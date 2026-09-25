# Dutydeck 全仓代码审查与 P1 修复记录

审查基线：`ae295ac807af957c29386c177fd06cae61917705`。修复分支：`fix/review-p0-p1-20260925`。修复目录：`.trae/worktrees/review-20260925`。所有审查及修复子代理均使用 `trae / GPT-6-Astra`。

## 范围、分级与状态

按 9 个分组向 Astra 子代理下发审查：runtime/workspace、storage/shared、CLI/backend/relay、ACP/PTY/transcript、Lark 接入与调度、Lark 投递与配置、Lark 记忆与工具、Web、自动化与 Leader；另下发修复与交叉复审任务。子代理未返回可用于验收的报告或修复结果，主线程接管检查与实现，并补查 server/auth/daemon/terminal、配置、凭据、构建与 CLI。这里不把任务已下发视为代理已完成审查。重点检查权限和执行生命周期，再检查同步扫描、重复实现及长期资源保留。结论来自当前实现、调用链、真实运行时或有界测试，未将大文件、风格或纯粹重复本身升级为严重问题。

- **P0：0 项确认。** 指大范围不可用、灾难性数据破坏或同等级严重事件；这不等于证明整个仓库不存在 P0。
- **P1：21 项确认。** 指可达的权限越界、核心功能错误、停止/超时失效、显著稳定性或性能风险；本轮要求全部修复并验证。
- **P2：18 项确认。** 指局部功能、可维护性或有规模边界的性能问题；本轮记录后续修复建议。

当前交付状态：**21 项 P1 已修复并通过相关回归，构建、类型检查和 7 项 E2E 全部通过**。最终全量测试 6,071 项通过、7 项跳过，唯一失败与基线相同，是 CLI 用例超过默认 15 秒；该文件放宽诊断时限后 3 项业务断言通过。P2 保留为后续工作。全部修改在独立 worktree，未部署。

## P1 清单

