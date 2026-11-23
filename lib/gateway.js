import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 千问 Token Plan 控制台数据网关客户端（与 dsh-token-plan-quota 同一上游契约，2026-11-03 实测）。
 * 只读三个接口：usage（本周期已用百分比+重置时间）、quota-config（各等级 Credits 配额表）、
 * subscription（当前等级 specCode / 剩余天数）。需要 BAILIAN_CONSOLE_COOKIE（控制台登录票据）。
 * 任何失败都应由调用方降级处理——本模块只负责取数和抛错。
 */

/** 等级配额表内置快照（2026-11-03 抓自 quota-config，单位 Credits）。网关不可达时的兜底。 */
export const BUILTIN_TIER_QUOTA = Object.freeze({
  lite: Object.freeze({ five_hour: 700, monthly: 11500 }),
  essential: Object.freeze({ five_hour: 1800, monthly: 25500 }),
  standard: Object.freeze({ five_hour: 3000, monthly: 45000 }),
  pro: Object.freeze({ five_hour: 12000, monthly: 180000 }),
});

/**
 * 每项 Harness 权益一个计费周期的官方配额（2026-11-03 定价页「Harness 权益」表）。
 * 剩余额度 = 配额 − 本地记录的返回/调用次数（额度耗尽即停用该权益工具）。
 */
export const ENTITLEMENT_QUOTAS = Object.freeze({
  search_pro: Object.freeze({ unit: "次", standard: 100, pro: 500 }),
  vertical_search: Object.freeze({ unit: "次", standard: 100, pro: 500 }),
  webfetch: Object.freeze({ unit: "次", standard: 1000, pro: 5000 }),
  code_interpreter: Object.freeze({ unit: "次", standard: 100, pro: 500 }),
  tts: Object.freeze({ unit: "字符", standard: 10000, pro: 10000 }),
  asr: Object.freeze({ unit: "秒", standard: 18000, pro: 18000 }),
  image_generation: Object.freeze({ unit: "张", standard: 20, pro: 50 }),
});

