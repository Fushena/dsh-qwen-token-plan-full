// 客户端面板冒烟测试：用最小 React 桩渲染 Entry，验证两个徽标各自打开对应面板，
// 权益行值 = 宿主 equityCounts（官方周期配额 − 本周期调用次数），耗尽行置灰。
// 运行：node test/client-smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// —— 最小 React 桩：函数组件即时执行，useState 从脚本化的 state 队列读取 ——
let stateQueue = [];
const React = {
  createElement: (type, props, ...children) => {
    if (typeof type === 'function') return type({ ...(props ?? {}), children: children.flat(Infinity) });
    return { type: String(type?.name ?? type), props: props ?? {}, children: children.flat(Infinity) };
  },
  Fragment: Symbol('Fragment'),
  useState: () => { const v = stateQueue.shift(); return [v, () => {}]; },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
};

let capturedFactory = null;
globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => { capturedFactory = factory; } },
  addEventListener: () => {}, removeEventListener: () => {},
  innerWidth: 1280, innerHeight: 800,
};
globalThis.document = undefined; // 无 DOM：面板走内联回退，createPortal 拿不到
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const navigatorStub = { language: 'zh-CN' };
new Function('window', 'document', 'navigator', 'fetch', 'setInterval', 'clearInterval', 'MutationObserver', 'setTimeout',
  source)(globalThis.window, undefined, navigatorStub, globalThis.fetch, () => 0, () => {}, undefined, () => 0);

const require = (name) => {
  if (name === 'react') return React;
  throw new Error(`unknown require: ${name}`);
};
const exports = capturedFactory(require);
assert.ok(typeof exports?.apply === 'function', 'client 导出 apply');

// —— 挂载：捕获 slot entry 组件 ——
let entry = null;
const slots = {
  inject: (name, fn) => { fn(); return () => {}; },
  register: (spec, comp) => { entry = comp; return () => {}; },
};
const ctx = { effect: (fn) => fn(), get: (k) => (k === 'slots' ? slots : undefined), logger: { warn: () => {} } };
exports.apply(ctx);
assert.ok(entry, '已注册徽标 entry');

const COUNTS = [
  { key: 'search_pro', quota: 100, used: 5, remaining: 95, unit: '次' },
  { key: 'vertical_search', quota: 100, used: 0, remaining: 100, unit: '次' },
  { key: 'webfetch', quota: 1000, used: 0, remaining: 1000, unit: '次' },
  { key: 'code_interpreter', quota: 100, used: 100, remaining: 0, unit: '次' },
  { key: 'tts', quota: 10000, used: 0, remaining: 10000, unit: '字符' },
  { key: 'asr', quota: 18000, used: 3600, remaining: 14400, unit: '秒' },
  { key: 'image_generation', quota: 20, used: 6, remaining: 14, unit: '张' },
];
// 第一层「服务自带免费额度」（官方先扣这一层）。数值刻意与第二层不同，
// 这样断言能证明两层各自渲染、没有把同一个数字画两遍。
const SERVICE = [
  { key: 'search_pro', quota: 200, used: 1, remaining: 199, unit: '次', expiresAt: 1796400000000 },
  { key: 'vertical_search', quota: 200, used: 0, remaining: 200, unit: '次', expiresAt: 1796400000000 },
  { key: 'webfetch', quota: 1000, used: 0, remaining: 1000, unit: '次', expiresAt: 1796400000000 },
  { key: 'code_interpreter', quota: 500, used: 0, remaining: 500, unit: '次', expiresAt: 1796227200000 },
  { key: 'tts', quota: 10000, used: 33, remaining: 9967, unit: '字符', expiresAt: 1796227200000 },
  { key: 'asr', quota: 36000, used: 0, remaining: 36000, unit: '秒', expiresAt: 1796227200000 },
  { key: 'image_generation', quota: 100, used: 1, remaining: 99, unit: '张', expiresAt: 1796227200000 },
  { key: 'video_generation', quota: 10, used: 0, remaining: 10, unit: '秒', expiresAt: 1796227200000 },
];
const STATUS = {
  enabled: true,
  tier: { specCode: 'standard', monthlyCredits: 45000, fiveHourCredits: 3000, planUsagePercent: 58, resetTime: 1795363200000, remainingDays: 19, source: 'gateway' },
  equityCounts: COUNTS,
  equities: null,
  serviceQuotas: SERVICE,
  serviceQuotasFetchedAt: Date.now(),
  // 宿主判定：七项里 code_interpreter 的第二层已耗尽且第一层也耗尽 → paid；
  // 其余项第一层还有余量 → service（官方先扣它，第二层满格属正常）。
  chargeLayers: {
    search_pro: 'service', vertical_search: 'service', webfetch: 'service',
    code_interpreter: 'paid', tts: 'service', asr: 'service',
    image_generation: 'service', video_generation: 'service',
  },
  chargeSources: {
    search_pro: 'service', vertical_search: 'service', webfetch: 'service',
    code_interpreter: 'paid', tts: 'service', asr: 'service',
    image_generation: 'service', video_generation: 'service',
  },
  caps: { specCode: 'standard' },
  usage: { totalCalls: 111, periodAnchor: 1795363200000 },
  paused: { any: true, reason: 'equity', exhausted: [{ key: 'code_interpreter', used: 100, quota: 100, unit: '次' }], until: 1795363200000 },
  provider: { id: 'qwen-token-plan-full', models: 13, catalogSource: 'live' },
  generatedAt: Date.now(),
};

