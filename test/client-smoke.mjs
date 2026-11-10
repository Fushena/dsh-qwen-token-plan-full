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
const STATUS = {
  enabled: true,
  tier: { specCode: 'standard', monthlyCredits: 45000, fiveHourCredits: 3000, planUsagePercent: 58, resetTime: 1795363200000, remainingDays: 19, source: 'gateway' },
  equityCounts: COUNTS,
  equities: null,
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

console.log('client-smoke: 全部断言通过 ✔');
