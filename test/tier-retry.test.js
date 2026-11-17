import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

/**
 * 启动兜底重试必须「一次性」（2026-11-13 修复）。
 *
 * 回归：refreshTier 失败排 60s 重试，retry 回调先置 tierRetryTimer=null 再失败
 * 又排下一个 60s → 断网时每分钟 fetch + setTierFallback → budget#save(.bak+rename)
 * 无限写盘。这里用受控 ctx.timeout 记录排程、注入恒失败的 fetch，
 * 手动推进多个「60s」断言 60_000ms 排程只发生一次。
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function fakeCtx() {
  const timeouts = [];
  const cleanups = [];
  const credentials = { resolve: async () => ({ value: 'cookie' }) };
  const ctx = {
    llm: {
      registerConfigurableProviders() {},
      registerAdapter: () => () => {},
      emitAdaptersUpdated() {},
    },
    effect(fn) { cleanups.push(fn()); },
    fiber: {},
    get: (name) => (name === 'credentials' ? credentials : undefined),
    credentials,
    timeout: (fn, ms) => { timeouts.push({ fn, ms }); return () => {}; },
    interval: () => () => {},
    logger: { info() {}, warn() {}, debug() {} },
  };
  return { ctx, timeouts, cleanups };
}

test('tier fallback retry is one-shot: repeated failures never reschedule the 60s timer', async () => {
  // HOME 隔离：HarnessBudget 默认落盘 ~/.dsh/...，不得污染真实状态。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-retry-'));
  const prevHome = process.env.HOME;
  const prevFetch = globalThis.fetch;
  process.env.HOME = home;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new TypeError('fetch failed'); };
  const { ctx, timeouts, cleanups } = fakeCtx();
  try {
    apply(ctx, { mediaTools: false, proxy: 'none', autoRelogin: false });
    await flush();
    const retrySchedules = () => timeouts.filter((entry) => entry.ms === 60_000);
    assert.equal(retrySchedules().length, 1, '首次失败应排且只排一个 60s 兜底重试');
    assert.equal(fetchCalls, 3, '启动即取 catalog/tier/equity 各一次');

    // 推进第一个 60s：重试仍失败（fetch 恒 reject）。一次性语义 → 不得再排。
    retrySchedules()[0].fn();
    await flush();
    assert.equal(retrySchedules().length, 1, '重试再失败不得再排下一个 60s（旧实现此处变 2，无限循环）');

    // 再推进一轮（模拟旧循环的后续节拍）：排程数与写盘都必须有界。
    retrySchedules()[0].fn();
    await flush();
    assert.equal(retrySchedules().length, 1, '持续失败时 60s 排程恒为 1');
    assert.equal(fetchCalls, 5, 'fetch 次数 = 启动 3 次 + 实际触发的重试 2 次，有界');
    // 每次失败都 setTierFallback→#save：写盘次数同样以「失败次数」为上界，不随时间无限增长。
    const budgetFile = path.join(home, '.dsh', 'qwen-token-plan-full.budget.json');
    assert.equal(fs.existsSync(budgetFile), true, '兜底等级应已落盘');
    const state = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    assert.equal(state.tier.source, 'builtin', '断网时按内置等级兜底');
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
