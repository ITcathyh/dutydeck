# 驱动资源登记与原实例恢复

状态：已完成独立协议复核，下文纳入五组必要修订，实施前核对最终类型。与 [Task/Attempt 设计](task-attempt-design.md) 的资源章节共同使用；本稿补当前实现接线和创建操作的边界，不宣布物理恢复已完成。

## 已核对的实现

Runtime 的 LocalDriverLedger 在 factory 前建立 operation 和 local_only 两行，保留原 AgentDriver 后才写 identity，start 尾声结束才完成创建。stop 等待 driverOperations 和 isStopped 后登记 gone。这能约束本实例；重开后的 local_only 没有足够的原生定位证据。

仓储已有 beforeCreate/spawned/creationFinished/observed 短事务，parent 必须为同 Session/run/controller 的 pending operation。资源 identity 不可替换，observation 使用独立 revision；原创建 controller 与恢复 holder 分开。新 controller 可以提交实际观测，但不能冒充旧 controller 完成创建许可。

ACPX 私有补丁当前提供 SDK operation 的 creation-started/finished，以及具体 child 的 spawned 通知。Adapter 保留 ChildProcess 和 SDK 创建尾声；每次具体 spawn 前的独立持久许可尚未接入。JSONL/Pipe 保留原子进程与进程组；出生事件之前仍需接登记失败分支。RawPty 和 SessionBackend 的 spawn/kill 合约不足以说明物理退出。

已完整检查 TmuxBackend：创建并写入 owner marker，保存 turn_id/first_prompt_sent，恢复仅 attach 既有 owner 匹配的 Session；capture 会另外启动 tail 和 pipe-pane。当前 owner 按 Dutydeck Session 固定，不能区分同名会话被删除后重建的不同实例；getPid 只有当前 pane PID。probe 的 missing/unknown 分类和屏幕捕获顺序需要保留，进程 kill/清理 Promise 仍须补实际退出证据。process-identity 已有 Linux host/boot/namespace/start 和 Darwin 保守观察；这是数据库进程证明，不等于进程组或 tmux 身份证明。

上述结论来自当前源码；本稿的新增物理协议尚未经过实际崩溃验收。

## 公共接缝与操作范围

DriverFactory 的必需 DriverContext 由 Runtime 构造，固定 Session/run、create/attach 模式、工厂创建许可及资源 hooks。Driver 不取得仓储、claim 或可任意改 Session 的接口。attach 输入只能来自已存原身份与已验证的恢复决定，HTTP body 不能直接提供 locator。

工厂的 rootResourceId 是本次 factory/start 的创建 operation，不是永远保持 pending 的 Session 容器。完成该 operation 后禁止继续往其下增加 child。后续 send、原上下文 load、配置 RPC 或输出 capture 如果可能创建资源，必须在其实际外部步骤前申请新的 operation；其下每次 spawn 另有独立 child。当前仓储 beforeCreate 已允许省略 parent；公共 driver hooks 应沿用 operation 根许可，有 parent 的调用仍遵守现有 pending 检查。Task/Attempt 设计已改为引用本稿，公共类型只保留一份。

SDK operation 的许可覆盖全部内部异步步骤，包括能力/版本探针、fallback 和 host terminal。具体 spawn 另取 child 许可，返回的 token 必须随 spawned 和 creationFinished 回传；不能用 SDK operation ID 反复覆盖多个 PID。operation 完成以 SDK 内部所有可能创建步骤已经结束为准，不能使用外层 Promise.race 的返回时间。取消后拒绝新执行许可，已登记原资源的受限 cleanup 许可仍可用于观测和停止；已经得到原 ChildProcess 的实例继续负责观察和清理。

同步 hook 可能抛错。beforeCreate 失败必须零 spawn；许可到 spawn 之间若存在 await，spawn 前再次核对原许可/owner，撤销则结束为 not_created；spawn 已发生后，先保存原对象并挂退出监听，再调用持久 identity hook。后者失败时仍保留原对象并实际停止，禁止抛错后丢失资源或补建替代实例。已出生但身份未存成功的行保持 pending/unknown，不能因创建者退出自动写 not_created。

