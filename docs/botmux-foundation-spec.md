# Botmux 集成 Foundation 实现规格（WP0 / WP1）

> 状态：可直接交给编码 subagent 的实现规格  
> 范围：WP0 契约与安全护栏；WP1 核心实体、repository 与原子事务  
> 不包含：EffectiveConfig 执行、backend 接线、授权 enforcement、Lark 群同步、Importer parser、Web 页面实现和生产切流

## 1. 目标与完成定义

WP0/WP1 的目标是建立后续所有 Botmux 集成工作共用的、不会泄密且可事务化的唯一基础模型：

```text
AgentDefinition
    ↓ default_agent
ChannelBot
    ↓ (channel_bot_id, chat_id)
GroupBinding
    ↓ later resolved by WP2
RunSnapshot
```

完成后必须满足：

1. 四个核心实体有 versioned、strict、可测试的领域 contract；
2. `AgentDefinition.id` 与 `driver_kind/adapter_id` 分离；
3. `ChannelBot` 不再把 App Secret 当普通字段，apply 后默认处于 disabled；
4. 同一 chat 下两个 Bot 可保存不同 GroupBinding，不互相覆盖；
5. RunSnapshot 为 create-only immutable record，能保存 effective config 和来源 revision，但不保存 secret/env/token；
6. 所有公开 DTO 由 allowlist serializer 生成，不能把 private entity 直接 `JSON.stringify` 返回；
7. storage 提供跨 repository 的单 SQLite transaction、optimistic revision、自然键冲突和条件 rollback；
8. 现有 `agent_configs`、`configs['lark.bots']`、Session/Task/Event 数据原样可读，不被 destructive migration 修改；
9. 建立脱敏 golden fixture，稳定表示 2 Bot、2 oncall、1 enabled interval schedule，不含真实用户、prompt 或凭据；
10. WP2–WP9 能只消费本规格，不需要重新定义实体、状态和错误语义。

## 2. 工作包边界

### WP0 负责

- `packages/shared` 中的 schema、enum、领域类型和 public DTO；
- strict parse、schema version、override contract、RBAC action enum；
- allowlist serializer、redaction helper 和 forbidden-field tests；
- migration foundation feature flag；
- 脱敏 Botmux golden fixture 与 contract tests；
- 本文定义的 API/read-model 形状，供后续 WP 消费。

WP0 不创建数据库表，不接入 Lark，不改变 runtime config resolution。

### WP1 负责

- `packages/storage` 的 migration、表、索引和约束；
- 四核心实体及辅助实体 repository；
- revision-aware CRUD、create-only snapshot、自然键查询；
- 同一数据库连接上的原子 batch transaction；
- import provenance、before version、条件 rollback primitive；
- CutoverLease 的 compare-and-swap primitive；
- 现有数据库升级/回退兼容和故障注入测试。

WP1 不把新实体接入 production listener/runtime，不自动转换 `lark.bots`，不导入真实 Botmux 数据，不启动 Bot，也不执行 cutover。

### 后续 WP 才负责

| 能力 | 所属 WP |
|---|---|
| field-level EffectiveConfig 解析并创建 RunSnapshot | WP2 |
| tmux selector、spawn、reattach | WP3 |
| principal resolution 和统一 authorize enforcement | WP4 |
| Lark 群事实同步、路由、mention、群工具 | WP5 |
| Schedule ticker/occurrence | WP6 |
| Botmux discover/plan/apply/rollback CLI | WP7 |
| 群矩阵、disabled Bot、冲突/回滚 Web UI | WP8 |
| App handoff/observation/rollback | WP9 |

WP0 冻结后续 WP 的输入输出；WP1 提供后续所需持久化。不得为了“顺手跑通”在 WP0/WP1 内复制 resolver、policy evaluator 或 Lark dispatcher。

## 3. 通用契约约定

### 3.1 ID、版本和时间

- 所有新实体 ID 为 opaque string，不允许消费者解析 ID 得出类型或权限；建议生成时使用稳定前缀便于诊断。
- 所有可修改实体有 `revision: positive integer`，创建为 1，每次成功修改加 1。
- 修改 API/repository 必须提交 `expected_revision`；不匹配返回 `revision_conflict`，不得 last-write-wins。
- 所有 contract 有 `schema_version: 1`；schema parser 必须拒绝未知字段。
- 时间均使用 UTC ISO-8601；数据库列使用 `_at` 后缀。
- 软删除使用 `archived_at` 或实体状态；WP1 不 hard-delete 被其他实体引用的核心记录。

### 3.2 自然键

| 实体 | 自然键 |
|---|---|
| AgentDefinition | 仅 `id`；Importer 去重使用 launch fingerprint/provenance，不用 `adapter_id` |
| ChannelBot | `(channel, external_app_id)`；P0 `channel=lark` |
| GroupBinding | `(channel_bot_id, external_chat_id)` |
| RunSnapshot | `run_id`，一 Run 一个 snapshot |
| Principal | `(channel_bot_id, kind, normalized_value)` |
| ChannelChatObservation | `(channel_bot_id, external_chat_id)` |
| CutoverLease | `(channel, external_app_id)` |
| ImportEntity | `(source_kind, source_instance_id, entity_kind, source_key)` |

### 3.3 JSON 与私密字段

- 表中 JSON 必须通过 WP0 schema 编解码，不能保存任意 untyped object。
- canonical hash 使用字段排序后的规范化 JSON；时间戳、readiness observation 等非语义字段不进入 config hash。
- Secret value、vendor env value、Cookie、capability token、schedule prompt、消息正文不得进入四核心实体、RunSnapshot、ImportEntityVersion、日志或 public DTO。
- Secret 只通过 `secret_ref` 引用；WP1 的 SecretRef 表只记录 provider metadata，不提供 value column。
- ACPX persisted `session_options` 的全部 object key 必须为 `snake_case`。群工具只允许 `dockmux_group_tools_url` 和 `dockmux_group_tools_token`；vendor 大写 env 留在 runtime bridge，不进入本规格实体 JSON。

### 3.4 Foundation feature flag

- 环境变量固定为 `DOCKMUX_BOTMUX_FOUNDATION=true|false`，默认 `false`；
- 数据库 migration 始终可安全执行，feature flag 只控制新 repository 写入口、management API 和后续 UI 是否暴露；
- flag 关闭时现有 Agent/Lark/Session 行为完全不变；
- flag 开启也不得自动迁移 `agent_configs`、写 `channel_bots`、启 listener 或确认 full trust；
- WP0 测试覆盖开/关两态，未知值启动失败而不是当作 true。

## 4. WP0 领域 schema

