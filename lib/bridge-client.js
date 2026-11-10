/**
 * dsh-chrome-bridge 的极简客户端（Cookie 自动收割用）。
 *
 * 协议与桥插件 index.js 完全一致：一行 JSON 请求 {token,id,op,args,client,timeoutMs}
 * → 一行 JSON 响应 {ok,result} / {ok:false,error}，每次调用新建一条 socket 连接。
 * 这里只用到 open / close / tabs / cdp(Storage.getCookies) 四个 op，故自带一份
 * 最小实现，不 import 桥的私有模块（版本漂移不至于拖垮本插件加载）。
 *
 * CDP 的 Storage.getCookies 在调试器通道下能拿到 HttpOnly Cookie（控制台登录票据
 * login_qianwenai_ticket 正是 HttpOnly），这是本方案成立的关键（实测 2026-11-04）。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const WIN = process.platform === "win32";
const UID = typeof process.getuid === "function" ? process.getuid() : null;
const DIR = process.env.DSH_BRIDGE_DIR || (WIN ? path.join(os.tmpdir(), "dsh-bridge") : `/tmp/dsh-bridge-${UID ?? "user"}`);
const TOKEN_FILE = process.env.DSH_BRIDGE_TOKEN || path.join(DIR, "dsh-bridge.token");
const FIXED_SOCK = process.env.DSH_BRIDGE_SOCK || (WIN ? null : path.join(DIR, "dsh-bridge.sock"));

/** 控制台域：收割 Cookie 时请求的 URL 集合（网关取数同源的两级域名）。 */
const CONSOLE_URLS = Object.freeze(["https://platform-home.qianwenai.com", "https://cs-data.qianwenai.com"]);
/** 登录成功的判据票据。 */
const LOGIN_COOKIE = "login_qianwenai_ticket";

/**
 * 读桥 token 文件（纵深防御，2026-11-10 安全审计）。
 *
 * 桥 token 等于「向浏览器桥发指令」的能力（开标签、跑 CDP）。旧实现直接
 * readFileSync，一份被替换/被放宽权限的 token 文件就能劫持我们的桥调用。
 * 因此读之前先 lstat：必须是普通文件（不是符号链接/目录）、属主是当前用户
 * （POSIX）、且 mode 无 group/other 位；任一不满足就不带 token（退化为匿名调用，
 * 桥自己也会拒绝）。检查失败绝不抛错——桥不可用时本来就要静默降级。
 */
function tokenLines() {
  try {
    const st = fs.lstatSync(TOKEN_FILE);
    if (!st.isFile()) return [];
    if (!WIN) {
      if (UID !== null && st.uid !== UID) return [];
      // 0o077 = group/other 的任何读写执行位；token 文件应当只有本人可访问。
      if ((st.mode & 0o077) !== 0) return [];
    }
    return fs.readFileSync(TOKEN_FILE, "utf8").split("\n").map((l) => l.trim());
  } catch { return []; }
}
function hostSock() { return FIXED_SOCK || tokenLines()[1] || null; }
function hostUp() { const s = hostSock(); return Boolean(s) && (WIN || fs.existsSync(s)); }
/** 与桥同款目录安全检查：真目录、属主是当前用户、其他人进不去。 */
function checkDir(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (!WIN && ((UID !== null && st.uid !== UID) || (st.mode & 0o077)))) {
    throw new Error(`${dir} 不是只属于当前用户的目录，拒绝使用`);
  }
}

/** Chrome 在跑、桥宿主在听、扩展已连接时返回 true；任何不满足都静默 false。 */
export function bridgeAvailable() {
  try {
    if (!hostUp()) return false;
    checkDir(WIN ? DIR : path.dirname(hostSock()));
    return true;
  } catch { return false; }
}

