// 媒体工具安全/内存回归（2026-11-18 审计，缺陷 A–E）。
// 全部离线：假 fetchImpl + mock node:dns + 临时目录假文件；绝不打真实上游、绝不外发真实文件、不打印密钥。
//  seams：导出的 download / assertDownloadUrl / isPrivateHostLiteral，以及 tool.execute（公共边界）。
//  DNS 在 node:dns.promises.lookup 处 mock（外部依赖边界）；实现必须以属性访问方式调用它才能被替换。
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile, stat, chmod, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { download, assertDownloadUrl, isPrivateHostLiteral, registerMediaTools } from "../lib/media-tools.js";

const MB = 1024 * 1024;
const IMAGE_MAX = 10 * MB;
const VIDEO_MAX = 200 * MB;

// 真魔数假图（lead 要求：假 PNG 必须带真魔数，否则魔数校验测试无意义）。
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fakePng = (fill = 64) => Buffer.concat([PNG_SIG, Buffer.alloc(fill, 0)]);
const fakeJpeg = (fill = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(fill, 0)]);
const fakeWebp = (fill = 64) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WEBP"), Buffer.alloc(fill, 0)]);
// 假密钥内容：仅用于断言「不外发」，不是真实凭据，也绝不打印。
const FAKE_SECRET = "FAKE_SECRET=not-a-real-key-0123456789";

function tryGc() {
  // 无 --expose-gc 启动参数时借 v8 flag 临时拿 gc（仅测试进程内，量内存用）。
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc");
    v8.setFlagsFromString("--no-expose-gc");
    if (typeof gc === "function") { gc(); return true; }
  } catch { /* 拿不到就退化为不强制 gc */ }
  return false;
}

// 每个测试独立的临时工作目录；workingDirectory 必给，否则 resolveWorkDir 退回 process.cwd()
// 会把生成物拉进仓库根（历史上真发生过）。finally 里整目录删除。
async function withTmpDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "media-safety-"));
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
    apiKeyEnv: "TEST_KEY", pluginName: "media-safety-test",
    route: { endpoint: "https://api.test", chatEndpoint: "https://api.test/chat", origin: "https://api.test" },
    imageModels: ["img"], videoModels: ["vid"], defaultImageModel: "img", defaultVideoModel: "vid",
    fetchImpl, logger: { info: () => {} },
    ...extra,
  };
}

const exec = () => ({ agent: {}, signal: new AbortController().signal });

// 让出宏任务：mock.timers.tick 同步触发 setTimeout 回调后，轮询里的 fetch/json
// 等异步步骤需要真实事件循环推进才能跑完。
const flush = () => new Promise((r) => setImmediate(r));

// DNS mock：map[host] = [{address,family}]；未映射的 host 一律 ENOTFOUND（fail-closed 语义）。
function fakeDns(t, map = {}) {
  t.mock.method(dns.promises, "lookup", async (host) => {
    const hit = map[String(host).toLowerCase()];
    if (hit) return hit;
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  });
}
const PUBLIC_DNS = { "cdn.test": [{ address: "93.184.216.34", family: 4 }] };

// 假 fetch：记录所有请求（url + init），按 handler 返回 Response。绝不触网。
function capturingFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls.length); };
  impl.calls = calls;
  return impl;
}
const okPngResponse = () => new Response(fakePng(16), { status: 200, headers: { "content-type": "image/png" } });
const imageJsonResponse = (url = "https://cdn.test/r.png") =>
  Response.json({ choices: [{ message: { content: [{ type: "image", image: url }] } }] });

// ───────────────────────── 缺陷 A（P0）：referenceImage 任意文件外发 ─────────────────────────

test("A1 工作目录内的 .env 被拒绝，且任何上游请求体都不含其内容", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    await writeFile(join(dir, "secret.env"), FAKE_SECRET);
    const fetchImpl = capturingFetch((url) => (url.includes("generation") || url.includes("/chat") ? imageJsonResponse() : okPngResponse()));
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    await assert.rejects(
      ctx.defs[0].execute({ prompt: "p", referenceImage: join(dir, "secret.env") }, exec()),
      /扩展名|白名单|参考图/,
    );
    // 校验必须发生在 POST 之前：一个上游请求都不该发出。
    assert.equal(fetchImpl.calls.length, 0, "非法参考图不得触发任何上游请求");
    const b64 = Buffer.from(FAKE_SECRET).toString("base64");
    for (const c of fetchImpl.calls) assert.ok(!String(c.init?.body ?? "").includes(b64), "请求体不得含文件内容");
  });
});

