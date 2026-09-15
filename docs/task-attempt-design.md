# Task、执行尝试与资源恢复

状态：状态、命令接口、迁移和兼容边界已通过独立审查；storage/shared 事务单元正在独立 worktree 实施，Runtime 和驱动尚未切换。数据库控制与驱动轮次的已通过结果见 [实施记录](full-product-execution.md)。本文件决定下一批实现契约，不能把内存 owner 或数据库执行权当成 Agent 已退出的证明。

## 要补的实际缺口

当前 dispatch 原子保存 Task 与 queuePosition，但领取仅建立内存 owner；Task、Session 和事件分别写入。executeTask 在授权、checkpoint、sessionPrompt 后调用 driver.send，提交阶段只记在内存。initialize 主要依据 Task.status 与 PTY checkpoint 恢复。崩溃后无法可靠区分准备中、已提交和结果待核对，完成事实与通知也可能不一致。

Session 创建、重连及 SDK 内部操作均可创建资源。资源记录必须覆盖没有 Task 的会话，不能只围住 send。WorkItem 当前按 taskId 的首条 user prompt 收集输出，并拒绝后续 user prompt；同 Task 重试会越过这个边界。因此 Attempt 身份必须一起接入事件和结果消费。

## 状态与身份

```ts
type TaskStatus = 'queued' | 'running' | 'reconcile_required'
  | 'completed' | 'failed' | 'interrupted' | 'cancelled';
type AttemptState = 'preparing' | 'active' | 'suspended' | 'reconcile_required' | 'legacy_unresolved' | 'settled';
type SubmissionState = 'not_submitted' | 'intent_recorded' | 'acknowledged' | 'legacy_unknown';
type AttemptOutcome = 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'unknown';
interface AttemptRef { taskId: string; attemptId: string; }
interface ResourceRef { resourceId: string; identityId: string; }
```

Task 保存原 ID、不可变接受输入、请求身份、queuePosition、currentAttemptId 和递增 revision。Task.status 是当前 Attempt 的投影；尚未领取时是 queued。Attempt 保存 ID、Task/Session/runId、从 1 递增的 number、revision、控制者及代际、state、submissionState、可选 submissionId、资源引用、恢复定位和可选 settlementId/outcome。恢复控制者变更另存历史，不改原提交控制者和提交事实。

| Attempt 状态 | 合法提交阶段 | Task 投影与动作 |
| --- | --- | --- |
| preparing | not_submitted | running；准备、重新授权，尚未允许 driver.send |
| active | intent_recorded / acknowledged | running；同一 submissionId 最多调用一次实际提交，或附着原轮次 |
| suspended | not_submitted | queued；shutdown 暂停准备，保留 Attempt 和队列位置，释放活动槽 |
| reconcile_required | intent_recorded / acknowledged / legacy_unknown | reconcile_required；占据活动槽，禁止下一指令或替代执行器 |
| legacy_unresolved | legacy_unknown | reconcile_required；仅用于多条历史活动记录的歧义迁移，不占新活动槽，由 Session blocker 阻止领取 |
| settled | 任意；outcome 必填 | current Attempt 投影为对应终态；unknown 投影仍为 reconcile_required |

每个 Session 的 preparing/active/reconcile_required 至多一行，以 SQLite 部分唯一索引约束。每个 Task 的 (taskId, number) 唯一，只有 currentAttempt 可以占活动槽。suspended 不占槽；claimNext 再领取该 Task 时恢复同一 Attempt，不能新建一行。它按保存的 queuePosition 排队，其他已明确插到前方的任务仍可先执行。资源 blocker 独立于活动槽，释放槽不等于允许重建资源。强退留下的 preparing 由新 Runtime 用 recoverAttempt 的 unsubmitted_preparation 分支先换绑为 suspended，再按队列领取；不需要 submissionId/turn/cursor，不重建 Attempt。只有 not_submitted 可走此分支，已提交与旧未知不可降级。