以下为语义 schema；TypeScript 可使用 camelCase，SQLite 列使用 snake_case。序列化到 import manifest 或 ACPX metadata 时使用 snake_case contract，不得把大写 env key嵌入对象键。

### 4.1 AgentDefinition

| 字段 | 类型/枚举 | 必填 | Public | 说明 |
|---|---|---:|---:|---|
| `schemaVersion` | `1` | 是 | 是 | contract version |
| `id` | string | 是 | 是 | 业务定义 ID，不是 adapter ID |
| `revision` | positive int | 是 | 是 | optimistic revision |
| `name` | non-empty string | 是 | 是 | 用户可见名称 |
| `state` | `enabled / disabled / archived` | 是 | 是 | disabled 不得被新 Run 选择 |
| `driverKind` | `pty / acpx` | 是 | 是 | 真实 driver |
| `adapterId` | string | 是 | 是 | 如 `claude-code`、`codex` |
| `protocol` | Dockmux normalized protocol | 是 | 是 | 不从 `id` 推断 |
| `launchProfile` | private object | 是 | 否 | command、args、runtime distribution；不得包含 secret value |
| `runtimeVersion` | string? | 否 | 是 | 探测值或 imported value |
| `backendPolicy` | BackendPolicy | 是 | 是 | 见下 |
| `defaults` | AgentDefaults | 是 | 部分 | model/reasoning/permission/timeout 可公开；cwd 只在受信管理 DTO 中出现 |
| `capabilities` | AgentCapabilityReport | 是 | 是 | pause/resume/terminal/structured events/native resume |
| `envSecretRef` | string? | 否 | 否 | 指向 server secret provider |
| `systemPolicyRef` | string? | 否 | 否 | 不返回实际 system prompt |
| `startupProfileRef` | string? | 否 | 否 | 不返回启动命令 |
| `source` | EntitySource | 是 | 是（脱敏） | native/manual/imported + source ref |
| `createdAt/updatedAt/archivedAt` | timestamps | 是/否 | 是 | 生命周期 |

`BackendPolicy`：

- `kind`: `managed / pty / tmux / zellij / zmx`；`managed` 仅用于 runtime 自己管理进程的 driver；
- `onUnavailable`: P0 仅允许 `block`；不得定义隐式 fallback；
- `persistentRequired`: boolean；imported Botmux tmux Agent 为 `true`；
- `requiredCapabilities`: string list。

`AgentDefaults`：

- `model`: optional string；缺省表示 Agent/CLI 默认；
- `reasoningEffort`: optional string；
- `cwd`: optional absolute/logical path；
- `permissionMode`: `ask / approve-reads / deny-all / full-trust`；
- `timeoutSeconds`: positive integer。

`AgentCapabilityReport` 固定字段：`structuredEvents`、`terminal`、`pause`、`resume`、`nativeResume`、`reportedAt`；能力值只表示已探测事实，不能根据 adapter 名称乐观推断。

`EntitySource` 固定字段：

- `kind`: `native / manual / imported`；
- imported 时必填 `sourceKind`、`sourceInstanceId`、`sourceKey`、`sourceDigest`，可选 `importRunId`；
- native/manual 时不得伪造 import provenance；
- public DTO 只返回 `kind`、是否 managed 和安全的 import run ID，不返回 source root/private path。

不可变项：`driverKind`、`adapterId`、`protocol` 若要改变，必须创建新 revision 并让既有 RunSnapshot 保留旧值；不能影响已有 Run。

### 4.2 ChannelBot

| 字段 | 类型/枚举 | 必填 | Public | 说明 |
|---|---|---:|---:|---|
| `schemaVersion/id/revision` | common | 是 | 是 | 领域 identity |
| `channel` | `lark` | 是 | 是 | P0 只支持 Lark |
| `externalAppId` | string | 是 | 是 | Lark App ID，自然键一部分 |
| `displayName` | string | 是 | 是 | 主标签 |
| `brand` | `feishu / lark` | 是 | 是 | API domain |
| `credentialRef` | string? | 否 | 否 | public 只返回 credential status |
| `defaultAgentDefinitionId` | FK | 否 | 是 | 为空即 blocker，不能启 listener |
| `defaults` | ChannelBotDefaults | 是 | 是（脱敏） | workspace/model/reasoning/role/execution policy refs |
| `routingDefaults` | RoutingPolicy | 是 | 是 | p2p/group reply/mention |
| `accessPolicy` | `owner_only / allowlist / open` | 是 | 是 | 新建/imported 缺省 `owner_only` |
| `riskPolicy` | validated object | 是 | 是 | mode/pattern metadata；不含 secret |
| `cardPolicy` | validated object | 是 | 是 | trace/presentation defaults |
| `groupToolsPolicy` | GroupToolsCeilingAndDefault | 是 | 是 | ceiling 与 default 分开 |
| `fullTrustConfirmed` | boolean | 是 | 是 | imported apply 必为 false |
| `desiredListenerState` | `disabled / enabled` | 是 | 是 | apply 必为 disabled |
| `migrationState` | 见下 | 是 | 是 | disabled journey |
| `source` | EntitySource | 是 | 是（脱敏） | native/manual/imported |
| `createdAt/updatedAt/archivedAt` | timestamps | 是/否 | 是 | 生命周期 |

`ChannelBotDefaults`：

- `workspace`: optional logical path；
- `model`: optional string；
- `reasoningEffort`: optional string；
- `rolePolicyRef`: optional string；
- `executionPolicyRef`: optional string；
- `permissionCeiling`: permission mode；Group/Run 不得越过此安全上限。

`RoutingPolicy`：

- `p2pMode`: `chat / thread`；
- `groupReplyMode`: `chat / shared / new-topic / chat-topic`；
- `mentionPolicy`: `always / topic / never / ambient`；
- 值必须 materialized，不能以 undefined 依赖版本默认。

`GroupToolsCeilingAndDefault`：

- `readCeiling/discoverCeiling/sendCeiling`: boolean；
- `readDefault/discoverDefault/sendDefault`: boolean；
- 任一 default 不得大于 ceiling；GroupBinding 可在 ceiling 内改变，不可扩大 ceiling。

`riskPolicy` 固定字段：`mode=off|guidance|enforced`、validated `pattern`、optional `policyRef`；高危允许主体不嵌在此对象，使用 Principal/Grant 或后续专用 policy。

`cardPolicy` 固定字段：`pushIntervalMs`（500–20000）、`traceLimit`（positive integer）、`hideTraceOnComplete`。WP0 不在该对象加入 no-card/no-CoT 等 P1 字段，未知字段按 strict schema 拒绝。

`migrationState`：

