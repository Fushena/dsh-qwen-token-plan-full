import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import dns from "node:dns";
import { mkdir, readFile, stat, realpath, open, rename, unlink } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
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

const REF_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** 按**实际内容魔数**判图片类型（不是扩展名）：PNG 89504E47 / JPEG FFD8FF / WebP RIFF????WEBP。 */
function sniffImageMime(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * 参考图安全装载（2026-11-18 修复缺陷 A+D）。旧实现不校验扩展名/内容/目录，直接 readFile
 * 任意绝对路径塞进上游请求体 —— 提示注入即可把 .env 等任意本地文件逐字节外发（实测）。
 * 四道闸，全部失败即抛明确中文错误，绝不静默降级成「没有参考图」：
 *  ① 扩展名白名单 .png/.jpg/.jpeg/.webp；
 *  ② 限制在会话工作目录内：path.resolve 归一 + realpath 收口（.. 穿越与符号链接都按
 *     **真实路径**比对；工作目录自身也 realpath，否则 macOS /var→/private/var 会误判）；
 *  ③ 先 stat 判「普通文件 + 大小 ≤ IMAGE_MAX_BYTES」再读（旧实现先 readFile 再判大小，
 *     150MB 文件在被拒前已整个进内存）；
 *  ④ 魔数校验真实内容，mime 由内容决定（扩展名可以撒谎，内容不会）。
 */
async function loadReferenceImage(ctx, exec, refPath) {
  const ext = extname(refPath).toLowerCase();
  if (!REF_IMAGE_EXTS.has(ext)) {
    throw new Error(`参考图扩展名不在白名单内（仅允许 .png/.jpg/.jpeg/.webp）：${refPath}`);
  }
  const workDir = await resolveWorkDir(ctx, exec);
  const realWorkDir = await realpath(resolve(workDir));
  let realRef;
  try {
    realRef = await realpath(resolve(workDir, refPath));
  } catch {
    throw new Error(`参考图不存在或无法访问：${refPath}`);
  }
  // 前缀比对带 sep 边界：/a/b 不能匹配 /a/bc；等于工作目录本身也不行（那是目录不是图）。
  if (realRef !== realWorkDir && !realRef.startsWith(realWorkDir + sep)) {
    throw new Error(`参考图越出会话工作目录（.. 穿越或符号链接指向外部），已拒绝：${refPath}`);
  }
  const st = await stat(realRef);
  if (!st.isFile()) throw new Error(`参考图必须是普通文件（目录/设备/管道等一律拒绝）：${refPath}`);
  if (st.size > IMAGE_MAX_BYTES) throw new Error(`参考图过大（${st.size} 字节，上限 ${IMAGE_MAX_BYTES}）`);
  const buf = await readFile(realRef);
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error(`参考图内容校验失败：魔数不是有效的 PNG/JPEG/WebP 图片：${refPath}`);
  return { buf, mime };
}

/**
 * 下载生成结果的安全约束（2026-11-10 安全审计，2026-11-18 加固）。
 *
 * URL 来自**上游响应**（output.choices[].image / output.video_url），是外部数据：
 *  - 协议必须 https：http:// 或 file:// 会让一个被投毒的上游响应把宿主当成代理/本地读取器；
 *  - 主机不能是本机/内网地址：否则就是 SSRF，可打到本机任意服务（127.0.0.1、10.x…）；
 *  - 大小有上限：旧实现把整个响应累积进内存（实测 64MB→RSS+184MB），现改为边读边写盘，
 *    内存占用与文件大小无关；超限立即 cancel 底层流。
 *
 * 域名必须 DNS 解析后再判（2026-11-18 修复，旧注释「不做 DNS 解析」方向反了）：
 * localtest.me 这类**公网域名** A 记录指向 127.0.0.1，只判字面量等于放行（实测下载成功）。
 * 解析失败/无结果 → 放行 + warn（lead 复核定稿，非 fail-closed）：直连时解析不了 fetch 自己
 * 也连不上，fail-closed 无安全收益；而跨境代理场景 ProxyAgent 由代理侧解析主机名，本地 DNS
 * 对境外 CDN 可能污染/失败，fail-closed 会打死合法下载。真正判据是「解析成功且任一地址私网」。
 *
 * 残留风险（已知且接受，不假装解决）：① 走代理时本地 DNS 校验只是 best-effort，代理侧解析
 * 绕不过；② DNS rebinding / TOCTOU：lookup 校验与 fetch 建连是两次独立解析，攻击者控制的
 * 权威 DNS 可在两次之间切换答案（校验时公网、连接时内网）。彻底封堵需把校验 IP 钉进连接
 *（自定义 undici dispatcher 的 connect.lookup），但 fetchImpl 可能经 ProxyAgent（lib/proxy.js），
 * 钉 IP 会破坏代理转发/SNI/证书校验。权衡：选择「每一跳都解析校验 + 写明残留风险」，把利用
 * 门槛抬到「需控制目标域名权威 DNS 且赢得两次解析间的竞态」，不做假性根治。
 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;     // 单张图片上限 10MB
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;    // 单个视频上限 200MB

/** IPv4 点分四段 → [a,b,c,d]；不是合法 IPv4 字面量返回 null。 */
function parseIpv4Literal(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isPrivateIpv4([a, b, c, d]) {
  if (a === 0 && b === 0 && c === 0 && d === 0) return true; // 0.0.0.0
  if (a === 127) return true;                        // 127.0.0.0/8
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16-31.x
  if (a === 192 && b === 168) return true;            // 192.168.x
  if (a === 169 && b === 254) return true;            // 169.254.x（链路本地）
  // 2026-11-18 补齐（实测旧黑名单放行）：
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT（Tailscale 就用这段）
  if (a === 192 && b === 0 && c === 0) return true;   // 192.0.0.0/24 IETF 协议分配
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224 && a <= 239) return true;              // 224.0.0.0/4 组播
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // 受限广播
  return false;
}

/**
 * IPv6 字面量 → 8 个 16 位组；不是合法 IPv6 返回 null。
 * 支持 :: 压缩、末尾内嵌 IPv4（::ffff:127.0.0.1）、%zone 后缀（剥掉再判）。
 */
function parseIpv6Literal(text) {
  let s = String(text);
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4Literal(tail);
    if (!v4) return null;
    const g0 = ((v4[0] << 8) | v4[1]).toString(16);
    const g1 = ((v4[2] << 8) | v4[3]).toString(16);
    s = s.slice(0, lastColon + 1) + g0 + ":" + g1;
  }
  let parts;
  const dbl = s.indexOf("::");
  if (dbl >= 0) {
    if (s.indexOf("::", dbl + 1) >= 0) return null; // 只允许一个 ::
    const head = s.slice(0, dbl) ? s.slice(0, dbl).split(":") : [];
    const rest = s.slice(dbl + 2) ? s.slice(dbl + 2).split(":") : [];
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null; // :: 至少要展开一组
    parts = [...head, ...Array(missing).fill("0"), ...rest];
  } else {
    parts = s.split(":");
    if (parts.length !== 8) return null;
  }
  const groups = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    groups.push(parseInt(p, 16));
  }
  return groups.length === 8 ? groups : null;
}

