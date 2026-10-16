# Dutydeck

<p align="center">
  <strong>本地优先的 AI Agent 研发工作台与飞书指挥台</strong><br>
  <em>把跑在你开发机上的 Claude Code / Codex / CLI 编码智能体，接到飞书和 Web 工作台上</em>
</p>

<p align="center">
  <a href="#why-dutydeck">为什么选 Dutydeck</a> •
  <a href="#key-highlights">核心能力</a> •
  <a href="#quick-start">快速上手</a> •
  <a href="#lark-guide">飞书指挥台</a> •
  <a href="#web-console">Web 工作台</a> •
  <a href="#agent-config">Agent 配置</a> •
  <a href="#plugins">插件</a> •
  <a href="#cli-reference">CLI 速查</a> •
  <a href="#known-limits">已知限制</a> •
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="./README.en.md">English</a>
</p>

---

## 项目简介

**Dutydeck** 是面向开发者和工程团队的本地优先（Local-First）AI Agent 研发工作台。

它用一个守护进程，把你开发机或服务器上的编码智能体（Claude Code、Codex、标准 ACP Agent、命令行 CLI）接到**飞书（Lark）**和 **Web 仪表盘**。在飞书发一条消息，Agent 就在你的机器上执行，结果以卡片推回手机。

```text
┌──────────────────────── 交互界面 (Interfaces) ────────────────────────┐
│  飞书移动端 / 桌面端 (Lark/Feishu)            Web 工作台              │
│  · 随时派活，任务卡片流式刷新                 · 任务看板与状态流转    │
│  · 危险操作在手机上点按钮审批                 · 终端模式 Agent 的终端回放│
│  · 跨会话长期记忆与定时委托                   · 用量与成本、每轮改动  │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ (WebSocket / SSE / Card 2.0)
┌───────────────────────────────────▼───────────────────────────────────┐
│                     Dutydeck 本地守护进程 (Local Daemon)               │
│  · 任务排队、抢占与中断调度                   · 权限门禁（逐项审批）   │
│  · 验证门禁（飞书任务，需配验证命令）         · 长期记忆自动提取与整理 │
│  · SQLite 事务持久化                          · CI 续作（由插件提供）  │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ (ACP Protocol / PTY Adapter)
┌───────────────────────────────────▼───────────────────────────────────┐
│                     本机 Agent 运行时 (Local Engines)                  │
│  · Claude Code (原生 / CPA 代理网关)          · 标准 ACP Agents (acpx) │
│  · 自定义 CLI 脚本与适配器                    · 可选的 Git Worktree 目录│
└───────────────────────────────────────────────────────────────────────┘
```

---

## 为什么选择 Dutydeck <a id="why-dutydeck"></a>