Runtime 的 Owner 撤销只阻止新的执行副作用；原资源的退出观察与清理尾声仍在同一合法数据库 claim 下完成。创建许可检查显式绑定原 driver generation，不能依靠会跨公共监听器传播的 AsyncLocalStorage。注销或替换实例之后，迟到创建通知只能处理原资源，不能改新 driver。

## 物理身份与可证明范围

process 定位保存非密钥的 host/boot/namespace、PID 和启动身份；进程组另外保存原组与领进程的创建依据。纯 PID、PID 文件和 signal 0 成功不授权发送终止信号。原 ChildProcess 的真实 exit 可以证明该 child，不能证明整组后代。没有足够组归属证据时保留 unknown；本次不声称可以容纳任意自行脱离组的外部程序。

tmux 身份至少关联选定 socket/server 实例、session ID、pane ID、创建时的唯一 Dutydeck resource marker 和 pane 启动身份；Session 名只用来定位。每个原轮次的 turn ID 与 transcript cursor 继续独立核对。只读 probe 不创建 tmux、capture、tail 或 Agent；attach 在核对原 identity 后，先登记本次新增 capture 资源再启动。原 Session 已丢失时，恢复失败且零 fresh/零 prompt；明确新建上下文产生新身份。

tmux kill 必须作用于已核对原实例的精确对象，不能核验 Session 名后再按同名目标无条件删除。原 pane 更换、server/socket 变化或 marker 不同保持冲突。停止结果区分 tmux 原会话、pane 进程及本机 tail/capture；detach 仅证明本机监听停止，不把仍运行的原轮次标 gone。实际 tmux 支持的原子目标核验接缝在协议复核与本地 fixture 中确认。

本机 tmux 3.3a 的独立 socket 探针已验证 `if-shell -F -t` 可在服务端核对 server/session/pane 与唯一资源 marker 后选择 kill-session；错误 marker 保留原会话，匹配时删除目标，同名重建后旧身份不会删除新会话。实际重建复用了 session ID 和 pane ID，说明这两个 ID 也不能单独跨 server 识别。证据为 `/tmp/dutydeck-full-product-20260914/tmux-resource-identity-probe.mts` 和 `.log`。这仅证明三个本地功能分支，尚未证明并发命令队列的原子性，也未证明 pane 后代全部退出；协议复核仍须处理这两项边界。

ACP 上下文身份与物理 child 分开：进程退出不证明远端 session/config 消失，恢复必须遵循 [ACP 原上下文设计](acp-native-context-design.md)。JSONL/Pipe 的每次替代进程是新的 identity；同一 Attempt 已记提交意图后不因 replacement 自动 resend。

## 提交与恢复

prepareSubmission 纯计算最终文本、inputDigest、原轮次恢复定位和实际 physical ResourceRef；不 spawn、不发送、不更新 transcript。所有路由前缀和 marker 在此冻结，send 不再偷偷改变 Runtime 保存的文本。Runtime 先保存 SubmissionIntent，再调用一次 send(DriverSubmission)；send 如需创建附属资源，使用新的受控许可，不能把未结束的创建许可绕过仓储 submission 检查。

供应商接受回执由明确 onAccepted 接入既有 markSubmitted，绑定 submissionId；本地 write callback、ensure 和终端缓冲区成功仍不作为对端接受。结果结算继续等待完整驱动流和 Runtime 持久事件尾声，资源收尾独立阻止下一轮或工作区释放。

重启后先只读列出原资源并执行受支持的原身份 probe，观察完成后按旧 revision 短事务提交；OS 查询不能放进 SQLite 写事务。当前 beforeCreate 记录没有可核验的完整创建协议证据，旧 pending/local_only/legacy 不能推断完成。新增“封闭旧创建许可”命令只适用于明确登记了新协议及原创建进程身份的 operation，且原创建者已被证明退出；它不完成未知 physical child，也不把其改 gone。具体证明与数据库 access 固定引用见下文，禁止调用者自报 creatorDead=true。

创建来源由受控协议接入路径确定，不能由普通 beforeCreate 自报。新 operation 的 creationProvenance 在已验证 claim 的事务中从 OpenControl 复制协议版本、数据库 entity、原 controller 与该 access 打开时的 Node ProcessIdentity。保留不可变副本，因为 dutydeck_access 在关闭或回收时删除旧行；远端创建者不能写成本机 Node。

