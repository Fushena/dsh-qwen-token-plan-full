import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apply } from '../index.js';
import { isolateHome } from './home.mjs';

/**
 * 旁路调用观察回归（v0.4.0）：聊天不经过本插件 adapter 时，session/event 观察器
 * 仍按 provider 计调用数。provider 识别首选 finish chunk 的 replayState.response.provider，
 * 兜底 request/context、request/header 跟踪；失败 attempt 与非观察 provider 不计；
 * 观察器内部异常不得外溢（宿主隔离之外的自保）。
 */

function fakeCtx(handlers) {
  const cleanups = [];
  const credentials = { resolve: async () => undefined };
  return {
    cleanups,
    ctx: {
      llm: { registerConfigurableProviders() {}, registerAdapter: () => () => {}, emitAdaptersUpdated() {} },
      effect(fn) { cleanups.push(fn()); },
      fiber: {},
      get: (name) => (name === 'credentials' ? credentials : undefined),
      credentials,
      on: (event, fn) => { handlers[event] = fn; return () => { delete handlers[event]; }; },
      timeout: () => () => {},
      interval: () => () => {},
      logger: { info() {}, warn() {}, debug() {} },
    },
  };
}

const finish = (provider) => ({ type: 'assistant/message', data: { stream: [{ type: 'chunk', chunk: { type: 'finish', replayState: { response: { provider } } } }] } });
const bare = () => ({ type: 'assistant/message', data: { stream: [] } });

test('observer counts watched-provider calls without the adapter, ignores others and failures', async () => {
  const { home, restore } = isolateHome('qtpf-obs-');
  const prevKey = process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.QWEN_TOKEN_PLAN_CN_API_KEY = 'sk-test';
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); }; // 目录/等级刷新静默失败
  const handlers = {};
  const { ctx, cleanups } = fakeCtx(handlers);
  try {
    apply(ctx, { mediaTools: false, catalogFeed: false, autoRelogin: false, proxy: 'none', watchedProviders: ['qwentokenplan'] });
    const emit = handlers['session/event'];
    assert.equal(typeof emit, 'function', '观察器应订阅 session/event');
    const sessionA = {};
    const sessionB = {};
    const total = () => JSON.parse(fs.readFileSync(path.join(home, '.dsh', 'qwen-token-plan-full.budget.json'), 'utf8')).totalCalls;

    emit(sessionA, { type: 'request/context', data: { provider: 'qwentokenplan', model: 'm' } });
    emit(sessionA, finish('qwentokenplan'));
    assert.equal(total(), 1, 'replayState 识别计数');
    emit(sessionA, bare());
    assert.equal(total(), 2, '无 replayState 时回退会话跟踪');
    emit(sessionA, finish('deepseek-account'));
    assert.equal(total(), 2, '非观察 provider 不计');
    emit(sessionB, finish('qwentokenplan'));
    assert.equal(total(), 3, '未跟踪会话靠 replayState 也能计（热重载中途场景）');
    emit(sessionA, { type: 'assistant/attempt', data: {} });
    assert.equal(total(), 3, '失败 attempt 不计');
    emit(sessionA, { type: 'request/header', data: { header: { config: { provider: 'qwen-token-plan-full' } } } });
    emit(sessionA, bare());
    assert.equal(total(), 4, '本插件 provider 始终在观察名单');
    // 观察器自保：事件 payload 畸形不得外溢异常。
    emit(sessionA, { type: 'assistant/message', data: { stream: [{ chunk: { type: 'finish', get replayState() { throw new Error('boom'); } } }] } });
    assert.equal(total(), 4);
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.QWEN_TOKEN_PLAN_CN_API_KEY; else process.env.QWEN_TOKEN_PLAN_CN_API_KEY = prevKey;
    restore();
  }
});
