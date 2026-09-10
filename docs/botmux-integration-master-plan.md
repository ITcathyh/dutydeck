# BotMux → Dutydeck 集成主蓝图

> 状态：唯一实施蓝图；当前结论为 **NO-GO 真实 staging/apply，NO-GO 激活/切流**。
>
> 当前唯一允许推进的产品能力是安全前置设施与纯只读、零副作用的 plan。本文不包含实现代码，也不授权对当前两个生产 App 做真实写入、停启 listener 或切流。
>
> 本文已吸收 `botmux-integration-design-review.md` 与 `botmux-migration-safety-review.md`。早期三份审计/方案继续作为证据附件，不再决定实施顺序。

## 1. 当前裁决

### 1.1 当前允许与禁止

| 动作 | 当前裁决 | 说明 |
|---|---|---|
| 读取设计文档、实现 WP0 安全底座 | GO | 不接触真实 BotMux 运行态，不改变 Dutydeck listener |
| 实现纯只读 importer plan | GO | 只输出脱敏报告；零数据库写入、零 secret 输出、零外部副作用 |
| 建立私密 archive | NO-GO，等待 WP0–WP3 | archive 本身是写操作，需先具备安全存储、分类、稳定快照和补偿 |
| 把真实 BotMux 配置写进 Dutydeck | NO-GO | 当前没有安全的禁用态 Bot、跨仓储事务、CAS 和完整 secret-ref 边界 |
| 对当前 App 做 offline verify 后直接 activate | NO-GO | 当前两个 App 均有未关闭的行为 blocker |
| 同一生产 App 在线 shadow/canary | 永久禁止 | 同一 App 不能同时由 BotMux 与 Dutydeck 消费 |
| 当前 App 切流/回滚 | NO-GO | WP5/6 仅建设并在独立测试 App 演练机械；另行评审后才可能开放生产 |

当前实现必须显式报告：

```text
activation_ready_apps=0
production_cutover=NO_GO
allowed_mode=read_only_plan
```

不得通过 `--skip-schedules`、`--confirm-full-trust`、忽略历史 session、一次 Agent smoke test，或把 Hammer 当普通 Claude Agent 来改变此结论。

### 1.2 当前两个 App 的阻断事实

| App | 当前必需行为 | 当前处置 |
|---|---|---|
| `bdev-helper` | 2 个 oncall 群、per-App+Chat cwd、`topic` mention、1 条 enabled Schedule、遗留群工具意图复核、tmux 连续性、活跃话题去向 | 全部进入 readiness blocker；保持 BotMux active |
| `hammer` | Hammer full mode、enforced gates、prompt skill injection、默认 cwd、tmux 连续性、活跃话题去向 | Hammer policy 先私密归档并强制 Blocked；保持 BotMux active |
| retired TraeX | 只读历史 | 私密归档；不得生成 live Bot、listener 或 routing |

## 2. 产品原则

1. **先证明不会造成事故，再讨论迁移。** WP0–WP6 是生产激活的前置建设，不是激活授权。
2. **一个 App 只有一个 runtime owner。** “shadow”只能是离线解析/重放或独立测试 App，不能让同一 App 双 listener。
3. **Import、staging、verification、handoff 是四个不同权限域。** plan 不写库；archive 不产生配置；staged Bot 不可被 listener/runtime 发现；handoff 必须有双边 fencing。
4. **实际行为决定切流门槛。** source App 正在使用的能力必须 `required`；产品路线图 P1/P2 不能豁免 App blocker。
5. **保留不等于承接。** archive 可以防止数据丢失，但 Hammer、Schedule、活跃上下文等仍必须显示 Blocked，不能显示 Ready。
6. **没有静默降级。** tmux 不可退到普通 PTY；旧 topic 不可静默开空上下文；Hammer 不可退成 system prompt；未知群工具不得自动启用。
7. **权限按动作能力定义。** `can_talk/can_operate` 仅作 BotMux 兼容语义；Dutydeck 核心按 request/operate/manage 动作执行。
8. **运行配置冻结。** `RunSnapshot` 创建后不可变；默认值修改只影响新 Run。
9. **Secret 是不可见引用。** public DTO、redacted plan、RunSnapshot、ACPX persisted session、日志和 rollback history 不保存 secret value。
10. **远端事实与本地期望分离。** Lark membership、listener ownership 是事实；GroupBinding 是期望；runtime verification 是第三层状态。
11. **失败是持久产品状态。** 用户随时能看见当前哪一侧拥有 App、哪些消息/Schedule 需核对、下一步是重试、保持 BotMux 还是回滚。

