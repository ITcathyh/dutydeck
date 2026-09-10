# Botmux 数据迁移清单与 Importer 规格

> 审计时间：2026-08-30（PRC）
>
> 来源：本机 Botmux 用户目录与 Dutydeck 当前代码/数据库 schema
>
> 安全边界：本文不记录 App Secret、token、cookie、登录态、消息正文或任务 prompt。文中的 `cli_*`、`oc_*` 是非敏感路由标识。

## 1. 结论

本机 Botmux 当前权威配置包含：

- 2 个当前注册的飞书 Bot；两者都使用 `claude-code`，未显式指定模型，运行时使用 CLI 默认模型。
- 2 条 oncall 群绑定，均属于 `cli_aaec6c24cff9dbd1`。
- 1 条启用中的 interval schedule，最近状态为 `ok`。
- 1 个本地团队 `default`，成员数为 0。
- 0 个本群 Role、0 个默认 Role、0 个 Role Profile。
- 0 个用户自定义 connector、0 个已安装 plugin、0 个 prompt/skill customization。
- 28 条历史 session 元数据；其中 6 条属于已从当前 `bots.json` 移除的 TraeX Bot。

Dutydeck 已能直接承载 Agent 基础定义、飞书 App、模型/CWD、私聊模式、普通群 reply mode、全局白名单和群协作工具；但当前没有一等承载下列 Botmux 语义：

- per-app + per-group 的 oncall/CWD/授权/回复策略；
- `canTalk`、`canOperate`、owner 三层权限；
- schedule；
- Hammer full + gates + prompt skill injection；
- Botmux workflow、Role、Role Profile、team/federation、feedback、customization；
- 按群限定的群协作工具 allowlist；
- Botmux 的 tmux backend 选择和现有 tmux session reattach 元数据。

因此不能把 `bots.json` 机械转换成 `lark.bots` 后就宣称迁移完成。当前用户真正会丢功能的 P0 项至少有：2 条 oncall、1 条 schedule、Hammer 策略、1 条按群限定的群协作工具策略，以及 tmux 持久会话语义。

## 2. 数据源与优先级

### 2.1 Botmux

| 数据源 | 作用 | 本机状态 | 迁移判定 |
|---|---|---:|---|
| `~/.botmux/bots.json` | Bot/App/Agent/权限/群级配置的权威注册表 | 2 条，mode `0600` | 权威输入 |
| `BOTS_CONFIG` | 覆盖 `bots.json` 的精确文件路径 | 当前环境未设置 | 无覆盖 |
| `~/.botmux/bots.json.bak` | 一次历史备份 | 2 条，含已移除的 TraeX Bot | 仅归档，不自动合并 |
| `~/.botmux/config.json` | 机器级全局设置 | 不存在 | 全部走 Botmux 默认值 |
| `~/.botmux/.env` | 机器级环境及旧桥接配置 | 4 个字段，mode `0600` | 只迁移语义，不复制 secret |
| `~/.botmux/.data-dir` | durable data dir breadcrumb | 指向 `/home/huangyuhang.edu/.botmux/data`；realpath 为 `/data00/home/huangyuhang.edu/.botmux/data` | importer 必须按 breadcrumb 解析 |
| `~/.botmux/data/` | session、identity cache、team、feedback 等状态 | 存在 | 按类别迁移 |
| `~/.botmux/bots/<app_id>/schedules.json` | per-bot schedule | 3 个文件、合计 1 条任务 | 权威 schedule 输入 |
| `~/.botmux/feishu-session.json` | 开放平台网页登录态 | 23 个 cookie、6 个 domain，mode `0600` | 禁止迁移，目标端重新登录 |
| dashboard secret/token、OAuth pending、socket/token 文件 | 运行时认证材料 | 存在 | 禁止复制或输出 |

Botmux 的数据目录优先级是 `SESSION_DATA_DIR` → `.data-dir` breadcrumb → `~/.botmux/data`。Importer 不得写死默认目录。

### 2.2 Dutydeck 当前承载面

