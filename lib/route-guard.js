/**
 * 面板数据路由的安全守卫（qwen-token-plan-full）。
 *
 * 背景（2026-11-10 实测）：插件用 `webServer.register({kind:"prefix"})` 注册的
 * 路由**完全绕过 DSH 的 Host 鉴权** —— `GET /` 与 `GET /api/...` 都是 401，
 * 而 `GET /qwen-token-plan-full/status` 无任何凭据即 200。旧守卫
 * `sameOriginOnly()` 更致命：它把 `Origin` 与 `req.headers.host` **自比**，
 * 两个值都由攻击者控制，于是 DNS rebinding
 * （`Host: evil.example:49419` + `Origin: http://evil.example:49419`）直接 200。
 *
 * 因此这里换成「不信任任何单个头」的判定：
 *  a) **Host 栅栏**（挡 DNS rebinding 的关键）：Host 必须是回环地址，或恰好是我们
 *     自己 webServer 的绑定地址。攻击者能让浏览器把 evil.example 解析到本机，
 *     但他没法改变浏览器实际发来的 Host（那仍是 evil.example）。
 *  b) **sec-fetch-site**：`cross-site` 一律拒绝。
 *  c) **Origin**：存在时其 hostname 走同一套回环/绑定判定，**绝不与 Host 自比**；
 *     `Origin: null` 拒绝。
 *  d) 无 Origin 且无 sec-fetch-site（本机进程 curl/脚本）→ 放行，但必须已过 Host 栅栏。
 *     取舍：同 uid 的本机进程本就在同一信任域内（它能直读 ~/.dsh 的凭据文件），
 *     拿不到更多东西；保留这条是为了不破坏面板调试。真实攻击路径（DNS rebinding、
 *     浏览器跨站请求）已经被 a+b+c 全部挡住。
 */

/** IPv4 字面量逐段解析；非法返回 null。 */
function ipv4Octets(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  const out = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * 主机名是不是「本机回环」：localhost、127.0.0.0/8、IPv6 ::1。
 * 只做字面量判定，不解析 DNS —— 解析结果会被攻击者用 DNS rebinding 操纵，
 * 字面量判定才是能立住的那道栅栏。
 */
export function isLoopbackHostname(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase();
  if (host === "") return false;
  // URL.hostname 对 IPv6 保留方括号；两种写法都接受。
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare === "localhost.") return true;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  const octets = ipv4Octets(bare);
  if (octets && octets[0] === 127) return true;
  return false;
}

/** 从 Host / Origin / 绑定地址取 hostname；解析失败返回 null。 */
export function hostnameOf(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return null;
  try {
    // Host 头是「authority」，不是完整 URL；补一个占位协议再解析。
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const hostname = url.hostname;
    return hostname ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** webServer 绑定地址 → hostname（配置里通常是裸 IP，如 "127.0.0.1"）。 */
function bindHostname(bindHost) {
  if (typeof bindHost !== "string" || bindHost.trim() === "") return null;
  const direct = hostnameOf(bindHost);
  if (direct) return direct;
  return null;
}

/** 同一个「可信 host」判定：回环，或恰好是 bind 地址。 */
function isTrustedHostname(hostname, bindHost) {
  if (hostname === null) return false;
  // 不支持通配绑定（webserver 本身也拒绝）；只认一个具体本机地址。
  if (isLoopbackHostname(hostname)) return true;
  const bind = bindHostname(bindHost);
  return bind !== null && hostname === bind;
}

/**
 * 路由请求准入判定（纯函数，便于单测）。
 *
 * @param req - 形如 { headers: { host, origin, "sec-fetch-site" } } 的请求对象。
 * @param bindHost - `ctx.get("webServer").host`，即本进程的绑定地址。
 * @returns {boolean} true = 放行；false = 调用方应回 403。
 */
export function trustedRouteRequest(req, bindHost) {
  const headers = req?.headers ?? {};
  const hostHeader = typeof headers.host === "string" ? headers.host : "";
  const host = hostnameOf(hostHeader);
  // a) Host 栅栏：Host 缺失/无法解析/非本机 → 直接拒绝。
  // 这是唯一不依赖浏览器"愿意发什么头"的判据，必须在看 Origin/sec-fetch-site 之前成立。
  if (!isTrustedHostname(host, bindHost)) return false;

  // b) 浏览器明确标注为跨站 → 拒绝（Safari/旧浏览器不发这个头，靠 c/d 兜底）。
  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && site.toLowerCase() === "cross-site") return false;

  // c) Origin 存在时必须自身的 hostname 可信；绝不与 Host 自比（两者都可被伪造，
  //    自比等于没有校验 —— 这正是旧实现被 DNS rebinding 打穿的原因）。
  const origin = headers.origin;
  if (origin !== undefined && origin !== null) {
    const originText = String(origin).trim();
    // "null" 是沙箱 iframe / file:// / data: 的 Origin，无法归属任何站点 → 拒绝。
    if (originText === "" || originText.toLowerCase() === "null") return false;
    const originHostname = hostnameOf(originText);
    if (!isTrustedHostname(originHostname, bindHost)) return false;
  }

  // d) 无 Origin 且无 sec-fetch-site：本机进程（curl/脚本/桌面 dsh-app:// 代理转发）。
  // 已过 a) Host 栅栏，按上面的取舍放行。
  return true;
}