function renderWith(panelMode, status = STATUS) {
  // Entry 的 useState 顺序：status, panel, anchor, mine
  stateQueue = [status, panelMode, null, true];
  return JSON.stringify(entry());
}

const planJson = renderWith('plan');
assert.ok(planJson.includes('套餐剩余'), 'plan 面板标题为「套餐剩余」');
assert.ok(planJson.includes('42.0%'), 'plan 面板显示剩余百分比（100-58）');
assert.ok(planJson.includes('standard'), 'plan 面板显示等级');
assert.ok(planJson.includes('qtpf-big'), 'plan 面板含剩余大数字');
assert.ok(planJson.includes('"aria-label":"套餐剩余"'), 'plan 面板 dialog 标签正确');
assert.ok(planJson.includes('18900'), 'plan 面板含折算剩余 Credits');
// 一键登录常驻：Cookie 有效（source=gateway）时按钮也在，说明行是常态提示。
assert.ok(planJson.includes('qtpf-login'), 'plan 面板常驻登录区块');
assert.ok(planJson.includes('🔑 一键登录'), 'Cookie 有效时登录按钮仍显示');
assert.ok(planJson.includes('登录完成即自动更新 Cookie'), '常态提示文案正确');

const budgetJson = renderWith('budget');
// 负向断言只看面板本体（徽标 title 悬浮说明仍保留额度摘要，不属于面板）。
const budgetPanel = budgetJson.slice(budgetJson.indexOf('qtpf-panel'));
assert.ok(budgetJson.includes('Token Plan 权益'), 'budget 面板标题为「Token Plan 权益」');
assert.ok(budgetJson.includes('套餐权益'), 'budget 面板含权益小节');
for (const name of ['联网搜索增强', '垂类搜索', '网页解析', '代码解释器', '语音合成', '语音识别', '图像生成', '视频生成']) {
  assert.ok(budgetJson.includes(name), `budget 面板含权益「${name}」`);
}
assert.ok(budgetJson.includes('95/100次'), '联网搜索增强：配额−调用次数 = 95/100');
assert.ok(budgetJson.includes('1000/1000次'), '网页解析未用 → 1000/1000');
assert.ok(budgetJson.includes('0/100次'), '代码解释器耗尽 → 0/100');
assert.ok(budgetJson.includes('4h/5h'), '语音识别：14400/18000 秒 → 4h/5h');
assert.ok(budgetJson.includes('14/20张'), '图像生成：14/20 张');
assert.ok(budgetJson.includes('1万/1万'), '语音合成：字符 → 万');
assert.ok(budgetJson.includes('✓ 包含'), '视频生成无周期配额 → 回退静态文案');
assert.ok(budgetJson.includes('qtpf-row exhausted'), '耗尽行带 exhausted 类（置灰）');
assert.ok(budgetJson.includes('部分权益额度耗尽'), '面板顶部显示耗尽警示');
assert.ok(!budgetPanel.includes('qtpf-actions'), '面板无按钮行（仿模型切换弹层）');
assert.ok(!budgetPanel.includes('刷新'), '面板不再有刷新按钮');
assert.ok(!budgetPanel.includes('关闭'), '面板不再有关闭按钮');
assert.ok(!budgetPanel.includes('周期次数上限'), 'budget 面板不含旧次数上限');
assert.ok(!budgetPanel.includes('qtpf-big'), 'budget 面板不含剩余大数字');

