import z from "@deepseek-ai/schemastery";
import { RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { DynamicCatalog } from "./lib/catalog.js";
import { QwenTokenPlanAdapter } from "./lib/adapter.js";
import { registerMediaTools } from "./lib/media-tools.js";
import { normalizeHarnessMode } from "./lib/harness.js";
import { HarnessBudget } from "./lib/budget.js";
import { fetchTierInfo, fetchEquityInfo, readConsoleCookie } from "./lib/gateway.js";
import { ReloginFlow } from "./lib/relogin.js";
import { createProxyFetch, redactProxyUrl } from "./lib/proxy.js";
import { trustedRouteRequest } from "./lib/route-guard.js";
import { SITE_ENDPOINTS, deriveRoute, isAutoEndpoint, detectSite } from "./lib/site.js";

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
  endpoint: z.string().default("auto"),
  chatEndpoint: z.string(),
  harness: z.any().default("auto"),
  mediaTools: z.boolean().default(true),
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
  requestTimeoutMs: z.number().min(1_000).default(120_000),
  // 请求重试策略（DSH 的 llm-retry 在 provider 配置下读取，见 dsh-llm 的 RetryPolicySchema）。
  // 跨境每次重试都要重新全量上传整段历史，DSH 默认的 5 次会把一次抖动放大成分钟级假死，
  // 所以这里默认降到 2 次、退避起点抬到 1000ms。
  retryPolicy: RetryPolicySchema.default({
    mode: "normal",
    maxRetries: 2,
    backoff: { initialDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.1 },
  }),
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

  const adapter = new QwenTokenPlanAdapter({
    ctx, catalog, providerId, displayName, apiKeyEnv,
    endpoint: route.endpoint, chatEndpoint: route.chatEndpoint, harnessMode,
    pluginName: name, budget, fetchImpl: proxyFetch,
    // 两个跨境旋钮必须真的传下去：不传就是恒 60s + 宿主默认 5 次重试（2026-11-17 修复）。
    requestTimeoutMs: config.requestTimeoutMs,
    retryPolicy: config.retryPolicy,
  });

  ctx.llm.registerConfigurableProviders([{
    provider: providerId,
    displayName,
    settingsNs: ctx.fiber.entry?.options.id ?? "qwen-token-plan-full",
    settingsPath: [],
  }]);

  let stopped = false;
  const lifetime = new AbortController();
  const refreshSignal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);

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
        if (!stopped) budget.setEquities(list);
      } catch { /* 保留旧数据；下轮周期或面板刷新再试 */ }
      finally { equityRefreshing = null; }
    })();
    return equityRefreshing;
  };

  const makeTimer = (fn, ms) => (typeof ctx.interval === "function" ? ctx.interval(fn, ms) : setInterval(fn, ms));
  const clearTimer = (t) => { try { if (typeof t === "function") t(); else { clearInterval(t); clearTimeout(t); } } catch { /* best effort */ } };
  const refreshCatalog = () => catalog.refresh(refreshSignal()).then((updated) => {
    if (updated && !stopped) ctx.llm.emitAdaptersUpdated();
    return updated;
  });
  const catalogTick = () => { if (!stopped) refreshCatalog().catch(() => {}); };
  const tierTick = () => { if (!stopped) refreshTier().catch(() => {}); };

  const statusPayload = () => {
    const snapshot = catalog.snapshot();
    return {
      ...budget.status(),
      // 登录会话状态：waiting = 已开登录页等待收割；failed = 上次会话失败（面板给指引）。
      relogin: relogin.state(),
      provider: {
        id: providerId,
        displayName,
        models: snapshot.models.length,
        catalogSource: snapshot.source,
        catalogSyncedAt: snapshot.syncedAt ?? null,
        // 面板要能看出「这把 key 到底落在哪个站点」，否则跨境 401 时无从排查。
        endpoint: route.endpoint,
        site: siteState.site,
        siteReason: siteState.reason,
        requestTimeoutMs: adapter.requestTimeoutMs,
      },
    };
  };

  // —— 资源全部挂 ctx.effect：清理函数由 Cordis 在 fiber dispose 时执行（热切换不泄漏）。——

  ctx.effect(() => {
    const handle = ctx.llm.registerAdapter([providerId], adapter);
    return () => {
      try { if (typeof handle === "function") handle(); else handle?.dispose?.(); } catch { /* best effort */ }
    };
  }, "qwen-token-plan-full: adapter");

  // 站点自动判定：启动时并发探测国内站/国际站，命中后把整套 URL 一起换。
  // 判定不出来（无 key / 两站点都不通 / 断网）时保留国内站默认值，插件照常可用。
  const detectOnce = async () => {
    try {
      const result = await detectSite({
        ctx, apiKeyEnv, pluginName: name, fetchImpl: proxyFetch,
        signal: lifetime.signal, logger: ctx.logger,
      });
      if (stopped) return;
      siteState = { site: result.site, reason: result.reason };
      if (result.endpoint === route.endpoint) return;
      // 就地改：media tools 捕获的是这个对象本身，换新对象它们就看不见。
      Object.assign(route, deriveRoute(result.endpoint), explicitChat ? { chatEndpoint: explicitChat } : {});
      adapter.retarget({ endpoint: route.endpoint, chatEndpoint: route.chatEndpoint });
      catalog.retarget(route.modelsUrl);
      ctx.logger?.info?.(`${name}: Token Plan 站点判定为 ${result.site}（${result.reason}），端点已切到 ${route.endpoint}`);
      ctx.llm.emitAdaptersUpdated();
    } catch (error) {
      if (stopped) return;
      siteState = { site: "cn", reason: `判定异常：${error instanceof Error ? error.message : String(error)}` };
      ctx.logger?.warn?.(`${name}: 站点自动判定异常，保留国内站端点（${siteState.reason}）`);
    }
  };
  // 只探一次；后到的调用者等同一个结果，不重复打上游。
  let siteTask = null;
  const resolveSite = () => { siteTask ??= detectOnce(); return siteTask; };

  // 判定必须挡在**第一个模型请求之前**：国际站 key 在国内站一律 401，而 401 不在
  // 可重试码里（DEFAULT_RETRYABLE_CODES），漏一轮就是整轮直接失败、llm-retry 也不救。
  // 只在 auto 且还没判完时等，正常路径零额外开销；探测失败也放行（绝不因为探测卡住而拒绝服务）。
  if (autoEndpoint) {
    const originalStream = adapter.stream.bind(adapter);
    adapter.stream = async function* gatedStream(options) {
      await resolveSite();
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
        imageModels, videoModels,
        defaultImageModel: String(config.defaultImageModel || imageModels[0]),
        defaultVideoModel: String(config.defaultVideoModel || videoModels[0]),
        providerId, fetchImpl: proxyFetch,
        logger: ctx.logger,
        budget,
      });
      return () => { try { disposeTools(); } catch { /* best effort */ } };
    }, "qwen-token-plan-full: media tools");
  }

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
            await Promise.allSettled([refreshTier(), refreshCatalog(), refreshEquities()]);
            return json(res, 200, statusPayload());
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

  ctx.logger?.info?.(
    `${name}: 已注册 provider "${providerId}"（Responses=${route.endpoint}；Chat=${route.chatEndpoint}；` +
    `站点 ${autoEndpoint ? "自动判定中" : "手动指定"}；空闲超时 ${adapter.requestTimeoutMs}ms；` +
    `内置工具 ${harnessMode.mode}；权益预算 ${budget.enabled ? "开启（等级自动上限）" : "关闭"}；` +
    `媒体工具 ${config.mediaTools === false ? "关闭" : "开启"}；目录每 ${refreshMinutes} 分钟刷新；` +
    `套餐每 ${tierRefreshHours} 小时刷新；Cookie 失效${config.autoRelogin === false ? "不会" : "将"}自动开登录页收割）`,
  );
}

apply.inject = inject;
apply.Config = Config;
export default apply;