正常 shutdown 对 not_submitted 调用 suspendUnsubmitted。用户取消未提交任务可以结算 cancelled；没有 Attempt 的 queued 直接 cancelQueued，不伪造执行尝试。已提交超时、断连、退出或取消请求只证明结果未知时进入 reconcile_required；明确完整结果才结算。已保存的 completed 不被迟到错误覆盖。

明确重试仅允许 failed/interrupted/cancelled 或待核对的当前 Attempt，completed 不重试，另发新 Task。待核对的旧 Attempt 在同一事务中以 outcome=unknown、recovery decision 为依据结算，保留原提交阶段；随后为同 Task 建立 number+1 的 suspended/not_submitted Attempt 并入队。这个新尝试由 claimNext 领取，不能在恢复 API 内直接 send。旧 settled 结果不改写。结果确认与资源退出分别核验；任何重试都必须满足资源安全条件。

## 请求与接受输入

```ts
interface TaskRequestV1 {
  version: 1;
  namespace: 'runtime' | 'lark' | 'work_item' | 'automation' | 'schedule';
  key: string;
  sessionId: string;
  actor: { kind: 'installation_owner'; id: 'installation_owner' }
    | { kind: 'channel'; id: string; appId: string } | { kind: 'unspecified' };
  prompt: string;
  mode: 'queue' | 'interrupt';
  skills: string[];
  options: { model?: string; reasoningEffort?: string; permissionMode?: string };
  sources: Array<{ kind: string; id: string; version?: string; digest?: string }>;
  sourcePayload: JsonValue;
}
interface AcceptedTaskInput {
  version: 1;
  prompt: string;
  executionContext: TaskExecutionContext;
  contentSources: Array<{ kind: string; id: string; version?: string; digest: string }>;
  digest: string;
}
```

JsonValue 仅允许有限 JSON 值，无 undefined、非有限数或重复键；对象键排序、数组保持顺序，UTF-8 JSON 的 SHA-256 形成 requestDigest。数组必须逐项为自有数据属性，无空洞、getter、额外属性或 Symbol，校验不调用输入对象的方法。获准载荷从数据库读回后必须得到同一摘要。Unicode 不做隐式归一化。actor、mode、显式执行选项、Skill 请求和来源身份均参与摘要；权限版本、临时 token、环境凭据和后续动态授权不参与。

平台凭据由连接/授权适配器在明确的元数据边界隔离，不进入 Task envelope 或公开投影。sourcePayload 和工具 input/output 是业务 JSON，不能仅凭 env、token、password 等通用键名拒绝整条记录；这些键也可能表示普通程序参数。结构化执行字段使用严格 schema，只保存恢复定位、凭据引用和授权引用，不接收环境注入对象或 secret 值；资源 locator 属于连接元数据，继续限制凭据字段。来源适配器负责只构造所需业务载荷，事件桥负责有限 JSON 转换和已知凭据值的脱敏；仓储不声称能识别任意用户文本中的秘密。

唯一键为 (namespace, sessionId, key)。同键同 requestDigest 返回原 Task、原接受快照和当前状态；不同摘要报 TASK_IDEMPOTENCY_CONFLICT。首次接受前先 lookupAccepted；命中不得重新读取远端材料或注入 Skill。并发首次准备可以进行无副作用读取，但只有 acceptTask 事务的获胜快照被采用；另一个相同请求返回已保存快照，不比较它后来读到的易变内容。接受快照保存冻结材料和 Skill 元数据，执行阶段仍重新授权。

| 入口 | 稳定 sourcePayload 与 sources |
| --- | --- |
| Web/CLI/直接调用 | 用户明确输入的 agentPrompt、选项、Skill 请求、附件身份；无调用方 key 时生成一次请求 key，不承诺跨调用幂等 |
| 飞书 | App、chat/root/message ID、原消息内容和附件 ID/来源版本；在材料下载及路由补充前构造，不能 hash 已注入临时上下文的 agentPrompt |
| WorkItem | WorkItem/step/WorkAttempt ID、冻结定义与上游结果 digest；图的新 WorkAttempt 建新 Task |
| Automation/Schedule | 运行或 occurrence ID、冻结定义版本与本次输入快照，不能使用每次 tick 的时间或重新读取的 CI 摘要 |