test("A2 工作目录外的绝对路径（即便带真 PNG 魔数）被拒绝", async (t) => {
  await withTmpDir(async (dir) => {
    await withTmpDir(async (outside) => {
      fakeDns(t, PUBLIC_DNS);
      const victim = join(outside, "victim.png");
      await writeFile(victim, fakePng());
      const fetchImpl = capturingFetch(() => imageJsonResponse());
      const ctx = makeCtx(dir);
      registerMediaTools(ctx, makeOpts(fetchImpl));
      await assert.rejects(ctx.defs[0].execute({ prompt: "p", referenceImage: victim }, exec()), /工作目录/);
      assert.equal(fetchImpl.calls.length, 0);
    });
  });
});

test("A3 .. 穿越出工作目录被拒绝", async (t) => {
  await withTmpDir(async (dir) => {
    await withTmpDir(async (outside) => {
      fakeDns(t, PUBLIC_DNS);
      await writeFile(join(outside, "victim.png"), fakePng());
      const sub = join(dir, "sub");
      await mkdir(sub);
      const traversal = join(sub, "..", "..", outside.split("/").pop(), "victim.png");
      const fetchImpl = capturingFetch(() => imageJsonResponse());
      const ctx = makeCtx(dir);
      registerMediaTools(ctx, makeOpts(fetchImpl));
      await assert.rejects(ctx.defs[0].execute({ prompt: "p", referenceImage: traversal }, exec()), /工作目录/);
      assert.equal(fetchImpl.calls.length, 0);
    });
  });
});

test("A4 符号链接逃逸出工作目录被拒绝（realpath 收口）", async (t) => {
  await withTmpDir(async (dir) => {
    await withTmpDir(async (outside) => {
      fakeDns(t, PUBLIC_DNS);
      const victim = join(outside, "victim.png");
      await writeFile(victim, fakePng());
      await symlink(victim, join(dir, "link.png"));
      const fetchImpl = capturingFetch(() => imageJsonResponse());
      const ctx = makeCtx(dir);
      registerMediaTools(ctx, makeOpts(fetchImpl));
      await assert.rejects(ctx.defs[0].execute({ prompt: "p", referenceImage: join(dir, "link.png") }, exec()), /工作目录|符号链接/);
      assert.equal(fetchImpl.calls.length, 0);
    });
  });
});

test("A5 .png 扩展名但内容不是图片（魔数校验）被拒绝，内容不外发", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    await writeFile(join(dir, "fake.png"), FAKE_SECRET); // 无 PNG 魔数
    const fetchImpl = capturingFetch((url) => (url.includes("generation") || url.includes("/chat") ? imageJsonResponse() : okPngResponse()));
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    await assert.rejects(ctx.defs[0].execute({ prompt: "p", referenceImage: join(dir, "fake.png") }, exec()), /魔数|内容|有效/);
    assert.equal(fetchImpl.calls.length, 0);
    const b64 = Buffer.from(FAKE_SECRET).toString("base64");
    for (const c of fetchImpl.calls) assert.ok(!String(c.init?.body ?? "").includes(b64));
  });
});

test("A6 mime 由实际内容决定：真 JPEG 即便命名 .png 也标 image/jpeg", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    await writeFile(join(dir, "photo.png"), fakeJpeg()); // 扩展名 png，内容 jpeg
    const fetchImpl = capturingFetch((url) => (url.includes("multimodal-generation") ? imageJsonResponse() : okPngResponse()));
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    await ctx.defs[0].execute({ prompt: "p", referenceImage: join(dir, "photo.png") }, exec());
    const post = fetchImpl.calls.find((c) => c.url.includes("multimodal-generation"));
    assert.ok(post, "图生图必须走原生多模态端点");
    const body = JSON.parse(post.init.body);
    const dataUrl = body.input.messages[0].content[0].image;
    assert.ok(dataUrl.startsWith("data:image/jpeg;base64,"), `mime 应按内容判为 jpeg，实际：${dataUrl.slice(0, 30)}`);
  });
});