Dutydeck SQLite 当前有 7 个 `agent_configs`、18 个 session、0 个 `channel_mappings`；`configs` 仅有认证、群工具签名、relay 签名三项，没有 `lark.bots`，所以本次导入不会与既有飞书 Bot 配置冲突。现有 Agent ID 已包含：

- `claude-code`（PTY CLI）；
- `traex`（PTY CLI）。

现有 schema 的直接承载能力：

| Dutydeck 位置 | 已支持字段 |
|---|---|
| `agent_configs.json` | command、args、protocol、model、reasoning effort、cwd、env、system prompt、permission mode |
| `configs['lark.bots']` | App ID/Secret、名称、workspace、默认 Agent/模型/思考强度、p2p mode、group reply mode、全局用户/Bot 白名单、风险控制、群协作工具开关 |
| `sessions` | Agent、CWD、模型、思考强度、permission mode、source/source_id、run ID |
| `channel_mappings` | 外部飞书路由到 Dutydeck session 的映射 |

`configs` 是通用 KV，不等于上述缺失能力已经实现；没有读取/授权/执行路径的 JSON 不能视为功能迁移完成。

## 3. 当前 Bot / Agent / 飞书 App 资产

### 3.1 当前权威 Bot

| App ID | 展示名 | CLI | 模型 | 有效后端 | 默认 CWD | 私聊模式 | 普通群 reply mode | @ 策略 |
|---|---|---|---|---|---|---|---|---|
| `cli_aaec6c24cff9dbd1` | `bdev-helper` | `claude-code` | CLI 默认 | `tmux` | `~` | `thread` | `chat-topic`（默认） | `topic` |
| `cli_aa0869da68b91cc9` | `hammer` | `claude-code` | CLI 默认 | `tmux` | `/home/huangyuhang.edu/projects` | `chat`（默认） | `chat-topic`（默认） | `always`（默认） |

共同属性：

- 每个 Bot 都配置了 App Secret，但本文不记录其值。
- 每个 Bot 各有 1 条 `allowedUsers`，类型均为完整邮箱；两者实际是同一个 owner 标识。
- `disableCliBypass` 均未设置，源端有效语义是 CLI bypass 开启。
- `sandbox` 均未设置，源端有效语义是文件沙盒关闭；网络未额外隔离。
- 均无 per-bot `env`、startup commands、custom passthrough、plugin、显式模型或 reasoning effort。
- 均无 `allowedChatGroups`、`chatGrants`、`globalGrants`、message listener、no-card group 或 session-group 配置。

`hammer` Bot 还有不能丢失的专用配置：

```json
{
  "enabled": true,
  "mode": "full",
  "enforce_gates": true,
  "skills_injection": "prompt"
}
```

这四项不是普通 `systemPrompt` 的同义词。Dutydeck 在没有 Hammer gate/skill runtime 前，不能把该 Bot 静默降级成普通 `claude-code`。

### 3.2 历史/孤儿 Bot

`cli_aafc1d3bc1b8dd2d`（展示名 `traex`、CLI `traex`）存在于：

- `bots.json.bak`；
- `bots-info.json`、bot open/union ID cache；
- 6 条 session 元数据；
- 一个空的 per-bot schedules 文件。

它不在当前 `bots.json` 中，应判定为“已退役或待确认”，默认只归档。Importer 只有在显式传入 `--include-retired-bots` 时才创建对应 Lark Bot/Agent 配置，不能根据缓存或 backup 自动复活。

### 3.3 飞书身份映射

`data/bots-info.json` 记录 3 个已知 Bot：

| App ID | Bot 名称 | 当前注册 |
|---|---|---|
| `cli_aaec6c24cff9dbd1` | `bdev-helper` | 是 |
| `cli_aa0869da68b91cc9` | `hammer` | 是 |
| `cli_aafc1d3bc1b8dd2d` | `traex` | 否 |

三者均有 bot open ID 与 union ID cache；这些 ID 是派生身份缓存，不是配置源。目标端应在各 App 凭据下重新调用飞书接口解析，尤其不能把一个 App 视角下的 `ou_*` 跨 App 复制。当前 owner 使用邮箱，适合直接迁移到 Dutydeck `allowedEmails`，再由目标 App 自行解析。

