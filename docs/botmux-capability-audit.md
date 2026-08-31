# Botmux 全能力审计与 Dockmux 能力保全清单

> 审计日期：2026-08-30  
> Botmux 基线：`06db2b4837b7ad88490d107c59aa4ed8b14d42d3`  
> Dockmux 对照基线：`27532041babfe3c322542ddbb1e6951d039a1806`

## 1. 目的与边界

本文回答两个问题：

1. Botmux 在 Agent 接入、飞书路由、群协作、会话、终端、自动化、安全和运维方面，已经形成了哪些真实用户能力；
2. Dockmux 替代 Botmux 时，哪些能力必须保留，哪些应该按 Dockmux 的 Task/Run 架构重塑，哪些应推迟或明确放弃。

审计基于本机 Botmux 与 Dockmux 仓库的代码、测试和文档，只读完成。本文不记录任何 App Secret、访问令牌、Cookie、用户标识或其他凭据值。

证据路径约定：

- `B:` 表示 `/data00/home/huangyuhang.edu/ai/botmux/`；
- `D:` 表示 `/data00/home/huangyuhang.edu/ai/dockmux/`。

覆盖度：

- `已覆盖`：Dockmux 已提供同等或更强的用户结果；
- `部分覆盖`：已有底层能力，但缺少策略层、配置入口或完整交互闭环；
- `未覆盖`：当前没有对应产品能力。

处置含义：

- `retain`：保留 Dockmux 当前实现，并把它作为替换时的回归契约；
- `reshape`：能力价值明确，但应按 Dockmux 的 Task/Run、统一 runtime 和最小权限架构重做；
- `defer`：有价值但不是当前替换的必要条件，等核心模型稳定后再做；
- `drop`：不应继承，通常因为安全风险、架构负担或与 Dockmux 产品方向冲突。

“核心优势”判断的是该能力是否构成 Botmux 用户选择、持续使用或依赖它的主要原因，而不是代码量大小。

## 2. 总结结论

Botmux 最值得继承的不是庞大的配置项集合，而是它已经把以下关系显式建模：

```text
Agent runtime
    ↓ default
Chat-visible Bot identity
    ↓ per-chat override
Group × Bot binding
    ↓ immutable effective snapshot
Session / Turn
```

其中最强的产品契约是：

1. 用户能知道“哪个 Bot 在哪个群、用哪个 Agent、在哪个目录工作”；
2. 群成员的“能发起对话”与“能控制进程或他人任务”是两种权限；
3. 普通群、话题群、私聊有稳定且可解释的会话边界；
4. CLI 进程和上下文可跨 daemon 重启恢复；
5. 多 Bot 协作依赖显式交接，不靠隐形广播；
6. 高风险能力、可写终端、文件系统和凭据之间存在明确边界。

Dockmux 已在 Task 队列与数据库状态恢复、语义事件、权限姿态、附件输入、飞书最小权限配置、Agent 适配器覆盖面方面达到或超过 Botmux。这里的“状态恢复”不等于 PTY CLI 进程跨 daemon 存活：虽然 `packages/session-backends` 已有 tmux/zellij/zmx 实现，生产装配 `D:apps/server/src/service.ts` 创建 `PtyCliDriver` 时没有注入 backend，driver 会在 `D:packages/pty-driver/src/driver.ts` 默认使用 `PtyBackend`。因此 PTY CLI 的 backing process continuity 仍是 P0 缺口。替换工作的重点不是复制全部外围功能，而是补齐 `GroupBinding`、动作权限分级、配置生效预览、Agent/群运营视图和生产持久 backend 接线。

## 3. 推荐的 Dockmux 配置分层

### 3.1 AgentDefinition

描述机器上可运行的 Agent，而不是某个聊天机器人身份：

- `id`、展示名、协议、命令与参数；
- runtime/发行来源、版本、可用性与 readiness；
- 模型、推理强度和权限姿态默认值；
- pause/resume、structured events、terminal 等真实能力；
- Agent 级 system prompt 或引用的角色模板。

现有基础：`D:packages/config/src/index.ts`、`D:packages/cli-adapters/src/factory.ts`、`D:packages/shared/src/index.ts`。

不可丢契约：协议身份、实际二进制来源和版本必须可区分；运行所需二进制不存在时应明确不可用，不能静默换成另一个 Agent。

### 3.2 ChannelBot

描述一个飞书可见身份及其默认行为：

- 飞书 App 身份和服务端 `credential_ref`；
- 默认 Agent、工作区、模型、推理强度、角色；
- 私聊/普通群回复模式和默认 mention policy；
- 群协作工具的读、发消息能力；
- 访问策略、高危策略、卡片展示策略；
- listener 状态、健康度和最近错误。

现有基础：`D:apps/server/src/lark/config.ts`、`D:apps/web/src/components/LarkConfigModal.tsx`。

不可丢契约：凭据只在服务端使用，不能进入公开配置、Agent prompt、ACPX 持久化 session 或日志。

### 3.3 GroupBinding

以 `bot_id × chat_id` 为主键保存群级覆盖：

- 实时入群状态和本地配置状态；
- Agent、工作区、模型、推理强度、RoleProfile 覆盖；
- reply mode、mention policy；
- `can_talk`、`can_dispatch`、`can_operate`、`can_admin` 策略；
- 群工具读取和发送策略；
- 最后验证时间、失效原因和生效配置摘要。

不可丢契约：飞书群成员关系是事实来源，本地策略是覆盖层。删除群绑定不能伪造退群成功，Bot 被移出群也不能继续显示为“配置正常”。

### 3.4 RoleProfile

保存可复用的职责与交互风格：

- persona/system prompt；
- 一行能力说明和适用场景；
- 可选的默认 Agent/模型建议；
- 版本与变更记录。

