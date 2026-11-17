import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import builtin from "./builtin-catalog.json" with { type: "json" };
import { tryResolveApiKey } from "./apikey.js";
import { HARNESS_TOOL_TYPES } from "./harness.js";
import { displayName, sortModels, familyOf } from "./model-display.js";

/** 非对话模型（生成/语音/embedding）：出现在 /v1/models 但不接 chat/responses 协议，排除出对话目录。 */
const NON_CHAT_PATTERNS = [
  // wan 系列含 wanx（如 wanx2.1-t2i-turbo，x 不是数字，/^wan\d/ 会漏，2026-11-13 修复）。
  /^wanx?\d/i, /^wan-/, /^qwen-image/i, /^qwen-audio/i, /^decision-model/i,
  /^text-embedding/i, /^gte-/i, /^paraformer/i, /^cosyvoice/i, /^sambert/i, /^qwen-tts/i, /^qwen3-tts/i,
];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** 出厂快照校验（与旧插件同规则；fingerprint 不校验）。 */
function validate(snapshot) {
  if (snapshot?.version !== 3 || snapshot.source !== "official-docs+verified-probes") {
    throw new Error("内置模型目录快照版本或来源不匹配");
  }
  const models = snapshot.models;
  if (!Array.isArray(models) || models.length < 2) throw new Error("内置模型目录至少需要两个模型");
  const seen = new Set();
  for (const model of models) {
    if (!model?.id || typeof model.id !== "string") throw new Error("模型条目缺少字符串 id");
    if (seen.has(model.id)) throw new Error(`模型目录存在重复 id：${model.id}`);
    seen.add(model.id);
    if (!Array.isArray(model.input) || !Array.isArray(model.harnessTools)) throw new Error(`模型 ${model.id} 的 input/harnessTools 必须是数组`);
    if (model.transport !== undefined && model.transport !== "chat") throw new Error(`模型 ${model.id} 的 transport 非法`);
    if (model.reasoning && !(Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.includes(model.defaultReasoningEffort))) {
      throw new Error(`模型 ${model.id} 的 reasoningEfforts 必须包含 defaultReasoningEffort`);
    }
  }
  return snapshot;
}

const BASE = deepFreeze(withComputedNames(validate(builtin)));

/** 内置快照的 name 一律用共享规则现算（JSON 里的旧写法不再生效）。 */
function withComputedNames(snapshot) {
  return { ...snapshot, models: snapshot.models.map((model) => ({ ...model, name: displayName(model.id) })) };
}

/** 动态发现的新模型：按家族推断保守规格（宁可低估也不让请求被 400）。 */
function generateUnknown(id) {
  const family = familyOf(id);
  const brand = family.brand;
  const name = displayName(id);
  if (family.key === "glm") {
    // glm-5.3 实测服务端强制 enable_thinking:true，未知 GLM 一律不给 none 档。
    return {
      id, name, brand, capabilities: "动态发现（规格为保守推断值）", reasoning: true,
      reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high",
      rejectedReasoningEfforts: ["none"], reasoningAliases: { minimal: "low", medium: "high", xhigh: "max" },
      input: ["text"], contextWindow: 1000000, maxTokens: 16384, harnessTools: [], transport: "chat",
    };
  }
  if (family.key === "deepseek") {
    return {
      id, name, brand, capabilities: "动态发现（规格为保守推断值）", reasoning: true,
      reasoningEfforts: ["none", "low", "high", "max"], defaultReasoningEffort: "high",
      reasoningAliases: { medium: "high", xhigh: "high" },
      input: ["text"], contextWindow: 163840, maxTokens: 32768, harnessTools: [],
    };
  }
  if (family.key === "qwen") {
    return {
      id, name, brand, capabilities: "动态发现（规格为保守推断值）", reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "xhigh"], defaultReasoningEffort: "xhigh",
      reasoningAliases: { high: "xhigh", max: "xhigh" },
      input: ["text"], contextWindow: 1000000, maxTokens: 65536, harnessTools: [...HARNESS_TOOL_TYPES],
    };
  }
  return {
    id, name, brand, capabilities: "动态发现（规格为保守推断值）", reasoning: true,
    reasoningEfforts: ["none", "low", "high", "max"], defaultReasoningEffort: "high",
    reasoningAliases: { medium: "high", xhigh: "high" },
    input: ["text"], contextWindow: 131072, maxTokens: 16384, harnessTools: [],
  };
}

