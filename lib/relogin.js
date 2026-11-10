/**
 * 控制台 Cookie 失效后的「登录会话」编排。
 *
 * 流程（2026-11-04 设计，与用户确认；2026-11-05 弹窗风暴治理）：
 *  1. 网关取数失败且错误签名指向 Cookie（secToken 缺失 / Cookie 过期 / 未配置）时，
 *     若 config.autoRelogin 开启 → 开一个登录会话：桥在就直接开登录页；
 *     Chrome 没跑则先拉起 Chrome（bootstrap 态，等桥就绪再开页）。
 *     自动路径的防打扰纪律（手动「一键登录」不受任何限制）：
 *      - Cookie 缺失（missing）→ 立即弹（没有可校验的东西，登录页是唯一恢复路径）；
 *      - 其余 Cookie 类签名（401/403/secToken/specCode，上游瞬断与反爬限流都会命中）
 *        需连续 2 个刷新周期确认（周期内去重：两次计数至少间隔 STREAK_GAP_MS）；
 *      - 自动会话冷却 AUTO_COOLDOWN_MS（2 小时，原 15 分钟挡不住每小时一次的定时刷新）；
 *      - 自动会话以失败结束（超时/页面被关闭/取消）→ 当日不再自动弹。
 *  2. 会话每 3 秒经 CDP Network.getCookies 从登录页收割控制台域 Cookie
 *     （调试器通道能读到 HttpOnly 的 login_qianwenai_ticket —— 这是方案成立的关键，
 *     实测 2026-11-04）。用户在页里完成登录后，下一轮轮询即拿到票据。
 *  3. 拿到票据 → 写回 ~/.dsh/.env（0600 原子替换）+ 尽力同步 ctx.credentials →
 *     调用 onSuccess 立即重取等级与权益 → 面板自动恢复真实数据。
 *  4. 超时 10 分钟 / 用户关掉登录页 → 会话结束并给出原因；面板上的「一键登录」按钮
 *     是手动入口（POST /qwen-token-plan-full/login），与自动路径共用同一会话。
 *
 * 拉不起 Chrome（没装/扩展缺失）时不重试轰炸：返回可读的失败原因，
 * 面板展示手动更新 Cookie 的指引。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { DASHBOARD_URL } from "./gateway.js";
import { bridgeAvailable, openLoginWindow, closeTab, hasTab, findConsoleTab, harvestCookie } from "./bridge-client.js";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 3_000;
/** 自动登录冷却：2 小时（原 15 分钟挡不住每小时一次的定时刷新，等于每轮必弹）。 */
const AUTO_COOLDOWN_MS = 2 * 60 * 60_000;
/** 「连续失败」两次计数之间的最小间隔：同一周期内的重复失败（面板强刷撞上定时刷）只计一次。 */
const STREAK_GAP_MS = 5 * 60_000;
/**
 * 自动登录启动失败后的短重试间隔（5 分钟）。
 *
 * 为什么不复用 AUTO_COOLDOWN_MS：冷却只在**登录会话真的开起来**之后才该消耗，
 * 否则「桥不可用」这类启动失败会把 2 小时冷却吃掉，当天再也不自愈（2026-11-10 修复）。
 * 但失败也不能立刻高频重试（面板强刷会连点），所以这里用一个短间隔挡住瞬间重放。
 */
const AUTO_START_FAILURE_GAP_MS = 5 * 60_000;

/** 本地日号（年-月-日）：自动会话失败后的「当日不再自动弹」用它对齐。 */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Cookie 类失败的分类（null = 与 Cookie 无关，绝不弹页）：
 *  - "missing"：本地压根没有 Cookie（未配置/缺少）——没有可校验的东西，登录页是唯一恢复路径，允许首触即弹；
 *  - "suspect"：Cookie 在但网关判它无效（secToken 缺失 / 401 / 403 / 未返回 specCode）。
 *    上游瞬断与反爬限流也长这样，单次不足以定罪，须连续 2 个刷新周期确认。
 */
export function cookieFailureKind(message) {
  const text = String(message ?? "");
  if (/COOKIE/i.test(text) && /未配置|缺少/.test(text)) return "missing";
  if (/cookie/i.test(text) || text.includes("secToken") || text.includes("未返回 specCode")
    || /\bHTTP 40[13]\b/.test(text)) return "suspect";
  return null;
}