function call(op, args = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const SOCK = hostSock();
    if (!SOCK) return reject(new Error("浏览器桥不在运行"));
    // 纵深防御：连接前复查所在目录。bridgeAvailable() 里查过一次，但 call() 也可能
    // 被直接调用（登录收割轮询），而目录可能在两次检查之间被替换成可写/异主的目录
    // —— 那时任何人都能往 socket 上冒充桥，返回伪造的 Cookie。失败即拒绝连接。
    if (!WIN) {
      try { checkDir(path.dirname(SOCK)); }
      catch (error) { return reject(new Error(`浏览器桥目录不可信，拒绝连接：${error instanceof Error ? error.message : String(error)}`)); }
    }
    let sock;
    try { sock = net.connect(SOCK); } catch (e) { return reject(e); }
    let acc = "";
    let done = false;
    let timer = null;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* 幂等 */ }
      fn(v);
    };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({
      token: tokenLines()[0] || null, id: crypto.randomUUID(), op, args,
      client: { kind: "qwen-token-plan-full", pid: process.pid }, timeoutMs,
    })}\n`));
    sock.on("data", (d) => {
      acc += d;
      const i = acc.indexOf("\n");
      if (i < 0) return;
      let msg;
      try { msg = JSON.parse(acc.slice(0, i)); } catch { return finish(reject, new Error("桥宿主回了坏 JSON")); }
      if (msg.ok) finish(resolve, msg.result);
      else finish(reject, new Error(msg.error || "桥未知错误"));
    });
    sock.on("error", (e) => finish(reject, new Error(`连不上浏览器桥：${e.message}`)));
    sock.on("close", () => finish(reject, new Error("浏览器桥连接被关闭")));
    timer = setTimeout(() => finish(reject, new Error(`等浏览器桥超时（${timeoutMs}ms）`)), timeoutMs);
  });
}

/** 后台开一个控制台登录页（DSH 干活窗口），尽力把它带到前台，返回 tabId；失败 null。 */
export async function openLoginWindow(url) {
  const r = await call("open", { url }, 20_000);
  const tabId = Number(r?.tabId);
  if (!Number.isFinite(tabId)) return null;
  try { await call("activate", { tabId }, 8_000); } catch { /* 抢焦点失败不影响登录 */ }
  return tabId;
}

export async function closeTab(tabId) {
  try { await call("close", { tabId }, 8_000); } catch { /* best effort */ }
}

/** tabId 是否还开着（用户手动关掉登录页 = 放弃登录的信号）。 */
export async function hasTab(tabId) {
  const tabs = await call("tabs", {}, 10_000);
  return Array.isArray(tabs) && tabs.some((t) => Number(t?.id) === Number(tabId));
}

/** 找一个已打开的控制台页面标签（浏览器兜底模式下用户自己在 Chrome 里开的登录页）。 */
export async function findConsoleTab() {
  const tabs = await call("tabs", {}, 10_000);
  const hit = (Array.isArray(tabs) ? tabs : [])
    .find((t) => typeof t?.url === "string" && t.url.startsWith("https://platform-home.qianwenai.com"));
  return hit ? Number(hit.id) : null;
}

/**
 * 从指定标签页收割控制台域 Cookie：拿到登录票据则返回拼好的 Cookie 头字符串，
 * 未登录返回 null。CDP 调试器通道返回网络栈完整 Cookie（含 HttpOnly 登录票据，
 * 实测 Network.getCookies 可读）；重复名以首个为准；首选失败再试 Storage 版。
 */
export async function harvestCookie(tabId) {
  let r = null;
  try { r = await call("cdp", { tabId, method: "Network.getCookies", params: { urls: [...CONSOLE_URLS] } }, 15_000); }
  catch {
    try { r = await call("cdp", { tabId, method: "Storage.getCookies", params: { urls: [...CONSOLE_URLS] } }, 15_000); }
    catch { r = null; }
  }
  // 桥的 cdp 通道返回 {result:{cookies}}（chrome.debugger.sendCommand 的原始信封），
  // 也兼容直接 {cookies} 的实现；解析错层会让收割永远返回 null（2026-11-04 实测教训）。
  const cookies = Array.isArray(r?.result?.cookies) ? r.result.cookies : (Array.isArray(r?.cookies) ? r.cookies : []);
  if (!cookies.some((c) => c?.name === LOGIN_COOKIE)) return null;
  const seen = new Set();
  const parts = [];
  for (const c of cookies) {
    if (!c?.name || seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value ?? ""}`);
  }
  return parts.join("; ");
}
