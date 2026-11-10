import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { QwenTokenPlanAdapter } from '../lib/adapter.js';
import { BUILTIN_CATALOG } from '../lib/catalog.js';

/**
 * 真实 SSE 服务器上的端到端超时回归。
 *
 * 为什么必须用真实 HTTP 服务器而不是假 ReadableStream：超时靠 abort 请求信号生效，
 * 真实 undici 收到 abort 会取消 body 并让 read() 抛错；手写假流不响应 abort，
 * 只能测出「定时器到点」，测不出「读取是否真的被中止」—— 而后者才是用户可感知的
 * 那一半（卡死时能不能及时止损、长回答会不会被误杀）。
 *
 * 三条断言：
 *   A. 慢但持续的流（总时长是阈值 3 倍多）必须完整跑完 —— 防「长回答被掐断」；
 *   B. 卡死的流必须在阈值附近报 TIMEOUT —— 防「干等 undici 300 秒」；
 *   C. 用户取消必须报 ABORTED 且立刻返回。
 */

const SSE = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
const send = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\r\n\r\n`);
const model = BUILTIN_CATALOG.models.find((entry) => entry.id === 'qwen3.8-flash');
const catalog = { find: () => model, snapshot: () => ({ models: [] }) };
const ctx = {
  get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'K' }) } : undefined),
  logger: { info() {}, warn() {}, debug() {} },
};

function makeAdapter(port, requestTimeoutMs) {
  return new QwenTokenPlanAdapter({
    ctx, catalog, providerId: 'qwen-token-plan-full', displayName: 'Qwen', apiKeyEnv: 'T',
    endpoint: `http://127.0.0.1:${port}/responses`,
    chatEndpoint: `http://127.0.0.1:${port}/chat`,
    harnessMode: { mode: 'none' }, pluginName: 'test',
    requestTimeoutMs, fetchImpl: globalThis.fetch,
  });
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

const pump = async (stream) => { for await (const chunk of stream) void chunk; };

test('空闲超时：慢但持续的流不会被掐断，卡死会及时 TIMEOUT，取消会 ABORTED', async () => {
  // A. 9 个 delta 每 150ms（约 1.35s，是 400ms 阈值的 3 倍多）+ 正常 done/completed。
  await withServer((req, res) => {
    res.writeHead(200, SSE);
    send(res, { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message' } });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      if (i <= 9) {
        send(res, { type: 'response.output_text.delta', output_index: 0, delta: 'x' });
        return;
      }
      clearInterval(timer);
      send(res, { type: 'response.output_item.done', output_index: 0, item: { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'xxxxxxxxx' }] } });
      send(res, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 9 } } });
      res.end();
    }, 150);
  }, async (port) => {
    const adapter = makeAdapter(port, 400);
    const started = Date.now();
    let text = '';
    for await (const chunk of adapter.stream({ model: model.id, messages: [], signal: new AbortController().signal })) {
      if (chunk.type === 'text-delta') text += chunk.text;
    }
    assert.equal(text.length, 9, 'A: 慢但持续的流必须完整读完');
    assert.ok(Date.now() - started < 2_500, 'A: 应在 2.5s 内正常结束');
  });

  // B. 发一个事件后永不再发 → 阈值附近必须 TIMEOUT。
  await withServer((req, res) => {
    res.writeHead(200, SSE);
    send(res, { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message' } });
  }, async (port) => {
    const adapter = makeAdapter(port, 400);
    const started = Date.now();
    await assert.rejects(pump(adapter.stream({ model: model.id, messages: [], signal: new AbortController().signal })), (error) => {
      assert.equal(error.code, 'TIMEOUT', 'B: 卡死的流必须报 TIMEOUT');
      assert.ok(Date.now() - started < 1_500, `B: 应在阈值附近中止（实际 ${Date.now() - started}ms）`);
      return true;
    });
  });

  // C. 用户取消 → ABORTED 且立刻返回。
  await withServer((req, res) => {
    res.writeHead(200, SSE);
    send(res, { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message' } });
  }, async (port) => {
    const adapter = makeAdapter(port, 60_000);
    const controller = new AbortController();
    const started = Date.now();
    const pending = pump(adapter.stream({ model: model.id, messages: [], signal: controller.signal }));
    setTimeout(() => controller.abort(new Error('user abort')), 150);
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'ABORTED', 'C: 用户取消必须报 ABORTED');
      assert.ok(Date.now() - started < 1_500, `C: 取消应立即生效（实际 ${Date.now() - started}ms）`);
      return true;
    });
  });
});
