// 语音合成工具（qwen_generate_speech）回归：自动落盘 + 给文件（2026-11-24）。
// 全部离线：假 fetchImpl + mock node:dns + 临时目录；绝不打真实上游、不打印密钥。
// 覆盖：MCP 权益通道 → 下载 wav 落盘 → 返回本地路径；按字符记账；额度预检；未就绪报错；
//       音频 URL 提取与音色透传；落盘失败不回落（语音无付费回落通道）。
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMediaTools } from "../lib/media-tools.js";

// 真 WAV 头（RIFF....WAVE）+ 少量填充：落盘内容校验用，不是真实音频。
const fakeWav = (fill = 64) => Buffer.concat([
  Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WAVE"), Buffer.alloc(fill, 0),
]);

async function withTmpDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "qtpf-tts-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function makeCtx(dir) {
  const defs = [];
  const credentials = { resolve: async () => ({ value: "fixture" }) };
  const workingDirectory = { ensure: async () => dir, defaultDirectory: () => dir };
  return {
    defs,
    tools: { register: (def) => { defs.push(def); return () => {}; } },
    get: (name) => (name === "credentials" ? credentials : name === "workingDirectory" ? workingDirectory : undefined),
  };
}

function makeOpts(fetchImpl, extra = {}) {
  return {
    apiKeyEnv: "TEST_KEY", pluginName: "tts-test",
    route: { endpoint: "https://api.test", chatEndpoint: "https://api.test/chat", origin: "https://api.test" },
    imageModels: ["img"], videoModels: ["vid"], defaultImageModel: "img", defaultVideoModel: "vid",
    fetchImpl, logger: { info: () => {}, warn: () => {} },
    ...extra,
  };
}

const exec = () => ({ agent: {}, signal: new AbortController().signal });
const speechOf = (ctx) => ctx.defs.find((def) => def.name === "qwen_generate_speech");

function fakeDns(t, map = { "cdn.test": [{ address: "93.184.216.34", family: 4 }] }) {
  t.mock.method(dns.promises, "lookup", async (host) => {
    const hit = map[String(host).toLowerCase()];
    if (hit) return hit;
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  });
}

function capturingFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls.length); };
  impl.calls = calls;
  return impl;
}
const okWavResponse = () => new Response(fakeWav(16), { status: 200, headers: { "content-type": "audio/wav" } });

// 假 TTS MCP 通道：callTool 真走一遍 pick/buildArgs，覆盖「按上游 schema 匹配字段」。
// 默认返回宿主实测形状（2026-11-24）：content[].text 是 JSON 字符串
// {"result":"<wav URL>","request_id":…}，没有 structuredContent —— 回归真实失败案例。
function fakeTtsMcp({ state, audio = "https://cdn.test/a.wav", schema, calls = [], fail = null, toolName = "bailian_tts", value }) {
  const parameters = schema ?? { type: "object", properties: { text: { type: "string" }, voice: { type: "string" } } };
  return {
    usesEquity: (key) => key === "tts" && state().remaining > 0,
    callTool: async (service, exec, pick, buildArgs) => {
      const definition = { name: `mcp__TextGenerateSpeech__${toolName}`, parameters, execute: async () => {} };
      const chosen = pick([{ name: toolName }], [definition]);
      const args = buildArgs(chosen.definition.parameters, chosen.rawName);
      calls.push({ service, args });
      if (fail) throw fail;
      return { tool: chosen.rawName, value: value ?? { content: [{ type: "text", text: JSON.stringify({ result: audio, request_id: "req-1" }) }] } };
    },
  };
}

const ttsState = (remaining) => () => ({ key: "tts", used: 10000 - remaining, quota: 10000, remaining, unit: "字符", source: "official" });

test("S1 权益通道合成 → 下载 wav 落盘 → 返回本地路径，按字符记账", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const calls = [];
    const recorded = [];
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    const budget = { equityState: ttsState(10000), record: (key, count) => { recorded.push([key, count]); return null; } };
    registerMediaTools(ctx, makeOpts(fetchImpl, { budget, mcp: fakeTtsMcp({ state: ttsState(10000), calls }) }));
    const text = "今天天气真不错";
    const result = await speechOf(ctx).execute({ text, voice: "温柔女声" }, exec());
    assert.equal(result.model, "mcp:bailian_tts");
    assert.equal(result.characters, text.length);
    assert.equal(result.voice, "温柔女声");
    assert.ok(result.path.startsWith(dir), "音频必须落在工作目录内");
    assert.ok(result.path.endsWith(".wav"), `扩展名应为 wav，实际：${result.path}`);
    assert.equal(result.url, "https://cdn.test/a.wav");
    // 落盘内容是真 WAV 头。
    const buf = await readFile(result.path);
    assert.equal(buf.toString("ascii", 0, 4), "RIFF");
    assert.equal(buf.toString("ascii", 8, 12), "WAVE");
    // 上游收到正确的 text/voice 字段。
    assert.equal(calls[0].service, "TextGenerateSpeech");
    assert.equal(calls[0].args.text, text);
    assert.equal(calls[0].args.voice, "温柔女声");
    // 按字符记一次权益账（callTool 直调不经 guard，不会重复计数）。
    assert.deepEqual(recorded, [["tts", text.length]]);
    // 只发了下载请求，没有打任何模型生成端点。
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(fetchImpl.calls[0].url.includes("cdn.test"));
  });
});

