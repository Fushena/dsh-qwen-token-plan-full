import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, Config } from '../index.js';
import { iterateSse, responsesToDshChunks } from '../lib/responses-sse.js';
import { streamFailureCode, httpFailure } from '../lib/errors.js';
import { chatToDshChunks } from '../lib/chat.js';
import { detectSite, SITE_ENDPOINTS } from '../lib/site.js';

const enc = new TextEncoder();
const sseBody = (text) => new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });

/**
 * 这一组钉的是 2026-11-18 审计里两条「跨境断连」根因。
 * 它们的共同点：错误码落到 DEFAULT_RETRYABLE_CODES 之外，llm-retry 一次都不重试，
 * 于是用户看到的是「用着突然断连」，而不是自动重试后恢复。
 */
const RETRYABLE = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']);

// —— P0-1：流内错误（HTTP 头 200，错误在 SSE 里下发）必须落进可重试码 ——

test('流内 rate_limit / server_error 归到可重试码，不再一律 PROVIDER_ERROR', () => {
  // 旧实现两处写死 httpFailure(400, …)，这五种里有四种落进 PROVIDER_ERROR（不可重试）。
  assert.equal(streamFailureCode({ code: 'rate_limit_exceeded', message: 'Requests rate limit exceeded' }), 'RATE_LIMIT');
  assert.equal(streamFailureCode({ code: 'server_error', message: 'internal server error' }), 'SERVER');
  assert.equal(streamFailureCode({ code: 'upstream_error', message: 'bad gateway' }), 'SERVER');
  assert.equal(streamFailureCode({ code: 'service_unavailable', message: 'temporarily overloaded' }), 'SERVER');
  assert.equal(streamFailureCode({ code: 'request_timeout', message: 'deadline exceeded' }), 'TIMEOUT');
  for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT']) assert.ok(RETRYABLE.has(code), `${code} 必须可重试`);
});

test('流内错误里的额度耗尽与认证失败仍不可重试（别把不可恢复错误也重试）', () => {
  assert.equal(streamFailureCode({ code: 'insufficient_quota', message: '余额不足' }), 'QUOTA');
  assert.equal(streamFailureCode({ code: 'invalid_api_key', message: 'Invalid API-key provided.' }), 'AUTH');
  assert.ok(!RETRYABLE.has('QUOTA'));
  assert.ok(!RETRYABLE.has('AUTH'));
});

test('结构化 code 优先于 message 文本：限流文案里带 quota 字样不能被误判成额度耗尽', () => {
  // 宿主的 isQuotaExceededError 只要文本里有 "quota exceeded" 就判额度。
  // code=rate_limit_exceeded 是上游的枚举、可靠；message 是散文。先信 code，
  // 否则「退避一下就能重试」会被当成终局错误直接终结本轮（2026-11-18 实测）。
  assert.equal(streamFailureCode({ code: 'rate_limit_exceeded', message: 'quota exceeded, slow down' }), 'RATE_LIMIT');
  assert.equal(streamFailureCode({ code: 'insufficient_quota', message: 'please retry later' }), 'QUOTA');
  assert.equal(streamFailureCode({ code: 'server_error', message: 'request timeout, retry' }), 'SERVER');
  // code 不认识时才回落到文本启发式，额度/上下文仍要认出来。
  assert.equal(streamFailureCode({ code: 'weird_new_code', message: '余额不足' }), 'QUOTA');
  assert.equal(streamFailureCode({ code: 'invalid_parameter', message: 'input length exceeds context window' }), 'CONTEXT_WINDOW_EXCEEDED');
});

test('type:"error" 事件抛出的 LlmError 带可重试码', async () => {
  const body = sseBody('data: {"type":"error","error":{"code":"server_error","message":"upstream overloaded"}}\n\n');
  await assert.rejects(
    () => (async () => { for await (const _ of responsesToDshChunks(body, undefined)) { /* drain */ } })(),
    (error) => { assert.equal(error.code, 'SERVER'); assert.ok(RETRYABLE.has(error.code)); return true; },
  );
});

