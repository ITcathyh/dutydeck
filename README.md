# Dockmux

Dockmux 是本地优先的 Agent 工程工作台。你从 Web 或飞书下达工程目标，Dockmux 负责选择和连接本机 Agent、持续展示有效进展、处理排队与审批、恢复异常，并把结果和验证证据留在同一条任务记录中。

```text
选择工作区 → 描述目标 → 查看进展 → 审批或纠偏 → 验证结果 → 继续工作
```

产品界面以 `Workspace → Task → Run` 组织信息；Session 是保持 Agent 上下文和兼容 HTTP API 的内部概念，不是使用 Dockmux 的前置知识。

## 核心体验

- **任务优先的 Web 工作台**：按工作目录聚合运行，首页集中显示执行中、排队、失败和最近完成的任务。创建任务时先写目标，再按需覆盖 Agent、模型和推理强度。
- **飞书指挥台**：私聊或群聊 @ 即可下达任务。单张卡片从排队更新到终态，优先展示当前焦点、结论、验证证据和此刻真正可用的操作。
- **可干预、可恢复的运行时**：支持排队、取消排队、立即介入、中断、继续、停止和重启。SQLite 保存任务、事件、授权请求和通道映射，daemon 重启后会恢复可执行队列。
- **有界历史与实时增量**：Web 首屏只读取最近 200 个事件，按游标加载更早记录，并将本地渲染窗口限制在 800 个事件；SSE 使用严格递增的 `sequence` 补齐断线期间的事件。
- **安全姿态明确**：Agent 默认使用 `ask`，`full-trust` 必须显式配置。远程浏览器通过 HttpOnly、SameSite Cookie 登录；浏览器登录流程不会把访问令牌写进 URL 或前端存储。
- **ACP 与真实 CLI**：优先使用固定版本的 `acpx@0.13.0` 接入 ACP Agent，也可通过 PTY 适配器连接已安装的 CLI。Dockmux 只展示本机实际可用的 Agent 和版本。

## 快速开始

环境要求：Node.js 22.12+、pnpm 11。要使用的 Agent CLI 需已在本机安装并完成供应商认证。

```bash
pnpm install
cp .env.example .env
pnpm dev
```

开发模式下：

- Web：`http://127.0.0.1:4311`
- API：`http://127.0.0.1:4310`

Vite 会把 Web 请求代理到本地 API。首次进入工作台后，选择工作区、填写任务目标并执行即可。

生产构建和本仓库启动：

```bash
pnpm build
pnpm server
```

全局安装后可以直接运行：

```bash
pnpm add -g dockmux
dockmux --cwd /path/to/project --port 4310
```

运行 `dockmux --help` 查看全部参数。

## 前台、后台与更新

无子命令的 `dockmux` 在前台运行。`start`、`stop`、`restart` 和 `status` 管理内置 daemon；带或不带 `daemon` 前缀的两种写法等价。

```bash
dockmux start --cwd /path/to/project --port 4310
dockmux status
dockmux restart --port 4410
dockmux stop

# 等价命令组
dockmux daemon start --port 4310
dockmux daemon status

# 更新全局包并重启后台服务
dockmux update
```

daemon 的数据库、PID、状态和日志位于启动根目录的 `.dockmux/`。服务会记住第一次启动的根目录，后续管理命令不会静默创建第二套配置。收到退出信号时，Dockmux 会关闭 Agent、SSE、终端连接和 SQLite；空闲 Driver 默认在 6 小时后释放，任务历史仍会保留。

## Web 工作台

工作台将 Web 与飞书创建的任务统一到工作区视图中：

1. 首页按状态扫描所有任务运行，并显示真实任务目标，而不是内部 ID。
2. 新建任务同时创建运行上下文并派发目标；若派发失败，可以只重试派发，不会重复创建。
3. 任务详情合并连续工具活动，突出当前步骤、最终回答、审批和错误；原始终端输出在独立面板中按需查看。
4. Agent 忙碌时，新指令可以排队，也可以立即介入；排队项可取消或提升为下一项。
5. 中断、失败或停止后的任务可以重启；归档后保留只读历史。

Markdown、代码块、工具调用和终端视图均按需渲染。长历史不会在首屏全量读取或一次性挂载到 DOM。

## 远程浏览器访问

Dockmux 默认只监听 `127.0.0.1:4310`，本机使用无需登录。需要局域网访问时显式使用 `--host 0.0.0.0`；一旦启用远程监听，所有来源（包括反向代理的 loopback 回源）都必须认证。

服务首次启动时会生成访问令牌并打印一次。之后可以随时查看或轮换：

```bash
dockmux auth token
dockmux auth token --rotate
```

远程浏览器打开工作台后输入令牌一次。验证成功后，服务只设置 `HttpOnly; SameSite=Strict` Cookie，fetch、SSE 和终端 WebSocket 会自动携带它。轮换令牌会使旧令牌及其浏览器会话失效。通过 HTTPS 反向代理访问时，应正确传递请求协议，使 Cookie 同时带上 `Secure`。

