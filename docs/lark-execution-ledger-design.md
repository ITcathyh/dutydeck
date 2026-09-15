# 飞书入站与卡片接入执行账本

状态：controller 草案，待与管理接口、来源消费者一起独立复核。已读 task-inbox/reconciler/card-actions 全文、coordinator 的恢复/接收材料/派发/终态/取消重试链和 LarkRuntime、事件加载接口。本文尚未实施，不涉及真实飞书发送。

## 接收与原请求

当前 Inbox 保留首次原事件并 CAS 领取，材料也有持久快照；这些能力保留。新增严格版本化 admission，固定 namespace=lark、App、原 messageId、来源业务轮次、Session、ExecutionActor、prompt、skills、显式 options 和 sources。Task ID 由 executionTaskId 计算，来源 raw CAS 成功后再 dispatch。App 取经过当前 listener 验证的配置域，actor 取实际发送者；消息正文和 callback value 都不能提供可信 actor。

已保存 admission/taskId 的恢复先查 execution 接受事实，再取新配置、准备材料或启动上下文。查找是只读事实恢复；后续查询结果和交付仍检查当前权限。原 Task 已接受时只补齐原卡片、上下文水位及 inbox 映射，不重新下载附件、展开 Skill、拉聊天历史或执行空 @ 兜底。Task 尚未接受才继续原来首次准备流程，并再次检查 /new 的 epoch 及 Session 归属。

来源 request 和准备后的 agentPrompt 分开固定；同 key 重投必须保持完整 request，不能重读新的风险配置覆盖原接受输入。运行时当前权限仍在 prepare/submit 重新检查。缺发送者 App 域、记录不合法、映射冲突或既有请求不同，持久 blocked 并给出可解释回执，不把接收错误误报为执行失败再自动重投。

历史已有关联 Task 保留其原 ID 和输入证据，沿用 TaskAdmissionV1.legacy_partial 规则；不能只根据 prompt 相同和创建时间相近猜 Task。没有确切 ID 的旧未决卡片显示历史关联待核对，禁止自动补发最终结果。历史已送达消息保留，单卡历史收据不追发。

## 固定尝试、输出与待核对状态

初次来源绑定 number=1 Attempt；一次明确重试所创建的新卡则绑定重试命令返回的具体 Attempt。Inbox/卡片保存 runtimeTaskId、runtimeAttemptId、结算引用与最后消费的 sequence，不能跟随 Task.currentAttemptId 自动切换。实时事件同时匹配 Session/Task/Attempt，Session 级诊断不加入结果正文；权限和协作问答也绑定原 Attempt，旧问题不能回答给新尝试。

LarkRuntime 接入 Runtime 的执行查询、Attempt 事件窗口和持久游标订阅。恢复从已提交的 cursor 回放，正常流和补发使用同一消费路径；游标在本条状态/快照保存成功后推进。处理回放可以按 event ID/sequence 重投，平台消息回执另外保留，不能用事件已消费证明平台已送达。

新增 reconcile_required 展示状态，明确文案“结果待核对”。它不是 terminal completed/failed，也不能显示为“运行中”；不提供普通失败重试按钮。资源和配置 blocker 使用管理查询的安全投影，当前不支持的恢复动作不渲染成可点按钮。确认失败、取消排队、主动中断和未知结果各自保留真实语义，中断 RPC 返回不直接把卡片改成已中断。

确定终态先通过共用 readAttemptResult 固定原结算与精确文本摘要。过程卡按同一 Attempt 和 throughSequence 读取工具/思考窗口；最终消息正文用冻结结果，显示裁剪只影响过程展示。读取失败、结算边界缺失或摘要不匹配时保留待核对，禁止回退到有限内存缓冲并宣称结果完整。未关闭工具可以在过程卡说明，不能把权威 completed 改写为另一执行 outcome。

## 操作身份与重试

新卡 callback value 使用字符串字段携带不可变 card/Task/Attempt 引用、原 revision 和 operationId。Runtime 始终从可信 listener/operator 构造完整 `{kind:'channel',appId,id}`，再次检查当前权限和原目标；卡面按钮可用性只作展示。取消排队、固定 Attempt 中断和恢复决定接入 [执行管理接口](execution-management-design.md)，不再仅按 Task 或当前内存 turn 选择执行对象。

遗留卡没有 Attempt 引用时，只能从其原持久卡片绑定核对，不能把缺 turn 或缺 Attempt 解释为“当前轮”。无法确定目标则提示刷新到最新管理页。旧回调重放保持原 operationId，成功后返回原决定或最新查询；不会中断同一 Task 后来的 Attempt。原有他人操作确认仍保留，但不能替代 Runtime 的真实操作者与当前授权。

无输入变更的明确重试调用原 Task 的 retryAttempt，用户确认重复外部效果风险、资源已核验后创建新 Attempt；卡片更新失败只补同一个新 Attempt 的消息。若用户修改目标或追加材料，则是新的业务请求、新 admission 和新 Task。旧卡已交付结果保持，不能把同一 Inbox 的 event.sender 改成重试人而抹掉原接受者；重试操作者保存于独立恢复决定。

