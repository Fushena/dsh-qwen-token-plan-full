import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCookieFailure, cookieFailureKind, updateEnvFile, ReloginFlow } from '../lib/relogin.js';
import { Config } from '../index.js';

test('cookie failure signatures match only cookie-class gateway errors', () => {
  assert.equal(isCookieFailure('user/info.json 未返回 secToken（Cookie 可能已过期）'), true);
  assert.equal(isCookieFailure('缺少 BAILIAN_CONSOLE_COOKIE'), true);
  assert.equal(isCookieFailure('未配置 BAILIAN_CONSOLE_COOKIE（~/.dsh/.env）'), true);
  assert.equal(isCookieFailure('网关 usage HTTP 401'), true);
  assert.equal(isCookieFailure('subscription 未返回 specCode'), true);
  // 网络瞬断/超时不应触发弹窗式重登录。
  assert.equal(isCookieFailure('fetch failed'), false);
  assert.equal(isCookieFailure('AbortError: signal timeout'), false);
});

test('failure kinds: missing pops immediately, suspect needs streak confirmation', () => {
  assert.equal(cookieFailureKind('未配置 BAILIAN_CONSOLE_COOKIE（~/.dsh/.env）'), 'missing');
  assert.equal(cookieFailureKind('缺少 BAILIAN_CONSOLE_COOKIE'), 'missing');
  assert.equal(cookieFailureKind('user/info.json 未返回 secToken（Cookie 可能已过期）'), 'suspect');
  assert.equal(cookieFailureKind('网关 usage HTTP 401'), 'suspect');
  assert.equal(cookieFailureKind('网关 usage HTTP 403'), 'suspect');
  assert.equal(cookieFailureKind('subscription 未返回 specCode'), 'suspect');
  assert.equal(cookieFailureKind('fetch failed'), null);
});

/** 假桥：记录 open 调用次数（= 弹页次数），收割永远返回 null（会话保持 waiting）。 */
function fakeBridge() {
  const calls = { open: 0, close: 0 };
  return {
    calls,
    bridge: {
      available: () => true,
      open: async () => { calls.open += 1; return 42; },
      close: async () => { calls.close += 1; },
      hasTab: async () => true,
      findConsoleTab: async () => null,
      harvestCookie: async () => null,
      launch: async () => true,
    },
  };
}

/** 假时钟 + 假 ctx：timeout 不真跑（tick 不推进），会话保持进行中。 */
function harness({ startMs = 1_793_800_000_000 } = {}) {
  const clock = { now: startMs };
  const ctx = { timeout: () => () => {} };
  return { clock, ctx };
}

test('suspect failure pops only after 2 distinct refresh periods', async () => {
  const { bridge, calls } = fakeBridge();
  const { clock, ctx } = harness();
  const flow = new ReloginFlow({ ctx, cookieEnv: 'X_COOKIE', bridge, now: () => clock.now });
  // 第 1 个周期：只计数，不弹。
  await flow.maybeAuto('网关 usage HTTP 401');
  assert.equal(calls.open, 0, '单次疑似失败绝不弹页');
  // 同一周期内的重复失败（面板强刷撞车）：去重，仍不弹。
  clock.now += 60_000;
  await flow.maybeAuto('网关 usage HTTP 401');
  assert.equal(calls.open, 0, '周期内重复失败不叠加计数');
  // 第 2 个周期：确认失效，弹一次。
  clock.now += 3_600_000;
  await flow.maybeAuto('网关 usage HTTP 401');
  assert.equal(calls.open, 1, '连续两个刷新周期确认后弹一次');
  // 会话进行中：后续失败不再叠弹（幂等复用）。
  clock.now += 3_600_000;
  await flow.maybeAuto('网关 usage HTTP 401');
  assert.equal(calls.open, 1, '已有会话时绝不二次弹页');
});

