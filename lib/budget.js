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

// 同进程内多实例（热重载新旧并存）共用一个 pid，tmp 名再加自增序号防撞车。
let tmpSeq = 0;

// 锚点抖动容差：两个实例几乎同时从空状态各自估算 now+30d 锚点，会相差几秒。
// 这不是真正的周期切换（真实切换至少跳一个网关重置日或 30 天），计数仍须合并。
const ANCHOR_JITTER_MS = 60_000;

/** 计数逐键相加（并集键）。 */
function addCounts(a, b) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = (out[key] ?? 0) + value;
  return out;
}

/** a 相对 b 的正增量（逐键 max(0, a-b)）：只取「新增的部分」，负数按 0。 */
function deltaCounts(a, b) {
  const out = {};
  for (const [key, value] of Object.entries(a)) {
    const d = value - (b[key] ?? 0);
    if (d > 0) out[key] = d;
  }
  return out;
}

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
  const anchorSource = state.periodAnchorSource === "gateway" || state.periodAnchorSource === "estimated"
    ? state.periodAnchorSource
    : undefined;
  return {
    periodAnchor: Number(state.periodAnchor) || 0,
    ...(anchorSource ? { periodAnchorSource: anchorSource } : {}),
    totalCalls: Number.isFinite(state.totalCalls) ? Math.max(0, Math.trunc(state.totalCalls)) : 0,
    byEquity: sanitizeCounts(state.byEquity),
    // 第一层「服务自带免费额度」的本地增量，与 byEquity 分开记（Q4，2026-11-25）：
    // 官方抵扣顺序是先扣第一层，共用一个计数器会把免费用量记到套餐权益头上，
    // 让第二层凭空少掉一截 → 误摘工具、误拒生成（免费额度还剩很多却回落付费）。
    // 账号级试用额度，不随订阅周期清零（与 serviceQuotas 快照同寿命）。
    byService: sanitizeCounts(state.byService),
    tier: state.tier && typeof state.tier === "object" ? state.tier : undefined,
    equities: sanitizeQuotaRows(state.equities),
    equitiesFetchedAt: Number(state.equitiesFetchedAt) || 0,
    // 官网余额拉取时刻的本地计数快照：官网余额 + (此后本地新增计数) = 当前真实剩余。
    equityUsedAtFetch: sanitizeCounts(state.equityUsedAtFetch),
    // 第一层「服务自带免费额度」快照（DescribeFqInstance）。与 equities 分开存：
    // 两层来自不同接口、刷新节奏也不同，任何一层失败不该让另一层的快照作废。
    // usedAtFetch 与第二层同理：快照之后本机新增的调用要从余额里扣掉。
    serviceQuotas: sanitizeQuotaRows(state.serviceQuotas, true),
    serviceQuotasFetchedAt: Number(state.serviceQuotasFetchedAt) || 0,
    serviceQuotaUsedAtFetch: sanitizeCounts(state.serviceQuotaUsedAtFetch),
    suppressedNotifiedAt: Number(state.suppressedNotifiedAt) || 0,
  };
}

/** 额度快照行的公共校验。withExpiry=true 时额外保留到期时间（第一层试用额度有有效期）。 */
function sanitizeQuotaRows(raw, withExpiry = false) {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((item) => item && typeof item === "object" && typeof item.key === "string"
      && Number.isFinite(Number(item.available)) && Number(item.total) > 0)
    .map((item) => ({
      key: String(item.key).slice(0, 48),
      unit: String(item.unit ?? "").slice(0, 12),
      available: Math.max(0, Math.round(Number(item.available))),
      total: Math.round(Number(item.total)),
      ...(withExpiry ? { expiresAt: Number(item.expiresAt) > 0 ? Number(item.expiresAt) : null } : {}),
    }));
}

