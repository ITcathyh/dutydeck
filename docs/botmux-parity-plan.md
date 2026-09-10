# BotMux → Dutydeck 能力对齐与渐进迁移方案

> 状态：设计草案；本文只定义迁移架构与验收门槛，不包含实现。
>
> 核心约束：迁移期间 BotMux 持续服务；不以“成功复制 `bots.json`”作为迁移完成；任何已使用但未被 Dutydeck 等价承接的能力，都必须阻止对应 Lark App 激活。

## 1. 结论

BotMux 的配置不是一个文件，而是一组互相关联的运行时状态：`bots.json`、全局 `config.json`、每 bot 的 `BOT_HOME`、共享 `dataDir` 下的群策略、授权、团队、计划任务、订阅、工作流及私密凭据，以及各 CLI 自己的 session/transcript。Dutydeck 当前可以直接承接 Lark 凭据、基础 Agent 配置、默认模型/工作目录、P2P/群会话路由和部分群工具；但还没有导入服务、一等的每群策略、BotMux 的团队/授权/自动化模型，也不能无歧义地表达“多个 Bot 使用同一种 CLI、但有不同启动配置”的场景。

因此采用以下原则：

1. **先盘点、再映射、后切流。** 每条源数据必须被标记为 `mapped`、`staged`、`runtime_only`、`unsupported` 或 `excluded_with_reason`，不允许静默丢字段。
2. **双轨兼容，但同一 App 不双写。** BotMux 在兼容期保持运行；Dutydeck 导入后的 bot 默认 `listening=false`。同一个 Lark `app_id` 任一时刻只能有一个 WebSocket/event consumer 对外回复。
3. **切流单位是 Lark App，而不是单个群。** 一个 App 的消息流包含其所有私聊和群聊；只有该 App 实际使用的安全、路由和启动能力全部通过 P0 门槛，才能切换。
4. **导入是可重复的受管同步，不是一次性拷贝。** 使用稳定自然键、源/目标哈希、来源映射和事务，支持 no-op 重跑、冲突检测、回滚及后续增量导入。
5. **保留不等于启用。** 尚未实现的配置进入受保护的兼容快照，BotMux 继续执行该能力；不能把未知字段写进 Dutydeck 后就宣称已兼容。
6. **密钥默认不可见。** 导入计划、日志、API 和错误不得返回 `app_secret`、Agent `env`、token、webhook key、connector credential 或启动命令中的内联密钥。

## 2. 当前实现基线

本方案基于当前代码的以下事实：

- Dutydeck `AgentConfig` 已有 `command`、`args`、`protocol`、`model`、`reasoningEffort`、`cwd`、`env`、`systemPrompt`、权限与超时等字段；Agent 以 ID upsert 到 SQLite `agent_configs`。
- 启动时会把配置文件/环境中的 Agent 写入数据库，但没有 Agent CRUD/导入 API。非 builtin Agent 不会在启动清理中被删除，因此可以作为导入落点，但运行中的 Agent catalog 需要明确 reload/restart 语义。
- `GET /api/agents` 当前直接返回运行时 `AgentConfig`。这可能暴露 `command`、`args`、`env` 和 system prompt；在导入任何含密钥的 Agent 之前必须先改为 public DTO。
- Lark bot 目前以聚合配置 `configs['lark.bots']` 保存，按 `appId` 更新；公开 DTO 已排除 `appSecret`、`env` 和 `startupCommands`。其中 `env`/`startupCommands` 仅是旧导入兼容字段，当前不会被 Agent 启动链路消费，不能作为真实迁移落点。
- Dutydeck 支持 bot 级 `p2pMode`、`groupReplyMode`、默认 Agent/模型/推理强度、监听开关、人员与 bot allowlist、高风险规则、卡片 trace 设置及群工具开关。
- Dutydeck 没有一等的 per-chat policy 表；`channel_mappings` 是卡片/投递映射，不是群配置，不能复用成授权或路由策略表。
- Dutydeck 群工具 token 使用持久化签名密钥、按 session/app/chat 绑定，向 Agent 注入的变量是 `dutydeck_group_tools_url` 和 `dutydeck_group_tools_token`。
- 当前内置 PTY CLI 覆盖 BotMux 的大部分常用 CLI，但 `mir`、`dsh`、`codex-app`、`mojo`、`riff`、`mira` 等没有可用的 server 启动路径。`codex` ID 还会优先命中 ACPX builtin；Agent 模型没有独立的 `driver_id`/`adapter_id`，所以不能用别名表达“此 bot 明确使用 PTY Codex”。
- session backend 包内虽有 PTY/tmux/zellij/zmx 相关实现，server 创建 `PtyCliDriver` 时仍使用默认 `PtyBackend`，并未注入 tmux 等持久 backend。BotMux 的 backend 选择以及“Dutydeck daemon 重启不终止正在运行的 CLI”都尚无等价运行时落点。
- Dutydeck 能持久化自己的 session、task、event、tool call 和 Lark channel mapping，但 BotMux session ID、CLI transcript、session-group 出生关系与 Dutydeck session schema 不兼容。

