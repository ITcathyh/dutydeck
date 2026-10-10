# Dutydeck

<p align="center">
  <strong>本地优先的 AI Agent 研发工作台与飞书指挥台</strong><br>
  <em>把跑在你开发机上的 Claude Code / Codex / CLI 编码智能体，变成随时待命、团队协同的飞书研发队友与 Web 工作台</em>
</p>

<p align="center">
  <a href="#why-dutydeck">💡 为什么选 Dutydeck</a> •
  <a href="#key-highlights">✨ 核心亮点</a> •
  <a href="#quick-start">⚡ 快速上手</a> •
  <a href="#lark-guide">🤖 飞书指挥台</a> •
  <a href="#web-console">🖥️ Web 工作台</a> •
  <a href="#agent-config">⚙️ Agent 配置</a> •
  <a href="#cli-reference">🛠️ CLI 速查</a> •
  <a href="#faq">❓ FAQ</a>
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="./README.en.md">English</a>
</p>

---

## 📖 项目简介

**Dutydeck** 是一个专为开发者和工程团队打造的本地优先（Local-First）AI Agent 研发工作台。

它通过守护进程，将你本地开发机或远程服务器上运行的编码智能体（如 Claude Code、Codex、各类标准 ACP Agent 及命令行 CLI），无缝接入**飞书（Lark）**与 **Web 仪表盘**。

你不再需要全程坐在电脑前紧盯终端输出。无论是在工位写业务代码、在会议室开会，还是在下班通勤路上，只要在飞书发一条消息，Agent 就会在本地的独立沙箱中安全作业，自动跑测试验证，并将长文成果与验证证据直接推送到你的手机上。

