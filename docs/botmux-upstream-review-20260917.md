# Botmux 近期改动吸收与验证

已将富文本附件、过期卡片收敛、Claude 配置优先级和自动化总览刷新融入 Dutydeck。

| 改动 | 行为 |
|---|---|
| 富文本顶层附件解析 | `message-content` 增加顶层 `files[]` 解析并复用下载与去重，支持本地化键与 `content_v2`，纯附件保留材料标记并过滤畸形节点。 |
| 过期卡片收敛与 CAS 保护 | `card-renderer` 与 `reconciler` 将 `230031` 归入永久不可更新并持久化 `progress_frozen`，终态发送独立结果并保留暂时错误重试。 |
| PTY Claude 配置优先级 | `driver` 传入显式 `agent.env`，由 `claude-settings` 按 key 覆盖用户/generated `settings.env`，采用 `0700` 私有目录与 `0600` 私有文件，不复制全量 `process.env`。 |
| 自动化总览前台轮询 | `AutomationOverview` 针对当前页 8 项每 10 秒前台刷新，遇错停止并可手动重试，切页、进入详情或卸载时清理轮询。 |

卡片映射写回采用数据库原子条件更新（`compareAndSetExtra`），CAS 冲突时继续轮询，避免旧异步请求覆盖新轮次卡片。

最终 build 与 typecheck 已通过；完整 E2E 现已 6/6 通过，运行环境为真实 Chromium、真实服务与真实 SQLite，CLI 执行与飞书传输使用模拟实现。真实 Claude 2.1.274 CLI 在隔离 `HOME`、`--bare` 参数与本地 HTTP 拒绝 stub 下，验证三种模式（`ask-user-settings`、`ask-env-only`、`full-trust-user-settings`）均向 agent 端点发起请求；该测试不涉及真实 provider 推理调用，不能推广为所有用户文件加载路径实测。两项 P2 生产与真实 SQLite 探针已关闭，独立终审已完成，无未解决的实质问题；原有断言未弱化。

最终集成全量 Vitest 279 个文件，276 通过、3 失败；4376 个用例，4361 通过、8 失败、7 跳过。8 项失败为 service 恢复/停止 3 项与 work-items 取消 5 项，与未改基线一致；第 3 个失败套件 physical-native 因缺 acpx/runtime 无法加载。本轮适配的 custom-command 用例通过，未观察到新增失败；基线出现的 1 次 ACP lifecycle 50ms 超时在最终本轮运行未出现。定向测试覆盖 Lark 与原子存储 52 文件 1075 用例通过、PTY 整包 12 文件 222 用例通过。
全量运行命令：
```bash
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_MODEL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN ./node_modules/.bin/vitest run --maxWorkers=8
```
证据已保存至 `artifacts/upstream-20260917/tests-final.log` 与 `artifacts/e2e/run-2026-09-17T15-46-00-674Z-299538/html/index.html`（此类 artifacts 仅作为本地验证产物，不提交 Git）。

共享 cwd 锁及跨身份实验暂不引入；未执行部署、重启或真实飞书写入。

---

## 调研阶段基线分析与上游取舍（修复前快照）

> **说明**：以下内容为实施前的基线调研报告快照（分析日期 2026-09-17，基于 Dutydeck 源码基线 `2173d2e` 与已 rebase 的 Botmux `ba847cae5d190e6c87a3c57452074921be3d1c58`）。当时 Dutydeck 业务代码尚未修改，记录了当时通过离线探针确认的缺口分析与上游 28 个提交的取舍依据，供历史追溯参考。

### 1. 调研期初始建议与优先级评估（历史快照）

本轮最值得融入 Dutydeck 的是**富文本附件识别、过期卡片停止重试、Claude 配置优先级**。另外，自动化总览存在外部状态刷新缺口。共享目录并发保护适合按使用场景补充，不能直接引入全局目录锁。

分析日期：2026-09-17。Dutydeck 源码基线为 `2173d2e`；Botmux 已执行 `git fetch origin`、`git rebase origin/master`，从 `ad184ae3` 更新到 `ba847cae5d190e6c87a3c57452074921be3d1c58`。本地原先没有独有提交，本次无冲突，更新后 HEAD 与刚拉取的 origin/master 相同。差异为 28 个提交、231 个文件，提交日期覆盖 9 月 14—17 日。两边原有未跟踪文件均保留。