test("A-positive 合法 PNG 参考图正常走图生图（不破坏既有能力）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    await writeFile(join(dir, "ref.png"), fakePng());
    const fetchImpl = capturingFetch((url) => (url.includes("multimodal-generation") ? imageJsonResponse() : okPngResponse()));
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    const result = await ctx.defs[0].execute({ prompt: "p", referenceImage: join(dir, "ref.png") }, exec());
    assert.equal(result.count, 1);
    const post = fetchImpl.calls.find((c) => c.url.includes("multimodal-generation"));
    const body = JSON.parse(post.init.body);
    assert.ok(body.input.messages[0].content[0].image.startsWith("data:image/png;base64,"));
    assert.equal(body.parameters.prompt_extend, false);
    assert.ok(result.paths[0].startsWith(dir), "生成物必须落在工作目录内");
  });
});

// ───────────────────────── 纯文本生图端点回归（2026-11-23 修复）─────────────────────────
// 旧实现把无参考图的生图发到 compatible-mode chat/completions（OpenAI 形状），图像模型
// 一律 400（input.messages.*.role/content 校验）。修复后纯文本与图生图统一走原生多模态端点。

test("T1 纯文本生图走原生多模态端点，请求体为 input.messages 原生形状", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    const fetchImpl = capturingFetch((url) => (url.includes("multimodal-generation") ? imageJsonResponse() : okPngResponse()));
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    const result = await ctx.defs[0].execute({ prompt: "一只胖鱼" }, exec());
    assert.equal(result.count, 1);
    const post = fetchImpl.calls.find((c) => c.init?.method === "POST");
    assert.ok(post.url.includes("/api/v1/services/aigc/multimodal-generation/generation"), `纯文本生图必须走原生端点，实际：${post.url}`);
    assert.ok(!post.url.includes("/chat/completions"), "不得再发 compatible-mode chat 端点");
    const body = JSON.parse(post.init.body);
    assert.equal(body.input.messages[0].role, "user");
    assert.deepEqual(body.input.messages[0].content, [{ text: "一只胖鱼" }]);
    assert.equal(body.messages, undefined, "不得用 OpenAI 顶层 messages 形状");
    assert.equal(body.stream, undefined);
    // 纯文本生图保留服务端 prompt_extend 默认（不显式关闭）。
    assert.equal(body.parameters.prompt_extend, undefined);
    assert.ok(result.paths[0].startsWith(dir));
  });
});

test("T2 纯文本生图 size/n 透传到原生 parameters", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    const fetchImpl = capturingFetch((url) => (url.includes("multimodal-generation") ? imageJsonResponse() : okPngResponse()));
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    await ctx.defs[0].execute({ prompt: "p", size: "768*1152", n: 2 }, exec());
    const post = fetchImpl.calls.find((c) => c.init?.method === "POST");
    const body = JSON.parse(post.init.body);
    assert.equal(body.parameters.size, "768*1152");
    assert.equal(body.parameters.n, 2);
    assert.deepEqual(body.input.messages[0].content, [{ text: "p" }]);
  });
});

// ───────────────────────── 缺陷 D（P2）：先 stat 判大小/普通文件，再读 ─────────────────────────

test("D1 超大参考图在读取前就被 stat 拒绝（不可读文件也能判大小）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    const big = join(dir, "big.png");
    // 稀疏文件：声明 150MB 但不占盘；chmod 000 使 readFile 必 EACCES。
    // 若实现先读后判 → 抛 EACCES（红）；先 stat 后判 → 抛「参考图过大」（绿），且根本不读。
    const fh = await open(big, "w");
    await fh.truncate(150 * MB);
    await fh.close();
    // 用 r+ 原位写魔数，不能 writeFile（'w' 会截断回 8 字节，稀疏大小就没了）。
    const fh2 = await open(big, "r+");
    await fh2.write(PNG_SIG, 0, PNG_SIG.length, 0);
    await fh2.close();
    await chmod(big, 0o000);
    const fetchImpl = capturingFetch(() => imageJsonResponse());
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    try {
      await assert.rejects(ctx.defs[0].execute({ prompt: "p", referenceImage: big }, exec()), /参考图过大/);
      assert.equal(fetchImpl.calls.length, 0);
    } finally { await chmod(big, 0o600).catch(() => {}); }
  });
});

