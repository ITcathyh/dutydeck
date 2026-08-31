# Botmux → Dockmux 集成方案交叉设计评审

> 评审日期：2026-08-30  
> 视角：资深产品设计 / 交互设计  
> 性质：设计评审，不包含代码实现

## 1. 评审范围

本次交叉阅读并评审以下三份文档：

1. `docs/botmux-capability-audit.md`
2. `docs/botmux-data-migration-inventory.md`
3. `docs/botmux-parity-plan.md`

重点检查：

- 用户如何从 Botmux 迁移到 Dockmux，而不是只检查字段是否可导入；
- `group × bot` 群配置矩阵是否能表达远端事实、期望策略和实际生效状态；
- 权限分级是否能让普通成员、任务发起人、群操作者和管理员做对事、阻止错事；
- 失败、部分成功、冲突、切流和回滚是否对用户可见、可理解、可恢复；
- 三份文档之间是否存在 P0 优先级、切流语义或验收门槛冲突。

## 2. 总体结论

三份文档的技术底座是可靠的：都反对机械复制 `bots.json`，都认可按 App 切流、per-chat policy、App-scoped identity、持久 backend、secret 隔离、幂等导入和可逆回滚。但当前方案仍更像“安全的数据迁移工程”，还不是一条完整的用户迁移旅程。

最大问题有四个：

1. **当前真实在用能力与阶段优先级冲突。** 唯一启用的 Schedule、Hammer full/gates/skill injection、现有飞书话题上下文被放入较晚阶段或未进入统一 P0 清单。
2. **“canary”名称制造了错误预期。** 同一 Lark App 不能让 Botmux 和 Dockmux 同时消费，当前设计中的 canary 实际是整 App 的受控切流观察，不是小比例或单群灰度。
3. **群矩阵和权限层级只有数据概念，没有完成用户决策模型。** 用户仍不知道一个格子为什么红、改 Bot 默认会影响哪些群、普通请求者能否取消自己的任务。
4. **回滚有技术步骤，缺少运行中用户体验。** 当前没有定义切流失败发生在不同阶段时，系统自动恢复还是等待人工、哪些消息可能需要核对、如何避免 Schedule 双跑或漏跑。

在这些问题修正前，不应使用“无感迁移”或“完整替换”描述当前方案。更准确的目标是：

> 可预检、短暂停顿、零双回复、零静默降级、零权限扩大、活跃上下文有明确去向、可在观察期内安全回退。

## 3. 三份文档的关键冲突

| 主题 | 能力审计 | 数据迁移清单 | Parity 方案 | 评审结论 |
|---|---|---|---|---|
| Schedule | P1 | 本机有 1 条 enabled，未承接应阻断 | Matrix 写 P1/P2，阶段 4 才做 | 当前实例必须 P0；通用产品可 P1，但“源 App 正在使用即升 P0”必须落实到阶段计划 |
| Hammer | 未作为独立能力进入 P0 | 当前 Hammer Bot 使用 full + gates + prompt skill injection，明确 P0 blocker | skills/plugins 在阶段 3，虽写“实际使用升 P0”但无 Hammer 专项 gate | 当前 Hammer App 必须 P0 blocked，不能以普通 Claude Agent 通过 offline verify |
| 历史/活跃 Session | 历史能力整体偏 defer；新 PTY 持久性已列 P0 | 28 条元数据，默认 archive-only | session/history/adopt 放 P2 | 冷历史可 P2；仍活跃的飞书话题与 live tmux continuity 是 P0，需要逐条 probe 和处置 |
| 持久 backend | 已修正为生产接线 P0 缺口 | 明确 server 默认 `PtyBackend`，不允许 tmux 降级 | 明确 P0 | 结论一致，保留 |
| 权限层级 | 提出 `can_talk/can_dispatch/can_operate/can_admin` | 描述 Botmux 的 owner/canOperate/canTalk | 提出 principal/grant/policy evaluator | 四级名称尚无动作定义；`talk` 与 `dispatch` 在 Dockmux 中高度重叠，不能直接进 UI/schema |
| Secret 迁移 | 强调 secret ref 与不泄露 | 倾向 prompt/reference，不直接迁 secret | 支持 private secret ref 导入 | 应允许本机、显式确认、全程不可见的安全转存；强制重填 App Secret 会造成不必要中断 |
| Group tools 旧配置 | 通用能力 P0/P1 | 发现一条旧 App+Chat bridge，但当前 Botmux 源码不消费，无法证明 send 权 | per-chat policy P0/P1 | 应显示“遗留意图待确认”，不能自动当成活跃行为，也不能静默丢弃；send 默认关是正确的 |
| 切流 | 强调 capability gate | Import/Activate 分离 | 按 App lease，状态含 `dockmux_canary` | 单 App 切流正确，但应重命名为“受控切流观察”，避免暗示按群/比例灰度 |

