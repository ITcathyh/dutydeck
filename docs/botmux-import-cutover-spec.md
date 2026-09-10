# Botmux 只读 Import、Preflight 与 Cutover Fencing 规格

> WP3b 当前可执行面以 [Botmux 只读迁移 CLI](./botmux-import-cli.md) 为准：仅 `dutydeck botmux discover|plan|archive`，不接 Dutydeck DB 或运行态。本文其余命令面是后续安全设计，不代表当前 CLI 已实现。
>
> 状态：设计规格，不包含实现。
>
> 安全目标：读取并验证 Botmux 资产，生成私密迁移计划、历史归档和可审计 cutover packet；不修改 Botmux，不写入 Dutydeck live Agent/Lark/Schedule 配置，不启动或停止 listener，不启用 schedule，不确认 full trust。
>
> 本文不记录任何 Secret、token、cookie、邮箱全文、手机号、App 视角身份值、消息正文、schedule prompt 或 workflow goal。

## 1. 不变量与结论

本规格定义的 CLI 是只读控制面，不是接管工具。允许的唯一写入是 Dutydeck 私有 control store 中的 plan/preflight 记录、受保护 archive 和 cutover packet；这些记录不能被 runtime 当作 live 配置读取。

以下不变量不可通过参数绕过：

1. Importer 没有 `apply`、`activate`、`listen`、`enable-schedule` 或 `confirm-full-trust` 命令。
2. 所有发现到的 Bot 默认 `target_state=staged_only`；任何输出都不能使 listener 或 scheduler 生效。
3. 同一个生产 Lark App 不允许 Botmux 与 Dutydeck 同时建立事件连接；“shadow”不等于第二个生产 listener。
4. Lark listener 与 Schedule writer 分别只有一个 owner；listener 停止不代表 scheduler 已停止。
5. `ou_` 只在产生它的 App 下有效；identity cache 永远不是授权事实源。
6. 群策略主键为 `(app_id, chat_id)`，不能折叠成纯 `chat_id`。
7. Botmux session/workflow 历史默认 archive-only，不创建 live Session/Task/Run，不自动 resume。
8. Secret bytes 不进入 manifest、plan digest、diff、日志、异常、provenance 或 rollback history。
9. `metadata-active` 不等于进程存活；本地配置存在不等于 Bot 仍在远端群内。
10. 任一未知 artifact、身份 inconclusive、双 listener、双 schedule writer 或 stale fingerprint 都使 preflight fail closed。

本机基线应报告 2 个当前 Bot、2 条 oncall、1 条 enabled schedule、1 个空 team、28 条 session metadata、30 条 workflow 草稿；roles/connectors/plugins 均为 0。由于两个当前 App 都有能力 blocker，`activation_ready_apps` 必须为 0。

## 2. 命令面

### 2.1 Source discovery

```text
dutydeck import botmux discover \
  [--source-home <dir>] \
  [--bots-config <exact-file>] \
  [--data-dir <dir>] \
  [--output json|text]
```

行为：

- 只解析真实源寻址：显式 CLI path → `BOTS_CONFIG` 精确文件 → 默认 registry；显式 data dir → `SESSION_DATA_DIR` → `.data-dir` breadcrumb → 默认 data dir。
- 输出数据根、配置根和 BOT_HOME 的 opaque path ref、artifact 分类计数、未知项和权限异常。
- 不输出绝对路径到公共报告；私密 control store 可保存规范路径。
- 不读取后回显任何凭据或正文。

### 2.2 Plan

```text
dutydeck import botmux plan \
  --discovery-id <id> \
  [--include-retired-in-archive] \
  [--include-history-archive] \
  [--emit-redacted <file>]
```

行为：

- 生成 normalized entity inventory、capability usage、target compatibility、blocker、secret requirement 和 artifact coverage。
- `--emit-redacted` 只写脱敏 report，mode `0600`；完整 private plan 只进 `0700` control store。
- retired Bot、history、workflow 草稿只影响 archive plan，不进入 live entity plan。
- 重复 plan 在权威配置和 target baseline 不变时产生同一 `plan_digest`。

### 2.3 Archive snapshot

```text
dutydeck import botmux archive \
  --plan-id <id> \
  --destination <private-dir> \
  [--history sessions,workflows,usage,feedback,attachments]
```

行为：