保持现有外部 API。内部 dispatch 的尾参数增加可选 request: TaskRequestV1；所有来源适配器在上述边界传入。现有程序调用未传时由完整显式参数构造 runtime envelope，包括 agentPrompt、riskPolicy 和 skills；该兼容路径不会猜测哪些内容可忽略，变化即冲突。send 也经过 accept/claim，保留等待结果的返回语义。

缺省 actorId 的纯 Runtime 调用记 unspecified，不能获得安装者权限；需要通道身份的 Session 或动作明确拒绝 ACTOR_REQUIRED。已认证的 Web/CLI 入口显式传 installation_owner，channel 身份由可信来源适配器解析并带 App。request.actor、显式 actorId、Session 的 App/来源必须一致；发生冲突先拒绝，不能任选一个继续授权。unspecified 仅保留本地无通道会话的普通执行语义，不扩大 full-trust 或群工具权限。

摘要分三层：requestDigest 描述入站语义；AcceptedTaskInput.digest 描述首次接受内容；submission.inputDigest 描述本次真正交给驱动的最终输入。sessionPrompt、PTY 路由块及 session marker 的生成必须在最终摘要前完成。持久输入不含临时凭据，凭据在执行边界单独注入，不算用户指令文本。

旧任务使用 digestVersion=legacy_unverifiable，迁移不能反算成 V1 完整证明。重投先检查原 task_ SHA256(sessionId + NUL + idempotencyKey) 的旧 ID；若命中 legacy Task，比较当年已保存的 session/prompt/actor，已知字段不同报冲突，否则返回原记录并标 replayValidation=legacy_partial，绝不创建第二 Task。新记录的来源命名空间参与 ID 和唯一键，完整 V1 比较不走 legacy 降级。

## 事务所有权与命令接口

storage 提供 execution 仓储。bind(claim) 只接受本 bundle 签发、仍存活的 RuntimeControlClaim；storage 内 WeakMap 持有 claim 到 access/instance/generation/entity 的绑定，调用者不能拼接这些字段。持久库每项命令在业务连接的同一 BEGIN IMMEDIATE 事务内检查 dutydeck_control 的协议、phase、entity、runtime、instance、generation 后读写执行事实；不得只调用另一控制连接的 assertCurrent 再写。:memory: 在同步事务内检查同一 bundle 的实例与代际。

```ts
interface SessionFence { sessionId: string; runId: string; }
interface AttemptFence extends SessionFence {
  taskId: string; attemptId: string; expectedRevision: number;
}
interface CommitResult {
  task?: TaskRecord;
  attempt?: TaskAttempt;
  session: Session;
  events: AgentEvent[];
  replayed: boolean;
}
interface BoundExecutionRepository {
  lookupAccepted(request: TaskRequestV1): AcceptedTask | undefined;
  acceptTask(f: SessionFence, request: TaskRequestV1, input: AcceptedTaskInput,
    position: 'front' | 'back'): CommitResult;
  claimNext(f: SessionFence): CommitResult | undefined;
  promoteQueued(f: SessionFence, taskId: string, expectedTaskRevision: number,
    operation: QueueOperationInput): CommitResult;
  getPendingQueueActions(f: SessionFence): QueueAction[];
  settleQueueAction(f: SessionFence, operationId: string, expectedRevision: number,
    evidence: QueueActionEvidence): QueueAction;
  markSubmissionPending(f: AttemptFence, input: SubmissionIntent): CommitResult;
  markSubmitted(f: AttemptFence, receipt: SubmissionReceipt): CommitResult;
  settleAttempt(f: AttemptFence, settlementId: string, evidence: SettlementEvidence): CommitResult;
  suspendUnsubmitted(f: AttemptFence): CommitResult;
  cancelQueued(f: SessionFence, taskId: string, expectedTaskRevision: number,
    decision: RecoveryDecisionInput): CommitResult;
  markReconcileRequired(f: AttemptFence, reason: ReconcileReason): CommitResult;
  recoverAttempt(f: AttemptFence, evidence: RecoveryEvidence): CommitResult;
  retryAttempt(f: AttemptFence, decision: RecoveryDecisionInput,
    safeResources: ResourceCheckRef[]): CommitResult;
  appendEvent(f: SessionFence | AttemptFence, event: EventInput): AgentEvent;
  patchSession(f: SessionFence, patch: SessionExecutionPatch): Session;
  createSession(session: Session): Session;
  replaceSessionRun(f: SessionFence, newRunId: string, safeResources: ResourceCheckRef[]): Session;
}
```