test("D2 目录伪装成 .png 被拒绝（必须是普通文件）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    await mkdir(join(dir, "folder.png"));
    const fetchImpl = capturingFetch(() => imageJsonResponse());
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    await assert.rejects(ctx.defs[0].execute({ prompt: "p", referenceImage: join(dir, "folder.png") }, exec()), /普通文件/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

// ───────────────────────── 缺陷 B（P1）：下载边读边写盘，内存与文件大小无关 ─────────────────────────

test("B1 64MB 下载峰值 RSS 增量与文件大小解耦（流式写盘）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    const SIZE = 64 * MB;
    const CHUNK = 1 * MB;
    let peak = 0;
    let gcEvery = 0;
    const fetchImpl = async () => {
      let sent = 0;
      const rs = new ReadableStream({
        pull(c) {
          // 每块用**新** buffer（复用同一块会被后续 fill 覆盖，落盘内容错乱）。
          // 周期性 gc 回收测试自身的临时块，使峰值反映 download 的**驻留**内存而非测试垃圾：
          // 旧实现 chunks 数组持有全部块 → gc 也收不掉 → 峰值随文件线性涨；新实现写盘即弃 → 平。
          if ((gcEvery++ % 8) === 0) tryGc();
          const rss = process.memoryUsage().rss;
          if (rss > peak) peak = rss;
          if (sent >= SIZE) { c.close(); return; }
          const buf = new Uint8Array(CHUNK);
          buf.fill(sent === 0 ? 0xaa : sent + CHUNK >= SIZE ? 0xbb : 0x00);
          sent += CHUNK;
          c.enqueue(buf);
        },
      });
      return new Response(rs, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(SIZE) } });
    };
    tryGc();
    const base = process.memoryUsage().rss;
    peak = base;
    const saved = await download(fetchImpl, "https://cdn.test/big.mp4", dir, "qwen-video", "mp4", undefined, VIDEO_MAX);
    assert.equal(saved.bytes, SIZE);
    const st = await stat(saved.path);
    assert.equal(st.size, SIZE, "落盘大小必须完整");
    const head = await readFile(saved.path);
    assert.equal(head[0], 0xaa);
    assert.equal(head[SIZE - 1], 0xbb);
    const deltaMB = (peak - base) / MB;
    // 旧实现实测 64MB→RSS+120~184MB（chunks+concat 双份驻留）；新实现逐块写盘即弃，
    // 增量只有流队列/写缓冲的常数级。阈值 32MB 远低于 64MB 文件本身，证明内存与文件大小解耦。
    assert.ok(deltaMB < 32, `峰值 RSS 增量 ${deltaMB.toFixed(1)}MB 应远小于 64MB 文件（流式写盘）`);
  });
});

test("B2 下载中途失败清理临时文件，不留半截产物", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    const fetchImpl = async () => {
      let n = 0;
      const rs = new ReadableStream({
        pull(c) {
          if (n++ < 2) c.enqueue(new Uint8Array(1024));
          else c.error(new Error("stream boom"));
        },
      });
      return new Response(rs, { status: 200, headers: { "content-type": "image/png" } });
    };
    await assert.rejects(download(fetchImpl, "https://cdn.test/x.png", dir, "qwen-image", "png"), /stream boom/);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dir), [], "失败后目录必须干净（无 .part/半截文件）");
  });
});

test("B3 累计超限立即中断语义保留，且不留临时文件", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    const fetchImpl = async () => {
      let n = 0;
      const rs = new ReadableStream({ pull(c) { if (n++ < 600) c.enqueue(new Uint8Array(1024)); else c.close(); } });
      return new Response(rs, { status: 200, headers: { "content-type": "image/png" } });
    };
    await assert.rejects(download(fetchImpl, "https://cdn.test/huge.png", dir, "qwen-image", "png", undefined, 64 * 1024), /超过大小上限/);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dir), []);
  });
});

test("B4 content-length 预检保留（声明超限直接拒，不读响应体）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    // 用假 response 对象精确观测「是否开始读 body」：真 Response 构造即锁流，
    // 无法区分「构造拉流」与「download 读流」。download 只用 headers.get/ok/status/body.getReader。
    let bodyRead = false;
    const fakeResp = {
      ok: true, status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? String(IMAGE_MAX + 1) : "image/png") },
      body: { getReader: () => { bodyRead = true; throw new Error("不该读 body"); } },
    };
    const fetchImpl = capturingFetch(() => fakeResp);
    await assert.rejects(download(fetchImpl, "https://cdn.test/big.png", dir, "qwen-image", "png"), /过大/);
    assert.equal(bodyRead, false, "声明超限时不该开始读响应体");
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dir), [], "预检拒绝不该落任何文件");
  });
});

// ───────────────────────── 缺陷 C（P2）：SSRF 网段补齐 + 域名 DNS fail-closed ─────────────────────────