## 4. 群配置、成员与协作策略

### 4.1 Oncall 与实际会话群

当前 2 条 oncall 均属于 `bdev-helper`：

| App ID | Chat ID | 工作目录 | 相关 session 数 |
|---|---|---|---:|
| `cli_aaec6c24cff9dbd1` | `oc_6f5c0eb3a94ce72303950f78e270fd8b` | `/home/huangyuhang.edu/go/src/code.byted.org/larkim/im_workspace` | 7 |
| `cli_aaec6c24cff9dbd1` | `oc_9bd53d6690c61289e9427f513945460b` | `/home/huangyuhang.edu/go/src/code.byted.org/larkim/im_workspace` | 12 |

同一群 `oc_9bd...` 还有：

- `hammer` 的 3 条 thread session，CWD 为 `/home/huangyuhang.edu/projects`；
- 已退役 TraeX 的 6 条 thread session，CWD 为 `im_workspace`。

因此 CWD 是 `(app_id, chat_id)` 级配置，不能折叠成一个群级 CWD，也不能只用 Dutydeck 当前的 per-App `workspace` 表达。

### 4.2 权限语义

Botmux 权限是分层的：

- `allowedUsers`：owner/`canOperate`；
- oncall、`allowedChatGroups`、`chatGrants`、`globalGrants`：`canTalk`；
- owner 专属：授权/撤销等管理动作。

本机当前只有 owner 邮箱和 2 条 oncall，显式 grants 数量为 0。Oncall 群成员在源端可对话，但并不自动拥有 owner 操作权。

Dutydeck 当前 `allowedUsers`/`allowedEmails` 是整条消息入口的全局白名单，没有独立 `canTalk`/`canOperate`。若只导入 owner 邮箱，oncall 群其他成员会失去源端对话权；若放开全局白名单，又会扩大非 oncall 群权限。必须先增加 per-group RBAC 承载。

### 4.3 回复与唤醒策略

- 两个当前 Bot 的有效普通群 reply mode 都是 `chat-topic`，Dutydeck 可直接映射到 `groupReplyMode`。
- `bdev-helper` 的 `regularGroupMentionMode=topic` 表示顶层仍需 @，但在 Bot 自己的 shared topic 内可无 @ 续聊。
- Dutydeck 当前群事件只在 @ 当前 Bot 时唤醒，尚不能完整表达 Botmux 的 `topic`/`never`/`ambient` 四级 @ 策略。

因此 `groupReplyMode` 可迁移，但 mention policy 必须另建字段和 dispatcher 行为，不能丢弃。

### 4.4 旧群协作网关

`~/.botmux/.env` 中存在 4 个旧桥接字段：

- `BOT_GATEWAY_CHAT_IDS`：1 个群，`oc_e4623bda27325f0c64aa88ceb7d58d97`；
- `BOT_GATEWAY_LARK_APP_IDS`：1 个 App，`cli_aaec6c24cff9dbd1`；
- `BOT_GATEWAY_SOCKET`：已配置，目标 Unix socket 存在且 mode `0600`；
- `BOT_GATEWAY_TRANSPORT_TOKEN_FILE`：已配置，token 文件存在且 mode `0600`。

Botmux 当前源码没有消费这些字段；它们属于外部/遗留群工具桥接。可确认的业务语义只有“该 App 在该群启用过群协作通道”，无法仅凭这 4 个字段证明具体读写操作范围。

Dutydeck 已有 session-bound 群协作工具和 HMAC capability，并在运行时注入：

- `dutydeck_group_tools_url`；
- `dutydeck_group_tools_token`。

迁移要求：

1. 迁移 `(app_id, chat_id)` allowlist 语义，不迁移旧 socket、旧 transport token 或 token 文件。
2. Dutydeck 现有 `groupToolsEnabled`/`groupToolsAllowSend` 是 per-App 开关，直接开启会把权限扩大到该 App 的所有群。要保真必须增加 per-group policy。
3. 旧配置无法证明 send 权限，Importer 默认 `allow_send=false`，要求用户显式确认后才能开启。
4. ACPX `session_options.env` 持久化键必须为 snake_case。禁止把 `BOT_GATEWAY_*` 或任何大写环境变量写进 session；旧大写名只能在读取边界兼容。

