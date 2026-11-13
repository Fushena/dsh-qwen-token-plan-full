import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_TIER_QUOTA, ENTITLEMENT_QUOTAS, TOOL_TO_EQUITY } from "./gateway.js";

/**
 * 服务端权益工具（联网搜索等）的调用次数预算。
 *
 * 口径（2026-11-09 更新）：剩余额度优先取控制台真实余额（queryTokenPlanEquityInfo），
 * 再叠加「上次拉取之后本地新增的调用数」，这样既覆盖别的设备/客户端已用掉的额度，
 * 也不会漏掉刷新间隔内的新调用。控制台数据不可用时（Cookie 失效、从未拉取成功、
 * 超过新鲜度阈值）退回本地估算：剩余 = 官方周期配额（ENTITLEMENT_QUOTAS）− 本周期本地计数。
 * 任一口径下某项额度耗尽后，请求不再声明该权益工具（模型调用与 DSH 本地工具不受影响）；
 * 周期重置或官网余额回升后自动恢复。周期锚点 = 网关 usage.per1MonthResetTime（套餐重置日）。
 * 计数持久化在 ~/.dsh/qwen-token-plan-full.budget.json。
 */

const THIRTY_DAYS_MS = 30 * 86_400_000;

function defaultFilePath() {
  return path.join(os.homedir(), ".dsh", "qwen-token-plan-full.budget.json");
}

/** 旧 state 的 window/periodCalls 里没有时间戳类型信息；迁移期把旧总数并入 unknown 桶即可。 */
function sanitizeCounts(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      const n = Number(value);
      if (/^[a-z0-9_]+$/.test(key) && Number.isFinite(n) && n > 0) out[key] = Math.trunc(n);
    }
  }
  return out;
}

function sanitizeState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  return {
    periodAnchor: Number(state.periodAnchor) || 0,
    totalCalls: Number.isFinite(state.totalCalls) ? Math.max(0, Math.trunc(state.totalCalls)) : 0,
    byEquity: sanitizeCounts(state.byEquity),
    tier: state.tier && typeof state.tier === "object" ? state.tier : undefined,
    equities: Array.isArray(state.equities)
      ? state.equities
        .filter((item) => item && typeof item === "object" && typeof item.key === "string"
          && Number.isFinite(Number(item.available)) && Number(item.total) > 0)
        .map((item) => ({
          key: String(item.key).slice(0, 48),
          unit: String(item.unit ?? "").slice(0, 12),
          available: Math.max(0, Math.round(Number(item.available))),
          total: Math.round(Number(item.total)),
        }))
      : undefined,
    equitiesFetchedAt: Number(state.equitiesFetchedAt) || 0,
    // 官网余额拉取时刻的本地计数快照：官网余额 + (此后本地新增计数) = 当前真实剩余。
    equityUsedAtFetch: sanitizeCounts(state.equityUsedAtFetch),
    suppressedNotifiedAt: Number(state.suppressedNotifiedAt) || 0,
  };
}

export class HarnessBudget {
  #config;
  #logger;
  #filePath;
  #state;

  constructor({ config = {}, logger, filePath = defaultFilePath() } = {}) {
    this.#config = config && typeof config === "object" ? config : {};
    this.#logger = logger;
    this.#filePath = filePath;
    this.#state = this.#load();
  }

