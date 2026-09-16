# 飞书交互与控制修复交付说明（2026-09-16）

交付基线：`61b6e5a6462eb66e08c87f83cca82e7e9822920e` + 三批 worker 补丁（control / interactions / results）+ 原生 AskUserQuestion 增量。
`docs/feishu-ux-review-20260916.md` 为该基线的历史排查结论，保留不动；本文只记录本轮最终落地行为与实测边界。

## 最终行为（按旧审计八类）

1. 排队/取消/中断的 actor 与真实终态
   - 排队取消、`/cancel`、卡片取消统一携带操作人 openId；跨 App/非本人/匿名且有排队的 stop 一律拒绝，且在信号进程前完成全部身份校验，不会先停进程再报错。
   - 终端驱动 Ctrl-C 只表示“请求中断”，必须等 PTY 空闲证据确认后才发终态；中断确认的 completed 带 `cancelled`，未确认前不提前给“已中断”回执。
   - 飞书取消/重试入口支持已有 `cancelled` 状态（与“已中断”区分），可重试；重启后恢复卡可对“尚未提交的排队输入”恢复取消入口。
2. 诚实的恢复/排队状态
   - `getTaskRecovery` 暴露真实 blocker：`DRIVER_RESOURCE_UNSAFE`、`DRIVER_STOP_BLOCKED`、`PREVIOUS_RESULT_UNKNOWN`，以及新增的 `QUEUE_START_CHECK_FAILED`。多个 blocker 同时存在时理由全部保留，不互相覆盖。
   - 不自动重放、不清空任何原执行资源 blocker；`QUEUE_START_CHECK_FAILED` 按实际 helper 显示启动检查失败和 `/cancel`、`/status` 操作。
   - 排队态计时显示“排队等待”，与运行“用时”区分。
   - 恢复描述 `describeLarkTaskRecovery` 只输出状态/blocker 理由和通用 `/cancel`、`/status`，不再给任何无配置的 Dutydeck Web 死入口；导出按钮由 service 按真实配置渲染。
3. 排队取消在队列投影故障下仍可靠
   - `cancelQueued` 已落库成功后，即使内部 `projectQueue()` 再次列举队列失败，也会保留 `queueBlocked`、从内存队列移除该任务并正常返回 cancelled，不再向用户误报取消失败。
4. 提问卡生命周期与显式拒绝
   - 结构化提问卡默认开启（显式 `structuredAskCards:false` 才回退文本）；真实 broker 超时后一个心跳内关闭卡片并置只读，点旧卡或引用旧卡不新建任务。
   - 托管群被拒、群停用、执行门未授权时，对人类显式 @/私聊给“请求未执行＋原因＋下一步”，普通闲聊和其他机器人静默；`/help` 只读权限即可。
5. 控制命令纠错
   - `/cancle`、`/mew`、`/rettry`、`/stpo` 等明确拼错只回纠正卡，不建任务、不把猜测命令交给 Agent；`/resume`、`/usr/bin/bash` 等仍按非命令原文处理。
6. 长结果交付与可恢复回执
   - 超长结果：正文存为以任务名命名的 Markdown 附件，另发一张“本轮结束”摘要卡（节选明确标注“非完整结论”，仅保留既有验收记录的控件，不自动创建验收）；附件与摘要各自有独立持久化幂等收据，中途崩溃重启只补缺失的一条，不重复发送。
   - 普通群（非话题）回复文件/回复摘要均不再下发 `replyInThread:false`，维持原有普通群契约。
7. 公开执行记录导出
   - 终态/恢复卡在有真实持久化任务与轮次时渲染“导出执行记录”；回调先做人/群/轮次/`task.view_result` 授权，再按用户 prompt 与终态事件切分本轮边界，后台把脱敏的“公开执行记录.md”发回原会话。旧快照里的“去 Web 查看”死文案被清理。