/** 判定状态的周期锚点是否来自网关权威 resetTime（而非本地 +30d 估算占位）。 */
function isAuthoritativeAnchor(state) {
  if (!state || !(state.periodAnchor > 0)) return false;
  if (state.periodAnchorSource === "gateway") return true;
  if (state.periodAnchorSource === "estimated") return false;
  // 兼容旧落盘文件（无 periodAnchorSource 字段）：网关 tier 的 resetTime 与锚点对齐才算权威。
  return state.tier?.source === "gateway"
    && Number(state.tier?.resetTime) > 0
    && Math.abs(state.periodAnchor - state.tier.resetTime) <= ANCHOR_JITTER_MS;
}

export class HarnessBudget {
  #config;
  #logger;
  #filePath;
  #state;
  // 上次成功落盘的快照：#save 用它算「本实例自上次保存以来的增量」，
  // 与磁盘现值合并（见 #save）。构造时初始化为加载到的磁盘状态（增量基线为 0）。
  #lastSaved;

  constructor({ config = {}, logger, filePath = defaultFilePath() } = {}) {
    this.#config = config && typeof config === "object" ? config : {};
    this.#logger = logger;
    this.#filePath = filePath;
    this.#state = this.#load();
    // 增量基线 = 构造时加载到的磁盘状态：此刻本实例相对磁盘的增量为 0。
    this.#lastSaved = structuredClone(this.#state);
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

  /**
   * 落盘前读磁盘现值，供 #save 合并。返回 sanitizeState 后的状态；
   * 主文件不存在返回 null（首次落盘）。读坏时延续 #load 的教训：
   * 先试 .bak，再不行隔离 .corrupt 并明确 warning——绝不静默当成 0，
   * 那会把别的实例已记的用量抹掉 → 余额高估 → 套餐外后付费。
   */
  #readDiskForMerge() {
    try {
      return sanitizeState(JSON.parse(fs.readFileSync(this.#filePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      this.#logger?.warn?.(
        `qwen-token-plan-full: 落盘前读取预算状态失败（${error instanceof Error ? error.message : String(error)}），尝试从备份合并：${this.#backupPath}`,
      );
      const restored = this.#restoreFromBackup();
      const corrupt = this.#quarantineCorruptFile();
      if (restored) {
        this.#logger?.warn?.(
          `qwen-token-plan-full: 预算状态文件已损坏${corrupt ? `（已另存为 ${corrupt}）` : ""}，落盘改用备份 ${this.#backupPath} 作为合并基线。`,
        );
        return restored;
      }
      // 主文件与备份都不可用：只能以本实例内存为基线重建（合并时 max 会保住
      // 本实例的全部历史），但必须明确告知「磁盘上可能还有别的实例的计数已丢失」。
      this.#logger?.warn?.(
        `qwen-token-plan-full: 预算状态文件已损坏${corrupt ? `（已另存为 ${corrupt}）` : ""}且备份不可用，` +
        `磁盘上的权益计数可能丢失，本次落盘仅保留本实例计数。请刷新面板重新拉取官网余额；` +
        `在数据恢复前，权益额度按「官网余额优先」的保守口径判定。`,
      );
      return sanitizeState({});
    }
  }

