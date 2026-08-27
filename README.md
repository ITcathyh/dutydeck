# Dockmux

Dockmux 是一个 ACP 优先的多 Agent 工作台。它会发现内置 ACPX 注册表支持的 Agent，仅保留本机已安装 CLI 的 Agent，并在 Web 界面中展示对应的 CLI 版本。Web 与 HTTP 是同一套仓储驱动运行时上的两个独立通道。

```text
Web / HTTP → Dockmux 运行时 → acpx@0.13.0 → ACP Agent
```

Dockmux 不使用 Agent SDK，也不内嵌供应商专属适配器。固定版本的公开 `acpx/runtime` 接口负责 ACP 初始化、持久会话、重连、流式输出、实时权限请求、取消和子进程清理；Dockmux 负责产品状态、标准化事件、存储、API 与通道。

## 快速开始

环境要求：Node.js 22.12+、pnpm 11。需要使用的 Agent CLI 必须已在本机安装，并按需完成认证。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

开发时访问 `http://127.0.0.1:4311`；Vite 会将 API 代理到 `http://127.0.0.1:4310`。

常用命令：

```bash
pnpm dev:server       # 仅启动 Fastify
pnpm dev:web          # 仅启动 Vite
pnpm test             # 验收测试与集成测试
pnpm typecheck
pnpm build
```

## 本地会话服务

唯一可发布的软件包 `dockmux` 提供 `dockmux` 可执行命令。它内置生产版 Web 界面，并统一管理运行时、ACP 进程、会话持久化、HTTP API 和 SSE 流；客户端不会直接启动 Agent 进程。服务启动后，界面、API 和 SSE 均使用终端输出的服务地址。

```bash
# 在当前仓库运行（会先执行构建）
pnpm server

# 软件包发布并安装后运行
pnpm add -g dockmux
dockmux --cwd /path/to/project --port 4310
```

支持的参数包括 `--local-only`、`--host`、`--port`、`--cwd`、`--database`、`--idle-timeout-ms`、`--cleanup-interval-ms` 和 `--no-lark-listen`。运行 `dockmux --help` 可查看完整说明。

### 后台运行

`dockmux daemon` 命令组可以把服务挂到后台运行并随时管理它，无需 `pm2` / `systemd` 之类的进程守护工具。它会通过 `daemonize-process` 将当前进程重新派生成隔离会话的守护进程，并把 PID、状态和日志记录在首次启动根目录的 `.dockmux/daemon/` 下。该根目录会被持久记忆；此后即使服务已停止，或者从其他目录执行 `start` / `restart`，仍会复用同一个根目录和 `.dockmux/dockmux.db`，不会静默创建第二套机器人配置。

`start` / `stop` / `restart` / `status` 既可以用在 `dockmux daemon ...` 下，也可以不带前缀直接作为顶层命令使用，两者指向同一套实现：

```bash
# 后台启动，可以带上与前台一致的启动参数（顶层或 daemon 前缀皆可）
dockmux start --cwd /path/to/project --port 4310
dockmux daemon start --port 4410

# 查看是否在运行、PID、地址与日志路径
dockmux status
dockmux daemon status

# 重启（沿用 start 时的参数，也可更换参数）
dockmux restart --port 4420

# 停止后台服务
dockmux stop
```

- 无子命令的 `dockmux` 仍然在前台直接启动服务；只有显式的 `start` 才会转入后台运行，两者互不干扰。
- 启动后会通过 PID 文件加载，处理 SIGTERM 优雅退出；`stop` 会先发 SIGTERM，超时未退再发 SIGKILL，并清理状态文件。
- 日志追加写入 `.dockmux/daemon/dockmux.log`；前台启动的 `dockmux` 与后台 `dockmux daemon start` 可互不干扰地同时使用。
- `status` / `stop` / `restart` 也从当前工作目录解析 `.dockmux/daemon/`。请与 `start` 在同一个目录下执行。
- 已在运行时再次 `start` 会返回 `ok:false` 与 `state:"already-running"`，不会重复拉起进程。

`dockmux acpk` 后的所有内容都会原样传递给已安装的 `acpk` 可执行文件，不做二次解析。参数、选项、顺序、标准输入、标准输出、标准错误和子进程退出码都会完整保留。

```bash
dockmux acpk agents list --json
dockmux acpk run --help
```

