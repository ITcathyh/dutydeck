# Dutydeck

<p align="center">
  <strong>本地优先的 AI Agent 工程工作台与飞书指挥台</strong><br>
  <em>Local-First AI Agent Engineering Workbench & Lark Bridge</em>
</p>

<p align="center">
  <a href="#quick-start">⚡ 快速上手</a> •
  <a href="#lark-guide">🤖 飞书指挥台</a> •
  <a href="#web-console">🖥️ Web 控制台</a> •
  <a href="#agent-config">⚙️ Agent 配置</a> •
  <a href="#cli-reference">🛠️ CLI 速查</a> •
  <a href="#faq">❓ FAQ</a>
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="./README.en.md">English</a>
</p>

---

## 📖 简介与核心价值

**Dutydeck** 是一个本地优先（Local-First）的个人与团队 Agent 研发工作台。它将你开发机或服务器上运行的编码智能体（如 Claude Code、Codex、各类 ACP Agent 及命令行 CLI）无缝桥接到**飞书**与 **Web 仪表盘**中。

你不需要随时守在终端前盯代码生成——无论是在工位、会议室还是通勤途中，只需在飞书私聊发送工程目标，或在群聊中 `@机器人`，Agent 就会在本机的独立沙箱中开始作业。

```text
┌───────────────── 交互界面 (Interfaces) ─────────────────┐
│  📱 飞书移动端 / 桌面端 (Lark/Feishu)    🌐 Web 深度工作台  │
│  · 目标下达 / 实时进度卡片              · 任务概览与多维度筛选 │
│  · 一键审批 / 追问交互                  · 实时增量日志 & 终端 │
│  · 长期记忆 / 群聊定时交办              · Git Worktree 隔离管 │
└────────────────────────────┬────────────────────────────┘
                             │ (WebSocket / SSE / Card 2.0)
┌────────────────────────────▼────────────────────────────┐
│              Dutydeck 本地守护进程 (Local Daemon)        │
│  · 任务排队、中断、恢复与调度        · 敏感操作权限门禁 (ask) │
│  · 跨会话长期记忆提取与整理          · 自动化命令验证与证据留存│
│  · SQLite 事务持久化 (零状态丢失)    · GitHub Actions 自动续作 │
└────────────────────────────┬────────────────────────────┘
                             │ (ACP Protocol / PTY Adapter)
┌────────────────────────────▼────────────────────────────┐
│              本机 Agent 运行时 (Local Engines)           │
│  · Claude Code (原生 / CPA 网关)    · ACP Agents (acpx)  │
│  · 自定义 CLI 适配器                · 独立 Git Worktree   │
└─────────────────────────────────────────────────────────┘
```

### 为什么选择 Dutydeck？

| 痛点场景 | 传统终端 CLI 使用方式 | Dutydeck 体验 |
|---|---|---|
| **随地交办** | 必须打开电脑终端，人离席任务即断 | 手机飞书直接发需求，异步作业，结果自动卡片推送 |
| **高危操作控制** | 要么全局跳过风险不可控，要么中断卡住 | 飞书卡片一键点击「批准/拒绝」，精准管控每个危险指令 |
| **多任务与代码冲突** | 在当前分支直接改写，容易污染未提交代码 | 默认自动创建独立的 Git Worktree 沙箱，零污染安全作业 |
| **质量验证** | Agent 声称“单测已通过”，难以佐证真实性 | 服务端真实验证命令，记录退出码、执行时长与代码指纹 |
| **团队协同与记忆** | 每次开启新会话都要反复灌输项目规范 | 跨会话长期记忆自动沉淀，群聊按需参与，定时总结汇报 |

---

## ✨ 核心特性

