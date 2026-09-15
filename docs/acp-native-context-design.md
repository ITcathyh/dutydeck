# ACP 原上下文与配置恢复

状态：独立复核已确认五组必要接缝，按驱动资源协议共同实施。当前 Runtime 核心遇到无法证明的复位会在提交前阻断；这不是完整恢复能力。本稿固定后续驱动单元要补的行为，不启动真实供应商。

## 本机固定版本的证据

已检查当前 AcpxAdapter 源码与私有 acpx 0.13.0 的实际 runtime.js/runtime.d.ts，不依据名字推断能力。

- Adapter.send 捕获包含 could not be resumed/resource not found 的错误后，写 reset_on_next_ensure、重新 ensure，再发同一 prompt。需要删除这一隐式重新执行路径；错误文本不证明原 prompt 没有产生效果。
- resetWhenScopedEnvironmentChanged 在群工具/relay/桥接环境变化时设置 reset_on_next_ensure。SDK 发现 reset、cwd 或 command 不匹配时不复用 record；没有 resumeSessionId 就调用 session/new。恢复时仅检查 sessionKey 存在仍不能保证原生上下文不变。
- SDK createOrLoadRuntimeSession 在明确提供 resumeSessionId 时只调用 session/resume 或 session/load，缺能力或不存在会失败；persistent turn 的 resumePolicy 是 same-session-only。这个协议分支可用于严格恢复，但现 Adapter 没有将调用者的原上下文身份传入。
- SDK getStatus 只读取持久 record 并组装 models/configOptions，没有发原生查询。它可以提供上次观察的选项信息，不能证明“配置未知”已经恢复。
- 已有真实本地 ACP 反例证明：Agent 将 model 改成 B 后返回错误，Adapter/Runtime 的旧快照仍是 A；物理 stop 后的 session/load 保留 B。原生会话存在和原生配置正确是两项不同证明。

定位：packages/acp-client/src/index.ts 的 sessionInput、resetWhenScopedEnvironmentChanged、ensureHandle、send、setModel/setReasoningEffort；固定 SDK dist/runtime.js 的 shouldReuseExistingRecord、createOrLoadRuntimeSession、ensureSession、getStatus。SDK 是本工作树的私有补丁副本，不修改共享安装。

## 驱动行为

首次创建和恢复必须由 Runtime 明确选择。首次创建只允许没有既有 native context 的新会话；恢复携带此前已持久的原生身份，不能用“记录缺失”自动改选创建。身份至少固定 sessionKey、acpxRecordId、backendSessionId、实际 agent/command 与 cwd；agentSessionId 如供应商提供则一并固定。模型/effort 是可变配置，不当作上下文身份。

原生身份在实际 session/new 或严格 resume/load 成功后，由驱动返回并在允许下一外部步骤前持久化；保存失败保留 pending/unknown 资源，不能再创建一个会话补救。恢复核对当前 record 与原身份；缺失、替换、App/执行域变化或无法证实同一上下文时返回明确 blocker。调用者需要新会话时走显式新上下文操作和新身份，不伪装成恢复成功。

显式 resumeSessionId 必须贯穿所有 ensure 分支，供应商拒绝 load/resume 后禁止 session/new 和 prompt。已有 record 的 reuse 快捷分支也必须验证原身份；ensure 返回本地 handle 不代表远端上下文已经核实，不能因此清除恢复 blocker。发送期间上下文再次消失时失败并保留原尝试核对，不自动重发。

群工具/relay token 等启动环境可在物理旧进程与全部尾声结束后刷新，但必须保持原 native context。不能继续用 reset 标志表达“更新环境”。若 SDK 的现有复用分支忽略新 sessionOptions，需要增加明确的恢复接缝；保留旧记录的会话历史和持久键校验，不用删 record 达到更新效果。所有持久键仍为 snake_case，vendor 环境继续走现有桥接文件。

配置未知与资源存活分别保存。恢复 model/effort 的依据只能是原生协议提供的当前配置，或向原上下文成功提交准确目标值并核实 ACK 所属操作；cached getStatus 不算。RPC 返回错误、ACK 丢失、来源不匹配或恢复过程中被撤销，未知状态继续保留。Runtime 仅在同一短提交内核对原配置操作 ID、driver/context 身份和目标快照后接受恢复证明。

