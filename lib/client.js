/**
 * dsh-qwen-token-plan-full 浏览器半边：输入行「权益」徽标 + 明细面板。
 *
 * - 「⚡ 权益」徽标只显示文字（有权益额度耗尽时变 ⚠ 橙色），点开权益面板：按当前等级
 *   列出 8 项套餐权益（联网搜索增强、垂类搜索、网页解析、代码解释器、语音合成、
 *   语音识别、图像生成、视频生成），行值 = 剩余/周期总额（配额 − 本周期调用次数）。
 * - 「◔ 套餐剩余」徽标点开套餐面板：剩余百分比大数字 + 等级、月配额、剩余 Credits、
 *   剩余天数、周期重置。两个徽标各自打开对应面板，不再共用。
 * - 弹层交互仿模型切换器：无按钮；点徽标打开并强制回源刷新，点弹层外（透明遮罩）关闭。
 * - 数据来自宿主路由 GET /qwen-token-plan-full/status（同源、只读），30s 轮询。
 * - 面板经 react-dom 的 createPortal 挂到 document.body 用 fixed 定位
 *   （宿主工具栏的 transform/backdrop-filter 会劫持 inline fixed 的包含块）。
 * - 样式经 <style data-plugin-css> effect 注入，重复挂载去重。
 * - locale 每次渲染时重取 <html lang>：宿主 locale 插件是异步写入的，apply 时可能还是空的。
 */