默认情况下，本机及同一局域网内的其他设备均可访问 Dockmux。这不会将服务发布到公网，访问仍受路由器、防火墙和网络策略约束。使用 `--local-only`（或 `DOCKMUX_LOCAL_ONLY=true`）启动时，只接受来自本机的连接；高级场景仍可使用 `--host <address>` 指定监听接口。

工作目录按会话解析，优先级依次为：`POST /api/sessions` 提供的 `cwd`、Agent 专属 `cwd`、进程级 `--cwd`。若均未提供，所有内置或自定义 Agent 默认使用启动 `dockmux` 时所在的目录。

## Web 工作台

Web 界面将本地会话和来自飞书的会话统一展示在同一套时间线中。当 Agent 忙碌时，新消息可以排队等待，也可以中断当前轮次后立即发送；排队消息在执行前可以取消。会话完成后，消息、推理过程、工具调用、权限请求和终端输出都会保存在 SQLite 中。

Agent 输出的 Markdown 会随流式内容持续渲染。围栏代码块使用同步 Prism 语法高亮，在新 Token 到达时保持稳定的深色背景，同时展示声明的语言并提供复制操作。遇到未知语言标识时，渲染器会回退为纯文本，不会报错，也不会异步加载第二套主题。

## 飞书卡片


发布后的 `dockmux` 可执行命令可以发送新的 Dockmux Card JSON 2.0 消息，也可以原地更新已有卡片。同一套实现会随服务挂载到 `/api/lark`；飞书配置是可选项，不会阻止常规 Dockmux HTTP/SSE 服务启动。

每个已保存机器人的消息接收状态，都可以在 **飞书设置** 中独立控制。机器人开启监听后，Dockmux 会在启动时建立该机器人的飞书长连接，并在后续启动时自动恢复。使用 `--no-lark-listen` 可以只为当前进程禁用全部监听器；此时界面开关为只读状态，SQLite 中的配置值不会改变。

私聊消息会直接唤醒已配置的 Agent；群聊消息只有在机器人被 @ 时才会唤醒。服务进程存活期间，每个会话复用同一个 Agent Session。Dockmux 会先添加一个随机确认表情，再发送运行中服务卡片、撤销确认表情，并随着 Agent 事件到达持续刷新同一张卡片。在群聊中，服务卡片会作为触发消息的**回复**发出，从而直接落在用户消息之下；如果触发消息位于话题线程内，卡片也会出现在对应线程中（回复失败时回退为群内普通发送）。

在飞书开放平台配置机器人：

1. 创建企业自建应用并启用机器人能力。
2. 为机器人开通飞书 API 所需的消息发送/更新、消息接收和表情回复写入权限；多 Agent 协作还需开通“获取群组中其他机器人和用户 @ 当前机器人的消息”。
3. 使用长连接方式订阅 `im.message.receive_v1`。
4. 发布应用版本，并将目标用户加入应用可用范围。
5. 将机器人加入每个目标群聊。

Web 侧边栏提供两步式的多机器人 **飞书设置** 对话框。第一步校验 App ID 和 App Secret，并可通过 TagInput 直接填写可用成员的真实姓名；保存时服务端会在机器人所在群中精确解析姓名并持久化对应 `open_id`，运行时不读取成员邮箱。找不到姓名或不同用户同名时会拒绝保存，避免授权错误。该步骤同时保存工作区、监听开关、推送间隔和轨迹策略。第二步配置 Agent、模型、推理强度、每轮预注入 Prompt 和高危操作门禁。两步全部完成前，机器人不能开启监听。每个 App ID 只能对应一个配置面板，重复 App ID 会返回 `409 LARK_BOT_ALREADY_CONFIGURED`。

每个机器人都可以配置绝对路径工作区、500 至 20000 毫秒的推送间隔、轨迹条数上限，以及完成后是否隐藏前置轨迹。默认推送间隔为 1000 毫秒，执行中展示最近 10 条轨迹；任务完成后默认隐藏前置 Trace，仅保留 Agent 最终输出。macOS 上的工作区按钮会通过本地服务打开系统目录选择器。配置以明文 JSON 形式存入本地 SQLite 的 `configs` 表。`GET /api/lark/config` 会返回全部机器人配置面板，但绝不会返回 App Secret。

