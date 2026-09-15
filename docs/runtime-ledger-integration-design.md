# Runtime 接入 Task/Attempt 账本

状态：仓储、发布器及 Runtime 核心已通过各自独立复核并整合。沿用 [Task/Attempt 设计](task-attempt-design.md) 的状态、事务和恢复规则。新库默认仍为 legacy；来源、旧调用方、物理资源和可操作恢复尚待接线与联合验收，不能据此宣称 P0 完成。

## 单元与边界

现 Runtime 的 Task、Session 执行状态和事件写入整体转到 bound execution。Owner、SessionMutations 与完整关闭尾声负责本进程异步取消；持久 claim/Attempt 负责数据库事实，两者不能互相替代。

| 单元 | 接入内容 | 验收 |
| --- | --- | --- |
| 仓储接缝 | 新库初始化、工作区投影、直接中断、状态事件原子命令、事件高水位 | 真实 SQLite 回滚、重投、失效 claim、历史 restart |
| Runtime 核心 | accept/claim/submit/settle、固定 QueueAction、事件归属、资源与关闭 | 提交前后强退、停止重开、未知与明确重试 |
| 来源与结果 | Web/CLI、飞书、WorkItem、Schedule/CI 的稳定请求与固定结果 | 响应丢失不重读材料、不重复执行；结果不跨 Attempt |
| 展示与恢复 | 持久发布器、SSE、任务/尝试查询和恢复命令 | 丢 wake 自主补发；游标续接；旧卡不操作新尝试 |

事务/并发核心作为复杂单元安排；冻结接口后的来源、消费者和展示开发交 ccflash。各自使用独立 worktree，不另造接受或状态判定协议。

## 新数据库与离线升级

storage 的 RepositoryOpenOptions 增加 `newDatabaseAuthority?: 'legacy' | 'ledger_v1'`。本接缝中默认仍 legacy；完整 Runtime 切换及全仓迁移测试通过的同一整合改动才将默认切为 ledger_v1。这个选项只决定真正新数据库的初始权威，不能覆盖既有 marker。

取得现有排他维护门禁后，在业务连接的 BEGIN IMMEDIATE 内、创建 schema_migrations 之前检查 main.sqlite_schema。仅有经现有 control opener 建立的 dutydeck_control/dutydeck_access 及 SQLite 保留对象才算新库；任何其他用户表、视图或触发器（包括空 schema_migrations）都算既存数据库。不能按 sessions/tasks 行数判断。沿用 runMigrations 的嵌套事务建立 schema，fresh 且显式 ledger_v1 时最后修改 marker，一起提交；不运行另一套旧数据转换。PRAGMA/VACUUM 等事务外步骤保持在外层事务前，finishUpgrade 在 commit 后执行，构造失败关闭 control 与业务连接。

已有 legacy 数据库只能通过离线命令 `dutydeck database upgrade-execution --database <path>` 转换：management opener 取得排他维护门禁，调用现有 execution.upgradeLegacy()，输出 authority、迁移数量和 blocker 后关闭；活跃 Runtime 存在则拒绝，不停止它。增加只读 `database execution-status --database <path>`：storage 单用途 inspectExecutionDatabase 用 readonly+fileMustExist SQLite 在同一读取快照内检查 schema/marker，路径不存在返回 missing，旧/未知 schema 返回明确状态，不注册写 access、不建库、不跑迁移；不得调用默认 createRepositories。真实生产库的操作不属于本次开发验证。

两条 CLI 都要求明确 --database，输出单条结构化结果。status 区分 missing、uninitialized（真实空 schema）、legacy、ledger_v1、unsupported；文件不可读/非 SQLite/坏 marker 是明确错误，不伪装 missing。可返回实际 schema version 和任务/尝试/资源数量，只列持久登记数量，不把残留登记数当作进程存活证明。upgrade 对不存在路径拒绝，不能意外建立空库；先取得现有 management/maintenance 门禁，复用 upgradeLegacy，不另写 SQL 转换算法，不隐式启动/停止 daemon。成功回读实际 authority、前后计数和 session blocker；失败保留可重开状态并释放本次连接。旧库已有活跃 Runtime、外部访问登记或未能证明死亡的持有者时维持原排他拒绝。

