#!/usr/bin/env node
/**
 * 权益能力实测：按插件各条真实调用路径逐项测试 8 项 Harness 权益能否调用。
 *   - 联网搜索增强/网页解析/代码解释器/垂类搜索：Responses API 服务端内置工具
 *     （与 lib/adapter.js + lib/content.js 完全相同的请求格式，*_call 事件计数与
 *     lib/responses-sse.js 同口径）。
 *   - 图像生成：lib/media-tools.js 的 qwen_generate_image 路径（chatEndpoint）。
 *   - 视频生成：lib/media-tools.js 的 qwen_generate_video 路径（video-synthesis + 轮询）。
 *   - 语音合成/语音识别：插件未接该路径，探测 chatEndpoint 是否可用后如实报告。
 * 用法：node test/entitlement-live.mjs [--quick]   （--quick 跳过视频/语音）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readEnv(name) {
  const direct = process.env[name];
  if (direct?.trim()) return direct.trim();
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.env'), 'utf8');
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm').exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* ignore */ }
  return undefined;
}

const KEY = readEnv('QWEN_TOKEN_PLAN_CN_API_KEY');
if (!KEY) { console.error('缺少 QWEN_TOKEN_PLAN_CN_API_KEY'); process.exit(1); }
const ENDPOINT = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses';
const CHAT_ENDPOINT = ENDPOINT.replace(/\/responses\/?$/, '/chat/completions');
const ORIGIN = new URL(ENDPOINT).origin;
const QUICK = process.argv.includes('--quick');
const HEADERS = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

