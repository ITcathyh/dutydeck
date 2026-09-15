# 工作流与 Dutydeck 执行账本接线

状态：公开包和本地样本已核对，以下为 host 接线草案，尚未通过独立设计复核或实施。完整交付范围仍以 [总方案](full-product-parity-plan.md) 的 P4 与 W01–W09 为准；本稿只明确执行、恢复和管理接口的接缝。

## 固定复用边界

使用 Botmux `e8c9bbdfacda272740d5fd0b148235e358bdf53e` 生成的 workflow-core 完整 portable runtime。已实际消费其九个公开导出，运行两节点重开、持久 gate、执行进程 SIGKILL 及外部动作回执未知四类样本。调度器已有条件边、汇总、循环、revisit 和提前汇总，不能根据源码的旧注释将它误判为只能执行简单 DAG。

现有包 build 输入来自 Botmux canonical 源码，仅复制 packages/workflow-core 的入口文件无法构建。正式引入时保存固定源码闭包、构建脚本、许可证和来源哈希，使发布包能在 Dutydeck 内重建；Dutydeck 只从受支持的公开入口消费，不导入 Botmux daemon、Bot 配置或飞书业务模块。扩展必须留在这一份引擎及其 host 契约中，不再维护第二个调度器。

当前公开 control 仅提供纯 loop/revisit 规则，没有持久 retry/grant/revise 命令。Botmux 的相应命令实现在 daemon-run.ts，不能深导入整个文件补缺口；需将不依赖 daemon 的部分提取为受支持的公开管理接口，并补并发和持久回执验证。

## 图尝试与 Agent 尝试分别记录

工作流运行固定定义、模板版本、参数、执行配置及授权来源。节点的一次实际激活使用引擎给出的 instance/loop-body 身份；不要只用 nodeId，也不要由 host 猜测 attemptId 字符串格式。

| 标识 | 含义与恢复规则 |
|---|---|
| workflowRunId | 同一份冻结图运行；重开不产生新运行 |
| activationId | 节点实例或某次循环体激活；revisit/下一迭代有新身份 |
| executionIntentId | 本次经授权的执行输入；自动恢复沿用，明确的新执行才更换 |
| graphAttemptId | 引擎的一次调度尝试；强退恢复可能增号，不表示允许再次调用 Agent |
| Task/Attempt | Dutydeck 接收和执行的权威；映射固定原 Task 与选定 Attempt，不追随 currentAttempt 隐式换结果 |

公开 AgentExecutionRequest 需提供 activationId 和确定的调度原因，供 host 获取 executionIntentId；首派、孤立恢复、明确 retry 与新一轮激活不能混为一个自增计数。映射记录保存来源运行/激活/图尝试、固定输入摘要、原 Task/Attempt 和控制决定。Dutydeck request key 由 executionIntentId 确定，遵循 [任务来源接收规则](task-source-consumers-design.md)：先查原接受事实，再准备材料或子会话；接受回执丢失时查询，不换 key 重发。

新的 graphAttempt 在孤立恢复中复用原 executionIntentId。原 Task 已知完成则核对原结果和资源；原结果未知就继续待核对；原任务尚未提交时沿用受支持的准备恢复。图执行者死亡本身不证明 Agent 任务没有执行。

普通节点重试可能包含新的人类答复或更新后的输入，不能覆盖已冻结 Task。对已知终态且资源安全的原执行，经当前授权生成新的 executionIntentId 和来源回链。未知原任务的处理先走固定 Attempt 的核对或明确重复副作用的重试决定；图的普通 retry 不绕过该入口。按原输入重试选定的新 Dutydeck Attempt 必须由这份决定显式绑定，不能由 host 自动选择最新尝试。

## 结果冻结与资源关闭

已核对 shared-node-runtime.ts 的真实执行路径：runNode 返回或抛出后，nodeSucceeded/nodeFailed/nodeBlocked 会被用作执行者关闭证明，随后 cleanupSettled 清理租约。普通失败分支也会走这条路径。AgentExecutionResult 的 status 虽只有 ok/fail/cancelled，manifest 和错误分类仍可产生 nodeBlocked，不能声称引擎没有 blocked 状态。

