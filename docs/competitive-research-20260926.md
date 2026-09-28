# Dutydeck 同类产品深度调研：已有能力与下一步投入

调研与能力核验日期：2026-09-26。源码基线：`2d7162e23629f58e8fcefc4659642154d8cd9587`；配置与库计数快照 19:28:53 CST，CI 环境与实例 registry 补核 19:37–19:38 CST。仅更新研究文档；未修改产品、测试、服务或生产配置。

## 1. 多数候选已有覆盖，先修明确断点、启用现成能力

**Dutydeck 已能接收飞书材料、找回旧任务并继续、复用本地工具和 Skill，也有自动验证返修、CI 续作及内部 Review。上轮多数候选应删除重复建设。** 本轮核验后，最建议修 Web 待核对任务的恢复入口、结果中的相对文件链接、引用/话题读取失败提示，并按工作区启用已有飞书代码验证。具体问题、方案与收益见 §5。

**有实现与当前已启用须分开：** 四个 Bot 都没配验证命令；五个服务均未配置飞书 `/ci` 所需的 GitHub token 或 Codebase secret。Codebase 适配器还缺真实上游载荷验收。正常结果、历史和续作无需新建成果中心、Issue 或编排器；外部 PR/MR 评论自动送回原任务才是确定缺少的新能力，可由用户决定是否投入。

