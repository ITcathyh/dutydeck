# Tag 分层协作：PMO + Leader + Worker

单 Agent 模式下，被 @ 的默认 Agent 既接待沟通又亲自执行，长任务容易把沟通、拆解和实现塞进同一个上下文。分层协作是 Bot 级的「执行方式」开关，把三件事交给不同的 Agent：

| 角色 | 由谁担任 | 做什么 | 权限 |
|---|---|---|---|
| PMO | Bot 默认 Agent（原有话题会话） | 接待、澄清、记下已确认的事实；小事直接答复；执行类任务写简报交给 Leader | 与单 Agent 模式相同 |
| Leader | 配置的 Leader Agent | 后台一次性规划：拆步骤、指派 Worker、写验收标准；最后执行验收步骤 | 规划在新会话里运行：ACP Agent 用 deny-all；终端模式 Agent 没有 deny-all，用完全信任（Claude 即 `--dangerously-skip-permissions`）。验收步骤是目标步骤，权限取话题与 Agent 中较低者 |
| Worker | 配置的 Worker Agent（1–8 个） | 作为目标步骤执行，每步一个独立子会话，可用 worktree 隔离 | 话题与 Agent 中较低者 |

未 @ 的群消息仍由只读判定器（整理 Agent）处理，不受这个开关影响。分层协作只在群聊生效：单聊里目标无法固定交付位置（原有的 `work create` 同样返回 `WORK_ITEM_ORIGIN_MISSING`），单聊保持单 Agent 提示。

## 流程

1. 用户 @ 机器人，消息进入 PMO 会话。分层模式下，提示里的「目标编排」块换成「分层协作」块：PMO 只保留 `delegate`、`list`、`show`，不再自己设计步骤图。
2. PMO 执行 `dutydeck work --turn <本轮凭证> delegate --file brief.json`，简报为 `{"goal","context","idempotencyKey"}`。宿主在本轮内固定交付话题，写入 `leader_delegation:<id>`，立即返回 `planning`，PMO 告知用户后结束本轮。同一请求键重复提交同一份简报返回原记录，简报内容不同则拒绝（409）。
3. Leader 在后台新会话里规划（ACP 为 deny-all，终端模式为完全信任；工作目录为话题工作区，10 分钟超时，会话启动和收尾也算在内；同时最多 3 个规划，其余排队），输出 JSON 计划或 `needs_context` 问题。
4. 宿主校验计划：只能指派名单内的 Worker，最多 11 步、无环；工作区不是 git 仓库时提示 Leader 只用 shared，并把 worktree 步骤改为 shared；最后追加 `leader_review`（Leader 验收）作为目标产物。计划先落盘再建目标；建目标前按当前配置再核一次名单，规划期间被移出名单的 Agent 不执行，按规划失败通知。
5. 目标在原话题出待确认卡，点「开始执行」才派发。
6. 每个子会话在结果保存后由后台停止（完成或失败都停，不占调度循环；重试会起新会话，不复用旧会话）。验收步骤第一行写「验收结论：通过 / 需返修 / 缺少信息」，作为结果卡回到原话题；结论不是「通过」或无法识别时，卡片显示「验收需返修」「验收缺少信息」或「验收待核对」，不显示「已完成」。
7. Leader 需要补充信息或规划失败时，在原话题回复文字；用户补充后，PMO 把新信息并入 context，用新的请求键重新 delegate。这些通知与状态同一次落盘，发送失败时每分钟补发、重启后补发，一小时后放弃。

## 配置

Web → 机器人 → 执行方式。保存时校验：已开启「允许它读取群聊内容」（群工具，PMO 靠它交接），已选 Leader（ACP Agent 都可以；终端模式 Agent 要求机器人和该 Agent 都是完全信任，因为规划和验收都以完全信任运行；旧版 PTY 不行），Worker 为 1–8 个且 Agent 都存在。名单只在提交执行方式、Leader 或 Worker 时校验：已选的 Agent 后来被删，不拦只改其他字段的保存；界面把它标成「已不存在」或「不可用」，取消或改选后才能保存分层设置。存储字段为 `executionMode`、`leaderAgentId`、`workerAgentIds`；切回单 Agent 时保留 Leader 与 Worker 选择。

终端模式 Agent 的权限只能在 `DUTYDECK_AGENTS_JSON` 里设置，重启后生效。例如让内置的原生 Claude（`claude-code`）以完全信任运行：

```json
[{ "id": "claude-code", "name": "Claude", "protocol": "pty-cli", "command": "claude", "permissionMode": "full-trust" }]
```

同 id 的配置替换内置定义，这个 Agent 当 Worker 时的权限上限也随之变成完全信任。之后机器人改成飞书逐项确认、或 Agent 不再是完全信任，已选的终端模式 Leader 在交接、开始规划和建目标前都会被拒（`LEADER_DELEGATION_FORBIDDEN`；按机器人当前配置、原话题会话和 Agent 三者核对），界面把它标成「不可用」。

## 边界

- 模型取各 Agent 定义的默认模型：目标子会话必须与 Agent 定义一致，想让 Leader 用某个模型，就建一个该模型的 Agent 选作 Leader。
- 群里用与话题会话不同的 Agent 原本要管理员权限（`run.change_agent`）。分层模式下，Bot 配置里的 Leader 与 Worker 算管理员已批准，能在群里发起任务的成员就能用；名单外的 Agent 仍要管理员。切回单 Agent 后名单不再算授权，非管理员发起、还没跑完的目标在下一步会被拦下。
- Worker 与验收步骤的权限按「话题与 Agent 取较低者」计算；ask 模式的 Agent 会在目标卡里请求授权，无人值守需要把对应 Agent 设为完全信任。
- 验收步骤「不修改文件」是提示约束，不是权限约束；终端模式 Leader 的规划也是这样。规划会话的高风险拦截按原话题和发起人计算，与目标子会话一致；终端模式会话和 ACP 一样注入 `dutydeck_session_id`，拦截钩子靠它找到会话策略。
- 沿用目标编排的限额：单个目标最多 3 个步骤并行、全局 6 个，单步 1 小时。
- 规划被重启打断时重新规划，计划已落盘时直接建目标；提交超过 30 分钟还没建目标的不再自动执行，原话题收到说明。
- 子会话回收对所有目标生效，包括单 Agent 模式下 `/work`、`work create` 创建的目标。

## 相关代码

- `apps/server/src/leader-delegation.ts`：简报校验、Leader 规划、计划校验、建目标、原话题通知、重启恢复
- `apps/server/src/work-item-tools.ts`：`delegate` 路由与 PMO 提示
- `apps/server/src/work-items.ts`：`workItemId`、子会话回收（`reclaim`）
- `apps/server/src/work-item-policy.ts`：`authorizeWorkItemAgent`，群里换用 Agent 的授权与分层名单放行
- `apps/server/src/lark/readonly-decider.ts`：`runReadonlyPrompt`，判定器与 Leader 规划共用
- `apps/server/src/lark/config.ts`、`apps/web/src/components/BotManagement.tsx`：配置与界面