- `native_disabled`：Dockmux 原生创建但未启用；
- `imported_disabled`：已导入，未监听；
- `verified_offline`：离线 readiness 已通过；
- `ready_for_handoff`：没有 blocker，等待 WP9 切流；
- `observation`：整 App 已切 Dockmux，处于回滚观察期；
- `active`：Dockmux 是正式 owner；
- `blocked`：有明确 blocker；
- `degraded`：曾 active，但当前不健康；
- `rolled_back`：已回 Botmux。

内部如果已有 `canary` 名称，public DTO/UI 必须映射为“观察中”，不得暗示按群或比例灰度。

合法 migration state transition：

```text
native_disabled -> verified_offline | blocked
imported_disabled -> verified_offline | blocked
blocked -> imported_disabled | verified_offline
verified_offline -> ready_for_handoff | blocked | imported_disabled
ready_for_handoff -> observation | blocked | imported_disabled
observation -> active | degraded | rolled_back
active -> degraded | rolled_back
degraded -> observation | active | rolled_back
rolled_back -> imported_disabled
```

WP0 只冻结 transition validator；真实 `ready_for_handoff -> observation` 必须由 WP9 lease/handoff 驱动，普通 ChannelBot update API 不得直接执行。

### 4.3 GroupBinding

GroupBinding 只保存本地期望策略。远端 membership/name/visibility 存在 `ChannelChatObservation`，不能混入 policy revision。

| 字段 | 类型/枚举 | 必填 | Public | 说明 |
|---|---|---:|---:|---|
| `schemaVersion/id/revision` | common | 是 | 是 | identity |
| `channelBotId` | FK | 是 | 是 | 与 chat 构成自然键 |
| `externalChatId` | string | 是 | 是 | 诊断信息，UI 主标签用群名 |
| `state` | `enabled / disabled / needs_review / archived` | 是 | 是 | `needs_review` 不可激活相关能力 |
| `oncall` | boolean | 是 | 是 | migrated source semantics |
| `agentOverride` | Override<id> | 是 | 是 | inherit/set |
| `workspaceOverride` | Override<path> | 是 | 是 | inherit/set；不允许静默 clear 到 `~` |
| `modelOverride` | Override<string> | 是 | 是 | inherit/set/clear；clear=CLI default |
| `reasoningOverride` | Override<string> | 是 | 是 | inherit/set/clear |
| `rolePolicyOverride` | Override<ref> | 是 | 是 | inherit/set/clear |
| `routingOverride` | RoutingOverride | 是 | 是 | 每字段 inherit/set |
| `accessOverride` | AccessOverride | 是 | 是 | 见下 |
| `groupToolsOverride` | GroupToolsOverride | 是 | 是 | 每能力 inherit/allow/deny，受 Bot ceiling |
| `presentationOverride` | validated override | 是 | 是 | P0 可只保留 inherit |
| `reviewReasons` | error/review code list | 是 | 是 | 不含敏感值 |
| `source` | EntitySource | 是 | 是（脱敏） | provenance |
| `createdAt/updatedAt/archivedAt` | timestamps | 是/否 | 是 | 生命周期 |

`Override<T>` 必须显式：

- `{ mode: 'inherit' }`；
- `{ mode: 'set', value: T }`；
- 仅允许清空到 Agent/CLI default 的字段可用 `{ mode: 'clear' }`。

禁止用 `undefined/null/空字符串` 同时表达 inherit、clear 和未填写。

`AccessOverride`：

- `mode`: `inherit / owner_only / allowlist / all_chat_members / disabled`；
- `principalIds`: 仅 `allowlist` 使用；
- `all_chat_members` 在 P0 只授予 `can_talk`；
- operate/admin 不在此字段隐式产生，由 admin binding / ActionGrant 表达。

`GroupToolsOverride`：

- `read/discover/send`: `inherit / allow / deny`；
- effective allow = ChannelBot ceiling AND GroupBinding requested/default；
- `deny` 永远优先；
- legacy gateway candidate 导入时 `read=allow` 仍需 review，`send=deny`。

### 4.4 RunSnapshot

RunSnapshot 为 create-only。WP1 repository 不提供 update/delete；运行时 backend instance identity 放在单独 `RunRuntimeBinding`，避免破坏 immutable config。

| 字段 | 类型 | 必填 | Public | 说明 |
|---|---|---:|---:|---|
| `schemaVersion/id` | common | 是 | 是 | identity |
| `runId` | string unique | 是 | 是 | 一 Run 一 snapshot |
| `sessionId` | string | 是 | 是 | 关联现有 Session |
| `createdAt` | timestamp | 是 | 是 | 无 updatedAt |
| `sourceRevisions` | SourceRevisionSet | 是 | 是 | Agent/Bot/Binding ID+revision；Binding 可为空 |
| `effectiveAgent` | object | 是 | 是 | agent ID/name、driver、adapter、protocol、runtime version |
| `effectiveBackendPolicy` | object | 是 | 是 | kind、persistent requirement、capabilities |
| `effectiveExecution` | object | 是 | 是 | workspace/cwd/model/reasoning/permission/role/execution policy revision |
| `effectiveRouting` | object | 是 | 是 | app/chat/thread/topic/reply/mention/session scope |
| `effectiveAuthorization` | sanitized decision | 是 | 是 | actor principal ID、action、decision source/revision；无 raw email |
| `effectiveGroupTools` | object | 是 | 是 | read/discover/send + policy revisions |
| `effectiveConfigHash` | canonical hash | 是 | 是 | 不含 runtime observations |
| `privateRefsDigest` | digest? | 否 | 否 | 只证明 private refs 集合，不保存值 |

RunSnapshot 禁止字段：App Secret、credential ref value、env、env file path、system prompt text、capability token、schedule prompt、消息正文、raw principal value。

### 4.5 辅助 schema

#### Principal

- `id/revision/channelBotId`；
- `kind`: `email / union_id / open_id / bot / system`；
- `normalizedValuePrivate`: private；
- `displayName` 与 `maskedDisplayValue`：public；
- `appScope`: Lark App identity；
- `verificationState`: `unverified / verified / invalid / stale`；
- `verifiedAt/verificationErrorCode`；
- raw `ou_*` 不得跨 ChannelBot 复用。

#### ChannelBotAdmin

- `(channel_bot_id, principal_id)` unique；
- `role`: P0 固定 `admin`；
- `source/revision/timestamps`。

#### ActionGrant

- `id/revision/principalId/channelBotId`；
- optional `groupBindingId`；
- `capability`: `can_talk / can_operate`；
- `operateScope`: `none / own_runs / group_runs / bot_runs`，仅 can_operate 使用；
- `expiresAt` optional；
- `state`: `active / revoked / expired`；
- `source/timestamps`。

P0 不实现 grant 申请卡、quota 或 `can_dispatch`，但 schema 不得把 can_operate 与 admin 合并。