upgradeLegacy 返回同步 ExecutionUpgradeSnapshot：before/after 各含实际 authority 和 tasks/attempts/resources/registeredAccess 计数，另含 after 的全部 Session resource blockers。在既有 beginUpgrade 与 finishUpgrade 之间、同一次业务 IMMEDIATE 事务内读取 before、执行原转换、读取 after 与 blocker；ledger_v1 的幂等分支也返回真实快照。CLI 只格式化这些已捕获的值，不能在释放维护后 await sessions.list 或另开 inspect 拼接报告。before 指 schema 准备完成后的执行权威转换前；预检状态只用于识别支持范围，不作为此次转换的隔离快照。内存库没有持久 access 表时登记数为 0，文件库维护期间包含本次真实登记，不为兼容旧输出强写 0。缺 --database 的两条命令同样返回单条 JSON 错误；保留其他旧 CLI 的错误格式。空 schema 只排除真实的两个控制表，同名用户视图仍属既存 schema。

Runtime initialize 在 Agent 配置保存、verification、Git、队列和 driver 动作前读取权威；legacy 返回 `EXECUTION_UPGRADE_REQUIRED` 及上述命令，清理已取得的 access，不 attachRuntime。仅 ledger_v1 才取得 claim 并 bind。正常新安装走真实 opener；历史测试走真实升级命令或相同入口，不用裸 SQL 改 marker。

## 请求、来源映射与选项

`dispatch` 保留既有参数，末尾增加 TaskRequestV1；`lookupAcceptedTask(request): AcceptedTask | undefined` 是同步只读身份查询。来源在下载材料、展开 Skill、CI 读取 HEAD 前先查接受事实；Runtime accept 事务仍再次检查。显式 sessionId、原 prompt、mode、key、原始 skills 及 actor 必须与 request 一致，不一致报 `TASK_REQUEST_MISMATCH`。agentPrompt 可为查询后准备的材料快照。未传 request 的旧入口产生完整默认 envelope；未提供 key 的 send 每次生成新 key。缺省 actor 为 unspecified，不补安装者。

TaskRequest.options 是该 Task 执行选项的唯一来源：首次准备时，缺省项从当时 Session/Agent 配置解析，冻结进 AcceptedTaskInputV2.executionOptions（model、reasoningEffort、permissionMode；可选项省略、不保存 undefined）。每次 Attempt 使用此快照构造实际 driver turn 配置，不顺手更新 Session 默认值；执行授权可收紧/拒绝快照，不能静默扩大权限。显式请求与接受快照都用于摘要。逐 Task 配置在本 Attempt preparing/not_submitted、markSubmissionPending 前执行；当前 preparing 不阻挡自身准备，其他 Attempt、未结束事件/权限/SDK 尾声及历史未知资源仍阻断。走内部配置路径，不调用会改 Session 默认值的 public setters，也不调用 stopSession/restart/replaceSessionRun。比较完整有效快照，相同才复用；已证明支持的动态选项必须 setter 成功，否则若能用启动参数准确表达，先停止旧 driver 并证明 gone，再在资源许可下创建同 Attempt 的新 driver。重建须沿用可证明的原生上下文恢复，不准因 resume 失败创建空会话。每个任务都应用完整快照，上一轮 model=A、下一轮缺省意味着恢复缺省，不能保留 A。无法证明复位/上下文或不支持组合（如 PTY deny-all）时在提交前返回明确准备错误，零 send；已提交恢复只附着原配置，不为重配重发。不能账本写 queue、实际执行 interrupt。

公共与内部配置 setter 共用提交门禁。开始外部 setter 前登记在途配置变更；在途/未知状态检查早于“已跟踪选项相等”的复用快捷返回，避免 ACK 未到时提交新任务。setter 报错可能发生在 Agent 已改变配置之后，必须保留持久的配置未知事实，不能沿用旧 options 推断未改变。物理 gone、stop/resume、换 run 或数据库重开都不能清除该事实；只有对原生上下文实际配置的可靠证明，或明确创建新上下文的受支持操作，才能解除。当前驱动尚无此证明接口时继续阻断，不借自动 fresh 恢复。两个真实反例已证实：模型已变 B 而 ACK 报错，以及 ACK 仍在等待时，账本默认 A 的下一任务都可能在 B 执行；普通 session/load 并未恢复模型。