### 4.5 Team、Role、Connector、Plugin

| 能力 | 当前资产 | 事实 |
|---|---:|---|
| Team | 1 | `default`，成员 0；无 team bot/group/federation 记录 |
| 本群 Role | 0 | `data/roles/` 不存在 |
| 默认 Role | 0 | `data/team-roles/` 不存在 |
| Role Profile | 0 | `data/role-profiles/` 不存在 |
| 外部 Role Library | 0 | `~/botmux-roles/` 不存在 |
| Connector | 0 | 未发现 webhook lifecycle、doc subscription 或用户 connector 持久化记录 |
| Plugin | 0 | `~/.botmux/plugins/` 为空，`bots.json` 无 plugin 赋值 |
| 用户 Skill Registry | 0 | `~/.botmux/skills/` 不存在 |
| Prompt/Skill Customization | 0 | `data/customizations/` 不存在 |

`~/.botmux/claude-plugin/` 和 `data/runtime-skills/` 是 Botmux 生成的内置/会话级物化产物，不是用户配置，不应复制到 Dutydeck。

## 5. Schedule、Workflow、Feedback 与历史状态

### 5.1 Schedule

当前只有 1 条任务：

- 所属 App：`cli_aaec6c24cff9dbd1`；
- 启用：是；
- 类型：`interval`；
- scope：`thread`；
- delivery position：`topic`；
- Chat：`oc_6f5c0eb3a94ce72303950f78e270fd8b`；
- CWD：`im_workspace`；
- 最近状态：`ok`。

任务还包含 schedule 表达式、prompt、root message、next/last run 等字段，本文不输出正文。Dutydeck 当前没有 scheduler/store，不能静默跳过；在 schedule 能力落地前，Importer 必须把本次导入判为 `blocked`，或在用户显式选择 `--skip-schedules` 时只归档并给出醒目缺失报告。

### 5.2 Workflow

- `~/.botmux/workflows/` 不存在，故无用户保存的 workflow definition。
- `~/.botmux/v3-runs/` 有 30 个 run 目录；全部处于 `grilling`，每个只有 `grill.state.json`，没有完成的 spec/dag/attempt 资产。
- `workflow-distillations/proposals/` 为空。
- `config.json` 不存在，Botmux v3 workflow 机器级开关按默认关闭。
- Botmux 源码仓库内的 7 个 `*.workflow.json` 是产品示例，不是用户数据。

这 30 个 run 应作为未完成草稿归档，不能直接变成 Dutydeck 可执行任务。其 goal 文本可能包含业务信息，Importer 日志不得打印。

### 5.3 Session

| App ID | session 数 | 元数据状态 | 群数 | CLI/backend |
|---|---:|---|---:|---|
| `cli_aa0869da68b91cc9` | 3 | active 3 | 1 | claude-code/tmux |
| `cli_aaec6c24cff9dbd1` | 19 | active 17、closed 2 | 2 | claude-code/tmux |
| `cli_aafc1d3bc1b8dd2d` | 6 | active 5、closed 1 | 1 | traex/tmux |

总计 28 条，全部为群聊 thread scope，全部记录 `agentFrozen=true` 和 persistent backend target。文件里的 `active` 是 Botmux 元数据状态，不保证进程仍存活。

Dutydeck 当前 PTY CLI 工厂默认创建 `PtyBackend`，Agent schema 也没有 backend 选择字段。虽然仓库已有 `TmuxBackend` 实现，但尚未形成可持久化的 per-Agent/per-session 选择与导入 reattach 契约。因此：

- 默认不导入为可运行 session；
- 可先导入为 archived source record；
- 只有确认 tmux session 名、CLI 原生 session ID、App/Chat/source ID、CWD 和权限都能原样落库并完成 reattach 探测后，才允许 `--resume-sessions`；
- 禁止把 tmux session 静默降级成 PTY。

