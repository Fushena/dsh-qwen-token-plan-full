// 记账合并与时钟回拨回归测试（2026-11-18）。
//
// 为什么这些测试存在：千问 Token Plan 权益耗尽后上游不自动停，超出部分按目录价
// 88 折后付费。预算模块的唯一职责是「宁可少算余额，绝不多算」——多算就会继续
// 声明已耗尽的权益工具，用户被真金白银扣钱。
//
// 缺陷 A：#save 整份内存快照 rename 覆盖磁盘，双开/热重载并存实例互相吞计数
//         （实测两实例共 3 次调用落盘 totalCalls=1）→ 余额高估 → 套餐外后付费。
// 缺陷 B：时钟回拨后 Date.now() - fetchedAt 为负，恒不大于新鲜度阈值 →
//         官网快照永不过期（实测回拨 1 小时仍判 official 新鲜）。
//
// 全部离线：临时目录当 HOME（isolateHome），显式 filePath 落在临时目录内，
// 绝不触碰真实 ~/.dsh/qwen-token-plan-full.budget.json；结束 rmSync 清理。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateHome } from "./home.mjs";
import { HarnessBudget } from "../lib/budget.js";

const DAY_MS = 86_400_000;

/** 每个用例独立的临时 HOME + 状态文件路径 + 日志收集器。 */
function setup(t, name = "budget.json") {
  const { home, restore } = isolateHome("qtpf-merge-");
  t.after(restore); // 结束必须清理临时目录
  const filePath = path.join(home, ".dsh", name);
  const warns = [];
  const infos = [];
  const logger = {
    debug: () => {},
    info: (m) => infos.push(m instanceof Error ? m.message : String(m)),
    warn: (m) => warns.push(m instanceof Error ? m.message : String(m)),
  };
  const writeState = (obj) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(obj));
  };
  const readState = () => JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { home, filePath, logger, warns, infos, writeState, readState };
}