不可丢契约：RoleProfile 是行为配置，不是安全边界。任何“private role”或提示词约束都不能代替 ACL、sandbox 或工具权限。

### 3.5 RunSnapshot

在 Run 创建时固化最终生效的执行配置：

```text
Run 显式覆盖
  > GroupBinding
  > ChannelBot 默认
  > AgentDefinition 默认
  > 进程默认
```

至少固化 Agent、协议、runtime 来源、工作区、模型、推理强度、权限姿态、角色版本、群策略版本和来源 Channel。

不可丢契约：进行中的 Run 不因后台修改 Bot 默认值而切换 Agent、工作目录、后端或权限姿态；新配置只影响后续 Run，除非用户执行一个可审计的显式迁移。

ACPX 的 `session_options` 会递归校验持久化键名。写入其中的所有键必须使用 `snake_case`；群工具运行时变量使用 `dockmux_group_tools_url` 和 `dockmux_group_tools_token`。大写环境变量只能在读取边界兼容，不能写入 ACPX 持久化 session。

## 4. 能力地图

### 4.1 Agent 适配器与配置入口

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| 多 CLI 适配器 | `B:src/adapters/cli/registry.ts`；`B:docs-site/docs/zh/adapters.md` | 用户可使用既有 coding CLI 和账号体系 | 选择的 Agent 必须对应真实运行进程，能力不可虚报 | 已覆盖：ACPX discovery + PTY adapter，见 `D:packages/config/src/index.ts`、`D:packages/cli-adapters/src/factory.ts` | 支撑 | retain |
| 协议与 runtime/发行来源分离 | `B:src/bot-registry.ts`；`B:docs-site/docs/zh/bots-json.md` | 同一协议可运行官方 CLI、fork、wrapper 或网关 | UI 必须显示实际 runtime、命令来源、版本；Session 内冻结 | 部分覆盖 | 核心 | reshape |
| 自动探测 CLI 与版本 | `B:src/adapters/cli/registry.ts` | 减少手工配置，快速发现缺失依赖 | 探测失败显示原因，不静默降级 | 已覆盖，见 `D:packages/config/src/index.ts` | 支撑 | retain |
| Bot Defaults 分区设置 | `B:src/dashboard/web/bot-defaults-page.tsx` | 把 Agent、Session、安全、卡片和高级设置分开 | 默认值与群覆盖后的最终值必须可预览 | 部分覆盖：Lark Config 有入口，Agent 仍偏环境变量 | 核心 | reshape |
| 每 Bot runtime/env/startup command | `B:src/bot-registry.ts` | 支持多账号、代理和特定启动准备 | Secret 不公开；启动命令必须有来源和风险提示 | 部分覆盖；legacy Lark env/startup command 已禁止注入 | 支撑 | reshape：放到 AgentDefinition/credential boundary，不回填 Bot catch-all |

### 4.2 飞书接入、Bot 身份与消息路由

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| QR/manual 飞书 Setup | `B:docs-site/docs/zh/quickstart.md`；`B:src/cli.ts`；`B:src/setup/open-platform-automation.ts` | 非平台专家也能完成应用、权限、事件和发版 | 增量配置、回读验证；已有可见范围无法确认时停止 | 已覆盖且权限范围更聚焦，见 `D:README.md`、`D:apps/server/src/lark/open-platform-configurator.ts` | 核心 | retain Dockmux 实现 |
| 多飞书 Bot | `B:src/bot-registry.ts`；`B:docs-site/docs/zh/architecture.md` | 同一机器承载多个不同身份和职责 | 每个 App 独立身份；一个 App 的 `open_id` 不能复制到另一个 App 当 owner | 已覆盖：多 listener | 核心 | retain |
| P2P chat/thread 路由 | `B:docs-site/docs/zh/session-model.md`；`B:src/im/lark/event-dispatcher.ts` | 用户可选择长期私聊上下文或每线程独立 | 相同路由键必须稳定命中同一 Session；重复事件不得重复执行 | 已覆盖，见 `D:apps/server/src/lark/session-resolver.ts` | 核心 | retain |
| 普通群四种回复模式 | `B:src/bot-registry.ts`；`B:src/im/lark/event-dispatcher.ts` | 兼顾共享群上下文和独立话题 | root、thread、topic 的边界必须可解释；模式变更不能串历史上下文 | 已覆盖主要模式 | 核心 | retain，并显式展示有效默认值 |
| 话题群每话题独立 Session | `B:docs-site/docs/zh/session-model.md` | 多任务在一个群中互不污染 | 同一 topic 连续、不同 topic 隔离 | 已覆盖 | 核心 | retain |
| mention policy | `B:src/bot-registry.ts` 的 `regularGroupMentionMode`；`B:src/im/lark/event-dispatcher.ts` | 让专用 Agent 群更自然，同时不打扰普通群 | 默认需 @；`ambient` 在有人明确 @ 其他 Bot 时让路；`never` 必须显式开启 | 部分覆盖：群默认需 @，无群级策略 | 核心 | reshape |
| 单人单 Bot 群免 @ | `B:src/im/lark/event-dispatcher.ts` | 将专用群用作个人工作台 | 仅在成员拓扑可确定为 1 human + 1 bot 时生效 | 未覆盖 | 支撑 | defer |
| 进群/新话题自动开工 | `B:src/bot-registry.ts`；`B:src/im/lark/event-dispatcher.ts` | 主动欢迎或执行固定任务 | 默认关闭；必须验证 owner 在群内并防止重复触发 | 未覆盖 | 外围 | defer |

说明：Botmux 的注释、文档和实际 loader 默认值存在过漂移；审计时源码表现为 P2P 默认 `chat`，普通群实际默认趋向 `chat-topic`。Dockmux 不应复制隐式默认，而应在配置页和 Run 详情中展示 materialized effective value。

