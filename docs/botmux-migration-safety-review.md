# Botmux → Dutydeck 迁移安全与可执行性评审

> 评审日期：2026-08-30（PRC）
>
> 评审对象：`botmux-capability-audit.md`、`botmux-data-migration-inventory.md`、`botmux-parity-plan.md`
>
> 安全边界：本文只记录字段语义、数量、代码路径和脱敏结论，不记录任何 Secret、token、cookie、邮箱全文、App 视角身份值、消息正文、任务 prompt 或 workflow goal。

## 1. 结论

当前结论是：**NO-GO 激活/切流，GO 只读 plan；完成本文 P0 修正后，才可 GO 禁用态 staging。**

三份文档的总体方向正确：按 App 切流、按 `App × Chat` 建模、派生身份缓存不迁移、历史 session/workflow 默认归档、导入不自动监听、受管实体使用稳定键和目标哈希。但当前规格仍有若干相互矛盾或尚无实现落点的部分，不能直接据此实现一个会写库或启用 listener 的 Importer。

本机两个当前 App 均存在激活阻断项：

- `bdev-helper` 实际使用 2 条 oncall、1 条 enabled schedule、群级 mention 行为、1 组来源不明的遗留群工具配置，以及 tmux 持久会话语义。
- `hammer` 实际使用 Hammer full/gate/prompt 注入策略和 tmux 持久会话语义。

允许先导入“禁用态配置”不等于允许切流。`--skip-schedules`、不导入历史或用户确认 full trust，都不能豁免某 App 的激活 blocker。

## 2. 对真实源数据的复核

### 2.1 已确认的权威输入

| 数据源 | 复核结果 | 迁移边界 |
|---|---:|---|
| `~/.botmux/bots.json` | 2 个当前 Bot、2 条 oncall；无 chat/global grants、无 per-bot env/startup commands | 当前 Bot 权威源；Secret 值只进入私密读取通道 |
| `~/.botmux/bots/*/schedules.json` | 3 个 per-bot store，合计 1 条任务且 enabled | schedule 权威源；prompt、message/root ID 属私密业务数据 |
| `~/.botmux/data/teams.json` | 1 个空 team | 可导入为空壳或记录为已审计排除，不阻塞当前运行 |
| `~/.botmux/data/sessions-*.json` | 28 条：25 条 metadata-active、3 条 closed；全部为 group/thread、tmux、`agentFrozen=true` | 只读 legacy catalog/冷归档；`active` 不证明 OS 进程仍存活 |
| `~/.botmux/v3-runs/*/grill.state.json` | 30 条，全部为 `grilling`；无 spec/dag/attempt 文件 | 未完成草稿，仅归档，不创建 Dutydeck Task/Run |
| `bots.json.bak` 与派生 identity cache | 含 1 个已从当前 registry 移除的历史 Bot | 仅 orphan 检测；不得自动复活或作为 owner 权威源 |
| feedback SQLite / WAL | 当前库 WAL 活跃；无实际 feedback label/delivery | 如归档须 SQLite online backup；不能只复制主 DB |

Botmux 的真实寻址优先级也得到代码确认：Bot registry 先看精确的 `BOTS_CONFIG`，data root 为 `SESSION_DATA_DIR` → `.data-dir` breadcrumb → 默认 data 目录；schedule 位于由 data root 推导出的 per-bot `BOT_HOME`。Importer 不能只扫描固定的 `~/.botmux`。

### 2.2 不能从历史数据反推配置

- 同一个群在 session 历史里出现于多个 App，只能证明多个 Bot 曾在该群产生过 session，不能证明这些 App 当前都有 oncall、allowlist 或群工具授权。
- 历史 session 的 `rootMessageId`、CLI session ID 和 tmux target 不能直接变成 Dutydeck `channel_mappings`。两套 session key、进程所有权和 transcript 语义不兼容。
- `bots-info.json`、bot open/union ID cache、allowed-user cache 只是某个 App 视角下的派生结果，不能替代目标 App 的在线验证。
- 遗留 `.env` 中的网关 App/Chat 字段没有当前 Botmux 源码消费者。它只能标成 `unknown_external_legacy`，不能直接认定为现行群工具授权。

## 3. P0 blockers 与推荐修正

### P0-1：现有 Lark 保存路径无法安全落“禁用态完整配置”