## 4. 必须修改

以下问题会导致实际能力丢失、权限变化、双回复、静默新建上下文或用户无法安全回滚，属于 P0 设计缺陷。

### M1. 分离“产品优先级”和“当前 App 切流阻塞级别”

当前文档使用单一 P0/P1/P2，导致 Schedule、Hammer、活跃 Session 在不同文档中被排到不同阶段。

必须改为两个维度：

| 维度 | 含义 |
|---|---|
| `product_priority` | 该能力对 Dockmux 通用路线图的默认优先级 |
| `cutover_requirement` | 对某个源 App 是 `required / review / archive_allowed / not_used` |

规则：只要拟切流 App 正在使用某能力，且用户可见行为会改变，该能力的 `cutover_requirement` 就必须是 `required`，不受通用路线图优先级影响。

当前实例至少应形成以下 App readiness：

| App | 当前必须解决 | 当前不能用什么方式通过 |
|---|---|---|
| `bdev-helper` | 2 个 oncall 群、per-App+Chat CWD、`topic` mention、1 条 enabled Schedule、遗留 group-tools policy 复核、活跃话题去向、tmux continuity | 不能只导 Bot 配置后新建空 Session；不能跳过 Schedule 后仍标“Ready” |
| `hammer` | Hammer full mode、enforced gates、prompt skill injection、默认 CWD、活跃话题去向、tmux continuity | 不能降级成普通 `claude-code` 并用一次成功回复冒充 parity |
| 退役 TraeX | 只读归档、不可默认复活 | 不进入 live cutover readiness |

验收：迁移中心必须按 App 显示 `Ready / Needs review / Blocked`，并列出阻塞的是哪条用户行为，而不是只列 schema 名称。

### M2. 将“活跃会话连续性”从历史归档中拆出，提升为 P0

“28 条 Session 默认 archive-only”对冷历史是合理的，但用户会在切流后继续回复原飞书话题。若 Dockmux 对原 topic 建立一个新 Session，用户看到的是同一话题，Agent 实际却失去上下文，这是最危险的静默降级之一。

切流前必须逐条把源 Session 分为：

- `live_attachable`：对应 backing tmux/CLI 仍存活，且能验证身份和目录；
- `native_resumable`：进程不在，但 CLI 原生 Session 可安全恢复；
- `summary_handoff`：不能续接，但可生成并由用户确认上下文摘要；
- `cold_archive`：已关闭或不再使用，只读归档；
- `unknown_needs_review`：元数据写 active，但无法证明进程或上下文存在。

每个仍可能收到回复的飞书 topic 必须在切流前选择：

1. 在 Dockmux 继续原上下文；
2. 保持 Botmux 服务该 topic——只有存在明确 per-topic ownership 机制时才可选；
3. 在 Dockmux 新开上下文，并在原话题中明确告知用户“已从摘要重新开始”；
4. 不切该 App。

不能把选项 3 静默执行。若当前架构只能整 App 切流，且不能把旧 topic 留给 Botmux，则活跃话题 adopt/resume 或显式 restart 是 App 切流 P0。

### M3. 把 `dockmux_canary` 重命名并修正用户承诺

同一 App 任一时刻只能有一个 event consumer，因此当前并不存在按比例、按人或按群的真实 canary。建议状态改为：

```text
botmux_active
  -> imported_disabled
  -> verified_offline
  -> ready_for_handoff
  -> draining_botmux
  -> dockmux_observation
  -> dockmux_active
  -> migration_finalized
```

`dockmux_observation` 是整 App 已切流、Botmux 保留用于回滚的观察期。

必须在 UI 明示：

- 配置和验证可以按 Bot、群逐项进行；
- 消息流所有权只能按 App 切换；
- 群矩阵中的多个格子不能独立“上线”不同 runtime；
- 切换期间可能有一个短暂停顿，但不允许双回复。

