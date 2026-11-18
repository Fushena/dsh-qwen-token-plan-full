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

在插件目录执行 `npm test`（159 项：compat + relogin + stream + tier-retry + route-guard + model-display + catalog-feed + observer + capability-probe + config-knobs + stream-resilience + probe-integrity + media-safety + budget-merge，含媒体下载 SSRF/重定向、流内错误分类、探测完整性、跨实例预算合并回归）。runner 逐文件串行执行（Windows 上唯一全绿的组合，见 `test/run.mjs` 注释）。另有 `test/client-smoke.mjs` 单独跑（面板渲染桩，不在 runner 内）。
`test/config-knobs.test.js` 钉死两个跨境旋钮与站点自动判定：默认值与最坏墙钟、非法值拒绝、
`providerRetryPolicy` 真的把策略交给宿主、真实 HTTP 服务器上卡死的流在**配置的**阈值处报 TIMEOUT、
国际站 key 自动切新加坡、断网不失活、换站点后媒体工具与目录一起跟随、
**首个模型请求必须等判定落地**（401 不在可重试码里，漏一轮就是整轮失败）、
**观察-only 时生图也要等判定**（聊天不经过 adapter，门控够不着媒体工具）。

**`test/stream.test.js` 必须用真实 HTTP 服务器而不是假流**：超时靠 abort 请求信号生效，真实 undici 收到 abort 会取消 body 并让读取抛错；手写假流不响应 abort，只能测出「定时器到点」，测不出「读取是否真的被中止」。它钉死三条语义：慢但持续的流必须完整读完（超时是**空闲超时**不是总时长，否则长回答会被掐断）、卡死的流要在阈值附近报 TIMEOUT、用户取消要立刻报 ABORTED。

测试使用本机已安装的 DeepSeek Harness 内置运行时与真实 `dsh-llm` 类，不访问网络、不读取个人凭据。其他安装路径可通过 `DSH_TEST_NODE` 和 `DSH_TEST_RUNTIME` 指定。

真实联网验证需单独进行；正常测试不会运行图片或视频生成。

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