  /**
   * 把本实例状态与磁盘现值合并（缺陷 A 修复，2026-11-18）。
   *
   * 为什么必须合并：旧 #save 用本实例内存快照整份 rename 覆盖。双开 DSH、
   * 热重载新旧实例并存、在途流跨实例完成时，各实例基于同一份旧快照各自 +1，
   * 后写的把先写的吞掉（实测两实例共 3 次调用落盘 totalCalls=1）→ 用量少记
   * → 余额高估 → 继续声明已耗尽的权益工具 → 套餐外按量后付费。
   *
   * 为什么选「磁盘现值 + 本实例增量」而不是「取双方较大值」：
   * 两实例从同一基线各自 +1 时双方内存值相等，max 仍是 1，照样互吞；
   * 增量（相对 #lastSaved）才能把并发新增都累上。增量在每次成功落盘后
   * 重置基线，重复保存增量为 0，幂等不重复计数。再与内存值取 max 兜底：
   * 磁盘因坏读回退到更旧的 .bak 时，不丢本实例已有的完整历史。
   *
   * 周期边界：periodAnchor 不同（超出抖动容差）时计数不可比——旧周期的
   * 90 次不能 max/累加进新周期。以锚点较新（已 rollover）的一方为周期基准：
   * 磁盘较新 → 磁盘计数 + 本实例增量（这些调用真实发生在当下，属新周期）；
   * 本实例较新 → 本实例已 rollover 清零，磁盘旧周期计数直接作废（无法知道
   * 磁盘的增量基线，宁可少记也不把旧周期用量带进新周期）。
   * totalCalls 是跨周期累计（rollover 从不清它），不受周期边界影响。
   *
   * 官网快照（equities/equitiesFetchedAt/equityUsedAtFetch）与 tier 不是
   * 累计量：同周期取 fetchedAt 较新的那份整体（三件套不可拆散配对）；
   * 跨周期只认新周期一方的快照——旧周期快照在新周期新鲜期内仍按旧
   * available=0 误抑制工具（2026-11-13 的教训，见 setTier）。
   */
  #mergeWithDisk(disk) {
    const mine = this.#state;
    const base = this.#lastSaved;
    if (!disk) return mine;
    const now = Date.now();
    const myAnchor = mine.periodAnchor || 0;
    const diskAnchor = disk.periodAnchor || 0;
    const myAuth = isAuthoritativeAnchor(mine);
    const diskAuth = isAuthoritativeAnchor(disk);
    // 估算锚点（now+30d）只是未拿到网关重置日前的占位值，可能晚于真实重置日（如 now+10d）。
    // 若一方持有网关权威锚点而另一方只是尚未过期的估算锚点，属于「同周期锚点校准」，
    // 绝不能因估算值数值更大就判定为新周期并把真实 tier / resetTime 覆写回兜底态。
    const calibratingMine = myAuth && !diskAuth && diskAnchor > now;
    const calibratingDisk = !myAuth && diskAuth && myAnchor > now;
    // 双方都无锚点，或同属权威/估算且锚点相同/仅差几秒（两实例几乎同时各自估算 now+30d）
    // → 同一周期。真实周期切换至少跳一个重置日或 30 天，远大于容差。
    const samePeriod = calibratingMine || calibratingDisk
      || myAnchor === diskAnchor
      || Math.abs(myAnchor - diskAnchor) <= ANCHOR_JITTER_MS;
    const diskNewer = diskAnchor > myAnchor;

    // 本实例自上次成功落盘以来的正增量（负数按 0：rollover 清零不算增量）。
    const totalDelta = Math.max(0, (mine.totalCalls || 0) - (base.totalCalls || 0));
    const countDelta = deltaCounts(mine.byEquity, base.byEquity);
    // 第一层计数器同口径（Q4）：账号级、不随周期清零，所以三个分支都要单独合并。
    const serviceDelta = deltaCounts(mine.byService, base.byService);

    const merged = { ...mine };
    // totalCalls：跨周期累计，恒合并。
    merged.totalCalls = Math.max(mine.totalCalls || 0, (disk.totalCalls || 0) + totalDelta);