统一 `executionTaskId(namespace, sessionId, key)` 保持 `task_v1_` 加 SHA-256(canonicalExecutionJson([namespace, sessionId, key]))。实现从 storage 当前算法提取并由 @dutydeck/storage 导出，Runtime 和 server 共同调用；不把 node:crypto 带入浏览器也使用的 shared 根导出。shared 只保存类型与规范编码。历史 ID 原样保留。

来源记录增加严格判别联合 TaskAdmissionV1：新事实为 `{version:1; kind:'canonical'; taskIdVersion:'v1'; taskId:string; request:TaskRequestV1}`；历史为 `{version:1; kind:'legacy_partial'; taskIdVersion:'legacy'|'v1'; taskId:string; request?:TaskRequestV1}`，仅在原事实确有 request 时携带，不能从今天的材料/配置补造。WorkAttempt、Schedule occurrence、CI dispatching 在各自 CAS 内持久 admission；既有 taskId 若保留为兼容投影，读写必须与 admission.taskId 相等。已有 Task 或 lookup 接受事实优先沿用；两者冲突立即 blocked，不再派发。只有旧 preparing/dispatching 映射尚无任何接受事实时，才按原记录 revision/raw CAS 固定新 ID；输家重读获胜记录。

Automation 的 task 授权绑定是第二条 KV：来源 CAS → 幂等补齐所选 taskId 的绑定 → dispatch。崩溃恢复补齐相同绑定，authorizeTask 使用记录的算法版本和 ID，不重新套旧 hash。首次准备前复核来源状态/lease；已经接受的恢复不因 HEAD、材料变化建立另一 Task，真正提交仍复核授权。飞书 admission 在原始入站处冻结 App/chat/root/message、原内容和附件身份；并发准备只使用 accept 胜出的快照。网络重投沿用请求；人工重新执行使用 Attempt retry，不换 key 冒充新用户输入。

新接受使用 AcceptedTaskInputV2（version=2，原快照字段加必需 executionOptions），摘要包含完整选项；读取类型保留原 V1 严格解码，历史 accepted_json 与原摘要不改。acceptTask 的新接收只接受 V2，既有接受事实仍能只读重投。缺 executionOptions 的历史准备/重试自动提交返回 INPUT_OPTIONS_UNVERIFIABLE，不伪造冻结事实；已提交轮次只能按原恢复证据附着。用户可明确核对/取消旧任务并另建完整新请求，不把这个新请求伪装成原 Task 的透明恢复。

## 新的同步仓储接口

```ts
interface SessionWorkspaceProof {
  expectedCwd: string;
  workspaceRevision: number;
  workspaceDigest: string;
}
type SessionStatePatch = Pick<Session, 'state'> & { error?: string | null };
interface BoundExecutionRepository {
  markOrphanedAttempt(f: AttemptFence, reason: ReconcileReason): CommitResult;
  finalizeSessionWorkspace(f: SessionFence, proof: SessionWorkspaceProof): Session;
  recordInterruptIntent(f: AttemptFence,
    input: { operationId: string; actor: ExecutionActor }): CommitResult & { action: QueueAction };
  patchSessionState(f: SessionFence | AttemptFence,
    operationId: string, patch: SessionStatePatch): CommitResult;
}
interface ExecutionRepository {
  getAcceptedTask(taskId: string): AcceptedTask | undefined;
}
interface EventRepository {
  highWaterMark(sessionId: string): number; // 同步 SQL，无事件为 0
}
```

均沿用现有 claim 校验、BEGIN IMMEDIATE、命令去重及事件 sequence 分配。重投先验当前 claim/Session 范围，再按稳定载荷查原事实；expectedRevision 不计入命令身份，首次提交才比较它。同 ID 异载荷拒绝并回滚。