本次交付是源码更新与分析；Dutydeck 业务代码未修改，没有部署或重启服务。以下判断依据双方当前实现、定向测试和离线功能探针，不把旧追平方案中的状态视为当前状态。

| 顺序 | 建议 | 用户收益 | 证据等级 |
|---|---|---|---|
| 1 | 补充富文本顶层 `files[]` 解析 | 话题中上传的附件能够进入任务材料 | 真实解析器 + 上游形状 fixture 已复现遗漏 |
| 2 | 将卡片过期错误归入永久不可更新，并持久收敛 | 历史过程卡不再反复请求更新，独立结果保留 | 真实对账函数 + fake transport/store 已复现重复 PATCH |
| 3 | 将显式 Claude Agent 环境配置合入私有 settings | 配置自定义网关或模型时，减少被用户设置覆盖的风险 | 实际配置生成已验证；真实 Claude 最终采用值 unverified |
| 4 | 为自动化总览补外部变化刷新 | 从飞书或其他页面修改计划后，总览及时显示新状态 | DOM 对照探针已复现 |
| 按需 | 为共享目录协作补冲突提示或组内串行 | 多个会话操作同一目录时，减少修改交叉 | Runtime + SQLite + mock driver 已确认可并发；未复现文件冲突 |

### 2. 核心缺口技术分析与探针结果（历史快照）

