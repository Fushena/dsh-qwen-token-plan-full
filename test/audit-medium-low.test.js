/**
 * Qwen 插件中/低危审计漏洞回归测试（#6 ~ #17）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { probeModelCapabilities, clearProbeCache } from '../lib/capability-probe.js';
import { DynamicCatalog } from '../lib/catalog.js';
import { asrSecondsFromResult, MCP_HOSTS, registerEquityMcp } from '../lib/mcp-equity.js';
import { ReloginFlow, updateEnvFile } from '../lib/relogin.js';
import { readConsoleCookie } from '../lib/gateway.js';
import { registerMediaTools } from '../lib/media-tools.js';
import { CatalogFeed } from '../lib/catalog-feed.js';
import { detectSite } from '../lib/site.js';
import { chatToDshChunks, buildChatRequestBody } from '../lib/chat.js';
import { HarnessBudget } from '../lib/budget.js';
import { isolateHome } from './home.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('#6: capability-probe sends reasoning.effort=none, handles CRLF SSE errors, and non-reasoning model has reasoning=false', async () => {
  clearProbeCache();
  const seenNoneBodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.reasoning?.effort === 'none') seenNoneBodies.push(body);
    // 模拟总是思考模型：拒绝 none（CRLF 流内 response.failed），接受 high
    if (body.reasoning?.effort === 'none') {
      const crlf = 'data: {"type":"response.failed","error":{"message":"none unsupported"}}\r\n\r\n';
      return { ok: true, status: 200, text: async () => crlf };
    }
    if (body.reasoning?.effort === 'high') {
      const crlf = 'data: {"type":"response.created"}\r\n\r\n';
      return { ok: true, status: 200, text: async () => crlf };
    }
    if (body.reasoning) return { ok: false, status: 400, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => 'data: {"type":"response.created"}\r\n\r\n' };
  };
  const res = await probeModelCapabilities('qwen-always-think', {
    endpoint: 'https://example.com/v1/responses', key: 'sk-test', fetchImpl,
  });
  assert.equal(seenNoneBodies.length, 1, '探测 none 时必须发送 reasoning:{effort:"none"}');
  assert.deepEqual(res.reasoningEfforts, ['high'], 'CRLF response.failed 应判为拒绝而非 ok');

  // 仅支持 none 的非推理模型：DynamicCatalog 不得标成 reasoning:true
  clearProbeCache();
  const creds = { resolve: async () => ({ value: 'sk-test' }) };
  const cat = new DynamicCatalog({
    ctx: { credentials: creds, get: (n) => (n === 'credentials' ? creds : undefined) },
    modelsUrl: 'https://example.com/v1/models',
    apiKeyEnv: 'K',
    pluginName: 'test',
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen-non-reasoning-test' }] }), { status: 200 });
      }
      const body = JSON.parse(init.body);
      if (body.reasoning && body.reasoning.effort !== 'none') {
        return new Response(JSON.stringify({ error: { message: 'unsupported' } }), { status: 400 });
      }
      return new Response('data: {"type":"response.created"}\r\n\r\n', { status: 200 });
    },
  });
  await cat.refresh();
  const m = cat.find('qwen-non-reasoning-test');
  assert.equal(m?.reasoning, false);
  assert.deepEqual(m?.reasoningEfforts, []);
});

test('#7 & #17: asrSecondsFromResult avoids double-counting & metadata inflation; MCP_HOSTS.qianwen and trailing slash', async () => {
  // 同时返回 structuredContent 与 content，且含长元数据字段：只计一次，且不把 speaker_id/request_id 算成语音字数
  const sec = asrSecondsFromResult({
    structuredContent: {
      request_id: 'req-very-long-metadata-identifier-1234567890',
      sentences: [{ text: '你好世界', speaker_id: 'speaker_metadata_abcdefghij', status: 'completed' }],
    },
    content: [{ type: 'text', text: JSON.stringify({ results: ['你好世界'] }) }],
  });
  assert.equal(sec, 1, `应只计 4 字（1 秒），实际 ${sec}`);

  assert.equal(MCP_HOSTS.qianwen, 'https://maas.qianwenaiapi.com');
  const registered = new Map();
  const creds = { resolve: async () => ({ value: 'sk-ws-test' }) };
  const mcpManager = {
    register: (name, cfg) => { registered.set(name, cfg); return () => registered.delete(name); },
    listServers: () => [],
  };
  const ctx = {
    credentials: creds,
    mcpManager,
    get: (n) => (n === 'credentials' ? creds : n === 'mcpManager' ? mcpManager : undefined),
  };
  const mcp = registerEquityMcp(ctx, {
    apiKeyEnv: 'BAILIAN_PAYG_API_KEY',
    host: 'https://maas.qianwenaiapi.com///',
    mode: 'auto',
    budget: { enabled: true, equityState: () => ({ remaining: 10 }) },
  });
  await mcp.rearm();
  assert.equal(registered.get('EnhancedSearch')?.url, 'https://maas.qianwenaiapi.com/api/v1/mcps/EnhancedSearch/mcp');
  mcp.dispose();
});

test('#8 & #9: ReloginFlow creates ~/.dsh, updates stale env, deduplicates start(), and stops cleanly on dispose()', async () => {
  const { home, restore } = isolateHome('qtpf-relogin-ml-');
  const prevEnv = process.env.TEST_STALE_COOKIE;
  try {
    // ~/.dsh 尚未创建时 updateEnvFile 不报 ENOENT
    assert.equal(fs.existsSync(path.join(home, '.dsh')), false);
    updateEnvFile('TEST_STALE_COOKIE', 'ticket=fresh1');
    assert.ok(fs.readFileSync(path.join(home, '.dsh', '.env'), 'utf8').includes('TEST_STALE_COOKIE=ticket=fresh1'));

    // 过期环境变量存在时，#persist 同步更新 process.env，避免 readConsoleCookie 继续被遮蔽
    process.env.TEST_STALE_COOKIE = 'ticket=stale';
    let onSuccessCalls = 0;
    const bridgeCalls = { open: 0, close: [] };
    let resolveOpen;
    const bridge = {
      available: () => true,
      open: () => new Promise((r) => { bridgeCalls.open += 1; resolveOpen = r; }),
      close: async (id) => { bridgeCalls.close.push(id); },
      hasTab: async () => true,
      findConsoleTab: async () => null,
      harvestCookie: async () => null,
      launch: async () => true,
    };
    const flow = new ReloginFlow({
      ctx: { timeout: () => () => {} },
      cookieEnv: 'TEST_STALE_COOKIE',
      bridge,
      onSuccess: () => { onSuccessCalls += 1; },
    });
    // 并发两次 start() 只开一次标签
    const p1 = flow.start();
    const p2 = flow.start();
    assert.equal((await p2).already, true);
    await new Promise((r) => setImmediate(r));
    // 在 open 返回前 dispose() → 返回后立即关闭无主标签，不建立会话
    flow.dispose();
    resolveOpen(77);
    const r1 = await p1;
    assert.equal(r1.ok, false);
    assert.equal(bridgeCalls.open, 1);
    assert.deepEqual(bridgeCalls.close, [77]);
    assert.equal(onSuccessCalls, 0);

    // 静默收割走 #persist 后，stale process.env 应被新值覆盖
    const flow2 = new ReloginFlow({
      ctx: { timeout: () => () => {} },
      cookieEnv: 'TEST_STALE_COOKIE',
      bridge: {
        available: () => true,
        open: async () => 99,
        close: async () => {},
        hasTab: async () => true,
        findConsoleTab: async () => 88,
        harvestCookie: async () => 'ticket=brandnew',
        launch: async () => true,
      },
    });
    const r2 = await flow2.start();
    assert.equal(r2.silent, true);
    assert.equal(readConsoleCookie('TEST_STALE_COOKIE'), 'ticket=brandnew');
  } finally {
    if (prevEnv === undefined) delete process.env.TEST_STALE_COOKIE;
    else process.env.TEST_STALE_COOKIE = prevEnv;
    restore();
  }
});

test('#10: media-tools counts L1+L2 capacity in pre-flight and extracts JSON-escaped image URLs', async (t) => {
  const { home, restore } = isolateHome('qtpf-media-ml-');
  try {
    t.mock.method(dns.promises, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
    const tools = new Map();
    const calls = [];
    const workingDirectory = { ensure: async () => home, defaultDirectory: () => home };
    const ctx = {
      tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name); } },
      get: (n) => (n === 'workingDirectory' ? workingDirectory : undefined),
    };
    const downloadedUrls = [];
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fetchImpl = async (url) => {
      downloadedUrls.push(String(url));
      return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
    };
    // L1 剩 2 张 + L2 剩 1 张 = 合计 3 张，请求 n=3 必须放行！
    const budget = {
      equityState: () => ({ key: 'image_generation', remaining: 1, used: 19, quota: 20, unit: '张' }),
      serviceQuotaState: () => ({ key: 'image_generation', remaining: 2, used: 8, quota: 10, unit: '张' }),
      record: () => {},
      recordRequest: () => {},
    };
    const fakeMcp = {
      usesEquity: (k) => k === 'image_generation',
      refresh: async () => {},
      callTool: async (_service, _exec, pick, buildArgs) => {
        const def = {
          name: 'mcp__TextGenerateImage__bailian_image',
          parameters: { type: 'object', properties: { prompt: { type: 'string' }, n: { type: 'integer' } } },
        };
        const chosen = pick([{ name: 'bailian_image' }], [def]);
        calls.push(buildArgs(chosen.definition.parameters, chosen.rawName));
        // 含 JSON 转义 \" 和 \u0026 的签名 URL
        return {
          tool: chosen.rawName,
          value: { content: [{ type: 'text', text: '{"url":"https://oss.example.com/a.png?a=1\\u0026b=2"}' }] },
        };
      },
    };
    const dispose = registerMediaTools(ctx, {
      apiKeyEnv: 'API_KEY', pluginName: 'test',
      route: { endpoint: 'https://example.com/responses', origin: 'https://example.com' },
      imageModels: ['wan2.6'], videoModels: ['wan2.6'],
      defaultImageModel: 'wan2.6', defaultVideoModel: 'wan2.6',
      fetchImpl, budget, mcp: fakeMcp,
    });
    const res = await tools.get('qwen_generate_image').execute({ prompt: 'cat', n: 3 }, { agent: {}, signal: new AbortController().signal });
    assert.equal(calls.length, 1);
    assert.equal(downloadedUrls[0], 'https://oss.example.com/a.png?a=1&b=2', 'JSON 转义 URL 应被正确解码且无尾反斜杠');
    assert.equal(res.paths.length, 1);
    dispose();
  } finally {
    restore();
  }
});

test('#11: CatalogFeed re-locates model by id on reorder and deletes stale compat when repaired to non-reasoning', async () => {
  const { restore } = isolateHome('qtpf-feed-ml-');
  try {
    let modelSpec = {
      id: 'qwen-flex-1', capabilities: '动态发现（保守推断）',
      reasoning: true, reasoningEfforts: ['high'], contextWindow: 1000000, maxTokens: 65536, input: ['text'],
    };
    let config = {
      providers: {
        qwentokenplan: {
          baseURL: 'https://example.com/v1', apiKeyEnv: 'K',
          models: [],
        },
      },
    };
    const entry = { options: { id: 'llm-pi-ai', get config() { return config; } } };
    let reorderOnEdit = false;
    const creds = { resolve: async () => ({ value: 'sk-test' }) };
    const ctx = {
      credentials: creds,
      get: (n) => (n === 'credentials' ? creds : n === 'configEditor' ? {
        entries: () => [entry],
        edit: async (_e, fn) => {
          if (reorderOnEdit) {
            // 模拟拉取 /models 期间数组头部插入了另一个模型，导致原下标偏移！
            config.providers.qwentokenplan.models.unshift({ id: 'manual-other', name: 'Manual' });
          }
          config = fn(config);
        },
      } : undefined),
    };
    const feed = new CatalogFeed({
      ctx,
      catalog: { find: (id) => (id === 'qwen-flex-1' ? modelSpec : undefined) },
      feedProvider: 'qwentokenplan',
      pluginName: 'test',
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'qwen-flex-1' }] }), { status: 200 }),
    });
    // 第一轮写入带 compat 的推理规格
    await feed.run();
    assert.deepEqual(config.providers.qwentokenplan.models[0].compat, { thinkingFormat: 'qwen' });

    // 第二轮探测确认为非推理模型，且 edit 前数组被重排
    modelSpec = {
      id: 'qwen-flex-1', capabilities: '动态发现（能力已探测）',
      reasoning: false, reasoningEfforts: [], contextWindow: 1000000, maxTokens: 65536, input: ['text'],
    };
    reorderOnEdit = true;
    const r2 = await feed.run();
    assert.deepEqual(r2.repaired, ['qwen-flex-1']);
    assert.equal(config.providers.qwentokenplan.models[0].id, 'manual-other', '数组头部手动条目不得被错位覆盖');
    const updated = config.providers.qwentokenplan.models.find((m) => m.id === 'qwen-flex-1');
    assert.equal(updated.reasoningEfforts, false);
    assert.equal('compat' in updated, false, '非推理回填后应移除过时的 compat 字段');
  } finally {
    restore();
  }
});

test('#12: detectSite starts cn grace period when intl resolves rather than at t=0', async () => {
  const origSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  // 模拟 intl 在 1600ms 完成（>1500ms），cn 在 1700ms 完成（只晚 100ms）；用假延时加速验证：
  // 通过验证在 intl 完成前没有创建 1500ms 宽限定时器即可确认起算时机。
  globalThis.setTimeout = (fn, ms, ...rest) => {
    scheduled.push(ms);
    return origSetTimeout(fn, ms, ...rest);
  };
  try {
    let intlDone = false;
    let resolveCn;
    const fetchImpl = (url) => {
      if (String(url).includes('ap-southeast-1')) {
        return new Promise((r) => origSetTimeout(() => { intlDone = true; r({ status: 200, body: { cancel: async () => {} } }); }, 30));
      }
      return new Promise((r) => {
        resolveCn = () => r({ status: 200, body: { cancel: async () => {} } });
        origSetTimeout(() => { assert.equal(intlDone, true); resolveCn(); }, 80);
      });
    };
    const creds = { resolve: async () => ({ value: 'sk-test' }) };
    const res = await detectSite({
      ctx: { credentials: creds, get: (n) => (n === 'credentials' ? creds : undefined) },
      apiKeyEnv: 'K', pluginName: 'test', fetchImpl,
    });
    assert.equal(res.site, 'cn', 'cn 在 intl 之后 50ms 完成应在宽限内获胜');
    assert.ok(scheduled.includes(1500), '应在 intl 完成后启动 1500ms 宽限计时器');
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('#13: client QuotaLayers hides warning when disabled/fetched-empty and Entry closes panel when !mine', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/client.js'), 'utf8');
  assert.match(source, /serviceQuotasEnabled !== false/, '应检查 serviceQuotasEnabled');
  assert.match(source, /serviceRows\.length === 0 && !serviceFetched/, '仅在启用且未成功拉取时提示失败');
  assert.match(source, /if \(!mine\) setPanel\(null\)/, '切走模型后应关闭 panel');
});

test('#14: chatToDshChunks ignores empty finish_reason and chatMessages emits tool before user', async () => {
  const body = await buildChatRequestBody({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'fn', arguments: {} }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }, { type: 'text', text: 'next' }] },
    ],
  }, { id: 'glm-5.1', reasoning: false });
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.messages[3].role, 'user');

  const sse = [
    'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":""}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":""}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const resp = new Response(sse, { status: 200 });
  const chunks = [];
  for await (const c of chatToDshChunks(resp.body)) chunks.push(c);
  const fin = chunks.find((c) => c.type === 'finish');
  assert.deepEqual(fin?.reason, { kind: 'stop' });
});

test('#15: setEquities(null)/setServiceQuotas(null) preserve cache and setTierFallback clears mismatched planUsagePercent', () => {
  const { restore } = isolateHome('qtpf-budget-ml-');
  try {
    const b = new HarnessBudget({ config: { tier: 'standard' } });
    b.setTier({
      specCode: 'pro',
      quota: { pro: { monthly: 10000, five_hour: 1000 } },
      usage: { per1MonthPercentage: 42.5, per1MonthResetTime: Date.now() + 86400_000 },
    });
    b.setEquities([{ key: 'search_pro', available: 12, total: 20 }]);
    b.setServiceQuotas([{ key: 'search_pro', available: 5, total: 10, expiresAt: Date.now() + 86400_000 }]);

    // 拉取失败传入 null 时，必须保留旧快照而非覆盖成 null
    b.setEquities(null);
    b.setServiceQuotas(null);
    assert.equal(b.status().equities?.[0]?.available, 12);
    assert.equal(b.status().serviceQuotas?.[0]?.remaining, 5);

    // 从 pro 降级到 standard 时不得沿用 pro 的 42.5% 进度
    b.setTierFallback('gateway down');
    assert.equal(b.status().tier.specCode, 'standard');
    assert.equal(b.status().tier.planUsagePercent, undefined);
  } finally {
    restore();
  }
});