事实：`apps/server/src/lark/config.ts::saveLarkConfig` 在写入 `stage='agent'`、`defaultAgentId` 或 `listening=true` 时要求 `fullTrustConfirmed=true`。而安全方案要求导入后同时满足：已有默认 Agent、`fullTrustConfirmed=false`、`listening=false`。

风险：若 Importer 复用当前保存 API，就会被迫提前确认 full trust；若绕过 API 直接写 `configs['lark.bots']`，又会绕过校验、并发保护和未来 schema 约束。

修正：

1. 增加一等 `staged/disabled` 配置状态，允许保存完整期望配置，但禁止 listener/runtime 消费。
2. `full_trust_confirmed` 只能由独立 activate 操作设置；从 Import CLI 删除 `--confirm-full-trust`，或明确它只存在于 `activate` 子命令。
3. Import apply 永远写 `listening=false`；验证和切流为另一条有审计的命令。

### P0-2：实际使用的能力尚无等价运行时

以下不是“以后再补”的一般性差异，而是本机当前 App 的激活 blocker：

| 实际资产 | 当前缺口 | 必须满足的激活门槛 |
|---|---|---|
| 2 条 oncall | 无 `(app_id, chat_id)` policy、无 talk/operate 分级 | whole-group talk 与 owner operate 分离；群级 CWD 生效 |
| 1 条 enabled schedule | 无 scheduler/store/outbox | 完整保留表达式、时区、thread root、continuation、delivery、幂等 fire ID；否则对应 App 不切流 |
| `topic` mention policy | Dispatcher 只支持默认 @ 路径 | 顶层/@/Bot 自有 topic 的行为与源端一致 |
| Hammer full/gates/injection | 无 Hammer runtime/policy | 未实现时 Hammer App 保持 disabled，不得降级成普通 Claude Code |
| tmux backend 与历史 target | server 生产路径仍使用普通 PTY | backend readiness、持久身份、daemon restart reattach 通过真实进程 E2E |
| 遗留群工具配置 | 当前仅 per-App 开关，来源语义不完整 | per-App+Chat policy；默认 disabled 且 send=false，人工确认来源后才启用 |

文档优先级需要统一：Schedule 可以在通用 roadmap 中排 P1/P2，但本机已有 enabled schedule，因此对其所属 App 动态提升为 P0。`--skip-schedules` 只能让禁用态配置 staging 继续，不能让该 App 激活。

### P0-3：Secret/PII 的存储和输出契约尚未闭合

事实：

- 当前 `GET /api/agents` 直接返回 `runtime.listAgents()`；底层是完整 `AgentConfig`，可包含 `env`、`command`、`args` 和 system prompt。
- 当前 Lark App Secret 位于聚合 `configs['lark.bots']` JSON；数据库权限已收紧，但没有独立 secret reference/version 模型。
- 迁移清单一方面要求 emitted manifest 不出现邮箱全文，另一方面示例 manifest 含 `owner_emails: string[]`，两者冲突。
- `import_entity_versions.before_value_private` 若直接保存完整 before JSON，会复制 Secret 到回滚历史。

修正：

1. 首次真实导入前，Agent、session、import plan 和 error DTO 全部改为 allowlist serializer。
2. 分开 `private_apply_plan` 与 `redacted_report`。前者只在本地进程/私密 store 中存在；后者只能含计数、字段路径、opaque entity ID 和 blocker。
3. App Secret、Agent env、connector credential 只存 secret provider/ref。回滚保存“旧 ref”，不保存 Secret plaintext 副本。
4. Secret provider 与 SQLite 无法组成同一事务时，采用 prepare ref → DB commit → finalize；失败只留下不可引用的孤儿 secret，不得留下已启用的半配置。
5. cookie、旧 gateway token、dashboard token、OAuth pending、session capability、send credential、CLI auth cache 一律不迁；目标端重建或重新认证。
6. 内部完整性摘要不得公开单个 Secret 的普通 hash。公开 plan digest 排除 Secret bytes；私下校验使用本机密钥 HMAC 或 opaque snapshot ID。

当前两个 Bot 没有 per-bot env/startup commands，降低了本次 Agent Secret 面积，但不消除 App Secret 和历史业务数据的保护要求。

### P0-4：App-scoped 身份必须“正向验证”，不能只排除明确失败

源端当前 owner 使用同一完整邮箱条目，这是适合跨 App 搬运的 locator；但最终授权主体仍必须分别在两个目标 App 下解析。