相关代码入口：

- Agent/schema：`packages/shared/src/index.ts`、`packages/config/src/index.ts`
- Agent runtime：`packages/agent-runtime/src/index.ts`
- SQLite/schema：`packages/storage/src/schema.ts`、`packages/storage/src/index.ts`、`packages/storage/src/migrations.ts`
- ACPX 持久化：`packages/acp-client/src/index.ts`、`packages/acp-client/src/acpx.test.ts`
- Server/Lark：`apps/server/src/app.ts`、`apps/server/src/lark/config.ts`、`apps/server/src/lark/routes.ts`
- 路由/群工具：`apps/server/src/lark/session-resolver.ts`、`apps/server/src/lark/agent-tools.ts`
- CLI/service：`apps/server/src/cli-program.ts`、`apps/server/src/service.ts`

## 3. 源数据盘点范围

导入器必须按 BotMux 自己的寻址规则读取源数据，不能假设所有文件都在 `~/.botmux`：

| 源类别 | 典型位置/内容 | 处理要求 |
|---|---|---|
| Bot registry | `BOTS_CONFIG` 指向的精确文件，或 `~/.botmux/bots.json` | `BOTS_CONFIG` 优先；读取 BotMux 归一化语义而非简单复制原始 JSON |
| 全局配置 | `~/.botmux/config.json` | 盘点语言、代理、维护、更新、voice、VC、skills/plugins、host alert 等全局能力 |
| Bot profile | `{dataDir}/bot-profiles/<appId>.json`、`bot-owners.json`、`bot-union-ids.json` | 补齐展示、owner 和跨应用身份信息；`ou_` 不得跨 App 复制 |
| 群与授权 | `bots.json` 内 `allowedChatGroups`、`oncallChats`、`chatReplyModes`、`chatGrants`、quota/expiry；以及 session-group、substitute、first-seen 等 store | 转为一等 per-chat policy；动态/临时授权需保留到期语义 |
| 团队/联邦 | `teams.json`、`team-groups.json`、`team-bots.json`、federation、platform team、peer cross-ref、observed bot 等 store | 不得降级成普通 allowlist；未实现前保持 BotMux 执行 |
| Agent 定制 | bot 的 CLI/runtime/backend、cwd、env、startup commands、sandbox、model、skills、plugins、role profile、system prompt | 合并为独立 Agent profile；私密值进入 secret store/ref，不进 public DTO |
| 自动化 | 每 bot `schedules.json`、async trigger、hooks/webhook、message listener、doc subscription、connector、workflow/issue board | 逐项盘点触发条件、幂等键、投递目标和 secret；不能只迁定义不迁执行语义 |
| 会话与投递 | `sessions-*.json`、session groups、frozen cards、dedup/idempotency、usage、CLI transcript/history | P0 不直接续接；先只读归档。以后按 CLI 类型设计可验证的 adopt/import |
| 协作产物 | whiteboard、team board、summary、feedback、VC meeting stores、role/profile Markdown | 保留文件层级与 provenance；未有等价 schema 时不扁平化 |
| 私密存储 | app secret、env、webhook/feedback secret、connector credential、daemon auth 等 | 只通过本地受限读取；不出现在 plan、diff、日志、API 或逐字段哈希中 |

每次 plan 都必须输出**按类别计数**和**未识别文件列表**。出现新 store 或未知字段时默认 fail closed；只有显式 `excluded_with_reason` 且不影响拟切流 App，才可继续。

## 4. Capability parity matrix

状态定义：

- **支持**：Dutydeck 已有等价运行时语义；仍可能缺导入接线。
- **部分**：有相近模型，但字段、默认值、作用域或运行路径不等价。
- **缺失**：没有可安全承接的运行时模型。
- **归档**：切流时不执行，仅保留来源与恢复能力。

优先级定义：