### 5.4 Feedback 与 Usage

| 数据 | 当前量 | 说明 |
|---|---:|---|
| `botmux-feedback.sqlite.turn_terminals` | 341 | 当前库的 turn 完成元数据 |
| `feisuo-feedback.sqlite.turn_terminals` | 12 | 旧库 |
| deliveries / feedback revisions / outbox / interactions / responses / skill runs | 0 | 当前没有实际反馈标签或投递数据 |
| usage JSONL | 21 个文件、1124 行 | 历史用量账本 |
| usage state | 2 个文件 | 运行基线 |

`botmux-feedback.sqlite` 当前启用了 WAL；主文件只有 4096 字节，绝大部分最新页在 `-wal` 中。若将来导入 analytics，必须使用 SQLite online backup/只读一致性快照，不能只复制主文件，也不能在 daemon 活跃时分开复制 DB/WAL/SHM。本机没有实际反馈标签，当前迁移可把两套 DB 和 usage ledger 作为可选冷归档，不阻塞运行功能。

## 6. 不迁移、只重建或只归档的数据

### 6.1 禁止自动迁移

- `larkAppSecret` 明文值；Importer 只生成 secret reference 或交互式输入槽位。
- `feishu-session.json` 的 cookie；目标端重新扫码登录。
- dashboard access token/secret、group gateway token、OAuth state、VC auth token、MCP capability、send credential。
- Unix socket、PID、端口、heartbeat、lock、PM2/supervisor 状态。
- 任何日志中的消息正文或可能的凭据。

### 6.2 目标端重建

- bot open ID、union ID、头像和 app-scoped `ou_*` cache；
- allowed-user open ID cache、identity mention cache；
- group-tools HMAC signing secret和每 session capability；保留 Dutydeck 已有 signing secret；
- dedup、queue、turn marks/sends、frozen cards、runtime skills、plugin manifests；
- dashboard daemon registry、worker lease、OAuth pending。

### 6.3 可选冷归档

- 28 条 Botmux session JSON 及其非 secret sidecar；
- 30 个未完成 workflow grilling run；
- usage ledger；
- 两套 feedback SQLite 的一致性快照；
- attachments（4 个文件，约 0.9 MB）；
- `bots.json.bak` 和已退役 TraeX 记录。

归档默认 mode `0600`，不得进入 git。

## 7. 迁移映射与缺口

| Botmux 语义 | Dutydeck 目标 | 当前状态 | 处理 |
|---|---|---|---|
| `larkAppId`/Secret/brand/name | `configs['lark.bots']` | 已支持 | Secret 用引用/交互输入，不写报告 |
| `cliId=claude-code` | `defaultAgentId=claude-code` | 已有 Agent | 可复用 |
| 退役 `cliId=traex` | `defaultAgentId=traex` | 已有 Agent | 仅显式 opt-in |
| model/reasoning | Lark 默认 + Agent/session 字段 | 已支持 | 当前为空，保持未设置 |
| default CWD | Lark `workspace` | 已支持 | Hammer 可直接映射 |
| oncall per-group CWD | 新 group policy | 缺失，P0 | 先实现 `(app_id, chat_id)` override |
| p2p mode | `p2pMode` | 已支持 | `thread`/`chat` 直接映射 |
| regular group reply mode | `groupReplyMode` | 已支持 | 两 Bot 显式落 `chat-topic`，避免 legacy fallback 漂移 |
| mention mode | 新 group wake policy | 缺失，P0 | 支持 always/topic/never/ambient |
| owner vs talk 权限 | 新 RBAC | 部分，P0 | 分离 owner/can_operate/can_talk |
| CLI bypass/sandbox | Lark full trust + Agent permission | 语义不同，P0 审批 | commit 要求 `--confirm-full-trust` |
| Hammer config | Hammer capability/policy | 缺失，P0 | 未实现前阻止 Hammer Bot 激活 |
| Group tools allowlist | per-group tool policy | 仅 per-App，P0 | 导入 1 App × 1 Chat，send 默认 false |
| schedule | scheduler tables/service | 缺失，P0 | 当前有 1 条 enabled，不得静默跳过 |
| session backend/tmux | backend policy + reattach metadata | 代码部分存在、持久化契约缺失 | 默认 archive-only |
| roles/profiles | role tables + prompt injection | 缺失 | 当前 0 条，不阻塞本机数据，但属产品功能缺口 |
| team/federation | team/member/group tables | 缺失 | 当前仅 1 个空 team，可延后 |
| feedback/customization/plugins | 对应 store/runtime | 缺失 | 当前无有效用户记录，可延后 |