function isPrivateIpv6(text) {
  const g = parseIpv6Literal(text);
  if (!g) return false;
  if (g.every((x, i) => (i < 7 ? x === 0 : x === 1))) return true; // ::1 回环
  if (g.every((x) => x === 0)) return true;                        // :: 未指定
  // IPv4-mapped ::ffff:a.b.c.d 与 IPv4-compatible ::a.b.c.d：内嵌 IPv4 按同一黑名单判。
  // new URL 会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1，所以必须按组判而不是按字符串。
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  const compatible = g.slice(0, 6).every((x) => x === 0) && (g[6] !== 0 || g[7] !== 0);
  if (mapped || compatible) {
    return isPrivateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  const firstByte = g[0] >> 8;
  if (firstByte === 0xfc || firstByte === 0xfd) return true;       // fc00::/7 ULA
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true;               // fe80::/10 链路本地
  if (g[0] >= 0xfec0 && g[0] <= 0xfeff) return true;               // fec0::/10 站点本地（已废弃，仍属内网）
  return false;
}

/**
 * 字面量主机名是不是本机/内网（SSRF 面）：
 * localhost、127.x、0.0.0.0、10.x、172.16-31.x、192.168.x、169.254.x，
 * 以及 IPv6 的 ::1、::、IPv4-mapped/compatible 内嵌内网地址、fc00::/7 ULA、
 * fe80::/10 链路本地、fec0::/10 站点本地（2026-11-13 审计补齐）。
 */
export function isPrivateHostLiteral(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase();
  if (host === "") return false;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare === "localhost.") return true;
  if (bare.includes(":")) return isPrivateIpv6(bare);
  const octets = parseIpv4Literal(bare);
  return octets ? isPrivateIpv4(octets) : false;
}