- 🤖 **飞书全功能指挥台**：私聊/群聊下达任务、持久化进度流、敏感操作交互式卡片审批、追问直答，超长产物自动打包为 Markdown 附件交付。
- 🛡️ **安全权限姿态（Permission Posture）**：默认 `ask`（高危操作实时审批）；支持 `approve-reads`、`deny-all`，仅在完全受信任的无人值守工作区使用 `full-trust`。
- 🌿 **Git Worktree 沙箱隔离**：基于当前提交自动派生独立分支与工作目录，保障宿主未提交改动安全；归档时支持严格的安全清理检测。
- 🧪 **真实验证与工程证据**：支持关联自动化验证命令（测试、构建、Lint），服务端真实执行并持久化退出码与执行输出，拒绝“虚假通过”。
- 🧠 **跨会话长期记忆**：每个聊天独立维系长期记忆。支持 `/remember` 人工沉淀，后台每 3 轮自动提取关键事实并定期整理去重。
- 👥 **群聊协作与自然语言委托**：支持观察（`observe`）与按需参与（`selective`）；支持自然语言设定持续委托（如“每天18点总结进展”）。
- 🔌 **通用 Agent 协议生态**：深度集成 `acpx@0.13.0` 标准 ACP 协议，提供 PTY 适配器驱动 Claude Code 及自定义命令行脚本。
- 🎛️ **极简运维与自愈诊断**：提供 `dutydeck setup`（引导安装）、`dutydeck doctor`（带修复建议的环境诊断）和 `dutydeck autostart`（开机自启）。

---

## ⚡ 快速上手 <a id="quick-start"></a>

### 1. 环境准备

- **Node.js**：`>= 22.12.0`
- **包管理器**：`pnpm >= 11`
- **Agent CLI**：本机已安装并登录 Claude Code 或其它 ACP 兼容的 CLI。

### 2. 安装与配置

推荐全局安装 CLI 并使用交互式向导完成配置：

```bash
# 全局安装 Dutydeck
pnpm add -g @byted/dutydeck --registry=http://bnpm.byted.org

# 运行交互式配置向导（自动探测 Agent、设定默认工作区、可选接入飞书）
dutydeck setup
```

> **向导特性**：`dutydeck setup` 具备幂等性，检测到既有配置时会询问保留或更新，中途退出不会残留半份配置。脚本与 CI 中可通过参数非交互运行：
> ```bash
> dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes
> ```

### 3. 启动服务

```bash
# 启动后台守护进程
dutydeck start

# 查看运行状态
dutydeck status

# 运行健康检查（遇错会给出明确的补救命令）
dutydeck doctor
```

启动完成后，打开浏览器访问控制台：
- **Web 控制台**：`http://127.0.0.1:4310`（本机访问默认免密）

---

### 💡 源码开发模式

如果你希望基于源码进行二次开发或调试：

```bash
# 1. 克隆代码并安装依赖
git clone https://github.com/bytedance/dutydeck.git
cd dutydeck
pnpm install

# 2. 准备环境变量文件（可直接跑 dutydeck setup 或复制模版）
cp .env.example .env

# 3. 启动开发模式（前后端热重载）
pnpm dev
```

在开发模式下：
- **Web 前端**：`http://127.0.0.1:4311`
- **后端 API**：`http://127.0.0.1:4310`（Vite 会自动将请求反向代理到该端口）

---

## 🤖 飞书指挥台使用指南 <a id="lark-guide"></a>

飞书机器人是 Dutydeck 最核心的使用入口。绑定机器人后，你即可在飞书中以对话形式驱动完整的研发流程。

### 1. 发起与交互流程

```text
[在飞书发消息] ──────► [收到确认表情: 👌] ──────► [推送动态进度卡片]
                                                    │
┌────────────────── Agent 遇到高危操作或提问 ◄───────┘
▼
[卡片弹出审批按钮: 批准 / 拒绝] 或 [收到问题卡片: 点击回复]
│
▼
[任务执行结束] ──────► [原进度卡冻结] ──────► [发送独立结果卡 (长文带附件)]
```

- **发起任务**：在私聊中直接发送需求；在群聊中按协作策略触发（默认 `@机器人` 并附带任务内容）。
- **追加与调整**：上一轮完成后，直接回复结果卡片或在私聊中发消息，Agent 会在相同上下文中继续推进。
- **在线审批**：遇到高危操作（如写文件、执行 Shell），卡片提供「批准一次」和「拒绝」按钮，点击即时下达指示。
- **解答追问**：Agent 遇到不明确需求主动提问时，直接回复问题卡片或使用 `/answer <编号> <内容>`。

### 2. 常用飞书命令速查