// 无 equityCounts（旧宿主/兜底）：回退静态月配额文案。
const legacy = structuredClone(STATUS);
delete legacy.equityCounts;
legacy.paused = { any: false, reason: null, exhausted: [], until: null };
const legacyJson = renderWith('budget', legacy);
assert.ok(legacyJson.includes('100 次/月'), '无计数时回退静态月配额');
assert.ok(!legacyJson.includes('95/100次'), '无计数时不显示计算值');

// lite 等级：8 项权益均不含，显示升级提示（断言只看面板本体；徽标 title 是计数摘要）。
const lite = structuredClone(STATUS);
lite.tier.specCode = 'lite';
const liteJson = renderWith('budget', lite);
const litePanel = liteJson.slice(liteJson.indexOf('qtpf-panel'));
assert.ok(liteJson.includes('Lite / Essential 套餐不含下列权益'), 'lite 等级显示升级提示');
assert.ok(!litePanel.includes('95/100次'), 'lite 面板不列权益配额');

// Cookie 失效（source=builtin）：登录按钮带失效提示。
const stale = structuredClone(STATUS);
stale.tier.source = 'builtin';
const staleJson = renderWith('plan', stale);
assert.ok(staleJson.includes('控制台 Cookie 已失效'), '兜底等级显示失效提示');
assert.ok(staleJson.includes('🔑 一键登录'), '失效时登录按钮可点');

// 登录会话进行中：显示等待文案 + 取消，不显示登录按钮。
const waitingStatus = structuredClone(STATUS);
waitingStatus.relogin = { state: 'waiting', startedAt: Date.now() };
const waitingJson = renderWith('plan', waitingStatus);
assert.ok(waitingJson.includes('等待登录完成'), 'waiting 显示等待文案');
assert.ok(waitingJson.includes('取消'), 'waiting 提供取消按钮');
assert.ok(!waitingJson.includes('🔑 一键登录'), 'waiting 时不显示登录按钮');

const closedJson = renderWith(null);
assert.ok(closedJson.includes('◔ 套餐剩余 42.0%'), '套餐徽标文案保留');
assert.ok(closedJson.includes('⚠ 权益'), '权益徽标显示「⚠ 权益」（STATUS.paused.any=true 时橙色告警）');
assert.ok(closedJson.includes('qtpf-badge paused'), '有权益耗尽时徽标带 paused 类（⚠ 橙色）');
assert.ok(!closedJson.includes('qtpf-panel'), '未点击时不渲染面板');

// 未耗尽时徽标回到 ⚡ 形态。
const calm = structuredClone(STATUS);
calm.paused = { any: false, reason: null, exhausted: [], until: null };
const calmJson = renderWith(null, calm);
assert.ok(calmJson.includes('⚡ 权益'), '未耗尽时徽标显示「⚡ 权益」');