这些是同步短事务接口，不在内部 await 网络、OS 或 driver。SessionFence 适用于无任务的资源、会话状态和带外事件；AttemptFence 另外验证 Task 当前指向、Attempt/runId、expectedRevision 与所属控制代际。recoverAttempt 由新合法 Runtime claim 发起，并在事务中换绑恢复控制者。replay 命令先验当前数据库/Session 权限，再核对已存操作身份与载荷；完全相同的 submissionId/settlementId/decisionId 重投返回原事实，不因调用者持有上次 revision 而重复写入。不同载荷冲突，非重投才检查 expectedRevision。

命令前置与结果固定如下：

- acceptTask 校验来源身份、Session 未归档及输入完整，保存 Task、请求、快照、queuePosition 和接受 task 事件；不创建 Attempt。资源阻塞不拒绝接收，但返回具体 blocker。
- claimNext 先核对 Session 资源可用于该动作、无活动槽、无历史歧义 blocker，再按持久队列领取；新 Task 创建 preparing Attempt，suspended 恢复原 Attempt。事务同时更新 Task、Session 和 task/status 事件。driver 创建不在此事务内。
- promoteQueued 只接受同 Session 的 queued/no-Attempt 或 suspended/not_submitted，按 operationId/actor/载荷幂等地分配前方 queuePosition、递增 Task revision 并保存队列事件；任务已被领取则冲突，不作用于活动任务。operationId 重投返回原结果，不再次提升。acceptTask(mode=interrupt) 与 promoteQueued 同时保存 QueueAction，详见下文；重投不会新建中断授权。
- SubmissionIntent 包含稳定 submissionId、最终 inputDigest、resourceRefs、可选 DriverTurnRecovery、提交控制者与冻结授权依据引用。preparing/not_submitted 才能进入 active/intent_recorded。写意图失败时不得调用 driver。
- SubmissionReceipt 为 `{ submissionId, kind: 'provider_accepted', provider, receiptRef, digest }`，只能保存可验证对端接受证据。本地 stdin callback、ACP ensureSession 和 PTY cursor 不符合；这些驱动可保持 intent_recorded 直到完整结果结算。
- SettlementEvidence 为完整驱动结果、确定未提交的准备错误/取消，或明确人工核对决定的判别联合。驱动结果必须关联同 Attempt 的完整输出与 stopReason；未知超时不能选 failed。每次结算原子写 Attempt/outcome、Task、Session 的执行状态及 task/status/completed 等事件；只 patch 状态字段，不覆盖标题、配置或较新的 Session 内容。
- suspendUnsubmitted 只接受 preparing/not_submitted，保留接受快照与队列位置。cancelQueued 只接受 queued、没有 Attempt 或 suspended/not_submitted，记录操作者和决定；不取消别的活动 Attempt。
- markReconcileRequired 保存原因与原提交阶段，不清资源。RecoveryEvidence 是分支联合：unsubmitted_preparation 带旧 Attempt revision 与安全资源观测，确认仍 preparing/not_submitted 后换绑新控制者并置 suspended，Task 回 queued；原 Task/Attempt/runId 不变。original_turn 带原 submissionId、identity/turn/cursor 和资源观测版本，验证后换绑并沿用原轮次附着；无法附着时保持待核对。两者都要求当前合法数据库 claim，不能由旧 claim 修改。
- retryAttempt 原子校验当前 Attempt/decision、资源观测与版本、旧结果可重试性，再结算未知旧尝试并创建 suspended 新尝试、更新 Task 和队列事件；decision 明确允许重复外部效果的风险，不冒充退出证据。
- replaceSessionRun 必须无活动槽、无 suspended Attempt、没有资源或历史歧义 blocker；否则报 SESSION_PENDING_ATTEMPTS，调用方先明确取消尚未提交的工作再 restart，不能悄悄改 Attempt.runId。归档及工作区释放走同一资源条件。配置/标题修改不改变 runId；停止后不能用任意 sessions.save 整行覆盖规避条件。

