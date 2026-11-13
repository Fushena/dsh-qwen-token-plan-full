import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import { buildRequestBody } from "./content.js";
import { buildChatRequestBody, chatToDshChunks } from "./chat.js";
import { responsesToDshChunks } from "./responses-sse.js";
import { selectHarnessTools, describeHarnessTools } from "./harness.js";
import { httpFailure, retryAfterMs } from "./errors.js";
import { resolveApiKey } from "./apikey.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, requestDeadline, classifyFetchError } from "./timeout.js";

const EFFORT_NAMES = Object.freeze({
  none: "关闭", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大",
});

function reasoningInfo(model) {
  const ids = model.reasoningEfforts ?? (model.reasoning ? ["low", "medium", "xhigh"] : []);
  if (!ids.length) return undefined;
  return {
    efforts: ids.map((id) => ({ id, name: EFFORT_NAMES[id] ?? String(id) })),
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
  };
}

function displayModel(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.id,
    description: `${model.transport === "chat" ? "Chat" : "Responses"} · ${describeHarnessTools(model.harnessTools)}`,
    inputModalities: [...(model.input ?? ["text"])],
  };
}

/**
 * Qwen Token Plan（个人版）适配器：
 * - 千问/DeepSeek 系走 Responses API（服务端内置工具、图片输入、推理档位）
 * - GLM 系走 OpenAI Chat Completions（enable_thinking + reasoning_effort）
 * - 目录由 DynamicCatalog 提供（出厂快照 + 线上 /v1/models 动态合并）
 */
export class QwenTokenPlanAdapter extends LlmAdapter {
  #ctx;
  #catalog;
  #fetch;
  #budget;
  providerId;
  displayName;
  apiKeyEnv;
  endpoint;
  chatEndpoint;
  harnessMode;
  pluginName;
  requestTimeoutMs;