#### ChannelChatObservation

- 自然键 `(channelBotId, externalChatId)`；
- `membershipState`: `member / not_member / inaccessible / unknown`；
- `chatType`: `group / topic_group / unknown`；
- `displayName/avatarRef` optional；
- `observedAt`、`lastSuccessAt`、`errorCode`；
- 不含 policy，不参与 GroupBinding revision/config hash。

#### ChannelBotHealthObservation

- `channelBotId`；
- `listenerState`: `offline / starting / online / degraded / unknown`；
- `lastHeartbeatAt/lastErrorCode/observedAt`；
- 不改变 ChannelBot config revision。

#### RunRuntimeBinding

- `runId` unique；
- `backendKind/backendInstanceId/ownershipDigest`；
- `processIdentity` private diagnostic ref；
- `state`: `planned / attached / detached / exited / lost / conflict`；
- `createdAt/updatedAt`。

WP1 只持久化 contract；WP3 才写真实 backend identity。

## 5. 配置继承与安全合并契约

WP2 实现 resolver，但 WP0 必须冻结以下规则，WP1 schema 必须能无损表达。

### 5.1 普通字段优先级

```text
显式 Run override
  > GroupBinding override
  > ChannelBot default
  > AgentDefinition default
  > process default
```

| 字段 | Run | Group | Bot | Agent | Process | 规则 |
|---|---:|---:|---:|---:|---:|---|
| selected AgentDefinition | 可 | 可 | 是 | — | fallback | 选中 Agent 后 driver/adapter/protocol 跟随，不单独覆盖 |
| workspace/cwd | 可 | 可 | 可 | 可 | 是 | 路径不存在或越界时 blocker，不回退 `~` |
| model | 可 | 可/clear | 可/clear | 可 | CLI default | clear 明确表示 CLI default |
| reasoning effort | 可 | 可/clear | 可/clear | 可 | driver default | 同上 |
| role/execution policy ref | 可 | 可/clear | 可 | 可 | none | Run 固化 revision |
| P2P mode | 否 | 否 | 是 | 否 | explicit fallback | 必须 materialized |
| group reply/mention | 否 | 可 | 是 | 否 | explicit fallback | Incoming route 创建 Run 前解析 |
| card presentation | 否 | 可 | 是 | 否 | default | 不影响权限 |

### 5.2 不按简单覆盖合并的安全字段

| 字段 | 合并规则 |
|---|---|
| `permissionMode` | Run/Group 只能收紧 ChannelBot `permissionCeiling`；扩大到 full-trust 必须有 Bot 级显式确认和 admin 授权，不能靠普通 override |
| group tools | Bot ceiling 是硬上限；Group deny-wins；Run 只能继续收紧，不能扩大 |
| high-risk | 独立执行门；任何上层 deny 都生效，can_operate/full-trust 不能绕过 |
| access/RBAC | 由 policy evaluator 计算，不写进普通 config override；RunSnapshot 记录决策来源 |
| credential/env | 仅引用，不参与普通继承；ChannelBot credential 不能流入 AgentDefinition 或 snapshot |
| backend | 由最终选中的 AgentDefinition 决定；Bot/Group/Run 不能把 required tmux 改成 PTY |

P0 permission posture 从严格到宽松的比较顺序固定为：`deny-all < ask < approve-reads < full-trust`。该顺序只用于判断 override 是否越过 ceiling；不表示 `ask` 与 `approve-reads` 在所有 driver 上都有相同交互能力。不支持某 posture 的 driver 必须 blocker，不能自动换档。

### 5.3 变更可见性

- 修改上游实体只影响后续 Run；既有 RunSnapshot 永不重算。
- 更新成功返回新 revision，并提供 derived blast-radius read contract：继承该值的 GroupBinding 数量、拥有覆盖的数量、既有 Run 不受影响。
- WP1 不计算 blast radius，但 repository 必须支持按 `channel_bot_id` 列 GroupBinding、按 source revision 查 Snapshot，供 WP8 构建 read model。

## 6. RBAC action matrix

P0 的运行权限只有 `can_talk`、`can_operate` 和 owner/admin 管理边界。不要在 WP0/WP1 引入含义未定的 `can_dispatch`。

### 6.1 Action enum 与要求

| Action | can_talk | can_operate | admin | 附加条件 |
|---|---:|---:|---:|---|
| `task.create` | 是 | 是 | 是 | App/Group scope 匹配 |
| `turn.append` | 是 | 是 | 是 | 目标 Session/Channel 可见 |
| `task.view_result` | 是 | 是 | 是 | 仍受 channel/Web visibility |
| `queue.cancel` | 否 | 是 | 是 | operateScope 覆盖目标 Run |
| `queue.promote/reorder` | 否 | 是 | 是 | operateScope 覆盖目标 group/bot |
| `run.interrupt/pause/resume/retry/restart` | 否 | 是 | 是 | callback 时重新鉴权、核对 Run revision |
| `terminal.read` | 否 | 是 | 是 | 用户绑定的短期 access session |
| `terminal.write` | 否 | 条件允许 | 是 | can_operate + explicit terminal_write gate；普通 operate 不自动获得 |
| `run.change_agent/cwd/model/backend/permission` | 否 | 否 | 是 | 已运行 Run 默认不可变；应创建新 Run 或审计迁移 |
| `group_binding.update` | 否 | 否 | 是 | expected revision |
| `channel_bot.update` | 否 | 否 | 是 | secret/full-trust 有额外确认 |
| `grant.create/revoke` | 否 | 否 | 是 | owner/admin only |
| `schedule.create/update/enable` | 否 | 否 | 是 | 后续 WP6；受 App lease |
| `listener.enable/disable` | 否 | 否 | 是 | 不等同直接 cutover |
| `cutover.start/rollback/finalize` | 否 | 否 | 是 | WP9 readiness gate |
| `group_tools.read/discover/send` | 不直接决定 | 不直接决定 | 不直接决定 | Agent session capability + Bot ceiling + Group policy；send 独立开关 |
| high-risk tool execution | 不直接决定 | 不直接决定 | 不直接决定 | 独立 high-risk actor/policy hook，deny-wins |

### 6.2 Policy precedence

1. explicit deny / archived / disabled / scope mismatch；
2. admin binding；
3. active scoped ActionGrant；
4. GroupBinding `all_chat_members/allowlist` 产生的 can_talk；
5. ChannelBot access policy；
6. default deny。

附加规则：

- `accessPolicy=open` 只产生 can_talk，不产生 can_operate/admin；
- oncall/all chat members 只产生 can_talk；
- App-scoped identity 不匹配、principal unresolved、grant expired、evaluator error 一律拒绝；
- card 创建时的 permission snapshot 只用于展示，点击时必须重新评估；
- WP1 repository 保存 grant/admin，WP4 才实现 evaluator 和各入口 enforcement。