QueueAction 保存 operationId、请求 Task、actor、queue/interrupt 意图、原目标 AttemptRef/runId、revision 及 pending/applied/blocked/obsolete。接受或提升的事务只捕获当时的活动 Attempt；无目标直接 applied，不可稍后选择另一个任务。Runtime 在提交后及启动恢复时履行 pending：再次校验同目标仍活动且当前拥有其资源，才 interrupt；目标已结算则 applied，资源/结果未知则 blocked，绝不打断后来的任务。中断请求返回不等于已执行完成；settleQueueAction 依据目标结算/观测保存状态与证据。同操作崩溃恢复可再次核验和请求中断原目标，不创建新任务或换目标。QueueOperationInput 为 operationId、actor 和 interrupt 布尔值；来源 mode=interrupt 的 operationId 由接受请求身份确定。该小表 task_queue_actions 只承担队列操作恢复，不是通用工作流引擎。

QueueAction 的创建只可 insert；accept 与 promote 共用操作身份冲突检查，来源或载荷不同即回滚，不能用 upsert 覆盖原目标。状态结算另走 revision CAS update。Session 执行 patch 中省略 error 表示保留，error:null 明确清除；换 run 成功时清除旧 error。普通 Session 保存仍保持原有配置字段“省略即保留”的语义，不能借此改执行状态。

read-only 查询不要求 Runtime claim：getTaskExecution(taskId) 返回 Task、currentAttempt、历史摘要及 blockers；getAttemptEvents(attemptId, window) 返回该次输出；getSessionResourceBlockers(sessionId) 聚合驱动、verification 和工作区恢复依据。按 taskId 查询默认当前 Attempt，响应包含明确 attemptId/settlementId；已固定结果的消费者必须按 AttemptRef 查询。

新表为 task_requests、task_attempts、task_queue_actions、driver_resources、recovery_decisions；Task 增 currentAttemptId/revision/digestVersion，events 增可空 taskId/attemptId/settlementId。资源观测与决策保留不可变依据，允许在自身表内 JSON 保存，不能只覆盖最后一句错误。索引约束请求唯一键、尝试序号、Session 活动槽、submissionId、settlementId 和决策 ID。未知旧 Task.status 保留原值在迁移证据里，运行投影置 reconcile_required。

Runtime 切换后，tasks.save/create/enqueue/promote 和 events.append 不再是独立执行写入口：兼容包装必须委托新命令，无法提供必要身份的执行修改报错。sessions.save 对已存在行仅允许非执行字段 patch，执行状态/runId/archive 走 bound execution。离线迁移使用明确内部入口；不得为让旧测试通过保留可在运行时绕过的任意 saveStatus。新增表的第一批 storage 单元尚不切换 Runtime，可暂保留旧运行路径；切换是一项完整整合改动。

## 资源记录与 Driver 接缝

公共 DriverContext、许可 scope、DriverSubmission、创建关闭与 native context 接口统一定义在 [驱动资源接线](driver-resource-integration-design.md)。此处保留账本基本约束，接口签名不再重复；实现按复核后的显式父链与 Runtime 私有 token 接入。

DriverFactory 增加必需 DriverContext。Runtime 在调用工厂前同步保存 Session/runId 根创建意图；工厂不得先创建环境文件/进程再登记。AgentDriver 增加无副作用 prepareSubmission(input) 返回冻结最终文本、摘要及恢复定位，send 接收该 DriverSubmission。prepareSubmission 不 spawn、不提交，必要的 session start 单独由 Session 资源许可覆盖。PTY 路由块/marker 在 prepareSubmission 中冻结；不能在 send 内再改文本。

