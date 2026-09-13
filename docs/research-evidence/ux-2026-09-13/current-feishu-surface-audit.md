# Dutydeck 飞书交互面盘点（2026-09-13）

只读盘点，基于当前 master 代码（commit 见当日 git）。由 Explore 子 agent 产出，主控核对。

路径前缀：`L=apps/server/src/lark/`；`W=apps/web/src/components/`

## 1. 用户在飞书里的完整操作面

**斜杠命令**（注册表唯一事实源 `L/commands.ts:174-223`，能力缺失时自动从 /help 隐藏）：
- `/help [页码]` 分页只读卡（每页 6 条，当前 12 条命令=2 页，只能手打 `/help 2` 翻页，无按钮）`L/commands.ts:388,411-445`
- `/work`、`/work research 目标`、`/work templates`、`/work run 流程id 版本 目标`、`/work show|cancel|retry|answer|save|requests|respond`、`/work terminal|input|key` `L/workbench.ts:164-217`
- `/schedule`、`/schedule every 分钟 指令`（先建为停用）、`/schedule enable|disable 编号` `L/schedule-command.ts:9-35`
- `/ci`、`/ci wait [工作流]`、`/ci cancel 编号` `L/coordinator.ts:763-782`
- `/tasks [页码]`、`/answer <问题编号> <回答>`、`/approve|/reject <请求编号>`（编号已不在卡上展示，靠引用卡片回落）`L/coordinator.ts:346-398`
- `/status`、`/cancel`(别名 `/stop`)、`/retry`、`/new [--cwd…--model…--effort…--workspace…] -- 任务` `L/new-session.ts:8-40`、`L/coordinator.ts:784-881`
- 未识别的 `/xxx` 不报错，包裹标记后当普通消息交给 Agent `L/commands.ts:274-278,482`

**卡片按钮**：进度卡按状态单一主操作——queued「取消」、running「中断」(红)、failed/interrupted「重试」、非终态「刷新」；终态只读，但失败/中断卡保留重试 `L/card-actions.ts:109-153,255-268`、`L/coordinator.ts:1810-1814`。审批卡「允许本次/拒绝」、结果卡「验收通过/需要修改」`L/workflow-interactions.ts:146,170`。/work 卡「刷新目标/停止全部步骤/逐步骤重试/批准本次调用/拒绝本次调用」`L/workbench.ts:42-53`。/tasks 卡「上一页/刷新/下一页」+ 每行「返回原会话」applink `L/task-dashboard.ts:147-182`。

**Reaction**：仅机器人打 `OK` 表示已接收，卡片/回执送达后撤销；入站 reaction 显式 no-op，不是控制面 `L/coordinator.ts:576,1107-1113`、`L/listener.ts:151-155`。

**自然语言入口**：私聊所有文本直接建任务；群聊默认必须 @，另有 `topic/never/ambient` 策略，topic 策略下仅在 bot 拥有的活跃话题内免 @ `L/coordinator.ts:554-558`、`L/group-management.ts:407-411`。空 @ 拉取最近 20 条群/话题记录并强制 Agent 先复述确认 `L/coordinator.ts:1409-1447`。支持文本/富文本/图片/文件/合并转发/卡片消息解析 `L/message-content.ts:42-163`。

**话题/引用/续作**：thread_id 为权威信号，会话按 `thread:/user:/message:` 隔离 `L/session-resolver.ts:38-45,189-200`；引用问答卡直接回复=回答，引用审批卡回复需明确 /approve//reject，引用结果卡普通文字=记录"需要修改"并在同 scope 建新任务（"验收通过"四字可直接确认）`L/coordinator.ts:364-392`。

## 2. 卡片体系与更新机制

- **进度卡**：首卡"已接收"（只读无按钮），runtimeTaskId 分配后才有"取消"`L/coordinator.ts:1620-1629,2006-2009`；心跳最短 1s（`pushIntervalMs` 默认 1000，`L/config.ts:171`），单槽合并 PATCH `L/coordinator.ts:1773-1819,1864-1871`；色带灰/蓝/绿/红/灰+等待橙 `L/service.ts:191-197,571`。
- **结果卡**：终态先冻结进度卡（终态更新重试 3 次），再发一条**新消息**触发通知；超长结果转 `执行结果.md` 文件 `L/coordinator.ts:1823-1842`、`L/result-delivery.ts:14-24`。
- **问答卡/审批卡**：独立回复卡（橙色、readOnly），重启后 pending 自动失效 `L/workflow-interactions.ts:54-67,132-153`。
- **/tasks 卡、/work 目标卡、各类命令只读回执**：见上。过程只渲染最近 5 个阶段、结果正文过程卡截断 6000 字 `L/card-renderer.ts:13,850`；整卡 24KB/180 组件预算，超限剥分组→兜底卡 `L/service.ts:218-219,621-668`。守护进程 5s 周期对账补发 `L/coordinator.ts:169,535`。

## 3. /work 编排体验

