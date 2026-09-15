# 工作流与自动任务接入执行账本

本稿落实 [Runtime 接线契约](runtime-ledger-integration-design.md) 的来源与结果部分。当前 work-items.ts、session-automation.ts 和 automation-integration.ts 已全文核对；不改图编排、日历算法或 GitHub 条件定义。两个普通开发单元分别负责 WorkItem 与 Schedule/CI，结果读取共用一个小函数。

## 固定请求与身份

来源先在自己的 Config CAS 中保存 TaskAdmissionV1，再 dispatch。已持久 request 原样复用；先查询接受事实，再准备工作区、Skill 或查询 GitHub HEAD。WorkItem 子 Session 尚未创建时先执行 execution.getAcceptedTask(固定 taskId)，仅 Session 已存在才调用 lookupAcceptedTask(request)；Task/Session 都不存在才走首次受授权创建，不把 SESSION_NOT_FOUND 泛化为任意 lookup 失败可忽略。响应丢失只补齐同一 Task 映射，不生成另一个请求。

新 WorkAttempt 使用 namespace=work_item、key=原 WorkAttempt.id；Schedule occurrence 用 namespace=schedule、key=既有 session-automation:schedule:<occurrenceId>；CI 用 namespace=automation、key=既有 session-automation:ci:<subscriptionId>。均由 executionTaskId 计算 canonical ID。源标识、原 prompt、原 skills、显式选项和 actor 必须完整冻结，不能在重投时重读当前默认值改变 envelope。CI 的首次 dispatchPrompt 仍在收到完成 run 列表后保存；之后恢复使用原文本，不再次拼接新的 GitHub 返回。

本地安装者仅由真实 installationOwnerTaskActor 映射到 installation_owner；平台用户带原 appId/id。WorkItem 的平台域取创建时已验证父 Session，保存在私有记录的 ExecutionActor 中，不能从子 Session.sourceId 的 WorkAttempt ID 猜 App。历史记录缺 actor 域时，只能核对其原父 Session/来源事实后 CAS 固定；无法核对即 blocked，不补 owner。公开 WorkItem、Schedule/CI 返回值不得暴露 admission.request.sourcePayload、冻结权限或私有 actor 域。

历史来源先检查已保存 taskId 及 execution.getAcceptedTask 的实际事实。有原 Task 则固定它，admission 标 legacy_partial 并保留实际存在的 request；不能把同一次接收换成 canonical ID。只有尚未接受的旧 preparing/dispatching 记录能在原 raw/revision CAS 内建立新 request 和 ID。映射冲突或同 key 异请求必须持久 blocked/admission_conflict，不能仅记录日志后重试新 Task。

Automation 继续使用第二个授权 KV，但内容升级为带已选 taskId/算法版本的严格记录。顺序是来源 CAS → 幂等补齐同一 binding → dispatch；中途重开补齐原 binding。authorizeTask 使用来源 admission 的确切 ID，保留 generation、启用状态、有效期、当前权限和提交前 HEAD 检查。已接受的恢复查找先于 HEAD 读取，实际尚未提交的执行仍须通过这些授权检查。WorkItem authorizeTask 同样核对已选 ID，而不是重新计算旧 hash。

## 唯一结果读取函数

新增 apps/server/src/task-results.ts，由 WorkItem 单元拥有，Automation 单元消费。导出同步 readAttemptResult(repositories, sessionId, taskId, attemptId)，repositories 仅需 execution；返回 pending、blocked（reason 为 reconcile_required/legacy_output_unresolved/admission_conflict）或 settled（result:AttemptResultV1）。越界、坏记录、超限和摘要冲突用明确 RuntimeError，不能返回空成功。

调用者在自身 CAS 内先固定 Task 的 number=1 Attempt.id，不选后来当前 Attempt。选择前先核对 Task/session/ID：没有 Attempt 且 Task.cancelled 表示首次领取前已取消，来源按原取消/不交付语义收口，不伪造 AttemptResult；无 Attempt 的真正 queued 才等待，其他状态缺 Attempt 为历史/坏事实。WorkItem 非父项取消流程中遇到这一情况，保留选定 step/attempt 的 cancelled，父项 blocked 并说明步骤已取消，停止其它执行分支；不假造父项的用户取消身份。queued/preparing/suspended 的 V1 或缺失输入不能被透明提交，来源立即 blocked/legacy_input_unresolved，并保留 INPUT_OPTIONS_UNVERIFIABLE 或 INPUT_SNAPSHOT_UNVERIFIABLE 原因。旧已有 output/已交付事实优先保留，不追溯破坏。已有固定 ID 的每次查询都核对 task/session/number，不跟随 Task.currentAttemptId；来源的图重试会创建新的 WorkAttempt，它自己的首次执行仍只选 number=1。

