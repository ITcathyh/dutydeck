# Codex App 协议与接入边界

状态：controller 完成版本定义和现有代码核对，后端未实现、真实模型未调用、尚未独立复核。本页是 P2 的实现输入，不是功能验收。

## 当前证据

2026-09-14 使用本机 `/home/huangyuhang.edu/.local/bin/codex`，实际版本 `codex-cli 0.154.0`。以下命令均成功退出，未启动 app-server、读取个人线程或修改用户配置：

```sh
codex app-server generate-ts --out /tmp/dutydeck-full-product-20260914/codex-app-protocol-ts
codex app-server generate-json-schema --out /tmp/dutydeck-full-product-20260914/codex-app-protocol-json
codex app-server generate-ts --experimental --out /tmp/dutydeck-full-product-20260914/codex-app-protocol-experimental-ts
```

稳定 TypeScript 目录实际 711 个文件、JSON Schema 305 个、包含实验接口的 TypeScript 847 个。文件清单与 SHA-256 见 `/tmp/dutydeck-full-product-20260914/codex-app-protocol-manifest.json`；这些是生成文件数，不是支持能力数。

已完整读取 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。协议使用双向 JSON-RPC，请求、通知和服务端请求需分别处理；stdio 默认使用 JSONL。连接完成一次 initialize/initialized 握手，后续调用 thread 和 turn 接口。WebSocket 被官方标为实验支持，Dutydeck 首先使用自己持有的 stdio 子进程；远端接入的凭据和所有权另行设计。

当前 Dutydeck 的 `packages/cli-adapters/src/adapters/codex-app.ts` 只生成外部 runner 参数和输入帧，注释明确要求用户另提供 runner；它没有实现 App Server 客户端。不能因为 factory 中列出了 codex-app，就计为后端可用。

固定 Botmux 基线 `e8c9bbdfacda272740d5fd0b148235e358bdf53e` 已有实际 runner、控制协议及派发账本。已核对其 `src/adapters/cli/codex-app.ts`，以及 runner 的授权处理、线程恢复和按 clientId 核对结果路径；这里只据这些已读路径作比较，未宣称复审了完整 runner。

## 本机生成定义支持的接口

| 需求 | 0.154.0 的真实生成定义 | Dutydeck 接入约束 |
| --- | --- | --- |
| 新建上下文 | ThreadStartParams 支持 model/provider/cwd、审批/沙箱、developerInstructions；返回原生 Thread.id | 新 Session 创建；保存原生 ID，不能用 Dutydeck Session ID 假造 |
| 继续上下文 | ThreadResumeParams 接受 threadId；返回模型、provider、effort 和线程状态 | 显式保留恢复语义，失败不能偷偷创建新线程 |
| 接收一轮 | TurnStartParams 有 clientUserMessageId；ThreadItem.userMessage 有 clientId | 使用已持久化 submissionId 关联；字段存在不证明服务端幂等重发 |
| 完成归属 | TurnStarted/TurnCompleted 都带 threadId 和完整 Turn 标识；Turn 有 itemsView/status/error | 先关联原轮次再结算，不能接受任意 completed 通知 |
| 原结果核对 | ThreadReadParams.includeTurns；实验 ThreadTurnsListParams.itemsView/cursor，ThreadItemsListParams.turnId/cursor | 查询对应 Thread/Turn，不枚举其他个人历史；不完整或不支持的历史返回待核对 |
| 活动轮次引导 | TurnSteerParams 要求 expectedTurnId，支持 clientUserMessageId | 引导要有独立已接受输入身份；不得自动把排队 Task 合并到同一结果 |
| 审批和问答 | ServerRequest 是独立联合，包含 command/file/permissions/userInput/elicitation 等分支 | 各分支按实际载荷展示与回应，不用一个 approved 布尔覆盖所有响应形态 |

稳定与实验接口分别生成。分页、附加上下文和特定扩展能力必须按实际版本协商，不能把文档示例中出现的字段无条件发送。发布资格要绑定经过实测的 CLI 版本和接口集合；未知接口必须给出可诊断的不支持结果。

## 采用的整合方向

新增直接实现 AgentDriver 的 Codex App 后端，使用受资源账本登记的原始 ChildProcess 和 stdio RPC；不要求用户安装 Botmux runner。旧参数适配配置保留明确迁移诊断，不能静默改跑另一条命令。App Server 的子进程、原生线程、原生轮次与 Dutydeck Session/Attempt 分开记录。

提交前由 P0 保存最终输入摘要、submissionId 和资源引用；一次 Attempt 只发一次 turn/start。RPC 响应或带匹配 clientId 的完整事件可成为接受证据，连接超时、write callback、thread/resume 成功均不能代替。已经发出请求而响应丢失时，先查询原轮次；未找到不证明从未提交，保持待核对。clientUserMessageId 是关联信息，不作为自动重发许可。

收到响应前的通知先按 thread/turn 暂存，建立归属后才发布；foreign turn、重复 clientId 或矛盾原生 ID 留诊断并阻止错误结算。最终 item 是输出核对依据，实时 delta 与重建输出必须去重。stopReason 使用明确终态，不从错误文本或空 status 猜测完成。迟到通知必须受 Attempt 和资源控制者约束。

权限通过 Dutydeck 已有权限模式、风险规则、操作者和 App 授权决定。命令、改文件、网络/文件权限、问答及 MCP elicitation 各自保留待处理记录，回复校验当前 thread/turn/request 与授权版本。Botmux 当前 runner 对命令/文件请求直接 acceptForSession、问答直接空 answers；Dutydeck 不沿用这些固定响应，因为本项目已提供独立的权限交互。

正常关闭保留原生线程上下文，实际进程退出由资源核验确认；待核对轮次不能用“同名线程成功恢复”解除资源 blocker。后台终端与远端执行资源不能仅由 app-server 进程死亡推断已停止。线程恢复、持久所有权及后台资源关闭的完整契约仍需与 P0 资源 hooks 一起冻结。

## 后续交付与验收

controller 先冻结 RPC/资源/审批接口，普通实现交 ccflash。实现需覆盖实际驱动、发现与配置、权限与问答 UI、线程选择/恢复/分叉、模型和推理设置、流式输出、终态与错误、停止和进程重开；不能只交协议类。

本地协议 fixture 必测：通知先于响应、响应丢失、相同 clientId 两个原生轮次、foreign completion、引导前置条件改变、在途审批撤销、分片 JSONL、进程退出与迟到请求。真实 CLI 还需核验新建→多轮→停止→重开恢复、历史核对、权限问答和供应商错误。当前只完成代码生成，没有这些运行证据。

完整产品 gate 还包括 Codex App 浏览器/桌面关联能力和远端已有 App Server 接入；它们不由本次本地协议核对覆盖，后续设计不能将其删除出范围。实际 Botmux 能力边界需继续从对应实现和功能样本核定。
