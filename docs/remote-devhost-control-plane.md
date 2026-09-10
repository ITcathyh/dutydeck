# 远程开发机上的 Dutydeck 控制面

这份指南面向把 Dutydeck 运行在一台受信开发机、从另一台电脑用浏览器管理的用户。它覆盖从安装、`--no-auth` 启动，到 staged 飞书配置、群策略、自动化预览和 Botmux 只读迁移检查的完整旅程。

当前控制面遵守 **NO-ACTIVATION**：可以安全地准备和检查配置，但不会因此启动飞书 listener、接管消息、启用 Schedule 或切换 Botmux 的生产写入方。看到 `runtime blocked` 通常是预期状态，不等于配置丢失。

本文中的主机名、ID 和路径全部是合成占位符。不要把真实 App Secret、访问令牌、用户身份或私有路径贴到文档、工单、聊天和命令行参数里。

## 1. 先分清两种凭据

| 名称 | 保护什么 | `--no-auth` 后是否还需要 | 放在哪里 |
|---|---|---:|---|
| Dutydeck 访问令牌 | 浏览器、HTTP API、SSE 和终端 WebSocket 对这台 Dutydeck 的访问 | 否 | 默认由 Dutydeck 管理；浏览器认证后只使用 HttpOnly Cookie |
| 飞书 App credentials | Dutydeck 代表企业自建应用读取飞书 App/群事实 | **仍然需要** | 本机 SecretProvider；普通 Web/API 只看到 SecretRef metadata |

`--no-auth` 只关闭第一道门。它不会创建、替代或放宽飞书的 App ID / App Secret，也不会让缺少 SecretRef 的 ChannelBot 变为可用。

关闭 Dutydeck 鉴权后，任何能连到该主机端口的人都能查看任务、控制 Agent 和访问终端。只能在受信网络或已经有上游鉴权的代理之后使用；不要直接暴露到公网。

## 2. 安装并启动受信开发机模式

环境要求为 Node.js 22.12+。从 npm 包使用时：

```bash
pnpm add -g dutydeck
dutydeck --version
```

从源码仓库使用时：

```bash
pnpm install
pnpm build
```

在固定的 Dutydeck 启动根目录运行 daemon。下面的主机、路径和端口仅为示例：

```bash
cd /srv/example-dutydeck
dutydeck start \
  --host 0.0.0.0 \
  --port 4310 \
  --cwd /srv/example-workspaces/project-a \
  --no-auth
dutydeck status
```

然后从浏览器打开：

```text
http://devbox.example.test:4310
```

页面应显示“受信开发机模式 · 无需 token”。这表示当前实例没有 Dutydeck 访问令牌登录步骤；不要因此去寻找、复制或粘贴 `dutydeck auth token`。如果页面不可达，先检查 `dutydeck status`、主机防火墙、端口映射和浏览器使用的 hostname/port 是否与启动参数一致。

daemon 会记住 `--no-auth`。要恢复默认鉴权，必须显式执行：

```bash
cd /srv/example-dutydeck
dutydeck restart --auth
```

## 3. 进入控制中心，但保留任务主路径

首次打开仍然会进入 attention-first 的任务首页。创建任务、处理审批和查看终端是主路径；Agent、飞书和自动化属于低频控制面。

从左侧栏打开“控制中心”，会看到四个入口：

1. **Agent**：浏览器安全的 Agent allowlist；不显示启动命令、环境变量、路径或 system prompt。
2. **飞书接入**：ChannelBot、SecretRef metadata、legacy 状态和运行时 blocker。
3. **群与权限**：RemoteChatFact、GroupBinding、有效路由、RBAC 摘要和独立 action gate。
4. **自动化**：ScheduleDefinition 的 staged/disabled 编辑和下一次触发预览。

左侧“下一步”只给当前最先需要处理的一件事。高级字段、blocker 明细和 metadata 定位符默认折叠，按需展开。

## 4. 准备 Agent 与 staged ChannelBot

### 4.1 Agent

Dutydeck 会从 ACPX 注册表和本机已安装的 CLI 发现 Agent。控制中心的 Agent 页目前是只读投影，不提供 staged AgentDefinition 创建表单：

- 内置 Agent：先在开发机安装并完成对应供应商 CLI 认证，再重启 Dutydeck。
- 自定义 Agent：当前仍通过 `DUTYDECK_AGENTS_JSON` 配置后重启，并在控制中心核对公开字段。
- 不要把供应商 token、App Secret 或其他秘密写入为了展示而创建的 Agent 字段。

