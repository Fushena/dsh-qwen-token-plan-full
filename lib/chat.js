import { LlmError, ToolCallId } from "@deepseek-ai/dsh-llm";
import { sanitizeText } from "./content.js";
import { iterateSse } from "./responses-sse.js";
import { failure, httpFailure } from "./errors.js";
import { resolveReasoningEffort } from "./harness.js";

function textBlocks(blocks, emptyText) {
  const text = [];
  for (const block of blocks ?? []) {
    if (block.type === "text" || block.type === "reasoning") text.push(sanitizeText(block.text));
    else if (block.type === "image") throw new LlmError("GLM Chat 路线不支持图片输入", "UNSUPPORTED_CONTENT");
    else if (block.type !== "tool-call" && block.type !== "tool-result"
      && block.type !== "tool-addition" && block.type !== "tool-removal" && block.type !== "file") {
      throw new LlmError(`GLM Chat 路线不支持内容类型 ${block.type}`, "UNSUPPORTED_CONTENT");
    }
  }
  return text.join("") || emptyText;
}

function assistantMessage(message) {
  const reasoning = (message.content ?? []).filter((block) => block.type === "reasoning")
    .map((block) => sanitizeText(block.text)).join("");
  const content = (message.content ?? []).filter((block) => block.type === "text")
    .map((block) => sanitizeText(block.text)).join("");
  const toolCalls = (message.content ?? []).filter((block) => block.type === "tool-call").map((block) => ({
    id: String(block.id),
    type: "function",
    function: { name: block.name, arguments: sanitizeText(block.arguments || "{}") },
  }));
  for (const block of message.content ?? []) {
    if (!["text", "reasoning", "tool-call"].includes(block.type)) {
      throw new LlmError(`GLM Chat assistant 历史不支持内容类型 ${block.type}`, "UNSUPPORTED_CONTENT");
    }
  }
  return {
    role: "assistant",
    content,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function chatMessages(options) {
  const messages = [];
  if (options.system) messages.push({ role: "system", content: sanitizeText(options.system) });
  for (const message of options.messages ?? []) {
    if (message.role === "system") {
      messages.push({ role: "system", content: textBlocks(message.content, "") });
      continue;
    }
    if (message.role === "assistant") {
      messages.push(assistantMessage(message));
      continue;
    }
    if (message.role === "tool") {
      // dsh-llm 0.2.x：工具结果是独立消息 ToolResultMessage{role:"tool",toolCallId}。
      messages.push({
        role: "tool",
        tool_call_id: String(message.toolCallId),
        content: textBlocks(message.content, message.isError ? "(工具执行失败且没有输出)" : "(工具没有输出)"),
      });
      continue;
    }
    const ordinary = (message.content ?? []).filter((block) => block.type !== "tool-result");
    const results = (message.content ?? []).filter((block) => block.type === "tool-result");
    if (ordinary.length || !results.length) messages.push({ role: "user", content: textBlocks(ordinary, "") });
    for (const result of results) {
      // dsh-llm 0.1.x 兼容形状：工具结果内嵌在 user 消息里。
      messages.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: textBlocks(result.content, result.isError ? "(工具执行失败且没有输出)" : "(工具没有输出)"),
      });
    }
  }
  return messages;
}

/** GLM 系列使用 OpenAI Chat Completions；其他模型仍由 Responses codec 处理。 */
export async function buildChatRequestBody(options, model) {
  const maximum = Number.isFinite(model.maxTokens) ? model.maxTokens : 131072;
  const requested = Number.isFinite(options.maxTokens) ? options.maxTokens : maximum;
  const effort = resolveReasoningEffort(options, model);
  const tools = (options.tools ?? []).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: sanitizeText(tool.description), parameters: tool.parameters },
  }));
  return {
    model: model.id,
    messages: chatMessages(options),
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: Math.max(1, Math.min(Math.floor(requested), maximum)),
    ...(effort ? { enable_thinking: effort !== "none", reasoning_effort: effort } : {}),
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop?.length ? { stop: options.stop } : {}),
  };
}

function mappedUsage(usage) {
  const totalInput = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : 0;
  const cacheRead = Number.isFinite(usage?.prompt_tokens_details?.cached_tokens)
    ? usage.prompt_tokens_details.cached_tokens
    : Number.isFinite(usage?.prompt_cache_hit_tokens) ? usage.prompt_cache_hit_tokens : 0;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: Math.max(0, totalInput - cacheRead),
    outputTokens: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : 0,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

function mappedFinish(reason) {
  if (reason === "stop") return { kind: "stop" };
  if (reason === "tool_calls") return { kind: "tool-calls" };
  if (reason === "length") return { kind: "max-tokens" };
  return { kind: "error", failure: failure(`GLM Chat 异常结束：${reason}`, String(reason || "UNKNOWN").toUpperCase()) };
}

function closeBlock(block) {
  if (block.kind === "text") return { type: "text", text: block.text };
  if (block.kind === "reasoning") return { type: "reasoning", text: block.text };
  return { type: "tool-call", id: ToolCallId(block.id || `call_${block.wireIndex}`), name: block.name || "", arguments: block.text || "{}" };
}

/** 把 OpenAI Chat Completions SSE 翻译为 DSH StreamChunk。 */
export async function* chatToDshChunks(body, signal) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let finish;
  let usage;
  const open = (kind, extra = {}) => {
    const block = { kind, index: nextIndex++, text: "", ...extra };
    order.push(block);
    return block;
  };

  for await (const chunk of iterateSse(body, signal)) {
    if (chunk?.error) throw new LlmError(`${chunk.error.code ?? "error"}: ${chunk.error.message ?? "GLM Chat 流错误"}`, httpFailure(400, `${chunk.error.code ?? ""} ${chunk.error.message ?? ""}`));
    for (const choice of chunk?.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += delta.reasoning_content;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: delta.reasoning_content };
      }
      if (typeof delta.content === "string" && delta.content) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += delta.content;
        yield { type: "text-delta", index: textBlock.index, text: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        const wireIndex = Number.isInteger(call.index) ? call.index : toolBlocks.size;
        let block = toolBlocks.get(wireIndex);
        if (!block) {
          block = open("tool-call", { wireIndex, id: "", name: "" });
          toolBlocks.set(wireIndex, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== undefined) block.id = String(call.id);
        if (call.function?.name !== undefined) block.name = String(call.function.name);
        const fragment = typeof call.function?.arguments === "string" ? call.function.arguments : "";
        block.text += fragment;
        if (fragment || call.id !== undefined || call.function?.name !== undefined) {
          yield {
            type: "tool-call-delta", index: block.index, id: ToolCallId(block.id || `call_${wireIndex}`),
            ...(block.name ? { name: block.name } : {}), argumentsDelta: fragment,
          };
        }
      }
      if (typeof choice.finish_reason === "string") finish = mappedFinish(choice.finish_reason);
    }
    if (chunk?.usage) usage = mappedUsage(chunk.usage);
  }

  if (signal?.aborted) throw new LlmError("GLM Chat 请求已取消", "ABORTED", { cause: signal.reason });
  if (!finish) throw new LlmError("GLM Chat 流在 finish_reason 前关闭", "STREAM_CLOSED");
  for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
  if (usage) yield { type: "usage", usage };
  yield {
    type: "finish",
    reason: finish.kind === "stop" && order.length === 0
      ? { kind: "error", failure: failure("GLM Chat 返回空回复", "EMPTY_RESPONSE") }
      : finish,
  };
}
