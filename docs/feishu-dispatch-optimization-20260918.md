# 飞书入口的指挥与调度：差距与优化方向

> 2026-09-18。范围：**用户如何从飞书把活派出去、派给谁、怎么并行、怎么在途干预**。
> 不重复 [团队 Tag 能力差距](team-tag-capability-gap-20260918.md)（那份讲入站侧的「该不该说话」）。
> 三类证据：代码结论均给 `file:line` 且本次实际读取；飞书接口能力用 `lark-cli` 实测确认（第 7 节）；同类产品的用户痛点取自两个真实用户群近 14 天的全量消息（第 8 节）。

## 1. 结论

两条主线。

**一、调度引擎已经接到飞书了，但只有 Agent 能用，而且没有人工确认这一步。** 仓库里有一个带依赖、环校验、条件等待、按步指定 Agent 与独立工作目录的 DAG（`packages/shared/src/work-items.ts:5-45`）。它对 Agent 是开放的：群工具启用且本轮有工作台任务时，`workbenchAgentPrompt` 会把 `dutydeck work create --file <JSON>` 注入提示词（`apps/server/src/work-item-tools.ts:59`，注入点 `apps/server/src/lark/agent-tools.ts:493-498`），Agent 可以现场构造任意 ≤12 步的计划。但**人这一侧只有一条写死的三步「研究」模板**，而且 Agent 建计划即执行，中间没有「先给人看方案、人点确认」这一步。同时飞书本身提供的三个指挥入口一个都没用：原生斜杠命令、任务智能体、消息加急。

**二、同类产品的用户在为四件事反复求助，其中三件 Dutydeck 已有底座、只差一层入口。** 从「Mew 体验反馈群」与「Botmux 交流群」近 14 天的 1342 条人类消息看，最高频的是授权开通、身份归属、输出噪音、任务过多管不过来。授权和噪音在 Dutydeck 里是「字段已有、群级没放开、聊天里没命令」；「它说做完了到底做完没有」这个两个产品都答不上来的问题，Dutydeck 有验证命令这个现成反制，只是结果卡上没说出来。

十三条建议按 P0 / P1 / P2 排在第 4 节与 §8.9。其中三条要新申请飞书权限（原生斜杠命令、任务智能体、加急与置顶），其余多数是已有字段或已有策略动作的接线；要新写运行时逻辑的是三条：编排的人工 gate、`/steer`、多 bot loop guard。

## 2. 现状：飞书这一侧能指挥到什么程度

| 维度 | 现状 | 位置 |
|---|---|---|
| 命令面 | 16 条命令，全部靠文本前缀解析（`commands.ts:88` 只认 `/` 前缀）；飞书客户端不知道它们存在 | `lark/commands.ts:182-241` |
| 选执行者 | **不能选**。一个 Bot 绑一个默认 Agent，`/new` 只解析 `--cwd / --model / --effort / --workspace` | `lark/new-session.ts:7,15` |
| 选工作目录 | 必须手敲服务器上已存在的绝对路径 | `lark/new-session.ts:45-50` |
| 并行 | 一个话题一个会话，会话内串行排队；人要并行只能另开话题（Agent 可以经 `work create` 让多步并行） | 产品口径，见 README「Agent 忙碌时…可以排队」；本行不是代码断言 |
| 编排 | Agent 可经 `dutydeck work create` 现场构造任意 ≤12 步计划，建即执行；人只能用写死的三步 research 模板，没有预览与确认 | 引擎 `shared/src/work-items.ts:5-45`；Agent 工具 `work-item-tools.ts:59` + 注入 `lark/agent-tools.ts:493-498`；人侧模板 `lark/workbench.ts:47-54`；提示语 `lark/coordinator.ts:987-996` |
| 在途干预 | 只有「排队」或「中断」两档，没有插话 | `lark/card-actions.ts:22` 动作闭集 `cancel/interrupt/retry/refresh` |
| 队列操作 | 策略动作 `queue.cancel/promote/reorder` 已定义且前两个已在 HTTP 侧使用，飞书无对应命令，`queue-summary.ts` 只做展示 | `shared/src/group-policy.ts:441`；HTTP 用法 `apps/server/src/app.ts:237,241` |
| 全局视图 | `/tasks` 按任务列，`/status` 只看本会话；没有「哪些 Agent 在跑、在哪个目录」 | `lark/task-dashboard.ts:302`、`lark/commands.ts:206-213` |
| 申请的飞书权限 | 16 项，全在 `contact` 与 `im` 域；无 `application`、无 `task` | `lark/open-platform-configurator.ts:6-21` |