| 指令 | 示例 | 作用说明 |
|---|---|---|
| `/help` | `/help` | 查看当前群或私聊中可用的指令帮助 |
| `/new` | `/new -- 修复登录接口超时的 bug` | 结束上一段上下文，并在当前工作区开启新任务 |
| `/new (高级)` | `/new --cwd "/data/app" --workspace worktree -- 优化性能` | 指定工作目录，并开启独立 Git Worktree 沙箱 |
| `/tasks` | `/tasks 1` | 查看当前会话发起的任务列表（进行中、待审批、已完成） |
| `/approve` | `/approve <卡片编号>` | 批准敏感工具调用（等同于点击卡片上的批准按钮） |
| `/reject` | `/reject <卡片编号>` | 拒绝敏感工具调用 |
| `/answer` | `/answer <卡片编号> 使用方案A` | 回复 Agent 提出的需求澄清或确认项 |
| `/cancel` | `/cancel` | 中断当前正在执行的任务 |
| `/retry` | `/retry` | 重新执行上一轮失败或中断的任务 |
| `/remember` | `/remember 测试命令必须使用 pnpm test` | 为当前聊天保存一条跨会话长期记忆 |
| `/memory` | `/memory 1` | 分页查看本聊天的长期记忆条目 |
| `/forget` | `/forget <记忆ID>` | 标记删除指定记忆条目 |
| `/ci` | `/ci wait build.yml`、`/ci fix` | 等待 GitHub Actions 或 Codebase 流水线结果并自动续作；Codebase 失败可按规则交给 Agent 修复 |

> **`/new` 选项语法规则**：使用参数时，必须在需求文本前加上 `--` 隔开，例如：  
> `/new --cwd "/path/to/repo" --model "gemini-3.8-flash-high" --effort "high" --workspace worktree -- 需求内容`

---

### 3. 会话长期记忆

Dutydeck 为每个聊天（私聊或群聊独立隔离）维护一份持久化记忆库，重启或 `/new` 不会丢失。

1. **常驻注入**：每轮任务开头，系统会将精简后的记忆索引（`MEMORY.md`，≤ 3000 字）注入 Agent 上下文。
2. **主动存取**：用户可用 `/remember <内容>` 显式写入；Agent 在执行中需要更深细节时可通过工具调用 `memory show` 或 `memory search` 按需拉取。
3. **自动化提取与整理**：
   - 每完成 **3 轮**任务，系统会在独立后台只读运行一次轻量 Agent，自动提取跨任务依然有效的偏好、约定与环境事实；
   - 每累计 **8 轮**任务（或索引接近满额），自动触发一轮归拢整理，合并同类项并淘汰过期知识。
   - 提取过程配备确定性规则门禁，确保绝不泄露凭据、绝不改写用户原文。可在聊天中发送 `/memory consolidate` 手动触发。

---

### 4. 群聊按需参与与持续委托

在团队群中，你可以将机器人配置为智能研发搭子：

- **Bot 默认模式**：在机器人设置中选择「默认群参与模式」，未单独配置的现有群和新加入的群都会继承，保存后生效。群内可显式关闭或改回「跟随机器人默认」；已有群的独立配置会保留。观察需要群聊读取权限，Tag 回复还需要主动发送权限。
- **团队上下文**：同一个 Bot 可以结合它已加入且允许读取的其他群回答，例如在测试群询问「看看个人待办群」。按群名和问题检索已读记录、近期消息、跟进事项与群记忆，回答保留来源；部分读取或检索截断会标明范围。跨群读取不会自动开启来源群的主动参与。
- **三种参与模式**：
  - `off`：仅在被明确 `@机器人` 时响应交办，不主动插话。
  - `observe`：默默观察群聊上下文与讨论，积累背景知识，但绝不主动发言。
  - `selective`：按需参与。未 @ 时默认安静；仅在明确叫机器人帮忙、可靠续问，或有充分证据的紧迫风险需要立即提醒时回复；这类求助需要读链接、调用工具或修改委托时，按一次 @ 交给执行 Agent。群友问答、泛问、进度和致谢不插话；不确定时不回复、不贴确认表情。
