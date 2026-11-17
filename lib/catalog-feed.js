import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { resolveApiKey } from "./apikey.js";
import { displayName, familyOf } from "./model-display.js";
import { NON_CHAT_PATTERNS } from "./catalog.js";

/**
 * 目录补货器（v0.4.0）：定期从「普通线路」（llm-pi-ai 里手工配的 provider，默认
 * qwentokenplan）**自己的域名**拉 /models，把新出现的对话模型翻译成 pi-ai 模型条目，
 * 经 ctx.configEditor.edit() 追加进该线路的 models 配置（只追加，绝不改动已有条目）。
 *
 * 设计要点（2026-11-17 与用户讨论定稿）：
 * - 抓普通线路自己的 baseURL，而不是本插件的阿里云端点——两个网关的模型清单可能不同，
 *   补进去的必须是普通线路真能拨通的模型。
 * - 档案翻译：本插件动态目录里已有该模型的实测/推断规格（contextWindow/maxTokens/input/
 *   推理档位）就翻译过去；档位映射成 pi-ai 的 reasoningEfforts（键=可选档位，值=线上拼写），
 *   并按家族配 compat.thinkingFormat（qwen/deepseek/zai）。没有规格的模型只写 id/name，
 *   容量吃 pi-ai 路由默认值——宁可保守，不让请求 400。
 * - 只在名单真变化时写配置（差集 + seen 持久化）：新模型上线是低频事件，避免频繁重载。
 *   seen 记录「曾经补过」的 id——用户手动删掉的模型不会被下一轮又塞回来。
 * - pi-ai 官方承诺：models 改动下一请求生效、免重启、注册原子更新（见 dsh-llm-pi-ai
 *   模块头注），因此补货不中断正在进行的请求。写入前 pi-ai 的 Config schema 会整体校验，
 *   校验失败不落盘。
 * - 调用上下文：configEditor.edit 要开 HMR 事务，而 HMR 用 AsyncLocalStorage 标记、
 *   异步链会继承——插件启动 tick 生在事务里，直接/延后调 edit 都报嵌套。所以周期补货
 *   由 index.js 经回环 POST /feed 触发，edit 实际跑在 HTTP 处理器的干净上下文里；
 *   面板「刷新」（POST /refresh）本身就在 HTTP 上下文，直接调。
 * - 不选档位时 pi-ai 不发推理字段——已有行为零变化；feedReasoning:false 可整体关掉档位翻译。
 */

const PI_AI_ENTRY_ID = "llm-pi-ai";
/** pi-ai 的规范思考档位（catalog.ts THINKING_LEVELS），off 对应 DSH 的 none。 */
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** 家族 → pi-ai 内置线上推理方言（SUPPORTED_THINKING_FORMATS）。 */
const THINKING_FORMAT = Object.freeze({ qwen: "qwen", deepseek: "deepseek", glm: "zai" });

function loadState(statePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      seen: Array.isArray(raw?.seen) ? raw.seen.map(String) : [],
      lastFeedAt: Number.isFinite(raw?.lastFeedAt) ? raw.lastFeedAt : null,
      lastAdded: Array.isArray(raw?.lastAdded) ? raw.lastAdded.map(String) : [],
      lastError: typeof raw?.lastError === "string" ? raw.lastError : null,
    };
  } catch {
    return { seen: [], lastFeedAt: null, lastAdded: [], lastError: null };
  }
}

export class CatalogFeed {
  #ctx; #catalog; #feedProvider; #feedReasoning; #pluginName; #fetch; #logger;
  #state; #statePath; #running = null;

  constructor({ ctx, catalog, feedProvider, feedReasoning = true, pluginName, fetchImpl = globalThis.fetch, logger }) {
    this.#ctx = ctx;
    this.#catalog = catalog;
    this.#feedProvider = String(feedProvider || "qwentokenplan");
    this.#feedReasoning = feedReasoning !== false;
    this.#pluginName = pluginName;
    this.#fetch = fetchImpl;
    this.#logger = logger;
    // 构造时求值（而非模块加载时）：测试的 home 隔离覆盖环境变量后才生效。
    this.#statePath = path.join(os.homedir(), ".dsh", "qwen-token-plan-full.feed.json");
    this.#state = loadState(this.#statePath);
  }