### 4.3 群配置与多 Agent 协作

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| `chat × bot` 群矩阵 | `B:src/services/groups-store.ts`；`B:src/core/dashboard-ipc-server.ts`；`B:src/dashboard/web/groups-page.tsx` | 一眼看出 Bot 是否入群、是否绑定目录/角色、是否监听 | 远端群状态与本地配置分别展示；部分失败不能伪装成全部成功 | 未覆盖 | 核心 | reshape，P0 |
| 创建群、邀请 Bot、转移群主 | `B:src/services/groups-store.ts`；`B:src/dashboard/web/groups-page.tsx` | 不离开控制台即可完成协作空间搭建 | 展示执行 Bot、邀请结果和 ownership 变更；转移群主需明确确认 | 未覆盖 | 支撑 | defer；先做只读矩阵和加入/移除 |
| 每群工作目录/oncall 绑定 | `B:src/bot-registry.ts`；`B:src/services/groups-store.ts` | 同一 Bot 在不同项目群落到正确仓库 | 路径必须在允许 workspace 内；群 A 配置不得泄漏到群 B | 未覆盖 | 核心 | reshape 为 GroupBinding |
| 多 Bot 显式 @ 交接 | `B:docs-site/docs/zh/multi-bot.mdx`；`B:src/cli/send-dispatch.ts` | Agent 可分工而不造成消息风暴 | Bot-to-Bot 必须显式寻址、可追踪发起者、阻止自回环 | 部分覆盖：group tools 已有 scoped capability，见 `D:apps/server/src/lark/agent-tools.ts` | 核心 | retain/reshape |
| 群成员、消息读取与发送工具 | `B:docs-site/docs/zh/multi-bot.mdx` | Agent 能理解协作上下文和通知同伴 | capability 必须绑定 session + app + chat；读取与发送分别授权 | 已覆盖，见 `D:apps/server/src/lark/agent-tools.ts` | 核心 | retain |
| sibling cwd 继承 | `B:src/bot-registry.ts` 的 `botToBotSameDir` | 交接后直接在同一项目工作 | 只有经过 workspace ACL 验证才可继承 | 未覆盖 | 支撑但高风险 | drop 默认行为；未来显式 reshape |
| 多话题自动编排 | `B:docs-site/docs/zh/multi-topic.md` | 自动拆解、并行开工、任务板汇总 | 每个分支可追踪、可取消、可汇总且不丢失败 | 未覆盖 | 外围 | defer，未来用 Run DAG 实现 |
| 群共享白板 | `B:docs-site/docs/zh/whiteboard.md`；`B:src/services/whiteboard-store.ts` | 多 Agent 共享计划和当前事实 | 群级隔离、CAS/锁、显示更新来源 | 未覆盖 | 支撑 | defer |

### 4.4 Session、后台进程与终端

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| tmux 默认持久进程 | `B:docs-site/docs/zh/tmux.md`；`B:src/core/session-manager.ts` | daemon 重启时 CLI 和上下文仍存活 | tmux 缺失时明确失败，不能静默退回不持久 PTY | 部分覆盖：`D:packages/session-backends/src/tmux-backend.ts` 已实现，但 `D:apps/server/src/service.ts` 未向 `PtyCliDriver` 注入 backend，生产 pty-cli 实际默认 `PtyBackend` | 核心 | reshape，P0 接入生产路径 |
| zellij/herdr/zmx backend | `B:src/adapters/backend`；`B:docs-site/docs/zh/zmx.md` | 适配不同机器环境 | UI 显示 backend 的真实 resume/attach 限制 | 部分覆盖：Dockmux package/tests 有 zellij/zmx/PTY，尚未接入生产 driver factory；无 herdr | 支撑 | reshape；先保证一个持久 backend 端到端可用 |
| Worker 崩溃重启与熔断 | `B:src/core/worker-pool.ts` | 短暂崩溃可恢复，持续崩溃不无限拉起 | 达到阈值进入 degraded，保留错误原因和人工恢复入口 | 部分覆盖 | 核心可靠性 | reshape |
| 空闲 worker suspend/reclaim | `B:src/core/worker-pool.ts`；`B:src/bot-registry.ts` | 控制多 Session 资源占用 | suspend 不能等同结束；恢复能力必须真实 | 已有 6 小时 driver idle release | 支撑 | retain/reshape 可见状态 |
| Adopt 外部 tmux pane | `B:docs-site/docs/zh/adopt.mdx` | 把正在本地运行的工作无扰接入聊天 | attach/detach 不杀原进程；明确无 sandbox/resume 保证 | 未覆盖 | 差异化 | defer |
| Chat-to-chat Relay | `B:docs-site/docs/zh/relay.md` | 将同一上下文迁到新群/私聊 | owner-only、idle-only、目标无活动 Session | 未覆盖 | 支撑 | drop 原模型；reshape 为一个 Task 绑定多个 Channel |
| 语义事件与原始终端 | `B:docs-site/docs/zh/cards.md`；`B:docs-site/docs/zh/web-terminal.md` | 日常看语义进度，排障时看终端 | 原始终端是 drill-down，不是唯一状态源 | Dockmux 语义事件更强，且有 terminal WS | Dockmux 核心优势 | retain Dockmux |
| 只读/可写终端链接 | `B:src/core/terminal-url.ts`；`B:src/core/terminal-write-auth.ts` | 远程查看和必要时接管 CLI | 可写入口必须鉴权并私下发给操作者；不可把 bearer token 放群卡 | Dockmux Web auth + terminal 已覆盖 | 安全支撑 | retain；drop 群卡公开可写选项 |