- 只复制到私有 archive；不修改源文件，不导入 live schema。
- 目录 mode `0700`、文件 mode `0600`；支持时使用 envelope encryption。
- feedback SQLite 使用 online backup；JSON/JSONL 用 no-follow 文件描述符读取并验证稳定性。
- 日志、heapshot、OAuth/MCP/VC credential、PID/lock/socket 默认 `excluded_with_reason`，不自动归档。

### 2.4 Identity and chat preflight

```text
dutydeck cutover botmux preflight \
  --plan-id <id> \
  --app-ref <opaque-ref> \
  [--identity-check] \
  [--chat-check] \
  [--backend-check] \
  [--schedule-check]
```

行为：

- 允许用目标 App credential 做只读 `get bot/contact/chat/member/permission` 校验。
- 不发送消息，不创建群，不邀请成员，不启动 Agent，不消费 schedule。
- 结果写入带有效期的 preflight evidence；过期或 credential revision 变化后必须重验。

### 2.5 Shadow plan

```text
dutydeck cutover botmux shadow-plan \
  --preflight-id <id> \
  --mode parser|policy|independent-test-app
```

只生成 shadow 方案，不执行生产 listener：

- `parser`：比较 Botmux effective config 与 importer normalized config。
- `policy`：对脱敏事件 metadata 做纯函数路由/权限对照，不运行 Agent、不发送消息。
- `independent-test-app`：生成独立测试 App/Chat 的测试清单，实际执行由其它受审工具完成。

禁止 `production-app-listener`、生产消息回放、生产 schedule fire、生产 send probe。

### 2.6 Fence inspection

```text
dutydeck cutover botmux fence-check \
  --preflight-id <id> \
  --app-ref <opaque-ref>

dutydeck cutover botmux cutover-packet \
  --preflight-id <id> \
  --app-ref <opaque-ref> \
  --output <private-file>
```

`fence-check` 只观察 listener/scheduler owner、source daemon、目标 listener 状态和 lease generation。`cutover-packet` 只生成外部 runbook 所需的签名私密 artifact，不获取 lease、不停源、不启目标。

### 2.7 Rollback planning

```text
dutydeck cutover botmux rollback-plan \
  --cutover-packet <private-file> \
  --current-observation-id <id>
```

只生成反向 drain/fence/watermark/dedup 清单，不执行运行回滚或数据库回滚。

### 2.8 禁止命令与参数

以下调用必须返回 `FORBIDDEN_MUTATION`：

```text
dutydeck import botmux apply ...
dutydeck import botmux activate ...
dutydeck import botmux --confirm-full-trust ...
dutydeck import botmux --resume-sessions ...
dutydeck cutover botmux acquire-lease ...
dutydeck cutover botmux start-listener ...
dutydeck cutover botmux enable-schedule ...
```

### 2.9 Exit code

| Code | 含义 |
|---:|---|
| 0 | 只读命令成功，检查项通过 |
| 2 | 参数或 manifest schema 错误 |
| 3 | capability blocker；只能继续 archive/修复 |
| 4 | credential/identity 不足或 inconclusive |
| 5 | authoritative source fingerprint stale |
| 6 | target baseline/provenance conflict |
| 7 | listener fencing 不成立或发现双 consumer |
| 8 | archive snapshot 不一致/失败 |
| 9 | schedule single-writer 不成立 |
| 10 | 请求了本规格禁止的 mutation/activation |

## 3. Manifest 与报告分层

### 3.1 三种 artifact

| Artifact | 内容 | 可见范围 |
|---|---|---|
| Private plan | 完整 locator refs、私密 path refs、entity refs、内部 digest refs | 本机 control store only |
| Redacted report | 数量、字段路径、opaque refs、状态、blocker | CLI/API authenticated viewer |
| Cutover packet | preflight evidence、fence/lease expectation、watermark slots、rollback 顺序 | 本机 operator/supervisor only |

三者都不保存 Secret plaintext。Private plan 需要身份值时只保存 secret/principal ref，不保存可公开的普通 hash。

### 3.2 Private manifest schema

所有持久化键使用 `snake_case`：

