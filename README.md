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
- **想真正用上套餐单列的 Harness 权益**（那 20 张图、100 次搜索……）：还需一把
  **百炼按量付费 Key**（`sk-` / `sk-ws-` 开头，[百炼控制台](https://bailian.console.aliyun.com/)
  → API-KEY 创建），存为凭据引用 `BAILIAN_PAYG_API_KEY`。Token Plan 专属 Key（`sk-sp-`）
  只抵扣 Credits、打 MCP 一律 401。没配这把 Key 时插件照常工作，只是所有调用都花 Credits，
  面板会如实标出来。详见「Harness 权益 MCP 通道」。
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
| 图片生成 | 无 | **`qwen_generate_image` 工具**：qwen-image-3.0-pro / wan2.7-image(-pro)，自动下载到会话工作目录。**双通道**：配了百炼按量付费 Key 就走 MCP 真扣套餐权益额度，否则回落模型 API 花 Credits |
| Harness 权益 | 用不上（专属 Key 只扣 Credits） | **MCP 权益通道**：6 个百炼 MCP 服务覆盖 7 项权益，按余额挂/摘，面板逐项标注消耗来源 |
| 视频生成 | 无 | **`qwen_generate_video` 工具**：wan3.0-video 异步任务 + 轮询 + 自动下载 mp4；`duration` 3-15 秒（默认 5 秒，Credits 随时长增加） |
| 版本豁免 | 需要（peerDeps 只到 0.1.x） | 不需要（peerDeps 覆盖 0.2.1-rc.5 至 0.2.2-rc.x） |

聊天能力与旧插件一致：千问/DeepSeek 系走 Responses API（服务端内置工具 web_search、code_interpreter、web_extractor、web_search_image、image_search，`harness: auto` 按模型能力取交集）；GLM 系走 Chat Completions（enable_thinking + reasoning_effort，未知 GLM 自动禁用 none 档，因服务端强制思考）。

不收录：TTS/ASR 的**模型端点**（Token Plan 端点实测 404/500，仅 websocket 支持）、decision-model-preview（400 Unsupported model）。媒体模型（wan*/qwen-image*/qwen-audio*）自动排除出对话目录。语音合成/识别自 v0.5.0 起改由百炼 MCP 服务提供（`mcp__TextGenerateSpeech__*` / `mcp__SpeechGenerateText__*`，需按量付费 Key），不再依赖那两个坏端点。

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
| `bailianApiKeyEnv` | `BAILIAN_PAYG_API_KEY` | **百炼按量付费 Key** 的凭据引用名（`sk-`/`sk-ws-` 开头）。Harness 权益只认这把 key；Token Plan 专属 key（`sk-sp-`）打 MCP 一律 401，只会扣 Credits。没配就整条通道不挂，面板如实标「Credits」 |
| `mcpEquity` | `auto` | 权益 MCP 通道：`auto` = 7 项权益一一对应 7 个真实服务；`off` 关闭；逗号列表按服务名精选（如 `TextGenerateImage,EnhancedSearch`）。视频无独立权益实例，默认不挂，要挂就显式写 `VideoGenerate` |
| `mcpHost` | `https://dashscope.aliyuncs.com` | MCP 服务域名。千问 One Key 域名 `https://maas.qianwenaiapi.com` 亦可用，路径同为 `/api/v1/mcps/<Service>/mcp` |
| `serviceQuotas` | `true` | 是否同时拉取**第一层「服务自带免费额度」**（官方先扣它）。关掉省两次控制台请求，面板退回只显示 Token Plan 权益的单层形态 |
| `imageModels` / `videoModels` / `defaultImageModel` / `defaultVideoModel` | 见上 | 媒体工具可选模型 |
| `models` | `[]` | 手工覆盖/追加目录条目（同 id 浅合并；可救活目录没有的模型） |
| `excludeModels` | `[]` | 按 id 或前缀排除 |
| `catalogRefreshMinutes` | `30` | 动态目录刷新周期 |
| `harnessBudget` | 开启 | 权益调用预算；`false` 或 `{disabled:true}` 完全关闭（工具不限次）。额度优先取控制台真实余额，不可用时退回官方周期配额−本地计数；`equityFreshMinutes` 默认 15 |
| `proxy` | 出站代理（控制台网关、模型请求、媒体下载同步生效）。留空读 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`；`none`/`off`/`direct` 强制直连；仅支持 http/https（socks 不支持） |
| `tier` | `auto` | 网关不可达时的兜底等级：`lite`/`essential`/`standard`/`pro` |
| `tierRefreshHours` | `1` | 等级/配额刷新周期（小时） |
| `consoleCookieEnv` | `BAILIAN_CONSOLE_COOKIE` | 控制台 Cookie 的凭据名（~/.dsh/.env 或环境变量） |
| `registerProvider` | `true` | `false` = 观察-only：不注册 adapter/provider（模型从选择器消失），面板/计数/媒体工具照常。徽标门控自 v0.4.0 起跟随 `watchedProviders`（宿主 status 下发），普通线路下也显示 |
| `watchedProviders` | `["qwentokenplan"]` | 旁路观察名单：这些 provider 的调用也计入面板「本周期调用次数」（本插件 providerId 始终在内）；媒体工具门控同用此名单 |
| `catalogFeed` | `true` | 目录补货：定期从普通线路自己的域名抓 /models，把新对话模型追加进 pi-ai 该线路的 models 配置 |
| `feedProvider` | `qwentokenplan` | 补货目标：llm-pi-ai 里手工配的 provider 路由名 |
| `feedReasoning` | `true` | 补货时是否翻译推理档位（reasoningEfforts + compat.thinkingFormat）；false 只补 id/name/容量/模态 |

## 旁路调用观察（v0.4.0 起）

聊天不必经过本插件的 adapter，面板也能看到真实调用数：插件订阅 DSH 的 `session/event`
只读事件流（事后广播，监听器异常被宿主隔离，绝不反向影响请求），在 `assistant/message`
落定时按 provider 计一次调用。provider 识别首选消息内嵌 finish chunk 的
`replayState.response.provider`（pi-ai 每条都带），兜底用 `request/context`/`request/header`
跟踪会话当前 provider。会话恢复/重放不发该事件，不会重复计数；失败 attempt 不计。

典型用法：聊天固定走手工 provider（如 llm-pi-ai 的 `qwentokenplan`），本插件只负责
面板/权益/媒体工具——这样修改插件触发热重载时，聊天请求不会被中断（v0.3.6 及以前，
选中本插件 provider 的会话在插件重载瞬间会报 `NO_ADAPTER` 整轮中断）。需要服务端内置
工具（联网搜索/代码解释器等）时，保持 `registerProvider: true` 并手动选本插件的模型。

`totalCalls` 口径自 v0.4.0 起统一为「模型 API 调用次数」（含图片/视频生成任务），
不再混计内置工具事件；权益次数仍按工具事件/生成张数单独累计。

## 目录补货（v0.4.0 起）

聊天固定走普通线路（llm-pi-ai 手工 provider）后，新模型上线由插件自动补进普通线路的名单：

1. 每次目录刷新（默认 30 分钟）后，用**普通线路自己的 baseURL 与 Key** 抓 `GET {baseURL}/models`
   （两个网关域名清单可能不同，必须抓普通线路真能服务的那份）；
2. 过滤非对话模型（生成/语音/embedding）与已有/已补过的 id，只留**新**对话模型；
3. 把本插件目录里的模型档案翻译成 pi-ai 条目：`name/contextWindow/maxTokens/input`，
   推理模型再附 `reasoningEfforts`（键=可选档位 off/minimal/low/medium/high/xhigh/max，
   值=线上拼写，按模型 aliases/accepted/rejected 推导）与 `compat.thinkingFormat`
   （千问=qwen、DeepSeek=deepseek、GLM=zai）；没有档案的模型只写 id/name，容量吃路由默认值；
4. 经 `ctx.configEditor.edit()` **只追加**进该线路 `models`（已有条目/其它 provider 分毫不动），
   pi-ai schema 整体校验通过才落盘；pi-ai 官方保证 models 改动下一请求生效、免重启。

纪律：**真变化才写**（差集为空不碰配置文件）；补过的 id 记入
`~/.dsh/qwen-token-plan-full.feed.json` 的 `seen`——用户手动删掉的模型不会被塞回来。
不选档位时 pi-ai 不发推理字段，已有行为零变化；档位翻译整体可用 `feedReasoning: false` 关掉。
状态见 status 路由 `feed` 字段（lastFeedAt/lastAdded/lastError/seenCount），面板「刷新」也会触发补货。

实现细节：周期补货经**回环自触发**（定时端 POST 本机 `/qwen-token-plan-full/feed`，
edit 在 HTTP 处理器的干净异步上下文执行）。原因：HMR 事务用 AsyncLocalStorage 标记且
异步链继承，插件启动 tick 里直接/延后调 `configEditor.edit` 都会报
"HMR transactions cannot be nested"（2026-11-17 实测）；HTTP 处理器生于应用启动、
不带事务标记。无 webServer 的组合（headless，无 HMR）退回直接调用。

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
`endpoint: auto`（默认）会在启动时并发探测这两个站点的 `/models`，**按完成顺序取结果**：
国内站先 200 就立即采用（国际站黑洞也不拖慢）；国际站先 200 时再给国内站 1.5s 宽限，
它在这期间也 200 就仍按国内站优先，否则采用国际站。
两个都不通（断网/无 key）时保留国内站默认值，**provider 照常注册不失活**。

为什么要按完成顺序而不是等两边都落定（v0.4.2 修复）：国内站被黑洞丢包时，等全落定要白等满
15s 探测预算，而这 15s 直接压在用户第一个请求上（实测 15003ms → 现在 1502ms）。
注意「先 `await` 国内站、失败再看国际站」是**同一个坑的另一半**——慢的那个仍然挡在前面，
实测同样 15003ms。1.5s 宽限则是为了不把「国内站只是慢了几百毫秒」误判成国际站（key 不匹配 → 401）。
命中后对话、Chat、目录、图片/视频工具的 URL **整套一起换**，不会出现半切换。
判定挡在第一个模型请求之前（实测 763ms），因为跨站点 401 不在可重试码里，
漏一轮就是整轮直接失败。**观察-only（`registerProvider: false`）时聊天不经过本插件**，
所以图片/视频工具在 `execute` 入口也等判定落地——否则生图会是第一个打到旧地域的请求。

**只有判定成功才固化**（v0.4.2 修复）。v0.4.1 把失败结果一起缓存：启动那一瞬间恰好断网，
国际站 key 就被永久钉在国内站，之后每轮都是不可重试的 `AUTH 401`，网络恢复也不自愈，
只能重启进程（2026-11-18 实测：恢复后重探次数 0）。现在失败会留下重试机会，冷却 30s；
冷却期内的请求直接放行，不拿探测预算压住用户这一轮。
面板 `GET /qwen-token-plan-full/status` 的 `provider.site` / `siteReason`
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

**另一条断连来源：流内错误曾被一律当成 400**（v0.4.2 修复）。上游的限流、过载、超时常常
不在 HTTP 头里，而是 HTTP 200 之后在 SSE 流里下发 `{"type":"error","error":{"code":...}}`。
v0.4.1 把这类错误写死成 400 → 归类 `PROVIDER_ERROR`，而它**不在** `DEFAULT_RETRYABLE_CODES`
（`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`）里 → `llm-retry` 一次都不重试，
用户看到的就是"用着突然断连"。现在流内错误码先还原成等价 HTTP 状态，再走与 HTTP 错误
**同一份**词表：限流→`RATE_LIMIT`、过载/内部错误→`SERVER`、超时→`TIMEOUT`（均可重试）；
额度耗尽仍是 `QUOTA`、认证失败仍是 `AUTH`、用户取消仍是 `ABORTED`（都不可重试）。

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
   本地计数在每次 **MCP 权益调用**派发时加一（v0.5.0 起，见「Harness 权益 MCP 通道」）；
   `qwen_generate_image` 走 MCP 时按落盘张数计入图像生成额度，走模型 API 时**不记权益**
   （那条路花的是 Credits，记了会把没花掉的权益显示成已用）。服务端内置工具调用同样不记权益。
   计数持久化在 `~/.dsh/qwen-token-plan-full.budget.json`
   （重启不丢），周期翻转自动清零恢复。每项判定依据可在面板 status 的 `source` 字段看到
   （`official` = 官网余额，`local` = 本地兜底）。
4. **某项额度耗尽后：请求不再声明该权益对应的工具**（其余权益、模型调用、DSH 本地工具不受影响；
   同名 DSH 本地工具会自动接管，见下），宿主日志提示一次并标明依据；
   `qwen_generate_image` 走 MCP 权益通道时按剩余张数拦住超量请求（n 太大直接报错，不扣钱），
   额度耗尽则摘掉 TextGenerateImage 服务、自动回落模型 API（开始花 Credits）。
   周期重置或官网余额回升后自动恢复。
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
**每行末尾带消耗来源标签**（v0.5.0 起）：绿色「权益」= 这次真在扣套餐单列的权益额度；
黄色「Credits」= 这项还没走通 MCP，调用在花套餐 Credits。下方「权益通道」一行显示
`已连通 n/7`；没配百炼按量付费 Key 时直接写明「现在每次调用都在花 Credits」并给出凭据名。
弹层交互仿模型切换器：无按钮，点徽标即打开并强制回源刷新，点弹层外任意处（透明遮罩）关闭，
Esc 也可关闭。数据同源口径：套餐剩余 = 网关 `per1MonthPercentage` 取反，Credits 按月配额折算。
数据走同源只读路由 `GET /qwen-token-plan-full/status`、`POST /qwen-token-plan-full/refresh`。

## Harness 权益 MCP 通道（v0.5.0 起）

**为什么要有这条通道**：Token Plan 专属 Key（`sk-sp-` 开头）**只能用于模型调用抵扣 Credits**，
不用于 Harness 服务。用它打模型端点生图、或让模型声明服务端内置工具，扣的都是 Credits，
套餐单列的那 20 张图像生成、100 次联网搜索……一次都不会动（实测官方余额长期满格，
而套餐用量百分比在涨）。Harness 权益必须用**百炼按量付费 Key**（`sk-` / `sk-ws-` 开头）
调百炼 MCP 服务才计入。依据：[Token Plan Harness 权益说明](https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits)。

**怎么接**：插件用宿主自带的 `mcpManager.register()` 挂 MCP 服务（零新增依赖、不改 profile）：

| 服务 | 覆盖权益 | 抑制的服务端内置工具 |
|---|---|---|
| `EnhancedSearch` | 联网搜索增强 | `web_search` |
| `VerticalSearch` | 垂类搜索 | `web_search_image` / `image_search` |
| `WebFetch` | 网页解析 | `web_extractor` |
| `CodeInterpreter` | 代码解释器 | `code_interpreter` |
| `TextGenerateSpeech` / `SpeechGenerateText` | 语音合成 / 语音识别 | 无（内置工具里没有对应项） |
| `TextGenerateImage` | 图像生成 | 无（`qwen_generate_image` 自己切通道） |

**服务名是实测出来的，不是照商店标题猜的**（v0.5.1 修正）。命名规律为「输入 Generate 输出」：
`TextGenerateImage` / `TextGenerateSpeech` / `SpeechGenerateText` / `VideoGenerate`；
搜索与抓取则是 `EnhancedSearch` / `VerticalSearch` / `WebFetch`。两种 404 必须分清：

| 响应 | 含义 | 处置 |
|---|---|---|
| `404 MCP服务不存在` | **服务名写错了** | 改名字，不是权限问题 |
| `404 未开通该MCP或非可用开通状态` | 名字对，账号未开通 | 去 MCP 广场开通 |

v0.5.0 曾按商店标题写成 `ImageGeneration` / `WebSearch` / `WebParser` / `TextToSpeech` /
`SpeechToText` / `VideoGeneration`，其中多数根本不存在，宿主会一直 `reconnecting`；
`WebSearch` 虽存在却是另一个服务，且把增强搜索与垂类搜索错误地合并成一项额度。
v0.5.1 起七项权益一一对应七个真实服务，实测全部 `connected`。

- 端点 `${mcpHost}/api/v1/mcps/<Service>/mcp`（streamable-http）。鉴权头写
  `Bearer ${credential:BAILIAN_PAYG_API_KEY}` **模板**交宿主展开——明文 Key 不进配置、
  不进日志、不进 status。Key 后补时凭据事件 `credentials/reference-updated` 触发自动补挂，
  **不用重启**。
- **按余额挂/摘**：某项权益余额为 0 就摘掉对应服务，同时把服务端内置工具还回去
  （否则那个能力就整个消失了）；余额回升自动挂回。余额未知（还没回源）时先挂着让它试。
- **只有真连通才算权益**：抑制内置工具、切换生图通道、面板标绿都只认宿主报的
  `connected` 状态。注册了但连不上（401/断网）时一律按 Credits 处理，绝不谎报省钱。
- **没配 Key 就整条通道不挂**：挂了也是 401，只会给模型塞一堆用不了的工具、给日志刷错误。
  此时面板每行标「Credits」并提示去哪配 Key。
- 记账走 `tools.guard`：派发前乐观 +1（guard 拿不到成功与否），真实口径由控制台回源对齐。
  guard 收到的 `exec` 形状是 `{ name, callId, arguments, signal, … }`（宿主
  `dsh-tools/lib/pipeline.js` 的 `createExecution`），**没有 `exec.tool`**；按权益键记账，
  七个键在 `TOOL_TO_EQUITY` 里都有自映射（`tts`/`asr` 没有内置工具类型，只能走这条路）。
- **Token Plan 权益满格不代表没走通**：官方抵扣顺序是先扣「服务自带免费额度」，
  那一层用完才动 Token Plan 附赠权益（见下一节）。另外阿里云按量付费出账有 1–3 小时延迟
  （[官方说明](https://www.alibabacloud.com/help/zh/user-center/bill-solution-troubleshooting-manual-for-common-consumer-bill-questions)）。
  判断通道是否生效看 `status.mcp.servers[].state` 与生图返回的 `model` 前缀
  （`mcp:` = 走了权益通道），别只看某一层余额。本地乐观计数会先动，官方快照回源后再对齐。
- 视频生成没有独立权益实例（按 Credits 计），默认不挂 `VideoGenerate`，
  以免与 `qwen_generate_video` 重复暴露同一能力。

**`qwen_generate_image` 双通道**：MCP 就绪且还有权益余额 → 走 MCP（真扣那 20 张）；
否则走模型 API（花 Credits）。上游调用失败才回落；**产物落盘失败直接报错、不回落**——
权益已经扣掉了，再走一遍模型 API 等于同一张图收两次钱。上游工具名与参数按宿主同步来的
真实 JSON Schema 匹配（不猜字段名），返回的 URL 与内联 base64 都能落盘。

## 两层免费额度与「当前扣减」（v0.6.0 起）

官方抵扣顺序（[Harness 权益文档](https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits)常见问题原文）：

> 先抵扣对应服务本身的免费额度（如各产品自带的试用/新用户额度），再抵扣 Token Plan
> 附赠的权益额度；权益额度用尽后，超出部分按对应服务的折扣价继续按量计费。

所以**有三层，钱按顺序往下走**：

| 层 | 是什么 | 周期 | 数据来源 |
|---|---|---|---|
| ① 服务自带免费额度 | 各 MCP 服务自己的试用额度（图像 100 张、搜索 200 次、TTS 1 万字符…） | 账号级，**有独立到期日**（实测 12/2、12/4） | `freetier/ListBailianFreetier` → `BssOpenAPI-V3/DescribeFqInstance` |
| ② Token Plan 附赠权益 | 套餐给的那 20 张 / 100 次 | 跟订阅周期（每月） | `queryTokenPlanEquityInfo` |
| ③ 88 折按量后付费 | 两层用尽后的超出部分 | 走账单，**真花钱** | — |

**v0.5.x 的显示缺陷**：面板只读第②层。2026-11-23 实测调了 MCP 生图/搜索/TTS，
第①层各扣 1 张 / 1 次 / 33 字符，第②层七项纹丝不动（20/20 满格）——用户据此判定
「通道没生效」。这是显示缺陷，不是计费缺陷。v0.6.0 起两层并列显示，每行标出此刻在扣哪一层。

- 面板两个小节：**服务自带免费额度**（右挂自己的到期日）+ **Token Plan 附赠权益**
  （右挂订阅周期重置日）。顶部一行「当前扣减」用一句话讲清钱从哪出。
- 每行标签四态：`服务额度`（蓝）/ `套餐权益`（绿）/ `按量付费`（红）/ `Credits`（黄，走模型 API）。
  **标签只标此刻真在扣的那一层**：第一层在扣时第二层不挂标签——两层都挂会让满格的套餐权益
  看着像正在被消耗，那正是这一版要消除的误读。
  由 `status.chargeSources` 给出——它把**通道**（MCP 还是模型 API）与**扣减层**合成结论，
  两者正交：走模型 API 时无论哪层有余额，花的都是 Credits。
- **第①层不参与工具拦截**。它耗尽只意味着开始扣第②层，能力并没有断；拿它去摘工具会把
  还能用的能力误停。只有第②层耗尽才停用内置工具声明（`filterTools` 口径不变）。
- 第①层数据缺失时**不假定它还有余量**：宁可显示第②层，也不谎报「在扣免费额度」。
  已到期 / 快照超新鲜度 / 时钟回拨一律判不可用，面板给可操作提示而不是画空表。
- 单位一律用 `BaseValue` 归一（字符/秒），**不用上游 `ShowUnit`**：语音合成的
  `InitCapacity.ShowUnit` 是「万字」而 `CurrCapacity.ShowUnit` 是「word」，两边口径不一致。
  `EndTime` 形如 `Wed Dec 02 00:00:00 CST 2026`，V8 把 `CST` 当美国中部（−06:00），
  必须替换成 `GMT+0800` 再解析，否则到期时间错开 14 小时。
- 视频只在第①层有额度（10 秒试用），第②层没有独立实例：第①层显示真实余量，
  第②层仍显示「✓ 包含」。不足 1 分钟的秒级额度按秒显示，避免被四舍五入成「0h/0h」。
- **第①层不刷新**（v0.6.2 起据此改显示）：`DescribeFqInstance` 的
  `CurrentCycleStartTime`/`CurrentCycleEndTime` 与 `StartTime`/`EndTime` 完全相同
  （实测八项皆然，9/2→12/2、9/4→12/4），即整个生命周期只有一个周期，**用尽或到期都不补发**。
  所以面板把**用尽的行整行隐去**，不留「0/100」让人误以为还会回满；全部用尽时整个第一层小节隐去。
  这与「取数失败」严格区分：后者才给可重试提示。第②层不受影响，它按订阅周期每月重发。
- 第①层是账号级试用额度，**不随订阅周期清零**；跨实例合并时两层各自比新鲜度
  （来自不同接口，任一层失败不该让另一层的快照作废）。

## 未知新模型的推断规格

线上出现目录没有的 id 时按家族推断保守规格：`glm*` → Chat 路、档位 low/high/max（无 none）；`deepseek*` → Responses、none/low/high/max、ctx 163840；`qwen*` → Responses、none/low/medium/xhigh、带全部内置工具；其余 → Responses、ctx 131072。规格不准时用 `models` 配置覆盖。

## 已知边界

- 动态目录刷新失败（无 Key/断网）静默保留旧目录，插件不失活。
- 图片 `size`/`n` 经实测走请求体顶层 `parameters` 字段原生透传；顶层 `size`/`n` 会被忽略。
- 视频任务超 15 分钟未完成会报错并附 task_id，可稍后人工查询。
- 生成结果的签名 URL 约 24 小时过期；文件已落盘不受影响。
- **MCP 权益通道依赖宿主 `mcpManager`**（DSH 自带 `@deepseek-ai/dsh-mcp-manager`，本 profile 已 active）。
  宿主没有它时通道整体降级为 Credits，插件其余功能不受影响，面板会说明原因。
- MCP 记账是**派发前乐观计数**（`tools.guard` 拿不到成功与否），失败调用也会先 +1；
  真实口径以控制台回源为准（默认 15 分钟新鲜度）。
- MCP 生图暂不支持本地参考图（`referenceImage`）：带参考图时直接走模型 API。
- **第①层「服务自带免费额度」需要控制台 Cookie**（与权益余额同一登录态）。Cookie 失效时
  这一层显示为不可用并提示重试，第②层照常显示；`serviceQuotas:false` 可完全关掉这一层取数。
- 第①层的到期日是**账号级试用额度的终点**，与订阅周期无关；到期后该项自动判不可用，
  扣减层随之落到第②层或按量付费。

## 与 DSH 0.2.1-rc.5 的兼容修复（插件 0.2.1）

- 通过 `Config`、`credential-ref` 和 configurable-provider 目录接入 DSH 模型设置；Key 由 DSH 凭据服务管理，缺失时返回 `MISSING_CREDENTIAL`。
- 自定义函数与服务端内置工具同名时保留 DSH 函数，移除冲突的服务端工具；内置 `web_extractor` 必须随内置 `web_search` 一起启用。
- `reasoningEffort: none` 不声明服务端内置工具，因为 Token Plan 普通模式拒绝内置代码解释器和网页抓取；DSH 函数仍可使用。
- 请求使用模型目录的默认推理档位和别名。GLM 强制思考模型在本地拒绝 `none`，避免发送必定失败的请求。
- HTTP 和流内的上下文超限、配额耗尽使用 DSH 标准错误码；流中断不会冒充成功回复。
- 目录更新通知 DSH 模型列表；热卸载取消目录和等级请求、清理定时器。媒体工具尊重 DSH 工作目录解析失败，不会悄悄改写到其他目录。

### 本地验证

在插件目录执行 `npm test`（219 项：compat + relogin + stream + tier-retry + route-guard + model-display + catalog-feed + observer + capability-probe + config-knobs + stream-resilience + probe-integrity + media-safety + budget-merge + mcp-equity + quota-layers + tts，含媒体下载 SSRF/重定向、流内错误分类（Chat 与 Responses 两条路线）、HTTP 429 与额度措辞的优先级、探测完整性、跨实例预算合并、纯文本生图端点回归、MCP 权益通道挂/摘与双通道计费口径、**MCP 派发按真实单位记账（字符/张/秒）与 asr 秒数在 `tools/result` 补记**、两层额度与扣减层判定、**第一层免费额度不虚扣第二层权益（含跨层拆分与周期翻页）**、语音合成落盘与按字符记账、**Chat 工具调用分片归并（空串 id 不覆盖、并行不污染）、SSE 心跳续命、内置工具让位需本次请求带 MCP 工具**）。runner 逐文件串行执行（Windows 上唯一全绿的组合，见 `test/run.mjs` 注释）。另有 `test/client-smoke.mjs` 单独跑（面板渲染桩，不在 runner 内；含来源标签与权益通道断言：缺 Key 时全标 Credits 且给出凭据名、连通项按扣减层标注、无 mcpManager 时说明原因；以及 v0.6.0 的两层断言：两小节并列且顺序与抵扣顺序一致、两层各自的真实数字、第一层耗尽转标套餐权益、第一层缺数据时不谎报、视频 10 秒试用按秒显示；v0.6.2 追加：第一层用尽行整行隐去、全部用尽时整节隐去、用尽与取数失败严格区分）。

下载类用例把 DNS 钉在 mock 上（`pinPublicDns`）：本机 DNS 会把 `*.invalid` 泛解析到
`198.18.x.x`（RFC 2544 基准段，属 SSRF 闸的内网地址），不钉死就会随网络环境随机失败。
`test/config-knobs.test.js` 钉死两个跨境旋钮与站点自动判定：默认值与最坏墙钟、非法值拒绝、
`providerRetryPolicy` 真的把策略交给宿主、真实 HTTP 服务器上卡死的流在**配置的**阈值处报 TIMEOUT、
国际站 key 自动切新加坡、断网不失活、换站点后媒体工具与目录一起跟随、
**首个模型请求必须等判定落地**（401 不在可重试码里，漏一轮就是整轮失败）、
**观察-only 时生图也要等判定**（聊天不经过 adapter，门控够不着媒体工具）。

**`test/stream.test.js` 必须用真实 HTTP 服务器而不是假流**：超时靠 abort 请求信号生效，真实 undici 收到 abort 会取消 body 并让读取抛错；手写假流不响应 abort，只能测出「定时器到点」，测不出「读取是否真的被中止」。它钉死三条语义：慢但持续的流必须完整读完（超时是**空闲超时**不是总时长，否则长回答会被掐断）、卡死的流要在阈值附近报 TIMEOUT、用户取消要立刻报 ABORTED。

测试使用本机已安装的 DeepSeek Harness 内置运行时与真实 `dsh-llm` 类，不访问网络、不读取个人凭据。其他安装路径可通过 `DSH_TEST_NODE` 和 `DSH_TEST_RUNTIME` 指定。

真实联网验证需单独进行；正常测试不会运行图片或视频生成。

## v0.7.3（2026-11-25，整合 codex PR #2：工具调用归并 + 心跳续命 + 内置工具让位收窄）

**来源**：整合 GitHub PR #2（`codex/dsh-adapter-review-fixes`），并在整合复核中修掉 PR 自带的两处缺陷、
补回一处被 PR 削弱的既有护栏。

- **Chat 路线 tool_calls 归并（审计 Q13 收口）**：分片按 `index` + `id` 双表归并，`id` 晚到不再用占位
  id 分裂成两个调用。**空串不是 id**——`call.id !== undefined` 与 `== null` 两种写法都会让续片段的
  `id:""` 覆盖真 id，`tool_result` 就对不上上游那条调用；现在空串一律视为「没给 id」。
- **无主续片段只在单块时复用**：PR 原实现无条件复用 `lastToolBlock`，并行两个调用时后续省略
  `index`+`id` 的片段会把两条调用的参数拼成坏 JSON，还污染已经正确的那一条。现在只有「当前仅一个
  工具块」才复用，多块时另开新块（归属不可判定时宁可分开，不猜）。
- **心跳/注释行续命空闲超时**：`iterateSse` 新增 `onData` 回调，收到任何字节就 `deadline.touch()`。
  旧实现只在产出 chunk 时续命，纯心跳（`: keep-alive`）的长任务会被误判 TIMEOUT。
- **内置工具让位收窄**：`filterMcpShadowedBuiltins(tools, mcp, requestTools)` 只在**本次请求真的带了**
  该服务的 `mcp__` 工具时才摘对应内置工具。旧实现只要 MCP 挂着就摘，本次请求没带 MCP 工具时
  内置搜索被白白弄丢。
- **HTTP 429 结构化 code 优先（Q2 加强）**：先 `JSON.parse` 取 `error.code ?? code` 再判额度字样。
  整合复核补回护栏：**JSON 报文只给 `message`（没有 code）时仍按 message 认明确额度字样**——
  PR 原实现在这种情况下把真终局的额度耗尽降级成 RATE_LIMIT，会白重试两轮且面板不提示。

**验证**：`npm test` **219 项全绿**（新增 6 例：无 index 分片归并、空串 id 不覆盖、并行调用不污染、
内置工具让位需请求带 MCP 工具、keep-alive 续命真实服务器用例、429 JSON 缺 code 的额度护栏）。

## v0.7.2（2026-11-25，两层额度分开记账 + MCP 派发按真实单位计费）

**背景**：2026-11-24 全量审计里两项「真金白银」缺陷（Q4/Q5）。两者都让本地余额与上游真实扣费
脱节：一个**虚扣**（免费额度还在却把套餐权益扣光、误摘工具回落付费），一个**少记**
（合成 2 万字符只记 1，权益其实早已耗尽却仍判有余量，超出部分走套餐外 88 折后付费）。

**Q4 — 第一层与第二层各自记账**（`lib/budget.js`）：
官方抵扣顺序是「服务自带免费额度 → Token Plan 权益 → 按量后付费」。旧实现两层共用
`byEquity` 一个计数器，于是第一层的免费用量被记到第二层头上：`equityState` 的
`remaining = available − sinceFetch` 凭空少掉一截，`mcp-equity` 据此摘掉 MCP 服务、
`qwen_generate_image/speech` 的预检据此拒绝调用 —— **免费额度还剩很多却开始花 Credits**。
新增账号级计数器 `byService`：`record()` 先按第一层**剩余量**吃满，溢出的部分才记第二层
（一次调用可以跨越两层）；`serviceQuotaState` 只读 `byService`，回源基线也取 `byService`；
跨实例合并三个分支都单独合并它；订阅周期翻页只清第二层（第一层是账号级试用额度，不随周期清零）。

**Q5 — MCP 派发按真实计量单位记账**（`lib/mcp-equity.js`）：
七项权益单位不同（`gateway.js`）：语音合成按**字符**、语音识别按**秒**、生图按**张**，其余按次。
旧 guard 一律 `record(key, 1)`，模型直调 `mcp__TextGenerateSpeech__bailian_tts` 合成 2 万字符
只记 1。新增 `equityUnitsForDispatch(key, exec.arguments)`：tts 取文本长度（与插件自家工具同口径）、
生图取 `n`（缺省 1，越界收敛到上游 1–4，不拿脏值放大记账）、其余按次。
asr 的秒数派发时不可知（入参只有音频 URL），先记 1 秒占位，再在宿主
`tools/result`（冻结的最终结果观察点）里按 `asrSecondsFromResult` 补差额：上游明确时长
（`duration`/`duration_ms`/句末 `end_time`）优先，否则按转写正文 ÷ 4 字每秒估算；
只认自己派发过的 `callId`、失败调用与拿不到线索的结果保持占位不猜数，同一调用只补一次，
`dispose` 撤观察器。字符只数**转写字段**（`results`/`sentences[].text`/内容块正文），
`request_id` 与块类型标签不算语音内容。

**验证**：`npm test` **213 项全绿**（新增 9 例：第一层还在扣时第二层不得虚扣、一次调用跨层拆分、
周期翻页第一层不清零；guard 按字符/张/次记账与脏值收敛、asr 秒数补记与去重、失败/未派发/无文本
不补记、上游明确时长优先、纯函数边界（非 JSON 转写、句级累加、循环引用、向上取整））。

## v0.7.1（2026-11-25，Chat 路线流内错误分类 + HTTP 429 优先级）

**背景**：2026-11-24 全量审计（48 项发现）里两处「一行级漏修」——同一个问题在 Responses 路线
2026-11-18 已修，Chat 路线与 HTTP 分类函数漏了同款防护。两者都直接决定 **llm-retry 会不会重试**：
宿主 `DEFAULT_RETRYABLE_CODES` 只认 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`，
错分成 `PROVIDER_ERROR` 或 `QUOTA` 就是终局，一次网络抖动/限流即整轮失败。

**Q1 — Chat 流内错误不再写死 HTTP 400**（`lib/chat.js`）：
旧代码 `if (chunk?.error) throw new LlmError(..., httpFailure(400, ...))`，于是上游流内
`rate_limit_exceeded`、`server_error` 全部落 `PROVIDER_ERROR`（400 既不是 429 也不是 5xx），
llm-retry 一次都不重试。改为与 Responses 路线同款的 `streamFailureCode(chunk.error)`：
**结构化 `code`/`type` 优先**（`insufficient_quota`/`billing_*`→QUOTA、`rate_limit*`→RATE_LIMIT、
`timeout*`→TIMEOUT、`server*`→SERVER），code 不认识才退到文本启发式。

**Q2 — HTTP 429 先于 quota 文本启发式**（`lib/errors.js`）：
旧顺序把 `isQuotaExceededError(body)` 排在 `status === 429` 之前，而网关存在
**429 限流但 body 带 "quota exceeded" 措辞**的报文（code/message 不一致），被误判成终局 QUOTA：
不重试，且面板显示「额度耗尽」误导用户。改为 429 先判 `RATE_LIMIT`；只有 body 以明确的额度
结构化字样开头（`insufficient_quota` / `insufficient quota` / `billing_*`，与流内侧枚举同款词首匹配）
才判 QUOTA——那是真终局。400 + 「余额不足/额度耗尽」等中文文案仍判 QUOTA，行为不变。

**验证**：`npm test` **204 项全绿**（`stream-resilience.test.js` 新增 4 例：Chat 流内
`rate_limit_exceeded`/`server_error`/`request_timeout` 归到可重试码、`insufficient_quota`/`invalid_api_key`
仍为终局；HTTP 429 + quota 措辞（含中文「额度耗尽请稍后再试」）→ RATE_LIMIT，429 +
`insufficient_quota`/`insufficient quota: billing…` → QUOTA，400 + 「余额不足」/`quota exceeded`
与 200 + 「额度耗尽」仍 → QUOTA）。

## v0.7.0（2026-11-24，语音合成工具：自动落盘 + 给文件）

**背景**：DSH 暂不支持音频附件——`dsh-mcp-client` 把 MCP 的 `audio` 块替换成占位文字、
`dsh-attachment` 只有 `saveImages` 没有 `saveAudio`、客户端没有任何 `<audio>` 播放器。
所以语音合成（TTS）的产物**无法在对话里内嵌播放**，百炼 TTS MCP 返回的本就是一个约 24h
过期的 wav URL。语音识别（ASR）产物是文本，走标准 text 通道直接进对话，不受此限。

**新增工具 `qwen_generate_speech`**（照 `qwen_generate_image` 的权益通道模式）：
调百炼 `TextGenerateSpeech` MCP（`bailian_tts`）→ 提取音频 URL → **自动下载到会话工作目录**
→ 返回本地文件路径（可点开收听、长期保存）与原始 URL。参数 `text`（≤2 万字符）、`voice`
（电商直播男/女、温柔女声、沉稳男声、英文男/女生、老年男/女声、童声男/女，留空用默认）。
走 MCP 权益通道：扣第一层语音合成额度（**按字符计**，`mcp_input_chars_mode`），不花 Credits；
权益未就绪/耗尽时报错说明（语音**没有模型 API 回落通道**，不像生图可回落扣 Credits）。

**实测踩到并修掉的三个真实形状坑**（离线测试先前都测不出，真实调用才暴露）：
1. **URL 藏在 JSON 字符串里**：宿主把 TTS 结果放在 `content[].text`（一段 `{"result":"http://…wav?…","request_id":…}` JSON 字符串），没有 `structuredContent`。`extractMcpAudio` 原先只扫对象字段，提不出 URL。改为：字符串若以 `{`/`[` 开头先 `JSON.parse` 再走对象分支；正则排除反斜杠（避免把 JSON 转义的尾部 `\` 带进 URL）。
2. **结果 URL 是 `http://`**：百炼 OSS 签名地址用 http，而下载安全闸只收 https。OSS 同域名支持 https 且签名与协议无关，故对 `*.aliyuncs.com` 升级 https 后再过闸；其它域名的 http 仍拒（fail-closed 不放宽）。
3. **代理 fake-IP 被误判内网**：Clash Verge（TUN 模式，`utun7` 198.18.0.1）把公网 OSS 域名解析到 `198.18.3.56`（RFC 2544 基准保留段）。SSRF 闸原把该段一律当内网拒。改为：**IP 字面量** `198.18.x.x` 仍拒（C1 钉死）；**域名经 DNS 解析**落到该段时放行 + warn（与 C3 解析失败放行同理——本地 DNS 已被代理接管，真实路由由代理侧决定，fail-closed 会打死合法下载）。真内网段（127/10/172.16/192.168/CGNAT/::1/ULA…）仍一律拒。

**记账口径修正**：上游在**合成成功那一刻**即扣字符，与下载成败无关。故 `budget.record("tts", text.length)` 放在下载**之前**——下载失败也要记，否则本地账本少计（与生图「每张落盘成功即计」不同：生图按张、下载失败那张确实没产出；语音按字符、合成已发生）。`callTool` 直调 `definition.execute` 不经 `tools.guard`，须手动记一次，不会重复计数。

**验证**：`npm test` 200 项全绿（新增 `tts.test.js` S1–S13：落盘+RIFF/WAVE 头校验、按字符记账、额度预检、未就绪/耗尽报错、空/超长文本、上游字段名匹配、音频 URL 优先、落盘失败仍记账不留半截、不传 voice 不塞字段、JSON 字符串提 URL、OSS http→https、非 OSS http 仍拒、fake-IP 放行；`media-safety` 新增 C2b fake-IP 域名放行+字面量仍拒）；`client-smoke` 通过。真实调用 `qwen_generate_speech`（温柔女声 16 字符）→ 落盘 `qwen-speech-…wav`（RIFF/WAVE PCM 16bit mono 24kHz，184KB），第一层 tts 扣 16 字符、`chargeSources.tts=service`。

## v0.6.2（2026-11-24，第一层用尽即隐去：它不会刷新）

**问题**：第一层用尽后面板仍显示「0/100张」。但这层是**一次性试用额度**，不会回满——
留着 0 会让人以为下个月还会补，从而误判可用量。

**先证实「不刷新」再改显示**（不靠猜）：`DescribeFqInstance` 返回的
`CurrentCycleStartTime`/`CurrentCycleEndTime` 与 `StartTime`/`EndTime` **完全相同**，
八项皆然（9/2→12/2、9/4→12/4）。整个生命周期只有一个周期，没有月度重置。
对照第②层：它按订阅周期每月重发，所以两层显示逻辑必须不同。

**改法**（`lib/client.js` 的 `QuotaLayers`）：先按 `remaining > 0` 过滤出可见行，
再决定是否画小节标题与到期提示——

- 部分用尽：只隐去用尽的那几行，其余照常显示，到期日取**可见行**里最早的。
- 全部用尽：整个第一层小节隐去（不留空标题）。
- **取数失败**（`serviceQuotas` 为空数组）：仍给可重试提示。用尽 ≠ 失败，两者严格区分。
- 第②层完全不受影响；用尽项的扣减层照常落到第②层并标「套餐权益」。

新增冒烟断言：全部用尽时无「0/100张」、无第一层标题、无重试提示、第二层仍完整；
部分用尽时只隐图像行、搜索行仍在、用尽项在第二层标「套餐权益」。

## v0.6.1（2026-11-24，冷启动竞态：权益通道不再永久降级）

**症状**：重启 App 后 `status.mcp` 报 `{enabled:false, reason:"no-manager"}`、
`chargeSources` 七项全 `credits`、第一层额度一行都没有——整条权益通道失效，
但热重载（`set_plugin enabled=true`）后一切正常。

**根因**：宿主的 `mcp-manager` 是**独立插件**，冷启动时可能比本插件晚就绪。
旧实现在 `registerEquityMcp` 里 `ctx.get("mcpManager")` **抓一次就定死**，
拿不到就直接返回 noop 降级对象，此后没有任何机会再试。热重载时 manager 早已 active，
所以这个 bug 在开发期完全看不见——只有真正重启 App 才暴露。

**修法**：manager 改为**动态解析**（`resolveManager()`），每次 `rearm()` 重解析一次；
拿不到时不再提前返回，而是照常建立状态并用宿主 `timer` 每 2 秒轮询，
**出现即挂载并停止轮询**（不长期占用）。`mount()` 在无 manager 时静默跳过而非记成失败；
`status().reason` 如实报 `no-manager`，`usesEquity`/`equityChannel` 一律返 false/credits，
不谎报省钱。`dispose()` 一并撤掉轮询。

新增回归 `a manager that appears later is picked up instead of degrading forever`：
假宿主支持 `managerLate`，先断言未就绪时不挂且不声称权益，再 `bringManagerUp()` +
`rearm()` 断言七项全挂。**这类「只在冷启动出现」的竞态，必须有意识地构造晚就绪夹具才测得到。**

实测：修复后热重载，`mcp.reason=mounted`、7/7 connected、第一层八行回来
（`search_pro=1`、`image_generation=1`、`tts=33`）、`chargeSources` 八项全 `service`、
`tier.source` 从 `builtin` 恢复为 `gateway`。

## v0.6.0（2026-11-23，两层免费额度与「当前扣减」）

**这不是 bug 修复，是把一个显示缺陷补上——它此前让用户以为整条权益通道没生效。**

实测经过：拿到真实 Key、七个服务全部 `connected`、生图返回 `mcp:bailian_image_gen`，
但 Token Plan 权益七项纹丝不动（图像 20/20 满格）。第一反应是「出账延迟 1–3 小时」，
等了近两小时复查仍然全满——那个归因是错的。继续挖控制台前端才找到真相：
**官方先扣「服务自带免费额度」，那一层用完才动 Token Plan 附赠权益。**
同一时刻第①层的实测数字正好对上我们的调用：图像 99/100（扣 1 张）、
语音合成 9967/10000（扣 33 字符）、联网搜索 199/200（扣 1 次）。

取数链路是从 `benefits.js` 里挖出来的，不是猜的：
`freetier/ListBailianFreetier{CommodityList:["sfm_plugin_public_cn"]}` 拿模板码 →
`BssOpenAPI-V3/DescribeFqInstance{TemplateCodes}` 拿 `InitCapacity`/`CurrCapacity`，
已用 = 两者 `BaseValue` 相减。此前猜过的十几个接口名全部 `NotFound`。

改动：

- `lib/gateway.js` 新增 `fetchServiceQuotas`（八项映射，含视频 10 秒试用），
  `Status==="valid"` 才算可用；单位用 `BaseValue` 不用 `ShowUnit`；
  `EndTime` 的 `CST` 换成 `GMT+0800` 再解析（否则错 14 小时）。
- `lib/budget.js` 新增第一层快照落盘、`serviceQuotaState`、`chargeLayer` 四态判定，
  跨实例合并时两层各自比新鲜度，第一层不随订阅周期清零。
- `index.js` 新增 `serviceQuotas` 开关与并行回源，status 输出
  `serviceQuotas`/`chargeLayers`/`chargeSources`（通道 × 扣减层的合成结论）。
- `lib/client.js` 面板改成两个小节并列 + 每行四态标签 + 顶部「当前扣减」一句话。
- **第一层耗尽不停用工具**：它只意味着开始扣第二层，能力没断。
- 视频只在第一层有额度，`chargeSources` 对它按层判定而非一律标 Credits。

**验证**：`npm test` 186 项全绿（新增 `quota-layers` 9 与冷启动竞态回归 1）；`client-smoke` 覆盖两层并列、
第一层耗尽转标套餐权益、第一层缺数据不谎报、视频按秒显示；热重载后实测 status 出两层
真实数字（第一层三项已扣、第二层七项满格）、八项 `chargeSources` 全 `service`；
面板 bundle 经 combo 地址取回 200，含两小节标题与「当前扣减」。

另修两处**既有**测试对本机 DNS 的隐式依赖（`*.invalid` 被泛解析到 `198.18.x.x`，
落进 SSRF 闸的内网段）：`compat` 与 `route-guard` 的下载用例改为把 DNS 钉在 mock 上。
已在 HEAD 副本复跑确认这两个失败与本版改动无关。

## v0.5.2（2026-11-23，MCP 服务名实测修正 + 权益记账漏映射）

v0.5.0 的 MCP 服务名是照百炼商店的**中文标题**推的英文名，拿到真实 `sk-ws-` Key 后逐个探测
才发现多数根本不存在。这是本版唯一的实质缺陷，但它让整条权益通道形同虚设。

**实测方法**：对 `<host>/api/v1/mcps/<name>/mcp` 发 JSON-RPC `initialize`，按响应区分：

| 响应 | 含义 |
|---|---|
| `200` + `serverInfo.name="BaiLianMcpServer"` | 服务存在且账号可用 |
| `404 MCP服务不存在` | **名字写错**（不是权限问题） |
| `404 未开通该MCP或非可用开通状态` | 名字对、账号未开通 |

**修正对照**（左为 v0.5.0 错名，右为实测真名）：

| v0.5.0 | 实测结果 | v0.5.1 |
|---|---|---|
| `ImageGeneration` | 404 服务不存在 | `TextGenerateImage` |
| `WebSearch` | 200，但是**另一个服务** | `EnhancedSearch`（增强搜索）+ `VerticalSearch`（垂类搜索） |
| `WebParser` | 404 未开通 | `WebFetch` |
| `TextToSpeech` | 404 服务不存在 | `TextGenerateSpeech` |
| `SpeechToText` | 404 未开通 | `SpeechGenerateText` |
| `VideoGeneration` | 404 服务不存在 | `VideoGenerate` |
| `CodeInterpreter` | 200 ✓ | 不变 |

命名规律是「输入 Generate 输出」。另外把默认 `mcpHost` 从千问 One Key 域名改为官方文档给的
`https://dashscope.aliyuncs.com`（两域名对同一服务名返回一致，千问域名保留为 `MCP_HOSTS.qianwen`）。

**连带修正**：增强搜索与垂类搜索是**两个独立服务、各有独立额度**，v0.5.0 把它们合并成一个
`WebSearch` 会导致垂类搜索永远扣不到自己的额度、且任一项耗尽会误摘另一项。现在七项权益
一一对应七个服务，`equityKeysOfService` 仍返回数组以备上游将来合并。

**记账漏映射修正**：`TOOL_TO_EQUITY` 原先只收服务端内置工具类型（`web_search` 等），
而 MCP 通道的 guard 是**按权益键**记账的。`code_interpreter`/`image_generation` 恰好同名
所以蒙对了，`tts`/`asr`/`search_pro`/`vertical_search`/`webfetch` 查不到映射就被
`record()` 静默丢弃——语音权益调了也不计数，面板永远显示 0。现在七个权益键全部自映射。
同时删掉 `lib/mcp-equity.js` 里没人用的 `TOOL_TO_EQUITY` 再导出。

**验证**：`npm test` 176 项全绿（服务数断言 6→7、搜索额度独立性、guard 分项记账、
权益键自映射回归均已覆盖；guard 测试改用真实 `exec` 形状 `{ name, callId, … }`——
宿主 `dsh-tools/lib/pipeline.js` 的 `createExecution` 里**没有 `exec.tool`**，
早先只按 `exec.tool.name` 写测试会漏掉真形状）；
热重载后实测 7 个服务全部 `connected`、`equityChannels` 七项全 `equity`；
真实调用 `qwen_generate_image` 返回 `model="mcp:bailian_image_gen"`，产物落盘正常；
`mcp__EnhancedSearch__search_pro` 与 `mcp__TextGenerateSpeech__bailian_tts` 均调用成功，
修复后 tts 本地计数 `0 → 1`、面板显示 `used=1/10000 remaining=9999`。
官方余额因按量付费出账延迟（1–3 小时）当时仍显示满额，属预期，见「已知边界」。

## v0.5.0（2026-11-23，Harness 权益 MCP 通道）

**修的是一个计费口径错误，不是崩溃**：此前所有「权益」调用其实都在花套餐 Credits——
Token Plan 专属 Key（`sk-sp-`）只用于模型调用，Harness 权益必须用百炼按量付费 Key
（`sk-`/`sk-ws-`）调 MCP 才计入。现象是权益页 7 项长期满格（图像生成 20/20），
而套餐用量百分比从 1% 涨到 1.74%。旧版还按那 20 张免费额度去拦 `qwen_generate_image`，
护栏错位：拦的是没在花的额度，放过的每张都在花 Credits。

改动：

- 新增 `lib/mcp-equity.js`：用宿主 `mcpManager.register()` 挂 6 个百炼 MCP 服务覆盖 7 项权益，
  鉴权走 `${credential:...}` 模板（明文 Key 不落任何地方），按余额挂/摘，
  `tools.guard` 乐观记账，Key 后补经凭据事件自动补挂。
- 新增配置 `bailianApiKeyEnv` / `mcpEquity` / `mcpHost`；`status` 新增 `mcp` 与 `equityChannels`。
- `qwen_generate_image` 双通道：MCP 优先真扣权益，上游失败才回落模型 API；
  落盘失败不回落（避免同一张图收两次钱）；模型 API 分支不再记权益。
- adapter 在声明服务端内置工具前剔除已被 MCP 接管的能力，且只认「真连通」的服务。
- 面板每行加消耗来源标签（绿「权益」/黄「Credits」）+「权益通道 已连通 n/7」+ 缺 Key 提示。

**176 项离线回归全部通过**（新增 `mcp-equity` 13、`compat` +1）。新增用例专门盯住三件容易
写错的事：缺 Key 时一个服务都不挂且面板如实说在花 Credits；注册了但连不上时既不摘内置工具
也不标绿；额度耗尽摘服务的同时把内置工具还回去。热重载后实测 `status`：
`mcp.reason="missing-key"`、7 个服务 `mounted:false`、7 项 `equityChannels` 全 `credits`
——与「还没配 Key，所以现在确实在花 Credits」的事实一致。真实扣减待 Key 到位后验证。

## v0.4.3（2026-11-23，纯文本生图端点修复）

`qwen_generate_image` 三个模型（qwen-image-3.0-pro / wan2.7-image / wan2.7-image-pro）
**无参考图的纯文本生图一律 HTTP 400**：

```
Input should be 'user': input.messages.0.role &
Input should be a valid list: input.messages.0.content &
Input should be a valid list: input.messages.1.content
```

根因：旧实现把纯文本生图发到 compatible-mode `chat/completions`（OpenAI 形状
`messages[].content=[{type:"text",text}]`），但图像模型在该网关按 DashScope **原生形状**校验
（顶层 `messages` 被当成 `input.messages`，且 `content` 必须是原生 part 列表）。图生图分支本就
走原生端点，所以只有「不带参考图」这条路径坏掉——恰好是最常用的路径。

修复：两条分支统一到原生多模态端点
`/api/v1/services/aigc/multimodal-generation/generation`，请求体
`input.messages[0].content = [{text:prompt}]`（纯文本）或 `[{image:...},{text:prompt}]`（图生图）。
`prompt_extend` 纯文本保留服务端默认（智能改写提升出图质量），图生图仍关闭（编辑指令逐字执行）。
`size`/`n` 透传 `parameters` 不变；额度预检、逐张记账、下载 SSRF 防护均不受影响。

验证：新增 `media-safety` T1/T2 两条端点回归（钉死原生端点 + `input.messages` 形状 + 不得再发
compatible-mode + `prompt_extend` 默认），并修正 3 处旧 mock（`compat`、`config-knobs` ×2 原先
打 `/chat` 是钉住了 bug 行为）。**161 项离线回归全部通过**（`media-safety` 22→24）。
真实联网实测：修复后纯文本生图 HTTP 200 出图，旧 400 消失；经 HMR 热重载在运行中的 DSH 上
用工具实跑确认（`set_plugin enabled=true` 触发 `reconcileProfile` 换掉旧 ESM 缓存，无需重启）。

## v0.4.2（2026-11-18，发布后审计整改）

对已发布的 v0.4.1 做了一轮完整审计（三路并行只读审计 + 逐条实测复核），发现 18 个问题并全部修复。
审计报告见工作区 `qwen-plugin-audit-0.4.1.md`。四个 P0：

1. **流内错误一律当 400 → 跨境断连不重试**（见「不同地区访问」节）。修复后限流/过载/超时
   分别归 `RATE_LIMIT`/`SERVER`/`TIMEOUT`，`llm-retry` 才会介入。分类**先信结构化 code、
   再回落 message 文本**：宿主的额度判定只看文本里有没有 `quota exceeded`，
   `code=rate_limit_exceeded` 而文案带 quota 字样的限流会被误判成不可重试的 `QUOTA`。
2. **站点判定失败被永久固化**（见「不同地区访问」节）。改为只有真拿到 200 才固化，
   失败留 30s 冷却后重试；面板手动刷新绕过冷却（用户点刷新就是要立刻重试）。
3. **能力探测被 30s 目录预算掐断，降级值还被永久缓存**。线上实测同一个
   `qwen4-max-preview`：30s 只发出 10 个请求 → `maxTokens` 探成 131072；180s 发满 11 个
   → 393216（真值）。被掐位置随网络抖动而变，多次运行得到 131072/262144/393216 三种结果。
   现在探测有独立预算，不可信失败（传输错误/中止/5xx）不写缓存、改走保守推断并留
   `probe-incomplete` 痕迹，面板刷新可 `reprobe` 重探。
4. **`referenceImage` 可外发任意本地文件**：此前不校验扩展名/内容/目录，一个 `.env`
   就能被 base64 原样发给上游。现在扩展名白名单 + 魔数校验 + 先 `stat` 判大小 +
   `realpath` 收口在会话工作目录内。

另有 5 个 P1（SSE 单事件无上限、`excludeModels` 不排除探测、`refresh` 无串行化、
探测等整段生成读完、下载全量驻留内存）与 9 个 P2（SSRF 缺网段与非字面量域名、
参考图先读后判大小、非对话模型过滤漏项、面板刷新绕过站点门控、站点探测等全落定、
预算跨实例整份覆写、时钟回拨快照永不过期、配置项缺说明、两处代码/注释冗余）。

**修复过程中又自查出五处新问题，一并修掉**（前三处是修复本身引入的，后两处是审计漏掉的）：

- **★ 探测用的图片本身不合格，导致所有动态发现的模型都被判成「不能收图」**。
  `PROBE_PNG_BASE64` 注释写「16×16」，实际是 **1×1**。上游对图片有最小边长限制，
  实测 `qwen4-max` 与 `qwen4-max-preview` 都回 HTTP 200 + `response.failed`：
  `InvalidParameter: The image length and width do not meet the model restrictions.
  [height:1 or width:1 must be larger than 10]`。这属于「可信的拒绝」，于是被当成能力事实
  缓存下来 —— 每个新模型一律 `input: ["text"]`，带图请求在宿主装配阶段抛 `UNSUPPORTED_CONTENT`。
  **动态能力探测本想根治的毛病，被探测自己用一张不合格的图重新造了出来。**
  换成真正 16×16 后，同一请求返回 `response.created`，线上复测
  `qwen4-max-preview` 得到 `input: ["text","image"]`、`maxTokens: 393216`，连续两轮稳定一致。

- **面板刷新会被能力探测拖死**。探测预算 180s，而面板前端 fetch 上限 45s，
  用户会先看到超时报错、后台还在继续花 Credits。现在前台刷新最多等 8s
  （`FOREGROUND_REFRESH_WAIT_MS`）就先回状态，探测转后台继续**不取消**（已在跑的探测
  取消掉等于白花钱），面板显示「模型规格探测中…」。
- **无条件 `reprobe` 会每次开面板重打 11 次付费生成**。点徽标就走 `POST /refresh`，
  所以只有上次探测留了 `probe-incomplete` 痕迹才重探，否则命中缓存。
- **`reprobe` 修好了本插件目录，却修不到用户真正在用的 pi-ai 条目**。补货器把模型 id
  记进 `seen` 后就不再重写，降级规格会一直留在 pi-ai 线路里、跨重启也不恢复。现在补货器
  记录自己写入时的**规格指纹**，下次发现该模型已探完且现存条目仍与指纹一致，就定向回填
  `contextWindow`/`maxTokens`/`input`/`reasoningEfforts`。三重闸门保证不误伤：目录里必须是
  已探测档案、必须有本器留下的指纹、指纹必须仍对得上（**用户手工改过就一律不碰**）。
- **补货状态首次写盘必失败**。`~/.dsh` 不存在时直接 `writeFileSync` 报错，只留一条 warn，
  于是「补过哪些模型」跨重启失忆。已补 `mkdirSync(recursive)`。

测试从 90 项扩到 **159 项离线回归全部通过**（新增 `stream-resilience` 17、`probe-integrity` 16、
`media-safety` 22、`budget-merge` 11，`catalog-feed` 5→8）。每条修复都做过 mutation 验证：
把修复改回旧写法，对应用例必须失败。测试卫生也一并收口：视频用例原先把产物写死到 `/tmp`
（实测累积 126 个残片），改为独立临时目录 + `finally` 清理。

**已知残留风险（写明不假装解决）**：预算合并是 read-merge-write，无文件锁（Node 无内置 flock），
两个进程在同一毫秒级窗口同时读到旧值仍可能丢一次增量——比旧实现「整份吞掉」已大幅收窄
（每次调用即落盘，窗口极小），彻底消除需要锁文件或单写者架构。媒体下载走代理时，本地 DNS 私网校验只是 best-effort
（`ProxyAgent` 把主机名交代理侧解析）；DNS rebinding 的 TOCTOU 窗口仍在——校验与建连是两次
独立解析。彻底封堵要把校验过的 IP 钉进连接（自定义 undici dispatcher 的 `connect.lookup`），
那会破坏代理转发与 SNI/证书校验，代价大于收益。当前把利用门槛抬到「需控制目标域名的权威 DNS
且赢两次解析竞态」，且 URL 来自上游响应而非任意网页。

v0.4.1（2026-11-17，跨境稳定性 × 观察模式合流）在 v0.4.0 的旁路观察/目录补货之上合入：
`requestTimeoutMs` 与 `retryPolicy` 两个配置旋钮（此前写死 60s + 宿主默认 5 次重试，用户无法调）、
`endpoint: auto` 的站点自动判定、动态能力探测（新模型自动带图能力与输出上限，不再一律按纯文本 65536 装配）。
**90 项离线回归全部通过**（上游 catalog-feed/observer 用例与本地跨境用例同时全绿）。
合流时发现并修掉一处交叉缺陷：观察-only（`registerProvider: false`）下聊天不经过本插件的 adapter，
站点判定门控一次都不触发，而媒体工具自己发 API 请求 —— 生图会成为第一个打到旧地域的请求并吃不可重试的
401。现在图片/视频工具在 `execute` 入口同样等待判定落地。
真实联网实测：国内站 key 打北京 `/models` 200、打新加坡 401（据此确认 key 与地域绑定）；
长思考 xhigh 首个正文 delta 41.5s 但 reasoning delta 持续下发，最大字节间隔仅 1.5s（不会误触超时）；
内置工具执行期最大静默 5.4s，由进行中事件的 heartbeat 续命。

历史验证结果（v0.3.6，2026-11-13 安全与稳定性审计）：61 项离线回归测试全部通过（含真实 SSE 服务器上的超时/取消端到端用例、内置工具进行中事件的续命回归、下载重定向逐跳校验的回环服务器用例）；本机 DSH 桌面配置可完整加载，四个 agent 预设正常。携带真实会话的 69 个工具，在千问思考模式、千问普通模式和 GLM Chat 通道均获得正常回复；另已验证函数调用及独立 `role: tool` 结果回传。多次热加载后，provider 保持单份注册，图片与视频工具各一份。未实际执行媒体生成。