| 痛点场景 | 传统终端 CLI 使用方式 | Dutydeck 体验 |
|---|---|---|
| **移动交办与异步等待** | 必须守在电脑前；断开 SSH 任务就中断 | 飞书发一句话派活，后台持续执行，结果以卡片回传 |
| **高危操作管控** | 要么全局 YOLO 跳过确认，要么频繁弹窗卡住执行 | 卡片上点「允许本次」或「拒绝」，在手机上放行 |
| **代码冲突与脏工作区** | 直接改当前分支，容易污染未提交的改动 | 可选 **Git Worktree**：从当前提交派生独立目录，不动主工作区（Web 新建会话默认开启，飞书默认不开，见下文） |
| **交付质量验证** | Agent 说“测试通过了”，可能没跑 | **服务端实际执行验证命令**，留存退出码、耗时与代码指纹，失败自动打回返修（飞书任务，需先配验证命令） |
| **团队协同与项目记忆** | 每次新会话都要重述规范 | **跨会话记忆**自动沉淀；进群后按需参与，也可用自然语言交办定时任务 |
| **流水线无人值守** | 推送后手动盯 CI，挂了再叫 Agent | 装上 CI 插件后，构建失败可唤醒 Agent 按规则修复（见[插件](#plugins)） |

---

## 核心能力 <a id="key-highlights"></a>

### 1. 飞书指挥台
- **流式进度卡片**：在私聊或群聊下达指令，状态、阶段、耗时实时更新。
- **手机审批**：Agent 要写文件、执行命令时，卡片弹出「允许本次 / 本会话允许此命令 / 拒绝」，点一次即可。
- **长文本打包**：超长代码或分析文档自动打成 Markdown 附件。
- **ADHD 友好输出**（`adhdMode`）：首行给结论和行动项，清单按组拆分。
- **手机看改动**：结果卡带「改动 N 个文件 +A −D · 查看改动」，打开就能看这一轮的 diff，还能逐行评论。

### 2. Git Worktree 目录（可选）
- 任务在从当前提交派生的独立 Git Worktree 里改代码，不动你正在写的主工作区。
- **默认值不同**：Web 新建会话默认“独立 Git 工作目录”；飞书任务默认“直接使用所选目录”（`shared`）。飞书里要用 Worktree，在 `/new` 里加 `--workspace worktree`。
- 任务归档时检查未提交改动、未合并提交和占用进程，确认安全才释放目录。

### 3. 验证门禁（Verification Gate）
- 给机器人配好验证命令（`verificationCommand`，如 `pnpm test`）后，飞书任务改了代码就会在宿主机工作区真实执行。
- 记录命令退出码、耗时、标准输出和代码指纹。
- 验证不通过时，把失败输出发回 Agent 返修，最多 2 轮。
- 目前只对飞书任务生效；Web 会话不会自动触发。没配验证命令时不执行。

### 4. 跨会话长期记忆
- **默认关闭**：`memoryEnabled` 未设置时，只有群默认参与强度为「按需」或「积极」才开启。
- **范围**：私聊各自独立。群聊默认同一机器人的所有群共享一个记忆池；把 `groupMemoryScope` 设为 `per-group` 后，各群记忆互不可见（Web「群记忆范围」，或 `dutydeck settings bot set <appId> groupMemoryScope=per-group`）。切换不迁移也不删除：`per-group` 下原共享池保留但不读取，切回共享即恢复。
- **记录与提取**：`/remember` 手动记录；后台每 3 轮提取环境事实与偏好，每 8 轮合并去重。
- **注入**：新任务注入精简记忆索引（`MEMORY.md`，≤ 3000 字符），执行中 Agent 可检索完整细节。

### 5. 群聊协作与定时委托
- **参与强度**：只在 @ 时 / 话题内免 @ / 按需 / 积极（见下文）。
- **少 @ 一次**：在机器人认领的话题里继续追问不用重复 @；忘了 @ 时，10 分钟内补发一个 `@机器人`，会认领前一条消息。
- **定时委托**：在群里或私聊说“每天 18:00 总结本群今日进展”“每 15 分钟看看这个话题有没有结论”，Agent 会发一张确认卡，写明做什么、什么时候、发到哪，点「启用」才开始，不用记命令；每次的结果卡上可以停用。也可以用 `/schedule` 按分钟间隔创建。
- **分层协作**：PMO 接需求、Leader 拆方案、Worker 落地，Leader 验收后回传原话题。

### 6. 开 PR 与跟进
- 飞书发 `/pr [标题]`，或在 Web 会话的「工作目录与自动化」面板点「开 PR」，Dutydeck 先出确认卡 / 确认框，有权限的人确认后才推送。
- 开出 PR 后自动跟进 CI 失败和评审意见，能修的交给 Agent 修好再推回同一分支。详见下文[开 PR 与跟进](#pr-loop)。
- 需要装支持开 PR 的 CI 插件（仓库自带的 `plugins/github`），否则 `/pr` 回“开 PR 未配置”。

### 7. CI 续作（插件提供）
- 核心不内置任何 CI 平台。GitHub Actions 和 Codebase 是两个自带插件：`plugins/github`、`plugins/codebase`，装上后才有 `/ci`。
- 构建失败时按规则交给 Agent 修复：单次故障最多 3 轮、同一报错指纹出现 2 次即停、推送前校验提交 SHA、不合入、不强制推送。
- 详见[插件](#plugins)一节的“CI 提供方”。

---

## 3 分钟快速上手 <a id="quick-start"></a>

### 1. 环境准备

- **Node.js**：`>= 22.12.0`
- **包管理器**：`pnpm >= 11`
- **已安装并登录的 Agent CLI**：Claude Code（`claude`）、Codex 或其他支持 ACP / CLI 的智能体。

### 2. 全局安装与配置

```bash
# 全局安装 Dutydeck
pnpm add -g @byted/dutydeck --registry=http://bnpm.byted.org

# 运行交互式配置向导（可重复运行）
dutydeck setup
```

向导会探测本机可用的 Agent、设置默认工作目录，并可选地绑定飞书机器人。绑定时：

- 默认 Agent 和 App Secret 存在机器人配置里（与 Web 面板是同一份），不写进 `.env`。交互时 App Secret 用隐藏输入。
- 新建机器人时会问是否立即开启监听，默认是。

脚本和 CI 里跳过交互：

```bash
# 只配本机，不绑飞书
dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes

# 绑定飞书应用：Secret 从管道读，不要放进命令行参数
printf %s "$LARK_SECRET" | dutydeck setup --lark-app-id cli_xxx --lark-app-secret-fd 0 --agent claude --listen --yes
```

向导选项：`--agent <id>` 指定默认 Agent（必须是检测到的 CLI）、`--lark-app-secret-fd <fd>` 从文件描述符读 Secret、`--listen` 同时开启监听。已在运行的服务要 `dutydeck restart` 才会读到新的机器人配置。

### 3. 启动守护进程与状态检查

```bash
# 启动后台守护进程
dutydeck start

# 健康诊断（有问题会给出可直接复制的修复命令）
dutydeck doctor

# 查看守护进程运行状态
dutydeck status
```

`doctor` 会对每个机器人的默认 Agent 执行一次 `--version`（5 秒超时，不调用模型）；当前目录没有 `.env` 时，改读 `last-daemon-dir` 记录的 daemon 目录，并说明读了哪一个。

启动后浏览器访问：
- **Web 控制台**：`http://127.0.0.1:4310`（本机访问免密）

---

### 源码二次开发与调试模式

```bash
# 1. 克隆代码仓库并安装依赖
git clone https://github.com/ITcathyh/dutydeck.git
cd dutydeck
pnpm install

# 2. 配置环境变量
cp .env.example .env

# 3. 启动前后端热重载开发模式
pnpm dev
```

本地开发地址：
- **Web 前端**：`http://127.0.0.1:4311`
- **后端 API**：`http://127.0.0.1:4310`（前端请求自动代理到此端口）

---

## 飞书指挥台实战指南 <a id="lark-guide"></a>

飞书任务卡默认不显示 Agent 名称。在机器人设置的「访问范围与高级设置」中开启「卡片显示 Agent 名称」后，状态右侧会显示简称角标（例如 `完成` `CCFlash`），不展示括号中的宿主细节。也可用 `dutydeck settings bot set <appId> showAgentName=true` 开启，设为 `false` 关闭。

### 1. 经典任务交互流程

```text
[在飞书发送需求] ──► [机器人在原消息贴 👌] ──► [推送动态进度卡片]
                                                      │
┌─────────── Agent 要执行受控操作或需要澄清 ◄─────────┘
▼
[审批卡：允许本次 / 本会话允许此命令 / 拒绝]  或  [提问卡：点选项或引用卡片回复]
│
▼
[任务结束] ──► [有验证命令则在本机运行验证] ──► [推送结果卡与附件]
```

1. **下达任务**：私聊直接说需求；群聊 `@机器人 任务描述`。
2. **跟进反馈**：接单后机器人在原消息上贴 `👌`，并发送进度卡。任务完成时在原消息上贴对勾，失败或中断（不含你自己取消）贴叉号。
3. **在线审批**：审批卡顶部有一句操作摘要（如“执行命令：pnpm test”）。
   - 「允许本次」只放行这一次；「本会话允许此命令」只给发起人，且仅限非高危命令，放行后同一会话里同一条命令不再发卡；「拒绝」。
   - 30 分钟没人处理会提醒一次，任务继续等；超过 24 小时自动拒绝。
4. **澄清答复**：Agent 发来提问卡时，点选项，或引用该卡片直接回复答案。问题和全部选项优先完整展示；超出卡片容量时提供全文附件，并明确标注卡面为节选。附件发送成功前暂不发布可作答的飞书提问卡，恢复后继续投递；回答或过期后的卡片保留当时展示的内容。审批卡仍只显示脱敏内容，不把原始命令作为全文附件发送。
5. **交付验收**：结果卡包含改动摘要、验证结果（通过 / 未通过 / 未验证 / 已过期）和超长 Markdown 附件；有改动的轮次带「查看改动」链接。结论后的「需要你：…」提示会单独显示为醒目块，标签加粗。

### 附件读取与结果投递

卡片的 Markdown 图片和结构化图片共用最多 4 张的读取上限，并去重；Markdown 中仅识别实际图片语法里的合法飞书 `img_key`，代码示例和普通图片 URL 不会触发下载。

飞书文件遇到平台明确的尺寸限制后，使用原机器人身份分片下载并流式落盘，每片不超过 32 MB。Dutydeck 的单文件本地上限为 **512 MiB**，这不是飞书的平台上限；图片不走分片下载。权限或保密拒绝不会绕过，失败、取消或超时不会把半成品交给 Agent。总期限沿用现有请求设置（默认 15 秒），慢速大文件可能需要重新提供较小文件。

过程卡和结果的写请求在限流等待、重试后重新确认任务和轮次归属，停止或换轮后不再继续旧轮写入；已经发出的请求无法撤销。最终结果被明确的内容安全审核拒收时，停止原文重发，并尝试发送不含原文的固定提示；提示成功不代表结果已送达，也不会改成附件绕过审核。

结果首次投递前记录时间；发送结果未知时，跨重启仍只在首次投递起一小时内自动重试。超过窗口后停止重发，需核查原话题和 Web 执行记录；已确认的送达回执仍可恢复。这不保证远端只执行一次。

### 结果未知的任务

重启、断线等情况下，一轮任务可能“不知道是否执行成功”。这时飞书原话题会收到一张提醒卡，有「重新执行 / 标为已完成 / 标为失败」三个按钮和「查看详情」链接。

- 发起人和管理员可以操作。「重新执行」需要在 60 秒内再点一次确认。
- 插话投递结果未知时，回执也会指向这张卡。
- Web 会话详情页执行记录下方有同样三个操作，重新执行要在确认框里确认。
- 处理后卡片上会显示谁在何时做了什么；处理记录写入执行账本。
- 超过 24 小时的旧任务不发飞书卡，只能在 Web 上处理。
- 接口：`GET /api/sessions/:id/unknown-tasks`、`POST /api/sessions/:id/unknown-tasks/:taskId`，body 为 `{target, action, allowDuplicateEffects?}`。

### 推送分级

群里的 @ 和加急按事情的轻重分三档，由三项机器人设置控制（Web 高级设置，或 `dutydeck settings bot set <appId> ...`）。三项都在“群卡片 @”总开关打开时才生效。

| 档位 | 包含 | @ 谁 | 加急 |
|---|---|---|---|
| 需要你操作 | 审批、提问、结果未知、任务恢复提醒 | 发起人 / 能批准的人（`notifyMentionAction`，默认 `true`） | 到阈值未处理会加急（审批、提问、结果未知卡） |
| 完成 | 结果卡、启动前失败 | 发起人（`notifyMentionDone`，默认 `true`） | 不加急 |
| 信息 | 进度、回执、排队 | 不 @ | 不加急 |

- `notifyQuietHours`（如 `22:00-08:00`，daemon 本地时区，空则关闭）：免打扰时段内完成档不 @；需要操作档照常 @，加急推迟到时段结束后补发一次。
- 定时任务的结果不 @。

---

### 2. 常用飞书命令速查表

下表与 `/help` 一致。`/help` 默认每页 6 条；装了插件命令时，插件命令列在最后一页。

| 指令 | 示例 | 作用说明 |
|---|---|---|
| `/help` | `/help 2` | 列出当前可用的命令及用法 |
| `/new` | `/new -- 优化登录接口的查询耗时` | 结束当前会话上下文；带任务内容则同时开新会话并派发 |
| `/new` 指定首轮配置 | `/new --cwd "/data/app" --workspace worktree -- 重构模块` | 选项：`--agent`、`--cwd`、`--workspace shared\|worktree`、`--model`、`--effort` |
| `/new --handoff` | `/new --handoff 接着补测试 -- 补齐重试逻辑单测` | 新会话带上上一会话的结果、git 状态和备注。`--handoff` 后到 `--` 之前是备注，任务写在 `--` 之后；不写 `--` 则只交接、不派任务 |
| `/plan` | `/plan 把鉴权中间件改成无状态` | 先只调研、出计划，卡片上批准后再执行（见下文） |
| `/pr` | `/pr 修复登录超时` | 把本会话的改动推到新的 `dutydeck/` 分支并开 PR（先发确认卡，确认后才推送），之后跟进 CI 和评审意见。需先装支持开 PR 的 CI 插件 |
| `/tasks` | `/tasks 2` | 分页查看待处理任务、运行进度和最近结果 |
| `/status` | `/status` | 本会话的 Agent、工作区、运行状态、待执行指令数和本月用量 |
| `/agents` | `/agents` | 列出本机可用的 Agent、版本和机器人当前默认用的那个 |
| `/approve` | 引用审批卡，回复 `/approve` | 批准本次工具调用，等同点「允许本次」。卡片上不再显示编号，按钮点不了时用“引用卡片 + 命令” |
| `/reject` | 引用审批卡，回复 `/reject` | 拒绝本次工具调用 |
| `/answer` | 引用提问卡，直接回复答案 | 回答 Agent 的问题并继续原任务。也可写成 `/answer <问题编号> <回答>` |
| `/cancel`（别名 `/stop`） | `/cancel` | 取消本会话正在执行或排队的这一轮，进度卡收敛为取消回执 |
| `/retry` | `/retry` | 重新执行最近一次失败或已取消的任务，新建一张进度卡 |
| `/queue` | `/queue top 2` | 查看待执行指令；`cancel <编号>` 取消、`top <编号>` 提到队首、`steer <编号>` 立即插话 |
| `/steer` | `/steer 先别动 migrations 目录` | 把一条内容插进正在执行的这一轮；Agent 不支持插话时排到队首并中断这一轮 |
| `/remember` | `/remember 严禁直接 push 到 master 分支` | 保存一条长期记忆，之后每轮任务都带给 Agent |
| `/memory` | `/memory`、`/memory consolidate`、`/memory ignore <描述>`、`/memory ignore list` | 查看当前可见的记忆及后台提取、整理状态；`consolidate` 立即整理；`ignore` 管理“不要记”的规则 |
| `/forget` | `/forget <记忆编号>` | 删除一条记忆 |
| `/schedule` | `/schedule every 30 巡检构建` | 查看、创建、启用或停用此话题的定时任务；`every` 后是分钟数，创建后默认停用，用 `/schedule enable <编号>` 启用 |
| `/ci` | `/ci wait build.yml`、`/ci fix`、`/ci cancel <等待编号>` | 等当前提交的 CI、失败时交给 Agent 修复、取消等待。需先装 CI 插件 |
| `/work` | `/work research 目标` | 查看目标、分配 Agent、回答步骤问题、复用工作流（`consult`、`research`、`templates`） |
| `/grant` / `/revoke` | `/grant @成员` | 把本群对话权限开放给全部成员或加入名单 / 收回 |
| `/repair` | `/repair` | 诊断并补齐飞书应用权限、事件订阅和卡片回调（执行前二次确认，不会自动发布） |

> **提示**：`/new` 带选项时，选项和正文之间用 `--` 分隔，例如 `/new --workspace worktree --model "claude-sonnet-5-5" -- 修复单测`。

#### 先出计划（`/plan`）

`/plan <任务>` 让 Agent 先只调研、出计划，不改文件。计划出来后，卡片上可以：

- **批准执行**：在同一会话里按机器人原来的权限模式执行；
- **提修改意见**：写在卡片上，或引用计划卡回复，Agent 重出计划；
- **取消**。

要点：

- 计划阶段会拦下写文件和执行命令的工具调用，以及常见的写操作命令。它不是沙箱，挡不住刻意构造的 shell 命令，不要在计划阶段让 Agent 读不可信内容。
- 不带任务时返回用法。
- 支持 Claude 的 ACP 和 Claude 终端模式。其它 Agent（如 codex）会明确提示“无法先出计划”。计划功能上线前就已存在的终端会话，要先 `/new`。
- 批准、提修改意见、取消，权限和中断任务相同（发起人或管理员），不需要高风险审批权限。
- 沿用审批的时限：30 分钟提醒一次，24 小时没人处理就关闭；有了更新的任务，旧计划卡自动失效。
- Web 输入框旁有“先出计划”开关；计划待批准时，输入区上方显示“执行计划待批准”面板，可批准、取消或提修改意见。飞书发起的计划在 Web 上只读。

#### 开 PR 与跟进（`/pr`）<a id="pr-loop"></a>

`/pr [标题]` 把当前会话的改动变成一个 PR。Web 里的入口是会话「工作目录与自动化」面板里的「开 PR」。

- **先确认，再推送**：先出确认卡（飞书）或确认框（Web），列出要提交的文件和增删行数、不包含的文件及原因、本地提交、源分支和目标分支、标题和正文摘要。有权限的人确认后才推送；清单 30 分钟过期。飞书沿用中断 / 重试同一道权限（发起人或管理员），Web 的生成、确认、取消也要求会话的中断权限。重复点或并发点只会推一次、只开一个 PR。
- **推送目标**：只推新建的 `dutydeck/<主题>-<8 位 id>` 分支，不用 force，不切换分支，不改动你正在用的检出（HEAD、暂存区、工作区文件都不变）。推送用本机的 git 凭据，所以本机要能 `git push` 到 `origin`。首次推送前远端已有同名分支会拒绝。
- **哪些文件会带上**：只带本会话某一轮改过、且之后没被别人再改的文件。其余的在清单里列为“不包含”：没有任何一轮改过的标“不是本会话改的”，改过之后又被改动的标“本会话改过，之后又被改动，无法确认”。生成清单到确认之间这些文件又变了，就不推送，需要重新发起。这依赖[每轮改动](#web-console)的记录，没有记录的轮次不会进清单。
- **本地未推送的提交**：HEAD 上有不在 `origin/<目标分支>` 里的提交时，会作为 PR 分支的祖先一起推送（不改写），并在清单里逐条列出；没有 `origin/<目标分支>` 跟踪分支时会提示无法确认这些提交是否已在目标分支上。本地未推送的提交超过 50 个时不能开 PR（清单列不全），先把它们整理成少量提交再试。
- **工作区里有超限的未跟踪文件时**（单个超过 20 MiB、合计超过 50 MiB，或超过 2000 个），`/pr` 和自动跟进都会报出具体文件或原因，不会静默跳过。把不需要提交的文件和构建目录加进 `.gitignore` 后再试。
- **自动跟进**：开出 PR 后每 2 分钟查一次 PR 状态、当前提交的 CI 和新评论。
  - CI 失败：最多自动修 3 轮；同一个错误出现 2 次就停；每轮改动超过 10 个文件或 300 行就停。
  - 评审意见：最多 5 轮，每轮最多带 10 条评论。**只有仓库所有者、成员、协作者的个人账号**（GitHub 的 `author_association` 为 OWNER、MEMBER、COLLABORATOR，且不是 Bot）的评论会自动交给 Agent；其他人和机器人（如覆盖率机器人）的评论只发“需要你决定”卡片，卡片上写明作者和身份，点「按评论修改」才处理，这类评论不占处理轮次。Agent 对自动处理的每条评论给出“已处理”或“需要问人”：已处理的在 PR 上回复；含义不清的发卡片问人，按钮是「按评论修改」「不处理」。自己发的评论和带 `<!-- dutydeck -->` 标记的评论不会当作新意见，同一条评论不会重复处理。github 插件的令牌要能读到组织成员身份（例如 fine-grained PAT 要有组织 Members 读权限），否则把成员身份设为私密的成员发的评论会被当成外部评论，只发卡片。
  - 修复推到同一个分支，只做快进。远端分支被别人推过就停止跟进，不覆盖。
  - PR 合并或关闭、或在 Web 点「停止跟进」后不再跟进。
  - 跟进时 Agent 直接改工作区，提示词禁止它自己 commit、push 或切分支，由 Dutydeck 把这一轮的改动提交到 PR 头上再推送。如果你在工作区里手改了 PR 涉及的文件，自动跟进会停下。修复这一轮改到的文件，如果在这一轮开始前就和 PR 分支不一致（里面有不属于这个 PR 的未提交改动，例如确认时被排除的本地修改），也不会推送：会停止跟进并列出这些文件，请人处理。修复只自动推送 PR 里已有的文件：这一轮改到别的文件（包括新建的文件，或这一轮期间被别的话题、编辑器改的文件）时不推送，停止跟进并列出这些文件；确认它们该进 PR 的话，自己提交并推到 PR 分支。
- **没装 CI 插件时**：`/pr` 回“开 PR 未配置”和安装方法；Web 不显示按钮，只显示同样的提示。

安装和令牌见[插件 → CI 提供方](#plugins)。

---

### 3. 群聊协作机制

把机器人拉进团队群后：

- **参与强度**（群里不 @ 时机器人什么时候接话，只影响接不接话，不改变权限）：
  - `只在 @ 时`：只处理 @ 机器人的消息。
  - `话题内免 @`：新任务要 @；机器人接手的话题里直接回复即可。
  - `按需`（`selective`）：没 @ 时先判断是不是在叫它，是才接；有明确求助或紧迫风险时主动回答。
  - `积极`（`eager`）：除了明显对别人说的、表情和致谢，群里真人的消息都接，适合单人群。
  - 底层字段是 `mentionPolicy` 和群参与模式 `participation`（`off` / `observe` / `selective` / `eager`）。`observe` 只监听、沉淀背景、不发言，目前只能用 `dutydeck settings group set <chatId> participation=observe` 设置。
  - 新建机器人的 `mentionPolicy` 默认 `topic`。
  - **多机器人群**（本群订阅的告警来源不算）没指定接话人时，除了叫它名字、回复它和它接手的话题，没 @ 的消息都不接。@ 要接话的机器人说「你负责接话」并点确认，或在 Web 群设置里指定接话人。
  - **接话人**（多机器人群和单机器人群都能指定）：按需档的接话人没配负责范围时，群里没有明确对象、需要有机器人处理的求助（如「有人知道今天的发布单在哪看吗」）也由它接；闲聊、群友之间的问答、@ 别人和进度播报仍不接。
  - **负责范围**（Web「机器人管理」的「负责范围」，或 `dutydeck settings bot set <appId> roleScope=...`，对这个机器人所在的所有群生效）：按需档配了以后，没 @ 的消息里属于范围内的事由它判断后接，不受接话人限制；多个机器人的范围重叠时可能都接。按需档没配、它也不是接话人时，在有多个真人的群里，没明确叫它的泛问和普通告警不接。积极档和单真人群配了负责范围后也改为按范围判断，接的会变少。
  - 没接话时 @ 它问「刚才为什么没回」，它会说明原因和怎么改；`/status` 显示参与强度、接话人和负责范围。
- **告警初筛**（内置场景包 `alarm`，见[内置插件](#builtin-plugins)）：
  - @ 机器人说「告警来了先帮我看看」或「告警来了先帮我初筛，只看 P0」，它发一张确认卡，写明来源机器人（默认取最近在群里发言最多的机器人）、级别、去重窗口和每小时上限。点确认的人是确认人，初筛任务以他的名义发起。说「关闭告警初筛」并确认即可关闭，设置会保留。
  - 开启后，来源机器人发的告警不经参与判定：机器人在告警下开话题起初筛任务。同一条告警在去重窗口内只分析一次，超过每小时上限的跳过；在跳过的告警下 @ 它问「刚才为什么没回」能查到原因。多机器人群里只由接话人做。`/status` 显示订阅和今天分析、跳过的条数。
  - @ 机器人并引用一张告警卡时，如果它在这个群里处理过同一告警规则，会把上一次的结论作为参考材料带给 Agent，并在过程卡顶部挂一行「📎 日期 同一告警规则：…」。
  - Web 群设置按场景包列出参数（来源、级别、去重窗口、每小时上限）。开启要先在群里确认过一次；之后可以在 Web 或 `dutydeck settings group set <chatId> scenarios=...` 改参数和开关。
  - 告警下的话题：多机器人群里，来源机器人发的告警开出的话题不算别的机器人的话题，有人在里面没 @ 地追问时照常走参与判定。机器人判定前会读这个话题的回复（每页 50 条、最多 4 页），发现别的机器人（来源机器人和自己以外）已在里面发过言、话题超过 4 页读不完或读取失败时让路，不接。两个机器人几乎同时判定时仍可能都接，这里不保证只有一个接。
- **团队答疑**（场景包 `team-faq`，在 `plugins/team-faq`，要先安装）：群里真人问到配置的服务或流程时，机器人按 runbook 判断要不要接，接了按 runbook 回答并标出处。安装和参数见[该插件的 README](plugins/team-faq/README.md)。
  - 只在 `按需` 和 `积极` 档生效；@ 机器人、回复机器人的消息照常处理。
  - 命中关键字只是把这条消息交给参与判定模型，并附上 runbook 摘录；同事之间的讨论、已经有人回答、runbook 没覆盖的问题，模型会不接。
  - runbook 读取超时或出错、或者一段都没读到而有文件读不到时，这条消息按没开这个包判定，`/status` 记为「取材料失败」，「为什么没回」会说明原因。
  - `/status` 显示关键字、runbook 和今天回答、跳过、取材料失败的条数。
- **少 @ 一次**：见上文。
- **自然语言定时与持续委托**：
  - `@机器人 提醒我明天下午 17:00 提交发布单。`
  - `@机器人 每个工作日 18:00 汇总今天群内的开发进展并发在群里。`
- **分层协作（Leader-Worker）**：接待的 Agent 整理任务简报交给 Leader；Leader 拆只读方案并指派 Worker 改代码，最终由 Leader 验收回传原话题。前提：开启群工具；Leader 若是终端模式 Agent，机器人和该 Agent 都要是 `full-trust`，否则保存配置时会报错。

---

### 4. 接入飞书机器人

#### 方式 A：Web 控制台一键创建（推荐）
1. 打开 Web 控制台（`http://127.0.0.1:4310`），首次使用点首屏的 **「绑定飞书 Bot」**（已有机器人时这里是「管理飞书 Bot」）。
2. 在弹出的向导里选 **「新增机器人」**，找到 **「一键创建飞书机器人」**，填名称，点 **「创建机器人」**。
3. 系统复用本机已有的飞书开发者登录态（或引导扫码），通过开放平台自动创建应用、配置事件订阅与权限、发布版本并保存密钥。
4. 选择默认 Agent 和工作目录，开启监听。

#### 方式 B：CLI 接入
```bash
# 创建并接入新机器人（默认逐项审批 ask）
dutydeck lark create "研发助手" --agent ccflash --listen

# Agent 不支持飞书逐项审批时，必须显式 --full-trust，否则在扫码前就报错
dutydeck lark create "研发助手" --agent <终端模式 Agent 的 id> --full-trust --listen

# 绑定已有自建应用（Secret 从管道读）
printf %s "$LARK_SECRET" | dutydeck setup --lark-app-id cli_xxxxxxxx --lark-app-secret-fd 0 --agent claude --yes
```

“支持飞书逐项审批”的 Agent：ACP Agent，以及 Claude Code / Seed / Relay 终端模式（经 PermissionRequest hook）。其它终端模式 CLI 只能用 `full-trust`。

#### Claude Code 自定义网关与 API Key

注册第二步选择 Claude Code，展开「模型服务配置」，填写网关 URL、认证方式和 API Key，先点「保存模型配置」，再点「完成配置」。已有机器人可在默认执行设置里修改；网关模型 ID 填在「默认模型」。支持内置 Claude Code 和 `adapterId` 为 `claude` / `claude-code` 的自定义 Agent（如 ccflash），网关须兼容 Anthropic Messages API。

```bash
# 已绑定的机器人：网关密钥从管道读，不进入命令行参数
printf %s "$MODEL_API_KEY" | dutydeck settings agent set claude --app cli_xxx baseUrl=https://gateway.example authMode=bearer --api-key-fd 0
dutydeck settings bot set cli_xxx defaultAgentId=claude defaultModel=your-model-id
dutydeck settings agent show claude --app cli_xxx
dutydeck settings agent set claude --app cli_xxx clearApiKey=true
```

`bearer` 使用 Authorization Bearer，`api-key` 使用 X-Api-Key。配置按机器人和 Agent 独立保存；不带 `--app` 修改的是共享 Agent 配置。URL 需配置该作用域的 API Key 才启用；清除机器人密钥后恢复共享 Agent / CLI 连接配置。密钥保存在本机私有密钥文件中，不在 API 和 CLI 输出里回显。模型用机器人 `defaultModel`，会话明确选择的模型优先；这些设置不改变其他机器人的模型。网关设置在下次启动 Agent 进程时生效，正在运行的会话用 `/new` 重新创建。


---

## Web 工作台与自动化闭环 <a id="web-console"></a>

### 1. 任务看板与终端回放
- 任务按 **「待处理」**（等审批 / 待回答）、**「进行中」**、**「已完成」**、**「已归档」** 分层。
- 卡片显示耗时、工具调用明细和最终产物。
- **终端回放只有终端模式（`pty-cli`）Agent 才有**，最多保留 5000 行；ACP Agent 没有终端。
- 支持新指令排队，也可以「立即中断」抢占。
- 会话的交付面板里有「每轮改动」列表。
- 飞书卡片打开的只读任务详情显示来源话题、来源群聊（私聊显示来源聊天）和最初发起人，可跳回已知话题或聊天；未记录的话题和缺失的历史来源记录会明确标注，名称读取失败时显示已有 ID。

### 2. 验证与返修
- 验证门禁目前只对**飞书任务**生效，需要先给机器人配验证命令（`pnpm test`、`go test ./...` 等）。
- 任务改了代码后，服务端在工作区执行验证。结果卡显示「验证通过」「验证未通过」「验证已过期」或「未验证」。
- 失败时，截断后的报错作为下一轮返修提示发回 Agent，最多 2 轮。

### 3. 手机看改动
- 飞书结果卡的「改动 N 个文件 +A −D · 查看改动」链接 14 天有效，只能看这一轮的改动。
- 只有在 git 仓库里、由 runtime 正常执行的轮次才记录改动。仓库里没被忽略的未跟踪文件太多（单个超过 20 MiB、合计超过 50 MiB 或超过 2000 个）时不记录，结果卡上没有改动行，服务日志写原因——建议把大文件和构建目录加进 `.gitignore`。
- 「查看改动」页可以逐行评论：登录 Web 的用户提交后直接发给 Agent；只有分享链接的人提交后，会在飞书原话题出一张确认卡，有权限的人点「交给 Agent 修改」才会执行。
- 轮换分享密钥 `dutydeck auth share-key rotate` 后，已发出的链接全部失效。

### 4. 用量与成本
Web 侧栏「用量与成本」有「费用」「明细」「会话分析」三个标签；飞书里 `/status` 显示本月用量。

- **会话洞察分析器**：随 npm 包内置，构建服务时自动生成；使用 Dutydeck 当前的 Node.js 运行时，在隔离子进程中本地分析，无需 Go 编译器、外部分析器二进制或单独构建引擎。源码开发使用工作区的 `tsx` loader。指标版本升级为 `v2`：旧快照仍可读取，不同指标版本不混算差值或分组汇总；重新分析可统一版本。洞察刷新不会修改任务用量与计费记录。

- **月度上限**：美元，按机器人或按群设置。Web，或 `dutydeck settings usage set-cap <月度美元> --app <appId> [--chat <chatId>]`。
- **价格表**：内置表含 OpenAI 和 Claude 型号，按模型名最长前缀匹配；匹配不到的型号记为“未定价”，不会套默认价。用 `DUTYDECK_USAGE_PRICING_JSON` 可整表覆盖。Claude 型号只认日期后缀（`-YYYYMMDD`）和 `-latest`，所以 `claude-opus-5-6` 不会落到 `claude-opus-5` 的价格上。
- **用量来源**：ACP Agent 报多少算多少，不报成本的按价格表估算。终端模式 Claude 的用量来自 transcript，是估算；子代理用量来自 `<session>/subagents/` 下的文件。同一轮多个型号时各自按自己的单价算，任一型号没有单价，整轮记为未定价。Codex、Traex 终端模式没有用量。
- **“部分用量未知，上限可能不准”**：任一轮的用量读不到时出现，位置是 Web 上限卡片、拒绝说明和告警。什么算未知：子代理文件读不到或格式不认识、daemon 重启后恢复的那一轮、未定价的型号。
- **没有计入的加价项**：美国境内推理 1.1 倍、快速模式、Batch、1 小时缓存写、Haiku 5.5 的分档价（Haiku 5.5 记为未定价）。所以估算偏低，不是账单。
- **接口**：`GET /api/usage/report`、`GET /api/usage/tasks`，参数 `from`、`to`、`model`、`agentId`、`appId`、`origin`（`/api/usage/tasks` 另有 `limit`、`offset`）。日期按 daemon 本地时区。需要安装管理员权限。

### 5. 通用定时任务

在 Web「任务计划」中点「创建定时任务」，选择 Agent、目录和权限后保存计划；保存只创建空闲会话，不发送执行指令。也可在已有任务的「工作目录与自动化」中创建计划，沿用该任务的目录、模型、权限和上下文。新计划默认停用，启用后才定时执行。支持指定时区的一次、每天、每周、固定间隔和五段 Cron；每分钟检查一次，服务恢复后最多补一次，同一计划有未结束或结果待核对的执行时不再启动下一次。

CLI 使用同一套接口，结果为 JSON：

```bash
# 创建独立计划；不立即执行，默认 shared 目录，也可 --workspace worktree
dutydeck schedule create --agent codex --cwd /path/to/project --name 日报 --prompt '检查变更并总结' --cron '0 9 * * 1-5' --timezone Asia/Shanghai
# 或为已有任务创建计划：--session ses_xxx --every 30（分钟）或 --at 2026-12-01T09:00
dutydeck schedule list
dutydeck schedule show schedule_xxx --session ses_xxx
dutydeck schedule enable schedule_xxx --session ses_xxx
dutydeck schedule update schedule_xxx --session ses_xxx --prompt '检查构建并总结'
dutydeck schedule disable schedule_xxx --session ses_xxx
dutydeck schedule run schedule_xxx --session ses_xxx --idempotency-key daily-check-1
dutydeck schedule history schedule_xxx --session ses_xxx
dutydeck schedule delete schedule_xxx --session ses_xxx
```

「立即执行」可用于停用的计划，只跳过时间等待，仍检查执行条件与权限，不改变下一次定时；同一个幂等键始终返回原执行，脚本重试应复用 `--idempotency-key`。删除后停止后续触发并使尚未提交的任务失效，已提交的任务继续收尾，历史和结果保留。`history` 返回该计划最近 1000 条记录，按时间从新到旧排列；查询已删除计划的历史请指定 `--session`。`show --session` 可查看删除记录。用 `--input '<JSON>'` 或 `--file plan.json` 设置完整创建参数或更新补丁（含 `condition`、`dstPolicy`），`--expected-revision` 可拒绝并发修改。`--instance <id>`、`--url`、`--database` 的目标规则与 `dutydeck settings` 相同。创建新会话后若保存失败或响应丢失，CLI 会返回会话 ID；先用 `list --session <id>` 检查是否已经保存，确认不存在后再用该 `--session` 重试。

后台任务沿用选定的权限姿态；`ask` 可能等待人工审批，需要无人值守时应显式选择适当权限。计划和执行记录保存在所属运行时的数据库中，每个数据库只允许一个运行时持有执行权；Web 与机器人实例通过实例切换访问各自的计划。

### 6. 实验功能（草稿页）
“群与权限”策略页、定时任务页的导入草稿、设置里的“迁移与高级草稿”目前只保存草稿，不会生效或执行，所以默认隐藏。在「设置与接入 → 实验功能」打开“显示实验功能”后才显示。开关只保存在当前浏览器。

---

## Agent 配置与权限姿态 <a id="agent-config"></a>

Dutydeck 支持 ACP（Agent Client Protocol），也支持用 PTY 驱动已有的 CLI Agent。

### 1. 自定义 Agent (`DUTYDECK_AGENTS_JSON`)

用环境变量 `DUTYDECK_AGENTS_JSON` 注册自定义 Agent。

#### 示例：接入 Claude Code（经代理网关）
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

配套的 `ccflash.settings.json`：
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8320",
    "ANTHROPIC_AUTH_TOKEN": "your-proxy-token"
  }
}
```

> **最佳实践**：
> - 用 `--settings` 指定独立配置文件，避免多任务并发时改动全局 `~/.claude/settings.json`。
> - `command` 必须是二进制的绝对路径或 `PATH` 里的可执行程序，不能用 shell alias。
> - `command` 找不到的 Agent **不会被登记**。`dutydeck doctor` 会报 fail 并点名这个 Agent 和命令，daemon 启动日志也会告警。
> - `DUTYDECK_AGENTS_JSON` 写错（JSON 语法或字段）时，报错会点名这个变量。

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

`timeout` 以秒为单位，默认 `600`，必须能精确换算为 1–2147483647 的整数毫秒（即 `0.001`–`2147483.647` 秒）。模型目录的备用 CLI 探测使用该 Agent 实际配置的直接 CLI 可执行路径、清洗后的 `env` 和 `cwd`，只透传已支持的全局选项（带值选项须分开参数和值）。其他启动参数、等号形式或包装命令不执行备用探测，保留配置中的默认模型，不替换成宿主命令。

#### 终端任务状态与恢复

Codex 和 TraeX 终端任务按当前原生轮次的成功、失败或取消事件结算，部分回答不抵消随后出现的失败；取消记为中断。TraeX 恢复会先读完同一会话的旧日志段，再读取新段；新版 canonical 记录保留过程、输入回执和最终回答，并去除镜像重复。

TraeX 用完整终端画面区分忙碌与就绪，正文或草稿里的状态引用不作为活动页脚。Codex 支持 `›` / `»` 输入提示，信任和更新菜单不视为输入就绪。Cursor 普通输入只发一次 Enter，保留多行输入和普通任务排队；不附带空输入的第二次控制动作。

Codex 当前父轮明确启动的直接子任务若报告额度耗尽或请求限流，Web 和飞书进度记录会显示固定诊断，不展示上游错误原文。父任务继续；Dutydeck 不因该诊断自动重试或切换账号。这是有界的尽力观察，恢复前已启动的子任务不会补报；TraeX 尚未启用此诊断。

#### 终端模式 Agent 与飞书审批

- Claude Code / Seed / Relay 的终端模式支持飞书审批，`ask` 和 `approve-reads` 都可用，靠 PermissionRequest hook 实现。
- 其它终端模式 CLI 只能用 `full-trust`；用 `ask` / `approve-reads` 时，会话启动会报错并给出两条修法：`dutydeck settings bot set <appId> permissionMode=full-trust fullTrustConfirmed=true`，或换成 ACP / Claude 终端模式 Agent。
- 飞书会话里的 Claude 终端模式固定用 `default` 权限模式启动，本机 `~/.claude` 里设的 `auto` 等默认模式不生效。注意下面[已知限制](#known-limits)里的 allow 规则。

---

### 2. 权限模式 (Permission Posture)

机器人（飞书）可用 `ask`、`approve-reads`、`full-trust`。`deny-all` 不能用于飞书机器人，只能用在 Agent 配置 / Web 会话上。

| 权限模式 | 行为 | 适用 |
|---|---|---|
| `ask` | 写文件、执行命令等特权操作挂起，在飞书 / Web 推送审批。**新建机器人的默认值**，前提是所选 Agent 支持飞书审批（见上） | 日常开发 |
| `approve-reads` | 自动放行读取和搜索，写操作和命令执行需审批；访问网络不算读操作。支持 ACP 和 Claude 终端模式 | 代码审查、问题排查 |
| `deny-all` | 自动拒绝一切特权操作。不能用于飞书机器人 | 只读探索 |
| `full-trust` | 跳过所有确认，直接放行 | 隔离沙箱或无人值守流水线。所选 Agent 不支持飞书审批时，机器人只能用它，并需要确认 |

默认值按入口略有不同：`lark create` 默认 `ask`，所选 Agent 不支持审批时必须加 `--full-trust`；Web 向导里，所选 Agent 支持审批则默认 `ask`，否则默认 `full-trust`。

---

### 3. 核心环境变量一览

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `DUTYDECK_HOST` | `127.0.0.1` | 监听 IP（局域网访问设为 `0.0.0.0`） |
| `DUTYDECK_PORT` | `4310` | Web 与 API 端口 |
| `DUTYDECK_AUTH` | `true` | 非本机访问是否要求认证（填 `false` 关闭；在非回环地址关闭认证会拒绝启动，除非加 `--unsafe-no-auth`） |
| `DUTYDECK_DEFAULT_CWD` | 启动路径 | 默认工作区绝对路径 |
| `DUTYDECK_DATABASE_URL` | `<cwd>/.dutydeck/dutydeck.db` | SQLite 数据库文件路径 |
| `DUTYDECK_AGENTS_JSON` | `[]` | 自定义 Agent 注册列表 |
| `DUTYDECK_CLEANUP_INTERVAL_MS` | `300000` | 周期清理间隔，整数毫秒，范围 1–2147483647 |
| `DUTYDECK_DRIVER_IDLE_TIMEOUT_MS` | `21600000` | 空闲终端释放阈值，非负毫秒；`0` 禁用，不受周期定时器的 32 位上限限制 |
| `DUTYDECK_USAGE_PRICING_JSON` | 内置价格表 | 整表覆盖用量估算的单价 |
| `DUTYDECK_DEPLOY_WINDOW` | 不限 | `dutydeck deploy` 允许的时段，如 `10:00-11:00,16:00-17:00`（Asia/Shanghai） |
| `LARK_APP_ID` | - | 仅 `dutydeck lark send` 等命令行发卡片的备用来源 |
| `LARK_APP_SECRET` | - | 同上。机器人用 `dutydeck setup` 配置，Secret 存在机器人配置里，不需要它 |

CI 相关的令牌和 webhook 密钥**不再是环境变量**，见[插件](#plugins)。

---

## 插件 <a id="plugins"></a>

插件给 Dutydeck 加命令、Agent、skills、外部触发器、hook、CI 提供方和场景包。核心里没有任何平台专用代码，GitHub、Codebase 的 CI 能力和告警初筛都是插件。

### 目录结构

```text
my-plugin/
├── .dutydeck-plugin/plugin.json   清单（必需）
├── commands/*.md                  斜杠命令（Markdown + $ARGUMENTS 模板）
├── agents/*.json                  Agent 定义（格式同 DUTYDECK_AGENTS_JSON 的一项）
├── skills/                        skills 目录
├── triggers/<id>.json             外部触发器
├── hooks/hooks.json               hook 配置
├── scenarios/*.json               场景包
└── index.mjs                      providers 入口（CI 提供方、场景包 provider、进程内 hook）
```

`plugin.json` 用严格校验，出错会报文件名和字段。字段：

| 字段 | 说明 |
|---|---|
| `name` | 必填，kebab-case，最长 64 |
| `version`、`description` | 可选 |
| `commands` / `agents` / `skills` / `triggers` | 目录，默认 `commands/`、`agents/`、`skills/`、`triggers/`；默认路径不存在就当没有 |
| `hooks` | hook 配置文件，默认 `hooks/hooks.json` |
| `providers` | ESM 入口文件，没有默认值 |
| `scenarios` | 场景包目录，默认 `scenarios/`；默认路径不存在就当没有 |
| `userConfig` | `{ <snake_case 键>: { description, sensitive? } }`，插件的配置项 |

路径必须在插件目录内；显式声明了但不存在算错误。

### 七类组件

| 组件 | 作用 | 需要信任确认 |
|---|---|---|
| commands | 把 `/<name>` 换成 prompt 模板，`$ARGUMENTS` 替换为参数。`/<插件名>:<name>` 总能用；没有重名时 `/<name>` 也可用。与内置命令同名会被拒绝；`compact`、`clear`、`init`、`review` 等 Agent 自带命令名只能用 `/<插件名>:<name>` | 否 |
| agents | 注册 Agent，先于 `DUTYDECK_AGENTS_JSON` 合并，同 id 以环境变量为准，不能替换内置 Agent。带来源标记：插件停用或卸载并重启后随之移除 | **是** |
| skills | 作为一个 skills 根目录加载 | 否 |
| triggers | 外部系统通过 HTTP 触发一次任务（见下） | 否 |
| hooks | 在任务生命周期的几个点执行你的命令（见下） | **是**（按事件分别确认，如 `hooks:task.received`） |
| providers | 入口模块导出 `register(api)`，注册 CI 提供方、场景包 provider 或进程内 hook；最多等 15 秒，超时只跳过这个插件 | **是** |
| scenarios | 场景包：群里出现某类消息时按包里写好的规则处理（见[怎么写场景包](#scenario-packs)）。包本身是 JSON，不执行代码；它引用的 provider 随 providers 一起确认 | 否 |

### 信任确认

agents、hooks、providers 会执行代码或命令，安装时要确认。daemon 只加载**已启用、且所有需确认能力都已确认**的插件。

- 交互终端里会列出能力并询问；非交互环境必须加 `--yes`，否则拒绝并列出要确认的能力。
- `plugin update` 时只有**新增**的能力才重新确认；同一能力下 hook 命令变了不会再问。
- npm 来源打包时不执行 prepare 等脚本（`--ignore-scripts`），避免确认前就跑插件代码。

### 作用域

`--scope` 决定插件在哪里生效：

- `global`（默认）：处处生效。
- `bot:<appId>`：只对这个机器人的会话生效；触发器的目标机器人也必须是它。Web 会话没有机器人，所以 bot 作用域的命令、skills、hooks 在 Web 里不生效。
- `workspace:<绝对路径>`：会话工作目录在该路径下才生效。
- agents 不受作用域限制，全局合并。

### 内置插件 <a id="builtin-plugins"></a>

随 Dutydeck 发布的插件在 `builtin-plugins/`（打包后在 `dist/builtin-plugins`）。daemon 先加载它们，再加载已安装的插件。现在只有一个：`alarm`，提供告警初筛和同一告警规则的关联，群里怎么用见[群聊协作机制](#lark-guide)。

- 免信任确认，作用域固定为 `global`，一直启用，不能卸载。`plugin list` 里标「内置」。
- 外部插件不能和内置插件同名，安装时会被拒绝；已装的同名插件不会加载，`plugin list` 和 `doctor` 会提示。
- 外部插件里和内置场景包 id 相同的包会被跳过（插件其余部分照常加载），免得接过群里已经确认的绑定。

### CLI

```bash
dutydeck plugin install <来源> [--scope global|bot:<appId>|workspace:<路径>] [--yes] [--json]
dutydeck plugin list [--json]
dutydeck plugin validate <目录>
dutydeck plugin init <名字> [--dir <目录>]
dutydeck plugin config <插件> <键> --value <值>          # 非敏感值
printf %s "$SECRET" | dutydeck plugin config <插件> <键> --value-fd 0   # 敏感值只能这样传
dutydeck plugin trigger-token <插件>/<触发器> [--rotate]
dutydeck plugin update [名字] [--yes]
dutydeck plugin enable <名字>
dutydeck plugin disable <名字>
dutydeck plugin uninstall <名字>
```

- `<来源>`：本地目录、`git+https://…`、`git@…`、`file://…`（`#ref` 固定分支、标签或提交）、`npm:包名@版本`。git 来源按提交 SHA 固定。
- 插件的增删改、启停都要 `dutydeck restart` 后才生效。
- `plugin validate` 也校验场景包（格式、模板变量、正则、参数），出错报文件和字段；`install`、`update` 不因场景包的问题失败，但会列出不会加载的包和原因。
- 数据放在数据库所在目录的 `plugins/` 下：`plugins.lock.json`（来源、固定版本、作用域、已确认能力）、`<名字>/`（安装副本）、`.data/<名字>/`（插件自己的可写目录）。`.trigger-tokens.json` 和 `.config.json` 权限 0600；敏感配置存在本机密钥存储里。

### 外部触发器

触发器让外部系统（监控、CI、脚本）发一个 HTTP 请求，在指定机器人的指定群里开一个任务。仓库里有可运行的示例 `examples/plugins/hello`。

`triggers/<id>.json`：

```json
{
  "auth": { "type": "token", "header": "x-dutydeck-token" },
  "target": { "botAppId": "{{config.bot_app_id}}", "chatId": "{{config.chat_id}}", "session": "new" },
  "prompt": "外部系统发来一条 ping，请简短回复并复述其中的消息：\n{{payload.message}}",
  "dedupeKey": "{{payload.id}}",
  "maxConcurrent": 2
}
```

- 地址：`POST /api/plugins/<插件>/triggers/<id>`，免 Web 登录，靠触发器自己的令牌或签名鉴权。
- 鉴权：`token`（请求头里带令牌，可带 `Bearer ` 前缀）或 `hmac-sha256`（`header` 必填，对原始请求体算 HMAC，十六进制，可带 `sha256=` 前缀）。令牌用 `dutydeck plugin trigger-token <插件>/<id>` 查看或 `--rotate` 轮换，轮换立即生效。
- `target` 的值可以写 `{{config.<键>}}`，引用插件配置；配置没填齐时触发器不可用。`session` 为 `new`（每次新会话）或 `reuse`。
- 返回码：`202 {sessionId, taskId}` 已接受；`200 {duplicate:true}` 重复事件；`400` 请求体不是 JSON；`401` 令牌或签名不对（不区分原因）；`404` 触发器不存在或插件未启用；`413` 请求体超过 1 MiB；`429` 达到 `maxConcurrent`；`502` 投递失败（同时撤销去重记录，可重试）。
- 去重 24 小时，重启后仍有效；去重键是 `dedupeKey` 渲染结果，没写就用整个请求体。`maxConcurrent` 默认 4，范围 1 到 32。
- 模板里 `{{payload.a.b}}` 取请求体字段，`{{payload}}` 取整个请求体。进入 prompt 的每个取值都被当作**不可信数据**包裹（带随机边界，单个取值最多 2 万字符）。模板读不到鉴权头、`authorization` 和 `cookie`。
- 任务结果以文本发回目标群，最多 8000 字符。

```bash
dutydeck plugin install examples/plugins/hello --yes
dutydeck plugin config hello bot_app_id --value cli_xxx
dutydeck plugin config hello chat_id --value oc_xxx
dutydeck plugin trigger-token hello/ping        # 记下令牌
dutydeck restart
curl -X POST http://127.0.0.1:4310/api/plugins/hello/triggers/ping \
  -H 'content-type: application/json' -H "x-dutydeck-token: $TOKEN" \
  -d '{"id":"1","message":"hi"}'
```

### Hook 协议

`hooks/hooks.json` 按事件列出命令：

```json
{
  "task.received": [
    { "command": ["node", "hooks/log-event.mjs"], "timeout": 5000 }
  ]
}
```

- `command`：字符串走 `/bin/sh -c`，数组直接执行；工作目录是插件根目录。`timeout` 必填，100 到 600000 毫秒。`onFailure` 为 `ignore`（默认）或 `block`。`matcher` 是可选正则（匹配对象见下表），安装时会检查不会灾难性回溯。
- **输入**：stdin 收到一份 JSON：`{ event, plugin, botAppId?, chatId?, sessionId?, taskId?, cwd?, payload }`。
- **环境变量**：继承 daemon 的全部环境变量（可能含飞书 App Secret、令牌等，写 hook 时要注意），另加 `DUTYDECK_PLUGIN_NAME`、`DUTYDECK_PLUGIN_ROOT`、`DUTYDECK_PLUGIN_DATA`、`DUTYDECK_PLUGIN_CONFIG_<KEY>`（含敏感值）、`DUTYDECK_HOOK_EVENT`。
- **输出**：exit 0 放行，stdout 可以是 JSON：`decision`（`allow` / `deny` / `ask`）、`reason`、`additionalContext`、`updatedPrompt`。exit 2 阻断，stderr 作为原因。其他非零退出码或超时是非阻断错误；`onFailure: block` 时改为阻断。超时会杀掉整个进程组并立即返回。stdout 上限 64 KiB，超出按“没有输出”处理；stderr 上限 8 KiB。
- **顺序**：按插件名排序，再按声明顺序。`deny` 立即生效并结束；其余按 `ask` 优于 `allow` 合并。

| 事件 | 触发点 | payload | `matcher` 匹配 | 哪些输出生效 |
|---|---|---|---|---|
| `task.received` | 任务进入（Web、飞书、自动化、触发器都经过） | source, namespace, key, prompt, mode, actor | 会话 source | `deny` 拒收任务（403 `PLUGIN_HOOK_DENIED`） |
| `task.beforeRun` | 任务开始前，skills 处理之后、prompt 冻结之前 | source, prompt, skills | 会话 source | `deny` 拒收；`additionalContext` 追加；`updatedPrompt` 替换 |
| `permission.request` | 审批发出之前 | 完整的权限请求 | 请求标题 | `allow` / `deny` 直接代为决定、不再出人工审批；其他结果照常走人工审批 |
| `task.completed` | 任务结算后，异步 | status, prompt, source；顶层带 taskId | status | 无 |
| `verification.completed` | 验证跑完后，异步 | 验证结果，加 source | status | 无 |
| `notify` | CI 通知和触发器结果发出之前 | `ci_notice`（title, text, failed）或 `trigger_result`（taskId, status, text） | kind | `deny` 时不发 |

群协作的判定、回复生成和记忆整理这三类后台会话也经过 `task.received` 和 `task.beforeRun`，输入带所属机器人的 `botAppId`，`bot:<appId>` 作用域的 hook 对它们生效；记忆整理会话不带 `chatId`。对这三类会话，`task.beforeRun` 只认 `deny`，`additionalContext` 和 `updatedPrompt` 会被忽略并记一条警告日志；`permission.request` 也只认 `deny`，`allow` 会被忽略并记警告日志，审批照常走原流程（不论插件作用域）。这三类会话结算时的 `task.completed`（以及适用时的 `verification.completed`）同样带 `botAppId`，bot 作用域的 hook 也会收到，可以用 payload 里的 `source`（`lark-decision`、`lark-response`、`lark-memory`）区分。

目前 `notify` 只覆盖 CI 通知和触发器结果，飞书任务结果卡的推送不经过它。

### CI 提供方

核心里 `/ci`、自动续作、Web「等待 CI 完成」、定时任务条件、`POST /api/hooks/<提供方 id>` 都经 CI 提供方插件。**没装任何 CI 插件时**：飞书 `/ci` 回“未配置”并给出安装方法；Web 显示“未安装 CI 插件”；普通定时任务不受影响。

提供方在 `providers` 入口里调用 `api.registerCiProvider(provider)` 注册。接口（类型见 `packages/shared/src/plugins.ts`）：

- `id`、`displayName`（必填，出现在卡片、提示词和 Web 上）、可选 `changeRequestLabel(n)`；
- `matchRepository(remoteUrl)`：远端地址归自己就返回仓库（`{owner, name, slug}`），否则返回 `undefined`；
- `getPipelineStatus(query)`（轮询用）、`getFailureLogs(repository, runId)`（补失败日志）；
- 可选 PR 方法，`/pr` 和 Web「开 PR」会实际用到：`createPullRequest`（开 PR）、`listReviewComments`（读评审意见）、`postComment`（回复），以及 `getPullRequest(repository, number)`，返回 `{ state: 'open' | 'closed' | 'merged', headSha? }`，用来发现 PR 已合并或关闭。没实现 `getPullRequest` 的插件只能靠 webhook 的 merge_request 事件发现合并或关闭；两者都没有时，跟进会一直轮询，直到达到轮次上限或有人手动停止。`listReviewComments` 返回的每条 `CiReviewComment` 带 `trusted`、`isBot`、`authorAssociation`：**不给 `trusted: true` 的评论不会被自动处理**，只会发“需要你决定”卡片。github 插件的判定是 `author_association` 为 OWNER、MEMBER、COLLABORATOR 之一且不是 Bot 账号。`postComment` 返回的 `id` 要和 `listReviewComments` 里同一条评论的 `id` 写法一致，否则会把自己的回复当成新评论；
- 可选 `webhook: { verify(req), parse(req) }`：`verify` 可返回 `signedAt`（宿主据此做 5 分钟重放窗口）；`parse` 返回统一的 `CiWebhookEvent`，请求体有问题时抛出 `statusCode: 400`。事件里 `timeIsAdvisory: true` 表示 `occurredAt` 只用于排序，不做重放窗口检查。缺哪个可选方法，对应能力就不可用。

仓库自带两个 CI 插件（从源码检出目录安装；npm 发布包里不带它们）：

| 插件 | 提供 | 配置项（都是敏感值，用 `--value-fd`） |
|---|---|---|
| `plugins/github` | GitHub Actions 构建状态与失败日志（取失败 job 和步骤，日志末尾 3000 字符）；PR 创建、状态读取、评论读写（供 `/pr` 和 Web「开 PR」使用）；可选 webhook `POST /api/hooks/github`（`X-Hub-Signature-256`） | `github.token`（可选，私有仓库和 PR 操作需要；公开仓库只等构建时不用）、`github.webhook_secret`（可选，填了才启用 webhook） |
| `plugins/codebase` | 字节 Codebase 的流水线和 MR webhook `POST /api/hooks/codebase`；也是给内部平台写 CI 插件的示例 | `codebase.webhook_secret` |

```bash
dutydeck plugin install ./plugins/github --yes
printf %s "$TOKEN"  | dutydeck plugin config github token --value-fd 0
printf %s "$SECRET" | dutydeck plugin config github webhook_secret --value-fd 0
dutydeck restart
```

开 PR 需要 `github.token`（写操作必须有令牌），令牌要有 pull requests 读写权限；读私有仓库的 Actions 构建另需 Actions 读权限。推送本身不用这个令牌，用本机 git 凭据。签名、令牌、`X-Dutydeck-Event-Id` 等细节见各插件目录下的 `README.md`。GitHub 没配 webhook 时用轮询等构建；配了之后 `/ci wait`、`/ci fix` 改为等 GitHub 推送。

相关变化：

- 定时任务里“CI 出现新的失败构建时执行”的条件名是 `ci_new_failure`；旧的 `github_new_failure` 仍可读、仍可传入。
- `GET /api/sessions/:id/automation/ci-providers` 返回已加载的 CI 提供方列表。
- 飞书 `/ci` 只要装了任一 CI 插件就可用；装了 github 插件但没填 token 时，公开仓库也能等构建。
- `/pr` 只要有实现了 `createPullRequest` 的 CI 插件就可用。webhook 型插件的 merge_request 合并或关闭事件会让 PR 跟进立即停止，pipeline 事件会立即触发一次检查。

### 怎么写场景包 <a id="scenario-packs"></a>

场景包让机器人在群里遇到某类消息时按写好的规则处理，例如来源机器人发告警就起初筛任务。一个包是插件 `scenarios/` 目录下的一个 JSON 文件，格式和每个字段的限制以 `packages/shared/src/scenarios.ts` 的 schema 为准。例子：`builtin-plugins/alarm`（`direct` 模式，带关联 provider）和 `plugins/team-faq`（`model` 模式，带上下文 provider）。

包里写的是：参数（群里开启时确认、Web 上可改，类型有 `integer`、`string_list`、`bot_list`）、触发条件、执行指令、群里开关的说法和确认卡文案、`/status` 的一行、「为什么没回」的说明、Web 上的说明。包 id 是 kebab-case，最长 32。

包的 `version` 用 semver。大版本不变时，群里已有的绑定照常生效，包新增的参数按包里的默认值算；大版本变了，已有绑定要在群里重新确认，升级前发出的开启确认卡也失效，要重新说一次。

**两种模式**

- `direct`：只由机器人消息触发。命中后不调判定模型，按去重和每小时上限决定起不起任务，起任务时以群里确认过的人的名义走和 @ 机器人相同的路径。下面这些是强制契约，包里省略了只会得到默认值，不会变成不限：
  - 只处理 `trigger.sourceBotsParam` 指定的那个参数里列出的来源机器人（`bot_list`，`role: "source"`），排除本机器人自己；包里别的 `role: "source"` 参数只让这些机器人不算群里会接话的机器人，不触发；
  - 必须有确认人：开启只能在群里点确认卡完成，Web 只能改已确认过的绑定。所以包里必须写开关短语 `phrases`（`enable`、`disable` 都不能为空），没写的包校验不通过；
  - `trigger.filter.keywordsAnyParam` 指向一个 `string_list` 参数，正文不含其中任一关键字的消息记为级别不符、不起任务；参数为空时不过滤。`trigger.filter` 只用于 `direct`，`model` 包写了校验不通过，`model` 用 `trigger.match` 选消息；
  - 去重：`dedupe` 用核心的 `source_text_v1`（来源加正文，去掉链接、数字、长十六进制串和空白后比较，时间、数值、实例号变了仍算同一条）或包自己的 provider；去重窗口参数 1–168 小时，每小时上限参数 1–30；
  - 多机器人群里只由接话人处理；每条消息的结论（起了、级别不符、重复、超上限、不是接话人、缺确认人、出错弃权）都记一条，「为什么没回」能查到。
- `model`：由真人消息触发，只在 `按需` 和 `积极` 档生效，@ 机器人或回复机器人的消息不走包。命中后交给参与判定模型，包提供判定指引和上下文：
  - 判定时，指引写在判定 prompt 里，包的上下文（provider 的 `context`）作为不可信材料附上，最多 `decisionChars` 字；判定为接时，回复或任务用同一份上下文（最多 `maxChars` 字）和 `execution.instruction`，不会再调一次 provider。
  - 命中的包算这个机器人的负责范围：没配负责范围、也不是接话人时，按需档也能接这类消息。反过来，命中的消息也按范围判断：积极档「默认都接」、单真人群「默认接」对它不再直接生效，按包的指引不该接的会不接（例如团队答疑里命中关键字但 runbook 没覆盖的问题）。指引只说明什么时候该接，不能放宽核心规则。
  - 多个 `model` 包命中同一条消息时，按包 id 排序只用第一个。
  - 判定后、发出回复或起任务前，会再查一次本群这个包是否仍开着，关了就不发。
  - 群里开启不需要确认人，可以直接在 Web 或 `scenarios=` 里开；群里的开关说法会发一张确认卡，卡上没有参数要填。

包里可以写 `topicOwnership: { "sourceTopics": "neutral" }`（目前 `alarm` 用）：多机器人群里，来源机器人发的消息开出的话题不算别的机器人的话题；只有读到别的机器人已在话题里发过言、或者话题读不完、读取失败时才让路。这不保证只有一个机器人接。

**provider 与信任**

包可以引用插件在 `register(api)` 里用 `api.registerScenarioProvider(provider)` 注册的 provider：`match`（补充匹配或给去重键）、`correlationKey`（关联上一轮用的键）、`context`（`model` 模式的上下文）。provider 是插件代码，安装时随 `providers` 一起确认。每次调用都有截止时间（`match` 500 毫秒，一轮关联合计 1 秒，`context` 默认 5 秒、最多 15 秒），超时的结果丢弃。引用的 provider 没注册时整个包跳过。

**正则**

触发和群里开关说法里的正则只允许 `i`、`m`、`s`、`u` 标志（取全部匹配由宿主加 `g`），源码最长 1000 字符。正则在宿主的隔离线程里执行，单次 200 毫秒，输入最多取前 4000 字符。`validate` 对可能灾难性回溯的写法只给提示，安全靠隔离执行和超时。

**模板变量**

文案里可以写 `{变量}` 和一层条件 `{变量?有值时:为空时}`。每个位置能用的变量是固定的，写了别的变量校验不通过：

| 位置 | 可用变量 |
|---|---|
| `execution.instruction`、`execution.intro` | `{source}`（来源机器人名字，`model` 模式的 instruction 不能用变量） |
| `correlation.prompt` | `{date}` |
| `correlation.cardLine` | `{date}`、`{headline}`、`{url}` |
| `confirm.enableSummary`、`disableSummary`、`enabledResult` | `{summary}` 和各参数 |
| `status.summary` | 各参数 |
| `explain.*` | `{time}`、`{reason}`、`{snippet}` |
| `web.description` | `{requesterId}` 和各参数 |

标题、名词、判定指引、参数说明、`reasons` 等是字面文字，不能写变量。消息正文和模型输出不会插进任何指令位置：来源消息原文和上一轮结论都作为不可信材料跟在指令后面，来源机器人的名字插进模板前会去掉换行和括号类字符。

**出错时**

包的 JSON 校验不过时跳过这个包，插件其余部分照常加载，`plugin list` 和 `doctor` 会列出原因；引用的 provider 没注册、包 id 冲突时也跳过这个包，原因写在 daemon 日志里。运行时正则或 provider 出错、超时，这条消息这个包弃权：`direct` 记一条弃权记录，不起任务；`model` 的上下文 provider 超时、出错、返回格式不对，或者一条材料都没有而 `missing` 不为空时，这条消息按没有这个包重新判定，判定记录里记下原因，`/status` 计入「取材料失败」，「为什么没回」会说明。同一条消息命中多个 `direct` 包时，按包 id 排序只处理第一个。

### 升级说明：CI 环境变量迁移到插件

以前用环境变量配 CI 的部署，**升级后这些变量不再生效**：`DUTYDECK_GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN`、`DUTYDECK_CODEBASE_WEBHOOK_SECRET`。升级后要：

1. `dutydeck plugin install ./plugins/github --yes`（或 `./plugins/codebase`）；
2. 用 `dutydeck plugin config … --value-fd 0` 填回令牌或 webhook 密钥（对应 `github.token`、`github.webhook_secret`、`codebase.webhook_secret`）；
3. `dutydeck restart`。

不这样做的话：旧的等待订阅和 `github_new_failure` 定时条件不再生效，Web 显示“未安装 CI 插件”，`/api/hooks/codebase` 返回 404（现在由 codebase 插件提供，需要装插件）。旧订阅数据仍可读，缺 provider 字段的旧订阅按 GitHub 处理。不做自动迁移。

### 安全说明

- 只装可信来源的插件。agents、hooks、providers 会在你的机器上执行命令，安装时的确认不是形式。
- hook 子进程继承 daemon 的全部环境变量，可能包含飞书 App Secret、GitHub token 等。
- **触发器地址只走 HTTPS 或内网。** token / HMAC 鉴权不带时间戳，被截获的请求在 24 小时去重过期后可以重放。
- 触发器的 prompt 模板把外部数据当不可信内容包裹，但这只降低提示词注入的风险，不能保证 Agent 不被诱导。触发出来的会话沿用机器人的权限模式，别给面向外部的触发器配 `full-trust` 机器人。
- git 来源用提交 SHA 固定；`plugin update` 新增能力会重新确认。
- 触发出来的会话若机器人是 `ask` 模式，审批卡可能只在 Web 上出现，飞书侧不一定有（未验证）。

---

## CLI 与运维速查 <a id="cli-reference"></a>

### 1. 守护进程日常管理

```bash
# 启动后台守护进程
dutydeck start [--cwd /path] [--port 4310] [--host 0.0.0.0]

# 查看服务状态
dutydeck status

# 平滑重启（先排空正在执行的任务）
dutydeck restart

# 停止守护进程
dutydeck stop

# 更新全局 Dutydeck 包并自动重启
dutydeck update

# 一键诊断（端口、SQLite、Agent 可执行性与默认 Agent、飞书监听等）
dutydeck doctor
```

### 2. 版本发布与部署 (`deploy`)

```bash
# 把构建好的检出目录发布为不可变版本：排空 → 切换 releases/current → 重启 → 健康检查；失败时按条件回滚
dutydeck deploy --source /path/to/checkout

# 先看会删什么、能释放多少空间，再清理旧版本和旧部署记录
dutydeck deploy prune --releases /path/to/releases --dry-run
dutydeck deploy prune --releases /path/to/releases
```

- **部署窗口**：环境变量 `DUTYDECK_DEPLOY_WINDOW`（如 `10:00-11:00,16:00-17:00`）限制部署时段，窗口外加 `--now` 才部署。
- **回滚**：健康检查不过时，停服务并确认数据库 schema 没变才切回上一版；schema 变了就停止自动回滚，保护数据，不会恢复旧数据库快照。
- **自动清理**：每次部署成功后保留最新 5 个发布目录和部署记录（含数据库备份）。`current`、它的上一版和仍被运行中进程引用的版本永远保留；清理失败只告警，不影响部署结果。
- **手动清理** `deploy prune`：选项 `--releases/--runtime/--unit`、`--keep N`（默认 5）、`--dry-run`、`--include-unmarked`、`--json`。手工部署留下的记录（没有 `created_by: dutydeck deploy` 标记）默认不动，只有加 `--include-unmarked` 才会清，并且仍被进程引用或 1 小时内改过的会跳过。最近 1 小时内改过的 `.partial` 目录同样跳过（可能是正在进行的部署）。
- **单 Bot 独立进程**：`dutydeck start --foreground --database /path/to/bot.db --bot-app-id cli_xxx`。

### 3. 开机自启 (`autostart`)

```bash
dutydeck autostart enable   # 注册开机自启（Linux systemd --user / macOS launchd）
dutydeck autostart status   # 查看自启状态
dutydeck autostart disable  # 关闭自启
```

### 4. 命令行管理配置 (`dutydeck settings`)

Web 控制台里的机器人设置、群聊策略和用量上限，都可以用命令行改，方便脚本化和让 Agent 自己管理配置：

| 控制台模块 | CLI 命令 |
|---|---|
| 机器人设置 | `dutydeck settings bot list / show / set / add / remove / install-hook` |
| 群聊协作策略 | `dutydeck settings group list / show / set / members / sync` |
| 月度用量上限 | `dutydeck settings usage show / set-cap / remove-cap` |
| 主终端后端 | `dutydeck settings terminal-backend [tmux\|herdr]` |
| 工作区分组 | `dutydeck workspace-groups` |

```bash
dutydeck settings bot show cli_xxx                           # 查看机器人全部配置
dutydeck settings bot set cli_xxx adhdMode=true              # 开启 ADHD 友好模式
dutydeck settings bot set cli_xxx notifyQuietHours=22:00-08:00
dutydeck settings group set oc_xxx participation=selective   # 设置群聊按需参与
dutydeck settings usage set-cap 50 --app cli_xxx             # 设置月度用量上限（美元）
dutydeck settings group set oc_xxx 'scenarios={"alarm":{"enabled":true,"params":{"levels":["P0","P1"]}}}'  # 改告警初筛的级别
```

群里的场景包用 `scenarios={"<包 id>":{"enabled":true|false,"params":{...}}}` 改，`params` 只写要改的键，`{"<包 id>":null}` 删掉这个包的绑定；`group show` 列出本群可用的包、参数和当前绑定。`direct` 模式的包（如告警初筛）要先在群里点确认卡开启过一次，之后才能用命令行或 Web 改。旧的 `alarm=<JSON>`（平铺的告警订阅）作为弃用别名保留一个版本，会转成 `scenarios.alarm`，输出里带弃用提示。

机器人自动欢迎默认开启。设置 `welcomeEnabled=false` 可关闭入群和首次私聊欢迎；保存后立即生效，不改变用户消息处理。需要群里只在被 @ 时回复时，同时使用 `mentionPolicy=always` 和 `defaultGroupParticipation=off`。

```bash
dutydeck settings bot set cli_xxx welcomeEnabled=false
```

飞书事件可按应用注册多个 HTTP 处理器，按数组顺序依次调用。当前支持卡片点击 `card.action.trigger` 和消息接收 `im.message.receive_v1`：

```bash
dutydeck settings bot set cli_xxx 'eventHandlers=[{"id":"observer","eventTypes":["card.action.trigger"],"url":"https://receiver.example/events","token":"<观察服务令牌>"},{"id":"buttons","eventTypes":["card.action.trigger"],"owner":"sample-service","legacyActions":["ack"],"url":"http://127.0.0.1:14432/events","token":"<接收服务令牌>"}]'
dutydeck settings bot set cli_xxx 'eventHandlers=[{"id":"messages","eventTypes":["im.message.receive_v1"],"url":"https://receiver.example/messages","token":"<接收服务令牌>"}]'
dutydeck settings bot set cli_xxx eventHandlers=null  # 关闭；[] 也可清空
```

每项包含唯一且稳定的 `id`（1–64 位字母、数字、点、下划线或连字符）、非空 `eventTypes`、`url` 和 `token`。卡片处理器可加 `owner`，匹配 `action.value.owner`；`legacyActions` 只匹配没有 owner 的旧卡片，不能包含 Dutydeck 内置动作。没有这两个筛选字段时，匹配全部非内置卡片。消息处理器收到应用订阅接入的全部消息事件，包括尚未经过聊天白名单或群权限检查的消息；接收服务自行授权业务动作。包含消息事件的处理器不能配置卡片筛选字段；处理两类事件且不筛选时可在同一项列出两个事件类型。

Dutydeck 发出 `POST`，带 `Authorization: Bearer <token>` 和 `Content-Type: application/json`：

```json
{"version":1,"app_id":"<连接配置中的 App ID>","handler_id":"buttons","event_type":"card.action.trigger","event":{"event_id":"<平台事件 ID>","operator":{},"context":{},"action":{}}}
```

`event` 是完整的 SDK 事件，保留 event_id、operator、context、action、token 以及消息内容等原字段；示例仅展示部分字段。顶层 `app_id` 来自可信连接配置，`handler_id` 来自注册项。接收服务返回 HTTP 200 或 202，JSON 必须包含同一 `event_id` 和 `decision`：

```json
{"event_id":"<同一事件 ID>","decision":"continue"}
{"event_id":"<同一事件 ID>","decision":"stop","toast":{"type":"success","content":"已受理。"}}
```

`continue` 才会调用下一个匹配项，全部继续后进入原有内置处理和权限检查；`stop` 立即停止，消息也不会触发欢迎卡。202 只表示传播决定已经确定，不代表业务已完成。`toast` 可选，类型只允许 `success`、`info`、`warning`、`error`，content 必须是非空字符串；只有卡片 stop 的 toast 会回给用户。接收服务执行业务副作用时须在回执前持久受理，并以 `app_id + handler_id + event_id` 去重，重复事件返回原传播决定。

整个外部处理链共用 2 秒预算，包含所有请求和回执正文读取。错误、超时、重定向或无效回执都会停止后续处理；卡片显示失败或结果待确认，消息回调抛出失败交给 SDK。没有后台重试或新增持久队列；平台再次投递时接收服务仍须幂等。内置 `task_id`、`taskId`、`dutydeck_*` 和兼容的 `dockmux_workflow` 卡片完全跳过外部处理器，保留原有去重与鉴权；启用卡片处理器时，owner 与内置标记混合或没有匹配接收项的外部 owner 会被拒绝。只注册消息处理器时卡片维持原处理。

注册数组整体替换，省略 `eventHandlers` 的保存保留原数组；公开 API 和 CLI 不返回 token。编辑、排序时，相同 id 省略 token 会沿用原令牌；新增 id 或修改 URL 时必须显式提供 token。URL 只允许 HTTPS 或本机 HTTP（`127.0.0.1`、`localhost`、`[::1]`），禁止 URL 用户信息、fragment 和重定向。存储的注册项无效时，公开配置显示不含密钥的 `eventHandlersError`，该机器人不能启动监听；原始配置保留，必须明确替换合法数组或提交 null 才能修改该机器人。

旧 `cardActionForwarding` 配置仍由同一事件链内部兼容：请求保持 `{"version":1,"app_id":"<可信 App ID>","event":<完整 SDK 事件>}`，接收端落库后返回 `202 {"status":"accepted","event_id":"<同一事件 ID>"}`，重复返回 `200 {"status":"duplicate","event_id":"<同一事件 ID>"}`，两种回执均停止传播。旧配置与非空 `eventHandlers` 不能同时启用。接收端增加 `decision:"stop"` 后，可用一次保存原子迁移：

```bash
dutydeck settings bot set cli_xxx cardActionForwarding=null 'eventHandlers=[{"id":"buttons","eventTypes":["card.action.trigger"],"owner":"sample-service","legacyActions":["ack"],"url":"http://127.0.0.1:14432/events","token":"<原接收服务令牌>"}]'
```

旧客户端忽略增加的 decision 字段；旧配置损坏时仍显示 `cardActionForwardingError`，需明确修复或清除旧字段。

### 5. 终端后端与 Herdr 侧边子任务空间

- **主终端后端**：在 `tmux`（默认）与 `Herdr`（Linux，>= 0.9.0）之间选择，设置后新建的 `pty-cli` 会话生效。
- **Herdr 侧边空间**：主 Agent 可通过环境注入的 `$dutydeck_herdr_command` 派发并行子任务。每个会话有专属 named session，可在侧边 pane 运行命令、抓日志，不阻塞主任务。

### 6. 远程访问与安全策略

- Dutydeck 默认只监听 `127.0.0.1`。
- 局域网访问：启动时指定 `--host 0.0.0.0`。非本机访问需要认证：**浏览器用访问密码登录**，先设置 `dutydeck auth password set`（或 `--generate` 生成随机密码）；**CLI、脚本和 API 用 access token**：
  ```bash
  dutydeck auth token          # 查看当前 Token（首次使用自动生成）
  dutydeck auth token --rotate # 生成新 Token，旧的立即失效
  ```
- 不要在非本机地址上用 `--no-auth`：外部人员可能借 Agent 在宿主机上执行命令。在非回环地址关闭认证会拒绝启动，除非显式加 `--unsafe-no-auth`。
- **凭据保护**：机器人对外开放后，防止群里其他人借 Agent 套出本机的令牌、密钥和 Agent 会话记录。跟随机器人设置里的「风险控制」，只约束不在「高危操作允许名单」里的发送人和其他机器人；名单里的人照常使用，完全信任模式也不受影响。
  - 约束提示：给 Agent 加一条规则，不读取、复制、输出或发送凭据和 Agent 会话记录（如 `~/.claude`、`~/.claude.json`、`~/.codex`），被要求时一句话拒绝。
  - 强制拦截：另外在工具调用前检查，拦下读写凭据文件和会话记录（如 `~/.codex/auth.json`、`~/.ssh` 私钥、`.env`）、打印环境变量里的密钥这类操作，命令不会执行，Agent 收到拦截原因。Claude Code（终端和 ACP）和完全信任模式的 Codex 终端，这个检查随启动参数传给本次启动的 Agent，不改 `~/.claude`、`~/.codex` 下的全局配置；Codex 走 ACP 时由工作区里的拦截 Hook 检查。
  - Claude Code 终端（包括 adapter 为 `claude-code` 的自定义 Agent，如 ccflash）和经 Dutydeck 启动的 ACP Claude，这个检查同时管高危操作正则，开强制拦截不用装工作区 Hook。自定义的 ACP Claude 要用随版本发布的 `dist/agents/claude-acp.mjs` 启动，自己拷贝出去的旧版本不带这个检查。
  - 任何模式下，飞书卡片、结果和群工具发出的消息都会把常见格式的密钥（如 `sk-ant-`、`ghp_`、JWT）和服务、Agent 环境变量里的密钥值替换成 `[REDACTED]`。

---

## 升级说明

- **工作项历史**：升级时自动建立调度索引，已完成且交付结束的记录不再进入每秒扫描；历史仍可查看，未交付结果继续重试。
- **断线与停止恢复**：跨实例实时流断开后可重新连接；服务关闭会回收代理连接和建连中的飞书监听。终端首次停止失败后可再次尝试回收进程。
- **后台任务**：空白回答不再阻塞后续记忆提取；群通知按完整一小时窗口计算额度；cron 修复跨年闰日和夏令时重复时段。已启用的周期计划缺失下次执行时间时自动补算，已结束的单次计划不会重新执行。
- **Web 任务状态**：补回遗漏事件时同时刷新任务状态，避免历史已更新而任务列表仍显示旧结果。
- **GitHub 读取边界**：PR 普通评论和行内评论支持分页，两类合计最多 100 页、8 MiB；超出时整次读取报错，不返回部分评论。单个 JSON 响应最多 2 MiB，单个日志实际下载最多 8 MiB，超限会取消读取；日志超限时仍返回失败任务和步骤摘要，但不附日志。
- **CLI 启动**：减少 `secret` 等本地管理命令的启动开销。
- **CI 环境变量迁移到插件**：见[插件 → 升级说明](#plugins)。`DUTYDECK_GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN`、`DUTYDECK_CODEBASE_WEBHOOK_SECRET` 不再生效，要装插件、用 `dutydeck plugin config … --value-fd 0` 填值并重启。
- **告警初筛改为内置场景包 `alarm`**：群里的说法、确认卡、来源、级别、去重和每小时上限不变；已有订阅在升级时自动转成 `alarm` 包的绑定，升级前发出的确认卡照常能点。变化有三处：初筛任务的 prompt 里告警原文改为不可信材料放在指令后面；关联带给 Agent 的上一轮结论也改为不可信材料；判断是否重复只查本包的初筛记录，群里其他判定记录再多也不会让同一条告警重复初筛。命令行改用 `scenarios=`，`alarm=` 保留一个版本。
- **告警初筛包升到 1.1.0，告警下的话题改为可以接追问**：多机器人群里，以前来源机器人发的告警开出的话题算别的机器人的话题，没 @ 的追问一律不接；现在这类话题不算别人的，只有别的机器人已在里面发过言、话题超过 4 页读不完或读取失败时才让路。两个机器人同时判定时可能都接。已有绑定按新版本生效，不用重新确认。
- **`model` 模式场景包可以用了**：以前加载时会拒绝，现在照常加载，例子见 `plugins/team-faq`。
- **数据库升到 v38 后旧版本打不开**：v38 把群分工改成按场景包存绑定。升级后再换回旧版本会因为数据库版本比程序新而拒绝启动（`DATABASE_SCHEMA_TOO_NEW`）。出了问题只能向前修复，或者恢复部署前的数据库快照，快照之后的全部写入都会丢。
- **强制拦截的工作区 Hook 加入凭据检查（v3）**：已经开了强制拦截的机器人，要在 Web 设置里重新点「配置拦截 Hook」或运行 `dutydeck settings bot install-hook <app-id>`，Codex ACP 的凭据检查才生效；重装前保存这个机器人的设置会提示 Hook 未就绪。默认 Agent 是 Claude Code 终端（含 ccflash 这类自定义 Agent）或经 Dutydeck 启动的 ACP Claude 的机器人不受影响，现在可以直接开强制拦截。
- **每轮改动漏记已修复**：以前，一次索引写入后同一秒内又改了某个文件、且文件大小没变时，“每轮改动”会漏记这个文件（影响「查看改动」和 `/pr` 的文件清单）。现在已修复。

---

## 已知限制 <a id="known-limits"></a>

- **本机 `~/.claude/settings.json` 的 allow 规则会绕过飞书逐项审批。** 飞书里 `ask` / `approve-reads` 的 Claude 终端模式虽然固定用 `default` 权限模式启动，但本机 `permissions.allow` 里的规则仍然生效，命中的操作不会出飞书审批卡。需要严格逐项审批时，清理本机的 allow 规则。
- **ACP 侧预先放行时，`/plan` 的计划阶段拦不住写操作。** 计划阶段靠拒绝 Agent 发来的每个权限请求来拦写。Claude ACP 如果自己预先配了允许规则（如 settings 里的 allow 列表）或默认模式是 bypass，这些操作根本不会来问 Dutydeck。用 `/plan` 时，ACP 侧不要预先放行写操作。
- **凭据保护按规则匹配，不是隔离。** 换个写法（编码、拼接路径、写脚本再执行）可能绕过；完全信任模式下，不在允许名单里的人仍能让 Agent 以本机用户身份运行任意命令。对外开放的机器人用强制拦截，或者不给它完全信任。
- 显式配置 Cursor 为 `pty-cli` 且只有原始屏幕输出时，即使回放中可见回答，也可能因缺少规范化最终正文而记为失败；默认 ACP Cursor 不在此范围。
- 验证门禁目前只对飞书任务生效，且需要先配验证命令。
- 终端模式下，Codex、Traex 没有用量数据；用量上限对它们不生效。
- 用量金额是估算，不含加价项（见“用量与成本”），不是账单。
- 触发器鉴权不带时间戳，见“插件 → 安全说明”。
- Web 的“群与权限”等草稿页默认隐藏，见“实验功能”。

---

## 常见问题与排障 (FAQ) <a id="faq"></a>

### Q1: 在飞书给机器人发消息，没有反应，也没贴 `👌`？
1. 运行 `dutydeck doctor`，看「飞书监听」一栏是否正常。
2. 到飞书开放平台检查应用是否开启了 **「机器人能力」**，事件订阅方式为 **长连接**（已订阅 `im.message.receive_v1`）。
3. 检查机器人是否在群里；群聊里消息是否 `@` 了机器人（按“话题内免 @”以上的强度时，在已认领的话题里可以不 @）。
4. 默认 Agent 没装或登录过期也会表现为不回：`doctor` 会对默认 Agent 跑 `--version`，并点名找不到的命令。

### Q2: 提示 `Persisted key policy violation`？
- **原因**：ACPX 持久化键名必须是全小写 `snake_case`。
- **解决**：不要把大写环境变量名直接写进 ACPX session 配置；群聊工具的运行时变量用 `dutydeck_group_tools_url` 和 `dutydeck_group_tools_token`。

### Q3: 自定义 Agent 没出现在列表里，或提示找不到命令？
- **原因**：守护进程是非交互子进程，不读 `~/.bashrc`、`~/.zshrc` 里的 alias；`command` 找不到的 Agent 不会被登记。
- **解决**：`dutydeck doctor` 会点名没登记的 Agent 和它的命令。在 `DUTYDECK_AGENTS_JSON` 里把 `command` 改成可执行文件的绝对路径（如 `/usr/local/bin/claude`），再 `dutydeck restart`。

### Q4: 飞书里报“逐项确认”相关的错误，或会话启动失败？
- 所选 Agent 不支持飞书逐项审批时（只有 ACP 和 Claude Code / Seed / Relay 终端模式支持），机器人只能用 `full-trust`。修法二选一：
  - `dutydeck settings bot set <appId> permissionMode=full-trust fullTrustConfirmed=true`（Agent 会无人值守地执行命令和改文件）；
  - 换成 ACP 或 Claude 终端模式的 Agent。

### Q5: 能否在同一台机器上运行多个机器人？
- 可以。每个机器人有自己的默认工作区、Agent 和飞书应用凭据，服务不同的群组。

### Q6: Claude Code / CCFlash 已完成，飞书卡片却提示工具未返回结果？
- 旧版本可能把 CLI 日志中的历史请求快照当成本轮工具调用。升级后，这些快照不会进入执行记录或确认本轮指令已接收；真实工具缺少结果时仍会提示失败。

---

## 开源许可证与协议 (License)

Dutydeck 核心代码采用开源授权协议。完整第三方依赖与开源许可证声明请参阅 [Third-Party Notices](THIRD_PARTY_NOTICES.md)。