function mergeModels(baseModels, liveIds, overrides, excludes) {
  const baseById = new Map(baseModels.map((model) => [model.id, model]));
  const isExcluded = (id) => excludes.some((pattern) => id === pattern || id.startsWith(pattern));
  const merged = [];
  const seen = new Set();
  const push = (model) => {
    if (!model?.id || seen.has(model.id) || isExcluded(model.id)) return;
    seen.add(model.id);
    // 展示名一律现算（与 ark 插件同一份 displayName 规则），内置 JSON 里的旧 name 不再生效。
    merged.push({ ...model, name: displayName(model.id) });
  };
  // 内置目录顺序优先（用户熟悉的排序），随后是动态发现的新模型。
  for (const model of baseModels) if (liveIds === null || liveIds.includes(model.id)) push(model);
  for (const id of liveIds ?? []) {
    if (NON_CHAT_PATTERNS.some((pattern) => pattern.test(id))) continue;
    push(baseById.get(id) ?? generateUnknown(id));
  }
  // config.models 手工固定/覆盖：按 id 替换或追加（可救活目录里没有的模型）。
  for (const override of overrides) {
    if (!override?.id || isExcluded(override.id)) continue;
    const at = merged.findIndex((model) => model.id === override.id);
    const patched = at >= 0 ? { ...merged[at], ...override } : override;
    if (at >= 0) merged[at] = patched; else { seen.add(override.id); merged.push(patched); }
  }
  // 分组 + 组内从新到旧（与 ark 插件同一份 sortModels 规则）。
  return sortModels(merged);
}

/**
 * 动态模型目录：出厂快照兜底 + 运行时拉取 /compatible-mode/v1/models 合并。
 * 拉取失败（无 Key/断网）时静默保留上一份目录，绝不让插件失活。
 */
export class DynamicCatalog {
  #models;
  #fetch;
  #modelsUrl;
  #ctx;
  #apiKeyEnv;
  #pluginName;
  #overrides;
  #excludes;
  #logger;
  source = "builtin";
  syncedAt = null;
  lastError = null;

  constructor({ ctx, modelsUrl, apiKeyEnv, pluginName, overrides = [], excludes = [], fetchImpl = globalThis.fetch, logger }) {
    this.#ctx = ctx;
    this.#modelsUrl = modelsUrl;
    this.#apiKeyEnv = apiKeyEnv;
    this.#pluginName = pluginName;
    this.#overrides = overrides;
    this.#excludes = excludes;
    this.#fetch = fetchImpl;
    this.#logger = logger;
    this.#models = deepFreeze(mergeModels(BASE.models, null, this.#overrides, this.#excludes));
  }

  snapshot() {
    return { version: 3, source: this.source, syncedAt: this.syncedAt, models: this.#models };
  }

  find(modelId) {
    return this.#models.find((model) => model.id === modelId);
  }

  /** 拉取线上模型清单并合并；失败保留旧目录。 */
  async refresh(signal) {
    const key = await tryResolveApiKey(this.#ctx, this.#apiKeyEnv, this.#pluginName);
    if (!key) { this.lastError = "missing-credential"; return false; }
    try {
      const response = await this.#fetch(this.#modelsUrl, {
        headers: { ...attributionHeaders(), Authorization: `Bearer ${key}` },
        signal,
      });
      if (!response.ok) { this.lastError = `models HTTP ${response.status}`; return false; }
      const json = await response.json();
      signal?.throwIfAborted();
      const ids = (json?.data ?? json?.models ?? [])
        .map((entry) => typeof entry === "string" ? entry : entry?.id)
        .filter((id) => typeof id === "string" && id.length > 0);
      if (ids.length === 0) { this.lastError = "models 列表为空"; return false; }
      this.#models = deepFreeze(mergeModels(BASE.models, ids, this.#overrides, this.#excludes));
      this.source = "live";
      this.syncedAt = new Date().toISOString();
      this.lastError = null;
      this.#logger?.info?.(`动态目录已刷新：${this.#models.length} 个对话模型（线上 ${ids.length} 个 id）`);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
}

export { BASE as BUILTIN_CATALOG };
