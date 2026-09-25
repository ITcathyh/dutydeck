# 同类产品调研与下一步优化（2026-09-25）

基线：Dutydeck master `ae295ac`。线上数据取自 09-25 14:15 CST 的只读快照。本文只写 09-17 至 09-23 前期对标之后的新增内容；已有结论见[团队 Tag 能力差距](team-tag-capability-gap-20260918.md)、[飞书入口调度](feishu-dispatch-optimization-20260918.md)、[完整产品追平方案](full-product-parity-plan.md)、[Botmux 评估](botmux-review-20260923.md)和[记忆对标](lark-memory-research-20260917.md)。

## 结论

Dutydeck 的功能已经和同类产品持平，验证留证、可审计的群参与判定、长期记忆、worktree 安全清理、doctor 这几项更完整。眼下最影响结果的问题都不在功能上，共三件：

1. **部署暴露。** 主服务监听内网 IP `10.37.33.49:4310`，且关闭了鉴权。从另一台内网机器无需凭据就能读到全部 79 个会话，而这个实例上挂着 full-trust 的机器人。
2. **发布节奏在丢任务。** 14 天内主服务重启 45 次、Tag 重启 38 次。主服务 15 个没完成的任务中有 12 个和重启有关。
3. **已有优势没用起来。**
   - 验证留证 0 次。
   - `/ci wait` 只支持 GitHub Actions，线上没有 GitHub token，而内部仓库在 Codebase。
   - 分层执行只跑过一小时。
   - Tag 群观察到的消息中 88% 来自机器人。

另有两点发现影响后面的做法：
- **有两项缺口比预想的便宜。**
  - Dutydeck 在用的 claude-agent-acp 0.66.0 和 codex-acp 已经支持运行中插话（扩展方法 `_session/steering`），只差 acpx 这一层透传。
  - token 和成本数据已经送到 `packages/acp-client/src/index.ts:124`，只是服务端没有存。
- **内部已有写明规则的做法可以照搬。**
  - 按触发人执行：Orchestra、Agent Fabric。
  - 审批过期与幂等：卡片续跑方案、AgentBox。
  - CI 修复的熔断：内部 CI 自动修复方案。
  - 事件投递：EventHub。

建议按三级处理，明细见第 5 节，哪些做、哪些不做见第 7 节：
- **P0，本周**：止血。处理鉴权暴露、数据库膨胀、记忆停摆、审批堵队列、重启丢任务。
- **P1，一个月内**：把发布做成用户无感；让验证、CI 这些已有能力真正用起来；开始记成本。
- **P2，之后**：运行中插话、记忆可见，以及小修、代码和文档整理。

## 1. 调研范围与证据

| 对象 | 读取内容 | 证据等级 |
|---|---|---|
| Claude Tag | 官方文档，其中 commands、how-it-works、spend-limit 三页逐字核对 | 官方文档 |
| Botmux | v3.30.0（`79e75b14`），逐个读了上次评估基线 `2716996` 之后的 43 个提交，另有 GitHub issue 158 个 | 源码、issue |
| Mew 及字节内部 agent 平台 | Mew 主文档、权限隔离、身份凭证、Automation、MR 联动、Worktree、FAQ 等 16 篇；amux、HAS、MyShadow、Team Bot、AgentDock、Togo；方舟 MA、Coze MA、TMates、Codebase MA、Ode、TAE、Tika、Uceclaw、Bits Flux、Agent Foundry、Agent Fabric、AgentBox、Cloud Agent Box、Orchestra、Neeko、Astra；另有 AAT、EventHub、CI 自动修复、卡片续跑、AxonTag、Agent Worker 等 20 多篇专题文档 | 飞书文档原文。9 篇无权限，包括 Neeko、Astra、TMates 手册、Ode 接入文档 |
| 国内 IM 与办公平台 | 飞书 aily、飞书任务智能体接口、钉钉 AI 助理与悟空、企业微信智能机器人、CodeBuddy/WorkBuddy、Qoder、Trae、Comate/DuMate、Kimi、扣子 3.0、MiniMax、Manus | 官方文档为主。钉钉「群消息感知触发」和 aily 功能手册抓不到正文 |
| 海外团队协作 agent | Devin、Linear、Factory、Charlie、Dust、Glean、Asana、Notion、Rovo、Zapier、Lindy、Adapt、Moveworks、Slack | 官方文档。Asana 帮助中心和 Moveworks 审批页只拿到搜索摘要 |
| coding agent 与编排工具 | cc-connect、OpenClaw、OpenTag、claude-threads、lark-channel-bridge、Copilot、Cursor、Codex、Warp、Conductor、Ramp Inspect、Stripe Minions、Augment Cosmos、Roomote、Kilo、Amp、Coder、Replit、Zed、Sourcegraph、AgentConnect、Multica、Compozy、Pomerium AgentOps、Gas Town、Claude Code agent teams、OpenAI Symphony、CodeRabbit、Greptile、PR-Agent、codex-plugin-cc | 源码和官方文档为主。用户抱怨来自 issue、HN 和博客转述。多数文档页没有日期，按抓取日 09-25 记 |
| ACP 协议 | 规范 v1.9.1（09-18）、v2 草案及相关 RFD 和 PR；claude-agent-acp、codex-acp、acpx 0.19.3 源码 | 源码。claude-agent-acp 0.66.0 支持插话这一点，已在开发机的依赖目录里核实 |
| Dutydeck 线上 | 两个 SQLite 库只读副本、14 天服务日志、源码接线抽查、9 月 git log | 实测 |

样本量小：主服务全量 121 个任务（08-27 起），14 天内 72 个；Tag 全量 86 个（09-20 起）。下文数字都只代表这一台开发机上的实际使用。

## 2. 线上数据说明的问题

### 2.1 使用量与构成

| 项 | 主服务（14 天） | Tag（6 天） |
|---|---|---|
| 任务数 | 72 | 86 |
| 来源 | 飞书群 58、记忆提取 7、Web 7（其中 6 个 cwd 是 `/tmp`，属测试） | 群 32、编排子步骤 16、群聊判定 12、定时 8、记忆 6、Web 5、Leader 5、回复生成 2 |
| 私聊 / CI | 0 / 0 | 0 / 0 |
| 终态 | 完成 57、失败 3、结果未确认 8、排队受阻 3、中断 1 | 完成 80、失败 1、结果未确认 5 |
| 群任务耗时中位 / p90 | 461s / 1803s | 53s / 634s |

### 2.2 未完成任务大多和重启有关

- 主服务 14 天内有 15 个任务没完成，其中 12 个和重启有关：8 个结果未确认、3 个排队受阻、1 个中断。
- 13 个结果未确认的任务里，12 个的原因码是 `PREVIOUS_RUNTIME_RESULT_UNKNOWN`。它们的结算时间都落在 09-22T16:22Z 和 09-25T03:04Z 两个重启点上。
- 重启次数：主服务 45 次，其中 09-23、09-24 各 10 次；Tag 38 次。
- 9 月以来，「跨重启恢复」相关的修复分别在 09-09、09-23、09-25 提交过。
- `dutydeck restart` 已有等待逻辑，但有两个缺口：
  - 它会等正在执行的任务结束，默认最长 900 秒（`daemon/command.ts:55`、`:139-144`）。
  - 等待期间没找到停止接收新任务的代码。
  - 查询运行状态失败时，它输出警告后照常重启（`:141`）。
- **未查清**：这 45 次重启是不是都走了这条命令。

### 2.3 挂起的审批会把会话堵几个小时

- Tag 共有 50 个审批请求。
  - 等待时长：中位 23 秒，p90 216 秒，最长 12.9 小时。
  - 3 个审批一直没人处理，排在它们后面的 3 个任务分别等了 3.0、3.4、4.3 小时，直到服务重启才放出来。
- 按标题首词归类，约 33 个审批看起来是只读操作，例如 Check、Inspect、Query、List、Read。这个比例是推断。
- 代码层面的原因：
  - 问题卡带截止时间（`lark/workflow-interactions.ts:309`），权限卡没有（`:310-313`）。
  - 权限卡只在服务重启或任务不再运行时才失效（`:458-463`）。
  - 点击本身已经按 `high_risk.execute` 策略鉴权（`:481`），并先把状态改成 `resolving` 防止重复处理（`:522`）。

### 2.4 主服务的记忆自动提取从 09-20 起停了