```json
{
  "schema_version": 1,
  "plan_id": "<opaque>",
  "created_at": "<iso8601>",
  "source": {
    "kind": "botmux",
    "source_instance_id": "<opaque>",
    "config_locator_ref": "<private-ref>",
    "data_locator_ref": "<private-ref>",
    "apply_fingerprint": "<opaque>",
    "archive_snapshot_id": null
  },
  "target": {
    "dutydeck_instance_id": "<opaque>",
    "baseline_fingerprint": "<opaque>",
    "live_write_allowed": false
  },
  "artifacts": [],
  "entities": {
    "agents": [],
    "lark_apps": [],
    "principals": [],
    "chat_policies": [],
    "schedules": [],
    "legacy_sessions": [],
    "legacy_workflows": []
  },
  "capability_usage": [],
  "secret_requirements": [],
  "identity_validations": [],
  "chat_validations": [],
  "fencing": {
    "listener": {},
    "schedule_writer": {}
  },
  "watermarks": {
    "lark_events": null,
    "turns": null,
    "deliveries": null,
    "schedules": []
  },
  "blockers": [],
  "warnings": [],
  "forbidden_actions": [
    "write_live_config",
    "enable_listener",
    "enable_schedule",
    "confirm_full_trust",
    "resume_legacy_session"
  ]
}
```

### 3.3 Artifact record

```ts
interface ImportArtifact {
  artifact_id: string
  relative_path_ref: string
  kind: string
  authority: 'authoritative' | 'derived' | 'runtime' | 'historical' | 'unknown'
  sensitivity: 'secret' | 'personal' | 'business' | 'runtime' | 'public_metadata'
  disposition: 'mapped' | 'archive_only' | 'rebuild' | 'runtime_only' | 'excluded_with_reason' | 'blocked_unknown'
  stat_ref: string
  private_digest_ref?: string
  exclusion_reason?: string
}
```

任何未分类文件或未知字段都落 `blocked_unknown`，不能只给 warning。

### 3.4 Entity record

```ts
interface ImportEntity {
  entity_ref: string
  entity_kind: string
  source_key_ref: string
  natural_key_ref?: string
  normalized_source_hash: string
  target_key_ref?: string
  target_baseline_hash?: string
  provenance_status: 'new' | 'managed_unchanged' | 'managed_changed' | 'manual_conflict' | 'unsupported'
  desired_state: 'staged_only' | 'archive_only' | 'excluded'
  blocker_codes: string[]
}
```

`desired_state` 不包含 active/listening/enabled。

## 4. Fingerprint 设计

### 4.1 Source instance identity

`source_instance_id` 必须在多次 plan 间稳定，且不依赖会变化的文件内容。建议第一次发现时生成随机 ID，存于 Dutydeck private source registry，并以受保护的 locator identity、Botmux deployment evidence 和 operator confirmation关联。

不得把绝对路径、App Secret hash、邮箱 hash 或整个 source root hash直接当 source ID。

### 4.2 Apply fingerprint

`apply_fingerprint` 只覆盖会影响未来 live 配置的权威输入：

- 当前 Bot registry 及 materialized defaults；
- 全局配置中被当前 App 实际使用的字段；
- per-bot schedule 定义；
- team/role/grant/chat policy 等配置 store；
- 本次 parser/schema version。

Secret 字段在 canonical document 中替换为 `{present, secret_ref_version}`，不放 Secret bytes。若必须检测源 Secret 在 plan 后变化，只在 private control store 保存 keyed HMAC；公开 digest 永不包含该 HMAC。

### 4.3 Archive snapshot ID

`archive_snapshot_id` 覆盖实际归档的 immutable copy，而不是活跃 source root。每个 artifact 的 content digest 仅在 private index 中保存；公开报告只显示 snapshot ID、数量、总大小和一致性状态。

动态 runtime 文件变化不会使 `apply_fingerprint` stale，但会产生新的 archive snapshot。

### 4.4 Target baseline fingerprint

按 entity 记录 target baseline hash，而不是只存一个全库 hash：

- Lark App：`app_id` 自然键对应的 public/private revision refs；
- Agent profile：稳定 source instance + source profile key；
- Chat policy：`app_id + chat_id`；
- Principal：`app_id + identity_kind + identity_ref`；
- Schedule：source namespace + source schedule ID。

preflight 只要发现目标当前 hash 与 baseline 不同，就返回 conflict/stale；只读工具不覆盖。

### 4.5 Plan digest

`plan_digest` 包含 schema/parser version、source instance、apply fingerprint、entity hashes、target baseline、blocker set 和 required validation IDs。它不包含 archive snapshot、volatile watermarks、Secret bytes或 PII plaintext。