- **P0**：某 App 切流前必须完成；发现该 App 使用该能力时必须阻断激活。
- **P1**：主要交互/协作能力；一旦源 App 使用会动态提升为 P0。
- **P2/P3**：长尾或历史能力；仍需盘点和保留，不代表允许静默丢失。

| BotMux 能力 | Dutydeck 当前状态 | 缺口/风险 | 目标数据落点 | 优先级 |
|---|---|---|---|---|
| Lark `appId/appSecret`、名称、品牌、展示名 | 支持 | 没有批量导入；聚合 JSON 的并发 RMW 可能丢更新 | `lark_bots` + private `secret_refs`；过渡期兼容 `lark.bots` | P0 |
| bot 启停、`apiOnly`、auto-start | 部分 | 只有 `listening`；导入时若自动监听会与 BotMux 双回复 | `lark_bots.listener_state` + `cutover_leases` | P0 |
| owner、allowed users/email/bots | 部分 | Dutydeck 主要支持 `ou_`/email；BotMux 还有 `on_`、owner、跨 bot 身份信息 | 结构化 `lark_principals`，区分 `open_id/union_id/email/bot` 与所属 app | P0 |
| `allowedChatGroups`、oncall chat | 缺失 | 没有群级 allow/deny/oncall 模型 | `lark_chat_policies` | P0 |
| chat grants/global grants、grant expiry、quota、slash 限制、auto-grant | 缺失 | 直接丢失会扩大或缩小权限 | `lark_grants`、`lark_quotas`、policy evaluator | P0（使用即阻断） |
| 高风险命令控制 | 部分 | Dutydeck 有 bot 级 allowlist/regex/risk mode，但与 BotMux grant/sandbox 语义不同 | bot risk policy + chat/user grant evaluator | P0 |
| P2P `chat/thread` 路由 | 支持 | 必须显式物化默认值，避免版本默认漂移 | `lark_bots.p2p_mode` | P0 |
| 普通群 `chat/shared/new-topic/chat-topic` | 部分 | BotMux 缺省是 `chat-topic`；Dutydeck 缺省会走 legacy per-sender 路由，不能留空 | `lark_bots.group_reply_mode`，导入时写显式 `chat-topic` | P0 |
| 每群 reply/mention/substitute/no-card/no-CoT 等覆盖 | 缺失 | Dutydeck 只有 bot 级 group mode 和少量全局卡片项 | `lark_chat_policies.routing_json` / typed columns | P0/P1 |
| default Agent/model/reasoning/cwd/timeout | 部分 | 可表达基础值，但 timeout 和 bot profile 的完整启动语义未完全接线 | 独立受管 `agent_configs` + `lark_bots.default_agent_id` | P0 |
| 多 Bot 共用同一 CLI、配置各自独立 | 部分 | Agent ID 兼作 adapter ID，别名无法选 adapter；会互相覆盖或无法启动 | Agent 增加 `driver_id`/`adapter_id`；稳定导入 ID `botmux:<appId>:<cliId>` | P0 |
| Codex PTY 与 ACPX Codex 区分 | 缺失 | `codex` builtin collision 会优先使用 ACPX，迁移后协议可能变化 | 明确 `driver_kind=pty/acpx` + `adapter_id=codex` | P0 |
| 常用 CLI 启动 | 部分 | 多数贡献已存在；`mir/dsh/codex-app/mojo/riff/mira` 等不可由 server 启动 | driver catalog + capability probe | P0（实际使用者）/P1 |
| env | 部分 | Agent 有 env，但 Agent API 会泄密；Lark legacy env 不会被运行时消费 | Agent private env refs；public serializer；ACPX runtime bridge | P0 |
| startup commands、wrapper、launch shell、runtime override | 缺失/部分 | Lark 字段只是 dormant 兼容数据；不能假装已执行 | typed launch profile + 首次启动/每次启动明确语义 | P0（实际使用者）/P1 |
| PTY/tmux/zellij/zmx/backendType | 部分 | backend 包存在，但 server 未注入，实际默认 `PtyBackend` | `agent_configs.backend_type` + backend factory | P0 |
| daemon 重启不中断 CLI、重启后重连 | 缺失 | 当前 `PtyBackend` 子进程生命周期不能当作持久 backend；已有 session DB 行不等于 CLI 进程仍存活 | 持久 backend ownership、attach/reconcile、orphan 检测和 restart protocol | P0 |
| sandbox、sandbox paths/network、disable bypass | 缺失/部分 | Dutydeck 的 full-trust 确认不是 BotMux sandbox 等价物 | execution policy/sandbox profile；未映射时禁止 full-trust 激活 | P0 |
| working dirs、default dir、repo picker、auto-worktree、same-dir inheritance | 部分 | 仅固定 workspace/cwd 可直接表达 | agent workspace + chat/session workspace policy + worktree registry | P0（固定 cwd）/P1 |
| group tools：成员/消息/peer/bot/send/reply | 支持/部分 | Dutydeck 有受 session/app/chat 约束的工具；send 是 bot 级开关，缺每群授权 | capability token + `lark_chat_policies.group_tools_*` | P0/P1 |
| 群管理：建群、改名、邀请、转让、删除、离群 | 缺失 | 目前主要是 chat/member 查询 | 独立 group admin service + 审计/高风险确认 | P1 |
| streaming card、trace、thinking、silent reaction、private/writable terminal | 部分 | Dutydeck 有 live card、trace/hide trace；多数 BotMux 细粒度偏好缺失 | bot/chat presentation policy | P1 |
| bot-to-bot、peer trust、same-dir | 部分 | allowed bots 与 peer tools 已有基础；没有完整 team/federation 信任根 | principals + team/federation graph + per-chat capability | P1 |
| teams、team groups、federation、platform roster、role profiles | 缺失 | 不能扁平映射为 allowedBots，否则丢失作用域与信任边界 | `teams`、`team_members`、`team_chats`、`federations`、role artifact store | P1/P2 |
| system prompt、pre-inject prompt、skills/plugins | 部分 | 有 system/pre-inject prompt；无 BotMux 注入策略、registry、feedback/pack 等完整语义 | versioned agent customization + skill/plugin registry | P1 |
| message listeners、content trigger、substitute mode、doc/comment subscription | 缺失 | 影响触发和回复范围，迁移定义但不执行会漏消息 | trigger/subscription tables + idempotent dispatcher | P1/P2 |
| schedule、async trigger、hook/webhook、workflow | 缺失/部分 | Dutydeck 有 session relay，但无 BotMux schedule/workflow 执行模型 | schedules/triggers/outbox + secret refs + execution audit | P1/P2 |
| session group 出生关系、owner/reminder、feed metadata | 缺失 | Dutydeck group session 路由不包含 BotMux 的出生/归属关系 | session lineage/group registry | P2 |
| session/history/resume/adopt、CLI transcript | 缺失/归档 | 两边 session ID 与 transcript 格式不兼容；盲目复用会串会话 | read-only legacy session catalog；逐 adapter 验证后 adopt | P2 |
| dedup、idempotency、frozen card、outbox | 部分/归档 | Dutydeck 有自己的 task/event/tool-call/channel state，不能直接复用 BotMux 运行态 | 不迁活跃锁；仅迁需持续的 idempotency key/outbox，带 namespace | P0（切流窗口）/P2 |
| voice、VC meeting agent | 缺失 | 包含外部凭据、监听角色和复杂 delivery state | 独立 connector/meeting 模块；之前保持 BotMux | P2 |
| whiteboard、team board、summary、issue board、feedback、usage | 缺失/部分 | Dutydeck 无等价协作产物模型 | versioned artifact/board/ledger store 或只读 archive | P2 |
| connector、webhook、feedback secrets | 缺失 | 不能放入普通 config JSON 或 plan | private `secret_refs` + connector-specific schema | P0（实际使用者）/P2 |
| 全局语言、代理、更新、维护、overload/notifier、timezone | 部分 | Dutydeck 有自身 auth/update，其他机器级行为不等价 | typed host settings；不自动覆盖 Dutydeck 运维配置 | P2/P3 |
| 部署身份、seen-message、临时锁、runtime tombstone/cache | 归档/不迁 | 机器运行态不应跨系统复用；但切流需定义 dedup 水位 | import manifest 记录排除原因；切流水位单独生成 | P0（dedup 水位）/P3 |