resources 的方法是同步、可抛错的短事务。创建操作和单个物理资源都存 driver_resources，以 kind 和 parent 区分：工厂/SDK start 等操作先申请 operation 许可；每一次具体 spawn 前再申请独立 physical child creationId，落库成功才允许该次 spawn。一个 SDK operation 可以产生版本探针、主 Agent 和 fallback 等多个 child，不能共用一个可覆盖的 PID/identity 行。operation 自身没有物理 identityId，不能作为 ResourceRef；Attempt 通过实际 physical refs 和其父 operation 链查询完整 blocker。

ACPX 内存 creation token 映射到 operation ID；SDK 的每处具体 spawn 边界新增同步许可，spawned/creationFinished 携带该 child ID，operation 的 creationFinished 单独保存。父操作未结束时即使已知 children 全退出仍阻塞，结束后禁止再在该许可下创建；父结束不证明任何 child 已退出。spawn 已发生时，Adapter 必须先保留原 ChildProcess、挂好退出观察，再调用 spawned，child 只绑定一次 immutable identity；持久身份写失败进入阻塞和实际清理，不能因抛错丢掉 child。异步外层 Promise 结束不结束 SDK 内部创建许可。

DriverResource 保存 resourceId、物理 child 的 immutable identityId、Session/runId、parent、kind、创建控制者、创建阶段、非密钥定位与观测历史。创建阶段为 pending/created/not_created/unknown；观测为 live/gone/unknown，权限不足不是 gone。无 PID 的 pending 意图在创建完成后仍无法证明是否产生资源时保持 unknown。ResourceRef 引用 immutable identityId，CAS 使用单独 revision，不把 mutable revision 当资源身份。

第一批仓储单元保留崩溃前 pending 创建操作的 blocker。新数据库 claim 不能代替创建结束或资源退出证明。第三阶段在接通完整先登记后创建协议后，增加显式核对命令：仅对采用该协议的本地创建操作，在证明原创建者已退出后封闭创建许可；每个已登记物理 child 仍单独核验。remote、legacy 和 local_only 记录不能走这项推断，父许可封闭也不能把未知 child 改为 gone。

同 Attempt 的 send 调用一次。ACP 原“错误文本命中后 reset 再 sendTurn”路径必须删除该推断；只有 typed definitely_not_submitted 且证据覆盖此前所有提交操作时，才可在同一未提交许可下修复 session。已记意图而证明不足时保留待核对。附着失败不得隐式转新建。恢复旧 ACP 上下文也不得自动重发旧任务。

保留当前完成顺序：驱动提交操作与完整 stream 结束，Runtime 等待本轮事件持久化后才统一结算；不把首条 completed 当成全部输出已收齐。结算可先于不影响结果的资源收尾，后者继续由独立资源状态约束。正常顺序多轮可以复用本实例已持有并登记的健康资源。

平台核验分别处理原始 ChildProcess、进程组、tmux 和远端资源。Linux 使用原始对象或可核对的启动身份作观测；跨实例停止须有不可替换目标能力，单独检查启动身份后按 PID/pgid 发信号仍不够。PTY 原 owner/turn/cursor 与账本关联后才附着。macOS 必须补实际实现与实机验收，不用新 Adapter 的空集合清旧 blocker。ACPX 持久 session_options 仍仅 snake_case，真实 SDK/sessionKey 回归必须保留。

停止先撤销入站及执行 owner，等待已进入事实写入和真实退出核验。失败保留 Attempt/资源记录。daemon shutdown 先 PTY prepareForDaemonShutdown，再物理 stop，避免误杀应保留的原轮次。

## 原子事件与消费者

appendEvent 和所有状态命令在 SQLite 内以当前 MAX(sequence)+1 分配序号，沿用现有 (sessionId, sequence) 唯一约束，不重排历史。稳定 eventId 重投必须核对 session/type/归属和稳定 payload，不能吞掉不同内容。Attempt 的 sourceId 去重键包含 sessionId+attemptId+sourceId；Session 事件使用 sessionId+runId+sourceId。所有指令输出、工具和结果事件增加顶层 taskId/attemptId；旧 user text.data.taskId 保留兼容，settlementId 只在结算后生成的事件出现。