仅在本机使用时可以缩小监听面：

```bash
dockmux --local-only
# 或 DOCKMUX_LOCAL_ONLY=true

# 显式开启局域网访问
dockmux --host 0.0.0.0
```

高级场景可使用 `--host <address>` 指定接口。不要把未启用 TLS 的服务直接暴露到不可信网络。

## 权限姿态

Dockmux 将一个权限姿态从 Agent 配置贯穿到 ACP 或 PTY 启动边界：

| 模式 | 行为 |
|---|---|
| `ask` | 默认值；需要升级的操作进入实时审批。 |
| `approve-reads` | ACP：自动允许只读请求，其他请求仍需批准。 |
| `deny-all` | ACP：拒绝所有需要升级的权限请求。 |
| `full-trust` | 显式开启完全信任；只应用于你确认可无人值守执行的工作区。 |

ACP 的待处理权限会出现在对应运行记录旁，可直接允许或拒绝。PTY CLI 当前只支持 `ask` 与 `full-trust`：`ask` 保留供应商原生确认并可从终端处理，另外两种不受支持的模式会被明确拒绝。适配器在安全模式下不会追加供应商的 bypass / yolo 参数；完全信任参数只在 `full-trust` 下启用。

## 飞书指挥台

发布版服务可以监听多个飞书机器人，也可以通过 CLI 或 `/api/lark` 主动发送和原地更新 Card JSON 2.0 消息。飞书配置可选，不会阻止 Web/API 启动。

### 用户路径

- 私聊文本直接创建任务；群聊只有 @ 机器人时触发。
- Dockmux 先确认收到，再在触发消息或对应话题下回复唯一任务卡片。
- 排队、运行、待决策、完成、中断和失败使用不同视觉层级。
- 运行态只保留少量合并后的有效进展；完成态先给结论，再给检查、改动和异常等证据。
- 卡片不展示模型私有思维链。工具参数、输出、错误和终端摘要在进入卡片前会做敏感信息清理并受卡片总大小预算约束。
- daemon 重启后，恢复中的旧卡片先变为只读，再与持久化终态对账，避免展示已经失效的按钮。

### 接入机器人

1. 在飞书开放平台创建企业自建应用，取得 App ID 与 App Secret。
2. 在 Web 的“飞书指挥台”填写 App ID，点击“自动配置”。Dockmux 会复用本机私密登录态；没有可用登录态时显示飞书二维码。
3. 自动配置会增量导入 Dockmux 需要的 16 项消息、群聊、附件与联系人权限，启用机器人，设置长连接 `im.message.receive_v1` 与 `card.action.trigger`，回读验证后发布新版本。存量应用的可见范围会在发版前完整读回并原样保留；无法确认时停止发版。
4. 填写 App Secret、工作区与 Agent，明确确认无人值守 `full-trust` 后启用监听，并把机器人加入目标群。

自动配置不是保存门禁，也不会申请用户身份发消息权限；需要时仍可在开发者后台手动配置。开放平台 Cookie 只写入本机 `~/.dockmux/feishu-open-platform-session.json`（私有权限），不会返回浏览器、进入日志或交给 Agent。

App Secret 只保留在服务端；通过 Web 保存时写入本地 SQLite，查询接口不会返回它。成员白名单使用姓名录入，保存时解析成 `open_id`；同名或找不到成员时会拒绝保存。使用 `--no-lark-listen` 可以只为当前进程关闭监听，不修改已保存配置。

常用环境变量：

| 变量 | 用途 |
|---|---|
| `LARK_APP_ID` | 企业自建应用 ID。 |
| `LARK_APP_SECRET` | 应用密钥，只供服务端使用。 |
| `LARK_RECEIVE_ID` | CLI/API 的默认接收方。 |
| `LARK_RECEIVE_ID_TYPE` | `open_id`、`union_id`、`user_id`、`email` 或 `chat_id`。 |
| `LARK_CHAT_ID` | 默认群聊 ID；存在时优先于默认接收方。 |
| `LARK_AGENT_NAME` | 卡片默认 Agent 名称。 |
| `LARK_OPEN_API_BASE_URL` | OpenAPI 地址，默认 `https://open.feishu.cn`。 |

主动发送或更新卡片：

```bash
export LARK_APP_ID=cli_xxx
export LARK_APP_SECRET=replace_me
export LARK_RECEIVE_ID=user@example.com
export LARK_RECEIVE_ID_TYPE=email

dockmux lark send '**构建完成**' --task-name '发布验证' --task-id release-42
dockmux lark update '**所有检查均已通过**' \
  --message-id om_xxx --state completed --task-id release-42
```

### 群内 Agent 协作

