# 执行查询、操作与用户恢复

状态：controller 草案，待独立复核和实现。已核对当前 app.ts 全文、service 的身份/授权接线、foundation-policy.ts、Runtime 的队列/中断/停止方法和仓储的恢复命令。底层执行账本不等于可用的产品入口；本单元负责让 Web、CLI 和后续平台回调操作同一份事实。

## 当前要接上的边界

HTTP send 尚未接收稳定请求键；cancel/promote/interrupt/stop/restart/archive 已做权限判断，但没有传完整执行操作者。legacy_unmanaged 的允许结果 source=integration，即使请求由安装者认证，也不能仅凭 decision.source 判断其身份。当前 API 只返回 Task 兼容投影，用户无法查询具体 Attempt、资源或恢复动作。

SSE 现有实现已先订阅再分批回放，并处理 drain、慢客户端与 sequence 去重。保留这些有效行为；接入持久 publisher 后不另建事件权威或无限缓存。飞书来源的固定入站 admission 和最终卡片消费由单独单元接线，不能只改公共 HTTP 就宣称所有入口幂等。

## 可信身份与稳定操作

BuildAppOptions 增加独立的 resolveExecutionActor(request) 接缝，由 service 使用现有 createInstallationPrincipalResolver 构造。只有真实解析结果才转换成 `{kind:'installation_owner',id:'installation_owner'}`；未解析到身份返回 ACTOR_REQUIRED。授权判断和身份解析均须成功，不能把 legacy_unmanaged、未配置 executionPolicy 或 HTTP body.actor 当作安装者证据。直接 buildApp 的测试显式注入自己的测试身份，无匿名 owner 默认值。

Web、管理 CLI 当前均为该安装者身份；未来平台入口由可信平台适配器提供完整 `{kind:'channel',appId,id}`。Runtime 的 cancelQueued/steerQueued/interrupt 接受 ExecutionActor，同时在读取边界兼容旧 string actor。已传结构化身份不拆成 id 后再从 sourceId 猜 App；旧字符串只能沿用已经可核验的原来源映射。所有持久 QueueAction 和取消/恢复决定保存完整 actor。pause 走同一固定中断目标；验证命令也从真实身份解析器取 actor，不能继续依赖 decision.source。

早期基线的真实内存 SQLite 反例确认：持有合法 Runtime claim 的调用者可把另一 App 的 channel actor 传入 cancelQueued、promoteQueued、人工 settleAttempt 或 retryAttempt，四者均接受；recordInterruptIntent 则正确拒绝 TASK_ACTOR_CONFLICT。证据在 `/tmp/dutydeck-full-product-20260914/execution-management-actor-probe.mts` 和同名 `.log`。该仓储范围缺口已由 controller 修复并整合，独立复核的148项联合测试及5项目标App反例通过；当前事务在缓存读回前核对原Session/接受请求的App。早期探针保留原样作为问题证据，不再描述当前实现。该检查不代替以下HTTP可信身份和P1当前角色授权；也未证明匿名HTTP或外部App可绕过上层认证。

仓储已在上述用户命令的同一事务中补齐一致的 actor 范围检查，放在操作去重读回之前：Lark actor 必须匹配 Session 的 App；WorkItem 必须匹配原已接受 request 的 App，缺原始身份不能猜测；普通本地 Session 不接受 channel actor。安装者使用既有固定身份。新管理接口拒绝 unspecified；原内部普通 Session 的匿名接收/提升/中断兼容契约保留。此检查只证明身份与目标范围一致，P1 的当前角色、事实、配置版本授权仍在其执行事务接缝实现，不能互相替代。

