import { LlmError } from "@deepseek-ai/dsh-llm";

/** Qwen Responses API 服务端内置工具（不是 DSH 本地函数工具）。 */
export const HARNESS_TOOL_TYPES = Object.freeze([
  "web_search",
  "code_interpreter",
  "web_extractor",
  "web_search_image",
  "image_search",
]);

export const HARNESS_TOOL_LABELS = Object.freeze({
  web_search: "联网搜索",
  code_interpreter: "代码解释器",
  web_extractor: "网页抓取",
  // Responses schema: web_search_image 接收 queries（文搜图）；
  // image_search 接收输入图片索引与 bbox（以图搜图）。
  web_search_image: "文搜图",
  image_search: "以图搜图",
});

const KNOWN = new Set(HARNESS_TOOL_TYPES);

/** 将插件配置归一化为 auto / none / 显式列表。 */
export function normalizeHarnessMode(value) {
  if (value == null || value === "" || value === "auto") return { mode: "auto" };
  if (value === false || value === "none") return { mode: "none" };
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const tools = raw.map((item) => String(item).trim()).filter((item) => KNOWN.has(item));
  return tools.length === 0 ? { mode: "none" } : { mode: "list", tools };
}

/**
 * 取配置与模型官方能力的交集，并满足 web_extractor 必须和 web_search 一起声明的约束。
 */
export function selectHarnessTools(supported, mode) {
  const available = new Set((supported ?? []).filter((item) => KNOWN.has(item)));
  if (mode.mode === "none") return [];
  const selected = mode.mode === "auto"
    ? new Set(available)
    : new Set(mode.tools.filter((item) => available.has(item)));
  if (selected.has("web_extractor") && available.has("web_search")) {
    selected.add("web_search");
  }
  return HARNESS_TOOL_TYPES.filter((item) => selected.has(item));
}

function clip(value, max = 600) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

/** 将服务端工具活动渲染为可持久化、可在 DSH UI 看见的简洁 Markdown。 */
export function formatHarnessActivity(activity) {
  if (!Array.isArray(activity) || activity.length === 0) return "";
  const parts = [];
  for (const entry of activity) {
    const data = entry.data && typeof entry.data === "object" ? entry.data : {};
    const action = data.action && typeof data.action === "object" ? data.action : {};
    switch (entry.type) {
      case "web_search_call": {
        const queries = stringArray(action.queries);
        const sources = Array.isArray(action.sources) ? action.sources : [];
        const urls = sources
          .map((source) => source && typeof source === "object" ? String(source.url ?? "") : "")
          .filter(Boolean);
        const lines = [`[内置工具：联网搜索]${queries.length ? ` ${queries.map((q) => JSON.stringify(q)).join("、")}` : ""}`];
        if (urls.length) lines.push(...urls.map((url) => `- ${url}`));
        parts.push(lines.join("\n"));
        break;
      }
      case "code_interpreter_call": {
        const lines = ["[内置工具：代码解释器] 已执行"];
        if (typeof data.code === "string" && data.code.trim()) lines.push(`\`\`\`python\n${clip(data.code)}\n\`\`\``);
        const logs = (Array.isArray(data.outputs) ? data.outputs : [])
          .filter((item) => item && typeof item === "object" && item.type === "logs")
          .map((item) => clip(item.logs))
          .filter(Boolean);
        if (logs.length) lines.push(logs.join("\n"));
        parts.push(lines.join("\n"));
        break;
      }
      case "web_extractor_call": {
        const lines = [`[内置工具：网页抓取]${data.goal ? ` ${clip(data.goal, 200)}` : ""}`];
        lines.push(...stringArray(data.urls).map((url) => `- ${url}`));
        parts.push(lines.join("\n"));
        break;
      }
      case "web_search_image_call":
      case "image_search_call": {
        const label = entry.type === "web_search_image_call" ? "文搜图" : "以图搜图";
        let count;
        let output = data.output;
        if (typeof output === "string") {
          try { output = JSON.parse(output); } catch { /* 只影响显示计数 */ }
        }
        if (Array.isArray(output)) count = output.length;
        else if (output && typeof output === "object" && Array.isArray(output.images)) count = output.images.length;
        parts.push(`[内置工具：${label}]${count == null ? " 已调用" : ` 返回 ${count} 张图片`}`);
        break;
      }
      default:
        parts.push(`[内置工具：${entry.type}] 已调用`);
    }
  }
  return `\n\n---\n${parts.join("\n\n")}`;
}

export function describeHarnessTools(tools) {
  if (!tools?.length) return "官方未列出服务端内置工具（DSH 本地工具仍可用）";
  return tools.map((tool) => HARNESS_TOOL_LABELS[tool] ?? tool).join("、");
}

/** Resolve DSH's shared effort ids to the selected provider model's contract. */
export function resolveReasoningEffort(options, model) {
  if (!model.reasoning) return undefined;
  const requested = options.reasoningEffort ?? model.defaultReasoningEffort;
  if (requested === undefined) return undefined;
  const effort = model.reasoningAliases?.[requested] ?? requested;
  if (model.rejectedReasoningEfforts?.includes(requested)
      || (model.reasoningEfforts?.length && !model.reasoningEfforts.includes(effort)
        && !model.acceptedReasoningEfforts?.includes(effort))) {
    throw new LlmError(`模型 ${model.id} 不支持推理档位 ${requested}；请选择 ${model.reasoningEfforts?.join(" / ") ?? "模型支持的档位"}`, "UNSUPPORTED_OPTION");
  }
  return String(effort);
}

/**
 * DSH 本地工具中与服务端内置工具同能力、会被 harness 声明顶掉的名字。
 *
 * Qwen Token Plan 与 Ark 一样：内置工具与同名自定义函数不能共存，
 * 共存时网关会走本地 schema 而服务端 harness 不执行。
 * 因此声明内置工具时要让同名本地函数让位；权益耗尽后内置工具被摘掉，
 * 同名本地函数自动重新出现 —— 即「权益没了回退到 DSH 自己的工具」。
 */
export const LOCAL_TOOL_FOR_CAPABILITY = Object.freeze({
  web_search: "web_search",
  web_extractor: "web_fetch",
  code_interpreter: null, // DSH 没有等价本地工具
});

/**
 * 由「本次真正能声明的内置工具」推导出必须让位的本地函数名。
 * @param builtins - 本次请求实际声明的内置工具类型（已按权益过滤）。
 * @param availableFunctions - 本次请求里 DSH 提供的本地函数名。
 * @returns 需要从函数声明中移除的名字。
 */
export function shadowedFunctionNames(builtins, availableFunctions) {
  const declared = new Set(builtins ?? []);
  const present = new Set((availableFunctions ?? []).map((name) => String(name)));
  const shadowed = new Set();
  for (const [capability, localName] of Object.entries(LOCAL_TOOL_FOR_CAPABILITY)) {
    if (!localName || !declared.has(capability)) continue;
    if (present.has(localName)) shadowed.add(localName);
  }
  for (const capability of declared) if (present.has(capability)) shadowed.add(String(capability));
  return shadowed;
}