/**
 * 解析并校验下载 URL（**同步**）：仅 https + 主机不是本机/内网字面量。抛错即拒绝。
 * 必须保持同步返回 URL：既有测试 test/route-guard.test.mjs:152 用 assert.throws 同步断言、
 * :153 直接取返回值 .hostname —— 这两条钉死了同步契约，不能改成 async。
 * DNS 加固放在 download 的异步路径里（assertHostDnsSafe），不污染这个同步函数。
 */
export function assertDownloadUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? "")); } catch { throw new Error(`下载地址不是合法 URL：${String(raw ?? "").slice(0, 120)}`); }
  if (url.protocol !== "https:") throw new Error(`拒绝下载非 https 结果（${url.protocol}）：${url.href.slice(0, 160)}`);
  if (isPrivateHostLiteral(url.hostname)) throw new Error(`拒绝下载本机/内网地址的生成结果：${url.hostname}`);
  return url;
}

/**
 * 非字面量域名的 DNS 加固（2026-11-18 修复缺陷 C）：解析所有 A/AAAA，任一落在私网即拒。
 * localtest.me 这类**公网域名** A 记录指向 127.0.0.1，只判字面量等于放行（实测下载成功）。
 * 由 download 在每一跳 await 调用（重定向每跳都重新解析校验）。
 *
 * 解析失败的取舍（lead 复核定稿：放行 + warn，不是 fail-closed）：
 *  - 直连场景 fail-closed 不增加任何安全性：域名真解析不了，紧接着的 fetch 自己也连不上，
 *    SSRF 无从发生；
 *  - 而本插件核心场景是跨境挂代理：ProxyAgent 把**主机名交给代理去解析**，本地 DNS 对
 *    境外 CDN 域名可能污染/失败，fail-closed 会把合法境外产物下载整片打死。
 * 真正有价值的判据是「解析成功且任一地址落在私网」。
 * 残留风险（已知且接受，不假装解决）：① 走代理时本地 DNS 校验只是 best-effort，代理侧
 * 解析绕不过；② DNS rebinding：lookup 校验与 fetch 建连是两次独立解析，存在时间窗
 *（校验时公网、连接时内网）。彻底封堵需把校验 IP 钉进连接（自定义 undici dispatcher 的
 * connect.lookup），但会破坏 ProxyAgent 转发/SNI/证书校验，权衡后不做假性根治。
 */
async function assertHostDnsSafe(url, logger) {
  const host = url.hostname;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // 字面量（IPv4/IPv6/localhost）不做 DNS：既快又避免对 IP 字面量无谓解析（既有测试钉死）。
  const isLiteral = parseIpv4Literal(bare) !== null || parseIpv6Literal(bare) !== null
    || bare === "localhost" || bare === "localhost.";
  if (isLiteral) return;
  let answers;
  try {
    // 属性方式调用（非命名导入绑定），便于测试在 node:dns.promises.lookup 边界 mock。
    answers = await dns.promises.lookup(bare, { all: true, verbatim: true });
  } catch (err) {
    logger?.warn?.(`下载域名本地 DNS 解析失败（${err?.code ?? "unknown"}），放行交由连接层/代理处理：${host}`);
    return;
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    logger?.warn?.(`下载域名无本地 DNS 解析结果，放行交由连接层/代理处理：${host}`);
    return;
  }
  for (const ans of answers) {
    const addr = String(ans?.address ?? "");
    if (isPrivateHostLiteral(addr)) {
      throw new Error(`拒绝下载本机/内网地址的生成结果：${host}（解析到 ${addr}）`);
    }
  }
}

/**
 * 流式读取响应体并**边读边写盘**（2026-11-18 修复缺陷 B）。
 * 旧实现把 chunks 累积进内存再 Buffer.concat（实测 64MB→RSS+184MB，200MB 上限≈600MB）；
 * 现在每个 chunk 立即写入临时文件句柄，内存占用与文件大小无关。
 * 保留：content-length 预检（在读流/开文件之前）、累计上限、超限立即 cancel 底层流。
 * 返回写入字节数；临时文件的清理/改名由调用方 download 负责。
 */
