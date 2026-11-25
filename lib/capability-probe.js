/**
 * 动态能力探测：对 /v1/models 发现但目录里没有正式条目的新模型，
 * 发最小请求探测真实能力（图片输入 / 推理档位 / 输出上限），
 * 结果写回目录对象，替代 generateUnknown 的保守推断。
 *
 * 设计约束：
 * - 每个模型只探一次（内存 Map 缓存），但**只缓存完整成功的探测**。
 *   实测教训（2026-11-18，真实上游）：30s 预算掐断探测后降级结果被无条件缓存，
 *   qwen4-max-preview 的 maxTokens 固化在 131072（真值 393216）直到进程结束，
 *   第二次 refresh 73ms 缓存命中、一字不变。传输失败/中止不是能力信号，绝不入缓存。
 * - 探测失败静默回退到 generateUnknown 的保守推断，绝不让插件失活。
 * - 探测请求是真实生成（旧注释「每次约 100 tokens」是错的，实测单请求中位 721ms、
 *   最大 2646ms），所以只读首个 SSE 事件就 cancel 释放连接，别等整段生成读完。
 * - 只探测 Responses 协议模型；GLM Chat 系不探（能力字段不同）。
 */

import { attributionHeaders } from "@deepseek-ai/dsh-llm";

/**
 * 16×16 纯红 PNG，用于探测图片输入能力。
 *
 * 尺寸不能小于 11×11：上游对图片有最小边长限制，1×1 会被拒
 * （实测 2026-11-18，qwen4-max 与 qwen4-max-preview 都返回 HTTP 200 + response.failed：
 * `InvalidParameter: The image length and width do not meet the model restrictions.
 * [height:1 or width:1 must be larger than 10]`）。
 * 原先这里放的是 1×1 PNG 却注释成 16×16 —— 于是**每个模型的图片探测都被上游拒掉**，
 * 而拒绝是「可信的不支持」，被当成能力信号缓存下来：所有动态发现的模型一律
 * input=["text"]，带图请求在宿主装配阶段就抛 UNSUPPORTED_CONTENT。
 * 这正是动态能力探测本想根治的毛病，换成了「探测自己把图片能力判没了」。
 * 换成真正 16×16 后同一请求返回 response.created（正常开工）。
 */
const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==";
const PROBE_IMAGE_DATA_URL = `data:image/png;base64,${PROBE_PNG_BASE64}`;

/** 探测用的推理档位列表：按常见程度排序，逐个尝试直到成功。 */
const EFFORT_CANDIDATES = ["none", "low", "medium", "high", "xhigh", "max"];

/** 探测结果缓存：modelId → ProbeResult。只有完整成功的探测才入缓存（incomplete 绝不写）。 */
const cache = new Map();

/**
 * 判定 SSE 文本里的首个 data 事件。
 * 为什么不能只看 HTTP 200：上游存在流内下发 type:"error" / response.failed 的形态
 * （见 responses-sse.js 的终止事件分支），把它们当成功会把不存在的能力缓存成真值。
 * @returns {"ok"|"rejected"|"empty"} empty = 一个可判定事件都没有（200 空流/网关错误页/首事件超 1MB 未终结的灌流），不可信。
 */
function classifyFirstEvent(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  for (const rawEvent of normalized.split("\n\n")) {
    const data = rawEvent.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue; // 注释/keepalive 事件，不构成判定依据
    if (data === "[DONE]") return "ok";
    try {
      const event = JSON.parse(data);
      if (event?.type === "error" || event?.type === "response.failed") return "rejected";
    } catch { /* 事件已到达即说明请求被接受；只有明确 error 才算拒绝 */ }
    return "ok";
  }
  return "empty";
}

/**
 * 探测的事件缓冲上限。为什么必须有：协议损坏/被投毒/中间设备灌流若永不含 "\n\n"，
 * buffer 会无界增长直到撑爆进程——与主 SSE 路径 2026-11-18 修掉的 P1 同一形态。
 * 为什么比主路径的 32MB（responses-sse.js MAX_EVENT_BYTES）小得多：这里只需要判
 * 首个事件的能力信号，不是收正文，1MB 装不下任何合法首事件。
 * 超限按不可信（empty→incomplete）处理而不是抛穿 refresh：一个模型的协议损坏
 * 只该让它走保守推断并留 probe-incomplete 痕迹，不该让整份目录刷新失败。
 */