// —— v0.5.0：每项权益的消耗来源标签 + 权益通道状态 ——
// 这是用户明确要的东西：余额之外还要看清「这笔钱从哪出」。
// 缺 Key 时必须如实说在花 Credits，不能因为权益满格就让人以为在省钱。
const noKey = structuredClone(STATUS);
noKey.equityChannels = Object.fromEntries(COUNTS.map((c) => [c.key, 'credits']));
// 宿主把「通道」与「扣减层」合成 chargeSources：走模型 API 时无论哪层有余额都花 Credits。
noKey.chargeSources = Object.fromEntries(Object.keys(noKey.chargeSources).map((k) => [k, 'credits']));
noKey.mcp = {
  enabled: true, reason: 'missing-key', keyPresent: false,
  host: 'https://dashscope.aliyuncs.com', credentialRef: 'BAILIAN_PAYG_API_KEY',
  servers: [{ service: 'TextGenerateImage', equityKeys: ['image_generation'], mounted: false }],
};
const noKeyJson = renderWith('budget', noKey);
assert.ok(noKeyJson.includes('qtpf-src credits'), '缺 Key 时每行标「Credits」来源');
assert.ok(!noKeyJson.includes('qtpf-src equity'), '缺 Key 时不得标绿「权益」');
assert.ok(noKeyJson.includes('未配置百炼按量付费 Key'), '缺 Key 时面板给出明确原因');
assert.ok(noKeyJson.includes('BAILIAN_PAYG_API_KEY'), '缺 Key 时告诉用户该配哪个凭据名');
assert.ok(noKeyJson.includes('现在每次调用都在花 Credits'), '缺 Key 时点明真实计费口径');

// MCP 连通：对应项标绿「权益」，未接通的项仍标「Credits」。
const connected = structuredClone(noKey);
connected.equityChannels = { ...connected.equityChannels, image_generation: 'equity', search_pro: 'equity' };
// 走 MCP 的两项：第一层还有余量 → service；其余仍走模型 API → credits。
connected.chargeSources = { ...connected.chargeSources, image_generation: 'service', search_pro: 'service' };
connected.mcp = {
  enabled: true, reason: 'mounted', keyPresent: true,
  host: 'https://dashscope.aliyuncs.com', credentialRef: 'BAILIAN_PAYG_API_KEY',
  servers: [
    { service: 'TextGenerateImage', equityKeys: ['image_generation'], mounted: true, state: 'connected' },
    { service: 'EnhancedSearch', equityKeys: ['search_pro'], mounted: true, state: 'connected' },
    { service: 'WebFetch', equityKeys: ['webfetch'], mounted: false, reason: '网页解析权益额度耗尽' },
  ],
};
const connectedJson = renderWith('budget', connected);
assert.ok(connectedJson.includes('qtpf-src service'), 'MCP 连通且第一层有余量的项标「服务额度」');
assert.ok(connectedJson.includes('qtpf-src credits'), '未接通的项仍标「Credits」');
assert.ok(connectedJson.includes('权益通道'), '面板含「权益通道」状态行');
assert.ok(connectedJson.includes('2/3'), '权益通道显示已连通数/总数');
assert.ok(connectedJson.includes('自动回落模型 API'), '有服务因额度耗尽摘除时说明已回落');
assert.ok(!connectedJson.includes('未配置百炼按量付费 Key'), '有 Key 时不再提示缺 Key');