| ID | 问题及影响 | 基线证据 | 已实施修复与验收 | 状态 |
|---|---|---|---|---|
| P1-01 | 验证 shell 退出后后台进程继续写工作区，验证提前成功且停止失效 | `packages/agent-runtime/src/verification.ts:382`；真实 shell 后台延迟写入，验证 passed 后 stop，2.2 秒后文件仍被改写 | 结算前清退并证明原进程组退出；真实 shell 覆盖延迟写入、取消、超时与清退失败 | 已修复，回归通过 |
| P1-02 | 每条流式事件扫描解析整个会话执行历史，同步阻塞服务 | `packages/storage/src/task-execution.ts:511`、runtime `index.ts:210,1175`；真实 SQLite，1/1,000/10,000 attempts 的单次执行投影平均 0.184/11.73/124.78ms；查询计划全表扫描 | attempt fence 点查、按 task 取 attempts、SQL blocker 存在性查询及索引；保留 revision/scope/run fence，复测规模增长 | 已修复，回归通过 |
| P1-03 | tmux 原始会话日志可被本机其他用户读取 | `packages/session-backends/src/tmux-backend.ts:564`；真实隔离 tmux、umask 022，日志 0644 且包含测试 marker | 私有目录 0700、文件 0600，kill/detach 清理；真实 backend 权限回归 | 已修复，回归通过 |
| P1-04 | CLI 后端明确返回 false，提交仍被记录为成功 | CLI adapters 的 Codex/Claude/TraeX `writeInput`，PTY `driver.ts:273,990`；真实 Codex adapter 在正文与 Enter 均 false 时 resolve | 提交代理将明确失败转异常，正文失败不继续 Enter，不写成功 marker、不盲重试 | 已修复，回归通过 |
| P1-05 | zmx 连续输出不断推迟抓取，终端更新饥饿 | `zmx-backend.ts:524,533`；真实子进程协议 fixture 持续输出 1.8 秒只有初始一次 history，安静后才更新 | 已安排的抓取只能提前；抓取中活动保留后续触发，覆盖安静轮询及 detach | 已修复，回归通过 |
| P1-06 | ACP launcher 被杀后真实 Agent 仍存活，驱动误报停止 | `acp-client/agents/env-launcher.mjs:27`、`claude-acp.mjs:51`；真实 AcpxAdapter、持久 sessionKey、忽略 TERM 的 Agent，测得 isStopped=true/realAgentAlive=true | 两个 launcher 的实际 Agent 纳入可升级终止及退出证明；真实持久化和 snake_case 回归 | 已修复，回归通过 |
| P1-07 | 启动后首次发现转录文件跳到 EOF，首轮答案丢失 | `pty-driver/src/transcript/tail.ts:149,188`；真实 Codex resolver 从 undefined 变为文件，答案事件为空、cursor=97 | 区分既有历史、新生文件及恢复 cursor；真实 resolver 首轮答案与已有历史不重放回归 | 已修复，回归通过 |
| P1-08 | `/new` 已作废或明确拒绝的请求重启后重新执行 | `lark/coordinator.ts:3251`，持久 Inbox 仍 received；真实 Coordinator 重建后 dispatch 原已作废命令 | 明确作废/拒绝持久终结；保留 shutdown 恢复语义；覆盖早期、中期作废后重启 | 已修复，回归通过 |
| P1-09 | 恢复的自定义启动参数绕过撤销后的权限检查 | `coordinator.ts:3405,3541`；restoring 被提前清除，真实恢复只检查 task.create 仍以撤权 cwd 启动 | 使用捕获的 restoring 重验 cwd/agent/model/effort，拒绝后终结 Inbox | 已修复，回归通过 |
| P1-10 | 上一任务终态收敛期间收到下一任务内容，结果卡串写 | `coordinator.ts:4185,4246`；暂停 A 的 recovery，注入 B，A final_output 为 A answerB_PRIVATE_RESULT | 同步关闭当前轮次接收并冻结结果；覆盖文本、工具及问答事件归属 | 已修复，回归通过 |
| P1-11 | 群级高风险成员或普通允许成员能兑换实例管理员 cookie | `coordinator.ts:2102` → `auth.ts:305` → `foundation-policy.ts:65`；真实本地 Fastify 兑换 303 后访问无关管理路由 200 | 当前不存在可信飞书身份到实例 owner 的绑定，因此移除所有飞书入口的全局登录票签发；新卡保留会话深链，旧回调指引 Web token 登录，底层通用登录接口保持兼容 | 已修复，回归通过 |
| P1-12 | QPS 配置小于 1 时令牌桶永不放行所有飞书 JSON 请求 | `lark/api-gate.ts:123,317,329`；生产配置 QPS=0.5，2.1 秒后 fetch=0，容量始终不足 1 | 保证 burst 至少 1，保留小数 QPS；虚拟时钟验证首个请求及两秒补充节奏 | 已修复，回归通过 |
| P1-13 | 开放平台响应正文无限等待，占住整个配置任务管理器 | `open-platform-session.ts:736` 在 headers 后清 timeout；原生 fetch 本地每 10ms 滴流，100ms 时限下 350ms 仍 preparing，第二 app 被拒 | deadline 持续至正文结束，含扫码剩余期限；本地原生 fetch 滴流回归释放活动任务 | 已修复，回归通过 |
| P1-14 | 国际 Lark HTTP 客户端丢失 brand，访问飞书域名导致功能失败 | `agent-tools.ts:455`、`lark/service.ts:468`；默认客户端加 stub fetch 的 4 次请求全部到 open.feishu.cn | 统一 brand 选域、传递配置、缓存包含品牌/域名，保留显式域名优先级 | 已修复，回归通过 |
| P1-15 | 记忆会话复用做二次方恢复检查，并重复检查两遍 | `memory-pipeline.ts:769`、runtime `index.ts:935`；1,000 tasks 单次 readiness 读取任务列表 1,001 次、执行投影 1,000,000 次 | 新增会话批量恢复快照，以一次历史遍历替代每任务全量扫描；保留终态任务危险资源阻断，验证快照与逐任务结果一致；启动选会话和派发前各自重新校验 | 已修复，回归通过 |
| P1-16 | 记忆慢任务租约过期被重复接管，超时又可卡在派发或中断 | `memory-pipeline.ts:475,798,828`；推进 16 分钟后两 dispatch/一次 archive；10ms 超时但 interrupt 挂起 70ms 后仍未退订 | UUID 认领绑定进程出生身份，活进程不被陈旧期限接管；完整 deadline 覆盖准备/启动/派发/读写，超时清退有 100ms 宽限；迟到启动先归档，清退失败保留认领 | 已修复，回归通过 |
| P1-17 | Bot 绑定向导不传编辑版本，旧表单覆盖新配置 | `LarkConfigModal.tsx:169,183,190`；DOM 缓存从 rev1 变 rev2 后旧表单无版本提交；真实 save 无版本覆盖为 rev3 | 捕获草稿基准 revision，三条保存路径都 CAS；Hook 后端二次保存也 CAS 并返回该次写入版本，409 保留草稿并可显式重载 | 已修复，回归通过 |
| P1-18 | 明确未发送的熔断错误被记 unknown，永久挡住后续周期 | `schedule-executor.ts:127,153,233`；真实 LARK_CIRCUIT_OPEN 后推进五周期及暂停重启，始终只投递一次；另实证 A 网络失败后退避期间 B 打开熔断，A 的原未知结果被 LarkCircuitOpenError 错盖 | Gate 保留先前尝试错误；仅首次可证未发送的熔断拒绝结算 failed；真正网络结果未知继续 unknown，禁止盲重发 | 已修复，回归通过 |
| P1-19 | Leader 规划超时后迟到启动仍派发真实任务 | `leader-delegation.ts:25,267`、`readonly-decider.ts:145,158`；真实 Runtime 等 failed 落盘后释放 start，仍 driver.send 一次 | 完整 deadline/取消栅栏，迟到启动不 dispatch 并停止 session，约束未清退资源并发 | 已修复，回归通过 |
| P1-20 | 开着终端 WebSocket 时 Fastify 停机死锁 | `terminal/terminal-ws.ts` onClose；真实 Fastify/ws 保持连接，app.close 不结束且资源未释放，客户端 terminate 后才完成；runtime shutdown 不保证 exit 事件 | preClose 阶段终止活动/待升级 socket，迟到 lookup 释放 stream，并复用关闭 Promise；真实 ws 和完整服务重启回归 | 已修复，回归通过 |
| P1-21 | daemon/autostart 日志默认权限泄露首次全局 token | `daemon/daemon.ts:400`、`autostart/autostart.ts:593,655`、`service.ts:157`；umask 022 真实 daemon fixture 得到目录 0755/文件 0644，外置数据库缺父目录保护 | 自有日志目录 0700、文件 0600，修复已有日志权限，避免跟随链接或修改外部父目录 | 已修复，回归通过 |