8. 原生 AskUserQuestion 桥接与完成判定
   - Claude 家族经 PreToolUse hook（`session native-ask`）把选择题送飞书，答案回填 `tool_result`；过期/取消/通道异常一律 deny。
   - 修复 `TERM=dumb NO_COLOR=1` 下 Ink 增量光标寻址把完成动词切碎导致 `send()` 永不完成：driver 新增渲染视口完成证据兜底（500ms 二次确认），复用全部 onIdle 安全门；提问 hook 运行中（activity 行 / busy footer）绝不提前完成。未改共享 IdleDetector、readyPattern 与 busy guard。

## 实测

以下均在本 worktree（依赖符号链接已隔离，`@dutydeck/*` 指向本 worktree，外部依赖只读链接主仓）实测，命令与退出码见 `/tmp/dutydeck-integration-final-report.md`。

- 类型检查：全部 package + apps/server + apps/web，0 错误。
- 单测/集成：`apps/server/src/lark` 51 文件 / 1056 用例全过；pty-driver + cli-adapters + relay + 核心 runtime（含真实 native ledger）22 文件 / 498 用例全过。注意：`physical-native.test.ts` 因既存 `acpx/runtime` 依赖声明缺口未加载，不能声称全仓 tests 全绿；当前已通过的 51 文件 1056 Lark + 22 文件 498 selected runtime/driver + browser E2E 即为本轮实际验收 Gate。
- 真实 Runtime + SQLite + 真实 PTY 子进程：`control-runtime.integration.test.ts` 7 例全过，覆盖命名 actor 排队取消/可重试、Ctrl-C 经真实子进程确认后推进队列、重启后资源 blocker 保留且仅本人可取消未提交排队、匿名/跨 App stop 拒绝、`QUEUE_START_CHECK_FAILED` 在持续列举故障下可见且取消仍成功并持久化 cancelled。
- 端到端（真实 Chromium + Fastify + SQLite + worktree + DutydeckRuntime，模拟 CLI/合成传输）：Playwright `extended` 项目 `e2e-lark-management` 1 通过 / 0 失败（34.5s），artifact：`/tmp/dutydeck-feishu-ux-final-e2e-20260916/`。
- 真实 Claude Code 2.1.273（本地 fake Anthropic API，无真实飞书）：`TERM=dumb NO_COLOR=1 COLORTERM=''`、答案延迟 5000ms，断言提问等待期间不完成、答案后恰好完成 1 次（`completedBeforeAnswer=false`、completed=1/`end_turn`、ask 请求 1 次、tool_result 收到所选 Beta）。
- 真实 Claude 完整问答+队列贯穿端到端实测（`/tmp/dutydeck-native-chain-DjwhIi/result.json`，ok: true，9 项断言全过）：真实 Claude 2.1.273 + PtyCliDriver + Runtime + SQLite + RelayAskBroker + LarkCoordinator（基于 syntheticFeishu / fakeAPI）；Alice 提问 pending 3.5s 期间 completed 为 0，Bob 请求 queued，实际 Beta 卡片 callback 成功、真实 tool_result=Beta、首 task completed 1、后 task completed 2，旧卡重复点击拒绝。测试 fixture 位于 `/tmp/dutydeck-native-feishu-chain-20260916.mjs`，日志位于 `/tmp/dutydeck-native-feishu-chain.log`。

## 明确边界

- 端到端使用的是模拟 CLI 与合成飞书传输（syntheticFeishu / fakeAPI）、真实 Chromium；未对真实飞书开放平台账号/真机客户端渲染与推送做验证。
- 真实 Claude 复现为本地单机 fake API；飞书卡片交互侧由 native-ask-hook / relay / workflow 测试覆盖。
- 终端菜单并非通用桥接：Claude 家族 AskUserQuestion 走原生 hook，其它 CLI 如需选择题可用既有 `session ask --choices`。
- 历史上两条“旧阻塞任务”不强制释放；部署后通过恢复卡的 blocker 理由与 `/cancel` 路径让用户可见、可处理。
- 未引入新的自动验收生命周期；结果验收仍为 lookup-only、用户显式触发。
- 依赖声明边界：`physical-native.test.ts` 存在既存 `acpx/runtime` 依赖声明缺口，实际验证以本轮通过的 51 文件 1056 Lark + 22 文件 498 selected runtime/driver + 浏览器 E2E 为准。
