/**
 * 探测完整性回归（2026-11-18 线上实测缺陷 A–G 的钉子，全部离线）：
 * 真实上游 + 真实 key 实测过：30s 预算把 qwen4-max-preview 的 maxTokens 探成
 * 131072（真值 393216），降级结果还被无条件缓存并标成「能力已探测」，
 * 第二次 refresh 73ms 缓存命中，假精确值固化到进程结束。这里用假 fetchImpl
 * 复现每一类失败形态，确保「探残 ≠ 探完」永远成立。
 * 绝不发真实网络请求：endpoint 一律 example.invalid，fetch 全部注入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeModelCapabilities, clearProbeCache } from "../lib/capability-probe.js";
import { DynamicCatalog, NON_CHAT_PATTERNS, BUILTIN_CATALOG } from "../lib/catalog.js";

const ENDPOINT = "https://example.invalid/v1/responses";
const MODELS_URL = "https://example.invalid/compatible-mode/v1/models";
const SSE_OK = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n';

/** 与既有 capability-probe.test.js 同款纯对象 mock（无 body 流，走 text() 兜底路径）。 */
function okObject() {
  return { ok: true, status: 200, text: async () => SSE_OK };
}

/** 模拟真实 fetch 的延迟：signal 中止时立刻以 AbortError 拒绝（而不是傻等）。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException("aborted", "AbortError")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

function probeOpts(fetchImpl, signal) {
  return { endpoint: ENDPOINT, key: "fixture", fetchImpl, signal };
}

/** /models 与 /responses 分流；probe 钩子拿到 (init, 第几次探测请求)。 */
function routingFetch({ ids, probe, probeDelayMs = 0 }) {
  const calls = { models: 0, probe: 0 };
  const impl = async (url, init = {}) => {
    if (String(url).endsWith("/models")) {
      calls.models += 1;
      return Response.json({ data: ids.map((id) => ({ id })) });
    }
    calls.probe += 1;
    if (probe) return probe(init, calls.probe);
    await delay(probeDelayMs, init.signal);
    return okObject();
  };
  impl.calls = calls;
  return impl;
}

function makeCatalog({ ids, excludes = [], fetchImpl }) {
  return new DynamicCatalog({
    ctx: { get: () => ({ resolve: async () => ({ value: "fixture" }) }) },
    modelsUrl: MODELS_URL,
    apiKeyEnv: "PROBE_TEST_KEY",
    pluginName: "probe-integrity-test",
    excludes,
    fetchImpl,
  });
}

// —— 缺陷 A：传输失败/中止必须标 incomplete，且不写缓存 ——

test("A1: 中途断网的探测标 incomplete 且不缓存，恢复后重探拿到真值", async () => {
  clearProbeCache();
  let outage = true;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // 第 3 个请求起进入断网窗口（覆盖档位与上限探测），模拟真实网络抖动。
    if (outage && calls >= 3) throw new Error("network hiccup");
    return okObject();
  };
  const first = await probeModelCapabilities("a1-flaky", probeOpts(fetchImpl));
  assert.equal(first.incomplete, true, "传输失败的探测必须标 incomplete");
  outage = false;
  const before = calls;
  const second = await probeModelCapabilities("a1-flaky", probeOpts(fetchImpl));
  assert.ok(calls > before, "incomplete 结果不得写缓存：第二次必须重新发请求");
  assert.notEqual(second.incomplete, true);
  assert.equal(second.maxTokens, 393216, "恢复后应探到真值，而不是缓存里的降级值");
});

test("A2: 被中止的探测标 incomplete 且不缓存", async () => {
  clearProbeCache();
  const controller = new AbortController();
  let calls = 0;
  let fired = false;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (calls === 4 && !fired) { fired = true; controller.abort(); throw new DOMException("aborted", "AbortError"); }
    return okObject();
  };
  const first = await probeModelCapabilities("a2-abort", probeOpts(fetchImpl, controller.signal));
  assert.equal(first.incomplete, true, "中止是不可信失败，不是「不支持」");
  const before = calls;
  const second = await probeModelCapabilities("a2-abort", probeOpts(fetchImpl));
  assert.ok(calls > before, "中止的探测不得写缓存");
  assert.equal(second.maxTokens, 393216);
});