const PROBE_MAX_EVENT_BYTES = 1 * 1024 * 1024;

/**
 * 从响应流里只读首个 data 事件就 cancel 释放连接（手法同 site.js）。
 * 为什么不等整段流：请求体是 stream:true 的真实生成，text() 要读完全部 SSE 才 resolve，
 * 11 次串行探测在 30s 预算里根本装不下——被掐的位置随网络抖动而变，探出的上限是假值。
 */
async function readFirstEventVerdict(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingBytes = 0; // 当前未终结事件的字节数；keepalive 修剪后重新起算（上限是逐事件的，不是全流的）
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pendingBytes += value.byteLength;
      // 先判再拼接：超限的 chunk 不再进 buffer，避免为一份注定不可信的数据再翻倍内存。
      if (pendingBytes > PROBE_MAX_EVENT_BYTES) return "empty";
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      // 只判定已完整到达的事件（以空行分隔）；半截 JSON 先不判，等下一个 chunk。
      const lastBreak = buffer.lastIndexOf("\n\n");
      if (lastBreak >= 0) {
        const verdict = classifyFirstEvent(buffer.slice(0, lastBreak + 2));
        if (verdict !== "empty") return verdict;
        buffer = buffer.slice(lastBreak + 2); // 目前只有 keepalive，丢弃继续读
        pendingBytes = 0;
      }
    }
    return classifyFirstEvent((buffer + decoder.decode()).replace(/\r\n/g, "\n"));
  } finally {
    // 无论判定结果如何都释放连接，让上游尽早停止生成（少花钱）。
    await reader.cancel().catch(() => {});
  }
}

/**
 * 发一次最小 Responses 请求，判断模型是否接受该请求体。
 * 三态（为什么要区分：旧码把「不支持」和「没探成」一律记 ok:false，
 * 网络抖动被当成「模型没能力」缓存下来，降级固化到进程结束）：
 * - ok：请求被接受（HTTP 2xx 且首事件不是明确错误）。
 * - rejected：上游明确拒绝（HTTP 4xx 或流内 error/response.failed），可信的「不支持」。
 *   例外：401/403/429 是 key/限流问题而非能力信号，按不可信处理，
 *   否则限流窗口里会把「什么都不支持」的假档案缓存下来——正是本文件要修的 bug 形态。
 * - incomplete：传输失败/中止/5xx/200 空流，不可信，整个模型须重探。
 * @returns {Promise<{ ok: boolean, rejected?: boolean, incomplete?: boolean, status?: number }>}
 */
async function tryRequest({ endpoint, key, body, fetchImpl, signal }) {
  if (signal?.aborted) return { ok: false, incomplete: true };
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        ...attributionHeaders(),
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return { ok: false, incomplete: true };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    const rejected = status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
    return { ok: false, rejected, incomplete: !rejected, status };
  }
  try {
    // 真实 fetch 有 body 流：读首事件即 cancel；无流的注入 mock 退回 text() 整读。
    const verdict = response.body?.getReader
      ? await readFirstEventVerdict(response)
      : classifyFirstEvent(await response.text());
    if (verdict === "rejected") return { ok: false, rejected: true, status: response.status };
    if (verdict === "empty") return { ok: false, incomplete: true, status: response.status };
    return { ok: true, status: response.status };
  } catch {
    // 读流中途被中止/断开：响应已开始但没探完，不可信。
    return { ok: false, incomplete: true, status: response.status };
  }
}

/**
 * 探测单个模型的能力。
 * @param {string} modelId
 * @param {{ endpoint: string, key: string, fetchImpl?: typeof fetch, signal?: AbortSignal }} options
 * @returns {Promise<{ input: string[], reasoningEfforts: string[], defaultReasoningEffort: string, maxTokens: number, incomplete?: boolean }>}
 *   incomplete:true 表示探测被传输失败/中止打断，结果是保守占位值，调用方必须回退 generateUnknown。
 */