/** Responses 内置工具调用（adapter 路径）：返回 { ok, calls, finish, textPreview }。 */
async function callHarness({ label, model, builtins, input, maxTokens = 1500, timeoutMs = 150_000 }) {
  const body = {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }],
    stream: true,
    max_output_tokens: maxTokens,
    ...(builtins.length ? { tools: builtins.map((type) => ({ type })), tool_choice: 'auto' } : {}),
  };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { ...HEADERS, Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { label, ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, ms: Date.now() - started };
    }
    const calls = new Map();
    let text = '';
    let finish = 'none';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break outer;
        let event;
        try { event = JSON.parse(payload); } catch { continue; }
        if (event.type === 'response.output_item.added' && String(event.item?.type ?? '').endsWith('_call')) {
          const t = event.item.type;
          calls.set(t, (calls.get(t) ?? 0) + 1);
        } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          text += event.delta;
        } else if (event.type === 'response.completed') {
          finish = event.response?.status ?? 'completed';
        } else if (event.type === 'error' || event.type === 'response.failed') {
          finish = `error:${(event.message ?? event.code ?? JSON.stringify(event)).toString().slice(0, 160)}`;
        }
      }
    }
    return {
      label, ok: finish === 'completed' && calls.size > 0,
      calls: Object.fromEntries(calls), finish,
      textPreview: text.slice(0, 100).replace(/\s+/g, ' '),
      ms: Date.now() - started,
    };
  } catch (error) {
    return { label, ok: false, error: String(error?.message ?? error), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** 图像生成（media-tools qwen_generate_image 路径，非流式 chatEndpoint）。 */
async function callImage({ label, model, prompt, timeoutMs = 300_000 }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        stream: false,
        parameters: {},
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    const urls = [];
    for (const choice of json?.output?.choices ?? json?.choices ?? []) {
      const content = choice?.message?.content;
      if (Array.isArray(content)) for (const part of content) {
        if (part?.type === 'image' && typeof part.image === 'string') urls.push(part.image.slice(0, 40));
        else if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') urls.push(part.image_url.url.slice(0, 40));
      } else if (typeof content === 'string') urls.push(`text:${content.slice(0, 60)}`);
    }
    return { label, ok: response.ok && urls.length > 0, status: response.status, urls: urls.length, error: response.ok ? (urls.length ? null : `无图片: ${text.slice(0, 160)}`) : text.slice(0, 200), ms: Date.now() - started };
  } catch (error) {
    return { label, ok: false, error: String(error?.message ?? error), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** 视频生成（media-tools qwen_generate_video 路径：异步提交 + 轮询）。 */
async function callVideo({ label, model, prompt, timeoutMs = 400_000 }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const submit = await fetch(`${ORIGIN}/api/v1/services/aigc/video-generation/video-synthesis`, {
      method: 'POST',
      headers: { ...HEADERS, 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({ model, input: { prompt } }),
      signal: controller.signal,
    });
    const submitJson = await submit.json().catch(() => ({}));
    const taskId = submitJson?.output?.task_id;
    if (!submit.ok || !taskId) {
      return { label, ok: false, error: `提交失败 HTTP ${submit.status}: ${JSON.stringify(submitJson).slice(0, 200)}`, ms: Date.now() - started };
    }
    let status = String(submitJson?.output?.task_status ?? 'PENDING');
    let task = submitJson;
    while (status !== 'SUCCEEDED') {
      if (Date.now() - started > timeoutMs - 20_000) break;
      await new Promise((r) => setTimeout(r, 10_000));
      const response = await fetch(`${ORIGIN}/api/v1/tasks/${taskId}`, { headers: HEADERS, signal: controller.signal });
      task = await response.json().catch(() => ({}));
      status = String(task?.output?.task_status ?? status);
      if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(status)) break;
    }
    const videoUrl = task?.output?.video_url;
    return { label, ok: status === 'SUCCEEDED' && !!videoUrl, status, url: videoUrl ? videoUrl.slice(0, 48) : null, error: videoUrl ? null : JSON.stringify(task?.output ?? {}).slice(0, 200), ms: Date.now() - started };
  } catch (error) {
    return { label, ok: false, error: String(error?.message ?? error), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** 语音类探测：插件未接该路径，试探 chatEndpoint 的 audio 模态是否可用。 */
async function probeAudio({ label, model, text, timeoutMs = 60_000 }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], modalities: ['text', 'audio'], audio: { voice: 'Cherry', format: 'wav' } }),
      signal: controller.signal,
    });
    const body = await response.text();
    let audio = false;
    try {
      const json = JSON.parse(body);
      const content = json?.choices?.[0]?.message?.content ?? json?.output?.choices?.[0]?.message?.content;
      audio = (typeof content === 'string' && content.length > 0) || !!json?.choices?.[0]?.message?.audio || !!json?.output;
    } catch { /* non-json */ }
    return { label, ok: response.ok && audio, status: response.status, detail: body.slice(0, 160), ms: Date.now() - started };
  } catch (error) {
    return { label, ok: false, error: String(error?.message ?? error), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const M = 'qwen3.8-flash';
const results = [];
async function run(t) {
  process.stdout.write(`▶  ${t.label} … `);
  const r = await t.fn();
  results.push(r);
  if (r.ok) console.log(`✔ ${r.ms}ms ${r.calls ? JSON.stringify(r.calls) : ''}${r.urls ? ` 图片×${r.urls}` : ''}${r.url ? ` ${r.url}…` : ''}`);
  else console.log(`✘ ${r.ms}ms  ${r.error ?? r.detail ?? `finish=${r.finish}`}`);
  if (!r.ok && r.textPreview) console.log(`   text: ${r.textPreview.slice(0, 90)}`);
  return r;
}

console.log(`Token Plan 权益能力实测（model=${M}，${QUICK ? 'quick' : 'full'}）\n`);

await run({ label: '联网搜索增强（web_search）', fn: () => callHarness({
  label: 'web_search', model: M, builtins: ['web_search'],
  input: '请搜索：2026年11月杭州今天天气如何？一句话回答。',
}) });

await run({ label: '网页解析（web_extractor，需伴随 web_search）', fn: () => callHarness({
  label: 'web_extractor', model: M, builtins: ['web_search', 'web_extractor'],
  input: '请搜索并打开 https://platform.qianwenai.com/pricing/token-plan ，一句话总结 Token Plan 有哪几个套餐。',
}) });

await run({ label: '代码解释器（code_interpreter）', fn: () => callHarness({
  label: 'code_interpreter', model: M, builtins: ['code_interpreter'],
  input: '用 Python 计算 2 的 100 次方的精确值，告诉我结果。',
}) });

await run({ label: '垂类搜索（web_search_image 文搜图）', fn: () => callHarness({
  label: 'web_search_image', model: M, builtins: ['web_search_image'],
  input: '搜索几张杭州西湖断桥的照片。',
}) });

if (!QUICK) {
  await run({ label: '图像生成（qwen-image-3.0-pro）', fn: () => callImage({
    label: 'image', model: 'qwen-image-3.0-pro', prompt: '一张极简风格的猫的插画，纯色背景。',
  }) });

  await run({ label: '语音合成（qwen-audio-3.0-tts-plus，插件未接此路径，探测）', fn: () => probeAudio({
    label: 'tts', model: 'qwen-audio-3.0-tts-plus', text: '今天天气很好。',
  }) });

  await run({ label: '视频生成（wan3.0-video，约 2-6 分钟）', fn: () => callVideo({
    label: 'video', model: 'wan3.0-video', prompt: '海浪拍打沙滩，5 秒短视频。',
  }) });
}

const okCount = results.filter((r) => r.ok).length;
console.log(`\n结果：${okCount}/${results.length} 项可调用`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('失败明细：');
  for (const f of failed) console.log(`  - ${f.label}: ${f.error ?? f.detail ?? `finish=${f.finish}`}`);
}