修改默认 Agent、模型、推理强度或工作区后，当前任务不受影响；该机器人在对应会话中的下一条消息会停止旧 Session，并按新配置创建 Session。旧 Session 的历史记录仍会保留。仅修改 Prompt、协作开关、轨迹或卡片展示策略时会继续复用当前 Session，并从后续消息开始生效，无需重启：配置按消息实时读取，协作工具的注入 Prompt（含 `groupToolsEnabled`/`groupToolsAllowSend`/`preInjectPrompt`）会在下一条消息起自动使用新值。单个任务失败（如未产生最终输出、输出被截断或瞬时驱动错误）只会结束该任务，不会把共享 Session 永久置为 `failed`：Session 会回到可复用的 `idle` 状态并继续消费队列中的后续任务，排队的任务不再因会话失败而悬在 `queued` 状态（过去会导致 `Unknown queued task` 和整个群聊卡死）。

### 飞书群内的 Agent 协作

对于已启用协作的群聊，飞书本身就是共享消息总线：Dockmux 不维护第二个房间，也不会将群历史复制到协作数据库。每个 Agent 都会获得一个仅限当前会话的本地 Capability，并可以使用以下命令：

```bash
dockmux group self
dockmux group peers
dockmux group members
dockmux group messages --limit 20
dockmux group messages --after '<cursor>' --limit 20
dockmux group send '请检查这个接口' --to cli_peer
dockmux group send '请改用 dockmux' --to '伟哥'
dockmux group send '已修复' --reply-to om_xxx --idempotency-key handoff-1
dockmux group wait --after '<cursor>' --timeout-ms 15000
```

`peers` 会取“当前飞书群内的机器人”与“本 Dockmux 实例已配置的机器人”的交集，因此不会将任意第三方机器人暴露为可调用 Agent。`messages` 和 `wait` 返回不透明游标，用于增量读取。回复操作会校验目标消息是否属于当前群聊，`send --to` 也只会解析发现结果中的协作方。界面分别提供“启用协作”和“允许写入”两个开关，对应配置字段为 `groupToolsEnabled` 和 `groupToolsAllowSend`。两个能力均默认关闭，必须由管理员显式启用。

Capability 仅包含一个随机 Token，并精确绑定到指定的 Dockmux Session、机器人和群聊。App Secret 与飞书访问令牌始终保留在服务端。以下 snake_case 运行时变量会自动注入，不应手动配置：`dockmux_group_tools_url` 和 `dockmux_group_tools_token`。CLI 仍兼容读取旧版大写变量，但服务端不再注入它们，避免违反 ACPX 持久化键名约束。

机器人需要开通与已启用操作对应的 OpenAPI 权限：

| 操作 | 权限 |
|---|---|
| 发现群内机器人 | `im:chat.members:read` |
| 接收其他机器人 @ 当前机器人的消息 | `im:message.group_at_msg.include_bot:readonly` |
| 读取或等待群消息 | `im:message:readonly` 和 `im:message.group_msg` |
| 发送或回复消息 | `im:message` |

飞书因权限不足拒绝操作时，命令会返回 `GROUP_TOOL_AUTHORIZATION_REQUIRED`，并携带 `requiredScopes`、`instruction` 和 `authorizationUrl`。Agent 会被要求停止该操作，并向用户展示这些信息。管理员必须在飞书开放平台为机器人开通权限并发布新的应用版本；机器人授权不能通过 `lark-cli auth login` 修复，Agent 也绝不能向用户索要 App Secret 或访问令牌。

可选的高危操作门禁包含两层。软门禁会针对不在高危成员名单中的发送者，注入不可绕过的安全指令；高危成员同样通过姓名 TagInput 填写，并在保存时解析为 `open_id` 鉴权。硬门禁会额外启用 ACP 权限拦截器和所选 Agent 的原生工具调用 Hook。Codex、Claude Code、Trae、Cursor Agent 和 Pi 均支持原生安装。Hook 配置写入所选工作区，已有且无关的 Hook 会被保留；高危正则表达式会同时在 Web 界面和服务端校验。匹配过程运行在隔离 Worker 中，超过 1000 毫秒即按失败关闭策略处理。

Session 侧边栏会优先展示机器人标签页，其后是本地视图和汇总视图。飞书 Session 会标记所属 App ID，因此不同机器人的消息绝不会混入同一标签页。Session 可以永久归档；已归档 Session 为只读状态，默认隐藏，可从左下角归档区域打开。系统有意不提供恢复 API。

环境变量：

