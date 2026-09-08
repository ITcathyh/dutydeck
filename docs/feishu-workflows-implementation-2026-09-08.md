# 飞书完整工作入口：首轮实现计划

用户已授权调研、设计后直接实施。基线为 `20b5042`，集成工作目录为 `/data00/home/huangyuhang.edu/ai/dockmux-feishu-workflows-20260908`。不变更真实飞书配置，不启动生产实例。本轮交付任务导航、产物回传、问答与 ACP 审批、任务材料收集；定时执行、浏览器和项目记忆留在后续清单。

## 用户行为与完成标准

1. `/tasks` 展示当前 App 内允许用户查看的任务；群聊只展示本群，私聊跨群列表只显示本人发起且仍有权查看的任务。按待处理、运行中、最近完成组织，提供返回原群/话题入口。任务目标和工作区可辨识，不要求记 Session ID。沿用 `/new` 创建新上下文。
2. Agent 用 `group send-file <path>` 回传当前工作目录内的文件，可指定图片消息。交付失败可单独重试；相同交付键不重复发送，不同内容不得复用同键。结果卡保留单卡终态，验收作为独立状态保存，不改写执行事实。
3. Agent 的 `session ask` 在飞书显示明确提问；回复问题卡或 `/answer <request-id> <内容>` 回答原问题，不新建 Agent 任务。ACP ask 模式发出一次性批准/拒绝按钮，并提供显式文字命令回退。点击成功仅表示执行端已经接受决策。过期、重复、越权和重启后的旧卡都不能推进执行。
4. 明确引用的消息、话题首轮近期材料、后续增量、附件与 docx/wiki 链接自动加入实际 Agent prompt，保留原用户目标。材料有来源、大小/数量上限与失败说明。同一消息和附件不反复注入，两个话题不串。读取用户明确引用的同群内容时保留来源，不能提升权限。
5. 收到消息后的持久状态、问题失效和交付重试均有重启测试。当前 running 任务重启后仍明确中断；本轮不承诺恢复任意 PTY 的执行中输出或本地确认框。

## 接口与安全决策

现有 Runtime、任务队列、卡片映射和 ConfigRepository 是基础。新增状态优先复用支持 CAS 的 ConfigRepository，补充按前缀列举以支持启动恢复；不引入通用 workflow 引擎。生产存储必须提供持久 CAS，测试替身可注入等价内存实现。

提问先持久登记再发布，回答先原子占用 pending 再发布答案并完成。并发失败者返回 409；超时或取消不得覆盖已占用的回答，发布失败明确取消。服务启动时没有 live waiter 的旧 pending/answering 记录变为 cancelled，保留原因，不能伪装已回答。Relay 本身保持与飞书无关，由 server 注入存储端口。

ACP 审批保留 Runtime 的结构化请求；配置新增显式 ask 姿态，旧配置仍按既有 full-trust 规则处理。卡片请求绑定 App、群、Session、当前 Runtime task/turn、请求 ID、真实卡片消息及本次服务 generation。批准重查 `high_risk.execute`；拒绝与回答至少需要对应任务的操作权限。普通群可读成员不因此获得审批权。重启后没有 driver 请求的历史卡显示失效。

材料收集和任务导航先验证 App/chat 与当前成员/角色。现有 `group message` 对传入 messageId 缺少群归属检查，本轮一起修正；thread-bound 的主动群工具只可读取绑定话题，合并转发仅展开已验证的父消息。自动引用收集须显式记录同群引用来源，不能默默跨群读取。

入站记录先持久保存，再确认收到。入口按 App/message ID 去重，Runtime 接收用稳定 task 幂等键补齐“已提交但尚未记成功”窗口；运行中进程重启后的任务状态继续沿用 interrupted。恢复时重新验证当前配置和权限，禁止用历史配置快照里的凭据或已撤销身份执行。

## 执行单元

### A：文件交付与文档读取，terra worker