    if (samePeriod) {
      if (calibratingMine) {
        merged.periodAnchor = myAnchor;
        merged.periodAnchorSource = "gateway";
      } else if (calibratingDisk) {
        merged.periodAnchor = diskAnchor;
        merged.periodAnchorSource = "gateway";
      } else {
        merged.periodAnchor = Math.max(myAnchor, diskAnchor);
        if (myAuth || diskAuth) merged.periodAnchorSource = "gateway";
        else if (mine.periodAnchorSource === "estimated" || disk.periodAnchorSource === "estimated") {
          merged.periodAnchorSource = "estimated";
        }
      }
      merged.byEquity = {};
      const keys = new Set([...Object.keys(mine.byEquity), ...Object.keys(disk.byEquity)]);
      for (const key of keys) {
        const m = mine.byEquity[key] ?? 0;
        const d = (disk.byEquity[key] ?? 0) + (countDelta[key] ?? 0);
        merged.byEquity[key] = Math.max(m, d);
      }
      merged.byService = {};
      const serviceKeys = new Set([...Object.keys(mine.byService), ...Object.keys(disk.byService)]);
      for (const key of serviceKeys) {
        const m = mine.byService[key] ?? 0;
        const d = (disk.byService[key] ?? 0) + (serviceDelta[key] ?? 0);
        merged.byService[key] = Math.max(m, d);
      }
      // 官网快照三件套：整体取 equitiesFetchedAt 较新的一份。
      if ((disk.equitiesFetchedAt || 0) > (mine.equitiesFetchedAt || 0)) {
        merged.equities = disk.equities;
        merged.equitiesFetchedAt = disk.equitiesFetchedAt;
        merged.equityUsedAtFetch = disk.equityUsedAtFetch;
      }
      // tier 是网关/兜底快照：校准期优先保留网关权威 tier，同性质按 fetchedAt 取较新。
      if (calibratingMine) {
        if (disk.tier?.source === "gateway" && (disk.tier.fetchedAt ?? 0) > (mine.tier?.fetchedAt ?? 0)) {
          merged.tier = disk.tier;
        }
      } else if (calibratingDisk) {
        if (mine.tier?.source !== "gateway" && (disk.tier?.fetchedAt ?? 0) >= (mine.tier?.fetchedAt ?? 0)) {
          merged.tier = disk.tier;
        } else if ((disk.tier?.fetchedAt ?? 0) > (mine.tier?.fetchedAt ?? 0)) {
          merged.tier = disk.tier;
        }
      } else if ((disk.tier?.fetchedAt ?? 0) > (mine.tier?.fetchedAt ?? 0)) {
        merged.tier = disk.tier;
      }
    } else if (diskNewer) {
      // 磁盘已滚入新周期：以磁盘为基准，叠加本实例增量（真实发生在当下）。
      merged.periodAnchor = diskAnchor;
      if (diskAuth) merged.periodAnchorSource = "gateway";
      else if (disk.periodAnchorSource) merged.periodAnchorSource = disk.periodAnchorSource;
      else delete merged.periodAnchorSource;
      merged.byEquity = addCounts(disk.byEquity, countDelta);
      // 第一层是账号级额度，磁盘已滚周期也不作废它的本地计数（只叠加本实例增量）。
      merged.byService = addCounts(disk.byService, serviceDelta);
      merged.equities = disk.equities;
      merged.equitiesFetchedAt = disk.equitiesFetchedAt;
      merged.equityUsedAtFetch = disk.equityUsedAtFetch;
      merged.tier = disk.tier;
    } else {
      // 本实例已滚入新周期：内存计数就是新周期的全部；磁盘旧周期计数与
      // 旧快照作废，不带入（带进来会把旧周期用量算到新周期头上 → 错乱）。
      merged.periodAnchor = myAnchor;
      // 第一层账号级额度不随订阅周期作废：本实例计数 + 磁盘里本实例还没见过的部分。
      merged.byService = addCounts(mine.byService, deltaCounts(disk.byService, base.byService));
    }
    // 第一层快照三件套（账号级、跨订阅周期，按自身到期时间作废）：
    // 三个分支统一按 serviceQuotasFetchedAt 整体取较新，绝不拆散三元组配对，
    // 也不在本实例滚周期时把磁盘上更新的第一层快照覆盖回旧值。
    if ((disk.serviceQuotasFetchedAt || 0) > (mine.serviceQuotasFetchedAt || 0)) {
      merged.serviceQuotas = disk.serviceQuotas;
      merged.serviceQuotasFetchedAt = disk.serviceQuotasFetchedAt;
      merged.serviceQuotaUsedAtFetch = disk.serviceQuotaUsedAtFetch;
    }
    // 抑制提示时间戳：取较新，避免多实例重复刷屏（不影响余额口径）。
    merged.suppressedNotifiedAt = Math.max(mine.suppressedNotifiedAt || 0, disk.suppressedNotifiedAt || 0);
    return merged;
  }

  #save() {
    // 原子写：先写同目录临时文件再 rename。旧实现 writeFileSync 直写，进程在写一半时
    // 被打断（崩溃/断电）就会留下半截 JSON，下次启动读坏 → 计数归零（见 #load 的说明）。
    // 保留 0600：状态含控制台同源额度数据，只允许本人读写。
    // tmp 名保留 pid 后缀（跨进程防撞），再加进程内自增序号：热重载时同进程
    // 新旧实例并存，只靠 pid 会撞同一个 tmp 路径。
    const tmp = `${this.#filePath}.tmp-${process.pid}-${tmpSeq++}`;
    try {
      fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
      // 落盘前与磁盘现值合并（缺陷 A）：整份覆盖会吞掉别的实例的计数。
      const merged = this.#mergeWithDisk(this.#readDiskForMerge());
      fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 1)}\n`, { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* 平台不支持时忽略 */ }
      // rename 前先把上一份好文件留成 .bak：损坏时 #load 才有东西可退。
      try {
        if (fs.existsSync(this.#filePath)) fs.copyFileSync(this.#filePath, this.#backupPath);
        try { fs.chmodSync(this.#backupPath, 0o600); } catch { /* 平台不支持时忽略 */ }
      } catch { /* 备份失败不影响主写入 */ }
      fs.renameSync(tmp, this.#filePath);
      // 成功后才采纳合并结果并重置增量基线：rename 失败时基线不动，
      // 下次保存会把本次增量重新算进去，不丢计数。
      this.#state = merged;
      this.#lastSaved = structuredClone(merged);
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
    if (this.#state.tier.resetTime > now) {
      this.#state.periodAnchor = this.#state.tier.resetTime;
      this.#state.periodAnchorSource = "gateway";
    }
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
      planUsagePercent: previous?.source === "gateway" && previous.specCode === specCode ? previous.planUsagePercent : undefined,
      resetTime: previous?.resetTime ?? 0,
      remainingDays: previous?.remainingDays,
      source: configured !== "auto" && BUILTIN_TIER_QUOTA[configured] ? "config" : "builtin",
      fallbackReason: reason,
      fetchedAt: Date.now(),
    };
    if (!this.#state.periodAnchor) {
      this.#state.periodAnchor = Date.now() + THIRTY_DAYS_MS;
      this.#state.periodAnchorSource = "estimated";
    }
    this.#save();
  }

  /** 周期锚点已过 → 清零周期计数并推进锚点（网关 resetTime 优先，否则 +30 天估算）。 */
  #rollover() {
    const now = Date.now();
    if (!this.#state.periodAnchor) {
      if (this.#state.tier?.resetTime > now) {
        this.#state.periodAnchor = this.#state.tier.resetTime;
        this.#state.periodAnchorSource = "gateway";
      } else {
        this.#state.periodAnchor = now + THIRTY_DAYS_MS;
        this.#state.periodAnchorSource = "estimated";
      }
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
      if (resetTime > now) {
        this.#state.periodAnchor = resetTime;
        this.#state.periodAnchorSource = "gateway";
      } else {
        this.#state.periodAnchor = this.#state.periodAnchor + THIRTY_DAYS_MS;
        this.#state.periodAnchorSource = "estimated";
      }
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
    const age = Date.now() - fetchedAt;
    // 时钟回拨（age < 0，fetchedAt 落在未来）：快照年龄不可信，判为不新鲜
    // 退回本地估算。旧实现只判 age > 阈值，回拨后差值恒为负 → 官网快照
    // 「永不过期」（实测回拨 1 小时仍判 official 新鲜），其间本机新增调用
    // 若超出快照口径就会高估余额 → 套餐外后付费（2026-11-18 修复）。
    if (age < 0 || age > this.#equityFreshMs) return null;
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
   * 第一层「服务自带免费额度」的单项状态：{ key, quota, used, remaining, unit, expiresAt, source }。
   *
   * 与 equityState 的关键差别：**不参与工具拦截**。官方抵扣顺序是先扣这一层、再扣
   * Token Plan 权益，所以这一层耗尽只意味着「开始扣第二层」，能力并没有断——
   * 拿它去摘工具会把还能用的能力误停。它只用于面板显示与「当前在扣哪一层」的判定。
   *
   * 无快照 / 快照过期 / 该项已到期 → null（面板不显示这一层，不猜数）。
   */
  serviceQuotaState(key) {
    const fetchedAt = Number(this.#state.serviceQuotasFetchedAt) || 0;
    if (!fetchedAt) return null;
    const age = Date.now() - fetchedAt;
    // 与 #officialRemaining 同口径：时钟回拨也判不新鲜。
    if (age < 0 || age > this.#equityFreshMs) return null;
    const rows = Array.isArray(this.#state.serviceQuotas) ? this.#state.serviceQuotas : null;
    const row = rows?.find((item) => item?.key === key);
    if (!row) return null;
    const expiresAt = Number(row.expiresAt) > 0 ? Number(row.expiresAt) : null;
    // 已过期的试用额度不能再算可用：否则会把「其实要花钱了」显示成「还有免费额度」。
    if (expiresAt != null && expiresAt <= Date.now()) return null;
    const usedAtFetch = this.#state.serviceQuotaUsedAtFetch?.[key] ?? 0;
    // 只读第一层自己的计数器（Q4）：读 byEquity 会把扣到第二层的量重复扣在第一层头上。
    const usedNow = this.#state.byService[key] ?? 0;
    const sinceFetch = Math.max(0, usedNow - usedAtFetch);
    const remaining = Math.max(0, Number(row.available) - sinceFetch);
    return {
      key,
      quota: Number(row.total),
      used: Math.max(0, Number(row.total) - remaining),
      remaining,
      unit: row.unit || ENTITLEMENT_QUOTAS[key]?.unit || "",
      expiresAt,
      sinceFetch,
      fetchedAt,
      source: "official",
    };
  }

  /**
   * 「这笔钱此刻从哪一层出」——面板标注的唯一依据。
   *
   * 官方顺序（help.aliyun.com/zh/model-studio/token-plan-harness-benefits 常见问题）：
   *   服务自带免费额度 → Token Plan 附赠权益 → 88 折按量后付费。
   *
   * 返回值：
   * - "service"：第一层还有余量，正在扣它（第二层此时纹丝不动是正常的）
   * - "equity"：第一层已耗尽/不存在，正在扣 Token Plan 权益
   * - "paid"：两层都耗尽，超出部分按 88 折走按量账单（真花钱）
   * - "unknown"：两层都没有可信数据（未配 Cookie / 从未拉取成功），不猜
   *
   * 第一层数据缺失时**不假定它还有余量**：宁可显示第二层，也不谎报「在扣免费额度」。
   */
  chargeLayer(key) {
    const service = this.serviceQuotaState(key);
    if (service && service.remaining > 0) return "service";
    const equity = this.equityState(key);
    if (equity && equity.remaining > 0) return "equity";
    if (service || equity) return "paid";
    return "unknown";
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
    const lastAt = this.#state.suppressedNotifiedAt;
    // 时钟回拨（now < lastAt，上次提示时间落在未来）：视为已过 1 小时，允许再提示。
    // 旧实现差值为负恒 < 1h → 耗尽警告被无限抑制，用户看不到「已暂停声明」的
    // 关键提示。方向上宁可多提示一次，也不能吞掉警告（2026-11-18 修复）。
    if (lastAt && now >= lastAt && now - lastAt < 3_600_000) return;
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
   * 只计权益次数，不累加 totalCalls —— 模型调用次数统一走 recordRequest()，
   * 由 session/event 观察器记账（2026-11-17：聊天走手工 provider 也能计数）。
   *
   * 记到哪一层（Q4，2026-11-25）：官方顺序是「服务自带免费额度 → Token Plan 权益 →
   * 按量后付费」，所以第一层还有余量时这笔用量落在第一层，第二层纹丝不动。
   * 一次调用可能跨越两层（第一层只剩 30 字符、本次 100 字符）→ 按剩余量拆分。
   * 第一层没有可信快照时全部记第二层（与 chargeLayer 的「不假定第一层有余量」同口径）。
   */
  record(type, count = 1) {
    if (!this.enabled) return null;
    this.#rollover();
    const key = TOOL_TO_EQUITY[String(type ?? "").replace(/[^a-z0-9_]/gi, "_").toLowerCase()];
    const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1;
    if (key) {
      const service = this.serviceQuotaState(key);
      const onService = service ? Math.min(n, service.remaining) : 0;
      if (onService > 0) this.#state.byService[key] = (this.#state.byService[key] ?? 0) + onService;
      const onEquity = n - onService;
      if (onEquity > 0) this.#state.byEquity[key] = (this.#state.byEquity[key] ?? 0) + onEquity;
    }
    this.#save();
    this.#logger?.debug?.(`qwen-token-plan-full: 权益调用 +${n}（${key ?? type ?? "unknown"}）`);
    return key ? this.equityState(key) : null;
  }

  /**
   * 记录一次模型 API 调用（totalCalls 的唯一入口）：session/event 观察器在
   * assistant/message 落定时调用；媒体生成任务成功也计一次。预算关闭时不计数。
   * 与权益计数解耦：聊天不必经过本插件的 adapter，面板也能看到真实调用数。
   */
  recordRequest(count = 1) {
    if (!this.enabled) return;
    this.#rollover();
    const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1;
    this.#state.totalCalls += n;
    this.#save();
    this.#logger?.debug?.(`qwen-token-plan-full: 模型调用 +${n}（本周期累计 ${this.#state.totalCalls}）`);
  }

  /**
   * 控制台权益明细（queryTokenPlanEquityInfo）：既是面板数据源，也是额度耗尽判定的
   * 首选依据（见 equityState）。拉取成功时同时记录当时的本地计数快照。
   */
  setEquities(list) {
    const rows = Array.isArray(list) ? list : null;
    if (rows) {
      this.#state.equities = rows;
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

  /**
   * 第一层「服务自带免费额度」快照（DescribeFqInstance 同源）。
   * 与 setEquities 分开：两层来自不同接口，任一层失败不该让另一层作废。
   */
  setServiceQuotas(list) {
    const rows = Array.isArray(list) ? list : null;
    if (rows) {
      this.#state.serviceQuotas = rows;
      this.#state.serviceQuotasFetchedAt = Date.now();
      // 基线取第一层自己的计数器（Q4）：拿 byEquity 当基线会让第一层增量恒为 0（高估免费额度）。
      this.#state.serviceQuotaUsedAtFetch = { ...this.#state.byService };
    } else {
      this.#state.serviceQuotasFetchedAt = this.#state.serviceQuotasFetchedAt || 0;
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
      // 时钟回拨（差值为负）同样判不新鲜，与 #officialRemaining 同口径。
      equitiesFresh: (() => {
        if (!this.#state.equitiesFetchedAt) return false;
        const age = Date.now() - this.#state.equitiesFetchedAt;
        return age >= 0 && age <= this.#equityFreshMs;
      })(),
      equitiesFreshMinutes: Math.round(this.#equityFreshMs / 60_000),
      // 第一层「服务自带免费额度」：面板与第二层并列显示。官方先扣这一层，
      // 只报第二层会让用户看着「20/20 满格」以为调用没走通（2026-11-23 实测教训）。
      // 含视频（第二层没有独立实例，但这一层有 10 秒试用）。
      serviceQuotas: (Array.isArray(this.#state.serviceQuotas) ? this.#state.serviceQuotas : [])
        .map((row) => this.serviceQuotaState(row.key))
        .filter(Boolean),
      serviceQuotasFetchedAt: this.#state.serviceQuotasFetchedAt || null,
      // 逐项「此刻在扣哪一层」：service / equity / paid / unknown。
      chargeLayers: Object.fromEntries(
        [...Object.keys(ENTITLEMENT_QUOTAS), "video_generation"].map((key) => [key, this.chargeLayer(key)]),
      ),
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