// —— v0.6.0：两层额度并列 + 「当前扣减」标注 ——
// 用户 2026-11-23 明确要求：只报第二层会让人看着「20/20 满格」以为调用没走通，
// 实际钱扣在第一层「服务自带免费额度」。两层必须同时可见。
const layersJson = renderWith('budget');
const layersPanel = layersJson.slice(layersJson.indexOf('qtpf-panel'));
assert.ok(layersPanel.includes('服务自带免费额度'), '面板含第一层小节标题');
assert.ok(layersPanel.includes('Token Plan 附赠权益'), '面板含第二层小节标题');
assert.ok(layersPanel.indexOf('服务自带免费额度') < layersPanel.indexOf('Token Plan 附赠权益'), '第一层在第二层之前（抵扣顺序一致）');
// 两层各自的真实数字，证明不是把同一个值画两遍。
assert.ok(layersPanel.includes('99/100张'), '第一层图像 99/100（已扣 1）');
assert.ok(layersPanel.includes('14/20张'), '第二层图像 14/20（与第一层不同）');
assert.ok(layersPanel.includes('199/200次'), '第一层搜索 199/200');
assert.ok(layersPanel.includes('9967/1万字符'), '第一层语音合成 9967/1万字符');
assert.ok(layersPanel.includes('10h/10h'), '第一层语音识别 36000 秒 → 10h/10h');
assert.ok(layersPanel.includes('qtpf-src service'), '第一层有余量的项标「服务额度」');
assert.ok(layersPanel.includes('qtpf-src paid'), '两层都耗尽的项标「按量付费」');
assert.ok(layersPanel.includes('当前扣减'), '面板顶部有「当前扣减」提示行');
assert.ok(layersPanel.includes('官方先扣服务自带免费额度'), '点明抵扣顺序，解释第二层为何满格');
assert.ok(layersPanel.includes('服务额度到期'), '第一层标注自己的到期日（与订阅周期不同）');
assert.ok(layersPanel.includes('周期重置'), '第二层标注订阅周期重置日');
// 视频：第二层无独立实例（✓ 包含），但第一层有 10 秒试用，必须显示真实余量。
assert.ok(layersPanel.includes('10/10秒'), '视频第一层 10 秒试用按秒显示（不被抹成 0h）');
assert.ok(layersPanel.includes('✓ 包含'), '视频第二层仍回退静态文案');
// 标签只标真在扣的那一层：第一层在扣时，第二层不得也挂「服务额度」——
// 否则满格的套餐权益看着像正在被消耗，正是这一版要消除的误读。
const planSegment = layersPanel.slice(layersPanel.indexOf('Token Plan 附赠权益'));
assert.ok(!planSegment.includes('qtpf-src service'), '第一层在扣时第二层不挂「服务额度」标签');
assert.ok(planSegment.includes('qtpf-src paid'), '两层都耗尽的项仍在第二层标「按量付费」');

// 第一层耗尽 → 该行标「套餐权益」，顶部提示改为「现在扣套餐权益」。
// 第一层**不刷新**（CurrentCycle 与整个生命周期同长），所以用尽的行整行隐去，
// 不留「0/100」让人误以为还会回满。
const serviceOut = structuredClone(STATUS);
serviceOut.serviceQuotas = SERVICE.map((row) => ({ ...row, used: row.quota, remaining: 0 }));
serviceOut.chargeSources = Object.fromEntries(Object.keys(serviceOut.chargeSources).map((k) => [k, 'equity']));
const serviceOutJson = renderWith('budget', serviceOut);
const serviceOutPanel = serviceOutJson.slice(serviceOutJson.indexOf('qtpf-panel'));
assert.ok(serviceOutPanel.includes('qtpf-src equity'), '第一层耗尽后标「套餐权益」');
assert.ok(serviceOutPanel.includes('现在扣的是套餐附赠权益'), '提示改为正在扣第二层');
assert.ok(!serviceOutPanel.includes('官方先扣服务自带免费额度'), '第一层耗尽后不再说「先扣服务额度」');
assert.ok(!serviceOutPanel.includes('0/100张'), '第一层用尽的行不再显示（这一层不刷新）');
assert.ok(!serviceOutPanel.includes('服务自带免费额度'), '全部用尽时整个第一层小节隐去');
assert.ok(!serviceOutPanel.includes('服务自带额度暂不可用'), '用尽 ≠ 取数失败，不给重试提示');
assert.ok(serviceOutPanel.includes('14/20张'), '第一层隐去后第二层照常完整显示');

