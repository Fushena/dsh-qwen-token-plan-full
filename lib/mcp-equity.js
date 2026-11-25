/**
 * Harness 权益的 MCP 通道（2026-11-23）。
 *
 * 为什么需要这一层：Token Plan 专属 Key（sk-sp-）只用于**模型调用抵扣 Credits**，
 * 官方明确「不用于 Harness 服务」。所以插件原先那套「服务端内置工具 + 模型 API 生图」
 * 无论调用多少次，官方 Harness 权益余额都不会动（实测 7 项全满、Credits 却在涨）。
 * 真正消耗权益的唯一通道是：**用百炼按量付费 Key（sk- / sk-ws-）调 MCP 服务**。
 * 见 https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits
 *
 * 本模块做三件事：
 *  1. 用宿主 `ctx.mcpManager.register` 把 7 个权益 MCP 服务挂进工具表（零新增依赖）；
 *  2. 按**真实权益余额**决定每项权益走 MCP 还是回落模型通道，耗尽即摘 MCP、
 *     让服务端内置工具重新声明（用户选择的「MCP 优先，耗尽自动回落」）；
 *  3. 通过 tools.guard 观察 MCP 工具调用并记账，让面板「剩余/总额」跟着真实扣减走。
 *
 * 记账口径：tools.guard 在派发前运行，拿不到成功与否，所以是**乐观计数**（调用即计）。
 * 官方余额每 tierRefreshHours 回源一次，setEquities 会把本地增量重新对齐，
 * 因此失败调用造成的偏差最多存在一个刷新周期（与既有内置工具计数口径一致）。
 */

import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { HARNESS_TOOL_TYPES } from "./harness.js";

/**
 * MCP 服务基址。默认百炼 DashScope —— 官方 Harness 权益文档给的就是这个域名
 * （示例 `https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp`）。
 * 千问 One Key 域名保留为可选：实测两域名对同一服务名返回一致。
 */
export const MCP_HOSTS = Object.freeze({
  cn: "https://dashscope.aliyuncs.com",
  dashscope: "https://dashscope.aliyuncs.com",
  qianwen: "https://dashscope.aliyuncs.com",
});

/**
 * 七项权益 ↔ MCP 服务名 ↔ 该服务覆盖的内置工具类型。
 *
 * service 是 URL 里的真实服务名（<host>/api/v1/mcps/<service>/mcp）。
 * **这些名字 2026-11-23 用真实 sk-ws- Key 逐个探测确认**，不是照商店标题猜的：
 * 猜错的名字服务端一律回 404「MCP服务不存在」，而「未开通该MCP或非可用开通状态」
 * 才表示名字对但账号没开通——两者必须分清，否则会把命名错误误判成权限问题。
 * 命名规律是「输入 Generate 输出」：TextGenerateImage / TextGenerateSpeech /
 * SpeechGenerateText / VideoGenerate；搜索与抓取则是 EnhancedSearch / VerticalSearch / WebFetch。
 *
 * 注意 search_pro 与 vertical_search 是**两个独立服务**（各有独立额度），
 * 不能像早先那样共用一个 EnhancedSearch —— 那样垂类搜索永远扣不到自己的额度。
 */
export const EQUITY_MCP_SERVICES = Object.freeze([
  { key: "search_pro", service: "EnhancedSearch", builtins: ["web_search"] },
  { key: "vertical_search", service: "VerticalSearch", builtins: ["web_search_image", "image_search"] },
  { key: "webfetch", service: "WebFetch", builtins: ["web_extractor"] },
  { key: "code_interpreter", service: "CodeInterpreter", builtins: ["code_interpreter"] },
  { key: "tts", service: "TextGenerateSpeech", builtins: [] },
  { key: "asr", service: "SpeechGenerateText", builtins: [] },
  { key: "image_generation", service: "TextGenerateImage", builtins: [] },
]);

/** 视频生成没有独立权益实例（按 Credits 计），单独一项、不参与权益门控。 */
export const VIDEO_MCP_SERVICE = Object.freeze({ service: "VideoGenerate", key: null });

/** 工具名前缀：mcp__<serverName>__<rawName>（与 dsh-mcp-client 一致）。 */
export function mcpToolPrefix(serverName) {
  return `mcp__${serverName}__`;
}