特别注意：`hammer` 与 `bdev-helper` 虽都使用 `claude-code`，不能简单共用同一个行为配置。若 Hammer 能力未来落在 Agent 级，应创建独立 Agent 配置（稳定 ID 例如 `botmux-hammer`）；若落在 Lark Bot policy，则保持共享 runtime、独立 policy。Importer 必须根据最终 schema 选择唯一方式，不能两边重复注入。

## 8. 机器可执行 Importer 规格（暂不实现）

### 8.1 CLI

```text
dutydeck import botmux \
  --source-home ~/.botmux \
  --dry-run \
  [--include-retired-bots] \
  [--include-history] \
  [--resume-sessions] \
  [--skip-schedules] \
  [--confirm-full-trust] \
  [--group-tools-send allow|deny] \
  [--secret-mode prompt|reference]
```

默认行为：dry-run、当前 `bots.json` only、history archive-only、schedule 不允许丢弃、group tool send 禁止、secret 不落 manifest。

建议 exit code：

| Code | 含义 |
|---:|---|
| 0 | dry-run 无阻塞，或事务提交成功 |
| 2 | schema/参数错误 |
| 3 | 存在未确认的 P0 能力缺口 |
| 4 | secret/re-auth 输入不足 |
| 5 | 源快照在读取期间变化，请重试 |
| 6 | 目标冲突且未给冲突策略 |

### 8.2 中间 Manifest

Importer 先生成内存 manifest；`--emit-manifest` 如需落盘，只能落脱敏版、mode `0600`：

```json
{
  "schema_version": 1,
  "source": {
    "kind": "botmux",
    "config_root": "<realpath>",
    "data_root": "<realpath>",
    "snapshot_at": "<ISO-8601>",
    "source_hashes": {}
  },
  "agents": [],
  "lark_bots": [],
  "groups": [],
  "group_bot_policies": [],
  "schedules": [],
  "archived_sessions": [],
  "archived_workflows": [],
  "secret_requirements": [],
  "blocked_capabilities": [],
  "warnings": []
}
```

核心记录建议：

```ts
interface ImportedLarkBot {
  source_app_id: string
  display_name?: string
  secret_ref: string                  // 只有引用，不含 secret
  default_agent_id: string
  workspace?: string
  default_model?: string
  default_reasoning_effort?: string
  p2p_mode: 'chat' | 'thread'
  group_reply_mode: 'chat' | 'shared' | 'new-topic' | 'chat-topic'
  owner_emails: string[]
  full_trust_required: boolean
  legacy_extensions?: Record<string, unknown> // 仅 round-trip；runtime 未支持时必须 blocked
}

interface ImportedGroupBotPolicy {
  source_app_id: string
  chat_id: string
  working_dir?: string
  oncall: boolean
  talk_policy: {
    whole_group: boolean
    user_ids: string[]
    owner_ids: string[]
  }
  reply_mode?: 'chat' | 'shared' | 'new-topic' | 'chat-topic'
  mention_mode?: 'always' | 'topic' | 'never' | 'ambient'
  group_tools?: {
    enabled: boolean
    allow_read: boolean
    allow_discover: boolean
    allow_send: boolean
  }
}

interface ImportedSchedule {
  source_app_id: string
  source_schedule_id: string
  chat_id: string
  scope: string
  working_dir?: string
  enabled: boolean
  schedule: unknown
  prompt_ciphertext_ref: string       // manifest/log 不含 prompt
  delivery: unknown
}
```