export async function probeModelCapabilities(modelId, { endpoint, key, fetchImpl = globalThis.fetch, signal }) {
  if (cache.has(modelId)) return cache.get(modelId);

  const result = {
    input: ["text"],
    reasoningEfforts: [],
    defaultReasoningEffort: "high",
    maxTokens: 16384,
  };
  // 任一不可信失败立即收手：结果注定不入缓存，继续付费探测只会再产出一份降级档案。
  const bail = () => ({ ...result, incomplete: true });

  // —— 1. 图片输入探测 ——
  const imageProbe = await tryRequest({
    endpoint, key, fetchImpl, signal,
    body: {
      model: modelId,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "What color is this image? Answer in one word." },
          { type: "input_image", image_url: PROBE_IMAGE_DATA_URL },
        ],
      }],
      stream: true,
      max_output_tokens: 32,
    },
  });
  if (imageProbe.incomplete) return bail();
  if (imageProbe.ok) {
    result.input = ["text", "image"];
  }

  // —— 2. 推理档位探测 ——
  // 先确认模型是否支持 reasoning（不传 effort 看是否默认开思考）。
  // 然后逐个尝试候选档位，收集成功的。
  const supportedEfforts = [];
  for (const effort of EFFORT_CANDIDATES) {
    const probe = await tryRequest({
      endpoint, key, fetchImpl, signal,
      body: {
        model: modelId,
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        stream: true,
        max_output_tokens: 32,
        reasoning: { effort },
      },
    });
    if (probe.incomplete) return bail();
    if (probe.ok) {
      supportedEfforts.push(effort);
    }
    // 探测到第一个成功的非 none 档后，可以合理推断后续档位也支持，
    // 但档位集合并不单调（实测有模型只收 low/high/xhigh），还是逐档探完才准。
  }
  if (supportedEfforts.length > 0) {
    result.reasoningEfforts = supportedEfforts;
    // 默认档：优先 high，其次 low，最后第一个成功的。
    result.defaultReasoningEffort = supportedEfforts.includes("high")
      ? "high"
      : supportedEfforts.includes("low")
        ? "low"
        : supportedEfforts[0];
  } else {
    // 所有档位都被明确拒绝：模型不支持 reasoning（传输失败已在上面 bail，不会走到这）。
    result.reasoningEfforts = [];
    result.defaultReasoningEffort = undefined;
  }

  // —— 3. 输出上限探测 ——
  // 从 65536（generateUnknown 的默认值）逐级上探，遇到第一个失败就停。
  const maxTokensCandidates = [65536, 131072, 262144, 393216];
  for (const candidate of maxTokensCandidates) {
    const probe = await tryRequest({
      endpoint, key, fetchImpl, signal,
      body: {
        model: modelId,
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        stream: true,
        max_output_tokens: candidate,
      },
    });
    if (probe.incomplete) return bail();
    if (probe.ok) {
      result.maxTokens = candidate;
    } else {
      // 遇到第一个被明确拒绝的值就停止（上限已找到）。
      break;
    }
  }

  cache.set(modelId, result);
  return result;
}

/**
 * 批量探测：对一组新模型 id 并发探测，返回 Map<modelId, ProbeResult>。
 * 抛错的模型返回 null、被打断的模型带 incomplete:true（调用方都回退到 generateUnknown）。
 */
export async function probeNewModels(modelIds, { endpoint, key, fetchImpl, signal, concurrency = 2 }) {
  const results = new Map();
  const queue = [...modelIds];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;
      try {
        const result = await probeModelCapabilities(id, { endpoint, key, fetchImpl, signal });
        results.set(id, result);
      } catch {
        results.set(id, null);
      }
    }
  });
  await Promise.allSettled(workers);
  return results;
}

/** 清空缓存：测试隔离 + 面板手动刷新（reprobe:true）的重探入口。 */
export function clearProbeCache() {
  cache.clear();
}