`closeAbandonedCreation(sessionFence, resourceId, expectedRevision)` 在事务外读取和观察原身份，再在短写事务验证当前 claim、entity、Session/run、原 provenance、revision、协议和 operation kind。仅 dead 可追加不可变 creationClosure：固定 closureId、原 provenance 摘要、dead 证据、验证的 resource revision、当前验证 controller 和时间。原 controller/holder/stage/identity 不改，重放返回原证据。operation-safe 为正常完成或有有效 closure；parent-open 为 pending、无 closure 且仍属原合法创建 owner；两个谓词一起修改。child pending/unknown 不变，内存库/旧协议/缺证明不自动恢复。

真实进程测试覆盖：许可落库但无 child 时强退可封闭父 operation；已有 child 许可但身份未存时强退，封闭父后 child 仍阻塞；原进程存活、PID 复用、不同 namespace、旧 access 删除、查询后 revision/claim 改变及迟到旧通知。旧 Node 死亡只证明其不能再发起受控步骤，已经交给 tmux server/Agent 的步骤由预先登记的 child 独立阻塞。

资源已可核验不自动重发 Task。unsubmitted 使用原准备恢复；已提交可附着时沿用原 Attempt/submission/turn；其余保持待核对并通过管理入口解释和处理。人工确认结果不清物理 blocker。

## 许可作用域与提交顺序

公共 DriverContext 固定 Session/run、driverInstanceId、create/attach 模式、原 refs、factory operation token 和 hooks。OperationPermit/ChildPermit 是 Runtime 私有 token，显式对应持久行和父链；driver 不能拼一个 resourceId 冒充许可。生命周期、submission、cleanup、strict-context-restore 四种 scope 由 Runtime 发放，SDK 回调贯穿原 token，禁止 currentOperation 可变字段或 ALS 代替父链。

factory/start 和配置准备的嵌套 SDK operation 继承其父许可。提交后的附属创建固定 taskId/attemptId/submissionId/driverInstanceId，允许同一未撤销 scope 的 sibling pending operation；别的 Attempt/driver、未知物理资源、旧未决创建和外部 blocker 仍拒绝。这项例外不用于 claimNext、markSubmissionPending、换 driver/run 或工作区清理。cleanup 只允许针对原登记资源的固定 ps/tmux/终止辅助操作，Task 撤销后可继续，claim 释放后不可新增；不能借它创建 Agent/native context 或 prompt。

严格 start/load、必要准备及其创建尾声先结束，再纯计算最终提交。DriverSubmission 固定 Task/Attempt/submission、final prompt、inputDigest、physical refs、可选 native ref/proof、recovery cursor 和 onAccepted。摘要统一用当前 Runtime 的 canonical JSON SHA-256 `digest({prompt:finalPrompt, executionOptions})`。PTY 的实际 flush 先在受控准备步骤结束，纯计算只读取稳定游标，分配的 turn ID 对同一 submission 保持稳定。提交后新 terminal 等附属行通过固定 scope/父链查询，不回写已冻结 SubmissionIntent。

## 原生上下文使用同一资源表

ACP session/new 前先在 factory operation 下持久登记 `kind=remote, purpose=acp_native_context` 的 pending child，固定 nativeCreationId、context generation、Session/执行域和预期 sessionKey/agent/command/cwd。new 仅发一次。SDK 首次保存原 record 时记录同一 `dutydeck_native_creation_id` 和实际 new 响应 identity/创建默认证据；随后仓储按原许可把 identity、created 与 Session 私有选择指针一起 CAS，允许后续配置 RPC/prompt。文件与 SQLite 之间没有跨库事务：任一窗口崩溃留下 pending/unknown，只有精确关联的原 record 证据可以补齐，缺证据不能重新 new。

原生上下文行是 identity 权威，Session 只保存选择引用；不另存第二份可改身份。`NativeContextRef={resourceId,identityId,originRunId}` 与 physical ResourceRef 分开。选择指针带 selectionRevision 和 selectionRunId。known context 的存续不要求在 stop/归档/换 run 时伪造 gone；pending/unknown 的创建及未知配置继续阻止新提交。原资源 origin run/controller 不改，普通物理引用仍严格限当前 run。