如确实要“单群试用”，必须使用独立测试 App，不能让同一 App 的两个 consumer 做影子流量。

### M4. 增加完整的迁移中心用户旅程

CLI `plan/apply/rollback` 是执行工具，不是用户旅程。P0 应有一个“Botmux 迁移”中心，至少包含八步：

1. **发现**：展示找到的当前 Bot、群绑定、Schedule、可能活跃的 Session、退役资产和未知项数量；不展示 secret 和 prompt。
2. **选择 App**：按 App 迁移，不默认全选；每张卡显示当前服务状态与阻塞数量。
3. **检查变化**：按“身份、Agent、群、权限、自动化、会话连续性”展示 `保持不变 / 行为变化 / 需确认 / 无法承接`。
4. **解决阻塞**：每个问题只有明确动作，如“验证身份”“选择 workspace 映射”“保留在 Botmux”“显式归档”；不能只有错误码和 CLI flag。
5. **离线验证**：验证 App credential/scope、Agent 登录与启动、workspace、backend、effective policy，但保持 listener 关闭。
6. **准备切流**：展示正在运行的 Turn、排队任务、下一次 Schedule 时间、预计暂停和回滚可用性；用户选择立即、等待 drain 或取消。
7. **受控切流观察**：逐步显示 Botmux 已 drain、watermark 已写、Dockmux lease 已取得、listener 已健康、第一条测试消息已通过。
8. **完成或回滚**：观察期内持续保留 Botmux；只有用户确认后才完成迁移和开始保留期倒计时。

任何阶段关闭页面后都能从持久状态继续，不得要求用户回忆上次执行到哪一步。

### M5. 群矩阵必须同时表达远端事实、期望策略和生效结果

只做 `chat × bot` 勾选表不够。每个 cell 至少有三层状态：

| 层 | 示例 | 来源 |
|---|---|---|
| 飞书事实 | 已入群、已退群、不可见、权限不足、最后同步时间 | Lark API / listener |
| Dockmux 期望 | workspace、Agent、reply/mention、访问策略、群工具策略 | GroupBinding |
| 运行生效 | listener owner、policy revision、last verified、degraded 原因 | runtime / RunSnapshot |

必须支持以下可辨识状态：

- 已入群，未配置；
- 已配置，已入群，尚未切流；
- 已配置且 active；
- 本地有配置，但 Bot 已退群；
- 无法读取群信息；
- 配置冲突；
- 继承 Bot 默认；
- 使用群级覆盖；
- 遗留策略待确认；
- runtime degraded。

矩阵 cell 点击后进入详情抽屉，按以下顺序展示：

1. 群名、Bot 名、远端 membership 和最后同步时间；
2. 当前 runtime owner：Botmux 或 Dockmux；
3. 有效 Agent、workspace 及 readiness；
4. Session/reply/mention 行为，用自然语言描述；
5. 谁可发起、谁可操作、谁可管理；
6. 群工具 read/send；
7. 配置来源与影响范围；
8. 迁移 blocker、最近失败和修复动作。

群 ID/App ID 只作为二级诊断信息，不作为用户主标签。规模变大时应以可搜索群列表 + Bot 状态列为主，矩阵作为运营视图，不能要求用户横向滚动几十个 Bot 完成配置。

### M6. 重构权限表达，不能直接落四级名称

`can_talk` 与 `can_dispatch` 在 Dockmux 中没有稳定差异：一条普通飞书消息通常就会创建 Turn/Task。若不先定义动作，四级角色会在 listener、卡片和设置页各自解释。

建议权限核心按动作能力建模，再提供用户可理解的 preset：

| 能力 | 含义 |
|---|---|
| `request_task` | 发起新任务和继续允许的上下文 |
| `operate_own_task` | 取消、重试、继续本人发起的任务 |
| `operate_group_tasks` | 操作群内任意成员发起的任务 |
| `manage_group_policy` | 修改 workspace、Agent、路由、成员授权 |
| `manage_bot` | 修改 Bot 默认、listener、凭据引用和切流 |

以下能力是正交门禁，不能由角色层级自动获得：

- 高危工具执行；
- 可写终端；
- 群工具发送；
- 跨群/跨 Bot 交接；
- 发放或撤销 grant；
- 修改 secret 或 full-trust。

推荐 UI preset：

