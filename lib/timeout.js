import { LlmError } from "@deepseek-ai/dsh-llm";

/**
 * 请求超时与错误码归类（qwen-token-plan-full）。
 *
 * 背景（2026-11-09 实测教训）：插件原先的 fetch 只透传 `options.signal`，没有任何超时
 * 保护，于是网络抖动时只能等 undici 的默认 headersTimeout/bodyTimeout —— 两者默认都是
 * 300 秒（`undici/lib/dispatcher/client.js` 的 `300e3`）。用户看到的就是「突然卡了 5
 * 分钟然后报 fetch failed」。
 *
 * 更要紧的是错误码：原先抛 `NETWORK`，而 DSH 的 `DEFAULT_RETRYABLE_CODES` 只有
 * EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT —— **没有 NETWORK**。
 * 于是网络类失败一次就终结本轮，llm-retry 根本不会介入。
 *
 * 因此这里：
 * 1) 给请求套一个显式超时，不再依赖 undici 的 300 秒兜底；
 * 2) 把网络类失败归到 `TRANSPORT`（可重试），超时归到 `TIMEOUT`（也可重试），
 *    这样抖动会触发自动重试，而不是干等之后彻底失败；
 * 3) 用户主动取消仍报 `ABORTED`，绝不被重试。
 *
 * 注意：本插件的超时只覆盖到「拿到响应头」为止（见 adapter.js 里 deadline.dispose()
 * 的位置）；SSE 正文的读取沿用 options.signal，取消语义不受影响。因此当前调用点不
 * 需要 touch()；但 requestDeadline 仍按「空闲超时」实现并在每个 chunk 处提供 touch()，
 * 一旦将来把超时延后到整个流，必须照 ark-agent-plan 的做法在循环里 touch()，
 * 否则正常的长流式回答会被总时长掐断（2026-11-10 实测教训）。
 */

/** 默认单次请求超时：够等慢响应，又不至于让你盯着屏幕干等。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * 组合「外部取消信号」与「本次请求超时」。
 *
 * 返回的 abort 函数是幂等的：无论超时先到还是用户先取消，都能安全调用。
 *
 * @param external - 上游传入的取消信号（用户取消 / 回合中止）。
 * @param timeoutMs - 单次请求超时毫秒数；非正数表示不设超时。
 * @returns {{signal: AbortSignal, timedOut: () => boolean, dispose: () => void}}
 */
export function requestDeadline(external, timeoutMs) {
  const controller = new AbortController();
  const signals = [controller.signal];
  if (external) signals.push(external);
  const signal = AbortSignal.any ? AbortSignal.any(signals) : controller.signal;
  let timer;
  let timerFired = false;
  const ms = Number(timeoutMs);

  /**
   * 重装定时器。**这是「空闲超时」而不是「总时长超时」**：
   * 超时表达的是「多久没动静才算卡死」，不是「一次请求最多花多久」。
   * 必须由调用方在收到进展时 touch() 重置；否则正常的长流式回答
   * （>60 秒输出）会被当成超时掐断。
   */
  const arm = () => {
    if (!Number.isFinite(ms) || ms <= 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timerFired = true; controller.abort(new Error("request timeout")); }, ms);
    if (typeof timer?.unref === "function") timer.unref();
  };
  arm();
  return {
    signal,
    timedOut: () => timerFired,
    /** 有进展（收到数据/chunk）时重置空闲计时。 */
    touch: () => { if (!timerFired) arm(); },
    dispose: () => { if (timer) { clearTimeout(timer); timer = undefined; } },
  };
}

/**
 * 把 fetch 抛出的异常归类成 DSH 的失败码。
 *
 * @param error - fetch 抛出的原始错误。
 * @param context.externalAborted - 是否因用户/回合取消而中止。
 * @param context.timedOut - 是否因本次请求超时而中止。
 * @returns {{code: string, message: string}} message 为原始错误摘要，供日志排查。
 */
export function classifyFetchError(error, { externalAborted = false, timedOut = false } = {}) {
  if (externalAborted) return { code: "ABORTED", message: "请求已取消", cause: error };
  const raw = error instanceof Error ? error.message : String(error);
  const cause = error?.cause;
  const detail = cause
    ? `${raw}（${cause.code ?? cause.message ?? String(cause)}）`
    : raw;
  if (timedOut) {
    return { code: "TIMEOUT", message: `请求超时：${detail}`, cause: error };
  }
  // undici 的连接类失败都以 TypeError('fetch failed') + cause 呈现；
  // 归到 TRANSPORT 才能进入 DSH 的自动重试链路。
  return { code: "TRANSPORT", message: `网络连接失败：${detail}`, cause: error };
}