/** 服务端工具类型（含 SSE 的 *_call 形式）/ 媒体工具 → 权益键。 */
export const TOOL_TO_EQUITY = Object.freeze({
  web_search: "search_pro",
  web_search_call: "search_pro",
  web_search_image: "vertical_search",
  web_search_image_call: "vertical_search",
  image_search: "vertical_search",
  image_search_call: "vertical_search",
  web_extractor: "webfetch",
  web_extractor_call: "webfetch",
  code_interpreter: "code_interpreter",
  code_interpreter_call: "code_interpreter",
  image_generation: "image_generation",
  // 权益键本身也作为合法输入：MCP 通道（lib/mcp-equity.js 的 guard）按权益键记账，
  // 七项一视同仁。tts/asr 尤其关键——它们没有对应的服务端内置工具类型，只能走这条路；
  // 缺了映射会让 record 查不到 key 而静默丢弃，面板永远显示 0。
  search_pro: "search_pro",
  vertical_search: "vertical_search",
  webfetch: "webfetch",
  tts: "tts",
  asr: "asr",
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ORIGIN = "https://platform-home.qianwenai.com";
export const DASHBOARD_URL = `${ORIGIN}/analytics/token-plan/individual`;
const GATEWAY_URL = "https://cs-data.qianwenai.com/data/api.json";
const API_PREFIX = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2";

/** 按 DSH 惯例的解析顺序读控制台 Cookie：环境变量 → ~/.dsh/.env。 */
export function readConsoleCookie(envName = "BAILIAN_CONSOLE_COOKIE") {
  const direct = process.env[envName];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  try {
    const text = fs.readFileSync(path.join(os.homedir(), ".dsh", ".env"), "utf8");
    const match = new RegExp(`^\\s*(?:export\\s+)?${envName}\\s*=\\s*(.*)$`, "m").exec(text);
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (value !== "") return value;
    }
  } catch { /* 文件不存在或不可读：视为未配置 */ }
  return undefined;
}

function unwrapGatewayJson(text, apiName) {
  const outer = JSON.parse(text);
  const payload = outer?.data?.DataV2?.data;
  if (!payload || payload.success !== true || payload.code !== "SUCCESS") {
    const msg = payload?.msg ?? outer?.data?.errorMsg ?? text.slice(0, 160);
    throw new Error(`网关 ${apiName} 返回失败：${msg}`);
  }
  return payload.data;
}

async function fetchSecToken(cookie, fetchImpl, signal) {
  const response = await fetchImpl(`${ORIGIN}/tool/user/info.json`, {
    headers: { cookie, accept: "application/json", referer: DASHBOARD_URL, "user-agent": UA },
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`user/info.json HTTP ${response.status}`);
  const secToken = JSON.parse(text)?.data?.secToken;
  if (typeof secToken !== "string" || secToken === "") throw new Error("user/info.json 未返回 secToken（Cookie 可能已过期）");
  return secToken;
}

async function callGateway(apiName, cookie, secToken, fetchImpl, signal) {
  const apiPath = `${API_PREFIX}/${apiName}`;
  const params = {
    Api: apiPath,
    V: "1.0",
    Data: {
      cornerstoneParam: {
        feTraceId: randomUUID(),
        feURL: DASHBOARD_URL,
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchUserType: 3,
        domain: "platform-home.qianwenai.com",
        consoleSite: "QIANWENAI",
        userNickName: "",
        userPrincipalName: "",
        xsp_lang: "zh-CN",
      },
    },
  };
  const cna = /(?:^|;\s*)cna=([^;]+)/.exec(cookie);
  if (cna) params.Data.cornerstoneParam["X-Anonymous-Id"] = cna[1].trim();
  const query = new URLSearchParams({ action: "BroadScopeAspnGateway", product: "sfm_bailian", api: apiPath, _v: "undefined" });
  const body = new URLSearchParams({
    product: "sfm_bailian",
    action: "BroadScopeAspnGateway",
    region: "cn-beijing",
    language: "zh-CN",
    params: JSON.stringify(params),
    sec_token: String(secToken),
  });
  const response = await fetchImpl(`${GATEWAY_URL}?${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      cookie,
      origin: ORIGIN,
      referer: DASHBOARD_URL,
      // 固定 Chrome/131 UA：自定义 UA 会被上游反爬策略拒绝（实测教训）。
      "user-agent": UA,
    },
    body: body.toString(),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`网关 ${apiName} HTTP ${response.status}`);
  return unwrapGatewayJson(text, apiName);
}

/**
 * 拉取等级与配额全量信息。
 * @returns {Promise<{specCode: string, quota: Record<string, {five_hour: number, monthly: number}>,
 *   usage: {per1MonthPercentage: number, per1MonthResetTime: number},
 *   subscription: {remainingDays?: number, endTime?: number}, fetchedAt: number}>}
 */
export async function fetchTierInfo({ cookie, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof cookie !== "string" || cookie === "") throw new Error("缺少 BAILIAN_CONSOLE_COOKIE");
  const secToken = await fetchSecToken(cookie, fetchImpl, signal);
  const [usage, quota, subscription] = await Promise.all([
    callGateway("usage", cookie, secToken, fetchImpl, signal),
    callGateway("quota-config", cookie, secToken, fetchImpl, signal),
    callGateway("subscription", cookie, secToken, fetchImpl, signal),
  ]);
  const specCode = String(subscription?.specCode ?? "");
  if (!specCode) throw new Error("subscription 未返回 specCode");
  return {
    specCode,
    quota: quota && typeof quota === "object" ? quota : BUILTIN_TIER_QUOTA,
    usage: {
      per1MonthPercentage: Number(usage?.per1MonthPercentage) || 0,
      per1MonthResetTime: Number(usage?.per1MonthResetTime) || 0,
    },
    subscription: {
      ...(Number.isFinite(subscription?.remainingDays) ? { remainingDays: subscription.remainingDays } : {}),
      ...(Number(subscription?.endTime) ? { endTime: Number(subscription.endTime) } : {}),
    },
    fetchedAt: Date.now(),
  };
}

/** 权益明细 API（控制台「用量详情」同源）：每项 Harness 权益的周期总量与剩余量。 */
const EQUITY_API = "zeldaEasy.bailian-commerce.tokenPlan.queryTokenPlanEquityInfo";

/**
 * equityType → 面板行与单位映射。totalQuota 是「本权益周期」的折算配额
 * （与月配额按周期剩余时间等比），availableQuota 是剩余量。
 * 视频生成无独立额度实例（按 Credits 计），不在表内 → 面板回退静态配额。
 */
export const EQUITY_TYPES = Object.freeze({
  tokenplan_harnesstool_search_pro: { key: "search_pro", unit: "次" },
  tokenplan_harnesstool_vertical_search: { key: "vertical_search", unit: "次" },
  tokenplan_harnesstool_webfetch: { key: "webfetch", unit: "次" },
  tokenplan_mcp_codeinterpreter: { key: "code_interpreter", unit: "次" },
  tokenplan_harnesstool_tts: { key: "tts", unit: "字符" },
  tokenplan_harnesstool_asr: { key: "asr", unit: "秒" },
  tokenplan_harnesstool_image_generation: { key: "image_generation", unit: "张" },
});

/**
 * 拉取 8 项 Harness 权益的剩余/周期配额。返回 [{ key, unit, available, total }]；
 * 失败抛错由调用方降级（面板回退静态配额）。
 */
export async function fetchEquityInfo({ cookie, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof cookie !== "string" || cookie === "") throw new Error("缺少 BAILIAN_CONSOLE_COOKIE");
  const secToken = await fetchSecToken(cookie, fetchImpl, signal);
  const raw = await callGatewayRaw(EQUITY_API, { queryTokenPlanEquityInfoRequest: { requestId: randomUUID() } }, cookie, secToken, fetchImpl, signal);
  const items = Array.isArray(raw?.tokenPlanEquityInfos) ? raw.tokenPlanEquityInfos : [];
  const out = [];
  for (const item of items) {
    const meta = EQUITY_TYPES[String(item?.equityType ?? "")];
    const available = Number(item?.availableQuota);
    const total = Number(item?.totalQuota);
    if (!meta || !Number.isFinite(available) || !Number.isFinite(total) || total <= 0) continue;
    out.push({ key: meta.key, unit: meta.unit, available: Math.max(0, Math.round(available)), total: Math.round(total) });
  }
  return out;
}

/**
 * 「服务自带免费额度」的 Template.Name → 面板行与单位映射（2026-11-23 实测）。
 *
 * 为什么必须有这一层：官方抵扣顺序是「先扣对应服务本身的免费额度（试用/新用户额度），
 * 再扣 Token Plan 附赠权益，权益用尽后按 88 折后付费」
 * （https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits 常见问题）。
 * 只读 queryTokenPlanEquityInfo 会看到「20/20 满格」，误以为调用没走通——
 * 实际钱正从这一层出。两层必须一起显示，否则面板在说谎。
 *
 * 单位以 BaseValue 为准，不能用 ShowUnit：语音合成的 InitCapacity.ShowUnit 是「万字」
 * （ShowValue=1），CurrCapacity.ShowUnit 却是「word」（ShowValue=9967），
 * 两边 ShowValue 口径不一致，只有 BaseValue 同尺度（都是字符数）。
 */
export const SERVICE_QUOTA_TYPES = Object.freeze({
  tool_search_pro_count: { key: "search_pro", unit: "次" },
  tool_vertical_search_count: { key: "vertical_search", unit: "次" },
  tool_web_fetch_count: { key: "webfetch", unit: "次" },
  mcp_call_count_mode: { key: "code_interpreter", unit: "次" },
  mcp_input_chars_mode: { key: "tts", unit: "字符" },
  mcp_asr_mode: { key: "asr", unit: "秒" },
  mcp_image_mode: { key: "image_generation", unit: "张" },
  // 视频在 Token Plan 侧无独立权益实例（第二层没有它），但服务自带额度里有 10 秒试用。
  // 面板视频行此前只能显示「✓ 包含」，接上这一层后能显示真实试用余量。
  mcp_video_mode: { key: "video_generation", unit: "秒" },
});

/** 服务自带免费额度所属商品码（「阿里云百炼自研工具」，2026-11-23 从控制台前端 bundle 挖出）。 */
export const SERVICE_QUOTA_COMMODITY = "sfm_plugin_public_cn";

/**
 * 千问控制台的 OpenAPI 通道（区别于上面的 zelda 网关）：product + action + params 表单。
 * 服务自带额度的两个接口都走这里，且必须用 ORIGIN 自己的 /data/api.json。
 */
async function callOpenApi(product, action, params, cookie, secToken, fetchImpl, signal) {
  const query = new URLSearchParams({ action, product, _v: "undefined" });
  const body = new URLSearchParams({
    product,
    action,
    region: "cn-beijing",
    language: "zh-CN",
    params: JSON.stringify(params ?? {}),
    sec_token: String(secToken),
  });
  const response = await fetchImpl(`${ORIGIN}/data/api.json?${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      cookie,
      origin: ORIGIN,
      referer: DASHBOARD_URL,
      "user-agent": UA,
    },
    body: body.toString(),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAPI ${product}/${action} HTTP ${response.status}`);
  const outer = JSON.parse(text);
  const data = outer?.data?.Data ?? outer?.data;
  if (data == null) {
    throw new Error(`OpenAPI ${product}/${action} 返回失败：${outer?.data?.Message ?? outer?.message ?? text.slice(0, 160)}`);
  }
  return data;
}

/**
 * DescribeFqInstance 的 EndTime 形如 "Wed Dec 02 00:00:00 CST 2026"。
 *
 * 这里的 CST 是 China Standard Time（+08:00），但 V8 把 CST 认成美国中部时间（−06:00）——
 * 直接 Date.parse 会把到期时间整整错开 14 小时（实测 12/2 00:00 被解析成 12/2 14:00）。
 * 所以必须把时区缩写换成显式偏移再解析。其余缩写按原样交给 Date。
 */
function parseQuotaTime(value) {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value.replace(/\bCST\b/, "GMT+0800"));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 拉取「服务自带免费额度」（第一层）。两步：
 *   1) freetier/ListBailianFreetier 拿该商品下的模板码（只返回模板，不含用量）；
 *   2) BssOpenAPI-V3/DescribeFqInstance 按模板码取 InitCapacity/CurrCapacity。
 * 已用 = Init.BaseValue − Curr.BaseValue。
 *
 * 只保留 Status==="valid" 的实例：过期试用额度不能算进可用量，
 * 否则会把已经不能用的额度当成「还在扣这一层」，把用户引向错误结论。
 *
 * @returns {Promise<Array<{key: string, unit: string, available: number, total: number, expiresAt: number|null}>>}
 */
export async function fetchServiceQuotas({ cookie, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof cookie !== "string" || cookie === "") throw new Error("缺少 BAILIAN_CONSOLE_COOKIE");
  const secToken = await fetchSecToken(cookie, fetchImpl, signal);
  const templates = await callOpenApi("freetier", "ListBailianFreetier",
    { CommodityList: [SERVICE_QUOTA_COMMODITY] }, cookie, secToken, fetchImpl, signal);
  const codes = (Array.isArray(templates) ? templates : [])
    .map((item) => item?.TemplateCode)
    .filter((code) => typeof code === "string" && code !== "");
  if (codes.length === 0) return [];
  const raw = await callOpenApi("BssOpenAPI-V3", "DescribeFqInstance",
    { TemplateCodes: codes }, cookie, secToken, fetchImpl, signal);
  const instances = Array.isArray(raw) ? raw : (raw?.Items ?? raw?.items ?? []);
  const out = [];
  for (const item of instances) {
    const meta = SERVICE_QUOTA_TYPES[String(item?.Template?.Name ?? "")];
    if (!meta) continue;
    if (String(item?.Status ?? "").toLowerCase() !== "valid") continue;
    const total = Number(item?.InitCapacity?.BaseValue);
    const available = Number(item?.CurrCapacity?.BaseValue);
    if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) continue;
    out.push({
      key: meta.key,
      unit: meta.unit,
      available: Math.max(0, Math.round(available)),
      total: Math.round(total),
      expiresAt: parseQuotaTime(item?.EndTime),
    });
  }
  return out;
}

/** callGateway 的变体：该接口成功时无 code 字段，按 success 判定；Data 需带业务请求体。 */
async function callGatewayRaw(apiName, data, cookie, secToken, fetchImpl, signal) {
  const params = {
    Api: apiName,
    V: "1.0",
    Data: {
      cornerstoneParam: {
        feTraceId: randomUUID(),
        feURL: DASHBOARD_URL,
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchUserType: 3,
        domain: "platform-home.qianwenai.com",
        consoleSite: "QIANWENAI",
        userNickName: "",
        userPrincipalName: "",
        xsp_lang: "zh-CN",
      },
      ...data,
    },
  };
  const cna = /(?:^|;\s*)cna=([^;]+)/.exec(cookie);
  if (cna) params.Data.cornerstoneParam["X-Anonymous-Id"] = cna[1].trim();
  const query = new URLSearchParams({ action: "BroadScopeAspnGateway", product: "sfm_bailian", api: apiName, _v: "undefined" });
  const body = new URLSearchParams({
    product: "sfm_bailian",
    action: "BroadScopeAspnGateway",
    region: "cn-beijing",
    language: "zh-CN",
    params: JSON.stringify(params),
    sec_token: String(secToken),
  });
  const response = await fetchImpl(`${GATEWAY_URL}?${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      cookie,
      origin: ORIGIN,
      referer: DASHBOARD_URL,
      "user-agent": UA,
    },
    body: body.toString(),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`网关 ${apiName} HTTP ${response.status}`);
  const outer = JSON.parse(text);
  const payload = outer?.data?.DataV2?.data;
  if (!payload || payload.success !== true) {
    throw new Error(`网关 ${apiName} 返回失败：${payload?.msg ?? outer?.data?.errorMsg ?? text.slice(0, 160)}`);
  }
  return payload.data ?? null;
}