const NEW_PRIVATE_V4 = [
  "100.64.0.1", "100.127.255.254",   // 100.64.0.0/10 CGNAT（Tailscale）
  "192.0.0.1", "192.0.0.255",        // 192.0.0.0/24
  "198.18.0.1", "198.19.255.254",    // 198.18.0.0/15 benchmark
  "224.0.0.1", "239.255.255.250",    // 224.0.0.0/4 组播
  "255.255.255.255",                 // 受限广播
];

test("C1 缺失网段字面量全部拦下（isPrivateHostLiteral + download 双层）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    const fetchImpl = capturingFetch(() => okPngResponse());
    for (const host of NEW_PRIVATE_V4) {
      assert.equal(isPrivateHostLiteral(host), true, `字面量判定应认 ${host} 为私网`);
      await assert.rejects(download(fetchImpl, `https://${host}/a.png`, dir, "qwen-image", "png"), /本机\/内网/, `download 应拒 ${host}`);
    }
    assert.equal(fetchImpl.calls.length, 0, "私网字面量不得触发任何 fetch");
  });
});

test("C2 公网域名解析到内网一律拒绝（含混合答案与 IPv6 答案）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, {
      "localtest.me": [{ address: "127.0.0.1", family: 4 }],
      "mixed.test": [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
      "v6internal.test": [{ address: "::1", family: 6 }],
      "cgnat.test": [{ address: "100.64.1.2", family: 4 }],
    });
    const fetchImpl = capturingFetch(() => okPngResponse());
    for (const host of ["localtest.me", "mixed.test", "v6internal.test", "cgnat.test"]) {
      await assert.rejects(download(fetchImpl, `https://${host}/a.png`, dir, "qwen-image", "png"), /本机\/内网/, `应拒 ${host}`);
    }
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test("C2b 代理 fake-IP 段（198.18.0.0/15）域名解析放行 + warn（非真实内网，2026-11-24）", async (t) => {
  await withTmpDir(async (dir) => {
    // Clash/Surge fake-IP 把公网域名映射到 198.18.x.x；这是代理本地映射，真实路由由代理决定。
    // 与 C3 解析失败放行同理：fail-closed 会打死合法下载。真内网段（C2）仍拒。
    fakeDns(t, { "oss.fakeip.test": [{ address: "198.18.3.56", family: 4 }, { address: "198.19.0.1", family: 4 }] });
    const warns = [];
    const fetchImpl = capturingFetch(() => okPngResponse());
    const logger = { warn: (m) => warns.push(m) };
    const saved = await download(fetchImpl, "https://oss.fakeip.test/a.png", dir, "qwen-image", "png", undefined, undefined, logger);
    assert.ok(saved.path.endsWith(".png"), "fake-IP 段域名应放行下载");
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(warns.some((w) => w.includes("fake-IP")), "应 warn 说明是代理 fake-IP");
    // 但 IP 字面量 198.18.x.x 仍按私网拦（C1 已覆盖）：解析放行只针对域名。
    await assert.rejects(download(fetchImpl, "https://198.18.3.56/a.png", dir, "qwen-image", "png"), /本机\/内网/);
  });
});

test("C3 DNS 解析失败放行 + warn（lead 定稿：非 fail-closed，保代理可用性）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, {}); // 任何 host 都 ENOTFOUND
    const warns = [];
    const fetchImpl = capturingFetch(() => okPngResponse());
    // 取舍（见实现注释）：直连时解析失败 fetch 自己也连不上，fail-closed 无安全收益；
    // 跨境代理场景 ProxyAgent 由代理侧解析，本地 DNS 失败/污染若 fail-closed 会打死合法下载。
    // 故解析失败 → 放行 + warn；只有「解析成功且含私网地址」才拒（C2）。
    const saved = await download(fetchImpl, "https://nx.test/a.png", dir, "qwen-image", "png", undefined, IMAGE_MAX, { warn: (m) => warns.push(m) });
    assert.equal(saved.bytes, fakePng(16).length, "解析失败应放行（交由连接层/代理处理）");
    assert.ok(warns.some((m) => /DNS|解析/.test(m)), "放行时必须 warn 留痕");
  });
});

