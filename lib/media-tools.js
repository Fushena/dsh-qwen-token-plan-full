import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveApiKey } from "./apikey.js";

const IMAGE_TIMEOUT_MS = 300_000;   // qwen-image-3.0-pro 实测 ~60s，留足余量
const VIDEO_TIMEOUT_MS = 900_000;   // wan3.0-video 实测 ~3.5min，轮询上限 15min
const POLL_INTERVAL_MS = 10_000;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(signal?.reason ?? new Error("aborted")); }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function resolveWorkDir(ctx, exec) {
  const wd = ctx.get?.("workingDirectory");
  if (wd) {
    if (exec?.agent && typeof wd.ensure === "function") return await wd.ensure(exec.agent, exec.signal);
    const fallback = typeof wd.defaultDirectory === "function" ? wd.defaultDirectory() : wd.defaultDirectory;
    if (typeof fallback === "string" && fallback) return fallback;
  }
  return process.cwd();
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function extFromContentType(contentType, fallback) {
  const ct = String(contentType ?? "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("mp4")) return "mp4";
  return fallback;
}

/**
 * 下载生成结果的安全约束（2026-11-10 安全审计）。
 *
 * URL 来自**上游响应**（output.choices[].image / output.video_url），是外部数据：
 *  - 协议必须 https：http:// 或 file:// 会让一个被投毒的上游响应把宿主当成代理/本地读取器；
 *  - 主机不能是字面量回环/内网地址：否则就是 SSRF，可打到本机任意服务（127.0.0.1、10.x…）；
 *  - 大小有上限：旧实现 `arrayBuffer()` 把整个响应读进内存，一个超大响应就能内存/磁盘 DoS。
 * 只做字面量判定，不做 DNS 解析 —— DNS 可以被 rebinding 操纵，字面量判定才立得住。
 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;     // 单张图片上限 10MB
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;    // 单个视频上限 200MB

/** 字面量主机名是不是本机/内网（SSRF 面）：localhost、127.x、::1、0.0.0.0、10.x、172.16-31.x、192.168.x、169.254.x。 */
export function isPrivateHostLiteral(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase();
  if (host === "") return false;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare === "localhost.") return true;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1" || bare === "::") return true;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
    octets.push(n);
  }
  const [a, b] = octets;
  if (a === 0 && octets[1] === 0 && octets[2] === 0 && octets[3] === 0) return true; // 0.0.0.0
  if (a === 127) return true;                        // 127.0.0.0/8
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16-31.x
  if (a === 192 && b === 168) return true;            // 192.168.x
  if (a === 169 && b === 254) return true;            // 169.254.x（链路本地）
  return false;
}

/** 解析并校验下载 URL：仅 https，且主机不是本机/内网字面量。抛错即拒绝。 */
export function assertDownloadUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? "")); } catch { throw new Error(`下载地址不是合法 URL：${String(raw ?? "").slice(0, 120)}`); }
  if (url.protocol !== "https:") throw new Error(`拒绝下载非 https 结果（${url.protocol}）：${url.href.slice(0, 160)}`);
  if (isPrivateHostLiteral(url.hostname)) throw new Error(`拒绝下载本机/内网地址的生成结果：${url.hostname}`);
  return url;
}

/** 流式读取并累积响应体，超过上限立即中断（绝不 arrayBuffer() 全量进内存）。 */
async function readBodyCapped(response, maxBytes, signal) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`生成结果过大（声明 ${declared} 字节，上限 ${maxBytes} 字节），已拒绝下载`);
  }
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("下载已取消");
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // 超限立刻放弃：取消底层流，不让后面的字节继续进内存。
        throw new Error(`生成结果超过大小上限（>${maxBytes} 字节），已中断下载`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* 已释放 */ }
  }
  return Buffer.concat(chunks, total);
}