getAcceptedTask 是同步只读查询，按 Task ID 严格解码已持久化的 request/input 和 replayValidation，沿用 V1/V2 原事实，不从当前配置补齐字段。用于重开后的已接受队列；查询不创建 Task、不修改摘要。

markOrphanedAttempt 仅允许持有当前合法 claim 的新 controller，处理 controller 身份与自己不同、仍是该 Session/run/Task 当前 Attempt 的已提交 preparing/active/reconcile_required 记录。not_submitted、suspended、settled 和 legacy_unresolved 均拒绝。首次执行比较 Attempt revision，原子追加原因、改 Task/Attempt 为 reconcile_required 及事件；保持原 controller、submissionController、submission、资源和恢复证据不变。命令重投沿用同一 reasonId，异载荷拒绝。旧 controller 已失去数据库所有权只证明它不能继续提交账本，不证明 Agent 消失；这个命令不接管原轮次、不发输入、不结算结果。尚未提交的 preparing 继续沿用 recoverAttempt(unsubmitted_preparation)，只有真实安全资源证明齐全才恢复排队，否则保留原状态和 blocker。

Runtime stop/archive/restart 增加可选 ExecutionActor，调用者传真实操作者。需要取消 queued Task 时，缺省或 unspecified 不冒充安装者：stop 仍停止本地执行与接收，保留 queued/suspended，完成停止后返回 ACTOR_REQUIRED；archive/restart 在改变归档或 run 前拒绝。没有待取消队列时可沿用无 actor 的生命周期操作。shutdown 始终保留队列；内部逐 Task 配置使用独立驱动停止路径，不借 stopSession 取消任务。

直接中断复用 QueueAction，source 增 interrupt，taskId 为原目标 Task，不建立假 queued Task。recordInterruptIntent 在同一事务固定目标、操作者、审计事件、兼容 interruptedByActor 投影与 Session interrupting；Task/Attempt 不结算，所修改投影增加相应 revision。unspecified 不清除既有 actor，更不推断 owner。没有活动 Attempt 时 Runtime 返回 `{interrupted:false, reason:'no_active_attempt'}`，不登记未来目标。提交后才调用原 driver；返回不是完成证据，等待完整结果或转 reconcile_required。旧操作恢复只核验原目标；目标已结算则收口，绝不打断后来尝试。

patchSessionState 原子更新 Session 并追加一条由最终持久字段生成的 status 事件，operationId 重投无重复事件。error:null 清除，省略保持；事件含最终 error（无错为 null）。AttemptFence 只允许当前属主的 thinking/running_tool/waiting_for_permission/interrupting 等非结算状态；completed/failed/interrupted 等本轮结果由 settleAttempt 写入。无任务 lifecycle 使用 SessionFence，事务核对无 preparing/active/reconcile_required/legacy_unresolved Attempt；stopped 还要求资源确已安全，starting/idle 要求资源对当前 owner 可用。suspended 不因生命周期写入被丢弃。启动失败可记录 failed 和 blocker，但不能把未知资源宣告 stopped。Runtime 禁止再用 patchSession+appendEvent 两步组成状态转换；既有 patchSession 仅用于显式归档及无事件元数据，保留归档 blocker。

## 工作区与 Session

WorkspaceManager 证明来自实际 `runtime_workspace:<sessionId>` KV 原始 UTF-8 字符串的 SHA-256。先读取 raw 并解析，然后验证这份记录对应的 OS/Git；异步验证结束再读 raw，必须完全相同，变化则重新准备与验证。不能把另一次读取的摘要配给旧验证，也不能 hash 带 error:undefined 的内存返回对象。

finalize 在事务内核对 SessionFence、实际 KV 的 sessionId/ready/revision/digest。当前 Session.cwd 已等于 ready.cwd 时直接返回当前事实，即便 expectedCwd 是首次调用前的值、已有历史 Attempt，也不再次更新；证明或 run 冲突仍拒绝。这个分支不清 blocker、不换 run，后续启动继续检查授权和资源。