async function streamBodyToFile(response, maxBytes, signal, tmpPath) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`生成结果过大（声明 ${declared} 字节，上限 ${maxBytes} 字节），已拒绝下载`);
  }
  const body = response.body;
  const fh = await open(tmpPath, "w");
  let total = 0;
  try {
    if (!body) return 0;
    const reader = body.getReader();
    try {
      while (true) {
        if (signal?.aborted) throw signal.reason ?? new Error("下载已取消");
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          // 超限立刻放弃：取消底层流，不让后面的字节继续进内存/进盘。
          throw new Error(`生成结果超过大小上限（>${maxBytes} 字节），已中断下载`);
        }
        await fh.write(value); // 逐块落盘，不在内存累积
      }
    } finally {
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch { /* 已释放 */ }
    }
    return total;
  } finally {
    await fh.close().catch(() => {});
  }
}

const MAX_DOWNLOAD_REDIRECTS = 5;

export async function download(fetchImpl, url, dir, prefix, fallbackExt, signal, maxBytes = IMAGE_MAX_BYTES, logger) {
  // 手动跟随重定向、每一跳都重新过 SSRF 校验（字面量同步判 + 域名 DNS 异步判）：
  // 默认 redirect:follow 只在第一跳校验，被投毒的上游 302 → http://127.0.0.1/… 或
  // → 内网域名就能绕过（2026-11-13/18 审计）。
  let safeUrl = assertDownloadUrl(url);
  await assertHostDnsSafe(safeUrl, logger);
  let response;
  for (let hops = 0; ; hops += 1) {
    response = await fetchImpl(safeUrl.href, { signal, redirect: "manual" });
    const status = response.status;
    const location = response.headers?.get?.("location");
    if (status >= 300 && status < 400 && location) {
      if (hops >= MAX_DOWNLOAD_REDIRECTS) throw new Error(`下载生成结果的重定向超过 ${MAX_DOWNLOAD_REDIRECTS} 跳，已拒绝`);
      const nextUrl = assertDownloadUrl(new URL(location, safeUrl).href);
      await assertHostDnsSafe(nextUrl, logger);
      // 放弃中间跳的响应体，别让连接挂着等 GC。
      try { await response.body?.cancel(); } catch { /* best effort */ }
      safeUrl = nextUrl;
      continue;
    }
    break;
  }
  if (!response.ok) throw new Error(`下载生成结果失败：HTTP ${response.status}`);
  const ext = extFromContentType(response.headers.get("content-type"), fallbackExt);
  await mkdir(dir, { recursive: true });
  // 最终命名沿用既有逻辑（本地生成，无穿越问题）；先写临时 .part 再 rename，
  // 失败路径清理临时文件，绝不留下半截产物冒充成功结果。
  const path = join(dir, `${prefix}-${stamp()}-${randomUUID().slice(0, 8)}.${ext}`);
  const tmpPath = `${path}.part-${randomUUID().slice(0, 8)}`;
  let total;
  try {
    total = await streamBodyToFile(response, maxBytes, signal, tmpPath);
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {}); // 清理半截临时文件
    try { await response.body?.cancel?.(); } catch { /* best effort */ }
    throw err;
  }
  return { path, bytes: total };
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

/** 兼容三种响应形状：compatible-mode {type:"image",image} / {type:"image_url"} 与原生多模态 {image:url}（无 type）。 */
function extractImageUrls(json) {
  const urls = [];
  const choices = json?.output?.choices ?? json?.choices ?? [];
  for (const choice of choices) {
    const content = choice?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "image" && typeof part.image === "string") urls.push(part.image);
        else if (part?.type === "image_url" && typeof part.image_url?.url === "string") urls.push(part.image_url.url);
        else if (part?.type === undefined && typeof part?.image === "string") urls.push(part.image);
      }
    }
  }
  return urls;
}

function textBlock(text) {
  return { type: "text", text };
}

/** 上游 schema 的属性名集合（小写），用于按语义匹配而不写死某家的字段名。 */
function schemaKeys(schema) {
  const props = schema?.properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}