- **请求者**：可发起和继续任务；新建 Bot 默认可操作自己的任务；
- **群操作者**：可操作群内所有任务，但不改策略；
- **管理员**：可改群/Bot 策略和授权；高危、终端、secret 仍单独确认。

Botmux 源行为映射必须保真：oncall/allowed group/grant 默认只映射为请求者；`allowedUsers` 映射为管理员。若源端请求者不能操作自己的任务，迁移页应把“沿用源行为”与“允许操作本人任务”作为显式选择，不能静默扩大权限。

`owner_only` 可以作为**新建 Bot**的安全默认，但不能覆盖源端 oncall 群“全群成员可请求、owner 才能管理”的有效行为。迁移摘要必须明确说明哪些群保留全群请求权、谁拥有操作或管理权。

所有 listener 入口、卡片按钮、terminal、群工具和管理 API 必须调用同一个 policy evaluator，并在拒绝时说明缺少的是哪项能力以及谁可授权。

### M7. 将失败与回滚设计成持久的用户状态，而不是 runbook

技术上存在 transaction、before version 和 lease 还不够。迁移中心必须记录每一步状态，并对用户区分：

| 失败阶段 | 默认处理 | 用户看到什么 |
|---|---|---|
| plan/apply 前 | 自动停止，无线上影响 | 哪个源项变化、冲突或无法读取；重新扫描 |
| 配置 transaction 中 | 自动回滚 DB | “未写入任何配置”，附失败实体，不展示 secret |
| Botmux drain 前 | 保持 Botmux active | “切流尚未开始” |
| Botmux 已 drain、Dockmux 未取得 lease | 优先恢复 Botmux；恢复失败则进入人工阻塞 | 当前哪一侧在监听、是否存在静默窗口 |
| Dockmux 已监听、尚未接受消息 | 可自动回滚 | 回滚步骤与健康验证 |
| Dockmux 已接受消息/已启动 Run | 禁止盲目重放；先 drain 并列出需核对事件 | 可能受影响的消息数量、任务状态和人工动作 |
| observation 期 | 可一键发起受控回滚 | 预览正在运行任务、下一次 Schedule、目标配置冲突 |

回滚入口必须先展示：

- 正在运行和排队的 Task；
- 已接收但未完成投递的 Lark 消息；
- 距离下一次 Schedule 还有多久；
- 回滚会恢复哪些配置和 listener；
- 哪些目标记录已被用户修改，因冲突不能自动回滚；
- 是否需要人工处理外部副作用。

不能承诺文件 staging、飞书发版、消息发送等远端动作与 SQLite 同事务；部分成功必须显示“需要人工清理”，并列出具体对象和安全动作。

### M8. 为 Schedule 增加独立 ownership 与 handoff gate

当前唯一 enabled Schedule 属于拟迁移 App。只迁定义不够，还要避免源端和目标端同时触发或都不触发。

Schedule P0 gate 必须包含：

- 源 schedule identity 和目标 identity 的幂等映射；
- 上次运行、下一次运行、时区、目标 App/Chat/topic/workspace 的 effective preview；
- 切流前若临近触发窗口，选择等待本次完成或延后切流；
- 先停止源调度 ownership，再启用目标；
- watermark/occurrence key 防止同一周期双跑；
- 回滚时反向交接 ownership；
- 目标运行失败时不能自动让源端重跑一个可能已产生外部副作用的任务。

阶段计划中的 Schedule 必须从阶段 4 移到 `bdev-helper` 的阶段 1/2 blocker。

### M9. 为 Hammer 建立行为级验证，不用 Agent 启动成功替代

当前 Hammer Bot 的 `full + enforce_gates + prompt skill injection` 是用户选择这个 Bot 的核心。迁移页必须把它显示成独立 capability，而不是一个隐藏在 Agent env/system prompt 中的字段集合。

可接受的处置只有：

1. Dockmux 提供等价 Hammer policy，并通过包含 gate 拒绝路径的 E2E；
2. Hammer App 保持 Botmux active；
3. 用户明确创建一个新的普通 Claude Bot，使用不同身份，不称为 Hammer 迁移。

不能通过“CLI 能启动、能回复一条消息”关闭 Hammer blocker。

### M10. 增加 workspace 和 Agent 登录 readiness，而不只检查路径/二进制

当前配置中同一物理目录可能以 `/home/...` 与 `/data00/...` 两种路径出现。CWD 是用户最敏感的群级配置之一，迁移必须验证：