export async function download(fetchImpl, url, dir, prefix, fallbackExt, signal, maxBytes = IMAGE_MAX_BYTES) {
  const safeUrl = assertDownloadUrl(url);
  const response = await fetchImpl(safeUrl.href, { signal });
  if (!response.ok) throw new Error(`下载生成结果失败：HTTP ${response.status}`);
  const ext = extFromContentType(response.headers.get("content-type"), fallbackExt);
  const bytes = await readBodyCapped(response, maxBytes, signal);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${prefix}-${stamp()}-${randomUUID().slice(0, 8)}.${ext}`);
  await writeFile(path, bytes);
  return { path, bytes: bytes.length };
}

async function postJson(fetchImpl, url, key, body, headers = {}, signal) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { ...attributionHeaders(), Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!response.ok) {
    const message = json?.message ?? json?.error?.message ?? text.slice(0, 400);
    throw new Error(`Token Plan API HTTP ${response.status}：${message}`);
  }
  return json ?? {};
}

/** 兼容两种响应形状：{output:{choices:[{message:{content:[{type:"image",image}]}}]}} 与 message 外层差异。 */
function extractImageUrls(json) {
  const urls = [];
  const choices = json?.output?.choices ?? json?.choices ?? [];
  for (const choice of choices) {
    const content = choice?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "image" && typeof part.image === "string") urls.push(part.image);
        else if (part?.type === "image_url" && typeof part.image_url?.url === "string") urls.push(part.image_url.url);
      }
    }
  }
  return urls;
}

function textBlock(text) {
  return { type: "text", text };
}

/**
 * 注册 Token Plan 媒体生成工具（图片 + 视频），消耗 Token Plan Credits。
 * budget：传入 HarnessBudget 时，图像生成按张计入「图像生成」权益额度（耗尽后拒绝调用）。
 * 返回统一注销函数。
 */
export function registerMediaTools(ctx, options) {
  const {
    apiKeyEnv, pluginName, origin, chatEndpoint,
    imageModels, videoModels, defaultImageModel, defaultVideoModel,
    providerId, fetchImpl = globalThis.fetch, logger, budget,
  } = options;

  const disposers = [];

  const imageTool = {
    name: "qwen_generate_image",
    description:
      "用千问 Token Plan 权益生成图片（消耗 Token Plan Credits，不额外计费）。" +
      "适合插画、海报、图标、照片级图像。生成后自动下载到会话工作目录并返回本地路径与原始 URL（URL 约 24 小时过期）。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "图片内容描述，中文即可，越具体越好" },
        model: { type: "string", enum: imageModels, description: `默认 ${defaultImageModel}（质量最好，约 1 分钟）；wan2.7-image 更快` },
        size: { type: "string", description: "宽*高，如 1024*1024、768*1152、1328*1328；留空用模型默认（约 2K）" },
        n: { type: "integer", minimum: 1, maximum: 4, description: "生成张数，默认 1" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          model: { type: "string" },
          paths: { type: "array", items: { type: "string" }, description: "已下载到工作目录的本地文件路径" },
          urls: { type: "array", items: { type: "string" }, description: "原始签名 URL（约 24h 过期）" },
          count: { type: "integer" },
        },
        required: ["model", "paths", "urls", "count"],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value ?? {};
        const lines = [`已生成 ${v.count ?? (v.paths ?? []).length} 张图片（${v.model ?? "image"}）：`];
        for (const [i, path] of (v.paths ?? []).entries()) lines.push(`${i + 1}. ${path}`);
        return [textBlock(lines.join("\n"))];
      },
    },
    timeoutMs: IMAGE_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = String(args?.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      const model = imageModels.includes(args?.model) ? args.model : defaultImageModel;
      const size = typeof args?.size === "string" && /^\d+\*\d+$/.test(args.size.trim()) ? args.size.trim() : undefined;
      const n = Number.isInteger(args?.n) && args.n >= 1 && args.n <= 4 ? args.n : 1;
      // 图像生成权益：额度（官方周期配额 − 本周期已生成张数）耗尽后拒绝调用。
      // 必须按本次请求的 n 预检：原先只判 remaining <= 0，于是「只剩 1 张」时
      // 一次请求 n=4 仍会放行，多出的 3 张按套餐外 88 折后付费（2026-11-10 修复）。
      // 口径与「耗尽即停用」一致：直接拒绝并说明剩余量，不悄悄收敛 n。
      const equity = budget?.equityState?.("image_generation");
      if (equity && equity.remaining < n) {
        throw new Error(
          `图像生成权益额度不足：本次请求 ${n} 张，周期内仅剩 ${equity.remaining} 张` +
          `（${equity.used}/${equity.quota}${equity.unit}），请把 n 调小或等周期重置后自动恢复`,
        );
      }
      const key = await resolveApiKey(ctx, apiKeyEnv, pluginName);
      const body = {
        model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        stream: false,
        parameters: { ...(size ? { size } : {}), ...(n > 1 ? { n } : {}) },
      };
      const json = await postJson(fetchImpl, chatEndpoint, key, body, {}, exec.signal);
      const urls = extractImageUrls(json);
      if (urls.length === 0) throw new Error(`模型 ${model} 没有返回图片（响应：${JSON.stringify(json).slice(0, 300)}）`);
      const dir = await resolveWorkDir(ctx, exec);
      const paths = [];
      for (const url of urls) {
        const saved = await download(fetchImpl, url, dir, "qwen-image", "png", exec.signal);
        paths.push(saved.path);
      }
      budget?.record?.("image_generation", paths.length);
      logger?.info?.(`qwen_generate_image: ${model} ×${paths.length} → ${dir}`);
      return { model, paths, urls, count: paths.length };
    },
  };

  const videoTool = {
    name: "qwen_generate_video",
    description:
      "用千问 Token Plan 权益生成短视频（消耗 Token Plan Credits，不额外计费）。" +
      "时长 3-15 秒（duration 参数，默认 5 秒）；时长越长 Credits 消耗越多。" +
      "异步任务：提交后每 10 秒轮询，通常 2-6 分钟出片（5 秒 1080P）。完成后自动下载到会话工作目录并返回本地路径。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "视频内容描述，中文即可；描述镜头运动效果更好" },
        model: { type: "string", enum: videoModels, description: `默认 ${defaultVideoModel}` },
        size: { type: "string", description: "分辨率 宽*高，如 832*480（16:9）、480*832（竖屏）；留空用默认" },
        duration: { type: "integer", minimum: 3, maximum: 15, description: "视频时长（秒），3-15 可选，默认 5；Credits 消耗随时长增加" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          model: { type: "string" },
          path: { type: "string", description: "已下载到工作目录的本地 mp4 路径" },
          url: { type: "string", description: "原始签名 URL（约 24h 过期）" },
          taskId: { type: "string" },
          seconds: { type: "number", description: "视频时长（秒）" },
        },
        required: ["model", "path", "url", "taskId"],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value ?? {};
        return [textBlock(`已生成视频（${v.model ?? "video"}${v.seconds ? `，${v.seconds}s` : ""}）：\n${v.path ?? ""}`)];
      },
    },
    timeoutMs: VIDEO_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = String(args?.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      const model = videoModels.includes(args?.model) ? args.model : defaultVideoModel;
      const size = typeof args?.size === "string" && /^\d+\*\d+$/.test(args.size.trim()) ? args.size.trim() : undefined;
      // duration：Token Plan 端 wan3.0-video 支持 3-15 秒（默认 5）。非法值静默忽略，回退服务端默认。
      const duration = Number.isInteger(Number(args?.duration)) && Number(args.duration) >= 3 && Number(args.duration) <= 15
        ? Number(args.duration) : undefined;
      const key = await resolveApiKey(ctx, apiKeyEnv, pluginName);
      const submit = await postJson(
        fetchImpl,
        `${origin}/api/v1/services/aigc/video-generation/video-synthesis`,
        key,
        { model, input: { prompt }, ...(size || duration ? { parameters: { ...(size ? { size } : {}), ...(duration ? { duration } : {}) } } : {}) },
        { "X-DashScope-Async": "enable" },
        exec.signal,
      );
      const taskId = submit?.output?.task_id;
      if (!taskId) throw new Error(`视频任务提交失败（响应：${JSON.stringify(submit).slice(0, 300)}）`);
      logger?.info?.(`qwen_generate_video: 任务 ${taskId} 已提交，开始轮询`);

      const deadline = Date.now() + VIDEO_TIMEOUT_MS - 30_000;
      let status = String(submit?.output?.task_status ?? "PENDING");
      let task = submit;
      while (status !== "SUCCEEDED") {
        if (exec.signal?.aborted) throw new Error("视频生成已取消");
        if (Date.now() > deadline) throw new Error(`视频任务 ${taskId} 超过 ${Math.round(VIDEO_TIMEOUT_MS / 60000)} 分钟仍未完成（最后状态 ${status}），可稍后用任务 id 查询`);
        await sleep(POLL_INTERVAL_MS, exec.signal);
        const response = await fetchImpl(`${origin}/api/v1/tasks/${taskId}`, {
          headers: { ...attributionHeaders(), Authorization: `Bearer ${key}` },
          signal: exec.signal,
        });
        task = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`查询视频任务失败：HTTP ${response.status}`);
        status = String(task?.output?.task_status ?? status);
        if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
          throw new Error(`视频任务 ${status}：${task?.output?.message ?? task?.output?.code ?? "无错误信息"}`);
        }
      }
      const videoUrl = task?.output?.video_url;
      if (!videoUrl) throw new Error(`任务成功但没有 video_url（响应：${JSON.stringify(task).slice(0, 300)}）`);
      const dir = await resolveWorkDir(ctx, exec);
      // 视频走的也是上游给的 video_url，同样按 200MB 上限约束。
      const saved = await download(fetchImpl, videoUrl, dir, "qwen-video", "mp4", exec.signal, VIDEO_MAX_BYTES);
      const seconds = Number(task?.usage?.duration ?? task?.usage?.output_video_duration);
      logger?.info?.(`qwen_generate_video: ${taskId} → ${saved.path}`);
      return { model, path: saved.path, url: videoUrl, taskId, ...(Number.isFinite(seconds) ? { seconds } : {}) };
    },
  };

  // 按 provider 隔离：媒体生成工具只在「选中本插件的模型」时出现，
  // 用 DSH 自带模型或另一个插件（ark）的模型时它们不可见，互不影响。
  // 未指定 providerId 时退回全局注册，保持向后兼容。
  const gated = providerId
    ? { when: (context) => context?.modelSelection?.provider === providerId }
    : {};
  disposers.push(ctx.tools.register(imageTool, gated));
  disposers.push(ctx.tools.register(videoTool, gated));
  return () => { for (const dispose of disposers) { try { dispose?.(); } catch { /* best effort */ } } };
}