矩阵中的静态优先级不是豁免规则：例如 VC 通常是 P2，但某个拟切流 App 正在承担会议监听时，该能力立即成为该 App 的 P0 blocker。

## 5. 目标数据模型

### 5.1 Agent 与 Lark bot

`agent_configs` 需要补足启动身份，而不是继续让 `id` 同时充当业务 profile ID 和 CLI adapter ID：

- `id`：稳定 profile ID，例如 `botmux:<app_id>:<source_profile_key>`。
- `driver_kind`：`pty`、`acpx` 或未来 driver 类型。
- `adapter_id`：`codex`、`claude-code`、`gemini` 等真实 adapter。
- `backend_type`：`pty/tmux/zellij/zmx/...`；只有 capability probe 通过才允许激活。
- 公共字段与私密启动字段分离；`env` 中的 secret 使用引用，public Agent DTO 永不返回 env/command/args/system prompt。

Lark bot 从聚合 `lark.bots` 演进成一等实体：

- `lark_bots(app_id UNIQUE, display fields, default_agent_id, routing defaults, listener_state, trust state, revision, ...)`
- `secret_refs(id, kind, encrypted_or_private_value, created_at, rotated_at, ...)`
- `lark_bot_secrets(app_id, app_secret_ref, ...)`
- `lark_principals(id, app_id, kind, value, display_name, verified_at, ...)`