## 5. Source snapshot 与 archive

### 5.1 文件快照

1. `lstat` 并拒绝非普通文件。
2. 以 no-follow 模式打开，保存 descriptor。
3. 读取前后 `fstat`，校验 device/inode/size/mtime 未变。
4. 多权威文件按固定顺序获取 Botmux 兼容读锁；无法锁时读取后重验并有限重试。
5. 源发生变化时返回 stale，不拼接不同时间点的配置。

`BOTS_CONFIG` 可以在默认 home 外；仅允许本地 CLI 显式 locator 或 Botmux 真实寻址结果，Web/API 不接受任意服务器路径。

### 5.2 SQLite

- 使用 SQLite online backup/read transaction，包含 WAL 已提交页。
- 不复制正在变化的 main/WAL/SHM 组合。
- archive index 记录 schema version、表名和行数；不把行内容写入 report。

### 5.3 History boundary

| 类型 | disposition | 禁止行为 |
|---|---|---|
| 28 条 session metadata | archive-only | 不创建 Session/channel mapping，不按 `active` 恢复进程 |
| CLI transcript/native history | archive-only 或保留源端 | 不跨 adapter 自动 resume |
| 30 条 grilling workflow | archive-only | 不创建 Task/Run，不继续 goal |
| retired Bot/cache | archive-only | 不自动创建 Bot/Agent |
| queue/dedup/turn marks/card state | runtime-only | 不导入目标 runtime namespace |
| feedback/usage | optional archive | 不当作 live permission/config |

Legacy catalog 只能返回 opaque source refs、时间、脱敏状态和 archive availability。原始 prompt、goal、identity、message ID、card nonce、PID/port、resume ID 不进普通 API。

## 6. Identity 与 Chat validation

### 6.1 Identity state machine

```text
discovered_locator
  -> target_lookup_pending
  -> verified_for_target_app
  -> preflight_valid

lookup transient/scope error
  -> inconclusive (staging 可记录，cutover blocked)

cross-app/unresolvable/definitive miss
  -> rejected (cutover blocked)
```

规则：

- `ou_` 必须由同一目标 App 正向查询成功；不能从 sibling App/cache 复制。
- email/mobile/`on_` 只是跨 App locator，必须分别经目标 App 解析和回读。
- 当前 schema 若只接受 `ou_`，必须先在目标 App 下解析；不能把 `on_` 直接写入旧 `allowedUsers`。
- `bots-info`、open/union ID cache、allowed-user cache 只用于 orphan/diagnostic，不授予权限。
- validation evidence 绑定 `app_id`、credential revision、scope snapshot 和过期时间；任一变化后失效。
- 错误输出只包含 identity ref、类型和 verdict，不回显原始身份值。

### 6.2 Chat validation

每条 `(app_id, chat_id)` binding 至少验证：

- 目标 App 能读取 chat metadata；
- Bot 当前仍是成员或具备所需可见性；
- oncall/chat policy 的 App 与 source binding 一致；
- CWD 已展开为绝对路径、存在、为目录、通过 canonical workspace ACL；
- reply/mention/session scope 可在目标 runtime 表达；
- group tool read/discover/send 分别有明确 policy。

只读 preflight 不发送测试消息。写路径 E2E 只能在独立测试 App/Chat，或未来单独审批的 canary 工具中执行。

遗留群网关配置状态固定为 `unknown_external_legacy`；在找到消费者/owner 和精确能力范围前，验证结果不能高于 `inconclusive`。

## 7. Listener lease 与双 consumer fencing

### 7.1 Lease 模型

Lease 必须由 Botmux、Dutydeck 和 supervisor 都能观察/强制，不能只存 Dutydeck SQLite：

```ts
interface AppListenerLease {
  app_ref: string
  generation: number
  owner_runtime: 'botmux' | 'dutydeck' | 'none'
  owner_instance_ref: string
  state: 'active' | 'draining' | 'stopped_verified' | 'expired' | 'conflict'
  acquired_at: string
  renewed_at: string
  expires_at: string
  source_connection_evidence_ref?: string
  target_connection_evidence_ref?: string
}
```

持有者必须周期续租；失租立即停止接收并断开连接。每次连接建立和事件接收都校验当前 generation。只检查进程存在、PID 文件或 Dutydeck 自己的 lease 行都不构成跨系统 fencing。

### 7.2 没有共享 lease 时的硬 fence