底座其实比入口宽：群级 `agentOverride`（`shared/src/group-policy.ts:67`）与策略动作 `run.change_agent`（`:444`，已在 `apps/server/src/service.ts:256` 使用）都在，只是聊天里没有对应语法。授权动作 `grant.create` / `grant.revoke` 同理（`:445`）。

## 3. 对标：同类产品把指挥调度做成了什么

| 能力 | Botmux | AgentMux | Cursor in Slack | Dutydeck |
|---|---|---|---|---|
| 选执行者 | `@botA @botB /t <prompt>` 各开一个会话 | Router 覆盖 10 种 CLI，可切换与故障转移 | 消息里写模型/环境名即可 | 不能选 |
| 选仓库 | `/repo <序号\|路径\|项目名>` + 项目选择卡 | 按会话绑定 | 关键词→仓库路由规则 + 最近活动 + 默认兜底 | 手敲绝对路径 |
| 并行 | 多话题协作：主控拆分→提分配方案→人确认→每子项开话题→汇总 | Orchestrations：持久 DAG，依赖输出传递、并发上限、失败阻断、取消、daemon 重启恢复 | 并行数不限，`@Cursor list my agents` 查看 | 人工另开话题 |
| 在途干预 | `/retry` `/restart` `/fork` `/quote` | `/steer <内容>` `/queue cancel <ID>` `/takeover` | 线程内追问 | 排队或中断 |
| 会话搬运 | `/relay` 搬到别的群；`/adopt` 接管本机 tmux 会话 | — | 跨频道访问 | 无 |
| 人设分层 | 群级 Role > 默认 Role，`cap` 能力标签进花名册 | — | — | 群级 `settings.instructions` 已有 |
| 命令发现 | `/list-slash-command` 分四段列出 | `/help` | `@Cursor help` | `/help`（需先知道它） |

三条可直接借用的做法：

- **选项写在消息任何位置**（Cursor）。Dutydeck 要求 `--` 分隔且选项必须在任务内容之前，写错就报错。
- **先出方案再执行**（Botmux 多话题协作、Cursor Plan-First）。Dutydeck 的 `/work` 是直接建并执行。
- **命令面板自己会露出来**（Cursor `help`、Botmux `/list-slash-command`）。飞书给了更强的做法，见建议 1。

## 4. 建议

按「改动小 × 解锁大」排。P0 三条都是接线，没有新引擎。

### P0-1　把 16 条命令注册成飞书原生斜杠命令

飞书开放平台有真实的命令注册接口，实测确认：`GET/POST /open-apis/application/v7/app_slash_commands`，写操作需要 `application:app_slash_command:write`，单应用上限 100 条，支持默认说明与多语言说明、图标，改动后客户端约 5 分钟生效（缓存在客户端，服务端立即生效）。

收益是用户不用背语法：在输入框打 `/` 就出带说明的命令面板。今天要用 `/help`，前提是先知道有 `/help`。

接线位置现成：`open-platform-configurator.ts` 已有「增量导入权限 → 回读验证 → 发版」这套流程，加一步注册命令即可；`/repair` 同步补齐。命令清单从 `commands.ts` 的 `requires` 结果生成，停用的命令不注册。

**待验证（`unverified`）**：用户从命令面板点选后，机器人收到的事件形态。若仍是 `im.message.receive_v1` 且正文以 `/cmd` 开头，解析层零改动。验证方法：在一个测试应用上注册一条命令，从客户端触发一次，打印 `listener.ts` 收到的原始事件。若是独立事件类型，则需在 `listener.ts:192` 旁边加一个分发分支。

### P0-2　`/new` 支持 `--agent`

一句话决定这活给 Claude Code、Codex 还是 CCFlash。底座齐全：群级 `agentOverride` 与策略动作 `run.change_agent` 都已存在并在用，缺的只是解析、校验 Agent 存在、调一次授权。

这条同时解掉一个当前的怪现象：Web 新建任务可以选 Agent，飞书不行，而飞书是文档里写明的核心入口。

### P0-3　工作目录别名与选择卡

给每个 Bot 配一张「别名 → 绝对路径」表，`/new --cwd dutydeck` 即可；不带参数时发一张目录选择卡。Web 侧栏已经按工作目录聚合任务，可用目录集合是现成的。

这条落在追平方案 C02（新话题与选仓）里，建议提前：手机上敲一条绝对路径是当前飞书入口最直接的摩擦。