## 3. 统一领域契约

WP0 冻结以下术语。后续工作包不得另建 `lark_bots`/`lark_chat_policies` 等竞争领域模型；物理表名可以不同，但必须经同一 repository 映射。

### 3.1 AgentDefinition

描述真实可运行 Agent：

- 业务 `id`、revision、source/provenance；
- `driver_kind`、`adapter_id`、protocol、runtime distribution/version；
- command/args/private env/startup profile 的 ref；
- backend policy、required capabilities、readiness；
- model/reasoning/cwd/permission defaults；
- role/execution policy ref 和真实 capability。

Agent ID 不再隐式决定 adapter。`pty+codex` 与 `acpx+codex` 是不同定义；缺 CLI/backend 必须 Blocked。

### 3.2 ChannelBot

描述 Lark 可见身份与默认策略：

- `app_id`、display/brand、`credential_ref`；
- default AgentDefinition、workspace、model/reasoning、role/execution policy；
- P2P/reply/mention 默认；
- explicit access policy、owner/admin principals、risk/card/group-tool defaults；
- lifecycle、health、runtime owner observation。

P0 必须存在一等 `staged_disabled` 状态：可以保存完整期望配置，但 listener、scheduler、session resolver 和 runtime catalog 都不能消费。`full_trust_confirmed` 只能由未来独立 handoff gate 设置，import 不能设置。

### 3.3 GroupBinding

自然键固定为 `(channel_bot_id, chat_id)`，同时表达三层状态：

1. remote fact：membership、metadata visibility、last sync；
2. desired policy：oncall、cwd、Agent/model/role、reply/mention、RBAC、group tools；
3. effective runtime：runtime owner、policy revision、last verified、degraded/blocker。

同一 chat 的不同 App 可以有不同 cwd 和权限。`channel_mappings` 继续只负责消息/卡片投递，不承载 GroupBinding。

### 3.4 RunSnapshot

仅在未来真实 Run 创建时生成，解析优先级：

```text
Run override > GroupBinding > ChannelBot > AgentDefinition > process default
```

固化四个实体 revision、driver/adapter/backend、workspace、model/reasoning、permission posture、role/execution policy、routing source、授权决策来源、group-tool policy 和 effective-config hash。只保存 secret/env ref 或 digest，不保存 value。

当前 importer 不创建 RunSnapshot、Session、Task 或 channel mapping；历史 BotMux session 也不能转换成 RunSnapshot。

### 3.5 动作 RBAC

Dutydeck P0 权限能力：

| Capability | 用户结果 |
|---|---|
| `request_task` | 发起任务、继续被允许的上下文 |
| `operate_own_task` | 取消、重试、继续本人发起的任务 |
| `operate_group_tasks` | 操作群内其他人的任务 |
| `manage_group_policy` | 修改群 cwd、Agent、路由、授权 |
| `manage_bot` | 修改 Bot 默认、credential ref、listener/handoff |

正交门禁：高风险执行、可写 terminal、群工具 send、跨群/跨 Bot dispatch、grant 管理、secret/full-trust 修改，不能由上述层级自动获得。

BotMux 映射：