[Botmux 实践](https://bytedance.larkoffice.com/wiki/Aq5awe4eyiqjDckTaHdcehrJnxb) 中的常驻执行、少搬告警材料，[Mew 实践](https://bytedance.larkoffice.com/docx/GLUTdKZXfoKAnUxnxDTc7Covnug) 中同一需求跨实现、测试、Review、CI 推进，都与 Dutydeck 已有链路相关。外部经历用于理解工作，不能充当 Dutydeck 的真实用户事故；本轮技术结论来自源码、隔离执行和只读运行证据，不再把“先调查已有能力是否存在”交给用户。

本报告没有测得用户受影响频率或节省工时。既有搜索页 100 条中 98 条为应用消息、2 条为人类消息；追加检索所有当前身份可见、含 Dutydeck 的人类消息仍为 2 条，均是分享链接与公开仓库请求。这既不足以证明生产痛点，也不能推出没有用户或需求；本轮复现的缺口不依赖虚构用户遭遇来成立。

没有新增无条件 P0。代码仍由人工审核后推送；以后若启用无人值守自动推送，推送前强制检查及防绕过能力仍为**条件 P0**，未满足不启用。沿用 [09-25 §7 用户决定](competitive-review-20260925.md#7-决策记录2026-09-25)：完整 Dashboard 密码登录，单会话分享免密码且只读，使用部署者身份；不做按人凭证隔离、XPI、表情控制、Ephemeral、周指标看板，不重提旧 P0-6 的范围冻结。Tag 真人试点继续暂停；保留非 Tag 默认关闭平台记忆、卡片隐藏记忆的决定，但当前四个 Bot 均显式保存 `memoryEnabled=true`，不能声称该决定已迁移到所有实例。本次不改配置。

## 2. 先校正产品身份和证据边界

### 2.1 同名项目需要分开比较

| 名称 | 本轮识别的对象 | 如何使用其证据 |
|---|---|---|
| Botmux | [deepcoldy/botmux](https://github.com/deepcoldy/botmux) | 最直接的本地 CLI—飞书桥接对照；源码、测试和问题记录一起看 |
| Mew | [字节内部 Mew](https://bytedance.larkoffice.com/wiki/YXL4wupehiDyzUkGnBWcXJ9inFb) | 使用飞书完整文档与讨论线程；不用公开同名仓库替代 |
| 内部 AgentDock | [AgentDock 使用手册](https://bytedance.my.larkoffice.com/docx/SVTxdeVtyoieVXx2paBm4YOUy2e)，指向 `tiktok/agent-dock` 和 `@byted-tiktok/agent-dock` | 与 Dutydeck 的血缘关系未确认，不能把相似 API 当成独立产品验证 |
| 公共 AgentDock | [yuklcool/agentdock](https://github.com/yuklcool/agentdock) 容器工作台、[Nigh/AgentDock](https://github.com/Nigh/AgentDock) 远程终端、[AgentDock/AgentDock](https://github.com/AgentDock/AgentDock) 开发框架 | 分别考察；框架能力不能并入内部 AgentDock 的产品能力 |
| Claude Tag | [Anthropic 官方产品文档](https://claude.com/docs/claude-tag/concepts/how-it-works)；[官方插件仓库](https://github.com/anthropics/claude-tag-plugins) | 平台行为以官方文档为准；插件开源不等于平台实现开源 |
| 追加对照 | cc-connect、OpenTag、Happy / Happy Agent、Vibe Kanban、Linear Agent API | 分别研究驱动失败、执行状态、移动审阅、成果反馈及交互契约 |

Dutydeck 当前 Git remote 是 `ITcathyh/dutydeck`，旧 remote 是 `ITcathyh/dockmux`，历史中可确认 dockmux 改名为 dutydeck；现有第三方声明确认部分代码来自 Botmux。尚未找到它与内部 `tiktok/agent-dock` 的直接血缘证据。因此旧报告“很可能是本项目早期形态”只保留为假设。

### 2.2 调研方式

先整读已有竞品报告与决策，再核对当前源码、关键测试和只读运行状态。外部材料使用 GitHub 当前分支及固定提交、官方文档、飞书文档正文和完整讨论线程。搜索结果只作定位。

技术事实区分**本轮隔离实测、运行只读核对、历史测试、源码确认、官方文档说明**；产品判断另区分**外部真实反馈、团队实践自述、假设**。用户问题报告可以证明当事人遇到的症状与额外操作，不能直接证明根因、普遍发生率或已经修复；团队指南和宣传材料不能当作用户收益实测。外部竞品没有在本机安装运行，因此本文没有性能、成功率或成本的横向实测排名。

## 3. 用户现在能做什么，当前实例还缺哪些条件

### 3.1 能力判断与现成入口

下表的“已有”来自完整调用链和 §7 本地验证；真实模型理解、飞书送达及生产浏览器登录并未据此验收。

| 用户动作 | 现成操作入口 | 本轮判定 | 真正剩余边界 |
|---|---|---|---|
| 把文字和附件交给 Agent | 飞书私聊直接发，群里 @Bot 并附文件；回复附件消息 | **输入链已有**：富文本顶层 files、图片、xlsx 均可下载并随请求送入 Agent。[解析](../apps/server/src/lark/message-content.ts)、[派发](../apps/server/src/lark/coordinator-dispatch.ts) | 本轮使用合成文件和假 Agent；不等于真实 xlsx 已被模型分析并交付，毋须重建附件入口。 |
| 带着引用、话题、文档提问 | 回复材料或在原话题 @Bot；发送 docx/wiki 链接，需要时写“包括子文档” | **读取已有，部分失败告知缺失**：可展开引用、话题增量、文档正文与引用子文档。[收集器](../apps/server/src/lark/task-context.ts) | 即时读取引用/话题报错只留下 sources，未送入 prompt；直接合并转发不自动展开，可回复该转发绕过。不覆盖任意 Wiki 子树、Base/Sheets 或图片正文。 |
| 找旧任务并继续改 | 飞书 `/tasks` 回原话题；原话题 @Bot 续问；主 Web 顶栏切 Bot→原任务→输入框 | **正常续作可用**：隔离浏览器同 session 两轮完成；实例选择和代理已有，线上 registry 已登记全部四个 Bot。[主界面](../apps/web/src/App.tsx)、[代理](../apps/server/src/instance-proxy.ts) | 需可操作权限；分享/归档只读。换话题、换 Bot、`/new` 或 Web“重新启动”不保证保留原生上下文；线上认证及代理发送未实测。 |
| 沿用目录、依赖与指定 Skill | 复用 session/cwd；新任务选现有目录；Web 输入 `/` 选择项目或用户目录的 Skill | **本地复用和 Web 显式选择已有；飞书 `/skills` 接线不通**。[工作区](../packages/agent-runtime/src/workspace.ts)、[Skill 注入](../apps/server/src/skill-delivery.ts) | 新 worktree 仅从提交建基线，不复制未提交 Skill/依赖。飞书身份前缀使旧解析漏掉 `/skills`，可暂用 Web 或让 Agent 读本地文件；不需重装系统或建 Skill 市场。 |
| 改完代码自动测，失败再修 | Web 机器人配置“验证命令”；飞书首次候选卡可保存；飞书任务完成后自动触发 | **源码已有最多两轮返修；当前四 Bot 未配置**。[配置](../apps/web/src/components/LarkConfigModal.tsx)、[自动验证](../apps/server/src/lark/coordinator-cards.ts) | 仅已完成且代码变化的飞书普通任务；命令按 Bot 保存、在 session.cwd 执行。Linux、有 HEAD 的 Git、工具/权限及原话题可续作是前提；Web 普通任务结束的自动钩子缺失。 |
| 手动测并读检查证据 | Web“工作目录、验证与自动化”→执行验证→历史；飞书结果卡“运行验证” | **手动执行与持久历史可用**：浏览器实跑退出 0/7，刷新保留输出、退出码。[交付面板](../apps/web/src/components/SessionDeliveryPanel.tsx) | 手动验证不触发自动返修，也不保存为 Bot 的自动命令；旧代码证据会过期，不能等同全部需求验收。 |
| 等 GitHub Actions 后继续 | Web 同一弹窗的 GitHub 表单；授权 API `POST /api/sessions/:id/automation/ci`；飞书 `/ci wait` | **轮询、原任务续作与通知已有；当前飞书入口未配置提供方**。[自动化](../apps/server/src/session-automation.ts)、[客户端](../apps/server/src/github-actions.ts) | Web/API 可对公开 GitHub 尝试匿名查询，需有效 origin/HEAD；私库需权限。本轮 HTTP 为替身；默认收到摘要继续，不自动下载完整失败日志或保证修好。 |
| 等 Codebase CI，再决定修复 | 有效 Codebase 会话里飞书 `/ci wait`、`/ci`、取消；事件接收 `/api/hooks/codebase` | **源码已接执行；线上未接通**：secret 未配、订阅/事件/任务均 0；上游真实载荷未验收。[CI 服务](../apps/server/src/codebase-ci.ts)、[接收路由](../apps/server/src/ci-hook-routes.ts) | 人工信封/GitLab fixture 通过不证明 Codebase/EventHub 接通。Web 表单只支持 GitHub；未见 shell `dutydeck ci` 或 Codebase 管理 API，飞书 `/ci` 已是现成入口。`/ci fix` 含推送路径，不能直接启用无人值守。 |
| 收 Review 意见继续修改 | 手动贴回原话题/Web；内部 work item 的 `reviewPolicy` 可经授权 API 或开启 groupTools 且持有当前任务 capability 的 work CLI 提交 | **内部 Review 与返修已有；外部评论自动回流未实现**。[内部评审](../apps/server/src/work-items.ts)、[入口](../apps/server/src/work-item-routes.ts) | 已反查评论异名、通用 webhook/automation：GitHub 只读 Actions，Codebase MR 更新不取评论。Agent 用 gh/bytedcli 查评论、建 MR/推送取决于本机工具授权，不能充当平台事件回流。 |
| 看结果、拿文件、处理异常后继续 | Web 任务详情“最终输出”“目标、步骤与成果”；已有投递自动对账补发 | **结果/历史可读，两个 Web 断点已复现**。[目标成果](../apps/web/src/components/WorkItemsPanel.tsx)、[渲染](../apps/web/src/MarkdownContent.tsx)、[恢复后端](../apps/server/src/recovery-routes.ts) | Web 相对文件链接误跳会话路由；飞书已有本地成果上传发送。待核对任务没有 Web 恢复操作，继续发送只排队。自动补发已有，手动补发不列主项；PTY 工具确认仍需终端，手机审批仅覆盖结构化请求。 |

自动验证调用链已追到执行：配置→飞书 dispatch 完成→判定代码变化→终态卡→Runtime/VerificationManager 启动 `/bin/sh`→记录输出与指纹→失败通过持久 inbox 回原会话返修。真实测试失败最多两轮；命令缺失/不可执行、超时、中断或指纹不可信不自动修。没有命令时只可能首次建议保存候选，不自动执行；无候选时没有验证行/按钮。命令使用精简环境，不继承服务 token，默认 300 秒；授权在入口和启动前复查。Web 手动按钮不能证明全入口自动化已存在。[执行器](../packages/agent-runtime/src/verification.ts)、[授权入口](../packages/agent-runtime/src/index.ts)

Codebase 目前解析 Dutydeck 的 `codebase.pipeline/codebase.merge_request` 信封和 GitLab 风格 `object_kind`，兼容 data/payload/event 外包；流水线处理 success/failed，MR 更新仅关联编号，关闭/合入结束等待，不读评论。接收器支持 token 或时间戳签名及事件去重；Dutydeck 不会自行向上游注册订阅。[解析与鉴权](../apps/server/src/codebase-ci.ts)

CI 也已追到执行：GitHub 每分钟轮询当前 HEAD，匹配的 runs 全完成后冻结摘要、派发原 session、按权威 attempt 结算；结果投递失败只重试通知。Codebase 收件→按仓库/分支/HEAD 匹配→固定 key 派发→结算通知；最多三轮修复，但通知失败仅记日志，未见同样的通知重试。202 只表示接收，不能当成任务已创建。修复后检查文件/行数与本地远端跟踪引用，不是所有 shell 推送前的强制保护；见 §6.1 条件 P0。

再次推进需求可复用 session→task/attempt、work item→步骤→多次结果及 digest。内部 Review 校验被审 step/attempt/digest，保留返修历史；验证有 taskId 和代码指纹，但尚未统一强制绑定每个 work item 成果版本，子步骤也不自动走飞书普通任务验证钩子。无需为此先建成果中心、Issue 或新编排器。[验证结构](../packages/shared/src/verification.ts)、[work item 结构](../packages/shared/src/work-items.ts)

其他已覆盖的底座继续保留：密码登录/签名只读分享、drain/不可变发布/回滚、审批提醒与过期、usage ledger/预算准入、记忆审计、PTY 后台任务识别、受限 ACP 原生插话。原生插话当前允许名单只含 Claude ACP，不能扩大到 Codex；数据缺失不能记成零成本。[能力接口](../apps/server/src/app.ts)、[ACP 客户端](../packages/acp-client/src/index.ts)、[用量](../apps/server/src/usage-ledger.ts)

### 3.2 当前实例的配置、版本与历史数据

当前识别到主 Web、三个独立 Bot、Tag 共五个活跃服务。以下运行事实由 controller 只读核对；没有据此执行生产恢复或修改开关。

| 时点与核验项 | 结果 | 判定 |
|---|---|---|
| 19:28:53：验证与 Codebase | 四 Bot 均无 verificationCommand；五库平台验证、Codebase 订阅/webhook 事件/任务均为 0 | 验证未启用，Codebase 没有已保存接入记录；不是代码缺失的证明。 |
| 19:37–19:38：CI 提供方 | 五服务启动环境、CLI 会读的 cwd/.env 均无 Codebase secret 和三种 GitHub token，旧 DOCKMUX 别名也无；文件早于服务启动，Tag 无 .env | 按已核对 CLI/service 入口，当前飞书 `/ci` 提供方未配置；Web 公开 GitHub 匿名路径另论。 |
| 19:37–19:38：实例 registry | 主 Web 已登记三个 Bot 的 4401/4402/4403 与 Tag 4311，均为回环地址 | 独立 DB 不阻断实例选择/代理，无须新建跨实例入口；线上浏览器认证及代理发送未验收。 |
| 19:28:53：参与/工具/记忆 | 三普通 Bot 默认 participation=off；Claude Code/Codex groupTools=false，flash=true；Tag selective、groupTools=true；四 Bot memoryEnabled=true | groupTools 控制主动群工具，participation 控制额外观察；均不能据此否定被唤醒后的直接引用/话题读取；默认参与 off 不代表每个群的有效覆写。显式 memory 配置优先于 HEAD 默认值。 |
| 19:28:53：待核对记录 | Claude Code 3、flash 4、Codex 2、Tag 5、主 Web 0 | 有异常恢复数据，不能相加当用户失败率或虚构业务损失。 |
| 19:30:31：发布归属 | 主 Web+三个 Bot 的运行 bundle hash 匹配 `94d3e7b` manifest；Tag 的 a77f2 元数据与实际 hash 不符 | 主入口版本已确认；Tag 准确版本仍 unverified，不能相信旧元数据。 |

`94d3e7b`（09:43 隔离 Bot 进程）与当前 HEAD `2d7162e`（09:29 非 Tag 默认 memory off）是兄弟提交，从 `d08e642` 分叉，各有一个提交；不能称线上“落后 HEAD”或建议直接升级。task-context、message-content、group-task-context、context-bootstrap、codebase-ci、recovery-routes、verification、skill-delivery、SessionDeliveryPanel、SessionAutomationPanel 两版本无 diff。HEAD 测试可佐证这些相同实现，不能把整包、外围鉴权或 Tag 视为同版本验收。

以下仍为 **11:05:52 历史快照**，本轮未重新统计：一个 Bot 有 3 条 usage，均 unavailable，其余库 0；各库 usage_caps=0、配置权威 legacy；Tag 调度版本 74 行、空闲页 145,644 个、每页 4,096 字节。不能冒充晚间新查，也不能用单次快照证明长期增速或模型成本。

原件：`/tmp/dutydeck-capability-runtime-20260926.json`、同前缀 `runtime-services`、`runtime-version`、`runtime-registry` JSON；历史为 `/tmp/dutydeck-research-20260926-product-runtime.json`。这些临时证据可能清理，正文仅保留判断所需汇总，不复制凭据或配置正文。

## 4. 竞品机制备查：用于方案选择，不证明用户需求

本节保留源码、官方机制与外部问题事实。其中“可借鉴”“应补充”等建议均以 §5 的本产品能力判断、相应方案被选中为前提，不构成实施顺序。某个竞品有诊断页、成果页或发生故障，不足以决定 Dutydeck 要新增同类功能。

### 4.1 Botmux：浏览器诊断与预算的实现边界

Botmux 当前 `32a0e98e9b03` 与上次参考 `79e75b14` 的差异很小，本轮不把既有功能说成一天内的新进展。

需要纠正旧报告的两项判断：

- **不能笼统说 Botmux 没有 doctor。** 当前代码既有手机可打开的 `/workbench-doctor`，也有 `botmux skills doctor`。前者逐项诊断浏览器登录、API、HTTP/WebSocket，并对单项设超时。Dutydeck 值得借鉴的是让用户在出故障的设备上诊断，CLI doctor 不能替代手机端网络检查。[浏览器诊断实现](https://github.com/deepcoldy/botmux/blob/32a0e98e9b031de44c2b0a050f4e3f87415082b8/src/dashboard/workbench-doctor.ts)、[Skill 命令](https://github.com/deepcoldy/botmux/blob/32a0e98e9b031de44c2b0a050f4e3f87415082b8/src/core/skills/cli-admin-command.ts#L486)
- **月预算配置不等于强制限额。** Botmux 的预算 tracker 有账本和告警，但本轮源码搜索未找到 `isBudgetHardStopped` 的生产调用方，注释及测试也明确尚未接入任务准入。Dutydeck 应展示实际执行策略与数据是否完整，不能只对比有没有“预算”字段。[实现边界](https://github.com/deepcoldy/botmux/blob/32a0e98e9b031de44c2b0a050f4e3f87415082b8/src/services/budget-tracker.ts#L319)、[防误导测试](https://github.com/deepcoldy/botmux/blob/32a0e98e9b031de44c2b0a050f4e3f87415082b8/test/budget-tracker.test.ts#L238)

这些结论来自当前源码和测试；具体永久链接列于来源表。Botmux 新近飞书反馈还涉及[卡片按钮](https://applink.feishu.cn/client/thread/open?open_chat_id=oc_80cb2e00fb80d96deb0d9978792b7fb6&open_thread_id=omt_19d30bd65c0f1c9e&openchatid=oc_80cb2e00fb80d96deb0d9978792b7fb6&openthreadid=omt_19d30bd65c0f1c9e&thread_position=-1)、[定时任务身份](https://applink.feishu.cn/client/thread/open?open_chat_id=oc_80cb2e00fb80d96deb0d9978792b7fb6&open_thread_id=omt_19d30bd65c0f1c9e&openchatid=oc_80cb2e00fb80d96deb0d9978792b7fb6&openthreadid=omt_19d30bd65c0f1c9e&thread_position=22)及[新旧安装方式冲突](https://applink.feishu.cn/client/thread/open?open_chat_id=oc_80cb2e00fb80d96deb0d9978792b7fb6&open_thread_id=omt_19d2aeacb74f5c93&openchatid=oc_80cb2e00fb80d96deb0d9978792b7fb6&openthreadid=omt_19d2aeacb74f5c93&thread_position=3)。它们支持“按执行版本与接入环节诊断”的方向，不能未经复现就当成 Dutydeck 的同类 bug。

### 4.2 Mew：持续研发机制与用户受阻记录

Mew 的有用对照是用户可见的运行管理：事件订阅、重叠执行策略、MR 联动，以及查看最近收到的事件和最近运行输出。Dutydeck 已有调度器和 CI 基础；只有真实工作中出现事件难以追查的问题，才考虑沿现有账本补充入口。[Mew Automation](https://bytedance.larkoffice.com/wiki/QECTwfqLSiqK4kksg1Oci7FYnwc)、[MR 联动](https://bytedance.larkoffice.com/wiki/F3WiwKUZkivnaikpZx5cGBgmnxc)

本轮完整线程暴露的场景更有价值：

| 用户遇到的事 | 证据可以支持什么 | 对 Dutydeck 的启发 |
|---|---|---|
| [同话题前两次复用，后续消息进入另一会话](https://applink.feishu.cn/client/thread/open?open_chat_id=oc_dcf8b079029c8602bd9599a56ae909f9&open_thread_id=omt_19d15e058153dbea&openchatid=oc_dcf8b079029c8602bd9599a56ae909f9&openthreadid=omt_19d15e058153dbea&thread_position=-1) | 有具体用户报告及后续问题跟踪；内部解释尚非本轮独立根因复现 | 记录每次消息路由到哪个 session、为什么复用或新建；路由冲突要可见 |
| [空输出排障多次更换解释，用户指出建议无效](https://applink.feishu.cn/client/thread/open?open_chat_id=oc_dcf8b079029c8602bd9599a56ae909f9&open_thread_id=omt_19d1146f6d0e1bef&openchatid=oc_dcf8b079029c8602bd9599a56ae909f9&openthreadid=omt_19d1146f6d0e1bef&thread_position=2) | 支持 Bot 的解释曾被用户反证 | 自动诊断要分“检测到的事实”和“建议排查项”，不要让模型猜测充当状态 |
| [昨天装的 Skill 今天不可用](https://applink.feishu.cn/client/thread/open?open_chat_id=oc_dcf8b079029c8602bd9599a56ae909f9&open_thread_id=omt_19d16bfb630fdb9a&openchatid=oc_dcf8b079029c8602bd9599a56ae909f9&openthreadid=omt_19d16bfb630fdb9a&thread_position=-1) | 用户报告安装内容丢失，人工建议使用持久设备；具体回收时间未独立核实 | 展示 Skill 的来源、版本、实际注入记录和会话生效范围 |
| [没有工具执行却显示成功](https://applink.feishu.cn/client/thread/open?open_chat_id=oc_dcf8b079029c8602bd9599a56ae909f9&open_thread_id=omt_19d1d3441ccf1ce0&openchatid=oc_dcf8b079029c8602bd9599a56ae909f9&openthreadid=omt_19d1d3441ccf1ce0&thread_position=-1) | 用户报告存在；本轮未复现根因或修复效果 | 运行终态、成果存在、验证通过分别呈现 |

Mew 的身份隔离不列为本轮建设项，因为本产品已经明确选择部署者身份。云沙箱生命周期也不直接移植到本地优先产品。

另一个可用的产品划分是 Chat 用于临时探索，Issue 承载跨多轮交付；MR 页面把检查、评论与改动放在一起，修复动作先生成有上下文的任务供确认。Dutydeck 已有持久任务和 work item，不必再引入一套 Issue 系统；应让一次交办及其后续审阅、CI 修复、交付记录保持关联。[团队协作指南](https://bytedance.larkoffice.com/docx/DaYgdCfwVoo8vgxIX1wcbSAmnIc)、[实践自述](https://bytedance.larkoffice.com/docx/GLUTdKZXfoKAnUxnxDTc7Covnug)

Automation 文档还有两个容易漏掉的边界：HTTP 202 只代表收到请求，暂停时也可能不创建 Run；Delivery ID 在同一 Trigger 下去重，同一事件命中多个 Trigger 仍可能产生多次执行。Dutydeck 的接入验收应明确“接收”和“创建任务”各自的结果，不能只检查 webhook 返回成功。[接收、去重与运行语义](https://bytedance.larkoffice.com/wiki/QECTwfqLSiqK4kksg1Oci7FYnwc)

### 4.3 Claude Tag：线程、成果与订阅机制

官方文档把线程当作持续工作入口：长任务用原地更新的清单，成果可以是文件、持续更新的页面或 PR；线程持续存在，计算环境可以回收。这启发 Dutydeck 将文档、代码和验证证据作为可再次打开的成果，而非只在终态消息里列一个路径。[工作机制](https://claude.com/docs/claude-tag/concepts/how-it-works)

值得借鉴的三个细节：

1. 明确完成条件和证明，区分“客观检查通过”“等待用户审阅”“等待用户决策”。Dutydeck 已有独立验证状态，可以进一步把任务目标与交付结果关联。[使用建议](https://claude.com/docs/claude-tag/users/good-habits)
2. PR 订阅覆盖 CI、review 和合入等变化，能在原线程续作。Dutydeck 已有 Codebase CI 路径，是否扩展 review 反馈取决于真实需求中的人工传递是否受阻；不能把“CI 绿了”替代“审阅问题已处理”。[GitHub 工作流](https://claude.com/docs/claude-tag/users/use-cases/work-with-github)
3. 定时任务描述包含触发、关注范围和输出形式，无变化可以不发。其公开接口也有边界：Slack 中配置的是单个 PR 订阅，并非任意仓库事件触发。[Routines](https://claude.com/docs/claude-tag/users/proactivity)

官方说明还表明，技能与指令可能在新线程才生效，平台记忆分频道/工作区/私聊。内部体验文中“不 @ 不响应”之类观察不能覆盖当前官方机制。Dutydeck 应明确自己的模式与生效范围，不照搬 Claude Tag 的默认主动发言或预算耗尽时中止任务策略。[响应规则](https://claude.com/docs/claude-tag/users/when-claude-responds)、[记忆](https://claude.com/docs/claude-tag/users/memory)、[预算](https://claude.com/docs/claude-tag/admins/set-spend-limit)

官方插件仓库进一步把排障分成文件是否到达、启动参数是否引用、运行时是否加载，避免把“安装成功”等同“当前线程可用”。oncall 初始化 Skill 要求做真实只读连接检查，旧记忆只作线索。这些是可复用的诊断方法，属于 Skill 指令，不能当作宿主强制保证；复制插件也不会获得 Tag 的连接凭据。[插件排障](https://github.com/anthropics/claude-tag-plugins/blob/034af83830ff459baeca6feaaa25a0297eb942e2/claude-tag-troubleshoot/skills/debug-plugins/SKILL.md)、[oncall 初始化](https://github.com/anthropics/claude-tag-plugins/blob/034af83830ff459baeca6feaaa25a0297eb942e2/claude-tag-oncall/skills/oncall-init/SKILL.md)

### 4.4 cc-connect：可供适配器核对的外部故障样本

本轮读取的三条具体 issue，适合转为 Dutydeck 回归场景：

| 问题记录 | 报告的行为 | 验收应检查什么 |
|---|---|---|
| [#1900](https://github.com/chenhg5/cc-connect/issues/1900) | 首轮失败后后端 session ID 丢失，后续不能正确续会话 | 首轮失败也保留已确认的原生 session 身份；区分身份不存在与执行失败 |
| [#1891](https://github.com/chenhg5/cc-connect/issues/1891) | OpenCode 在 EOF 路径被兜底当作完成 | 没有明确终态时保留未知/失败，不能仅凭进程 EOF 发成功卡 |
| [#1877](https://github.com/chenhg5/cc-connect/issues/1877) | Claude resume 的旧微轮 result 可能结算新轮 | 终态必须属于当前提交的任务尝试，旧记录不能结算新任务 |

这是外部用户报告与源码线索，不是本轮复现的 Dutydeck 缺陷。涉及对应适配器的方案被选中后，可将这些记录作为协议样本与契约测试的参考；它们不证明新增执行器或功能的必要性。

### 4.5 Happy 与 Vibe Kanban：移动审阅与反馈机制

Happy App 的当前 diff 实现按需加载文件，在手机上限制差异计算量，明确显示文件截断、估算数量和冲突，无法取得比较基线时也不会显示“无改动”。这比把全量终端输出塞进手机更适合审阅。Dutydeck 可以借用这些交互原则，继续使用飞书与现有 Web。[固定版本源码](https://github.com/slopus/happy/blob/8517ab232528a6046271d6010aaed663e1187dfc/packages/happy-app/sources/components/HappyAgentDiffView.tsx)

Happy Agent 的离线测试验证：移动同步不可达时，本地任务仍完成，同步消息留在 outbox。其 chaos 测试还覆盖断流、重连、重复变更和重启，并比较客户端重建状态与服务端状态。本轮仅阅读了测试及关键断言，没有运行其测试套件。[离线场景](https://github.com/slopus/happy-agent/blob/eba156993bf299973ad77eaa61b196eeaf50ca46/packages/gym-tests/tests/happy_sync_does_not_block_local_sessions.test.ts)、[同步场景](https://github.com/slopus/happy-agent/blob/eba156993bf299973ad77eaa61b196eeaf50ca46/packages/gym-tests/tests/happy_api_chaos_sync.test.ts)

Vibe Kanban 把多文件行级评论汇成一条反馈发给 Agent，任务回到执行中；另有分支差异与 PR 入口。这可以成为 Dutydeck 成果页的交互参考。其公司已宣布关闭，项目转为社区维护，本轮不建议依赖其托管服务，也不把 README 的功能广度当作产品成功证据。[审阅文档](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/docs/core-features/reviewing-code-changes.mdx)、[官方公告](https://www.vibekanban.com/blog/shutdown)

### 4.6 Linear：活动状态与不可变输入记录

Linear 把工作中、等待输入、错误、完成和 stale 明确区分；建议以固定下来的 Agent Activities 重建用户输入，而非读取可能被编辑过的评论。Dutydeck 已有任务事件与账本，可以将这一原则用于跨入口排障和自动化事件记录，无需为了借鉴交互而新增 Linear 集成。[交互协议](https://linear.app/developers/agent-interaction)、[最佳实践](https://linear.app/developers/agent-best-practices)

### 4.7 AgentDock：会话连续性与持久化边界

公共 `yuklcool/agentdock` 为容器提供持久工作区，控制台通过统一任务接口和事件流对接驱动。其近期修复有两个直接参考点：首次提交即确定 session ID，后续沿用；提交失败保留草稿，迟到响应不清空用户已经切换到的另一会话。这类细节影响用户能否相信“我现在正在和哪一个任务对话”。[提交逻辑](https://github.com/yuklcool/agentdock/blob/6ae6507b23b6cc7f64bb85da3fc02bc64a21208b/web/console/src/pages/SubmitTaskChat.tsx)、[对应 PR #22](https://github.com/yuklcool/agentdock/pull/22)

它还将工具调用整理成 start/end/error、call ID 和耗时，便于界面呈现有意义的进展；Dutydeck 的 [compactTraceEntries](../apps/server/src/lark/card-renderer.ts) 已按 tool ID 合并 tool_call/tool_result，并保存 startedAt/completedAt；应复用现有配对与状态，增加跨 adapter 的迟到、缺失和重复事件样本验收（D2），不另建一套工具步骤功能。事件接口支持按 sequence 续读，但源码中的持久化仍有吞掉写入异常的 best-effort 路径，不能将“有 SSE 回放”写成任何情况下都不丢记录。[工具事件](https://github.com/yuklcool/agentdock/blob/6ae6507b23b6cc7f64bb85da3fc02bc64a21208b/packages/agentcore/agentcore/drivers/nanobot.py#L353)、[事件接口与持久化](https://github.com/yuklcool/agentdock/blob/6ae6507b23b6cc7f64bb85da3fc02bc64a21208b/services/control_plane/control_plane/routers/tasks.py#L1059)

内部 AgentDock 手册也明确 session 和单轮 task 分开，202 只代表入队，SSE 可断点续读；外部平台可以使用只读卡片，自己管理任务生命周期。这适合检查 Dutydeck 的接口和外部接入体验。手册关于无认证和默认监听地址的描述未经当前源码/发布包核验，本轮不据此判断其线上安全现状。[内部手册](https://bytedance.my.larkoffice.com/docx/SVTxdeVtyoieVXx2paBm4YOUy2e)

`Nigh/AgentDock` 主要解决浏览器远程接管本机终端；浏览器断开与客户端/电脑重启是不同故障层级，内存终端回放不等于持久任务恢复。`AgentDock/AgentDock` 则是 TypeScript 开发框架。两者用于界定路线，不作为团队任务工作台的同口径功能对手。Dutydeck 近期继续完善当前本地执行模式，无需为追随容器工作台额外引入集群控制面。[远程终端仓库](https://github.com/Nigh/AgentDock/tree/7a3371460c1fe1846717ce5c6dbb449e6789a9e8)、[框架仓库](https://github.com/AgentDock/AgentDock/tree/4d9eb73747deda96eb23aea4755e160d8d482eba)

### 4.8 OpenTag：结果需要绑定到准确的对象

OpenTag 将验证失败、证据缺失、结果未知和人工豁免区分；证据还可能因对象不符或版本变化失效。创建 Draft PR 后会重新读取仓库、base/head 和草稿状态，而非仅凭命令退出成功就宣布交付。若相应方案被选中，Dutydeck 可复用现有验证指纹、尝试账本和成果入口：明确证明的是哪份代码、哪次执行、哪个外部对象。[完成条件](https://github.com/amplifthq/opentag/blob/3a3136dcb8395b6dda6c872a8398d21a70935a23/packages/control-protocol/src/completion.ts#L73)、[PR 状态回读](https://github.com/amplifthq/opentag/blob/3a3136dcb8395b6dda6c872a8398d21a70935a23/packages/local-runtime/src/effects/github-draft-pr.ts#L120)

其运行模式仍以 Slack 与配对的本地 runner 为主。工作区校验也不能等同操作系统沙箱。本轮只借鉴对象绑定和结果核对，不移植它的整套控制面或把它宣传为完整的高可用 Agent 集群。[固定版本说明](https://github.com/amplifthq/opentag/tree/3a3136dcb8395b6dda6c872a8398d21a70935a23)

## 5. 建议投入：修补明确断点，配置与新能力分开决定

### 5.1 已有价值直接使用，外部材料保留原本含义

常驻执行、飞书材料输入、原任务续作、本地环境复用已有覆盖；§3 已给出入口和条件。输入框还有排队、插话、打断及审批说明，任务总览和目标面板已有结果与步骤历史，自动化总览已有任务转计划、下次时间和上下文。它们不再作为新功能候选。[输入框](../apps/web/src/components/Composer.tsx)、[任务总览](../apps/web/src/components/WorkspaceOverview.tsx)、[自动化总览](../apps/web/src/components/AutomationOverview.tsx)

外部证据仍各自有边界：[cc-connect #1884](https://github.com/chenhg5/cc-connect/issues/1884) 报告文字+xlsx 同发未送达、单发文件可绕过；Dutydeck 已覆盖其顶层 files 输入形态，本轮未做真实 xlsx 模型交付验收。[Mew 多轮研发](https://bytedance.larkoffice.com/docx/GLUTdKZXfoKAnUxnxDTc7Covnug) 是工作自述，不证明不满；§4.2 的续会话、Skill 消失和空输出是外部用户症状，不能套作 Dutydeck 事故。

[Mew 团队指南](https://bytedance.larkoffice.com/docx/DaYgdCfwVoo8vgxIX1wcbSAmnIc) 的评审前确认与评审后回写是场景线索；[Claude Tag 体验分享](https://bytedance.larkoffice.com/wiki/W9kcwVRctirJM8kcFahcQgN9nRb) 是次级资料，两者没有测得 Dutydeck 收益，不据此扩大目标用户到所有团队角色。

### 5.2 八项具体建议：问题、现状、方案、收益与等级

P1 是已复现的交付/续作断点或现成代码验证的启用；P2 是特定入口修补与接入投入；P3 是有绕过办法的小便利。下表是建议，尚未批准实施；没有新增无条件 P0，自动推送仍受 §6.1 的条件 P0 约束。用户影响频率、收益均未量化，不填写 ROI 或省时比例。

| 问题 / 等级 | 当前状态与证据 | 预期方案 | 预期收益 |
|---|---|---|---|
| ① Web 待核对任务无法按提示继续 · **P1，修补** | 真实隔离浏览器中，UI 显示“输入新指令即可继续”，原 task 实为 reconcile_required，新指令只 queued；未发任何恢复请求。后端已有 owner 恢复接口。[恢复路由](../apps/server/src/recovery-routes.ts)、[界面状态](../apps/web/src/workspace-model.ts) | 在原详情显示未知结果与排队原因，接现有 inspect/probe/confirm 等恢复操作；由有权限的安装者先看证据、确认结果，完成核对后再续作，不自动重跑。 | 主要帮助异常后从 Web 继续的人，避免按错误提示反复发送，保留已执行动作及原记录。 |
| ② Web 结果中的相对文件链接打不开 · **P1，修补** | fixture 的 deliverable.txt 确实存在，点击最终输出中的相对链接却跳到 `/sessions/deliverable.txt`，报“找不到这个任务”。仅确认此形态；飞书已有[本地成果上传发送](../apps/server/src/lark/artifact-delivery.ts)，不能泛称没有文件交付。[结果渲染](../apps/web/src/MarkdownContent.tsx) | 复用现有结果区提供受控下载/预览或有效链接，校验文件归属、访问权限与路径；HTML 按静态内容处理，文件缺失明确提示。 | 用户能从交付结果取得实际文件，减少回终端找路径；不用再建成果中心。 |
| ③ 引用/话题读取失败未告知 · **P1，修补** | 实际函数探针产生两个 sources 错误，派发 prompt 却只有原请求；收集器与调用方的接线已核对。附件、文档失败另有标记，不能泛化为全都静默。[材料收集](../apps/server/src/lark/task-context.ts)、[派发](../apps/server/src/lark/coordinator-dispatch.ts) | 将缺失来源送入 prompt 或直接显示；明确哪条引用/哪个话题没读到、如何补齐，不建新上下文平台。 | 降低用户依据材料不全答复作判断的风险，减少追问材料是否读到；这是风险判断，未声称已发生业务事故。 |
| ④ 飞书代码任务尚未启用自动验证 · **P1，配置事项** | 自动检查与最多两轮返修已有集成测试；四 Bot verificationCommand 均空、五库验证记录为 0。[机器人配置](../apps/web/src/components/LarkConfigModal.tsx)、[验证链](../apps/server/src/lark/coordinator-cards.ts) | 按目标工作区选合适命令，在同一目录、服务工具和权限条件下先跑通，再经现有配置启用。命令按 Bot 存储，跨项目 Bot 不能随意填一条全局命令。本次不改线上。 | 减少每轮手动再发“跑测试、失败再改”；保留命令异常分类与返修上限。不把配置列为新增开发。 |
| ⑤ 飞书显式指定 Skill 未传到平台加载器 · **P2，修补** | Web 选择可用；飞书 `/skills` 加身份前缀后，解析结果为空，派发也没有结构化 skillRequests。[Skill 加载](../apps/server/src/skill-delivery.ts) | 在加身份前缀前解析用户指令，或传结构化请求；沿用现有目录发现、正文快照与摘要校验。 | 飞书也能明确指定本轮使用的 Skill，减少转 Web 或反复要求读文件；不建市场或重装系统。 |
| ⑥ Codebase CI 有实现但未接上游 · **P2，接入** | 线上无 secret/订阅/事件；本地测试仅人工信封/GitLab 载荷，真实 Codebase/EventHub 字段与签名未验收。[适配器](../apps/server/src/codebase-ci.ts)、[接收器](../apps/server/src/ci-hook-routes.ts) | 维护侧取得已有脱敏事件验收适配器，再打通上游投递；先启用等待/通知并保留人工决定修复。飞书 `/ci` 可复用，Web 管理页非先决条件；推送条件不满足前，不启用 `/ci fix` 或其他含自动推送的修复路径。 | 减少主动查 CI、转贴状态与提醒继续；接收、匹配、派发、通知分别可追查。技术契约由维护侧负责，不请用户判断能否接。 |
| ⑦ 外部 Review 评论不能自动回原任务 · **P2，新能力** | 内部 work item Review 和手动贴意见续作已有；异名和通用 webhook/automation 反查后，未发现 PR/MR 评论自动收取到执行的链路。[现有内部评审](../apps/server/src/work-items.ts) | 若用户需要省去找/贴评论，新增外部评论接入、去重、代码版本绑定和处理回执，复用原 task/work item；明确哪些意见已处理、哪些仍待人决定。 | 减少评论搬运及回查遗漏；接受手动贴意见时无需投入。不同于创建 MR、推送代码或已有内部 Review。 |
| ⑧ 直接合并转发没有自动展开 · **P3，小便利** | 当前直接入站仅保留 message_id；回复这条转发再提问已可展开并下载材料。[消息入口](../apps/server/src/lark/session-resolver.ts) | 需要时补直接入站的已授权展开，复用引用链和读取预算，不增加另一套消息平台。 | 少一次“回复转发再提问”的操作；有现成绕过办法，排在上述修补之后。 |

### 5.3 最建议先做的事，以及用户需要决定什么

**先选修补包①②③，并并行决定④的启用范围。** 恢复、文件交付和读取失败提示都已有隔离复现及明确接线位置，影响的是用户继续工作、取得文件与判断材料完整性。它们复用已有页面和后端，技术上不需要再调查“Dutydeck 有没有能力”。验证则已有真实本地执行链，应由维护侧按工作区完成命令配置和启用验收，不新增验证引擎。

随后按入口需求选⑤⑥：主要在飞书工作就补显式 Skill；需要 Codebase 状态回流就投入真实接入验收。⑦是值得单独决定的新能力：希望自动收外部评论就做，能接受原话题手动贴意见就不做。用户需要决定的是修补投入、现成能力启用范围，以及是否新增评论自动回流；调查技术能否工作由维护侧承担。

自动补发已经覆盖真实 SQLite 回执复用和重启后只补缺失阶段；手动“只补发结果”按钮可留 P3 备选，不单列主项。Web 普通任务结束的自动验证钩子确实缺失，但当前有手动验证，不在缺少使用需求证据时扩建全入口自动化。

QA 平台、新增 Issue 体系、成果中心、大 Dashboard、完整 IDE、容器平台、Skill 市场继续不投。[Mew 数字团队试点](https://bytedance.larkoffice.com/docx/TqOKdn1USoDp3kxL3kjcZcFWntg) 只试两份用例，其中一份有人参与编写调试，尚未进正式 QA 群，本研究没有重跑；不足以扩展业务场景。Tag 真人试点、多 Agent 分工、技术评审会助手也不因本轮核验自动恢复。

### 5.4 选定后怎样验收，不再重做能力调查

| 选定事项 | 维护侧交付条件 | 仍需如实保留的边界 |
|---|---|---|
| ①②③ 修补 | 浏览器完成“读恢复证据→有权确认→原会话续作”；真实文件从原结果可取；引用/话题失败明确指出来源与补齐办法。 | 无权/过期决策/活进程必须拒绝；文件访问不能越权或执行 HTML 脚本；不能靠自动重跑掩盖未知结果。 |
| ④ 配置启用 | 每个目标 Bot/目录记录实际命令、退出码和指纹；飞书完成触发验证，真实测试失败按上限返修，基础设施错误停止。 | 配置保存不等于执行通过；跨目录要重新核对，模型修复效果和真实飞书送达需单独验收。 |
| ⑤⑥ 入口与接入 | 飞书指定 Skill 的正文确实进入该轮；真实脱敏 Codebase 事件通过字段/签名/重复投递/原任务绑定检查，再接上游。 | 合成 payload 不替代真实契约；HTTP 202 不等于创建任务，通知失败与执行失败分开；不越过推送条件 P0。 |
| ⑦ 外部评论 | 真实授权评论绑定原任务和代码版本，重复/旧版本不误触发，返修有意见回执且历史保留。 | 内部 Review、人工贴意见与建 MR 不能作为外部订阅验收替代；仍保留人工技术判断。 |

上述是未来实施验收条件，并未在本次全部执行。影响频率和实际减少的补搬、传话、排障操作尚未测量，可在选定方案使用后观察；不会因此撤回已确认的技术缺口，也不增加专门指标看板。

### 5.5 Claude Code 调研如何采纳

参考来自同一 Herdr 的 Claude Code pane，完整定位见 §7.5。它提供第二份方案视角；以下保留此前按仓库事实、原始资料与 09-25 用户决定作出的技术取舍，不把参考稿中的推演或旧数字视为新实测。表中工程 ID、补充项与 P1/P3 说法用于追溯原提案；以 §5 本轮能力判断和相应方案被选中为前提，不是已排期实施。

| 参考意见 | 采纳方式 | 原因与本报告落点 |
|---|---|---|
| 独立发布、drain、审批超时作为新 P0；引用 45 次重启、80% | **修正** | 这些数字属于 09-25 历史口径；§3 已核实独立发布、drain、提醒/过期存在。可选增量是 A1/A2 恢复体验、G2 运行事实，不重复建设，也不承诺彻底消除未知结果 |
| native steering、usage ledger、Codebase CI 从零建设 | **修正后采纳目标** | 已有实现；分别改为 D1/D2 能力与关键回归、G3 数据质量、B1/B2 真实执行与接入。当前 Claude ACP 允许名单不能扩大表述为 Codex ACP 也可用 |
| group.tail 纯内存导致队列全丢，应替换持久优先队列 | **暂缓重构，校正事实** | [task-inbox](../apps/server/src/lark/task-inbox.ts) 有持久 CAS、received/request；[coordinator-inbound](../apps/server/src/lark/coordinator-inbound.ts) initializeWorkflows 回放 recoverable、重接 running/queued 原卡。内存串行链不等于持久任务全丢；先有实际瓶颈样本再谈重构，不新造事故 |
| 挂起审批立即让出执行槽，避免 /status 等命令排队 | **不直接采纳** | 聊天命令先 routeChatCommand 再加入 group.tail，不能说 /status 被审批任务卡住。同 session 普通任务仍串行；未证明后续写任务可独立执行前，不能无条件让出执行槽。已有超时/提醒/阻塞说明继续复用 |
| 长文本按 2000/6000 字符阈值折叠、附件降级 | **修正后保留交付目标** | [prepareLarkResult](../apps/server/src/lark/result-delivery.ts) 已按卡片能否保留全文决定 .md 附件降级，[card-renderer](../apps/server/src/lark/card-renderer.ts) 已有折叠。upload/message/summary 已有幂等回执，不照抄阈值；可选增量是 C1/C2 审阅与 E2 只补失败阶段 |
| config.summary.content JSON 必然驱动官方步骤条；24KB/180 组件等为官方限制 | **unverified，仅留 P3 验证线索，不单列交付项** | 本轮无相应官方契约与实机证据；[service](../apps/server/src/lark/service.ts) 当前 summary 仅为摘要标题，名字不能证明支持步骤条。参考中的 ACK 超时、CardKit 频率/交互限制也不直接作当前契约；有需求时先小型验证，不列 P1 已知可行方案 |
| tool call 步骤化展示 | **复用已有，补异常验收** | compactTraceEntries 已按 tool ID 配对并留开始/完成时间；D2 增加跨 adapter 异常样本，不重建步骤列表或假定私有协议可用 |
| actor 身份隔离、表情控制、Ephemeral、XPI | **不纳入任何实施队列** | 与 09-25 §7 用户决定不符；沿用部署者身份及现有鉴权。不能据此反推已发生越权 |
| Tag 激活与更复杂多 Agent 协作 | **保留条件** | 真人试点继续暂停；仅 H1/H2 保留待验证问题，不自动恢复，不预排月份 |
| worktree 无条件 24h 强制删除 | **不采纳** | 不能以时间替代可删判断；须保留运行中、未提交内容、外部修改保护。现有安全清理不在本轮重建范围 |
| Botmux“纯 PTY 无插话”、竞品无校验以及领先/落后排名 | **不采纳排名** | 缺同版本、同任务横向实测；§2–4 只保留可追溯机制和边界，不从协议名字推导产品优劣 |

## 6. 技术方案备查：选中相应方案后才适用

以下保留关键底线和全部 23 项验收。§3 已判断现成能力，§5 已给出修补与投入建议；不要求先建成果页、诊断页或做完全部工程项才能使用产品。无人值守自动推送须先满足 B3 强制检查及防绕过条件；当前人工审核推送不变。

旧工程 ID 仅供追溯，不能从技术清单反推新需求或把已实现部分重复排期。

| 当前建议或条件 | 旧工程项 | 适用边界与验收关联 |
|---|---|---|
| ① Web 恢复核对 | A1、A2、D2；必要时 F1 | 接既有 owner 恢复后端，验收 1–3、13、15、19。 |
| ② 相对文件交付；⑦ 外部评论回流 | C1、C2；必要时 E1 | 复用结果与原任务，补受控文件访问或版本绑定反馈；验收 7–9、18。 |
| ③ 材料读取失败；⑧ 直接转发展开 | D2 | 复用上下文读取，补具体异常/入口；23 项不能替代真实材料检查。 |
| ④ 自动验证配置；⑥ Codebase 接入 | B1、B2、E1 | 已有执行链，配置与真实契约验收分别处理；验收 4、5、16、17。 |
| ⑤ 显式 Skill；正常续作兼容 | G1、G2、D1、D2 | 修接线、保留目录/加载边界，不扩展平台 memory；验收 10、11、19、21。 |
| 自动补发的后续小入口 | E2 | 沿用已存回执，仅重试失败投递；验收 12、20，当前非主项。 |
| 无人值守自动推送 | B3 | 条件 P0；启用前完成宿主强制限制，验收 6。 |
| 随改动的文档、兼容、实例能力说明 | G1、G2、D2、F1 | 适用才改，非独立开发路线；验收 1、7、10、11、13、14、19、21。 |
| 用量口径 | G3 | 数据真实性保留；无单列费用优化需求，验收 22。 |
| 配置迁移 | G4 | 明确管理需求后才启动，验收 23。 |
| 团队关联与多 Agent 分工 | H1、H2 | Tag 试点明确恢复且有需求后再考虑；当前不启动，验收 23。 |

### 6.1 关键实施底线与安全边界补充

以下保留原技术边界，作为相应方案被选中后的约束；启动条件见上文。适用时不得降低边界要求，但保留这些原则不代表批准建设对应功能。

1. **任务恢复权限与并发控制（对应 A1、A2）**：依据 [recovery-routes](../apps/server/src/recovery-routes.ts) 与 [task-recovery](../apps/server/src/lark/task-recovery.ts)，只有登录且具有所有者权限（owner）的操作者才能在任务详情发起检查或执行恢复决策；单会话只读分享链接不开放恢复读写接口。原任务的底层进程仍然存活时，系统必须拒绝重复拉起新执行；若任务状态版本（revision）已发生变化，一律拒绝过期决策。
2. **底层协议兼容与持久化键名（对应 D1、D2）**：依据 [capabilities](../apps/server/src/app.ts)，升级主要 Agent 时，必须使用脱敏样本集针对首轮失败丢失会话、连接中断误报完成、旧结果覆盖新轮等场景进行回归；检查保存会话和继续对话是否正常；尤其必须使用真实 `AcpxAdapter` 校验持久化会话配置，严格执行递归 `snake_case` 小写蛇形命名校验，杜绝注入大写环境变量导致保存会话失败；不兼容版本按能力回退排队或提示人工恢复。
3. **测试命令与代码指纹（对应 B1）**：复用现有“执行验证”、自动验证及历史入口，在目标实例与工作目录中记录实际检查结果和代码指纹，并关联到本次成果；命令配置成功不代表执行通过，明确区分权限缺失、找不到命令、执行超时与断言失败；一旦工作区代码发生修改，旧验证证据立即失效，防止误判代码已通过。
4. **代码仓库事件去重与推送强制边界（对应 B2、B3）**：依据 [codebase-ci](../apps/server/src/codebase-ci.ts)，内部 Codebase/EventHub 接入须按事件唯一标识去重，同一订阅同一事件最多接收一次任务；停用规则后的迟到事件不得套用新规则。在正式启用机器人无人值守自动推送代码前，系统宿主必须强制核验目标分支、远端代码提交是否被抢先变动，并确认测试真实通过；若任意 shell 命令或脚本仍可绕过该检查向远端推送，严禁宣称具备强制推送安全保证。
5. **成果页沙箱安全与改动判定（对应 C1、C2）**：依据 [SessionDeliveryPanel](../apps/web/src/components/SessionDeliveryPanel.tsx)，成果页展示的 HTML 文件仅作为普通静态文件提供下载与查看，严禁在管理界面上下文中直接执行脚本；共享工作区内的代码变动，必须按当前轮次前后的文件内容指纹及明确范围判定归属，严禁将他人改动混入。
6. **自动化排障与结果补发（对应 E1、E2）**：依据 [SessionAutomationPanel](../apps/web/src/components/SessionAutomationPanel.tsx)、[AutomationOverview](../apps/web/src/components/AutomationOverview.tsx) 与 [result-delivery](../apps/server/src/lark/result-delivery.ts)，自动化任务须串联完整生命周期并支持失败阶段单独补发，避免无故重跑整个任务。
7. **设备诊断脱敏原则（对应 F1）**：针对手机和本地电脑的诊断页面默认只读检查已有证据，主动测试单独明示；排障信息导出包仅包含版本号、错误码和关联 ID，严禁包含任何聊天文本、认证 Token 或环境变量。
8. **用量统计与数据真实性（对应 G3）**：依据 [usage-ledger](../apps/server/src/usage-ledger.ts)，用量统计必须明确区分厂商回传的实际用量、按价格表估算的费用与未获取状态，不把缺数据当成零消耗，不把估算当成实付。
9. **工作目录生命周期管理**：工作目录与临时分支不得仅凭固定的时间阈值（如无条件 24 小时）强制删除，清理前必须严格判定是否处于运行中、是否有未提交修改以及是否存在外部修改保护。
10. **成果、上下文与反馈归属（对应 C1、C2、D1、D2、H1）**：成果与检查须关联原 task/attempt 和成果版本；整体反馈、批注返修复用原 session 路由，版本变化不静默套用旧位置。首发失败保留已确认 session 身份和草稿；迟到响应不能写入已切换的会话。大 diff、二进制、重命名、删除、截断和目录清理须明确说明；原任务的输出与上一版成果不能被返修覆盖后失去追溯。跨话题关联仅在试点恢复后由人指定，摘要标注来源与冲突，不凭相似度自动合并。
11. **通知回执与计划语义（对应 E1、E2）**：复用真实 upload/message/summary 回执和幂等记录，只补未完成阶段；上游可能已收到而本地超时时保留未知，核对后再决定补发，不能以盲目重试保证送达。复用现有计划的下次时间、上下文与重叠策略，区分事件接收、匹配、建任务、执行和通知结果；任务成功不因通知失败重跑。
12. **运行事实与使用说明（对应 G1、G2、F1）**：文档随功能说明密码登录、本机免密适用条件、只读分享、恢复边界、非 Tag 记忆默认关闭及群共享范围，移除启动打印 Token、无条件零状态丢失等过时承诺。维护侧保留实例版本、启动时间、实际配置路径及草稿/生效状态；实例切换隔离缓存。Skill 区分登记、启动引用、当前 session 加载与实际调用，不以进程在线或安装成功代替可用证据。
13. **迁移与分工的启动条件（对应 G4、H2）**：明确配置管理需求后才制定 V2 切换与回滚方案，验证 listener 不双启、凭据失效和在途任务语义；未触发前不迁移。Tag 试点恢复且有具体分工需求后，比较单 Agent 与分工的交付质量、用时和消耗，无可比较证据不增加协作层级。

相关实现与代码入口参考：

- 服务端核心能力接口：[能力展示接口](../apps/server/src/app.ts)
- 飞书任务恢复与引导：[任务恢复模块](../apps/server/src/lark/task-recovery.ts)
- Token 与费用记录：[用量账本模块](../apps/server/src/usage-ledger.ts)
- 自动化计划总览：[自动化概览组件](../apps/web/src/components/AutomationOverview.tsx)
- 自动化触发排障：[自动化面板组件](../apps/web/src/components/SessionAutomationPanel.tsx)
- 交付成果展示面板：[成果交付面板](../apps/web/src/components/SessionDeliveryPanel.tsx)

### 6.2 验收场景与预期结果

以下保留原 14 个验收场景（1–14）并补充必要边界（15–23），共 23 项验收标准。**它们是验收标准，不是本次全部通过的清单**。本轮已执行的相关测试、负向观察及未完成的真实外部验收见 §7.1；历史测试另列，不能以局部覆盖宣称整项验收完成。

| # | 验收场景 | 应看到的结果 | 关联方案 |
|---|---|---|---|
| 1 | 任务有输出，终态回执丢失 | 显示未知及证据，不伪造完成，不默认重做 | A1/A2、D2 |
| 2 | 原进程还活着时点击恢复 | 先核对所有权与资源状态，拒绝重复启动 | A2 |
| 3 | 单会话分享链接访问恢复操作 | 仅能查看获授权会话内容；恢复读写接口均拒绝 | A1/A2 |
| 4 | 首次保存验证命令 | 正确实例和目录产生真实记录；配置成功与执行成功分开 | B1 |
| 5 | 真实 Codebase 事件重复送达 | 同一订阅只接收一次任务，有去重依据 | B2、E1 |
| 6 | 修复期间远端 head 改变 | 受控推送拒绝，旧证据失效；未实现强制边界时只交付待人工推送结果 | B3（无人值守启用条件） |
| 7 | Agent 自称完成，但没有成果或验证 | 保留运行终态，明确成果/验证状态 | C1、B1、D2 |
| 8 | 对旧 diff 提交反馈 | 标明版本已变化，不静默错配行号 | C2 |
| 9 | 一个任务多条反馈 | 汇为一次明确返修，绑定原任务和成果版本 | C2 |
| 10 | 升级后 resume 读到旧 result | 不能结算本轮任务 | D2 |
| 11 | 不支持原生插话的 Agent | 明确显示排队，不假报已注入 | D1/D2 |
| 12 | 执行成功、飞书投递失败 | 只补投递，不重做任务 | E2 |
| 13 | 手机断网再连接 | 状态可追平，未知空白不能显示为无任务 | D2、F1 |
| 14 | 切换到旧版本实例 | 明确显示实例与能力差异，不带入另一实例缓存 | F1、G2 |
| 15 | 无终态、原生上下文失效；恢复重复点击/过期 revision | 证据分别可解释；后端只允许当前有效决策，重复点击不建两次执行 | A1/A2 |
| 16 | 验证权限缺失、命令不存在、超时、测试失败；随后改代码 | 分类说明，不无限返修；代码变化令旧证据失效 | B1 |
| 17 | Codebase 无效签名、乱序、缺订阅/日志；计划停用后迟到、离线后补跑 | 接收与建任务分别留证，匹配/跳过可解释；旧事件不套新规则，补跑符合既有规则 | B2、E1 |
| 18 | 报告/代码整体返修；大 diff、二进制、重命名、成果删除或目录清理 | C1 可完成整体反馈并追溯版本；缺失/截断明确，HTML 不执行脚本，共享目录不归入他人改动 | C1 |
| 19 | EOF、首轮失败、后台子 Agent、迟到/重复/乱序工具事件与取消竞争 | 不丢已确认 session ID、不重复结算；复用工具配对且未结束状态不伪装完成；真实 AcpxAdapter 持久化键回归通过 | D2 |
| 20 | 长结果附件各阶段失败；上游已收到但回执超时；重启后再试 | 按全文适配降级，复用 upload/message/summary 回执，只补未完成阶段，保留未知投递状态 | E2 |
| 21 | 旧 session 未加载新 Skill；Agent 进程在线但启动失败；草稿未生效 | 区分登记/启动/加载/调用与生效范围，不把草稿当当前配置；诊断包脱敏 | F1、G2 |
| 22 | usage 缺失、供应商回传、估算及重复累计事件 | 缺失不为零，实报与估算分开，价格版本可查、无重复计数；文档不承诺无条件恢复 | G3、G1 |
| 23 | V2 切换/回滚、重复 listener、凭据失效；Tag 关联与单/多 Agent 对照 | 仅满足启动条件后验收：迁移不双启、在途任务语义明确；关联由人指定、冲突标来源，分层价值有可比较证据 | G4、H1/H2（条件项） |

## 7. 来源、验证与未核实范围

### 7.1 本轮能力实测，以及保留的历史验证

本轮使用 HEAD `2d7162e` 的现有测试、隔离目录和假 Agent；没有改产品/测试文件或弱化断言。未发送真实飞书消息、注册生产订阅、执行生产恢复、推送外部代码或改生产配置。controller 另完成只读运行核对，时点与版本边界见 §3.2。以下各组分开计数，不与历史测试累计成覆盖率。

| 本轮核验 | 时点 / 耗时（2026-09-26 CST） | 实际结果 | 真实组件与替身边界 |
|---|---|---|---|
| 材料、续作、Skill | 19:27:25.358–19:27:53.439；墙钟 28.081 秒，Vitest 26.95 秒 | **9 文件，222 通过、1 失败**；首轮无跳过。19:28:32 单例复跑 5.16 秒仍失败，44 项未选中 | 真临时文件、Runtime/SQLite、AcpxAdapter/ACPX 本地子进程；飞书下载/服务、路由和模型有 mock。函数探针另证明 sources 错误未进入 prompt、Skill 前缀解析遗漏，不计入 Vitest 数。 |
| 验证、CI、内部 Review | 19:28:10.089–19:28:27.236；墙钟 17.147 秒，Vitest 15.99 秒 | **9 文件，144/144 通过**；一次执行、exit 0 | 自动验证用真协调器/Runtime/SQLite/Git/验证进程，模型与 Lark 为假。CI 恢复用真关库重开与本地 JSONL 子进程；GitHub HTTP 为假。Codebase 为真 Git/SQLite，加内存任务、模拟 dispatch/通知，push 被定向至 /tmp 本地裸仓库；非真实上游验收。 |
| Web 与恢复/投递 | 19:30:06，Vitest 2.95 秒；19:36:03，2.91 秒 | **两次调用，8 文件，73/73 通过**（65+8） | 真 DOM、SQLite、恢复 Runtime；自动补发的 Lark service 为假，证明只补缺失阶段，不证明线上必达。 |
| 隔离浏览器 | 19:29:57–19:37:03 | **11 次脚本调用**：主流程 6、恢复 3、手机审批 2；含修 fixture、失败和负向观察，不能写“11 场景全过” | Chromium+Vite+源码 Fastify/SQLite/Runtime；假 Agent/审批 driver、本地认证。最终正常续作、手动验证历史、结构化手机审批可用；文件误跳、恢复续发只排队已复现。 |

上下文失败位于 `workflows.integration.test.ts:793`，期待拒绝文案“白名单”，源码已有“仅任务发起人和管理员可操作”路径，疑似断言过时。未采集该次实际卡片，完整根因仍未确认；后面的未中断、重启重试断言也未执行到。**不能写全绿或当作权限逻辑已全部验证**，维护侧需核实后保留行为断言再处理；本轮未改测试、未继续盲重试。

UI 中 CI 表单确实发起请求，但无 GitHub remote 的 fixture 返回仓库条件错误，不能算真实 GitHub 等待成功。恢复 owner confirm 的一次 409 留在日志，不声称浏览器恢复成功；安全拒绝由已有 Runtime 测试另证。手机初次 driver 提前退出导致 409，修正 pending fixture 后通过；Vite 跨端口请求曾被真实 Origin 校验拒绝，改临时同源代理后重测，未关闭生产鉴权。无活动事件时未知结果区块不显示的负向观察也保留。

三组准确命令如下（仓库根目录；日志包装仅记录时间、stdout/stderr、退出码）：

```sh
# 材料、续作、Skill：222 passed / 1 failed
pnpm exec vitest run --project node --maxWorkers 2 \
  apps/server/src/lark/message-content.test.ts \
  apps/server/src/lark/task-context.test.ts \
  apps/server/src/lark/session-resolver.test.ts \
  apps/server/src/lark/workflows.integration.test.ts \
  apps/server/src/lark/coordinator-recovery.test.ts \
  apps/server/src/lark/new-session.integration.test.ts \
  apps/server/src/skill-delivery.test.ts \
  apps/server/src/skill-catalog.test.ts \
  packages/acp-client/src/acpx.test.ts
# 失败单例复跑：1 failed / 44 skipped
pnpm exec vitest run --project node apps/server/src/lark/workflows.integration.test.ts \
  -t 'uses each task requester for managed-group cancel and retries with the current operator after restart'

# 验证、CI、内部 Review：144 passed
pnpm exec vitest run --project node --no-cache \
  apps/server/src/codebase-ci.test.ts \
  apps/server/src/session-automation.test.ts \
  apps/server/src/session-automation-ci-recovery.integration.test.ts \
  apps/server/src/session-automation-ledger.integration.test.ts \
  apps/server/src/lark/auto-verification.integration.test.ts \
  packages/agent-runtime/src/workspace-verification.test.ts \
  packages/agent-runtime/src/verification-identity.test.ts \
  apps/server/src/work-items.test.ts \
  apps/server/src/automation-integration.test.ts

# Web/投递/恢复：65 + 8 passed
pnpm exec vitest run \
  apps/web/src/components/SessionDeliveryPanel.dom.test.tsx \
  apps/web/src/components/SessionAutomationPanel.dom.test.tsx \
  apps/web/src/components/PermissionCard.dom.test.tsx \
  apps/web/src/components/ActivityPanel.dom.test.tsx \
  apps/server/src/recovery-routes.test.ts \
  apps/server/src/lark/result-delivery.test.ts \
  apps/server/src/lark/reconciler.test.ts --reporter=verbose
pnpm exec vitest run packages/agent-runtime/src/execution-recovery.test.ts --reporter=verbose

# 浏览器：共 11 次调用；脚本和失败记录留在 /tmp
node --conditions=development --import tsx /tmp/dutydeck-capability-ui-20260926/check.mts
node --conditions=development --import tsx /tmp/dutydeck-capability-ui-20260926/recovery-mobile.mts
node --conditions=development --import tsx /tmp/dutydeck-capability-ui-20260926/mobile-only.mts
```

分项可追溯：context 为 12、24、34、44 通过/1 失败、44、9、20、9、26；delivery 为 21、23、1、4、14、25、1、46、9，均按上方文件顺序。完整断言边界和日志见 §7.4。真实飞书、真实模型、xlsx 全链、Codebase/EventHub 原件和线上浏览器认证/代理发送均未用上述本地结果替代。

**历史测试与评审（不作为晚间重新运行记录）**

此前详细方案由未参与编写者独立复核，结论为无阻塞问题；这是历史评审，不代表本轮终稿已经独立审完。本轮独立文档 review 由 controller 安排，不把预核当终稿验收。

2026-09-26 11:03:05 CST 开始，20.28 秒，8 个测试文件 **181/181 通过**：

```sh
pnpm exec vitest run \
  apps/server/src/instance-proxy.test.ts \
  apps/server/src/lark/auto-verification.integration.test.ts \
  apps/server/src/lark/coordinator-ux-p0.test.ts \
  apps/server/src/lark/memory-turn.integration.test.ts \
  apps/server/src/work-items.test.ts \
  apps/server/src/codebase-ci.test.ts \
  apps/server/src/usage-ledger.test.ts \
  packages/acp-client/src/steering.test.ts
```

分项为多实例代理 6、自动验证 14、飞书交互 74、记忆按轮审计 3、work items 46、Codebase CI 21、usage 13、Acpx 插话 4。覆盖真实本地 HTTP/SSE/WebSocket、SQLite、Git 工作区、验证子进程及 Acpx 持久化键；飞书 provider 与模型使用测试替身。未新增或修改测试断言，未运行竞品测试套件。

原调研在上述独立评审后，于 11:22:35 CST 补跑以下检查，3 个文件 **58/58 通过**，覆盖恢复 owner 权限、禁止伪造操作者、密码身份和分享边界。两轮共 11 个文件、239 项通过；没有实际执行生产恢复。

```sh
pnpm exec vitest run \
  apps/server/src/recovery-routes.test.ts \
  apps/server/src/foundation-policy.test.ts \
  apps/server/src/auth/auth.test.ts
```

历史补测于 2026-09-26 12:19:11 CST 执行以下针对性检查，耗时 3.28 秒，**2 个文件 17/17 通过**（task-inbox 5、result-delivery 12），用于核对 §5.5 中 inbox 持久化与结果投递的采纳边界。这组为历史记录，晚间 UI 核验再次运行了其中 result-delivery；不能把不同批次相加当成不重复的测试覆盖，也不表示 Web 恢复或全部拟建方案已验收。

```sh
pnpm exec vitest run \
  apps/server/src/lark/task-inbox.test.ts \
  apps/server/src/lark/result-delivery.test.ts
```

原调研运行查询以进程实际指向的库为准，SQLite 用 `mode=ro` 与 `PRAGMA query_only=1`。主要计数口径如下；未输出配置正文或凭据。

```sql
SELECT status, count(*) FROM tasks GROUP BY status;
SELECT count(*) FROM configs WHERE key LIKE 'runtime_verification:%';
SELECT data_status, count(*) FROM usage_ledger GROUP BY data_status;
SELECT count(*) FROM usage_caps;
SELECT count(*) FROM configs WHERE key LIKE 'ci_webhook/codebase/%';
SELECT count(*) FROM ci_webhook_events;
SELECT count(*) FROM ci_webhook_tasks;
SELECT authority FROM configuration_authority;
SELECT count(*) FROM schedule_entity_versions;
PRAGMA freelist_count;
PRAGMA page_size;
```

### 7.2 GitHub 与官方文档覆盖

以下固定提交是本轮检视的源码快照。主要仓库检查 README、相关实现、测试及近期 issue/PR；并非逐文件审计。首批 GitHub API 检索每仓库最近 10 个提交、最多 30 条混合 issue/PR，`yuklcool/agentdock` 返回 15 条；补充项目按审阅与同步机制定向阅读。未使用 star 数或 issue 数推断质量。

| 仓库 | 固定提交 | 主要阅读对象 |
|---|---|---|
| [deepcoldy/botmux](https://github.com/deepcoldy/botmux/tree/32a0e98e9b031de44c2b0a050f4e3f87415082b8) | `32a0e98e9b03` | doctor、预算/用量、提交回执、旧版到当前差异 |
| [chenhg5/cc-connect](https://github.com/chenhg5/cc-connect/tree/a5c93d9ce1993f7ce136ef454e3f80324758cc1a) | `a5c93d9ce199` | session 续接、EOF 终态、Claude resume、飞书附件解析 |
| [amplifthq/opentag](https://github.com/amplifthq/opentag/tree/3a3136dcb8395b6dda6c872a8398d21a70935a23) | `3a3136dcb839` | 完成条件、对象与证据、Draft PR 回读、工作区核验 |
| [anthropics/claude-tag-plugins](https://github.com/anthropics/claude-tag-plugins/tree/034af83830ff459baeca6feaaa25a0297eb942e2) | `034af83830ff` | 插件排障、oncall 初始化、Snowflake 认证边界 |
| [yuklcool/agentdock](https://github.com/yuklcool/agentdock/tree/6ae6507b23b6cc7f64bb85da3fc02bc64a21208b) | `6ae6507b23b6` | 会话提交、工具事件、SSE 回放与持久化、近期修复 |
| [Nigh/AgentDock](https://github.com/Nigh/AgentDock/tree/7a3371460c1fe1846717ce5c6dbb449e6789a9e8) | `7a3371460c1f` | 远程 PTY、断连与内存回放；用于路线区分 |
| [AgentDock/AgentDock](https://github.com/AgentDock/AgentDock/tree/4d9eb73747deda96eb23aea4755e160d8d482eba) | `4d9eb73747de` | README、许可和项目定位；未深审框架实现 |
| [slopus/happy](https://github.com/slopus/happy/tree/8517ab232528a6046271d6010aaed663e1187dfc) | `8517ab232528` | 移动 diff 组件全文、同步/RPC 文档 |
| [slopus/happy-agent](https://github.com/slopus/happy-agent/tree/eba156993bf299973ad77eaa61b196eeaf50ca46) | `eba156993bf2` | 离线测试全文、chaos 测试相关场景与断言 |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban/tree/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a) | `d5cbb5380fa0` | README、审阅/完成任务文档、评论组件 |

此外阅读 Claude Tag 的工作机制、响应、记忆、Routines、使用建议、GitHub 工作流、修 bug 和预算官方页面，Linear 的 Agent 交互及最佳实践，以及 Vibe Kanban 官方关闭公告；具体链接随正文论点给出。GitHub 找到的同名 Mew 仓库未确认与内部产品相关，未纳入比较。

许可检查只服务于判断能否直接吸收源码：已检查项目大多为 MIT，Tag 插件与 Vibe Kanban 使用 Apache-2.0；cc-connect 的 README/包元数据称 MIT，但本轮树中未找到对应 LICENSE，直接复制前仍需核实。本文只提出设计借鉴，没有复制竞品实现。

### 7.3 lark-cli 检索、整读与选样范围

本轮使用 `lark-cli 1.0.77`，显式用户身份，只读调用。初轮文档每词检索一页、每页 20 条；消息每词最多两页、每页 50 条，未限定时间。表中数字是返回条数，未去重，不能解释成用户数或投诉数。

| 检索词 | 文档条数 / 仍有下一页 | 消息条数 / 仍有下一页 |
|---|---|---|
| botmux | 20 / 是 | 100 / 是 |
| mew | 20 / 是 | 100 / 是 |
| AgentDock | 15 / 否 | 7 / 否 |
| Agent Dock | 20 / 是 | 100 / 是 |
| Claude Tag | 20 / 是 | 100 / 是 |
| ClaudeTag | 20 / 是 | 1 / 否 |
| Dutydeck | 4 / 否 | 100 / 是 |

增补检索限定 Mew 体验反馈群、2026-09-18 起：`automation` 返回 34 条、`验收` 返回 1 条，均无下一页。后者不是人工验收反馈，未当作用户实测。`Agent Dock` 分词噪音与无关表格已排除。

**全文读取的 12 篇飞书资料：**

| 材料 | 在本报告中的用途 |
|---|---|
| [Botmux 主文档](https://bytedance.larkoffice.com/wiki/UBOXwH01CixfxfkqxUpcKgvQnsg) | 产品入口与使用方式；宣传保证不作实测 |
| [Botmux 典型示例](https://bytedance.larkoffice.com/wiki/Aq5awe4eyiqjDckTaHdcehrJnxb) | 07-23 历史实践；不据此否定今天的恢复能力 |
| [Mew 主文档](https://bytedance.larkoffice.com/wiki/YXL4wupehiDyzUkGnBWcXJ9inFb) | Workspace、Device、Chat/Issue；Coming soon 项不算已交付 |
| [Mew 团队协作指南](https://bytedance.larkoffice.com/docx/DaYgdCfwVoo8vgxIX1wcbSAmnIc) | 多角色交付流程；属于推荐做法，非强制状态机 |
| [Mew 实践自述](https://bytedance.larkoffice.com/docx/GLUTdKZXfoKAnUxnxDTc7Covnug) | 临时探索与持续交付的入口划分；历史数量未引用 |
| [Mew 数字团队试点](https://bytedance.larkoffice.com/docx/TqOKdn1USoDp3kxL3kjcZcFWntg) | 需求、MR、测试、原话题回流可追溯；没有重跑试点 |
| [Mew Automation](https://bytedance.larkoffice.com/wiki/QECTwfqLSiqK4kksg1Oci7FYnwc) | 触发、去重、重叠策略与事件/运行分层排障 |
| [Mew MR 联动](https://bytedance.larkoffice.com/wiki/F3WiwKUZkivnaikpZx5cGBgmnxc) | 审阅、修复任务与对外发表评论的边界 |
| [内部 AgentDock 手册](https://bytedance.my.larkoffice.com/docx/SVTxdeVtyoieVXx2paBm4YOUy2e) | 产品身份、接口契约；当前实现未独立核实 |
| [内部平台名单](https://bytedance.larkoffice.com/docx/Hnl3dG6xEoWR2DxpkLNcz3GQnub) | 定位对象，不作为能力证据 |
| [Claude Tag 体验分享](https://bytedance.larkoffice.com/wiki/W9kcwVRctirJM8kcFahcQgN9nRb) | 团队可见性与收集反馈；冲突信息按官方文档校正 |
| [Claude Tag 关键机制](https://bytedance.larkoffice.com/wiki/Cb9fwFiRhi3N6ckCNERcm91fnne) | 内部设计评论；不当作当前平台实现 |

另完整读取 12 条选定讨论线程及关键根消息，均检查到回复页 `has_more=false`。正文采用的反馈链接附在对应论点旁。只确认人工报告的症状；支持 Bot 给出的根因、事故规模和“应该已恢复”不作本研究的验证结论。纯问答可以不调用工具，不能从“零工具”单独判定任务失败。

这是定向、分页受限的调研，**不是全租户或全部历史穷尽检索**。三篇已获取但未全文读完的长 FAQ/企业反馈整理，以及未审阅完的 Botmux webhook 线程，均未作结论依据。图片和画板没有 OCR，结论限于已读取文字。选中材料未遇权限拒绝，不代表其他资料均可访问；未申请新权限。

### 7.4 证据保存与仍待验证的事项

正文保留可回溯来源、固定 SHA、关键命令和测量口径。临时文件可能清理，不将其作为唯一长期证据，也不将配置原文、凭据或大量聊天材料复制进仓库。

| 证据 | 本地位置 |
|---|---|
| 材料/续作/Skill 核验与日志 | `/tmp/dutydeck-capability-context-20260926.md`、`/tmp/dutydeck-capability-context-tests-20260926.log` |
| 验证/CI/Review 核验与日志 | `/tmp/dutydeck-capability-delivery-20260926.md`、`/tmp/dutydeck-capability-delivery-tests-20260926.log` |
| UI 核验、全量日志与截图/脚本 | `/tmp/dutydeck-capability-ui-20260926.md`、`/tmp/dutydeck-capability-ui-tests-20260926.log`、`/tmp/dutydeck-capability-ui-20260926/`；图 02 为文件误跳，03 为验证历史，06/07 为恢复状态，08 为手机审批 |
| 运行配置、进程、版本、CI 环境与 registry | `/tmp/dutydeck-capability-runtime-20260926.json`、`/tmp/dutydeck-capability-runtime-services-20260926.json`、`/tmp/dutydeck-capability-runtime-version-20260926.json`、`/tmp/dutydeck-capability-runtime-registry-20260926.json` |
| 旧研究材料 | `/tmp/dutydeck-research-lark-20260926/`、`/tmp/dutydeck-github-research-20260926/`、`/tmp/dutydeck-research-root-20260926/`；飞书原件限制本机权限并脱敏 |
| 改写前副本 | `/tmp/dutydeck-capability-before-20260926.md` |

三份能力报告已全文读取；其早于补核、仍将 registry 或 CI 环境列为未核实的文字，以 §3.2 的 19:37–19:38 controller 原件为准。

仍为 **unverified** 的产品接入：真实 Codebase/EventHub 载荷与完整外部 CI 修复、真实飞书与模型交付、线上浏览器认证/代理发送。Tag 精确源码版本和失败单测完整根因也未确认；主 Web+三个 Bot 的发布版本已通过 hash 确认。

研究边界仍包括：内部 AgentDock 与 Dutydeck 的项目关系，外部问题根因及修复效果，统一任务集下的竞品成功率/成本，以及建议的用户影响频率与实际收益。

### 7.5 历史参考与本轮判断范围

Claude Code 完整参考稿 `/tmp/dutydeck-claude-reference-20260926.md` 来自同一 Herdr pane `w1Y:p3`、session `ad895633-9b20-4e35-9417-c988ff50b9a5`，完成于 11:14 CST；此前已全文读取，§5.5 保留取舍。其模拟角色讨论不作独立实测或本轮评审。

旧修订已整读 Botmux 典型示例、Mew 实践/指南/试点、Claude Tag 体验文、Mew 续会话/Skill/空输出线程、根帖与 cc-connect #1884 body，并按 fetch_manifest 核对来源。Dutydeck 搜索页的 100 条及 98/2 身份计数来自 `messages_6.json`，该页 `has_more=true`。controller 后续只读检索命令为 `lark-cli im +messages-search --query Dutydeck --sender-type user --page-size 50 --page-all --no-reactions --as user --format json`，exit 0、ok=true、2 条人类消息、has_more=false；原件 `messages_dutydeck_human_recheck.json` 位于上述飞书材料目录、权限 0600。该检索不覆盖未提产品名的真实工作。

本轮补齐的是本产品能力判断、运行启用状态、隔离浏览器及相关状态流验证，并将旧“先验证六个候选”改成八项明确建议。§2/4 的竞品事实和原始来源、§5.5 的技术取舍、§6.1 底线及 §6.2 全部 23 条标准保留。文档交付不等于这些建议已开发或已上线，也不等于已测得用户收益。