```text
┌──────────────────────── 交互界面 (Interfaces) ────────────────────────┐
│  📱 飞书移动端 / 桌面端 (Lark/Feishu)         🌐 Web 深度工作台       │
│  · 随时随地派活，任务卡片流式刷新             · 任务全局看板与状态流转│
│  · 遇到危险操作手机一键审批                   · 真实终端 Xterm 全量回放│
│  · 跨会话长期记忆与自然语言定时委托           · Git Worktree 沙箱管控 │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ (WebSocket / SSE / Card 2.0)
┌───────────────────────────────────▼───────────────────────────────────┐
│                     Dutydeck 本地守护进程 (Local Daemon)               │
│  · 任务排队、抢占与中断调度                   · 敏感操作权限门禁 (ask) │
│  · 自动化真机验证门禁 (Verification Gate)     · 长期记忆自动提取与整理 │
│  · SQLite 事务持久化 (零状态丢失)             · CI / Codebase 流水线续作│
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ (ACP Protocol / PTY Adapter)
┌───────────────────────────────────▼───────────────────────────────────┐
│                     本机 Agent 运行时 (Local Engines)                  │
│  · Claude Code (原生 / CPA 代理网关)          · 标准 ACP Agents (acpx) │
│  · 自定义 CLI 脚本与适配器                    · 独立 Git Worktree 目录 │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 💡 为什么选择 Dutydeck？（核心价值与场景） <a id="why-dutydeck"></a>

很多开发者习惯直接在终端跑 `claude` 或其他 CLI 编程助手，但日常工程落地中往往会遇到以下阻碍：

| 痛点场景 | 传统终端 CLI 使用方式 | Dutydeck 体验 |
|---|---|---|
| **移动交办与异步等待** | 必须守在电脑屏幕前；离席或断开 SSH，任务立即中断 | 手机飞书发一句话直接派活，后台持续执行，结果以富文本卡片自动回传 |
| **高危操作管控** | 要么全局开启 YOLO 跳过确认（风险不可控），要么频繁弹窗卡死执行 | 飞书卡片弹出「批准/拒绝」按钮，在手机上一键点击放行，兼顾效率与安全 |
| **代码冲突与脏工作区** | 直接改写当前分支，容易污染未暂存的本地改动 | 自动从当前提交派生独立的 **Git Worktree 沙箱**，完全不干扰主工作区 |
| **代码交付质量验证** | Agent 声称“单测已全部通过”，往往存在假通过或漏跑 | **服务端真机执行测试命令**，留存退出码、耗时与代码指纹，失败自动打回返修 |
| **团队协同与项目记忆** | 每次开启新会话都要重新输入规范；无法在团队群协助排障 | **跨会话持久记忆**自动沉淀；进群支持观察与按需回复，甚至用自然语言交办定时任务 |
| **流水线无人值守** | Git 推送后需要手动盯着 CI 结果，挂了再拉起 Agent 修 | 监听 GitHub Actions 与 Codebase Webhook，流水线失败**自动唤醒 Agent 自愈修复** |

---

## ✨ 六大核心亮点 <a id="key-highlights"></a>

### 1. 📱 飞书全功能指挥台：移动端无缝协同
- **动态流式卡片**：在私聊或群聊中下达指令，任务状态、当前阶段、执行耗时实时更新。
- **手机一键审批**：遇到写文件、删目录或高危 Shell 调用时，卡片即时弹出审批选项，点一次即可放行。
- **长文本产物自动打包**：超长代码或详尽分析文档自动打包为 Markdown 附件交付，阅读不折叠。
- **ADHD 友好输出模式**：首行直给结论与行动项，清单严格按组拆分，不讲废话客套话。

### 2. 🌿 Git Worktree 物理级沙箱：零污染工作区
- **主目录绝对安全**：你正在本地写着大需求，突然需要修复线上紧急 Bug？无需 `git stash` 或切分支，Dutydeck 自动从当前 HEAD 派生独立 Git Worktree 沙箱进行修改。
- **严苛的安全清理门禁**：任务归档时，自动检查是否存在未提交改动、未合并的分支 Commit 及占用进程，确认无安全风险后才允许释放目录。

### 3. 🧪 铁证级真机验证门禁（Verification Gate）
- **告别模型幻觉**：Agent 说“测试已跑通”不可轻信。Dutydeck 会在宿主机工作区实际运行测试命令（如 `pnpm test` 或 `go test ./...`）。
- **完整证据留存**：记录命令退出码、耗时、标准输出与代码哈希指纹。
- **自动返修闭环**：验证不通过时，自动抓取失败日志作为上下文打回 Agent 发起针对性返修（最多 2 轮），省去人工介入。

### 4. 🧠 跨会话长期记忆系统
- **记忆不丢失**：每个私聊或群聊独立维护持久化记忆库，重启或开启新会话（`/new`）不丢失。
- **主动记录与自动提取**：支持人工发送 `/remember` 固化团队规范；后台每 3 轮轻量提取环境事实与偏好，每 8 轮自动合并去重。
- **按需注入上下文**：任务开启时注入精简记忆索引，执行中 Agent 可通过命令检索完整细节。

### 5. 👥 团队群聊智能搭子与持续委托
- **按需参与（Selective）**：不会在群内刷屏打扰，仅在明确求助、紧迫风险或特定上下文时发言。
- **少 @ 一次交互**：在你发起的话题内继续追问无需重复 `@机器人`，10 分钟内补 `@` 自动认领刚才发出的需求。
- **自然语言定时委托**：在群聊直接交办“每天 18:00 总结本群今日进展”，守护进程精准定时执行并汇报。
- **分层协作模式**：支持配置 PMO 接收需求、Leader 拆解方案、Worker 具体落地并自动回传验收。

### 6. 🔄 CI / Codebase 流水线自愈闭环
- **GitHub Actions 轮询**：发送 `/ci wait`，后台自动跟进构建状态，失败即时唤醒 Agent。
- **Codebase Webhook 监听**：原生支持企业内 Codebase / GitLab MR 与流水线事件（具备 HMAC-SHA256 签名与防重放机制），流水线挂掉后自动执行受限代码自愈修复。

---

## ⚡ 3 分钟快速上手 <a id="quick-start"></a>

### 1. 环境准备

- **Node.js**：`>= 22.12.0`
- **包管理器**：`pnpm >= 11`
- **已安装的 Agent CLI**：本机已安装 Claude Code（`claude`）或其他支持 ACP / CLI 的智能体。

### 2. 全局安装与配置

推荐使用全局 CLI 配合交互式向导，向导会自动探测本机可用的 Agent、设置默认工作目录并引导配置飞书机器人：

```bash
# 全局安装 Dutydeck
pnpm add -g @byted/dutydeck --registry=http://bnpm.byted.org

# 运行交互式配置向导（支持幂等重入）
dutydeck setup
```

> **自动化部署提示**：CI 或无人值守脚本中可通过参数直接跳过交互：  
> `dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes`

### 3. 启动守护进程与状态检查

```bash
# 启动后台守护进程
dutydeck start