  #budgetConfig() {
    const budget = this.#config.harnessBudget;
    return budget && typeof budget === "object" ? budget : {};
  }

  /** harnessBudget:false 或 harnessBudget.disabled:true 时整个预算机制关闭（工具永远声明）。 */
  get enabled() {
    return this.#config.harnessBudget !== false && this.#budgetConfig().disabled !== true;
  }

  #load() {
    // 读坏绝不能静默：旧实现 catch 后直接 return sanitizeState({})，
    // 一次坏读就把「本周期已用次数」清零 → 预算判成满额 → 继续声明已耗尽的权益工具
    // → 套餐外后付费。所以这里：① 解析失败先试 .bak 备份（每次成功 save 前都会留一份）；
    // ② 备份也不行就把坏文件挪成 .corrupt-<ts> 并明确 warning「计数已丢失」，
    // 让用户知道要刷新面板重新拉取官网余额，而不是悄悄把额度放大。
    try {
      return sanitizeState(JSON.parse(fs.readFileSync(this.#filePath, "utf8")));
    } catch (error) {
      const missing = error?.code === "ENOENT";
      if (missing) return sanitizeState({});
      this.#logger?.warn?.(
        `qwen-token-plan-full: 预算状态文件读取失败（${error instanceof Error ? error.message : String(error)}），尝试从备份恢复：${this.#backupPath}`,
      );
      const restored = this.#restoreFromBackup();
      if (restored) {
        // 恢复成功也把坏文件隔离掉：否则此后每次启动都先撞同一个坏文件，
        // 每次都要走「读坏 → 恢复」路径，日志噪声大且难以排查根因。
        const corrupt = this.#quarantineCorruptFile();
        this.#logger?.warn?.(
          `qwen-token-plan-full: 预算状态文件已损坏${corrupt ? `（已另存为 ${corrupt}）` : ""}，已从备份 ${this.#backupPath} 恢复计数。`,
        );
        return restored;
      }
      // 备份也不可用：把坏文件挪成 .corrupt-<ts> 留证（不覆盖任何东西），
      // 并明确告知「本周期计数已丢失」，便于用户重新拉取官网余额核对。
      const corrupt = this.#quarantineCorruptFile();
      this.#logger?.warn?.(
        `qwen-token-plan-full: 预算状态文件已损坏${corrupt ? `（已另存为 ${corrupt}）` : ""}，本周期权益计数丢失。` +
        `请刷新面板重新拉取官网余额；在数据恢复前，权益额度按「官网余额优先」的保守口径判定。`,
      );
      return sanitizeState({});
    }
  }

  get #backupPath() {
    return `${this.#filePath}.bak`;
  }

  /**
   * 从 .bak 恢复（每次成功 #save 前都会留一份）：成功返回反序列化后的状态，
   * 调用方会把它作为内存状态，并在下一轮 #save 重建正式文件。
   * 注意 .bak 是「上一次成功保存」的快照，最多比主文件少一轮计数——这比归零好得多。
   * @returns 状态对象，或 null（备份不存在/也损坏）。
   */
  #restoreFromBackup() {
    try {
      const raw = fs.readFileSync(this.#backupPath, "utf8");
      const state = sanitizeState(JSON.parse(raw));
      this.#logger?.warn?.(`qwen-token-plan-full: 预算状态文件损坏，已从备份恢复：${this.#backupPath}`);
      return state;
    } catch {
      return null;
    }
  }

  /** 把损坏文件挪成 .corrupt-<ts>（避免下一次读到同一坏文件），返回新路径；失败返回 null。 */
  #quarantineCorruptFile() {
    try {
      const target = `${this.#filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.#filePath, target);
      return target;
    } catch {
      return null;
    }
  }

  #save() {
    // 原子写：先写同目录临时文件再 rename。旧实现 writeFileSync 直写，进程在写一半时
    // 被打断（崩溃/断电）就会留下半截 JSON，下次启动读坏 → 计数归零（见 #load 的说明）。
    // 保留 0600：状态含控制台同源额度数据，只允许本人读写。
    const tmp = `${this.#filePath}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this.#state, null, 1)}\n`, { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* 平台不支持时忽略 */ }
      // rename 前先把上一份好文件留成 .bak：损坏时 #load 才有东西可退。
      try {
        if (fs.existsSync(this.#filePath)) fs.copyFileSync(this.#filePath, this.#backupPath);
        try { fs.chmodSync(this.#backupPath, 0o600); } catch { /* 平台不支持时忽略 */ }
      } catch { /* 备份失败不影响主写入 */ }
      fs.renameSync(tmp, this.#filePath);
    } catch (error) {
      this.#logger?.warn?.(new Error(`qwen-token-plan-full: 预算状态写入失败 ${error instanceof Error ? error.message : String(error)}`));
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败忽略 */ }
    }
  }

  /** 网关成功：写入真实等级、配额与本周期信息。 */
  setTier(info) {
    const quotaRow = info.quota?.[info.specCode] ?? BUILTIN_TIER_QUOTA[info.specCode];
    this.#state.tier = {
      specCode: info.specCode,
      monthlyCredits: Number(quotaRow?.monthly) || 0,
      fiveHourCredits: Number(quotaRow?.five_hour) || 0,
      planUsagePercent: Math.round((info.usage?.per1MonthPercentage ?? 0) * 1000) / 10,
      resetTime: Number(info.usage?.per1MonthResetTime) || 0,
      remainingDays: info.subscription?.remainingDays,
      source: "gateway",
      fetchedAt: info.fetchedAt ?? Date.now(),
    };
    // 先按旧锚点结算：旧周期已过期就清零（含官网余额快照），再采用网关给的新锚点。
    const now = Date.now();
    if (this.#state.periodAnchor && this.#state.periodAnchor <= now) {
      this.#state.byEquity = {};
      this.#state.suppressedNotifiedAt = 0;
      // 官网快照属于旧周期：不清的话新周期 15min 新鲜期内仍按旧 available=0
      // 误抑制工具（2026-11-13 修复）。清掉后回落 local 兜底，等下轮 equity 刷新。
      this.#state.equities = undefined;
      this.#state.equitiesFetchedAt = 0;
      this.#state.equityUsedAtFetch = {};
    }
    if (this.#state.tier.resetTime > now) this.#state.periodAnchor = this.#state.tier.resetTime;
    this.#rollover();
    this.#save();
  }

  /** 网关不可达：按配置等级（默认 standard）用内置配额表兜底，保留已有周期锚点。 */
  setTierFallback(reason) {
    const configured = String(this.#config.tier || "auto");
    const specCode = configured !== "auto" && BUILTIN_TIER_QUOTA[configured] ? configured : "standard";
    const row = BUILTIN_TIER_QUOTA[specCode];
    const previous = this.#state.tier;
    this.#state.tier = {
      specCode,
      monthlyCredits: row.monthly,
      fiveHourCredits: row.five_hour,
      planUsagePercent: previous?.source === "gateway" ? previous.planUsagePercent : undefined,
      resetTime: previous?.resetTime ?? 0,
      remainingDays: previous?.remainingDays,
      source: configured !== "auto" && BUILTIN_TIER_QUOTA[configured] ? "config" : "builtin",
      fallbackReason: reason,
      fetchedAt: Date.now(),
    };
    if (!this.#state.periodAnchor) this.#state.periodAnchor = Date.now() + THIRTY_DAYS_MS;
    this.#save();
  }

  /** 周期锚点已过 → 清零周期计数并推进锚点（网关 resetTime 优先，否则 +30 天估算）。 */
  #rollover() {
    const now = Date.now();
    if (!this.#state.periodAnchor) {
      this.#state.periodAnchor = this.#state.tier?.resetTime > now ? this.#state.tier.resetTime : now + THIRTY_DAYS_MS;
      return;
    }
    while (this.#state.periodAnchor <= now) {
      this.#state.byEquity = {};
      this.#state.suppressedNotifiedAt = 0;
      // 同 setTier 的周期结算：官网余额快照随旧周期一起作废（见彼处说明）。
      this.#state.equities = undefined;
      this.#state.equitiesFetchedAt = 0;
      this.#state.equityUsedAtFetch = {};
      const resetTime = this.#state.tier?.resetTime ?? 0;
      this.#state.periodAnchor = resetTime > now ? resetTime : this.#state.periodAnchor + THIRTY_DAYS_MS;
    }
  }

  /** 当前等级下每项权益的周期配额（lite/essential 无权益 → null）。 */
  #specCode() {
    const spec = this.#state.tier?.specCode;
    return spec === "standard" || spec === "pro" ? spec : null;
  }

  /** 控制台余额的新鲜度阈值：超过即视为不可信，退回本地估算。 */
  get #equityFreshMs() {
    const raw = Number(this.#budgetConfig().equityFreshMinutes);
    const minutes = Number.isFinite(raw) && raw >= 1 ? raw : 15;
    return minutes * 60_000;
  }

  /**
   * 控制台真实余额（queryTokenPlanEquityInfo 同源），已扣除拉取之后的本地新增调用。
   * 返回 null 表示这份数据不可用（从未拉取 / 超过新鲜度阈值 / 不含该项权益）。
   *
   * 为什么还要减「sinceFetch」：官网余额是 10 分钟前拉取的快照，其间本机可能又调用了
   * 若干次；不减就会高估剩余、把已经用掉的额度继续当成可用。
   */
  #officialRemaining(key) {
    const fetchedAt = Number(this.#state.equitiesFetchedAt) || 0;
    if (!fetchedAt) return null;
    if (Date.now() - fetchedAt > this.#equityFreshMs) return null;
    const rows = Array.isArray(this.#state.equities) ? this.#state.equities : null;
    if (!rows) return null;
    const row = rows.find((item) => item?.key === key);
    if (!row) return null;
    const available = Number(row.available);
    const total = Number(row.total);
    if (!Number.isFinite(available) || !Number.isFinite(total) || total <= 0) return null;
    const usedAtFetch = this.#state.equityUsedAtFetch?.[key] ?? 0;
    const usedNow = this.#state.byEquity[key] ?? 0;
    const sinceFetch = Math.max(0, usedNow - usedAtFetch);
    return {
      available: Math.max(0, Math.round(available)),
      total: Math.round(total),
      sinceFetch,
      fetchedAt,
    };
  }

  /**
   * 单项权益本周期计数：{ used, quota, remaining, source }；
   * 预算关闭或无配额定义（视频生成等）→ null。
   *
   * remaining 的来源（source）：
   * - "official"：控制台真实余额，跨设备/跨客户端准确（首选）
   * - "local"：本地计次估算（控制台数据不可用时的兜底）
   */
  equityState(key) {
    if (!this.enabled) return null;
    this.#rollover();
    const official = this.#officialRemaining(key);
    if (official) {
      const remaining = Math.max(0, official.available - official.sinceFetch);
      return {
        key,
        quota: official.total,
        used: Math.max(0, official.total - remaining),
        remaining,
        unit: ENTITLEMENT_QUOTAS[key]?.unit ?? "",
        source: "official",
        sinceFetch: official.sinceFetch,
        fetchedAt: official.fetchedAt,
      };
    }
    const specCode = this.#specCode();
    const quota = specCode ? ENTITLEMENT_QUOTAS[key]?.[specCode] : undefined;
    if (!Number.isFinite(quota) || quota <= 0) return null;
    const used = this.#state.byEquity[key] ?? 0;
    return {
      key,
      quota,
      used,
      remaining: Math.max(0, quota - used),
      unit: ENTITLEMENT_QUOTAS[key].unit,
      source: "local",
    };
  }

  /** 面板/预算共用：全部有配额定义的权益键的计数状态。 */
  equitiesState() {
    return Object.keys(ENTITLEMENT_QUOTAS).map((key) => this.equityState(key)).filter(Boolean);
  }

  /**
   * 请求前过滤：返回该模型可继续声明的服务端工具（权益未耗尽的）。
   * 无权益映射的工具（本地 function 走不到这里）原样保留。
   */
  filterTools(tools) {
    if (!this.enabled) return { tools, dropped: [] };
    this.#rollover();
    const dropped = [];
    const kept = tools.filter((type) => {
      const key = TOOL_TO_EQUITY[type];
      if (!key) return true;
      const state = this.equityState(key);
      // 无配额定义（等级未知/网关兜底）时不拦截；有定义且剩余 0 时停用。
      if (state && state.remaining <= 0) {
        dropped.push({
          key, used: state.used, quota: state.quota,
          source: state.source, remaining: state.remaining,
        });
        return false;
      }
      return true;
    });
    return { tools: kept, dropped };
  }

  /** 旧接口兼容：任一权益耗尽即视为暂停（adapter 不再用它做整体开关）。 */
  canUse() {
    if (!this.enabled) return { ok: true, reason: "disabled" };
    const { dropped } = this.filterTools(Object.keys(TOOL_TO_EQUITY));
    if (dropped.length) return { ok: false, reason: "equity", dropped, until: this.#state.periodAnchor };
    return { ok: true };
  }

  /** 抑制发生时调用：每小时只提示一次，避免刷屏。 */
  noteSuppression(check) {
    const now = Date.now();
    if (this.#state.suppressedNotifiedAt && now - this.#state.suppressedNotifiedAt < 3_600_000) return;
    this.#state.suppressedNotifiedAt = now;
    this.#save();
    const until = check?.until ? new Date(check.until).toLocaleString("zh-CN") : "周期重置后";
    const items = (check?.dropped ?? []).map((d) => {
      const basis = d.source === "official" ? "官网余额" : "本地计次";
      return `${d.key} ${d.used}/${d.quota}（${basis}）`;
    }).join("、");
    this.#logger?.info?.(
      `qwen-token-plan-full: 权益额度已耗尽（${items || "未知项"}），暂停声明对应内置工具以避免套餐外按量计费（模型调用与 DSH 本地工具不受影响），${until}自动恢复。`,
    );
  }

  /**
   * 记录一次权益调用（SSE 里每个 *_call 输出项计一次；媒体工具传 image_generation）。
   * 预算关闭时不计数。返回计数后的权益状态（无映射/无配额返回 null）。
   */
  record(type, count = 1) {
    if (!this.enabled) return null;
    this.#rollover();
    const key = TOOL_TO_EQUITY[String(type ?? "").replace(/[^a-z0-9_]/gi, "_").toLowerCase()];
    const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1;
    this.#state.totalCalls += n;
    if (key) this.#state.byEquity[key] = (this.#state.byEquity[key] ?? 0) + n;
    this.#save();
    this.#logger?.debug?.(`qwen-token-plan-full: 权益调用 +${n}（${key ?? type ?? "unknown"}）`);
    return key ? this.equityState(key) : null;
  }

  /**
   * 控制台权益明细（queryTokenPlanEquityInfo）：既是面板数据源，也是额度耗尽判定的
   * 首选依据（见 equityState）。拉取成功时同时记录当时的本地计数快照。
   */
  setEquities(list) {
    const rows = Array.isArray(list) ? list : null;
    this.#state.equities = rows;
    if (rows) {
      this.#state.equitiesFetchedAt = Date.now();
      // 记录「此刻的本地计数」：之后 equityState 用 官网余额 − (当前计数 − 快照)，
      // 得到拉取之后仍然真实的剩余量（官网快照 + 本地增量）。
      this.#state.equityUsedAtFetch = { ...this.#state.byEquity };
    } else {
      // 拉取失败：保留旧快照，仅让新鲜度判定自然过期退回本地估算。
      this.#state.equitiesFetchedAt = this.#state.equitiesFetchedAt || 0;
    }
    this.#save();
  }

  /** 面板/路由用的完整状态。 */
  status() {
    this.#rollover();
    const specCode = this.#specCode();
    const equityStates = this.equitiesState();
    const exhausted = equityStates.filter((e) => e.remaining <= 0);
    return {
      enabled: this.enabled,
      tier: this.#state.tier ?? null,
      // 权益计数：面板行值与预算拦截共用同一口径；每项的 source 标明依据
      // （"official" = 控制台真实余额，"local" = 本地计次兜底）。
      equityCounts: equityStates,
      // 控制台权益明细原始数据（equityState 的首选依据）。
      equities: this.#state.equities ?? null,
      equitiesFetchedAt: this.#state.equitiesFetchedAt || null,
      // 官网数据是否足够新鲜：false 时拦截依据退回本地计次。
      equitiesFresh: this.#state.equitiesFetchedAt
        ? Date.now() - this.#state.equitiesFetchedAt <= this.#equityFreshMs
        : false,
      equitiesFreshMinutes: Math.round(this.#equityFreshMs / 60_000),
      caps: { specCode },
      usage: {
        totalCalls: this.#state.totalCalls,
        periodAnchor: this.#state.periodAnchor || null,
      },
      paused: {
        // 官网余额可用时以它为准（即使等级未知也拦得住）；否则要求有本地配额定义。
        any: this.enabled && exhausted.length > 0
          && (specCode != null || exhausted.some((e) => e.source === "official")),
        reason: "equity",
        exhausted: exhausted.map((e) => ({
          key: e.key, used: e.used, quota: e.quota, unit: e.unit, source: e.source,
        })),
        until: this.#state.periodAnchor || null,
      },
      generatedAt: Date.now(),
    };
  }
}