- oncall/allowed group/grant 的 `can_talk` → `request_task`；默认不附带 operate。
- `allowedUsers`/owner 的 `can_operate` 不能一键映成全部管理权限；需按动作生成 private plan，并在 WP4 正向验证。
- 新建 Bot 可以默认 owner-only，但不能覆盖源 oncall 群“全群可请求、owner 管理”的行为。

所有 Lark listener、card callback、HTTP/CLI、terminal、群工具和管理 API 最终必须调用一个 policy evaluator；点击卡片时重新授权，不能只信任卡片创建时状态。

### 3.6 Schedule ownership 与 Hammer archive

Schedule 先建所有权与审计模型，不在 importer 中直接启用：

- `ScheduleDefinition`：source ID、ChannelBot/GroupBinding、表达式/时区、thread root/continuation、delivery、cwd、payload ref、enabled source state；
- `ScheduleOccurrence`：稳定 fire ID、planned/claimed/run/delivered 状态；
- `ScheduleOwnership`：`botmux_owned | handoff_pending | dutydeck_shadow | dutydeck_owned | rollback_pending`，带 generation/watermark；
- imported/archived schedule 永远保持 `botmux_owned`，除非未来独立 runtime/handoff gate 完成。

Hammer 配置保存为版本化、私密 `ArchivedCapability`：`enabled/full/enforce_gates/skills_injection` 仅供 diff/readiness，不能被 prompt/runtime 消费。只要没有 Hammer 行为级实现和拒绝路径 E2E，Hammer ChannelBot 永远 Blocked。

## 4. 指纹、敏感数据与历史边界

### 4.1 三种不同水位

- `apply_fingerprint`：只覆盖权威静态配置及归一化默认值；本计划阶段不执行 apply，但先固定契约。
- `archive_snapshot_id`：动态历史的一致性/尽力快照 ID，不参与配置 stale 判断。
- `cutover_watermark`：未来消息和 Schedule 去重边界，由 WP5/6 管理。

不能对仍在变化的整个 BotMux root 计算一个 fingerprint 后要求完全稳定。

### 4.2 读取与 archive 安全

- `BOTS_CONFIG` 可合法指向 home 外文件；仅本地 CLI 接受精确路径。
- JSON 使用 no-follow 文件描述符读取，前后 fstat inode/size/mtime；非普通文件、owner/mode 异常或变化时 fail closed。
- data root 按 `SESSION_DATA_DIR → .data-dir breadcrumb → default`；per-bot Schedule 从推导的 BOT_HOME 读取。
- SQLite/反馈 WAL 只能用 online backup/read transaction；不能拆拷 DB/WAL/SHM。
- public digest 排除 secret bytes；私密完整性使用本机 key HMAC 或 opaque snapshot ID，不公开单个 secret 普通 hash。
- private archive 目录 `0700`、文件 `0600`；不进 git、普通 API、plan diff。

### 4.3 历史不是 live 配置

- 28 条 session 显示为 `source_status` 与 `liveness=unknown`；未验证 OS pane、CLI native session 和 frozen launch snapshot 前禁止 attach。
- P0 不提供通用 `--resume-sessions`；历史 App/Chat/root/CLI ID 不能变成 Dutydeck channel mapping。
- 30 个 workflow grilling run 是敏感 incomplete draft，只归档，不创建 Task/Run，不继续 goal。
- 不迁 BotMux queue、dedup、turn marks/sends、frozen card、PID/port/lock/runtime token。
- retired TraeX、backup 和 identity cache 只用于 orphan 检测，不生成 live entity。
- 任何可能继续收到回复的旧 topic 在未来切流前必须选择：可验证 adopt/native resume、用户确认的 summary restart、cold archive，或不切 App。静默新上下文永久禁止。

## 5. 强制前置工作包

所有包都是 P0 前置，不是 production activation 步骤。编号同时是**强制合并顺序**。

### WP0：安全存储、CAS、SecretRef、公开 API 脱敏、禁用态 Bot