test("S2 额度不足（剩 3 字符却请求 8 字符）在调用上游前就被拒，不记账不下载", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const calls = [];
    const recorded = [];
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    const budget = { equityState: ttsState(3), record: (key, count) => { recorded.push([key, count]); return null; } };
    registerMediaTools(ctx, makeOpts(fetchImpl, { budget, mcp: fakeTtsMcp({ state: ttsState(3), calls }) }));
    await assert.rejects(speechOf(ctx).execute({ text: "今天天气真不错" }, exec()), /仅剩 3 字符/);
    assert.equal(calls.length, 0, "额度不足不得先调上游");
    assert.equal(fetchImpl.calls.length, 0, "额度不足不得下载");
    assert.deepEqual(recorded, []);
  });
});

test("S3 权益通道未就绪（无 mcp）→ 明确报错，不打模型 API", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl)); // 无 mcp
    await assert.rejects(speechOf(ctx).execute({ text: "你好" }, exec()), /权益通道未就绪|按量付费/);
    assert.equal(fetchImpl.calls.length, 0, "语音没有模型 API 回落，不得发任何请求");
  });
});

test("S4 权益耗尽（remaining=0）→ usesEquity 假 → 报错而非偷偷花钱", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    const budget = { equityState: ttsState(0), record: () => null };
    registerMediaTools(ctx, makeOpts(fetchImpl, { budget, mcp: fakeTtsMcp({ state: ttsState(0) }) }));
    await assert.rejects(speechOf(ctx).execute({ text: "你好" }, exec()), /权益通道未就绪/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test("S5 空文本 / 超长文本被拒", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl, { mcp: fakeTtsMcp({ state: ttsState(10000) }) }));
    await assert.rejects(speechOf(ctx).execute({ text: "   " }, exec()), /text 不能为空/);
    await assert.rejects(speechOf(ctx).execute({ text: "字".repeat(20001) }, exec()), /text 过长/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test("S6 上游字段名按 schema 匹配（input/speaker 而非 text/voice）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const calls = [];
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    const schema = { type: "object", properties: { input: { type: "string" }, speaker: { type: "string" } } };
    registerMediaTools(ctx, makeOpts(fetchImpl, { mcp: fakeTtsMcp({ state: ttsState(10000), schema, calls, toolName: "text_to_speech" }) }));
    const result = await speechOf(ctx).execute({ text: "你好世界", voice: "沉稳男声" }, exec());
    assert.equal(calls[0].args.input, "你好世界");
    assert.equal(calls[0].args.speaker, "沉稳男声");
    assert.equal(result.model, "mcp:text_to_speech");
  });
});

test("S7 音频 URL 提取：优先带音频扩展名的，忽略同响应里的图片 URL", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    // 响应里混了一个 png 与一个 wav：应挑 wav。
    const mcp = {
      usesEquity: (key) => key === "tts",
      callTool: async () => ({ tool: "bailian_tts", value: { structuredContent: { cover: "https://cdn.test/cover.png", result: "https://cdn.test/voice.wav?x=1" } } }),
    };
    registerMediaTools(ctx, makeOpts(fetchImpl, { mcp }));
    const result = await speechOf(ctx).execute({ text: "你好" }, exec());
    assert.equal(result.url, "https://cdn.test/voice.wav?x=1");
    assert.ok(fetchImpl.calls[0].url.includes("voice.wav"));
  });
});

test("S8 落盘失败直接上抛、不回落；但合成已扣字符仍须记账（不留半截文件）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const recorded = [];
    const fetchImpl = capturingFetch(() => { throw new Error("download boom"); });
    const ctx = makeCtx(dir);
    const budget = { equityState: ttsState(10000), record: (key, count) => { recorded.push([key, count]); return null; } };
    registerMediaTools(ctx, makeOpts(fetchImpl, { budget, mcp: fakeTtsMcp({ state: ttsState(10000) }) }));
    await assert.rejects(speechOf(ctx).execute({ text: "你好" }, exec()), /download boom/);
    // 上游在合成成功即扣字符，与下载成败无关：下载失败也要记，否则本地账本少计。
    assert.deepEqual(recorded, [["tts", 2]], "合成已扣字符：下载失败仍须记账");
    assert.deepEqual(await readdir(dir), [], "失败后目录必须干净（无半截文件）");
  });
});

