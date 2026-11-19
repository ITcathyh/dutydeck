<a id="readme-top"></a>

<div align="center">

<img src="docs/assets/banner-zh.svg" alt="Dutydeck：在飞书派活，Agent 在你的机器上干活" width="100%">

<h3>在飞书派活，Agent 在你的机器上干活</h3>

<p>📱 手机审批 · ✅ 服务端真跑验证 · 👑 Leader 拆活验收 · ♻️ 重启不丢活</p>

![Node.js ≥ 22.12][node-shield] ![pnpm ≥ 11][pnpm-shield] ![tmux][tmux-shield] ![飞书卡片 2.0][lark-shield] ![ACP 兼容][acp-shield]

<a href="#whats-new"><b>最近&#8288;更新</b></a> • <a href="#quick-start"><b>快速&#8288;上手</b></a> • <a href="#features"><b>功&#8288;能</b></a> • <a href="#leader"><b>Leader&nbsp;模式</b></a> • <a href="#web"><b>Web&nbsp;工作&#8288;台</b></a> • <a href="#agents"><b>支持的&nbsp;Agent</b></a> • <a href="#docs"><b>文&#8288;档</b></a>

<sub>简体中文 · <a href="README.en.md">English</a></sub>

</div>
<a href="docs/assets/promo-zh.mp4"><img src="docs/assets/promo-zh.webp" alt="宣传短片：飞书里一句话派活，Agent 跑命令前在手机上审批，服务端跑测试验证通过，结果卡一点就能看本轮 diff；还有定时、重启不丢活、长期记忆、开 PR，支持 30 种终端适配器和 21 个 ACP Agent" width="100%"></a>

<p align="center"><sub>38 秒宣传短片 · <a href="docs/assets/promo-zh.mp4">高清 MP4</a> · 界面为示意，任务内容是虚构示例</sub></p>

<a id="install"></a>

```sh
git clone https://github.com/ITcathyh/dutydeck.git && cd dutydeck
# 安装依赖并构建
pnpm install && pnpm build
# 打成 npm 包，再全局安装得到 dutydeck 命令
pnpm --filter @byted/dutydeck pack --pack-destination "$PWD"
npm install -g ./byted-dutydeck-*.tgz
# 向导：探测本机 Agent，可绑定飞书机器人
dutydeck setup
# 启动守护进程并体检
dutydeck start && dutydeck doctor
```

