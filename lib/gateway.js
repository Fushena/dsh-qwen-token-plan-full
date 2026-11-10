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