目标：先建立“即使未来写入，也不能半写、泄密或被 runtime 误消费”的底座。

主责边界：shared contracts、storage migrations/repositories/transactions、secret provider boundary、public serializers、ChannelBot lifecycle gate。

必须交付：

- AgentDefinition、ChannelBot、GroupBinding、RunSnapshot、Principal、Schedule ownership、import provenance 的 versioned contract。
- storage-owned batch transaction、entity revision/CAS、stable `source_instance_id + entity_kind + source_key`、normalized source hash、last applied target hash。
- rollback-by-ref：before version 只保存旧 secret ref；不复制 plaintext secret。
- secret prepare → DB commit → finalize/compensate 协议；孤儿 secret 不可被任何 active entity 引用。
- `private_plan` 与 `redacted_report` 物理/接口隔离；公开报告只含计数、字段 path、opaque entity ref、blocker。
- Agent/session/import/error DTO allowlist serializer；`GET /api/agents` 不再返回 env、command、args、system prompt、secret ref 内容。
- `staged_disabled` ChannelBot：允许保存期望 Agent/策略且 `full_trust=false`，但 listener/scheduler/runtime 必须拒绝消费。
- 聚合 `configs['lark.bots']` 至少进入单写者+revision CAS；长期由 ChannelBot repository 接管，禁止无版本 RMW。

验收：

- 任一跨实体写入点故障后零部分配置；CAS 能发现人工并发修改。
- secret prepare、DB commit、finalize 三处故障均可重试/补偿，不产生 active 半配置。
- API、CLI、日志、异常、telemetry、test snapshot 无 App Secret、PII 全值、env、prompt、token。
- 保存完整 staged Bot 不要求/设置 full trust，且无法通过 listener、Schedule 或 session resolver 创建 Run。
- 当前真实数据仍未导入；WP0 完成后 production activation 仍为 NO-GO。

### WP1：核心数据模型、RBAC、oncall、mention、group tools、Schedule ownership、Hammer archive

依赖：WP0。

目标：完整表达当前 source 行为和 blocker，但不启动任何 runtime。

主责边界：domain repositories/read models、effective-config resolver contract、policy evaluator、GroupBinding 三层状态、Schedule/Hammer archive schema。

必须交付：

- 四核心实体与 revision；effective precedence 的纯函数 resolver；RunSnapshot builder contract 但不由 importer 调用。
- `(app_id, chat_id)` GroupBinding；oncall whole-group request 与 owner operate/manage 分离。
- action RBAC 及唯一 policy evaluator；兼容报告可显示 `can_talk/can_operate`，runtime 只按明确 capability 执行。
- mention `always/topic/never/ambient`、reply/session scope、per-group cwd、group-tool read/discover/send 的期望模型。
- 遗留 gateway 标记为 `unknown_external_legacy`，`enabled=false`、`allow_send=false`，不创建 capability。
- ScheduleDefinition/Occurrence/Ownership；完整保留 expression、timezone、thread root/continuation、delivery、cwd、payload ref 和 source enabled state。
- Hammer ArchivedCapability 与 hard blocker；不得注入 system prompt、Agent env 或 runtime。
- GroupBinding read model 同时展示 remote fact/desired policy/effective runtime，不用一张布尔矩阵伪装健康。

验收：

- 两个 oncall binding 可表达不同 App+Chat cwd；同一 chat 的其他 App 不继承。
- oncall 普通成员只有 request；不能操作任务、改 cwd/policy、拿 terminal 或启用 group-tool send。
- BotMux 缺省 `chat-topic` 被物化，`topic` mention 有自然语言 effective preview。
- 唯一 enabled Schedule 被表达为 `botmux_owned`，任何 Dutydeck tick/Run 创建尝试被拒绝。
- Hammer capability 可安全 readback/diff，但任何 Ready/activate 计算必为 Blocked。
- WP1 完成后没有真实 Bot/Group/Schedule 写入，production activation 仍为 NO-GO。