send 增加 requestId、可选逐 Task model/reasoningEffort/permissionMode，使用既有 namespace=runtime、key=web:<requestId> 的 TaskRequestV1，不新增仓储 namespace。公开输入不接收 sourcePayload、actor、accepted input 或 authorizationRefs。浏览器为一次用户发送生成 requestId，网络重投保持同一键、prompt、skills 与显式选项；用户再次发送建立新键。服务端先构造完整 request 并 lookupAcceptedTask，再准备材料和 dispatch，返回相同 Task。相同键但请求不同返回冲突，不能因重试重读当前缺省选项改变原接受事实。未传 requestId 的旧客户端仍可发送，由服务端生成新键，但不宣称跨 HTTP 重试幂等。

取消、提升和中断接收 operationId 与对应 expectedRevision，UI 从实际查询结果构造并在响应不明时重用。新增 interruptAttempt(sessionId, {taskId, attemptId, expectedRevision, operationId, actor}) 绑定原尝试；旧 interrupt 仅给尚未迁移的内部调用保留兼容，不让新入口仅按 taskId 选择同 Task 的后续尝试。旧卡/旧页面操作若目标已经变化，返回原操作重放结果或明确冲突，绝不改绑新 Attempt。stop/restart/archive 传当前真实 actor；缺参兼容行为仅保留给 Runtime 内部既有 API，不在新 HTTP 入口静默丢身份。

## 查询与公开投影

增加 `GET /api/sessions/:sessionId/tasks/:taskId/execution`，在当前 task.view_result 授权下返回 PublicTaskExecution。先核对 Task 属于路径 Session；不存在和跨 Session 都不能借错误内容泄漏别的任务。

公开对象包含现有 PublicTaskRecord、各 Attempt 的 id/number/runId/revision/state/submissionState/outcome/settlementId/创建和最后变更时间、可展示的 reconcile code、blocker 和动作可用性。资源只给 resourceId/revision/kind/stage/当前 observationId/state，以及安全性与可恢复性说明。controller/access identity、原生 locator、冻结 request/sourcePayload、执行权限快照、工具凭据和未经处理的原始诊断不随投影返回。详细输出继续从对应 Attempt 的有界事件窗口或已验证结果读取，不拼当前 Session 的全部文本。

配置在途/未知也进入查询 blocker，读取 DriverConfigurationLedger 的实际持久记录，只给状态与说明。不能因为没有活动 Task 或物理资源已 gone 就把配置 blocker 省略。动作可用性由当前资源、原输入、Task/Attempt 状态与权限计算，点击时仍完整复核，不把页面缓存当许可。

查询不触发 driver factory、resume、OS kill、目录准备或隐式状态修复。新增 Attempt 事件入口沿用整数游标和上限，先核对 Attempt 属于路径 Task/Session；不向浏览器返回另一个 Task 的 sourcePayload。

## 结果核对与明确重试

新增 Runtime 的有界管理方法，内部调用现有 bound execution，HTTP/CLI 不直接取得数据库 claim 或 bound 对象。结果确认接口固定 taskId/attemptId、decisionId、expectedRevision、所选 outcome 和用户说明；当前操作者由可信边界补入，说明作为明确人工证据保存。客户端不得提交 resource observed=gone 或更换 native identity。

结果确认仅用于 reconcile_required/legacy_unresolved 的原尝试，允许在资源仍未知时确认结果，但资源 blocker 原样保留。正在正常由当前 Runtime 执行的 Attempt 先走停止/核对，不直接人工结算并让原事件继续写。已结算旧决定的相同 decisionId 重投返回原事实；不同内容冲突，不能重写结算。手动确认不伪造 driver_result 或供应商回执，输出仍按真实 settlement 边界冻结。

明确重试使用现有 retryAttempt：原输入必须为可验证 V2；原结果可重试；实际资源满足退出证明；当前用户明确确认允许重复外部效果。未决旧 Attempt 以 unknown 结算，新 Attempt number+1 进入 suspended/queued，由正常 drain 领取；管理接口绝不直接 send。即使重复确认 HTTP 返回丢失，也只能创建这一新 Attempt。已完成任务需要再次执行时发送新 Task；旧 WorkItem/Schedule 的固定 Attempt 结果不跟随新尝试。

