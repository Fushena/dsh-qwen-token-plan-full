import { LlmError, ToolCallId } from "@deepseek-ai/dsh-llm";
import { formatHarnessActivity } from "./harness.js";
import { failure, httpFailure } from "./errors.js";

function eventData(raw) {
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^\s/, ""));
  }
  return lines.length ? lines.join("\n") : undefined;
}

/** 无第三方依赖的 SSE data JSON 迭代器，兼容 LF/CRLF、多 data 行和尾事件。 */
export async function* iterateSse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator) break;
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = eventData(raw);
        if (!data) continue;
        if (data === "[DONE]") return;
        try { yield JSON.parse(data); }
        catch { /* 供应商偶发的非 JSON 心跳不应杀死整个回复。 */ }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = eventData(buffer);
      if (data && data !== "[DONE]") {
        try { yield JSON.parse(data); } catch { /* ignore trailing heartbeat */ }
      }
    }
  } finally {
    // A protocol terminator can arrive before EOF. Cancel without waiting for the source to close.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function itemMessageText(item) {
  if (!Array.isArray(item?.content)) return "";
  return item.content.map((part) => part && typeof part === "object" ? String(part.text ?? "") : "").join("");
}

function itemReasoningText(item) {
  for (const key of ["summary", "content"]) {
    if (Array.isArray(item?.[key])) {
      const text = item[key].map((part) => part && typeof part === "object" ? String(part.text ?? "") : "").join("");
      if (text) return text;
    }
  }
  return "";
}

function usageFrom(response) {
  const usage = response?.usage ?? {};
  const details = usage.input_tokens_details ?? {};
  const outputDetails = usage.output_tokens_details ?? {};
  const totalInput = Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  const cacheRead = Number.isFinite(details.cached_tokens) ? details.cached_tokens : 0;
  const cacheWrite = Number.isFinite(usage.cache_creation_input_tokens)
    ? usage.cache_creation_input_tokens
    : Number.isFinite(details.cache_creation_input_tokens) ? details.cache_creation_input_tokens : 0;
  return {
    inputTokens: Math.max(0, totalInput - cacheRead - cacheWrite),
    outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(Number.isFinite(outputDetails.reasoning_tokens) && outputDetails.reasoning_tokens > 0
      ? { reasoningTokens: outputDetails.reasoning_tokens } : {}),
  };
}

function mergeHarnessActivity(activity, item, itemId, onHarnessUse, outputIndex) {
  const type = String(item?.type ?? "");
  if (!type || ["message", "reasoning", "function_call"].includes(type)) return;
  // 去重键**优先 output_index**：response.output_item.added / .done 都带它，
  // 而 qwen 的服务端工具项（如 web_search_call）常常不带 item.id。旧实现用
  // item.id ?? item_id 作键且要求 id 非空，于是同一次调用被 added 与 done
  // 各计一次 → 权益预算被多扣一倍（2026-11-10 用真实解析器复现：带 id 计 1，
  // 不带 id 计 2）。没有 output_index 的流退回 id 作次选键。
  const key = Number.isInteger(outputIndex) && outputIndex >= 0
    ? `#${outputIndex}`
    : (item?.id != null && item.id !== "" ? `id:${item.id}` : (itemId != null && itemId !== "" ? `id:${itemId}` : ""));
  const hit = key ? activity.find((entry) => entry.type === type && entry.dedupeKey === key) : undefined;
  if (hit) {
    hit.status = item.status ?? hit.status;
    hit.data = item;
  } else {
    activity.push({ type, itemId: item?.id || itemId || undefined, dedupeKey: key, status: item.status, data: item });
    // 每个新的服务端工具输出项 = 一次权益调用（web_search_call / code_interpreter_call / …）。
    if (onHarnessUse && type.endsWith("_call")) onHarnessUse(type);
  }
}