Dutydeck 的 AttemptResult 可以先于物理进程与输出尾声落库。因此 executeAgent 不能只等到 completed 事件就返回，也不能将未知资源转成普通异常。正常返回前必须同时取得固定 AttemptResult、匹配的实体 manifest 和对应物理资源/创建尾声关闭证据。原生上下文的正常存续与物理执行关闭分开，不能为完成工作流伪造 remote gone。

AttemptLeaseProvider 将图尝试绑定到上述原执行及其资源。drainExternallyOwned 只有证明这些精确资源关闭后才返回 closed；缺记录、资源身份不明或活动轮次不可附着均不算 closed。finalizeAfterProof 保留引擎先持久 journal 证明、后清理 host lease 的顺序。

还需补受支持的“结果/资源待核对后挂起”边界：服务可以结束本次调度调用并保留未关闭 lease，不能靠永不结束的 Promise 提供唯一恢复入口，也不能把挂起写成已有关闭证明的 nodeBlocked。现有实际循环会对未知 orphan/terminal peer 持续 drain；仅给 AgentExecutionResult 增加枚举值仍不足以让 portable 调用返回。

待复核的完整接口如下：executeAgent 增加 `unresolved` 分支，保存原执行引用与诊断；新增只观察固定执行的 reconcile 回调，可返回仍待核对，或返回带精确关闭证明的原执行结果。观察不创建 Task、不准备新输入、不发 prompt。共享调度器与 portable adapter 同步支持该分支，不能只改外层类型。

| 边界 | 持久事实与下一步 |
|---|---|
| 首次调用返回 unresolved | 追加固定图尝试的 executionUnresolved，保留原 lease；释放本次调用的内存槽位，不追加 nodeSucceeded/nodeFailed/nodeBlocked 或清理 lease |
| 首次调用抛异常 | 异常自身不证明资源关闭；先核对精确 lease，未知则走同一未决分支并保留原错误，只有已证明关闭才可按原失败规则结束节点 |
| 同进程观察或重开 | 按原激活/图尝试/执行引用只读核对；仍未知时不增图尝试、不 acquire 新 lease，不走普通孤立重试分支 |
| 结果和资源均已核实 | 对原结果核对 manifest，再在 journal mutation 中重查目标尚未取消或 superseded，保存原尝试的结果及关闭证明，最后 cleanupSettled；旧结果不能完成新实例 |
| 存在未决执行但无本地调用在途 | 返回 portable `awaitingExecution` 与固定未决列表，运行未进入终态；运行服务靠账本事件或显式刷新再驱动，不持有唯一永续 Promise |
| 取消、提前汇总、revisit 清理遇到未知 | 保留取消/替代意图和原 lease，返回同样的待核对状态；不得因取消了 JavaScript 回调而发布资源已关闭或运行终态 |

执行者在 executionUnresolved 落 journal 前死亡时，仍按持久 lease/来源映射找回原 Task；不能依赖进程内返回值判断是否已接受。旧 Botmux journal 没有新字段时继续走既有保守 orphan 规则，由 host 的固定 executionIntent 映射防止重复提交。正式事件、回调输入及公开包兼容性须独立复核后冻结；零新 Task、零 Agent resend、原 lease 可查询且调用可返回是这一组接口的验收条件。

## 持久控制与人类答复

Web、CLI、飞书操作共用管理服务，解析当前真实操作者与 App/群范围，针对固定运行版本、节点实例、尝试或等待项提交 operationId。公开引擎管理命令在 journal mutation 内重读、核对预期状态、追加事件和操作回执；旧卡不能影响新尝试。成功重投先验证当前权限，再返回原回执，不重复增加循环/revisit 预算。

授权命令和 journal 属于不同持久域，不能宣称跨 SQLite/文件原子。Dutydeck 先保存带固定载荷的管理意图，引擎按同一 operationId 在受支持命令中幂等应用；崩溃后读回原回执并补齐状态。配置撤销后未应用的意图重新鉴权，已经应用的操作保留历史。外部 HTTP、Agent 调用和文件准备均不放进 SQLite 写事务。

Botmux 原 revisit grant 已考虑“预算已加、retry 尚未落盘”的窗口，但提取后的接口仍须验证当前预算/目标及命令重投，不能因复用了函数名就算通过。loop grant 固定旧迭代，retry 固定旧节点尝试；host 外部动作未知时不开放普通 retry。

