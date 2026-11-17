import { test } from "node:test";
import assert from "node:assert/strict";
import { probeModelCapabilities, clearProbeCache } from "../lib/capability-probe.js";

// 最小 SSE 响应体（一个 output_text.delta + completed），
// 探测只关心 HTTP 状态，但 body 也得能读，否则 response.text() 会挂。
const SSE_BODY =
  'data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
  'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';

function mockFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    for (const handler of handlers) {
      if (handler.match(body)) {
        const status = handler.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => (status >= 200 && status < 300 ? SSE_BODY : JSON.stringify({ error: { message: "bad request" } })),
        };
      }
    }
    // 默认 200。
    return { ok: true, status: 200, text: async () => SSE_BODY };
  };
  impl.calls = calls;
  return impl;
}

test("probe: model with image support gets input=['text','image']", async () => {
  clearProbeCache();
  const fetchImpl = mockFetch([
    // 带图请求成功。
    { match: (b) => b.input?.[0]?.content?.some?.((c) => c.type === "input_image"), status: 200 },
  ]);
  const result = await probeModelCapabilities("test-vision-model", {
    endpoint: "https://example.com/v1/responses",
    key: "test-key",
    fetchImpl,
  });
  assert.deepEqual(result.input, ["text", "image"]);
});

test("probe: model without image support keeps input=['text']", async () => {
  clearProbeCache();
  const fetchImpl = mockFetch([
    // 带图请求 400。
    { match: (b) => b.input?.[0]?.content?.some?.((c) => c.type === "input_image"), status: 400 },
  ]);
  const result = await probeModelCapabilities("test-text-model", {
    endpoint: "https://example.com/v1/responses",
    key: "test-key",
    fetchImpl,
  });
  assert.deepEqual(result.input, ["text"]);
});

test("probe: reasoning efforts collected from successful probes", async () => {
  clearProbeCache();
  const fetchImpl = mockFetch([
    // low/high/xhigh 成功，其余 400。
    { match: (b) => b.reasoning?.effort === "low", status: 200 },
    { match: (b) => b.reasoning?.effort === "high", status: 200 },
    { match: (b) => b.reasoning?.effort === "xhigh", status: 200 },
    { match: (b) => b.reasoning?.effort === "medium", status: 400 },
    { match: (b) => b.reasoning?.effort === "max", status: 400 },
  ]);
  const result = await probeModelCapabilities("test-reasoning-model", {
    endpoint: "https://example.com/v1/responses",
    key: "test-key",
    fetchImpl,
  });
  // none（不传 reasoning）也应该成功（默认 200）。
  assert.ok(result.reasoningEfforts.includes("none"));
  assert.ok(result.reasoningEfforts.includes("low"));
  assert.ok(result.reasoningEfforts.includes("high"));
  assert.ok(result.reasoningEfforts.includes("xhigh"));
  assert.ok(!result.reasoningEfforts.includes("medium"));
  assert.ok(!result.reasoningEfforts.includes("max"));
  // 默认档优先 high。
  assert.equal(result.defaultReasoningEffort, "high");
});

test("probe: maxTokens escalates to highest successful candidate", async () => {
  clearProbeCache();
  const fetchImpl = mockFetch([
    { match: (b) => b.max_output_tokens === 393216, status: 400 },
  ]);
  const result = await probeModelCapabilities("test-maxtokens-model", {
    endpoint: "https://example.com/v1/responses",
    key: "test-key",
    fetchImpl,
  });
  assert.equal(result.maxTokens, 262144);
});

test("probe: cache prevents duplicate probes", async () => {
  clearProbeCache();
  const fetchImpl = mockFetch([]);
  await probeModelCapabilities("test-cache-model", {
    endpoint: "https://example.com/v1/responses",
    key: "test-key",
    fetchImpl,
  });
  const firstCallCount = fetchImpl.calls.length;
  await probeModelCapabilities("test-cache-model", {
    endpoint: "https://example.com/v1/responses",
    key: "test-key",
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, firstCallCount, "second call should use cache");
});

test("probe: fetch failure returns conservative defaults", async () => {
  clearProbeCache();
  const fetchImpl = async () => { throw new Error("network down"); };
  const result = await probeModelCapabilities("test-offline-model", {
    endpoint: "https://example.com/v1/responses",
    key: "test-key",
    fetchImpl,
  });
  assert.deepEqual(result.input, ["text"]);
  assert.equal(result.maxTokens, 16384);
});