| 变量 | 是否必需 | 用途 |
|---|---:|---|
| `LARK_APP_ID` | 是 | 企业自建应用 ID（`cli_xxx`） |
| `LARK_APP_SECRET` | 是 | 企业自建应用密钥；仅服务端使用，状态 API 永不返回 |
| `LARK_RECEIVE_ID` | 使用默认发送目标时 | 默认接收方；单次 CLI/API 调用可以覆盖 |
| `LARK_RECEIVE_ID_TYPE` | 否 | `open_id`、`union_id`、`user_id`、`email` 或 `chat_id`；默认为 `email` |
| `LARK_CHAT_ID` | 使用默认群聊时 | 群聊 ID（`oc_xxx`）；优先级高于 `LARK_RECEIVE_ID` |
| `LARK_AGENT_NAME` | 否 | 默认卡片标题前缀；默认为 `Dockmux`，每次调用均可覆盖 |
| `LARK_OPEN_API_BASE_URL` | 否 | OpenAPI 地址；默认为 `https://open.feishu.cn` |

对应的服务启动参数为 `--lark-app-id`、`--lark-app-secret`、`--lark-receive-id`、`--lark-chat-id`、`--lark-receive-id-type`、`--lark-agent-name` 和 `--lark-base-url`。`--no-lark-listen` 只覆盖当前进程的监听状态。

CLI 示例：

```bash
# 推荐：从进程环境变量或 .env 读取凭证
export LARK_APP_ID=cli_xxx
export LARK_APP_SECRET=replace_me
export LARK_RECEIVE_ID=user@example.com
export LARK_RECEIVE_ID_TYPE=email
dockmux lark send '**构建完成**' --task-id release-42

# 将机器人加入群聊后，直接向该群发送消息
dockmux lark send '**群聊构建通知**' --chat-id oc_xxx --task-id release-42

# 等价的单次调用参数
# 完成态卡片；默认使用 LARK_RECEIVE_ID
dockmux lark send '**构建完成**' \
  --app-id cli_xxx \
  --app-secret 'replace_me' \
  --receive-id user@example.com \
  --receive-id-type email \
  --task-name '发布验证' \
  --task-id release-42 \
  --elapsed-seconds 35

# 运行态卡片；Markdown 正文原样传递
dockmux lark send $'### 构建阶段\n\n🟢 依赖安装完成\n🟡 正在执行测试' \
  --state running \
  --agent-name '我的 Agent' \
  --read-only

# 原地更新同一张卡片
dockmux lark update '**所有检查均已通过。**' \
  --message-id om_xxx \
  --state completed \
  --task-id release-42 \
  --elapsed-seconds 48
```

以下 HTTP 接口均以 Dockmux 服务地址为前缀：

```text
GET  /api/lark/status
GET  /api/lark/config
PUT  /api/lark/config
DELETE /api/lark/config/:appId
POST /api/lark/bot/inspect
GET  /api/lark/hooks/status
POST /api/lark/hooks/install
POST /api/lark/send
POST /api/lark/update
GET  /api/system/capabilities
POST /api/system/select-directory
```

请求体示例：

```json
POST /api/lark/send
{
  "bot": {
    "appId": "cli_xxx",
    "appSecret": "replace_me",
    "receiveId": "user@example.com",
    "receiveIdType": "email",
    "agentName": "我的 Agent"
  },
  "receiveId": "user@example.com",
  "receiveIdType": "email",
  "agentName": "我的 Agent",
  "state": "running",
  "readOnly": true,
  "taskName": "发布验证",
  "taskId": "release-42",
  "elapsedSeconds": 10,
  "markdown": "### 构建阶段\n\n🟢 已连接 Session\n🟡 正在执行测试"
}

POST /api/lark/update
{
  "bot": {
    "appId": "cli_xxx",
    "appSecret": "replace_me",
    "agentName": "我的 Agent"
  },
  "messageId": "om_xxx",
  "agentName": "我的 Agent",
  "state": "completed",
  "taskName": "发布验证",
  "taskId": "release-42",
  "elapsedSeconds": 35,
  "markdown": "**执行完成**\n\n所有检查均已通过。"
}
```

通过 HTTP 向群聊发送消息：

```json
POST /api/lark/send
{
  "botAppId": "cli_xxx",
  "chatId": "oc_xxx",
  "agentName": "我的 Agent",
  "state": "completed",
  "taskId": "release-42",
  "markdown": "**群聊任务已完成**"
}
```

机器人必须已经加入目标群聊。向已知 `chatId` 发送消息只需要常规机器人消息权限；该选项不会同时启用群列表查询或消息接收能力。