过渡期可双读旧 `configs['lark.bots']`，但只允许一个写路径；迁移完成后不得同时对聚合 JSON 和新表做无版本的 read-modify-write。

### 5.2 群策略

新增 `lark_chat_policies`，至少以 `(app_id, chat_id)` 唯一，覆盖：

- allow/deny/oncall 状态；
- reply mode、mention mode、session scope；
- group tools read/send 权限；
- no-card/no-CoT/trace 等展示覆盖；
- substitute/listener/subscription 开关；
- revision、source、updated_at。

授权和 quota 不应塞进不透明 JSON：

- `lark_grants(app_id, chat_id, principal_id, capability, expires_at, source, revision)`
- `lark_quotas(app_id, chat_id, principal_id, window, limit, consumed, reset_at)`

所有鉴权都应通过同一个 policy evaluator，避免 listener、群工具和高风险命令各自解释配置。

### 5.3 导入 provenance 与版本

新增专用 import repository，并提供单 SQLite transaction 的 apply/rollback：

- `import_runs(id, source_kind, source_root_fingerprint, plan_digest, status, started_at, finished_at, sanitized_summary)`
- `import_entities(source_id, entity_kind, source_key, target_kind, target_key, source_hash, last_applied_target_hash, run_id, status, UNIQUE(...))`
- `import_entity_versions(run_id, target_kind, target_key, before_value_private, after_hash)`，用于可逆回滚；私密快照不可通过 API 读取。
- `import_artifacts(run_id, relative_path, kind, content_hash, classification, archive_ref, status)`，确保所有源文件和字段都有处置结果。
- `cutover_leases(app_id UNIQUE, active_runtime, generation, acquired_at, handoff_watermark, status)`，防止同一 App 双消费者。

当前 `RepositoryBundle` 没有跨 repository 的事务边界，不能用多个普通 `save()` 拼成导入。导入必须由 storage 层提供原子 batch：Agent、Lark bot、chat policy、principal、provenance 任一失败时全部回滚。

### 5.4 兼容快照

完整功能保护依赖不可变源快照：

- plan 阶段只读取；apply 前把本次使用的配置类 artifact 复制到 run staging，目录 `0700`、文件 `0600`。
- snapshot 不删除、不改写 BotMux 源文件；API 只返回 artifact 分类、计数和整体 fingerprint。
- 不为单个 secret 输出 hash；错误中只使用 JSON path，例如 `bots[2].env.<redacted>`。
- 大体积 transcript/session 可先登记 path、size、mtime 和内容 hash，P2 再归档；原 BotMux 数据保留期内不得清理。
- 文件系统 staging 与 SQLite 无法组成真正的单事务：snapshot staging 失败时不得开始 DB apply；DB 失败时 run 标记 failed 并保留/清理孤儿 staging；只有 DB commit 后才把 snapshot 标为 committed。

## 6. 幂等导入、冲突与回滚

### 6.1 Plan

建议本地 CLI 为唯一可以指定任意源路径的入口：

```text
dutydeck import botmux plan [--bots-config <exact-file>] [--data-dir <dir>]
dutydeck import botmux apply --plan-id <id> [--on-conflict preserve|rename|overwrite]
dutydeck import botmux rollback --run-id <id>
```

默认行为是 plan/dry-run。Web/API 只能查看已由本地 CLI 建立的 redacted plan 或触发既定 plan apply，不能接受任意服务器文件路径，避免把 Dutydeck auth 变成任意文件读取能力。

Plan 必须：