因此，当前用户旅程是“准备并确认 Agent”，不是在 Web 创建新的 staged AgentDefinition。若没有任何 Agent，任务创建会保持不可用。

### 4.2 ChannelBot

在“飞书接入”中选择“创建 staged Bot”，只填写：

- 显示名称，例如 `Example Team Bot`；
- 飞书 App ID，例如 `cli_example_app`；
- 品牌：飞书或 Lark。

不要在 Web 填 App Secret。新对象固定为：

```text
state = staged
desired listener state = disabled
full trust = false
```

创建成功不代表已连通飞书，更不会启动 listener。如果同一 App 还存在旧配置，页面会标记 `legacy_unmanaged`；先并行核对，不要让新旧两边同时成为写入方。

## 5. 用本机 SecretProvider 安全录入飞书凭据

SecretRef ID 是 Dutydeck 内部使用的非敏感引用名，例如 `lark-example-team`。严格的 Lark bundle 结构是：

```json
{
  "schema_version": 1,
  "kind": "lark_app_credential",
  "app_id": "cli_example_app",
  "app_secret": "synthetic-placeholder-only"
}
```

上面的值只是结构示例，不能通过真实预检。真实值不要出现在 shell argv、环境变量或 Web 表单中。

最简单的安全方式是在受信开发机的交互终端运行，让 CLI 以隐藏输入读取完整 JSON：

```bash
cd /srv/example-dutydeck
dutydeck secret set lark-example-team
```

自动化或已有受控输入文件时，必须通过显式文件描述符传入。输入文件应由你的秘密管理工具生成、权限不宽于 `0600`，并按本地凭据销毁策略及时处理：

```bash
cd /srv/example-dutydeck
dutydeck secret set lark-example-team --value-fd 0 \
  < /srv/example-private-input/lark-app-bundle.json
```

如果 CLI 不是从 daemon 的启动根目录运行，应显式指向同一数据库，避免把 metadata 写入另一套 `.dutydeck`：

```bash
dutydeck --database /srv/example-dutydeck/.dutydeck/dutydeck.db \
  secret set lark-example-team --value-fd 0 \
  < /srv/example-private-input/lark-app-bundle.json
```

检查结果时只列 metadata 和可用性，不会返回明文：

```bash
cd /srv/example-dutydeck
dutydeck secret list
```

回到控制中心，在群配置矩阵中为 ChannelBot 选择 `lark-example-team`。如果引用为 `missing` 或 `unreadable`，Bot 必须继续 disabled；Web 不提供“测试并回显”或临时粘贴 App Secret 的旁路。

## 6. Identity preflight

Identity preflight 的目标是只读验证三件事：

1. SecretRef 中的 App ID 与 staged ChannelBot 一致；
2. 飞书接受该 App credential，并能返回对应 Bot 的脱敏身份事实；
3. 对选定 GroupBinding，Bot 能读取群且确实是群成员。

预检只写带有效期、凭据 revision/fingerprint 绑定的 RemoteIdentityFact / RemoteChatFact；输出不含原始 App Secret、Open ID、Chat ID 或用户 PII。即使通过，返回仍应是 `activationChanged=false`、`listenerReadiness=blocked`。

先验证 App identity；没有 `--group-binding` 时不会凭空发现未知群：

```bash
cd /srv/example-dutydeck
dutydeck lark preflight channel-bot-example
```

已有 GroupBinding 时，可以重复传入 `--group-binding`，只验证选中的群：

```bash
cd /srv/example-dutydeck
dutydeck lark preflight channel-bot-example \
  --group-binding group-binding-example-a \
  --group-binding group-binding-example-b
```

CLI 只连接 daemon state 记录的 loopback 地址，不接受任意远程 URL。鉴权 daemon 模式下，它从 daemon 记录的数据库读取 Dutydeck 访问令牌并在本机请求边界使用；显式 `--no-auth` 的受信开发机模式不发送 Authorization。两种模式都不会把 token 打到 stdout。

输出会再次经过 CLI allowlist，只保留脱敏 identity/chat fact、validity 和 blocker。`status=blocked` 时 JSON 仍完整输出，但进程退出码为 `2`，便于脚本将“已检查但未通过”与命令崩溃区分。即使 `status=passed`，结果也固定包含：

```text
activationChanged = false
listenerReadiness = blocked
remainingBlockers = listener_lease, activation_unavailable
```

所以 preflight passed 只是离线事实证据，不是 listener 激活或 cutover。

## 7. 群事实、GroupBinding 与 RBAC

