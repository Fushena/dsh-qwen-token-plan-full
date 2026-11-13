/**
 * 模型展示名与列表排序的**唯一规则源**（2026-11-13 用户要求：两个插件的模型
 * 排列与命名必须一致——按模型类型分组、组内从新到旧、同名模型同写法）。
 *
 * 本文件是纯函数模块：不 import 任何宿主/凭据/网络依赖，可被目录、面板、
 * 测试直接引用。ark-agent-plan 与 qwen-token-plan-full 各持一份**逐字节相同**
 * 的副本（qwen 的测试会在兄弟目录存在时校验两份一致，防漂移）。
 *
 * 规则：
 *  - displayName(id)：人类可读名，同族统一格式
 *      deepseek-v4-1-flash / deepseek-v4.1-flash → "DeepSeek-V4.1 Flash"
 *      glm-5-3-flash-260828                     → "GLM-5.3 Flash 260828"
 *      kimi-k3-1-pro                            → "Kimi-K3.1 Pro"
 *      doubao-seed-2-1-lite                     → "Doubao Seed 2.1 Lite"
 *      qwen3.8-max                              → "Qwen-3.8 Max"
 *  - sortModels(models)：
 *      1. 家族（品牌）分组：DeepSeek → 豆包 → 智谱 → 月之暗面 → MiniMax → 千问 → 其他
 *      2. 组内版本号新者在上（v4.1 > v4；3.8 > 3.7；evolving/latest 视为最新）
 *      3. 同版本按发布日期新→旧，再按层级 pro/max > 标准 > flash > turbo > lite/air > mini > economy
 */

export const BRAND_LABEL = Object.freeze({
  deepseek: "DeepSeek", doubao: "Doubao", glm: "GLM", kimi: "Kimi",
  minimax: "MiniMax", qwen: "Qwen", claude: "Claude",
});

export const TIER_LABEL = Object.freeze({
  pro: "Pro", max: "Max", air: "Air", lite: "Lite", mini: "Mini",
  flash: "Flash", turbo: "Turbo", economy: "Economy", evolving: "Evolving",
  code: "Code", thinking: "Thinking", vision: "Vision", ga: "GA",
});

/** 家族显示顺序与品牌标签（规格推断留在各插件自己的 catalog 里）。 */
export const FAMILY_DISPLAY = Object.freeze([
  { test: /^deepseek/i, order: 0, key: "deepseek", brand: "DeepSeek" },
  { test: /^doubao/i, order: 1, key: "doubao", brand: "豆包" },
  { test: /^glm/i, order: 2, key: "glm", brand: "智谱" },
  { test: /^kimi/i, order: 3, key: "kimi", brand: "月之暗面" },
  { test: /^minimax/i, order: 4, key: "minimax", brand: "MiniMax" },
  { test: /^qwen/i, order: 5, key: "qwen", brand: "千问" },
]);

/** 家族归属：返回 { order, key, brand }；不认识的品牌归「第三方」垫底。 */
export function familyOf(id) {
  const family = FAMILY_DISPLAY.find((entry) => entry.test.test(id));
  return family ?? { order: 9, key: String(id).split("-")[0] ?? "zzz", brand: "第三方" };
}

/**
 * 拆分品牌前缀：把「品牌+版本 fused」的首 token 拆成品牌键 + 版本残片。
 *   qwen3.8-max → { brandKey: "qwen", rest: ["3.8", "max"] }
 *   deepseek-v4-pro-0813 → { brandKey: "deepseek", rest: ["v4", "pro", "0813"] }
 * 日期后缀保留进 rest：名字里要显示它（否则带日期与不带日期的同名模型在选择器里重名）。
 */
function splitBrand(id) {
  const tokens = String(id).split("-");
  const fused = /^([a-z]+)(\d+(?:\.\d+)*)$/i.exec(tokens[0] ?? "");
  if (fused) return { brandKey: fused[1].toLowerCase(), rest: [fused[2], ...tokens.slice(1)] };
  return { brandKey: (tokens[0] ?? "").toLowerCase(), rest: tokens.slice(1) };
}