# 运行健康诊断（若有问题会输出一键复制执行的修复命令）
dutydeck doctor

# 查看守护进程运行状态
dutydeck status
```

启动成功后，浏览器访问控制台：
- **Web 控制台**：`http://127.0.0.1:4310`（本机访问默认免密）

---

### 💡 源码二次开发与调试模式

如果你希望参与 Dutydeck 本身的代码开发或进行深度定制：

```bash
# 1. 克隆代码仓库并安装依赖
git clone https://github.com/bytedance/dutydeck.git
cd dutydeck
pnpm install

# 2. 配置环境变量
cp .env.example .env

# 3. 启动前后端热重载开发模式
pnpm dev
```

本地开发地址：
- **Web 前端**：`http://127.0.0.1:4311`
- **后端 API**：`http://127.0.0.1:4310`（前端请求自动反向代理到此端口）

---

## 🤖 飞书指挥台实战指南 <a id="lark-guide"></a>

飞书机器人是 Dutydeck 最常用的交互入口。

### 1. 经典任务交互流程

```text
[在飞书发送需求] ──────► [机器人贴反馈表情: 👌] ──────► [推送动态进度卡片]
                                                             │
┌────────────────── Agent 遇到写操作或疑问确认 ◄──────────────┘
▼
[卡片弹出审批按钮: 批准 / 拒绝] 或 [收到提问卡片: 回复答复]
│
▼
[任务执行完毕] ──────► [自动运行本地测试验证] ──────► [推送最终结果卡片与附件]
```

1. **下达任务**：私聊直接说需求；群聊 `@机器人 任务描述`。
2. **跟进反馈**：机器人接单后自动在原消息添加 `👌` 表情，并发送流式进度卡片。
3. **在线审批**：遇到高危特权操作，卡片呈现「批准一次」与「拒绝」，在手机上直接点击操作。
4. **澄清答复**：Agent 遇到模糊需求发来问题卡片时，直接回复卡片或使用 `/answer <编号> <内容>`。
5. **交付验收**：执行完毕后推送结果卡片，包含代码改动、验证命令输出（通过/未通过/未验证）以及超长 Markdown 产物。

---

### 2. 常用飞书命令速查表

| 指令 | 示例 | 作用说明 |
|---|---|---|
| `/help` | `/help` | 查看当前会话中可用的帮助与命令列表 |
| `/new` | `/new -- 优化登录接口的查询耗时` | 开启全新会话，隔离前序上下文 |
| `/new (指定沙箱)` | `/new --cwd "/data/app" --workspace worktree -- 重构模块` | 指定工作路径，并在独立的 Git Worktree 沙箱中作业 |
| `/new --handoff` | `/new --handoff 补齐重试逻辑单测` | 开启新会话并自动带上前一会话的改动快照与上下文交接 |
| `/tasks` | `/tasks` | 分页查看当前会话发起的任务列表与当前状态 |
| `/approve` | `/approve <卡片编号>` | 批准敏感工具调用（等同于点击卡片上的「批准」按钮） |
| `/reject` | `/reject <卡片编号>` | 拒绝敏感工具调用 |
| `/answer` | `/answer <卡片编号> 选择方案 B` | 回复 Agent 提出的澄清问题 |
| `/cancel` | `/cancel` | 中断当前正在执行的任务 |
| `/retry` | `/retry` | 重新执行上一轮失败或中断的任务 |
| `/remember` | `/remember 严禁直接 push 到 master 分支` | 手动为当前聊天沉淀一条长期跨会话记忆 |
| `/memory` | `/memory 1` | 查看当前聊天持久化的记忆列表 |
| `/forget` | `/forget <记忆ID>` | 标记删除指定的记忆条目 |
| `/ci` | `/ci wait build.yml` 或 `/ci fix` | 监听 GitHub Actions / Codebase 构建，失败可交由 Agent 自动修复 |

> **提示**：`/new` 若带有选项参数，请在选项与正文之间使用 `--` 分隔，例如：  
> `/new --workspace worktree --model "claude-sonnet-5-5" -- 修复单测`

---

### 3. 群聊协作机制深度解析

把 Dutydeck 机器人拉进团队群后，它能扮演高情商的研发协作者：