### WP2：Persistent backend 生产接线

依赖：WP0、WP1 的 AgentDefinition/backend contract。

目标：关闭“package 存在但 production 仍使用 PtyBackend”的事实缺口，只保证 Dutydeck-owned 测试 Run 的进程连续性，不 adopt BotMux legacy session。

主责边界：session-backends、pty-driver、server composition root 的 backend selector/injection、ownership marker、startup reconcile。

必须交付：

- `apps/server/src/service.ts` 创建 `PtyCliDriver` 时显式选择并注入 tmux；imported tmux policy 缺 readiness 时硬失败，不退 PTY。
- backend identity/ownership marker 与 Run/Session 关联；命名空间防止 attach 无关 pane。
- server restart reconcile：验证 pane/process、ownership、CLI identity；成功 attach 原实例，失败 degraded，不 spawn 冒充恢复。
- stop/restart 只 detach；显式 terminate 才 kill。
- orphan、重复 attach、pane 已退出、版本不兼容的稳定诊断。

验收：

- 使用隔离测试 Agent 真正启动 CLI，记录 PID/pane/backend ID，终止并重启 daemon 后三者不变、无第二进程、同一事件流继续。
- tmux 缺失/不可用时硬失败；只有显式 non-persistent 测试 Agent 可用 PtyBackend，并清楚标记不可恢复。
- DB Session 行单独存在不能让测试通过；必须提供 OS process/pane 证据。
- 不读取、attach 或改写 28 条 BotMux session；production activation 仍为 NO-GO。

### WP3：Importer 仅 dry-run + 私密 archive

依赖：WP0–WP2 contract；可提前开发 source reader，但只能在此前置合并后接入主干。

目标：实现安全发现、分类和 archive，不提供 apply/verify/activate/rollback 配置命令。

唯一允许的命令面：

```text
dutydeck import botmux plan \
  [--bots-config <exact-file>] [--data-dir <dir>] [--emit-redacted <file>]

dutydeck import botmux archive --plan-id <id>
```

`archive` 只写 WP0 私密 archive/provenance，不创建 AgentDefinition、ChannelBot、GroupBinding、Principal、Schedule runtime、Session、Task、Run 或 channel mapping。

必须交付：

- 真实 source resolution、no-follow/fstat snapshot、三类 fingerprint/watermark contract、artifact coverage 和 unknown fail closed。
- BotMux effective-default normalization；backup/cache 不参与 active merge。
- redacted report 与 private archive 分离；private archive 也不复制禁止迁移的 cookie/runtime token/socket/lock。
- legacy session/workflow/feedback archive 遵守敏感数据边界；SQLite 使用 online backup。
- 不存在 `--resume-sessions`、`--skip-schedules` 解锁、`--confirm-full-trust`、`apply` 或 `activate`。

本机 golden plan 必须精确报告：

```text
current_channel_bots=2
retired_channel_bots=1
oncall_group_bindings=2
enabled_schedules=1
distinct_owner_locators=1
legacy_session_records=28
workflow_drafts=30
activation_ready_apps=0
production_cutover=NO_GO
```

验收：

- plan 对 Dutydeck DB、BotMux source、listener、Schedule 和 Lark 零写入/零副作用；连续两次静态 apply fingerprint 一致。
- archive 只产生 private artifact/provenance；公开 API 不能读取 raw archive。
- 所有 source 项有 disposition；未知项给出安全下一步，不能 warning 后 Ready。
- Hammer、Schedule、活跃-looking session、遗留 gateway 都显示 blocker/needs review，不被 archive 状态消除。
- retired TraeX 不生成 live entity；任何真实 config staging/apply 仍不可能执行。

### WP4：Identity 与 readiness preflight

依赖：WP0–WP3。

目标：以只读方式证明身份、远端 membership、workspace 和 Agent readiness；inconclusive 只能形成报告，不能提升状态。

