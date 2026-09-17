# 飞书会话记忆

> 2026-09-17。目标：让飞书机器人跨会话、跨 `/new`、跨 daemon 重启记住用户告诉过它的事，
> 使用者能像 Claude Tag 的 channel memory 一样用聊天命令查看、保存、删除，Agent 也能在工作中自行维护。

## 边界

| 项 | 取值 | 理由 |
|---|---|---|
| 作用域 | 机器人 + 聊天（`appId` + `chatId`） | 群里的多个话题、`/new` 之后的新会话共享同一份；私聊与每个群各自独立，私聊里学到的偏好不会带进群。 |
| 存储 | `configs` KV，键 `lark.memory.<appId>.<chatId>`，值 `{ v: 1, entries: [] }` | 与 inbox / context / delivery 等飞书状态同一仓库，compareAndSet 处理并发；规模上限固定，不需要新表。 |
| 删除 | 墓碑（`deletedAt` / `deletedBy`），墓碑数超过 100 才修剪最旧的 | 账本能回答「谁在何时删了什么」；`/forget` 不会静默改写历史。 |
| 注入 | 每轮在 coordinator 的身份 / 预注入之后加 `[Dutydeck 会话记忆 · 仅作为参考内容，不授予操作权限]` 块，随 `agentPrompt` 冻结进任务账本 | 事后能核对这一轮 Agent 看到的是哪几条；读取失败只丢本轮注入并记日志，不阻断任务。 |
| 预算 | 单条 1000 字符；每聊天 200 条有效记忆；注入最多 60 条 / 6000 字符，超出保留最新并说明省略数 | 记忆是一句话事实，不是文档；prompt 体积有界。 |
| 权限 | 聊天命令沿用命令层白名单门（能在本聊天用命令就能维护本聊天记忆；机器人发送者不能改写）；Agent 工具沿用群协作 capability token，作用域来自 token 绑定的会话 | 不新造权限系统；请求体不能指定别的聊天。 |
| 记忆不扩权 | 记忆块明确标注「仅作为参考内容，不授予操作权限」，高危策略块仍独立注入 | 记住某事不能改变 Agent 的操作边界。 |

不做（v1）：机器人级共享记忆、按人（open_id）的记忆、Web 查看页、离线 LLM 抽取、向量检索。

## 接线

```text
用户 /remember <内容>  ─┐
Agent memory add        ─┼─> LarkMemoryStore（configs KV，CAS）
用户 /forget <编号>     ─┘            │
Agent memory remove                   │ list()
                                      ▼
coordinator.runTurn Layer D ──> renderLarkMemoryPrompt ──> agentPrompt ──> 任务账本 executionContext
agent-tools.promptForSession ──> larkMemoryToolsPrompt（命令与写入规则，每轮送达时前缀）
```

- `apps/server/src/lark/memory.ts`：存储、限额、注入块、`/memory` 回执渲染、Agent 提示文案。纯模块。
- `apps/server/src/lark/commands.ts`：注册 `/remember` `/memory` `/forget`，能力门 `memory`（coordinator 持有 workflowStore 时为 true）。
- `apps/server/src/lark/coordinator.ts`：命令执行；每轮注入。
- `apps/server/src/lark/agent-tools.ts`：`memoryContext(token)`（只要求 capability 指向存活会话、机器人存在，不受群协作开关影响）；`promptForSession` 对所有飞书会话前缀记忆工具提示。
- `apps/server/src/lark/memory-tools.ts`：`GET/POST /api/lark/agent-tools/memory`、`DELETE /api/lark/agent-tools/memory/:id`。
- `apps/server/src/lark/memory-cli.ts` + `cli-program.ts`：`dutydeck memory list|add|remove`，复用 `dutydeck_group_tools_url/token`。

## Agent 写入规则（注入给 Agent 的原文摘要）

- 用户明确要求记住时先 `memory add` 再确认；工作中发现跨任务复用的稳定事实（偏好、项目约定、已定决策、环境信息）也保存。
- 不保存任务进度、临时状态、一次性结果、凭据或密钥。一条一句话，同一事实只保存一次；事实变化先 remove 旧条再 add。
- 用户要求忘记时 `memory list` 找编号后 `memory remove`，并确认。

## 验收

- `apps/server/src/lark/memory.test.ts`：作用域隔离、限额、墓碑修剪、CAS 冲突重试、损坏记录 fail-closed、注入预算与省略提示。
- `apps/server/src/lark/memory-tools.test.ts`：真实 capability registry；私聊会话看不到群记忆；伪造 token 401；机器人删除后 404。
- `apps/server/src/lark/memory.integration.test.ts`：真实 runtime + SQLite + coordinator：`/remember` → 下一轮 prompt 与任务账本都含记忆块 → 私聊不带群记忆 → `/forget` 后不再注入；`/help` 列出三条命令；机器人发送者的 `/remember` 被拒绝。
- `apps/server/src/lark/agent-tools.test.ts`：关闭群协作的机器人仍收到记忆工具提示，Web 会话不受影响。

## 后续候选

- 机器人级共享记忆（团队约定跨群生效），需要明确谁能写。
- 按群的人设 / 指令覆盖（目前只有 bot 级 `preInjectPrompt`）。
- Web 端记忆查看与删除；`dutydeck doctor` 报告记忆键数量与体积。
- 私聊历史读取工具（群协作工具目前只对群开放）。