当前 Botmux 若尚未消费共享 lease，只能使用 supervisor 硬 fence：

1. 按 App drain 对应 Botmux daemon；
2. 确认其事件连接已断、进程不会被 PM2/supervisor 自动拉起；
3. 写入外部 generation/owner 记录；
4. 目标 runtime 在观察到 source stopped + supervisor inhibit 后才具备 eligibility。

本规格的 CLI 只检查并生成证据，不执行上述动作。无法按 App 单独停止时，生产 App 不可 cutover；只能使用独立测试 App。

### 7.3 双 consumer 判定

出现以下任一情况立即判 `FENCE_CONFLICT`：

- 两个 runtime 都报告连接 active；
- source daemon 仍可被自动重启，而 target 被标记 eligible；
- lease owner/generation 与实际连接 evidence 不一致；
- lease 过期但连接仍接收事件；
- 无法判断当前 App 的 source daemon/connection identity。

## 8. Schedule 单写者与 occurrence 水位

Listener lease 与 Schedule writer lease 必须分离。Botmux listener 停止后，本地 scheduler 仍可能触发；反之亦然。

```ts
interface ScheduleWriterLease {
  app_ref: string
  generation: number
  owner_runtime: 'botmux' | 'dutydeck' | 'none'
  state: 'active' | 'draining' | 'stopped_verified' | 'conflict'
  renewed_at: string
  expires_at: string
  source_schedule_set_hash: string
  watermark_ref?: string
}
```

每次触发使用确定性 occurrence key：

```text
source_instance_id + source_schedule_id + scheduled_for_utc
```

目标执行账本对 occurrence key 建唯一约束。执行可以 at-least-once，但用户可见 delivery 必须幂等；不能依赖 `lastRunAt` 的近似时间去重。

Schedule handoff 最少记录：

- source schedule definition hash；
- timezone 和解析后的下一次 occurrence；
- last claimed/started/settled occurrence；
- pending execution/outbox 数量；
- thread/chat/root/delivery/continuation policy refs；
- writer generation。

切换规则：

1. Source schedule writer 先进入 draining，停止 claim 新 occurrence。
2. 等已 claim occurrence settle，或明确记录为 source-owned pending。
3. 记录 watermark 并验证 source writer stopped。
4. Target 只有在独立外部 activation 中获得下一 generation 后才能 claim。
5. 若到期点落在 handoff 窗口，按 occurrence key 由唯一 owner补领；不得两边各跑一次。

只读 importer 永远把导入 schedule 标为 `staged_disabled`。`--skip-schedules` 不会使所属 App 变成 cutover-ready。

## 9. Watermark 设计

### 9.1 Lark event watermark

优先记录可验证的 event/message idempotency key；时间戳只作为辅助窗口：

```ts
interface LarkEventWatermark {
  app_ref: string
  source_generation: number
  last_accepted_event_ref?: string
  last_settled_event_ref?: string
  accepted_at?: string
  settled_at?: string
  pending_event_count: number
  confidence: 'exact' | 'bounded_window' | 'unknown'
}
```

Botmux 若无法给出确定 cursor，标 `bounded_window/unknown`，cutover packet 必须扩大 dedup 窗口并要求人工核对；不能伪造 exact。

### 9.2 Turn 与 delivery watermark

记录 source App 下 running/queued/waiting/final-delivery 数量和 opaque refs。当前不迁 in-flight session/turn，因此 cutover 前必须 drain 为 0，或取消 cutover。

delivery watermark 记录已提交但未确认的发送。Source outbox 未清空时，Target 不得替它重发同一结果；应由 source settle 或人工分类。

### 9.3 Schedule watermark

按 schedule 保存最后 settled occurrence 与下一个 due occurrence。定义变化时 definition hash 改变，旧 occurrence namespace 保留，不能重置去重账本。

## 10. 安全 Shadow

### 10.1 允许

- 对同一 source snapshot 连续运行 parser，验证 normalized result 与 plan digest 稳定。
- 用脱敏 actor/chat/message-shape 元数据比较 Botmux 与 Dutydeck policy evaluator verdict。
- 对历史 route key 做离线 collision 检查，但不创建 channel mapping。
- 在独立测试 App 下验证 listener、群路由、身份、群工具和卡片行为。
- 在本地独立测试 workspace 运行 Agent/backend readiness，不使用生产消息。

### 10.2 禁止

