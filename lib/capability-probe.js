/**
 * 动态能力探测：对 /v1/models 发现但目录里没有正式条目的新模型，
 * 发 1-2 次最小请求探测真实能力（图片输入 / 推理档位 / 输出上限），
 * 结果写回目录对象，替代 generateUnknown 的保守推断。
 *
 * 设计约束：
 * - 每个模型只探一次（内存 Map 缓存），刷新目录不重复探测。
 * - 探测失败静默回退到 generateUnknown 的保守推断，绝不让插件失活。
 * - 探测请求消耗极少量 credits（每次约 100 tokens），用户已确认接受。
 * - 只探测 Responses 协议模型；GLM Chat 系不探（能力字段不同）。
 */

import { attributionHeaders } from "@deepseek-ai/dsh-llm";

/** 16×16 纯红 PNG，用于探测图片输入能力。 */
const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PROBE_IMAGE_DATA_URL = `data:image/png;base64,${PROBE_PNG_BASE64}`;

/** 探测用的推理档位列表：按常见程度排序，逐个尝试直到成功。 */
const EFFORT_CANDIDATES = ["none", "low", "medium", "high", "xhigh", "max"];

/** 探测结果缓存：modelId → ProbeResult。 */
const cache = new Map();

/**
 * 发一次最小 Responses 请求，判断模型是否接受该请求体。
 * @returns {Promise<{ ok: boolean, status?: number, text?: string }>}
 */
async function tryRequest({ endpoint, key, body, fetchImpl, signal }) {
  try {
    const response = await fetchImpl(endpoint, {
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
    const text = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 探测单个模型的能力。
 * @param {string} modelId
 * @param {{ endpoint: string, key: string, fetchImpl?: typeof fetch, signal?: AbortSignal }} options
 * @returns {Promise<{ input: string[], reasoningEfforts: string[], defaultReasoningEffort: string, maxTokens: number } | null>}
 */
export async function probeModelCapabilities(modelId, { endpoint, key, fetchImpl = globalThis.fetch, signal }) {
  if (cache.has(modelId)) return cache.get(modelId);

  const result = {
    input: ["text"],
    reasoningEfforts: [],
    defaultReasoningEffort: "high",
    maxTokens: 16384,
  };

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
        ...(effort === "none" ? {} : { reasoning: { effort } }),
      },
    });
    if (probe.ok) {
      supportedEfforts.push(effort);
    }
    // 探测到第一个成功的非 none 档后，可以合理推断后续档位也支持，
    // 但为了准确性还是继续探完（每个请求约 100 tokens，成本极低）。
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
    // 所有档位都失败：模型可能不支持 reasoning，或者探测请求本身有问题。
    // 保守起见标记为无推理能力。
    result.reasoningEfforts = [];
    result.defaultReasoningEffort = undefined;
  }

  // —— 3. 输出上限探测 ——
  // 用一个较大的值试探，如果 400 就逐步降低。
  // 从 65536 开始（generateUnknown 的默认值），如果成功就尝试更大的。
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
    if (probe.ok) {
      result.maxTokens = candidate;
    } else {
      // 遇到第一个失败的值就停止（上限已找到）。
      break;
    }
  }

  cache.set(modelId, result);
  return result;
}

/**
 * 批量探测：对一组新模型 id 并发探测，返回 Map<modelId, ProbeResult>。
 * 失败或超时的模型返回 null（调用方回退到 generateUnknown）。
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

/** 清空缓存（测试用）。 */
export function clearProbeCache() {
  cache.clear();
}