本地发布器消费已提交 events，提交返回后唤醒，并在进程存活时每秒补查有订阅的 Session。每个订阅维护 sequence 游标；投递成功才推进，单个订阅抛错不阻止其他订阅，下一次补查可重投，消费方按 ID/sequence 去重。查询/唤醒失败不能依赖用户重连或下一次任务才恢复。subscribe 保持现有取消函数形态，增加可选 afterSequence；默认在注册时以同步持久高水位开始，提供 cursor 时先回放再连上实时流，消除单独“先读历史再订阅”的缝隙。shutdown 停止新订阅并等已进入的发布操作，不为永久失败订阅无限阻塞资源关闭；事实仍在数据库。

| 消费者 | 本次 Runtime 切换必须一起改变 |
| --- | --- |
| WorkItem | WorkAttempt 首次领取后绑定 runtimeAttemptId，完成后保存 settlementId 和冻结输出；按 attemptId 收集，后续 user prompt 不污染。选定 Attempt 待核对立即 blocked，不走普通超时重试 |
| Automation | 同样绑定本次 Attempt/结算；未知结果阻塞推进，重发交付不能重发 Task |
| 飞书 live/coordinator/reconciler | 新状态显示“结果待核对”，任务订阅用持久游标补齐；不把它降成 running 或失败后重新派发 |
| Web/CLI/timeline | 显示原 Task 与各次 Attempt、提交阶段及安全 blocker；恢复操作携带 expectedRevision，旧卡片不能操作新 Attempt |
| 既有交付 | card mapping、WorkItem/Automation delivery 继续作为现交付依据，增加 attempt/settlement 关联；已交付的旧结果不重新建 pending |

工作流在 Task 被人工重试后也不跟随 currentAttempt：原 WorkAttempt 仍指向被选中的旧结果。若绑定时已错过领取，按该 WorkAttempt 的 Task 初次 Attempt 固定；不能默认取最新。历史已完成 WorkAttempt 的 output/digest 保留。历史未完成且无法确定输出边界时 blocked，不能猜测拼接。

网络 Delivery 在 P6 统一为 destination/action/attempt/settlement 身份与回执；本地 event log 不证明平台已发送。先保留现有交付恢复，后续迁移不能重复发送旧成功记录。

## 迁移与中间版本准入

schemaVersion 与 executionAuthority 分开。第一批 storage 单元仅建表/索引，并在隔离库调用转换做验收；正常旧运行路径继续以 legacy 为权威，不能预先生成生产 Attempt 快照。真正转换在旧写者停止、排他升级成立后执行：事务重读最终旧任务/事件/会话，写历史转换与 blockers，并将 executionAuthority 从 legacy 切为 ledger_v1。同事务失败整体回滚；完成后重复打开只读标记，不重复生成。新 Runtime 要求 ledger_v1 才运行，legacy 模式的执行写包装在 marker 切换后拒绝写；旧二进制不遵守 marker，仍必须离线切换排除。

旧数据迁移只在已批准的离线升级窗口运行；无登记旧 daemon 不在控制表中，不能在线推断已退出。当前开发仅使用隔离样本，不执行真实切换。

| 历史数据/入口 | 处理 |
| --- | --- |
| queued、输入完整 | 保持 queued，无 Attempt；资源安全后领取 |
| queued、缺冻结输入 | 保持 queued，加 INPUT_SNAPSHOT_UNVERIFIABLE blocker，禁止自动重新读材料补造 |
| running 或未知历史状态，Session 内只有一条 | 创建 legacy_unknown / reconcile_required Attempt，保存旧状态和 checkpoint，不自动 send |
| 同 Session 多条 running/未知状态 | 全部保存为 legacy_unresolved/legacy_unknown，各自关联原 Task；部分唯一槽索引排除这些行。Session 设置 LEGACY_MULTIPLE_EXECUTIONS blocker，不选择一条冒充真实活动轮次；逐条人工核对可结算，全部解除歧义且资源安全后才允许领取或换 run |
| completed/failed/interrupted/cancelled | 保留原 Task 终态；为结果查询建立确定性 legacy Attempt/settlement ID。只有确实有完成记录才记历史 completed；failed/interrupted 的提交阶段仍 legacy_unknown，不推断从未执行 |
| 所有旧 Session，含 no-task/idle/completed/failed/archived | 建 legacy unknown 根资源清单。只有已存在、可独立核验的证明才能解除，归档或 daemon 死亡均不证明 Agent 已退出 |