### P1-4　给编排补一个人工 gate

先把现状说准，因为它和直觉相反：**Agent 已经能从飞书现场编排**。群工具启用且本轮有工作台任务时，`workbenchAgentPrompt` 把 `dutydeck work create --file <JSON>` 连同完整的计划格式注入提示词（`work-item-tools.ts:59`，注入条件 `lark/agent-tools.ts:493-498`），Agent 可以构造任意 ≤12 步、带依赖与 `wait` 分支的计划。引擎本身也比对手严格：环检测、可达性检查、每步可单独指定 `agentId` / `workspaceMode` / `skills`（`shared/src/work-items.ts:5-45`）。Botmux 的多话题协作靠主控模型自己发命令，没有这层校验。

真正缺的是两件事：

1. **人看不到、也拦不住。** `create` 是「持久接收即开始执行」，提示词里写的是「收到目标编号说明计划已持久接收」。用户在飞书看到的是分工简述和编号，不是一份可以改、可以否决的方案。Botmux 的多话题协作和 Cursor 的 Plan-First 都是「先提分配方案 → 人确认 → 再开工」。
2. **人自己不能起编排。** 命令面只有写死的 `/work research` 三步模板（`lark/workbench.ts:47-54`）与 `save` / `run <模板> <版本>` 复用（`workbench.ts:311-331`），没有「我要三个 Agent 并行做这件事」的入口。

建议：在 `create` 与执行之间插一张预览卡（步骤、依赖、每步 Agent、是否独立 worktree），人点确认才落队；同时开 `/work plan <目标>` 让人也能起一次编排。执行引擎不改。

这正是追平方案 **P4** 里列的「人工 gate」，建议提前。与 A06 不重合：A06 讲用同一契约从 Web/CLI/定时/API 触发**已发布**的模板。

### P1-5　舰队视图

补 `/agents`（本机可用 Agent 与版本，`runtime.listAgents` 已有），并给 `/tasks` 的每行加上 Agent 与工作区。今天跨话题、跨工作区地问「现在有几个 Agent 在跑、谁在等审批」，飞书里答不出来。

对应 Cursor 的 `@Cursor list my agents`、Botmux 的 `/sessions`。追平方案 U01 覆盖的是 Web 侧的集中工作台，飞书侧需要单独一条。

### P1-6　`/steer` 与队列命令

`/steer <内容>` 把内容注入当前这一轮，而不是排到队尾，也不中断重来。今天想纠偏只能二选一：排队等它做完错的，或者中断丢掉已有进展。

同时把已有的 `queue.cancel / queue.promote / queue.reorder` 三个策略动作接出成 `/queue` 命令（列队、取消某条、提前某条）。授权复用现成动作，不新增权限模型。

### P2-7　接入飞书任务智能体

飞书任务域有一组智能体接口，实测确认存在并均需 `task:task:write`：`task agent register_agent`（注册/注销 AI 智能体）、`task agent update_agent_profile`（更新智能体主页内容）、`task agent_task_step_info append_task_steps`（写入任务记录）。

把 Dutydeck 注册成飞书任务里的智能体后，「把一条飞书任务分配给它」就是第二条派活通道，执行进度写回任务记录，在飞书任务界面直接可见。Botmux、AgentMux、Cursor 都没有这条——它只在飞书生态里存在。

风险与建议：这三个接口在 `lark-cli` 里标为 high-risk-write。建议第一步只做「读取分配给自己的任务 + 写任务记录」，不自动接管、不自动改任务状态，并且和现有权限申请一样走「回读验证后再发版」。

### P2-8　加急与置顶作为兜底

问题卡和审批卡今天只能等人看见，唯一的催促手段是 `/tasks` 里的「待你处理」分组。飞书提供 `im messages urgent_app / urgent_phone / urgent_sms`（机器人须是该消息发送者且在会话中）与 `im pins create/delete/list`。

建议：审批或问题卡超过阈值无人处理时，对原消息做一次**应用内**加急（不做短信和电话，噪音成本太高）；长任务把进度卡置顶，结束时取消置顶。两者都要新申请权限，且加急必须有每群频次上限——这一点和团队 Tag 文档里「低门槛唤醒必须配预算闸门」是同一条纪律。

## 5. 与已有文档的关系

