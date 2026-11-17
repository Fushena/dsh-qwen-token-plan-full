import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config, apply } from '../index.js';
import { QwenTokenPlanAdapter } from '../lib/adapter.js';
import { normalizeHarnessMode } from '../lib/harness.js';
import { SITE_ENDPOINTS } from '../lib/site.js';

/**
 * 跨境两个旋钮：requestTimeoutMs 与 retryPolicy（2026-11-17）。
 *
 * 背景（本机实测）：跨境链路静默一旦超过写死的 60s 空闲阈值就报 TIMEOUT，
 * 而 TIMEOUT 在 DSH 的 DEFAULT_RETRYABLE_CODES 里、默认重试 5 次且每次重新
 * 全量上传历史 → 一次抖动被放大成 5–6 分钟假死。两个旋钮必须成对调：
 * 真正的最坏墙钟 = requestTimeoutMs × (1 + maxRetries) + 退避总和，
 * 所以放宽超时必须同时压低重试次数，否则「修断连」会变成「卡更久」。
 */

test('Config 暴露跨境默认值：空闲超时 120s、重试 2 次、退避起点 1000ms', () => {
  const config = Config({});
  assert.equal(config.requestTimeoutMs, 120_000);
  assert.equal(config.retryPolicy.mode, 'normal');
  assert.equal(config.retryPolicy.maxRetries, 2);
  assert.equal(config.retryPolicy.backoff.initialDelayMs, 1_000);
  // 最坏墙钟必须留在旧实现的量级（旧：60s × 6 次 ≈ 360s），不得因为放宽超时而恶化。
  const worstCaseMs = config.requestTimeoutMs * (1 + config.retryPolicy.maxRetries);
  assert.ok(worstCaseMs <= 360_000, `最坏墙钟 ${worstCaseMs}ms 不得超过旧实现的 360s`);
});

test('Config 拒绝非法旋钮值：0/负数超时、未知重试模式、非法重试次数', () => {
  assert.throws(() => Config({ requestTimeoutMs: 0 }));
  assert.throws(() => Config({ requestTimeoutMs: -1 }));
  assert.throws(() => Config({ retryPolicy: { mode: 'forever' } }));
  assert.throws(() => Config({ retryPolicy: { mode: 'normal', maxRetries: -1 } }));
  assert.throws(() => Config({ retryPolicy: { mode: 'normal', maxRetries: 1.5 } }));
});

test('退避区间倒置/未知键在 adapter 侧被拒（schemastery 的 union 放行，靠 DSH 的解析器兜底）', () => {
  // schemastery 的 union 只校验形状，跨字段约束（initial ≤ max）与未知键它不管；
  // resolveRetryPolicy 才管。这里钉住「非法配置一定报错」，而不是悄悄按默认值跑。
  assert.throws(
    () => new QwenTokenPlanAdapter({ ...adapterBase, retryPolicy: Config({ retryPolicy: { mode: 'normal', backoff: { initialDelayMs: 9_000, maxDelayMs: 1_000 } } }).retryPolicy }),
    /initialDelayMs/,
  );
  assert.throws(
    () => new QwenTokenPlanAdapter({ ...adapterBase, retryPolicy: Config({ retryPolicy: { mode: 'normal', backoff: { bogus: 1 } } }).retryPolicy }),
    /unknown key/,
  );
});

const adapterBase = {
  ctx: { get: () => undefined },
  catalog: { find: () => undefined, snapshot: () => ({ models: [] }) },
  providerId: 'qwen-token-plan-full', displayName: 'Qwen', apiKeyEnv: 'TEST', pluginName: 'test',
  endpoint: 'https://example.invalid/responses', harnessMode: normalizeHarnessMode('none'),
};

test('adapter 把配置的重试策略交给 DSH：providerRetryPolicy 返回解析后的策略', () => {
  // 期望值写成字面量（不重算 Config 默认），这样「加了字段但没透传」一定会被抓到。
  const adapter = new QwenTokenPlanAdapter({
    ...adapterBase,
    retryPolicy: {
      mode: 'normal', maxRetries: 1, retryableCodes: ['TIMEOUT'],
      backoff: { initialDelayMs: 2_000, maxDelayMs: 8_000, jitterRatio: 0 },
    },
  });
  assert.deepEqual(adapter.providerRetryPolicy('qwen-token-plan-full'), {
    mode: 'normal', maxRetries: 1, retryableCodes: ['TIMEOUT'],
    initialDelayMs: 2_000, maxDelayMs: 8_000, jitterRatio: 0,
  });
});