test('response.failed 的 finish.failure 带可重试码', async () => {
  const body = sseBody('data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"slow down"}}}\n\n');
  let code = null;
  for await (const chunk of responsesToDshChunks(body, undefined)) {
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') code = chunk.reason.failure.code;
  }
  assert.equal(code, 'RATE_LIMIT');
});

test('response.cancelled 仍报 ABORTED（用户取消不该被当成上游故障重试）', async () => {
  const body = sseBody('data: {"type":"response.cancelled","response":{"error":{"code":"server_error","message":"x"}}}\n\n');
  let code = null;
  for await (const chunk of responsesToDshChunks(body, undefined)) {
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') code = chunk.reason.failure.code;
  }
  assert.equal(code, 'ABORTED');
});

// —— 2026-11-24 审计 Q1：Chat 路线流内错误漏修（Responses 侧 11-18 已修，chat.js:144 仍写死 400）——

test('Chat 流内 rate_limit_exceeded / server_error 归到可重试码（Q1）', async () => {
  for (const [code, expected] of [['rate_limit_exceeded', 'RATE_LIMIT'], ['server_error', 'SERVER'], ['request_timeout', 'TIMEOUT']]) {
    const body = sseBody(`data: {"error":{"code":"${code}","message":"upstream says no"}}\n\n`);
    await assert.rejects(
      () => (async () => { for await (const _ of chatToDshChunks(body, undefined)) { /* drain */ } })(),
      (error) => { assert.equal(error.code, expected, `${code} 应映射 ${expected}`); assert.ok(RETRYABLE.has(error.code)); return true; },
    );
  }
});

test('Chat 流内额度/认证错误仍不可重试（Q1 别把终局错误也重试）', async () => {
  for (const [code, expected] of [['insufficient_quota', 'QUOTA'], ['invalid_api_key', 'AUTH']]) {
    const body = sseBody(`data: {"error":{"code":"${code}","message":"terminal"}}\n\n`);
    await assert.rejects(
      () => (async () => { for await (const _ of chatToDshChunks(body, undefined)) { /* drain */ } })(),
      (error) => { assert.equal(error.code, expected); assert.ok(!RETRYABLE.has(error.code)); return true; },
    );
  }
});

// —— 2026-11-24 审计 Q2：HTTP 429 + quota 措辞被误判 QUOTA（quota 启发式排在 429 之前）——

test('HTTP 429 即使 body 带 quota 措辞也判 RATE_LIMIT（Q2）', () => {
  // 网关确实存在 code/message 不一致报文（流内侧 11-18 就是为此修的）。
  // HTTP 429 是结构化状态、可靠；body 是散文。退避一下就能重试的限流不该被当终局。
  assert.equal(httpFailure(429, 'rate limit reached, quota exceeded, slow down'), 'RATE_LIMIT');
  assert.equal(httpFailure(429, '请求过于频繁，额度耗尽请稍后再试'), 'RATE_LIMIT');
  assert.ok(RETRYABLE.has(httpFailure(429, 'quota exceeded')));
});

test('HTTP 429 + 明确额度结构化字样仍判 QUOTA；非 429 的额度判定不变（Q2 护栏）', () => {
  assert.equal(httpFailure(429, 'insufficient_quota'), 'QUOTA');
  assert.equal(httpFailure(429, 'insufficient quota: billing account suspended'), 'QUOTA');
  assert.equal(httpFailure(429, '{"error":{"code":"insufficient_quota"}}'), 'QUOTA');
  assert.equal(httpFailure(429, '{"code":"insufficient_quota"}'), 'QUOTA');
  assert.equal(httpFailure(429, '{"error":{"code":"rate_limit_exceeded","message":"insufficient_quota"}}'), 'RATE_LIMIT');
  assert.equal(httpFailure(400, '余额不足'), 'QUOTA');
  assert.equal(httpFailure(400, 'quota exceeded'), 'QUOTA');
  assert.equal(httpFailure(200, '额度耗尽'), 'QUOTA');
  assert.equal(httpFailure(429, 'too many requests'), 'RATE_LIMIT');
  assert.equal(httpFailure(401, 'anything'), 'AUTH');
});

