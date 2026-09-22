# Botmux 近 7 天提交评估（2026-09-22）

本文是前期评估快照；后续实现与整合验证见[改进吸收交付记录](botmux-adoption-20260922.md)。

有值得吸收的改进。优先补 **daemon 进程身份校验、Codex/TraeX 输入就绪判断**；其次是 **编辑补 @ 触发、显式最终答案去重、复制失败反馈**。按触发人隔离 CLI 凭据有价值，但需要单独设计，不能作为兼容性小补丁并入。

本轮完成 Botmux 源码同步与评估，Dutydeck 业务代码未修改。既有优化分支应先整合验收，本报告只列新增差异，不重复开工。

## 同步结果与范围

| 项目 | 实测结果 |
|---|---|
| Botmux 仓库 | `../botmux`，远端 `deepcoldy/botmux` |
| 同步命令 | `git fetch origin master`，随后 `git rebase origin/master` |
| 同步前 → 后 | `737c76b42ec314980abb7eb60d37b812255c563a` → `6ab79c78020f1eda362592dd0c558c2b0b8773fc` |
| Rebase 结果 | 无本地独有提交、无冲突；前进 20 个提交，HEAD 与此次 fetch 的 origin/master 差异为 `0 / 0` |
| 审阅窗口 | 2026-09-15 14:20:05 至 2026-09-22 14:20:05，UTC+8，按 committer date |
| 窗口提交数 | 83 个，其中 2 个 merge；沿 master first-parent 为 75 个 |
| Dutydeck 对照基线 | `ceb72bd9509d46eb44d450263aefde5446b10bb2` |

遍历窗口提交列表，对相关业务提交进一步读 diff、现行实现和测试；不把 83 个提交全部视为独立功能，也不声称逐行审计了全部上游改动。Botmux 原有 `.prs-new.json`、`.worktrees/` 均保留。未更新依赖、重启服务或写入真实飞书。

## 建议吸收的五项改进

### 1. 高优先：daemon 控制需要核验进程身份