`GET /api/lark/status` 用于报告机器人凭证是否存在。`GET /api/lark/config` 可以返回 App ID 和默认 Agent ID，但绝不会返回 App Secret。未配置凭证时调用发送/更新接口会返回 `503 LARK_NOT_CONFIGURED`，其他 Dockmux Session 和 SSE 路由仍可正常使用。

处于已完成、空闲或已中断状态的 Agent Driver 默认会在 6 小时后释放，系统每 5 分钟执行一次清理扫描。Session 元数据和事件仍保存在 SQLite 中，下一条消息会自动重连持久 ACP Session。收到 `SIGINT`、`SIGTERM` 或调用 `server.close()` 时，系统会清除定时器、关闭子 Driver 和 SSE 连接，并释放 SQLite。第二次按下 `Ctrl-C` 会立即退出；CLI 关闭流程设有 5 秒硬上限，避免卡死的子进程占住终端。

Dockmux 启动时会读取 ACPX 内置注册表，检查对应的本地供应商 CLI，并调用其版本命令。只有成功发现的 Agent 才会出现在 `GET /api/agents`、Session 选择器和飞书默认 Agent 选择器中。Mock ACP、JSONL Demo 和 PTY Demo 仅用于测试，不会作为可选内置 Agent 发布。

## Trae 与自定义 ACP Agent

ACPX 内置的 `trae` 条目会解析为 `traecli acp serve`。仍可通过 `DOCKMUX_AGENTS_JSON` 添加自定义 ACP 服务，但只有对应命令可用时才会被纳入：

```json
[
  {
    "id": "custom",
    "name": "自定义 ACP",
    "command": "/path/to/custom-agent",
    "args": ["acp", "serve"],
    "protocol": "acp",
    "model": "optional-model",
    "cwd": "/work/project",
    "env": { "TRAE_PROFILE": "work" },
    "permissionMode": "ask",
    "timeout": 600,
    "capabilities": { "pause": false, "resume": true },
    "builtin": false
  }
]
```

该进程必须通过 stdio 使用 ACP 协议，并支持 `initialize`、Session 创建/加载、Prompt、流式 `session/update`、权限请求和 `session/cancel`。Dockmux 会将 argv 原样传递给 acpx；发现阶段会忽略命令不存在的配置。

权限模式包括 `ask`（默认）、`approve-reads`、`deny-all`，以及必须显式启用的 `full-trust`。`ask` 和 `approve-reads` 会将升级后的 ACP 权限请求发送到 Web 界面，用户的允许/拒绝操作会直接完成实时 acpx 请求。完全信任模式绝不会默认启用。

## HTTP API

```text
POST /api/sessions
GET  /api/sessions
GET  /api/sessions/:id
POST /api/sessions/:id/send
DELETE /api/sessions/:id/queue/:taskId
POST /api/sessions/:id/interrupt
POST /api/sessions/:id/pause
POST /api/sessions/:id/resume
POST /api/sessions/:id/stop
POST /api/sessions/:id/restart
POST /api/sessions/:id/archive
POST /api/sessions/:id/permissions/:permissionId
GET  /api/sessions/:id/events?after=<sequence>
GET  /api/sessions/:id/stream
GET  /api/agents
```

SSE 事件携带 `id: <sequence>`，并支持通过 `Last-Event-ID` 或 `?after=` 回放。输出会标准化为 `text`、`thinking`、`tool_call`、`tool_result`、`permission_request`、`status`、`error`、`completed` 和 `raw_terminal`。解析失败的内容始终转换为 `raw_terminal`，绝不会丢弃。

`interrupt` 会取消当前 ACP 轮次，但保留 Session；`stop` 会关闭 acpx Session 和进程；`resume` 使用持久化的 Dockmux Session Key 重连；`restart` 会先停止，再使用新的 `runId` 启动运行时实例。不支持暂停的 Agent 会返回 `UNSUPPORTED_CAPABILITY`，而不会假装暂停成功。

## 存储与架构

业务代码依赖仓储接口，而非直接依赖 SQLite。Drizzle/better-sqlite3 实现负责持久化机器、项目、Session、任务、事件、工具调用、权限、错误和通道映射。

需求与验证证据的对应关系见[验收计划](docs/acceptance-plan.md)。测试套件覆盖：真实内嵌 acpx 运行时与 Mock ACP 服务、工具调用关联、实时权限、生命周期语义、异常退出、JSONL/PTY 降级、无损原始输出、SSE 回放、仓储恢复、安全默认值、自定义 Agent，以及 12 项 TraeX 检查。