实际 cwd 不同才走初始化更新：Session 仅 created/starting/failed、未归档/停止、尚无任何 Attempt，expectedCwd 匹配，且没有 pending/unknown/live 等未证明结束的资源。仅将 ready.cwd 投影到 Session；mode/sourceCwd 继续由唯一工作区记录读取。历史 Session 改目录不在此接口支持范围。restart 对相同已准备工作区先验证/no-op，再调用 replaceSessionRun 检查旧 Attempt 和资源，不因存在已结算历史而拒绝正常重启。

普通配置省略字段保持原值。换 run、归档、terminal driver 获取、工作区清理和无任务恢复都检查持久 blocker；无 Task 不等于无资源。

## 事件归属、权限与发布

内部捕获的 eventScope/owner 只适用于其原 Session，任何 currentRef 查询必须匹配 sessionId。公开订阅回调在脱离内部 Attempt 与 owner 的异步上下文中调用，回调发起的新 API 操作重新取得目标 Session 的身份；不能因 publisher.wake 继承 ALS 而把发往 B 的事件写入 A，或让迟到回调沿用已结算的 Attempt。

每条 driver 事件入队时捕获 AttemptRef、runId、本地 owner/generation 及 eventId。消费者读取该捕获 Attempt 的最新 revision，不复用入队旧 revision，也不改绑当前 activeTasks。有 sourceId 的全局 ID 为版本化 SHA-256(canonicalExecutionJson([sessionId, ['attempt', attemptId], sourceId]))；无任务生命周期使用 ['run', runId]。无 sourceId 在入队生成一次 ID，失败重投沿用。完成判定等该轮事件尾声入队；归属不明的迟到事件不能计入下一 Attempt。

权限与工具内部键同时绑定 taskId/attemptId/原生请求 ID；回调携带固定 Attempt 及内部请求身份，驱动原生 ID 单独保存。取消或重开后不能通过“当前同名 permission”恢复旧卡。工具/权限等派生展示先等权威事件提交，再更新派生记录；展示失败不撤销执行事实。

driver 事件转换为有限 JSON：省略可选 undefined 对象字段，保留 null 和数组顺序；循环、函数、非有限数报明确转换错误。严格 TaskRequest 校验不使用这种有损修补。命令提交后 wake，emit 不再自行分配 sequence，通知失败不写任务 failed。完成事件只由结算事务生成。

SSE 有游标时 publisher afterSequence 回放并跟进；新页面的最近 200 条与连接之间使用该窗口确定的持久游标，不做有缝的“读窗口后从现在开始”。保留慢客户端断开/socket drain。游标只表示事件已交给本地消费者，不声称外部平台 exactly-once。

## 结果消费者的固定边界

新增共享结果引用 `AttemptResultV1 = {version:1; taskId; attemptId; settlementId; throughSequence; outcome; output:{text,digest}}`，其中 outcome 明确为 completed/failed/interrupted/cancelled（不含 unknown），throughSequence 为该 settlement 的最后事件 sequence。WorkAttempt 保留既有 status，增加 admission、runtimeAttemptId、result 与 `resultBoundary?: 'verified'|'legacy_output_unresolved'`。Schedule occurrence/CI 记录升级 schemaVersion=2，添加相同字段、状态 blocked；V1 严格读取后 CAS 升级，不能先覆盖再猜历史；admission/runtimeAttemptId/result 在历史和尚未进入对应阶段的记录可省略。既有 WorkAttempt.output 保持原兼容字段供后续图步骤使用，不伪造 settlementId/throughSequence。未决运行原因另存 `blockReason: 'reconcile_required'|'legacy_output_unresolved'|'legacy_input_unresolved'|'admission_conflict'`；这些字段的公开投影不暴露私有 sourcePayload/授权资料。无 Attempt 的 queued 取消直接收口为取消/不交付；不可透明执行的旧输入立即 blocked。具体首次子 Session 查询及持久取消 actor 见 [来源接线稿](task-source-consumers-design.md)。

每个来源只选择 Task 的 number=1 Attempt，CAS 固定 runtimeAttemptId；不跟随 currentAttempt。在最终 settlement 边界内用 getAttemptEvents(afterSequence, limit) 分页读完（默认 200 不代表全部），只消费 <=throughSequence 的事件，再生成输出与摘要；沿用现有字节上限和超限错误，不能静默截成成功。冻结后重发只用 AttemptResultV1。Automation deliver 改为接收该结果引用，不能只传 taskId 再查询当前 Task/Session 输出；WorkItem 图后续步骤同样读冻结结果。