test('noteSuccess clears the streak so isolated blips never pop', async () => {
  const { bridge, calls } = fakeBridge();
  const { clock, ctx } = harness();
  const flow = new ReloginFlow({ ctx, cookieEnv: 'X_COOKIE', bridge, now: () => clock.now });
  await flow.maybeAuto('网关 usage HTTP 401'); // count=1
  clock.now += 3_600_000;
  flow.noteSuccess(); // 这轮取数成功 → 清零
  clock.now += 3_600_000;
  await flow.maybeAuto('网关 usage HTTP 401'); // count=1（重新开始）
  assert.equal(calls.open, 0, '偶发瞬断被成功打断，永远凑不齐连续两个周期');
});

test('missing cookie pops immediately on first sight', async () => {
  const { bridge, calls } = fakeBridge();
  const { ctx } = harness();
  const flow = new ReloginFlow({ ctx, cookieEnv: 'X_COOKIE', bridge, now: () => Date.now() });
  await flow.maybeAuto('未配置 X_COOKIE（~/.dsh/.env）');
  assert.equal(calls.open, 1, '没有 Cookie 时登录页是唯一恢复路径，首触即弹');
});

test('auto cooldown is 2h; manual start bypasses it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-cool-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
    const calls = { open: 0, close: 0 };
    let harvest = null;
    let pendingTick = null;
    const bridge = {
      available: () => true,
      open: async () => { calls.open += 1; return 42; },
      close: async () => { calls.close += 1; },
      hasTab: async () => true,
      findConsoleTab: async () => null,
      harvestCookie: async () => harvest,
      launch: async () => true,
    };
    const clock = { now: 1_793_800_000_000 };
    // timeout 存下 tick 回调，由测试手动推进（不真跑定时器）。
    const ctx = { timeout: (fn) => { pendingTick = fn; return () => { pendingTick = null; }; } };
    const flow = new ReloginFlow({ ctx, cookieEnv: 'X_COOKIE', bridge, now: () => clock.now });
    await flow.maybeAuto('未配置 X_COOKIE');
    assert.equal(calls.open, 1);
    // 收割成功 → 会话以 success 收场：当日熔断解除，只剩 2h 冷却在挡。
    // #arm 的回调不返回 tick 的 Promise（await pendingTick 等不到它完成），
    // 用 setImmediate 冲一次微任务队列让 tick 内部的多层 await 全部落地。
    harvest = 'login_qianwenai_ticket=tk';
    pendingTick?.();
    await new Promise((r) => setImmediate(r));
    assert.equal(flow.state().state, 'success');
    // 冷却期内（30 分钟后）自动路径沉默。
    clock.now += 30 * 60_000;
    await flow.maybeAuto('未配置 X_COOKIE');
    assert.equal(calls.open, 1, '2h 冷却内不再自动弹');
    // 手动入口不受冷却限制。
    const r = await flow.start({ auto: false });
    assert.equal(r.ok, true);
    assert.equal(calls.open, 2, '手动一键登录永远可用');
  } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('failed auto session blocks further auto pops for the rest of the day', async () => {
  const { bridge, calls } = fakeBridge();
  const { clock, ctx } = harness({ startMs: 1_793_800_000_000 });
  const flow = new ReloginFlow({ ctx, cookieEnv: 'X_COOKIE', bridge, now: () => clock.now });
  await flow.maybeAuto('未配置 X_COOKIE');
  assert.equal(calls.open, 1);
  // 自动会话以失败收场（模拟超时/页面被关闭的 finish 路径）。
  flow.cancel('模拟登录页被关闭');
  // 次日之前（同一本地日）：自动路径全部沉默。
  clock.now += 30 * 60_000;
  await flow.maybeAuto('未配置 X_COOKIE');
  assert.equal(calls.open, 1, '当日熔断：失败后当天不再自动弹');
  // 跨到次日（+24h 足够跨过本地日界）：熔断解除，冷却也已满足。
  clock.now += 25 * 3_600_000;
  await flow.maybeAuto('未配置 X_COOKIE');
  assert.equal(calls.open, 2, '次日恢复自动能力');
});