最终转换按 legacy 的 COALESCE(queue_position,0)、created_at、rowid 总顺序稳定重编号 queued，保留负数、NULL 和正数混合时的领取顺序。在同一事务内，有未结算历史 Attempt 的 Session 执行状态投影为 interrupted；保留其归档标记、配置、原错误和历史依据。没有未结算历史 Attempt 的 Session 保留原状态，不能全量改为 idle。

在资源 hooks 尚未全部接通的 Runtime 中间版本，本实例新建资源使用 durable local_only 创建记录并保留完整内存 owner，可继续正常多轮；重开后一律需要核对，不能自动清除记录。资源 ledger 未接通部分不能称 P0 完成。

旧 Session 资源未知时，阻止 start/reconnect/resume/replace、getTerminalDriver 的副作用附着、自动 drain、无任务自动归档和 workspace cleanup。已经接受的 queued 保留并显示 blocker。历史 active 或未知 Attempt 不能先新建同 key ACP Adapter 去“看看能否恢复”。原 PTY 只有 owner/turn/cursor 核验与新账本关联完成后才允许同 Attempt attach。Verification 与工作区已有证明继续各自保存，查询聚合 blocker，不复制竞争权威。

恢复 API 支持重新核验、附着原轮次、停止确认归属资源、人工确认结果和明确重试。RecoveryDecisionInput 含 decisionId、actor、expected Attempt/resource revisions、action 和 evidence 引用；自动 OS 观测与人工决定分别存储。资源未知时可记录结果确认，但仍不能执行重试或清理；终态与资源条件不能互相代替。

## 实施和验收

1. storage/shared 事务单元：实现以上类型、表、显式离线转换、claim 绑定与短事务命令；真实 SQLite 验证原子接受/唯一领取/结算事件和旧数据矩阵。默认只加 schema，保持 legacy marker，尚不切 Runtime，不宣布恢复能力可用。
2. Runtime 与消费者作为整合单元：所有接受、领取、提交、终态和 Session 执行写收口；接 Attempt 输出范围、持久发布器和上述资源中间阻断。恢复与正常 send 不保留两套权威。
3. 资源 hooks：工厂/JSONL/Pipe、ACPX 内部创建、PTY 原轮次依次接通，独立验证先登记后创建和强退恢复，保留已通过的轮次、退出及 shutdown 回归。
4. 恢复 API/Web/CLI 与交付关联，执行端到端崩溃矩阵。macOS、真实供应商和平台回执单列验证，未验证项不计完整产品完成。

必测：同键同/异载荷及 legacy 重投；缺省/冲突 actor 不扩大权限；preparing shutdown 和 claim 提交后 SIGKILL 均能沿用原 Attempt 仅一次提交；suspended 时 restart 明确拒绝；schema 添加后旧 Runtime 再完成任务、最终切换只转换最终事实；同 Session 多条历史 running 全部保留且阻塞；队列提升重投、保存中断意图后崩溃不打断新目标；未知→明确重试后两份分离输出且旧图结果不变；写意图/结算前后强退；完成已提交但广播失败且进程存活后自动补发；旧控制者/回调迟到；SDK 一次启动中探针/主 Agent/fallback 具有独立 child 身份、父未完成继续阻塞、晚到创建、创建记录失败、PID 绑定失败清理；旧资源未知和活资源不能替换；恢复中再次 shutdown；原 PTY 附着不重发及 ACP 保留上下文但未知活动轮次阻塞。

使用真实 SQLite、独立 Node 与本地真实驱动，以子进程收件日志、Attempt、稳定事件和交付次数核验。强退仅使用测试捕获的 ChildProcess 身份，不全机按名称 kill。外部平台与生产停止另需具体操作授权；本次代码和隔离测试不申请无关授权。
