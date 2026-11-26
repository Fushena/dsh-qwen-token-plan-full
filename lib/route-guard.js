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
 *  c) **Origin**：存在时其 hostname 走同一套回环/绑定判定，且完整 origin
 *     （协议+host+端口）必须等于请求自身的 origin（防本机其它端口页面的 CSRF）；
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
 * 检查远端 socket IP（req.socket.remoteAddress）是否为本机回环地址：
 * 127.0.0.0/8、::1、::ffff:127.0.0.0/8（含压缩/十六进制规范形式）。
 */
export function isLoopbackAddress(address) {
  let raw = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (raw === "") return false;
  const pct = raw.indexOf("%");
  if (pct >= 0) raw = raw.slice(0, pct);
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  if (raw === "::1" || raw === "0:0:0:0:0:0:0:1") return true;
  if (raw.startsWith("::ffff:")) {
    const tail = raw.slice("::ffff:".length);
    const v4 = ipv4Octets(tail);
    if (v4) return v4[0] === 127;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) return (parseInt(hex[1], 16) >> 8) === 127;
    return false;
  }
  const octets = ipv4Octets(raw);
  return Boolean(octets && octets[0] === 127);
}

/** 判定是否为通配绑定地址（0.0.0.0 / :: / 0:0:0:0:0:0:0:0）。 */
function isWildcardHost(hostname) {
  const bare = String(hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (bare === "0.0.0.0" || bare === "::") return true;
  if (/^0(:0){7}$/.test(bare)) return true;
  return false;
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

/** 从 Host / Origin / 绑定地址取 hostname；解析失败或含畸形片段（userinfo/path/query/fragment/空白）返回 null。 */
export function hostnameOf(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "" || /\s/.test(raw)) return null;
  const hasScheme = raw.includes("://");
  if (hasScheme) {
    if (!/^https?:\/\//i.test(raw)) return null;
    const authority = raw.replace(/^https?:\/\//i, "");
    if (authority === "" || /[@/?#\\]/.test(authority)) return null;
  } else {
    if (/[@/?#\\]/.test(raw)) return null;
  }
  try {
    // Host 头是「authority」，不是完整 URL；补一个占位协议再解析。
    const url = new URL(hasScheme ? raw : `http://${raw}`);
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
      return null;
    }
    const hostname = url.hostname;
    return hostname ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** webServer 绑定地址 → hostname（配置里通常是裸 IP，如 "127.0.0.1" 或裸 IPv6 "fd00::1"）；拒绝通配地址。 */
function bindHostname(bindHost) {
  if (typeof bindHost !== "string" || bindHost.trim() === "") return null;
  let candidate = bindHost.trim();
  // 裸 IPv6 地址（如 "fd00::1"）不加方括号会被 new URL 当成非法端口，补方括号后再解析。
  if (!candidate.includes("://") && !candidate.startsWith("[") && (candidate.match(/:/g)?.length ?? 0) >= 2) {
    candidate = `[${candidate}]`;
  }
  const direct = hostnameOf(candidate);
  if (!direct || isWildcardHost(direct)) return null;
  return direct;
}

/** 同一个「可信 host」判定：回环，或恰好是具体 bind 地址（拒绝 0.0.0.0 / :: 通配）。 */
function isTrustedHostname(hostname, bindHost) {
  if (hostname === null || isWildcardHost(hostname)) return false;
  if (isLoopbackHostname(hostname)) return true;
  const bind = bindHostname(bindHost);
  return bind !== null && hostname === bind;
}

/**
 * 路由请求准入判定（纯函数，便于单测）。
 *
 * @param req - 形如 { method?, socket?: { remoteAddress }, headers: { host, origin, "sec-fetch-site" } } 的请求对象。
 * @param bindHost - `ctx.get("webServer").host`，即本进程的绑定地址。
 * @returns {boolean} true = 放行；false = 调用方应回 403。
 */
export function trustedRouteRequest(req, bindHost) {
  // 0) 远端 socket 校验：非回环来源一律拒绝（防止通配或局域网绑定下被局域网任意机器访问无鉴权路由）。
  const remoteAddress = req?.socket?.remoteAddress;
  if (remoteAddress !== undefined && remoteAddress !== null) {
    if (!isLoopbackAddress(remoteAddress)) return false;
  }

  const headers = req?.headers ?? {};
  if (typeof headers.host !== "string") return false;
  const hostHeader = headers.host.trim();
  const host = hostnameOf(hostHeader);
  // a) Host 栅栏：Host 缺失/畸形/非本机 → 直接拒绝。
  // 这是唯一不依赖浏览器"愿意发什么头"的判据，必须在看 Origin/sec-fetch-site 之前成立。
  if (!isTrustedHostname(host, bindHost)) return false;

  // b) sec-fetch-site：拒绝重复数组头；只允许空或 same-origin（非变更 GET/HEAD 或未提供 method 时允许 none），
  //    绝不放行 same-site 或 cross-site（防本机其他端口无 Origin 请求绕过同端口护栏）。
  const rawSite = headers["sec-fetch-site"];
  if (rawSite !== undefined) {
    if (Array.isArray(rawSite) || typeof rawSite !== "string") return false;
    const site = rawSite.trim().toLowerCase();
    if (site !== "" && site !== "same-origin") {
      if (site === "none") {
        const method = typeof req?.method === "string" ? req.method.trim().toUpperCase() : "";
        if (method !== "" && method !== "GET" && method !== "HEAD") return false;
      } else {
        return false;
      }
    }
  }

  // c) Origin 存在时：hostname 走同一套回环/绑定判定，且完整 origin（协议+host+端口）
  //    必须等于请求自身的 origin。拒绝重复数组头、畸形 Origin 与 "null"。
  const origin = headers.origin;
  if (origin !== undefined && origin !== null) {
    if (Array.isArray(origin) || typeof origin !== "string") return false;
    const originText = origin.trim();
    // "null" 是沙箱 iframe / file:// / data: 的 Origin，无法归属任何站点 → 拒绝。
    if (originText === "" || originText.toLowerCase() === "null") return false;
    const originHostname = hostnameOf(originText);
    if (!isTrustedHostname(originHostname, bindHost)) return false;
    try {
      // URL.origin 归一化协议/默认端口；本机 webServer 只提供 http，Host 补 http 前缀。
      const requestOrigin = new URL(`http://${hostHeader}`).origin;
      if (new URL(originText).origin !== requestOrigin) return false;
    } catch {
      return false;
    }
  }

  // d) 无 Origin 且无 sec-fetch-site：本机进程（curl/脚本/桌面 dsh-app:// 代理转发）。
  // 已过远端回环校验 + a) Host 栅栏，放行。
  return true;
}