- **三种群参与模式**：
  - `off`：仅在被明确 `@机器人` 时响应交办，平时完全静音。
  - `observe`：默默监听群聊技术讨论，沉淀群内工程背景，绝不主动发言。
  - `selective`（按需参与）：平时保持安静；仅在识别到明确求助、紧迫线上风险或可靠追问时主动回答。
- **少 @ 一次的人性化机制**：
  - 在机器人已认领的话题内，你作为发起人继续回复无需重复 `@`；
  - 刚在群里发了长篇需求忘了 `@`？在 10 分钟内单独发送一个 `@机器人`，机器人会自动认领前一条消息开始处理！
- **自然语言定时与持续委托**：
  - `@机器人 提醒我明天下午 17:00 提交发布单。`
  - `@机器人 每个工作日 18:00 汇总今天群内的开发进展并发在群里。`
- **分层协作（Leader-Worker）**：
  - 复杂任务交办后，负责接待的 Agent 整理任务简报交给 Leader；Leader 负责拆解只读方案并指派 Worker 改写代码，最终由 Leader 验收回传原话题。

---

### 4. 接入飞书机器人

#### 方式 A：Web 控制台一键自动接入（最推荐）
1. 浏览器打开 Web 控制台（`http://127.0.0.1:4310`），点击首屏右上角 **「新增机器人」**。
2. 填写机器人名称，点击 **「创建机器人」**。
3. 系统自动复用当前机器已有的飞书开发者登录态（或引导扫码），通过开放平台模版自动创建应用、配置事件订阅与权限、一键发布版本并持久化密钥。
4. 关联默认目录与 Agent 即可立即投产。

#### 方式 B：CLI 命令行快速接入
```bash
# 创建并接入新机器人
dutydeck lark create "研发助手" --agent ccflash --listen

# 绑定已有自建应用
dutydeck setup --lark-app-id cli_xxxxxxxx
```

---

## 🖥️ Web 工作台与自动化闭环 <a id="web-console"></a>

Web 工作台专为深度排查、全景把控与工程资产治理设计。

### 1. 全局任务看板与终端回放
- 任务按 **「待处理」**（等待审批/待回答）、**「进行中」**、**「已完成」** 和 **「已归档」** 清晰分层。
- 卡片突出显示核心耗时、工具调用明细与最终产物；展开右侧面板可查看 **Xterm 实时全量终端回放**。
- 支持新指令排队缓冲，以及紧急情况下的**「立即中断抢占（Interrupt）」**。

### 2. 真实自动化验证与自动打回
- 配置机器人的验证命令（如 `pnpm test`、`go test ./...`）后，每当任务修改了代码，服务端自动在沙箱中执行。
- 结果卡片展示 **「验证通过」**、**「验证未通过」** 或 **「验证已过期」**。
- 若执行失败，截断后的报错输出会自动作为下一轮返修提示喂回 Agent，进行全自动闭环修复。

### 3. Codebase / GitLab Webhook 自动化续作
Dutydeck 可以在 `POST /api/hooks/codebase` 接收 MR 和流水线变更事件：
- **安全鉴权**：支持请求头 Token、Bearer Token、HMAC-SHA256 签名校验与 24 小时去重防重放。
- **自动触发自愈**：在配置了 Webhook 的会话中输入 `/ci fix`，流水线挂掉后自动拉起 Agent 分析修复。具备严格防护：单次故障最多修复 3 轮、同一报错指纹遇 2 次即停、每轮限制改动文件数与行数、推送前校验 Commit SHA，不合入、不强制推送。

---

## ⚙️ Agent 配置与权限姿态 <a id="agent-config"></a>

Dutydeck 既支持原生的 ACP（Agent Client Protocol）协议，也支持通过 PTY 模拟终端驱动市面上已有的各类 CLI Agent。

### 1. 自定义 Agent 配置 (`DUTYDECK_AGENTS_JSON`)

通过设置环境变量 `DUTYDECK_AGENTS_JSON`，你可以注册任意自定义 Agent。

#### 示例：接入 Claude Code (经由代理网关 / 公司 CPA)
```json
[
  {
    "id": "ccflash",
    "name": "CCFlash (Claude Code)",
    "protocol": "pty-cli",
    "adapterId": "claude-code",
    "command": "claude",
    "args": ["--settings", "/home/username/.claude/ccflash.settings.json"],
    "model": "claude-sonnet-5-5",
    "permissionMode": "ask"
  }
]
```