### 4.5 Task、卡片与长期执行

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| type-ahead/排队 | `B:docs-site/docs/zh/cards.md`；`B:src/core/session-manager.ts` | 当前任务运行时继续下达后续请求 | 取消 queued item 不能中断当前 running item | 已覆盖且更强，见 `D:packages/agent-runtime/src/index.ts` | Dockmux 核心优势 | retain |
| 每轮状态卡与快捷操作 | `B:docs-site/docs/zh/cards.md` | 用户知道已接收、执行、完成或失败 | 按钮权限与任务状态二次校验；过期按钮不得误操作新任务 | 已覆盖，见 `D:apps/server/src/lark/coordinator.ts` | 核心 | retain |
| 最终回执持久化和对账 | `B:src/core/deferred-schedule-settlement.ts` 及 card reconciliation 代码 | daemon 重启或网络抖动后仍能收到最终结果 | 最终回执 exactly-once observable；重复发送至少可去重 | Dockmux 已有 reconciler，见 `D:apps/server/src/lark/reconciler.ts` | Dockmux 核心优势 | retain |
| Needs You/Active/Recent 工作台 | Botmux Fleet dashboard；Dockmux `D:docs/interaction-design-2026-08-30.md` | 先看到需介入事项，再看运行和历史 | 任务状态必须来自持久事件，不由 UI 猜测 | Dockmux 更强 | Dockmux 核心优势 | retain Dockmux，不把首页改成 Bot 矩阵 |

### 4.6 Workflow、定时和外部触发

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| 一次性/cron/自然语言定时 | `B:docs-site/docs/zh/schedule.md`；`B:src/core/scheduler.ts`；`B:src/services/schedule-store.ts` | 自动巡检、日报和周期任务 | 每次触发有独立 Run、来源、下次时间和可取消状态 | 未覆盖 | 核心场景之一 | reshape 为 Schedule → Task/Run |
| 继续原 Session 或新话题 | `B:docs-site/docs/zh/schedule.md` | 周期工作可延续上下文或保持隔离 | UI 明示上下文策略；目标 Session 不存在时不能静默换目标 | 未覆盖 | 支撑 | reshape |
| API sync/async trigger | `B:docs-site/docs/zh/api-task-trigger.md`；`B:docs-site/docs/zh/api-core-only.md` | CI、脚本和外部系统可靠调用 Agent | idempotency key、持久结果、查询、取消、恢复 | 部分覆盖：有 Session HTTP API，无正式外部触发契约 | 核心平台能力 | reshape，优先于 Workflow |
| Webhook connector | `B:docs-site/docs/zh/webhook.md`；`B:src/dashboard/webhook-routes.ts`；`B:src/services/webhook-audit.ts` | 告警、代码平台等事件自动进入 Agent | Token/HMAC、去重、限流、审计、脱敏；可信指令与不可信 event envelope 分离 | 未覆盖 | 支撑 | defer，按 Connector → Task 实现 |
| v3 Workflow DAG | `B:docs-site/docs/zh/workflow.md`；`B:src/workflows/v3` | spec gate、DAG、并行、循环、人工门 | Run journal、节点幂等、人类 gate、失败可恢复 | 未覆盖 | 有潜力但尚复杂 | defer |
| 旧模板 + v3 双体系 | `B:packages/workflow-core`；`B:src/workflows/v3` | 兼容历史工作流 | 两套概念会增加创建、迁移和解释成本 | 未覆盖 | 架构负担 | drop，不移植双引擎 |

### 4.7 角色、Profile 与 Team

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| Bot 默认角色 + 群级覆盖 | `B:docs-site/docs/zh/roles.md`；`B:src/core/role-resolver.ts` | 同一 Bot 在不同群承担不同职责 | 优先级 chat > bot default > none；Run 中固化角色版本 | 部分覆盖：systemPrompt + preInjectPrompt | 核心 | reshape |
| 可复用 RoleProfile | `B:src/services/role-profile-store.ts`；`B:src/dashboard/web/roles-page.tsx` | 多 Bot/群批量采用一致角色 | 应用前差异预览；缺失 profile 安全回退并提示 | 未覆盖 | 支撑 | reshape |
| capability 一行标签 | `B:docs-site/docs/zh/roles.md` | 人和 Agent 快速发现谁擅长什么 | 描述是发现信息，不授予工具或文件权限 | 未覆盖 | 支撑 | defer |
| 跨部署 Team federation | `B:docs-site/docs/zh/multi-bot.mdx`；`B:src/services/team-groups-store.ts` | 跨机器、跨 owner 组织 Agent 团队 | 强身份、显式 opt-in、审计、撤销 | 未覆盖 | 外围 | defer |
| private/shared role | `B:docs-site/docs/zh/roles.md` | 减少角色上下文暴露 | Botmux 文档已说明它不是 daemon 硬 ACL | 未覆盖 | 非安全能力 | drop 作为安全承诺 |

### 4.8 记忆、反馈和用量

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| CLI 原生上下文/记忆 | `B:docs-site/docs/zh/bots-json.md` | 延续用户既有 Agent 习惯 | 不伪造跨 CLI 统一记忆语义 | 已通过原生 resume/ACPX Session 覆盖 | 核心 | retain |
| 显式 `/summary` 记忆 | `B:src/im/lark/summary-command.ts`；`B:src/services/summary-range-store.ts` | 将关键决策沉淀为可复用记录 | 用户显式触发、可审阅、记录来源和范围、受 workspace/sandbox 边界约束 | 未覆盖 | 支撑 | defer/reshape |
| 群共享白板 | `B:src/services/whiteboard-store.ts` | 多 Agent 共享当前计划 | CAS、群隔离、版本和更新者可见 | 未覆盖 | 支撑 | defer |
| 最终答复反馈 | `B:src/services/feedback-policy.ts`；`B:src/services/skill-feedback-store.ts`；`B:src/im/lark/skill-feedback-card.ts` | 收集真实结果质量，形成迭代闭环 | 仅请求人反馈；按钮策略按 delivery snapshot 固化；重复点击语义明确 | 未覆盖 | 高价值支撑 | reshape，P1 |
| 反馈 durable outbox | `B:src/services/feedback-outbox.ts`；`B:src/services/feedback-webhook-dispatcher.ts` | 网络失败不丢外部反馈 | 本地先落库，重试幂等，敏感字段受控 | 未覆盖 | 可靠性支撑 | reshape |
| 原生 usage ledger | `B:src/services/usage-ledger.ts`；`B:src/services/codex-app-token-usage.ts` | 审计上下文和成本趋势 | 只记供应商原生 delta；未知即未知，不估算；记录归属 | 部分覆盖：实时 context usage，无持久 ledger | 支撑 | reshape |