独立目录 `/data00/home/huangyuhang.edu/ai/dockmux-feishu-files-20260908`。负责 `apps/server/src/lark/service.ts`、`agent-tools.ts`、`agent-tools-routes.ts`、`agent-tools-cli.ts` 及对应测试，可新增 `artifact-delivery.ts` 与测试。不得改 coordinator/listener/runtime/shared/storage/config，不 commit，不派 agent，不使用真实飞书。还有其他 agent 工作，不能回退其改动。

- CLI：`group send-file <path> [--reply-to om_x] [--in-thread] [--idempotency-key value] [--image]`。沿用现有 token、群工具发送权限及目标校验，不接收任意 chatId。回复目标需属于绑定群。
- 当前 Session cwd 内的 canonical 普通文件才可发送；拒绝路径逃逸、symlink 逃逸、目录/FIFO/空文件。尽量使用已打开 fd 的 fstat 与内容，减少检查和读取之间的文件变化。产品上限：文件 30 MiB、图片 10 MiB；这是本轮保守选择，不声明为平台最新最大值。
- 沿用现有 token/API gate/error 封装，multipart 上传 `/im/v1/files`（file_type=stream）或 `/im/v1/images`（image_type=message），再发 file/image 消息。不得把 token 或绝对路径写入群消息。
- ConfigRepository CAS 保存 Session+交付键下的 fingerprint、provider key、发送状态/messageId。相同键不同内容/目标返回 409；重复成功返回原结果；上传成功发送失败后重试应复用上传 key、稳定 provider uuid。无显式键按作用域+内容 hash+目标派生。重启后不能永久 busy，读取既有交付结果仍需鉴权；真正上传/发送前重查权限。
- 补 `readDocument(url): Promise<{url:string;title?:string;text:string}>` 的可选 service 方法。仅接受 https 飞书/Lark docx/wiki URL；不直接 fetch 用户 URL。wiki 解析 node 并限定 docx，随后读取 raw_content，使用已配置 OpenAPI 主机与机器人 token。
- 修复现有 `group message` 缺少 chat/thread 归属检查的问题，保留被授权父消息的 merge_forward 展开。
- 测试用真实临时文件+fake HTTP：multipart 原字节、file/image 目标、逃逸和非普通文件、越权与撤销成员、并发重复、同键冲突、上传后发送失败及新实例重试、CLI/route 接线。

### B：上下文模块与纯任务卡，按明确接口委派

材料模块单独新增文件，复用现有 LarkCardService 的消息方法及 A 的 readDocument；不改 A 负责的 service。输入为已授权事件、绑定 scope、已有水位、当前 prompt/resources，输出 agentPrompt、资源来源及新水位。controller 在 Runtime 接收成功后提交水位；失败时不消耗材料。

任务卡 formatter 接收已授权的任务摘要，不在 UI 函数猜权限。提供有界列表、清楚的状态和返回原位置链接；历史缺少发起人时禁止在跨群个人列表中猜测归属。controller 负责命令注册、查询与授权接线。

### C：controller 集成

负责 coordinator/listener、配置姿态、Runtime 原子审批与接收幂等、Relay 问答与持久状态、状态存储适配、任务授权查询和反馈接线。紧耦合文件由一个 writer 修改。保持 ACPX session_options 的 snake_case，修改环境注入或 Session 配置时增加真实 AcpxAdapter 持久 session key 回归测试。

## 验证与收口

先以各单元针对性测试验证数据流，再将 worker 的含新增文件 diff 整合到集成 worktree。运行受影响 server/runtime/relay/storage/ACP 测试、类型检查和构建，补一个跨入口、持久化、卡片回调和 fake provider 的端到端测试。报告真实飞书联调未执行的边界。

由未参与编写的 reviewer 审查整合 diff，controller 裁决并修复有效问题，验证后再次审查。完成标准是上述用户行为可运行、测试通过且无未解决阻塞 finding，不以文件存在或 worker DONE 作为完成依据。

## 实施记录