参考 [26f89920：跨命名空间进程身份](https://github.com/deepcoldy/botmux/commit/26f89920)。收益是避免陈旧 PID 文件让 `start/status` 误报运行，或让 `stop/restart` 向其他进程发信号。

Dutydeck 的 [daemon.ts](../apps/server/src/daemon/daemon.ts) 中，`DaemonState` 未保存进程出生身份；`isDaemonRunning`（133 行）只调用 `pidAlive`，后者用 `kill(pid, 0)` 检查存在性。[command.ts](../apps/server/src/daemon/command.ts) 的 `daemonStop`（168 行）随后直接发 SIGTERM，超时后发 SIGKILL，没有核对进程是否仍属于本服务。隔离探针把探针自身的普通 Node PID 写入临时 daemon 状态文件，真实 `isDaemonRunning` 返回 `true`；未对任何进程发终止信号。

建议在 daemon 启动时保存 host、boot、PID namespace 和出生时间，在状态判断及每次信号前复核；无法证明归属时给出可操作诊断。仓库已有 [process-identity.ts](../packages/storage/src/process-identity.ts) 的数据结构和观测逻辑，但它只在其他资源控制路径使用。可复用其原则，不能简单直接调用就宣称跨平台完成：Darwin 的匹配分支目前仍可能返回 `unknown`。

验收覆盖 PID 复用、重启后的旧状态、命名空间不一致、读取身份失败、TERM 等待期间身份改变以及正常 stop/restart。A1/A2 优化分支没有改这两个 daemon 文件。

### 2. 高优先：补齐 Codex 与 TraeX 的输入反例判断

参考 [7c8bacd4：Codex 恢复就绪](https://github.com/deepcoldy/botmux/commit/7c8bacd4)、[e23d0bb2：精简恢复页脚](https://github.com/deepcoldy/botmux/commit/e23d0bb2) 和 [f037f346：TraeX loading 闸门](https://github.com/deepcoldy/botmux/commit/f037f346)。收益是减少 CLI 尚未能接收输入时提前粘贴任务。

Dutydeck [codex.ts](../packages/cli-adapters/src/adapters/codex.ts) 的 `prepareInput`（51 行）只显式排除 `model/directory: loading`，其余画面出现非编号 `›` 即可返回。调用真实方法的屏幕探针表明：正常 `Context 85% used` 页脚通过，但 `Resuming`、`Working … esc to interrupt`、capacity 排队、未提交草稿、composer 后出现权限菜单这五种反例也都只读屏一次即放行。因此这里的已证实问题是**误判就绪**，不能照搬上游“永久阻塞”的故障结论。

现有 A2 分支增加了通用就绪检查，但会让位于 Codex 自带的 `prepareInput`，所以没有消除该问题。TraeX 也需要把 loading 骨架屏作为未就绪证据；A2 未为它补对应 `startupPendingPattern`。

建议在 A2 上补充底部真实 composer、恢复/运行/菜单等反例判断，沿用既有 30 秒超时和终端诊断。验收使用上游真实形状的屏幕 fixture，并覆盖新建、恢复、首轮、后续轮次及另一种 CLI；真实 CLI 各版本兼容仍需实测。

### 3. 中优先：编辑原消息补 @ 后能够首次触发

参考 [c3baf9fd：编辑补 @](https://github.com/deepcoldy/botmux/commit/c3baf9fd)。用户发出消息后才想起叫机器人，可以直接编辑原消息，无需复制重发。

Dutydeck [listener.ts](../apps/server/src/lark/listener.ts) 当前注册 `im.message.receive_v1`（208 行），[open-platform-configurator.ts](../apps/server/src/lark/open-platform-configurator.ts) 的消息接收事件清单没有 `im.message.updated_v1`。现有 B/C/D 分支同样没有接入。此项是代码确认的入口缺失，真实飞书编辑事件行为为 **unverified**。

建议同时补事件订阅与 handler，通过消息详情恢复正文、附件和身份，再进入既有权限、话题路由和 inbox 去重链。语义限定为“尚未受理、编辑后显式 @ 本 bot 的人类消息首次触发”；已执行消息编辑不重复执行，机器人消息与无 @ 编辑不触发。不能把群历史抓取转成执行入口，也不能无条件给旧 `messageId` 加版本后缀绕过去重。

协调器隔离探针已验证：无 @ 时执行 0 次，同 ID 补 @ 后执行 1 次，重复提交及重建 coordinator 后仍为 1 次。说明现有持久 inbox 可承接这种首次触发，无需复制上游的另一套 JSON 去重存储。实施验收还要覆盖 receive/update 并发、已受理消息、富文本附件、权限撤销、消息无法拉取，以及已有应用升级后的订阅补齐。

### 4. 中优先：显式最终答案与自动回传共用交付记录

参考 [6d53c26b：显式 final 后抑制兜底双发](https://github.com/deepcoldy/botmux/commit/6d53c26b)。收益是 Agent 已把最终答案发到飞书后，平台不用再发送一份同文结果。

Dutydeck [agent-tools.ts](../apps/server/src/lark/agent-tools.ts) 的 `send`（633 行）有内容指纹去重，却没有 `final` 语义，也不写自动结果收据。[coordinator.ts](../apps/server/src/lark/coordinator.ts) 的 `deliverTerminal`（3070 行）只认任务自身的 `finalDeliveredTurn` 等字段；[result-delivery.ts](../apps/server/src/lark/result-delivery.ts) 的 `lark.delivery.*` 只约束自动结果链。用真实群工具服务、真实 coordinator、内存 SQLite、模拟 runtime/provider 的隔离探针得到：显式发送 1 次，自动结果 1 次，正文相同。没有真实网络调用。

建议新增明确的最终交付类型，绑定当前 task、turn、目标话题，只有平台成功收据才能抑制该轮自动答案，并让重启对账读取同一记录。普通进度、交接或发往其他位置的消息不能抑制最终答案；失败、未知交付、空 final 和迟到旧轮请求也不能误吞结果。业务验证状态、结果导出和验收入口仍须保留。

验收覆盖上述边界、并发终态、重启恢复和收据写入失败。该项不同于旧计划中“最终结果不等待过程卡 PATCH”，两项应共用交付状态设计。

### 5. 小范围修复：复制失败不能显示“已复制”

参考 [17f80ec8：剪贴板降级路径](https://github.com/deepcoldy/botmux/commit/17f80ec8) 的测试思路。Dutydeck 的实际问题位于 [MarkdownContent.tsx](../apps/web/src/MarkdownContent.tsx) 的 `CodeBlock.copy`（34 行）：忽略 `execCommand('copy')` 的布尔返回值；Clipboard API 存在但拒绝时直接退出，没有尝试降级。

直接提取现行复制闭包、替换浏览器接口的探针显示：`execCommand=false` 时仍设置 `copied=true`；Clipboard API 拒绝时旧接口调用次数为 0。建议按实际成功结果显示反馈，拒绝后尝试降级，临时节点放在 `finally` 清理，并显示失败状态。

Dutydeck 使用自定义 portal 弹窗，并非上游原生 `<dialog>`，因此不能原样移植 `dialog[open]` 选择器。探针没有证明原生弹窗 inert 故障；完整浏览器剪贴板权限行为仍为 **unverified**。

## 按人授权值得做，但需要单独定义能力边界

[d87ab3e1](https://github.com/deepcoldy/botmux/commit/d87ab3e1) 与 [bb54c4fc](https://github.com/deepcoldy/botmux/commit/bb54c4fc) 把 CLI 工具身份绑定到触发人，并支持授权后在同轮更新工具身份。多用户共用机器人时，这能明确“谁能发起任务”和“工具代表谁访问数据”两个不同问题。

Dutydeck 已有跨应用 owner 身份校验、群动作授权、冻结 actor 和会话能力 token，不能把这些都当成缺失；但它们不等价于为任意工具子进程提供按人的用户凭据隔离。

建议另立范围，只先治理 `lark-cli/bytedcli`：按 app、sender、turn 绑定身份，仅向对应工具子进程提供凭据；缺少用户授权时不能回落宿主身份；授权设备码需校验同一用户，旧轮授权不能覆盖新轮。要分别覆盖人类、机器人代办和定时任务，先明确后两者的身份语义，再接产品入口。不要一并搬入 Botmux 的 XPI、daemon IPC 或统一自动授权策略。

该建议为源码层能力评估，未做真实用户授权或 token 切换。若实施涉及 ACPX session 配置/env 注入，按本项目约束使用小写 `snake_case` 键，并以真实 `AcpxAdapter` 保存会话验证。

## 已有改进与不建议直接移植的部分

9 月 17 日兼容性报告已全文核对。富文本顶层附件、`230031` 过期卡片收敛、Claude 显式 env 优先级、自动化总览轮询都已在当前 master；本轮重跑相关 4 个文件、69 项测试全部通过。历史文档中的旧失败数字不作为本轮测试结果。

以下五条分支均经 `merge-base --is-ancestor <分支> ceb72bd` 确认尚未合入本轮 master。表中表示“已有实现提交”，不表示整合或部署完成，也不表示旧方案全部交付。

| 分支（共同前缀 `feat/opt-20260921-batch1-`） | 固定提交 | 已有实现，应整合验收后再补差异 |
|---|---|---|
| `a1-runtime` | `023d2ad` | 首事件前瞬态网关重试、权限 TTL、主机内存准入和 live driver 上限 |
| `a2-pty` | `1cdf737` | 通用就绪检查、提交确认、停滞检测、Hermes paste、compact 空回合续跑；保留本报告第 2 项缺口 |
| `b-collab` | `f0e1b5c` | 从持久化账本恢复机器人防环深度 |
| `c-product` | `0a2d76a` | 配置生效范围提示、完成后折叠 Trace、群级 `/quiet` |
| `d-reliability` | `0912aa9` | 媒体请求超时与有限重试、重连窗口 shadow 扫描；shadow 不等于补投已启用 |

这些分支共同包含 `16710d7` 的前期研究与批次 0 改进；本轮已全文阅读其中综合评估和实施计划，并以实际 diff 去重。

| 上游主题 | 取舍及理由 |
|---|---|
| 群内多人串行 `787df835`、卡片模式更新串行 `5cd51d5c` | 本项目已有持久任务队列、每会话单 attempt、卡片 PATCH 合并串行处理；保留并发回归场景，无依据整套替换。 |
| 全局监听/群覆写 `e10e60f6` | 本项目已有 Bot 默认、群级参与覆盖；关键词监听不是完全相同的功能，若需要应另定需求，不再引入一套继承系统。 |
| Role 注入覆盖 `df22bf34` | 上游是提示词 Role 的 `once/every` 注入，本项目群权限 role assignment 语义不同；没有同一故障路径，不能混为已有等价修复。 |
| 精确中断与 steer `40927a43`、`f50012a4` | 已有 task/attempt、停止证明和排队/steer 接口；原生 Codex App turn steer 应与现有后端资格计划一起评估。 |
| ZMX socket `2c719f7b`、Bun IPC/二进制相关修复 | 当前 Dutydeck 生产 PTY 入口固定 tmux，上游故障所需后端/打包条件不同；不作为本项目已确认 bug。 |
| 原生表格自适应 `a6ad42d8` | 本项目结果表格走 Markdown/长结果附件交付，缺少同一原生 table 截断链；需先用本项目卡片样本复现。 |
| 飞书加急 `901fbce9` | 已有超时 ask/审批卡的应用内加急及频控；短信/电话加急是扩展产品范围，暂不补。 |
| Bot 添加弹窗滚动 `05d07c51` | 上游特定选择器和弹窗样式与本项目不同，未复现同一问题。 |
| Base 用户权限 `37907352` | 应随按人 CLI 授权所支持的实际功能补齐；不能将应用身份已有权限与用户授权 scope 混为一谈。 |
| 插件设置页、CLI 模型代理、浏览器桥接、跨身份分流 | 分别涉及新运行入口、凭据/网络边界或协作协议；没有作为局部兼容性修复整体引入的依据。 |
| Cursor/Codex App 过程展示、Claude 订阅用量、自动建群/拉 owner | 可保留为产品候选；本轮未完成这些功能的端到端适配评估，不高于已复现修复。 |

## 验证与交付边界

本轮使用源码、分支 diff、定向测试与隔离探针验证，定向测试分别为：

| 范围 | 实际通过 |
|---|---|
| 上轮兼容性四项 | 4 文件，69 项 |
| CLI 适配、进程身份、runtime 控制/账本、daemon、后端选择 | 7 文件，178 项 |
| listener、群工具、结果交付、群参与 | 4 文件，172 项 |
| owner 身份、setup 配置、群策略、弹窗焦点 | 4 文件，91 项 |

独立只读复核已核对提交统计、分支状态、主要代码证据，并重跑双发、编辑去重和复制探针，未发现未解决的 P1/P2 问题。未修改业务代码或现有测试，未运行全仓 build/E2E；真实飞书事件、真实用户授权、真实 CLI 版本矩阵和浏览器剪贴板权限仍需实施时验收。

本地证据目录：`artifacts/botmux-review-20260922/`，包含提交清单、基线和验证记录。报告位于独立 worktree `../dutydeck-botmux-review-20260922`，分支 `docs/botmux-review-20260922`。
