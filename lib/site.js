import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { tryResolveApiKey } from "./apikey.js";

/**
 * Token Plan 站点自动判定（2026-11-17）。
 *
 * 为什么必须探测而不是看 key 猜：实测同一把国内站 key（`sk-sp-` 前缀、115 字符）
 * 打北京 /models 返回 200，打新加坡返回 401 `InvalidApiKey`；国际站 key 反之。
 * **key 字符串本身不带任何站点标记**，长度与前缀两站点一致，所以无法离线判定。
 * 控制台网关也不行：lib/gateway.js 的请求体写死 region=cn-beijing +
 * consoleSite=QIANWENAI，只能查国内站。
 *
 * 为什么只有这两个候选：Token Plan（个人版）目前只在中国站（北京）与国际站
 * （新加坡）售卖，且 **API Key 与地域绑定，跨地域一律 401**（官方 base-url 文档：
 * API Keys are region-specific）。实测其他地域也不通：cn-shanghai 401、
 * cn-hangzhou 404 `Model not exist.`、us-east-1 401。所以候选集就是这两个，
 * 不存在「就近选一个更快的地域」这种选项 —— 换地域等于换账号。
 *
 * 判定失败绝不致命：拿不到 key、两站点都不通、网络全断时一律保留国内站默认值，
 * 插件照常注册（目录用内置快照兜底），绝不因为探测失败而失活。
 */

/** 两个站点的 Responses 端点；其余 URL（chat/models/origin）都由它派生。 */
export const SITE_ENDPOINTS = Object.freeze({
  cn: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses",
  intl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses",
});

/** 站点探测顺序：两站点都通时以国内站为准（文档默认，且绝大多数用户在国内站）。 */
const SITE_ORDER = Object.freeze(["cn", "intl"]);

/** 探测超时：只是启动期一次 GET /models，不该让插件启动等太久。 */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * 国际站先探通时，留给国内站的宽限。
 *
 * 为什么需要宽限而不是直接用先到的那个：两站点都通时必须以国内站为准（文档默认，
 * 且绝大多数用户在国内站），而国际站偶发比国内站快几百毫秒。给 1.5s 足够覆盖
 * 国内站的正常抖动，又远小于 PROBE_TIMEOUT_MS —— 国内站真被黑洞时不会白等满 15s。
 */
const CN_PREFERENCE_MS = 1_500;

/** 由 Responses 端点派生一整套 URL；三处消费方（adapter/catalog/media）共用同一份。 */
export function deriveRoute(endpoint) {
  return {
    endpoint,
    chatEndpoint: endpoint.replace(/\/responses\/?$/, "/chat/completions"),
    modelsUrl: endpoint.replace(/\/responses\/?$/, "/models"),
    origin: new URL(endpoint).origin,
  };
}

/** "auto"（或留空）表示自动判定；其余一律当成用户显式指定的端点。 */
export function isAutoEndpoint(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || text.toLowerCase() === "auto";
}

/**
 * 并发探测两个站点的 /models，返回第一个 200 的站点。
 *
 * @returns {Promise<{site: string, endpoint: string, reason: string, probed: boolean}>}
 *   永远 resolve；判定不出来时 site="cn" 且 reason 说明原因（供日志/面板展示）。
 *   `probed` 区分「真的探到了 200」与「回落默认值」——调用方据此决定要不要重试判定，
 *   把回落当成已判定会让国际站 key 永久钉在国内站（2026-11-18 实测每轮 401）。
 */
export async function detectSite({ ctx, apiKeyEnv, pluginName, fetchImpl = globalThis.fetch, signal, logger }) {
  const fallback = (reason) => ({ site: "cn", endpoint: SITE_ENDPOINTS.cn, reason, probed: false });
  const key = await tryResolveApiKey(ctx, apiKeyEnv, pluginName);
  if (!key) return fallback(`未配置 ${apiKeyEnv}，按国内站默认端点`);

  const probe = async (site) => {
    const modelsUrl = deriveRoute(SITE_ENDPOINTS[site]).modelsUrl;
    const probeSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const response = await fetchImpl(modelsUrl, {
      headers: { ...attributionHeaders(), Authorization: `Bearer ${key}` },
      signal: probeSignal,
    });
    // 响应体不用读，但必须释放：留着不读会把这条连接钉在连接池里。
    await response.body?.cancel().catch(() => {});
    return { site, status: response.status };
  };

  // cn 优先，但不让慢的 cn 拖住已经探通的 intl。
  //
  // 两版错法都实测过（2026-11-18）：
  // - `await Promise.allSettled(两探)`：cn 黑洞丢包时要白等满 15s，intl 1s 就 200 也没用；
  // - 改成 `await cn` 再看 intl：一样白等 15s —— 慢的那个仍然挡在前面（实测 15003ms）。
  // 所以必须**按完成顺序取**：谁先出结果就先看谁，200 立即采用。
  // cn 优先靠的是「两边都通时谁先到」这个自然竞争 + CN_PREFERENCE_MS 宽限：
  // intl 先 200 时再给 cn 一点时间，避免把「cn 只是慢了几百毫秒」误判成国际站。
  const notes = [];
  const adopt = (site) => ({ site, endpoint: SITE_ENDPOINTS[site], reason: `${site} 站点 /models 返回 200`, probed: true });
  const tagged = SITE_ORDER.map((site) => probe(site).then(
    (value) => ({ site, ok: value.status === 200, note: `${site} HTTP ${value.status}`, done: true }),
    (reason) => ({ site, ok: false, note: `${site} ${reason instanceof Error ? reason.message : String(reason)}`, done: true }),
  ));
  // 每个探测一落定就把结果填进 results；宽限计时器只负责「到点了还没结果」这一种情况，
  // 用可清理的 setTimeout 而不是裸 Promise，否则宽限没用上时会留一个 2s 的空转计时器。
  const results = new Map();
  const settled = tagged.map((task, index) => task.then((value) => { results.set(SITE_ORDER[index], value); return value; }));
  const cnSite = SITE_ORDER[0];
  let graceTimer = null;

  try {
    // 按完成顺序取：谁先出结果先看谁，慢的那个不挡路。
    const first = await Promise.race(settled);
    if (first.ok && first.site === cnSite) return adopt(first.site);
    if (first.ok) {
      // intl 先通：此刻再起短宽限（不是从 t=0 起算，避免 intl 耗时 >1.5s 时宽限归零）。
      let cn = results.get(cnSite);
      if (!cn) {
        const cnGrace = new Promise((resolve) => {
          graceTimer = setTimeout(() => resolve(null), CN_PREFERENCE_MS);
          graceTimer.unref?.();
        });
        cn = await Promise.race([settled[SITE_ORDER.indexOf(cnSite)], cnGrace]);
      }
      return adopt(cn?.ok ? cnSite : first.site);
    }
    // 首个完成者失败：等另一个（它可能早就 200 了，也可能还在跑）。
    const otherIndex = SITE_ORDER.findIndex((site) => site !== first.site);
    const second = results.get(SITE_ORDER[otherIndex]) ?? await settled[otherIndex];
    if (second.ok) return adopt(second.site);
    notes.push(first.note, second.note);
    logger?.warn?.(`${pluginName}: 站点自动判定失败（${notes.join("；")}），保留国内站端点`);
    return fallback(`两站点均未通过：${notes.join("；")}`);
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
  }
}