// 部分用尽：只隐去用尽的那几行，其余仍在第一层显示。
const servicePartial = structuredClone(STATUS);
servicePartial.serviceQuotas = SERVICE.map((row) => (
  row.key === 'image_generation' ? { ...row, used: row.quota, remaining: 0 } : row
));
servicePartial.chargeSources = { ...servicePartial.chargeSources, image_generation: 'equity' };
const partialJson = renderWith('budget', servicePartial);
const partialPanel = partialJson.slice(partialJson.indexOf('qtpf-panel'));
assert.ok(partialPanel.includes('服务自带免费额度'), '仍有余量时第一层小节保留');
assert.ok(!partialPanel.includes('0/100张'), '用尽的图像行隐去');
assert.ok(partialPanel.includes('199/200次'), '未用尽的搜索行仍在第一层');
const partialPlan = partialPanel.slice(partialPanel.indexOf('Token Plan 附赠权益'));
assert.ok(partialPlan.includes('qtpf-src equity'), '用尽项的扣减层落到第二层并标注');

// 第一层取数失败：不画空表，给可操作提示，第二层照常显示（能力没断）。
const noService = structuredClone(STATUS);
noService.serviceQuotas = [];
noService.serviceQuotasFetchedAt = null;
delete noService.chargeSources;
delete noService.chargeLayers;
const noServiceJson = renderWith('budget', noService);
const noServicePanel = noServiceJson.slice(noServiceJson.indexOf('qtpf-panel'));
assert.ok(noServicePanel.includes('服务自带额度暂不可用'), '第一层无数据时给出提示');
assert.ok(noServicePanel.includes('14/20张'), '第一层缺失时第二层仍完整显示');
assert.ok(!noServicePanel.includes('qtpf-src service'), '无第一层数据时不谎报在扣服务额度');
assert.ok(!noServicePanel.includes('当前扣减'), '两层都无判定依据时不显示扣减提示');

// 第一层已成功拉取但账号无试用项，或配置已关闭：隐去提示，不误报取数失败。
const emptyFetched = structuredClone(noService);
emptyFetched.serviceQuotasFetchedAt = Date.now();
const emptyFetchedPanel = renderWith('budget', emptyFetched);
assert.ok(!emptyFetchedPanel.slice(emptyFetchedPanel.indexOf('qtpf-panel')).includes('服务自带额度暂不可用'), '已成功拉取且为空时不报暂不可用');
const disabledService = structuredClone(noService);
disabledService.serviceQuotasEnabled = false;
const disabledPanel = renderWith('budget', disabledService);
assert.ok(!disabledPanel.slice(disabledPanel.indexOf('qtpf-panel')).includes('服务自带额度暂不可用'), '关闭第一层时不报暂不可用');

// 宿主没有 mcpManager：说明原因，而不是静默什么都不显示（兼容 enabled:false 与真实 mcp.status() 的 enabled:true）。
const noManager = structuredClone(STATUS);
noManager.mcp = { enabled: false, reason: 'no-manager', servers: [] };
const noManagerJson = renderWith('budget', noManager);
assert.ok(noManagerJson.includes('宿主未提供 MCP 服务'), '无 mcpManager 时面板说明原因');

const noManagerEnabled = structuredClone(STATUS);
noManagerEnabled.mcp = { enabled: true, reason: 'no-manager', keyPresent: false, servers: [] };
const noManagerEnabledJson = renderWith('budget', noManagerEnabled);
assert.ok(noManagerEnabledJson.includes('宿主未提供 MCP 服务'), 'enabled:true + reason:no-manager 也必须显示无 MCP 提示');
assert.ok(!noManagerEnabledJson.includes('未配置百炼按量付费 Key'), 'no-manager 不得被 missing-key 遮盖');

// 第一层快照过期（serviceQuotasFetchedAt > 0 但 serviceQuotasFresh === false）：应提示暂不可用而非静默消失。
const staleService = structuredClone(noService);
staleService.serviceQuotasFetchedAt = Date.now() - 3600_000;
staleService.serviceQuotasFresh = false;
const staleServicePanel = renderWith('budget', staleService);
assert.ok(staleServicePanel.slice(staleServicePanel.indexOf('qtpf-panel')).includes('服务自带额度暂不可用'), '快照过期时应提示暂不可用');

console.log('client-smoke: 全部断言通过 ✔');