函数从 getTaskExecution 中找指定 Attempt：preparing/active/suspended 为 pending；reconcile_required 或 settled/unknown 为 blocked/reconcile_required；legacy_unresolved 或缺可靠结算边界为 blocked/legacy_output_unresolved。已知 settled outcome 必须有 matching attemptId+settlementId 的权威 completed 事件，取其 sequence 为 throughSequence，并核对事件 outcome。不得以 Task.status 或 Session 当前高水位判完成。

用 getAttemptEvents 按顺序分页读取到 throughSequence（exclusive beforeSequence=throughSequence+1），检查每页序号单调和 task/attempt/session 归属。输出为所有非 user 的 text.data.text 原字串拼接，UTF-8 SHA-256，与 Runtime 结算的 driver_result.outputDigest 比较；上限保持 512 KiB，超限报错，不截断。手动确认/未提交取消没有 driver 输出摘要，仍要求真实结算事件。生成结果后由来源 CAS 冻结，后续交付/图依赖只读这个快照。普通 WorkItem completed 步骤继续要求非空生成结果，保持原错误语义。

## WorkItem 接线

WorkAttempt 增 admission、runtimeAttemptId、result、resultBoundary 和 blockReason；旧 output 保持兼容，后续步骤仍读取冻结 output。私有 StoredWork 保存 admission/actor 等执行材料时，公开投影只返回任务/尝试引用、状态、结果和可展示 blocker，不将原 envelope 透传。

launch 遇到已接受 Task 先补映射并返回，不重新启动 Session、不展开 Skill。首次发起才执行现有 startWorkItemSession 和授权流程，dispatch 使用持久 request。drive 用固定 Attempt 结果推进；unknown/legacy 输出无归属立即 blocked，不能等一小时后才报超时。旧已保存 output 或已交付 WorkItem 保留；活动工作中缺结果的历史完成步骤，先按原固定 Task/Attempt 核验结果，无法核验则标明 legacy_output_unresolved 并阻止下游，不扫描邻近 Session 事件猜补。

cancel 的同一 CAS 保存私有 cancellationActor:ExecutionActor，再停止子执行；安装者代平台创建人取消后，重开必须仍使用本次安装者身份。超时及 haltBlocked 使用创建时冻结的可核验 actor 并保存自动停止原因。统一调用 stopWorkItemSession(sessionId, actor:ExecutionActor):Promise<boolean>，不能只拆 actor.id 丢失 App 域。父项取消不等待长 send 后才落库；返回 true 仍需原 driver 或既有持久事实证明资源安全，无内存 driver 本身不构成证明。物理未确认仍 blocked。图 retryStep 仍只接受确定失败并创建新的 WorkAttempt，不借它自动重试 unknown 的原 Task。结果读取的越界、坏记录或摘要冲突走 blocked，不能被旧 output catch 转为 failed 后允许重试。

## Schedule/CI 与交付接线

仅 occurrence 和 CI 记录升级 schemaVersion=2；保留严格 V1 reader，原 raw CAS 后写入 V2。新增 admission/runtimeAttemptId/result/resultBoundary/blockReason 和 blocked 状态；尚未到达的阶段不造字段。Schedule 定义 schemaVersion=1 与现有触发条件、generation 保持。公开类型/函数显式排除私有请求材料。

refreshAcceptedWork 先固定 number=1，再冻结结果；unknown/legacy 缺边界立即 blocked。planSchedule 看到已有 blocked/未决来源仍阻止创建下一 occurrence，即便同一 Task 后来 Attempt 2 已成功也不能越过。真正新的业务触发保留原代际规则。

deliver 改为 (sessionId, result:AttemptResultV1, occurrenceId, sourceId)。automation-integration 校验引用和当前交付权限、原目的地；直接用冻结 text 渲染结果，保留原失败/中断状态映射、idempotencyKey 与目的地约束。不再找 user 事件起点切当前 Session 列表。交付回执写回前除 lease owner 外也核对原 result 的 task/attempt/settlement/throughSequence/digest；过期响应不能覆盖另一结果。旧已 delivered 保持，旧 pending/error 无可靠结果标 blocked，不重造 pending。

## 验收

- 真实 SQLite 下接收成功但 dispatch 响应丢失，重开后材料/Skill/HEAD 读取次数不增加，供应商收件仍一次；来源与授权双 KV 中间强退可补同一映射。
- 两个竞争 CAS 只能选一个 admission；同 key 异载荷、旧算法 ID 与新 ID 冲突均保留 blocked，授权绑定不失联。
- 输出超过 200 条仍完整；Attempt 1 unknown、Attempt 2 completed 时来源保持 blocked；别的 Session/Task/Attempt 事件、旧无边界输出和 digest 不匹配不能成为成功。
- 原有图等待/条件/取消/明确失败重试、Schedule generation/权限/HEAD/到期、目的地幂等和已交付记录保持。
- 根 Runtime 账本接口整合后运行真实本地 driver + SQLite 联合测试；类型和模拟测试不替代这个最终接线门禁。