/** 网关错误里指向 Cookie/登录态失效的签名（命中才可能触发自动登录，避免误弹页面）。 */
export function isCookieFailure(message) {
  return cookieFailureKind(message) !== null;
}

/** 把新 Cookie 写回 ~/.dsh/.env：保留其他行，替换/追加同名键，原子写 0600。 */
export function updateEnvFile(envName, value) {
  const file = path.join(os.homedir(), ".dsh", ".env");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* 文件不存在：新建 */ }
  const line = `${envName}=${String(value).replace(/[\r\n]+/g, " ").trim()}`;
  const re = new RegExp(`^\\s*(?:export\\s+)?${envName}\\s*=.*$`, "m");
  // 函数形式替换：cookie 值里的 $ 序列不能被 String.replace 当替换模式展开（$&/$1 等）。
  const next = re.test(text)
    ? text.replace(re, () => line)
    : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* 平台不支持时忽略 */ }
  fs.renameSync(tmp, file);
}

/** macOS：直接拉起 Chrome 并打开目标页（原生消息宿主由 Chrome 随后派生，桥自然就绪）。 */
function launchBrowser(url) {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve(false);
    execFile("/usr/bin/open", ["-a", "Google Chrome", url], { timeout: 10_000 }, (error) => resolve(!error));
  });
}

/** 桥依赖的默认绑定（测试可整体注入 fake，绝不在单测里碰真 Chrome/真桥）。 */
const DEFAULT_BRIDGE = {
  available: bridgeAvailable,
  open: openLoginWindow,
  close: closeTab,
  hasTab,
  findConsoleTab,
  harvestCookie,
  launch: launchBrowser,
};

export class ReloginFlow {
  #ctx; #cookieEnv; #logger; #autoEnabled; #onSuccess;
  #bridge; #now;
  #session = null;
  #lastResult = null;
  #lastAutoAt = 0;
  /** 最后一次「自动登录启动失败」时刻：只挡短间隔重试，不消耗 2h 冷却。 */
  #lastAutoStartFailAt = 0;
  /** suspect 连续失败计数：{ count, lastAt }。missing 与取数成功都会清零。 */
  #streak = { count: 0, lastAt: 0 };
  /** 自动会话当日失败日号：命中即当日不再自动弹（手动入口不受限）。 */
  #autoBlockedDay = null;
  /** 当前会话是否自动发起（决定失败时是否触发当日熔断）。 */
  #sessionAuto = false;

  constructor({ ctx, cookieEnv, logger, autoEnabled = true, onSuccess = null, bridge = null, now = null } = {}) {
    this.#ctx = ctx;
    this.#cookieEnv = cookieEnv;
    this.#logger = logger;
    this.#autoEnabled = autoEnabled !== false;
    this.#onSuccess = onSuccess;
    this.#bridge = bridge ?? DEFAULT_BRIDGE;
    this.#now = now ?? (() => Date.now());
  }

