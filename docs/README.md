# 文档索引

本目录收录 Dutydeck 的架构设计、功能手册、调研对标与交付记录（共 46 篇）。

状态说明：
- **现行**：仍在指导当前工作的规范、使用手册与调研结论。
- **已落地**：方案类文档或阶段交付记录，关键设计已在代码中实现。
- **历史**：已被后续文档或实现取代的早期方案与评估快照。
- **待确认**：仅完成部分底层实现或尚未接线的方案草案，后续是否继续推进待定。

## 飞书入口与群协作

| 文档 | 日期 | 说明 | 状态 |
|---|---|---|---|
| [tag-layered-execution.md](tag-layered-execution.md) | 2026-09-24 | PMO + Leader + Worker 三层协作流程、配置、权限与自动返修验收手册。 | 现行 |
| [generic-collaboration-implementation.md](generic-collaboration-implementation.md) | 2026-09-24 | 通用群协作（上下文补读、按需发言、跨群检索、事项跟进与持续委托）使用与接口说明。 | 现行 |
| [lark-card-polish-proposal-20260923.md](lark-card-polish-proposal-20260923.md) | 2026-09-23 | 飞书任务卡片去噪方案（标题栏状态标签、实时工具进展、完成态过程卡收起与长结果折叠）。 | 已落地 |
| [tag-layered-governance-proposal.md](tag-layered-governance-proposal.md) | 2026-09-23 | Tag 可选分层协作（PMO + Leader + Worker）早期设计方案。 | 历史（被 [tag-layered-execution.md](tag-layered-execution.md) 及 `leader-delegation.ts` 实现取代） |
| [collaboration-extensions.md](collaboration-extensions.md) | 2026-09-18 | `CollaborationExtensions` 外部事件/查询/动作扩展与 `CollaborationEvaluation` 回放评测规范。 | 现行 |
| [team-tag-foundation-plan.md](team-tag-foundation-plan.md) | 2026-09-18 | 通用群协作 Agent 能力方案（群观察、选择性参与、跟进记录、持续委托与条件提醒）。 | 已落地 |
| [team-tag-foundation-design.md](team-tag-foundation-design.md) | 2026-09-18 | 团队 Tag 基座能力初版设计（信号→判定→事件档案→处置管道与已知问题折叠）。 | 历史（被 [team-tag-foundation-plan.md](team-tag-foundation-plan.md) 与 [generic-collaboration-implementation.md](generic-collaboration-implementation.md) 取代） |
| [feishu-ux-delivery-20260916.md](feishu-ux-delivery-20260916.md) | 2026-09-16 | 飞书交互与控制修复交付说明（取消/中断身份校验、阻塞原因展示、提问卡过期、长结果幂等与 `native-ask`）。 | 已落地 |
| [feishu-ux-review-20260916.md](feishu-ux-review-20260916.md) | 2026-09-16 | 飞书交互与控制问题修复前审查报告（基线 `61b6e5a`）。 | 历史（被 [feishu-ux-delivery-20260916.md](feishu-ux-delivery-20260916.md) 取代） |
| [bot-activation-design.md](bot-activation-design.md) | 2026-09-15 | Bot、群与身份统一激活设计（ChannelBot V2 权威切换、Listener 代际控制与导入落库）。 | 待确认（`packages/storage` 已实现 V2 配置表与命令，但 `apps/server` 的 listener 权威切换与导入 `apply` 尚未接线） |
| [bot-configuration-field-map.md](bot-configuration-field-map.md) | 2026-09-15 | `StoredLarkConfig` 到 V2 配置模型的字段归属、权限展开规则与服务端写路径清单。 | 待确认（V2 schema 与存储层转换已实现，但 `apps/server` 各配置写入口与 listener 尚未切换到 V2） |
| [bot-configuration-storage-design.md](bot-configuration-storage-design.md) | 2026-09-15 | Bot 配置 V2 的 SQLite 表升级、`ConfigurationRepository` 读写/历史接口、无绑定凭据命令与迁移事务设计。 | 已落地 |
| [bot-configuration-v2-design.md](bot-configuration-v2-design.md) | 2026-09-15 | Bot 配置 V2 数据结构（`ChannelBotV2`、`BotAccessPolicy`、`OwnRunRule`）、`FullTrustScopeV1` 与事务接口设计。 | 已落地 |
| [delivery-ledger-design.md](delivery-ledger-design.md) | 2026-09-15 | 统一消息交付账本（`deliveries` / `delivery_operations` 表、回执核对与重放边界）设计草案。 | 待确认（属未实施的 P6 草案，代码尚未创建 `deliveries` 表，仍使用 `lark.delivery.*` KV 与 `channel_mappings`） |
| [lark-execution-ledger-design.md](lark-execution-ledger-design.md) | 2026-09-15 | 飞书入站消息、过程/结果卡及卡片回调接入 Task/Attempt 执行账本的设计草案。 | 待确认（飞书层已接入 `reconcile_required` 展示与 `readAttemptResult`，但入站 `TaskAdmissionV1` 与独立交付表尚未在 `task-inbox.ts` / `coordinator.ts` 落地） |

