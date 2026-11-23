import z from "@deepseek-ai/schemastery";
import { RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { DynamicCatalog } from "./lib/catalog.js";
import { CatalogFeed } from "./lib/catalog-feed.js";
import { QwenTokenPlanAdapter } from "./lib/adapter.js";
import { registerMediaTools } from "./lib/media-tools.js";
import { normalizeHarnessMode } from "./lib/harness.js";
import { HarnessBudget } from "./lib/budget.js";
import { fetchTierInfo, fetchEquityInfo, readConsoleCookie } from "./lib/gateway.js";
import { ReloginFlow } from "./lib/relogin.js";
import { createProxyFetch, redactProxyUrl } from "./lib/proxy.js";
import { trustedRouteRequest } from "./lib/route-guard.js";
import { SITE_ENDPOINTS, deriveRoute, isAutoEndpoint, detectSite } from "./lib/site.js";
import { registerEquityMcp, equityChannel, MCP_HOSTS } from "./lib/mcp-equity.js";

const DEFAULT_ENDPOINT = SITE_ENDPOINTS.cn;
const DEFAULT_IMAGE_MODELS = ["qwen-image-3.0-pro", "wan2.7-image", "wan2.7-image-pro"];
const DEFAULT_VIDEO_MODELS = ["wan3.0-video"];
const ROUTE_PREFIX = "/qwen-token-plan-full";

export const name = "dsh-qwen-token-plan-full";
export const inject = ["llm", "tools", "timer", "credentials", "webServer"];

// DSH settings discover credential inputs through the Config schema's role.
export const Config = z.object({
  providerId: z.string().default("qwen-token-plan-full"),
  displayName: z.string().default("千问 Token Plan 全能版"),
  apiKeyEnv: z.string().role("credential-ref").default("QWEN_TOKEN_PLAN_CN_API_KEY"),
  // "auto"：启动时并发探测国内站/国际站的 /models，谁 200 用谁（key 与地域绑定，
  // 跨地域一律 401，见 lib/site.js）。显式写死一个 URL 则完全跳过探测。
  endpoint: z.string().default("auto").description("Responses 端点。留空或 auto = 启动时自动判定国内站/国际站（两站点 key 不通用，跨站一律 401）；也可显式写死 URL。"),
  chatEndpoint: z.string().description("Chat Completions 端点。留空则由 endpoint 自动派生（/responses → /chat/completions）。"),
  harness: z.any().default("auto"),
  mediaTools: z.boolean().default(true),
  // Harness 权益 MCP 通道（2026-11-23）：Token Plan 专属 Key（sk-sp-）只抵扣 Credits，
  // 官方明确「不用于 Harness 服务」。要真正消耗套餐单列的 7 项权益，必须用百炼
  // 按量付费 Key（sk- / sk-ws-）调 MCP。这里配的就是那把 Key 的凭据名。
  bailianApiKeyEnv: z.string().role("credential-ref").default("BAILIAN_PAYG_API_KEY")
    .description("百炼按量付费 Key（sk- / sk-ws-）的凭据名。配好后 7 项权益走 MCP：扣权益额度、不花 Credits；没配则一切照旧走模型 API 扣 Credits。"),
  // auto = 有 Key 就挂全部权益服务；off = 完全不挂；也可显式列服务名（逗号分隔）。
  mcpEquity: z.any().default("auto")
    .description("权益 MCP 通道：auto（有 Key 就挂）/ off（不挂）/ 显式服务名列表，如 TextGenerateImage,EnhancedSearch。"),
  mcpHost: z.string().default(MCP_HOSTS.cn)
    .description("MCP 服务基址。默认千问 AI 平台 One Key；百炼 DashScope 用 https://dashscope.aliyuncs.com。"),
  models: z.array(z.any()).default([]),
  excludeModels: z.array(z.string()).default([]),
  imageModels: z.array(z.string()),
  videoModels: z.array(z.string()),
  defaultImageModel: z.string(),
  defaultVideoModel: z.string(),
  catalogRefreshMinutes: z.number().min(1).default(30),
  // 套餐余量刷新周期：6 小时 → 1 小时（用户要求 2026-11-04）。
  tierRefreshHours: z.number().min(0.5).default(1),
  consoleCookieEnv: z.string().role("credential-ref").default("BAILIAN_CONSOLE_COOKIE"),
  // Cookie 失效时自动开 Chrome 登录页并在登录成功后收割新 Cookie 写回；false 关闭。
  autoRelogin: z.boolean().default(true),
  tier: z.string().default("auto"),
  harnessBudget: z.any(),
  // 出站代理：留空读 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 环境变量；"none"/"off"/"direct" 强制直连。
  // Node 默认不继承系统代理，需要时由这里显式指定（仅支持 http/https）。
  proxy: z.string().default(""),
  // 空闲超时（不是总时长）：多久没有新字节算卡死。跨境静默窗口比国内长得多
  // （中间 NAT / 机场节点的空闲回收更激进），60s 会把健康请求误杀，故默认 120s。
  // 必须与 retryPolicy 成对调：最坏墙钟 = requestTimeoutMs × (1 + maxRetries)。
  requestTimeoutMs: z.number().min(1_000).default(120_000).description("空闲超时（毫秒，不是总时长）：多久没有新字节算卡死。跨境静默窗口比国内长，60s 会误杀健康请求，故默认 120000。与重试次数成对调：最坏墙钟 = 本值 ×(1 + maxRetries)。"),
  // 请求重试策略（DSH 的 llm-retry 在 provider 配置下读取，见 dsh-llm 的 RetryPolicySchema）。
  // 跨境每次重试都要重新全量上传整段历史，DSH 默认的 5 次会把一次抖动放大成分钟级假死，
  // 所以这里默认降到 2 次、退避起点抬到 1000ms。
  retryPolicy: RetryPolicySchema.default({
    mode: "normal",
    maxRetries: 2,
    backoff: { initialDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.1 },
  }).description("请求重试策略（交给宿主 llm-retry 执行）。跨境每次重试都要重传整段历史，DSH 默认 5 次会把一次抖动放大成分钟级假死，故默认 2 次、退避起点 1000ms。"),
  // false = 观察-only：不注册 adapter/provider（模型从选择器消失），面板/计数/媒体工具照常。
  // 聊天走手工 provider 时改插件不再中断请求；需要服务端内置工具时保持 true 并手动选本插件模型。
  registerProvider: z.boolean().default(true).description("是否注册模型 provider。false = 观察-only：模型从选择器消失，但面板计数、权益工具、目录补货照常工作（聊天走手工线路时改插件不再中断请求）。"),
  // 旁路观察名单：这些 provider 的模型调用也计入面板「本周期调用次数」（本插件 providerId 始终在内）。
  watchedProviders: z.array(z.string()).default(["qwentokenplan"]).description("旁路观察名单：这些 provider 的模型调用也计入面板「本周期调用次数」。本插件自身始终在内，无需重复填写。"),
  // 目录补货：定期从普通线路（pi-ai 手工 provider）自己的域名抓 /models，
  // 把新对话模型追加进它的 models 配置（只追加、真变化才写、免重启生效）。
  catalogFeed: z.boolean().default(true).description("目录补货：定期从普通线路自己的域名抓 /models，把新对话模型追加进它的 models 配置（只追加、真变化才写、免重启生效）。"),
  feedProvider: z.string().default("qwentokenplan").description("补货目标：新模型追加到哪个手工 provider 的 models 里。"),
  // 补货时是否翻译推理档位（reasoningEfforts + compat.thinkingFormat）；false 只补 id/name/容量/模态。
  feedReasoning: z.boolean().default(true).description("补货时是否翻译推理档位。false 则只补 id/名称/容量/模态，档位吃目标线路的默认值。"),
});

/** tierRefreshHours 宿主侧兜底缺省值，与 Config 默认保持一致。 */
const DEFAULT_TIER_REFRESH_HOURS = 1;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** 路由守卫：实现见 lib/route-guard.js（含 DNS rebinding 的实测背景与取舍说明）。 */
function trustedRouteRequestFor(server) {
  // 本进程的绑定地址（如 "127.0.0.1"）：Host 除回环外，只允许等于它。
  const bindHost = (() => { try { return String(server?.host ?? ""); } catch { return ""; } })();
  return (req) => trustedRouteRequest(req, bindHost);
}

export function apply(ctx, config = {}) {
  const providerId = String(config.providerId || "qwen-token-plan-full");
  const displayName = String(config.displayName || "千问 Token Plan 全能版");
  const apiKeyEnv = String(config.apiKeyEnv || "QWEN_TOKEN_PLAN_CN_API_KEY");
  const harnessMode = normalizeHarnessMode(config.harness);

  // —— 端点：auto 先按国内站装配，启动探测出结果后整套 URL 一起换（见下方 effect）。——
  // route 是唯一的 URL 来源：adapter / catalog / media tools 都从它取值，
  // 避免「只改了对话端点，图片视频还打旧地域」这种半切换。
  const autoEndpoint = isAutoEndpoint(config.endpoint);
  const explicitChat = typeof config.chatEndpoint === "string" && config.chatEndpoint.trim() !== ""
    ? config.chatEndpoint.trim() : "";
  // 必须是**同一个对象**：media tools 注册时捕获了它的引用，探测出结果后只能就地改属性，
  // 换成新对象会让已注册的图片/视频工具永远拿着旧地域（2026-11-17）。
  const route = deriveRoute(autoEndpoint ? DEFAULT_ENDPOINT : String(config.endpoint).trim());
  if (explicitChat) route.chatEndpoint = explicitChat;
  let siteState = autoEndpoint
    ? { site: "auto", reason: "站点探测中" }
    : { site: "manual", reason: "用户显式指定 endpoint" };

  const registerProvider = config.registerProvider !== false;
  // 观察名单：手工 provider（默认 qwentokenplan）+ 本插件自身。媒体工具门控同用此名单。
  const watchedProviders = Array.isArray(config.watchedProviders)
    ? config.watchedProviders.map(String) : ["qwentokenplan"];
  const watched = new Set([providerId, ...watchedProviders]);

  const overrides = Array.isArray(config.models) ? config.models : [];
  const excludes = Array.isArray(config.excludeModels) ? config.excludeModels.map(String) : [];
  const refreshMinutes = Number.isFinite(config.catalogRefreshMinutes) && config.catalogRefreshMinutes >= 1
    ? config.catalogRefreshMinutes : 30;
  const tierRefreshHours = Number.isFinite(config.tierRefreshHours) && config.tierRefreshHours >= 0.5
    ? config.tierRefreshHours : DEFAULT_TIER_REFRESH_HOURS;

  // 出站代理：Node 的 fetch 不读系统代理设置，需要时由配置或环境变量显式指定。
  // 未配置且无环境变量时原样返回原生 fetch —— 行为与改动前完全一致。
  const proxyFetch = createProxyFetch({ proxy: config.proxy, logger: ctx.logger });
  const proxyLabel = redactProxyUrl(typeof config.proxy === "string" && config.proxy.trim() !== ""
    ? (proxyFetch === globalThis.fetch ? "" : config.proxy)
    : proxyFetch.proxyUrl);
  if (proxyLabel) ctx.logger?.info?.(`${name}: 出站请求经代理 ${proxyLabel}`);

  const catalog = new DynamicCatalog({
    ctx, modelsUrl: route.modelsUrl, apiKeyEnv, pluginName: name, overrides, excludes, logger: ctx.logger,
    fetchImpl: proxyFetch,
  });

  // 服务端权益调用预算：上限按 Token Plan 等级自动推导（网关 quota-config ÷ perCallCredits）。
  const budget = new HarnessBudget({ config, logger: ctx.logger });

  // Harness 权益 MCP 通道：有百炼按量付费 Key 才挂（没 Key 挂了也是 401）。
  // 挂上后该能力从服务端内置工具手里接管过来 —— 内置工具走模型 API 只扣 Credits，
  // MCP 才真正消耗套餐单列的权益额度。额度耗尽自动摘除、内置工具回来（用户选定策略）。
  const mcp = registerEquityMcp(ctx, {
    apiKeyEnv: String(config.bailianApiKeyEnv || "BAILIAN_PAYG_API_KEY"),
    host: String(config.mcpHost || MCP_HOSTS.cn),
    mode: config.mcpEquity,
    budget, logger: ctx.logger, pluginName: name,
  });

  // 目录补货器：聊天固定走普通线路时，新模型由这里补进普通线路的名单（见 lib/catalog-feed.js）。
  const feed = config.catalogFeed === false ? null : new CatalogFeed({
    ctx, catalog, feedProvider: String(config.feedProvider || "qwentokenplan"),
    feedReasoning: config.feedReasoning !== false,
    pluginName: name, fetchImpl: proxyFetch, logger: ctx.logger,
  });

  const adapter = new QwenTokenPlanAdapter({
    ctx, catalog, providerId, displayName, apiKeyEnv,
    endpoint: route.endpoint, chatEndpoint: route.chatEndpoint, harnessMode,
    pluginName: name, budget, mcp, fetchImpl: proxyFetch,
    // 两个跨境旋钮必须真的传下去：不传就是恒 60s + 宿主默认 5 次重试（2026-11-17 修复）。
    requestTimeoutMs: config.requestTimeoutMs,
    retryPolicy: config.retryPolicy,
  });

  if (registerProvider) {
    ctx.llm.registerConfigurableProviders([{
      provider: providerId,
      displayName,
      settingsNs: ctx.fiber.entry?.options.id ?? "qwen-token-plan-full",
      settingsPath: [],
    }]);
  }

  let stopped = false;
  const lifetime = new AbortController();
  const refreshSignal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
  // 能力探测要独立预算：每个新模型 11 次串行真实生成请求，30s 的目录刷新预算装不下。
  // 2026-11-18 线上实测同一个 qwen4-max-preview：30s → 只发出 10 个请求、maxTokens
  // 探成 131072；180s → 11 个请求、393216（真值）。被掐的位置随网络抖动而变，
  // 结果不稳定，且降级值会被缓存固化。/models 本身仍用 30s（那只是一个 GET）。
  const PROBE_BUDGET_MS = 180_000;
  const probeSignal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(PROBE_BUDGET_MS)]);
  // 面板点刷新时最多同步等这么久，之后先回旧快照、探测转后台。必须显著小于前端的
  // REFRESH_TIMEOUT_MS（45s，lib/client.js），否则用户等到的是前端超时报错而不是状态。
  const FOREGROUND_REFRESH_WAIT_MS = 8_000;

  // 等级信息：立即取一次，之后按 tierRefreshHours（默认 1 小时）周期刷新；
  // 控制台 Cookie 缺失或网关失败时用 config.tier/内置表兜底（standard），预算机制不失效。
  // Cookie 类失败自动触发登录会话（autoRelogin 开启且有 Chrome 桥时）：开登录页轮询收割，
  // 登录成功 → 新 Cookie 写回 ~/.dsh/.env + 凭据服务 → 立即重取等级/权益（见下方 relogin）。
  const cookieEnv = String(config.consoleCookieEnv || "BAILIAN_CONSOLE_COOKIE");
  const resolveCookie = async () => {
    const storedCookie = await ctx.credentials.resolve(cookieEnv);
    return storedCookie?.value ?? readConsoleCookie(cookieEnv);
  };
  let tierRefreshing = null;
  let tierRetryTimer = null;
  // 「60 秒后自动重试一次」必须名副其实：重试再失败不再排下一次，
  // 否则断网时每分钟 fetch+setTierFallback→budget#save 无限写盘（2026-11-13 修复）。
  let tierRetried = false;
  const refreshTier = () => {
    if (tierRefreshing) return tierRefreshing;
    tierRefreshing = (async () => {
      try {
        const cookie = await resolveCookie();
        if (!cookie) {
          budget.setTierFallback(`未配置 ${cookieEnv}（~/.dsh/.env）`);
          relogin.maybeAuto(`未配置 ${cookieEnv}`).catch(() => {});
          return;
        }
        const info = await fetchTierInfo({ cookie, fetchImpl: proxyFetch, signal: refreshSignal() });
        if (!stopped) {
          budget.setTier(info);
          // 取数成功 = Cookie 仍有效：清零自动登录的连续失败计数。
          relogin.noteSuccess();
        }
      } catch (error) {
        if (stopped) return;
        const reason = error instanceof Error ? error.message : String(error);
        budget.setTierFallback(reason);
        // Cookie 过期/失效签名 → 自动开登录会话（冷却期内不重复弹页）。
        relogin.maybeAuto(reason).catch(() => {});
        // 启动/热重载瞬间宿主网络偶发未就绪（实测一次 "fetch failed"，重试即恢复）：
        // 60 秒后自动重试一次，避免带着兜底等级等满整个刷新周期。只重试一次：
        // 再失败交给周期刷新（tierRefreshHours）兜底，不无限排 60s。
        if (!tierRetried) {
          tierRetried = true;
          const retry = () => { tierRetryTimer = null; if (!stopped) refreshTier().catch(() => {}); };
          tierRetryTimer = typeof ctx.timeout === "function" ? ctx.timeout(retry, 60_000) : setTimeout(retry, 60_000);
        }
      } finally {
        tierRefreshing = null;
      }
    })();
    return tierRefreshing;
  };

  // 登录会话编排：成功后立即重取等级与权益（面板恢复真实数据的钩子）。
  const relogin = new ReloginFlow({
    ctx,
    cookieEnv,
    logger: ctx.logger,
    autoEnabled: config.autoRelogin !== false,
    onSuccess: async () => {
      if (stopped) return;
      await Promise.allSettled([refreshTier(), refreshEquities()]);
    },
  });

  // 权益明细（每项权益 剩余/周期配额，控制台 queryTokenPlanEquityInfo 同源）：
  // 每 10 分钟刷新一次 + 面板点「刷新」强制回源；失败保留旧数据（面板回退静态配额）。
  const EQUITY_REFRESH_MS = 10 * 60_000;
  let equityRefreshing = null;
  const refreshEquities = () => {
    if (equityRefreshing) return equityRefreshing;
    equityRefreshing = (async () => {
      try {
        const cookie = await resolveCookie();
        if (!cookie) return;
        const list = await fetchEquityInfo({ cookie, fetchImpl: proxyFetch, signal: refreshSignal() });
        // 成功但返回空列表（等级不含权益/接口结构变更）也要落盘：否则旧快照会一直
        // 被当成新鲜数据，把已经变化的额度继续按旧值判定。
        if (!stopped) {
          budget.setEquities(list);
          // 官方余额是唯一的挂/摘依据：回源后立刻重算，耗尽的服务当场摘掉，
          // 让内置工具接回去（否则模型会继续调一个必然超额失败的 MCP 工具）。
          mcp.refresh();
        }
      } catch { /* 保留旧数据；下轮周期或面板刷新再试 */ }
      finally { equityRefreshing = null; }
    })();
    return equityRefreshing;
  };

  const makeTimer = (fn, ms) => (typeof ctx.interval === "function" ? ctx.interval(fn, ms) : setInterval(fn, ms));
  const clearTimer = (t) => { try { if (typeof t === "function") t(); else { clearInterval(t); clearTimeout(t); } } catch { /* best effort */ } };
  // options.reprobe=true 用于「上次被掐断」的恢复：清掉探测缓存重探。
  // options.foreground=true 用于面板手动刷新（HTTP 请求）：此时**不等**能力探测。
  // 为什么必须分开：面板 fetch 有 45s 上限（lib/client.js REFRESH_TIMEOUT_MS），而探测
  // 预算是 180s；让用户的一个点击同步等最长 3 分钟的付费生成，只会等到前端超时报错、
  // 后台却还在花钱。所以前台刷新只保证「目录 + 余额」立刻回来，探测转后台继续，
  // 探完由 emitAdaptersUpdated 通知宿主，下一轮轮询自然看到新规格。
  let probing = false;
  const refreshCatalog = (options = {}) => {
    const { foreground = false, ...rest } = options;
    const task = catalog.refresh(refreshSignal(), { probeSignal: probeSignal(), ...rest }).then((updated) => {
      if (updated && !stopped) ctx.llm.emitAdaptersUpdated();
      return updated;
    });
    if (!foreground) return task;
    // 目录部分（/models，30s 预算）与探测部分（180s）之间没有可观测的分界点，
    // 所以前台只给 task 一个短观察窗：窗内完成就用真结果，否则先回旧快照。
    // 任务本身**不取消**（探测已在跑，取消等于白花钱），只是不再让用户等它。
    probing = true;
    task.catch(() => {}).finally(() => { probing = false; });
    return Promise.race([task, new Promise((r) => { const t = setTimeout(() => r(false), FOREGROUND_REFRESH_WAIT_MS); t.unref?.(); })]);
  };
  // 目录刷新后顺带补货。关键坑（2026-11-17 实测）：HMR 事务用 AsyncLocalStorage 标记，
  // 异步链会继承——启动 tick 生在事务里，延后多久的定时器回调都仍带标记，直接调
  // configEditor.edit 必报 "HMR transactions cannot be nested"。而 HTTP 处理器跑在
  // webServer 启动时的干净上下文里，所以补货经「回环自触发」执行：定时端只发一个
  // loopback POST /feed，真正的 edit 在服务端处理器里做。无 webServer 的组合（headless）
  // 没有 HMR，直接调即可。
  const triggerFeed = () => {
    if (stopped || !feed) return;
    let origin;
    try { origin = ctx.get?.("webServer")?.getOrigin?.(); } catch { /* 监听未绑定 */ }
    if (!origin) { feed.run().catch(() => {}); return; }
    // 必须用原生 fetch 直连回环，不能走 proxyFetch（代理会把本机请求绕出去）。
    globalThis.fetch(`${origin}${ROUTE_PREFIX}/feed`, { method: "POST", signal: AbortSignal.timeout(60_000) })
      .catch(() => { /* 触发失败等下一周期或面板手动刷新 */ });
  };
  const catalogTick = () => {
    if (stopped) return;
    refreshCatalog().catch(() => {}).then(() => {
      if (stopped || !feed) return;
      if (typeof ctx.timeout === "function") ctx.timeout(triggerFeed, 5_000);
      else setTimeout(triggerFeed, 5_000);
    });
  };
  const tierTick = () => { if (!stopped) refreshTier().catch(() => {}); };

  const statusPayload = () => {
    const snapshot = catalog.snapshot();
    const mcpStatus = mcp.status();
    return {
      ...budget.status(),
      // Harness 权益 MCP 通道状态：面板据此标注每项权益此刻花的是「权益额度」还是「Credits」。
      mcp: mcpStatus,
      // 逐项来源：equity = 走 MCP 扣权益；credits = 走模型 API 扣 Credits。
      // 面板不再只报余额，而是把「这笔钱从哪出」讲清楚（用户 2026-11-23 要求）。
      equityChannels: Object.fromEntries(
        (budget.equitiesState() ?? []).map((state) => [state.key, equityChannel(state.key, mcpStatus)]),
      ),
      // 登录会话状态：waiting = 已开登录页等待收割；failed = 上次会话失败（面板给指引）。
      relogin: relogin.state(),
      provider: {
        id: providerId,
        displayName,
        models: snapshot.models.length,
        catalogSource: snapshot.source,
        catalogSyncedAt: snapshot.syncedAt ?? null,
        // 目录/探测的失败原因要能看见：探测被掐断时 source 仍是 "live"（目录确实拉到了），
        // 只有 lastError 里的 probe-incomplete 痕迹能说明「规格是保守推断出来的」。
        catalogError: catalog.lastError ?? null,
        // 探测是否还在后台跑：面板据此显示「规格探测中」，而不是让用户以为卡住了。
        probing,
        // 面板要能看出「这把 key 到底落在哪个站点」，否则跨境 401 时无从排查。
        endpoint: route.endpoint,
        site: siteState.site,
        siteReason: siteState.reason,
        requestTimeoutMs: adapter.requestTimeoutMs,
      },
      // 观察模式状态：registerProvider=false 时聊天不经过本插件，计数来自 session/event 旁路。
      observe: { registerProvider, watchedProviders: [...watched] },
      // 目录补货状态：lastAdded/lastError/seenCount 供面板与排查。
      feed: feed ? feed.status() : { enabled: false },
    };
  };

  // —— 资源全部挂 ctx.effect：清理函数由 Cordis 在 fiber dispose 时执行（热切换不泄漏）。——

  if (registerProvider) {
    ctx.effect(() => {
      const handle = ctx.llm.registerAdapter([providerId], adapter);
      return () => {
        try { if (typeof handle === "function") handle(); else handle?.dispose?.(); } catch { /* best effort */ }
      };
    }, "qwen-token-plan-full: adapter");
  }

  // 旁路调用观察器：订阅 session/event（只读事后广播，监听器异常被宿主隔离，绝不反向影响请求）。
  // 聊天走手工 provider（pi-ai）时，adapter 内的计数够不着这些请求，这里补上：
  // - provider 识别首选 assistant/message 内嵌 finish chunk 的 replayState.response.provider
  //   （pi-ai 每条消息都带，插件热重载后会话中途也能立即识别）；
  // - 兜底用 request/context、request/header 跟踪会话当前 provider（覆盖不带 replayState 的适配器）。
  // 只计成功落定的 assistant/message（一次 = 一次 API 调用）；失败 attempt 不计（NO_ADAPTER 等根本没出门）。
  // 会话恢复/重放不发 session/event，不会重复计数；WeakMap 随会话对象回收，无泄漏。
  ctx.effect(() => {
    const sessionProviders = new WeakMap();
    const providerOfMessage = (event) => {
      const stream = event?.data?.stream;
      if (!Array.isArray(stream)) return undefined;
      for (const entry of stream) {
        const chunk = entry?.chunk;
        if (chunk?.type === "finish") {
          const p = chunk.replayState?.response?.provider;
          if (typeof p === "string" && p) return p;
        }
      }
      return undefined;
    };
    const onSessionEvent = (session, event) => {
      try {
        const type = event?.type;
        if (type === "request/context") {
          const p = event.data?.provider;
          if (typeof p === "string" && p) sessionProviders.set(session, p);
          return;
        }
        if (type === "request/header") {
          const p = event.data?.header?.config?.provider;
          if (typeof p === "string" && p) sessionProviders.set(session, p);
          return;
        }
        if (type === "assistant/message") {
          const p = providerOfMessage(event) ?? sessionProviders.get(session);
          if (p && watched.has(p)) budget.recordRequest();
        }
      } catch { /* 观察器永不影响会话事件流 */ }
    };
    const off = ctx.on("session/event", onSessionEvent);
    return () => { try { if (typeof off === "function") off(); else ctx.off?.("session/event", onSessionEvent); } catch { /* best effort */ } };
  }, "qwen-token-plan-full: usage observer");

  // 站点自动判定：启动时并发探测国内站/国际站，命中后把整套 URL 一起换。
  // 判定不出来（无 key / 两站点都不通 / 断网）时保留国内站默认值，插件照常可用。
  const detectOnce = async () => {
    try {
      const result = await detectSite({
        ctx, apiKeyEnv, pluginName: name, fetchImpl: proxyFetch,
        signal: lifetime.signal, logger: ctx.logger,
      });
      if (stopped) return;
      siteState = { site: result.site, reason: result.reason, probed: result.probed === true };
      if (result.endpoint === route.endpoint) return;
      // 就地改：media tools 捕获的是这个对象本身，换新对象它们就看不见。
      Object.assign(route, deriveRoute(result.endpoint), explicitChat ? { chatEndpoint: explicitChat } : {});
      adapter.retarget({ endpoint: route.endpoint, chatEndpoint: route.chatEndpoint });
      catalog.retarget(route.modelsUrl);
      ctx.logger?.info?.(`${name}: Token Plan 站点判定为 ${result.site}（${result.reason}），端点已切到 ${route.endpoint}`);
      ctx.llm.emitAdaptersUpdated();
    } catch (error) {
      if (stopped) return;
      siteState = { site: "cn", reason: `判定异常：${error instanceof Error ? error.message : String(error)}`, probed: false };
      ctx.logger?.warn?.(`${name}: 站点自动判定异常，保留国内站端点（${siteState.reason}）`);
    }
  };
  // 判定成功才固化；失败（断网/超时/两站点都不通）留 null 让下次重试。
  //
  // 为什么不能连失败一起缓存：siteTask ??= detectOnce() 会把「启动瞬间断网 → 回落 cn」
  // 永久钉住。国际站 key 在国内站一律 401，而 AUTH 不在 DEFAULT_RETRYABLE_CODES 里，
  // llm-retry 不救 → 网络恢复后每一轮仍然直接失败，只能重启进程。
  // 2026-11-18 实测：启动期断网后连续三轮全是 AUTH 401，恢复后重探次数 0。
  let siteTask = null;
  let siteResolved = false;
  let siteRetryAfter = 0;
  // 失败后的重试冷却：没有它，断网时每个请求都要先白等满 15s 探测预算
  // （两个站点各一次），比原来的「只探一次」更慢。30s 与目录刷新同量级。
  const SITE_RETRY_COOLDOWN_MS = 30_000;
  const resolveSite = ({ force = false } = {}) => {
    if (siteResolved || stopped) return Promise.resolve();
    // 手动刷新要绕过冷却：用户点「刷新」正是想立刻重试，让他再等 30s 说不通。
    // 但在途的仍复用同一个 Promise —— 并发点击不该重复打上游。
    if (force) siteRetryAfter = 0;
    else if (Date.now() < siteRetryAfter) return Promise.resolve();
    siteTask ??= detectOnce().then(() => {
      // detectOnce 内部已把成功/失败写进 siteState；只有拿到 200 才算判定完成。
      if (siteState.probed) siteResolved = true;
      else { siteTask = null; siteRetryAfter = Date.now() + SITE_RETRY_COOLDOWN_MS; }
    }).catch(() => { siteTask = null; siteRetryAfter = Date.now() + SITE_RETRY_COOLDOWN_MS; });
    return siteTask;
  };
  /** 供请求路径用：冷却期内 resolveSite 自己会直接放行，不拿探测预算压住用户这一轮。 */
  const resolveSiteForRequest = () => resolveSite();

  // 判定必须挡在**第一个模型请求之前**：国际站 key 在国内站一律 401，而 401 不在
  // 可重试码里（DEFAULT_RETRYABLE_CODES），漏一轮就是整轮直接失败、llm-retry 也不救。
  // 只在 auto 且还没判完时等，正常路径零额外开销；探测失败也放行（绝不因为探测卡住而拒绝服务）。
  if (autoEndpoint) {
    const originalStream = adapter.stream.bind(adapter);
    adapter.stream = async function* gatedStream(options) {
      await resolveSiteForRequest();
      yield* originalStream(options);
    };
  }

  if (config.mediaTools !== false && typeof ctx.tools?.register === "function") {
    const imageModels = Array.isArray(config.imageModels) && config.imageModels.length
      ? config.imageModels.map(String) : DEFAULT_IMAGE_MODELS;
    const videoModels = Array.isArray(config.videoModels) && config.videoModels.length
      ? config.videoModels.map(String) : DEFAULT_VIDEO_MODELS;
    ctx.effect(() => {
      const disposeTools = registerMediaTools(ctx, {
        apiKeyEnv, pluginName: name, route,
        // 媒体工具自己发请求，绕过 adapter.stream 的门控；观察-only 时更是唯一出口。
        awaitSite: autoEndpoint ? resolveSiteForRequest : undefined,
        imageModels, videoModels,
        defaultImageModel: String(config.defaultImageModel || imageModels[0]),
        defaultVideoModel: String(config.defaultVideoModel || videoModels[0]),
        providerId, acceptProviders: watchedProviders, fetchImpl: proxyFetch,
        logger: ctx.logger,
        budget,
        // 生图双通道：权益额度还有且 MCP 连通就走 MCP（扣权益），否则回落模型 API（扣 Credits）。
        mcp,
      });
      return () => { try { disposeTools(); } catch { /* best effort */ } };
    }, "qwen-token-plan-full: media tools");
  }

  // MCP 权益通道的生命周期交给 Cordis：热切换/卸载时撤 guard、摘服务，不留悬挂工具。
  ctx.effect(() => () => { try { mcp.dispose(); } catch { /* best effort */ } },
    "qwen-token-plan-full: equity mcp");

  // 面板数据路由：GET status / POST refresh / POST login(±cancel)（仅同源）。
  ctx.effect(() => {
    const server = ctx.get?.("webServer");
    if (server === undefined || typeof server.register !== "function") return () => {};
    try {
      // 所有分支（含 404/405）都必须先过守卫：DSH 的 prefix 路由不做任何鉴权，
      // 不在这里拦就等于把面板数据与登录操作暴露给任意网页（见 route-guard.js）。
      const trusted = trustedRouteRequestFor(server);
      const handle = server.register({
        kind: "prefix",
        path: ROUTE_PREFIX,
        async handler(req, res) {
          if (!trusted(req)) return json(res, 403, { error: "forbidden" });
          let sub = "";
          try {
            sub = new URL(req.url ?? "/", "http://localhost").pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, "");
          } catch { /* keep "" */ }
          if (req.method === "GET" && (sub === "" || sub === "status")) {
            return json(res, 200, statusPayload());
          }
          if (req.method === "POST" && sub === "refresh") {
            // 必须先等站点判定：判定窗口（≤15s）内点面板刷新会拿旧端点打 /models，
            // 国际站 key 在国内站 401 → 面板显示 lastError。
            if (autoEndpoint) await resolveSite({ force: true });
            // 只有上次探测没探完（lastError 留了 probe-incomplete 痕迹）才重探。
            // 点徽标就会走这条路由，无条件 reprobe 等于每开一次面板就对每个新模型
            // 重打 11 次**真实生成**请求 —— 那是花用户的 Credits 买同一个答案。
            const incomplete = String(catalog.lastError ?? "").includes("probe-incomplete");
            await Promise.allSettled([refreshTier(), refreshCatalog({ reprobe: incomplete, foreground: true }), refreshEquities(), ...(feed ? [feed.run()] : [])]);
            return json(res, 200, statusPayload());
          }
          // 补货触发端点：定时端经回环 POST 到这里，edit 跑在 HTTP 的干净异步上下文，
          // 避开 HMR 事务的 AsyncLocalStorage 继承（见 catalogTick 注释）。
          if (req.method === "POST" && sub === "feed") {
            if (!feed) return json(res, 404, { error: "feed disabled" });
            const r = await feed.run();
            return json(res, 200, { ...statusPayload(), feedResult: r });
          }
          // 面板「一键登录」：开 Chrome 登录页并进入收割轮询；结果由后续 status 轮询带回。
          if (req.method === "POST" && sub === "login") {
            const r = await relogin.start({ auto: false });
            return json(res, r.ok ? 200 : 502, { ...statusPayload(), login: r });
          }
          if (req.method === "POST" && sub === "login/cancel") {
            relogin.cancel("用户取消了登录");
            return json(res, 200, statusPayload());
          }
          return json(res, 404, { error: "not found" });
        },
      });
      return typeof handle === "function" ? handle : () => { try { handle?.dispose?.(); } catch { /* best effort */ } };
    } catch (error) {
      ctx.logger?.warn?.(`${name}: 状态路由注册失败（${error instanceof Error ? error.message : String(error)}）`);
      return () => {};
    }
  }, "qwen-token-plan-full: status route");

  ctx.effect(() => {
    // 先定站点再拉目录：否则第一次目录刷新会打到旧站点，白跑一趟还可能覆盖成错目录。
    // 不 await 整个 effect：那会把三个定时器的注册也推迟到探测之后（cordis 异步 effect 语义）。
    if (autoEndpoint) resolveSite().then(catalogTick).catch(() => {});
    else catalogTick();
    tierTick();
    refreshEquities().catch(() => {});
    const catalogTimer = makeTimer(catalogTick, refreshMinutes * 60_000);
    const tierTimer = makeTimer(tierTick, tierRefreshHours * 3_600_000);
    const equityTimer = makeTimer(() => { if (!stopped) refreshEquities().catch(() => {}); }, EQUITY_REFRESH_MS);
    return () => {
      stopped = true;
      lifetime.abort();
      relogin.dispose();
      clearTimer(catalogTimer);
      clearTimer(tierTimer);
      clearTimer(equityTimer);
      clearTimer(tierRetryTimer);
      tierRetryTimer = null;
    };
  }, "qwen-token-plan-full: timers");

  // 启动日志里的 MCP 一行：只说「有没有 Key」这个此刻确定的事实。
  // 挂/摘是异步的（要等凭据解析），这里不报服务数，免得日志与真实状态打架。
  const mcpBoot = mcp.status();
  const bailianRef = String(config.bailianApiKeyEnv || "BAILIAN_PAYG_API_KEY");
  const mcpBootText = !mcpBoot.enabled
    ? (mcpBoot.reason === "no-manager" ? "关闭（宿主无 mcpManager）" : "关闭")
    : (mcpBoot.keyPresent ? `已配 Key（${bailianRef}），按余额挂/摘` : `待配 Key（${bailianRef}），当前仍走模型 API 扣 Credits`);

  ctx.logger?.info?.(
    `${name}: ${registerProvider ? `已注册 provider "${providerId}"` : "观察-only（未注册 provider）"}` +
    `（Responses=${route.endpoint}；Chat=${route.chatEndpoint}；` +
    `站点 ${autoEndpoint ? "自动判定中" : "手动指定"}；空闲超时 ${adapter.requestTimeoutMs}ms；` +
    `内置工具 ${harnessMode.mode}；权益预算 ${budget.enabled ? "开启（等级自动上限）" : "关闭"}；` +
    `权益 MCP ${mcpBootText}；` +
    `媒体工具 ${config.mediaTools === false ? "关闭" : "开启"}；调用观察 ${[...watched].join("/")}；` +
    `目录补货 ${feed ? `开启 → ${String(config.feedProvider || "qwentokenplan")}${config.feedReasoning === false ? "（不含档位）" : ""}` : "关闭"}；目录每 ${refreshMinutes} 分钟刷新；` +
    `套餐每 ${tierRefreshHours} 小时刷新；Cookie 失效${config.autoRelogin === false ? "不会" : "将"}自动开登录页收割）`,
  );
}

apply.inject = inject;
apply.Config = Config;
export default apply;