## 7. WP1 持久化 schema

新表建议集中在一个 forward-only migration（当前最大 schema version 后的下一版本）。migration 不 drop/rename 现有表，不自动搬运 `agent_configs` 或 `configs['lark.bots']`。

### 7.1 核心表

#### `agent_definitions`

- `id TEXT PRIMARY KEY`
- `schema_version INTEGER NOT NULL CHECK = 1`
- `revision INTEGER NOT NULL CHECK > 0`
- `name TEXT NOT NULL`
- `state TEXT NOT NULL`
- `driver_kind TEXT NOT NULL`
- `adapter_id TEXT NOT NULL`
- `protocol TEXT NOT NULL`
- `launch_profile_private TEXT NOT NULL` — validated JSON, no secret value
- `runtime_version TEXT NULL`
- `backend_policy TEXT NOT NULL` — validated JSON
- `defaults_private TEXT NOT NULL` — validated JSON
- `capabilities TEXT NOT NULL` — validated JSON
- `env_secret_ref TEXT NULL`
- `system_policy_ref TEXT NULL`
- `startup_profile_ref TEXT NULL`
- `source TEXT NOT NULL` — validated sanitized JSON
- `config_hash TEXT NOT NULL`
- `created_at/updated_at TEXT NOT NULL`
- `archived_at TEXT NULL`

索引：`state`、`adapter_id`。不得对 `adapter_id` 建 unique。

#### `channel_bots`

- `id TEXT PRIMARY KEY`
- common schema/revision/timestamps
- `channel TEXT NOT NULL`
- `external_app_id TEXT NOT NULL`
- `display_name TEXT NOT NULL`
- `brand TEXT NOT NULL`
- `credential_ref TEXT NULL`
- `default_agent_definition_id TEXT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT`
- `defaults_private/routing_defaults/access_policy/risk_policy/card_policy/group_tools_policy TEXT NOT NULL`
- `full_trust_confirmed INTEGER NOT NULL DEFAULT 0`
- `desired_listener_state TEXT NOT NULL DEFAULT 'disabled'`
- `migration_state TEXT NOT NULL`
- `source TEXT NOT NULL`
- `config_hash TEXT NOT NULL`
- `archived_at TEXT NULL`

约束：`UNIQUE(channel, external_app_id)`；imported create 必须检查 listener disabled/full trust false。

#### `group_bindings`

- `id TEXT PRIMARY KEY`
- common schema/revision/timestamps
- `channel_bot_id TEXT NOT NULL REFERENCES channel_bots(id) ON DELETE RESTRICT`
- `external_chat_id TEXT NOT NULL`
- `state TEXT NOT NULL`
- `oncall INTEGER NOT NULL DEFAULT 0`
- `agent_override/workspace_override/model_override/reasoning_override/role_policy_override TEXT NOT NULL`
- `routing_override/access_override/group_tools_override/presentation_override TEXT NOT NULL`
- `review_reasons TEXT NOT NULL`
- `source TEXT NOT NULL`
- `config_hash TEXT NOT NULL`
- `archived_at TEXT NULL`

约束：`UNIQUE(channel_bot_id, external_chat_id)`；索引 `channel_bot_id,state`。

#### `run_snapshots`

- `id TEXT PRIMARY KEY`
- `schema_version INTEGER NOT NULL CHECK = 1`
- `run_id TEXT NOT NULL UNIQUE`
- `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT`
- `source_revisions/effective_agent/effective_backend_policy/effective_execution/effective_routing/effective_authorization/effective_group_tools TEXT NOT NULL`
- `effective_config_hash TEXT NOT NULL`
- `private_refs_digest TEXT NULL`
- `created_at TEXT NOT NULL`

Repository 只提供 create/get/listBySourceRevision；无 update/delete/upsert。

### 7.2 权限和 observation 表

- `principals`：字段按 4.5；unique `(channel_bot_id, kind, normalized_value_hash)`；raw normalized value 存 private column，public serializer永不返回。
- `channel_bot_admins`：unique `(channel_bot_id, principal_id)`，带 revision/source/timestamps。
- `action_grants`：字段按 4.5；索引 `(channel_bot_id, group_binding_id, principal_id, capability, state, expires_at)`。
- `channel_chat_observations`：unique `(channel_bot_id, external_chat_id)`；observation update 不碰 GroupBinding revision。
- `channel_bot_health_observations`：`channel_bot_id` unique。
- `run_runtime_bindings`：`run_id` unique；WP3 使用。

### 7.3 SecretRef 边界

`secret_refs` 仅含：

- `id`、`kind`、`provider`、`provider_key_private`、`status`、timestamps；
- 不含 secret value；
- Repository 可查询存在性/状态，不能读取 value；真正解析接口属于 server secret provider，不属于 public `RepositoryBundle`。

### 7.4 Import provenance 与 rollback

#### `import_runs`

- `id`、`source_kind`、`source_instance_id`；
- `source_root_fingerprint`、`plan_digest`；
- `status`: `planned / applying / applied_disabled / failed / rollback_pending / rolling_back / rolled_back / rollback_conflict`；
- `sanitized_summary`、`error_code`；
- timestamps。

#### `import_entities`

- `id/import_run_id/entity_kind/source_key/target_kind/target_key`；
- `source_hash/last_applied_target_hash`；
- `status`: `planned / created / updated / unchanged / conflict / blocked / archived / excluded / rolled_back`；
- `reason_code`；
- unique source natural key as defined in 3.2。

#### `import_entity_versions`

- `id/import_run_id/target_kind/target_key`；
- `before_exists INTEGER`；
- `before_value_private TEXT NULL` — validated entity JSON，只含 ref，不含 secret value；
- `before_hash TEXT NULL`；
- `after_hash TEXT NOT NULL`；
- `created_at`；
- unique `(import_run_id, target_kind, target_key)`。

#### `import_artifacts`

- source relative path/classification/content hash/archive ref/status/reason code；
- 不保存 artifact 原文、单 secret hash 或 prompt。

### 7.5 CutoverLease

`cutover_leases`：

- `channel/external_app_id` unique；
- `active_runtime`: `botmux / dockmux / none`；
- `generation positive integer`；
- `state`: `botmux_active / imported_disabled / verified_offline / ready_for_handoff / draining / observation / dockmux_active / rollback_pending / rolled_back / degraded`；
- `message_watermark_ref/schedule_watermark_ref`；
- `holder_id/lease_expires_at`；
- `revision/timestamps/last_error_code`。

WP1 只提供 compare-and-swap；WP9 才执行外部 handoff。`observation` 是整 App 切流观察，不表示流量分片。