  #save() {
    try { fs.writeFileSync(this.#statePath, JSON.stringify(this.#state, null, 2), "utf8"); }
    catch (error) { this.#logger?.warn?.(`${this.#pluginName}: 补货状态写盘失败（${error instanceof Error ? error.message : String(error)}）`); }
  }

  status() {
    return {
      enabled: true,
      provider: this.#feedProvider,
      reasoning: this.#feedReasoning,
      lastFeedAt: this.#state.lastFeedAt,
      lastAdded: this.#state.lastAdded,
      lastError: this.#state.lastError,
      seenCount: this.#state.seen.length,
    };
  }

  /** 串行化：周期刷新与面板「刷新」可能同时触发。 */
  run() {
    if (this.#running) return this.#running;
    this.#running = this.#run()
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.#state.lastError = reason;
        this.#save();
        this.#logger?.warn?.(`${this.#pluginName}: 目录补货失败（${reason}）`);
        return { added: [], error: reason };
      })
      .finally(() => { this.#running = null; });
    return this.#running;
  }

  async #run() {
    const editor = this.#ctx.get?.("configEditor");
    if (!editor || typeof editor.edit !== "function") {
      this.#state.lastError = "configEditor 服务不可用";
      this.#save();
      return { added: [], error: this.#state.lastError };
    }
    const entry = editor.entries().find((e) => e?.options?.id === PI_AI_ENTRY_ID);
    if (!entry) {
      this.#state.lastError = `找不到配置行 ${PI_AI_ENTRY_ID}`;
      this.#save();
      return { added: [], error: this.#state.lastError };
    }
    const current = entry.options.config ?? {};
    const route = current.providers?.[this.#feedProvider];
    if (!route || typeof route.baseURL !== "string" || route.baseURL === "") {
      this.#state.lastError = `pi-ai 线路 ${this.#feedProvider} 不存在或未配 baseURL`;
      this.#save();
      return { added: [], error: this.#state.lastError };
    }

    // 用普通线路自己的域名与 Key 抓名单（决策①）。
    const key = await resolveApiKey(this.#ctx, String(route.apiKeyEnv ?? ""), this.#pluginName);
    const url = `${route.baseURL.replace(/\/+$/, "")}/models`;
    const response = await this.#fetch(url, {
      headers: { ...attributionHeaders(), Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`models HTTP ${response.status}（${url}）`);
    const json = await response.json();
    const ids = (json?.data ?? json?.models ?? [])
      .map((e) => (typeof e === "string" ? e : e?.id))
      .filter((id) => typeof id === "string" && id.length > 0);
    if (ids.length === 0) throw new Error("models 列表为空");

    const existing = new Set((route.models ?? []).map((m) => m?.id).filter(Boolean));
    const seen = new Set(this.#state.seen);
    const fresh = ids.filter((id) =>
      !existing.has(id) && !seen.has(id) && !NON_CHAT_PATTERNS.some((p) => p.test(id)));

    this.#state.lastFeedAt = Date.now();
    if (fresh.length === 0) {
      this.#state.lastError = null;
      this.#save();
      return { added: [] };
    }

    const entries = fresh.map((id) => this.#translate(id));
    // 只追加：已有条目、其它 provider、其它字段一律原样保留。
    await editor.edit(entry, (cur) => {
      const providers = { ...(cur.providers ?? {}) };
      const target = { ...(providers[this.#feedProvider] ?? {}) };
      const models = [...(target.models ?? [])];
      const have = new Set(models.map((m) => m?.id));
      for (const item of entries) {
        if (!have.has(item.id)) { models.push(item); have.add(item.id); }
      }
      target.models = models;
      providers[this.#feedProvider] = target;
      return { ...cur, providers };
    });

    this.#state.seen = [...new Set([...this.#state.seen, ...fresh])];
    this.#state.lastAdded = fresh;
    this.#state.lastError = null;
    this.#save();
    this.#logger?.info?.(`${this.#pluginName}: 目录补货 → ${this.#feedProvider} 新增 ${fresh.length} 个模型：${fresh.join("、")}`);
    return { added: fresh };
  }

  /** 本插件目录档案 → pi-ai 模型条目。没有档案就只写 id/name（容量吃路由默认值）。 */
  #translate(id) {
    const known = this.#catalog.find(id);
    const family = familyOf(id);
    const item = { id, name: displayName(id) };
    if (Number.isFinite(known?.contextWindow)) item.contextWindow = known.contextWindow;
    if (Number.isFinite(known?.maxTokens)) item.maxTokens = known.maxTokens;
    if ((known?.input ?? []).includes("image")) item.input = ["text", "image"];

    if (!this.#feedReasoning) return item;
    if (known?.reasoning === false) {
      item.reasoningEfforts = false; // 明确非推理模型（如 auto 路由），选择器不提供档位。
      return item;
    }
    const format = THINKING_FORMAT[family.key];
    const efforts = known?.reasoningEfforts;
    if (!known?.reasoning || !format || !Array.isArray(efforts) || efforts.length === 0) return item;

    const aliases = known.reasoningAliases ?? {};
    const accepted = known.acceptedReasoningEfforts ?? [];
    const rejected = known.rejectedReasoningEfforts ?? [];
    const map = {};
    for (const level of PI_LEVELS) {
      const requested = level === "off" ? "none" : level;
      const resolved = aliases[requested] ?? requested;
      if (rejected.includes(resolved)) continue;
      if (!efforts.includes(resolved) && !accepted.includes(resolved)) continue;
      // off 留空 = 支持该档、线上不发推理字段（pi-ai 规则）；其余值=线上拼写。
      map[level] = level === "off" ? null : resolved;
    }
    if (Object.keys(map).length > 0) {
      item.reasoningEfforts = map;
      item.compat = { thinkingFormat: format };
    }
    return item;
  }
}