主责边界：Lark identity resolver、credential-ref probe、membership/scope readback、workspace/CLI login/backend readiness probes、redacted result store。

必须交付：

- Principal 唯一 scope `(app_id, identity_kind, identity_value)`；email/mobile/`on_` 是 locator，最终主体在每个目标 App 下分别正向解析。
- `ou_` 永不跨 App 复制；当前 schema 不能表达 `on_` 时不写入 allowedUsers。
- credential ref 可用性、Lark scope、Bot membership/metadata visibility 的只读探测。
- cwd 同时处理 private lexical path、absolute resolved path、canonical fingerprint、exists/directory/allowed 状态；`~` 不原样写，也不失败后回退 home。
- Agent binary/version、进程用户、CLI 登录态、workspace 可读、backend readiness 的 smoke preflight；不连接生产 App listener。
- 可能活跃 topic 的 disposition 清单：`live_attachable/native_resumable/summary_handoff/cold_archive/unknown_needs_review` 仅作为判断，不自动 adopt。

验收：

- 两个测试 App 证明相同 locator 分别解析且 App-scoped identity 不串；network/scope inconclusive 明确 Blocked。
- import/API 错误只显示条目序号、类型和 opaque ref，不回显邮箱/手机号/open ID 全值。
- 两个 oncall 群分别验证 membership/readability；本地历史不能替代远端事实。
- 所有 cwd 可解释 lexical/resolved/canonical 差异，路径缺失或越 workspace 时 fail closed。
- smoke test 使用独立测试 App/本地 Run，不创建生产 listener、Schedule 或 ChannelBot。
- 当前两个生产 App 仍显示 Blocked；WP4 不是 activation preflight pass 的授权。

### WP5：跨系统 lease 与双 listener fencing

依赖：WP0–WP4。

目标：解决“Dutydeck 单边 lease 无法阻止 BotMux 重连”。只在 supervisor/隔离测试 App 验证，不切当前 App。

主责边界：shared supervisor/fencing adapter、per-App drain acknowledgement、generation/watermark protocol、listener start guard。

必须交付：

- BotMux 与 Dutydeck 都可观察或由共同 supervisor 强制的唯一 App generation；只持有当前 fence 的 runtime 能建 listener。
- per-App drain：停止接新事件、等待/处置 running/queued work、确认连接断开、记录 source watermark。
- Dutydeck listener start 前验证 source fenced、credential/scope/readiness、target generation；失败不连接。
- BotMux/Dutydeck restart 都不能绕过 fence；stale generation 拒绝启动。
- Schedule ownership 使用同一 generation，但此阶段不启用当前 source Schedule 的 Dutydeck executor。
- 如果现有 BotMux 无法 per-App drain，结果必须是 Blocked；不能用整套停机或同 App 双消费替代验收。

验收：

- 独立测试 App 上强制并发启动两边，只有一边能建立 listener；反复重启仍成立。
- source drain 后 target 未接管的静默窗口可见且可恢复 source；watermark 持久。
- stale holder、supervisor 不可达、ack 丢失都 fail closed，不靠超时猜测 ownership。
- 证明 Dutydeck DB 中的 CutoverLease 单独存在不能通过测试。
- 不对当前两个生产 App 执行 drain/fence；production activation 仍为 NO-GO。

### WP6：离线 shadow、受控 handoff 与 rollback 机械

依赖：WP0–WP5；最后合并。

目标：在独立测试 App 建立完整迁移状态机、失败体验和回滚证据。此包结束不等于当前生产 App 可切流。

状态术语统一为：

```text
discovered
  -> planned
  -> archived
  -> verified_offline
  -> ready_for_handoff
  -> draining_source
  -> target_observation
  -> migration_finalized

任何 blocker -> blocked
任何部分失败 -> failed_rolled_back | failed_compensation_required
```

“shadow”定义：