throughSequence 必须取同一 attemptId+settlementId 的权威 completed 事件；它由结算事务最后追加，不能用 Session 当前高水位代替。文本算法与 Runtime.driver_result.outputDigest 一致：按 sequence 顺序直接拼接非 user 的 type=text 且 data.text 为 string 的原始文字，UTF-8 SHA-256；不 trim、不插换行、不含 thinking/tool/status/raw_terminal。消费保留 512 KiB 上限；已提交 driver_result 的摘要不匹配则拒绝生成已验证结果。旧 legacy 无该结算事件时保持 unresolved。手动确认及未提交取消没有 driver 输出摘要，仍要求真实结算边界，不伪造输出。

legacy 已保存 output 或已交付事实保留；没有存储结果且没有可靠 Attempt 事件归属时，持久 blocked/legacy_output_unresolved，不生成空的成功、不猜补旧事件。被选 Attempt 为 reconcile_required、legacy_unresolved 或 settled/unknown 时立即 blocked，独立于 Task 当前状态和后来 Attempt；新的 reconcile_required 同样 blocked，不继续普通运行等待超时，也不制造另一个 occurrence。飞书 live 按固定 taskId+attemptId+sequence 过滤，缺失映射先查接受事实；最终卡片只用该 Attempt 的结果，已交付历史不重建 pending。

## 资源中间态与关闭

send 同样 accept/claim，等待它自己的 Attempt 结果；不能创建绕账本的 running Task。未提交准备在关闭时 suspend 原 Attempt；提交意图落库后，超时/退出/interrupt 缺少完整结果则 reconcile_required，不能降回未提交或根据 rejected Promise 写 failed。

物理 hooks 全接通前，factory 调用前登记 operation 和 local_only 资源。返回 driver 时绑定本地 identity；完整 start/creation 尾声结束后标记 child created、owner-live，并单独结束 parent operation。正常顺序任务可复用同实例已知存活资源。抛错或仍有创建尾声保持 pending/unknown；资源登记失败也必须持有实际 driver 并清理，不丢引用。使用现有 beforeCreate/spawned/creationFinished/observed，不放宽旧 pending 的收口权限。

gone 必须由原 driver.isStopped()===true 的物理证明及完整创建/生命周期尾声结束支撑。shutdown=true、stop() resolve 和 PTY detach 均不能代替。原实例无法证明的 local_only 在重开后继续 unknown；controller 进程死亡不证明其 Agent 已退出。这个过渡不能作为 P0 最终交付，后续仍须接通 ACP/PTY/JSONL/Pipe、远端创建与恢复的真实 hooks。

shutdown 顺序：停止外部生产者和新提交 → 撤销原本地 owner、取消准备并先发起已知 driver.stop/interrupt 与创建清理 → 持 claim 等已进入的命令、driver/队列及事件派生尾声 → 提交暂停/未知结果与最终资源观测 → 关闭 publisher 并等待其实际在途查询/回调 → 释放 claim、关闭仓储。驱动停止不能在短写序列中等待，也不能先等权限中的执行完成才发起 stop。publisher.close 会停止继续投递，并不保证把全部历史事件交给失败消费者；未交付事实仍在库中供重播。通知失败不改执行结论，未决物理资源不因清空内存消失。

## 合入验收

真实新库 ledger 初始化及事务失败重开；已有空/非空 legacy 库拒绝隐式转换，离线升级排他；工作区响应丢失重投、KV 变动拒绝、历史 restart；固定中断目标与状态/事件同事务；来源 CAS/双 KV 崩溃恢复；重复供应商 ID 跨 Attempt 隔离；超过 200 条输出与 legacy 缺边界阻塞；shutdown/detach 不谎报 gone；Runtime/来源/结果只走一个账本。真实 SQLite、Git、本地驱动集成、全 workspace 构建/类型/测试及独立审查通过后才能合入最终运行路径。真实供应商和平台未运行的项继续标为 unverified。