| 建议 | 是否已被覆盖 |
|---|---|
| P0-1 原生斜杠命令 | 新增，两份文档都没有 |
| P0-2 `/new --agent` | 新增 |
| P0-3 目录别名与选择卡 | 属追平方案 C02，本文建议提前 |
| P1-4 编排的人工 gate | 对口追平方案 **P4**（明写「人工 gate」），本文建议提前并给出具体形态；与 A06（触发已发布模板）不重合 |
| P1-5 舰队视图 | U01 已写明「跨入口状态一致、移动端可操作」，但没有把「飞书侧列出在跑的 Agent 与工作区」写成交付项，本文补这一条 |
| P1-6 `/steer` 与队列命令 | 新增 |
| P2-7 飞书任务智能体 | 新增 |
| P2-8 加急与置顶 | 新增 |

[团队 Tag 能力差距](team-tag-capability-gap-20260918.md) 覆盖的入站相关性判定、表情控制面、按群预算、通用事件源、结构化记录，本文不重复。

## 6. 明确不做

- **不自造 DAG 引擎**。`work-items.ts` 已经够用且校验更严，缺的是入口。
- **不做跨部署团队联邦**（Botmux 的 team 发现与跨机邀请）。追平方案 C07 已排在 P7，且信任模型要单独设计：Botmux 文档自己写明 `specialties/mentionable/online` 是自报字段、「不是可信凭据」。
- **不做短信与电话加急**。应用内加急已足够，其余噪音成本过高。

## 7. 验证状态与来源

飞书接口能力用本机 `lark-cli`（binary 1.0.88）实测确认：

| 结论 | 验证方式 | 状态 |
|---|---|---|
| 原生斜杠命令接口存在 | `lark-cli application +slash-command-list --dry-run` 返回 `GET /open-apis/application/v7/app_slash_commands` | 已确认 |
| 写操作需 `application:app_slash_command:write` | `+slash-command-create --dry-run` 返回 `missing_scope` 并指名该 scope | 已确认 |
| 上限 100 条、客户端缓存约 5 分钟、支持多语言说明与图标 | `+slash-command-create --help`、`+slash-command-list --help` | 已确认 |
| 命令触发后的事件形态 | 未验证 | `unverified` |
| 任务智能体三个接口存在且需 `task:task:write` | `lark-cli task agent --help`、`lark-cli skills read lark-task` 的 scope 表 | 已确认 |
| 加急与置顶接口存在、加急要求机器人是发送者 | `lark-cli im messages urgent_app --help`、`lark-cli im --help` | 已确认 |

代码结论：本分支 `worktree-participation-gates`（基于 `71e232a`），均已在正文标注 `file:line`。

### 独立复核记录

一轮只读复核逐条核查了正文的代码断言。采纳并已改的五处：

| 复核发现 | 处理 |
|---|---|
| 「飞书只暴露写死三步模板」夸大：群工具启用时 Agent 已可经 `dutydeck work create` 现场构造任意 DAG | 第 1、2 节与 P1-4 全部重写，论点从「引擎没接到飞书」改为「缺人工 gate 和人侧入口」 |
| §8.2 称「全仓库没有频次 guard」不准确：群参与路径有每小时预算，只是 `group-participation.ts:224` 先过滤掉非人类发送者 | 改为「预算存在但不覆盖机器人」，建议也相应改成「改分别计数而不是丢弃」 |
| P1-4 归到 C06 牵强，真正对口的是列有「人工 gate」的 P4 | 第 5 节归属表已改 |
| P1-5 称「U01 只覆盖 Web」偏窄，U01 已写明跨入口一致与移动端可操作 | 改为「U01 没把飞书侧列 Agent 写成交付项」 |
| 三处行号偏差（命令表、队列动作、`/status`） | 已订正 |

未采纳一处：复核指出第 8 节的条数统计无法从仓库复核。数据源是飞书群不是仓库，文档已给出 `chat_id`、时间窗与拉取命令，可用同一条命令复现；同时已把「反馈量第一」改成「按条数排在该群首位」，与「只用来排序」的口径对齐。

对标产品（2026-09-18 调研）：