test("A3: 5xx 是服务端故障不是「不支持」，标 incomplete 且不缓存", async () => {
  clearProbeCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, text: async () => "upstream busy" };
    return okObject();
  };
  const first = await probeModelCapabilities("a3-5xx", probeOpts(fetchImpl));
  assert.equal(first.incomplete, true, "5xx 不可信，不能当成能力缺失");
  const before = calls;
  const second = await probeModelCapabilities("a3-5xx", probeOpts(fetchImpl));
  assert.ok(calls > before, "5xx 降级的探测不得写缓存");
  assert.equal(second.maxTokens, 393216);
});

// —— 缺陷 B：独立探测预算 + incomplete 走保守推断 + lastError 留痕 ——

test("B1: probeSignal 被掐断时提交保守档案、留 probe-incomplete 痕迹、refresh 仍为 true", async () => {
  clearProbeCache();
  const fetchImpl = routingFetch({ ids: ["qwen5-max-preview"], probeDelayMs: 80 });
  const catalog = makeCatalog({ ids: ["qwen5-max-preview"], fetchImpl });
  // /models 预算充足，探测预算故意不够第一个请求（实测教训：30s 装不下 11 次真实生成）。
  const updated = await catalog.refresh(AbortSignal.timeout(5000), { probeSignal: AbortSignal.timeout(25) });
  assert.equal(updated, true, "/models 成功就该更新目录，探测降级不应否定整次刷新");
  assert.equal(catalog.source, "live");
  const model = catalog.find("qwen5-max-preview");
  assert.ok(model, "新模型仍应进目录");
  assert.match(model.capabilities, /保守推断/, "探残不得标成「能力已探测」");
  assert.doesNotMatch(model.capabilities, /能力已探测/);
  assert.equal(model.maxTokens, 65536, "qwen 家族保守上限，而不是探残的假精确值");
  assert.deepEqual(model.reasoningEfforts, ["none", "low", "medium", "xhigh"]);
  assert.match(String(catalog.lastError), /probe-incomplete/, "降级必须留可读痕迹");
  assert.match(String(catalog.lastError), /qwen5-max-preview/);
});

test("B2: 向后兼容——只传 refresh(signal) 时探测沿用该 signal，掐断同样走保守推断", async () => {
  clearProbeCache();
  const fetchImpl = routingFetch({ ids: ["qwen5-max-preview"], probeDelayMs: 80 });
  const catalog = makeCatalog({ ids: ["qwen5-max-preview"], fetchImpl });
  const updated = await catalog.refresh(AbortSignal.timeout(25));
  assert.equal(updated, true);
  const model = catalog.find("qwen5-max-preview");
  assert.match(model.capabilities, /保守推断/);
  assert.equal(model.maxTokens, 65536);
  assert.match(String(catalog.lastError), /probe-incomplete/);
});

test("B3: reprobe:true 清缓存重探，给上次被掐断的降级档案恢复入口", async () => {
  clearProbeCache();
  const fetchImpl = routingFetch({ ids: ["qwen5-max-preview"], probeDelayMs: 80 });
  const catalog = makeCatalog({ ids: ["qwen5-max-preview"], fetchImpl });
  await catalog.refresh(AbortSignal.timeout(5000), { probeSignal: AbortSignal.timeout(25) });
  assert.match(catalog.find("qwen5-max-preview").capabilities, /保守推断/);
  // 面板手动刷新：充足预算 + reprobe，必须真正重探而不是命中降级缓存。
  const updated = await catalog.refresh(AbortSignal.timeout(10000), { probeSignal: AbortSignal.timeout(10000), reprobe: true });
  assert.equal(updated, true);
  const model = catalog.find("qwen5-max-preview");
  assert.match(model.capabilities, /能力已探测/, "reprobe 后应拿到完整探测档案");
  assert.equal(model.maxTokens, 393216);
  assert.equal(catalog.lastError, null, "完整探测成功后痕迹应清掉");
});