## 执行与运行时

| 文档 | 日期 | 说明 | 状态 |
|---|---|---|---|
| [session-names.md](session-names.md) | 2026-09-24 | 普通会话自定义名称规则、Web 重命名入口与 `dutydeck session` CLI 手册。 | 现行 |
| [workspace-groups.md](workspace-groups.md) | 2026-09-24 | 工作区展示分组优先级规则与 `dutydeck workspace-groups` CLI 手册。 | 现行 |
| [acp-native-context-design.md](acp-native-context-design.md) | 2026-09-15 | ACP 原生上下文严格创建/恢复（`createStrictSession` / `restoreStrictSession`）与配置证明（`configureNative`）设计。 | 已落地 |
| [codex-app-protocol-qualification.md](codex-app-protocol-qualification.md) | 2026-09-15 | Codex App Server JSON-RPC 协议定义核对与原生 `AgentDriver` 接入边界设计。 | 待确认（已完成协议定义生成核对，但 `packages/cli-adapters/src/adapters/codex-app.ts` 仍为外部 runner 壳，未实现内置 JSON-RPC 驱动） |
| [driver-resource-integration-design.md](driver-resource-integration-design.md) | 2026-09-15 | 驱动资源创建许可（`ControlledDriverResources`）、tmux/进程身份核验、`closeAbandonedCreation` 与原生上下文资源表设计。 | 已落地 |
| [execution-management-design.md](execution-management-design.md) | 2026-09-15 | 执行状态查询（`PublicTaskExecution`）、操作者身份解析（`resolveExecutionActor`）、`interruptAttempt` 与结果确认/重试接口设计。 | 待确认（存储层操作者 App 范围校验与 `confirm_result` / `retry` 决策已实现，但 `apps/server/src/app.ts` 的公开查询与恢复路由尚未接线） |
| [process-driver-turn-design.md](process-driver-turn-design.md) | 2026-09-15 | JSONL/Pipe 传输层单轮次生命周期（`ActiveTurn`）、等待明确 `completed` 结算与中断/超时进程组收口设计。 | 已落地 |
| [runtime-consistency-design.md](runtime-consistency-design.md) | 2026-09-15 | Runtime 单会话事件写链、持久队列（`queue_position` / `promoteQueued`）、群授权 `prepareTurn` 与 `AcpxAdapter.isStopped` 设计。 | 已落地 |
| [runtime-ledger-integration-design.md](runtime-ledger-integration-design.md) | 2026-09-15 | Runtime 接入 Task/Attempt 账本、逐 Task 选项快照（`AcceptedTaskInputV2`）、`markOrphanedAttempt` / `patchSessionState` 设计。 | 已落地 |
| [runtime-recovery-design.md](runtime-recovery-design.md) | 2026-09-15 | SQLite 单 Runtime 持久控制权（`dutydeck_control` / `dutydeck_access` / `attachRuntime`）与跨进程恢复设计。 | 已落地 |
| [task-attempt-design.md](task-attempt-design.md) | 2026-09-15 | Task、Attempt 与 DriverResource 状态机、`TaskRequestV1` 幂等摘要及 `BoundExecutionRepository` 事务接口设计。 | 已落地 |
| [task-source-consumers-design.md](task-source-consumers-design.md) | 2026-09-15 | WorkItem、Schedule 与 CI 自动化接入 `TaskAdmissionV1` 及共用 `readAttemptResult` 固定结果边界设计。 | 已落地 |
| [workflow-host-integration-design.md](workflow-host-integration-design.md) | 2026-09-15 | Botmux `workflow-core` 接入 Dutydeck 执行账本的 host 草案（`executionUnresolved`、`wait` 节点与 `answerCondition`）。 | 待确认（属 P4 草案，代码尚未引入 `workflow-core` 或实现 `executionUnresolved` / `answerCondition`，当前编排仍由 `work-items.ts` 承载） |

## 记忆

| 文档 | 日期 | 说明 | 状态 |
|---|---|---|---|
| [lark-memory-design.md](lark-memory-design.md) | 2026-09-25 | 飞书会话记忆设计（v3 同机器人群共享池 `groups`、私聊独立池、`MEMORY.md` 索引常驻、后台提取与三段式整理、旧账本懒迁移）。 | 已落地 |
| [lark-memory-research-20260917.md](lark-memory-research-20260917.md) | 2026-09-17 | Anthropic、字节内部与开源/商业共 21 个 Agent 记忆系统的对标调研与反例数据总结。 | 现行 |

## 部署与运维