window.__ModuleLoader__.load({
  id: "dsh-qwen-token-plan-full",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    /** createPortal 在 react-dom 上（react 本体没有）；拿不到时面板退回内联渲染。 */
    let createPortal = null;
    try {
      const ReactDOM = require("react-dom");
      if (typeof ReactDOM?.createPortal === "function") createPortal = ReactDOM.createPortal;
    } catch { /* 无 react-dom 种子词：内联回退 */ }

    const STATUS = "/qwen-token-plan-full/status";
    const REFRESH = "/qwen-token-plan-full/refresh";
    const LOGIN = "/qwen-token-plan-full/login";
    const LOGIN_CANCEL = "/qwen-token-plan-full/login/cancel";
    const STYLE_ID = "dsh-qwen-token-plan-full.css";
    const POLL_MS = 30_000;

    const COPY = {
      zh: {
        badge: "权益", paused: "已达上限", error: "权益 ?",
        planPanelTitle: "套餐剩余", budgetPanelTitle: "Token Plan 权益",
        tier: "套餐等级", tierSource: { gateway: "控制台实时", config: "配置指定", builtin: "内置兜底" },
        monthly: "月配额", fiveHour: "5 小时配额", credits: "Credits",
        capPeriod: "周期次数上限", cap5h: "5 小时上限", perCall: "单次成本估算",
        usedPeriod: "本周期已用", used5h: "近 5 小时", usedTotal: "累计",
        planRemaining: "套餐剩余", planUnknown: "套餐 ?", resetAt: "周期重置", remainingDays: "剩余天数",
        planCreditsLeft: "剩余 Credits", planUsed: "本周期已用", planQuota: "套餐配额",
        entitlements: "套餐权益", entitlementsNote: "Lite / Essential 套餐不含下列权益，升级 Standard 及以上解锁。",
        pausedPeriod: "已达周期上限，内置工具暂停声明", paused5h: "已达 5 小时上限，内置工具暂停声明",
        pausedEquity: "部分权益额度耗尽，对应工具已停用",
        exhaustedSuffix: "（已耗尽）",
        resumeAt: "预计恢复", models: "对话模型", catalogSource: { live: "线上目录", builtin: "内置快照" },
        refresh: "刷新", close: "关闭", updatedAt: "更新于", noTier: "等级信息未获取（点徽标重试）",
        budgetOff: "权益预算已关闭（config.harnessBudget=false），内置工具不限次。",
        cookieExpired: "控制台 Cookie 已失效，套餐数据暂停更新。",
        loginCta: "一键登录", logging: "等待登录完成…", loginCancel: "取消", loginFail: "自动登录未成功",
        loginBootstrap: "正在启动 Chrome，就绪后自动打开登录页…",
        loginIdle: "在 Chrome 打开控制台登录页；登录完成即自动更新 Cookie。",
        loginManualHint: "未开启 Chrome 桥：请在 Chrome 登录控制台后，把 Cookie 更新到 ~/.dsh/.env 的 BAILIAN_CONSOLE_COOKIE。",
      },
      en: {
        badge: "Tools", paused: "capped", error: "Tools ?",
        planPanelTitle: "Plan remaining", budgetPanelTitle: "Token Plan benefits",
        tier: "Plan tier", tierSource: { gateway: "console live", config: "configured", builtin: "builtin fallback" },
        monthly: "Monthly", fiveHour: "5-hour", credits: "credits",
        capPeriod: "Cap / period", cap5h: "Cap / 5h", perCall: "Est. credits per call",
        usedPeriod: "Used this period", used5h: "Used in 5h", usedTotal: "Total",
        planRemaining: "Plan remaining", planUnknown: "Plan ?", resetAt: "Period resets", remainingDays: "Days left",
        planCreditsLeft: "Credits left", planUsed: "Used this period", planQuota: "Plan quota",
        entitlements: "Plan benefits", entitlementsNote: "Lite / Essential plans include none of these; upgrade to Standard or Pro.",
        pausedPeriod: "Period cap reached; built-in tools paused", paused5h: "5-hour cap reached; built-in tools paused",
        pausedEquity: "Some benefit quotas exhausted; matching tools disabled",
        exhaustedSuffix: " (exhausted)",
        resumeAt: "Resumes", models: "Chat models", catalogSource: { live: "live", builtin: "bundled" },
        refresh: "Refresh", close: "Close", updatedAt: "Updated", noTier: "Tier info unavailable (click the badge to retry)",
        budgetOff: "Budget disabled (config.harnessBudget=false); built-in tools unlimited.",
        cookieExpired: "Console cookie expired; plan data is stale.",
        loginCta: "Sign in", logging: "Waiting for sign-in…", loginCancel: "Cancel", loginFail: "Auto sign-in failed",
        loginBootstrap: "Starting Chrome; the login page opens once the bridge is ready…",
        loginIdle: "Opens the console login page in Chrome; the cookie updates itself once you sign in.",
        loginManualHint: "Chrome bridge unavailable: sign in to the console in Chrome, then update BAILIAN_CONSOLE_COOKIE in ~/.dsh/.env.",
      },
    };

    /**
     * Token Plan 服务端权益清单（2026-11-03 抓自 platform.qianwenai.com/pricing/token-plan
     * 「Harness 权益」对照表；lite/essential 均不含，故只列 standard/pro 配额）。
     * equity = 宿主 equityCounts 的键：剩余额度 = 官方周期配额 − 本周期返回/调用次数
     * （宿主按 *_call 事件与媒体工具结果计数），耗尽即停用。行值显示「剩余/周期总额」。
     * 计数不可用（网关兜底且无本地计数）时回退静态配额文案。
     */
    const ENTITLEMENTS = Object.freeze([
      { zh: "联网搜索增强", en: "Web search (enhanced)", equity: "search_pro", q: { zh: { standard: "100 次/月", pro: "500 次/月" }, en: { standard: "100 calls/mo", pro: "500 calls/mo" } } },
      { zh: "垂类搜索", en: "Vertical search", equity: "vertical_search", q: { zh: { standard: "100 次/月", pro: "500 次/月" }, en: { standard: "100 calls/mo", pro: "500 calls/mo" } } },
      { zh: "网页解析", en: "Web page parsing", equity: "webfetch", q: { zh: { standard: "1000 次/月", pro: "5000 次/月" }, en: { standard: "1000 calls/mo", pro: "5000 calls/mo" } } },
      { zh: "代码解释器", en: "Code interpreter", equity: "code_interpreter", q: { zh: { standard: "100 次/月", pro: "500 次/月" }, en: { standard: "100 calls/mo", pro: "500 calls/mo" } } },
      { zh: "语音合成", en: "Speech synthesis", equity: "tts", q: { zh: { standard: "1 万字符/月", pro: "1 万字符/月" }, en: { standard: "10k chars/mo", pro: "10k chars/mo" } } },
      { zh: "语音识别", en: "Speech recognition", equity: "asr", q: { zh: { standard: "5 小时/月", pro: "5 小时/月" }, en: { standard: "5 hours/mo", pro: "5 hours/mo" } } },
      { zh: "图像生成", en: "Image generation", equity: "image_generation", q: { zh: { standard: "20 张/月", pro: "50 张/月" }, en: { standard: "20 images/mo", pro: "50 images/mo" } } },
      { zh: "视频生成", en: "Video generation", equity: null, q: { zh: { standard: "✓ 包含", pro: "✓ 包含" }, en: { standard: "✓ included", pro: "✓ included" } } },
    ]);

    /** 行值「剩余/周期总额」：宿主 equityCounts（配额−调用次数）为准；语音识别按小时显示。 */
    function equityValue(count, en) {
      if (!count || !Number.isFinite(count.quota) || count.quota <= 0) return null;
      const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000) / 10}万` : String(n));
      if (count.unit === "秒") {
        const h = (n) => `${Math.round(n / 360) / 10}h`;
        return `${h(count.remaining)}/${h(count.quota)}`;
      }
      const unit = en ? (count.unit === "次" ? "" : ` ${count.unit === "张" ? "img" : count.unit === "字符" ? "chr" : count.unit}`) : count.unit;
      return `${fmt(count.remaining)}/${fmt(count.quota)}${unit}`;
    }

    function pickLocale() {
      const lang = (typeof document !== "undefined" && document.documentElement?.lang) || (typeof navigator !== "undefined" && navigator.language) || "";
      return String(lang).toLowerCase().startsWith("zh") ? COPY.zh : COPY.en;
    }

    async function request(path, method) {
      const response = await fetch(path, {
        method: method ?? "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload === null) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
      }
      return payload;
    }

    function fmtTime(ms, locale) {
      if (!ms) return "—";
      try { return new Date(ms).toLocaleString(locale === COPY.en ? "en-US" : "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
      catch { return String(ms); }
    }

    const cssText = () => `
.qtpf-badge{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:11px;
  border:1px solid rgba(120,120,140,.35);background:rgba(120,120,140,.08);cursor:pointer;user-select:none;
  font:500 11px/1 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  font-variant-numeric:lining-nums tabular-nums;color:inherit;white-space:nowrap}
.qtpf-badge:hover{background:rgba(120,120,140,.18)}
.qtpf-badge.paused{border-color:rgba(234,140,32,.7);background:rgba(234,140,32,.14);color:#b45309}
.qtpf-badge.plan{border-color:rgba(46,160,110,.5);background:rgba(46,160,110,.1)}
.qtpf-badge.plan:hover{background:rgba(46,160,110,.2)}
.qtpf-badge+.qtpf-badge{margin-left:6px}
.qtpf-backdrop{position:fixed;inset:0;z-index:2147483000;background:transparent}
.qtpf-panel{position:fixed;z-index:2147483001;right:24px;bottom:64px;width:320px;max-height:70vh;overflow:auto;
  border-radius:12px;border:1px solid rgba(120,120,140,.25);background:#fff;color:#1c1c28;
  box-shadow:0 8px 28px rgba(0,0,0,.14);padding:12px 14px;
  font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  font-variant-numeric:lining-nums tabular-nums}
@media (prefers-color-scheme:dark){.qtpf-panel{background:#26262f;color:#e8e8f0;border-color:rgba(160,160,180,.22);
  box-shadow:0 8px 28px rgba(0,0,0,.45)}
  .qtpf-row .k{color:#9a9ab0}.qtpf-title{color:#f0f0f8}}
.qtpf-title{display:flex;align-items:center;justify-content:space-between;font-weight:650;font-size:14px;margin-bottom:10px}
.qtpf-row{display:flex;justify-content:space-between;gap:12px;padding:3px 0}
.qtpf-row .k{color:#6a6a7a;flex:none}
.qtpf-row .v{font-weight:550;text-align:right}
.qtpf-row.exhausted{opacity:.55}
.qtpf-row.exhausted .v{color:#b45309;font-weight:600}
.qtpf-sec{margin:10px 0 4px;font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;opacity:.55}
.qtpf-warn{margin:8px 0;padding:8px 10px;border-radius:8px;background:rgba(234,140,32,.12);color:#b45309;font-size:12px}
.qtpf-login{display:flex;align-items:center;gap:8px;margin-top:10px}
.qtpf-login .msg{flex:1;font-size:12px;line-height:1.5;opacity:.85}
.qtpf-btn{height:26px;padding:0 12px;border-radius:8px;border:1px solid rgba(46,160,110,.55);
  background:rgba(46,160,110,.14);color:#1c1c28;cursor:pointer;font:600 12px/1 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;white-space:nowrap}
.qtpf-btn:hover{background:rgba(46,160,110,.26)}
.qtpf-btn.ghost{border-color:rgba(120,120,140,.4);background:rgba(120,120,140,.1)}
.qtpf-btn.ghost:hover{background:rgba(120,120,140,.2)}
@media (prefers-color-scheme:dark){.qtpf-btn{color:#e8e8f0}}
.qtpf-big{display:flex;align-items:baseline;gap:8px;margin:2px 0 4px}
.qtpf-big b{font-size:32px;font-weight:720;letter-spacing:-.02em;line-height:1.1}
.qtpf-big span{font-size:12px;opacity:.6}
.qtpf-bar{height:6px;border-radius:3px;background:rgba(120,120,140,.2);overflow:hidden;margin:4px 0 2px}
.qtpf-bar>i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#7c6cf0,#4aa3f0)}
.qtpf-bar.paused>i{background:linear-gradient(90deg,#f0a54a,#f07c4a)}
.qtpf-bar.plan>i{background:linear-gradient(90deg,#34c98a,#2aa06e)}
.qtpf-foot{margin-top:8px;font-size:11px;opacity:.5;text-align:right}
`;

    function Row({ k, v, dim }) {
      return React.createElement("div", { className: `qtpf-row${dim ? " exhausted" : ""}` },
        React.createElement("span", { className: "k" }, k),
        React.createElement("span", { className: "v" }, v));
    }

    /** 套餐剩余换算：徽标与套餐面板共用，口径一致。 */
    function planFacts(status) {
      const tier = status?.tier ?? null;
      const pctLeft = tier?.planUsagePercent != null
        ? Math.max(0, Math.min(100, 100 - tier.planUsagePercent))
        : null;
      const creditsLeft = tier?.monthlyCredits && pctLeft != null
        ? Math.round(tier.monthlyCredits * pctLeft / 100)
        : null;
      return { tier, pctLeft, creditsLeft };
    }

    /**
     * Cookie 处理区（只在套餐面板出现，常驻）：
     * - waiting：已开登录页，显示等待文案 + 取消按钮；
     * - 其他状态：「一键登录」按钮常驻——Cookie 有效时也可主动点击续期登录态；
     *   说明行按状态给失效提示 / 上次失败原因 / 常态提示。
     */
    function LoginBlock({ status, copy, busy, error, onLogin, onCancelLogin }) {
      const rl = status?.relogin ?? {};
      const tier = status?.tier ?? null;
      if (rl.state === "waiting") {
        const line = rl.bootstrap ? `🚀 ${copy.loginBootstrap}` : `⏳ ${copy.logging}（${fmtTime(rl.startedAt, copy)}）`;
        return React.createElement("div", { className: "qtpf-login" },
          React.createElement("span", { className: "msg" }, line),
          React.createElement("button", { type: "button", className: "qtpf-btn ghost", onClick: onCancelLogin }, copy.loginCancel));
      }
      const cookieStale = tier == null || (tier.source !== "gateway" && tier.source !== "unknown" && tier.source !== "cache");
      const hint = error || (rl.state === "failed" ? rl.message : null);
      const msg = cookieStale
        ? copy.cookieExpired + (hint ? `\n${copy.loginFail}：${hint}` : "")
        : hint ? `${copy.loginFail}：${hint}` : copy.loginIdle;
      return React.createElement("div", { className: "qtpf-login" },
        React.createElement("span", { className: "msg" }, msg),
        React.createElement("button", { type: "button", className: "qtpf-btn", disabled: busy, onClick: onLogin },
          busy ? "…" : `🔑 ${copy.loginCta}`));
    }

    /**
     * 面板分两种：mode="plan" 讲套餐剩余（剩余百分比/Credits、等级、周期），
     * mode="budget" 讲套餐权益清单（联网搜索增强/垂类搜索/网页解析/代码解释器/
     * 语音合成/语音识别/图像生成/视频生成，按当前等级显示配额）。徽标与面板一一对应。
     * 交互仿模型切换弹层：无按钮；点徽标打开并强制回源刷新，点面板外（透明遮罩）关闭。
     */
    function Panel({ mode, status, copy, anchor, onClose, login = {} }) {
      const tier = status?.tier ?? null;
      const usage = status?.usage ?? {};
      const paused = status?.paused ?? {};
      const { pctLeft, creditsLeft } = planFacts(status);
      const isPlan = mode === "plan";
      const title = isPlan ? copy.planPanelTitle : copy.budgetPanelTitle;

      // 锚定在徽标正上方：right/bottom 由 Entry 测量徽标位置得来；高度不越过视口顶部。
      const panelStyle = {
        right: anchor?.right ?? 24,
        bottom: anchor?.bottom ?? 64,
        maxHeight: anchor ? `min(70vh, calc(100vh - ${anchor.bottom + 16}px))` : "70vh",
      };
      const body = React.createElement("div", { className: "qtpf-panel", style: panelStyle, role: "dialog", "aria-label": title },
        React.createElement("div", { className: "qtpf-title" },
          React.createElement("span", null, title),
          React.createElement("span", { style: { fontWeight: 400, opacity: .6, fontSize: 12 } },
            tier ? `${tier.specCode} · ${copy.tierSource[tier.source] ?? tier.source}` : "")),

        status && status.enabled === false
          ? React.createElement("div", { className: "qtpf-warn" }, copy.budgetOff)
          : null,
        paused?.any
          ? React.createElement("div", { className: "qtpf-warn" },
              copy.pausedEquity,
              paused.until ? ` · ${copy.resumeAt} ${fmtTime(paused.until, copy)}` : "")
          : null,

        isPlan
          ? tier
            ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "qtpf-big" },
                  React.createElement("b", null, pctLeft != null ? `${pctLeft.toFixed(1)}%` : "—"),
                  React.createElement("span", null, copy.planRemaining)),
                React.createElement("div", { className: "qtpf-bar plan" },
                  React.createElement("i", { style: { width: `${pctLeft ?? 0}%` } })),
                React.createElement("div", { className: "qtpf-sec" }, copy.tier),
                Row({ k: copy.planQuota, v: `${tier.monthlyCredits || "—"} ${copy.credits}` }),
                creditsLeft != null
                  ? Row({ k: copy.planCreditsLeft, v: `≈ ${creditsLeft} / ${tier.monthlyCredits} ${copy.credits}` })
                  : null,
                tier.planUsagePercent != null
                  ? Row({ k: copy.planUsed, v: `${tier.planUsagePercent.toFixed(1)}%` })
                  : null,
                tier.remainingDays != null ? Row({ k: copy.remainingDays, v: tier.remainingDays }) : null,
                Row({ k: copy.resetAt, v: fmtTime(tier.resetTime || usage.periodAnchor, copy) }),
                tier.fallbackReason ? Row({ k: "fallback", v: String(tier.fallbackReason).slice(0, 60) }) : null,
                LoginBlock({ status, copy, busy: login.busy, error: login.error, onLogin: login.onLogin, onCancelLogin: login.onCancelLogin }))
            : React.createElement(React.Fragment, null,
                React.createElement("div", { className: "qtpf-warn" }, copy.noTier),
                LoginBlock({ status, copy, busy: login.busy, error: login.error, onLogin: login.onLogin, onCancelLogin: login.onCancelLogin }))
          : React.createElement(React.Fragment, null,
              React.createElement("div", { className: "qtpf-sec" }, copy.entitlements),
              tier && (tier.specCode === "standard" || tier.specCode === "pro")
                ? React.createElement(React.Fragment, null,
                    ENTITLEMENTS.map((item, idx) => {
                      const count = item.equity ? (status?.equityCounts ?? []).find((e) => e.key === item.equity) : null;
                      const live = equityValue(count, copy === COPY.en);
                      const exhausted = count && count.remaining <= 0;
                      return React.createElement(Row, {
                        key: idx,
                        k: copy === COPY.en ? item.en : item.zh,
                        v: live ?? item.q[copy === COPY.en ? "en" : "zh"][tier.specCode],
                        dim: exhausted,
                      });
                    }))
                : React.createElement("div", { className: "qtpf-warn" }, copy.entitlementsNote)),

        status?.generatedAt
          ? React.createElement("div", { className: "qtpf-foot" }, `${copy.updatedAt} ${fmtTime(status.generatedAt, copy)}`)
          : null);

      if (createPortal === null || typeof document === "undefined" || document.body === undefined) return body;
      return React.createElement(React.Fragment, null,
        createPortal(React.createElement("div", { className: "qtpf-backdrop", onClick: onClose }), document.body),
        createPortal(body, document.body));
    }

    /** 本插件注册的 provider id（宿主 config.providerId 的默认值；status.provider.id 到达后以其为准）。 */
    const PROVIDER_ID = "qwen-token-plan-full";

    /**
     * 从徽标容器向上走祖先，在最近的 composer 子树里找模型触发器
     * （ui-model-selection 的 triggerLabel span 内包着 <span data-provider-id>），
     * 读出当前会话选中模型的 provider id。找不到（未选模型/占位文本）返回 null。
     * 菜单选项行挂在 body 门车里，不会被 composer 祖先的子树查询命中。
     */
    function readTriggerProvider(root) {
      if (typeof document === "undefined") return null;
      let node = root;
      while (node && node !== document.body && node.parentElement) {
        const span = node.querySelector?.('[class*="triggerLabel"] [data-provider-id]');
        if (span) return span.getAttribute("data-provider-id");
        node = node.parentElement;
      }
      return null;
    }

    function Entry() {
      const copy = pickLocale();
      const [status, setStatus] = React.useState(null);
      // 两个徽标各自的面板：null 关闭，"plan" = 套餐剩余，"budget" = 权益预算。
      const [panel, setPanel] = React.useState(null);
      const [anchor, setAnchor] = React.useState(null);
      // 只有当前会话选中的模型属于本插件 provider 时才显示徽标（m01713）。
      const [mine, setMine] = React.useState(false);
      const badgeRef = React.useRef(null);
      const planBadgeRef = React.useRef(null);
      const containerRef = React.useRef(null);
      const providerIdRef = React.useRef(PROVIDER_ID);
      // 登录会话 UI 态：busy = POST login 在途；loginError = 上一次尝试的失败原因。
      const [loginBusy, setLoginBusy] = React.useState(false);
      const [loginError, setLoginError] = React.useState(null);

      // 面板锚定在「点开它的那个徽标」正上方：打开时测量，窗口变化时跟随。
      const measure = React.useCallback(() => {
        const active = panel === "plan" ? planBadgeRef.current : badgeRef.current;
        const el = active ?? badgeRef.current ?? planBadgeRef.current;
        if (!el || typeof window === "undefined") return;
        const rect = el.getBoundingClientRect();
        const right = Math.max(8, Math.min(window.innerWidth - 328, window.innerWidth - rect.right));
        const bottom = Math.max(8, window.innerHeight - rect.top + 8);
        setAnchor({ right, bottom });
      }, [panel]);

      const load = React.useCallback(async (viaRefresh) => {
        try {
          const data = await request(viaRefresh ? REFRESH : STATUS, viaRefresh ? "POST" : "GET");
          if (data?.provider?.id) providerIdRef.current = String(data.provider.id);
          setStatus(data);
          // 会话不再是 waiting 时清掉进行中标记。
          if (data?.relogin?.state !== "waiting") setLoginBusy(false);
        } catch { /* 保留旧状态，下轮轮询重试 */ }
      }, []);

      const doLogin = React.useCallback(async () => {
        setLoginBusy(true);
        setLoginError(null);
        try {
          // 失败（502）时响应体仍带 login.error 的具体原因，不能用 request() 直接抛掉。
          const response = await fetch(LOGIN, { method: "POST", credentials: "same-origin", headers: { accept: "application/json" }, cache: "no-store" });
          const data = await response.json().catch(() => null);
          if (data?.provider?.id) providerIdRef.current = String(data.provider.id);
          if (data) setStatus(data);
          if (!response.ok || data?.login?.ok !== true) {
            const why = (typeof data?.login?.error === "string" && data.login.error)
              || (typeof data?.error === "string" && data.error) || `HTTP ${response.status}`;
            setLoginError(why);
          }
        } catch (error) {
          setLoginError(error instanceof Error ? error.message : String(error));
        } finally {
          // waiting 态由 status.relogin 驱动；按钮进行中标记只覆盖 POST 在途窗口。
          setLoginBusy(false);
        }
      }, []);

      const cancelLogin = React.useCallback(async () => {
        setLoginBusy(false);
        try { setStatus(await request(LOGIN_CANCEL, "POST")); } catch { /* 下轮轮询纠正 */ }
      }, []);

      // 探测当前 composer 的模型触发器：provider 匹配才显示徽标。
      const probe = React.useCallback(() => {
        setMine(readTriggerProvider(containerRef.current) === providerIdRef.current);
      }, []);

      React.useEffect(() => {
        load(false);
        const timer = setInterval(() => load(false), POLL_MS);
        return () => clearInterval(timer);
      }, [load]);

      // 登录会话等待期：加速轮询（3s），登录成功后面板尽快显示真实数据并停掉快轮。
      const waiting = status?.relogin?.state === "waiting";
      React.useEffect(() => {
        if (!waiting) return undefined;
        const timer = setInterval(() => load(false), 3_000);
        return () => clearInterval(timer);
      }, [waiting, load]);

      React.useEffect(() => {
        if (typeof document === "undefined" || typeof MutationObserver === "undefined") return undefined;
        probe();
        let scheduled = false;
        // 节流 400ms：聊天流式输出会高频触发 DOM 变更，探测本身只是小范围查询。
        const schedule = () => {
          if (scheduled) return;
          scheduled = true;
          setTimeout(() => { scheduled = false; probe(); }, 400);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, {
          subtree: true, childList: true, attributes: true,
          attributeFilter: ["data-provider-id"],
        });
        window.addEventListener("focus", schedule);
        return () => {
          observer.disconnect();
          window.removeEventListener("focus", schedule);
        };
      }, [probe]);

      React.useEffect(() => {
        if (!panel) return undefined;
        const onKey = (e) => { if (e.key === "Escape") setPanel(null); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [panel]);

      React.useEffect(() => {
        if (!panel) return undefined;
        measure();
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return () => {
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        };
      }, [panel, measure]);

      // 预算关闭时不占输入行位置（没有可管理的东西）。
      if (status && status.enabled === false) return null;

      const paused = Boolean(status?.paused?.any);
      // 徽标只显示「权益」二字（额度明细在面板与悬浮提示里），有权益耗尽时加 ⚠ 提示。
      const label = status ? copy.badge : copy.error;
      const counts = status?.equityCounts ?? [];
      const title = status
        ? `${copy.budgetPanelTitle}\n${copy.tier}: ${status.tier?.specCode ?? "?"}`
          + (counts.length ? `\n${counts.map((c) => `${c.key} ${c.remaining}/${c.quota}${c.unit}`).join("\n")}` : "")
          + (paused ? `\n${copy.pausedEquity}` : "")
        : copy.budgetPanelTitle;

      // 套餐剩余徽标：与控制台同源（网关 usage 的已用百分比取反），Credits 数按月配额折算。
      const { tier, pctLeft, creditsLeft } = planFacts(status);
      const planPctText = pctLeft != null ? pctLeft.toFixed(1) : null;
      const planLabel = planPctText != null ? `${copy.planRemaining} ${planPctText}%` : copy.planUnknown;
      const planTitle = planPctText != null
        ? `${copy.planRemaining} ${planPctText}%${creditsLeft != null ? `\n≈ ${creditsLeft} / ${tier.monthlyCredits} ${copy.credits}` : ""}\n${copy.tier}: ${tier?.specCode ?? "?"}`
        : copy.planPanelTitle;

      // 容器常驻（display:contents 不影响工具栏布局）：隐藏徽标时 probe 仍需要它作定位锚点。
      // 交互仿模型切换弹层：点徽标 = 打开并强制回源刷新；点面板外（透明遮罩）= 关闭。
      const openPanel = (mode) => { setPanel(mode); load(true); };
      return React.createElement("span", { ref: containerRef, style: { display: "contents" } },
        mine ? React.createElement(React.Fragment, null,
          React.createElement("button", {
            type: "button",
            ref: planBadgeRef,
            className: "qtpf-badge plan",
            title: planTitle,
            "aria-expanded": panel === "plan",
            onClick: () => openPanel("plan"),
          }, `◔ ${planLabel}`),
          React.createElement("button", {
            type: "button",
            ref: badgeRef,
            className: `qtpf-badge${paused ? " paused" : ""}`,
            title,
            "aria-expanded": panel === "budget",
            onClick: () => openPanel("budget"),
          }, paused ? `⚠ ${label}` : `⚡ ${label}`),
          panel ? Panel({
            mode: panel, status, copy, anchor, onClose: () => setPanel(null),
            login: { busy: loginBusy, error: loginError, onLogin: doLogin, onCancelLogin: cancelLogin },
          }) : null)
          : null);
    }

    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === "undefined") return undefined;
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {};
        const style = document.createElement("style");
        style.dataset.plugin = "dsh-qwen-token-plan-full";
        style.dataset.pluginCss = STYLE_ID;
        style.textContent = cssText();
        document.head.appendChild(style);
        return () => { style.remove(); };
      }, "dsh-qwen-token-plan-full: styles");

      const slots = ctx.get("slots");
      if (slots === undefined) {
        ctx.logger?.warn?.(new Error("qwen-token-plan-full: 宿主未提供 slots 服务，徽标无法挂载"));
        return;
      }

      // 座位交接三要件（同 token-plan-quota 的实机结论）：同一时刻只挂一座、
      // disposer 释放占位、更优座位后到能接手。order 41 = 排在额度徽标（40）右边。
      const BadgeEntry = () => React.createElement(Entry, null);
      const seats = [
        { name: "conversation.input.right", order: 41, entry: BadgeEntry },
        { name: "conversation.input.left", order: 41, entry: BadgeEntry },
        { name: "conversation.input.dock", order: 41, entry: BadgeEntry },
      ];
      let live = null;
      for (const [index, seat] of seats.entries()) {
        ctx.effect(() => slots.inject(seat.name, () => {
          if (live !== null && live.index <= index) return () => {};
          if (live !== null) {
            const previous = live;
            live = null;
            try { previous.dispose(); } catch { /* 让位给更优座位，卸载幂等 */ }
          }
          try {
            const dispose = slots.register({ name: seat.name, id: "qwen-token-plan-full", order: seat.order }, seat.entry);
            const release = typeof dispose === "function" ? dispose : () => {};
            live = { index, name: seat.name, dispose: release };
            return () => {
              if (live !== null && live.index === index) live = null;
              try { release(); } catch { /* 幂等 */ }
            };
          } catch (error) {
            live = null;
            ctx.logger?.warn?.(new Error(`qwen-token-plan-full: 挂载到 ${seat.name} 失败 —— ${error instanceof Error ? error.message : String(error)}`));
            return () => {};
          }
        }), `dsh-qwen-token-plan-full: ${seat.name}`);
      }
    }

    exports.apply = apply;
    // 动态插件的 fiber 只看得见声明过的服务（0.1.2 起硬规则）：slots 是徽标唯一硬依赖。
    exports.inject = ["slots"];
    return module.exports;
  },
});