- canonical realpath；
- 目录存在、可进入、权限正确；
- 是否在 Dockmux 允许的 workspace root 内；
- 软链变化是否会改变安全边界；
- Agent 进程用户是否能读取项目和自己的 CLI 登录态；
- 选择的 backend 能在该目录启动并恢复。

迁移 UI 显示用户熟悉的逻辑路径，同时在诊断中显示 canonical path。不能在路径不存在时自动回退 `~` 或 Bot 默认 CWD。

## 5. 建议修改

以下不会立即造成数据或权限事故，但会明显增加学习成本、误操作和后续维护负担。

### S1. 统一产品术语

三份文档混用 `ChannelBot / lark_bots`、`GroupBinding / lark_chat_policies`、`owner / admin / canOperate`。建议稳定为：

- 产品名：Agent、飞书 Bot、群绑定、角色模板、运行快照；
- 存储名：`agent_configs`、`lark_bots`、`lark_chat_policies` 等只出现在技术详情；
- 权限名：请求者、群操作者、管理员；
- 状态名：已发现、待处理、离线验证通过、准备切流、观察中、已完成、回滚中、已回滚。

### S2. 有效配置预览应以“用户结果”呈现

不要只展示 JSON diff。对每个 Bot/群给出句子：

> 在「某项目群」，`bdev-helper` 使用 Claude Code，于指定 workspace 工作；顶层消息需 @，Bot 话题内可直接续聊；全群可发起任务，仅管理员可改配置；群工具可读，不可发送。

高级用户仍可展开字段级来源和 revision。

### S3. 编辑 Bot 默认值前显示 blast radius

修改 Bot 默认 Agent、workspace、权限或 mention policy 时，应显示：

- 有多少群继承该默认；
- 有多少群有覆盖，不受影响；
- 多少个进行中的 Run 不会变化；
- 变更从哪个新 Run 开始生效。

### S4. 群矩阵支持筛选和问题导向视图

默认筛选应优先显示：

- Needs review；
- 配置与 membership 不一致；
- 切流 blocker；
- listener/runtime degraded；
- 遗留策略未确认。

“全部正常”群可以折叠。矩阵不应成为新的监控墙。

### S5. 对未知资产提供决策而不是单纯 fail closed

Fail closed 是正确的安全默认，但用户还需要下一步。每个 unknown 应支持：

- 查看来源路径和字段名（不展示值）；
- 标记为需要实现；
- 证明为派生缓存后排除；
- 只读归档；
- 取消本 App 迁移。

`excluded_with_reason` 应记录批准人和理由。

### S6. 设定观察期与完成迁移的明确动作

建议默认至少保留一个可配置观察期，期间：

- Botmux 二进制和源数据不删除；
- 每个 App 可执行受控回滚；
- Dashboard 显示健康、消息去重、权限拒绝、Schedule 状态；
- “完成迁移”是显式动作，并展示之后仍保留哪些归档和恢复材料。

### S7. 将迁移历史做成审计时间线

每次 plan/apply/cutover/rollback 形成一条时间线，记录操作者、App、摘要、状态和安全的差异统计。不要把用户逼到 CLI 日志和数据库表中寻找答案。

### S8. 保留 Task-first 首页，迁移和群矩阵放在二级入口

三份文档对这一点判断正确。迁移期间可以在首页显示单一“迁移需要处理”入口，但不应把主工作台永久改造成 Bot/Fleet 表格。

### S9. 允许安全、不可见的本机 Secret 转存

“不输出 Secret”不等于用户必须重新键入已有 App Secret。在同一机器、用户显式确认、源文件权限和 owner 校验通过时，可提供三种选择：

- **复用本机已有凭据**：Importer 在进程内直接写 private secret provider，不进入 manifest、diff、日志、HTTP 或 shell argv；
- **重新输入凭据**：用于主动轮换；
- **稍后配置**：保持 imported disabled。

开放平台 Cookie、dashboard token、运行时 capability 仍禁止迁移并要求重建。

## 6. 认可

以下设计判断应保持，不建议因迁移便利而弱化。

### A1. 按 App 切流并禁止双 listener

同一 Lark App 只能有一个 runtime owner，是避免双回复和乱序的正确底线。需要修改的是“canary”名称和观察期交互，不是 lease 原则。