Manifest 与 ACPX 持久化对象的所有键都使用 snake_case。对旧大写 env 的兼容只能出现在 source reader，不能穿过 normalization 层。

### 8.3 处理流程

1. **Discover**：按 Botmux 的真实优先级解析 `BOTS_CONFIG` 和 data breadcrumb；对所有路径做 `realpath`，拒绝越界或非普通文件。
2. **Snapshot**：记录 `bots.json`、schedules、team/role 文件的 inode/size/mtime/hash；读取结束后再次校验。SQLite 用 online backup 快照。
3. **Parse**：严格解析当前 `bots.json`；backup/cache 仅做 orphan 检测，不参与默认合并。
4. **Normalize**：应用 Botmux 默认值，显式得到 `tmux`、CLI 默认模型、`chat-topic`、mention policy、bypass/sandbox 等有效语义。
5. **Classify**：把资产标成 `config`、`derived_cache`、`runtime_state`、`secret`、`archive_only`。
6. **Resolve identities**：邮箱可保留；任何 `ou_*` 必须在目标 App 下重新解析/验证，不能跨 App 复制。
7. **Plan conflicts**：以 `source_kind + source_app_id` 作为幂等键；已存在记录比较规范化 hash，默认不覆盖人工修改。
8. **Gate**：只要 enabled schedule、Hammer、oncall、群工具按群策略或 tmux resume 没有目标承载，就返回 exit 3；只有用户显式 skip/confirm 才继续。
9. **Commit**：单个 SQLite transaction 写 Agent/Lark/group/schedule 记录；secret 通过独立 secret provider 提交，失败则整体回滚。
10. **Verify**：重新读取目标记录，校验 2 Bot、2 oncall、1 enabled schedule、权限与群策略数量；不启动 listener、不发送飞书消息。
11. **Activate**：作为单独命令执行，先完成飞书身份/权限探测和 full-trust 确认，再启用 listener。Import 本身不产生外部副作用。

### 8.4 本机 dry-run 的期望结果

```text
current_bots=2
retired_bots=1
owner_email_entries=2
distinct_owners=1
oncall_bindings=2
enabled_schedules=1
teams=1
team_members=0
chat_roles=0
team_roles=0
role_profiles=0
connectors=0
plugins=0
customizations=0
session_records=28
workflow_drafts=30
blocked_capabilities=oncall,schedule,hammer,group_tools_per_group,mention_policy,tmux_session_resume
```

任何 dry-run/日志都只输出数量、字段名、hash、非敏感 ID 和阻塞原因；不得输出 secret、token、cookie、邮箱全文、open ID cache 值、消息正文、schedule prompt 或 workflow goal。

## 9. 验收条件

只有同时满足以下条件，才可称为“完整迁移”：

1. 两个当前飞书 App 都能以各自身份启动正确 Agent；App Secret 未出现在日志、manifest 或 git。
2. `bdev-helper` 的两个 oncall 群仍按各自 App+Chat CWD 工作，群成员保留 talk 权但没有 owner 操作权。
3. Hammer 仍执行 full 模式、gate 和 prompt skill injection；若未实现，必须保持禁用并明确报错。
4. 唯一 enabled schedule 在目标 scheduler 中仍启用，路由到原 App/Chat/topic/CWD，且不会重复触发。
5. `bdev-helper` 的 `p2p=thread`、两个 Bot 的 `groupReplyMode=chat-topic`、mention policy 行为与源端一致。
6. 群协作工具只在 `cli_aaec... + oc_e462...` 策略范围内启用；运行时只持久化 snake_case env key，token 为 Dutydeck 新生成的 session capability。
7. 已退役 TraeX 不会被默认复活；其 6 条 session 可查为 archive，但不参与 live routing。
8. Botmux 28 条 tmux session 不会被静默改成 PTY；resume 未实现时明确 archive-only。
9. Dutydeck 原有 7 个 Agent、18 个 session 和三个 signing/auth config 不被覆盖；`lark.group_tools.signing_secret` 保持原值。
10. Import 可重复运行且结果幂等；第二次 dry-run 应报告 0 个新增、0 个隐式覆盖。