## 8. Repository 与 transaction contract

### 8.1 核心 repository

每个可修改实体 repository 必须提供：

- `create(entity)`：自然键或 ID 冲突返回标准 conflict；
- `get(id)`；
- `getByNaturalKey(...)`；
- `list(filter, bounded pagination)`；
- `update(id, expectedRevision, patch)`：成功 revision +1；
- `archive(id, expectedRevision)`；
- `computeCanonicalHash(entity)`。

不得提供无 revision 的通用 `save/upsert` 给 importer 或管理 API。RunSnapshot 只提供 `create/get/getByRunId/listBySourceRevision`。

### 8.2 原子 batch

Storage 必须提供一个 transaction boundary，使调用方在同一 SQLite transaction 中操作 AgentDefinition、ChannelBot、GroupBinding、Principal、Grant、Import provenance 和 versions。

契约：

- callback 成功才 commit；抛错全部 rollback；
- nested transaction 禁止或使用明确 savepoint，不能悄悄在外层 commit；
- transaction 内 repository 使用同一 DB connection；
- callback 不能执行 Lark API、文件 copy、启动进程等外部副作用；
- 故障注入能在每个 entity insert/update 之后抛错，并证明无部分数据。

### 8.3 条件 rollback primitive

对每个 ImportEntityVersion：

1. 读取当前 target canonical hash；
2. 当前 hash 必须等于该 run 的 `after_hash`；
3. 相等则恢复 `before_value_private`，或在 `before_exists=false` 时 archive/delete本 run 创建的尚未被引用记录；
4. 不相等则整体或该实体进入 `rollback_conflict`，不得覆盖人工修改；
5. rollback 自身在一个 transaction 中完成；
6. rollback 不修改 Botmux 源文件，不操作 listener/lease 外部状态。

删除策略：优先 archive；只有没有外键引用、由该 import run 创建且从未被 runtime 使用的记录才允许物理删除。具体判断必须有测试。

### 8.4 CutoverLease CAS

- acquire/update 必须提交 `expected_revision + expected_generation + expected_active_runtime`；
- 任一不匹配返回 `lease_conflict`；
- WP1 不自动 steal expired lease，只返回状态供 WP9 决策；
- state transition 必须在 WP0 合法 transition 表内，非法返回 `invalid_state_transition`。

## 9. Public DTO 与 redaction

### 9.1 Agent DTO

`GET /api/agents` 的 public item只允许：

- id、name、state、revision；
- driver kind、adapter ID、protocol、runtime version；
- backend kind/persistent capability/readiness summary；
- default model、reasoning、permission mode；
- public capabilities、source kind。

禁止：command、args、env、env ref、cwd absolute path、system prompt、system/startup policy ref、private source path。

如果现有 Web 需要 cwd，提供单独受信 management DTO，字段仍需明确 allowlist；不能继续直接返回 runtime `AgentConfig`。

### 9.2 ChannelBot DTO

允许显示：identity、display、routing/access/group-tools policy、default Agent、migration/listener/credential status、revision、blocker codes。

禁止：App Secret、credential ref、Cookie、raw owner identity、private paths、legacy env/startup commands。

Credential 只返回 `missing / configured / invalid / unknown`。

### 9.3 Principal DTO

返回 id、kind、displayName、maskedDisplayValue、verification state；不返回完整 email/open/union ID。需要诊断完整 ID 的本地 CLI 也不得把值写入默认日志。

### 9.4 Import/rollback DTO

只返回 entity count、kind、safe natural key、status、reason/error code、hash 和字段 path；禁止 before/private entity JSON、source absolute secret path、prompt、env 和凭据。

### 9.5 Redaction 测试字典

测试至少种入以下 canary 值并断言 HTTP/log/error/snapshot 完全不存在：

- fake App Secret；
- fake vendor token；
- fake Cookie；
- fake full email/open ID；
- fake startup command inline secret；
- fake system prompt；
- fake schedule prompt；
- fake group-tools capability token。

测试 fixture 必须是合成值，不复制真实 Botmux 文件。

## 10. 群配置矩阵信息架构

WP8 实现页面；WP0 冻结 read model/status，WP1 保存查询所需事实。

### 10.1 导航与页面层级

```text
集成与策略
  ├─ Agent
  ├─ 飞书 Bot
  ├─ 群配置
  └─ 迁移记录
```

Task-first 首页不变。首页只可出现“迁移有 N 项待处理”的单入口，不放永久 Fleet 矩阵。

### 10.2 桌面矩阵

- 行：Lark chat，主标签为群名/头像，ID 为二级信息；
- 列：ChannelBot，表头显示 Bot migration/listener health；
- cell：GroupMatrixCell，不用单一 checkbox；
- 大规模时默认可搜索群列表 + 选定 Bot 列，提供“矩阵模式”作为运营视图；
- 移动端使用群卡片列表，不横向压缩矩阵。

### 10.3 GroupMatrixCell read model

每个 cell 必须同时返回：

1. `remoteFact`：membership state、chat type、display、last successful sync、error；
2. `desiredPolicy`：binding state、继承/覆盖摘要、revision、review reasons；
3. `runtimeFact`：Bot listener owner/health、last verified、degraded reason；
4. `effectiveSummary`：Agent、workspace display、reply/mention、talk/operate/admin summary、group tools read/send；
5. `migrationStatus`：not imported/disabled/blocked/ready/observation/active/rolled back；
6. `severity`: `healthy / info / needs_review / blocked / degraded`；
7. `primaryAction`: 一个明确动作和 target。

### 10.4 Cell 状态与文案

| 状态 | Cell 文案 | 主动作 |
|---|---|---|
| member + no binding | 已入群，未配置 | 配置此群 |
| binding + member + Bot disabled | 配置完成，Bot 尚未接管 | 查看切流准备 |
| binding + member + active | 运行正常 | 查看有效配置 |
| binding + not_member | 已配置，但 Bot 不在群中 | 检查入群状态 |
| inaccessible | 无法读取群状态 | 查看权限修复 |
| needs_review | 遗留策略待确认 | 确认策略 |
| revision conflict | 配置已被其他修改覆盖 | 比较并重试 |
| listener offline | 配置存在，listener 离线 | 查看 Bot 健康度 |
| inherit | 继承 Bot 默认 | 查看来源 |
| override | 使用群级覆盖 | 查看差异 |

### 10.5 Cell 详情抽屉

固定顺序：

1. 群与 Bot identity、remote membership、last sync；
2. 当前 active runtime 与 migration state；
3. Agent/workspace readiness；
4. Session/reply/mention 的自然语言说明；
5. can_talk/can_operate/admin 概要；
6. group tools read/discover/send；
7. 配置来源和 override；
8. blocker/失败/修复动作；
9. advanced IDs/revision/hash。