### A2. Import 与 Activate 分离

导入后保持 `listening=false`、不自动确认 full trust，给用户充分的离线验证窗口，是正确的安全设计。

### A3. 所有源项必须有 disposition

`mapped / staged / runtime_only / unsupported / excluded_with_reason` 和 unknown fail-closed 能阻止“看起来迁完了”的静默丢失。

### A4. per-App + per-Chat 是群策略正确主键

CWD、oncall、mention、reply、群工具和权限不能折叠为纯 chat 级或 Bot 全局设置。`app_id + chat_id` 是正确边界。

### A5. 远端 membership 与本地策略分开

群矩阵不应把“写了配置”当成“Bot 已入群”，也不应在 Lark API 部分失败时伪造成功。

### A6. App-scoped 身份重新验证

不跨 App 复制 `ou_*`，邮箱/union 等身份在目标 App 下重新解析，是迁移权限正确性的前提。

### A7. RunSnapshot 与有效配置来源

进行中的 Run 不跟随默认值漂移，且能解释配置来自 Run、群、Bot、Agent 还是进程默认，是 Dockmux 应强化的优势。

### A8. Secret、ACPX 和群工具边界

公开 DTO 不返回 env/command/secret，ACPX 持久化只写 snake_case 元数据，群工具 capability 绑定 session/app/chat，都是必须保留的设计。

### A9. 不静默把 tmux 降级为 PTY

三份文档最终都正确识别了“package 已存在但生产未接线”的差异。数据库 Session 行不能冒充仍存活的 CLI 进程。

### A10. 事务、provenance、冲突保护和源数据不改写

默认 preserve、目标被人工修改时阻止覆盖、rollback 不修改 Botmux 源数据，是可逆迁移的正确基础。

### A11. 退役 TraeX 默认不复活

backup、identity cache 和历史 Session 不能作为当前 Bot 的权威注册源。归档与激活分开是正确的。

### A12. 不把垂直长尾塞回核心配置

VC、voice、文档评论、旧 Workflow 等应走后续 Connector/Run DAG，而不是扩大核心 Bot 配置和飞书权限范围。

## 7. 修订后的 P0 用户验收门槛

从用户视角，某个 App 只有同时满足以下条件才可显示“可切流”：

- [ ] 这个 App 的身份、Secret 和 owner 已验证，且 Secret 全程不可见；
- [ ] 实际 Agent、登录态、workspace、模型、权限姿态和持久 backend 已通过离线 smoke test；
- [ ] 所有群绑定都显示远端 membership、有效路由、mention、权限和群工具策略；
- [ ] 每个源端正在使用的能力已 `preserved`，或用户明确选择一个不会静默改变行为的处置；
- [ ] enabled Schedule 已有唯一 ownership、next-run 和 rollback 方案；
- [ ] Hammer 等 Bot 专属行为已通过行为级 E2E，或该 App 保持 Botmux active；
- [ ] 所有可能继续收到回复的旧 topic 已选择 adopt/resume/summary restart，不存在静默新上下文；
- [ ] 当前 running/queued Turn 已 drain 或有明确处置；
- [ ] Botmux listener 可按 App 停止，Dockmux lease 可取得，handoff watermark 可写入；
- [ ] 回滚预检为 ready，且用户知道 observation 期间 Botmux 仍被保留；
- [ ] 切流后第一条私聊、普通群、话题群、允许/拒绝用户和群工具 smoke 均有明确验证步骤；
- [ ] UI 能在任何失败阶段说明当前哪一侧在监听、哪些消息/任务需要核对、下一步是重试还是回滚。

## 8. 最终建议

建议先修订三份源文档，形成一份统一的“按 App readiness 清单”，再进入实现计划。优先顺序应是：

1. 统一当前实例的 P0 blocker：oncall/群策略、Schedule、Hammer、活跃话题、持久 backend；
2. 定义迁移中心状态机和无双 listener 的受控切流体验；
3. 完成群矩阵三层状态和权限动作矩阵；
4. 完成失败、部分成功和运行中回滚的用户可见契约；
5. 最后再细化 importer schema、批量操作和 P1/P2 长尾。

如果只完成数据导入、群策略表和 lease，而没有活跃话题去向、Schedule ownership、Hammer 行为验证与可见回滚，就只能称为“安全导入基础设施”，不能称为 Botmux 的无感替换。