缺省选项的复位值必须来自该上下文创建时实际返回的默认配置，或驱动明确支持的 reset 能力。不得把现在的 B 当成当初默认 A。首次创建时记录必要的默认配置证据；历史上下文没有该证据时，要求明确选择可验证的值或创建新上下文，不能默默使用旧值。逐 Task 配置仍保持 AcceptedTaskInputV2 的原快照，证明只说明驱动已应用它，不重写接受事实。

## SDK 接缝和记录保留

独立本地 ACP/持久 sessionKey 探针确认：原记录 messages=2；显式 resumeSessionId 的快速 reuse 不新建 child、不 load，也忽略新 env；reset 加原 ID load 后 new/load/prompt 总数为 1/1/1，但 messages 变成 0。现 createAndSaveRuntimeRecord 还在保存原 identity 前先发 requested model RPC。因此本次使用两个明确的 strict create/restore 入口，保留 SDK 旧 API 的外部兼容，不用 reset 实现环境刷新。

strict create 使用资源协议的 native pending 许可。真实 new 返回后先保存关联原 nativeCreationId 的 SDK record、原 identity 与未被 requested model 覆盖的创建默认证据，再经 Runtime 回调确认 SQLite identity/选择；成功后才允许任何配置 RPC/prompt。保存任一步失败保留原 handle/client 供收尾，禁止替代创建。精确 file record 证据可供崩溃后的 CAS 补齐；当前配置或同名 record 不可代替原 new 回执。

strict restore 必传 expected identity，核对 file record 的 key/recordId/nativeId/agent/command/cwd/作用域并真实连接 load/resume 原 ID。保留原 record 的 messages/title/eventLog/sequence/usage，只按明确白名单更新本次启动环境和实际观察；systemPrompt 等创建字段不能随 env 一起改写。每个后续 turn/control requireRecord 再次核对 expected identity，失败时零 prompt/配置 RPC；保留 suppressReplayUpdates，历史重放不进入新 Attempt 输出。

严格 setter 返回原生响应依据，proof 固定 context ref、driverInstanceId、configuration operationId、目标 model/effort 与实际 ACK/查询证据。Runtime 仅在全部目标确认、当前 operation CAS 及 Session 默认/owned options 成功提交后清 pending/unknown。配置修复有专用的原上下文 restore/config scope，绕过的只是普通 reconnect 对未知配置的准入限制，不能放开 Task submission，也不以 cached getStatus 清障。

## Runtime 接入与可修复入口

驱动单元先提供严格创建/恢复、身份与配置证明接口，Runtime 再接入既有资源账和配置未知状态。具体公共类型在协议实现前统一冻结，避免仅为 ACP 增一个绕开通用执行门禁的私有调用链。其他 driver 没有该能力时保持明确 unsupported，不因 ACP 已支持而宣称全执行器支持。

用户入口区分“恢复原会话配置”“创建新上下文”和“继续核对原尝试”。第一项只修配置，不重发未知原任务；第二项明确建立新上下文，也不把原未知结果改成失败；第三项保留原 Task/Attempt 的恢复证据。UI/CLI 必须可发现这些动作并展示阻塞原因，不能只有不可解除的内部 KV。

## 实际验收

使用真实 AcpxAdapter、当前 SDK、持久 sessionKey 和本地 ACP 协议进程验证，不能只 mock runtime.ensureSession：

- 首次 session/new 恰好一次；stop/resume、重开和环境更新始终沿用同一个 backendSessionId，后续 prompt 恰好一次。
- 删除/替换本地 record、原生 session/load 拒绝、resume 能力缺失，均零额外 session/new/零 prompt；保留可解释状态。
- 原生 model/effort 改变后 ACK 丢失、ACK 迟到、恢复时 stop、新配置操作与旧 ACK 交错，错误证明不能清 pending/unknown。
- 配置成功恢复后下一任务的冻结值与原生实际值一致；模型及 effort 的默认复位各有真实响应证据，历史无证据分支明确阻断。
- 修改群工具和 relay 启动环境仍通过真实 ACPX 持久化键校验，既有会话历史不丢；恢复失败无隐式 fresh 重发。
- sessionKey/资源身份/配置证据持久失败、SDK 创建和关闭尾声仍受 P0 claim 与资源许可保护。

本地协议验收通过后还需真实供应商确认其 resume/load、选项 ACK 和默认返回行为。没有真实证据的执行器维持未验证状态，不把本机 fixture 当供应商能力完成。