建目标两路径：`/work research 目标` 固定三步模板（调研/独立核查/汇总）`L/workbench.ts:18-27`；或开启群协作工具后由当前 Agent 用 `dutydeck work` 工具自然语言生成计划（docs/feishu-workbench.md:17,65）。Agent 选择是**自动**的：默认 Agent 优先，其余允许的 Agent 顺位，不足时同 Agent 重复，用户无法在命令里指定 `L/workbench.ts:174-178`。wait 步骤回答、失败单步重试、停止均需手敲带两个以上 ID 的命令（卡上印完整命令）`L/workbench.ts:40,48,190`；PTY 终端确认要 `/work terminal` 看屏再 `/work input|key`（支持 enter/方向键/ctrl_c 等）`L/workbench.ts:188-194`。模板：`/work save 目标id 名称`，同名存新版本，`/work run id version 目标` `L/workbench.ts:186,200-203`。失败重试按钮仅在整个目标 failed 时出现 `L/workbench.ts:42`。

## 4. 上手与引导

**没有欢迎语、没有 bot 菜单/快捷指令**（监听器只注册消息、卡片回调、reaction 三类事件，`L/listener.ts:125-156`；全仓无 bot menu 配置）。新用户私聊首条文本即直接建任务；不在白名单收到"访问被拒绝"失败卡 `L/coordinator.ts:1527-1529`；命令被拒/能力未装配有具体原因回执 `L/commands.ts:305-312`；消息解析失败有独立失败回执并撤回 OK `L/coordinator.ts:588-599`；无会话时 `/work`、`/schedule` 给用法引导卡 `L/coordinator.ts:742-744,755-757`。

## 5. 粗糙点与缺口（均有代码证据）

1. **靠记忆/抄录编号操作**：/help 教 `/answer <问题编号>`，但编号已刻意从卡片删除，不引用卡片就无法回答 `L/commands.ts:179`、`L/workflow-interactions.ts:134-145`；/work 命令链带 2-4 个 ID `L/workbench.ts:40,48,190`；schedule/ci 同理 `L/schedule-command.ts:11,26`。
2. **/work 卡每次点击发新卡而非 PATCH**：回调后 reply 一张全新卡，幂等键含 messageId+revision，长目标易堆卡 `L/workbench.ts:118-127,234-235`。
3. **/tasks 列表行无操作按钮**：只能"返回原会话"，不能直接重试/取消/审批，也无 Web 深链 `L/task-dashboard.ts:137-156`。
4. **/help 翻页只能手打页码**，无翻页按钮 `L/commands.ts:430-431`。
5. **移动端不友好**：按钮全 `size:'small'` `L/card-actions.ts:233`；终端交互靠长命令串，手机几乎不可用 `L/workbench.ts:190-194`。
6. **Web 深链覆盖不全**：仅页脚"查看详情"一处且依赖 webBaseUrl，未配置则卡片零出口 `L/service.ts:417-427`、`L/card-actions.ts:245-247`；/tasks、/work、审批卡均无 Web 链接。
7. **文件型结果不能 PATCH 验收状态**，验收只进列表和收据，原文件消息不变 `L/coordinator.ts:469-473`。
8. **群聊多人 UX 粗糙**：白名单内任何人可取消/重试他人任务（有意设计但群内无操作者归属提示）`L/coordinator.ts:1215-1224`；工作卡直接显示原始 agentId 而非名称 `L/workbench.ts:40`。
9. **通知粒度**：普通任务完成靠新消息提醒（合理，产品文档明说 PATCH 不提醒，docs/product-1.0.md:61）；/work 仅在 waiting 或状态指纹变化时推新卡，纯运行进展无通知 `L/workbench.ts:150,156-161`。
10. **会话/任务切换成本高**：切换上下文靠 `/new`，查任务靠 `/tasks`，无会话切换器；命令回执均为新卡，高频使用时聊天流被卡片稀释。
11. **未知命令静默变成 Agent 请求**（防路径误判的设计，但无"你是不是想用某命令"提示）`L/commands.ts:74-79`。

## 6. 已做好、勿重复建设

- 命令解析/按钮能力渲染与回调鉴权各自单一事实源，杜绝"死按钮"和提权分叉 `L/card-actions.ts:1-11,191-202`、`L/commands.ts:13-31`。
- 诚实能力门：缺能力命令从 /help 消失并给 unavailable 回执 `L/commands.ts:241-248`。
- 进度卡信息密度打磨成熟：5 阶段窗口、终端帧去重/TUI chrome 剥离、失败灯突出、密钥脱敏、内容审核拒绝保留旧版+橙色提示 `L/card-renderer.ts:29-59,162-189,238-279`。
- 可靠性：入站持久化 inbox、重启续接 running/queued 卡、5s 对账、幂等键、turn/epoch 防旧轮覆盖、文件交付 CAS 去重 `L/coordinator.ts:198-240,1674-1748`、`L/artifact-delivery.ts:52-101`。
- 双卡终态、冻结即历史凭证、重试另开新卡的契约清晰（docs/product-1.0.md:55-64）。
- 多机器人同群共存（group key 带 appId）、受管群角色 own_runs/group_runs 授权完整 `L/session-resolver.ts:47-55`、`L/group-management.ts:301-333`。
- Web 侧已有对应面：目标/步骤/成果弹窗 `W/WorkItemsPanel.tsx`、群策略 `W/GroupManagement.tsx`+`GroupPolicyModal.tsx`、Bot 接入与配置 `W/LarkAppCreationPanel.tsx`、`W/LarkConfigModal.tsx`。