**附件识别可以直接做小范围补丁。** 上游 [b769f2c9 / #1386](https://github.com/deepcoldy/botmux/commit/b769f2c9) 在正文节点之外扫描富文本顶层 `files`，复用原有去重与下载链路。Dutydeck 的 [message-content.ts](../apps/server/src/lark/message-content.ts) 当前只遍历正文节点；[coordinator.ts](../apps/server/src/lark/coordinator.ts) 从这个结果接收附件，没有补扫顶层数组。

离线输入 `{content: [[{tag: 'at', user_name: 'agent'}]], files: [{file_key: 'file_v3_top_level', file_name: 'brief.md'}]}`，当前结果为 `text='@agent'`、`resources=[]`。本地化 `zh_cn` 正文的同类输入也为空。建议复用现有 `addResource`，同时覆盖内联与顶层同 key 去重、仅附件无正文、本地化正文。只含附件时还需保留可读材料标记，避免被当成空消息。这里使用上游回归样本的结构，未采集真实飞书事件或验证实际客户端下载。

**过期卡片应沿现有交付状态收敛。** 上游 [fc356179 / #1440](https://github.com/deepcoldy/botmux/commit/fc356179) 将 `230031` 作为更新期限已过处理，清理时核对当前卡 ID，防止迟到请求误伤新卡。Dutydeck [card-renderer.ts](../apps/server/src/lark/card-renderer.ts) 的 `isLarkMessageUnupdatable` 只识别 `230012/230030`；[service.ts](../apps/server/src/lark/service.ts) 能保留 `upstreamCode`，因此缺口位于分类和后续状态处理。

对已完成且已有独立结果消息的过程卡，连续调用两次真实 [performLarkCardReconcile](../apps/server/src/lark/reconciler.ts)，对照结果为：

| 模拟错误码 | PATCH 次数 | 保存映射次数 | 两轮未解决数量 | 最终冻结 |
|---|---:|---:|---|---|
| 230030 | 1 | 1 | 0、0 | 是 |
| 230031 | 2 | 0 | 1、1 | 否 |

建议补入 `230031`，保留结果消息并持久标记过程卡不可继续更新。这里的问题是业务对账再次发起请求；[api-gate.ts](../apps/server/src/lark/api-gate.ts) 对普通 4xx 已不会在单次调用内重试。还要处理运行中心跳：当前协调器只在终态设置 `progressFrozen`，单改错误码列表不能证明所有重试都已消除。验收应覆盖终态对账、运行中永久拒绝、旧卡失败不冻结新卡。平台真实错误响应和长时间运行现场仍为 unverified，不在报告中断言具体天数期限。

**Claude 配置应明确优先级，复用已有私有文件机制。** 上游 [551dc3f4 / #1407](https://github.com/deepcoldy/botmux/commit/551dc3f4) 将 Bot 显式环境配置写入进程级 `--settings`，处理用户 settings 覆盖进程环境的问题。Dutydeck [claude-family.ts](../packages/cli-adapters/src/adapters/claude-family.ts) 生成权限与 hook 设置，[ClaudeSettings](../packages/pty-driver/src/claude-settings.ts) 已能合并用户 settings，并以私有目录和 `0600` 文件保存。

用真实适配器与合并器测试：Agent 环境指向 `agent.invalid`，用户 `--settings.env` 指向 `user.invalid`；在 `ask` 与 `full-trust` 下，生成 settings 都仍保留 `user.invalid`，未提升 Agent 环境。由此确认配置生成缺口；真实 Claude 进程最终如何取值未在本轮启动验证，不能宣称已发生错误网关路由。

建议约定“本任务显式 Agent 配置覆盖用户默认值”，按 key 合并 `env`，保留无冲突用户值、原有权限及 hooks；不要复制整个宿主环境。现有 helper 只在用户与生成参数都含 `--settings` 时写私有合并文件，因此新增仅有 Agent env 的路径也要接入私有文件，避免敏感值进入命令行参数，并覆盖退出/恢复清理。修复应首先限定已证实的 PTY Claude 路径。若扩展到 ACPX，需要另外遵守 session 持久化键的 `snake_case` 约束，并使用真实 `AcpxAdapter` 回归测试。

**自动化总览应借鉴跨入口一致性用例。** 上游 [11105348 / #1352](https://github.com/deepcoldy/botmux/commit/11105348) 修复的是文件监听、业务缓存与已发布快照混用，造成 SSE 变更丢失。Dutydeck 没有这条相同故障链：详情 [SessionAutomationPanel](../apps/web/src/components/SessionAutomationPanel.tsx) 修改后失效缓存，并每 10 秒查询；总览 [AutomationOverview](../apps/web/src/components/AutomationOverview.tsx) 共享查询键，但没有周期刷新。

DOM 探针打开组件后改变 fake API 返回值，保持前台且不切换窗口，等待 11 秒：总览 API 调用数为 `1 → 1`，仍显示停用；详情为 `1 → 2`，已显示启用。证据只说明持续打开时没有主动刷新；重新挂载、窗口聚焦等查询触发仍可能刷新。建议为可见总览页复用有界轮询或事件失效，并保留当前每页 8 个任务的查询范围。无需移植上游文件 watcher。

**共享目录保护属于策略补充。** 上游 [2c326f35 / #1389](https://github.com/deepcoldy/botmux/commit/2c326f35) 保护跨身份分流组的工作目录接力；[xpi-shared-cwd-admission.ts](../../botmux/src/core/xpi-shared-cwd-admission.ts) 对没有组 ID 的会话返回 `unmanaged`，并非全局目录锁。Dutydeck [Runtime](../packages/agent-runtime/src/index.ts) 的资源检查与 [任务领取事务](../packages/storage/src/task-execution.ts) 主要以 Session 为范围。

隔离临时目录中，真实 Runtime、SQLite 和 mock driver 创建两个使用同一 shared cwd 的会话，在任一任务结束前，两者都已调用 `send`。这确认并发可发生，不证明并发一定错误。[Web 新建](../apps/web/src/components/NewSessionModal.tsx) 默认 worktree；Runtime API 省略模式时默认 shared。若要支持同目录受控接力，可增加冲突提示或显式协作组内串行，并验证等待可见、失败释放及重启恢复。不要强制所有同目录只读任务串行，也不要把本机锁宣传为能约束外部 CLI。

### 3. 上游提交核对与取舍（历史快照）

以下近期功能已有对应能力，或需要新的产品需求，暂不整块引入：

| 上游改动 | Dutydeck 核对与取舍 |
|---|---|
| 群默认模型 `c8344ab5` | 已有群 model/reasoning 配置及新会话注入；现有测试覆盖旧上下文保留、新话题使用新配置。复用现有存储。 |
| 动态单卡问答 `6abe4e7d` | 已有结构化选择、自由输入和问题卡。上游 unified 为 opt-in；单卡会改变当前过程卡、问题卡、独立结果的交付方式，收益需另做体验判断。 |
| 反馈身份 `71ddb711` | 当前回调已校验发送人、卡片、任务和轮次；缺身份拒绝。没有依据新建一套上游技能反馈制度。 |
| 群标签页 `a7894b4c` | 可把工作台固定到群内，但需补 API、权限与管理入口。属于可选小功能，低于已复现修复。 |
| 建群模式/群名 `4856fbc5`、`b215ec70`；可信免 @ `e87d5c4d` | 当前以已有群绑定及正式群策略为主。若没有建群服务需求，无需引入额外签名与信任来源。 |
| 派发回执话题 ID `ba847cae` | Dutydeck 已有原生话题读取和跳转；上游是 dispatch 命令附加 best-effort 查询。未来需要发送后立即取链接时可借鉴，不等于当前任务路由缺失。 |
| Bun WebSocket 代理 `a1efad0e` | Dutydeck 当前使用 Node，未验证相同故障；Node 代理环境是否完整可用仍为 unverified。 |
| 只读受限续跑 `81fb2232` | 上游限定 TraeX、显式开关及 RPC 能力检查。不能直接当作通用自动重试；应与现有 WorkItem、任务和自动化状态整合后另立范围。 |
| Codex 空闲升级 `e964808c` | 会引入运行版本切换、恢复与回滚边界。本轮缺乏自动升级需求证据，优先保持任务执行配置可解释。 |
| Codex/ZMX 启动 `f45c6e2d` | 当前已具备提交前就绪检查与当前 viewport 捕获；吸收回归场景，不据提交标题判定相同 bug。 |
| 跨身份分流 `34621ff4`、`dc7b4e63` | 上游后续已收进默认关闭的实验开关。身份选择、会话隔离与共享目录接力耦合，不拆一半直接接入。 |
| TraeX fork/backend `5dc5bee9`、`74c303d9`、`d40c0a28` | 新能力和供应商特定边界，需结合 Dutydeck 的原生上下文/恢复契约验证；不视为可直接 cherry-pick。 |
| Herdr、单文件 worker IPC、Cloud Agent 环境、工作台外壳 `701f55f5`、`88f1603d`、`fed664e4`、`7e5c6822` | 上游特有运行或界面路径，未确认本项目有同类故障，不优先移植。 |
| setup 重新扫码 `d7d38532`、send 帮助 `89a62b64` | Dutydeck 已有强制重新登录及明确续跑入口；开放平台请求中途失效仍可补结构化诊断，但尚未复现同一菜单死循环。帮助修复也需本项目对应入口复现后再定。 |

### 4. 调研期定向测试与基线验证记录（历史快照）

本轮实际验证均为本地隔离测试，没有真实飞书写入或供应商推理调用：

- Dutydeck 飞书：`message-content`、`workflow-interactions`、`group-management`、`listener`，4 个文件、160 项通过。
- Dutydeck 自动化与 setup：`session-automation-routes`、`setup/lark-bind`、`SessionAutomationPanel.dom`、`AutomationOverview.dom`，4 个文件、37 项通过。
- Dutydeck 执行器与身份：`claude-settings`、`cli-adapters/adapters`、`group-runtime.integration`，3 个文件、95 项通过。
- Botmux 飞书：`message-parser`、`recall-frozen-cards`、`chat-tabs`、`skill-feedback-callback`、`dispatch-thread-id`、`group-default-models`、`signed-chat-defaults`，7 个文件、330 项通过。
- Botmux 计划同步与 setup：`schedule-store-dashboard-sync`、`schedule-store-dashboard-watch`、`cli-setup-existing-app-session-expired`，3 个文件、21 项通过；包括真实文件监听到聚合状态收敛测试。
- Botmux 启动与接力：`codex-startup-gate-screen-resync`、`xpi-shared-cwd-admission`、`worker-ipc-preload`，3 个文件、52 项通过。
- 额外探针覆盖附件遗漏、过期卡重试、Claude settings 生成、shared cwd 并发，以及总览/详情两个 DOM 对照用例。DOM 临时测试运行后已从仓库删除。

上述既有定向测试合计 695 项通过，另有 2 项 DOM 对照探针。独立只读复核已核对主要结论、推荐边界和 Git 差异数量，相关措辞修正已采纳，无未解决的实质反证。未运行全量构建、全量 E2E，也未证明真实平台与所有 CLI 组合兼容。现有测试通过与新输入暴露缺口可以同时成立。