### 4.9 附件、语音、会议和文档

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| 图片/文件/富文本输入 | `B:src/im/lark/message-parser.ts`；`B:src/core/attachment-path.ts` | Agent 可处理真实工作材料 | 下载失败给可执行错误；临时文件权限和生命周期受控 | 已覆盖且格式更广，见 `D:apps/server/src/lark/message-content.ts`、`session-resolver.ts` | 核心输入能力 | retain |
| 文件/图片输出与卡片 | `B:src/im/lark/client.ts`；`B:docs-site/docs/zh/cards.md` | 结果能以适合的媒介返回群聊 | 大文件失败可解释；不能把本机任意路径泄露给聊天 | 部分覆盖 | 支撑 | reshape 按真实需求 |
| 按需语音总结 | `B:docs-site/docs/zh/voice.mdx`；`B:src/services/voice` | 移动端快速消费长回复 | 按需、权限校验、每卡一次、文本摘要与音频可追溯 | 未覆盖 | 外围 | defer |
| VC Meeting Agent | `B:src/services/vc-meeting-*`；`B:src/core/vc-meeting-prepare-command.ts` | 自动监听会议并在指定位置输出 | profile capability gate；`skip/publish` fail-closed；输出位置可预测 | 未覆盖 | 垂直外围 | defer，建为 Connector 而非核心 Bot 配置 |
| 文档评论 watch | `B:docs-site/docs/zh/doc-comment.md`；`B:src/core/doc-comment-poller.ts` | 文档评审自动响应 | 明确订阅范围、预热 Session、评论线程内回复、可取消 | 未覆盖 | 垂直外围 | defer，建为 Connector |

### 4.10 Dashboard 与运营视图

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| Fleet Sessions | `B:docs-site/docs/zh/dashboard.md`；`B:src/dashboard.ts` | 运营多个 Bot daemon 和 Session | 展示真实 daemon/session 状态及部分失败 | Dockmux 以 Task 工作台覆盖主要旅程 | 核心但模型不同 | retain Dockmux Task-first |
| Groups/Role/Bot Defaults/Schedule 页面 | `B:src/dashboard/web/groups-page.tsx`；`roles-page.tsx`；`bot-defaults-page.tsx`；`schedules-page.tsx` | 集中管理身份、群关系和自动化 | 配置来源、覆盖关系和生效范围可见 | 未覆盖/部分覆盖 | 核心运营能力 | reshape 为二级“集成与策略”区域 |
| Feedback analytics | `B:src/dashboard/web/feedback-page.tsx`；`B:src/dashboard/feedback-analytics-api.ts` | 发现低质量 Agent/群/场景 | 指标口径、样本量和时间范围明确 | 未覆盖 | 支撑 | defer 到反馈采集后 |
| public read-only Dashboard | `B:docs-site/docs/zh/dashboard.md` | 低成本共享运行状态 | Botmux 可能暴露部分元数据 | Dockmux 默认 token auth 更安全 | 风险大于价值 | drop 默认公开；如未来提供需独立最小数据面 |
| 首页 Bot/Fleet 矩阵 | Botmux Dashboard 导航 | 适合 daemon 运维 | 不能挤压“待你处理”的主任务旅程 | Dockmux Needs You/Active/Recent 更清晰 | 非 Dockmux 核心 | drop 作为首页；保留为设置子页 |