| 文档 | 日期 | 说明 | 状态 |
|---|---|---|---|
| [legacy-import-cli.md](legacy-import-cli.md) | 2026-09-18 | Botmux 历史数据只读探测、脱敏计划与加密归档 CLI（`dutydeck migrate discover/plan/archive`）手册。 | 现行 |
| [database-execution.md](database-execution.md) | 2026-09-15 | 离线执行账本状态查询、升级与旧会话归档 CLI（`dutydeck database execution-status/upgrade-execution/retire-legacy`）手册。 | 现行 |
| [macos-database-control-design.md](macos-database-control-design.md) | 2026-09-15 | macOS 下基于 `IOPlatformUUID`、`kern.bootsessionuuid` 与 `ps lstart` 的数据库控制进程身份核验设计。 | 已落地 |

## 调研与对标

| 文档 | 日期 | 说明 | 状态 |
|---|---|---|---|
| [competitive-review-20260925.md](competitive-review-20260925.md) | 2026-09-25 | 同类产品对标、线上运行诊断（内网无鉴权暴露、Tag 库膨胀、审批堵队列、重启丢任务）与 P0–P2 优化计划。 | 现行 |
| [botmux-adoption-20260923.md](botmux-adoption-20260923.md) | 2026-09-23 | Botmux 改进吸收交付与上线迁移记录（systemd 前台自愈、restart ABI 检查、CLI 就绪与目录信任、tmux 环境清理、解散群过滤、登录态清理）。 | 已落地 |
| [botmux-review-20260923.md](botmux-review-20260923.md) | 2026-09-23 | Botmux 近 14 天（09-09 至 09-23）140 个提交的评估快照。 | 历史（评估项已由 [botmux-adoption-20260923.md](botmux-adoption-20260923.md) 落实取代，后续增量见 [competitive-review-20260925.md](competitive-review-20260925.md)） |
| [botmux-adoption-20260922.md](botmux-adoption-20260922.md) | 2026-09-22 | Botmux 五项改进（daemon 进程身份、Codex/TraeX 输入就绪、编辑补 @、显式 `--final` 答复、复制降级反馈）交付与验证记录。 | 已落地 |
| [botmux-adoption-plan-20260922.md](botmux-adoption-plan-20260922.md) | 2026-09-22 | 2026-09-22 Botmux 五项差异吸收的分工、设计与验收实施计划。 | 历史（被交付记录 [botmux-adoption-20260922.md](botmux-adoption-20260922.md) 取代） |
| [botmux-review-20260922.md](botmux-review-20260922.md) | 2026-09-22 | Botmux 近 7 天（09-15 至 09-22）83 个提交的前期评估快照。 | 历史（被 [botmux-adoption-20260922.md](botmux-adoption-20260922.md) 与 [botmux-review-20260923.md](botmux-review-20260923.md) 取代） |
| [feishu-dispatch-optimization-20260918.md](feishu-dispatch-optimization-20260918.md) | 2026-09-18 | 飞书入口指挥与调度差距调研及优化方案（原生斜杠命令注册、`/new --agent`、编排确认卡、`/agents`、`/steer`、`/queue`、卡片加急已实现）。 | 已落地 |
| [milo-speaking-patterns-20260918.md](milo-speaking-patterns-20260918.md) | 2026-09-18 | Milo 群内发言与持续跟进模式实证观察（持续委托、部分进展跟进、降频不丢事项）。 | 现行 |
| [team-tag-capability-gap-20260918.md](team-tag-capability-gap-20260918.md) | 2026-09-18 | Dutydeck 作为团队 Tag 基座的能力差距分析，含 `maxDecisionsPerHour` 判定预算闸门与 `ambient` 让路语义落地记录。 | 现行 |
| [team-tag-foundation-research-20260918.md](team-tag-foundation-research-20260918.md) | 2026-09-18 | 团队 Tag 底座前期代码核查与外部产品对标评估报告（基线 `a220928`）。 | 历史（已收敛为 [team-tag-foundation-plan.md](team-tag-foundation-plan.md) 并由 [generic-collaboration-implementation.md](generic-collaboration-implementation.md) 取代） |
| [compatibility-review-20260917.md](compatibility-review-20260917.md) | 2026-09-17 | 上游兼容性改动吸收报告（富文本顶层 `files[]`、`230031` 过期卡收敛、PTY Claude 配置优先级、`AutomationOverview` 轮询）。 | 已落地 |
| [full-product-execution.md](full-product-execution.md) | 2026-09-15 | 完整产品首轮（P0 任务运行账本、停止隔离、驱动契约、旧库升级归档、群权限与 Bot V2 存储组件）交付与验收记录。 | 已落地 |
| [full-product-parity-plan.md](full-product-parity-plan.md) | 2026-09-14 | Dutydeck 对标 Botmux 的完整产品能力规划与基线对照方案（E/C/W/A/X/M/U 七大域、P0–P9 批次）。 | 待确认（P0 核心账本与部分飞书/协作能力已落地见 [full-product-execution.md](full-product-execution.md)，其余扩展项在 09-15 暂停扩功能后是否继续推进待确认） |