风险：Dutydeck 现有 owner 校验把网络/scope 异常视为 inconclusive，可允许配置保存。这适合编辑体验，不足以作为迁移激活门槛。当前 `allowedUsers` schema 只保存 `ou_`；把 `on_` 直接塞入会在归一化时丢失。

修正：

1. Principal 唯一键为 `(app_id, identity_kind, identity_value)`；`ou_` 永不跨 App 复制。
2. email/mobile/`on_` 先作为 locator，激活前必须在目标 App 下正向解析出可用主体并回读验证；inconclusive 允许 staging，但阻断 activation。
3. 在新 principals schema 落地前，`on_` 必须先经目标 App 解析成该 App 的 `ou_`，不能写进当前 `allowedUsers`。
4. Import/API 错误只报告条目序号和类型，不回显完整邮箱、手机号或 open ID。

### P0-5：群绑定必须以 `App × Chat` 为主键并在线验真

真实数据证明，同一群可被多个 App 使用，而只有其中一个 App 有当前 oncall。因此只用 `chat_id` 会串 CWD、talk 权限和工具 capability。

修正：

- `lark_chat_policies` 的自然键固定为 `(app_id, chat_id)`；grant/tool/session routing 都引用该键。
- Oncall 的源语义是“本群所有能发言成员可 talk，operate 仍只认 owner/allowedUsers”，不能把全群 talk 升级成全局 allowlist或 card operate 权。
- 激活前使用目标 App 验证 Bot 仍在群内、能读取必要 metadata、能按策略回复；本地 oncall/session 记录不是远端成员事实。
- 遗留网关配置默认 `enabled=false`、`allow_send=false`；在找到外部桥接实现或获得操作者明确确认前，不创建有效 capability。
- 旧 socket/token 不复制；Dutydeck 重新签发 session+app+chat scoped capability，并只持久化 snake_case 环境键。

### P0-6：源快照与 fingerprint 目前会被活跃运行态破坏

Botmux 仍在运行时，session、WAL、heartbeat、queue、dedup 和 usage 会持续变化。若 `source_root_fingerprint` 覆盖整个 root，plan 很容易永久 stale；若只按路径扫描并跟随 symlink，又有 TOCTOU 风险。

修正：

1. 分成 `apply_fingerprint`、`archive_snapshot_id`、`cutover_watermark`：
   - `apply_fingerprint` 只覆盖本次会写入的权威配置及其归一化默认值；
   - 动态历史用一致性/尽力归档快照，不参与配置 apply 的 stale 判定；
   - 消息去重由切流水位单独处理。
2. JSON 文件以 `open(O_NOFOLLOW)`/文件描述符读取，前后 `fstat` 校验同一 inode；多文件无法得到一致视图时按固定顺序加源只读锁或重试后 fail closed。
3. SQLite 必须使用 online backup/read transaction；不得拆拷 DB/WAL/SHM。
4. 明确扫描边界：精确 Bot registry、全局 config、由 data root 推导的 BOT_HOME、已知 store 和所有未识别文件。日志、heapshot、PM2、OAuth/MCP/VC credential 等即使排除，也必须在 artifact coverage 中有分类和理由。
5. `BOTS_CONFIG` 可以合法位于默认 home 外。不能简单“realpath 越界即拒绝”；应仅允许本地 CLI 显式路径/真实 Botmux 寻址结果，并验证普通文件、owner/mode、no-follow 和稳定快照。Web/API 不接受任意源路径。

### P0-7：历史 session/workflow 的敏感边界需要收紧

28 条 session JSON 不只是“元数据”：字段中可能包含用户 prompt、owner 身份、消息/root ID、card nonce、进程/端口和 CLI resume 标识。30 条 workflow 草稿包含 goal。它们都应按敏感业务归档处理。

修正：

- P0 Importer 不提供通用 `--resume-sessions`。该参数应移除或固定返回 unsupported；未来由每 adapter/backend 专用 `adopt` 命令执行。
- Legacy catalog 只暴露脱敏标题、时间、来源 App/Chat 的 opaque ref 和状态；原始 JSON/sidecar 使用 `0600` 私密归档，不进入 git、普通 API 或 plan diff。
- `metadata-active` 统一显示为 `source_status=active, liveness=unknown`；未验证 OS pane、CLI native session 和 frozen launch snapshot 前，不允许 reattach。
- 不导入 Botmux dedup、queue、turn marks/sends、frozen card、PID/port/lock；它们属于源 runtime namespace。
- 30 个 `grilling` run 只作为 incomplete draft archive，不创建 Dutydeck Task/Run，不自动继续 goal。
- 历史 TraeX 默认 archive-only；backup/cache 永不触发 live Bot 创建。