/** 由工具名反查它属于哪个 MCP 服务；不属于任何已注册服务时返回 undefined。 */
export function serverOfToolName(name, serverNames) {
  const text = String(name ?? "");
  if (!text.startsWith("mcp__")) return undefined;
  const rest = text.slice("mcp__".length);
  const cut = rest.indexOf("__");
  if (cut <= 0) return undefined;
  const server = rest.slice(0, cut);
  return serverNames.includes(server) ? server : undefined;
}

/**
 * 该服务覆盖哪些权益。目前七项一一对应，但保留数组返回：
 * 上游若把多项权益并进一个服务，这里不用改调用方。
 */
export function equityKeysOfService(service) {
  return EQUITY_MCP_SERVICES.filter((item) => item.service === service).map((item) => item.key);
}

/** 归一化配置：auto（有 key 就挂）/ off（完全不挂）/ 显式服务名列表。 */
export function normalizeMcpMode(value) {
  if (value === false || value === "off" || value === "none") return { mode: "off" };
  if (value == null || value === "" || value === "auto" || value === true) return { mode: "auto" };
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const known = new Set([...EQUITY_MCP_SERVICES.map((item) => item.service), VIDEO_MCP_SERVICE.service]);
  const services = [...new Set(raw.map((item) => String(item).trim()).filter((item) => known.has(item)))];
  return services.length === 0 ? { mode: "off" } : { mode: "list", services };
}

/**
 * 权益余额 → 该服务此刻是否应该挂着。
 *
 * 规则（用户 2026-11-23 选定「MCP 优先，额度耗尽自动回落模型 API」）：
 *  - 余额未知（网关兜底、无官方快照）：挂着，先让它试；真实 401 由 MCP 状态暴露。
 *  - 余额 > 0：挂着（走权益，不花 Credits）。
 *  - 余额 = 0：摘掉，内置工具/模型 API 重新可用（回落花 Credits，面板会标注来源）。
 */
export function shouldMountService(service, equityStates) {
  const keys = equityKeysOfService(service);
  if (keys.length === 0) return true; // 视频：无权益实例，恒挂
  return keys.some((key) => {
    const state = equityStates?.[key];
    if (!state || !Number.isFinite(state.remaining)) return true;
    return state.remaining > 0;
  });
}

/**
 * 本次请求**不该**声明的服务端内置工具：其能力已由挂着的 MCP 服务提供。
 *
 * 为什么必须摘：内置工具与 MCP 工具同时在场时，模型会优先用内置工具（服务端执行、
 * 走模型 API 扣 Credits），权益永远不动 —— 正是本次要修的错位。
 */
export function suppressedBuiltins(mountedServices) {
  const mounted = new Set(mountedServices ?? []);
  const out = new Set();
  for (const item of EQUITY_MCP_SERVICES) {
    if (!mounted.has(item.service)) continue;
    for (const type of item.builtins) out.add(type);
  }
  return HARNESS_TOOL_TYPES.filter((type) => out.has(type));
}

/**
 * 注册并维护权益 MCP 服务。
 *
 * @param ctx - 插件上下文（需要 mcpManager / tools；缺任一则整体降级为不挂载）
 * @param options - { apiKeyEnv, host, mode, budget, logger, pluginName, keyPresent?, includeVideo? }
 * @returns { dispose, refresh, rearm, callTool, mountedServices, readyServices, usesEquity, status }
 *   refresh 供权益回源后重算挂/摘；rearm 供 Key 落盘后补挂；usesEquity 供生图工具选通道。
 */
