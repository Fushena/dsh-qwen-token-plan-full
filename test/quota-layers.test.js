// 两层额度与「当前扣减层」回归测试（v0.6.0，2026-11-23）。
//
// 为什么这些测试存在：官方抵扣顺序是「服务自带免费额度 → Token Plan 附赠权益 →
// 88 折按量后付费」。实测当天调了 MCP 生图/搜索/TTS，第一层各扣 1/1/33，
// 而第二层七项纹丝不动（20/20 满格）。旧面板只读第二层，用户据此判定「通道没生效」——
// 这是显示缺陷，不是计费缺陷。所以两层都要显示，且必须标出此刻在扣哪一层。
//
// 这里钉死三件事：
//   ① 第一层快照的口径（含到期、时钟回拨、本地增量）；
//   ② chargeLayer 的四态判定，尤其「第一层数据缺失时不假定它还有余量」；
//   ③ 第一层耗尽**不得**停用工具（能力没断，只是开始扣第二层）——这是最容易写错的地方。
//
// 全部离线：临时目录当 HOME（isolateHome），显式 filePath 落在临时目录内，
// 绝不触碰真实 ~/.dsh/qwen-token-plan-full.budget.json。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateHome } from "./home.mjs";
import { HarnessBudget } from "../lib/budget.js";
import { SERVICE_QUOTA_TYPES, SERVICE_QUOTA_COMMODITY } from "../lib/gateway.js";

const DAY_MS = 86_400_000;

function setup(t) {
  const { home, restore } = isolateHome("qtpf-layers-");
  t.after(restore);
  const filePath = path.join(home, ".dsh", "budget.json");
  const logger = { debug: () => {}, info: () => {}, warn: () => {} };
  const readState = () => JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { filePath, logger, readState };
}

/** 第一层原始行（宿主 fetchServiceQuotas 的输出形状）。 */
function serviceRow(key, available, total, unit = "次", expiresAt = Date.now() + 9 * DAY_MS) {
  return { key, available, total, unit, expiresAt };
}

test("L1 服务自带额度：模板名映射覆盖八个 MCP 服务，商品码是百炼自研工具", () => {
  // 名字来自控制台 freetier 实测，不是猜的。视频只在第一层有额度（第二层无独立实例）。
  assert.equal(SERVICE_QUOTA_COMMODITY, "sfm_plugin_public_cn");
  assert.deepEqual(SERVICE_QUOTA_TYPES.mcp_image_mode, { key: "image_generation", unit: "张" });
  assert.deepEqual(SERVICE_QUOTA_TYPES.mcp_input_chars_mode, { key: "tts", unit: "字符" });
  assert.deepEqual(SERVICE_QUOTA_TYPES.mcp_asr_mode, { key: "asr", unit: "秒" });
  assert.deepEqual(SERVICE_QUOTA_TYPES.mcp_video_mode, { key: "video_generation", unit: "秒" });
  assert.deepEqual(SERVICE_QUOTA_TYPES.tool_search_pro_count, { key: "search_pro", unit: "次" });
  assert.deepEqual(SERVICE_QUOTA_TYPES.tool_vertical_search_count, { key: "vertical_search", unit: "次" });
  assert.deepEqual(SERVICE_QUOTA_TYPES.tool_web_fetch_count, { key: "webfetch", unit: "次" });
  assert.deepEqual(SERVICE_QUOTA_TYPES.mcp_call_count_mode, { key: "code_interpreter", unit: "次" });
  assert.equal(Object.keys(SERVICE_QUOTA_TYPES).length, 8, "八个服务一个不多一个不少");
});