唯一 enabled schedule 还绑定 thread root 与 continuation 语义。即使未来有 scheduler，如果原 thread/session 无法验证，也不能静默改成新 chat/new session；必须要求用户选择“保留原 topic 但新上下文”或“完成可验证 adopt”。

### P0-8：当前存储层无法兑现原子 apply、幂等与回滚

事实：`RepositoryBundle` 没有跨 repository transaction；`agents.save()` 和 `config.set()` 各自立即提交。Lark bots 又是聚合 JSON read-modify-write，没有 revision/CAS。现有路径无法原子写 Agent、Bot、principal、chat policy、schedule 和 provenance。

修正：

1. 先增加 storage-owned transaction/batch API；Importer 不得用多个普通 `save()` 拼事务。
2. Lark Bot 改为一等表，或过渡期至少使用单写者 + revision CAS；不能对聚合 JSON 无版本 RMW。
3. 稳定来源键必须独立于会变化的 root fingerprint。建议使用持久 `source_instance_id` + entity kind + Botmux stable key；App/Chat/Principal 仍用各自外部自然键做冲突检测。
4. 幂等以 entity 级 normalized source hash 和 `last_applied_target_hash` 判断；历史文件变化不能让配置实体重复创建。
5. Apply 前重验权威输入的 `apply_fingerprint` 和目标 revision；冲突默认 preserve/fail，不覆盖人工修改。
6. 已提交 rollback 本身也是一个有 provenance 的事务，只恢复该 run 管理的配置实体，且仅在目标仍等于 `after_hash` 时执行；不删除期间产生的 session/task/history。
7. Secret 回滚恢复 ref，不恢复日志/快照里的 Secret 值；文件 staging 的补偿状态必须可重试。

### P0-9：Dutydeck 单边 lease 不能防止 Botmux 重连

`cutover_leases` 若只存在 Dutydeck 数据库，只能约束 Dutydeck 自己，Botmux 不读取它，因而不能技术上保证同一 App 不出现双 listener。

修正：

- 切流前必须能按 App 停止并 drain 对应 Botmux daemon/listener，确认连接已断并记录 source watermark。
- 使用双方都能观察的 fencing 机制，或由 supervisor 持有唯一 App lease；只有持有当前 generation 的 runtime 才可启动 listener。
- 若无法按 App 独立 drain，使用独立测试 App；禁止同一生产 App 在线 shadow。
- 运行回滚顺序固定为 Dutydeck stop/drain → 写目标 watermark → 释放/fence Dutydeck → 恢复 Botmux → 验证授权与去重。该流程不是 SQLite rollback 的一部分。

## 4. CWD 与路径的可执行性修正

本机一个 Bot 的默认 CWD 是 `~`，而 Dutydeck 当前 Lark workspace 要求绝对路径。Importer 不能原样写入，也不能只做字符串比较。

建议在 plan 中同时保存：

- `source_cwd_lexical`：仅私密 plan 使用；
- `resolved_cwd`：按运行 Botmux 的用户展开成绝对路径；
- `canonical_cwd_fingerprint`：用于 ACL/冲突校验；
- `path_status`：exists/directory/allowed/missing。

激活前必须验证每个 default/oncall CWD 存在、为目录、位于允许 workspace 内。不要为展示目的强制把用户熟悉的 lexical 路径改写成物理 realpath，但安全比较必须使用 canonical/no-follow 结果。

## 5. 推荐的可执行 Importer 契约

### 5.1 命令边界

```text
dutydeck import botmux plan \
  [--bots-config <exact-file>] [--data-dir <dir>] [--emit-redacted <file>]

dutydeck import botmux apply --plan-id <id> \
  [--on-conflict preserve|rename] [--secret-mode prompt|reference|local-copy]

dutydeck import botmux verify --run-id <id>
dutydeck import botmux activate --app-id <id> --verified-run-id <id>
dutydeck import botmux rollback --run-id <id>
```