Dutydeck 原 WorkPlan wait 是独立人工步骤，其原答案还用于后续 equals 条件。它不能直接改成二选一的节点前审批。正式包校验器的本地探针确认：不接受 wait 节点、自定义本地 answer executor、host.resultSchema 或以 host 输出为源的条件边；合法 host 和 goal 条件边两项对照通过。不能仅注册一个 host handler 就声称已兼容。证据为 workflow-public-consumer/wait-contract-probe.mjs 和 .log；未调用平台或 Agent。

采用在同一引擎增加 `wait` 节点的方案，以下接口待独立复核：

- 节点保存问题、答复类型与候选项，不含 Agent profile 或外部动作 executor。首次激活先在 journal 冻结 questionId、activationId 和问题载荷，再由统一问题服务保存可查询的投影。重开重用原问题；没有答复时 portable runtime 返回待答复项，不占 Agent 执行租约。
- 答复共用上面的持久管理命令：当前权限、固定问题/激活及预期 revision 验证后，同一 journal mutation 保存原答复、操作者、operationId 和回执。服务 SQLite 与 journal 间按原 operationId 补回执，不能覆盖首次已接受的答复。旧 WorkItem answer 路由继续拒绝重复答复；新管理接口可对同一 operationId 返回原回执。
- 已接受答复生成该等待节点的 `result.json` 与 manifest，固定 `{ answer: <原字符串> }` 和实体摘要，之后节点完成。写文件失败或强退后只重建相同答复的产物，不重问、不调用 Agent。取消与答复竞争由同一 journal mutation 决定，迟到答复不能重开已取消的等待。
- 旧计划自由文本保留原始字符串：非全空白、JavaScript length 不超过 4000，按原字符串精确比较，不 trim 后存储。旧 wait 不增加超时；新问题若明确设置期限，过期保留未答复状态和原因，不能自动写入拒绝答案。

旧计划的合并规则也必须完整保留：所有直接依赖均已 settled，至少一个未 skipped，才可继续。因此转换后的普通 join 使用现有 `one_success`，不能沿用默认 `all_success`，否则 yes/no 分支中未选中的 skipped 分支会阻塞汇总。现有单条 when 可以引用任意上游 wait，且独立于直接依赖的跳过规则；把该 wait 简单添加成另一条条件边会改变 one_success 的含义。

为这个已存在的行为增加显式 `answerCondition: { from: <上游 wait>, equals: <原字符串> }`。校验器要求源是当前图的 wait 且为依赖链祖先；本次先支持旧计划所需的顶层无环图。调度器先等直接依赖 settled，再按原合并规则及固定答复条件决定运行或 skipped，并持久化决定及其来源答复摘要。没有条件的 V3 节点保持既有行为。节点输入仍保存旧直接依赖的 answer、结果和 skipped 状态，不能因转换增加条件引用就改变给 Agent 的输入。

转换须覆盖直接及跨一层引用 wait、自由文本前后空白、yes/no 分支汇总、全部分支 skipped、条件 wait、重开答复及重复/越权/迟到操作。该设计是完整引擎的兼容扩展，未实现前不能将旧 WorkPlan 标为已迁移。

## 接收门槛

完整接线用真实 Dutydeck Runtime、SQLite、本地 Agent 子进程和正式 workflow-core 包验证：接受回执丢失、Agent 结果先落库、进程尾声延迟、daemon 强退、未知结果、取消和旧回调、新节点实例、明确重试、重复人类答复、预算命令半完成。每个窗口核对 Agent 实际收到的请求数量和原 Task/Attempt 归属。

成功结果还要验证 manifest 的路径、实体字节、摘要、节点/尝试归属和下游只读输入。提前汇总不能让被取消分支迟到覆盖成果。外部发送、回复和建计划通过统一意图/回执接口，未知状态保留原幂等时限；不因图重开刷新时限或重新生成动作正文。

上述接缝通过后，还须完成目标/计划审阅、模板版本与发布、成果管理、Issue 连接、UI 和跨入口旅程。现有四类运行样本和本稿新增的纯校验器探针不替代这些产品验收。资格证据保存在 `/tmp/dutydeck-full-product-20260914/workflow-package-qualification.report.md` 与 workflow-public-consumer 内；本稿未报告新的工作流运行测试通过。