编辑保存必须携带 expected revision。若冲突，保留用户未提交编辑，在侧边展示“当前版本 vs 你的更改”，不能清空表单。

### 10.6 默认值 blast radius

编辑 ChannelBot 默认前 read model 必须能返回：

- 继承该字段的 GroupBinding 数量；
- 有覆盖、不受影响的数量；
- 当前 existing RunSnapshot 数量，并注明不会变化；
- 新值从后续 Run 开始生效。

WP1 为此提供按 Bot/override mode/source revision 的 bounded query；WP8 才组织文案。

## 11. 禁用态 ChannelBot 旅程

任何 imported ChannelBot apply 后必须是：

```text
desired_listener_state=disabled
full_trust_confirmed=false
migration_state=imported_disabled 或 blocked
```

### 11.1 Bot 详情页头部

必须持续展示状态条：

> 已导入，尚未接管飞书消息。Botmux 仍在服务此 App。

状态条包含：active runtime、credential status、readiness、blocker count、最后验证时间。

### 11.2 Disabled Bot 页面段落

按用户决策顺序：

1. **身份与凭据**：App/brand/owner verification/credential status；
2. **Agent 与执行环境**：Agent、workspace、backend、登录/readiness；
3. **群配置**：member/binding 数、needs review、effective diff；
4. **权限**：谁 can_talk/can_operate/admin；
5. **自动化**：Schedule 等 blocker；
6. **旧上下文边界**：legacy topic records 只读提示，不伪称已续接；
7. **切流准备**：未关闭项和下一步。

### 11.3 CTA 规则

- `验证离线配置`：允许；不得启动同 App listener；
- `编辑配置`：允许；修改 revision，既有 Run 不变；
- `查看迁移计划/冲突`：允许；
- `准备切流`：只有 blocker=0、credential configured、offline verify 通过时出现；
- 不提供直接的“开启监听”toggle；启用必须进入 WP9 handoff；
- `fullTrustConfirmed` 不得在 importer apply 中自动勾选；必须由具体 App 的 admin 独立确认。

### 11.4 Disabled 状态的消息语义

- Dockmux 不消费该 App Lark 消息；
- Web/API 可用该 AgentDefinition 做独立 smoke test，但结果不得伪装成该 Lark Bot 已验证；
- GroupMatrix cell 必须继承 Bot “尚未接管”状态，不能单独显示 active；
- Botmux 仍 active 时，页面不显示“迁移完成”。

## 12. 失败、冲突与 rollback UI contract

WP0 冻结状态/error code；WP1 持久化；WP7/WP8/WP9 实现行为和页面。

### 12.1 标准错误码

| Code | 含义 | 用户动作 |
|---|---|---|
| `validation_failed` | schema/override 非法 | 查看字段并修正 |
| `unknown_source_field` | Source 含未识别能力 | 分类、归档或停止迁移 |
| `source_stale` | plan 后 source fingerprint 变化 | 重新扫描 |
| `revision_conflict` | 编辑基于旧 revision | 比较并重试 |
| `natural_key_conflict` | App/Chat 等已有不同来源对象 | 保留现有或人工处理 |
| `managed_target_changed` | 目标在上次 apply 后被人工修改 | 不覆盖，显示 diff |
| `foreign_reference_missing` | Agent/principal 等引用不存在 | 修复依赖 |
| `secret_unavailable` | SecretRef 缺失/无效 | 配置或轮换凭据 |
| `transaction_failed` | DB batch 失败且已 rollback | 重试；明确“无部分写入” |
| `rollback_conflict` | 当前 target 不等于 after hash | 比较后人工合并 |
| `lease_conflict` | App 已被另一 runtime/generation 占用 | 检查 active runtime |
| `invalid_state_transition` | 非法 lifecycle 操作 | 回到允许步骤 |
| `forbidden_private_field` | private value 将进入 public/persisted contract | 阻止并报告字段 path |

错误对象只含 code、safe message、entity kind/key、field path、retryability、suggested action；不含 raw source object 或 private value。

### 12.2 ImportRun UI 状态

| 状态 | 页面标题 | 主 CTA |
|---|---|---|
| planned | 迁移计划待确认 | 解决阻塞 / 应用计划 |
| applying | 正在写入 Dockmux，Bot 仍未启用 | 等待；禁止重复 apply |
| applied_disabled | 已安全导入，尚未接管 | 离线验证 |
| conflict | 有配置冲突，未覆盖现有修改 | 比较冲突 |
| failed | 导入失败，已回滚数据库 | 查看失败并重试 |
| rollback_pending | 回滚预检待确认 | 查看影响 |
| rolling_back | 正在恢复 Dockmux 配置 | 等待 |
| rolled_back | Dockmux 配置已恢复 | 查看记录 |
| rollback_conflict | 有后续修改，未自动覆盖 | 逐项处理 |

### 12.3 冲突比较

冲突页以实体为单位显示：

- 来源版本的安全摘要；
- 当前 Dockmux 值；
- 上次 importer 写入值；
- 字段级 `same / source_changed / target_changed / both_changed`；
- 允许动作：保留 Dockmux、采用来源（仅允许的实体且需确认）、为无外部自然键对象另存、取消本 App 迁移。

App ID、Chat ID、Principal 等外部自然键不允许 rename。Secret 字段只显示 configured/changed，不显示值或单 secret hash。

### 12.4 Rollback 预览

WP1 rollback 只处理数据库配置，UI 必须明确区分：

- **配置回滚**：恢复本次 import 前实体；
- **运行切回**：listener/Schedule/lease handoff，属于 WP9；
- **外部副作用**：Lark 发版、消息、文件等不能由 DB transaction 自动撤销。

预览至少显示：

- 将恢复/归档/保持不变的实体数量；
- current hash 是否仍等于 after hash；
- 冲突实体和原因；
- 当前是否存在 RunSnapshot 引用，因而只能 archive 不能 delete；
- Botmux 源不会被修改；
- secret 不会显示。

若 transaction 失败，页面必须写“数据库未产生部分写入”。若有外部步骤部分成功，显示 `manual_cleanup_required` 和明确对象，不用模糊 toast。

### 12.5 页面关闭与重入

- ImportRun、冲突和 rollback 状态全部持久化；
- 用户关闭页面后重新进入必须回到同一阶段；
- applying/rolling_back 超时后不能仅凭前端计时判 failed，应查询持久状态和 transaction outcome；
- 每次操作进入审计时间线，记录 actor ID、时间、safe summary、result/error code。

## 13. Golden fixture 规格

WP0 创建完全合成的 fixture，满足：