当群矩阵中已有可用的 RemoteChatFact 时：

1. 打开“群与权限”→“群配置矩阵”。
2. 核对远端事实：群名、成员状态、群类型和事实有效期。
3. 对“未配置”的群选择“配置此群”；Dutydeck 创建继承默认值的 staged GroupBinding。
4. 按需编辑回复模式、提及策略以及群工具 `read` / `discover` / `send`。
5. 如果启用 oncall，记住它只授予 `can_talk`，不会授予 `can_operate` 或 `admin`。
6. 保存后查看 effective config，确认每一项来自 Bot 默认还是群级覆盖，并处理列出的 blocker。

权限必须按 action 判断，不能把一个角色当作所有能力的总开关：

| 能力 | 规则 |
|---|---|
| `can_talk` | open/oncall 可获得；只允许对话 |
| `can_operate` | 还要满足 own/group/bot scope |
| `admin` | 管理控制面与高权限配置 |
| terminal write | 独立 action gate |
| high-risk | 独立 action gate |
| group-tools send | 独立 action gate，且还受 Bot ceiling 和群覆盖约束 |

当前 Web 可以创建/编辑 GroupBinding 并展示 RBAC 摘要，但还没有完整的 RoleAssignment 管理表单。没有已有 RemoteChatFact 时，Web 也不会让用户手填任意 Chat ID 伪造事实；preflight CLI 只验证已经选定的 GroupBinding，不会凭空发现未知 Chat ID。CAS 冲突时不要刷新丢弃草稿，使用“基于新版本重试”。

## 8. Schedule 只做 edit / preview

在“自动化”中打开 Schedule 面板，可以：

- 查看 staged/disabled ScheduleDefinition；
- 修改名称、时区和 DST 策略；
- 预览下一次触发时间；
- 查看 identity、SecretRef、目标群、单写者 lease 和 executor blocker；
- 在 revision 冲突时保留草稿并基于新版本重试。

当前面板不会创建生产 timer、Task/Run 或发送消息，也没有 enable、run-now 或接管按钮。Schedule executor 尚未实现；从 Botmux 发现的 enabled source Schedule 仍由 Botmux 所有，不能因为 Dutydeck 能预览就切换写入方。

当前 Web 也不提供 greenfield ScheduleDefinition 创建表单；只有已经进入离线仓储的定义才能 edit/preview。

## 9. Botmux Importer：discover → plan → archive

Importer 是只读审计工具，不是 apply/cutover 工具。先在合成路径或明确选定的 Botmux source 上运行：

```bash
dutydeck botmux discover \
  --source-home /srv/example-botmux-source \
  --data-dir /srv/example-botmux-source/data

dutydeck botmux plan \
  --source-home /srv/example-botmux-source \
  --data-dir /srv/example-botmux-source/data \
  --output /srv/example-audit/redacted-plan.json
```

确认 plan 的 blocker 和 `production_cutover=NO_GO` 后，才能按需创建私密加密 archive：

```bash
dutydeck botmux archive \
  --source-home /srv/example-botmux-source \
  --data-dir /srv/example-botmux-source/data \
  --output /srv/example-audit/private-archive
```

交互终端会隐藏询问 archive 口令。非 TTY 必须用 `--passphrase-fd`；不要把口令放入 argv 或环境变量。完整输入安全规则见 [Botmux 只读迁移 CLI](botmux-import-cli.md)。

这三条命令都不会：

- 写入 Dutydeck 的 AgentDefinition、ChannelBot、GroupBinding 或 Schedule runtime；
- 修改或停止 Botmux；
- 启动 listener、恢复 session/workflow 或解除 blocker；
- 把 `NO_GO` 变成 activation ready。

## 10. 状态词汇

| 状态 | 用户含义 | 应做什么 |
|---|---|---|
| `staged` | 新配置草稿，尚未进入生产运行 | 补齐 metadata、事实、权限并复核 effective config |
| `disabled` | 明确保持关闭；不应产生生产动作 | 仅离线编辑，等待独立激活评审 |
| `legacy_unmanaged` | 旧配置/运行仍存在，但不受新 SecretRef、GroupBinding 和 action RBAC 契约管理 | 保持来源可见，避免双写；迁移和切换前单独审计 |
| `offline_management_ready` | repository、权限解析和管理写入可用于离线配置 | 可以 staged 编辑；不代表 runtime ready |
| `runtime blocked` | 生产消息或执行入口 fail-closed | 展开 blocker，完成对应 wiring/预检；不要寻找隐藏开关 |
| `NO-ACTIVATION` | 本阶段的产品安全约束，不是“稍后自动开启” | 不启动 listener/Schedule，不停止 Botmux，不做 cutover |
| `production_cutover=NO_GO` | Importer 判定当前不能切换生产所有权 | 处理 plan blocker，保留现有 writer |