test("S9 不传 voice 时不向上游塞 voice 字段（用服务端默认）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const calls = [];
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl, { mcp: fakeTtsMcp({ state: ttsState(10000), calls }) }));
    const result = await speechOf(ctx).execute({ text: "你好" }, exec());
    assert.equal(calls[0].args.voice, undefined);
    assert.equal(result.voice, undefined);
  });
});

test("S11 http 的 aliyuncs OSS 结果 URL 升级 https 后放行（2026-11-24 实测回归）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    const httpUrl = "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/prod/cosyvoice-v3-flash/x.wav?Expires=1&Signature=abc%3D";
    const mcp = {
      usesEquity: () => true,
      callTool: async () => ({ tool: "bailian_tts", value: { content: [{ type: "text", text: JSON.stringify({ result: httpUrl }) }] } }),
    };
    registerMediaTools(ctx, makeOpts(fetchImpl, { mcp }));
    const result = await speechOf(ctx).execute({ text: "你好" }, exec());
    assert.equal(result.url, httpUrl.replace(/^http:/, "https:"), "OSS 域名应升级 https");
    assert.ok(fetchImpl.calls[0].url.startsWith("https://"));
    assert.ok(result.path.endsWith(".wav"));
  });
});

test("S12 非 aliyuncs 域名的 http URL 仍被安全闸拒绝（不放宽）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    const mcp = {
      usesEquity: () => true,
      callTool: async () => ({ tool: "bailian_tts", value: { content: [{ type: "text", text: JSON.stringify({ result: "http://cdn.test/a.wav" }) }] } }),
    };
    registerMediaTools(ctx, makeOpts(fetchImpl, { mcp }));
    await assert.rejects(speechOf(ctx).execute({ text: "你好" }, exec()), /非 https|https/);
    assert.equal(fetchImpl.calls.length, 0, "非 OSS 的 http 不得放行下载");
  });
});

test("S13 代理 fake-IP（198.18.0.0/15）解析放行：OSS https 结果可下载（2026-11-24 实测回归）", async (t) => {
  await withTmpDir(async (dir) => {
    // Clash/Surge fake-IP 模式把公网 OSS 域名解析到 198.18.x.x（基准保留段，非真实内网）。
    fakeDns(t, { "dashscope-result-bj.oss-cn-beijing.aliyuncs.com": [{ address: "198.18.3.56", family: 4 }] });
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    const httpsUrl = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/prod/x.wav?Expires=1&Signature=abc%3D";
    const mcp = {
      usesEquity: () => true,
      callTool: async () => ({ tool: "bailian_tts", value: { content: [{ type: "text", text: JSON.stringify({ result: httpsUrl }) }] } }),
    };
    registerMediaTools(ctx, makeOpts(fetchImpl, { mcp }));
    const result = await speechOf(ctx).execute({ text: "你好" }, exec());
    assert.ok(result.path.endsWith(".wav"), "fake-IP 段不应拦下合法 OSS 下载");
    assert.equal(fetchImpl.calls.length, 1);
  });
});

test("S10 宿主真实形状：content[].text 是 JSON 字符串也能提出 URL（2026-11-24 实测回归）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t);
    const fetchImpl = capturingFetch(() => okWavResponse());
    const ctx = makeCtx(dir);
    // 真实失败案例：URL 藏在 JSON 字符串里，且带转义引号收尾与查询串。
    const realUrl = "https://cdn.test/prod/cosyvoice-v3-flash/20261124/1257896666798445/8a31dcc0.wav?Expires=1795574405&OSSAccessKeyId=LTAItest&Signature=4h0DvPb8AzJA74Z3n4Yb2TtAAA0%3D";
    const mcp = {
      usesEquity: () => true,
      callTool: async () => ({
        tool: "bailian_tts",
        value: { content: [{ type: "text", text: `{"result":"${realUrl}","request_id":"req-real"}` }] },
      }),
    };
    registerMediaTools(ctx, makeOpts(fetchImpl, { mcp }));
    const result = await speechOf(ctx).execute({ text: "你好" }, exec());
    assert.equal(result.url, realUrl, "URL 必须完整、无尾部转义符");
    assert.ok(result.path.endsWith(".wav"));
    assert.equal(fetchImpl.calls[0].url, realUrl);
  });
});