export function registerEquityMcp(ctx, options = {}) {
  const {
    apiKeyEnv = "BAILIAN_PAYG_API_KEY",
    host = MCP_HOSTS.cn,
    budget, logger, pluginName = "dsh-qwen-token-plan-full",
    // 视频没有独立权益实例（一律按 Credits 计），挂它只会与 qwen_generate_video
    // 重复暴露同一能力、白占工具位。要挂就在 mcpEquity 里显式列 VideoGenerate。
    includeVideo = false,
  } = options;
  const mode = normalizeMcpMode(options.mode);
  // manager 是**动态解析**的，不在 apply 时抓一次就定死：宿主的 mcp-manager 是独立插件，
  // 冷启动时它可能比本插件晚就绪。抓一次就会永久降级成 no-manager（实测踩过：
  // 热重载时它早在，所以正常；重启 App 后本插件先跑，权益通道整条失效）。
  const resolveManager = () => {
    try {
      const hit = ctx.get?.("mcpManager");
      return hit && typeof hit.register === "function" ? hit : null;
    } catch {
      return null;
    }
  };
  let manager = resolveManager();
  const tools = ctx.get?.("tools");

  const noop = {
    dispose: () => {}, refresh: () => {}, rearm: async () => {}, mountedServices: () => [],
    readyServices: () => [], usesEquity: () => false,
    callTool: async () => { throw new Error("Harness 权益 MCP 通道未启用"); },
    status: () => ({ enabled: false, reason: "off", servers: [] }),
  };
  if (mode.mode === "off") return noop;
  // 没 manager 不在此处 return：先按「待宿主就绪」建立状态，等它出现再挂（见下方轮询）。
  if (!manager) {
    logger?.warn?.(`${pluginName}: 宿主 mcpManager 尚未就绪，Harness 权益 MCP 通道待其出现后自动挂载（当前生图/搜索走模型 API 扣 Credits）`);
  }

  const wanted = mode.mode === "list"
    ? mode.services
    : [...new Set(EQUITY_MCP_SERVICES.map((item) => item.service))];
  if (includeVideo && mode.mode !== "list") wanted.push(VIDEO_MCP_SERVICE.service);

  // 没有按量付费 Key 就**一个服务都不挂**：挂了也是 401，只会给模型塞一堆用不了的
  // 工具、给日志刷错误。Key 是用户后补的，所以用 credentials/reference-updated 补挂。
  let keyPresent = options.keyPresent === true;
  const probeKey = async () => {
    try {
      const hit = await ctx.get?.("credentials")?.resolve?.(credentialRef(apiKeyEnv));
      const raw = hit?.value ?? process.env[apiKeyEnv];
      keyPresent = typeof raw === "string" && raw.trim() !== "";
    } catch {
      keyPresent = typeof process.env[apiKeyEnv] === "string" && process.env[apiKeyEnv].trim() !== "";
    }
    return keyPresent;
  };

  /** name → disposer；只保留此刻真正挂着的。 */
  const mounted = new Map();
  /** name → 最近一次状态（供面板与排障）。 */
  const states = new Map();
  /** name → { tool: 原名, at: 时间戳 }；调用过一次就记住上游真实工具名。 */
  const observed = new Map();
  let disposed = false;

  /** 挂载状态以宿主为准：manager.list() 的 status 带 connected/waiting-credentials/failed。 */
  const hostStatusOf = (service) => {
    try {
      const rows = manager.list?.() ?? [];
      const hit = rows.find((row) => row?.name === service);
      return hit?.status?.state ?? undefined;
    } catch {
      return undefined;
    }
  };

  const equityStates = () => {
    const out = {};
    for (const item of EQUITY_MCP_SERVICES) {
      try { out[item.key] = budget?.equityState?.(item.key); } catch { out[item.key] = undefined; }
    }
    return out;
  };

  const entryFor = (service) => ({
    transport: "streamable-http",
    url: `${host}/api/v1/mcps/${service}/mcp`,
    // 模板交给宿主展开（manager.toClientConfig 固定 expandTemplates:true），
    // 明文 Key 不进配置、不进日志。
    headers: { Authorization: `Bearer \${credential:${apiKeyEnv}}` },
    toolCallTimeoutMs: service === VIDEO_MCP_SERVICE.service ? 120_000 : 60_000,
    startupTimeoutMs: 30_000,
    reconnect: { enabled: true, maxAttempts: 10 },
  });

  const mount = (service) => {
    if (mounted.has(service)) return;
    if (!manager) return; // 宿主还没就绪：留给下一次 rearm，不记成挂载失败。
    try {
      const dispose = manager.register(service, entryFor(service));
      mounted.set(service, dispose);
      states.set(service, { mounted: true });
      logger?.info?.(`${pluginName}: Harness 权益 MCP 已挂载 ${service}（消耗权益，不花 Credits）`);
    } catch (error) {
      states.set(service, { mounted: false, error: String(error?.message ?? error) });
      logger?.warn?.(`${pluginName}: MCP 服务 ${service} 挂载失败：${String(error?.message ?? error)}`);
    }
  };

  const unmount = (service, why) => {
    const dispose = mounted.get(service);
    if (!dispose) return;
    mounted.delete(service);
    states.set(service, { mounted: false, reason: why });
    try { dispose(); } catch (error) { logger?.warn?.(`${pluginName}: 摘除 ${service} 失败：${String(error)}`); }
    logger?.info?.(`${pluginName}: ${service} 已摘除（${why}）——该能力回落到模型通道，开始消耗 Credits`);
  };

  /** 按当前权益余额 + Key 是否就位重算挂/摘。幂等，可在每次权益回源后调用。 */
  const refresh = () => {
    if (disposed) return;
    if (!keyPresent) {
      for (const service of wanted) unmount(service, `未配置百炼按量付费 Key（${apiKeyEnv}）`);
      return;
    }
    const statesNow = equityStates();
    for (const service of wanted) {
      if (shouldMountService(service, statesNow)) mount(service);
      else unmount(service, "权益额度已耗尽");
    }
  };

  /** Key 后补时补挂：先软探测，再重算。宿主 mcp-client 自己也会因该事件重连。 */
  const rearm = async () => {
    if (disposed) return;
    // 每次重算都重解析 manager：它可能刚刚才就绪（冷启动竞态）。
    manager = resolveManager();
    const had = keyPresent;
    await probeKey();
    if (disposed) return;
    if (!had && keyPresent && manager) logger?.info?.(`${pluginName}: 检测到 ${apiKeyEnv} 已配置，挂载 Harness 权益 MCP 通道`);
    refresh();
  };

  // 记账：MCP 工具被派发即计一次（口径见文件头）。guard 只观察、从不拒绝。
  let guardDispose = () => {};
  if (tools && typeof tools.guard === "function") {
    guardDispose = tools.guard((exec) => {
      const name = exec?.tool?.name ?? exec?.name ?? exec?.definition?.name;
      const server = serverOfToolName(name, [...mounted.keys()]);
      if (!server) return undefined;
      const text = String(name);
      observed.set(server, { tool: text.slice(`mcp__${server}__`.length), at: Date.now() });
      for (const key of equityKeysOfService(server)) {
        try { budget?.record?.(key, 1); } catch { /* 记账失败不影响调用 */ }
      }
      return undefined;
    });
  }

  // Key 是用户后补的：凭据一落盘就补挂，不用重启也不用手动刷新。
  let credentialOff = () => {};
  try {
    credentialOff = ctx.on?.("credentials/reference-updated", (ref) => {
      if (String(ref ?? "") !== apiKeyEnv) return;
      void rearm();
    }) ?? (() => {});
  } catch { /* 宿主无该事件时退化为定时 refresh */ }

  void rearm();

  // 冷启动竞态兜底：宿主 mcp-manager 是独立插件，可能比本插件晚就绪。
  // 没有可订阅的「服务出现」事件，所以用宿主 timer 轮询到它出现为止（出现即停，不长期占用）。
  let managerPollOff = () => {};
  if (!manager) {
    const timer = ctx.get?.("timer");
    const poll = () => {
      if (disposed) return;
      const hit = resolveManager();
      if (!hit) return;
      manager = hit;
      logger?.info?.(`${pluginName}: 宿主 mcpManager 已就绪，挂载 Harness 权益 MCP 通道`);
      managerPollOff();
      managerPollOff = () => {};
      void rearm();
    };
    try {
      if (timer?.setInterval) {
        const handle = timer.setInterval(poll, 2_000);
        managerPollOff = () => { try { timer.clearInterval?.(handle); } catch { /* 宿主已卸载 */ } };
      } else {
        const handle = setInterval(poll, 2_000);
        handle.unref?.();
        managerPollOff = () => clearInterval(handle);
      }
    } catch { /* 拿不到 timer 就只靠权益回源时的 rearm 兜底 */ }
  }

  /**
   * 已**连通**的服务。抑制内置工具、切换生图通道都只认这个，不认「注册了」：
   * 连不上（401/网络）却把内置工具摘了，等于把搜索能力整个弄丢。
   * state 为 undefined 表示宿主没报状态（旧版 manager / 测试替身），退回按注册算。
   */
  const readyServices = () => [...mounted.keys()].filter((service) => {
    const state = hostStatusOf(service);
    return state === undefined || state === "connected";
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { credentialOff(); } catch { /* 宿主可能已先行卸载 */ }
    try { managerPollOff(); } catch { /* 同上 */ }
    try { guardDispose(); } catch { /* 宿主可能已先行卸载 */ }
    for (const service of [...mounted.keys()]) {
      const off = mounted.get(service);
      mounted.delete(service);
      try { off(); } catch { /* 卸载期失败不阻塞插件 settle */ }
    }
  };

  /**
   * 经 MCP 调一次上游工具（供生图工具走权益通道）。
   *
   * 不猜上游工具名与参数：从**宿主已注册的适配定义**里取真实名字和 JSON Schema，
   * 由调用方按 schema 组参数。执行走宿主同一套适配器（图片投影、取消、错误归一）。
   * 返回 { tool, value }；value 形如 { content:[...], structuredContent? }。
   * 找不到工具或调用失败时抛错，调用方决定是否回落模型通道。
   */
  const callTool = async (service, exec, pick, buildArgs) => {
    if (!manager) throw new Error("宿主 mcpManager 尚未就绪");
    if (!keyPresent) throw new Error(`未配置百炼按量付费 Key（${apiKeyEnv}）`);
    const prefix = mcpToolPrefix(service);
    const defs = (tools?.definitions?.() ?? []).filter((def) => String(def?.name ?? "").startsWith(prefix));
    if (defs.length === 0) throw new Error(`${service} 尚未就绪（MCP 未连通或工具未同步）`);
    const chosen = pick(defs.map((def) => ({
      name: String(def.name).slice(prefix.length),
      description: def.description ?? "",
      inputSchema: def.parameters,
    })), defs);
    if (!chosen) throw new Error(`${service} 没有可用的目标工具（现有：${defs.map((d) => d.name).join(", ")}）`);
    const { rawName, definition } = chosen;
    const args = buildArgs(definition.parameters ?? {}, rawName);
    observed.set(service, { tool: rawName, at: Date.now() });
    const value = await definition.execute(args, exec);
    return { tool: rawName, value };
  };

  return {
    dispose,
    refresh,
    rearm,
    callTool,
    mountedServices: () => [...mounted.keys()],
    readyServices,
    /** 某项权益此刻是否真的走 MCP（连通 + 有余额）。生图工具据此决定显隐。 */
    usesEquity: (key) => {
      if (!keyPresent || !manager) return false;
      const ready = new Set(readyServices());
      const hit = EQUITY_MCP_SERVICES.find((item) => item.key === key);
      if (!hit || !ready.has(hit.service)) return false;
      const state = budget?.equityState?.(key);
      return !state || !Number.isFinite(state.remaining) || state.remaining > 0;
    },
    status: () => ({
      enabled: true,
      // 宿主 manager 还没出现时如实说「待就绪」，不要报成 mounted/missing-key。
      reason: !manager ? "no-manager" : (!keyPresent ? "missing-key" : (mounted.size ? "mounted" : "none-mounted")),
      host,
      credentialRef: apiKeyEnv,
      keyPresent,
      servers: wanted.map((service) => ({
        service,
        equityKeys: equityKeysOfService(service),
        ...(states.get(service) ?? { mounted: false }),
        state: hostStatusOf(service),
        lastTool: observed.get(service)?.tool,
      })),
    }),
  };
}

/** 供 adapter 用：把「已被 MCP 接管且连通」的内置工具从本次声明里剔除。 */
export function filterMcpShadowedBuiltins(tools, mcp, requestTools = []) {
  const list = typeof mcp?.readyServices === "function" ? mcp.readyServices()
    : typeof mcp?.mountedServices === "function" ? mcp.mountedServices() : null;
  if (!list) return { tools, taken: [] };
  const available = list.filter((service) => {
    const prefix = mcpToolPrefix(service);
    return requestTools.some((tool) => tool?.name?.startsWith(prefix));
  });
  const suppressed = new Set(suppressedBuiltins(available));
  if (suppressed.size === 0) return { tools, taken: [] };
  const taken = [];
  const kept = (tools ?? []).filter((type) => {
    if (!suppressed.has(type)) return true;
    taken.push(type);
    return false;
  });
  return { tools: kept, taken };
}

/**
 * 面板用：每项权益此刻的消耗来源。
 * equity = 走 MCP、扣官方权益额度；credits = 走模型 API/内置工具、扣 Credits。
 * 只有「挂着且宿主报 connected」才算 equity —— 否则面板会谎报省钱。
 */
export function equityChannel(key, mcpStatus) {
  if (!mcpStatus?.enabled || mcpStatus.keyPresent === false) return "credits";
  if (mcpStatus.reason === "no-manager") return "credits";
  const hit = (mcpStatus.servers ?? []).find((item) => (item.equityKeys ?? []).includes(key));
  if (!hit?.mounted) return "credits";
  if (hit.state !== undefined && hit.state !== "connected") return "credits";
  return "equity";
}
