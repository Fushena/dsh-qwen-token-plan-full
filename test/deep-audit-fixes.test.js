/**
 * Deep audit High & Medium regression tests for dsh-qwen-token-plan-full.
 * All tests run completely offline with isolated temp dirs and mocked network/DNS.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { Config, apply } from "../index.js";
import { trustedRouteRequest, isLoopbackAddress, hostnameOf } from "../lib/route-guard.js";
import { redactProxyUrl, createProxyFetch } from "../lib/proxy.js";
import { responsesToDshChunks } from "../lib/responses-sse.js";
import { chatToDshChunks } from "../lib/chat.js";
import { QwenTokenPlanAdapter } from "../lib/adapter.js";
import { normalizeHarnessMode } from "../lib/harness.js";
import { filterConsoleCookies, matchConsoleTab } from "../lib/bridge-client.js";
import { updateEnvFile, ReloginFlow } from "../lib/relogin.js";
import { readConsoleCookie, fetchServiceQuotas } from "../lib/gateway.js";
import { HarnessBudget } from "../lib/budget.js";
import {
  registerEquityMcp,
  shouldMountService,
  equityUnitsForDispatch,
  filterMcpShadowedBuiltins,
} from "../lib/mcp-equity.js";
import {
  download,
  isPrivateHostLiteral,
  upgradeAliyuncsHttps,
  extractMcpImages,
  registerMediaTools,
} from "../lib/media-tools.js";
import { probeModelCapabilities, clearProbeCache } from "../lib/capability-probe.js";
import { CatalogFeed } from "../lib/catalog-feed.js";
import { isolateHome } from "./home.mjs";

function sse(events) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("")).body;
}
async function collect(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

// ---------------------------------------------------------------------------
// Shared #1: route-guard.js
// ---------------------------------------------------------------------------

test("Shared #1: route-guard enforces loopback remoteAddress, rejects wildcard bind, tightens sec-fetch-site & malformed headers, supports bare IPv6 bind", () => {
  const BIND = "127.0.0.1";
  // Loopback remoteAddress allowed; non-loopback rejected even with loopback Host.
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.1.2.3"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.5"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.5"), false);
  assert.equal(
    trustedRouteRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:49419" } }, BIND),
    true,
  );
  assert.equal(
    trustedRouteRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" }, headers: { host: "127.0.0.1:49419" } }, BIND),
    true,
  );
  assert.equal(
    trustedRouteRequest({ socket: { remoteAddress: "192.168.1.5" }, headers: { host: "127.0.0.1:49419" } }, BIND),
    false,
    "non-loopback remoteAddress must be rejected",
  );
  assert.equal(
    trustedRouteRequest({ socket: { remoteAddress: "" }, headers: { host: "127.0.0.1:49419" } }, BIND),
    false,
  );

  // Wildcard bind hosts: non-loopback Host/peer rejected, but loopback 127.0.0.1 still allowed.
  assert.equal(trustedRouteRequest({ headers: { host: "0.0.0.0:49419" } }, "0.0.0.0"), false);
  assert.equal(trustedRouteRequest({ headers: { host: "[::]:49419" } }, "::"), false);
  assert.equal(trustedRouteRequest({ headers: { host: "192.168.1.5:49419" } }, "0.0.0.0"), false);
  assert.equal(trustedRouteRequest({ socket: { remoteAddress: "192.168.1.5" }, headers: { host: "127.0.0.1:49419" } }, "0.0.0.0"), false);
  assert.equal(trustedRouteRequest({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:49419" } }, "0.0.0.0"), true);
  assert.equal(trustedRouteRequest({ socket: { remoteAddress: "::1" }, headers: { host: "127.0.0.1:49419" } }, "::"), true);

  // sec-fetch-site: array rejected, same-site without Origin rejected, none rejected on POST / allowed on GET & HEAD.
  assert.equal(
    trustedRouteRequest({ headers: { host: "127.0.0.1:49419", "sec-fetch-site": ["same-origin"] } }, BIND),
    false,
  );
  assert.equal(
    trustedRouteRequest({ method: "GET", headers: { host: "127.0.0.1:49419", "sec-fetch-site": "same-site" } }, BIND),
    false,
    "same-site without Origin must be rejected",
  );
  assert.equal(
    trustedRouteRequest({ method: "POST", headers: { host: "127.0.0.1:49419", "sec-fetch-site": "none" } }, BIND),
    false,
    "sec-fetch-site: none must be rejected on mutating POST",
  );
  assert.equal(
    trustedRouteRequest({ method: "GET", headers: { host: "127.0.0.1:49419", "sec-fetch-site": "none" } }, BIND),
    true,
  );
  assert.equal(
    trustedRouteRequest({ method: "HEAD", headers: { host: "127.0.0.1:49419", "sec-fetch-site": "none" } }, BIND),
    true,
  );

  // Malformed Host/Origin with @, /, ?, #, whitespace rejected.
  for (const badHost of [
    "evil.com@127.0.0.1:49419",
    "127.0.0.1:49419/path",
    "127.0.0.1:49419?q=1",
    "127.0.0.1:49419#frag",
    "127.0.0.1:49419 extra",
  ]) {
    assert.equal(hostnameOf(badHost), null, `malformed host ${badHost}`);
    assert.equal(trustedRouteRequest({ headers: { host: badHost } }, BIND), false);
  }
  for (const badOrigin of [
    "http://user@127.0.0.1:49419",
    "http://127.0.0.1:49419/path",
    "http://127.0.0.1:49419?a=1",
    "http://127.0.0.1:49419#x",
  ]) {
    assert.equal(trustedRouteRequest({ headers: { host: "127.0.0.1:49419", origin: badOrigin } }, BIND), false);
  }

  // Bare IPv6 bind host (e.g. fd00::1) wrapped in brackets inside bindHostname().
  assert.equal(
    trustedRouteRequest({ headers: { host: "[fd00::1]:49419", origin: "http://[fd00::1]:49419", "sec-fetch-site": "same-origin" } }, "fd00::1"),
    true,
  );
});

// ---------------------------------------------------------------------------
// Shared #2: proxy.js
// ---------------------------------------------------------------------------

test("Shared #2: redactProxyUrl rejects opaque schemes and strips query/hash without leaking secrets", () => {
  assert.equal(redactProxyUrl("user:secret@proxy.local:8080"), null);
  assert.equal(redactProxyUrl("http:user:secret@proxy.local"), null);
  assert.equal(redactProxyUrl("socks5://user:secret@proxy.local:1080"), null);
  assert.equal(redactProxyUrl("http://user:secret@proxy.local:8080/p?token=abc#h"), "http://***@proxy.local:8080/p");
  assert.equal(redactProxyUrl("https://proxy.local:8443/?k=v#x"), "https://proxy.local:8443/");

  const warns = [];
  const fn = createProxyFetch({
    proxy: "user:supersecret@proxy.local:8080",
    logger: { warn: (m) => warns.push(String(m)) },
  });
  assert.equal(fn, globalThis.fetch);
  assert.equal(warns.length, 1);
  assert.ok(!warns[0].includes("supersecret"), "plaintext password must never be logged");
});

// ---------------------------------------------------------------------------
// Shared #3: index.js retryPolicy includes STREAM_CLOSED
// ---------------------------------------------------------------------------

test("Shared #3: Config default retryPolicy includes STREAM_CLOSED alongside DSH defaults", () => {
  const cfg = Config({});
  assert.deepEqual(cfg.retryPolicy.retryableCodes, [
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
    "STREAM_CLOSED",
  ]);
});

// ---------------------------------------------------------------------------
// Shared #4: responses-sse.js empty call_id & late backfill in output_item.done
// ---------------------------------------------------------------------------

test("Shared #4: responses-sse falls back on empty call_id and backfills late call_id/name on output_item.done", async () => {
  const chunks = await collect(responsesToDshChunks(sse([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "", id: "fc_fallback", name: "", arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "", id: "fc_fallback", name: "late_fn", arguments: '{"a":1}' } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "", id: "", name: "", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"b":2}' },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_late_real", name: "second_fn", arguments: '{"b":2}' } },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ])));
  const ends = chunks.filter((c) => c.type === "block-end").map((c) => c.block);
  assert.equal(ends[0].id, "fc_fallback");
  assert.equal(ends[0].name, "late_fn");
  assert.equal(ends[1].id, "call_late_real");
  assert.equal(ends[1].name, "second_fn");
});

// ---------------------------------------------------------------------------
// Shared #5 & Medium: chat.js finish_reason & parallel same-index tool_calls
// ---------------------------------------------------------------------------

test("Shared #5 & Medium chat.js: function_call / stop-with-tools map to tool-calls; same-index different-id calls do not collide", async () => {
  const c1 = await collect(chatToDshChunks(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "fn_a", arguments: '{"x":1}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "function_call" }] },
  ])));
  assert.deepEqual(c1.at(-1), { type: "finish", reason: { kind: "tool-calls" } });

  const c2 = await collect(chatToDshChunks(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "fn_a", arguments: '{"x":1}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_2", function: { name: "fn_b", arguments: '{"y":2}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ])));
  const blocks = c2.filter((c) => c.type === "block-end").map((c) => c.block);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => [b.id, b.name, JSON.parse(b.arguments)]), [
    ["call_1", "fn_a", { x: 1 }],
    ["call_2", "fn_b", { y: 2 }],
  ]);
  assert.deepEqual(c2.at(-1), { type: "finish", reason: { kind: "tool-calls" } });
});

// ---------------------------------------------------------------------------
// Q-H1 & Medium: bridge-client.js domain/expiry/injection filter & findConsoleTab
// ---------------------------------------------------------------------------

test("Q-H1 & Medium bridge-client: strict cookie filtering and exact console tab matching", () => {
  const now = 1_800_000_000_000;
  const future = Math.floor((now + 60_000) / 1000);
  const past = Math.floor((now - 60_000) / 1000);
  const cookie = filterConsoleCookies([
    { name: "evil_session", value: "leak", domain: ".google.com", expires: future },
    { name: "spoof", value: "x", domain: "qianwenai.com.evil.com", expires: future },
    { name: "other_sub", value: "x", domain: "other.qianwenai.com", expires: future },
    { name: "expired_tk", value: "old", domain: ".qianwenai.com", expires: past },
    { name: "bad\r\nname", value: "x", domain: ".qianwenai.com", expires: future },
    { name: "bad_val", value: "a; b\r\nX-Inject: 1", domain: ".qianwenai.com", expires: future },
    { name: "login_qianwenai_ticket", value: "parent_tk", domain: ".qianwenai.com", expires: -1 },
    { name: "login_qianwenai_ticket", value: "exact_tk", domain: "platform-home.qianwenai.com", expires: future },
    { name: "cna", value: "abc", domain: "cs-data.qianwenai.com", expires: future },
  ], now);
  assert.equal(cookie, "login_qianwenai_ticket=exact_tk; cna=abc");

  // Expired login ticket must return null.
  assert.equal(
    filterConsoleCookies([{ name: "login_qianwenai_ticket", value: "old", domain: ".qianwenai.com", expires: past }], now),
    null,
  );

  // matchConsoleTab rejects spoofed prefix host and non-numeric IDs.
  assert.equal(matchConsoleTab([
    { id: 1, url: "https://platform-home.qianwenai.com.evil.example/analytics" },
    { id: "not-a-num", url: "https://platform-home.qianwenai.com/analytics" },
    { id: null, url: "https://platform-home.qianwenai.com/analytics" },
  ]), null);
  assert.equal(matchConsoleTab([
    { id: 1, url: "https://platform-home.qianwenai.com.evil.example/analytics" },
    { id: 42, url: "https://platform-home.qianwenai.com/analytics/token-plan/individual" },
  ]), 42);
});

// ---------------------------------------------------------------------------
// Q-H2 & Q-H3: relogin.js stale cookie ignore in #tick + updateEnvFile safety
// ---------------------------------------------------------------------------

test("Q-H2: ReloginFlow #tick ignores stale initial cookie/ticket and keeps login tab open until fresh ticket arrives", async () => {
  const { home, restore } = isolateHome("qtpf-qh2-");
  try {
    fs.mkdirSync(path.join(home, ".dsh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".dsh", ".env"), "TEST_CK=cna=1; login_qianwenai_ticket=stale_tk\n");
    let currentHarvest = "cna=2; login_qianwenai_ticket=stale_tk"; // same stale ticket
    let pendingTick = null;
    let closed = 0;
    const bridge = {
      available: () => true,
      open: async () => 55,
      close: async () => { closed += 1; },
      hasTab: async () => true,
      findConsoleTab: async () => 55,
      harvestCookie: async () => currentHarvest,
      launch: async () => true,
    };
    const ctx = { timeout: (fn) => { pendingTick = fn; return () => { pendingTick = null; }; } };
    const flow = new ReloginFlow({ ctx, cookieEnv: "TEST_CK", bridge, now: () => 1_800_000_000_000 });
    const started = await flow.start({ auto: false });
    assert.equal(started.ok, true);
    assert.equal(started.tabId, 55);

    // First poll returns same stale ticket -> must NOT close tab or finish!
    const tick1 = pendingTick;
    pendingTick = null;
    tick1();
    await new Promise((r) => setImmediate(r));
    assert.equal(flow.state().state, "waiting", "stale ticket must not complete login");
    assert.equal(closed, 0, "login tab must stay open while ticket is stale");
    assert.ok(pendingTick, "must re-arm poll");

    // User finishes login -> brand new ticket arrives -> persists & closes tab.
    currentHarvest = "cna=2; login_qianwenai_ticket=fresh_tk";
    const tick2 = pendingTick;
    pendingTick = null;
    tick2();
    await new Promise((r) => setImmediate(r));
    assert.equal(flow.state().state, "success");
    assert.equal(closed, 1);
    assert.match(fs.readFileSync(path.join(home, ".dsh", ".env"), "utf8"), /login_qianwenai_ticket=fresh_tk/);

    // Also verify #readLocalCookie resolves via ctx.get("credentials") with credentialRef() when .env lacks it.
    let resolvedRef = null;
    let pendingTickCred = null;
    const credCtx = {
      timeout: (fn) => { pendingTickCred = fn; return () => { pendingTickCred = null; }; },
      get: (name) => (name === "credentials" ? {
        resolve: async (ref) => {
          resolvedRef = ref;
          return { value: "cna=1; login_qianwenai_ticket=cred_stale_tk" };
        },
      } : undefined),
    };
    let credHarvest = "cna=2; login_qianwenai_ticket=cred_stale_tk";
    const flowCred = new ReloginFlow({
      ctx: credCtx,
      cookieEnv: "TEST_CK_CRED_ONLY",
      bridge: { ...bridge, harvestCookie: async () => credHarvest, close: async () => {} },
      now: () => 1_800_000_000_000,
    });
    const startedCred = await flowCred.start({ auto: false });
    assert.equal(startedCred.ok, true);
    assert.equal(resolvedRef, "TEST_CK_CRED_ONLY", "must resolve via ctx.get('credentials').resolve(credentialRef(...))");
    const tCred = pendingTickCred;
    pendingTickCred = null;
    tCred();
    await new Promise((r) => setImmediate(r));
    assert.equal(flowCred.state().state, "waiting", "stale ticket from credential service must not complete login");
    flowCred.dispose();
  } finally {
    restore();
  }
});

test("Q-H3: updateEnvFile rethrows non-ENOENT read errors, validates envName, and deduplicates lines", () => {
  const { home, restore } = isolateHome("qtpf-qh3-");
  try {
    const dshDir = path.join(home, ".dsh");
    const envFile = path.join(dshDir, ".env");
    fs.mkdirSync(dshDir, { recursive: true });

    // Invalid envName rejected.
    assert.throws(() => updateEnvFile("BAD.*NAME", "v"), /非法/);

    // Duplicate lines all collapsed into one.
    fs.writeFileSync(envFile, "KEEP=1\nMY_KEY=old1\nOTHER=2\nexport MY_KEY=old2\n");
    updateEnvFile("MY_KEY", "new_val");
    const content = fs.readFileSync(envFile, "utf8");
    assert.equal(content.match(/MY_KEY=/g)?.length, 1);
    assert.match(content, /^KEEP=1$/m);
    assert.match(content, /^OTHER=2$/m);
    assert.match(content, /^MY_KEY=new_val$/m);

    // Non-ENOENT error (making .env a directory -> EISDIR) must throw, never wipe!
    fs.unlinkSync(envFile);
    fs.mkdirSync(envFile);
    assert.throws(() => updateEnvFile("MY_KEY", "v"), (err) => err?.code === "EISDIR");
    assert.equal(fs.statSync(envFile).isDirectory(), true);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Q-H4 & Q-H5: gateway.js matching quote strip & callOpenApi logical errors
// ---------------------------------------------------------------------------

test("Q-H4: readConsoleCookie strips only matching outer quote pairs", () => {
  const { home, restore } = isolateHome("qtpf-qh4-");
  const prev = process.env.TEST_Q_COOKIE;
  delete process.env.TEST_Q_COOKIE;
  try {
    const dshDir = path.join(home, ".dsh");
    fs.mkdirSync(dshDir, { recursive: true });
    // Unquoted RFC 6265 cookie ending in a quote must NOT lose its trailing quote.
    fs.writeFileSync(path.join(dshDir, ".env"), 'TEST_Q_COOKIE=a=1; b="quoted"\n');
    assert.equal(readConsoleCookie("TEST_Q_COOKIE"), 'a=1; b="quoted"');
    // Matching outer quotes ARE stripped.
    fs.writeFileSync(path.join(dshDir, ".env"), 'TEST_Q_COOKIE="a=1; b=2"\n');
    assert.equal(readConsoleCookie("TEST_Q_COOKIE"), "a=1; b=2");
    fs.writeFileSync(path.join(dshDir, ".env"), "TEST_Q_COOKIE='a=1; b=2'\n");
    assert.equal(readConsoleCookie("TEST_Q_COOKIE"), "a=1; b=2");
  } finally {
    if (prev !== undefined) process.env.TEST_Q_COOKIE = prev;
    restore();
  }
});

test("Q-H5: fetchServiceQuotas throws on HTTP 200 logical errors and non-array templates", async () => {
  const mkFetch = (openApiBody) => async (url) => {
    if (String(url).includes("user/info.json")) {
      return Response.json({ data: { secToken: "tok" } });
    }
    return Response.json(openApiBody);
  };
  await assert.rejects(
    fetchServiceQuotas({ cookie: "c=1", fetchImpl: mkFetch({ success: false, message: "NotLogin", data: {} }) }),
    /返回失败|NotLogin/,
  );
  await assert.rejects(
    fetchServiceQuotas({ cookie: "c=1", fetchImpl: mkFetch({ code: "200", data: { Success: false, Code: "AuthFailed", Message: "expired" } }) }),
    /AuthFailed|expired/,
  );
  await assert.rejects(
    fetchServiceQuotas({ cookie: "c=1", fetchImpl: mkFetch({ code: "200", data: { Data: { notAnArray: true } } }) }),
    /非数组/,
  );
});

// ---------------------------------------------------------------------------
// Q-H6 & Medium: budget.js cross-instance usedAtFetch, periodAnchor===0,
//                setTierFallback preservation, setTier rollover, serviceQuotasFresh
// ---------------------------------------------------------------------------

test("Q-H6 & Medium budget.js: cross-instance usedAtFetch alignment, periodAnchor===0 merge, setTierFallback/setTier, serviceQuotasFresh", (t) => {
  const { home, restore } = isolateHome("qtpf-qh6-");
  t.after(restore);
  const filePath = path.join(home, ".dsh", "budget.json");
  const now = Date.now();
  const DAY = 86_400_000;

  // 1) Cross-instance setEquities / setServiceQuotas must align usedAtFetch to merged counters (no double-counting).
  const a = new HarnessBudget({ filePath });
  const b = new HarnessBudget({ filePath });
  a.setTier({ specCode: "pro", usage: { per1MonthPercentage: 0.1, per1MonthResetTime: now + 20 * DAY }, fetchedAt: now });
  b.record("search_pro", 5); // disk byEquity.search_pro = 5; a still has 0 in memory
  a.setEquities([{ key: "search_pro", unit: "次", available: 495, total: 500 }]);
  assert.equal(a.equityState("search_pro").remaining, 495, "must not double-count disk calls as sinceFetch");
  assert.equal(a.equityState("search_pro").sinceFetch, 0);
  // Subsequent record after fetch still decrements properly.
  a.record("search_pro", 1);
  assert.equal(a.equityState("search_pro").remaining, 494);

  // Same for Layer 1 service quotas.
  b.setServiceQuotas([{ key: "tts", unit: "字符", available: 9000, total: 10000, expiresAt: now + 20 * DAY }]);
  b.record("tts", 100); // disk byService.tts = 100
  a.setServiceQuotas([{ key: "tts", unit: "字符", available: 8900, total: 10000, expiresAt: now + 20 * DAY }]);
  assert.equal(a.serviceQuotaState("tts").remaining, 8900, "L1 must not double-count disk calls");
  assert.equal(a.status().serviceQuotasFresh, true);

  // 2) periodAnchor === 0 instance calling setEquities must NOT lose its fresh equities snapshot to disk.
  const filePath2 = path.join(home, ".dsh", "budget2.json");
  const x = new HarnessBudget({ filePath: filePath2 });
  const y = new HarnessBudget({ filePath: filePath2 }); // y has periodAnchor === 0
  x.setTier({ specCode: "standard", usage: { per1MonthPercentage: 0, per1MonthResetTime: now + 15 * DAY }, fetchedAt: now });
  y.setEquities([{ key: "image_generation", unit: "张", available: 12, total: 20 }]);
  assert.equal(y.equityState("image_generation").remaining, 12, "fresh equities from unanchored instance must survive merge");
  assert.equal(y.status().usage.periodAnchor, now + 15 * DAY, "must adopt non-zero anchor from disk");

  // 3) setTierFallback preserves previous pro specCode when config.tier === 'auto'.
  const filePath3 = path.join(home, ".dsh", "budget3.json");
  const autoB = new HarnessBudget({ config: { tier: "auto" }, filePath: filePath3 });
  autoB.setTier({ specCode: "pro", usage: { per1MonthPercentage: 0.2, per1MonthResetTime: now + 10 * DAY }, fetchedAt: now });
  autoB.setTierFallback("transient network error");
  assert.equal(autoB.status().tier.specCode, "pro", "auto fallback must preserve previous known tier");

  // 4) setTier advancing past previous estimated anchor by > ANCHOR_JITTER_MS clears byEquity & stale equities.
  const filePath4 = path.join(home, ".dsh", "budget4.json");
  fs.mkdirSync(path.dirname(filePath4), { recursive: true });
  fs.writeFileSync(filePath4, JSON.stringify({
    periodAnchor: now + 2 * DAY,
    periodAnchorSource: "estimated",
    byEquity: { search_pro: 80 },
    equities: [{ key: "search_pro", unit: "次", available: 0, total: 100 }],
    equitiesFetchedAt: now,
    equityUsedAtFetch: { search_pro: 80 },
  }));
  const rollB = new HarnessBudget({ filePath: filePath4 });
  rollB.setTier({ specCode: "standard", usage: { per1MonthPercentage: 0, per1MonthResetTime: now + 30 * DAY }, fetchedAt: now });
  assert.equal(rollB.equityState("search_pro").source, "local");
  assert.equal(rollB.equityState("search_pro").remaining, 100, "advancing into next cycle must clear old byEquity and stale equities");
});

// ---------------------------------------------------------------------------
// Q-H7 & Medium: mcp-equity.js guard denial, L1 awareness, rearmSeq, aliases, hostStatusOf
// ---------------------------------------------------------------------------

test("Q-H7 & Medium mcp-equity: guard denies over-quota, L1 keeps service mounted, rearmSeq prevents race, aliases & hostStatusOf error", async () => {
  // Aliases in equityUnitsForDispatch
  assert.equal(equityUnitsForDispatch("tts", { input: "hello" }), 5);
  assert.equal(equityUnitsForDispatch("tts", { content: "你好世界" }), 4);
  assert.equal(equityUnitsForDispatch("tts", { prompt: "abc" }), 3);
  assert.equal(equityUnitsForDispatch("tts", { sentence: "12" }), 2);
  assert.equal(equityUnitsForDispatch("image_generation", { count: 3 }), 3);
  assert.equal(equityUnitsForDispatch("image_generation", { num_images: 2 }), 2);
  assert.equal(equityUnitsForDispatch("image_generation", { image_count: 4 }), 4);
  assert.equal(equityUnitsForDispatch("image_generation", { batch_size: 2 }), 2);

  // shouldMountService respects Layer 1 even if Layer 2 is 0.
  assert.equal(
    shouldMountService("TextGenerateImage", { image_generation: { remaining: 0 } }, { image_generation: { remaining: 5 } }),
    true,
  );
  assert.equal(
    shouldMountService("TextGenerateImage", { image_generation: { remaining: 0 } }, { image_generation: { remaining: 0 } }),
    false,
  );

  // Guard denial + L1+L2 combined capacity + hostStatusOf error handling + rearmSeq race.
  const guards = [];
  const recorded = [];
  let listThrows = false;
  let resolveCount = 0;
  let resolveSlow;
  let keyVal = null;
  const registered = new Map();
  const ctx = {
    get(name) {
      if (name === "mcpManager") {
        return {
          register(service) { registered.set(service, true); return () => registered.delete(service); },
          list() {
            if (listThrows) throw new Error("manager crash");
            return [...registered.keys()].map((n) => ({ name: n, status: { state: "connected" } }));
          },
        };
      }
      if (name === "tools") return { guard: (fn) => { guards.push(fn); return () => {}; }, definitions: () => [] };
      if (name === "credentials") {
        return {
          resolve: () => {
            resolveCount += 1;
            if (resolveCount === 1) return new Promise((r) => { resolveSlow = () => r(undefined); });
            return Promise.resolve(keyVal ? { value: keyVal } : undefined);
          },
        };
      }
      return undefined;
    },
    on: () => () => {},
  };
  const state = { l1: { tts: 10 }, l2: { tts: 0, search_pro: 1 } };
  const budget = {
    enabled: true,
    equityState: (k) => (state.l2[k] == null ? undefined : { key: k, remaining: state.l2[k], quota: 100, used: 100 - state.l2[k] }),
    serviceQuotaState: (k) => (state.l1[k] == null ? undefined : { key: k, remaining: state.l1[k], quota: 100, used: 100 - state.l1[k] }),
    record: (k, u) => {
      recorded.push([k, u]);
      const onL1 = Math.min(u, state.l1[k] ?? 0);
      if (state.l1[k] != null) state.l1[k] -= onL1;
      if (state.l2[k] != null) state.l2[k] = Math.max(0, state.l2[k] - (u - onL1));
    },
  };
  const mcp = registerEquityMcp(ctx, { budget });
  // Initial rearm() #1 is hanging with slow resolve -> now key arrives and rearm() #2 runs first.
  keyVal = "sk-fresh";
  await mcp.rearm();
  assert.equal(mcp.status().keyPresent, true);
  assert.equal(mcp.usesEquity("tts"), true, "L1 remaining > 0 must keep tts active even when L2 is 0");
  // Now let slow stale rearm #1 resolve with undefined -> MUST NOT clobber keyPresent!
  resolveSlow();
  await new Promise((r) => setImmediate(r));
  assert.equal(mcp.status().keyPresent, true, "stale probeKey must not overwrite keyPresent=true");

  // Guard denies over-quota TTS (needs 20 > freeCapacity 10) without recording.
  const guard = guards[0];
  const denied = guard({ name: "mcp__TextGenerateSpeech__tts", callId: "t1", arguments: { input: "x".repeat(20) } });
  assert.ok(denied && typeof denied.reason === "string", "over-quota dispatch must be denied");
  assert.equal(recorded.length, 0, "denied call must not be recorded");

  // Guard allows within L1 capacity (10 <= 10).
  assert.equal(guard({ name: "mcp__TextGenerateSpeech__tts", callId: "t2", arguments: { input: "x".repeat(10) } }), undefined);
  assert.deepEqual(recorded, [["tts", 10]]);
  // Next call sees freeCapacity 0 -> denied AND schedules microtask refresh() to unmount exhausted service!
  assert.ok(guard({ name: "mcp__TextGenerateSpeech__tts", callId: "t3", arguments: { input: "a" } })?.reason);
  await Promise.resolve();
  assert.equal(registered.has("TextGenerateSpeech"), false, "exhausted MCP service must be unmounted on microtask after guard denial");

  // hostStatusOf catch returns "error" -> service NOT ready -> built-in NOT shadowed.
  listThrows = true;
  assert.equal(mcp.readyServices().length, 0);
  assert.deepEqual(
    filterMcpShadowedBuiltins(["web_search"], mcp, [{ name: "mcp__EnhancedSearch__search" }]).tools,
    ["web_search"],
  );
  mcp.dispose();
});

// ---------------------------------------------------------------------------
// Q-H7 (media-tools reservations), Q-H8 & Medium SSRF/redirect
// ---------------------------------------------------------------------------

test("Q-H7/Q-H8 & Medium media-tools: concurrent reservations, download validation, extractMcpImages, aliyuncs https, SSRF", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qtpf-qh8-"));
  t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  try {
    // Medium SSRF gaps
    for (const host of ["0.0.0.1", "240.0.0.1", "sub.localhost", "sub.localhost.", "ff02::1", "64:ff9b::1.2.3.4", "::ffff:0:127.0.0.1"]) {
      assert.equal(isPrivateHostLiteral(host), true, `SSRF must block ${host}`);
    }

    // upgradeAliyuncsHttps clears :80 and leaves non-aliyuncs alone
    assert.equal(
      upgradeAliyuncsHttps("http://bucket.oss-cn-beijing.aliyuncs.com:80/a.png?Expires=1"),
      "https://bucket.oss-cn-beijing.aliyuncs.com/a.png?Expires=1",
    );
    assert.equal(upgradeAliyuncsHttps("http://evil.example/a.png"), "http://evil.example/a.png");

    // download() rejects non-media Content-Type, 0 bytes, HTML/JSON error pages, and cancels body on bad redirect
    await assert.rejects(
      download(async () => new Response("<html>err</html>", { status: 200, headers: { "content-type": "text/html" } }), "https://cdn.test/a.png", dir, "p", "png"),
      /不是媒体文件/,
    );
    await assert.rejects(
      download(async () => new Response('{"error":"no"}', { status: 200, headers: { "content-type": "application/json" } }), "https://cdn.test/a.png", dir, "p", "png"),
      /不是媒体文件/,
    );
    await assert.rejects(
      download(async () => new Response("", { status: 200, headers: { "content-type": "image/png" } }), "https://cdn.test/a.png", dir, "p", "png"),
      /0 字节/,
    );
    await assert.rejects(
      download(async () => new Response("<!DOCTYPE html><html>403</html>", { status: 200, headers: { "content-type": "image/png" } }), "https://cdn.test/a.png", dir, "p", "png"),
      /错误页/,
    );
    await assert.rejects(
      download(async () => new Response('{"Code":"AccessDenied","Message":"expired"}', { status: 200, headers: { "content-type": "application/octet-stream" } }), "https://cdn.test/a.png", dir, "p", "png"),
      /错误页/,
    );
    await assert.rejects(
      download(async () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200, headers: { "content-type": "image/png", "content-length": "1024" } }), "https://cdn.test/trunc.png", dir, "p", "png"),
      /截断|Content-Length/,
    );

    let redirectBodyCancelled = false;
    await assert.rejects(
      download(async () => ({
        status: 302,
        ok: false,
        headers: { get: (k) => (String(k).toLowerCase() === "location" ? "http://127.0.0.1/secret" : null) },
        body: { cancel: async () => { redirectBodyCancelled = true; } },
      }), "https://cdn.test/r.png", dir, "p", "png"),
      /非 https|本机\/内网/,
    );
    assert.equal(redirectBodyCancelled, true, "rejected redirect must cancel response.body");
    assert.deepEqual(await readdir(dir), [], "failed downloads must leave dir clean");

    // extractMcpImages: structuredContent first, ignores non-image URL fields, dedupes inline
    const extracted = extractMcpImages({
      structuredContent: {
        docs: "https://help.example/docs",
        image_url: "https://cdn.test/one.png",
      },
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "https://cdn.test/dup.png" },
      ],
    });
    assert.deepEqual(extracted.urls, ["https://cdn.test/one.png"]);
    assert.deepEqual(extracted.inline, []);

    // Concurrent reservation test for imageTool & speechTool
    const defs = [];
    const ctx = {
      tools: { register: (def) => { defs.push(def); return () => {}; } },
      get: (n) => (n === "workingDirectory" ? { ensure: async () => dir, defaultDirectory: () => dir } : undefined),
    };
    let releaseImg;
    let imgRem = 1;
    let ttsRem = 5;
    let mcpImgCalls = 0;
    let mcpTtsCalls = 0;
    const budget = {
      equityState: (k) => (k === "image_generation"
        ? { key: k, remaining: imgRem, quota: 20, used: 20 - imgRem, unit: "张" }
        : { key: k, remaining: ttsRem, quota: 100, used: 100 - ttsRem, unit: "字符" }),
      record: (k, u) => { if (k === "image_generation") imgRem -= u; if (k === "tts") ttsRem -= u; },
    };
    let releaseTts;
    const mcp = {
      usesEquity: () => true,
      refresh: () => {},
      callTool: async (service) => {
        if (service === "TextGenerateImage") {
          mcpImgCalls += 1;
          await new Promise((r) => { releaseImg = r; });
          return {
            tool: "img",
            value: {
              structuredContent: { image_url: "http://b.oss-cn-beijing.aliyuncs.com:80/pic.png" },
              content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
            },
          };
        }
        mcpTtsCalls += 1;
        await new Promise((r) => { releaseTts = r; });
        return { tool: "tts", value: { structuredContent: { result: "https://cdn.test/s.wav" } } };
      },
    };
    const fetchImpl = async (url) => {
      if (String(url).endsWith(".wav")) {
        return new Response(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(16)]), { status: 200, headers: { "content-type": "audio/wav" } });
      }
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200, headers: { "content-type": "image/png" } });
    };
    const dispose = registerMediaTools(ctx, {
      apiKeyEnv: "K", pluginName: "test",
      route: { endpoint: "https://api.test/responses", chatEndpoint: "https://api.test/chat", origin: "https://api.test" },
      imageModels: ["img"], videoModels: ["vid"], defaultImageModel: "img", defaultVideoModel: "vid",
      fetchImpl, budget, mcp,
    });
    const imageTool = defs.find((d) => d.name === "qwen_generate_image");
    const speechTool = defs.find((d) => d.name === "qwen_generate_speech");
    const exec = { agent: {}, signal: new AbortController().signal };

    // Parallel image calls with remaining=1: 2nd must be rejected by in-flight reservation!
    const pImg1 = imageTool.execute({ prompt: "a", n: 1 }, exec);
    await assert.rejects(imageTool.execute({ prompt: "b", n: 1 }, exec), /权益额度不足/);
    releaseImg();
    const imgRes = await pImg1;
    assert.equal(mcpImgCalls, 1);
    assert.equal(imgRes.count, 1, "urls preferred over inline: only 1 image saved");
    assert.equal(imgRes.urls[0], "https://b.oss-cn-beijing.aliyuncs.com/pic.png", "http aliyuncs image URL upgraded to https without :80");

    // Parallel TTS calls with remaining=5: 2nd must be rejected by in-flight reservation!
    const pTts1 = speechTool.execute({ text: "hello" }, exec);
    await assert.rejects(speechTool.execute({ text: "hi" }, exec), /权益额度不足/);
    releaseTts();
    await pTts1;
    assert.equal(mcpTtsCalls, 1);
    dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Q-H9 & Medium: capability-probe.js + index.js credential update & /refresh chaining
// ---------------------------------------------------------------------------

test("Q-H9 & Medium capability-probe: transient stream errors/[DONE]/bad JSON are incomplete; non-none effort preferred", async () => {
  for (const [label, body] of [
    ["rate_limit_exceeded", 'data: {"type":"error","error":{"code":"rate_limit_exceeded","message":"slow down"}}\n\n'],
    ["server_error", 'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"oops"}}}\n\n'],
    ["invalid_api_key", 'data: {"type":"error","error":{"code":"invalid_api_key","message":"bad key"}}\n\n'],
    ["bare DONE", "data: [DONE]\n\n"],
    ["bad JSON", "data: {not-json\n\n"],
  ]) {
    clearProbeCache();
    const res = await probeModelCapabilities(`qh9-${label}`, {
      endpoint: "https://example.invalid/responses",
      key: "sk",
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    assert.equal(res.incomplete, true, `${label} must be incomplete, not cached`);
  }

  // Non-"none" default effort preferred when "high" & "low" are absent (e.g. ["none", "xhigh"]).
  clearProbeCache();
  const res = await probeModelCapabilities("qh9-xhigh-only", {
    endpoint: "https://example.invalid/responses",
    key: "sk",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.reasoning && !["none", "xhigh"].includes(body.reasoning.effort)) {
        return { ok: false, status: 400, text: async () => "{}" };
      }
      return { ok: true, status: 200, text: async () => 'data: {"type":"response.created"}\n\n' };
    },
  });
  assert.deepEqual(res.reasoningEfforts, ["none", "xhigh"]);
  assert.equal(res.defaultReasoningEffort, "xhigh");
});

test("Q-H9 & Medium index.js: apiKeyEnv credential update re-probes site; POST /refresh chains feed.run() after refreshCatalog", async () => {
  const { home, restore } = isolateHome("qtpf-idx-");
  const prevFetch = globalThis.fetch;
  try {
    let activeKey = "sk-cn";
    const listeners = new Map();
    const cleanups = [];
    const registered = [];
    let routeHandler = null;
    const events = [];
    let finishCatalog;
    const catalogGate = new Promise((r) => { finishCatalog = r; });
    let holdNextCatalog = false;

    const entry = {
      options: {
        id: "llm-pi-ai",
        config: { providers: { qwentokenplan: { apiKeyEnv: "FEED_K", baseURL: "https://feed.invalid/v1", models: [] } } },
      },
    };
    const editor = {
      entries: () => [entry],
      edit: async (_e, fn) => { entry.options.config = fn(entry.options.config); },
    };

    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.startsWith("https://feed.invalid/")) {
        events.push("feed-fetch");
        return Response.json({ data: [{ id: "qwen3.8-flash" }] });
      }
      if (href.includes("cn-beijing") && href.endsWith("/models")) {
        if (activeKey === "sk-cn") {
          if (holdNextCatalog) {
            events.push("catalog-start");
            await catalogGate;
            events.push("catalog-end");
          }
          return Response.json({ data: [{ id: "qwen3.8-flash" }] });
        }
        return new Response("{}", { status: 401 });
      }
      if (href.includes("ap-southeast-1") && href.endsWith("/models")) {
        if (activeKey === "sk-intl") {
          return Response.json({ data: [{ id: "qwen3.8-flash" }] });
        }
        return new Response("{}", { status: 401 });
      }
      throw new TypeError("offline");
    };

    const credentials = {
      resolve: async (ref) => ({ value: ref === "FEED_K" ? "sk-feed" : activeKey }),
    };
    const ctx = {
      llm: {
        registerConfigurableProviders() {},
        registerAdapter: (_p, adapter) => { registered.push(adapter); return () => {}; },
        emitAdaptersUpdated() {},
      },
      effect: (fn) => cleanups.push(fn()),
      fiber: {},
      credentials,
      get: (n) => (n === "credentials" ? credentials
        : n === "configEditor" ? editor
          : n === "webServer" ? { host: "127.0.0.1", register: ({ handler }) => { routeHandler = handler; return () => {}; } }
            : undefined),
      on: (ev, fn) => {
        const list = listeners.get(ev) ?? [];
        list.push(fn);
        listeners.set(ev, list);
        return () => {};
      },
      timeout: () => () => {},
      interval: () => () => {},
      logger: { info() {}, warn() {}, debug() {} },
    };

    apply(ctx, Config({ mediaTools: false, proxy: "none", autoRelogin: false, mcpEquity: "off" }));
    await new Promise((r) => setTimeout(r, 50));
    const adapter = registered[0];
    assert.ok(adapter.endpoint.includes("cn-beijing"), "initially resolved to CN");

    // Hot-swap key to INTL -> emit credentials/reference-updated -> must re-probe and switch to INTL!
    activeKey = "sk-intl";
    for (const fn of listeners.get("credentials/reference-updated") ?? []) fn("QWEN_TOKEN_PLAN_CN_API_KEY");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(adapter.endpoint.includes("ap-southeast-1"), "must re-probe and retarget to INTL after key update");

    // Switch back to CN and verify POST /refresh runs feed.run() AFTER refreshCatalog().
    activeKey = "sk-cn";
    holdNextCatalog = true;
    events.length = 0;
    const req = { method: "POST", url: "/qwen-token-plan-full/refresh", headers: { host: "127.0.0.1:49419" } };
    const res = { writeHead() {}, end() {} };
    const refreshPromise = routeHandler(req, res);
    await new Promise((r) => setTimeout(r, 30));
    // Catalog is gated; feed MUST NOT have started yet!
    assert.ok(!events.includes("feed-fetch"), "feed.run() must wait for refreshCatalog() to settle");
    finishCatalog();
    await refreshPromise;
    assert.ok(events.indexOf("catalog-end") < events.indexOf("feed-fetch"), "feed-fetch must occur after catalog-end");

    for (const c of cleanups.reverse()) { try { c?.(); } catch {} }
  } finally {
    globalThis.fetch = prevFetch;
    restore();
  }
});

// ---------------------------------------------------------------------------
// Medium: adapter.js displayModel name & catalog-feed.js fixes
// ---------------------------------------------------------------------------

test("Medium adapter.js: displayModel uses model.name || model.id", async () => {
  const adapter = new QwenTokenPlanAdapter({
    ctx: { get: () => undefined },
    catalog: {
      snapshot: () => ({ models: [{ id: "qwen4-max", name: "Qwen4 Max Custom", transport: "responses", input: ["text"], harnessTools: [] }] }),
      find: (id) => (id === "qwen4-max" ? { id: "qwen4-max", name: "Qwen4 Max Custom", transport: "responses", input: ["text"], harnessTools: [] } : undefined),
    },
    providerId: "p", displayName: "d", apiKeyEnv: "K",
    endpoint: "https://example.invalid/responses",
    harnessMode: normalizeHarnessMode("none"), pluginName: "test",
  });
  const list = await adapter.listModels();
  assert.equal(list[0].name, "Qwen4 Max Custom");
  const resolved = await adapter.resolveModel("p", "qwen4-max");
  assert.equal(resolved.name, "Qwen4 Max Custom");
});

test("Medium catalog-feed.js: respects abort signal, guards deleted provider, tracks appliedEntries, maps alias->none to null", async () => {
  const { home, restore } = isolateHome("qtpf-cf-med-");
  const prevKey = process.env.CF_TEST_KEY;
  process.env.CF_TEST_KEY = "sk-test";
  try {
    // 1) Alias minimal -> none maps to null (not string "none"), and rejected requested is skipped.
    const specs = {
      "glm-5.2": {
        reasoning: true,
        reasoningEfforts: ["none", "low", "high"],
        reasoningAliases: { minimal: "none" },
        rejectedReasoningEfforts: ["medium"],
      },
    };
    let config = {
      providers: {
        qwentokenplan: { apiKeyEnv: "CF_TEST_KEY", baseURL: "https://gw.invalid/v1", models: [] },
      },
    };
    const entry = { options: { id: "llm-pi-ai", get config() { return config; } } };
    const editor = {
      entries: () => [entry],
      edit: async (_e, fn) => { config = fn(structuredClone(config)); },
    };
    const ctx = { get: (n) => (n === "configEditor" ? editor : undefined), logger: { info() {}, warn() {}, debug() {} } };
    const feed = new CatalogFeed({
      ctx, catalog: { find: (id) => specs[id] }, feedProvider: "qwentokenplan", pluginName: "test",
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "glm-5.2" }] }), { status: 200 }),
    });
    const r = await feed.run();
    assert.deepEqual(r.added, ["glm-5.2"]);
    const glm = config.providers.qwentokenplan.models.find((m) => m.id === "glm-5.2");
    assert.equal(glm.reasoningEfforts.minimal, null, "minimal aliased to none must map to null, not 'none'");
    assert.equal(glm.reasoningEfforts.medium, undefined);

    // 2) Provider deleted during /models fetch: must NOT create ghost provider!
    let ghostConfig = {
      providers: {
        qwentokenplan: { apiKeyEnv: "CF_TEST_KEY", baseURL: "https://gw.invalid/v1", models: [] },
      },
    };
    const ghostEntry = { options: { id: "llm-pi-ai", get config() { return ghostConfig; } } };
    const ghostEditor = {
      entries: () => [ghostEntry],
      edit: async (_e, fn) => {
        delete ghostConfig.providers.qwentokenplan;
        ghostConfig = fn(structuredClone(ghostConfig));
      },
    };
    const feed2 = new CatalogFeed({
      ctx: { get: (n) => (n === "configEditor" ? ghostEditor : undefined), logger: { info() {}, warn() {}, debug() {} } },
      catalog: { find: () => undefined },
      feedProvider: "qwentokenplan",
      pluginName: "test",
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "new-model-x" }] }), { status: 200 }),
    });
    const r2 = await feed2.run();
    assert.equal(ghostConfig.providers.qwentokenplan, undefined, "must not create a ghost provider");
    assert.deepEqual(r2.added, []);

    // 3) Aborted signal prevents editor.edit and returns cleanly.
    const ac = new AbortController();
    ac.abort();
    let edited = false;
    const feed3 = new CatalogFeed({
      ctx: { get: () => ({ entries: () => [entry], edit: async () => { edited = true; } }), logger: { info() {}, warn() {}, debug() {} } },
      catalog: { find: () => undefined },
      feedProvider: "qwentokenplan",
      pluginName: "test",
      signal: ac.signal,
      fetchImpl: async () => { throw new Error("should not fetch when aborted"); },
    });
    const r3 = await feed3.run();
    assert.deepEqual(r3.added, []);
    assert.equal(edited, false);
  } finally {
    if (prevKey === undefined) delete process.env.CF_TEST_KEY;
    else process.env.CF_TEST_KEY = prevKey;
    restore();
  }
});