- offline effective-config/RBAC/replay，不消费生产 App event；或
- 独立测试 App 的真实消息；
- 绝不代表同一 App 的并行 consumer、单群灰度或百分比 canary。

必须交付：

- 持久迁移状态和八步旅程：发现、选择 App、检查变化、解决 blocker、离线验证、准备 handoff、整 App observation、完成/回滚。
- App readiness 两维：`product_priority` 与 `cutover_requirement=required|review|archive_allowed|not_used`。
- 准备页面列出 running/queued work、未完成 delivery、下一次 Schedule、活跃 topic disposition、预计静默窗口和回滚能力。
- failure matrix：transaction 前/中、source drain 前/后、target connect 前/后、已接受消息/已启动 Run、observation 期的默认动作和人工清理。
- rollback 机械：target stop/drain → target watermark → fence target → restore source → 权限/去重验证；不把远端动作宣传成 SQLite 事务。
- GroupBinding 运营视图展示 remote fact/desired/effective 三层，并用自然语言呈现用户结果。
- no public `activate`/`cutover` 命令；只提供 feature-flagged test harness 和 operator evidence。生产开放需新的独立评审与授权。

验收：

- 独立测试 App 完成正向 handoff 与反向 rollback；没有双 listener、消息回环或静默 ownership。
- 在 drain 前、drain 后未接管、target 已连接未收消息、已创建 Run 四阶段注入故障，状态和用户下一步明确。
- rollback 前可见任务、delivery、Schedule、配置 CAS 冲突和外部副作用；有人工修改时不盲目覆盖。
- 旧 topic 不会静默新开上下文；unknown disposition 阻断 ready_for_handoff。
- Schedule 没有唯一 ownership/executor/occurrence 去重时，App 阻断；不得在 WP6 临时跳过。
- Hammer archive 仍导致 Hammer App Blocked；一次 Claude smoke reply 不能解除。
- WP6 完成后的默认报告仍为 `production_cutover=NO_GO`，直到新的 production release review 明确批准。

## 6. 当前 NO-GO blocker 如何落入工作包

| Blocker | 前置 WP | 关闭含义 |
|---|---|---|
| 公开 Agent/API 可能泄露 env/command | WP0 | allowlist serializer 与泄漏测试通过 |
| 无 disabled 完整 Bot 状态；保存默认 Agent 会要求 full trust | WP0 | staged entity 可保存且 runtime 永不消费 |
| 无跨 repository transaction/CAS/可靠 rollback | WP0 | batch、revision CAS、provenance、rollback-by-ref 通过故障注入 |
| 无 SecretRef 跨事务补偿 | WP0 | prepare/finalize/compensation 完整，不复制 plaintext |
| oncall 与 talk/operate 权限不等价 | WP1 | action RBAC 和唯一 evaluator 表达且拒绝路径通过 |
| per-App+Chat cwd/mention/group tools 缺失 | WP1 | GroupBinding 三层模型完整；legacy tools 默认全禁用 |
| enabled Schedule 会双跑/漏跑 | WP1、WP5、未来 executor gate | ownership/occurrence/generation 可表达；没有 executor 仍保持 App Blocked |
| Hammer full/gates/injection 缺失 | WP1、未来 Hammer runtime gate | 安全 archive + hard blocker；archive 不算关闭运行 blocker |
| production 仍是 PtyBackend | WP2 | 显式 tmux 注入和真实 restart/reattach E2E |
| source snapshot TOCTOU、root 永久 stale | WP3 | no-follow 稳定读与三种 fingerprint/watermark 分离 |
| 历史 session/workflow 含敏感数据或被误转 live | WP3 | private archive、liveness unknown、无 resume/apply 路径 |
| App-scoped identity/membership/cwd/login 未正向验证 | WP4 | 只读正向 probe；inconclusive 仍 Blocked |
| Dutydeck 单边 lease 无法阻止 BotMux | WP5 | 共同 supervisor/fence 和 per-App drain 真验证 |
| 活跃 topic 去向、运行中失败、用户可见回滚未定义 | WP4、WP6 | disposition + 持久状态机 + test App 故障演练 |