test("C4 每一跳重定向重新做 DNS 校验（302→内网域名被拒）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, { ...PUBLIC_DNS, "localtest.me": [{ address: "127.0.0.1", family: 4 }] });
    const fetchImpl = capturingFetch((url) => {
      if (url.includes("cdn.test")) return new Response(null, { status: 302, headers: { location: "https://localtest.me/final.png" } });
      return okPngResponse();
    });
    await assert.rejects(download(fetchImpl, "https://cdn.test/a.png", dir, "qwen-image", "png"), /本机\/内网/);
    // 只该发出第一跳；第二跳在校验阶段就被拒，不得 fetch。
    assert.equal(fetchImpl.calls.length, 1);
  });
});

test("C5 公网域名+公网解析正常下载；IPv6 公网字面量不触发 DNS（保留既有能力）", async (t) => {
  await withTmpDir(async (dir) => {
    // DNS mock 对任何调用都抛错：若实现错误地对字面量做 DNS，这条会红。
    t.mock.method(dns.promises, "lookup", async () => { throw new Error("literal 不该触发 DNS"); });
    const fetchImpl = capturingFetch(() => okPngResponse());
    const saved = await download(fetchImpl, "https://[2606:4700::1111]/a.png", dir, "qwen-image", "png");
    assert.equal(saved.bytes, fakePng(16).length);
    assert.ok(saved.path.startsWith(dir));
  });
});

test("C5b 公网域名解析到公网地址正常下载（DNS 放行路径）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    const fetchImpl = capturingFetch(() => okPngResponse());
    const saved = await download(fetchImpl, "https://cdn.test/a.png", dir, "qwen-image", "png");
    assert.equal(saved.bytes, fakePng(16).length);
    assert.equal(fetchImpl.calls.length, 1);
  });
});

test("C6 assertDownloadUrl 保持同步契约；DNS 私网拒绝在 download 路径生效", async (t) => {
  fakeDns(t, { "localtest.me": [{ address: "127.0.0.1", family: 4 }] });
  // 同步契约（既有 route-guard.test.mjs:152-153 钉死）：非 https 同步抛错、公网域名同步返回 URL。
  assert.throws(() => assertDownloadUrl("http://127.0.0.1/x.png"), /非 https/);
  assert.equal(assertDownloadUrl("https://localtest.me/x.png").hostname, "localtest.me");
  // DNS 加固在真实下载路径（download 每跳 await assertHostDnsSafe）：解析到内网必拒。
  await withTmpDir(async (dir) => {
    const fetchImpl = capturingFetch(() => okPngResponse());
    await assert.rejects(download(fetchImpl, "https://localtest.me/x.png", dir, "qwen-image", "png"), /本机\/内网/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

// ───────────────────────── 缺陷 E（P2）：视频轮询保留上游 message ─────────────────────────

test("E1 轮询 HTTP 失败时保留已解析的上游 message", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fetchImpl = capturingFetch((url) => {
      if (url.includes("video-synthesis")) return Response.json({ output: { task_id: "t1", task_status: "RUNNING" } });
      // 轮询：HTTP 400 + 可解析 body 带上游具体错误。
      return Response.json({ output: { task_status: "FAILED", message: "上游具体错误：内容审核未通过", code: "DataInspectionFailed" } }, { status: 400 });
    });
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    const videoTool = ctx.defs.find((def) => def.name === "qwen_generate_video");
    const p = videoTool.execute({ prompt: "p" }, exec());
    p.catch(() => {}); // 先挂拒绝处理，避免 tick/flush 期间 unhandledRejection
    await flush(); // 让提交请求跑完、进入 sleep(POLL_INTERVAL_MS)
    t.mock.timers.tick(10_000); // 同步触发轮询定时器
    await flush(); // 让轮询 fetch + json 解析跑完
    await assert.rejects(p, /内容审核未通过/, "必须保留上游 message，不能只报笼统 HTTP 400");
  });
});

test("E2 轮询 HTTP 失败且 body 不可解析时仍报 HTTP 状态（保留既有文案）", async (t) => {
  await withTmpDir(async (dir) => {
    fakeDns(t, PUBLIC_DNS);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fetchImpl = capturingFetch((url) => {
      if (url.includes("video-synthesis")) return Response.json({ output: { task_id: "t2", task_status: "RUNNING" } });
      return new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    });
    const ctx = makeCtx(dir);
    registerMediaTools(ctx, makeOpts(fetchImpl));
    const videoTool = ctx.defs.find((def) => def.name === "qwen_generate_video");
    const p = videoTool.execute({ prompt: "p" }, exec());
    p.catch(() => {});
    await flush();
    t.mock.timers.tick(10_000);
    await flush();
    await assert.rejects(p, /查询视频任务失败：HTTP 502/);
  });
});