- **少 @ 一次**：开启观察或按需参与后，回复你自己 @ 机器人的请求或机器人给你的回复不用再 @，在机器人已接手、由你发起的话题里继续说也不用再 @；别人的消息、@ 了其他人或回复其他人消息的，仍按上面的规则判断。在群里发完请求忘了 @，10 分钟内单独补一个 @，机器人直接处理你刚才那条消息，不再要求确认。`/status` 会显示当前群的参与模式。
- **处理状态与并发**：决定回复后在源消息加 `OK` 表情，生成并发送回复后移除；无需回复时保持静默。不同群独立处理，同群按顺序处理，尚未接下的连发消息会合并判断。
- **分层协作执行方式**：在机器人设置的「执行方式」选择「分层协作」并指定 Leader 与 Worker 后，被 @ 的默认 Agent 当 PMO 负责接待和答复，改代码、跑测试这类任务写成简报交给 Leader；Leader 只读拆解并指派 Worker，最后由 Leader 验收，结果回到原话题。只在群聊生效，计划要点「开始执行」才派发。详见 [Tag 分层协作](docs/tag-layered-execution.md)。
- **Agent 单次交接与回传（handoff / reply-agent）**：群聊中支持机器人之间的轻量任务交接与单次回传工具，严格绑定同话题与当前轮次 turn 凭证。交接在原话题 @ 目标并附带目标与边界；处理完成后通过 reply-agent 回传实质结果并 @ 发起方。Agent 应仅在交接任务和回传实质结果时 @ 对方；礼貌确认不应再次 @，以免循环唤醒。多步分工或多轮返修走 `/work` 编排。
- **自然语言定时与持续委托**：
  - `@机器人 记录一个待办：明天下午 17:00 前提交发布单。`
  - `@机器人 每天工作日 18:00 总结本群今天的研发进展发到群里，直到我取消。`
  - `@机器人 跟进刚才的构建状态，每两小时检查一次，若失败则提醒我。`

---

### 5. 接入飞书机器人

#### 途径 A：Web 界面一键自动创建（最推荐）
1. 访问 Web 控制台（`http://127.0.0.1:4310`），在首屏点击 **「新增机器人」**。
2. 输入机器人名称，点击 **「创建机器人」**。
3. 界面会复用本机已登录的飞书开发者凭据（或展示扫码登录）。系统通过飞书开放平台一键模版自动创建应用、配置所需事件与权限、发布版本并保存密钥至本地。
4. 选定工作目录与执行 Agent 后即可一键接通。

#### 途径 B：CLI 命令行快速接入
```bash
# 创建并接入新机器人
dutydeck lark create "研发助手" --agent ccflash --listen

# 绑定已有自建应用（自动补齐权限与长连接配置）
dutydeck setup --lark-app-id cli_xxxxxxxx
```

---

## 🖥️ Web 工作台与工程闭环 <a id="web-console"></a>

Web 工作台为你提供全维度的任务视察、代码沙箱管理与自动化流转。

### 1. 任务看板与状态流转
- 状态按 **「待你处理」**（等审批/等回答）、**「进行中」**、**「已完成」** 和 **「已归档」** 清晰分层展示。
- 任务卡片突出核心步骤、工具调用折叠、最终回答与耗时指标；右侧面板可按需展开原始终端全量输出（Xterm 真实回放）。
- 当 Agent 忙碌时，新提交的指令支持排队缓冲，也支持**「立即介入（Interrupt & Preempt）」**。

### 2. Git Worktree 独立沙箱
在 Web 创建任务或通过飞书指定 `--workspace worktree` 时，系统会从源仓库当前 Commit 派生一个独立的临时 Git 工作树：
- **互不干扰**：主目录写代码、跑本地服务不受任何影响，避免分支切换污染。
- **安全清理门禁**：归档后清理工作区时，Dutydeck 会执行极其严苛的自动化检查：
  - 确认无未提交代码（含未跟踪与忽略文件）；
  - 确认无未合并到主分支的新增 Commit；
  - 确认无子模块冲突且无运行中的进程占用。
  - 确认通过后安全释放目录，保留 Git 分支与全部操作历史。

### 3. 真实验证命令（Verification Gate）
飞书机器人配置了验证命令（例如 `pnpm test` 或 `go test ./...`）后，一轮任务跑完、且这一轮改了代码时（worktree 看相对派生它的 Commit 有没有改动，共享目录看本轮开始和结束时的代码指纹是否变化），系统自动执行这条命令；结果卡上也可以点「运行验证」手动执行：
- **真实环境**：在对应的任务工作目录下真实执行，限制最长超时（默认 5 分钟）与输出大小（128 KiB）。
- **留存铁证**：记录退出码、执行时间、输出摘要与代码指纹。结果卡标题栏只写「运行完成」，验证状态单独一行：验证通过 / 验证未通过 / 未验证；验证之后代码又被修改的，旧证据自动失效，标「验证已过期」。自动验证执行中服务重启的，重启后卡片改标「验证被中断」，可点「运行验证」重跑。
- **自动返修**：命令失败时，把截断后的失败输出作为一轮返修发回 Agent，同一条请求最多返修 2 轮，仍失败则标「验证未通过」。命令不存在、启动失败、超时等验证工具本身的问题同样算未通过，但不发回返修。
- **候选命令**：还没配验证命令的机器人，工作区第一次有任务跑完时，系统按基准分支（worktree 派生它的 Commit，共享目录是仓库默认分支）上的 `package.json`（test / typecheck 脚本）、`Makefile`（test 目标）或 `go.mod` 推断一个候选命令，在结果卡上点「使用这个验证命令」即可保存到机器人配置。