表中的“未来 executor/Hammer runtime gate”明确表示：WP0–WP6 可以把风险变成可见、可阻断、可演练的状态，但不会自动获得当前生产 App 激活资格。

## 7. 最终执行顺序与可并行关系

### 7.1 强制合并顺序

```text
WP0 安全底座
  → WP1 领域模型与 blocker 表达
  → WP2 persistent backend
  → WP3 dry-run + archive only
  → WP4 identity/readiness preflight
  → WP5 cross-system fencing
  → WP6 shadow/handoff/rollback test harness
  → 新的 production release review（不在本文授权范围）
```

不得跳过 WP0 先做真实 importer；不得跳过 WP1 直接把群配置塞入 legacy JSON；不得在 WP5 前实现公开 cutover；不得用 WP6 test App 成功替代当前 App capability gate。

### 7.2 可并行开发，但不可乱序合并

| 可并行项 | 条件 | 合并约束 |
|---|---|---|
| WP1 schema 设计 与 WP2 backend spike | WP0 contract 已冻结 | WP2 只能用 WP1 定义的 backend identity；正式合并仍 WP1→WP2 |
| WP3 source reader/parser 与 WP1/WP2 | 仅使用脱敏 fixture、纯函数、零写入 | archive/repository 接线必须等 WP0–WP2 合并 |
| WP4 Lark probe 原型 与 WP3 parser | 仅独立测试 App、结果不落 active config | 正式 result store/Principal scope 依赖 WP0/WP1 |
| WP5 supervisor/fencing 协议设计 与 WP4 | 只做模拟/隔离 App | 真实 listener guard 必须等 identity/readiness contract 稳定 |
| WP6 UI 状态原型 与 WP3–WP5 | 使用静态脱敏状态 fixture | 不得提供真实 activate/cutover action；正式合并最后 |

### 7.3 每个实现 subagent 的共同交付格式

每个 WP 的实现任务必须报告：

- 修改文件/包与未触碰边界；
- schema/API/state-machine 版本；
- 允许路径与拒绝路径测试；
- 故障注入、secret/PII、并发/CAS 或真实 OS process 证据；
- 当前仍未关闭的 production blocker；
- 明确声明“未执行真实 App staging/activation/cutover”。

任何 subagent 如果发现需要连接、停止、发消息、启用 Schedule 或修改当前 BotMux/Lark App，必须停止并请求新的授权；本蓝图不提供该权限。

## 8. 进入下一次 production release review 的最低证据

WP0–WP6 全部完成后，也只允许申请新的 release review。申请材料至少包含：

- 2 Bot、2 oncall、1 enabled Schedule 的稳定脱敏 plan，以及 `activation_ready_apps=0` 的正确 blocker；
- staged-disabled、CAS、SecretRef compensation、公开 DTO 防泄漏的故障证据；
- action RBAC、GroupBinding、mention/group-tools 的允许与拒绝证据；
- tmux production injection 和真实 daemon restart/reattach 的 OS 证据；
- 两个 App 的 identity/membership/cwd/CLI login preflight 结果，inconclusive 项不得被忽略；
- 独立测试 App 的双 listener fencing、handoff 和 rollback 故障演练；
- 当前 25 条 metadata-active session 的逐 topic disposition 计划；
- bdev-helper Schedule executor/ownership/dedup/delivery 的行为级方案与测试；
- Hammer full/gates/prompt skill injection 的行为级实现与 gate 拒绝 E2E，或继续保留 Hammer App 在 BotMux；
- 明确的人工批准，决定哪些 App 继续 BotMux、哪些进入未来受控 observation。

在新评审批准前，主蓝图的最终状态保持不变：**BotMux 继续服务当前 App；Dutydeck 只做安全前置、只读 plan、私密 archive 与独立测试 App 演练。**
