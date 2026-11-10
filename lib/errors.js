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