### 4. GitHub Actions 自动续作
当代码推送到远端仓库后，无需肉眼盯 CI：
- 页面或飞书执行 `/ci wait [workflow]`。
- Dutydeck 后台每分钟轮询 GitHub API（需配置 `DUTYDECK_GITHUB_TOKEN`）。
- 一旦指定或所有 Workflow 构建结束，Dutydeck 会自动唤醒 Agent，在当前上下文中追加指令进行修复或下发结果通知。

### 5. Codebase 流水线续作与修复
配置 `DUTYDECK_CODEBASE_WEBHOOK_SECRET` 并重启后，Dutydeck 在 `POST /api/hooks/codebase` 接收 Codebase MR 与流水线事件。该路径不走 Web 登录，由路由自己校验：
- 令牌：请求头 `X-Dutydeck-Token`、`Authorization: Bearer <密钥>`，或 URL 参数 `?token=<密钥>`（只能填 URL 的平台用；请求日志只记路径）。
- 签名：`X-Dutydeck-Signature: sha256=<hex>`，为 HMAC-SHA256(密钥, `<X-Dutydeck-Timestamp>.<原始请求体>`)。
- 时间戳：`X-Dutydeck-Timestamp`（Unix 秒）或载荷里的事件时间，与本机时间相差超过 5 分钟即拒绝。签名模式必须带 `X-Dutydeck-Timestamp`；令牌模式可以不带，此时只靠去重防重放。
- 去重：`X-Dutydeck-Event-Id` 或载荷的 `id` / `event_id`，缺省时按请求体哈希；24 小时内的重复投递只确认、不处理，过期记录会被删除。

在 origin 为 `code.byted.org` 的会话里执行 `/ci wait`：失败时发送失败卡，点「交给 Agent 修」开始修复；执行 `/ci fix`：失败时直接交给 Agent 修复。流水线通过时投递续作任务，MR 合入或关闭后停止等待。修复规则：最多 3 轮；同一错误指纹出现 2 次即停；每轮最多改 10 个文件、300 行；动手前和推送前各核对一次 head SHA；CI 日志作为不可信输入包在标记里交给 Agent；不合入、不 approve、不 force push。任务以部署者身份执行，事件里的操作人只做记录。

载荷支持 DutyDeck 信封 `{ id, type: "codebase.pipeline" | "codebase.merge_request", timestamp, repository, branch, mr, sha, status 或 action, pipeline: { id, url }, operator, failures: [{ job, stage, reason, log }] }`，也按 GitLab 风格解析 `object_kind: pipeline | merge_request`。

---

## ⚙️ Agent 配置与扩展 <a id="agent-config"></a>

Dutydeck 既支持标准的 ACP (Agent Client Protocol) 协议，也支持通过 PTY 模拟终端直接驱动市面上已有的命令行 Agent。

### 1. 自定义 Agent 配置 (`DUTYDECK_AGENTS_JSON`)

可以通过环境变量 `DUTYDECK_AGENTS_JSON` 注入自定义 Agent 列表。

#### 示例：接入 Claude Code (经由公司内部 CPA / 自定义网关)
如果你的团队内部搭建了 Claude Code 代理网关（例如 Claude Proxy API），可以通过以下配置直接接入：

```json
[
  {
    "id": "ccflash",
    "name": "CCFlash (Claude Code)",
    "protocol": "pty-cli",
    "adapterId": "claude-code",
    "command": "claude",
    "args": ["--settings", "/home/username/.claude/ccflash.settings.json"],
    "model": "gemini-3.8-flash-high",
    "permissionMode": "ask"
  }
]
```