/** 网关等级信息（standard 有本地配额定义，便于断言 local 兜底口径）。 */
function tier(now, resetTime = now + 20 * DAY_MS) {
  return {
    specCode: "standard",
    monthlyCredits: 45000,
    fiveHourCredits: 3000,
    resetTime,
    source: "gateway",
    fetchedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 缺陷 A：跨实例整份覆写
// ---------------------------------------------------------------------------

test("A1 跨实例交替 recordRequest：落盘 totalCalls 等于真实总次数", (t) => {
  const { filePath, logger, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  const b = new HarnessBudget({ filePath, logger });
  // 双开 DSH / 热重载新旧并存：两个实例交替记账，共 3 次真实调用。
  a.recordRequest();
  b.recordRequest();
  a.recordRequest();
  assert.equal(readState().totalCalls, 3, "整份覆写会把计数吞成 1~2");
  // 最后落盘的实例内存应与磁盘一致。
  assert.equal(a.status().usage.totalCalls, 3);
  // 再记一次：后落盘实例应把磁盘现值合并进来，而不是用自己的旧快照盖回去。
  b.recordRequest();
  assert.equal(readState().totalCalls, 4);
  assert.equal(b.status().usage.totalCalls, 4);
  // tmp 文件不得残留（pid 后缀之外还要防同进程撞车）。
  assert.ok(!fs.readdirSync(path.dirname(filePath)).some((f) => f.includes(".tmp-")));
});

test("A2 跨实例交替 record：byEquity 按增量累加，不互吞", (t) => {
  const { filePath, logger, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  const b = new HarnessBudget({ filePath, logger });
  a.record("web_search"); // search_pro +1
  b.record("web_search"); // search_pro +1
  a.record("web_search", 2); // search_pro +2
  b.record("web_search"); // search_pro +1 → 共 5
  a.record("image_generation"); // image_generation +1
  b.record("image_generation"); // image_generation +1 → 共 2
  const disk = readState();
  assert.equal(disk.byEquity.search_pro, 5);
  assert.equal(disk.byEquity.image_generation, 2);
});

test("A2b 权益键本身可作 record 输入：tts/asr 没有内置工具类型，只能走这条路", (t) => {
  // MCP 通道的 guard 直接按权益键记账（lib/mcp-equity.js）。tts/asr 在
  // TOOL_TO_EQUITY 里若没有自映射，record 查不到 key 就静默丢弃，面板永远显示 0。
  const { filePath, logger, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  // 新实例还没有档位（specCode 未知）→ equityState 返回 null，但**计数必须照记**。
  a.record("tts", 12);
  a.record("asr", 30);
  // 其余五项权益键同样要能直接记账（guard 对七个服务一视同仁）。
  a.record("search_pro");
  a.record("vertical_search");
  a.record("webfetch");
  a.record("code_interpreter");
  a.record("image_generation");
  const disk = readState();
  assert.equal(disk.byEquity.tts, 12, "tts 漏映射会被静默丢弃");
  assert.equal(disk.byEquity.asr, 30, "asr 漏映射会被静默丢弃");
  assert.equal(disk.byEquity.search_pro, 1);
  assert.equal(disk.byEquity.vertical_search, 1);
  assert.equal(disk.byEquity.webfetch, 1);
  assert.equal(disk.byEquity.code_interpreter, 1);
  assert.equal(disk.byEquity.image_generation, 1);
  // 内置工具类型这条老路必须仍然好使（不能因为加自映射而回归）。
  a.record("web_search");
  assert.equal(readState().byEquity.search_pro, 2);
  // 未知类型仍然不计数（不凭空造权益键）。
  a.record("no_such_thing");
  assert.equal(readState().byEquity.no_such_thing, undefined);
  // 档位确定后，这两项要能正常出现在面板状态里。
  a.setTierFallback("test");
  assert.equal(a.equityState("tts")?.used, 12);
  assert.equal(a.equityState("asr")?.used, 30);
});

test("A3 周期边界：磁盘已滚入新周期，本实例旧周期计数不得覆写回去", (t) => {
  const { filePath, logger, writeState, readState } = setup(t);
  const now = Date.now();
  // 本实例加载时还停在旧周期（锚点已过期，计数 90）。
  writeState({
    periodAnchor: now - 1000,
    totalCalls: 90,
    byEquity: { search_pro: 90 },
    tier: tier(now, 0),
  });
  const a = new HarnessBudget({ filePath, logger });
  // 另一实例已结算旧周期并滚入新周期（锚点在未来，新周期计数 7）。
  const newAnchor = now + 20 * DAY_MS;
  writeState({
    periodAnchor: newAnchor,
    totalCalls: 95,
    byEquity: { search_pro: 7 },
    tier: tier(now, newAnchor),
  });
  // setEquities(null) 是不触发 rollover 的落盘路径：本实例内存锚点仍是旧的。
  a.setEquities(null);
  const disk = readState();
  assert.equal(disk.periodAnchor, newAnchor, "不得把旧周期锚点写回去");
  assert.equal(disk.byEquity.search_pro, 7, "旧周期 90 次不属于新周期，不可比大小");
  assert.equal(disk.totalCalls, 95, "totalCalls 是跨周期累计，无新增则保持磁盘现值");
});

test("A3b 周期边界：本实例已滚入新周期，磁盘旧周期计数不得 max 进来", (t) => {
  const { filePath, logger, writeState, readState } = setup(t);
  const now = Date.now();
  const newAnchor = now + 20 * DAY_MS;
  writeState({
    periodAnchor: now - 1000, // 已过期
    totalCalls: 90,
    byEquity: { search_pro: 90 },
    tier: tier(now, newAnchor),
  });
  const a = new HarnessBudget({ filePath, logger });
  a.record("web_search"); // rollover 清零旧计数 → 新周期 sp=1 → 落盘
  const disk = readState();
  assert.equal(disk.periodAnchor, newAnchor);
  // 若合并语义是「无脑取较大值」，旧周期 90 会被带进新周期（91）→ 错乱。
  assert.equal(disk.byEquity.search_pro, 1);
});

test("A4 同周期官网快照：整体取 equitiesFetchedAt 较新的一份", (t) => {
  const { filePath, logger, writeState, readState } = setup(t);
  const now = Date.now();
  writeState({
    periodAnchor: now + 20 * DAY_MS,
    totalCalls: 0,
    byEquity: {},
    tier: tier(now),
    equities: [{ key: "search_pro", unit: "次", available: 50, total: 100 }],
    equitiesFetchedAt: now - 60_000,
    equityUsedAtFetch: {},
  });
  const a = new HarnessBudget({ filePath, logger });
  const b = new HarnessBudget({ filePath, logger });
  // b 拉到更新的官网余额（40）；a 拉取失败保留旧快照（50）。
  b.setEquities([{ key: "search_pro", unit: "次", available: 40, total: 100 }]);
  a.setEquities(null);
  const disk = readState();
  assert.equal(disk.equities[0].available, 40, "旧快照不得盖掉磁盘上更新的快照");
  assert.ok(disk.equitiesFetchedAt >= now);
  // 快照三件套（equities/fetchedAt/usedAtFetch）必须整体取同一份，
  // 合并后本实例内存也应采纳磁盘的较新快照。
  const s = a.equityState("search_pro");
  assert.equal(s.source, "official");
  assert.equal(s.remaining, 40);
});

test("A5 落盘时磁盘损坏：.bak 恢复 + .corrupt 隔离 + warning，绝不静默归零", (t) => {
  const { filePath, logger, warns, writeState, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.recordRequest();
  a.recordRequest(); // 磁盘 totalCalls=2，.bak=1（上一份好文件）
  fs.writeFileSync(filePath, "{broken json");
  a.recordRequest(); // 内存 3；磁盘现值读坏 → 必须走恢复路径而不是当成 0
  // 本实例内存保有完整历史（3），.bak 只有 1：合并绝不能把计数归零或丢掉本实例历史。
  assert.equal(readState().totalCalls, 3);
  assert.ok(
    warns.some((w) => w.includes("损坏") || w.includes("备份")),
    "坏读必须明确 warning，不能静默",
  );
  assert.ok(
    fs.readdirSync(path.dirname(filePath)).some((f) => f.startsWith("budget.json.corrupt-")),
    "坏文件应挪成 .corrupt-<ts> 留证",
  );
  // 第二段：.bak 里含有别的实例写入的更高计数（6），主文件损坏。
  // 合并必须从 .bak 恢复并叠加本实例增量（6+1=7），而不是静默当成 0 只写自己的 4。
  const anchor = readState().periodAnchor;
  writeState({ periodAnchor: anchor, totalCalls: 7, byEquity: {} }); // 先让主文件有效
  fs.writeFileSync(`${filePath}.bak`, JSON.stringify({ periodAnchor: anchor, totalCalls: 6, byEquity: {} }));
  fs.writeFileSync(filePath, "{broken again");
  a.recordRequest(); // 内存 4，增量 1
  assert.equal(readState().totalCalls, 7, "磁盘坏读必须走 .bak 恢复，绝不能当成 0");
});

test("A6 双方都是估算锚点（无网关 resetTime）且相差几秒：视为同周期，增量合并", (t) => {
  const { filePath, logger, writeState, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.record("web_search"); // 本实例 rollover 兜底锚点 = now+30d，sp=1
  const disk0 = readState();
  // 另一实例的兜底锚点晚 5 秒（构造时刻不同）：这不是真正的周期切换，
  // 若按「锚点不同即取新周期」处理会把双方计数互吞。
  writeState({
    ...disk0,
    periodAnchor: disk0.periodAnchor + 5000,
    totalCalls: 6,
    byEquity: { search_pro: 6 },
  });
  a.record("web_search"); // 本实例 sp=2，增量 1 → 合并后 6+1=7
  const disk = readState();
  assert.equal(disk.byEquity.search_pro, 7);
  assert.equal(disk.totalCalls, 6);
  assert.equal(disk.periodAnchor, disk0.periodAnchor + 5000);
});

// ---------------------------------------------------------------------------
// 缺陷 B：时钟回拨
// ---------------------------------------------------------------------------

test("B1 时钟回拨：fetchedAt 在未来 → 官网快照不可信，退回 local", (t) => {
  const { filePath, logger, writeState } = setup(t);
  const now = Date.now();
  // 等价于「快照拉取后本机时钟回拨 1 小时」：fetchedAt 落在未来。
  writeState({
    periodAnchor: now + 20 * DAY_MS,
    totalCalls: 3,
    byEquity: { search_pro: 3 },
    tier: tier(now),
    equities: [{ key: "search_pro", unit: "次", available: 80, total: 100 }],
    equitiesFetchedAt: now + 3_600_000,
    equityUsedAtFetch: { search_pro: 3 },
  });
  const a = new HarnessBudget({ filePath, logger });
  const s = a.equityState("search_pro");
  assert.equal(s.source, "local", "回拨后差值为负，快照必须判为不可信");
  assert.equal(s.remaining, 97); // 本地口径：100 - 3
  assert.equal(a.status().equitiesFresh, false, "status 的新鲜度判定同病同修");
});

test("B1-guard 正常时钟：新鲜度行为不变（护栏）", (t) => {
  const { filePath, logger, writeState } = setup(t);
  const now = Date.now();
  const seed = (fetchedAt) => ({
    periodAnchor: now + 20 * DAY_MS,
    totalCalls: 3,
    byEquity: { search_pro: 3 },
    tier: tier(now),
    equities: [{ key: "search_pro", unit: "次", available: 80, total: 100 }],
    equitiesFetchedAt: fetchedAt,
    equityUsedAtFetch: { search_pro: 3 },
  });
  // 1 分钟前拉取：新鲜，走 official。
  writeState(seed(now - 60_000));
  const fresh = new HarnessBudget({ filePath, logger });
  assert.equal(fresh.equityState("search_pro").source, "official");
  assert.equal(fresh.equityState("search_pro").remaining, 80);
  assert.equal(fresh.status().equitiesFresh, true);
  // 15 分钟内（留 30s 余量防执行耗时越过边界）：仍新鲜。
  // 精确的 15min 边界不钉死：实现里两次 Date.now() 相隔几 ms 就会让
  // 「恰好 15min」在 <= 与 > 之间漂移，那是正常时钟下的既有行为，不属于本修复。
  writeState(seed(now - 15 * 60_000 + 30_000));
  const near = new HarnessBudget({ filePath, logger });
  assert.equal(near.equityState("search_pro").source, "official");
  // 明显超过 15 分钟：过期，退回 local。
  writeState(seed(now - 16 * 60_000));
  const stale = new HarnessBudget({ filePath, logger });
  assert.equal(stale.equityState("search_pro").source, "local");
  assert.equal(stale.status().equitiesFresh, false);
});

test("B2 时钟回拨：suppressedNotifiedAt 在未来 → 每小时提示不被无限抑制", (t) => {
  const { filePath, logger, infos, writeState } = setup(t);
  const now = Date.now();
  writeState({
    periodAnchor: now + 20 * DAY_MS,
    totalCalls: 0,
    byEquity: {},
    tier: tier(now),
    suppressedNotifiedAt: now + 3_600_000, // 回拨后落在未来
  });
  const a = new HarnessBudget({ filePath, logger });
  a.noteSuppression({
    dropped: [{ key: "search_pro", used: 100, quota: 100, source: "local" }],
    until: now + 20 * DAY_MS,
  });
  // 差值为负应视为「已过 1 小时」：宁可多提示，不能无限吞掉耗尽警告。
  assert.equal(infos.length, 1);
});

test("B2-guard 正常时钟：1 小时内不重复提示（护栏）", (t) => {
  const { filePath, logger, infos, writeState } = setup(t);
  const now = Date.now();
  writeState({
    periodAnchor: now + 20 * DAY_MS,
    totalCalls: 0,
    byEquity: {},
    tier: tier(now),
    suppressedNotifiedAt: now - 1000, // 刚提示过
  });
  const a = new HarnessBudget({ filePath, logger });
  a.noteSuppression({ dropped: [], until: now + 20 * DAY_MS });
  assert.equal(infos.length, 0);
});

// ---------------------------------------------------------------------------
// 2026-11-25 高危回归：估算 +30d 锚点不得拒绝真实网关 setTier()；第一层三元组原子合并
// ---------------------------------------------------------------------------

test("A7 估算 +30d 锚点不得拒绝更近的真实网关 setTier()（校准锚点并保留档位与历史计数）", (t) => {
  const { filePath, logger, readState } = setup(t);
  const now = Date.now();
  const a = new HarnessBudget({ filePath, logger });
  // 首次无 Cookie 兜底写入估算锚点（now + 30d）与 standard 兜底档位，并记录 2 次调用。
  a.setTierFallback("missing cookie");
  a.record("web_search", 2);
  const before = readState();
  assert.equal(before.tier.source, "builtin");
  assert.equal(before.tier.specCode, "standard");
  assert.ok(before.periodAnchor > now + 25 * DAY_MS, "兜底应写入估算 +30d 锚点");

  // 用户随后登录，网关返回真实 Pro 档位与更近的重置日（now + 10d）。
  const realReset = now + 10 * DAY_MS;
  a.setTier({
    specCode: "pro",
    usage: { per1MonthPercentage: 0.125, per1MonthResetTime: realReset },
    subscription: { remainingDays: 10 },
    fetchedAt: now,
  });
  const after = readState();
  assert.equal(after.periodAnchor, realReset, "真实网关 resetTime 不得被更大的估算 +30d 锚点覆盖回退");
  assert.equal(after.periodAnchorSource, "gateway");
  assert.equal(after.tier.source, "gateway", "真实网关 tier 不得被回滚成 builtin 兜底");
  assert.equal(after.tier.specCode, "pro", "Pro 档位必须落盘生效");
  assert.equal(after.byEquity.search_pro, 2, "校准同周期锚点时须保留先前已记用量");
  assert.equal(a.status().tier.specCode, "pro");
});

test("A8 第一层 serviceQuotas 三元组在跨周期合并时必须原子一致（不拆散、不回滚）", (t) => {
  const { filePath, logger, writeState, readState } = setup(t);
  const now = Date.now();
  const oldAnchor = now - 1000;
  const newAnchor = now + 20 * DAY_MS;
  const expiresAt = now + 30 * DAY_MS;

  // 场景 1（diskNewer）：本实例在旧周期，但持有更新的第一层快照（available=10, fetchedAt=now+5000, used=90）；
  // 磁盘已滚入新周期，但第一层快照更旧（available=80, fetchedAt=now-5000, used=20）。
  writeState({
    periodAnchor: oldAnchor,
    periodAnchorSource: "gateway",
    totalCalls: 5,
    byEquity: { search_pro: 5 },
    byService: { image_generation: 90 },
    tier: tier(now - 5000, oldAnchor),
    serviceQuotas: [{ key: "image_generation", unit: "张", available: 10, total: 100, expiresAt }],
    serviceQuotasFetchedAt: now + 5000,
    serviceQuotaUsedAtFetch: { image_generation: 90 },
  });
  const a = new HarnessBudget({ filePath, logger });
  writeState({
    periodAnchor: newAnchor,
    periodAnchorSource: "gateway",
    totalCalls: 6,
    byEquity: { search_pro: 1 },
    byService: { image_generation: 20 },
    tier: tier(now, newAnchor),
    serviceQuotas: [{ key: "image_generation", unit: "张", available: 80, total: 100, expiresAt }],
    serviceQuotasFetchedAt: now - 5000,
    serviceQuotaUsedAtFetch: { image_generation: 20 },
  });
  a.setEquities(null); // 走 diskNewer 合并分支
  const d1 = readState();
  assert.equal(d1.serviceQuotas[0].available, 10, "diskNewer 不得把旧 available(80) 与新 usedAtFetch(90) 拆散混配");
  assert.equal(d1.serviceQuotasFetchedAt, now + 5000);
  assert.equal(d1.serviceQuotaUsedAtFetch.image_generation, 90);

  // 场景 2（mine rolled over）：本实例滚入新周期，磁盘还停在旧周期但第一层快照更新 → 不得把磁盘较新第一层覆盖回旧值。
  const filePath2 = `${filePath}.r2`;
  fs.writeFileSync(filePath2, JSON.stringify({
    periodAnchor: oldAnchor,
    periodAnchorSource: "gateway",
    totalCalls: 10,
    byEquity: { search_pro: 10 },
    byService: { image_generation: 5 },
    tier: tier(now, newAnchor),
    serviceQuotas: [{ key: "image_generation", unit: "张", available: 95, total: 100, expiresAt }],
    serviceQuotasFetchedAt: now - 10_000,
    serviceQuotaUsedAtFetch: { image_generation: 5 },
  }));
  const b = new HarnessBudget({ filePath: filePath2, logger });
  // 另一实例在旧周期写入了更新的第一层快照（available=70, fetchedAt=now-1000, used=30）。
  fs.writeFileSync(filePath2, JSON.stringify({
    periodAnchor: oldAnchor,
    periodAnchorSource: "gateway",
    totalCalls: 10,
    byEquity: { search_pro: 10 },
    byService: { image_generation: 30 },
    tier: tier(now, newAnchor),
    serviceQuotas: [{ key: "image_generation", unit: "张", available: 70, total: 100, expiresAt }],
    serviceQuotasFetchedAt: now - 1000,
    serviceQuotaUsedAtFetch: { image_generation: 30 },
  }));
  b.record("web_search"); // b 滚入 newAnchor，走 else 分支
  const d2 = JSON.parse(fs.readFileSync(filePath2, "utf8"));
  assert.equal(d2.periodAnchor, newAnchor);
  assert.equal(d2.serviceQuotas[0].available, 70, "本实例滚周期时不得把磁盘上更新的第一层快照覆盖回旧值");
  assert.equal(d2.serviceQuotasFetchedAt, now - 1000);
  assert.equal(d2.serviceQuotaUsedAtFetch.image_generation, 30);
});