启用群协作后，飞书群本身是共享消息总线。Agent 可以发现当前群中由本 Dockmux 实例管理的机器人、增量读取消息，并在管理员允许时发送或回复：

```bash
dockmux group self
dockmux group peers
dockmux group members
dockmux group messages --limit 20
dockmux group send '请检查这个接口' --to cli_peer
dockmux group wait --after '<cursor>' --timeout-ms 15000
```

群工具 capability 精确绑定运行、机器人和群聊。App Secret 与飞书访问令牌不会交给 Agent。ACPX Session 只写入 snake_case 的 `dockmux_group_tools_url` 和 `dockmux_group_tools_token`；旧大写键仅能在读取边界兼容。

## Agent 配置

Dockmux 启动时读取 ACPX 注册表，并检查对应供应商 CLI。只有可执行文件存在的 Agent 才会进入 Web 与飞书选择器；能够探测到的 CLI 版本会一并展示。

使用 `DOCKMUX_AGENTS_JSON` 添加或覆盖 Agent。下面是自定义 ACP 示例：

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
    "env": { "CUSTOM_PROFILE": "work" },
    "permissionMode": "ask",
    "timeout": 600,
    "capabilities": { "pause": false, "resume": true },
    "builtin": false
  }
]
```

工作目录优先级为：创建运行时的 `cwd`、Agent 配置的 `cwd`、进程级 `--cwd`。自定义 ACP 进程需通过 stdio 支持初始化、创建/加载 Session、Prompt、流式更新、权限请求与取消。

主要环境变量：

| 变量 | 默认值/用途 |
|---|---|
| `DOCKMUX_HOST` | 默认 `127.0.0.1`；显式设为 `0.0.0.0` 才开启局域网监听。 |
| `DOCKMUX_PORT` | 默认 `4310`。 |
| `DOCKMUX_LOCAL_ONLY` | `true` 时只监听 `127.0.0.1`。 |
| `DOCKMUX_DATABASE_URL` | 默认 `<cwd>/.dockmux/dockmux.db`。 |
| `DOCKMUX_DEFAULT_CWD` | 默认工作区。 |
| `DOCKMUX_ACPX_COMMAND` | ACPX 可执行命令。 |
| `DOCKMUX_DRIVER_IDLE_TIMEOUT_MS` | Driver 空闲释放时间，默认 6 小时。 |
| `DOCKMUX_CLEANUP_INTERVAL_MS` | 清理扫描间隔，默认 5 分钟。 |
| `DOCKMUX_AGENTS_JSON` | 自定义 Agent JSON 数组。 |

## HTTP 与事件模型

对外 HTTP 路径暂时保留 `/api/sessions/*` 以兼容现有客户端；产品层把一条 Session 投影为一个任务运行。常用接口：

```text
POST /api/sessions
GET  /api/sessions
GET  /api/sessions/summaries
POST /api/sessions/:id/send
POST /api/sessions/:id/interrupt
POST /api/sessions/:id/restart
POST /api/sessions/:id/permissions/:permissionId
GET  /api/sessions/:id/tasks
GET  /api/sessions/:id/events?before=<sequence>&limit=200&direction=backward
GET  /api/sessions/:id/stream?after=<sequence>
GET  /api/agents
```

事件标准化为 `text`、`thinking`、`tool_call`、`tool_result`、`permission_request`、`status`、`task`、`error`、`completed` 和 `raw_terminal`。无法解析的输出保留为 `raw_terminal`，不会静默丢弃。SSE 在建立订阅后回放持久化事件，并按 `sequence` 合并同时到达的实时事件，消除回放与订阅之间的丢失窗口。

## 验证与性能

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke
pnpm benchmark
```

- `pnpm smoke` 使用隔离的假 CLI 验证发现 Agent、创建运行、SSE、继续对话、终端 WebSocket 和生产 Web。
- `node scripts/e2e-smoke.mjs --real` 使用本机真实 Claude CLI 执行同一关键链路，会调用模型并可能产生费用，必须显式运行。
- `pnpm benchmark` 构建 Web 后写入临时磁盘 SQLite 的 5 万事件，并用真实无头 Chromium 检查首屏、分页、实时增量、浏览器堆、100 次 SSE 重连、服务端内存和入口 gzip 预算；超出任一预算即失败。

完整产品定义、架构不变量和一次性交付矩阵见：

- [产品定义](docs/product-1.0.md)
- [架构](docs/architecture-1.0.md)
- [验收矩阵](docs/acceptance-1.0.md)
- [包边界审计](docs/package-boundaries-1.0.md)

## Historical / Provenance

Dockmux 的部分 ACP 工作台、飞书桥接、CLI 适配与终端实现来自早期内部原型的演进。来源只用于保留版权、许可证和代码考古信息，不定义当前产品模型。历史说明见 [Provenance](docs/architecture.md)；如需追溯具体实现，请以 Git 历史和对应源文件版权声明为准。