  constructor({ ctx, catalog, providerId, displayName, apiKeyEnv, endpoint, chatEndpoint, harnessMode, pluginName, budget, requestTimeoutMs, fetchImpl = globalThis.fetch }) {
    super();
    this.#ctx = ctx;
    this.#catalog = catalog;
    this.#fetch = fetchImpl;
    this.#budget = budget;
    this.providerId = providerId;
    this.displayName = displayName;
    this.apiKeyEnv = apiKeyEnv;
    this.endpoint = endpoint;
    this.chatEndpoint = chatEndpoint ?? endpoint.replace(/\/responses\/?$/, "/chat/completions");
    this.harnessMode = harnessMode;
    this.pluginName = pluginName;
    // 单次请求超时（覆盖到「拿到响应头」为止，见 lib/timeout.js 的背景说明）：
    // 不自己设超时就会一直等 undici 的 300 秒兜底，表现为「突然卡 5 分钟」。
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  providerInfo(provider) {
    return { id: provider, name: this.displayName };
  }

  async listModels() {
    return this.#catalog.snapshot().models.map((model) => displayModel(this.providerId, model));
  }

  async resolveModel(provider, modelId) {
    const model = this.#catalog.find(modelId);
    if (!model) {
      return {
        provider, id: modelId, name: modelId,
        description: "未出现在当前目录中；可尝试调用，但不注入内置工具",
        inputModalities: ["text"],
      };
    }
    const reasoning = reasoningInfo(model);
    return {
      ...displayModel(provider, model),
      ...(Number.isFinite(model.contextWindow) ? { context: { contextWindow: model.contextWindow } } : {}),
      ...(Number.isFinite(model.maxTokens) ? { defaultMaxTokens: model.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }

  async *stream(options) {
    const catalogModel = this.#catalog.find(options.model);
    const model = catalogModel ?? {
      id: options.model, reasoning: false, input: ["text"],
      maxTokens: options.maxTokens ?? 16384, harnessTools: [],
    };
    const useChat = model.transport === "chat";
    let harnessTools = useChat ? [] : selectHarnessTools(model.harnessTools, this.harnessMode);
    // 权益预算：按「官方周期配额 − 本周期返回/调用次数」逐项过滤，
    // 额度耗尽的权益不再声明对应工具（其余权益与模型调用、本地工具不受影响）。
    if (harnessTools.length && this.#budget) {
      const { tools: kept, dropped } = this.#budget.filterTools(harnessTools);
      if (dropped.length) {
        harnessTools = kept;
        this.#budget.noteSuppression({ dropped, until: this.#budget.status().usage.periodAnchor });
      }
    }
    const url = useChat ? this.chatEndpoint : this.endpoint;
    const routeName = `${this.displayName}（${useChat ? "Chat" : "Responses"}）`;
    const key = await resolveApiKey(this.#ctx, this.apiKeyEnv, this.pluginName);
    const attachments = this.#ctx.get?.("attachments");
    const body = useChat
      ? await buildChatRequestBody(options, model)
      : await buildRequestBody(options, model, attachments, harnessTools);

    let response;
    // 显式超时 + 可重试错误码：undici 默认 headersTimeout/bodyTimeout 都是 300 秒，
    // 不自己设超时就会「突然卡 5 分钟后报 fetch failed」；而原先的 NETWORK 码不在
    // DSH 的 DEFAULT_RETRYABLE_CODES（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT）
    // 里，网络抖动一次就终结本轮。两者一起修。
    // 超时同样要覆盖 SSE body 读取阶段，而不只是「拿到响应头」：
    // fetch() 拿到头就 resolve，真正的数据还在后面一点点流；只在头阶段设超时，
    // body 卡住时仍会退回 undici 的 300 秒兜底（正是本插件要修的场景）。
    // 所以 deadline.dispose() 放到包住整个流的 try/finally。
    const deadline = requestDeadline(options.signal, this.requestTimeoutMs);
    try {
      let response;
      try {
        response = await this.#fetch(url, {
          method: "POST",
          headers: {
            ...attributionHeaders(),
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          signal: deadline.signal,
        });
      } catch (error) {
        const failure = classifyFetchError(error, {
          externalAborted: Boolean(options.signal?.aborted),
          timedOut: deadline.timedOut(),
        });
        throw new LlmError(`${routeName} ${failure.message}`, failure.code, { cause: failure.cause });
      }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const code = httpFailure(response.status, text);
      const retryMs = retryAfterMs(response.headers);
      throw new LlmError(
        `${routeName} API 返回 HTTP ${response.status}${text ? `：${text.slice(0, 600)}` : ""}`,
        code,
        { status: response.status, ...(retryMs ? { providerRetryAfterMs: retryMs } : {}) },
      );
    }
    if (!response.body) throw new LlmError(`${routeName} API 没有返回响应流`, "PROVIDER_ERROR", { status: response.status });

    // 声明了服务端内置工具时，工具调用块等末尾的活动文本之后再发，
    // 避免 assistant 留下 [文本…, tool-call, 文本] 的块序污染历史。
    //
    // 解析器传**融合信号**（外部取消 + 空闲超时）：只传 options.signal 的话，
    // 超时到点只会取消 undici 的 body，解析器自己的 signal 检查看不到。
    const streamSignal = deadline.signal;
    const source = useChat
      ? chatToDshChunks(response.body, streamSignal)
      : responsesToDshChunks(response.body, streamSignal, (type) => this.#budget?.record(type), {
        deferToolCalls: harnessTools.length > 0,
      });
    try {
      for await (const chunk of source) {
        // 每收到一个 chunk 就重置空闲超时：超时语义是「多久没动静算卡死」，
        // 不是「一次请求最多花多久」；不 touch 的话正常长回答（>60s 流式输出）
        // 会被当成超时掐断（2026-11-10 实测复现）。
        deadline.touch();
        // 工具进行中/心跳事件只用于续命（见 responses-sse.js default 分支），
        // 不是内容块，不得泄漏给上层协议。
        if (chunk.type === "heartbeat") continue;
        yield chunk;
      }
    } catch (error) {
      // 解析器把「信号中止」统一报成 ABORTED，但它看到的是融合信号：
      // 只有外部取消才是真 ABORTED，超时中断的要改报 TIMEOUT（且可重试）。
      if (error instanceof LlmError) {
        if (error.code === "ABORTED" && deadline.timedOut() && !options.signal?.aborted) {
          throw new LlmError(`${routeName} 请求超时：等待响应超过 ${this.requestTimeoutMs}ms 没有新数据`, "TIMEOUT", { cause: error });
        }
        throw error;
      }
      const failure = classifyFetchError(error, {
        externalAborted: Boolean(options.signal?.aborted),
        timedOut: deadline.timedOut(),
      });
      throw new LlmError(`${routeName} ${failure.message}`, failure.code, { cause: failure.cause });
    }
    } finally {
      deadline.dispose();
    }
  }
}