资源重新核验、停止已确认归属资源和附着原轮次分别调用后续物理 hooks 的受支持实现。没有该执行器的证明能力时，API 返回对应 blocker 和可解释状态，禁止“清空阻塞”按钮或凭用户勾选把 unknown 改 gone。ACP 原配置恢复、新建上下文、原任务结果核对为三个明确动作，遵循 [原生恢复契约](acp-native-context-design.md)。这些物理动作未接通前不能把本单元中间查询页算最终恢复能力交付。

所有决定由同一事务写状态与事件，提交后只 wake publisher。通知失败不改变结果；恢复时的授权、配置或资源冲突保留原事实并给出具体原因。API 返回最新公开投影，不能把一次旧幂等命令缓存的 Task 投影冒充当前 Task 状态。

人工确认增加明确的 `run.confirm_result` PolicyAction；按目标 Task 的操作范围授权，不能只凭 task.view_result 授予改结果资格。明确重试沿用 run.retry。确认与重试不通过 active()/reconnect 取得 driver：使用当前数据库 claim 和独立短管理序列读取原 Session/Attempt，允许对已停止会话核对未知结果；正常仍由本地执行中的尝试不得人工结算。恢复决定的 resourceChecks 由服务读取真实记录生成，公开请求只提交目标、revision、稳定 decisionId、说明及重复效果确认。

幂等重投须先让既有事务命令识别原决定，再对首次执行做状态、版本、资源和配置检查。明确重试已产生下一次 Attempt 后，旧请求重放仍返回原决定及最新公开投影，不因新 Attempt 的活动资源或旧 revision 改变而制造第二次重试。当前 actor/目标范围与权限每次都重新验证。实现若需要在命令内部补入配置阻塞检查，应复用既有命令事务，不能在 Runtime 外先判断当前状态后把合法旧重投拒绝掉。

## SSE 与界面接线

带游标的连接把 afterSequence 交给持久 publisher，保持按实际 sequence 去重与有界 socket 队列。首次连接仍显示最近 200 条；窗口读取与订阅之间以该窗口实际最后 sequence 续接，空窗口从 0 续接，确保窗口与持续流不留空档。若事件超过窗口，也不要求首次页面渲染全部历史；向前翻页保持现有语义。

界面在 Task 下展示各次尝试及其确定/待核对结果，资源阻塞和配置未知分别说明。操作请求携带用户看到的引用和 revision，409 后刷新并展示变更原因；不自动生成另一个 operationId 再试。操作成功但卡片更新失败时重新查询同一 Task/Attempt。浏览器断线重连和慢客户端恢复继续使用最后实际处理的 sequence。

管理 CLI 通过运行中的本地 API 执行同一操作和身份检查；离线 database 子命令只负责检查/权威升级，不能离线另建执行器或越过 Runtime 写恢复结果。

## 验收

- 真实 HTTP + SQLite + 本地驱动：发送接受后响应丢失，同 requestId 重投保持一次材料读取、一个 Task、一次供应商收件；变 prompt/skills/options/actor 的同键冲突。
- 安装者认证在 legacy_unmanaged 场景下仍正确传入，伪造 body actor 无效；平台 App 不同的取消/中断拒绝。缺身份不匿名提权。
- 固定中断目标后新 Attempt 出现，重放旧操作不干扰新尝试；队列取消/提升的版本冲突和同操作响应丢失均有真实事务断言。
- 手工确认 unknown 不清资源；明确重试只创建一次新 Attempt，旧输出不变；V1 输入、不可核验资源和配置未知没有自动重发。
- 公共查询和错误不透出私有请求、权限或 locator；越界 Task/Attempt 请求不能读到输出。查询本身零 factory/零 send。
- SSE 窗口与订阅交错、丢 wake、超过 200/1000 条、socket drain、重连/关闭均有实际 HTTP 流回归。
- Web 操作旅程、CLI 黑盒、源码构建/类型和对应测试通过，再完成独立复核。后续物理恢复与飞书入口另有联合 gate，不使用 mock 代替最终真实旅程。
