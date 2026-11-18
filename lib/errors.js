import { isContextWindowExceededError, isQuotaExceededError } from "@deepseek-ai/dsh-llm";

/** 供应商 HTTP 失败 → DSH LlmFailure code 映射（与 dsh-llm 失败码词表一致）。 */
export function httpFailure(status, text) {
  const lower = String(text ?? "").toLowerCase();
  if (status === 401 || status === 403) return "AUTH";
  if (isQuotaExceededError(lower) || /余额不足|额度耗尽|套餐.*用尽/.test(lower)) return "QUOTA";
  if (status === 429) return "RATE_LIMIT";
  if (status === 408) return "TIMEOUT";
  // 必须用 "SERVER"：dsh-llm 的 DEFAULT_RETRYABLE_CODES 只认这个词，
  // 写成 "SERVER_ERROR" 会让网关 5xx 永远不会被 llm-retry 重试（实测 2026-11-05）。
  if (status >= 500) return "SERVER";
  if (isContextWindowExceededError(lower) || /上下文.*超|超出.*token/.test(lower)) return "CONTEXT_WINDOW_EXCEEDED";
  return "PROVIDER_ERROR";
}

/**
 * 流内错误（HTTP 头是 200，错误在 SSE 里下发）→ 失败码。
 *
 * 为什么不能一律当 400：跨境链路最常见的限流与网关 5xx 正是这个形态
 * （`type:"error"` / `response.failed` 带 `rate_limit_exceeded` / `server_error`）。
 * 旧实现在 responses-sse.js 两处写死 httpFailure(400, …)，把它们全映射成
 * PROVIDER_ERROR —— 而 DEFAULT_RETRYABLE_CODES 不含它，llm-retry 一次都不重试，
 * 表现就是「跨境用着突然断连」。2026-11-18 实测五种流内错误全部落进 PROVIDER_ERROR。
 *
 * 手法：把上游 code 文本还原成**等价 HTTP 状态**，再交给 httpFailure 走同一份词表，
 * 避免维护第二套分类规则（quota / context-window 的判定也就自动继续生效）。
 */
export function streamFailureCode(error) {
  const code = String(error?.code ?? error?.type ?? "").toLowerCase();
  const message = String(error?.message ?? "").toLowerCase();
  const text = `${code} ${message}`;
  // **结构化 code 优先于自由文本 message**。上游的 code 是枚举、可靠；message 是给人看的
  // 散文，措辞随时变。宿主的 isQuotaExceededError 只要在文本里看见 "quota exceeded" 就判额度，
  // 于是 code=rate_limit_exceeded 而 message 里带 "quota exceeded, slow down" 的限流
  // 会被误判成 QUOTA（2026-11-18 实测）→ 明明退避一下就能重试，却直接终结本轮。
  // 所以先按 code 把「明确可重试」与「明确终局」分开，剩下的才交给文本启发式。
  if (/^(insufficient_quota|quota_exceeded|quota_exhausted|billing_.*)$/.test(code)) return "QUOTA";
  if (/rate.?limit|too_many_requests|throttl/.test(code)) return "RATE_LIMIT";
  if (/^(request_timeout|timeout|timed_out|deadline_exceeded)$/.test(code)) return "TIMEOUT";
  if (/^(server_error|internal_error|internal_server_error|upstream_error|bad_gateway|service_unavailable|overloaded|model_unavailable)$/.test(code)) return "SERVER";
  // code 不认识时才看文本：额度与上下文这两类不可重试的终局错误先认，再谈状态码猜测。
  if (isQuotaExceededError(text) || /余额不足|额度耗尽|套餐.*用尽/.test(text)) return "QUOTA";
  if (isContextWindowExceededError(text) || /上下文.*超|超出.*token/.test(text)) return "CONTEXT_WINDOW_EXCEEDED";
  if (/rate.?limit|too_many_requests|throttl|请求过于频繁|限流/.test(text)) return httpFailure(429, text);
  if (/timeout|timed?.out|deadline|超时/.test(text)) return httpFailure(408, text);
  // upstream/server/internal/bad_gateway/service_unavailable/overloaded 都是上游侧故障。
  if (/server.?error|internal|upstream|bad.?gateway|service.?unavailable|overload|temporarily|系统繁忙|服务.*不可用/.test(text)) {
    return httpFailure(503, text);
  }
  // 认证与额度没有等价状态码可猜，交给 httpFailure 的文本判定（quota 走 isQuotaExceededError）。
  if (/invalid.?api.?key|unauthorized|invalid.?authentication|permission/.test(text)) return httpFailure(401, text);
  return httpFailure(400, text);
}

/** 解析 Retry-After（秒数或 HTTP 日期）为毫秒。 */
export function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** finish.reason.failure 的可序列化形状。 */
export function failure(message, code, status) {
  return { message, code, ...(status ? { status } : {}) };
}