// PR 整合复核：JSON 报文里只有 message（没有 code）时不能丢掉 v0.7.1 的文本兜底。
// 真终局额度耗尽被降级成 RATE_LIMIT，会白白重试两轮再失败，面板也不提示「额度耗尽」。
test('HTTP 429 的 JSON 报文缺 code 时，仍按 message 认明确额度字样（Q2 整合护栏）', () => {
  assert.equal(httpFailure(429, '{"error":{"message":"insufficient_quota: billing hard limit reached","type":"requests"}}'), 'QUOTA');
  assert.equal(httpFailure(429, '{"error":{"message":"insufficient quota: billing account suspended"}}'), 'QUOTA');
  // 有 code 时 code 优先，message 里的额度措辞不能翻盘。
  assert.equal(httpFailure(429, '{"error":{"code":"rate_limit_exceeded","message":"insufficient quota"}}'), 'RATE_LIMIT');
  // 散文式限流仍然可重试。
  assert.equal(httpFailure(429, '{"error":{"message":"rate limit reached, quota exceeded, slow down"}}'), 'RATE_LIMIT');
  assert.equal(httpFailure(429, '{"message":"too many requests"}'), 'RATE_LIMIT');
});

// —— P1-5：SSE 单事件长度上限 ——

test('不含空行的超大流被判协议损坏，而不是无限吃内存', { timeout: 30_000 }, async () => {
  // 旧实现 buffer 只在遇到空行时才切事件：24MB 无空行的流实测解析出 0 个事件、RSS +136MB。
  const chunk = enc.encode('x'.repeat(1024 * 1024));
  const body = new ReadableStream({ start(c) { for (let i = 0; i < 40; i += 1) c.enqueue(chunk); c.close(); } });
  await assert.rejects(
    () => (async () => { for await (const _ of iterateSse(body, undefined)) { /* drain */ } })(),
    (error) => { assert.equal(error.code, 'STREAM_CLOSED'); return true; },
  );
});