// —— 缺陷 C：探测不得等整段生成读完 ——

test("C: 首事件后即释放连接——流不关闭也能完成探测，且每个请求都 cancel", async () => {
  clearProbeCache();
  let cancels = 0;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // 首事件下发后永不关闭的流：等 text() 读完的旧实现会在这里挂死。
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(SSE_OK));
      },
      cancel() { cancels += 1; },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  let timer;
  const hung = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("探测挂起：还在等整段 SSE 流读完（应读首事件即 cancel）")), 1500);
  });
  try {
    const result = await Promise.race([probeModelCapabilities("c-stream", probeOpts(fetchImpl)), hung]);
    assert.equal(result.maxTokens, 393216, "11 次探测都应正常完成");
    assert.notEqual(result.incomplete, true);
    assert.equal(cancels, calls, "每个探测请求读完首事件都必须 cancel 释放连接");
  } finally {
    clearTimeout(timer);
  }
});

// —— 缺陷 D：excludeModels 必须同样排除探测，别白花钱 ——

test("D: 被 excludes 前缀命中的新模型 0 次探测请求，其余新模型照常探", async () => {
  clearProbeCache();
  const ids = ["qwen5-secret-preview", "qwen5-open-preview"];
  const fetchImpl = routingFetch({ ids });
  const catalog = makeCatalog({ ids, excludes: ["qwen5-secret"], fetchImpl });
  const updated = await catalog.refresh();
  assert.equal(updated, true);
  assert.equal(fetchImpl.calls.probe, 11, "被排除的模型一次付费探测都不该发（实测旧码打了 22 次再丢弃）");
  assert.equal(catalog.find("qwen5-secret-preview"), undefined);
  assert.ok(catalog.find("qwen5-open-preview"), "未排除的新模型照常进目录");
});

// —— 缺陷 E：refresh 串行化，并发不得打出双份探测 ——

test("E: 并发 refresh 复用在途 Promise，只探一份；完成后缓存仍生效", async () => {
  clearProbeCache();
  const fetchImpl = routingFetch({ ids: ["qwen5-max-preview"], probeDelayMs: 20 });
  const catalog = makeCatalog({ ids: ["qwen5-max-preview"], fetchImpl });
  const p1 = catalog.refresh();
  const p2 = catalog.refresh();
  assert.equal(p1, p2, "并发调用应复用同一个在途 Promise（同 catalog-feed 的 #running 手法）");
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(fetchImpl.calls.probe, 11, "并发两次 refresh 不得打出 22 次探测");
  await catalog.refresh();
  assert.equal(fetchImpl.calls.probe, 11, "完整探测的缓存必须保留，串行第三次 refresh 不重探");
});

// —— 缺陷 F：NON_CHAT_PATTERNS 漏网修补，且不误伤内置对话模型 ——

test("F: wanx-v1 / multimodal-embedding-v1 / qwen3-asr-flash 被过滤，14 个内置模型全通过", () => {
  for (const id of ["wanx-v1", "multimodal-embedding-v1", "qwen3-asr-flash"]) {
    assert.ok(NON_CHAT_PATTERNS.some((p) => p.test(id)), `${id} 是非对话模型，必须被过滤`);
  }
  assert.equal(BUILTIN_CATALOG.models.length, 14, "内置目录规模变化时此钉子要人工复核");
  for (const model of BUILTIN_CATALOG.models) {
    assert.ok(!NON_CHAT_PATTERNS.some((p) => p.test(model.id)), `内置对话模型 ${model.id} 不得被误伤`);
  }
});

