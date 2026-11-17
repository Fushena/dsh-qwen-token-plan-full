# dsh-qwen-token-plan-full — 千问 Token Plan 全能版

按你的 Token Plan（个人版）实际权益重写的 DSH Host 插件，是 `dsh-qwen-token-plan-cn-responses` 的全功能替代品：

## 如何安装 / Installation

三种方式任选其一，装完 bundle 默认启用。发布标签见 <https://github.com/Fushena/dsh-qwen-token-plan-full/tags>。

**A. 插件页（推荐，Desktop 与 Web 通用）**
打开侧边栏 **Plugins** 页或 **Settings → Plugins**，在安装对话框粘贴 git 地址：

```
github:Fushena/dsh-qwen-token-plan-full
```

追加标签可锁定版本，如 `github:Fushena/dsh-qwen-token-plan-full#v0.3.6`。宿主会拉取仓库、装入当前 profile 并启用 bundle；开启 HMR 时刷新页面即生效，否则按宿主提示重启。

**B. 命令行**

```sh
dsh plugin --profile <profile> add github:Fushena/dsh-qwen-token-plan-full
```

`<profile>` 换成宿主实际运行的 profile —— Desktop 一般为 `desktop`（会话内 `echo $DSH_PROFILE` 可见）。装错 profile（比如 Desktop 却装进 `web`）会导致插件在你的应用里不可见。

**C. clone 后安装（开发 / 离线）**

```sh
git clone https://github.com/Fushena/dsh-qwen-token-plan-full.git
dsh plugin --profile <profile> add link:/绝对路径/dsh-qwen-token-plan-full
```

或让 DSH agent 调用 `plugin_manager` → `install_bundle`，`target` 填 clone 目录的绝对路径。

**装完之后**：在 Settings → Models 配置凭据引用 `QWEN_TOKEN_PLAN_CN_API_KEY`（见下文前置条件），再在模型选择器里选本 provider。更新：重装更新的标签，或重跑同一条 `add` 命令。

## 前置条件与平台支持 / Prerequisites

- **DSH 版本**：针对 DeepSeek Harness **0.2.2-rc.1** 开发与验证；peer 依赖
  `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-credentials` 范围为
  `^0.2.1-rc.5 || ^0.2.2-rc.1`（0.2.1-rc.5 至 0.2.2-rc.x 均可安装）。
- **账号**：需要阿里云百炼 **Token Plan 个人版**订阅，并在 Settings → Models 配置凭据引用
  `QWEN_TOKEN_PLAN_CN_API_KEY`；缺失时请求报 `MISSING_CREDENTIAL`。
  权益面板的精确余额另需 `BAILIAN_CONSOLE_COOKIE`（`~/.dsh/.env` 或环境变量）；
  没有它时预算退回「官方周期配额 − 本地计数」的本地估算，功能不失效。