- 同一生产 App 的第二个 WebSocket/event consumer；
- 生产事件 mirror/replay 到会执行 Agent 的 Dutydeck；
- 生产 schedule prompt 的 shadow fire；
- shadow 发送消息、创建群、邀请成员、修改卡片或消费 grant/quota；
- 通过“只观察但仍 ack/claim”规避 single-consumer 约束。

Shadow 成功只能关闭 parser/policy blocker，不能替代真实 fencing、identity positive validation、backend restart E2E 或 Schedule single-writer。

## 11. Cutover packet 与外部 runbook

### 11.1 Packet 内容

Cutover packet 必须绑定：

- plan/preflight ID 与有效期；
- authoritative apply fingerprint；
- target baseline revisions；
- identity/chat/backend/schedule validation evidence；
- listener 与 Schedule writer 当前 owner/generation；
- watermark slots；
- blocker 必须为空；
- rollback sequence 和 operator checklist；
- `activation_performed=false` 固定字段。

Packet 是私密、签名、一次性的操作输入，不是 activation capability。Importer 无法消费它来启用 listener。

### 11.2 外部 cutover 顺序

以下是未来独立、另行评审的 supervisor/operator 流程，本规格不执行：

1. 冻结目标 App 的 Botmux 配置变更，重验 apply fingerprint。
2. 停止接受新 turn，等待 running/queued/final delivery drain。
3. Drain Schedule writer，不再 claim occurrence；settle pending occurrence/outbox。
4. 记录 event/turn/delivery/schedule watermarks。
5. 停止并硬 fence source App daemon，验证 listener 与 scheduler 均不可自动重启。
6. 获取新的 listener/schedule generation。
7. 由独立 activation facility 写 live config、确认必要 trust、启动目标 listener；不由 Importer 执行。
8. 先验证 listener 单 owner，再由独立 facility 启用对应 schedule writer。
9. 在小窗口核对 dedup、权限、群路由、CWD、卡片和 schedule occurrence。
10. 保留 Botmux 源和恢复环境，直到观察期结束。

任一步证据不完整都停止在 source-stopped 或回滚，不允许边修边开双 listener。

## 12. Rollback runbook

运行回滚和配置回滚是两件事。运行回滚必须先处理 consumer/writer，再考虑 Dutydeck 受管配置：

1. Target 停止接收新 turn，drain running/final delivery。
2. Target Schedule writer 停止 claim，settle 或记录 pending occurrence。
3. 写 target event/delivery/schedule watermark。
4. 断开 Target listener，验证连接关闭；释放或 fence Target generation。
5. Supervisor 解除 Source inhibit，Source 以新 generation 恢复 listener。
6. Source schedule writer 读取 occurrence watermark 后恢复，唯一约束阻止重复 fire。
7. 在 watermark 邻域做 dedup/人工对账，确认没有重复回复或漏投。
8. Dutydeck managed config 若要回滚，只恢复未被人工修改的 entity revision；不删除切流期间产生的 session/task/audit/history。
9. Secret 只恢复旧 ref；不从 diff/archive 恢复 plaintext。

若 Target 无法证明已断开，或 Source 不支持 generation/watermark，禁止恢复 Source 形成双 consumer；保持两边停止并人工处置。

## 13. Preflight gate

只有以下全部成立，cutover packet 才能标 `eligible=true`；这仍不等于已激活：

- artifact coverage 100%，无 unknown；
- authoritative fingerprint fresh，target baseline 无冲突；
- App credential 有效且不出现在输出；
- owner/principal 全部 target-App positive verified；
- 所有 chat binding 以 App+Chat 验真，CWD/ACL 有效；
- 实际使用的 oncall/RBAC、mention、Hammer、group tools、backend、schedule 均有等价行为证据；
- legacy session/workflow 明确 archive-only；
- listener fence 和 schedule single-writer 方案均可由 supervisor 强制；
- running/queued/delivery/schedule pending 有可清零或可证明的 drain 方案；
- shadow 未使用生产 listener/send/schedule；
- rollback packet 完整且水位格式可被 source/target双方理解。

本机当前必须输出 `eligible=false`，主要 blocker 至少包括 oncall/RBAC、enabled schedule、Hammer、mention policy、per-chat group tools、tmux production reattach、shared fencing 和禁用态 live schema。只读 plan/archive/preflight 可以推进，但任何直接激活请求必须硬失败。