/** 由模型 ID 生成人类可读名称（规则见文件头）。 */
export function displayName(id) {
  const { brandKey, rest } = splitBrand(id);
  const brand = BRAND_LABEL[brandKey] ?? (brandKey ? brandKey.charAt(0).toUpperCase() + brandKey.slice(1) : "Unknown");

  const parts = [];
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];

    // V4 / V4-1 → V4.1
    if (/^v\d+$/i.test(token)) {
      let version = token.toUpperCase();
      if (/^\d+$/.test(rest[i + 1] ?? "")) { version += `.${rest[i + 1]}`; i += 2; } else i += 1;
      parts.push(version);
      continue;
    }

    // K3 / M3 / K2.7 这类字母+数字当作版本号（Kimi、MiniMax 写法）
    if (/^[km]\d+(?:\.\d+)?$/i.test(token)) {
      parts.push(token.toUpperCase());
      i += 1;
      continue;
    }

    // 纯数字：紧跟在 K3 后面则是次版本（K3-1 → K3.1）；否则是版本号（5-3 → 5.3）
    if (/^\d+$/.test(token)) {
      const prev = parts[parts.length - 1];
      if (prev && /^[KM]\d+$/.test(prev)) {
        parts[parts.length - 1] = `${prev}.${token}`;
        i += 1;
        continue;
      }
      let version = token;
      if (/^\d+$/.test(rest[i + 1] ?? "")) { version += `.${rest[i + 1]}`; i += 2; } else i += 1;
      parts.push(version);
      continue;
    }

    // 点分版本（3.8 / 2.1）直接作为版本号
    if (/^\d+\.\d+$/.test(token)) {
      parts.push(token);
      i += 1;
      continue;
    }

    parts.push(TIER_LABEL[token] ?? token.charAt(0).toUpperCase() + token.slice(1));
    i += 1;
  }

  // 品牌词（如 seed）在版本前时用空格：Doubao Seed 2.1 Pro
  const versionAt = parts.findIndex((part) => /^\d/.test(part) || /^V\d/.test(part) || /^[KM]\d/.test(part));
  if (versionAt > 0) {
    return `${brand} ${parts.slice(0, versionAt).join(" ")} ${parts.slice(versionAt).join(" ")}`.replace(/\s+/g, " ").trim();
  }
  const joined = parts.join(" ");
  if (!/\d/.test(joined)) return `${brand} ${joined}`.trim();
  // 只有「V4.1 / 5.3」这种纯数字版本用连字符（DeepSeek-V4.1、GLM-5.3）；
  // K3 / M3 这类字母版本沿用空格（Kimi K3、MiniMax M3），与同族其它成员一致。
  const first = parts[0] ?? "";
  const useHyphen = /^V\d/.test(first) || /^\d/.test(first);
  return (useHyphen ? `${brand}-${joined}` : `${brand} ${joined}`).replace(/\s+/g, " ").trim();
}

/** 无版本号的特殊/新发布模型应排在同族最上方。 */
const SPECIAL_LATEST = /evolving|latest|preview|experimental/i;

/** 日期后缀：方舟写法 -261017（YYMMDD），百炼写法 -1017（MMDD）；都不参与版本号解析。 */
const DATE_SUFFIX = /-(\d{6}|\d{4})$/;

/** 从模型 ID 里解析版本号数字串：deepseek-v4-1-flash → [4,1]；qwen3.8-max → [3,8]。 */
export function versionParts(id) {
  if (SPECIAL_LATEST.test(id)) return [99, 99]; // 特殊模型视为最新
  const base = String(id).replace(DATE_SUFFIX, "");
  const tokens = base.split("-");
  const nums = [];
  for (const token of tokens) {
    if (/^v?\d+$/.test(token)) nums.push(Number(token.replace(/^v/, "")));
    else if (/^v?\d+\.\d+$/.test(token)) nums.push(...token.replace(/^v/, "").split(".").map(Number));
    else if (/^[km]\d+(?:\.\d+)?$/i.test(token)) nums.push(...token.slice(1).split(".").map(Number));
    else if (/^[a-z]+\d+(?:\.\d+)*$/i.test(token)) nums.push(...token.replace(/^[a-z]+/i, "").split(".").map(Number));
  }
  return nums.length ? nums : [0];
}

/** 发布日期后缀（-261017 / -1017）；无则 0。 */
export function releaseDate(id) {
  const m = DATE_SUFFIX.exec(String(id));
  return m ? Number(m[1]) : 0;
}

/** 比较两个数字数组（前者大者为新）。 */
export function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return y - x; // 版本号大的排前面
  }
  return 0;
}

/** 同族内的层级排序：pro/max > 标准 > turbo/flash > lite/air > mini/economy。 */
export function tierRank(id) {
  if (/economy/i.test(id)) return 90;   // 经济版垫底
  if (/\bmini\b|-mini/i.test(id)) return 80;
  if (/\blite\b|-lite|\bair\b|-air/i.test(id)) return 70;
  if (/turbo/i.test(id)) return 60;
  if (/flash/i.test(id)) return 50;
  if (/\bpro\b|-pro\b|\bmax\b|-max/i.test(id)) return 10;
  return 40; // 标准版 / 无后缀
}

/**
 * 列表排序（返回新数组，不修改入参）：家族分组 → 版本新者在上 →
 * 发布日期新者在上 → 层级高者在上 → id 字典序兜底。
 * 入参可带 familyOrder（数字）覆盖家族顺序；缺省按 id 现推。
 */
export function sortModels(models) {
  return [...models].sort((a, b) => {
    const familyA = a.familyOrder ?? familyOf(a.id).order;
    const familyB = b.familyOrder ?? familyOf(b.id).order;
    if (familyA !== familyB) return familyA - familyB;

    // 新版本在上（evolving 之类无版本号的特殊模型视为最新）
    const versionDiff = compareVersions(versionParts(a.id), versionParts(b.id));
    if (versionDiff !== 0) return versionDiff;

    // 同版本：发布日期新者在上；无日期后缀的是「跟随最新部署」的别名，视为最新。
    const dateA = releaseDate(a.id) || Number.POSITIVE_INFINITY;
    const dateB = releaseDate(b.id) || Number.POSITIVE_INFINITY;
    if (dateA !== dateB) return dateB - dateA;

    // 同日期：层级高者在上
    const tierDiff = tierRank(a.id) - tierRank(b.id);
    if (tierDiff !== 0) return tierDiff;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