- **自动登录弹窗纪律**：只有本地**取不到** `BAILIAN_CONSOLE_COOKIE`（未配置/缺少）时插件才会自动开控制台登录页；
  Cookie 在但网关判它无效（过期/限流/瞬断）**不自动弹**——面板留错误文案，等下次定时刷新自愈，
  或你在面板手动点「一键登录」。自动会话还有 2 小时冷却与「失败当日不再弹」熔断。
  自动重登流程依赖第三方插件 [dsh-chrome-bridge](https://github.com/OrderG-X/dsh-chrome-bridge) 及其 Chrome 扩展。
  **macOS** 下插件可直接拉起 Chrome 完成重登；**Windows/Linux** 下自动拉起不可用
  （`lib/relogin.js` 仅 darwin 走 `/usr/bin/open -a Google Chrome`），需手动更新
  `~/.dsh/.env` 里的 Cookie，或先装 dsh-chrome-bridge 由桥收割。
- **网络/代理**：大陆网络直连百炼控制台网关可能被 TLS 重置；Node 的 `fetch` 不读系统代理，
  需配置 `proxy` 或 `HTTPS_PROXY`，见下文「出站代理」专节。
- **平台**：聊天、动态目录、图片/视频生成、代理支持跨平台（macOS/Windows/Linux）；
  仅「自动拉起 Chrome 重登」为 macOS 专属，见上。

## 相对旧插件的改进

| 能力 | 旧插件 0.1.9 | 本插件 |
|---|---|---|
| 模型目录 | 编译期冻结（2026-09-04 快照，9 个） | **动态**：出厂 14 个 + 每 30 分钟拉取线上 `/v1/models` 合并，新模型自动出现 |
| dsh-llm 协议 | 面向 0.1.x（tool-result 内嵌块），0.2.x 上多轮工具对话会 400 | 面向 0.2.1：`role:"tool"` 独立消息 → `function_call_output` / chat `tool_call_id`，同时兼容 0.1.x 形状 |
| 图片生成 | 无 | **`qwen_generate_image` 工具**：qwen-image-3.0-pro / wan2.7-image(-pro)，走 Token Plan 计费，自动下载到会话工作目录 |
| 视频生成 | 无 | **`qwen_generate_video` 工具**：wan3.0-video 异步任务 + 轮询 + 自动下载 mp4；`duration` 3-15 秒（默认 5 秒，Credits 随时长增加） |
| 版本豁免 | 需要（peerDeps 只到 0.1.x） | 不需要（peerDeps 覆盖 0.2.1-rc.5 至 0.2.2-rc.x） |

聊天能力与旧插件一致：千问/DeepSeek 系走 Responses API（服务端内置工具 web_search、code_interpreter、web_extractor、web_search_image、image_search，`harness: auto` 按模型能力取交集）；GLM 系走 Chat Completions（enable_thinking + reasoning_effort，未知 GLM 自动禁用 none 档，因服务端强制思考）。

不收录：TTS/ASR（Token Plan 端点实测 404/500，仅 websocket 支持）、decision-model-preview（400 Unsupported model）。媒体模型（wan*/qwen-image*/qwen-audio*）自动排除出对话目录。

## 配置（cordis.patch.yml 的 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `providerId` | `qwen-token-plan-full` | 模型路由 id |
| `displayName` | 千问 Token Plan 全能版 | 选择器显示名 |
| `apiKeyEnv` | `QWEN_TOKEN_PLAN_CN_API_KEY` | 凭据引用名（DSH 凭据服务 → 环境变量） |
| `endpoint` / `chatEndpoint` | `auto` / 由 endpoint 派生 | Responses / Chat 端点。`auto` = 启动时并发探测国内站与国际站，谁认这把 key 用谁（见「不同地区访问」）；写死 URL 则跳过探测 |
| `requestTimeoutMs` | `120000` | **空闲**超时（多久没有新字节算卡死），不是总时长。跨境静默窗口更长，故从 60s 抬到 120s；最小 1000 |
| `retryPolicy` | `{mode:"normal",maxRetries:2,backoff:{initialDelayMs:1000,maxDelayMs:10000,jitterRatio:0.1}}` | 请求重试策略，交给宿主 `llm-retry` 执行。DSH 默认 5 次，跨境会把一次抖动放大成分钟级假死，故降到 2 次 |
| `harness` | `auto` | `auto`/`none`/逗号列表（如 `web_search,web_extractor`） |
| `mediaTools` | `true` | 关掉则不注册图片/视频工具 |
| `imageModels` / `videoModels` / `defaultImageModel` / `defaultVideoModel` | 见上 | 媒体工具可选模型 |
| `models` | `[]` | 手工覆盖/追加目录条目（同 id 浅合并；可救活目录没有的模型） |
| `excludeModels` | `[]` | 按 id 或前缀排除 |
| `catalogRefreshMinutes` | `30` | 动态目录刷新周期 |
| `harnessBudget` | 开启 | 权益调用预算；`false` 或 `{disabled:true}` 完全关闭（工具不限次）。额度优先取控制台真实余额，不可用时退回官方周期配额−本地计数；`equityFreshMinutes` 默认 15 |
| `proxy` | 出站代理（控制台网关、模型请求、媒体下载同步生效）。留空读 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`；`none`/`off`/`direct` 强制直连；仅支持 http/https（socks 不支持） |
| `tier` | `auto` | 网关不可达时的兜底等级：`lite`/`essential`/`standard`/`pro` |
| `tierRefreshHours` | `1` | 等级/配额刷新周期（小时） |
| `consoleCookieEnv` | `BAILIAN_CONSOLE_COOKIE` | 控制台 Cookie 的凭据名（~/.dsh/.env 或环境变量） |

## 不同地区访问（速度下降与断连）

**端点只有一个地域可选，不能"就近接入"。** Token Plan 个人版只在中国站（北京）与国际站
（新加坡）售卖，且 **API Key 与地域绑定，跨地域一律 401**。实测同一把国内站 key：

| 地域 | `/compatible-mode/v1/models` |
|---|---|
| `cn-beijing` | **200** |
| `cn-shanghai` | 401 `InvalidApiKey` |
| `cn-hangzhou` | 404 `Model not exist.` |
| `ap-southeast-1` | 401 `InvalidApiKey` |
| `us-east-1` | 401 `InvalidApiKey` |

所以海外用户只能跨境回北京（或改用国际站账号 + 新加坡 key），改地域不是加速手段。
`endpoint: auto`（默认）会在启动时并发探测这两个站点的 `/models`，谁返回 200 用谁并锁定；
两个都不通（断网/无 key）时保留国内站默认值，**provider 照常注册不失活**。
命中后对话、Chat、目录、图片/视频工具的 URL **整套一起换**，不会出现半切换。
判定挡在第一个模型请求之前（只探一次，实测 763ms），因为跨站点 401 不在可重试码里，
漏一轮就是整轮直接失败。面板 `GET /qwen-token-plan-full/status` 的 `provider.site` / `siteReason`
会显示判定结果，`provider.endpoint` / `requestTimeoutMs` 显示当前生效值。

**跨境慢的三个真实来源**（2026-11-17 实测，国内基准 ping 49.8ms、TLS 103ms、TTFB 200ms）：

1. **每轮重传全量历史**：插件不用 `previous_response_id`/`store`，每轮把整段对话（含 base64 内联图片）
   重新上传。上行带宽小的地区，对话越长越慢——这是跨境体感下降的主因，与端点无关。
2. **每轮重新握手**：上游是 `istio-envoy`、HTTP/1.1、**不回 keep-alive 头**，undici 的有效空闲复用
   窗口只有约 2 秒（`keepAliveTimeout` 4s − `keepAliveTimeoutThreshold` 2s）。工具执行往往超过 2 秒，
   于是下一轮重新 DNS+TCP+TLS。实测复用连接首字 1321ms、新建连接 2295ms，跨境 RTT 大时差值成倍放大。
3. **"假慢"**：`reasoning_effort: xhigh` 下首个**正文** delta 实测 41.5 秒（思考期一直在下发 reasoning
   delta，只是 UI 不显示正文）。这不是断连，别急着调超时。

**断连的机制**：跨境链路的中间 NAT / 代理节点空闲回收更激进，长时间没有字节的流会被静默掐断。
空闲超时触发后报 `TIMEOUT`，宿主 `llm-retry` 会重试——**最坏墙钟 = `requestTimeoutMs` × (1 + `maxRetries`)**。
默认 120s × 3 = 360s。两个旋钮要成对调：只把超时拉到 300s 而留着 5 次重试，最坏就是 30 分钟假死。

排查顺序：① 看面板 `provider.site` 是否是预期站点（401 多半是 key 与站点不匹配）；
② `proxy` 是否真的生效（**socks 不支持**，会静默回退直连；Node 也不读系统代理，见下节）；
③ 用 `probe-region-latency.py`（仓库根，纯标准库）在本地跑 `regions` 模式，把当地到北京的握手成本
与国内基准对比，区分"链路问题"与"插件默认值问题"。

## 出站代理（`proxy`）

Node 的 `fetch` 默认**不读系统代理设置**，所以即使系统代理开着，插件也不会自动走它。
需要代理时二选一：

- 配置项 `proxy` 填 `http://127.0.0.1:7897`（按实际端口）；
- 启动 DSH 前设置环境变量 `HTTPS_PROXY`。

留空且无环境变量时行为与改动前完全一致；代理地址写错或不支持（如 socks）会退回直连并提示，
不会影响原本可用的请求。

## 权益调用预算（按项计次）

服务端内置工具（联网搜索等）按**每项权益的返回/调用次数**限额，额度 = 定价页官方周期配额：

1. 插件用 `BAILIAN_CONSOLE_COOKIE`（与 dsh-token-plan-quota 同一份，~/.dsh/.env）调控制台网关，
   拿到你的等级（`subscription.specCode`）与计费周期锚点（`usage.per1MonthResetTime`，套餐重置日）。
2. 每项权益一个周期的配额（`lib/gateway.js` 的 `ENTITLEMENT_QUOTAS`，2026-11-03 抓自定价页
   「Harness 权益」表）：standard → 联网搜索增强 100 次、垂类搜索 100 次、网页解析 1000 次、
   代码解释器 100 次、语音合成 1 万字符、语音识别 5 小时、图像生成 20 张；pro → 500/500/5000/500/
   1 万/5 小时/50 张。lite/essential 不含这些权益（不声明服务端工具）。
3. **剩余额度优先取控制台真实余额**（`queryTokenPlanEquityInfo`，与面板权益页同源），
   再叠加「上次拉取之后本地新增的调用数」：`剩余 = 官网 available − sinceFetch`。
   这样别的设备/客户端/网页版用掉的额度也会被算进来，同时不遗漏刷新间隔内的新调用。
   控制台数据不可用时（Cookie 失效、从未拉取成功、超过新鲜度阈值，默认 15 分钟，
   `harnessBudget.equityFreshMinutes` 可调）退回本地估算：`剩余 = 官方周期配额 − 本周期调用次数`。
   本地计数在每次响应流出现一个服务端工具调用（`web_search_call` / `web_extractor_call` /
   `code_interpreter_call` / `web_search_image_call` …）时加一；`qwen_generate_image`
   按返回张数计入图像生成额度。计数持久化在 `~/.dsh/qwen-token-plan-full.budget.json`
   （重启不丢），周期翻转自动清零恢复。每项判定依据可在面板 status 的 `source` 字段看到
   （`official` = 官网余额，`local` = 本地兜底）。
4. **某项额度耗尽后：请求不再声明该权益对应的工具**（其余权益、模型调用、DSH 本地工具不受影响；
   同名 DSH 本地工具会自动接管，见下），宿主日志提示一次并标明依据；
   `qwen_generate_image` 在额度耗尽时直接报错拒调。周期重置或官网余额回升后自动恢复。
5. 网关不可达（Cookie 失效/断网）时用 `tier` 配置或内置 standard 等级兜底，预算机制不失效。
6. **为什么必须拦**：Harness 权益用尽后不会自动停，超出部分按目录价 88 折**后付费**
   （不占套餐 Credits/量包）。控制台没有「用完即停」开关，只能由客户端停止声明工具来做到。

**面板**：输入行右侧出现两个徽标，各自打开对应面板——「◔ 套餐剩余 n%」点开套餐面板
（剩余百分比大数字、等级、月配额、剩余 Credits、本周期已用、剩余天数、周期重置）；
「⚡ 权益」（只显示文字；有权益耗尽时变 ⚠ 橙色）点开权益面板，按当前等级列出 8 项套餐权益
（联网搜索增强、垂类搜索、网页解析、代码解释器、语音合成、语音识别、图像生成、
视频生成；Lite/Essential 显示升级提示）。行值为「剩余/周期总额」：总额 = 官方周期配额
（不折算），剩余 = 配额 − 本周期调用次数；语音识别按小时显示，视频生成无周期配额显示 ✓ 包含。
额度耗尽的行置灰标橙并计入顶部警示。徽标悬浮提示列出各项「剩余/配额」摘要。
弹层交互仿模型切换器：无按钮，点徽标即打开并强制回源刷新，点弹层外任意处（透明遮罩）关闭，
Esc 也可关闭。数据同源口径：套餐剩余 = 网关 `per1MonthPercentage` 取反，Credits 按月配额折算。
数据走同源只读路由 `GET /qwen-token-plan-full/status`、`POST /qwen-token-plan-full/refresh`。

## 未知新模型的推断规格

线上出现目录没有的 id 时按家族推断保守规格：`glm*` → Chat 路、档位 low/high/max（无 none）；`deepseek*` → Responses、none/low/high/max、ctx 163840；`qwen*` → Responses、none/low/medium/xhigh、带全部内置工具；其余 → Responses、ctx 131072。规格不准时用 `models` 配置覆盖。

## 已知边界

- 动态目录刷新失败（无 Key/断网）静默保留旧目录，插件不失活。
- 图片 `size`/`n` 经实测走请求体顶层 `parameters` 字段原生透传；顶层 `size`/`n` 会被忽略。
- 视频任务超 15 分钟未完成会报错并附 task_id，可稍后人工查询。
- 生成结果的签名 URL 约 24 小时过期；文件已落盘不受影响。

## 与 DSH 0.2.1-rc.5 的兼容修复（插件 0.2.1）

- 通过 `Config`、`credential-ref` 和 configurable-provider 目录接入 DSH 模型设置；Key 由 DSH 凭据服务管理，缺失时返回 `MISSING_CREDENTIAL`。
- 自定义函数与服务端内置工具同名时保留 DSH 函数，移除冲突的服务端工具；内置 `web_extractor` 必须随内置 `web_search` 一起启用。
- `reasoningEffort: none` 不声明服务端内置工具，因为 Token Plan 普通模式拒绝内置代码解释器和网页抓取；DSH 函数仍可使用。
- 请求使用模型目录的默认推理档位和别名。GLM 强制思考模型在本地拒绝 `none`，避免发送必定失败的请求。
- HTTP 和流内的上下文超限、配额耗尽使用 DSH 标准错误码；流中断不会冒充成功回复。
- 目录更新通知 DSH 模型列表；热卸载取消目录和等级请求、清理定时器。媒体工具尊重 DSH 工作目录解析失败，不会悄悄改写到其他目录。

### 本地验证

在插件目录执行 `npm test`（83 项：compat + relogin + stream + tier-retry + route-guard + model-display + capability-probe + config-knobs，含媒体下载 SSRF/重定向回归）。
`test/config-knobs.test.js` 钉死两个跨境旋钮与站点自动判定：默认值与最坏墙钟、非法值拒绝、
`providerRetryPolicy` 真的把策略交给宿主、真实 HTTP 服务器上卡死的流在**配置的**阈值处报 TIMEOUT、
国际站 key 自动切新加坡、断网不失活、换站点后媒体工具与目录一起跟随、
**首个模型请求必须等判定落地**（401 不在可重试码里，漏一轮就是整轮失败）。

**`test/stream.test.js` 必须用真实 HTTP 服务器而不是假流**：超时靠 abort 请求信号生效，真实 undici 收到 abort 会取消 body 并让读取抛错；手写假流不响应 abort，只能测出「定时器到点」，测不出「读取是否真的被中止」。它钉死三条语义：慢但持续的流必须完整读完（超时是**空闲超时**不是总时长，否则长回答会被掐断）、卡死的流要在阈值附近报 TIMEOUT、用户取消要立刻报 ABORTED。

测试使用本机已安装的 DeepSeek Harness 内置运行时与真实 `dsh-llm` 类，不访问网络、不读取个人凭据。其他安装路径可通过 `DSH_TEST_NODE` 和 `DSH_TEST_RUNTIME` 指定。

真实联网验证需单独进行；正常测试不会运行图片或视频生成。

v0.3.7（2026-11-17，跨境稳定性）新增：`requestTimeoutMs` 与 `retryPolicy` 两个配置旋钮（此前写死 60s +
宿主默认 5 次重试，用户无法调），以及 `endpoint: auto` 的站点自动判定。83 项离线回归全部通过。
真实联网实测：国内站 key 打北京 `/models` 200、打新加坡 401（据此确认 key 与地域绑定）；
长思考 xhigh 首个正文 delta 41.5s 但 reasoning delta 持续下发，最大字节间隔仅 1.5s（不会误触超时）；
内置工具执行期最大静默 5.4s，由进行中事件的 heartbeat 续命。

历史验证结果（v0.3.6，2026-11-13 安全与稳定性审计）：61 项离线回归测试全部通过（含真实 SSE 服务器上的超时/取消端到端用例、内置工具进行中事件的续命回归、下载重定向逐跳校验的回环服务器用例）；本机 DSH 桌面配置可完整加载，四个 agent 预设正常。携带真实会话的 69 个工具，在千问思考模式、千问普通模式和 GLM Chat 通道均获得正常回复；另已验证函数调用及独立 `role: tool` 结果回传。多次热加载后，provider 保持单份注册，图片与视频工具各一份。未实际执行媒体生成。