配套的 `ccflash.settings.json` 示例：
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8320",
    "ANTHROPIC_AUTH_TOKEN": "your-proxy-token",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3.8-flash-high",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3.8-flash-high",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.8-flash-high"
  }
}
```

> **最佳实践提示**：
> - 建议通过 `--settings` 参数独立指定配置文件，而**不要**动态改写全局 `~/.claude/settings.json`，防止多任务并发时配置互相踩踏。
> - `command` 字段必须是可执行文件绝对路径或在系统 `PATH` 中的二进制名，不可使用 Shell alias。

#### 示例：接入自定义 ACP Agent
```json
[
  {
    "id": "custom-acp",
    "name": "My Custom ACP",
    "protocol": "acp",
    "command": "/usr/local/bin/my-agent-acp",
    "args": ["serve"],
    "permissionMode": "ask"
  }
]
```

---

### 2. 权限姿态对比 (Permission Posture)

| 权限模式 | 行为表现 | 适用场景 |
|---|---|---|
| `ask` (默认) | 遇到写文件、Shell 执行等操作时，挂起任务并在飞书与 Web 推送实时审批 | 默认推荐，兼顾灵活性与绝对安全 |
| `approve-reads` | 自动允许所有只读请求（如读文件、查看目录），写操作与执行命令仍需批准 | 适合主要做代码分析、排查 Bug 的场景 |
| `deny-all` | 自动拒绝任何需要特权的操作 | 纯只读探索，杜绝一切变更 |
| `full-trust` | 自动跳过全部权限确认（相当于 YOLO / 纯无人值守模式） | **仅限**你完全信任、隔离良好的自动化构建沙箱 |

---

### 3. 核心环境变量一览

| 环境变量 | 默认值 | 作用说明 |
|---|---|---|
| `DUTYDECK_HOST` | `127.0.0.1` | 监听地址；若需局域网访问设为 `0.0.0.0` |
| `DUTYDECK_PORT` | `4310` | 守护进程监听端口 |
| `DUTYDECK_LOCAL_ONLY` | `false` | 设为 `true` 时强制锁定仅本机可连 |
| `DUTYDECK_AUTH` | `true` | 是否启用 Access Token 鉴权（仅填小写 `false` 关闭） |
| `DUTYDECK_DEFAULT_CWD` | 当前启动路径 | 默认的工作区绝对路径 |
| `DUTYDECK_DATABASE_URL` | `<cwd>/.dutydeck/dutydeck.db` | 本地 SQLite 存储路径 |
| `DUTYDECK_AGENTS_JSON` | `[]` | 自定义 Agent 扩展配置列表 |
| `DUTYDECK_GITHUB_TOKEN` | - | 用于 GitHub Actions 状态轮询的个人访问令牌 |
| `DUTYDECK_CODEBASE_WEBHOOK_SECRET` | - | Codebase webhook（`/api/hooks/codebase`）的令牌与签名密钥；未设置时不开放该入口 |
| `LARK_APP_ID` | - | 飞书应用 App ID |
| `LARK_APP_SECRET` | - | 飞书应用 App Secret（持久化存储在服务端） |

---

## 🛡️ 远程访问与安全性

1. **默认零暴露**：Dutydeck 默认仅监听 `127.0.0.1`，不向外网暴露任何端口。
2. **局域网与远程访问**：
   - 使用 `dutydeck start --host 0.0.0.0` 开放外网或局域网访问。
   - 远程访问默认强制开启 **Token 认证**。首次启动时终端会打印安全 Token，后续可通过以下命令查询或轮换：
     ```bash
     dutydeck auth token          # 查看当前 Token
     dutydeck auth token --rotate # 轮换并注销旧会话
     ```
   - 登录凭证仅通过严格的 `HttpOnly; SameSite=Strict` Cookie 存储在浏览器中，杜绝 XSS 泄露。
3. **免密模式警告 (`--no-auth`)**：
   - 仅在已具备前置身份网关（如 SSO / 反向代理认证）的可信内部网络下，才可使用 `--no-auth`。
   - **切勿**将 `--no-auth` 的服务直接映射到公网，否则任何人均可借由 Agent 获得宿主机 Shell 权限！

---

## 🛠️ 运维与 CLI 速查 <a id="cli-reference"></a>

### 1. 守护进程管理

`dutydeck` 默认作为系统后台守护进程常驻运行：

```bash
# 启动守护进程
dutydeck start [--cwd /path] [--port 4310] [--host 0.0.0.0]