## P2 清单：本轮保留

| ID | 问题、证据和影响边界 | 建议 |
|---|---|---|
| P2-01 | `agent-runtime/src/ledger.ts:54,66` 永久强引用已安全停止 driver；真实 8 次 stop/resume 后 active=0、records=8，未测生产堆增长 | 已证明退出、操作排空且持久写入后释放内存记录，保留失败清退证据 |
| P2-02 | runtime `index.ts:1852` 每次 send 从 sequence 0 回放；250 历史事件触发 255 事件读取/256 次执行投影 | 默认高水位订阅后立即 inspect，覆盖订阅前已完成竞态 |
| P2-03 | `verification.ts:77` 将未初始化 gitlink 递归回父仓库；真实新 worktree 的未初始化子模块报 Recursive Git repository detected | 指纹纳入 gitlink 与初始化状态，已初始化时继续递归和脏状态检测 |
| P2-04 | `shared/schedule-foundation.ts:377` DST 回拨漏掉第二次 01:30；NY after 2026-11-01T05:45Z 返回次日，应为当天 06:30Z | 候选覆盖回拨窗口，再按 overlap 策略和 UTC 严格未来过滤 |
| P2-05 | 同文件 `:378` 两年逐分钟搜索漏闰日；2028-02-29 后返回 undefined，应为 2032，实测空扫约 521ms | 按日历跳跃搜索，覆盖闰年/世纪年与不可能日期，避免延长逐分钟循环 |
| P2-06 | tmux `cat >> file` 无容量上限；有界实测 2MiB，生产增长/耗尽时间 unverified | 有界转发或安全轮转，保证 tail 连续性，处理异常遗留文件 |
| P2-07 | `relay/ask-broker.ts:152,165,189` answering 清 timer 且 cancelSession 跳过；挂起 publisher 后两方不释放，生产 publisher 无限挂路径 unverified | 发布阶段有界期限，保留先领取答案优先与短暂清退宽限 |
| P2-08 | `transcript/tail.ts:249,261,267` 大行重复 concat 并保留 backing buffer；16×1MiB 分段累计复制 136MiB，消费后仍持有约16MiB | 固定读取块/预算，空 pending 释放内存，超长行明确诊断 |
| P2-09 | `session-resolver.ts:378` `/new --agent claude` 仍携原 Codex 默认模型/effort，真实参数为 claude+gpt-default+xhigh | 切 Agent 时未指定值采用目标默认，同 Agent/显式覆盖维持原语义 |
| P2-10 | `coordinator.ts:1135` 幂等领取前累计 bot 深度；同消息并发三次只 dispatch 一次但 depth=3，下一交接被封 | 按群串行门禁按 messageId 只累计一次，状态有界或复用持久记录 |
| P2-11 | `api-gate.ts:500` half-open 无单探测互斥，注入失败后上游并发峰值3；token bucket 仍限速 | 记录探测持有者，明确取消、失败、成功释放语义 |
| P2-12 | `pin-manager.ts:199` unpin 失败仍写 unpinned；两次 reconcile 只调用一次撤销且首轮误报成功 | 失败保留 pinned，确定性成功后落盘，第二轮可重试 |
| P2-13 | `agent-tools.ts:850` 500条预算前已全量读 sessions/tasks/cards；limit1 仍读取501任务，生产耗时未测 | 列表仓库层过滤/分页，task详情点查后校验 app/chat 隔离 |
| P2-14 | `group-task-context.ts:70,130` watermark 取并集复活已结束项；旧 closed_followup 与空新水位合并后仍存在 | 带顺序的移除证据，避免旧并发写回复活，也保留未送达结束通知 |
| P2-15 | `CollaborationPanel.tsx:156,838` 保存期间继续编辑，成功回调清草稿；DOM 实证 B 被服务端已提交 A 覆盖 | 禁用保存中编辑，或按提交快照只清除未变化草稿并推进 revision |
| P2-16 | `event-history.ts:60` 每条补偿复制全历史；50k历史追加200条144–182ms、中插2.28–2.62s；Node测量，浏览器/中插生产频率 unverified | 批量去重合并、一次分配和索引，完整历史语义保持 |
| P2-17 | `work-items.ts:82,113,154,376` 每秒全历史解析，1,000 cancelled/8,544,890字节一tick为1list+2,000get，普通session授权仍1list | 非目标会话短路，归属点查，只推进活跃/待通知记录；自动化同类扫描一并治理 |
| P2-18 | `session-automation.ts:425,925,954` 仅比较 GitHub runId；同ID attempt1成功→attempt2失败被 skipped，dispatch=0 | 比较(runId,runAttempt)，兼容旧数据，保持HEAD与admission防重 |

