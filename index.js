import z from "@deepseek-ai/schemastery";
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

const DEFAULT_ENDPOINT = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses";
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
  endpoint: z.string().default(DEFAULT_ENDPOINT),
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
  // false = 观察-only：不注册 adapter/provider（模型从选择器消失），面板/计数/媒体工具照常。
  // 聊天走手工 provider 时改插件不再中断请求；需要服务端内置工具时保持 true 并手动选本插件模型。
  registerProvider: z.boolean().default(true),
  // 旁路观察名单：这些 provider 的模型调用也计入面板「本周期调用次数」（本插件 providerId 始终在内）。
  watchedProviders: z.array(z.string()).default(["qwentokenplan"]),
  // 目录补货：定期从普通线路（pi-ai 手工 provider）自己的域名抓 /models，
  // 把新对话模型追加进它的 models 配置（只追加、真变化才写、免重启生效）。
  catalogFeed: z.boolean().default(true),
  feedProvider: z.string().default("qwentokenplan"),
  // 补货时是否翻译推理档位（reasoningEfforts + compat.thinkingFormat）；false 只补 id/name/容量/模态。
  feedReasoning: z.boolean().default(true),
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
  const endpoint = String(config.endpoint || DEFAULT_ENDPOINT);
  const chatEndpoint = String(config.chatEndpoint || endpoint.replace(/\/responses\/?$/, "/chat/completions"));
  const harnessMode = normalizeHarnessMode(config.harness);
  const origin = new URL(endpoint).origin;
  const modelsUrl = endpoint.replace(/\/responses\/?$/, "/models");

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
    ctx, modelsUrl, apiKeyEnv, pluginName: name, overrides, excludes, logger: ctx.logger,
    fetchImpl: proxyFetch,
  });

  // 服务端权益调用预算：上限按 Token Plan 等级自动推导（网关 quota-config ÷ perCallCredits）。
  const budget = new HarnessBudget({ config, logger: ctx.logger });

  // 目录补货器：聊天固定走普通线路时，新模型由这里补进普通线路的名单（见 lib/catalog-feed.js）。
  const feed = config.catalogFeed === false ? null : new CatalogFeed({
    ctx, catalog, feedProvider: String(config.feedProvider || "qwentokenplan"),
    feedReasoning: config.feedReasoning !== false,
    pluginName: name, fetchImpl: proxyFetch, logger: ctx.logger,
  });

  const adapter = new QwenTokenPlanAdapter({
    ctx, catalog, providerId, displayName, apiKeyEnv, endpoint, chatEndpoint, harnessMode,
    pluginName: name, budget, fetchImpl: proxyFetch,
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

  if (config.mediaTools !== false && typeof ctx.tools?.register === "function") {
    const imageModels = Array.isArray(config.imageModels) && config.imageModels.length
      ? config.imageModels.map(String) : DEFAULT_IMAGE_MODELS;
    const videoModels = Array.isArray(config.videoModels) && config.videoModels.length
      ? config.videoModels.map(String) : DEFAULT_VIDEO_MODELS;
    ctx.effect(() => {
      const disposeTools = registerMediaTools(ctx, {
        apiKeyEnv, pluginName: name, origin, chatEndpoint,
        imageModels, videoModels,
        defaultImageModel: String(config.defaultImageModel || imageModels[0]),
        defaultVideoModel: String(config.defaultVideoModel || videoModels[0]),
        providerId, acceptProviders: watchedProviders, fetchImpl: proxyFetch,
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
            await Promise.allSettled([refreshTier(), refreshCatalog(), refreshEquities(), ...(feed ? [feed.run()] : [])]);
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
    catalogTick();
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
    `${name}: ${registerProvider ? `已注册 provider "${providerId}"` : "观察-only（未注册 provider）"}（Responses=${endpoint}；Chat=${chatEndpoint}；` +
    `内置工具 ${harnessMode.mode}；权益预算 ${budget.enabled ? "开启（等级自动上限）" : "关闭"}；` +
    `媒体工具 ${config.mediaTools === false ? "关闭" : "开启"}；调用观察 ${[...watched].join("/")}；` +
    `目录补货 ${feed ? `开启 → ${String(config.feedProvider || "qwentokenplan")}${config.feedReasoning === false ? "（不含档位）" : ""}` : "关闭"}；目录每 ${refreshMinutes} 分钟刷新；` +
    `套餐每 ${tierRefreshHours} 小时刷新；Cookie 失效${config.autoRelogin === false ? "不会" : "将"}自动开登录页收割）`,
  );
}

apply.inject = inject;
apply.Config = Config;
export default apply;