test("F2: 漏网非对话模型进 /models 也不触发探测、不进目录", async () => {
  clearProbeCache();
  const ids = ["wanx-v1", "multimodal-embedding-v1", "qwen3-asr-flash", "qwen3.8-flash"];
  const fetchImpl = routingFetch({ ids });
  const catalog = makeCatalog({ ids, fetchImpl });
  assert.equal(await catalog.refresh(), true);
  assert.equal(fetchImpl.calls.probe, 0, "非对话模型不该花一次探测钱");
  for (const id of ids.slice(0, 3)) assert.equal(catalog.find(id), undefined);
  assert.ok(catalog.find("qwen3.8-flash"));
});

// —— 缺陷 G：HTTP 200 但流内 error / response.failed 必须判失败 ——

/** 首事件即错误的 200 响应（真实上游存在该形态，见 responses-sse.js 的 error/response.failed 分支）。 */
function errorStreamResponse(type) {
  const payload = type === "error"
    ? 'data: {"type":"error","error":{"message":"capability not supported"}}\n\n'
    : 'data: {"type":"response.failed","response":{"status":"failed"}}\n\n';
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("G1: 图片探测 200+流内 error → 不得记成支持图片", async () => {
  clearProbeCache();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.input?.[0]?.content?.some?.((c) => c.type === "input_image")) return errorStreamResponse("error");
    return okObject();
  };
  const result = await probeModelCapabilities("g1-image", probeOpts(fetchImpl));
  assert.deepEqual(result.input, ["text"], "流内 error 是明确拒绝，不是成功");
  assert.notEqual(result.incomplete, true, "上游明确拒绝是可信信号，不应标 incomplete");
});

test("G2: 档位探测 200+response.failed → 该档不得记成支持", async () => {
  clearProbeCache();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.reasoning?.effort === "xhigh") return errorStreamResponse("response.failed");
    return okObject();
  };
  const result = await probeModelCapabilities("g2-effort", probeOpts(fetchImpl));
  assert.ok(!result.reasoningEfforts.includes("xhigh"), "response.failed 的档位不是支持");
  assert.ok(result.reasoningEfforts.includes("low"), "其余正常档位不受影响");
});

test("G3: 上限探测 200+流内 error → 不得把该上限记成支持", async () => {
  clearProbeCache();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.max_output_tokens >= 262144) return errorStreamResponse("error");
    return okObject();
  };
  const result = await probeModelCapabilities("g3-maxtokens", probeOpts(fetchImpl));
  assert.equal(result.maxTokens, 131072, "流内 error 的上限候选必须判失败并止步");
});

// —— 同类缺口（lead 复核指出）：读首事件的缓冲必须有上限，协议损坏/被投毒的灌流不得撑爆进程 ——