## 反证与边界

- 普通入站有持久 CAS，配置写入有串行化与 CAS，工作区操作有身份和状态保护；这些机制没有因为代码较长而被重复报告为缺失。
- 同 app 的群共享记忆是已实现的产品约定；完整 Web 历史也是现有要求，不能通过删除历史掩盖性能问题。
- 外部投递结果真正未知时保持 unknown 属于现有安全语义；本轮仅修“已证明未发送”被错误归类的情况。
- 未验证真实模型、真实飞书服务及真实 zmx/zellij 二进制；相关验证使用真实 Runtime/SQLite/Git/子进程与隔离平台替身，结论不扩展到未测试环境。
- 未运行生产重启、未写真实数据库、未发送外部消息。主 checkout 原有 `.claude/` 保留。

## 验证记录

| 阶段 | 命令/方法 | 结果 |
|---|---|---|
| 基线包构建 | `pnpm build:packages` | 通过 |
| 基线类型检查 | `pnpm typecheck`，先重建 workspace packages | 通过；最初陈旧 dist 引发的缺导出已排除 |
| 基线全量测试 | `pnpm test --maxWorkers=4` | 353文件：352通过/1失败；6,016测试：6,008通过/1失败/7跳过；330.67s |
| 基线失败复跑 | `vitest run apps/server/src/secret-cli.blackbox.test.ts --maxWorkers=1` | 同一 referenced-removal 用例仍超过15s；另外2项通过，未改断言或超时 |
| 基线业务断言核实 | 同文件同命令增加 `--testTimeout=60000`，仅诊断命令参数 | 3项全部通过，问题用例15.402s；确认业务断言通过，默认15s门限失败仍单独保留，不据此宣称基线全绿 |
| 基线全量构建 | `pnpm build` | 通过；Vite 提示现有大 chunk，未作为独立 P1 |
| 基线浏览器验收 | Playwright core + synthetic Lark，7项 | core3通过、extended2通过/2失败；两创建app用例引用过期“扫码创建机器人”按钮，当前按钮为“创建机器人”，默认 forceLogin=false；修复验收脚本对齐当前交互，保留配置/幂等/凭据隐藏断言 |
| P1-01 回归 | workspace-verification + verification-identity | 28 项通过；新增 2 项先在基线失败，覆盖后台写入和清退失败后门禁 |
| P1-03/05 回归 | tmux-capture-permissions + zmx-capture-progress + zmx-backend/tmux-stale-env | 32 项通过、4 项缺 zmx 真二进制跳过；真实隔离 tmux 和子进程协议 fixture 的新增 3 项基线均失败 |
| P1-04 回归 | driver-recovery + driver-start-resume + adapters | 108 项通过；真实 Codex/Claude/TraeX adapter 和隔离 tmux 的 6 项失败提交回归基线均失败，修后不写成功 marker |
| P1-07 回归 | transcript + transcript-sources | 51 项通过；真实 Codex resolver 先无路径、首个 flush 即保留完整首轮答案，已有历史和恢复 cursor 测试保持通过 |
| P1-12/18 回归 | api-gate 三文件 + schedule-executor | 111 项通过；小数 QPS、并发熔断错误来源及未发送周期恢复均先复现失败 |
| P1-13 回归 | open-platform-session 两文件 + jobs | 49 项通过；原生 fetch 本地滴流新增 4 项在基线超时，修后释放请求和 job 槽位 |
| P1-14 回归 | brand-routing + service/agent-tools/chat-mode/listener + app-creation/listener-hot-add | 9 项品牌回归通过；service/agent-tools/chat-mode/listener 合计 190 项通过，app-creation/listener-hot-add 57 项通过；默认 HTTP、WS 重连、群形态及身份缓存隔离，真实 SQLite/Fastify 路由 |
| P1-17 回归 | LarkConfigModal DOM + hooks-install-cas | 55 项通过；三保存路径、草稿重载、Hook 精确版本和异步安装期间 CAS |
| P1-20 回归 | terminal-ws + terminal-ws.shutdown | 28 项通过；真实 Fastify/ws，含不确认关闭、挂起授权/lookup |
| 创建 app 验收脚本 | 隔离 Playwright 2 场景 | 2 项通过；补齐 privilege/draft/approval fixture 并校验先于 publish，未确认发布保持 Bot 停用 |
| P1-06 回归 | launcher-lifecycle + ACPX 边界/生命周期 | 45 项通过；真实 AcpxAdapter、持久 sessionKey，忽略 TERM 的 Agent 及后代清退，信号杀死 launcher 时停止证明保持 unknown；构建复制共享 launcher 文件 |
| P1-08/09/10/11 回归 | new-session、task-inbox、detail-login、relaunch-session 等 | 明确拒绝/作废落 failed，shutdown received 仍可恢复；恢复参数重验；终态任务拒收迟到事件；所有 Lark 回调不签发全局票。最终全量覆盖这些文件 |
| P1-02/15 回归 | storage task-execution + runtime execution-recovery | 规模 1/1,000/10,000 历史的解析数量有界，scope/run/task fence、索引查询计划、历史完整性与批量恢复等价；schema 25 增加两项索引 |
| P1-16 回归 | memory-view/memory/memory-recovery/memory-pipeline.integration/memory-pipeline | 5 文件 108 项通过；活 owner 超过旧陈旧期限仍不被接管；挂起准备/启动/派发有界返回，迟到操作不继续执行或覆盖新认领 |
| P1-19 回归 | leader-delegation.integration + readonly-decider | 真实 Runtime 挂起 3 个 start 后超时，仍占清退并发槽位；释放旧启动后旧会话停止且不派发，第 4 个任务再执行；readonly 14 项通过 |
| P1-21 回归 | private-log、autostart、daemon lifecycle blackbox | 真实日志目录/文件收紧到 0700/0600，保留内容和外部父目录权限，拒绝符号/硬链接，不修改链接目标；全量覆盖 |
| 集成问题修正 | migrations、service、identity-preflight.service、group-runtime.integration、database-control.integration、server-startup.integration、terminal-ws 两文件 | 8 文件 77 项通过；迁移预期补 schema 25，保留旧数据/完整性断言；修复真实服务重复调用 preClose 导致第二次 wss.close 报错 |
| 独立检查 | Chromium/Fastify/SQLite/Git/Runtime 端到端运行；Astra 子代理只读交叉检查 | 独立 E2E 7 项通过；子代理交叉检查未返回，已结束等待，不计作代理复审通过 |
| 最终全仓构建 | `pnpm build`，末次服务变更后再 `pnpm --filter dutydeck build` | 通过；Vite 的现有大 chunk 提示保留 |
| 最终类型检查 | `pnpm typecheck` | 通过 |
| 首轮修复后全量 | `pnpm test --maxWorkers=4` | 363 文件，356 通过/7 失败；6,042 通过/30 失败/7 跳过。29 项由迁移预期与 WS 重复关闭导致，已在 77 项集成回归中修正；余下 1 项仍为基线 CLI 15 秒超时 |
| 最终全量复跑 | `pnpm test --maxWorkers=4` | 363 文件：362 通过/1 失败；6,079 测试：6,071 通过/1 失败/7 跳过，324.42s。唯一失败仍为基线 secret-cli referenced-removal 超过默认 15 秒，未发现新增测试失败 |
| 最终 CLI 业务断言复核 | `vitest run apps/server/src/secret-cli.blackbox.test.ts --maxWorkers=1 --testTimeout=60000` | 3 项通过；问题用例 16.133s。仅本次诊断参数放宽，仓库默认 15s 和业务断言未修改 |
| 浏览器验收 | `pnpm e2e:full:run` | 7 项全部通过，118.31s；core 3 项、synthetic Lark 4 项，包括未登录 API 401、Web token 登录后显示原会话答案 |