配套的独立配置文件 `ccflash.settings.json`：
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8320",
    "ANTHROPIC_AUTH_TOKEN": "your-proxy-token"
  }
}
```

> **最佳实践**：
> - 推荐使用 `--settings` 指定独立配置文件，避免动态篡改全局 `~/.claude/settings.json` 引发多任务冲突。
> - `command` 字段必须是二进制绝对路径或系统 `PATH` 中的可执行程序，不能使用 shell alias。

#### 示例：接入标准 ACP Agent
```json
[
  {
    "id": "custom-acp",
    "name": "My Custom ACP",
    "protocol": "acp",
    "command": "/usr/local/bin/my-acp-agent",
    "args": ["serve"],
    "permissionMode": "ask"
  }
]
```

---

### 2. 权限姿态对比 (Permission Posture)

| 权限模式 | 行为特征 | 推荐场景 |
|---|---|---|
| `ask` **(默认推荐)** | 遇到写文件、Shell 执行等特权操作时，任务挂起并在飞书/Web 推送审批 | 绝大多数日常开发，兼顾便捷与最高安全性 |
| `approve-reads` | 自动允许所有读操作（读文件、列目录），只有写操作和命令执行需审批 | 侧重代码审查、问题分析与 Bug 排查 |
| `deny-all` | 自动拒绝一切特权操作 | 纯只读探索模式，绝对保证零改动 |
| `full-trust` | 跳过所有确认直接放行（相当于无人值守 YOLO 模式） | **仅限**高安全性隔离沙箱或无人值守自动化流水线 |

---

### 3. 核心环境变量一览

| 环境变量 | 默认值 | 作用说明 |
|---|---|---|
| `DUTYDECK_HOST` | `127.0.0.1` | 服务监听 IP（若需局域网访问设为 `0.0.0.0`） |
| `DUTYDECK_PORT` | `4310` | 守护进程 Web 与 API 端口 |
| `DUTYDECK_AUTH` | `true` | 是否启用 Token 访问鉴权（填 `false` 关闭） |
| `DUTYDECK_DEFAULT_CWD` | 启动路径 | 默认的工作区绝对路径 |
| `DUTYDECK_DATABASE_URL` | `<cwd>/.dutydeck/dutydeck.db` | 本地 SQLite 存储数据库文件路径 |
| `DUTYDECK_AGENTS_JSON` | `[]` | 自定义 Agent 注册列表 |
| `DUTYDECK_GITHUB_TOKEN` | - | GitHub Actions 状态轮询 Token |
| `DUTYDECK_CODEBASE_WEBHOOK_SECRET` | - | Codebase Webhook 的令牌与 HMAC 签名密钥 |
| `LARK_APP_ID` | - | 飞书应用 App ID |
| `LARK_APP_SECRET` | - | 飞书应用 App Secret |

---

## 🛠️ CLI 与运维速查 <a id="cli-reference"></a>

### 1. 守护进程日常管理

```bash
# 启动守护进程
dutydeck start [--cwd /path] [--port 4310] [--host 0.0.0.0]

# 查看服务状态（包含 PID、端口、日志位置）
dutydeck status

# 平滑重启服务（先排空正在执行的任务再重启）
dutydeck restart

# 停止守护进程
dutydeck stop

# 更新全局 Dutydeck 包并自动重启
dutydeck update