/** 在候选名里挑第一个真实存在的属性名；都不在则返回 undefined（宁可不传也不瞎塞）。 */
function pickKey(keys, candidates) {
  const lower = new Map(keys.map((key) => [key.toLowerCase(), key]));
  for (const candidate of candidates) {
    const hit = lower.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 从 MCP 工具结果里取图片：URL 优先（可复用既有 SSRF 下载闸），
 * 其次内联 base64（宿主适配器已把图片投影成 attachments，这里再落一份到工作目录）。
 * 上游形状各家不同，故同时扫 structuredContent 与 content 文本里的 URL。
 */
function extractMcpImages(value) {
  const urls = [];
  const inline = [];
  const seen = new Set();
  const pushUrl = (raw) => {
    const text = String(raw ?? "").trim();
    if (!/^https?:\/\//i.test(text) || seen.has(text)) return;
    seen.add(text);
    urls.push(text);
  };
  const walk = (node, depth = 0) => {
    if (depth > 6 || node == null) return;
    if (typeof node === "string") {
      for (const hit of node.match(/https?:\/\/[^\s"'<>)]+/g) ?? []) pushUrl(hit);
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (typeof node !== "object") return;
    if (node.type === "image" && typeof node.data === "string") {
      inline.push({ data: node.data, mime: String(node.mimeType ?? "image/png") });
    }
    for (const [key, item] of Object.entries(node)) {
      if (typeof item === "string" && /^(image_?url|url|image|output_?image)$/i.test(key)) pushUrl(item);
      else walk(item, depth + 1);
    }
  };
  walk(value?.structuredContent);
  walk(value?.content);
  return { urls, inline };
}

/** 内联 base64 图片落盘（同样过大小上限；不经过网络，无需 SSRF 闸）。 */
async function saveInlineImage(dir, prefix, block, maxBytes) {
  const buf = Buffer.from(String(block.data ?? ""), "base64");
  if (buf.length === 0) throw new Error("MCP 返回的图片数据为空");
  if (buf.length > maxBytes) throw new Error(`生成结果超过大小上限（>${maxBytes} 字节），已拒绝保存`);
  const ext = extFromContentType(block.mime, "png");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${prefix}-${stamp()}-${randomUUID().slice(0, 8)}.${ext}`);
  const fh = await open(path, "w");
  try { await fh.write(buf); } finally { await fh.close().catch(() => {}); }
  return { path, bytes: buf.length };
}

/**
 * 选上游生图工具：优先「文生图」语义（text_to_image / text2image / generate_image /
 * image_generation / synthesis），排除明显的图生图/编辑/放大类，避免把编辑工具当生图用。
 * 返回 { rawName, definition }；候选为空返回 undefined。
 */
function pickImageTool(candidates, defs, needReference) {
  const score = (item) => {
    const name = item.name.toLowerCase();
    let value = 0;
    if (/text[_-]?to[_-]?image|text2image|txt2img/.test(name)) value += 6;
    if (/generate|synthesis|create|draw|paint/.test(name)) value += 3;
    if (/image/.test(name)) value += 1;
    if (/edit|inpaint|outpaint|upscale|variation|repaint|image[_-]?to[_-]?image|img2img/.test(name)) value -= 5;
    if (needReference && /edit|image[_-]?to[_-]?image|img2img|repaint/.test(name)) value += 8;
    return value;
  };
  const ranked = candidates
    .map((item, index) => ({ item, definition: defs[index], value: score(item) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);
  const best = ranked[0];
  return best ? { rawName: best.item.name, definition: best.definition } : undefined;
}

/**
 * 注册 Token Plan 媒体生成工具（图片 + 视频），消耗 Token Plan Credits。
 * budget：传入 HarnessBudget 时，图像生成按张计入「图像生成」权益额度（耗尽后拒绝调用）。
 * acceptProviders：除本插件 providerId 外，同样可见这些工具的 provider（如手工配的
 * qwentokenplan）——生成工具自己发 API 请求，不要求聊天经过本插件的 adapter。
 * 返回统一注销函数。
 */
export function registerMediaTools(ctx, options) {
  const {
    apiKeyEnv, pluginName, origin, chatEndpoint,
    imageModels, videoModels, defaultImageModel, defaultVideoModel,
    providerId, acceptProviders = [], fetchImpl = globalThis.fetch, logger, budget,
  } = options;

  // 权益 MCP 通道（2026-11-23）：有百炼按量付费 Key 且服务连通、权益还有余额时，
  // 生图走 MCP —— 扣官方那 20 张权益，不花 Credits。否则回落模型 API（扣 Credits）。
  // mcp 缺省时行为与旧版完全一致。
  const mcp = options.mcp;
  const mcpReady = () => {
    try { return typeof mcp?.usesEquity === "function" && mcp.usesEquity("image_generation"); }
    catch { return false; }
  };

  // 站点自动判定可能在工具注册之后才出结果：给了 route 就读它的**当前值**，
  // 否则图片/视频工具会一直打着装配时那个旧地域（半切换）。不给 route 时行为不变。
  const route = options.route;
  const currentChatEndpoint = () => (route ? route.chatEndpoint : chatEndpoint);
  const currentOrigin = () => (route ? route.origin : origin);
  // 站点判定门控：媒体工具自己发 API 请求，不经过 adapter.stream。
  // 观察-only（registerProvider=false，上游 0.4.0）时聊天完全不走本插件，
  // adapter 上那层门控一次都不会触发 —— 生图会成为第一个打到旧地域的请求，
  // 而跨站点 401 不在可重试码里，一次就是彻底失败。所以这里也要等判定。
  const awaitSite = typeof options.awaitSite === "function" ? options.awaitSite : null;

  const disposers = [];

  /**
   * 权益通道生图：调百炼 TextGenerateImage MCP，扣官方权益额度、不花 Credits。
   * 上游字段名按真实 schema 匹配；返回 { tool, paths, urls, dir }。
   */
  const generateViaMcp = async ({ prompt, model, size, n, exec }) => {
    const { tool, value } = await mcp.callTool(
      "TextGenerateImage",
      exec,
      (candidates, defs) => pickImageTool(candidates, defs, false),
      (schema) => {
        const keys = schemaKeys(schema);
        const args = {};
        const promptKey = pickKey(keys, ["prompt", "text", "input", "description", "content"]);
        if (!promptKey) throw new Error("上游生图工具没有可识别的 prompt 字段");
        args[promptKey] = prompt;
        const modelKey = pickKey(keys, ["model", "model_id", "model_name"]);
        if (modelKey) args[modelKey] = model;
        const sizeKey = pickKey(keys, ["size", "resolution", "image_size"]);
        if (size && sizeKey) args[sizeKey] = size;
        const countKey = pickKey(keys, ["n", "count", "num_images", "image_count", "batch_size"]);
        if (n > 1 && countKey) args[countKey] = n;
        return args;
      },
    );
    const { urls, inline } = extractMcpImages(value);
    if (urls.length === 0 && inline.length === 0) {
      throw new Error(`MCP 生图没有返回图片（响应：${JSON.stringify(value).slice(0, 300)}）`);
    }
    return { tool, urls, inline };
  };

  /**
   * 落盘阶段独立于上游调用：**这里的失败不许回落模型 API**。
   * 图已经生成、权益已经扣掉，再走一遍付费通道等于同一张图收两次钱
   * （一次权益、一次 Credits），还会产出两份不一致的图。所以异常直接上抛。
   */
  const saveMcpImages = async ({ urls, inline }, exec) => {
    const dir = await resolveWorkDir(ctx, exec);
    const paths = [];
    for (const url of urls) {
      const saved = await download(fetchImpl, url, dir, "qwen-image-mcp", "png", exec.signal, IMAGE_MAX_BYTES, logger);
      paths.push(saved.path);
      // 逐张记账：权益按张计，中途失败已落盘的仍计入（2026-11-13 定的口径）。
      budget?.record?.("image_generation", 1);
    }
    for (const block of inline) {
      const saved = await saveInlineImage(dir, "qwen-image-mcp", block, IMAGE_MAX_BYTES);
      paths.push(saved.path);
      budget?.record?.("image_generation", 1);
    }
    return { paths, dir };
  };

  const imageTool = {
    name: "qwen_generate_image",
    description:
      "生成图片（插画、海报、图标、照片级图像）。优先走百炼 MCP 权益通道：消耗套餐单列的图像生成权益额度、不花 Credits；" +
      "权益额度用尽或 MCP 不可用时自动回落模型 API（消耗 Token Plan Credits）。" +
      "生成后自动下载到会话工作目录并返回本地路径与原始 URL（URL 约 24 小时过期）。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "图片内容描述，中文即可，越具体越好" },
        referenceImage: { type: "string", description: "可选参考图的本地绝对路径（PNG/JPEG/WebP）。提供后做图生图编辑：以参考图为基准，按 prompt 局部修改，保持其余部分一致。适合统一系列图标风格。" },
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
      if (awaitSite) await awaitSite();
      const prompt = String(args?.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      const model = imageModels.includes(args?.model) ? args.model : defaultImageModel;
      const size = typeof args?.size === "string" && /^\d+\*\d+$/.test(args.size.trim()) ? args.size.trim() : undefined;
      const n = Number.isInteger(args?.n) && args.n >= 1 && args.n <= 4 ? args.n : 1;
      const refPath = typeof args?.referenceImage === "string" ? args.referenceImage.trim() : "";
      // 参考图只有模型 API 那条路支持（MCP 上游收 URL，本地文件传不进去），
      // 所以带参考图时直接按模型通道处理，别在权益通道上白跑一趟。
      const viaMcp = !refPath && mcpReady();
      // 权益额度预检**只在权益通道上做**，且必须按本次请求的 n 判：
      // 只判 remaining <= 0 的话，「只剩 1 张」时一次请求 n=4 仍会放行，
      // 多出的 3 张按套餐外 88 折后付费（2026-11-10 修复）。直接拒绝并说明剩余量，
      // 不悄悄收敛 n。模型 API 通道花的是 Credits，官方那 20 张与它无关，
      // 拿权益余额拦它是错位护栏（2026-11-23 修正）。
      const equity = viaMcp ? budget?.equityState?.("image_generation") : undefined;
      if (equity && equity.remaining < n) {
        throw new Error(
          `图像生成权益额度不足：本次请求 ${n} 张，周期内仅剩 ${equity.remaining} 张` +
          `（${equity.used}/${equity.quota}${equity.unit}），请把 n 调小或等周期重置后自动恢复`,
        );
      }

      if (viaMcp) {
        // 权益通道：调百炼 TextGenerateImage MCP。上游工具名/字段名不写死，
        // 按宿主同步来的真实 schema 匹配（见 pickImageTool / pickKey）。
        // **只有上游调用失败才回落**模型 API（用户要的是「先吃免费额度，用完照样能画」）；
        // 落盘失败不回落 —— 图已生成、权益已扣，再走付费通道就是同一张图收两次钱。
        let produced = null;
        try {
          produced = await generateViaMcp({ prompt, model, size, n, exec });
        } catch (error) {
          if (exec?.signal?.aborted) throw error;
          logger?.warn?.(
            `qwen_generate_image: MCP 权益通道失败（${String(error?.message ?? error)}），` +
            "回落模型 API（本次消耗 Credits，不扣权益额度）",
          );
        }
        if (produced) {
          const { paths, dir } = await saveMcpImages(produced, exec);
          logger?.info?.(`qwen_generate_image[MCP权益]: ${produced.tool} ×${paths.length} → ${dir}`);
          return { model: `mcp:${produced.tool}`, paths, urls: produced.urls, count: paths.length };
        }
      }
      const key = await resolveApiKey(ctx, apiKeyEnv, pluginName);
      // qwen-image / wan2.7-image 系列**只能**走 DashScope 原生多模态端点
      //（/api/v1/services/aigc/multimodal-generation/generation）。
      // 2026-11-23 修复：旧实现把「无参考图」的纯文本生图发到 compatible-mode
      // chat/completions（OpenAI 形状 messages[].content=[{type:"text",text}]），
      // 但图像模型在该网关按原生形状校验，三个模型一律 400：
      //   "Input should be 'user': input.messages.0.role &
      //    Input should be a valid list: input.messages.0.content &
      //    Input should be a valid list: input.messages.1.content"
      //（网关把顶层 messages 当成 input.messages，且要求 content 是原生 part 列表）。
      // 图生图分支本就走原生端点（compatible-mode 还拒绝 image+text 混合 content，报
      // "Either 'text' or 'image' must be provided, but not both"）。
      // 统一两条分支到原生端点：input.messages[0].content = [{text:prompt}]（纯文本）
      // 或 [{image:url|base64}, {text:prompt}]（图生图）。原生端点纯文本生图已实测 200。
      const content = [{ text: prompt }];
      // prompt_extend：纯文本生图保留服务端默认（智能改写提升出图质量）；
      // 图生图关闭——编辑指令要逐字执行，不让改写丢掉「保持不变」约束。
      const parameters = { ...(size ? { size } : {}), ...(n > 1 ? { n } : {}) };
      if (refPath) {
        // 四道安全闸（扩展名白名单/工作目录收口/stat 前置/魔数定 mime），见 loadReferenceImage。
        const { buf: refBuf, mime } = await loadReferenceImage(ctx, exec, refPath);
        const dataUrl = `data:${mime};base64,${refBuf.toString("base64")}`;
        content.unshift({ image: dataUrl });
        parameters.prompt_extend = false;
      }
      const body = { model, input: { messages: [{ role: "user", content }] }, parameters };
      const json = await postJson(fetchImpl, `${currentOrigin()}/api/v1/services/aigc/multimodal-generation/generation`, key, body, {}, exec.signal);
      const urls = extractImageUrls(json);
      if (urls.length === 0) throw new Error(`模型 ${model} 没有返回图片（响应：${JSON.stringify(json).slice(0, 300)}）`);
      const dir = await resolveWorkDir(ctx, exec);
      const paths = [];
      for (const url of urls) {
        const saved = await download(fetchImpl, url, dir, "qwen-image", "png", exec.signal, IMAGE_MAX_BYTES, logger);
        paths.push(saved.path);
        // 模型 API 通道花的是 Credits，**不扣官方那 20 张权益**（sk-sp- Key 不参与
        // Harness 计量），所以这里不再记 image_generation —— 否则面板会把「没花掉的
        // 权益」显示成已用，正是本次要修的错位（2026-11-23）。权益记账只在 MCP 通道做。
      }
      logger?.info?.(`qwen_generate_image[模型API/Credits]: ${model} ×${paths.length} → ${dir}`);
      // 一次生成任务计一次模型调用（权益按张另计，见循环内 record）。
      budget?.recordRequest?.();
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
      if (awaitSite) await awaitSite();
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
        `${currentOrigin()}/api/v1/services/aigc/video-generation/video-synthesis`,
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
        const response = await fetchImpl(`${currentOrigin()}/api/v1/tasks/${taskId}`, {
          headers: { ...attributionHeaders(), Authorization: `Bearer ${key}` },
          signal: exec.signal,
        });
        task = await response.json().catch(() => ({}));
        if (!response.ok) {
          // 2026-11-18 修复缺陷 E：旧实现这里只报笼统 HTTP 状态，把已解析出的上游
          // output.message/code 直接丢掉（如「内容审核未通过」），用户无从排障。
          // 保留上游具体错误；body 不可解析时退回既有「HTTP 状态」文案。
          const upstream = task?.output?.message ?? task?.output?.code ?? task?.message ?? task?.code;
          throw new Error(upstream
            ? `查询视频任务失败：HTTP ${response.status}：${upstream}`
            : `查询视频任务失败：HTTP ${response.status}`);
        }
        status = String(task?.output?.task_status ?? status);
        if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
          throw new Error(`视频任务 ${status}：${task?.output?.message ?? task?.output?.code ?? "无错误信息"}`);
        }
      }
      const videoUrl = task?.output?.video_url;
      if (!videoUrl) throw new Error(`任务成功但没有 video_url（响应：${JSON.stringify(task).slice(0, 300)}）`);
      const dir = await resolveWorkDir(ctx, exec);
      // 视频走的也是上游给的 video_url，同样按 200MB 上限约束。
      const saved = await download(fetchImpl, videoUrl, dir, "qwen-video", "mp4", exec.signal, VIDEO_MAX_BYTES, logger);
      const seconds = Number(task?.usage?.duration ?? task?.usage?.output_video_duration);
      logger?.info?.(`qwen_generate_video: ${taskId} → ${saved.path}`);
      // 视频无独立权益实例（按 Credits 计），只计一次模型调用。
      budget?.recordRequest?.();
      return { model, path: saved.path, url: videoUrl, taskId, ...(Number.isFinite(seconds) ? { seconds } : {}) };
    },
  };

  // 按 provider 隔离：媒体生成工具在「选中本插件或观察名单内 provider（如手工
  // qwentokenplan）的模型」时出现；用 DSH 自带模型或另一个插件（ark）的模型时
  // 它们不可见，互不影响。名单为空且未指定 providerId 时退回全局注册，保持向后兼容。
  const accepted = new Set([providerId, ...(Array.isArray(acceptProviders) ? acceptProviders : [])]
    .map((p) => String(p ?? "")).filter(Boolean));
  const gated = accepted.size
    ? { when: (context) => accepted.has(context?.modelSelection?.provider) }
    : {};
  disposers.push(ctx.tools.register(imageTool, gated));
  disposers.push(ctx.tools.register(videoTool, gated));
  return () => { for (const dispose of disposers) { try { dispose?.(); } catch { /* best effort */ } } };
}