- 2 个 current Lark Bot，均引用 fake credential placeholder；
- 两者 adapter 为 `claude-code`、backend 为 tmux；
- Bot A：P2P thread、group reply chat-topic、mention topic、2 个 oncall 群和相同合成 workspace；
- Bot B：P2P chat、group reply chat-topic、独立 workspace、Hammer blocker marker；
- 1 个 enabled interval schedule，只含 private payload placeholder；
- 1 个 retired Bot，仅 archive classification；
- 1 个遗留 group-tools candidate，send=false、needs review；
- owner 使用合成 principal，不含真实邮箱/open ID；
- 至少一个 unknown field，用于 fail-closed test；
- canary secret/prompt/token 值用于断言 redaction，值必须是合成且明显不可用。

Fixture 的 golden public summary 固定为：

```text
current_channel_bots=2
retired_channel_bots=1
oncall_group_bindings=2
enabled_interval_schedules=1
distinct_owner_principals=1
legacy_session_records=28
workflow_drafts=30
```

WP0 不实现真实 parser；fixture 表示 normalized source contract，供 WP7 parser 对齐。

## 14. WP0 编码任务清单与验收

### 14.1 建议文件所有权

- `packages/shared/src/`：foundation domain schema、enum、override、RBAC action、public DTO；
- `apps/server/src/`：现有 Agent route 的 allowlist serializer 接入；
- `test/fixtures` 或 package fixture 目录：脱敏 normalized Botmux fixture；
- 对应 contract/redaction tests。

不要在一个巨型 `index.ts` 内继续堆全部 schema；按 domain 分文件并从公共入口显式 export。

### 14.2 必测

- 四核心 schema valid round-trip；未知字段全部拒绝；
- Override 的 inherit/set/clear 合法组合和非法 null/空字符串；
- ChannelBot imported defaults 强制 listener disabled/full trust false；
- group tools default 不得超过 ceiling；
- RunSnapshot forbidden field canary 被拒绝；
- public Agent DTO 不含 command/args/env/system prompt/cwd/private ref；
- ChannelBot/Principal/Import DTO redaction；
- App-scoped Principal contract 不允许跨 Bot scope；
- RBAC action 到 required capability 的 exhaustive table test；新增 action 未登记时编译或测试失败；
- golden fixture summary 稳定且文件中不含真实 ID、邮箱、path、secret/prompt。

### 14.3 WP0 完成回报

- 列出新增/修改 contract 和 public DTO；
- 列出 API 响应中移除的 private 字段及 Web 兼容处理；
- 提供测试命令/结果；
- 明确未接入 storage/runtime/Lark，不能宣称功能已运行。

## 15. WP1 编码任务清单与验收

### 15.1 建议文件所有权

- `packages/storage/src/schema.ts`：新表定义；
- `packages/storage/src/migrations.ts`：forward migration；
- `packages/storage/src/` 新 domain repository/transaction 模块；
- `packages/shared` 只消费 WP0 已冻结 interface；若不足先回补 WP0 contract/test，不在 WP1 私建重复类型。

### 15.2 必测

#### 数据库升级

- 从空库和真实形状的 v10 fixture 升级；现有 Agent/Session/Task/Event/Config 行逐项不变；
- migration 重跑 no-op；中途失败 schema_migrations 不记录成功；
- DB/WAL/SHM 权限仍满足现有 private mode contract。

#### 核心实体

- 四核心 create/read/list；Agent/Bot/Binding revision update；Snapshot create-only；
- 同一 chat 两个 Bot 可有不同 workspace/access/group-tools policy；
- 同一 Bot+Chat 重复创建报 natural key conflict；
- 两个 Agent 可共用 adapter ID，但 driver/backend 不同；
- referenced Agent archive 后，ChannelBot 不被静默改指其他 Agent；
- observation 更新不改变 GroupBinding revision/hash。

#### Revision 与事务

- stale expected revision 返回 conflict，原值不变；
- 跨 2 Agent/2 Bot/2 Binding/Principal/ImportEntity 的 batch 成功一次 commit；
- 在每个写点故障注入，所有表均无部分行；
- transaction callback 中禁止/测试外部 repository 使用不同连接。

#### Rollback

- created target 且无引用可安全清理/归档；
- updated target hash 未变可恢复 before value；
- target 被人工修改时报 rollback conflict，绝不覆盖；
- 多实体中一个 conflict 时按选定 contract 整批停止，不能半回滚；
- before/after private version 不含 secret value；
- rollback 后 revision/审计状态一致且 Botmux source untouched。

#### Lease

- acquire/update/release 的 expected revision/generation/runtime CAS；
- 两个竞争者只有一个成功；
- illegal transition 拒绝；
- expired lease 不自动偷取；
- observation/public 状态不暗示流量分片。

#### 查询支持

- 按 ChannelBot bounded list GroupBinding；
- natural key lookup；
- 按 source entity/revision 找 snapshot/import mapping；
- 构造 GroupMatrixCell 所需 observation + binding + bot health 数据，无 N+1 强制路径；
- 查询结果经过 WP0 serializer 后不泄露 private 字段。

### 15.3 WP1 完成回报

- migration version、表、索引、约束清单；
- repository/transaction/rollback interface；
- 从 v10 升级与故障注入测试结果；
- 现有数据未改写的证据；
- 明确新表尚未成为 production runtime authoritative path，WP2/WP5/WP7 未完成前 ChannelBot 不可激活。

## 16. Definition of Done

WP0 只有在以下全部成立时完成：

- [ ] 四核心实体、辅助类型、override、action、状态机和 error code 已 versioned/strict；
- [ ] public DTO 采用 allowlist，现有 `/api/agents` 不再直接返回 private AgentConfig；
- [ ] redaction canary tests 覆盖 HTTP、error、log snapshot 和 entity serialization；
- [ ] golden fixture 稳定复现目标计数且无真实数据；
- [ ] 后续 WP 不需要发明第二套实体/权限/状态名。

WP1 只有在以下全部成立时完成：

- [ ] 新 schema 可从现有数据库无损升级；
- [ ] 四核心 repository、observation、principal/grant、provenance、lease 可 readback；
- [ ] 所有 mutable write 使用 expected revision；
- [ ] RunSnapshot create-only；
- [ ] 原子 batch 故障注入证明零部分写；
- [ ] 条件 rollback 不覆盖后续人工修改；
- [ ] 同 chat 多 Bot 不互相覆盖；
- [ ] `lark.bots` 仍可兼容读取，但新 foundation 没有第二个无版本写路径；
- [ ] 无 secret value 进入新表/public DTO/test snapshot；
- [ ] completion report 明确 runtime/UI/cutover 仍未接入，未越权关闭后续 gate。