# 一键排障诊断（检测端口占用、SQLite 读写、Agent 可执行性、飞书长连接等）
dutydeck doctor
```

### 2. 生产级版本发布与部署 (`deploy`)

```bash
# 把构建后的检出目录发布为不可变版本：排空 → 切换 releases/current → 重启 → 健康检查；失败安全回滚
dutydeck deploy --source /path/to/checkout
```
- **部署窗口保护**：可通过环境变量 `DUTYDECK_DEPLOY_WINDOW`（例如 `10:00-11:00,16:00-17:00`）限制自动部署时段。
- **数据安全回滚**：自动保留最新 5 个发布版本和数据库备份；若检测到数据库 Schema 变更，自动停止回滚以保护业务数据。
- **单 Bot 独立进程隔离**：支持单 bot 专属数据库独立拉起：`dutydeck start --foreground --database /path/to/bot.db --bot-app-id cli_xxx`。

### 3. 开机自启设置 (`autostart`)

无需手动手写 systemd 服务或 launchd plist 文件：

```bash
dutydeck autostart enable   # 注册开机自启（Linux systemd --user / macOS launchd）
dutydeck autostart status   # 查看自启状态
dutydeck autostart disable  # 关闭自启
```

### 4. 命令行管理配置 (`dutydeck settings`)

Web 控制台里的全部机器人设置、群聊策略与用量配额，均可通过命令行直接修改，便于脚本化与 Agent 自我管理：

| 控制台模块 | CLI 命令 |
|---|---|
| **机器人设置** | `dutydeck settings bot list / show / set / add / remove / install-hook` |
| **群聊协作策略** | `dutydeck settings group list / show / set / members / sync` |
| **每日用量上限** | `dutydeck settings usage show / set-cap / remove-cap` |
| **主终端后端** | `dutydeck settings terminal-backend [tmux|herdr]` |
| **工作区分组** | `dutydeck workspace-groups` |

常用命令示例：
```bash
dutydeck settings bot show cli_xxx                           # 查看机器人全部配置
dutydeck settings bot set cli_xxx adhdMode=true              # 开启 ADHD 友好模式
dutydeck settings group set oc_xxx participation=selective   # 设置群聊按需参与
dutydeck settings usage set-cap 50 --app cli_xxx             # 设置每日用量上限
```

### 5. 终端后端与 Herdr 侧边子任务空间

- **主终端后端切换**：在 `tmux`（默认）与 `Herdr`（Linux, >= 0.9.0）之间灵活选择，设置后新建的 `pty-cli` 会话自动生效。
- **会话专属 Herdr 侧边工作空间**：主 Agent 可通过环境注入的 `$dutydeck_herdr_command` 派发并行子任务。每个会话获得专属 named session，支持在侧边独立 pane 运行命令、抓取日志与并发探索，不阻塞主任务。

### 4. 远程访问与安全策略

- **默认绝对安全**：Dutydeck 默认只监听 `127.0.0.1`，不向外部公网暴露。
- **局域网/内网穿透访问**：
  - 启动时指定 `--host 0.0.0.0`；
  - 首次启动终端会生成高强度安全 Token，远程连接必须使用该 Token 鉴权；
  - 查看或轮换 Token：
    ```bash
    dutydeck auth token          # 查看当前 Token
    dutydeck auth token --rotate # 轮换 Token 并强制登出全部旧会话
    ```
- **警惕 `--no-auth`**：切勿将开启 `--no-auth` 的服务暴露至公网，否则外部人员可能借由 Agent 获得宿主机系统执行权限。

---

## ❓ 常见问题与排障 (FAQ) <a id="faq"></a>

### Q1: 在飞书给机器人发消息，机器人没有任何反应，也没贴 `👌` 表情？
1. 运行 `dutydeck doctor`，检查输出中「飞书长连接（Lark Listen）」一栏是否正常。
2. 登录飞书开放平台后台，检查该应用是否已开启 **「机器人能力」**，且事件订阅方式为 **长连接**（已订阅 `im.message.receive_v1` 事件）。
3. 检查机器人是否已被拉入对应的群聊；在群聊中确认消息是否包含了 `@机器人`。

### Q2: 提示 `Persisted key policy violation` 错误？
- **原因**：内部 ACPX 持久化键名规范强制要求使用全小写的 `snake_case`。
- **解决**：不要将大写环境变量名直接写入 ACPX session 配置；Agent Dock 群聊工具的运行时变量使用 `dutydeck_group_tools_url` 和 `dutydeck_group_tools_token`。

### Q3: 提示 `Agent command not found` 或找不到可执行程序？
- **原因**：后台守护进程处于非交互式子进程环境，不会读取 `~/.bashrc` 或 `~/.zshrc` 中的 `alias`。
- **解决**：在 `DUTYDECK_AGENTS_JSON` 中，`command` 请填写可执行文件的绝对物理路径（例如 `/usr/local/bin/claude`），严禁使用别名。

### Q4: 能否在同一台机器上运行多个机器人？
- 可以。在 Web 控制台可以添加多个飞书机器人；每个机器人可以绑定独立的默认工作区路径、Agent 引擎和飞书应用凭据，分别服务于不同的业务或研发群组。

---

## 📄 开源许可证与协议 (License)

Dutydeck 核心代码采用开源授权协议。完整第三方依赖与开源许可证声明请参阅 [Third-Party Notices](THIRD_PARTY_NOTICES.md)。