### 4.11 权限、风险与沙箱

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| `canTalk` / `canOperate` 分离 | `B:src/im/lark/event-dispatcher.ts`；`B:src/bot-registry.ts` | 群成员可请求 Agent，但不能重启、改目录或控制他人任务 | 所有按钮和 daemon command 按动作分类二次鉴权；talk grant 永不自动升级为 operate | 未覆盖：Dockmux 白名单成员可操作任意卡片 | 核心安全优势 | reshape，P0 |
| owner anchor | `B:src/bot-registry.ts` 的 `ownerOpenId`；`B:src/im/lark/event-dispatcher.ts` | 始终有明确管理员和故障通知对象 | owner 身份按 App 解析；跨 App 的 `open_id` 不可复用 | 部分覆盖 | 核心 | reshape |
| talk grant 请求卡 | `B:src/services/grant-store.ts`；`B:src/im/lark/event-dispatcher.ts` | 陌生用户可向 owner 申请临时使用 | 有效期、额度、范围、撤销和 pending 节流；只授 talk/dispatch | 未覆盖 | 核心协作优势 | reshape，P1 |
| allowlist 解析失败关闭 | `B:src/im/lark/event-dispatcher.ts` | 配错 owner 时不会放开给所有人 | “已配置但解析为空”必须 fail-closed 并通知 owner | Dockmux邮箱解析失败已关闭，但空白名单仍开放 | 核心 | reshape |
| 显式访问策略 | Botmux 的 open/allowlist/p2pOpen 组合；`D:apps/server/src/lark/coordinator.ts` | 管理员理解谁可以发起与操作 | 不允许“空名单”隐式表示开放；应有 `owner_only/allowlist/open` | 未覆盖显式策略 | 核心 | reshape，默认 `owner_only` |
| 高危操作控制 | `D:apps/server/src/lark/config.ts`；`D:apps/server/src/lark/security-hooks.ts` | full-trust 飞书运行仍有额外门禁 | enforced 模式在 adapter/tool 边界执行，超时或异常 fail-closed；提示词仅辅助 | Dockmux 已覆盖且更强 | Dockmux 核心优势 | retain |
| Agent permission posture | `D:README.md`；`D:packages/acp-client/src/index.ts`；`D:packages/pty-driver/src/driver.ts` | Web 任务默认可审批，full-trust 明确可见 | `ask` 不得追加 bypass；full-trust 需显式同意；PTY 不支持的模式明确拒绝 | 已覆盖 | Dockmux 核心优势 | retain |
| 三层文件沙箱 | `B:src/adapters/backend/sandbox.ts`；`B:src/services/sandbox-store.ts` | 限制 Agent 读写工作区外文件，隔离凭据 | RW/RO/Deny deny-wins；不支持时 fail-closed；网络策略明确；凭据不进 sandbox | 未覆盖；permission posture 不是文件隔离 | 核心安全优势 | reshape 为 backend capability |
| sandbox outbox relay | `B:src/adapters/backend/sandbox.ts` | sandbox Agent 可请求发消息但拿不到飞书凭据 | sandbox 只写受限请求；host 重建命令、强制 session/chat 身份并校验参数 | Dockmux group tools 已用 scoped token，但无文件 sandbox | 核心边界设计 | reshape 时参考 |
| 可写终端 token | `B:src/core/terminal-write-auth.ts`；`B:src/bot-registry.ts` | owner 必要时远程接管 | bearer token 不进群卡和日志；短期、单用途、可撤销 | Dockmux Web auth 较安全 | 安全支撑 | retain Dockmux，drop Botmux 公开开关 |
| Bot 消息信任 | `B:src/im/lark/event-dispatcher.ts`；`D:apps/server/src/lark/coordinator.ts` | 允许 Agent 协作且防止陌生 Bot 注入 | peer 身份必须由 app/chat roster 验证；Bot 默认无高危权；防回环 | 部分覆盖 | 核心 | retain/reshape，禁止宽泛 team 自动获得 operate |

### 4.12 部署、恢复与可靠性

| 能力 | Botmux 证据 | 用户价值 | 不可丢交互契约 | Dockmux 覆盖 | 核心优势 | 处置 |
|---|---|---|---|---|---|---|
| setup/start/stop/restart/status/upgrade | `B:docs-site/docs/zh/quickstart.md`；`B:docs-site/docs/zh/cli-commands.md` | 普通用户能完成本机运维 | 命令幂等；失败保留可执行诊断；升级不误删 session 数据 | 已覆盖 daemon 命令，见 `D:apps/server/src/daemon` | 支撑 | retain |
| 一 Bot 一 daemon | `B:docs-site/docs/zh/architecture.md` | Bot 间故障和配置隔离 | Dashboard 需 fan-out 并处理部分 daemon 离线 | Dockmux 单 runtime + 多 listener 更简单 | Botmux 架构特征，不是用户必需 | drop，不照搬 |
| SQLite/文件状态恢复 | `B:src/core/session-manager.ts` 及各 store；`D:packages/storage/src` | 重启后任务、映射和回执可继续 | 状态迁移可回滚；不能因内存 map 丢失而把任务误判成功 | Dockmux 已覆盖核心 Task 状态 | 核心可靠性 | retain |
| 后端 readiness 与硬失败 | `B:docs-site/docs/zh/tmux.md`；`B:src/adapters/backend` | 用户在开工前知道依赖缺失 | 缺 tmux/bwrap/CLI 时不静默换弱安全后端 | 部分覆盖：selector/package 有规则，生产 server 尚未使用 selector | 核心 | reshape，P0 |
| daemon 重启后的 Session reattach | `B:src/core/session-manager.ts`；`B:src/core/worker-pool.ts` | 长任务不中断或至少可恢复 | 重新附着同一 backing session；失败显示 degraded，不创建冒充原 Session 的新上下文 | 部分覆盖：ACP/CLI 原生 resume 可恢复部分上下文，但生产 pty-cli 使用 `PtyBackend`，进程不会跨 daemon 存活，也没有 backing-session reattach | 核心 | reshape，P0 并补真实进程 E2E |
| 卡片/回执重放与去重 | `B:src/core/deferred-schedule-settlement.ts`；`D:apps/server/src/lark/reconciler.ts` | 网络抖动和重启不丢最终结果 | 事件至少一次到达时，用户侧结果不可无限重复 | Dockmux 已覆盖较强 | 核心 | retain |
| 日志/审计脱敏 | `B:src/services/webhook-audit.ts`；Dockmux auth/config code | 排障时不泄露凭据 | Secret、Cookie、bearer token、附件临时路径按策略脱敏 | 部分覆盖 | 基础安全 | retain 并持续测试 |

## 5. 明确不照搬的 Botmux 设计

1. 不复制单一 `bots.json` catch-all。身份凭据、Agent 定义、群绑定、运行态和审计数据应分层存储。
2. 不允许空白名单隐式代表开放。开放必须是显式、有警告、可审计的策略选择。
3. 不把 Botmux 的一 Bot 一 daemon 作为 Dockmux 目标架构；保留统一 runtime 和 listener pool。
4. 不把原始终端截图当作主要进度；Dockmux 的结构化事件和 Task 状态是事实源。
5. 不在未验证 workspace ACL 时继承另一个 Bot 的 cwd。
6. 不把 Role/Profile 的“private”语义宣传为安全隔离。
7. 不把可写终端 bearer URL直接放进群卡。
8. 不默认开放 public read-only Dashboard。
9. 不迁移 Botmux 旧 Workflow 与 v3 Workflow 双体系；未来只保留一个 Dockmux-native Run DAG。
10. 不把语音、会议、文档评论等垂直集成塞进核心 Bot 配置；未来统一走 Connector → Task。
11. 不让 cross-deployment team membership 自动扩大 operate 或高危权限。
12. 不自动把任意聊天内容写入长期记忆；必须显式、可审阅、带来源并受 workspace 边界约束。