`doctor` 全部通过后打开 `http://127.0.0.1:4310`。前置条件和其他安装方式见[快速上手](#quick-start)。

## 🔥 最近更新 <a id="whats-new"></a>

<sub>2026 年 11 月</sub>

| | 新能力 | 带来什么 |
|:---:|---|---|
| 👑 | [**Leader 模式**](#leader) | 一个 Agent 拆活、派给多个 Worker、验收，只把该你定的事推给你 |
| 📱 | [**工作台改版**](docs/zh/web-console.md#1-工作台全部任务与任务详情) | 总览、任务、待办、自动化四个入口；手机上有底部导航，结果检视变成底部抽屉 |
| 🎯 | [**定时任务跟到办完**](docs/zh/web-console.md#5-通用定时任务) | 带完成条件和截止时间，办完自己停；可加前置命令，条件满足才唤醒 Agent |
| 🧷 | [**按工作区记住审批**](docs/zh/agents.md#workspace-approval-rules) | `pnpm test`、`git status` 这类命令批准一次，同一目录以后自动放行，重启后仍有效 |
| 🌙 | [**后台子任务状态区**](docs/zh/web-console.md#1-工作台全部任务与任务详情) | Agent 自己开的后台任务集中显示在时间线上方，跑完、失败、还在跑一眼分清 |
| ✍️ | [**文字优化**](docs/zh/lark.md#文字优化默认关闭) | 可选：最终答复发出前由另一个 Agent 润色；代码、链接、数字被改动就退回原文 |
| 🩺 | [**运维工具**](docs/zh/cli.md#logs) | `dutydeck logs` 看日志，`doctor` 查对外暴露风险，systemd socket 激活让重启期间的连接排队 |

## 💡 为什么需要它 <a id="why"></a>

编码 Agent 大多只能在终端里用：你得守在电脑前，SSH 一断任务就停；放手让它跑，又怕它乱改、乱执行；它说“测试通过了”，你也不知道它跑没跑。**Dutydeck 是跑在你开发机上的守护进程**，把 Claude Code、Codex 等 Agent 接到飞书和 Web 上。

| | 直接用终端 CLI | 用 Dutydeck |
|---|---|---|
| **派&#8288;活** | <sub>守在电脑前，SSH 断了就停</sub> | ✅ 飞书一句话，后台持续跑 |
| **高&#8288;危** | <sub>全局放行，或频繁弹窗</sub> | ✅ 手机上逐项审批 |
| **质&#8288;量** | <sub>说测过了，可能没跑</sub> | ✅ 服务端真跑验证命令 |
| **分&#8288;支** | <sub>直接改当前分支</sub> | ✅ 可选独立 worktree |
| **协&#8288;作** | <sub>一个终端一个 Agent，拆活、盯进度全靠你</sub> | ✅ Leader 拆活派给多个 Worker，验收后再交给你 |
| **成&#8288;本** | <sub>花了多少只能事后算</sub> | ✅ 按机器人或群设月度上限 |
| **重&#8288;启** | <sub>进程一停，活就没了</sub> | ✅ 保留可恢复的任务 |

<p align="center">
  <img src="docs/assets/flow-zh.svg" alt="流程：飞书进度卡 → 审批卡（允许本次 / 拒绝 / 本会话允许此命令 / 本工作区允许此类命令，后两项视发起人、命令类型和权限而定）→ 服务端跑 pnpm test 得到退出码 0 → 结果卡显示改动 3 个文件和验证通过" width="100%">
</p>

<p align="center"><sub>派活 → 审批 → 服务端验证（失败最多返修 2 轮）→ 结果卡<br>审批卡上“本会话允许此命令”“本工作区允许此类命令”两个按钮视发起人、命令类型和权限出现</sub></p>

| [**30**](packages/cli-adapters/src/factory.ts) | [**21**](packages/acp-client/src/index.ts) | [**2 轮**](docs/zh/web-console.md#2-验证与返修) | [**14 天**](docs/zh/web-console.md#3-手机看改动) | [**0 次**](docs/zh/lark.md#结果未知的任务) | [**8 个**](docs/zh/lark.md#leader-mode) |
|:---:|:---:|:---:|:---:|:---:|:---:|
| <sub>内置终端适配器</sub> | <sub>acpx 登记的 ACP Agent</sub> | <sub>验证失败后最多返修</sub> | <sub>手机看改动链接有效期</sub> | <sub>结果未知时自动重发</sub> | <sub>Leader 模式最多 Worker</sub> |

## ✨ 能做什么 <a id="features"></a>

<img src="docs/assets/demo-zh.svg" alt="演示：在飞书群里 @ 机器人派活，审批 pnpm test 后收到“验证通过”的结果卡；右侧是开发机上 Agent 的执行过程" width="100%">

<p align="center"><sub>示意动画：卡片字段照真实飞书卡片绘制，部分按钮按条件出现；任务内容是虚构示例</sub></p>

<table>
<tr>
<td width="33%" valign="top">
📱 <b>飞书派活</b><br>
私聊或群里 @ 一句话，进度卡实时刷新；不记命令也行，说“换 codex 重新做”，点确认就办。<br>
<sub>→ <a href="docs/zh/lark.md">飞书指挥台</a></sub>
</td>
<td width="33%" valign="top">
👑 <b>Leader 模式</b> <img alt="新" src="https://img.shields.io/badge/%E6%96%B0-FF5A5F?style=flat-square"><br>
Leader 拆活、派给多个 Worker、验收，只把该你定的事推给你。<br>
<sub>→ <a href="#leader">往下看</a></sub>
</td>
<td width="33%" valign="top">
📝 <b>先出计划</b><br>
<code>/plan</code> 只调研、不改文件，卡片上批准后才动手（Claude）。<br>
<sub>→ <a href="docs/zh/lark.md#先出计划plan">先出计划</a></sub>
</td>
</tr>
<tr>
<td valign="top">
🛡️ <b>手机审批</b><br>
写文件、跑命令前弹卡，点按钮放行；常用测试命令可按工作区记住。<br>
<sub>→ <a href="docs/zh/agents.md">Agent 与权限</a></sub>
</td>
<td valign="top">
✅ <b>验证门禁</b><br>
飞书任务由服务端跑验证，失败最多返修 2 轮。<br>
<sub>→ <a href="docs/zh/web-console.md#2-验证与返修">验证与返修</a></sub>
</td>
<td valign="top">
🔍 <b>手机看改动</b><br>
结果卡一点就是本轮 diff，可逐行评论。<br>
<sub>→ <a href="docs/zh/web-console.md#3-手机看改动">手机看改动</a></sub>
</td>
</tr>
<tr>
<td valign="top">
🧭 <b>插话与分身</b><br>
<code>/steer</code> 插话进正在跑的一轮，<code>/fork</code> 带上下文开分身，<code>/resume</code> 接回旧会话。<br>
<sub>→ <a href="docs/zh/lark.md#2-常用飞书命令速查表">命令速查</a></sub>
</td>
<td valign="top">
🔁 <b>开 PR 并跟进</b><br>
<code>/pr</code> 确认后开 PR，跟进 CI 和评审（需 GitHub 插件）。<br>
<sub>→ <a href="docs/zh/lark.md#pr-loop">开 PR 与跟进</a></sub>
</td>
<td valign="top">
⏰ <b>定时跟到办完</b> <img alt="新" src="https://img.shields.io/badge/%E6%96%B0-FF5A5F?style=flat-square"><br>
说“每半小时看下这个 PR，跟到合并”，点启用才开始，办完自己停。<br>
<sub>→ <a href="docs/zh/features.md#6-群聊协作与定时委托">群聊协作与定时委托</a></sub>
</td>
</tr>
<tr>
<td valign="top">
🧠 <b>长期记忆</b><br>
<code>/remember</code> 手动记，也可后台自动提取。<br>
<sub>→ <a href="docs/zh/features.md#5-跨会话长期记忆">跨会话长期记忆</a></sub>
</td>
<td valign="top">
♻️ <b>重启不丢活</b><br>
结果未知的任务不会自动重发，而是发卡片让你决定。<br>
<sub>→ <a href="docs/zh/lark.md#结果未知的任务">结果未知的任务</a></sub>
</td>
<td valign="top">
📊 <b>用量与成本</b><br>
按机器人或群设月度上限，Web 上看费用明细和会话分析。<br>
<sub>→ <a href="docs/zh/web-console.md#4-用量与成本">用量与成本</a></sub>
</td>
</tr>
<tr>
<td colspan="3" valign="top">
🔌 <b>插件化</b><br>
CI、代码平台、告警初筛等外部集成以插件交付，也可以自己写。<br>
<sub>→ <a href="docs/zh/plugins.md">插件</a></sub>
</td>
</tr>
</table>

<details>
<summary><b>⌨️ 飞书里最常用的 10 个命令</b>（不记命令也行，直接说要做什么）</summary>

| 命令 | 作用 |
|---|---|
| `/new [--agent …] -- 任务` | 开新会话并派活，可指定 Agent、目录、worktree、模型 |
| `/plan 任务` | 先只调研、出计划，批准后再动手 |
| `/steer 内容` | 把一句话插进正在执行的这一轮 |
| `/fork [任务]` | 带上下文在新话题开分身，原会话继续 |
| `/resume` | 接回本话题最近关闭的会话 |
| `/pr [标题]` | 确认后开 PR，之后跟进 CI 和评审 |
| `/schedule every 30 任务` | 每 30 分钟跑一次，点启用才开始 |
| `/remember 内容` | 存一条长期记忆，之后每轮都带给 Agent |
| `/status` | 当前 Agent、工作区、运行状态和本月用量 |
| `/cancel` | 取消正在执行或排队的这一轮 |

完整列表见[命令速查](docs/zh/lark.md#2-常用飞书命令速查表)。

</details>

<div align="right"><sub><a href="#readme-top">↑ 回到顶部</a></sub></div>

## 👑 Leader 模式 <a id="leader"></a>

一句话派活，三个角色接力：**接待**和你对话；**Leader** 按你写的「Leader 指引」拆步骤、派给 **Worker**（最多 8 个）。Worker 中途的提问和工具授权先由 Leader 判断，交付不合格就打回返修（最多 2 轮）；真该你定的事，比如命中高危规则的命令，才推到你面前。

<p align="center">
  <img src="docs/assets/leader-zh.svg" alt="Leader 模式示意：你在群里提需求，接待 Agent 交给 Leader；Leader 按指引拆成 3 步，点「开始执行」后派给 Worker A、B；Worker B 的提问由 Leader 依据指引作答，命中高危规则的迁移命令推给你审批；Leader 验收通过，结果回到原话题" width="100%">
</p>

<p align="center"><sub>示意图：群聊里 Leader 拆好计划后，点「开始执行」才派发；私聊不用点。任务内容是虚构示例</sub></p>

- **只认你的原话**：授权只来自你本人的消息、你在卡片上的答复和指引里写明的长期授权；Leader 的推断、接待的转述都不算。
- **替你定过什么都留痕**：卡片上的「Leader 已替你定」列出每个决定和依据，不同意就在话题里直接说。
- **指引就是一个技能**：一份 `SKILL.md`，放在项目里、用户目录或打包成插件都行；不填就用内置规则。

开启：Web「机器人管理」→「执行方式」选 Leader 模式（需先开启群工具），或：

```sh
dutydeck settings bot set <appId> executionMode=layered leaderAgentId=<agentId> workerAgentIds=<id1>,<id2>
```

<sub>→ <a href="docs/zh/lark.md#leader-mode">Leader 模式详解</a></sub>

## 🖥️ Web 工作台 <a id="web"></a>

不在飞书时，打开 `http://127.0.0.1:4310`：**总览**先列出需要你决定的事，**待办**里常规审批可以直接批，**任务**里看对话、工具调用、每轮改动和终端回放（终端模式 Agent），**自动化**管定时任务；`Ctrl-K`（macOS 为 `⌘K`）搜任务和设置。浅色、深色主题都有，手机上也能顺手用。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/web-task-dark.png">
    <img src="docs/assets/web-task-light.png" alt="Web 工作台任务详情：Agent 读取文件、修改代码并跑测试的完整过程" width="100%">
  </picture>
</p>

<table>
<tr>
<td width="37%"><img src="docs/assets/web-tasks.png" alt="总览：待你决定的权限审批排在最前，可直接批准或拒绝；下面是正在推进和可继续的任务，右侧是最近交付"></td>
<td width="37%"><img src="docs/assets/web-diff.png" alt="本轮改动：左侧文件列表和已查看进度，右侧逐行 diff"></td>
<td width="13%"><img src="docs/assets/web-mobile-home.png" alt="手机上的任务列表：按状态筛选，底部是总览、任务、待办、更多四个入口"></td>
<td width="13%"><img src="docs/assets/web-mobile-task.png" alt="手机上的结果检视：底部抽屉列出执行、改动、验证三项交付状态"></td>
</tr>
<tr>
<td align="center"><sub>总览：待你决定的审批排在最前，能直接批</sub></td>
<td align="center"><sub>每轮改动：逐文件查看 diff</sub></td>
<td align="center" colspan="2"><sub>手机：底部导航，结果检视是底部抽屉</sub></td>
</tr>
</table>

<p align="center"><sub>截图来自隔离的演示实例，项目、任务和代码都是虚构示例</sub></p>

## 🚀 快速上手 <a id="quick-start"></a>

> [!NOTE]
> 需要 Node.js ≥ 22.12、pnpm ≥ 11、`tmux`，以及一个已安装并登录的 Agent CLI（Claude Code、Codex 等）。

跑完[开头那组命令](#install)之后：

1. 打开 `http://127.0.0.1:4310`，本机访问免登录。
2. 在首屏点「绑定飞书 Bot」→「一键创建飞书机器人」，按向导授权。
3. 在飞书私聊机器人，或在群里 @ 它派活。

<details>
<summary><b>其他安装方式</b></summary>

- **全局安装已发布包**：`pnpm add -g @byted/dutydeck`，之后同样执行 `dutydeck setup` 和 `dutydeck start`。
- **脚本 / CI 里跳过交互**：`dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes`，飞书绑定参数见[快速上手文档](docs/zh/getting-started.md)。
- **源码热重载开发**：见下方[参与开发](#dev)。

</details>

<details>
<summary><b>让你的 Agent 帮你装</b></summary>

把下面这段发给你的编码 Agent：

```text
帮我安装并启动 Dutydeck（https://github.com/ITcathyh/dutydeck）。
1. 确认 Node.js ≥ 22.12、pnpm ≥ 11、tmux 已安装，缺什么告诉我。
2. 按仓库 README 开头的命令克隆、构建、打包，
   并全局安装 dutydeck 命令。
3. 运行 dutydeck setup --skip-lark --yes 只配本机，
   再运行 dutydeck start。
4. 运行 dutydeck doctor，把没通过的项和它给出的修复命令列给我。
```

</details>

## 🤖 支持的 Agent <a id="agents"></a>

内置 **30 种终端适配器**；本机没有对应终端适配器时，ACP Agent 自动出现（acpx 登记 21 个）。同一 Agent 两种方式都可用时默认走终端，比如 Gemini、Cursor 在飞书里只能用 `full-trust`；要逐项审批，需在 `DUTYDECK_AGENTS_JSON` 里显式指定 `protocol: "acp"`。自定义 Agent 也用它注册。

| Agent | 接入方式 | 飞书逐项审批 |
|---|---|:---:|
| **Claude Code**（含经网关、自定义配置的变体） | 终端 · ACP | ✅ |
| **Codex** | 终端（`codex`）· ACP（`codex-acp`） | ACP ✅ |
| **TRAE** | 终端（`traex`）· ACP（`traex-acp`） | 取决于原生策略 |
| **Gemini CLI、Cursor、OpenCode、Copilot CLI、Kimi 等** | 终端 | 仅 `full-trust` |
| **ACP Agent**（Qwen Code、Factory Droid、iFlow 等，自动发现） | ACP | ✅ |

> [!WARNING]
> `full-trust` 会跳过逐项审批，Agent 写文件、跑命令都直接放行。只在隔离环境或你信任的流水线里用。

各 Agent 的审批能力与权限档位见 [Agent 与权限](docs/zh/agents.md)。

<div align="right"><sub><a href="#readme-top">↑ 回到顶部</a></sub></div>

## 🏗️ 工作原理 <a id="how-it-works"></a>

<p align="center">
  <img src="docs/assets/arch-zh.svg" alt="架构：飞书、Web 工作台和 CLI/HTTP 触发器连到跑在本机的 Dutydeck 守护进程，守护进程通过终端（PTY）或 ACP 驱动本机 Agent" width="100%">
</p>

- **触发入口**：飞书（长连接 + 卡片 2.0）、Web 工作台、CLI / HTTP 触发器。
- **守护进程**：跑在你的机器上，负责任务队列、权限门禁、验证门禁、记忆和插件。
- **执行账本**：每轮任务记入 SQLite，区分未提交、执行中和结果未知。
- **驱动层**：终端模式经 PTY 驱动 CLI，ACP Agent 走 ACP 协议。
- **会话后端**：终端模式默认用 `tmux`，已配置的 Herdr 仍可使用。

**本地优先**：Agent、代码和凭据留在本机；默认只监听 `127.0.0.1`，非本机访问需要登录。<br>
**不靠猜**：超时、断线、重启都不会被当作“没执行”而自动重发。<br>
**防泄露**：可拦下读取 `~/.ssh`、`.env`、Agent 会话记录等操作；卡片和群消息里的常见密钥自动打码。<br>
**稳上线**：`dutydeck deploy` 排空任务 → 切换版本 → 重启 → 健康检查，失败按条件回滚；配上 systemd socket 激活，重启期间的连接排队而不是被拒。<br>
**自巡检**：每小时检查长连接、待投递结果、结果未知和逾期计划，有新问题私信机器人所有者。

## 📚 文档 <a id="docs"></a>

| 文档 | 内容 |
|---|---|
| 🚀 [快速上手](docs/zh/getting-started.md) | 安装、配置向导、非交互安装、源码开发 |
| ✨ [功能详解](docs/zh/features.md) | 核心能力的细节、默认值和边界 |
| 📱 [飞书指挥台](docs/zh/lark.md) | 任务流程、命令速查、`/plan`、`/pr`、群聊协作、Leader 模式、接入机器人 |
| 🖥️ [Web 工作台](docs/zh/web-console.md) | 总览与待办、验证与返修、手机看改动、用量与成本、定时任务 |
| 🤖 [Agent 与权限](docs/zh/agents.md) | 自定义 Agent、终端任务恢复、权限模式、按工作区记住的审批、环境变量 |
| 🔌 [插件](docs/zh/plugins.md) | 插件结构、触发器、业务工具、Hook、CI 提供方、场景包 |
| ⌨️ [CLI 与运维](docs/zh/cli.md) | 守护进程、日志、部署与回滚、备份恢复、`settings`、远程访问、巡检 |
| ⬆️ [升级说明](docs/zh/upgrading.md) | 升级时需要注意的行为变化 |
| ❓ [已知限制与 FAQ](docs/zh/troubleshooting.md) | 已知限制、常见问题排障 |

<sub>给 AI 编码 Agent：开发约定和验证要求见 <a href="AGENTS.md">AGENTS.md</a>。</sub>

<div align="right"><sub><a href="#readme-top">↑ 回到顶部</a></sub></div>

## 🛠️ 参与开发 <a id="dev"></a>

```bash
git clone https://github.com/ITcathyh/dutydeck.git
cd dutydeck
pnpm install
cp .env.example .env
pnpm dev        # Web 前端 http://127.0.0.1:4311，后端 API http://127.0.0.1:4310
```

pnpm monorepo：`apps/server`（守护进程与 CLI）、`apps/web`（Web 工作台）、`packages/*`（执行引擎、ACP/终端驱动、存储、插件 SDK 等）；E2E 测试见 [tests/e2e/README.md](tests/e2e/README.md)。

## 📄 许可证

本仓库尚未声明开源许可证；在添加 LICENSE 之前，代码保留所有权利。第三方代码与素材及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

<div align="center">
<br>
<img src="docs/assets/logo.svg" alt="Dutydeck" width="48">
<p><sub>派活在飞书，干活在本机</sub></p>
<a href="#readme-top">↑ 回到顶部</a>
</div>

[node-shield]: https://img.shields.io/badge/Node.js-%E2%89%A5_22.12-339933?style=flat-square&logo=nodedotjs&logoColor=white
[pnpm-shield]: https://img.shields.io/badge/pnpm-%E2%89%A5_11-F69220?style=flat-square&logo=pnpm&logoColor=white
[tmux-shield]: https://img.shields.io/badge/tmux-%E5%BF%85%E9%9C%80-1BB91F?style=flat-square&logo=tmux&logoColor=white
[lark-shield]: https://img.shields.io/badge/%E9%A3%9E%E4%B9%A6-%E5%8D%A1%E7%89%87_2.0-3370FF?style=flat-square
[acp-shield]: https://img.shields.io/badge/ACP-%E5%85%BC%E5%AE%B9-0EA5E9?style=flat-square