- Botmux：[多机器人协作](https://deepcoldy.github.io/botmux/multi-bot.html)、[多话题协作模式](https://deepcoldy.github.io/botmux/multi-topic.html)、[角色与团队](https://deepcoldy.github.io/botmux/roles.html)、[斜杠命令](https://deepcoldy.github.io/botmux/slash-commands.html)、[CLI 命令](https://deepcoldy.github.io/botmux/cli-commands.html)
- AgentMux：https://github.com/wangning19940904/AgentMux
- Cursor in Slack：[Slack 集成](https://cursor.com/docs/integrations/slack)、[Cloud Agents](https://cursor.com/docs/cloud-agent)
- AgentDock（同名多个项目，与本项目形态最近的是自托管 agent fleet）：https://github.com/yuklcool/agentdock

用户反馈（第 8 节）：飞书群「Mew 体验反馈群」（`oc_dcf8b079029c8602bd9599a56ae909f9`）与「Botmux 交流群」（`oc_80cb2e00fb80d96deb0d9978792b7fb6`），时间窗 2026-09-04 至 09-18，经 `lark-cli im +chat-messages-list` 全量拉取。引用的用户原话均来自该窗口内的公开群消息，只用于判断产品痛点。

## 8. 用户群反馈：两个同类产品近 14 天的真实痛点

用 `lark-cli` 拉取 2026-09-04 至 09-18 的全量消息：「Mew 体验反馈群」715 条人类消息、「Botmux 交流群」627 条（均已剔除机器人回复）。下表是关键词匹配计数，条目会重叠，只用来排序，不作为定量结论。

| Botmux 群高频主题 | 条数 | Mew 群高频主题 | 条数 |
|---|---:|---|---:|
| 授权与权限开通 | 50 | 凭据与身份 | 71 |
| 升级与自启 | 42 | 唤醒策略不符预期 | 47 |
| 会话/话题管理 | 39 | Skill 与插件 | 37 |
| 模型与配额 | 30 | 自动化任务 | 34 |
| 定时与 webhook | 28 | 云环境启动慢或失败 | 32 |
| CLI 崩溃或启动失败 | 23 | worktree 与仓库 | 32 |
| 按触发人身份 | 22 | 超时与提前结束 | 26 |
| 消息未送达或未确认 | 19 | 设备离线 | 22 |
| 多 bot 互相刷屏 | 12 | 多 agent 调度 | 12 |

两个群的形态不同：Botmux 群以「怎么配」和「装不上」为主，Mew 群以「身份是谁」和「跑不起来」为主。但落到 Dutydeck 能改的地方，有七条是共性。

### 8.1 授权开通是第一运营摩擦

Botmux 群里 50 条与授权相关，重复出现同一句话：「怎么给群里所有人一次性开通」「拉进群不等于授权」「每次都要 owner 手动同意」。

Dutydeck 的模型比它干净：access 四档（`owner_only` / `allowlist` / `all_chat_members` / `disabled`）+ 成员白名单按姓名录入并解析成 `open_id`，同名或找不到直接拒绝保存。但**聊天里没有任何授权命令**，改一次要去 Web。Botmux 有 `/grant`、`/grant @某人 [N]`、`/revoke`。

建议：补 `/grant` 与 `/revoke`，作用域限本群，写入现有 `accessOverride`。这是纯接线。

### 8.2 多 bot 互相 @ 会真的把群打爆

12 条相关反馈里有「两个机器人循环发这种消息，刷了几千条」「直接给飞书干爆了」「把他们移出群，再拉进群也会发生」。

这条值得把 Dutydeck 的实际行为说准，因为它和「bot 发的消息永不唤醒」这个流传的说法不一致。唤醒判据是（`coordinator.ts:753`）：

```
legacyWake = quotedWorkflow || p2p || (group && (mentionsBot || !botSender && (continuedTopic || never || ambientOpen)))
```

`&&` 优先于 `||`，所以 `mentionsBot` 这一支**不受 `!botSender` 约束**：别的机器人 @ 了 Dutydeck，一样唤醒；引用工作流卡片（`quotedWorkflow`）同理。`!botSender` 只挡住了「没有 @ 的机器人消息」那三条路径。

往下还有两道闸，但都不封口：

- 群参与判定开启时，机器人的消息因为 `explicit === false` 会在 `coordinator.ts:760` 被丢弃——可是 `participation` 默认 `off`。
- 访问控制里（`coordinator.ts:2122`）机器人发送方的放行条件是 `!accessRestricted || (peerBotsAllowed && trustedPeerBot) || allowedBot`。配了名单时它是严的：必须是握过手的同实例 peer 或显式登记的机器人。但 `accessRestricted` 的判据是「`allowedUsers` 或 `allowedEmails` 非空」，**没有配成员名单时对任何机器人一律放行**——而「不配名单、群里谁都能用」正是 §8.1 里用户最想要的那种配置。

频次预算确实存在，但**不覆盖机器人**：群参与模块的每小时判定预算与发言预算只对人类发起的回合生效——`group-participation.ts:224` 先要求 `senderKind === 'human'`，否则直接 `return`，根本走不到预算那一步。

于是最危险的组合是现成的：群里不配成员名单 + 结果卡默认 @ 回发起人（`groupCardMention`）+ 对方也是一个会响应 @ 的机器人。

建议：把追平方案 C03 的多 bot 路由提前落地，loop guard 必须是硬门禁而不是 prompt。三条最小规则：机器人触发的回合计入每小时预算（把 `group-participation.ts:224` 的人类过滤改成分别计数，而不是丢弃）；同一话题内连续机器人往返深度上限；回复对象是机器人时不 @ 回去。

两处顺带修正，都属同一个说法的跨文档传播：[团队 Tag 能力差距](team-tag-capability-gap-20260918.md) §1.1 的「多 bot 回环防护只有一条 `!botSender`，bot 发的消息永不唤醒」，以及同文档 §5 把 C03 列为「继续观察」——按上面的判据，前者的后半句不成立；后者与[追平方案](full-product-parity-plan.md) 不一致，那里 C03 排在 P1/P6，交付要求已明写「防止无人约束的 Bot 互相循环触发」。

### 8.3 「消息可能没送达」是 PTY 路线的头号稳定性投诉

Botmux 群 19 条 `submit_unconfirmed`（「未能在会话存储确认 Codex 已接收这条消息」），另有 23 条 CLI 崩溃或启动失败。根因是往 TUI 注入输入无法确认是否真的提交——有用户定位到「Codex 额度低于 10% 时弹出切换模型的提示，吃掉了一次回车」。

Dutydeck 走同一条路线（PTY 适配器 + tmux），方向上的处理是对的：具备原生 transcript 游标且仍持有原 tmux 会话的轮次可续接和重放、指令不会重发，无法确认时明确中断，并有投递账本对账。

建议：不新增机制，改为**按这批真实失败形态做验收**——供应商 CLI 弹出交互提示、额度耗尽、tmux pane 被回收、daemon 升级期间投递，各构造一次，确认用户在卡片上拿到的是一个确定动作（「已确认未执行，点此重发」或「状态未知，点此查看终端」），而不是一段让人自己判断的说明。

### 8.4 输出噪音要能按群调

反馈集中在几句话：「回复里的按钮能隐藏吗」「话题模式 @ 太多会话框被打满」「中间过程不要单独发」「只回表情不回卡片行不行」「任务完成就别回复了」。

Dutydeck 的 `presentation` 已经覆盖大半：`groupCardMention`（是否 @）、`hideTraceOnComplete`、`traceLimit`、`pushIntervalMs`、`structuredAskCards`。问题是它**只有 bot 级**——`presentationOverride` 的取值只有 `{ mode: 'inherit' }`（`packages/shared/src/group-policy.ts:75`），同一个机器人进 10 个群只能用一套呈现。

建议：把 `presentationOverride` 打开成真实覆盖，并补两档用户反复要的形态：完成时只贴表情不发结果卡、中间进展完全静默只保留最终结果。

### 8.5 身份静默降级被用户明确指认为安全问题

Mew 群最大的一块（71 条）。最有价值的一段是 09-04 赵博与开发者的往返：他给 Agent 配了「用触发人身份」，实际执行却用了 Agent 创建者的 Codebase 身份，原因是触发人不是 Workspace 成员，系统静默降级了。他的结论值得照抄：

> 默认信任这个原则我觉得没问题，但是静默降级有问题。……而如果他什么都不做，就可以用我创建的 Agent 的权限（明明我还配了 trigger user），这个事情就很难解释了。这个降级策略是需要支持配置的。

Botmux 在 09-08 的 3.20.0 上线了「按触发人身份调用 CLI」（默认关闭，token 按「应用 + 授权人」分文件存储），随后一周群里出现 22 条相关提问与缺陷，说明这条路本身也不好走。

Dutydeck 今天等价于「永远用部署者身份」：capability token 只承载群工具与记忆，App Secret 不交给 Agent，但 Agent 在工作区里用的是宿主机的 CLI 登录态，README 已明说 worktree「不隔离宿主凭据、文件系统或网络」。

建议分两步，不要一次做完：

1. **先把话说清楚**。在飞书入口显式声明「本机器人以部署者身份执行」，并在 `access` 为 `all_chat_members` 时于欢迎卡和 `/status` 里重复一次。这一步零成本，消除的是最难解释的那类事故。
2. **再给拒绝的选项**。加一档「要求触发人凭据，缺失即拒绝执行」，不提供静默降级。按触发人注入凭据本身可以晚做，但「宁可拒绝也不降级」这个开关应该先有。

### 8.6 「假完成」两边都有，而 Dutydeck 手里有现成的反制

Mew 群 26 条涉及提前结束：「明明任务没完成却显示任务已完成」「compact 之后就中断了」「给了 final answer 但有残留后台任务导致超时」「长时间没有进展就中断执行，是如何判断没有进展的」。Botmux 群同样有「上一条把『准备做什么』误当成了最终回复，提前结束了 turn」。

Dutydeck 有这两个产品都没有的东西：验证命令会在目标目录真实执行，保存退出码、有限输出、时间和代码指纹，并且 Agent 自述测试通过不会产生验证记录。但**结果卡上没有把这件事说出来**——`result-delivery.ts` 与 `card-renderer.ts` 里没有任何验证状态的渲染。

建议：结果卡加一行「已验证（退出码 0，指纹 abc1234）」或「未验证」，未验证时带一个「运行验证」按钮。改动很小，而它正面回答了同类产品用户问得最多的一类问题——「它说做完了，到底做完没有」。

### 8.7 任务一多就管不过来

Botmux 群 39 条涉及会话与话题管理：「话题开多了不知道每个任务在干什么」「希望 Agent 按『类型｜具体事项』自动命名会话」「会话控制能聚合我的本地机器和 devbox 吗」「希望给 Chat 加星标和筛选」；Mew 群有「手机上想创建和监管多个任务，有最佳实践吗」。

这正面支持正文 P1-5 的舰队视图，并补一条：**让 Agent 在首轮结束时给本会话起一个名字**，飞书侧显示在任务导航里。Botmux 已经有 `botmux session rename`，用户仍在要更自动的版本。

### 8.8 反过来，这批反馈验证了 Dutydeck 已经做对的几件事

| 反馈里反复出问题的地方 | Dutydeck 的现状 |
|---|---|
| 用户拿到一串错误码不知道下一步（两个群大量） | `doctor` 每一项失败都给出具体的补救命令 |
| 「配置保存了但机器人没接入」 | 首屏按真实接入状态分档，不把配置记录当成已接入 |
| Mew 用户的代码仓库被自动移走两次 | worktree 只在归档后显式检查，严格要求无未提交改动、无未跟踪文件、无未合入提交才允许清理 |
| 多个定时任务共用群级会话导致上下文串线 | 定时计划绑定具体工作项，不按 chat 锚点查找 |
| 「让它总结群消息，结果它开始执行群里的指令」 | 记忆与群参与判定跑在 `deny-all` 的独立会话里 |

### 8.9 据此调整优先级

正文第 4 节的排序基本不变，插入两条并上移一条：

| 顺序 | 项 | 变化 |
|---|---|---|
| P0 | 原生斜杠命令、`/new --agent`、目录别名 | 不变 |
| **P0（新增）** | **`/grant` 与 `/revoke`**（§8.1） | 按条数排在 Botmux 群首位；`grant.create` / `grant.revoke` 策略动作已存在，纯接线 |
| **P0（新增）** | **结果卡标注验证状态**（§8.6） | 改动小，正面回答同类产品答不了的问题 |
| **P1（对齐）** | **多 bot 硬性 loop guard**（§8.2） | 追平方案 C03 本就在 P1/P6；团队 Tag 文档把它列为「继续观察」，按本节证据应回到 P1 |
| P1 | DAG 编排入口、舰队视图（加会话自动命名）、`/steer` 与队列 | 不变 |
| **P1（新增）** | **`presentationOverride` 打开到群级**（§8.4） | 已有字段，只差放开 |
| P2 | 飞书任务智能体、加急与置顶 | 不变 |
| **P2（新增）** | **身份边界显式化**（§8.5） | 第一步零成本，第二步只做「拒绝而非降级」的开关 |


## 9. 实际交付状态（2026-09-19，分支 `feat/feishu-dispatch`）

第 4 节与 §8.9 的 13 条全部落地。下面只记与建议原文有出入、或使用前必须知道的部分。

### 9.1 降级实现的一条

**`/steer` 不是「插话」，是「提到队首并中断当前轮」。** 运行时没有「向正在执行的这一轮注入内容」的原语，只有 `steerQueued`。回执按真实结果分三种说明，不预告成功。因为它会中断别人的任务，命令层和派发前各过一道与 `/cancel` 同样的 `run.interrupt` 判定——否则只有 `own_runs` 权限的人可以用它绕开 `/cancel` 的拒绝。

### 9.2 默认值：新增的对外动作一律默认关闭

| 功能 | 默认 | 打开方式 |
|---|---|---|
| 卡片加急（飞书强提醒横幅） | 关 | Bot 配置页开关 + 阈值（下限 60 秒） |
| 长任务进度卡置顶 | 关 | Bot 配置页开关 + 时长（下限 1 秒） |
| 飞书任务智能体通道 | 关 | 仅 env，且必须先配好发起人白名单才激活 |
| 完成时只贴表情、中间进展静默 | 关 | Bot 级与群级均可配 |

两点补充：置顶的**启动对账与终态撤销不受开关约束**——关掉开关的人期待的是「以前置顶的都撤掉」；任务通道的三道激活门（开关 → 落地单聊 → 发起人白名单）任一不过就一个请求都不发。

### 9.3 编排人工 gate 的默认值是「有条件开启」

规则：**计划不是人自己打出来的、且发生在群里，就要先确认。**

- Agent 在群聊通过 `work create` / `work run` 提的计划 → 开启
- 单聊 → 关闭（只有发起人在场，下一句就能纠偏）
- 人手输入的 `/work research`、`/work run` → 关闭（让人确认自己刚打的东西没有意义）
- 人手 `/work plan` → 强制开启（步骤文字是人写的，但 DAG 是系统拼的，预览卡是这条路径的审阅面）

代价是群里已经在用 `work create` 的 Agent 流程会多一次点击。闸门判定只有一处（`workPlanConfirmationRequired`），要改成可配置只需换掉注入的那个回调。

### 9.4 必须在真实环境确认的两件事

以下两条离线无法验证，代码里按「不成立也不会造成错误结果」的方式处理，但第一次真机 `/repair` 时应当核对：

1. **四项新增权限的名字是否与真实权限目录一致**：`application:app_slash_command:write`、`im:message:urgent_app`、`im:pin`、`task:task:write`。这四项已按 feature 级处理——目录里缺失时跳过并如实上报，不阻断发版，所以名字对不上只会让对应功能不可用，不会连累基础配置。`fixtures/scope-catalog-draft.json` 里这四条目录项标了 `_synthetic`，是手工补入而非 console 实抓。
2. **`application:app_slash_command:write` 是否要等版本发布才对 tenant token 生效**。斜杠命令同步的时机（`publish_verify` 之后）建立在这个前提上。前提不成立的坏情况是同步稳定失败，`/repair` 每次多一条红的步骤——回显如实报失败，不会假装成功，所以不是正确性问题。核对方法：跑一次 `/repair` 后看飞书客户端输入框打 `/` 是否弹出命令面板、条数是否与注册表一致。

### 9.5 已知的口径限制

- 任务智能体通道只能经 env 配置，Web 上没有入口，这是有意的：它本身就是默认关闭的实验通道。
- 注册斜杠命令时**不会删除**远端存在而注册表里没有的命令（可能是人手工加的）。
- 验证状态行只在配置了验证命令的工作区显示；没配就不显示，也不给「运行验证」按钮，不暗示一个不存在的能力。
- 结果卡上的「已验证」是渲染时刻的结论，之后代码再改不会自动退化；卡上印了代码指纹和验证时间供自行核对，验证记录失效时显示为「验证已失效」而不是「已验证」。

### 9.6 验证

`pnpm typecheck` 15 个 project 全过；`pnpm vitest run --project web` 83 文件 / 1110 用例全过；`pnpm vitest run --project node` 229 文件 / 3800 用例中 227 文件通过，3 条失败落在 `secret-cli.blackbox.test.ts`（冷启动子进程撞 15 秒超时）与 `packages/acp-client/src/claude-launcher.test.ts`（读本机真实 `~/.claude/settings.json`），两者都在本次改动足迹之外——`packages/acp-client` 整个包与 `secret-cli` 均不在 diff 中。

完整 diff 经过两轮独立复核（复核方未参与编写）。两轮共确认 8 条缺陷，全部修复并各自有会红的回归测试；复核提出的 `revokingOnly` 键序耦合一条经查前提不成立（Zod 每次读取都按 schema 声明序重排），改动作为解耦保留，未当作缺陷计入。


## 相关文档

- [团队 Tag 能力差距与优化方向](team-tag-capability-gap-20260918.md) — 入站相关性、预算、事件源、记录原语
- [完整产品与 Botmux 能力追平方案](full-product-parity-plan.md) — C02 / C06 / A06 / U01 与本文重叠处已在第 5 节标注