## 6. 推荐实施顺序

### P0：替换核心所需

1. Agent 管理页：真实 runtime、版本、能力、readiness 和默认权限姿态。
2. `ChannelBot` 与 `GroupBinding` 分层，支持最终生效配置预览。
3. 飞书群清单和 `chat × bot` 矩阵，先只读，再加入安全的管理动作。
4. `can_talk / can_dispatch / can_operate / can_admin` 动作权限分级。
5. 显式 `owner_only / allowlist / open` 访问策略，默认 `owner_only`。
6. RunSnapshot 固化 Agent、workspace、runtime、角色和权限来源。
7. 将持久 session backend selector 接入 `apps/server/src/service.ts` 的生产 `PtyCliDriver` factory，至少先保证 tmux 的 readiness、spawn、daemon 重启 reattach 和硬失败完整闭环；不能仅以 package/tests 存在视为能力已交付。

### P1：高价值闭环

1. owner 临时 talk/dispatch 授权卡；
2. RoleProfile 与群级角色覆盖；
3. Schedule → Task/Run；
4. 外部幂等 Trigger API；
5. 最终答复反馈与 durable outbox；
6. 原生 usage ledger；
7. 文件 sandbox capability、readiness 和 fail-closed 测试。

### P2：扩展能力

1. Webhook Connector；
2. Adopt 外部终端；
3. 显式 summary memory；
4. 一个 Task 绑定多个 Channel；
5. 群共享白板；
6. 基于真实需求的语音、会议和文档 Connector。

## 7. Capability Preservation Gate

Dockmux 在宣称可替换 Botmux 前，以下场景必须在真实或等价隔离的飞书、真实 `AcpxAdapter`/PTY backend、真实持久化数据库上通过 E2E。只用 mock Lark client、mock ACP client 或内存仓库不能关闭 gate。

### G0：配置与凭据边界

- [ ] 自动配置一个新的飞书 App 后，权限、事件、卡片回调和版本回读均正确；已有通讯录可见范围无法解析时发版停止。
- [ ] 同时配置两个飞书 Bot，各自使用独立身份和 owner；Bot A 的 app-scoped `open_id` 不能在 Bot B 上误获得权限。
- [ ] 公共配置 API、浏览器存储、日志、Agent prompt、群工具输入中均不出现 App Secret、Cookie 或 access token。
- [ ] 用真实 `AcpxAdapter` 创建、持久化、加载群聊 Session；`session_options` 中只有 `snake_case` 键，重启后 group tools capability 仍可重建。
- [ ] 修改 Bot/群默认配置只影响新 Run；运行中的 RunSnapshot 不改变 Agent、workspace、权限姿态或 runtime。

### G1：Agent 与 backend readiness

- [ ] **关闭当前生产缺口**：`apps/server/src/service.ts` 创建 `PtyCliDriver` 时显式选择并注入持久 backend；不能继续依赖 driver 的默认 `PtyBackend` 后宣称 CLI 可跨 daemon 存活。
- [ ] ACPX Agent 和至少一个 PTY Agent 都能被探测、显示真实版本并完成一轮任务。
- [ ] Agent CLI 缺失时 UI 和飞书卡片给出可执行错误，不切换到另一个 Agent。
- [ ] 选择 tmux/zellij/zmx 等持久 backend 时，缺依赖必须硬失败，不能静默退回普通 PTY。
- [ ] backend 声称支持 resume 时，daemon 重启后重新附着同一上下文；不支持时明确显示不可恢复。

### G2：私聊、普通群与话题路由

- [ ] P2P `chat` 模式下连续消息进入同一 Session；`thread` 模式下不同顶层线程隔离。
- [ ] 普通群 `chat/shared/new-topic/chat-topic` 的 root/thread 路由与配置说明一致。
- [ ] 话题群中同一 topic 连续、不同 topic 隔离；群 A 和群 B 永不共享 Session。
- [ ] 同一飞书消息事件重复投递时只创建一个 Task/Turn，最终卡片不重复。
- [ ] 默认群消息未 @Bot 时不执行；明确启用 `ambient/never` 后才改变，且有人 @其他 Bot 时本 Bot 正确让路。
- [ ] Bot 自己的消息、未信任 Bot 消息和交接回执不会形成消息回环。

### G3：GroupBinding 与配置优先级

- [ ] 群矩阵能区分“已入群未配置”“已配置已入群”“本地有绑定但已退群”“listener 离线”。
- [ ] 同一 Bot 在两个群绑定不同 workspace/Agent/RoleProfile，各自启动任务时生效且互不泄漏。
- [ ] Run 显示最终生效值及来源，符合 `Run > GroupBinding > ChannelBot > Agent > process` 优先级。
- [ ] Bot 被移出群或权限被撤销后，矩阵和运行入口在下一次同步中进入 degraded/blocked，而不是继续显示正常。
- [ ] 群管理 API 部分成功时逐项展示结果，不把失败 Bot 标为已加入。

### G4：身份、动作权限与高危控制