# 查看状态（包含 PID、监听地址、日志路径）
dutydeck status

# 重启守护进程：先排空（新消息照常排队、暂不开始执行），等正在执行的任务结束再重启
dutydeck restart
# 重启某个 systemd unit 托管的运行时（如 bot 运行时）
dutydeck restart --unit dutydeck-tag-ccflash.service

# 把已构建的检出目录发布为不可变版本：排空 → 切换 releases/current → 重启 → 健康检查，不通过自动切回上一版。
# unit 须运行 releases/current/dist/cli.js，可用 --print-unit 生成；设置 DUTYDECK_DEPLOY_WINDOW（如 10:00-11:00,16:00-17:00）可限制部署时段
# 成功后只留最新 5 个发布目录和 deploy 自己写的部署记录（含数据库备份），current、上一版和仍被运行中进程引用的不删
dutydeck deploy --source /path/to/checkout

# 停止守护进程
dutydeck stop

# 更新全局包并自动平滑重启服务
dutydeck update
```

### 2. 健康检查与环境排障 (`doctor`)

遇到服务异常、无法连接或配置疑惑时，第一步运行：

```bash
dutydeck doctor
```

`doctor` 会全面检测：Node 版本、守护进程存活、端口占用、SQLite 读写、工作区权限、已注册 Agent 可执行性、飞书长连接监听状态等。**每一项失败都会附带一行可直接复制执行的修复命令。**

### 3. 开机自启动管理 (`autostart`)

无需手动编写 plist 或 service 文件：

```bash
dutydeck autostart enable   # 注册开机自启（macOS launchd / Linux systemd --user）
dutydeck autostart status   # 查看自启配置状态
dutydeck autostart disable  # 移除开机自启
```

---

## ❓ 常见问题与排障 (FAQ) <a id="faq"></a>

### Q1: 飞书发消息后，机器人没有加 `👌` 表情，也没有任何反应？
- **排查步骤**：
  1. 运行 `dutydeck doctor` 检查飞书长连接（Lark Listen）是否正常。
  2. 确认在飞书开发者后台该应用已开启 **「机器人」** 能力，并启用了长连接模式接收事件（`im.message.receive_v1`）。
  3. 检查机器人是否已经加入对应的私聊或群聊；在群聊中确认是否已 `@机器人`。

### Q2: 提示 `Persisted key policy violation` 错误？
- **原因**：内部 ACPX 持久化键名要求全小写 `snake_case`。
- **解决**：不要把大写的环境变量名直接写入 ACPX session 配置；Agent Dock 群聊工具的运行时变量使用 `dutydeck_group_tools_url` 和 `dutydeck_group_tools_token`。

### Q3: 提示 `Agent command not found` 或找不到可执行文件？
- **原因**：守护进程运行在独立的进程环境中，不会加载交互式 Shell 的 `~/.bashrc` 或 `~/.zshrc` 中的 `alias`。
- **解决**：在 `DUTYDECK_AGENTS_JSON` 中，`command` 请填写可执行文件的绝对物理路径（例如 `/home/user/.nvm/versions/node/v22.x/bin/claude`），不要使用别名。

### Q4: 如何在多机器、多群组间共享 Dutydeck？
- 可以在 Web 控制台中绑定多个飞书机器人；每个机器人可以绑定独立的默认工作区和 Agent，甚至指派给不同的业务研发群组，互不冲突。

---

## 📚 进阶架构与开发文档

- [端到端测试与验收矩阵规范](tests/e2e/README.md)
- [通用群协作设计与实现](docs/generic-collaboration-implementation.md)
- [Tag 分层协作：PMO + Leader + Worker](docs/tag-layered-execution.md)
- [群协作扩展技术规范](docs/collaboration-extensions.md)
- [飞书会话长期记忆架构设计](docs/lark-memory-design.md)
- [旧版数据迁移 CLI 使用指南](docs/legacy-import-cli.md)
- [完整产品对齐规划文档](docs/full-product-parity-plan.md)

---

## 📄 许可证与第三方声明 (License)

Dutydeck 核心代码采用开源授权协议。部分协议桥接与终端实现演进自早期内部工程原型，完整第三方依赖与开源许可证声明请参阅 [Third-Party Notices](THIRD_PARTY_NOTICES.md)。