## 11. 排错

### 浏览器仍要求 Dutydeck token

确认连接的是正确的 hostname/port，并从 daemon 启动根目录检查状态。若进程继承了旧配置，显式重启：

```bash
cd /srv/example-dutydeck
dutydeck restart --host 0.0.0.0 --port 4310 --no-auth
```

不要为了绕过错误登录页把 token 写进 URL。

### SecretRef 显示 missing / unreadable

```bash
cd /srv/example-dutydeck
dutydeck secret list
```

确认 CLI 与 daemon 使用同一个数据库、SecretProvider 目录归当前用户所有且目录/文件没有被软链替换。需要轮换时使用 metadata 中的当前 revision：

```bash
dutydeck secret rotate lark-example-team \
  --expected-revision 2 \
  --value-fd 0 \
  < /srv/example-private-input/lark-app-bundle-rotated.json
```

轮换不会绕过 ChannelBot 的引用、identity preflight 或 App ID 一致性检查。

### App identity mismatch 或远端认证失败

核对 staged ChannelBot 的 App ID 与 Lark bundle 的 `app_id` 是否属于同一企业自建应用。不要尝试在 Web 查看 App Secret；修正受控输入并做条件 rotate，再重新运行 `dutydeck lark preflight <channel-bot-id>`。

### 群没有出现或状态过期

确认 Bot 已加入目标群、群 ID 属于同一 App/tenant，并检查 RemoteIdentityFact / RemoteChatFact 的 validity。事实缺失、过期、凭据 revision 变化或 Bot 不在群中都必须 fail-closed；不能手工把状态改成 member。

### 保存时出现 revision conflict

这表示其他浏览器或进程先保存了新 revision。控制面会保留 ChannelBot SecretRef、GroupBinding 或 Schedule 草稿；先阅读 current revision，再选择“基于新版本重试”。不要用旧 revision 强行覆盖。

### 一直显示 runtime blocked

展开 blocker 的 code、message 和 action。凭据、identity、事实、权限、listener lease、Schedule writer ownership 和 executor 是不同依赖；只完成其中一项不会解除其他 blocker。当前版本没有通用“忽略并继续”按钮。

## 12. 回滚与恢复安全

- **恢复 Dutydeck 鉴权**：`dutydeck restart --auth`；之后用 `dutydeck auth token` 完成远程浏览器登录。
- **撤回 SecretRef 选择**：先在群配置矩阵把所有 ChannelBot 与该引用解绑，再根据 `secret list` 的 revision 执行 `dutydeck secret remove <ref-id> --expected-revision <n>`。被引用时 remove 会拒绝，不会级联破坏 Bot。
- **撤回 staged 群或 Schedule 编辑**：当前 Web 没有通用 undo/delete。使用 current revision 把字段改回已审计的旧值；在确认前始终保持 disabled。
- **CAS 冲突**：保留草稿并 rebase；不要通过清库或手改 SQLite 规避 revision。
- **Importer**：`discover` 不写文件；`plan` 只创建新的 `0600` 脱敏报告；`archive` 只创建新的 `0700` 私密目录且没有 restore 命令。Archive 是否删除应遵循你的保留策略，Dutydeck 不提供自动回滚。
- **Botmux writer**：staging Dutydeck 不会停止 Botmux。只要 plan 仍为 `NO_GO`，就保留原 writer，不进行双写或手工切换。

## 13. 当前还不能做什么

截至这份指南对应的版本，以下能力没有面向用户的完整闭环：

- 在 Web 新建 staged AgentDefinition；Agent 页目前只读。
- 在没有可信 RemoteChatFact 的情况下，仅靠 Web 手填 Chat ID 创建群事实。
- 在 Web 完整管理 RoleAssignment；当前只能编辑 GroupBinding/oncall/group-tools 并查看权限摘要。
- 在 Web 新建任意 ScheduleDefinition，或启用、立即运行 Schedule。
- 启动新 ChannelBot listener、申请 listener lease、自动停旧 Botmux writer 或完成 cutover。
- 从 Botmux archive apply/restore；Importer 仍只有 discover/plan/archive。

这些限制是可见的 blocker，不应通过 legacy Web secret 表单、环境变量、直接 SQLite 修改或未记录的内部 API 绕过。