- [ ] 默认 `owner_only` 下，陌生群成员和陌生私聊用户不能发起 Task，也不能操作卡片。
- [ ] 被授予 `can_talk/can_dispatch` 的成员能发起任务，但不能改目录、重启、终止他人 Run、修改配置或获得可写终端。
- [ ] `can_operate` 用户只能执行定义好的运行操作；只有 `can_admin` 能改 Bot/群策略和授权。
- [ ] allowlist 已配置但用户/邮箱解析失败时 fail-closed，并向 owner 提供可执行修复说明。
- [ ] 空白名单不会隐式开放；只有显式 `access_policy=open` 才允许所有可见用户使用，并有醒目风险提示。
- [ ] 未进入高危允许名单的用户在 Lark full-trust Run 中触发危险命令时，被 adapter/tool hook 强制拦截；脚本、子进程和等价路径不能绕过。
- [ ] 信任 peer Bot 只能获得显式协作 capability，默认不能获得高危或 admin 权限。
- [ ] queued Task 的取消按钮不会中断当前 running Task；过期卡片不能影响后来的 Run。

### G5：长期运行、排队与重启恢复

- [ ] 同一 Session 连续提交至少三个 Turn；第一个运行时后两个排队，顺序稳定且可分别取消/提升。
- [ ] daemon 在 running、queued、waiting-for-permission、final-delivery 四个阶段分别重启，恢复后状态与用户可见结果一致。
- [ ] running CLI 由持久 backend 托管时，server 重启不杀进程；重连后事件继续进入同一 Run。
- [ ] 无法恢复时状态进入 `failed/degraded` 并保留原因，不创建一个新 Session 冒充原上下文。
- [ ] 最终回执网络发送成功但本地确认前重启，恢复后不会无限重复发卡；未发送成功则最终能补发。
- [ ] worker/driver 连续崩溃达到阈值后熔断，UI 显示原因和人工恢复入口，不无限重启。

### G6：群内多 Agent 协作

- [ ] Bot A 读取 roster 后显式发送 `@Bot B` 交接，Bot B 能识别可信来源并创建独立 Task。
- [ ] capability token 只允许访问绑定的 app/chat/session；将 token 用于另一个群、Bot 或 Session 必须失败。
- [ ] 群消息读取和发送是两个独立开关；只读配置不能通过任何别名路径发消息。
- [ ] Bot B 不会因为同群或 Team 身份自动继承 Bot A 的 cwd；只有显式且通过 workspace 校验的绑定才能共享目录。
- [ ] 两个 Bot 互相提及、回复和发送结果时有回环上限或终止策略。

### G7：附件、事件和用户可见结果

- [ ] 图片、文件、音频、视频、富文本和合并转发至少各有一个真实飞书输入用例；Agent 收到可读资源或明确失败说明。
- [ ] 临时附件使用私有权限，任务结束后的生命周期符合策略；不在卡片或日志暴露非必要本机绝对路径。
- [ ] Agent 流式文本、工具调用、权限请求、失败和最终答复在 Web 与飞书两端语义一致。
- [ ] PTY 原始终端异常时，Task 语义事件和最终状态仍是事实源；终端不可用不会把已完成任务显示为运行中。

### G8：运营、审计与回滚

- [ ] Dashboard 能从 Needs You/Active/Recent 定位任务，并从 Task 追到 Agent、Bot、群绑定、RunSnapshot 和原始事件。
- [ ] 多 Bot 中一个 listener 离线时，其余 Bot 和 Web Task 不受影响；设置页明确显示局部故障。
- [ ] 配置迁移前后对同一组 Bot/群生成 effective-config diff；无法映射的 Botmux 字段被列为人工处理项，不静默丢弃。
- [ ] 迁移失败可回滚到迁移前 Dockmux 配置和数据库；回滚不覆盖用户新产生的运行记录。
- [ ] 日志和审计记录能说明谁在何时发起、授权、操作、修改策略，但不记录 Secret、Cookie 或 bearer token。

### G9：启用后才必须通过的条件 gate

以下能力不阻塞第一阶段核心替换，但一旦产品宣称支持，就必须先通过对应 E2E：

- [ ] **Schedule/API Trigger**：幂等触发、重启恢复、取消、目标上下文策略和 exactly-once observable result。
- [ ] **文件 sandbox**：RW/RO/Deny、deny-wins、网络关闭、缺 bwrap/Seatbelt fail-closed、凭据不可读、群工具 host relay 不可伪造 session/chat。
- [ ] **临时授权**：申请、批准、拒绝、过期、额度耗尽、撤销、并发点击和 owner 不可达。
- [ ] **RoleProfile**：群级覆盖、版本冻结、缺失 profile 安全回退，以及角色提示词不能扩大工具权限。
- [ ] **反馈/usage ledger**：请求人限定、delivery snapshot、重复反馈、outbox 重试，以及未知 usage 不被估算。
- [ ] **Adopt/多 Channel**：detach 不杀原进程、只读/可写权限、Channel 撤销，以及一个 Channel 失败不改变 Task 所有权。

## 8. Gate 关闭规则

1. 每个场景必须保存可复现的测试前置、事件序列、期望持久状态和用户可见断言。
2. 涉及 ACPX 持久化键名的场景必须使用真实 `AcpxAdapter` 和真实 session key；只 mock ACP client 不计通过。
3. 涉及飞书 app-scoped 身份的场景至少需要两个真实测试 App；单 App 内伪造两个 ID 不计通过。
4. 涉及重启恢复的场景必须真的终止并重启 daemon/runtime 进程；仅重建内存对象不计通过。
5. 涉及 backend 持久化的场景必须检查原 OS 进程/pane 身份，而不是只断言数据库记录存在。
6. 涉及权限和 sandbox 的场景必须同时包含允许路径与拒绝路径，并验证拒绝发生在执行边界而非仅提示词层。
7. 任一 P0 gate 失败时，不应宣称 Dockmux 已完整替换 Botmux；应明确标注替换范围和保留的 Botmux fallback。