- 主服务最后一条记忆写于 09-20 06:40Z，之后 23 个群任务没有产生新记忆。
- 同期 7 次提取任务中：完成 3、失败 1、结果未确认 3。
- 09-23、09-24 的日志里反复出现 `MEMORY_RECOVERY_REQUIRED`（409）。
- 今天部署的共享记忆池有没有顺带修好这个问题：`unverified`。

### 2.5 手机上打不开卡片详情

- 两个服务的 `webBaseUrl` 要么为空，要么是内网 IP。14 天内相关告警共 175 条：「卡片详情手机打不开」和「审批/问答卡片没有网页出口」。
- 卡片 PATCH 遇到飞书 230020 共 17 次，其中 14 次回退成「发新卡」，集中在两个一分钟窗口里。群里可能因此出现重复卡片（推断）。

### 2.6 宣称的能力与实际使用

| 能力 | 接线情况 | 线上使用 |
|---|---|---|
| 验证命令留证 | 已实现。README 第 259 行写「任务执行完成后，系统可自动触发」，但代码里只有 API 和卡片按钮两个入口，不会自动触发（`lark/coordinator.ts:3109`） | 所有 bot 都没配 `verificationCommand`，验证记录 0 条 |
| `/ci wait` | 已实现，只支持 GitHub Actions（`session-automation.ts:41`）。只要有 automation 就显示为可用 | 两个服务都没有 GitHub token，CI 订阅 0 个 |
| 分层执行（PMO+Leader+Worker） | 已接线（`leader-delegation.ts:194`） | Tag 配了 Leader 和 Worker，但没有 `executionMode`，所以实际是单 Agent。5 个 Leader 任务都在 09-23 的一小时内 |
| 群聊按需参与 | 已接线 | 只有 Tag 开了。212 条观察消息里机器人发的 187 条（88%）；37 次判定中 25 次是防 bot 循环规则在拦截；6 天里真正服务人的发言共 5 次 |
| 持续委托与定时 | 已接线 | 5 个委托都已取消，5 个定时都已停用，最后一次运行在 09-22 |
| 多 bot 运行时 | 产品里没有，靠手工拷贝到 `.dutydeck/bot-runtimes/`，再配单独的 systemd unit | `deployments/current-deployment-path` 仍指向 09-24 那次部署 |
| `/steer` | 只把排队中的一轮提到队首（`lark/commands.ts:127`），不进入正在执行的轮次 | 未统计 |
| 用量数据 | ACP 的 `usage_update` 已转成 `status/usage` 事件（`packages/acp-client/src/index.ts:124`），服务端没有任何地方消费 | 0 条记录 |

### 2.7 开发节奏与返工集中区

- 09-01 以来共 191 个非合并提交：fix 93、feat 68。只看 09-23 到 09-25：fix 38、feat 22。
- 按提交标题关键词，fix 集中在以下主题：

  | 主题 | fix 次数 |
  |---|---:|
  | 卡片与结果投递 | 29 |
  | PTY 就绪识别 | 20 |
  | 群参与 / Tag 上下文 | 17 |
  | 建 Bot / 登录 | 14 |
  | 重启与恢复 | 13 |
  | 记忆 | 6 |

- 被 fix 改得最多的文件：

  | 文件 | fix 次数 |
  |---|---:|
  | `lark/coordinator.ts` | 25 |
  | `agent-runtime/src/index.ts` | 12 |
  | `lark/service.ts` | 12 |
  | `pty-driver/src/driver.ts` | 10 |
  | `lark/reconciler.ts` | 9 |
  | `lark/card-renderer.ts` | 9 |

- 主检出上同时挂着 20 多个 worktree。线上服务直接运行主检出的 `apps/server/dist`，所以每次合入后部署都会重启线上服务。

### 2.8 两个需要马上处理的问题

**鉴权关闭且监听内网（已复核）**

- `ss -ltnp` 显示 4310 绑在 `10.37.33.49`；`.env` 里设置了 `DUTYDECK_HOST` 和 `DUTYDECK_AUTH`。
- 我从另一台内网机器（本机 Mac）请求 `GET /api/sessions`，无需凭据返回 200，内容是 79 个会话。写接口没有测。
- 代码默认值本身是安全的：host 默认 `127.0.0.1`，鉴权默认开启（`daemon/command.ts:818-829`）。问题出在这次部署的配置。
- 内部文档「字节的 Managed Agents 平台们」收录的 AgentDock，写的正是「API 不做鉴权，默认监听 0.0.0.0，默认端口 4310」。它和本项目 AGENTS.md 的标题「Agent Dock」吻合，很可能是本项目的早期形态。也就是说，这个暴露面在内部已有公开记录。
- 另据勘察 agent 报告，两个服务启动时会把 access token 明文写进日志。这一条我没有复核。

**Tag 数据库膨胀（已复核）**

- `schedule_entity_versions` 从 09-20T05:29Z 到现在写了 404,293 行，库文件 672MB，约每秒一行。
- 原因：`schedule-executor.ts:98-108` 先给每个委托续租约，之后才检查委托状态；每次续租都在 `schedule-foundation.ts:269` 写一行版本记录，而这张表没有任何清理代码。
- 主服务库里这张表是 0 行。主库 300MB 的构成没有查。

## 3. 同类产品的做法

### 3.1 Claude Tag：前期对标之后值得注意的设计

09-18 的文档已经覆盖了何时回复、身份、定制、主动性和审计。这次核对官方文档，新增以下几点：