安全默认值：plan-only、history archive-only、retired Bot excluded、listener disabled、full trust false、group tools disabled、send false。`overwrite` 如保留，必须逐实体显式确认，不能作为全局开关。

### 5.2 状态机

```text
planned
  -> staged_disabled
  -> verified_offline
  -> cutover_ready
  -> active

任何 blocker/conflict
  -> blocked

apply 失败
  -> failed_rolled_back | failed_compensation_required
```

`apply` 成功只代表 Dutydeck 内部配置原子落库，不代表 Lark App 已接管。只有 `activate` 可以获得 cutover generation 并打开 listener。

### 5.3 本机预期 gate

只读 plan 应稳定报告以下脱敏事实：

```text
current_bots=2
retired_bots=1
oncall_bindings=2
enabled_schedules=1
teams=1
team_members=0
roles=0
connectors=0
plugins=0
session_records=28
workflow_drafts=30
activation_ready_apps=0
```

在 P0 能力未实现前，apply 最多进入 `staged_disabled`；任何尝试 activate 都应返回 blocker 列表，而不是接受 `--skip-*` 后继续。

## 6. 三份文档的具体修订建议

### `botmux-data-migration-inventory.md`

- 删除 Import apply 的 `--confirm-full-trust`，移到独立 activation。
- 删除/禁用通用 `--resume-sessions`；历史只归档。
- 将 `owner_emails: string[]` 从可落盘 manifest 移到 private plan；redacted manifest 只保留 principal refs/counts。
- 把遗留群网关从“迁移 allowlist 语义”改为 `unknown_external_legacy`，默认完全禁用。
- 明确 `--skip-schedules` 不解除所属 App 的激活 blocker。
- 将 session archive 标成敏感归档，而不是普通“非 secret sidecar”。
- 幂等键从仅 `source_kind + app_id` 扩展为稳定 source instance + entity kind + source key。

### `botmux-parity-plan.md`

- 保留“导入后 full trust false/listening false”，并补充当前 save API 与该目标冲突，列为实现前 P0。
- 把 `source_root_fingerprint` 拆为 apply/archive/watermark 三类，避免活跃 Botmux 使 plan 永久 stale。
- 明确 secret provider 的跨事务补偿和 rollback-by-ref；不要在 before version 保存 plaintext。
- 明确 Dutydeck 自己的 `cutover_leases` 不是跨系统 fencing。
- 对本机 enabled schedule 动态提升为阶段 1/2 激活 blocker，而不是等阶段 4。

### `botmux-capability-audit.md`

- 能力 Gate 方向正确；补充当前 `~` CWD 到绝对 workspace 的 materialization gate。
- 补充 identity 的“inconclusive 可 staging、不可 activation”。
- 补充历史 archive 的 PII/prompt/card nonce 边界。
- 群工具旧网关只能作为待确认外部依赖，不应计为已验证的当前 Botmux runtime capability。

## 7. 解除 NO-GO 的最低条件

满足以下全部条件后，才可以开始真实 apply；开始 App activation 还需通过对应能力 E2E：

1. Public DTO、plan、日志、异常和测试 snapshot 的 Secret/PII 泄漏测试通过。
2. 禁用态 Lark Bot 可以保存完整期望配置，且不会要求或隐式设置 full trust。
3. storage 提供单事务 batch、entity provenance、revision CAS、故障注入回滚。
4. Principal 按 App 正向验证；inconclusive 身份阻断激活。
5. `(app_id, chat_id)` policy、talk/operate 分级和 CWD override 已接入 dispatcher/runtime。
6. enabled schedule、Hammer、mention policy、群工具 per-chat policy、tmux backend 对实际使用 App 均有等价实现，或对应 App 保持 disabled。
7. Session/workflow 只读归档不参与 live routing；无通用自动 resume。
8. Secret ref、文件 staging 与 DB transaction 的 prepare/finalize/compensation 演练通过。
9. per-App Botmux drain、双 listener fencing、watermark/dedup 和运行回滚演练通过。
10. 同一 plan 重复 apply 为 no-op；目标人工修改后为 conflict；rollback 不覆盖后续用户运行数据。

在这些条件之前，最安全且可执行的下一步是实现纯只读 `plan`：完成源寻址、全 artifact 分类、私密快照和 redacted capability report，但不写 Dutydeck、不读取后输出任何凭据、不启动或停止任何 listener。
