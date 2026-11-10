import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * 出站 HTTP 代理支持。
 *
 * 为什么需要：Node 的 `fetch` 默认**不读系统代理设置**（macOS 的 `scutil --proxy`
 * 指向 127.0.0.1:7897 之类，Node 完全看不到）。而 volcengine 控制台
 * （`console.volcengine.com`）在没有可用代理的情况下，TLS 握手会被直接重置
 * （实测 2026-11-09：直连与 curl 走系统代理均 `SSL_ERROR_SYSCALL`，
 * 同域 `api.volcengine.com` 却正常）。结果就是额度面板报 `fetch failed`。
 *
 * 所以这里把代理接进 fetch：
 * - 代理地址来自配置项，未配置时读环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *   （以及同名小写），这是 Node 世界的通行约定；
 * - 走 undici 的 ProxyAgent（DSH 运行时自带 undici，插件自身不额外声明依赖）；
 * - **解析不到 undici、代理协议不支持、地址不合法时都不报错，原样返回原生 fetch**，
 *   绝不因为「代理支持」反而把原本能用的请求弄坏。
 */

/** 环境变量里常见的大写/小写写法，按优先级排列。 */
const PROXY_ENV_KEYS = Object.freeze([
  "DSH_HTTPS_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "DSH_HTTP_PROXY",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
]);

/** 「明确要求不走代理」的取值。 */
const DISABLED_VALUES = /^(none|off|false|0|direct|no)$/i;

/**
 * 从环境变量里找代理地址。
 * @param env - 环境变量表，默认 process.env。
 * @returns 原始字符串（尚未校验合法性），或 undefined（未配置 / 显式关闭）。
 */
export function proxyFromEnv(env = process.env) {
  for (const key of PROXY_ENV_KEYS) {
    const raw = env?.[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value === "") continue;
    if (DISABLED_VALUES.test(value)) return undefined;
    return value;
  }
  return undefined;
}

/**
 * 校验并规范化代理地址。
 *
 * 只接受 http/https —— undici 的 ProxyAgent 不支持 socks；收到 socks 地址时
 * 必须回退原生 fetch，而不是硬塞给它导致所有请求失败。
 * 允许省略协议写成 host:port（补 http://）。
 *
 * @param raw - 候选地址。
 * @returns {{url: URL, href: string} | null} 可用则返回解析结果，否则 null。
 */
function parseProxy(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (value === "" || DISABLED_VALUES.test(value)) return null;
  // 裸 host:port → 补默认协议；其余非 http(s) 一律拒绝。
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (/^[^/:\s]+:\d+$/.test(value)) value = `http://${value}`;
    else return null;
  }
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return { url, href: url.href };
  } catch {
    return null;
  }
}

/** 在 profile 作用域下定位 undici；解析不到返回 null。 */
function loadUndici() {
  // 候选目录只认「由 DSH 自己决定的 profile 路径」。
  // **绝不要**把「当前工作目录」放进候选：cwd 由启动方式决定（用户可能从任意目录
  // 启动 DSH），从中解析 `undici` 等于允许那个目录里的第三方包在本宿主进程里执行任意
  // 代码 —— 一个打错的启动目录就能变成 RCE（2026-11-10 安全审计）。
  const candidates = [
    process.env.DSH_PROFILE_DIR,
    path.join(process.env.DSH_HOME || path.join(process.env.HOME || "", ".dsh"), "profiles", "desktop"),
  ].filter((dir) => typeof dir === "string" && dir.trim() !== "");
  for (const root of candidates) {
    try {
      const req = createRequire(pathToFileURL(path.join(root, "package.json")));
      const undici = req("undici");
      if (undici && typeof undici.ProxyAgent === "function" && typeof undici.fetch === "function") return undici;
    } catch { /* 换下一个候选目录 */ }
  }
  return null;
}

/**
 * 构造走代理的 fetch。无有效代理配置时返回原生 fetch（行为与改动前完全一致）。
 *
 * @param options.proxy - 配置指定的代理；留空则读环境变量；none/off/direct 强制直连。
 * @param options.logger - 记录降级原因（只记一次，避免刷屏）。
 * @returns 与全局 fetch 同签名的函数；接管代理时带 `proxyUrl` 属性便于诊断。
 */
export function createProxyFetch({ proxy, logger } = {}) {
  const configured = typeof proxy === "string" ? proxy.trim() : "";
  // 显式关闭优先级最高。
  if (configured !== "" && DISABLED_VALUES.test(configured)) return globalThis.fetch;
  // 配置了但地址不可用（写错、或 socks 这类不支持协议）→ 直连并提示，
  // **不能**悄悄去用环境变量里的代理：用户显式写了配置就该以它为准。
  let target;
  if (configured !== "") {
    target = parseProxy(configured);
    if (!target) {
      // 日志绝不打印原始配置：`http://user:pass@host` 会把凭据明文留在日志里。
      // redactProxyUrl 对非法地址返回 null，此时退化为安全文案。
      const shown = redactProxyUrl(configured) ?? "(含凭据或无法解析的地址)";
      logger?.warn?.(`qwen-token-plan-full: 配置的代理 "${shown}" 不可用（仅支持 http/https，或地址写错），本次请求直连。`);
      return globalThis.fetch;
    }
  } else {
    target = parseProxy(proxyFromEnv());
  }
  if (!target) return globalThis.fetch;

  const undici = loadUndici();
  if (!undici) {
    // 同样脱敏：环境变量里的代理地址也可能带账号密码。
    const shown = redactProxyUrl(target.href) ?? "(含凭据或无法解析的地址)";
    logger?.warn?.(
      `qwen-token-plan-full: 检测到代理 ${shown}，但当前运行时解析不到 undici 的 ProxyAgent；请求仍直连。若额度刷新失败，请检查该代理是否可用。`,
    );
    return globalThis.fetch;
  }

  const dispatcher = new undici.ProxyAgent({ uri: target.href });
  const proxyFetch = (input, init = {}) => undici.fetch(input, { ...init, dispatcher });
  proxyFetch.proxyUrl = target.href;
  return proxyFetch;
}

/**
 * 诊断用：去掉代理 URL 里的账号密码。
 * @param url - 代理地址。
 * @returns 可写进面板/日志的字符串，无法解析则为 null。
 */
export function redactProxyUrl(url) {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    return parsed.href;
  } catch {
    return null;
  }
}