| 设计 | 具体做法 | 来源 |
|---|---|---|
| 固定命令集 | `!help` `!configure` `!restart` `!status` `!mute` `!unmute` `!feedback` `!routines` `!fork`。命令必须单独成句，多一个词就当普通请求处理 | [commands](https://claude.com/docs/claude-tag/users/commands) |
| 仅本人可见的状态 | `!status` 的回复只有发问人能看到，不打断工作，不算新请求；`!routines #其他频道` 同样只对本人可见 | 同上 |
| 👎 就是静音 | 有人对回复点 👎，该线程立即静音，正在写的回复也放弃，并贴一条说明怎么恢复。再次 @ 自动解除静音 | 同上 |
| 跨频道分叉 | `!fork #频道 <prompt>` 在目标频道开新线程，把原线程作为背景；两边互相贴链接。私有频道不能分叉，因为受众会变 | 同上 |
| 两层会话 | 每个线程一个会话；频道顶层另有一个频道会话。频道会话在以下情况换新：约 1 小时没有顶层消息、存活约 1 天、频道配置变了 | [how-it-works](https://claude.com/docs/claude-tag/concepts/how-it-works) |
| 配置在开线程时冻结 | 线程开始时锁定 skill、插件和频道指令；连接和域名规则按每次请求检查 | 同上 |
| 编辑和删除的语义 | 编辑消息时，agent 收到一条带新旧内容的通知，但不会触发新任务；删除回复不通知，也不从 transcript 里删掉 | 同上 |
| 结果形式 | 直接回复、文件或图表、原地更新的页面、托管网页 | 同上 |
| 花费拆成四类 | Engaged、Proactive、Scheduled、Monitoring。读频道和判断要不要回复不计费；按频道看花费、设上限；组织用量到 75% 和 95% 时提醒；「限流」和「超预算」两种情况给不同提示 | [spend-limit](https://claude.com/docs/claude-tag/admins/set-spend-limit) |
| 自报权限 | 用户可以问 `@Claude what can you access from this channel?`，它会列出本频道当前能访问什么 | how-it-works |

### 3.2 Botmux：上次评估后 43 个提交

- **值得跟进的 8 项**：
  - 后台子 agent 未回报时，本轮不能算完成（`7fab8e03`）。Dutydeck 的 PTY 驱动只要画面空闲就判定完成（`pty-driver/src/driver.ts:777`）。
  - 群内按人分开会话和 worktree（XPI lane，`3025187e`）。
  - 重启时清理会话身份相关的环境变量（`e1e6b24b`）。
  - 按文件头识别图片真实格式（`4d831a95`）。
  - Codex resume 时 `-c` 参数的位置（`8ce0866f`）。
  - 通讯录接口的瞬时错误就地重试（`f6cd001a`）。
  - 私聊 `/t` 开的话题独立绑定会话（`d085238d`）。
  - 提问卡保留 Markdown 链接（`3bee8f2a`）。
- **追平方案里漏掉的能力**：
  - 按 bot 的月预算和用量账本（08-30 就有）。
  - `/insight` 逐轮对账与回放。
  - 动态单卡模式。
  - 额度用完时自动交接给备用 bot。
  - 自包含单文件安装：替换前先试运行候选版本，有会话在跑就推迟自动更新。
- **Dutydeck 仍然领先的地方**：
  - Botmux 没有 `doctor`。
  - Botmux 自动创建的 worktree 从不回收（issue #698，仍 open）。

### 3.3 Mew

| 设计 | 具体做法 | 来源 |
|---|---|---|
| 按触发人隔离身份 | `actor_key` 由租户和 user_id 哈希得到；每人一套 HOME/XDG、lark-cli profile、bytedcli 目录和 git credential helper；wrapper 清掉 token 类环境变量；preflight 依次核身份、工具授权、资源权限；只缓存「允许」 | [Mew 权限隔离](https://bytedance.sg.larkoffice.com/docx/WCSFdBVUDoIu64xxFZvluSDYgBh) |
| 凭证在 Run 创建时冻结 | 按平台分别选触发人、设备或服务凭证。「解析不出发送者就回退成创建者」被 Mew 自己列为漏洞；Team Bot 的做法是身份校验失败就拒绝执行 | [Mew 身份凭证](https://bytedance.larkoffice.com/wiki/QI2LwIPZ9iNpO0k1XhMclo9hnFh)、[Mew FAQ](https://bytedance.larkoffice.com/wiki/FxEVwPnAoi40HUkK5HVcWs30njd) |
| 分层看门狗 | 静默 14 分钟停止；有工具在运行时放宽到 45 分钟；codex 和 traecli 1 分钟没有首条输出就告警、3 分钟杀掉 | Mew FAQ |
| 重试分类 | 分 `same_session`、`new_session`、`after_provider_recovery`、`fresh_session` 四类；可能已经产生副作用的 Run 标为 `replay_unsafe`，不自动重放 | Mew FAQ |
| 决策卡超时 | Mew：15 分钟没人答就采纳推荐项。HAS：7 分钟后释放进程，48 小时内作答仍能续跑 | Mew FAQ、[HAS](https://bytedance.larkoffice.com/wiki/J3BDw1t5riJy8ek3P2ecv8zHn1e) |
| 自动化触发 | Webhook 返回 202，用 `X-Mew-Delivery-ID` 做幂等；可订阅 Codebase、Meego、Oncall 事件并过滤；上一次没跑完时可选 Queue、Parallel、Skip；提供「最近收到的事件」「最近输出」两个排查面板 | [Mew Automation](https://bytedance.larkoffice.com/wiki/QECTwfqLSiqK4kksg1Oci7FYnwc) |
| MR 联动 | 在 Checks 上点 Fix，生成预填了 MR 上下文的任务，用户确认后执行；评论双向同步 | [Mew MR 联动](https://bytedance.larkoffice.com/wiki/F3WiwKUZkivnaikpZx5cGBgmnxc)、[Wailmer](https://bytedance.larkoffice.com/wiki/IbB8wdSyTiuFo0kPjuicYzOunne) |
| 记忆 | Mew 平台没有跨会话记忆，只靠 provider 原生记忆。HAS 在工作项结束时蒸馏记忆，分事实、决策、偏好三类，带召回审计和注入预览 | Mew FAQ、HAS |

规模参考：Botmux 内部主群 4996 人、20 个 bot；Mew 数字团队从 9 月中上线 9 个 Agent、接入 6 个群。Mew 没有公开的周活数据。

### 3.4 行业共识与用户抱怨

**已基本一致的做法**：
- 线程里 @ 发起，一个线程一个会话。
- 先用 👀 或链接确认收到。
- 自动选仓库，拿不准就问。
- 每个任务隔离运行。
- 交付以 PR 为中心，agent 不能自己合并。
- 支持定时和事件触发。
- CI 失败自动修。
- 有成本上限。
- 手机只在需要操作时推送。

**用户的主要抱怨**：
- 假完成：一篇文章核对了 101 条「tests pass」声明，35% 不实。
- 噪音：Devin 早期一个线程堆了 47 条回复。
- 永久排队、断连。
- 审批疲劳，导致开 YOLO 模式后误删。
- 通过评论注入指令，泄露凭证。
- 成本不透明。

### 3.5 按主题的具体做法

只列和 Dutydeck 现有缺口直接相关的做法。标「内部」的是字节内部产品。链接见附录。

#### 3.5.1 群参与与降噪

| 产品 | 做法 |
|---|---|
| Devin | 👀 在模型处理之前就加上；「安静」由程序直接处理，不交给模型；监听频道时维护一份待办清单，把新消息分成新问题、已跟踪问题的症状、无关三类，避免同一件事开十几个会话 |
| Glean | 判断「该回」但把握不大时，先只让提问人看到草稿，提问人点「发到线程」才公开。从不在别人的线程里主动插话。有外部成员的频道一律不主动回答。提问人既没分享也没删除时，补发一条提示，让别人可以自己请求答案 |
| Glean | bot 用固定表情标状态：⏳ 处理中、👀 有建议、✅ 已公开、⚠️ 被标为没用。频道 owner 只能关掉功能，不能打开管理员关掉的功能 |
| Adapt | 在频道里 @ 它，用一句话设定参与规则，例如「顶层消息只在被 @ 时回」。它在线程里回显生效的规则。线程规则覆盖频道规则 |
| Dust | bot 只读被 @ 的那一个线程。Dust 和其他 bot 的消息不进数据同步，避免 AI 输出被当成原始资料 |
| AxonTag（内部） | 建话题时拍一次快照，之后每轮只加一行「其他地方的新消息」摘要，上下文预算 1.5 万 token。10 分钟内不重复插话。判定失败时不发言并记日志。发送前 5 秒内有新消息，本次回复作废 |
| Agent Worker（内部） | 群上下文从每次拼最近 150 条原文，改为约 1–3KB 的结构化摘要，其余由 agent 按需用 CLI 查。改之前老群经常触发 128KiB 降级 |
| solo-agent 熵文档（内部） | 单个 agent 10 秒内发送超过 20 次返回 429；同一频道 10 秒内有 20 次由 agent 消息触发的请求，暂停 agent 触发 60 秒，人类消息不受限 |
| Manus | 一个线程同时只处理一个任务，任务归最先 @ 它的人；后加入的人要任务所有者批准 |
| Charlie | 复盘称团队共享使用少见，多数仍是一个人驱动一个 agent；该产品已宣布 10-05 关闭 |

#### 3.5.2 审批

| 产品 | 做法 |
|---|---|
| 卡片续跑方案（内部） | 回调值带 `_agent_callback{version, session_id, expires_at}`，14 天有效；按 event_id 幂等；4xx 不重试，5xx 最多重试 3 次；同一会话内串行 |
| Agent Fabric（内部） | 按钮回调带 session_id 和 wait_id，恢复到对应的等待点 |
| AgentBox（内部） | Web 和飞书是对等的确认通道，卡片过期后可以去 Web 完成 |
| OpenTag | 点击时核对 run、尝试锁和提案 hash，过期或重复点击被拒；外部调用结果不明时记为 `outcome_unknown` |
| Zapier | 审批超时后可选「跳过继续」或「结束运行」，超时时长和提醒都可配 |
| Moveworks | 执行前展示已收集的全部参数，用户可以先修改再确认 |
| Factory | 命令和工具按风险分级，只有超出当前级别才弹审批 |
| Dust | 工具分 never_ask / low / medium / high 四档。high 每次都要批，不能存成「总是允许」；「本会话全部允许」只存在内存里（09-15 新增）；未设档的远程 MCP 工具默认 high |
| AgentConnect | 审批卡私聊发给触发人，找不到时依次找会话 owner、共享名单、创建者；点击时重新校验权限，状态用 CAS 从 pending 改写 |
| Asana | 提权（改权限、加成员）和删除两类动作永远要人批准 |
| Devbox Claude/Codex（内部） | 权限确认 hook 同样没有超时，和 Dutydeck 是同一个缺口 |

#### 3.5.3 身份与凭证

| 产品 | 做法 |
|---|---|
| Orchestra（内部） | 每次调用冻结执行人，优先级 jwt > executor > environment。确认不了身份就停。Git 操作用 credential helper 现场换短期 Codebase token，不写盘，也不回落到部署者的 SSH key。token 续期：Codex/TraeX 用 PreToolUse hook，Claude Code 用 SessionStart hook。PMO 转派任务时附带原始发起人的触发证据 |
| Agent Fabric（内部） | runAs=user 时，飞书 union_id 到邮箱前缀的映射、成员校验、授权任一步失败就拒绝，不回落到 bot 身份。沙箱里只放占位凭证 |
| AAT（内部） | 默认拒绝；识别不了的用户类型按无权限处理，不用 TAT 绕过 |
| Glean | 默认按触发人的权限执行。agent identity 按「凭证 × 工具」生效，动作由 agent 账号署名，触发人单独记进审计 |
| Asana | 实际权限取 Teammate 权限和发起人权限的交集 |
| Roomote | 每个 run 记 `actingUserId`，别人追问时先切换执行人再投递 |
| OpenClaw | 排队中的消息保留原发送人的权限上限，不借用最新发送人的权限 |
| Copilot | 谁发起的 PR 谁不能批准；只有写权限用户的评论会传给 agent |
| Moveworks | 触发人还没授权某个连接器时，先请他授权再执行 |
| 扣子 3.0 | 本地 Agent 走 ACP 接入。官方提醒「多人共享个人账号、高频自动化、长期无人值守」会增加风控风险 |
| 私有群模式（内部） | 原则是「群就是边界」，内容在进入上下文之前拦截。文档承认 cron 的结果可能泄漏到公开群 |

#### 3.5.4 响应、发布、恢复与插话

| 产品 | 做法 |
|---|---|
| Linear | 收到事件后 10 秒内要发第一条 activity，30 分钟没有 activity 标为 stale |
| AgentConnect | durable inbox 在重启后重放消息，并给 prompt 附一段说明：「上次尝试可能中途停了，先检查再重复任何外部副作用」。`turnStallTimeoutMs` 看门狗。收到 SIGTERM 先排空，受 `shutdownDrainMs` 约束 |
| Multica | 重启后回收没干净结束的 run，标 `runtime_recovery`，最多重试 2 次；二进制更新时如果在忙，推迟到任务结束 |
| Amp | runner 只在没有线程处于轮次中时重启。消息默认插话，在当前一步结束后送入；⌘Enter 改为排到整轮之后 |
| Coder | worker 每 9 秒写一次心跳，30 秒过期，新进程接管心跳过期的会话。AgentAPI 每 25ms 截屏一次，屏幕连续 2 秒不变才写入用户消息 |
| lark-agent-bridge（内部） | `/update` 只接受 fast-forward；构建成功才重启，失败回滚；话题归属在重启后保留 |
| Agent Fabric、AgentBox、熵文档（内部） | 会话或每次运行绑定启动时的版本；执行持有租约，并记录「还欠着没做的动作」 |
| TAE（内部） | Chat Agent 滚动升级会丢掉内存里的会话；Task Agent 的老实例继续跑旧版本，直到 TTL 到期 |
| OpenClaw 团队 agent（内部） | 反例：开发机重启杀掉了正在跑的 agent，状态卡住，只能手工修 |
| 企业微信 | 每个机器人同一时刻只允许一条连接；新连接订阅成功后旧连接才被断开，官方建议用主备切换做高可用 |
| Roomote | `POST /api/tasks/:taskId/steer_message`，每条消息记 `send` 或 `steer`；agent 原生支持就注入，否则中止后重放 |
| Gas Town | `gt nudge` 默认等 agent 空闲再投递 |

#### 3.5.5 验证、CI 与事件

| 产品 | 做法 |
|---|---|
| Claude Routines | 文档明说「运行显示绿色不等于任务成功」；事件 payload 包在标签里，标成不可信数据 |
| Gas Town | `gt done` 要求工作区干净且至少有 1 个 commit。源码注释写明报错信息故意不提绕过参数，因为 LLM 会读报错后自行绕过 |
| Claude Code agent teams | `TaskCompleted` hook 返回 exit 2 就拒绝完成，并把 stderr 回灌给模型 |
| codex-plugin-cc | 反例（issue #248）：验证基础设施出错时也返回 block，结果无限重唤醒 |
| Kilo | Code Review 从 PR 的 base 分支读 `REVIEW.md`，被审的改动改不了审它的规则 |
| CodeRabbit | `review_skipped` 不能当成代码干净；读 Jenkins 结果时只认与 PR head commit 匹配的构建 |
| PR-Agent / Qodo | 跨轮次记录每条问题的关闭和重开；每条问题必须以 Fixed、Skipped（附理由）或 Reported 结束 |
| Greptile | Model Inversion（实验）：识别作者用的模型，换另一家的模型来审 |
| Stripe Minions | CI 最多跑两轮 |
| Ramp Inspect | 核心指标是「会话最终产出合并的 PR」 |
| AgentBox Review CI（内部） | 钉住 MR 版本；结果是 Stale 或 Pending 都算失败；agent 不 approve、不绕过、不合入 |
| CI 自动修复方案（内部，开发中） | 动手前和 push 前各校验一次 expected_head_sha；最多 3 轮；同一个错误指纹出现 2 次就停；每轮最多改 10 个文件、300 行；CI 日志当作不可信输入；不合入、不 approve、不 force push |
| LBP CR（内部） | 把服务账号加进 review 规则，用 Approvals required 设为 1 或 2 决定 AI 的结论能否单独放行 |
| EventHub（内部） | 有 2.4k+ 公共事件和 35k+ 业务事件，包括 Codebase Push/MR/Comment、Argos、cron。已能投递到 Botmux 开发机 agent，目前 300+ 订阅；接入走带 token 校验的 webhook，Codebase 侧要手工加 webhook |
| Agent Fabric DMA（内部） | webhook 校验签名和时间戳，按 event-id 去重；可选每个事件新开会话，或按 key 归到同一会话 |
| Agent Worker（内部） | cron 包装成一条 @ 消息处理，复用普通消息链路 |
| Augment Cosmos | `subscribe-event` 让运行中的会话订阅事件，匹配的事件回投到同一个会话 |
| 飞书任务 | 事件 `task.task.update_user_access_v2` 含负责人变更（`task_assignees_update`），可以替代 Dutydeck 现在的定时轮询（`lark/coordinator.ts:1008`）。指派给 bot 的任务会不会触发这个事件：`unverified` |
| Uceclaw（内部） | 7–8 月 AI 提交的 MR 合入耗时中位 40 小时，人工提交 1.8 小时 |

#### 3.5.6 成本与记忆

| 产品 | 做法 |
|---|---|
| 方舟 MA（内部） | 事件流 `span.model_request_end` 逐请求带 input/output/cache token |
| AgentConnect | 每个会话存一份 `StoredUsage` |
| OpenAI Symphony | token 取累计总量，与上次值求差，防止重复计数 |
| Rovo | 组织共享额度，可按用户查看，可按事件导出 CSV；用到 80% 和 100% 时通知管理员；达到上限后暂停计费功能 |
| Compozy | 预算写成 `{tokens, wall_clock_sec, on_exceeded: halt\|escalate}`，派发前检查 |
| Kilo、Augment、Coder | 按人设每日上限；相对基线的突增告警；每次请求前检查已花费 |
| 内部平台现状 | 多数只做到按人按天统计，或还停留在规划 |
| Asana | 每条记忆挂在某个项目、任务或文档上，检索时只返回发起人能看到来源的记忆。执行视图列出本次用到和新建的记忆，用户可以删除 |
| Copilot | 记忆带代码引用，使用前对照当前分支验证，28 天没用到就删 |
| 飞书 aily | 记忆按每个用户、每个群各存一份；群里的对话不调用私聊内容；每次发布留变更记录，可回滚 |
| Lindy | 可编辑的 memory.md 里可以写「不要记住什么」；后台按频道和文档的可见性，把内容分流到团队记忆或个人记忆 |
| AgentBox ContentGuard（内部） | 写入记忆前扫描注入、外泄和凭证 |

### 3.6 ACP 协议层现状

规范基线 v1.9.1（09-18）。这一节决定插话、重启接回和成本三项的做法。

| 能力 | 规范层 | 适配器 / acpx 层 | Dutydeck 现状 |
|---|---|---|---|
| 运行中插话 | v1 没有。`session/inject` 仍在 PR #1261（RFD）和 #2043（schema，放在 unstable 下），都未合并 | claude-agent-acp（至少从 0.64.0 起）和 codex-acp 都实现了扩展方法 `_session/steering`，在 initialize 响应的 `_meta.steering.supported` 里声明。claude-agent-acp 返回 `injected`、`startedNewTurn` 或 `promptRequired`；有待处理的权限卡时改为排到后面。acpx 到 0.19.3 都没有透传 | 用的是 acpx 0.13.0 和 claude-agent-acp 0.66.0，已在开发机依赖目录里确认含 `_session/steering`。仓库已经在维护 `patches/acpx@0.13.0.patch` |
| 重启后接回正在执行的轮次 | 没有。resume/load 恢复的是会话上下文，agent 进程一死这一轮就没了 | acpx 0.17.0 的 `createSharedAcpRuntime()` 由独立后台进程持有 agent 连接，客户端重启后用 `watchSession({cursor})` 接回；后台进程也没了时返回 `WATCH_OUTCOME_UNKNOWN`。代价：这种模式拒绝插话、拒绝逐轮权限回调 | agent 是服务的子进程，服务一重启这一轮就断。unit 配的是 `KillMode=process`，后台持有进程不会被连带杀掉（推断，需实测） |
| 用量 | `usage_update` 于 06-05 稳定：`used`/`size` 必填，`cost` 可选。每轮 token 明细 `PromptResponse.usage` 仍是草案 | claude-agent-acp 报 `cost`（美元）和每轮 usage；codex-acp 不报成本，usage 是本轮增量 | 已转成 `status/usage`（`packages/acp-client/src/index.ts:124`），服务端没有消费 |

插话的实际效果因 agent 而异（第三方，PR #2043 评论）：Codex 几乎立即生效；Claude Code 要等到下一个安全边界才并入。

### 3.7 已关停或改名

Roo Code Cloud 于 05-15 关停，由 Roomote 接替；Continue 被 Cursor 收购后停更；Coder Tasks 从 v2.36 起移除；AgentAPI 于 09-13 标为 deprecated；Augment Remote Agents 改名 Cosmos；Sweep 转成 JetBrains 插件；Charlie 宣布 10-05 关闭。

## 4. Dutydeck 的位置

| 维度 | Dutydeck | Claude Tag | Botmux | Mew | 结论 |
|---|---|---|---|---|---|
| 执行位置 | 本机 | 云沙箱，每线程一个 | 本机 tmux | 本机 daemon 或云沙箱 | 本地优先仍是合理定位。Cursor My Machines、Devin Outposts、扣子 3.0 本地 Agent 也在做「推理或调度在云、执行在用户机器」 |
| 身份 | 部署者身份，状态里显式声明（`coordinator.ts:265`） | 服务账号，按频道授权 | 可选按触发人（v3.20 起） | 按触发人和平台选择凭证 | **落后**。内部 Orchestra、Agent Fabric 都按每次调用冻结触发人，失败即拒绝 |
| 群聊按需参与 | 只读判定、预算、可审计、可回放 | 读整段对话，四选一动作 | ambient 模式让路 | 无 | **领先**，但缺真人使用数据，也缺 Glean、AxonTag 那类降噪规则 |
| 表情控制 | 入站表情不处理（`listener.ts:269-273`） | 👎 即静音 | 只用作输出 | 无 | **落后** |
| 记忆 | 索引常驻、后台提取与整理、群共享池 | 频道记忆、工作区共享 | 依赖 CLI 自带记忆 | 平台没有 | **领先**，但主服务提取已停 |
| 审批 | 飞书卡片按钮，点击有鉴权和防重；权限卡无超时 | 没有逐次审批卡 | 授权卡，owner 批准后重放原消息 | 确认卡 15 分钟自动采纳推荐项 | 缺超时和风险分级 |
| 验证 | 服务端真实执行并记录指纹 | 无独立验证 | 无 | 无 | **领先**，但使用 0 次 |
| CI 续作 | 只支持 GitHub Actions | 订阅 GitHub PR | 无 | Codebase MR Checks→Fix | 内部场景**落后** |
| 事件触发 | 只有代码级扩展接口 | routine：定时、监听、PR | Webhook、API | Webhook、事件订阅、重叠策略、排查面板 | 缺用户可配入口 |
| 成本 | 只有次数预算；用量数据已到 acp-client 但没存 | 四类花费、频道上限、提醒 | 月预算、账本、洞察 | Insights（Labs） | **落后**，补齐成本低 |
| 发布与升级 | 从主检出直接运行，14 天重启 45 次 | 托管服务 | 单文件、试运行候选版本、有会话时顺延 | daemon npm 包 | **落后** |

## 5. 优化建议

分级口径：
- **P0**：本周处理。正在造成安全风险、数据损坏或用户可见损失的问题。
- **P1**：一个月内。发布无感，以及已有能力没用起来的问题。
- **P2**：P1 之后。功能缺口和代码、文档整理。

「参考」后面是依据的产品，细节见第 3 节。

### P0：本周

| 问题 | 预期方案 | 影响范围 | 收益 |
|---|---|---|---|
| **P0-1 主服务内网无鉴权**：4310 监听 `10.37.33.49` 且鉴权关闭，从另一台机器无凭据读到 79 个会话 | 1. 完整 dashboard 和除分享页外的全部接口必须先输密码（只存哈希）；CLI 和本机调用继续用 Bearer token<br>2. 飞书卡片的详情链接打开一个独立的单会话详情页：免密码、只读，靠服务端签名的链接限定到这一个会话，看不到其他会话，也进不了完整 dashboard<br>3. host 不是回环地址且没有鉴权时拒绝启动，除非显式传带 `unsafe` 字样的参数；doctor 把这种组合标红<br>4. 启动日志不再打印 token | 鉴权模块、Web 登录页与分享页、卡片链接、线上 `.env`、启动日志 | 内网其他人不能再读会话、驱动 full-trust agent；群里其他人点详情仍能看到单个会话；以后同样的误配置在启动时就被拦下 |
| **P0-2 Tag 数据库膨胀**：`schedule_entity_versions` 5 天写了 40 万行，库文件 672MB | 1. 执行器先查委托状态，已取消或停用的委托不再续租<br>2. 续租不写实体版本记录<br>3. 给这张表加保留策略；上线后按 `dutydeck restart` 停服，执行一次 `VACUUM` | `schedule-executor.ts`、`schedule-foundation.ts`；Tag 线上库 | 每天约 100MB（估算）的增长停止，库文件变小 |
| **P0-3 主服务记忆提取停了 5 天没人发现**：09-20 后 23 个群任务没有新记忆，日志反复出现 `MEMORY_RECOVERY_REQUIRED` | 1. 核对 `ae295ac` 部署后这个错误是否消失，没消失就修<br>2. `/memory` 和 doctor 显示最后一次成功提取的时间，连续多轮没有提取时标黄 | 记忆提取流水线、`/memory`、doctor | 记忆恢复写入；以后停摆能被看到 |
| **P0-4 没人处理的审批一直堵住队列**：3 个审批让后面的任务排了 3.0–4.3 小时，直到服务重启；权限卡没有截止时间（`lark/workflow-interactions.ts:310-313`） | 1. 权限卡和问题卡一样带截止时间：到时先提醒，再超时按策略拒绝，卡片改为「已过期」并在话题里说明（参考 Mew、HAS、Zapier）<br>2. 按钮回调按 event_id 去重（参考卡片续跑方案、Agent Fabric）<br>3. 挂起期间，后面排队的任务显示「被审批阻塞」和取消按钮<br>4. 群机器人默认 `approve-reads`，只读操作不再弹审批（参考 Factory、Dust） | `lark/workflow-interactions.ts`、任务队列、卡片 | 不再出现一个任务排几个小时的情况；约 2/3 的审批（按标题推断为只读）不再打扰人 |
| **P0-5 重启时任务丢失**：14 天主服务重启 45 次，15 个未完成任务中 12 个和重启有关；`dutydeck restart` 等待期间仍接新任务，查询失败时照常重启（`daemon/command.ts:139-144`） | 1. 查清 45 次重启的来源：`dutydeck restart`、`--force`、直接 `systemctl`，还是崩溃后自动拉起<br>2. 等待期间停止接新轮次，新消息留在 inbox，重启后再处理（参考 AgentConnect、Amp）<br>3. 查询运行状态失败时不重启，要求显式 `--force`<br>4. Tag 运行时的重启同样走这条路径 | `daemon/command.ts`、inbox、Tag 的 systemd unit | 直接减少「结果未确认」和「排队受阻」；改动小 |
| **P0-6 范围增长快于使用量**（不做，见第 7 节）：TS 文件一个月从 158 个到 737 个，同期主服务 121 个任务；9 月 fix 93 次、feat 68 次 | 冻结追平方案的外围范围：ASR/TTS、会议消费者、桌面托盘、远端设备、跨部署联邦、插件市场，以及 28 个执行器逐个验收，都改为「有需求证据再做」。执行器只保留 Claude Code、Codex、CCFlash/TraeX 三个的完整能力矩阵（见第 7 节） | 追平方案、开发排期 | 开发时间集中到本表列出的、用户已经碰到的问题上 |

### P1：一个月内

| 问题 | 预期方案 | 影响范围 | 收益 |
|---|---|---|---|
| **P1-1 合入 master 就等于上线**：线上服务直接运行主检出的 `dist`；多 bot 运行时靠手工拷贝，部署指针已过期 | 1. 线上改为运行不可变的发布目录。把 Tag 现有的 `bot-runtimes` 拷贝方式产品化成 `dutydeck deploy`：build → 拷贝到带版本号的目录 → 用目标 node 试加载 → 排空 → 切换 → 健康检查 → 失败回滚（参考 Botmux、lark-agent-bridge）<br>2. 每天 1–2 个部署窗口，先部署 Tag，观察几小时后再部署主服务 | 部署流程、多 bot 运行时、并行 agent 的协作约定 | 别的 agent 合入不再触发线上重启；多 bot 运行时不再手工维护；坏版本自动回滚 |
| **P1-2 被中断的任务只留下「结果未确认」**：12 个任务的原因码是 `PREVIOUS_RUNTIME_RESULT_UNKNOWN`，要用户自己判断 | 1. 被切断的轮次从 inbox 重投，prompt 附一段说明：会话恢复成功写「从停下处继续」，恢复失败写「之前的动作可能已经生效，先检查再重复任何外部副作用」（参考 AgentConnect）<br>2. 结果不确定的标「未知」，不标失败；自动重投最多 2 次（参考 Multica）<br>3. 可能已产生外部副作用的轮次标 `replay_unsafe`，交给人决定（参考 Mew） | inbox、投递账本、`lark/task-recovery.ts` | 用户不用自己判断任务做完没有，也不用手动重发 |
| **P1-3 手机打不开卡片详情**：`webBaseUrl` 为空或是内网 IP，14 天相关告警 175 条（随 P0-1 一起做） | 审批、问答、失败原因和结果摘要都在卡片里完成；详情链接改为 P0-1 的单会话详情页；`setup` 问清手机能否访问 Web，不能就不显示「查看详情」 | 卡片渲染、`setup` | 手机上能完成全部操作，也不必为手机访问放开鉴权 |
| **P1-4 验证留证一次没用过**：所有 bot 都没配 `verificationCommand`；README 第 259 行说会自动触发，代码只有按钮和 API 入口（`lark/coordinator.ts:3109`） | 1. 工作区第一次任务时，从 `package.json`、`Makefile`、`go.mod` 推断验证命令，用户一键确认<br>2. 本轮改了代码就自动验证；失败回灌成一轮返修，最多 2 轮<br>3. 验证工具本身出错记为失败、不回灌，避免无限重试（codex-plugin-cc #248 的反例）；「跳过」不算通过（参考 CodeRabbit）<br>4. 验证命令以 base 分支上的配置为准，被测改动改不了（参考 Kilo）<br>5. 结果卡分开显示「运行完成」和「验证通过」，改代码后没重新验证的标「验证已过期」；修正 README 的描述 | 验证模块、结果卡、README | 同类产品都没有的证据链真正用起来，直接回应「假完成」这类抱怨 |
| **P1-5 CI 续作对内部仓库没用**：只支持 GitHub Actions（`session-automation.ts:41`），线上没有 GitHub token，CI 订阅 0 个 | 1. 没配置时 `/ci` 显示「未配置」和配置方法，不再显示为可用<br>2. 新增校验签名或 token、按 event-id 去重的 webhook 入口；事件转成普通任务回投到原会话，执行人取事件里的操作人。事件源优先接 EventHub 的 Codebase MR 和流水线事件（参考 EventHub、Agent Fabric、Augment）<br>3. 修复规则照内部 CI 自动修复方案：动手前和 push 前各核对一次 head SHA；最多 3 轮；同一错误出现 2 次即停；每轮最多 10 个文件、300 行；CI 日志当不可信输入；不合入、不 approve、不 force push<br>4. 失败卡上加「交给 Agent 修」（参考 Mew） | `session-automation.ts`、新增 webhook 入口、inbox、卡片 | 内部用户能用上 CI 闭环；不会对着过期代码修改，也不会在同一个错误上无限重试。EventHub 和 Codebase webhook 的接入细节 `unverified` |
| **P1-6 花了多少钱看不到**：只有次数预算；用量事件已在 `packages/acp-client/src/index.ts:124` 产生，服务端没存 | 1. 先存下来并展示，按 bot、群、触发人和来源汇总。来源分四类：显式请求、主动介入、定时、后台判定与提取<br>2. 口径：token 取累计值，与上次求差防重复（参考 Symphony）；codex-acp 不报成本、usage 是本轮增量，按单价估算并标为估算；PTY 类 CLI 标为「无数据」<br>3. 再加每个 bot、每个群的月上限，到 75% 和 95% 提醒；超限只拒绝新任务，不打断在跑的（参考 Claude Tag、Rovo） | `acp-client` 之后的服务端存储、Web 控制台、派发前检查 | 多人共用一份订阅时能看清谁花了多少；第一步不需要新数据源 |
| **P1-7 Tag 群里多是机器人在说话**（暂缓，见第 7 节）：212 条观察消息 88% 来自 bot；37 次判定中 25 次在拦 bot 循环；6 天真正服务人 5 次 | 1. 先加规则：不在别人的话题里主动插话；有外部成员的群不主动发言；发送前 5 秒内有新消息就作废本次回复；10 分钟内不重复插话（参考 Glean、AxonTag）<br>2. 群主可以用一句话写参与规则，作为判定器输入，bot 回显生效的规则（参考 Adapt）<br>3. 选 1–2 个真实团队群试点：先 observe 一周，再 selective 一周。按[通用群协作方案](team-tag-foundation-plan.md)的验收场景统计误介入、漏记录和 👍/👎 比例；同时打开分层执行，和单 Agent 对比耗时、token 和验收结果 | `lark/readonly-decider.ts`、`group-participation.ts`、试点群 | 少打扰人；拿到真人数据后再决定 Tag 投入多少 |
| **P1-8 取舍没有数据依据**（不做，见第 7 节） | Web 首页放周指标：真人发起的任务数、无人工干预完成率、结果未确认率、审批等待中位数、首次回应时延、主动发言的 👍/👎 比例、有验证证据的完成比例（参考 Ramp 以「最终合并 PR」为核心指标） | Web 控制台、统计查询 | 本表各项改完有没有效果可以量出来 |

### P2：P1 之后

| 问题 | 预期方案 | 影响范围 | 收益 |
|---|---|---|---|
| **P2-1 所有人都借用部署者的身份**（不做，见第 7 节）：状态里显式声明（`coordinator.ts:265`）；Mew 和 Botmux 群里身份类问题排第一（09-18 统计为 71 条和 22 条） | 1. 入队时冻结触发人，每轮在 prompt 顶部注入当前 actor；记录谁触发、谁批准、以谁的身份执行（参考 Orchestra、Glean）<br>2. git 用 credential helper 按触发人现换短期 Codebase token，不写盘；`lark-cli`、`bytedcli` 按人隔离凭据目录，wrapper 清理敏感环境变量，冻结 PATH（参考 Orchestra、Mew）<br>3. 身份确认不了就拒绝并在卡片里说明，不回退为部署者身份；触发人没授权时先发授权卡（参考 Agent Fabric、AAT、Moveworks）<br>4. 群共享记忆按触发人能看到的范围过滤（参考 Asana） | 入队、执行环境、git 凭据、审批、记忆检索。需要先写设计文档，并用真实 `AcpxAdapter` 做回归测试 | 群里别人 @ bot 时不再以部署者的权限做事；每个操作都能追到具体的人 |
| **P2-2 表情不能控制 bot，群里查状态会刷屏**（不做，见第 7 节）：入站表情登记为 no-op（`listener.ts:269-273`） | 1. 👎 静音该话题，并放弃还没发出的回复；👀 在模型处理之前就加上（参考 Claude Tag、Devin）<br>2. bot 的状态表情固定一套：处理中、有建议、已公开、被标为没用（参考 Glean）<br>3. `/status`、`/tasks` 和把握不大的回复草稿，改用飞书「仅特定人可见」卡片（`/open-apis/ephemeral/v1/send`），触发人点「发到群里」才公开（参考 Claude Tag、Glean）。该接口能否用于话题内：`unverified` | `listener.ts`、`reaction-records.ts`、卡片发送 | 一个表情就能让 bot 停下；查状态不打扰群里其他人 |
| **P2-3 不能在任务运行中插话**：`/steer` 只把排队中的消息提前（`lark/commands.ts:127`） | 1. 在 `patches/acpx@0.13.0.patch` 里加扩展请求透传，对声明了 `_meta.steering.supported` 的 agent 调用 `_session/steering`<br>2. 投递账本记下返回的 `injected`、`startedNewTurn` 或 `promptRequired`<br>3. 发消息时可选插话、排队或打断；排队的消息可改为立即插话，或删除（参考 Amp、Replit、Roomote）<br>4. 不支持插话的 agent 保持排队；PTY 类 CLI 只在屏幕稳定 2 秒后写入（参考 Coder AgentAPI） | acpx patch、`packages/acp-client`、`/steer`、投递账本。用真实 `AcpxAdapter` 做回归测试 | 长任务跑偏时不用打断重来。Claude Code 在下一个安全边界并入，Codex 几乎立即生效；有待处理的权限卡时 Claude 会把插话排到后面 |
| **P2-4 用错的记忆发现不了**：在 `memory-view.ts` 和 `card-renderer.ts` 里没搜到按任务展示已用记忆的字段（`unverified`） | 结果卡或 Web 任务页列出本次用到和新写入的记忆，每条可一键删除（参考 Asana）；群里可配置「不许记」规则（参考 Lindy）；bot 自己的输出不作记忆来源，写入共享池前扫描注入指令和凭证（参考 Dust、AgentBox） | 记忆流水线、`lark/memory-view.ts`、结果卡 | 群共享池里的错误记忆能被发现和删掉 |
| **P2-5 若干已知小问题** | 1. Botmux 的修复（见 3.2；XPI `3025187e` 是 1.8 万行的新功能，不在此列），优先做「后台子 agent 未回报时不算完成」。Dutydeck 现在画面空闲就判完成（`pty-driver/src/driver.ts:777`）<br>2. 飞书任务认领从轮询改为订阅 `task.task.update_user_access_v2`；先验证指派给 bot 时会不会触发，不触发就保留轮询 | PTY 驱动、飞书入口、`lark/task-agent.ts` | 减少误判完成；去掉定时轮询 |
| **P2-6 `coordinator.ts` 反复返工**：4387 行，9 月被 fix 25 次；卡片与结果投递被 fix 29 次 | 按入站唤醒、任务派发、卡片生命周期、恢复对账拆成四块；卡片渲染用真实飞书 payload 做快照测试 | `lark/coordinator.ts`、卡片测试 | 改一处不再牵动整个文件，卡片类回归能在测试里发现 |
| **P2-7 文档状态不清**：`docs/` 下已有 45 份 Markdown 文档，部分已被后续实现覆盖，例如团队 Tag 差距一文的第 1 节 | 新建 `docs/README.md`，给每份标注状态：现行、已落地或历史 | `docs/` | 人和 agent 不再照着过时方案做 |

## 6. 暂不做或不建议做

- **不做托管云沙箱。** 本地优先是定位，外部头部产品也在做「执行在客户机器」。
- **暂不把 ACP 连接移到服务进程外。**
  - acpx 0.17 的 shared runtime 能在重启后接回正在执行的轮次，但这种模式拒绝插话和逐轮权限回调，和 P0-4、P2-3 冲突。
  - 升级 acpx 还要重新验证现有 patch。
  - 先做 P0-5 和 P1-2；等 acpx 在 shared runtime 里支持扩展请求透传后再评估。
- **不在 Tag 群里放多个 bot 自由对话。** Botmux 09-15 的 P0 事故和 Mew 的双 bot 循环都说明这条路风险高；Dutydeck 线上 25 次判定都花在拦截 bot 循环上。
- **不追 Botmux 全部 32 个执行器**，也不照搬它的 22 个 Dashboard 页面。
- **不在平台里造排班或升级引擎**，沿用 09-18 的结论。
- **有前提再做**：
  - Leader 验收的问题跨轮次保存，每条以 Fixed、Skipped 或 Reported 收口（参考 PR-Agent），可选换一家模型来审（参考 Greptile）。前提是 P1-7 试点证明分层执行有人用。
  - AI 审查结论能否放行，交给仓库的审批规则决定（参考 LBP CR）。前提是 P1-5 的 CI 接入跑通。

## 7. 决策记录（2026-09-25）

| 条目 | 决定 |
|---|---|
| P0-1 | 改为密码方案：完整 dashboard 必须输密码；飞书卡片的详情链接打开独立的单会话详情页，免密码、只读。P1-3 里和卡片链接相关的部分一起做 |
| P0-6 | 不做，不在本项目的关注范围 |
| P1-7 | 暂缓。Tag 还在测试，没有正式用起来，现有数据不代表真实使用 |
| P1-8 | 不做 |
| P2-1 | 不做。沿用部署者身份执行，部署者的权限最足 |
| P2-2 | 不做 |
| P2-5 | Botmux 的 XPI（`3025187e`）是 1.8 万行的新功能，不属于小修，不做；其余修复和飞书任务事件照做 |
| 其余各项 | 全部实现；Codex review 和端到端验收通过后合入并部署 |

## 附录：来源

**Dutydeck**
- 源码：master `ae295ac`，正文已标 `文件:行号`。
- 线上数据：`.dutydeck/dutydeck.db` 和 `.dutydeck/bot-runtimes/cli_aa25f2398c789bb5/dutydeck.db` 的只读副本；主服务日志 `.dutydeck/daemon/dutydeck.log`；Tag 日志来自 journal。时间窗为 2026-09-11T06:15Z 到 09-25T06:15Z。

**Claude Tag**
- [commands](https://claude.com/docs/claude-tag/users/commands)
- [how-it-works](https://claude.com/docs/claude-tag/concepts/how-it-works)
- [spend-limit](https://claude.com/docs/claude-tag/admins/set-spend-limit)
- [when-claude-responds](https://claude.com/docs/claude-tag/users/when-claude-responds)
- [memory](https://claude.com/docs/claude-tag/users/memory)

**Botmux**
- [GitHub](https://github.com/deepcoldy/botmux)，HEAD `79e75b14`（v3.30.0）。
- [Botmux 主文档](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg)
- [交流群问题汇总](https://bytedance.larkoffice.com/docx/GauddM4RsoWp4expKa3cxAj8nAe)

**Mew**
- [主文档](https://bytedance.larkoffice.com/wiki/YXL4wupehiDyzUkGnBWcXJ9inFb)
- [权限隔离](https://bytedance.sg.larkoffice.com/docx/WCSFdBVUDoIu64xxFZvluSDYgBh)
- [身份凭证](https://bytedance.larkoffice.com/wiki/QI2LwIPZ9iNpO0k1XhMclo9hnFh)
- [Automation](https://bytedance.larkoffice.com/wiki/QECTwfqLSiqK4kksg1Oci7FYnwc)
- [MR 联动](https://bytedance.larkoffice.com/wiki/F3WiwKUZkivnaikpZx5cGBgmnxc)
- [Worktree](https://bytedance.larkoffice.com/wiki/Momuwv2G7iVPuGkKqOZcS3eun8d)
- [FAQ](https://bytedance.larkoffice.com/wiki/FxEVwPnAoi40HUkK5HVcWs30njd)

**字节内部其他产品**
- [amux](https://bytedance.larkoffice.com/wiki/JCNtw1oWuiCdtckYdUIcmX2onDc)
- [HAS](https://bytedance.larkoffice.com/wiki/J3BDw1t5riJy8ek3P2ecv8zHn1e)
- [Team Bot 开发机指南](https://bytedance.larkoffice.com/docx/H2TwdRg22oUYiLxpgZHcxHMGnDg)
- [字节的 Managed Agents 平台们](https://bytedance.larkoffice.com/docx/Hnl3dG6xEoWR2DxpkLNcz3GQnub)
- [Wailmer](https://bytedance.larkoffice.com/wiki/IbB8wdSyTiuFo0kPjuicYzOunne)
- Orchestra：[主文档](https://bytedance.larkoffice.com/wiki/HBfQwkjtyiX4cYkZErQcP9xvnne)、[Orchestra 在飞书](https://bytedance.larkoffice.com/wiki/MiOVwLCSIiQ4Lck17wMcRu0AnRc)
- Agent Fabric：[主文档](https://bytedance.larkoffice.com/docx/IjPRdFCsloLAnTxkPAamsHrQyzg)、[开发者指南](https://bytedance.larkoffice.com/docx/PzjSdS8JNopEC0xyn6Dmdigiyye)、[DMA](https://bytedance.larkoffice.com/docx/RFwRdtRzGop8y6xpBhVm6fFyyXf)
- AgentBox：[用户文档](https://bytedance.larkoffice.com/wiki/RJccw8lXiiVjJSk23o6cEsEynod)、[Review CI](https://bytedance.larkoffice.com/wiki/XsLawOlVeinBRHkCcDSct8Ignxf)、[智能工作流](https://bytedance.larkoffice.com/wiki/HzS2weZ2yipY9Lk8cvGcGS3cnT6)
- [卡片续跑方案](https://bytedance.larkoffice.com/docx/EhandSTiOo6yHtxjFk1cWPjFnFh)
- EventHub：[主文档](https://bytedance.larkoffice.com/wiki/OJ08w4LkTiXx5ekdn7pcQHkNnoe)、[Botmux 接入](https://bytedance.larkoffice.com/wiki/Nvnmw5Nfqi8Mb8kQXzSc57eVnOe)、[Codebase 接入](https://bytedance.larkoffice.com/wiki/FEvowjAToihXUVkfoFOcN4OrnJg)
- [CI 自动修复方案](https://bytedance.larkoffice.com/docx/Ja3zdfGtVoIh3SxU8ZYcudHSn4g)
- [LBP CR](https://bytedance.larkoffice.com/wiki/VEadwOkSfiko0ckNuUKcY6C5n4c)
- [AxonTag](https://bytedance.larkoffice.com/docx/LETDd8v6ioOfcUx3O8CcGjqjnOd)
- [Agent Worker](https://bytedance.larkoffice.com/wiki/XvrWw2wCIiRjt4kMaPOceyQVn2c)
- [solo-agent 熵文档](https://bytedance.larkoffice.com/docx/N4hBd3oJ7ovtyfx617hcTefAn5f)
- [lark-agent-bridge](https://bytedance.larkoffice.com/docx/VFfidF48jooI8hxs5LKcRdY3nVc)
- [AAT](https://bytedance.larkoffice.com/docx/N1F2dLylDoiAM2xb2MncqCqNn6b)
- [私有群模式](https://bytedance.larkoffice.com/wiki/LvPKwdzcZicxLvkExFjce98Tnqf)
- [方舟 Managed Agents 手册](https://bytedance.larkoffice.com/docx/CczcdrpoIowAgLxIWQyc482hn49)
- [TAE 选型指南](https://bytedance.larkoffice.com/docx/JO4IdvqKjoyizRxAK4Al8CSbg8d)
- [Uceclaw 效果报告](https://bytedance.larkoffice.com/docx/OnBkdSsxdo0Z65xlDdGcEzJznWc)
- [OpenClaw 团队 agent](https://bytedance.larkoffice.com/wiki/PIdJwmwhmiu9NikZRjncCiVFnIc)
- [Devbox Claude/Codex](https://bytedance.larkoffice.com/wiki/Tj5mwNWODiIGpTkmqDHcWu6Nn4K)
- 无权限未读：Neeko 主文档、Astra、TMates 用户手册与 OpenAPI 指南、Ode 接入文档、AxonTag「Agent 在群里怎么协调说话」。

**国内 IM 与办公平台**
- [aily 自定义智能体升级](https://www.feishu.cn/content/article/7631864469689240764)
- [钉钉 AI 助理发消息](https://open-dingtalk.github.io/developerpedia/docs/develop/agent/send-message/)、[悟空隐私与安全](https://wukong.dingtalk.com/docs/quick-start/privacy-and-security/)
- [企业微信智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)
- [WorkBuddy 助理](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Assistant)
- [Qoder 任务管理](https://docs.qoder.cn/user-guide/quest/task-management)
- [扣子本地 Agent](https://docs.coze.cn/cozespace_local_agent)
- [Manus Slack](https://help.manus.im/en/articles/14431752-chatting-with-manus-agent-on-slack-channels-dms-and-file-delivery)

**海外团队协作 agent**
- [Devin Slack 礼仪](https://devin.ai/blog/devins-slack-etiquette)
- [Linear Agent Interaction](https://linear.app/developers/agent-interaction)
- [Factory](https://docs.factory.ai/)
- [Charlie 复盘](https://charlielabs.ai/blog/charlie-2025-a-recap-and-whats-next/)
- Glean：[Agent identity](https://docs.glean.com/administration/agent-identity/overview)、[Publishing to Slack](https://docs.glean.com/agents/concepts/publish-slack)、[Configure bot responses](https://docs.glean.com/administration/platform/embedded-integrations/slackbot/admin-guide/configure-bot-responses)
- Dust：[Slack 排障](https://docs.dust.tt/docs/slack-troubleshooting)、[PR #32154](https://github.com/dust-tt/dust/pull/32154)、[Webhooks](https://docs.dust.tt/docs/webhooks)
- [Adapt Proactive agent mode](https://adapt.com/changelog/proactive-agent-slack)
- [Lindy 集成与护栏](https://docs.lindy.ai/integrations/overview)
- Asana：[Agentic AI 安全](https://asana.com/inside-asana/how-asana-thinks-about-agentic-ai-security)、[记忆机制](https://asana.com/inside-asana/ai-teammates-turn-work-into-reusable-information)
- [Notion Custom Agents](https://www.notion.com/help/custom-agents)
- Rovo：[额度](https://support.atlassian.com/rovo/docs/rovo-usage-limits/)、[自动化中的 Jira Coding Agent](https://support.atlassian.com/rovo/docs/work-with-rovo-dev-in-automations/)
- [Zapier 审批步骤](https://help.zapier.com/hc/en-us/articles/38731463206029-Request-approval-to-keep-your-workflow-running-with-Human-in-the-Loop)
- [Moveworks Activities](https://docs.moveworks.com/agent-studio/conversation-process/activities)
- [Slack Developing agents](https://docs.slack.dev/ai/developing-agents/)

**coding agent 与编排工具**
- [OpenTag](https://github.com/amplifthq/opentag)
- [OpenClaw 队列](https://docs.openclaw.ai/concepts/queue.md)
- [claude-threads](https://github.com/anneschuth/claude-threads)
- [cc-connect](https://github.com/chenhg5/cc-connect)
- [Copilot 风险与缓解](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations)
- [Cursor Slack](https://cursor.com/docs/integrations/slack)
- [Claude Routines](https://code.claude.com/docs/en/routines)
- [Ramp Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent)
- [Stripe Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)
- [AgentConnect](https://github.com/agentconnect-md/agentconnect)
- [Multica](https://github.com/multica-ai/multica)
- [Compozy](https://github.com/compozy/compozy)
- [Roomote](https://github.com/RooCodeInc/Roomote)
- [Coder](https://github.com/coder/coder)、[AgentAPI](https://github.com/coder/agentapi)
- [Amp streaming JSON](https://ampcode.com/docs/cli/streaming-json)
- [Gas Town](https://github.com/steveyegge/gastown)
- [OpenAI Symphony](https://github.com/openai/symphony)
- [codex-plugin-cc](https://github.com/openai/codex-plugin-cc)（issue #248）
- [PR-Agent](https://github.com/qodo-ai/pr-agent)
- [Kilo 文档](https://kilo.ai/docs)
- [Augment Cosmos](https://docs.augmentcode.com/cosmos)
- [CodeRabbit](https://docs.coderabbit.ai)
- [Greptile](https://greptile.com/docs)

**ACP**
- [ACP 规范仓库](https://github.com/agentclientprotocol/agent-client-protocol)：PR [#1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261)、[#2043](https://github.com/agentclientprotocol/agent-client-protocol/pull/2043)
- [v2 prompt RFD](https://agentclientprotocol.com/rfds/v2/prompt)
- [会话用量更新](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates)
- [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts)
- [codex-acp](https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexAcpServer.ts)
- [acpx shared sessions](https://github.com/openclaw/acpx/blob/main/docs/shared-sessions.md)

**用户抱怨**
- [.NET 团队 Copilot 十个月复盘](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/)
- [101 条 tests pass 声明核查](https://dev.to/vinzenz_eiberger/i-checked-101-tests-pass-claims-from-my-ai-coding-agents-35-werent-true-h6n)
- [评论注入攻击](https://www.securityweek.com/claude-code-gemini-cli-github-copilot-agents-vulnerable-to-prompt-injection-via-comments/)
- [审批疲劳](https://grith.ai/blog/permission-fatigue-security-failure)

**飞书接口**
- [发送仅特定人可见的消息卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/send-message-cards-that-are-only-visible-to-certain-people?lang=zh-CN)
- 飞书任务事件 `task.task.update_user_access_v2`：schema 来自 lark-cli 1.0.78 导出。
