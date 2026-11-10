import { LlmError } from "@deepseek-ai/dsh-llm";

import { resolveReasoningEffort, shadowedFunctionNames } from "./harness.js";

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function sanitizeText(text) { return String(text ?? "").replace(LONE_SURROGATE_RE, "\uFFFD"); }

async function imageBlock(block, model, attachments, signal) {
  if (!(model.input ?? []).includes("image")) throw new LlmError(`模型 ${model.id} 不支持图片输入`, "UNSUPPORTED_CONTENT");
  if (!attachments) throw new LlmError("图片输入需要 DSH 附件服务", "UNSUPPORTED_CONTENT");
  const stored = await attachments.readImage(block.attachment, signal);
  return { type: "input_image", image_url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}` };
}

async function inputContent(blocks, model, attachments, signal) {
  const result = [];
  for (const block of blocks ?? []) {
    if (block.type === "text") result.push({ type: "input_text", text: sanitizeText(block.text) });
    else if (block.type === "image") result.push(await imageBlock(block, model, attachments, signal));
    else if (block.type === "tool-result") result.push(...await inputContent(block.content, model, attachments, signal));
    // file / tool-addition / tool-removal / reasoning：请求装配已投影为文本或无需重放，跳过。
  }
  return result;
}

async function toolOutput(block, model, attachments, signal) {
  const content = await inputContent(block.content, model, attachments, signal);
  if (content.length === 0) return block.isError ? "(工具执行失败且没有输出)" : "(工具没有输出)";
  if (content.every((item) => item.type === "input_text")) return content.map((item) => item.text).join("\n");
  return content;
}

function flushAssistantText(items, text) {
  if (text.length === 0) return "";
  items.push({
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: sanitizeText(text), annotations: [] }],
  });
  return "";
}

async function convertMessage(message, model, attachments, signal) {
  if (message.role === "system") {
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    return text ? [{ role: "system", content: sanitizeText(text) }] : [];
  }
  if (message.role === "assistant") {
    const items = [];
    let text = "";
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool-call") {
        text = flushAssistantText(items, text);
        items.push({ type: "function_call", call_id: String(block.id), name: block.name, arguments: sanitizeText(block.arguments || "{}") });
      } else if (block.type === "image") {
        throw new LlmError("Responses 历史不支持结构化的 assistant 图片块", "UNSUPPORTED_CONTENT");
      }
      // reasoning 不重放，避免把上一轮思维链伪装为当前模型的原生推理项。
    }
    flushAssistantText(items, text);
    return items;
  }
  if (message.role === "tool") {
    // dsh-llm 0.2.x：工具结果是独立消息 ToolResultMessage{role:"tool",toolCallId}。
    const content = await inputContent(message.content, model, attachments, signal);
    let output;
    if (content.length === 0) output = message.isError ? "(工具执行失败且没有输出)" : "(工具没有输出)";
    else if (content.every((item) => item.type === "input_text")) output = content.map((item) => item.text).join("\n");
    else output = content;
    return [{ type: "function_call_output", call_id: String(message.toolCallId), output }];
  }

  const items = [];
  const ordinary = [];
  for (const block of message.content) {
    if (block.type === "tool-result") {
      // dsh-llm 0.1.x 兼容形状：工具结果内嵌在 user 消息里。
      items.push({
        type: "function_call_output",
        call_id: String(block.toolCallId),
        output: await toolOutput(block, model, attachments, signal),
      });
    } else ordinary.push(block);
  }
  const content = await inputContent(ordinary, model, attachments, signal);
  if (content.length) items.push({ role: "user", content });
  return items;
}

/** 将 DSH 的 provider-neutral 历史转换为 Qwen Responses input items。 */
export async function buildInput(options, model, attachments) {
  const input = [];
  if (options.system) input.push({ role: "system", content: sanitizeText(options.system) });
  for (const message of options.messages) input.push(...await convertMessage(message, model, attachments, options.signal));
  return input;
}

export function functionToolDeclarations(tools = []) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: sanitizeText(tool.description),
    parameters: tool.parameters,
  }));
}

export async function buildRequestBody(options, model, attachments, harnessTools) {
  if (options.stop?.length) throw new LlmError("Qwen Responses API 未声明支持 stop 参数", "UNSUPPORTED_OPTION");
  // 工具仲裁规则（与 DSH 自带模型、以及 ark 插件的工具互不影响）：
  // 1) harnessTools 已由 adapter 按权益过滤，只剩「本次真能用的」服务端内置工具；
  // 2) 这些内置工具优先——同能力的 DSH 本地函数让位（只让位这些名字，其余不受影响）；
  // 3) 权益耗尽后内置工具被滤掉，同名本地函数自动重新出现（回退到 DSH 自己的工具）；
  // 4) normal 模式（effort=none）Token Plan 拒绝思考型内置工具，此时退回全部本地函数。
  const effort = resolveReasoningEffort(options, model);
  const declaredFunctions = functionToolDeclarations(options.tools);
  // Token Plan rejects thinking-only built-ins in normal mode. Keep DSH
  // functions available in both modes instead of letting provider tools fail.
  const builtins = effort === "none" ? [] : [...new Set(harnessTools)];
  // 让位的只有「本次真声明了」的内置工具；先算出最终声明集合，再据此剔除本地函数。
  const candidateBuiltins = builtins.filter((type) =>
    type !== "web_extractor" || (builtins.includes("web_search") && effort !== "none"));
  const shadowed = shadowedFunctionNames(candidateBuiltins, declaredFunctions.map((tool) => tool.name));
  const keptFunctions = declaredFunctions.filter((tool) => !shadowed.has(tool.name));
  const tools = [
    ...keptFunctions,
    ...candidateBuiltins.map((type) => ({ type })),
  ];
  const maximum = Number.isFinite(model.maxTokens) ? model.maxTokens : 16384;
  const requested = Number.isFinite(options.maxTokens) ? options.maxTokens : maximum;
  const body = {
    model: model.id,
    input: await buildInput(options, model, attachments),
    stream: true,
    max_output_tokens: Math.max(16, Math.min(Math.floor(requested), maximum)),
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (effort) body.reasoning = { effort };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  return body;
}