/** apply 级装配：捕获真正注册进宿主的 adapter（照 tier-retry.test.js 的隔离手法）。 */
function fakeCtx() {
  const cleanups = [];
  const registered = [];
  const credentials = { resolve: async () => ({ value: 'fixture' }) };
  const ctx = {
    llm: {
      registerConfigurableProviders() {},
      registerAdapter: (providers, adapter) => { registered.push({ providers, adapter }); return () => {}; },
      emitAdaptersUpdated() {},
    },
    effect(fn) { cleanups.push(fn()); },
    fiber: {},
    get: (name) => (name === 'credentials' ? credentials : undefined),
    credentials,
    timeout: () => () => {},
    interval: () => () => {},
    logger: { info() {}, warn() {}, debug() {} },
  };
  return { ctx, cleanups, registered };
}

test('apply 把 Config 的两个旋钮真的装配进注册的 adapter', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-knobs-'));
  const prevHome = process.env.HOME;
  const prevFetch = globalThis.fetch;
  process.env.HOME = home;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const { ctx, cleanups, registered } = fakeCtx();
  try {
    apply(ctx, Config({
      mediaTools: false, proxy: 'none', autoRelogin: false,
      requestTimeoutMs: 30_000,
      retryPolicy: { mode: 'normal', maxRetries: 0, backoff: { initialDelayMs: 500, maxDelayMs: 1_000, jitterRatio: 0 } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(registered.length, 1, '必须注册一个 adapter');
    const adapter = registered[0].adapter;
    assert.equal(adapter.requestTimeoutMs, 30_000, '配置的空闲超时必须落到 adapter（旧实现恒为 60s）');
    assert.equal(adapter.providerRetryPolicy('qwen-token-plan-full').maxRetries, 0, '配置的重试次数必须交给宿主');
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('配置的空闲超时真的作用到线上：卡死的流在配置阈值处报 TIMEOUT', { timeout: 15_000 }, async () => {
  // seam 4：真实 HTTP 服务器（假流不响应 abort，测不出 body 是否真被中止）。
  // 这条钉的是「配置 → 装配 → 线上信号」整条链：旧实现 Config 里没有这个字段，
  // 无论用户写什么都恒等 60s，本测试会一直挂到 node:test 超时。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-wire-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message' } })}\r\n\r\n`);
    // 之后永不再发字节：模拟跨境链路静默。
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { ctx, cleanups, registered } = fakeCtx();
  try {
    apply(ctx, Config({
      mediaTools: false, proxy: 'none', autoRelogin: false,
      endpoint: `http://127.0.0.1:${server.address().port}/compatible-mode/v1/responses`,
      requestTimeoutMs: 1_000,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const adapter = registered[0].adapter;
    const started = Date.now();
    await assert.rejects(
      (async () => { for await (const chunk of adapter.stream({ model: 'qwen3.8-flash', messages: [], signal: new AbortController().signal })) void chunk; })(),
      (error) => {
        assert.equal(error.code, 'TIMEOUT');
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 3_000, `应在配置的 1s 阈值附近中止（实际 ${elapsed}ms）`);
        assert.match(error.message, /1000ms/, '错误文案必须报出用户配置的那个阈值');
        return true;
      },
    );
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    server.closeAllConnections?.();
    server.close();
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** 端点自动判定用的 ctx：额外记录注册时的 URL，并提供 tools/webServer 缺席的最小面。 */
function endpointCtx() {
  const base = fakeCtx();
  const tools = [];
  base.ctx.tools = { register: (def) => { tools.push(def); return () => {}; } };
  return { ...base, tools };
}

test('endpoint 默认自动判定：两站点并发探测，谁 200 用谁（国际站 key 也能用）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-site-'));
  const prevHome = process.env.HOME;
  const prevFetch = globalThis.fetch;
  process.env.HOME = home;
  const seen = [];
  // 国际站 key：北京 401、新加坡 200（与真实上游一致，实测 2026-11-17）。
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    if (href.includes('token-plan.cn-beijing')) return new Response('{"code":"InvalidApiKey"}', { status: 401 });
    if (href.includes('token-plan.ap-southeast-1')) {
      return Response.json({ data: [{ id: 'qwen3.8-flash' }] });
    }
    throw new TypeError('fetch failed');
  };
  const { ctx, cleanups, registered } = endpointCtx();
  try {
    apply(ctx, Config({ mediaTools: false, proxy: 'none', autoRelogin: false }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const adapter = registered[0].adapter;
    assert.equal(
      adapter.endpoint,
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses',
      '国内站 401、国际站 200 → 必须自动切到新加坡',
    );
    assert.equal(
      adapter.chatEndpoint,
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
      'Chat 端点必须跟着一起切',
    );
    assert.ok(
      seen.some((href) => href.startsWith('https://token-plan.cn-beijing.maas.aliyuncs.com/') && href.endsWith('/models')),
      '必须探测过国内站',
    );
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('站点判定失败不失活：两站点都不通仍照常注册，端点保留国内站', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-site-down-'));
  const prevHome = process.env.HOME;
  const prevFetch = globalThis.fetch;
  process.env.HOME = home;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); throw new TypeError('fetch failed'); };
  const { ctx, cleanups, registered } = endpointCtx();
  try {
    apply(ctx, Config({ mediaTools: false, proxy: 'none', autoRelogin: false }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const adapter = registered[0].adapter;
    assert.ok(adapter, '断网时也必须注册 adapter —— 站点探测失败绝不能让 provider 失活');
    assert.equal(adapter.endpoint, SITE_ENDPOINTS.cn, '判不出来时保留国内站默认值');
    assert.ok(
      seen.some((href) => href.includes('ap-southeast-1') && href.endsWith('/models')),
      '两个站点都要探过，不能只探国内站',
    );
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('换站点后媒体工具与目录一起跟随：不允许「对话切了、图片还打旧地域」', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-site-media-'));
  const prevHome = process.env.HOME;
  const prevFetch = globalThis.fetch;
  process.env.HOME = home;
  const seen = [];
  // 国际站 key：北京一律 401，新加坡放行；图片响应给一张合法的公网 https 图。
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    if (href.includes('cn-beijing')) return new Response('{"code":"InvalidApiKey"}', { status: 401 });
    if (href.endsWith('/models')) return Response.json({ data: [{ id: 'qwen3.8-flash' }] });
    if (href.includes('/chat/completions')) {
      return Response.json({
        choices: [{ message: { content: [{ type: 'image', image: 'https://example.com/cat.png' }] } }],
      });
    }
    // 图片下载：不真下载，返回一个最小 PNG 字节流即可（本例只关心打到了哪个域名）。
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200, headers: { 'content-type': 'image/png' },
    });
  };
  const { ctx, cleanups, registered, tools } = endpointCtx();
  try {
    apply(ctx, Config({ proxy: 'none', autoRelogin: false }));   // mediaTools 默认开启
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(registered[0].adapter.endpoint, SITE_ENDPOINTS.intl, '国际站 key → 切到新加坡');

    // 目录必须按新站点重取：探测那次之外，还得有一次打新加坡 /models 的目录刷新。
    const intlCatalogHits = seen.filter(
      (href) => href.startsWith('https://token-plan.ap-southeast-1.maas.aliyuncs.com/') && href.endsWith('/models'),
    ).length;
    assert.ok(intlCatalogHits >= 2, `换站点后目录要按新站点重取，实际新加坡 /models 只打了 ${intlCatalogHits} 次`);

    const imageTool = tools.find((def) => def.name === 'qwen_generate_image');
    assert.ok(imageTool, '图片工具已注册');
    seen.length = 0;
    await imageTool.execute({ prompt: 'a cat', n: 1 }, { signal: undefined }).catch(() => {});
    assert.ok(
      seen.some((href) => href.startsWith('https://token-plan.ap-southeast-1.maas.aliyuncs.com/')),
      `图片工具必须打新站点，实际打了：${seen.join(' | ')}`,
    );
    assert.ok(
      !seen.some((href) => href.includes('cn-beijing')),
      `半切换：图片工具仍在打北京 —— ${seen.join(' | ')}`,
    );
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('第一个模型请求必须等站点判定落地：国际站 key 的首轮不许打到北京吃 401', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qtpf-site-gate-'));
  const prevHome = process.env.HOME;
  const prevFetch = globalThis.fetch;
  process.env.HOME = home;
  const chatHits = [];
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/models')) {
      // 探测故意慢：模拟跨境启动。首轮请求若不等判定，就会先打到北京。
      await probeGate;
      if (href.includes('cn-beijing')) return new Response('{"code":"InvalidApiKey"}', { status: 401 });
      return Response.json({ data: [{ id: 'qwen3.8-flash' }] });
    }
    // 只数模型请求：控制台网关（platform-home.qianwenai.com）也在启动期打，
    // 把它算进来会误判成「首轮已发出」。
    if (href.includes('token-plan.')) chatHits.push(href);
    if (href.includes('cn-beijing')) return new Response('{"code":"InvalidApiKey"}', { status: 401 });
    return new Response('data: {"type":"response.completed","response":{"usage":{}}}\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  const { ctx, cleanups, registered } = endpointCtx();
  try {
    apply(ctx, Config({ mediaTools: false, proxy: 'none', autoRelogin: false }));
    const adapter = registered[0].adapter;
    // 判定还没出结果就发首轮请求。
    const consumed = (async () => {
      for await (const _chunk of adapter.stream({
        model: 'qwen3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) { /* drain */ }
    })();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(chatHits.length, 0, '判定未落地时不得发出模型请求（401 不可重试，漏一轮就是整轮失败）');
    releaseProbe();
    await consumed;
    assert.equal(chatHits.length, 1, '判定落地后放行首轮');
    assert.ok(
      chatHits[0].startsWith('https://token-plan.ap-southeast-1.maas.aliyuncs.com/'),
      `首轮必须打判定出来的站点，实际：${chatHits[0]}`,
    );
  } finally {
    releaseProbe();
    for (const cleanup of cleanups.reverse()) { try { cleanup?.(); } catch { /* best effort */ } }
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