四项首批能力已接入独立集成分支 `feat/feishu-workflows-20260908`；具体使用方式见[飞书工作流程](feishu-workflows.md)。

- 任务导航：`/tasks` 根据当前成员和任务归属过滤，显示执行状态、待回答/审批及独立验收状态；返回原群或话题，回复结果卡沿用原上下文开新任务。
- 文件交付：Session 工作目录内的文件、图片上传与发送，持久 CAS 和消息 UUID 支持交付重试；发送前重查目标和权限，打开后通过 Linux `/proc/self/fd` 校验文件范围。目前其他平台明确拒绝文件回传。
- 问答与审批：Relay 的原等待器接收回答，ACP ask 模式允许逐项确认；卡片绑定真实回调上下文、任务和服务代次，先记录决策意图，执行端消费后才确认。首次发卡失败随心跳重投，决策提交前失败且请求仍有效时可在原卡重试。
- 任务材料：同群引用、话题增量、附件和 docx/wiki 正文进入实际 Agent 输入，保留独立目标和来源。飞书消息时间按毫秒保存，查询起点换算成秒；同秒分页保留扫描位置，避免水位卡在第一页。
- 持久恢复：消息回执前写入 inbox，材料快照在 dispatch 前保存；任务映射和材料水位成功保存后才确认 accepted。稳定 Runtime task ID 消除重复执行窗口。监听器重建可重新挂接仍存活的问答；守护进程重启时 running 任务仍明确中断。结果验收和单卡交付分别保存、对账。

独立审查成立的问题均纳入返修：原卡与替代卡的回调归属、当前任务发起人与 Session 创建人的区别、权限撤销、审批并发与持久化失败、入站快照/映射提交窗口、同秒消息翻页、文件父目录替换，以及验收与终态卡片写入竞态。故障注入还修复了 dispatch 已成功后排队卡保存失败导致误报任务失败、丢弃运行事件的问题。卡片重试以当前操作人和当前配置执行，不继承原请求人的高危权限。

两条候选 finding 经核对后撤回：文本命令的 task.create 预闸实际允许 can_operate；模拟 CAS 返回 false 但权威值仍等于 expected 不符合 SQLite CAS 契约，当前串行会话路径不存在相应证据。未为这些假设扩改实现。

材料、问答和历史记录暂时按本地恢复与审计用途保留，尚无自动过期策略；长期数据量与扫描成本增长是已接受的限制，后续按终态和保留期归档。定时执行器、浏览器接管、项目记忆、文档评论触发、CardKit 细粒度更新仍属后续清单。

最终验证（2026-09-08）：

- 统一受影响测试：45 个文件、786 项全部通过，包含 14 项真实 Runtime + SQLite + Relay + 模拟飞书的集成测试。
- 真实 AcpxAdapter 与 mock ACP 子进程覆盖 ask、持久 Session key 和小写环境键；审批只消费一次。文件服务测试使用真实临时文件与模拟 HTTP。
- shared、relay、storage、acp-client、agent-runtime 编译通过；服务器与 Web 类型检查、Web/Vite 与服务器打包通过。
- 构建后的 `group send-file --help`、`session ask --help` 可用；`git diff --check` 通过。
- 独立 reviewer 复核集成源码及最后的卡片保存故障修复，无剩余阻断问题。测试保留原状态与事件断言；旧回调夹具补充真实入口应提供的操作者，并加强对目标 Runtime task ID 的断言。

最终测试命令：

```bash
node node_modules/vitest/vitest.mjs run --maxWorkers=4 apps/server/src/lark packages/agent-runtime packages/relay packages/acp-client packages/storage apps/server/src/relay-routes.test.ts apps/server/src/relay-ask-store.test.ts apps/web/src/components/LarkConfigModal.dom.test.tsx
```

未修改真实飞书配置，未向真实用户或群发送消息，未部署或推送分支。真实租户权限、移动端卡片表现与真机收发仍需联调；本轮不能等同于生产验收。