  /** refreshTier 成功钩子：清零连续失败计数（偶发瞬断不跨周期累积成"连续"）。 */
  noteSuccess() {
    if (this.#streak.count !== 0) this.#streak = { count: 0, lastAt: 0 };
  }

  /** 会话进行中标记：refreshTier 失败回调据此抑制重复自动触发。 */
  active() { return this.#session !== null; }

  /** status 载荷用：进行中 → waiting；否则回放最近一次结果。 */
  state() {
    if (this.#session) return { state: "waiting", startedAt: this.#session.startedAt, bootstrap: this.#session.bootstrap === true };
    return { state: this.#lastResult?.state ?? "idle", message: this.#lastResult?.message ?? null, at: this.#lastResult?.at ?? null };
  }

  /** 开登录会话；已有会话则幂等复用。返回 {ok, error?, tabId?, bootstrap?}。 */
  async start({ auto = false } = {}) {
    this.#sessionAuto = auto === true;
    if (this.#session) return { ok: true, already: true, tabId: this.#session.tabId, bootstrap: this.#session.bootstrap === true };
    if (!this.#bridge.available()) {
      // 根因常是 Chrome 没在跑：先把它拉起来（原生消息宿主由 Chrome 启动时派生），
      // 进入 bootstrap 会话等桥就绪后再开登录页；拉不起 Chrome 才回落手动指引。
      const launched = await this.#bridge.launch(DASHBOARD_URL);
      if (!launched) {
        return { ok: false, error: "浏览器桥不在运行且无法打开 Chrome（或扩展未装）。请打开 Chrome 重试；或在 Chrome 登录控制台后把 Cookie 更新到 ~/.dsh/.env 的 " + this.#cookieEnv };
      }
      this.#session = { tabId: null, startedAt: this.#now(), timer: null, busy: false, bootstrap: true };
      this.#logger?.info?.(`qwen-token-plan-full: ${auto ? "自动" : "手动"}登录：Chrome 未运行，已拉起 Chrome，等桥就绪…`);
      this.#arm(POLL_MS);
      return { ok: true, tabId: null, bootstrap: true };
    }
    try {
      const tabId = await this.#bridge.open(DASHBOARD_URL);
      if (tabId === null) return { ok: false, error: "登录页没能打开（桥拒绝或超时）" };
      this.#session = { tabId, startedAt: this.#now(), timer: null, busy: false };
      this.#logger?.info?.(`qwen-token-plan-full: ${auto ? "自动" : "手动"}登录会话开始（tab ${tabId}），等待控制台登录…`);
      this.#arm(POLL_MS);
      return { ok: true, tabId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 面板取消按钮 / 热卸载。 */
  cancel(message = "已取消登录") {
    const s = this.#session;
    if (!s) return;
    this.#finish("failed", message);
    if (s.tabId !== null) this.#bridge.close(s.tabId);
  }

  /**
   * refreshTier 失败钩子（自动路径的唯一入口），防打扰纪律见文件头注释：
   * missing 首触即弹；suspect 连续 2 个刷新周期确认；冷却 2h；自动会话失败后当日不再弹。
   */
  async maybeAuto(reasonText) {
    if (!this.#autoEnabled || this.#session) return;
    const kind = cookieFailureKind(reasonText);
    if (kind === null) return;
    const now = this.#now();
    if (kind === "suspect") {
      // 周期内去重：同一刷新周期内撞出的重复失败（面板强刷、60s 重试）只计一次。
      // 不刷新 lastAt——否则高频手动刷新会把间隔永远顶回去，「连续两个周期」凑不齐。
      if (now - this.#streak.lastAt < STREAK_GAP_MS) return;
      this.#streak = { count: this.#streak.count + 1, lastAt: now };
      if (this.#streak.count < 2) {
        this.#logger?.info?.("qwen-token-plan-full: Cookie 类取数失败（疑似），下个刷新周期再确认一次才开登录页");
        return;
      }
    } else {
      this.#streak = { count: 0, lastAt: 0 };
    }
    if (this.#autoBlockedDay === localDay(now)) return;
    if (now - this.#lastAutoAt < AUTO_COOLDOWN_MS) return;
    // 启动失败后的短间隔：避免失败瞬间被面板强刷/定时刷连点（不消耗 2h 冷却）。
    if (now - this.#lastAutoStartFailAt < AUTO_START_FAILURE_GAP_MS) return;
    const r = await this.start({ auto: true });
    if (r.ok) {
      // 只有会话真的开起来（或幂等复用了进行中的会话）才消耗 2h 冷却：
      // 启动失败（桥不可用、登录页打不开）不消耗，下一轮刷新还能自愈。
      this.#lastAutoAt = now;
    } else {
      this.#lastAutoStartFailAt = now;
      this.#logger?.warn?.(`qwen-token-plan-full: 自动登录未启动：${r.error}（不消耗 2 小时冷却，${Math.round(AUTO_START_FAILURE_GAP_MS / 60_000)} 分钟后再试）`);
    }
  }

  dispose() {
    const s = this.#session;
    if (s) { this.#clearTimer(s); this.#session = null; this.#lastResult = { state: "failed", message: "插件卸载，登录会话终止", at: this.#now() }; }
  }

  #arm(ms) {
    const s = this.#session;
    if (!s) return;
    const fn = () => { this.#tick().catch(() => {}); };
    s.timer = typeof this.#ctx?.timeout === "function" ? this.#ctx.timeout(fn, ms) : setTimeout(fn, ms);
  }

  #clearTimer(s) {
    try { if (typeof s.timer === "function") s.timer(); else if (s.timer) clearTimeout(s.timer); } catch { /* best effort */ }
    s.timer = null;
  }

  async #tick() {
    const s = this.#session;
    if (!s || s.busy) return;
    s.busy = true;
    try {
      if (this.#now() - s.startedAt > LOGIN_TIMEOUT_MS) {
        this.#finish("failed", "登录超时（10 分钟），Cookie 未更新");
        if (s.tabId !== null) this.#bridge.close(s.tabId);
        return;
      }
      // bootstrap：Chrome 刚被拉起，桥宿主还没就绪；就绪后立刻开登录页转正常会话。
      if (s.bootstrap) {
        if (!this.#bridge.available()) { this.#arm(POLL_MS); return; }
        let tabId = null;
        try { tabId = await this.#bridge.open(DASHBOARD_URL); } catch { /* 桥刚就绪瞬断，下轮再试 */ }
        if (tabId === null) { this.#arm(POLL_MS); return; }
        s.tabId = tabId;
        s.bootstrap = false;
        this.#logger?.info?.(`qwen-token-plan-full: 桥已就绪，登录页打开（tab ${tabId}），等待控制台登录…`);
        this.#arm(POLL_MS);
        return;
      }
      // 桥瞬断时 hasTab 抛错 → 保守认为页面还在；真被关掉会在下一轮被稳定地判掉。
      let open = true;
      try { open = await this.#bridge.hasTab(s.tabId); } catch { open = true; }
      if (!open) {
        this.#finish("failed", "登录页被关闭，Cookie 未更新");
        return;
      }
      let cookie = null;
      try { cookie = await this.#bridge.harvestCookie(s.tabId); } catch { /* debugger 忙/瞬断，下轮再试 */ }
      if (!cookie) {
        // 用户可能在自己已登录的控制台标签页里完成了会话：扫一遍同名 URL 的页面兜底收割。
        try {
          const other = await this.#bridge.findConsoleTab();
          if (other !== null && other !== s.tabId) cookie = await this.#bridge.harvestCookie(other);
        } catch { /* 忽略 */ }
      }
      if (cookie) {
        const persisted = await this.#persist(cookie);
        this.#finish(persisted.ok ? "success" : "failed", persisted.ok ? "登录完成，Cookie 已更新并生效" : persisted.error);
        this.#bridge.close(s.tabId);
        return;
      }
      this.#arm(POLL_MS);
    } finally {
      if (this.#session === s) s.busy = false;
    }
  }

  async #persist(cookie) {
    try {
      updateEnvFile(this.#cookieEnv, cookie);
    } catch (error) {
      return { ok: false, error: `写入 ~/.dsh/.env 失败：${error instanceof Error ? error.message : String(error)}` };
    }
    // 凭据服务存一份（DSH 配置面可见）；失败不致命——.env 已是 resolveCookie 的正式回退路径。
    try { await this.#ctx?.credentials?.set?.(this.#cookieEnv, cookie); }
    catch (error) { this.#logger?.warn?.(`qwen-token-plan-full: 凭据服务写入 ${this.#cookieEnv} 失败（用 .env 回退）：${error instanceof Error ? error.message : String(error)}`); }
    try { await this.#onSuccess?.(); }
    catch { /* 刷新失败不影响 Cookie 已落盘这一事实 */ }
    return { ok: true };
  }

  #finish(state, message) {
    const s = this.#session;
    if (s) this.#clearTimer(s);
    this.#session = null;
    const now = this.#now();
    this.#lastResult = { state, message, at: now };
    if (state === "success") {
      // 登录成功 = Cookie 已换新：连续失败计数清零，当日熔断解除。
      this.#streak = { count: 0, lastAt: 0 };
      this.#autoBlockedDay = null;
    } else if (this.#sessionAuto) {
      // 自动会话以失败收场（超时/页面被关闭）：当日不再自动弹，次日恢复。
      this.#autoBlockedDay = localDay(now);
    }
    this.#sessionAuto = false;
    const line = `qwen-token-plan-full: 登录会话${state === "success" ? "成功" : "结束"}：${message}`;
    if (state === "success") this.#logger?.info?.(line); else this.#logger?.warn?.(line);
  }
}