1. 按 `BOTS_CONFIG` 精确路径优先规则解析源；
2. 使用 BotMux parser 的归一化默认值，或建立有测试覆盖的等价 parser；
3. 生成完整 capability usage report、entity diff、blocker 和 artifact coverage；
4. 只返回字段路径和脱敏摘要；
5. 记录整体源 fingerprint 与 plan digest。

### 6.2 稳定键和 no-op

- Lark bot 自然键：`app_id`。
- Agent 自然键：`source_id + app_id + source_profile_key`，不能只用 `cli_id`。
- Chat policy：`app_id + chat_id`。
- Principal：`app_id + identity_kind + identity_value`。
- 其他对象采用其 BotMux 稳定 ID，并保留 source namespace。

重复 apply 时，若整体源 fingerprint 未变且所有 target hash 等于 `last_applied_target_hash`，结果必须是 no-op，不产生重复 Agent、grant、schedule 或 listener。

### 6.3 默认冲突策略

默认 `preserve`：

1. 目标不存在：创建并登记 provenance。
2. 目标由同一 source 管理，且当前 target hash 等于上次 applied hash：允许按新 source 更新。
3. 目标被用户修改、来源不同、或已有手工同 `app_id` bot：报告冲突并跳过；不得覆盖。
4. `rename` 只适用于无外部自然键的对象（例如 Agent profile）；Lark `app_id`、chat ID、principal 不允许通过改名逃避冲突。
5. `overwrite` 必须逐类显式确认，并保存 before version；secret 的覆盖也不能出现在 diff 文本中。

Apply 必须重读源并校验 fingerprint 和 plan digest。plan 后源发生变化时返回 stale-plan，要求重新 plan，不能带着旧 diff 写新数据。

### 6.4 回滚

- 单次 apply 的所有目标变更使用同一 DB transaction；失败自动回滚。
- 已提交 run 的 rollback 使用 `import_entity_versions` 逆向恢复，仅当目标仍等于该 run 的 `after_hash`。若已有后续人工修改，停止并报告冲突。
- rollback 只恢复 Dutydeck，不修改/删除 BotMux 数据。
- 已切流 App 的运行回滚顺序是：Dutydeck 停止接收并 drain → 写 handoff watermark → 释放 Dutydeck lease → 恢复 BotMux listener → 验证消息和授权；不能简单先启动 BotMux 造成双回复。

## 7. Secret 与 API 安全门槛

在首个真实导入之前必须完成：

1. `/api/agents` 和所有 Agent/session DTO 使用 allowlist serializer，不返回 `env`、`command`、`args`、system prompt、secret ref 内容。
2. `lark_bots` public DTO 继续排除 app secret、env、startup commands；任何新 import API 也遵守相同规则。
3. plan、日志、telemetry、异常和测试 snapshot 只显示 `<redacted>`；不能 `JSON.stringify` 原始 BotMux config。
4. SQLite、WAL、snapshot、runtime env bridge 均保持 private 权限；备份/导出默认不含 secret，含 secret 的恢复包需显式选项。
5. owner 身份遵守 App scope：`ou_` 只能用于产生它的 Lark App；跨 App 只能用 email/mobile/`on_` 等可验证身份，再通过目标 App 解析。无法验证时阻断激活。
6. 导入不会自动设置 `fullTrustConfirmed=true`。只有 capability report 无 blocker，且操作者对具体 App 显式确认，才允许启用 full-trust/listener。

## 8. ACPX `session_options` 约束

导入 Agent env 时必须保留原环境变量的大小写，不能为了通过 ACPX 校验把 vendor key 改名：

- ACPX 会递归校验持久化 `session_options` 的所有 object key，持久化键必须是 `snake_case`。
- `OPENAI_API_KEY`、`ANTHROPIC_*` 等大写或非 snake_case key 继续走现有 `0600` runtime env JSON bridge；持久化 session 只保存 `dutydeck_agent_env_file` 和 digest 等 snake_case 元数据。
- 群工具直接写入 ACPX session 的键只能是 `dutydeck_group_tools_url` 和 `dutydeck_group_tools_token`。
- 如需兼容旧 `DUTYDECK_GROUP_TOOLS_*`，只能在读取边界兼容；禁止把大写键写回 `session_options.env`。
- 导入 plan/diff 不显示 env value，且不能因“未持久化到 session_options”误判 env 未迁移。

必须增加使用真实 `AcpxAdapter` 和真实持久化 session key 的回归测试，覆盖：