- `selectNativeContext(currentFence, expectedSelectionRevision, contextRef, decision)` 验证同 Session、精确 purpose/identity/originRun 和稳定决定；首次 new 由创建确认命令原子选择，另选上下文必须明确决定。
- `beginNativeRestore(currentFence, contextRef, expectedResourceRevision, expectedSelectionRevision, driverInstanceId)` 只为当前选择发受限恢复 operation，新连接 child 记当前 run；旧执行物理资源与创建尾声必须安全。配置未知时仅授配置修复 scope。
- `confirmNativeContextRestore(..., restoreOperationId, proof)` 验证上述固定引用及当前 claim/driver，追加当前 run 的 context binding/proof，必要时更新 holder；不改 Task/Attempt/submission/outcome，不伪造 original_turn attached=true。
- replaceSessionRun 保持原活动槽/队列/物理门禁，已知选择引用在同一事务带到新 selectionRunId；原 native 行和未知配置保留。SubmissionIntent 使用独立 nativeContextRef/contextProofId，提交时核对当前选择、本次 driver/run/claim 及配置证据。

显式新上下文也保留旧未知尝试与旧 native 行，不能清物理 blocker。旧未知 native 创建的替换须记录明确决定并证明原创建尾声及所有执行物理资源已安全；其原协议必须保证确认 identity 前零 prompt。该决定只将指定旧创建移出当前选择候选，保留未决诊断，不当作 remote gone。已提交旧 Attempt 仍须独立核对，不能借替换自动重发。

ACP strict restore 只能证明原上下文可用，不能证明附着原进行中 prompt；idle Session 也没有可供恢复的 Attempt。原活动轮次缺 attach 能力时继续 reconcile_required。完整 SDK record 保留及配置 ACK 顺序以 [ACP 设计](acp-native-context-design.md) 为准。

## 停止能力分开声明

能力分别声明 physical observe、持有原对象 stop、跨实例 identity-bound stop、native context restore、active turn attach、配置 ACK/default proof。Linux 新 controller 的 `/proc` 检查再 kill 仍有 PID 复用窗口；没有 pidfd/受控 supervisor 等不可替换定位的后端仅提供只读 probe，跨实例 stop 明确 unsupported/unknown。进程组后代不能仅靠 leader exit 或 pidfd 当全部退出。

tmux client、tail、server 创建的 pipe/cat 和 pane 分开登记。server 端创建结果未到前崩溃保留 pending，不能随 Node 的 closure 清除；共享 server 不能由单 Session 停掉。现服务端条件 kill 是待资格验证的候选，须用并发 pane replacement/respawn、server 和 marker 变更反例验证；没有不可替换目标证明时不授跨实例自动 kill，停止后的 probe 不能弥补误杀。普通适配单元不自行猜测这些能力。

## 划分和验收

独立复核的五组接缝按上述统一接口实施，由复杂协议单元实现 shared/Runtime/storage 的必要接缝与 ACPX spawn 边界。冻结这些类型后，JSONL/Pipe、RawPty、tmux/backend 的普通适配和测试交 CCFlash 分单完成，互不修改 Runtime 核心。ACP 原上下文与配置证明由同一协议设计约束，不能另建旁路。未接物理 hooks 的旧 driver 使用复杂单元提供的显式 local_only bridge 保持既有行为，不挂新协议 provenance、不声明可自动关闭旧创建。

实际故障矩阵覆盖：许可写失败零 spawn；spawn 后 identity 写失败仍持有并清理原 child；创建后 stop/关闭、迟到 spawn、SDK 多 child、父结束后再创建均正确阻断；强退后原资源重查、PID 复用、tmux 同名重建、未知查询和新 controller 不误接管。真实本地 JSONL/Pipe、AcpxAdapter/SDK 持久 sessionKey、tmux 与 PTY 验证原轮次不重发、完整输出和退出尾声。既有多轮、权限、终端屏幕、shutdown detach 与打包回归必须保持。

Linux 本地证明与其他平台/供应商验收分别记录。macOS 或远程后端缺少真实验收时明确标未验证；中间 local_only 回退不得计为资源恢复已交付。