test('正常的大事件不被上限误杀（阈值必须远高于合法事件）', async () => {
  const big = 'y'.repeat(2 * 1024 * 1024);
  const body = sseBody(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: big })}\n\n`);
  let events = 0;
  for await (const _ of iterateSse(body, undefined)) events += 1;
  assert.equal(events, 1);
});

// —— P2-14：站点探测「谁先 200 用谁」 ——

const siteCtx = { get: (n) => (n === 'credentials' ? { resolve: async () => ({ value: 'fixture' }) } : undefined) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 挂住直到探测预算 abort 它 —— 模拟黑洞丢包（既不回包也不 RST）。 */
const hangUntilAbort = (init) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, 60_000);
  init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
});
const siteFetch = (spec) => async (url, init) => {
  const site = String(url).includes('ap-southeast-1') ? 'intl' : 'cn';
  const [status, delay = 0] = spec[site];
  if (status === 'hang') { await hangUntilAbort(init); return new Response('{}', { status: 504 }); }
  await sleep(delay);
  return new Response('{}', { status });
};

test('cn 黑洞时不等满 15s 探测预算：intl 先通就用 intl', async () => {
  // 两版错法都实测过：await allSettled(两探) → 15003ms；改成 await cn 再看 intl → 仍 15003ms
  // （慢的那个还是挡在前面）。必须按完成顺序取，慢站点才不挡路。这 15s 是压在用户第一个请求上的。
  const started = Date.now();
  const result = await detectSite({
    ctx: siteCtx, apiKeyEnv: 'X', pluginName: 'audit',
    fetchImpl: siteFetch({ cn: ['hang'], intl: [200, 300] }), logger: { warn() {} },
  });
  const elapsed = Date.now() - started;
  assert.equal(result.site, 'intl');
  assert.equal(result.probed, true);
  assert.ok(elapsed < 5_000, `不该等满探测预算，实测 ${elapsed}ms`);
});

test('两站点都通时仍以国内站为准，哪怕国际站快几百毫秒', async () => {
  // 国际站偶发比国内站快，直接用「先到的那个」会把国内用户误判到国际站 → key 不匹配 401。
  const result = await detectSite({
    ctx: siteCtx, apiKeyEnv: 'X', pluginName: 'audit',
    fetchImpl: siteFetch({ cn: [200, 600], intl: [200, 100] }),
  });
  assert.equal(result.site, 'cn');
  assert.equal(result.endpoint, SITE_ENDPOINTS.cn);
});

test('cn 先 200 就立刻返回，不等国际站（intl 黑洞也不拖慢）', async () => {
  const started = Date.now();
  const result = await detectSite({
    ctx: siteCtx, apiKeyEnv: 'X', pluginName: 'audit',
    fetchImpl: siteFetch({ cn: [200, 100], intl: ['hang'] }),
  });
  assert.equal(result.site, 'cn');
  assert.ok(Date.now() - started < 5_000, '不该被黑洞的国际站拖住');
});

test('cn 明确失败时立刻采用 intl，并把 probed 标真', async () => {
  const ctx = { get: (n) => (n === 'credentials' ? { resolve: async () => ({ value: 'fixture' }) } : undefined) };
  const fetchImpl = async (url) => new Response('{}', { status: String(url).includes('ap-southeast-1') ? 200 : 401 });
  const result = await detectSite({ ctx, apiKeyEnv: 'X', pluginName: 'audit', fetchImpl });
  assert.equal(result.site, 'intl');
  assert.equal(result.endpoint, SITE_ENDPOINTS.intl);
  assert.equal(result.probed, true);
});

test('两站点都不通时 probed=false（调用方据此重试，而不是当成已判定）', async () => {
  const ctx = { get: (n) => (n === 'credentials' ? { resolve: async () => ({ value: 'fixture' }) } : undefined) };
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const result = await detectSite({ ctx, apiKeyEnv: 'X', pluginName: 'audit', fetchImpl, logger: { warn() {} } });
  assert.equal(result.site, 'cn');
  assert.equal(result.probed, false, '回落默认值必须与真判定区分开');
});

// —— P0-2：判定失败不得永久固化 ——

function fakeCtx(home) {
  const cleanups = [];
  const registered = [];
  const credentials = { resolve: async () => ({ value: 'fixture-intl-key' }) };
  const ctx = {
    llm: {
      registerConfigurableProviders() {},
      registerAdapter: (providers, adapter) => { registered.push({ providers, adapter }); return () => {}; },
      emitAdaptersUpdated() {},
    },
    effect(fn) { cleanups.push(fn()); },
    fiber: {},
    get: (name) => (name === 'credentials' ? credentials
      : name === 'workingDirectory' ? { defaultDirectory: () => home } : undefined),
    credentials,
    on: () => () => {},
    timeout: () => () => {},
    interval: () => () => {},
    logger: { info() {}, warn() {}, debug() {} },
  };
  return { ctx, cleanups, registered };
}

test('启动期断网导致的判定失败不被固化：冷却期满后重判并切到 intl', { timeout: 20_000 }, async () => {
  // 旧实现 siteTask ??= detectOnce() 把失败一起缓存 → 国际站 key 永久钉在国内站，
  // 每轮 AUTH 401（不可重试），只能重启进程。实测恢复后重探次数 0。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-site-'));
  const prevFetch = globalThis.fetch;
  const realNow = Date.now;
  let phase = 'startup-broken';
  let skew = 0;
  let reprobes = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const intl = u.includes('ap-southeast-1');
    if (u.endsWith('/models')) {
      if (phase === 'startup-broken') throw new TypeError('fetch failed');
      reprobes += 1;
      return new Response('{}', { status: intl ? 200 : 401 });
    }
    return new Response(JSON.stringify({ error: { message: 'Invalid API-key provided.' } }), { status: intl ? 200 : 401 });
  };
  Date.now = () => realNow() + skew;
  const { ctx, cleanups, registered } = fakeCtx(home);
  try {
    apply(ctx, Config({ mediaTools: false, proxy: 'none', autoRelogin: false, catalogFeed: false }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const adapter = registered[0].adapter;
    assert.ok(adapter.endpoint.includes('cn-beijing'), '启动期断网 → 回落国内站');

    phase = 'network-ok';
    const drain = async () => { try { for await (const _ of adapter.stream({ model: 'qwen4-max', messages: [] })) { /* drain */ } } catch { /* 401 预期 */ } };
    await drain();
    assert.ok(adapter.endpoint.includes('cn-beijing'), '冷却期内不该反复探测');

    skew = 31_000; // 冷却期满（真实世界过了 31 秒，网络已恢复）
    await drain();
    assert.ok(adapter.endpoint.includes('ap-southeast-1'), '冷却期满必须重判并切到国际站');
    assert.ok(reprobes > 0, '必须真的重探过');
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    Date.now = realNow;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('面板手动刷新绕过重试冷却：用户点刷新就是要立刻重试', { timeout: 20_000 }, async () => {
  // 冷却是给自动路径用的（断网时别每轮白等探测预算）。用户手动点「刷新」时若还被冷却挡着，
  // 就得干等 30s 才有效果 —— 那是把自愈入口也一起关掉了。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-force-'));
  const prevFetch = globalThis.fetch;
  let broken = true;
  let probes = 0;
  let generations = 0;
  // 注意：createProxyFetch 在 proxy:none 时**返回当时的 globalThis.fetch 引用**（不是包装函数），
  // 所以计数必须记在这个共享 handler 里，apply 之后再换 globalThis.fetch 是拦不到的。
  const handler0 = async (url) => {
    const u = String(url);
    if (u.endsWith('/models')) {
      // 只数国际站的探测：目录刷新也会打 /models，但只打当前站点（cn）。
      // 国际站被访问 == 站点判定真的重跑过，这才是本用例要断言的东西。
      if (u.includes('ap-southeast-1')) probes += 1;
      if (broken) throw new TypeError('fetch failed');
      if (u.includes('ap-southeast-1')) {
        // 带一个内置目录没有的新模型，让能力探测真的跑起来（后半段要数它的请求）。
        return new Response(JSON.stringify({ data: [{ id: 'qwen4-max' }, { id: 'probe-target-x' }] }), { status: 200 });
      }
      return new Response('{}', { status: 401 });
    }
    if (u.endsWith('/responses')) {
      generations += 1;
      return new Response('data: {"type":"response.output_text.delta","delta":"hi"}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response('{}', { status: 200 });
  };
  globalThis.fetch = handler0;
  const { ctx, cleanups } = fakeCtx(home);
  const routes = [];
  ctx.get = (n) => {
    if (n === 'credentials') return { resolve: async () => ({ value: 'fixture-intl-key' }) };
    if (n === 'workingDirectory') return { defaultDirectory: () => home };
    if (n === 'webServer') {
      return {
        host: '127.0.0.1',
        getOrigin: () => 'http://127.0.0.1:1',
        register: ({ handler }) => { routes.push(handler); return () => {}; },
      };
    }
    return undefined;
  };
  try {
    apply(ctx, Config({ mediaTools: false, proxy: 'none', autoRelogin: false, catalogFeed: false }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterStartup = probes;
    assert.ok(afterStartup > 0, '启动时应探过国际站一次');

    broken = false; // 网络恢复，但冷却期（30s）还没到
    const handler = routes[0];
    assert.ok(typeof handler === 'function', '应注册了面板路由');
    const res = { writeHead() {}, end() {} };
    const call = () => handler({ method: 'POST', url: '/qwen-token-plan-full/refresh', headers: { host: '127.0.0.1:1' } }, res);
    await call();
    assert.ok(probes > afterStartup, `手动刷新必须绕过冷却立刻重探国际站（启动 ${afterStartup} 次 → 现在 ${probes} 次）`);

    // 判定已成功后再点面板：不得重打生成类探测请求。点徽标就走这条路由，
    // 无条件 reprobe 等于每开一次面板都对每个新模型重打 11 次真实生成（花用户 Credits）。
    assert.ok(generations > 0, '前置条件：首轮应已对新模型 probe-target-x 探过能力');
    const afterFirst = generations;
    await call();
    assert.equal(generations, afterFirst, `探测已完整时面板刷新不得重打生成类探测（首轮 ${afterFirst} 次 → 现在 ${generations} 次）`);
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// —— P2-17：配置项必须有说明，否则配置页只显示裸字段名 ——

test('面板刷新不被能力探测拖死：探测慢时先回状态，探测转后台继续', async () => {
  // 前端 fetch 有 45s 上限，探测预算 180s。让一个点击同步等最长 3 分钟的付费生成，
  // 用户只会等到前端超时报错、后台还在花钱。前台必须短窗返回，且**不取消**在跑的探测。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-fg-'));
  const prevFetch = globalThis.fetch;
  const routes = [];
  let cancelled = 0;
  let finished = false;
  // 每个探测请求挂 12s（远超前台 8s 观察窗，但远小于 180s 探测预算）。
  // 计数与挂起都记在 apply 之前装好的这个 handler 里（createProxyFetch 直接返回它的引用）。
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen4-max' }, { id: 'slow-probe-x' }] }), { status: 200 });
    }
    if (u.endsWith('/responses')) {
      await new Promise((r) => {
        const t = setTimeout(r, 12_000);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); cancelled += 1; r(); }, { once: true });
      });
      finished = true;
      return new Response('data: {"type":"response.output_text.delta","delta":"hi"}\n\n', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const { ctx, cleanups } = fakeCtx(home);
  ctx.get = (n) => {
    if (n === 'credentials') return { resolve: async () => ({ value: 'fixture-cn-key' }) };
    if (n === 'workingDirectory') return { defaultDirectory: () => home };
    if (n === 'webServer') {
      return {
        host: '127.0.0.1',
        getOrigin: () => 'http://127.0.0.1:1',
        register: ({ handler }) => { routes.push(handler); return () => {}; },
      };
    }
    return undefined;
  };
  try {
    apply(ctx, Config({ mediaTools: false, proxy: 'none', autoRelogin: false, catalogFeed: false }));
    const handler = routes[0];
    assert.ok(typeof handler === 'function', '应注册了面板路由');
    let payload = null;
    const res = { writeHead() {}, end(body) { payload = JSON.parse(body); } };
    const started = Date.now();
    await handler({ method: 'POST', url: '/qwen-token-plan-full/refresh', headers: { host: '127.0.0.1:1' } }, res);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 11_000, `前台刷新必须在观察窗内返回（实测 ${elapsed}ms，探测每请求 12s）`);
    assert.ok(payload, '必须回了状态载荷');
    assert.equal(payload.provider.probing, true, '探测未完时 probing 应为 true，面板据此显示「探测中」');
    assert.equal(cancelled, 0, '前台超时不得取消在跑的探测（取消等于已花的钱白花）');
    assert.equal(finished, false, '此时探测确实还没探完');
  } finally {
    for (const c of cleanups.reverse()) { try { if (typeof c === 'function') c(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('新增的每个配置字段都带 description，且默认值不变', () => {
  const json = Config.toJSON();
  const root = json.refs[json.uid];
  const fields = ['endpoint', 'chatEndpoint', 'requestTimeoutMs', 'retryPolicy',
    'registerProvider', 'watchedProviders', 'catalogFeed', 'feedProvider', 'feedReasoning'];
  for (const field of fields) {
    const leaf = json.refs[root.dict[field]];
    assert.ok(leaf?.meta?.description, `${field} 缺 description（配置页会只显示裸字段名）`);
  }
  const resolved = Config({});
  assert.equal(resolved.requestTimeoutMs, 120_000);
  assert.equal(resolved.registerProvider, true);
  assert.equal(resolved.retryPolicy.maxRetries, 2);
});