test('manual session failure does not trip the daily block', async () => {
  const { bridge, calls } = fakeBridge();
  const { clock, ctx } = harness();
  const flow = new ReloginFlow({ ctx, cookieEnv: 'X_COOKIE', bridge, now: () => clock.now });
  await flow.start({ auto: false }); // 手动开会话
  flow.cancel('用户取消'); // 手动会话失败：不该熔断自动路径
  clock.now += 30 * 60_000; // 仍在 2h 冷却外（从未自动弹过，lastAutoAt=0）
  await flow.maybeAuto('未配置 X_COOKIE');
  assert.equal(calls.open, 2, '手动失败不影响自动路径');
});

test('failed auto start does not consume the 2h cooldown (self-heals next refresh)', async () => {
  // 回归：旧实现 `this.#lastAutoAt = now` 在 start() 之前，桥不可用导致启动失败
  // 也会吃掉 2 小时冷却 → 当天不再自愈。修后只有 r.ok 才消耗冷却；失败只挡 5 分钟。
  let available = false;
  let opened = 0;
  const bridge = {
    available: () => available,
    open: async () => { opened += 1; return 7; },
    close: async () => {},
    hasTab: async () => true,
    findConsoleTab: async () => null,
    harvestCookie: async () => null,
    launch: async () => false, // 拉不起 Chrome → start 必然失败
  };
  const clock = { now: 1_793_800_000_000 };
  const flow = new ReloginFlow({ ctx: { timeout: () => () => {} }, cookieEnv: 'X_COOKIE', bridge, now: () => clock.now });
  await flow.maybeAuto('未配置 X_COOKIE');
  assert.equal(flow.state().state, 'idle', '启动失败没有会话');
  assert.equal(opened, 0);
  // 5 分钟失败间隔内（面板强刷）不重试，避免连点。
  clock.now += 60_000;
  await flow.maybeAuto('未配置 X_COOKIE');
  assert.equal(opened, 0, '失败后的短间隔内不重试');
  // 桥恢复后，下一个刷新周期就能自愈——不需要等 2 小时。
  available = true;
  clock.now += 5 * 60_000 + 1;
  await flow.maybeAuto('未配置 X_COOKIE');
  assert.equal(flow.state().state, 'waiting', '失败不消耗 2h 冷却，桥恢复后立即可自愈');
  assert.equal(opened, 1);
});

test('updateEnvFile replaces in place, appends when missing, keeps other keys', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-env-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const file = path.join(home, '.dsh', '.env');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'A_KEY=1\nBAILIAN_CONSOLE_COOKIE=old\nQWEN_TOKEN_PLAN_CN_API_KEY=sk-x\n');
    updateEnvFile('BAILIAN_CONSOLE_COOKIE', 'cna=z; login_qianwenai_ticket=tk;');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^A_KEY=1$/m);
    assert.match(text, /^BAILIAN_CONSOLE_COOKIE=cna=z; login_qianwenai_ticket=tk;$/m);
    assert.match(text, /^QWEN_TOKEN_PLAN_CN_API_KEY=sk-x$/m);
    assert.equal(text.match(/BAILIAN_CONSOLE_COOKIE=/g)?.length, 1);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
    // 键不存在时追加。
    updateEnvFile('NEW_KEY', 'v');
    assert.match(fs.readFileSync(file, 'utf8'), /^NEW_KEY=v$/m);
    // CRLF 注入被清洗：换行折叠为空格，不会生成新的独立行。
    updateEnvFile('BAILIAN_CONSOLE_COOKIE', 'a=1\r\nINJECTED=evil');
    const cleaned = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(cleaned, /^INJECTED=evil$/m);
    assert.equal(cleaned.match(/BAILIAN_CONSOLE_COOKIE=/g)?.length, 1);
    // $ 序列不被展开为替换模式。
    updateEnvFile('BAILIAN_CONSOLE_COOKIE', 'x=$&y$1');
    assert.match(fs.readFileSync(file, 'utf8'), /^BAILIAN_CONSOLE_COOKIE=x=\$&y\$1$/m);
  } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('tier refresh default is 1h and autoRelogin defaults on', () => {
  const config = Config({});
  assert.equal(config.tierRefreshHours, 1);
  assert.equal(config.autoRelogin, true);
});