## 每次卡片与交付记录

当前 channel_mappings 对 `(channel, external_id)` 唯一，coordinator 每轮覆盖相同入站消息的 mapping；仅在 extra 加 Attempt 字段会继续覆盖旧轮次的待交付依据。实施前需固定每次卡片的独立持久记录和原消息到当前展示的索引。其身份至少包括 App、原 messageId、Task、Attempt、卡片用途；过程与结果消息分开记录。不能通过删除旧 mapping 解决唯一约束，也不能复制旧已 delivered 为 pending。

每条网络请求固定原目的地和幂等键，回执更新按原卡片记录 revision/Attempt/settlement/内容摘要 CAS。当前“重读 extra 相等后 save”之间仍可竞争，最终写必须由实际 CAS 完成。配置变化或权限撤销阻止新的交付，不改写已发生的回执。内容拒绝时保留原地降级、限流退避及不可更新过程卡的处理；不能因卡面失败重新执行任务。

平台 UUID 只提供有期限的去重。2026-09-15 读取的官方 [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) 和 [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply) 均规定同 UUID 在一小时内去重，长度最多 50；不同内容需要新 UUID。两份正文与响应样本已完整读取，原 JSON 快照保存在 `/tmp/dutydeck-full-product-20260914/lark-message-{create,reply}-official.json`。文档没有给出 reply/create 跨接口共享去重保证，不据此推导可以任意回退。

现有 sendLarkResult 捕获任意 reply 异常后立即调用 send，包含回执丢失和仍发送中的情况；必须收窄为已证实未交付、落点仍获授权的失败分支。超时、断连、230049 或成功但本地回执未保存均保留原请求身份与未知状态；只在实际去重期限内重试同一端点、目的地和不可变内容。期限过去不能把同一 UUID 当永久保证，也不按正文或时间相似猜已送达。支持精确回执核对，无法证明时提供明确的人工核对/再次发送动作，保存可能重复的确认；不重新执行 Task。

最终内容及平台请求体必须在首次网络提交前固定，避免重开后 Agent 改名、展示配置或计时变化使同一 UUID 对应不同内容。卡片超长转文件在这个准备边界决定，保存实际文件摘要和上传引用；不能每次重试重新计算形态。平台明确拒绝后的内容修订是同一 Delivery 下的新操作版本，不能以原 UUID 发送另一份正文。过程卡 PATCH 与最终消息各自记实际请求和回执；对消息更新的重放条件不能套用创建 UUID 的保证。

网关亦须接入操作的重放能力。已完整读取 api-gate.ts：当前所有 JSON 方法均按网络/5xx/瞬时码自动重试，没有区分读取和未带 UUID 的创建；230049 在实现注释中被误写为频控，官方含义为消息正在发送。使用真实 LarkCardService 与本地 fetch 故障探针，已复现 reply 回执丢失后两次 reply 再一次 create，以及无 UUID 的 send 被提交两次；证据为 `/tmp/dutydeck-full-product-20260914/lark-delivery-unknown-probe.mts` 及 `.log`。这证明本机请求行为，未实跑飞书，也不声称已经观察到平台重复消息。

交付执行器负责持久请求身份、期限和结果分类；网关只在当前操作明确可重放时执行网络重试，不能在外层记录一次操作、内层私自提交若干无身份写入。令牌等待和退避后还要复查当前授权与交付领取，关闭/撤销信号贯穿到实际 fetch；仅在队列入口授权不足以阻止等待期间撤销后的发送。已进入远端的操作保留可能完成的事实，不伪造取消成功。限流同时保留 App 总量与实际接收群/用户的范围，上传也经过相应平台预算；具体预算与媒体接口在 P6 实施时按官方契约和真实样本验收。

该记录与 P6 的 [统一 Delivery 草案](delivery-ledger-design.md) 共用同一权威；草案已定义每个意图和平台操作的两层记录。最终结构仍需和共享凭据/监听代际切换一起审查，不能先引入临时交付表，之后再迁成第二套产品语义。这部分尚未通过独立设计复核，未交实现。

## 验收

真实 SQLite 与本地驱动覆盖：接收成功响应丢失重开，零重复材料读取/零额外 prompt；source CAS 与卡片映射之间失败后补齐原关联；超过 200 条和并行 Session 的事件不截断或串结果。Attempt 1 unknown、Attempt 2 completed 时两张卡各持原引用，旧卡不被自动改成成功。

回调覆盖旧卡、中断与重试交错、跨 App 操作者、撤权、重复点击、落库成功后平台响应丢失；未知结果不能普通重试，明确重试只有一个新 Attempt。Inbox 及卡片 malformed/legacy 缺边界均保留可核对状态。已有长结果、限流、内容拒绝、话题原址、群 @、/new、问答/权限和已交付历史的回归断言保持。

本地协议和 stub 平台只验证本机控制流。真实飞书事件、卡片回调与交付回执的最终验收另行记录，未实跑不能标产品交付完成。