test("L2 第一层快照落盘并按「官方余额 − 本地增量」算剩余", (t) => {
  const { filePath, logger, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  a.setServiceQuotas([serviceRow("image_generation", 99, 100, "张")]);
  const disk = readState();
  assert.equal(disk.serviceQuotas[0].available, 99);
  assert.ok(disk.serviceQuotasFetchedAt > 0, "必须记快照时间，否则无法判新鲜度");
  assert.deepEqual(disk.serviceQuotaUsedAtFetch, {}, "快照要记下此刻的本地计数");
  const before = a.serviceQuotaState("image_generation");
  assert.equal(before.remaining, 99);
  assert.equal(before.quota, 100);
  assert.equal(before.used, 1);
  assert.equal(before.unit, "张");
  assert.equal(before.source, "official");
  // 快照之后又生成一张：官方还没回源，本地增量必须体现出来（宁可少算不多算）。
  a.record("image_generation", 1);
  const after = a.serviceQuotaState("image_generation");
  assert.equal(after.remaining, 98, "拉取后的本地调用要扣掉");
  assert.equal(after.sinceFetch, 1);
  assert.equal(after.used, 2);
});

test("L3 第一层已到期 / 快照过期 / 时钟回拨 → 不显示这一层（不猜数）", (t) => {
  const { filePath, logger, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  // 已过期的试用额度：不能把「其实要花钱了」显示成「还有免费额度」。
  a.setServiceQuotas([serviceRow("image_generation", 50, 100, "张", Date.now() - DAY_MS)]);
  assert.equal(a.serviceQuotaState("image_generation"), null, "已到期必须判不可用");
  assert.equal(a.chargeLayer("image_generation"), "equity", "第一层过期后按第二层判定");

  // 快照太旧（默认 15 分钟新鲜度）：退回不显示。
  a.setServiceQuotas([serviceRow("image_generation", 99, 100, "张")]);
  const state = readState();
  state.serviceQuotasFetchedAt = Date.now() - 60 * 60_000;
  fs.writeFileSync(filePath, JSON.stringify(state));
  const stale = new HarnessBudget({ filePath, logger });
  stale.setTierFallback("test");
  assert.equal(stale.serviceQuotaState("image_generation"), null, "超新鲜度阈值不得当真");

  // 时钟回拨：差值为负同样判不新鲜（与第二层同口径）。
  const back = readState();
  back.serviceQuotasFetchedAt = Date.now() + 60 * 60_000;
  fs.writeFileSync(filePath, JSON.stringify(back));
  const rewound = new HarnessBudget({ filePath, logger });
  rewound.setTierFallback("test");
  assert.equal(rewound.serviceQuotaState("image_generation"), null, "时钟回拨不得让快照永不过期");
});

test("L4 chargeLayer 四态：service → equity → paid → unknown", (t) => {
  const { filePath, logger } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  // 两层都没数据：standard 档位有本地配额兜底（20 张、已用 0），所以说的是「在扣套餐权益」，
  // 这不是谎报——那 20 张确实是套餐给的。
  assert.equal(a.chargeLayer("image_generation"), "equity");
  // 真正的 unknown：连档位都不知道（没有本地配额定义），两层皆无依据 → 不猜。
  // 用独立文件：同一 filePath 的新实例会从磁盘读到 a 刚落盘的兜底档位。
  const blind = new HarnessBudget({ filePath: `${filePath}.blind`, logger });
  assert.equal(blind.chargeLayer("image_generation"), "unknown");

  // 第一层有余量 → 正在扣它（第二层满格属正常，这正是当天实测的情形）。
  a.setServiceQuotas([serviceRow("image_generation", 99, 100, "张")]);
  a.setEquities([{ key: "image_generation", unit: "张", available: 20, total: 20 }]);
  assert.equal(a.chargeLayer("image_generation"), "service");
  assert.equal(a.equityState("image_generation").remaining, 20, "第二层此时确实没动");

  // 第一层耗尽 → 开始扣第二层。
  a.setServiceQuotas([serviceRow("image_generation", 0, 100, "张")]);
  assert.equal(a.chargeLayer("image_generation"), "equity");

  // 两层都耗尽 → 按量后付费（真花钱）。
  a.setEquities([{ key: "image_generation", unit: "张", available: 0, total: 20 }]);
  assert.equal(a.chargeLayer("image_generation"), "paid");
});

test("L5 第一层数据缺失时不假定它还有余量（宁可显示第二层，也不谎报免费）", (t) => {
  const { filePath, logger } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  // 只有第二层：第一层从未拉到（Cookie 失效 / 接口失败）。
  a.setEquities([{ key: "image_generation", unit: "张", available: 20, total: 20 }]);
  assert.equal(a.serviceQuotaState("image_generation"), null);
  assert.equal(a.chargeLayer("image_generation"), "equity", "不得报 service");
  // 第二层也耗尽且第一层未知 → paid（有依据说「要花钱了」）。
  a.setEquities([{ key: "image_generation", unit: "张", available: 0, total: 20 }]);
  assert.equal(a.chargeLayer("image_generation"), "paid");
});

test("L6 第一层耗尽不得停用工具：能力没断，只是开始扣第二层", (t) => {
  const { filePath, logger } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  a.setServiceQuotas([serviceRow("image_generation", 0, 100, "张"), serviceRow("tts", 0, 10000, "字符")]);
  a.setEquities([
    { key: "image_generation", unit: "张", available: 20, total: 20 },
    { key: "tts", unit: "字符", available: 10000, total: 10000 },
  ]);
  // 拿第一层去摘工具会把还能用的能力误停——这是本次最容易写错的地方。
  const { tools, dropped } = a.filterTools(["image_generation", "tts"]);
  assert.deepEqual(tools, ["image_generation", "tts"], "第一层耗尽不影响可用性");
  assert.deepEqual(dropped, []);
  assert.equal(a.status().paused.any, false);
  // 只有第二层也耗尽才停用。
  a.setEquities([{ key: "image_generation", unit: "张", available: 0, total: 20 }]);
  const after = a.filterTools(["image_generation"]);
  assert.deepEqual(after.tools, []);
  assert.equal(after.dropped[0].key, "image_generation");
});

test("L7 视频只在第一层有额度：第二层无实例也要能判定扣减层", (t) => {
  const { filePath, logger } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  a.setServiceQuotas([serviceRow("video_generation", 10, 10, "秒")]);
  const video = a.serviceQuotaState("video_generation");
  assert.equal(video.remaining, 10);
  assert.equal(video.unit, "秒");
  assert.equal(a.chargeLayer("video_generation"), "service");
  // 第二层没有 video_generation 这个权益键，equityState 必须是 null（不能凭空造）。
  assert.equal(a.equityState("video_generation"), null);
  const status = a.status();
  assert.ok(status.serviceQuotas.some((row) => row.key === "video_generation"), "面板第一层含视频");
  assert.ok(!status.equityCounts.some((row) => row.key === "video_generation"), "面板第二层不含视频");
  assert.equal(status.chargeLayers.video_generation, "service");
});

test("L8 status 同时输出两层与逐项扣减层", (t) => {
  const { filePath, logger } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  a.setServiceQuotas([serviceRow("image_generation", 99, 100, "张"), serviceRow("search_pro", 199, 200)]);
  a.setEquities([
    { key: "image_generation", unit: "张", available: 20, total: 20 },
    { key: "search_pro", unit: "次", available: 100, total: 100 },
  ]);
  const status = a.status();
  assert.equal(status.serviceQuotas.length, 2);
  assert.equal(status.equityCounts.length, 7, "第二层恒列七项（含未拉到的项按本地兜底）");
  assert.ok(status.serviceQuotasFetchedAt > 0);
  assert.equal(status.chargeLayers.image_generation, "service");
  assert.equal(status.chargeLayers.search_pro, "service");
  assert.equal(Object.keys(status.chargeLayers).length, 8, "七项权益 + 视频");
});

test("L9 跨实例合并：两层各自比新鲜度，第一层不随订阅周期清零", async (t) => {
  const { filePath, logger, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  // a 先拉到两层。
  a.setServiceQuotas([serviceRow("image_generation", 99, 100, "张")]);
  a.setEquities([{ key: "image_generation", unit: "张", available: 20, total: 20 }]);
  // b 模拟热重载后的新实例：构造时读盘（拿到 a 的快照），随后只拉到第二层。
  // 隔 2ms 再拉：快照新鲜度是毫秒级严格大于，同毫秒平手时按设计保留本实例。
  await new Promise((resolve) => setTimeout(resolve, 2));
  const b = new HarnessBudget({ filePath, logger });
  b.setEquities([{ key: "image_generation", unit: "张", available: 19, total: 20 }]);
  const disk = readState();
  assert.equal(disk.serviceQuotas?.[0]?.available, 99, "第一层快照不得被另一实例吞掉");
  assert.equal(disk.equities[0].available, 19, "第二层取更新的那份");

  // 订阅周期翻页：第二层清零，第一层是账号级试用额度，必须留着。
  const rolled = readState();
  rolled.periodAnchor = Date.now() - DAY_MS;
  fs.writeFileSync(filePath, JSON.stringify(rolled));
  const c = new HarnessBudget({ filePath, logger });
  c.setTierFallback("test");
  c.recordRequest(); // 触发 rollover + 落盘
  const after = readState();
  assert.deepEqual(after.byEquity, {}, "第二层本地计数随周期清零");
  assert.equal(after.serviceQuotas?.[0]?.available, 99, "第一层跨周期保留（试用额度不按月发放）");
});

test("L10 第一层还在扣时，第二层不得虚扣（Q4：共用计数器会把免费用量记到套餐头上）", (t) => {
  const { filePath, logger, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  // 2026-11-25 真机快照形状：第一层图像 99/100 还有余量，第二层 20/20 满格。
  a.setServiceQuotas([serviceRow("image_generation", 99, 100, "张"), serviceRow("tts", 9512, 10000, "字符")]);
  a.setEquities([
    { key: "image_generation", unit: "张", available: 20, total: 20 },
    { key: "tts", unit: "字符", available: 10000, total: 10000 },
  ]);
  // 第一层扣 20 张：第二层此刻确实一分没动，remaining 必须还是 20。
  for (let i = 0; i < 20; i += 1) a.record("image_generation", 1);
  const equity = a.equityState("image_generation");
  assert.equal(equity.remaining, 20, "第一层的消耗不得记到第二层头上");
  assert.equal(equity.used, 0);
  assert.equal(equity.sinceFetch, 0);
  const service = a.serviceQuotaState("image_generation");
  assert.equal(service.remaining, 79, "第一层要如实扣掉这 20 张");
  assert.equal(service.sinceFetch, 20);
  // 按字符计的第一层同理（TTS 一次 4756 字符 ×2 = 第一层 9512 刚好扣完）。
  a.record("tts", 4756);
  a.record("tts", 4756);
  assert.equal(a.equityState("tts").remaining, 10000, "字符权益同样不得虚扣");
  assert.equal(a.serviceQuotaState("tts").remaining, 0);
  assert.equal(a.chargeLayer("tts"), "equity", "第一层扣完才开始扣第二层");
  // 第一层扣完之后，后续调用才真正落到第二层（这里把第一层剩下的 79 张用光）。
  a.setServiceQuotas([serviceRow("image_generation", 0, 100, "张"), serviceRow("tts", 9512, 10000, "字符")]);
  a.record("image_generation", 1);
  assert.equal(a.equityState("image_generation").remaining, 19);
  assert.equal(a.serviceQuotaState("image_generation").remaining, 0, "第一层不再继续扣");
  const disk = readState();
  assert.equal(disk.byEquity.image_generation, 1, "第二层计数器只记真正扣到第二层的量");
  assert.equal(disk.byService.image_generation, 20, "第一层计数器独立记账并落盘");
  assert.equal(disk.byService.tts, 9512);
});

test("L11 一次调用跨越两层：按第一层剩余量拆分，溢出的部分才记第二层（Q4）", (t) => {
  const { filePath, logger, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  // 第一层只剩 30 字符，本次合成 100 字符：官方会先扣光 30，再扣第二层 70。
  a.setServiceQuotas([serviceRow("tts", 30, 10000, "字符")]);
  a.setEquities([{ key: "tts", unit: "字符", available: 10000, total: 10000 }]);
  a.record("tts", 100);
  assert.equal(a.serviceQuotaState("tts").remaining, 0, "第一层被扣光");
  assert.equal(a.equityState("tts").remaining, 9930, "只有溢出的 70 字符记到第二层");
  const disk = readState();
  assert.equal(disk.byService.tts, 30);
  assert.equal(disk.byEquity.tts, 70);
});

test("L12 订阅周期翻页：第一层本地计数是账号级，不得跟着第二层一起清零（Q4）", (t) => {
  const { filePath, logger, readState } = setup(t);
  const a = new HarnessBudget({ filePath, logger });
  a.setTierFallback("test");
  a.setServiceQuotas([serviceRow("image_generation", 99, 100, "张")]);
  a.setEquities([{ key: "image_generation", unit: "张", available: 20, total: 20 }]);
  a.record("image_generation", 3);
  assert.equal(readState().byService.image_generation, 3);
  // 周期锚点推到过去 → 下一次记账触发 rollover。
  const rolled = readState();
  rolled.periodAnchor = Date.now() - DAY_MS;
  fs.writeFileSync(filePath, JSON.stringify(rolled));
  const c = new HarnessBudget({ filePath, logger });
  c.setTierFallback("test");
  c.recordRequest();
  const after = readState();
  assert.deepEqual(after.byEquity, {}, "第二层随周期清零");
  assert.equal(after.byService.image_generation, 3, "第一层是账号级试用额度，跨周期保留");
});