基线日志保存在 `/tmp/dutydeck-review-baseline-tests.log`、`/tmp/dutydeck-review-baseline-build-packages.log`、`/tmp/dutydeck-review-baseline-typecheck-built.log`。审查复现脚本在 `/tmp/dutydeck-review-*.mts`、`/tmp/dutydeck-review-web-ae295ac/`、`/tmp/dutydeck-automation-review-ae295ac/`；关键缺陷已落为仓库回归测试，临时脚本不是最终验收替代物。

## 性能复测

本地真实 SQLite，使用合成的已结算历史；保留所有任务与 attempts。以下值来自 `/tmp/dutydeck-review-performance-after.json`，与构建/全测并行运行，不能据此推算线上延迟或严格加速倍数。

| 历史 attempts | 单任务投影平均 ms | attempt fence 点查平均 ms | 整会话批量恢复 ms | 返回历史任务数 |
|---|---:|---:|---:|---:|
| 1 | 0.2171 | 0.0355 | 1.3028 | 1 |
| 1,000 | 0.2159 | 0.0347 | 32.1896 | 1,000 |
| 10,000 | 0.1973 | 0.0318 | 135.7110 | 10,000 |

单任务投影与事件 fence 不再随无关历史增长而反复解析全会话；批量恢复仍按历史规模读取，回归测试核对完整结果与安全阻断语义。

浏览器验收原始结果和 HTML 报告：`artifacts/e2e/run-2026-09-25T14-24-57-693Z-d3f8b2/results.json`、`artifacts/e2e/run-2026-09-25T14-24-57-693Z-d3f8b2/html/index.html`。

最终验证日志：`/tmp/dutydeck-review-final-tests-rerun.log`、`/tmp/dutydeck-review-final-typecheck.log`、`/tmp/dutydeck-review-final-build.log`、`/tmp/dutydeck-review-final-server-build.log`、`/tmp/dutydeck-review-final-secret-diagnostic.log`、`/tmp/dutydeck-review-final-e2e.log`。