test("H1: 永不含空行的灌流在缓冲上限处停下——incomplete、不缓存、连接被释放", async () => {
  clearProbeCache();
  const CHUNK = 64 * 1024;
  const LIMIT = 1 * 1024 * 1024;
  const junk = new TextEncoder().encode("x".repeat(CHUNK)); // 无任何换行，永远凑不出事件边界
  let pulled = 0;
  let cancels = 0;
  let requests = 0;
  const floodFetch = async () => {
    requests += 1;
    const stream = new ReadableStream({
      pull(controller) {
        // 测试自保阀：上限缺失（红运行）时也别真把内存灌爆——拉满 64MB 后永久挂起，
        // 由下面的超时守卫判 fail，而不是 OOM。
        if (pulled >= 64 * 1024 * 1024) return new Promise(() => {});
        pulled += CHUNK;
        controller.enqueue(junk);
      },
      cancel() { cancels += 1; },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  let timer;
  const hung = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("灌流无上限：把上限改成 Infinity 时这里必须 fail")), 1500);
  });
  try {
    const result = await Promise.race([probeModelCapabilities("h1-flood", probeOpts(floodFetch)), hung]);
    assert.equal(result.incomplete, true, "协议损坏的流不是能力信号，必须标 incomplete");
    assert.equal(requests, 1, "首个请求超限即收手，不得继续付费探后续档位");
    assert.equal(cancels, 1, "超限也必须 cancel 释放连接");
    assert.ok(pulled >= LIMIT, `停得太早（${pulled} 字节）说明不是上限在起作用`);
    assert.ok(pulled <= LIMIT + 2 * CHUNK, `应在 1MB 上限附近停下，实际拉了 ${pulled} 字节`);
    // 不写缓存：上游恢复后同 id 重探必须拿到真值，而不是继承灌流那次的降级占位。
    const healthy = await probeModelCapabilities("h1-flood", probeOpts(async () => okObject()));
    assert.equal(healthy.maxTokens, 393216, "incomplete 不入缓存，恢复后重探拿到真值");
    assert.notEqual(healthy.incomplete, true);
  } finally {
    clearTimeout(timer);
  }
});
test("I1: 探测用图必须满足上游最小边长（>10px），否则每个模型都会被判成不能收图", async () => {
  // 线上实测（2026-11-18）：原先放的是 1×1 PNG（注释却写 16×16）。上游对
  // qwen4-max 与 qwen4-max-preview 都回 HTTP 200 + response.failed：
  //   InvalidParameter: ... [height:1 or width:1 must be larger than 10]
  // 拒绝属「可信的不支持」→ 被当成能力信号缓存 → 所有动态发现的模型一律 input=["text"]，
  // 带图请求在宿主装配阶段抛 UNSUPPORTED_CONTENT。这条钉子直接校验发出去的那张图。
  let sent;
  await probeModelCapabilities("i1-image-size", probeOpts(async (_url, init) => {
    sent ??= JSON.parse(init.body);
    return okObject();
  }));
  const part = sent.input[0].content.find((c) => c.type === "input_image");
  assert.ok(part, "第一个请求必须是图片探测");
  const b64 = String(part.image_url).replace(/^data:image\/png;base64,/, "");
  const png = Buffer.from(b64, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "必须是真 PNG");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.ok(width > 10 && height > 10,
    `探测图 ${width}×${height} 太小：上游要求边长 >10，会把「不支持图片」误判成能力事实`);
});


// —— 2026-11-25 高危回归：新 GLM 不走 /responses 探测；非 Qwen 探测结果保留各自家族规格 ——

test("J1: 新发现的 GLM 模型跳过 /responses 探测，保留 transport=chat、思考能力与空 harnessTools", async () => {
  clearProbeCache();
  const ids = ["glm-5.4-preview"];
  const fetchImpl = routingFetch({
    ids,
    probe: async () => ({ ok: false, status: 400, text: async () => "unsupported protocol" }),
  });
  const catalog = makeCatalog({ ids, fetchImpl });
  const updated = await catalog.refresh();
  assert.equal(updated, true);
  assert.equal(fetchImpl.calls.probe, 0, "GLM 走 Chat Completions，不得向 /responses 发探测请求");
  const glm = catalog.find("glm-5.4-preview");
  assert.ok(glm, "新 GLM 模型应进入目录");
  assert.equal(glm.transport, "chat", "GLM 必须保留 transport: chat");
  assert.equal(glm.reasoning, true, "GLM 不得因 /responses 400 被误标为不支持思考");
  assert.deepEqual(glm.harnessTools, [], "GLM 不得被注入 Qwen 专属内置工具");
});

test("J2: 新发现的非 Qwen 模型（如 DeepSeek）能力探测后保留自身家族的 contextWindow 与空 harnessTools", async () => {
  clearProbeCache();
  const ids = ["deepseek-v4-preview"];
  const fetchImpl = routingFetch({ ids });
  const catalog = makeCatalog({ ids, fetchImpl });
  const updated = await catalog.refresh();
  assert.equal(updated, true);
  assert.ok(fetchImpl.calls.probe > 0, "非 GLM 的新 Responses 模型照常探测");
  const ds = catalog.find("deepseek-v4-preview");
  assert.ok(ds);
  assert.match(ds.capabilities, /能力已探测/);
  assert.equal(ds.contextWindow, 163840, "DeepSeek 应保留家族 contextWindow，不得硬编码成 1000000");
  assert.deepEqual(ds.harnessTools, [], "DeepSeek 不得被硬塞 Qwen 专属内置工具");
});