- 导入 Agent 含大写 vendor secret 时能启动；secret 只存在 runtime bridge，不在 persisted session/options/store；
- 群工具两个小写键可持久化并在 session scope 变化时刷新；
- `session_options` 任意层级没有大写或非 snake_case object key；
- 重连/恢复 session 后 env bridge 仍可用，文件权限正确；
- 仅 mock ACP client 的测试不计入验收。

## 9. 双轨兼容与切流流程

兼容期保持 BotMux 二进制、配置、数据目录和其他 bot daemon 原样运行。Dutydeck 的导入不是接管动作。

### 9.1 双轨状态

每个 App 有明确状态：

```text
botmux_active
  -> dutydeck_imported_disabled
  -> dutydeck_verified_offline
  -> handoff_draining
  -> dutydeck_canary
  -> dutydeck_active
  -> botmux_retained_for_rollback
```

- `dutydeck_imported_disabled`：凭据和配置已导入，但 `listening=false`、未确认 full trust。
- `dutydeck_verified_offline`：通过 Web/API 发起 Dutydeck 本地 Agent 测试，不连接同一 App 的消息流。
- `handoff_draining`：只停止该 App 的 BotMux listener/daemon 并记录消息水位；BotMux 的其他 App 继续运行。
- `dutydeck_canary`：Dutydeck 获得 App lease 后才开启 listener；同一 App 禁止 BotMux 同时重连。
- `botmux_retained_for_rollback`：源配置和运行环境继续保留，直到观察期和全部 parity 验收完成。

如果现有部署无法按 App 单独停止 listener，就不能在同一 App 上做在线 shadow；应使用独立测试 App，或先补 per-App drain/lease 能力。绝不能依赖“两个 consumer 大概不会同时收到消息”。

### 9.2 切流水位

切流需记录最后处理的 Lark message/event 时间和可用幂等键。Dutydeck 启动后对水位附近消息执行 dedup；BotMux 的临时锁、PID、cache 不迁移。对无法建立确定水位的事件类型，canary 必须选择低风险窗口并保留人工核对清单。

## 10. 分阶段实施与验收

### 阶段 0：完整盘点与安全护栏

范围：只读 inventory、public DTO 收口、import schema/transaction 设计、source snapshot。

验收标准：

- 对目标 BotMux 实例扫描 `bots.json`、全局 config、BOT_HOME、dataDir 和已知 store，artifact coverage 为 100%。
- 每个字段/文件都有 classification；未知项使 plan 失败而非告警后继续。
- `/api/agents`、Lark public config、plan、日志和错误的 secret 泄漏测试通过。
- plan 不写 Dutydeck、不改 BotMux；连续两次 plan digest 一致。
- DB transaction、provenance、before version 和 rollback 设计经故障注入测试覆盖。
- BotMux 正常运行，Dutydeck 尚未监听任何导入 App。

### 阶段 1：P0 核心配置导入（默认禁用）

范围：Lark bot/secret、独立 Agent profile、driver/adapter、model/reasoning/cwd/env、principal、群 allow/oncall、路由默认、chat policy、grant/quota/risk、cutover lease。

P0 激活门槛：

- App credential 能通过目标 Lark app 验证；`ou_`/`on_`/email 身份完成 scope 校验。
- 该 App 使用的 CLI、driver kind、backend、startup command、env、sandbox 行为有等价实现；否则 blocker。
- Dutydeck daemon 重启不会终止已运行 CLI，重启后能按持久 backend 身份重新 attach；仅恢复数据库 session 行不计通过。
- BotMux 缺省 group reply mode 被显式导成 `chat-topic`；每群覆盖逐条一致。
- allow group、oncall、grant、quota、expiry 和高风险策略的 golden cases 一致。
- 同 CLI 的多个 bot 生成不同 Agent profile；PTY Codex 不会误选 ACPX Codex。
- 导入后 listener 仍为 disabled，`fullTrustConfirmed` 仍为 false。
- 同一源重复 apply 为 no-op；人工修改目标后重跑产生 conflict，不覆盖。
- 在 Agent/Lark/chat policy 任一写入点故障，数据库无部分数据。
- 真实 `AcpxAdapter` snake_case 与 secret bridge 测试通过。

### 阶段 2：单 App canary 与可逆切流

范围：per-App drain/lease、handoff watermark、消息 dedup、运行健康与一键回滚 runbook。

验收标准：