/** 把 Qwen Responses SSE 翻译为 DSH StreamChunk 协议。onHarnessUse(type) 在每个服务端工具调用首现时回调一次。 */
export async function* responsesToDshChunks(body, signal, onHarnessUse, options = {}) {
  const slots = new Map();
  const activity = [];
  // 声明了服务端内置工具时，工具调用块要等末尾的内置工具活动文本发完再发。
  // 否则 assistant 消息会变成 [文本…, tool-call, 文本]，而 Anthropic Messages
  // 协议（DeepSeek 官方端点）要求 tool_use 之后只能跟 tool_result —— 这类历史
  // 一旦被持久化，切到官方 provider 时整段对话都会 400。
  const deferToolCalls = options.deferToolCalls === true;
  const pendingToolCallBlocks = [];
  // 已内联发出过 tool-call 时，流末尾绝不能再追加文本块（会写坏历史块序）。
  let emittedInlineToolCall = false;
  let nextIndex = 0;
  let nextToolCallIndex = 1_000_000;
  let terminal;
  let sawContent = false;
  let sawFunctionCall = false;

  events: for await (const event of iterateSse(body, signal)) {
    const outputIndex = Number.isInteger(event.output_index) ? event.output_index : -1;
    switch (event.type) {
      case "response.output_item.added": {
        const item = event.item ?? {};
        if (outputIndex < 0) break;
        if (item.type === "message") {
          const slot = { kind: "text", index: nextIndex++, text: "" };
          slots.set(outputIndex, slot);
          yield { type: "block-start", index: slot.index, blockType: "text" };
        } else if (item.type === "reasoning") {
          const slot = { kind: "reasoning", index: nextIndex++, text: "" };
          slots.set(outputIndex, slot);
          yield { type: "block-start", index: slot.index, blockType: "reasoning" };
        } else if (item.type === "function_call") {
          const slot = {
            kind: "tool-call", index: deferToolCalls ? nextToolCallIndex++ : nextIndex++,
            id: ToolCallId(String(item.call_id ?? item.id ?? `call_${outputIndex}`)),
            name: String(item.name ?? ""), arguments: String(item.arguments ?? ""),
          };
          slots.set(outputIndex, slot);
          if (!deferToolCalls) {
            emittedInlineToolCall = true;
            yield { type: "block-start", index: slot.index, blockType: "tool-call" };
            if (slot.name || slot.arguments) yield { type: "tool-call-delta", index: slot.index, id: slot.id, name: slot.name, argumentsDelta: slot.arguments };
          }
        } else mergeHarnessActivity(activity, item, event.item_id, onHarnessUse, outputIndex);
        break;
      }

      case "response.output_text.delta": {
        const slot = slots.get(outputIndex);
        if (slot?.kind === "text" && typeof event.delta === "string" && event.delta) {
          slot.text += event.delta; sawContent = true;
          yield { type: "text-delta", index: slot.index, text: event.delta };
        }
        break;
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const slot = slots.get(outputIndex);
        if (slot?.kind === "reasoning" && typeof event.delta === "string" && event.delta) {
          slot.text += event.delta; sawContent = true;
          yield { type: "reasoning-delta", index: slot.index, text: event.delta };
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const slot = slots.get(outputIndex);
        if (slot?.kind === "tool-call" && typeof event.delta === "string" && event.delta) {
          slot.arguments += event.delta;
          if (deferToolCalls) break; // 块延后发出，见 pendingToolCallBlocks
          sawContent = true;
          yield { type: "tool-call-delta", index: slot.index, id: slot.id, argumentsDelta: event.delta };
        }
        break;
      }

      case "response.output_item.done": {
        const item = event.item ?? {};
        const slot = slots.get(outputIndex);
        if (!slot) { mergeHarnessActivity(activity, item, event.item_id, onHarnessUse, outputIndex); break; }
        if (slot.kind === "text") {
          const finalText = itemMessageText(item);
          if (!slot.text && finalText) {
            slot.text = finalText; sawContent = true;
            yield { type: "text-delta", index: slot.index, text: finalText };
          }
          yield { type: "block-end", index: slot.index, block: { type: "text", text: slot.text } };
        } else if (slot.kind === "reasoning") {
          const finalText = itemReasoningText(item);
          if (!slot.text && finalText) {
            slot.text = finalText; sawContent = true;
            yield { type: "reasoning-delta", index: slot.index, text: finalText };
          }
          yield { type: "block-end", index: slot.index, block: { type: "reasoning", text: slot.text } };
        } else {
          const finalArguments = String(item.arguments ?? slot.arguments ?? "{}");
          if (!slot.arguments && finalArguments) {
            slot.arguments = finalArguments;
            if (!deferToolCalls) {
              sawContent = true;
              yield { type: "tool-call-delta", index: slot.index, id: slot.id, name: slot.name, argumentsDelta: finalArguments };
            }
          }
          slot.arguments ||= "{}";
          sawFunctionCall = true; sawContent = true;
          const block = { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.arguments };
          if (deferToolCalls) pendingToolCallBlocks.push({ index: slot.index, block });
          else yield { type: "block-end", index: slot.index, block };
        }
        slots.delete(outputIndex);
        break;
      }

      case "response.completed":
      case "response.incomplete":
      case "response.failed":
      case "response.cancelled":
        terminal = { eventType: event.type, response: event.response ?? {} };
        break events;

      case "error":
        throw new LlmError(`${event.error?.code ?? event.code ?? "error"}: ${event.error?.message ?? event.message ?? "Qwen Responses 流错误"}`, httpFailure(400, JSON.stringify(event.error ?? event)));
      default:
        // 「进行中/心跳类」事件（如 response.web_search_call.searching）不产出内容，
        // 但必须让 adapter 的空闲超时知道连接还活着：内置工具执行超过 requestTimeoutMs
        // 期间只有这类事件，静默吞掉会让健康请求被 TIMEOUT 误杀（2026-11-13 探针实锤）。
        // heartbeat 仅供续命，adapter 收到后 touch 但不转发上层。
        yield { type: "heartbeat" };
    }
  }

  if (signal?.aborted) throw new LlmError("Qwen Responses 请求已取消", "ABORTED", { cause: signal.reason });
  if (!terminal) throw new LlmError("Qwen Responses 流在终止事件前关闭", "STREAM_CLOSED");
  // 未闭合块**只有**在 response.completed 时才算协议损坏：completed 意味着服务端认为
  // 一切正常结束，却漏发了 output_item.done，此时报 STREAM_CLOSED 是对的。
  // response.incomplete / failed / cancelled 是上游主动截断（max_output_tokens、内容
  // 审查、用户取消），容忍未闭合块才对；否则 STREAM_CLOSED 会抢在下面的 incomplete
  // 分支之前抛出，丢掉 max-tokens 语义与已经流出的文本（2026-11-10 实测复现）。
  const terminalCountsAsClean = terminal.eventType === "response.completed";
  if (slots.size && terminalCountsAsClean) {
    throw new LlmError("Qwen Responses 流存在未结束的输出块", "STREAM_CLOSED");
  }
  if (!terminalCountsAsClean) {
    // 截断时把未闭合的块补成完整块：text/reasoning 用已累积的 slot.text，
    // tool-call 用已累积的 arguments（缺省 "{}"）。收尾顺序仍是
    // [文本/思考 …, 工具调用 …]：先关文本类块；延迟模式下的工具调用块进
    // pendingToolCallBlocks 最后统一发（文本之后），非延迟模式的就地补 block-end
    // （其 block-start 早在 added 时就已发出，BlockAssembler 的块序不受 block-end 影响）。
    for (const slot of slots.values()) {
      if (slot.kind === "tool-call") continue;
      sawContent = sawContent || Boolean(slot.text);
      yield { type: "block-end", index: slot.index, block: { type: slot.kind, text: slot.text } };
    }
    for (const slot of slots.values()) {
      if (slot.kind !== "tool-call") continue;
      slot.arguments ||= "{}";
      sawFunctionCall = true; sawContent = true;
      const block = { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.arguments };
      if (deferToolCalls) pendingToolCallBlocks.push({ index: slot.index, block });
      else yield { type: "block-end", index: slot.index, block };
    }
    slots.clear();
  }

  const activityText = formatHarnessActivity(activity);
  // 防御：已内联发出 tool-call 后不再追加文本块，否则历史会变成
  // [文本…, tool-call, 文本]，DeepSeek 官方 Messages 端点会拒绝整段对话。
  if (activityText && !emittedInlineToolCall) {
    const index = nextIndex++;
    sawContent = true;
    yield { type: "block-start", index, blockType: "text" };
    yield { type: "text-delta", index, text: activityText };
    yield { type: "block-end", index, block: { type: "text", text: activityText } };
  }
  // 延迟模式下现在才发工具调用块：文本/思考块都已按顺序发出，
  // 内容顺序必然是 [文本…, tool-call…]，满足 Messages 协议的硬性校验。
  for (const pending of pendingToolCallBlocks) {
    const block = pending.block;
    yield { type: "block-start", index: pending.index, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: pending.index, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: "block-end", index: pending.index, block };
  }

  const response = terminal.response;
  yield { type: "usage", usage: usageFrom(response) };
  if (terminal.eventType === "response.completed") {
    if (!sawContent) yield { type: "finish", reason: { kind: "error", failure: failure("Qwen Responses 返回空回复", "EMPTY_RESPONSE") } };
    else yield { type: "finish", reason: { kind: sawFunctionCall ? "tool-calls" : "stop" } };
  } else if (terminal.eventType === "response.incomplete") {
    const reason = response.incomplete_details?.reason;
    yield { type: "finish", reason: reason === "max_output_tokens"
      ? { kind: "max-tokens" }
      : { kind: "error", failure: failure(`Qwen Responses 未完整结束：${reason ?? "unknown"}`, "PROVIDER_ERROR") } };
  } else {
    const error = response.error ?? {};
    yield { type: "finish", reason: { kind: "error", failure: failure(`${error.code ?? "error"}: ${error.message ?? "Qwen Responses 请求失败"}`, terminal.eventType === "response.cancelled" ? "ABORTED" : httpFailure(400, JSON.stringify(error))) } };
  }
}
