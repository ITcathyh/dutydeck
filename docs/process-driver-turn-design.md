# JSONL/Pipe 轮次完成契约

属于 P0 的真实驱动接缝，设计已通过独立复核，尚未实现。生命周期单元冻结后由 ccflash 实现；保持 ACP、PTY CLI 和 legacy PTY 的现有协议。

## 已复现的问题

当前 JSONL/Pipe 的 send 只等待启动并写 stdin，Runtime 随即结算任务。使用项目现有 `tests/fixtures/jsonl-agent.mjs`、真实 Runtime 和 SQLite，两个协议都先返回并保存 failed，Agent 随后发送 thinking、工具输出、最终文本和 completed 也无法纠正终态。现有 transport 测试另行等待 completed，所以未能发现这个接缝。

复现脚本在本轮临时证据目录 `runtime-jsonl-probe.mts`，没有外部请求，实际子进程已回收。最终交付必须将反例转成仓库中的集成回归。

## 完整轮次与进程分别管理

send 返回的 Promise 表示本轮结束。它只能在 stdin 写入成功且收到明确的归一化 completed 后成功结束；该轮事件先交给 Runtime，再完成 Promise，使 Runtime 的 flush 能覆盖全部结果。一次输出文本、write callback、进程仍存活或空闲超时均不能代替 completed。done/result 等兼容名称沿用现有 normalizer，不新建另一套事件解析器。Pipe 维持现有 JSON 行兼容协议，不推断任意纯文本程序的完成边界。

同一实例最多一个未收口轮次。并发 send 明确拒绝；正常顺序发送继续使用现有进程。轮次有独立对象身份，stdin 回调、超时、stdout 和收尾只操作自己捕获的轮次与进程，不能清掉后续轮次。没有活动轮次的输出不能作为下一轮结果；未知原始输出仍作为诊断保留。供应商必须把本轮全部结构化输出放在 completed 之前，无轮次标记的协议无法证明违反这一约定的跨轮输出归属。

对外失败与资源可复用分开。错误输出立即显示，但在明确 completed 或进程输出关闭之前继续保留该轮归属；不得收到 error 就释放执行槽，让随后迟到的 completed 完成下一轮。异常退出、写失败、stdio 流错误和 AgentConfig.timeout 都使本轮失败，并观察仍在进行的回调和输出。ChildProcess 的 error 不能替代 stdin Writable 的 error 处理；真实 EPIPE 会同时触发 write callback 和 stream error。

timeout 等导致 send 提前拒绝时，先关闭旧轮向 Runtime 的事件投递，再拒绝 Promise；其余旧输出只在内部消费以完成边界判定和资源核验。Runtime 可能已创建下一排队尝试，即使其 send 还在等待旧资源，旧 error/completed 回调仍会取得新的 attempt 身份，因此不能仅靠 transport 内部 turn ID 隔离。正常 error 继续等待 completed/输出关闭再结算，不采用提前拒绝策略。

## 中断、超时与停止

interrupt 先对原轮次发中断信号，等待它的明确结束边界；信号发送成功不表示本轮已经结束。若进程不响应，在有界宽限期后收口该进程组。超时同样撤销该轮并启动资源收口，向调用者报告超时后，新的 send 仍须等待旧轮的实际尾声或旧进程组退出证明。不能仅给旧输出换一个本地 turn ID 就继续复用仍在输出的进程。

内部失败回收与公开 stop 区分：正常完成或可确认的中断可以继续当前进程；必须终止进程时，确认其所有受管资源结束后才允许该实例重新启动。JSONL/Pipe 本身没有通用持久上下文协议，进程重建不能宣称保留供应商会话上下文。无法确认退出时保持明确阻塞，让用户核对资源，不能偷偷创建第二组进程。

内部回收或已结束旧进程的迟到 onExit 也不能作为当前实例不可恢复退出投递给 Runtime。Runtime 的非零退出回调会改写当前 Session 并可能取消后续队列；本轮失败通过所属 send 报告，只有影响当前实例的未处理退出才走实例退出通知。原进程对象的退出仍必须被生命周期核验观察，不能为了屏蔽通知而遗漏资源回收。

公开 stop 仍永久撤销实例，调用者不能通过 send/start/resume 复活它；并发 stop 共享完整收尾。本单元复用生命周期单元的真实进程组核验、迟到启动回收和实例回调隔离，不能为使轮次测试通过而削弱这些保证。

## 验收与边界

使用受控的真实 Node 子进程和 SQLite，覆盖以下行为：

1. 暂停在已收到提示词、尚未发 completed：send 和 Runtime 任务都保持运行；释放后持久任务为 completed，最终文本对应本轮。
2. 同一进程连续两轮及 Runtime 连续排队至少三轮，每条提示词只提交一次、结果分别归属对应任务；并发直接 send 拒绝。
3. thinking/工具/最终文本/completed 在同一 stdout chunk，以及末条无换行但明确结束后正常关输出；不能因 exit 比 stdout close 先到而漏掉最终结果。
4. error 后迟到 completed、无 completed 的退出、真实 EPIPE、超时后迟到输出，都不完成下一轮；不出现未处理 Promise 或 EventEmitter 错误。
5. SIGINT 正常结束可继续；忽略 SIGINT 的进程经回收后才能启动替代。父进程退出但同组子进程存活时不得开放替代。
6. stop 与 pending start/send、写回调、超时收尾交错，停止后的所有新操作拒绝，重复停止共享结果。测试失败也回收本测试创建的精确子进程。
7. 第一轮 timeout 已返回、下一 Runtime 任务已建立但尚未写 stdin 时，旧 error/completed 不改写下一任务；内部回收的旧进程非零退出也不清空队列。核验后新提示词只提交一次；在等待期间公开 stop 则不再创建进程或提交提示词。

隔离单元测试和真实 Runtime 集成测试都通过后，才修订用户驱动契约文档。真实供应商、脱离进程组的任意后代及非 POSIX 平台仍按各自支持矩阵验收，不由本地 Node fixture 代替。