- BotMux 其他 App 全程继续服务；目标 App 不存在双 listener 窗口。
- canary 覆盖私聊、普通群、话题群、@/非@、允许/拒绝用户、允许/拒绝群、高风险命令、群工具 read/send。
- 回复 session scope、模型、cwd、env 和卡片行为符合迁移 plan。
- 重启 Dutydeck 后 lease、群策略、ACPX session 与 secret bridge 可恢复；PTY 类 Agent 的 CLI 进程保持运行并重新 attach，不产生第二个进程。
- 演练 Dutydeck → BotMux 回滚，无重复回复、无未授权执行、无源配置改写。
- canary 观察期内无 P0 blocker 后，才可将 App 标为 `dutydeck_active`。

### 阶段 3：P1 群协作与定制能力

范围：群管理、per-chat presentation、bot-to-bot/team/federation、worktree/repo policy、skills/plugins/role、message listener/subscription，以及实际在用而被提升为 P0 的能力。

验收标准：

- parity matrix 中该阶段每个“源中已使用”的对象都有行为测试，不只验证数据库行存在。
- team/federation 信任边界与 BotMux 一致，不能因扁平化扩大 peer 能力。
- 群管理和跨群发送均有审计、高风险确认和 per-chat policy 校验。
- skill/plugin/role artifact 有版本、来源、回滚和 secret 扫描。
- 已切流 App 的增量 re-import 仍遵守 managed-target hash 冲突规则。

### 阶段 4：P2 长尾、历史与退役评估

范围：schedule/workflow、session/adopt、docs、VC/voice、whiteboard/boards、feedback/usage、connector 及全局运维配置。

验收标准：

- 所有 source artifact 最终为 `mapped`、`runtime_only`、`archived` 或经批准的 `excluded_with_reason`，不存在 unknown。
- schedule/listener/webhook 的触发、幂等、重试、outbox 和 secret 行为有端到端测试。
- session adopt 按 adapter 分别验证；失败时安全退回只读历史，不创建错误续会。
- 全部 App 完成各自实际使用能力的 parity 验收、回滚观察期结束、操作者明确批准后，才讨论停止 BotMux。
- BotMux 源快照和恢复说明按约定保留；退役操作不属于导入 apply，必须是独立、显式步骤。

## 11. 必测场景清单

除各阶段验收外，至少覆盖：

- `BOTS_CONFIG` 指向非默认文件，且 config dir/dataDir 分离；
- 空值与缺省值语义，特别是 group reply `chat-topic`；
- 两个 bot 使用同一 CLI 但不同 cwd/env/model/startup command；
- 手工 Agent ID 与导入 Agent ID 冲突、手工 Lark appId 冲突、跨来源冲突；
- plan 后源文件变化、apply 中途崩溃、snapshot 失败、SQLite rollback、rollback 后再 import；
- app secret/env/webhook secret 不出现在 HTTP、CLI、日志、exception、telemetry、test snapshot；
- allowed user 的 `ou_` 同 App 成功、跨 App 失败，`on_`/email 经目标 App 验证后成功；
- grant 到期、quota 临界值、高风险 allow/deny、群工具 token 越 chat/session 使用失败；
- BotMux listener 未 drain 时 Dutydeck lease 获取失败；Dutydeck active 时 BotMux 重连被 runbook/guard 阻止；
- Dutydeck 重启、BotMux 重启、ACPX session reconnect、runtime env bridge 丢失/权限异常；
- 新增未知 BotMux store/字段导致 plan fail closed，并在 coverage report 中可见。

## 12. 非目标与禁止捷径

- 不在第一阶段尝试把所有 BotMux 历史 session 强行转换成 Dutydeck session。
- 不把 `channel_mappings` 当作群策略表。
- 不把每 bot 的 env/startup commands 塞进 Lark legacy 字段后视为已迁移。
- 不按 `cli_id` 合并 Agent profile，也不让 `codex` ID 隐式决定 PTY/ACPX。
- 不自动确认 full trust，不在 import 完成时自动监听。
- 不让 BotMux 与 Dutydeck 同时消费同一 App 来做“影子流量”。
- 不删除、重写或就地迁移 BotMux 源数据；退休是迁移完成后的单独决策。
- 不因某能力优先级是 P2 就忽略它；源 App 正在使用时必须升级为切流 blocker。

按此方案，Dutydeck 可以先可靠承接实际使用的核心 bot/Agent/群能力，同时保持 BotMux 作为未完成能力的运行时与完整恢复源，逐 App、可审计、可回滚地完成迁移，而不是以一次不可逆的配置复制换取表面上的“导入成功”。
