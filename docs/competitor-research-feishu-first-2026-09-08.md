# 让飞书成为 Dutydeck 的完整工作入口

调研日期：2026-09-08。面向本地或受信开发机上的编码、调研与巡检任务，兼顾个人使用和项目群协作。本文记录调研时的代码基线与产品建议。用户随后授权实施，首批落地状态见[实施记录](feishu-workflows-implementation-2026-09-08.md)，用法见[飞书工作流程](feishu-workflows.md)。下文“当前能力”均指调研基线。

**建议把下一轮投入集中在飞书内的决策、上下文、任务导航和成果交付。** 用户应能在手机上找到任务、补充要求、回答问题、批准具体操作，并拿到可查看的文件和验证结果。Web 继续承担接入配置、大段 diff、终端及排障。

本项目已有相当完整的运行底座。继续借鉴竞品时，应补齐用户旅程中的断点，保留现有 Runtime、事件、队列和卡片对账机制。下文明确区分当前实现、竞品资料支持的能力和拟新增行为。

## 当前能力比旧审计更完整，但飞书操作仍有断点

本轮代码基线：Dutydeck `20b504251c0309ae5332503a2f957536f8e6a679`；本地 Botmux `13413f8561d14b78081c046fde3ad8c72875572e`，两者最新提交日期均为 2026-09-07。未拉取远端、切换分支或读取生产凭据。Botmux 结论针对这个本地 checkout。

已全文阅读本项目 README、产品定义、架构定义、2026-08-30 Botmux 能力审计、集成主蓝图及远程控制面指南，再用当前装配代码和测试核对。旧审计和部分控制面说明存在版本差异，不能直接转成新的开发清单。

| 用户能力 | 当前核查结果 | 产品判断与证据 |
|---|---|---|
| 私聊、普通群、话题群连续工作 | 已实现 App、群和话题范围的会话解析，多种回复模式及持久会话查找 | 保留；优化任务发现和上下文展示。[会话解析](../apps/server/src/lark/session-resolver.ts) |
| 群级 Agent、目录、模型与权限 | 已有 `live_lark` 路径，群覆盖、角色、任务发起人和执行时权限校验已接入 | 不再列为“从零补 GroupBinding”。live_lark 也可存为 staged，但按独立绑定和成员事实判定是否应用；通用 foundation 不允许直接改 live bot。[群管理](../apps/server/src/lark/group-management.ts)、[运行装配](../apps/server/src/service.ts) |
| tmux 持久进程 | 生产 PTY factory 已显式注入带 Dutydeck 所有权的 tmux 后端；本轮隔离测试通过同一 pane/PID 重连 | 旧审计的“生产未接线”已过时。当前重启会将持久化 running 任务标为 interrupted；运行中结果续接尚未实现。[后端装配](../apps/server/src/service.ts)、[持久后端](../packages/pty-driver/src/persistent-backend.ts) |
| 进度和完成通知 | 已有确认表情、可变进度卡、单卡终态交付、重试及持久化对账 | 保留单卡交付；原卡确定不可更新时才补发唯一替代卡。后续补验收动作及附件。[协调器](../apps/server/src/lark/coordinator.ts)、[对账](../apps/server/src/lark/reconciler.ts) |
| 接收后、执行前的消息恢复 | listener 将事件直接交给 coordinator；入口去重使用内存 Set，随后才解析、排队和创建执行 | 已有任务与卡片持久化，仍不能据此承诺入站消息全程耐重启；“确认收到后、执行落库前”的恢复为 unverified。[接收入口](../apps/server/src/lark/listener.ts)、[去重与排队](../apps/server/src/lark/coordinator.ts) |
| 飞书操作前审批 | 当前飞书 Session 创建明确要求 `fullTrustConfirmed`，并固定 `permissionMode: full-trust`；卡片回调只有 cancel、interrupt、retry、refresh | 有 Runtime/Web 审批底座，缺飞书审批交互与非全信任启动路径。full-trust 下 ACP 自动允许请求；另有高危自动拦截，但不等于交互审批。[启动约束](../apps/server/src/lark/session-resolver.ts)、[卡片动作](../apps/server/src/lark/card-actions.ts)、[权限接口](../apps/server/src/app.ts) |
| Agent 向用户提问 | `session ask` 和 HTTP 回答接口已实现，问题进入文本事件；待回答记录保存在内存 | 飞书消息处理和卡片动作未接到该回答接口；需要把回答送回挂起的问题。持久恢复也需补齐。[Relay 路由](../apps/server/src/relay-routes.ts)、[Ask broker](../packages/relay/src/ask-broker.ts) |
| 飞书任务导航与配置 | 命令注册表有 help、status、cancel/stop、retry、new | `/status` 只查看当前上下文。跨任务查找、切回任务、选择工作区/模型仍缺原生入口。[命令表](../apps/server/src/lark/commands.ts) |
| 上下文与附件输入 | 当前消息的多媒体资源可下载；空 `@` 会读取最近消息并要求确认；群工具也可按 chat/thread、cursor 和 wait 查消息，并展开合并转发 | 有基础，不宜写成“不会读历史”。普通带文字请求缺统一的引用、线程增量和文档材料收集流程；合并转发默认只给占位信息。[附件解析](../apps/server/src/lark/message-content.ts)、[资源处理](../apps/server/src/lark/session-resolver.ts)、[空消息回退](../apps/server/src/lark/coordinator.ts) |
| 输出文件与文档 | 核心 Lark service 的 send/reply 发交互卡；另有加载动画图片上传 | 未找到面向 Agent 产物的通用上传/回传工具。具体 Agent 可自行使用已安装工具，但交付尚无 Dutydeck 统一契约。[Lark service](../apps/server/src/lark/service.ts)、[群工具](../apps/server/src/lark/agent-tools.ts) |
| 定时任务 | 已有定义、时区/DST、发生记录、所有权、水位与预览；API 明确 `executorWired: false` | 下一步是执行器和飞书创建/暂停流程，不能把配置页当成已支持定时执行。[Schedule API](../apps/server/src/schedule-routes.ts)、[存储](../packages/storage/src/schedule-foundation.ts) |
| Skills 与用量 | 已有本地 skill 发现、Web 选择、ACP usage 事件与上下文展示 | 缺飞书能力目录、结果反馈和专门的跨任务用量汇总。应复用现有数据。[Skill 发现](../apps/server/src/skill-catalog.ts)、[usage 事件](../packages/acp-client/src/index.ts)、[上下文展示](../apps/web/src/composer-utils.ts) |

## 竞品最有价值的是具体交互与执行契约

选择直接连接本地 Agent 的 IM 工具，以及在聊天中交付工程结果的产品。对飞书直接竞品看接入和日常操作，对 Slack 产品看可迁移的交互模式。在线资料统一访问于 2026-09-08；下表链接文字标识产品及对应页面；未单列发布日期的来源均未注明，结论只代表本轮读取到的文档状态。

| 产品 | 核查到的具体能力 | 值得融入 Dutydeck | 适用边界 |
|---|---|---|---|
| Botmux，本地源码 | TUI 提问卡等待 worker ACK；持久 CardKit 序号；定时前置条件；会话级浏览器工具；skill 按 adapter 投递 | 提问送达确认、流更新抗乱序、条件执行、浏览器授权边界 | 和本项目最接近；功能面广，需按现有 Runtime 接入。v3 workflow 自身标为实验性，不能据此承诺可靠性 |
| [OpenClaw 飞书通道](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md) | 持久入站队列、事件去重；群/发送者/topic 会话范围；文档、知识库、云盘、Base 工具；持久 ACP 绑定 | 接收即落库；按范围提供飞书工具；显式项目记忆 | 上游包为 `@openclaw/feishu`；动态用户 workspace 共享宿主进程，不是系统沙箱；持久队列保证不覆盖所有飞书事件 |
| [Lark 官方 OpenClaw 插件](https://github.com/larksuite/openclaw-lark) | 消息、文档、表格、日历和任务工具；README 说明敏感操作确认卡片 | 从“聊天发指令”扩展到读取业务材料、写回结果；显示实际操作身份及授权范围 | 包为 `@larksuite/openclaw-lark`，与上游扩展不同；不能把二者的配置或审批能力混用；本轮未验证真实授权流程 |
| [cc-connect](https://github.com/chenhg5/cc-connect/blob/main/docs/feishu.md) | 飞书权限卡与文本回退、按话题绑定工作区、多图合批；[会话切换和 cron 命令](https://github.com/chenhg5/cc-connect/blob/main/docs/usage.md) | 手机端任务导航；一次发多张图只形成一份任务材料；卡片不可用时仍能完成操作 | 本地 CLI 需先认证；群历史共享仅缓存进程观察到的消息；定时任务重启补偿与投递保证为 unverified |
| [Claude-to-IM](https://github.com/op7418/Claude-to-IM) | 飞书适配器实现 CardKit v2、权限按钮及 `/perm` 文字降级；桥接层处理重试和限速 | 参考权限请求与消息交付的接口，不必替换现有 Runtime | 是需宿主实现存储、模型和权限接口的库；模型事件接口针对 Claude Code SDK；原生 topic、出站媒体及 scheduler 为 unverified |
| [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) | 本地 Claude/Codex；群、topic、文档评论会话；恢复命令、profile 和权限模式映射 | 文档评论直接发起修改；飞书内查看和恢复会话 | package/命令名为 `lark-channel-bridge`；默认 full，桥接自身无文件系统沙箱；不同 provider 的逐工具审批为 unverified |
| [acp-link](https://github.com/xufanglin/acp-link) | 话题首轮聚合、后续增量、待处理附件；MCP 文件回传和 docx/wiki 读取；cron | 用户分多条消息提交材料，Agent 回传真实文件 | 轻量 ACP 桥接；源码可查，本轮未执行；其通用文件路径参数不应直接成为 Dutydeck 的发送授权 |
| [Cursor Slack](https://cursor.com/docs/integrations/slack) | 同线程续作、强制新任务、运行任务列表、频道默认仓库与显式覆盖、完成 PR 通知 | 飞书任务工作卡、工作区选择、线程跟进和结果入口 | 需 Cursor 账户及仓库连接；当前文档也支持指定自托管 worker/pool，不能简单归为只能云端运行 |
| [Devin Slack](https://docs.devin.ai/integrations/slack) | 消息快捷创建任务、Web/Slack 双向同步、取消同步、归档后继续；环境改动可在 Slack 查看并 Apply | 把现有消息变成任务；任务可显式绑定消息通道；审批展示具体变更 | 依赖 Devin 身份与执行环境；Code Channels 依赖 Slack 发布进度，不等于飞书已有相同组件 |
| [Claude Code Channels](https://code.claude.com/docs/en/channels-reference) / [Remote Control](https://code.claude.com/docs/en/remote-control) | 本地会话接外部消息；双向 channel 可转发工具审批；请求 ID 匹配，手机/本地先到的答案生效 | 消息、提问、权限决策分流；保持本地执行并从飞书干预 | Channels 为预览能力并需显式开启；项目 trust 和 MCP consent 不转发，不能承诺所有交互均可远程完成 |

Cursor 的 [Cloud Agent 能力文档](https://cursor.com/docs/cloud-agent/capabilities) 还明确把任务完成后的 PR 评论、CI、Slack 回复和定时器作为订阅事件，唤醒原会话继续工作。对 Dutydeck 的启发是：等待外部结果应成为可持久化的任务状态。可以先解决用户回答与 CI 完成两种事件，避免让 Agent 持续轮询。

Devin 的 [Scheduled Sessions](https://docs.devin.ai/product-guides/scheduled-sessions) 和 [Automations](https://docs.devin.ai/product-guides/automations) 提供运行历史、状态及条件/动作配置。可借鉴其“谁创建、以谁的身份执行、何时触发、执行后向哪里报告”的可见性；本项目已经有 Schedule 基础模型，应在其上接通执行。

Claude 的 Slack 产品正在变化。[旧 Claude Code Slack 文档](https://code.claude.com/docs/en/slack) 说明 Team/Enterprise 正转向 [Claude Tag](https://support.claude.com/en/articles/15594475-what-is-claude-tag)，Pro/Max 仍使用旧接入路径。本报告借鉴当前 Channels/Remote Control 的明确交互契约，不把旧 Slack 产品名称当成稳定的功能规格。

### 飞书直接竞品补充了三点产品方向

**业务材料和操作身份应在任务里看得见。** Lark 官方插件把文档、Base、日历、任务作为工具提供；OpenClaw 上游则按账号开启工具族，权限管理工具默认关闭。Dutydeck 可先复用已有 skill/CLI，支持“读需求文档 → 修改代码 → 把结果写回指定文档”的完整任务，并在操作前展示用机器人还是当前用户身份、作用于哪个资源。先接消息与文档，日历、Base 和会议按实际需求展开，不复制一套全量飞书 SDK。[官方插件能力](https://github.com/larksuite/openclaw-lark)、[上游工具开关](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md)。具体身份授权兼容性仍需实施时验证。

**收到消息与恢复执行之间还有一段需要保护。** OpenClaw 明确对消息和文档评论先持久化，再按会话串行分发。Dutydeck 当前 listener 异步提交后返回，入口使用内存去重，并先发送确认表情；已有的 Runtime 队列和卡片对账保护的是后续阶段。建议把入站持久接收纳入长任务恢复：先保存来源和去重键，再发送“已接收”，重启后继续尚未交给 Runtime 的消息；同时处理“Runtime 已接收但入口未记成功”的重复窗口。这里是代码路径支持的风险判断，尚未做故障注入，不能声称已经复现丢消息。[OpenClaw 入站语义](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md)、[Dutydeck 入口](../apps/server/src/lark/coordinator.ts)。

**手机端的小交互值得优先打磨。** cc-connect 会合并连续图片，并提供会话/工作区切换；它的群历史共享却不回放启动前消息。因此 Dutydeck 应做有来源的材料收集，不能用短时缓存代替完整上下文。[飞书指南](https://github.com/chenhg5/cc-connect/blob/main/docs/feishu.md)。Claude-to-IM 的 [飞书适配器](https://github.com/op7418/Claude-to-IM/blob/main/src/lib/bridge/adapters/feishu-adapter.ts) 和 [权限 broker](https://github.com/op7418/Claude-to-IM/blob/main/src/lib/bridge/permission-broker.ts) 还提供明确的权限请求与文字回答路径，适合借鉴为卡片失效时的操作回退；回退也必须匹配请求 ID 和操作者，不能让任意群回复成为批准。

文档评论是后续很自然的新入口：用户在报告某段评论“更新这部分”，Agent 就近获取材料并回复处理结果。[lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge#cloud-doc-comments) 已有这一交互。建议列入文档集成的第二步，沿用本项目任务授权和工作区绑定，不照搬“能评论就能触发本机执行”的访问规则，也不默认落到用户 home 目录执行。

### Botmux 新增部分值得单独吸收

相对仓库内 2026-08-30 审计，以下增量更值得进入新的候选清单：

| 机制 | 当前源码证据 | 本项目如何吸收 |
|---|---|---|
| TUI 输入先 processing，收到 worker ACK 才确认 | [card-handler.ts](../../botmux/src/im/lark/card-handler.ts) 的输入提交路径 | 飞书点击后显示“正在提交”，收到 ACK 后显示已送达执行端，再由具体请求状态确认回答或审批生效 |
| 流式卡每次写入前持久化递增序号，换卡阻止旧流继续写 | [card-stream-store.ts](../../botmux/src/services/card-stream-store.ts) | 若升级 CardKit，复用现有卡片映射加序号/归属；并发、重启、换卡与封存一并验证 |
| 定时任务执行前先检查条件，可区分 skip 和 error | [schedule-precondition-gate.ts](../../botmux/src/services/schedule-precondition-gate.ts)、[scheduler.ts](../../botmux/src/core/scheduler.ts) | 先支持“CI 确实失败才诊断”等受控条件；接入现有 occurrence，避免每次 tick 都产生模型调用和通知 |
| 枚举式浏览器操作和会话授权 | [codex-browser-broker.ts](../../botmux/src/services/codex-browser-broker.ts)、[认证请求边界](../../botmux/src/services/codex-browser-authenticated-fetch.ts) | 浏览器操作通过受限能力调用；飞书展示连接、授权、接管与结果状态，避免暴露任意 CDP/JS 通道 |
| skill 目录/manifest 与 adapter 投递方式分开 | [session-runtime.ts](../../botmux/src/core/skills/session-runtime.ts)、[delivery.ts](../../botmux/src/core/skills/delivery.ts) | 飞书展示已安装能力；运行记录固定选择及实际投递方式，不把“目录里有 skill”当作每个 Agent 都已加载 |
| 提交前的同步 allow/reject hook | [hook-runner.ts](../../botmux/src/services/hook-runner.ts) | 可以补任务输入检查；Botmux 默认错误策略可放行且 Schedule 不经过该 hook，不能替代本项目统一权限检查 |

Botmux 的反馈策略还区分请求人、指定评审者和显式开放范围，并冻结投递时的反馈策略。[feedback-policy.ts](../../botmux/src/services/feedback-policy.ts)。这适合借作验收反馈的身份规则；普通点赞不等于接受代码变更。其 [usage-ledger.ts](../../botmux/src/services/usage-ledger.ts) 已有按轮次记录的原生用量及可选价格估算，本项目可先做原生用量归属，不复制整套计价面。

### CardKit 是可选优化，先解决操作与结果

Dutydeck 已设置卡片的 `streaming_mode`，实际更新调用是按 `message_id` PATCH 整卡。CardKit 的卡实体流更新则使用 `card_id`、元素 ID 与递增 `sequence`；两种更新路径不能混为一谈。[本项目更新调用](../apps/server/src/lark/service.ts)、[飞书官方 SDK 的 CardKit 说明](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/doc/channel/cardkit-streaming.md)。该 SDK 页面已标注迁移，应在实施时依据新 SDK/当前 OpenAPI 核对接口。

建议在长输出卡片确有刷新开销或渲染问题时采用 CardKit。收益待测，不能声称替换后必然更快。即使使用元素级更新，仍保留现有单卡终态和对账；完成推送是否另加表情提醒应经手机端实测决定，避免重新产生两张结果卡。

## 最值得优先投入的四项体验

### 在飞书里回答问题和批准具体操作

用户说“修复测试失败”，Agent 查到两种修复方向后，在原话题发出选择卡；用户点击或回复，执行从暂停点继续。需要执行受控操作时，卡片说明操作、目标和影响，并允许本次或拒绝。两类行为分别保存为“回答问题”和“批准操作”，避免一次普通回复被解释成授权。

当前可复用 `RelayAskBroker`、Runtime 的 `permission_request`、`resolvePermission` 及既有卡片回调入口。需要补四处连接：飞书会话可选择受支持的审批姿态；卡片关联具体问题/权限请求；消息回复优先解析为该问题的答案；点击时重新校验 App、群、操作者、任务轮次和请求有效性。

**先覆盖 ACP 的结构化权限请求。** PTY Agent 的原生确认能力不同，继续按实际适配器能力展示。不要把终端里的任意 `y/n` 提示包装成已经可靠支持的审批。提问等待也需要持久状态；服务重启后应明确恢复或失效，不能只有历史文本而执行端仍等待一个内存请求。

Claude Channels 的请求 ID 及先到答案生效机制、Botmux 的 TUI ACK，都说明这个功能需要做到执行端。只是给卡片加两个按钮还不足以完成审批。[Channels 权限转发](https://code.claude.com/docs/en/channels-reference)。

验收场景：同一群两个人分别发起任务，答案不会串任务；旧卡、重复点击和越权操作不会推进执行；用户拒绝后 Agent 得到明确结果；用户回答不会额外创建一轮排队任务。此项工作量为 **L，estimate**，因为涉及运行与交互两端。

### 把引用、线程与飞书文档带进任务

用户先在话题发截图和需求文档，再说“按上面的要求修一下”，Dutydeck 应自动整理本次任务所需的材料，并在首张卡片显示材料来源及读取失败项。后续补充只加入新消息，避免反复发送整个群历史。

现有线程隔离解决的是“送到哪个上下文”。建议再补一个有界材料收集步骤：读取明确引用的消息；对首次接手的话题获取近期上下文；按消息 ID 保存已读水位；收集前后分开发送的附件；识别 docx/wiki 链接并按权限读取。群聊范围、原作者和原链接都应保留。

[acp-link](https://github.com/xufanglin/acp-link) 的首轮话题聚合、后续增量和待处理附件队列是很直接的参考。其 [link.rs](https://github.com/xufanglin/acp-link/blob/596cc53419a383cf4260a63c49d12e306d6c2c09/src/link.rs) 有新会话聚合和附件入队路径，文件发送/文档读取工具见 [mcp_tools.rs](https://github.com/xufanglin/acp-link/blob/596cc53419a383cf4260a63c49d12e306d6c2c09/src/im/feishu/mcp_tools.rs)。这些是源码证据，本轮未运行该产品。

建议先支持用户主动给出的消息和文档。文档写入、日历或会议能力按具体任务单独接入。读取失败时展示缺哪份材料和如何补充；群成员共享的内容只能作为任务材料，不能提升执行权限。已有 Agent skill/CLI 可以承接读取操作，Dutydeck 负责来源、范围和结果状态。

验收场景：引用一条消息后发“解释这个报错”；先图后文；首次介入已有话题；文档无权限；合并转发中部分附件不可读；两个话题含同名文件。此项 **M，estimate**；用户身份授权若成为必要条件，需另估。

### 让用户在飞书找到并继续工作

建议提供一张可反复唤出的工作卡，显示“待我处理、运行中、最近任务”，每项使用目标名称、工作区与明确的下一步。用 `/tasks` 作为稳定文字入口，再提供卡片上的新任务、返回话题和继续操作。用户不必记 Session ID，也不必先打开 Web。

新任务表单只收目标和工作区；Agent、模型与权限在需要时展开。工作区使用管理员登记的可选项。模型列表复用现有真实探测结果，选择后说明对新任务还是当前任务生效。运行中的任务不得因切换默认值而换目录或 Agent。

首期“继续”应定位既有飞书话题及任务，避免同时引入跨群迁移。Web 发起任务若要同步到飞书，应增加明确的通道绑定动作，再向已授权的接收方投递。跨 App 或跨群继续时，需重新检查上下文能否向目标范围公开。

Cursor 的线程续作/新建/运行列表与 Devin 的消息快捷创建，都是已存在的交互参照；飞书具体入口先用可控的卡片和命令，不依赖 Slack 专有菜单能力。[Cursor Slack](https://cursor.com/docs/integrations/slack)、[Devin Slack](https://docs.devin.ai/integrations/slack)。

验收场景：手机上同时跟进两个项目；从列表回到正确话题；服务重启后仍能定位任务；无权限的群任务不出现在列表里；忙碌时补充要求可明确选择排队或纠偏。此项 **M，estimate**，可先复用现有任务摘要查询。

### 在飞书收到产物，并区分完成与验收

用户要一份报告，应收到文档链接或文件；用户要修 Bug，应收到改动摘要、验证命令及结果、PR/MR 链接或补丁。现有结果卡已经显示 Agent 最终文本、证据摘要和 Web 详情，但缺少统一的文件交付、验证来源与验收记录。

建议在现有 Run 证据上增加产物引用与交付状态，并提供受当前任务能力约束的 `send-file`/图片回传入口。执行已完成、文件尚未送达应分别记录；上传失败重试交付，避免重新运行整个任务。Agent 指定的路径需检查归属和可发送范围，目标群与话题由当前能力上下文确定。

结果卡增加“已验收”“需要修改”两个动作。前者记录请求人的验收，后者携带原因继续当前任务；不让点击行为改变已经冻结的执行事实。文件展示与反馈可以共用结果消息关联，但保持独立状态。

验证摘要优先读取已有工具结果和后续可解析的测试证据。供应商仅返回文字总结时，应标明“Agent 报告”，避免把自然语言直接计为已验证测试。大 diff 和终端仍由 Web 查看。

验收场景：返回图片、PDF 和普通文件；产物上传失败后单独重试；最终通知重发不重复交付；只有允许的用户可验收；用户要求修改时保留上一版产物与验证记录。此项 **M，estimate**。

## 后续能力按依赖和真实使用频率投入

优先级表示建议投入顺序，不是线上故障级别；消息与恢复一行是四项 P0 的共用验收要求，不另建一个恢复项目。工作量 S/M/L 是相对估计，不是承诺工期；收益均为产品判断，尚无用户数据量化。

| 能力 | 优先级 / 工作量 | 具体用户结果 | 建议范围与依赖 |
|---|---|---|---|
| 提问与审批卡 | P0 / L | 手机回复或点击后执行继续 | ACP 先行；持久请求、身份和过期处理 |
| 引用/线程/文档材料收集 | P0 / M | “按上面的需求做”有足够材料 | 复用消息读取和附件下载；有界增量 |
| 飞书任务工作卡 | P0 / M | 查找、回到、继续多个任务 | 复用任务摘要与作用域授权 |
| 产物交付与验收反馈 | P0 / M | 收到可打开的结果并给出修改意见 | 扩展现有结果投递；交付可单独重试 |
| 消息与长任务恢复 | P0 配套 / M–L | 已确认收到的消息可追踪，知道原进程是否还在 | 补入站持久接收及运行中重启证据；区分原进程重连、原生 resume、摘要重开 |
| 飞书能力目录 | P1 / S–M | 点击“解释代码、评审改动、生成报告”等已安装能力 | 复用 skill catalog；显示作用范围和所需输入，暂不建市场 |
| 飞书文档操作与身份授权 | P1 / M–L | 读取需求、写回报告，知道以谁的身份操作 | 复用现有 skill/CLI；先做指定文档读写与授权状态，再接评论入口；日历/Base 按需展开 |
| 定时任务实际执行 | P1 / L | “每个工作日九点检查 CI”，可查看、暂停和修改 | 接通现有 occurrence/ownership 模型；飞书确认时区、目标话题、下次执行和上下文策略 |
| 外部事件触发 | P1 / M–L | CI 失败或指定文档更新后创建任务，结果回飞书 | 从一个真实事件源开始；幂等键、来源身份、限流、取消和结果查询 |
| 每任务独立 worktree | P1，发生并行改码时提前 / M–L | 同一仓库的两个任务互不覆盖改动 | Dutydeck 管工作目录分配、分支归属和收口；复用现有 CLI 执行能力 |
| 显式项目记忆 | P1 / M | 用户确认后记住项目约定，下次有来源可查 | 按用户/群/工作区隔离；可查看、修改、删除；复用文件型记忆与原生 Agent 能力 |
| 浏览器接管与截图证据 | P2，浏览器任务高频时提前 / L | 在飞书安排浏览器操作，必要时接管登录，再收到结果 | 先做受控连接/截图/断线提示；远程开发机与用户电脑不在一处时需桥接 |
| 原生用量与质量统计 | P1 配套 / M | 找到重复失败、需要返工或上下文过长的任务类型 | 关联原生 usage、验证与用户反馈；缺失值保留 unknown，不推算费用 |
| 语音交互 | P2 / M | 移动端语音下达任务、按需听摘要 | 已有音频附件输入；转写、确认文本与语音输出需独立补齐 |

定时执行建议优先做有明确表达式和目标的任务。之后再考虑周期性主动检查；通知策略至少区分“每次汇报”和“仅有变化/异常时汇报”，并提供暂停入口。现有卡片刷新心跳只是展示机制，不代表已经有周期性自主工作能力。

浏览器能力的关键价值在远程主机无法直接访问用户桌面登录态的场景。普通网页检索或本机已有浏览器工具能完成的任务，可先继续交给 Agent，避免同时维护一套完整远程桌面产品。

worktree 只隔离代码目录和分支，不提供凭据、文件访问或网络隔离。若要让不同信任级别的群成员运行本机工具，需要单独设计并验证 OS/容器沙箱；不能把它算入“每任务 worktree 已完成”的承诺。

## 建议的落地顺序与完成标准

先交付飞书任务工作卡和文件回传，使入口与出口可用；同步设计提问/审批的持久状态，随后交付飞书内回答和 ACP 审批，再补线程/文档材料收集。运行中重启的恢复证据贯穿这一阶段，不能用已完成一轮的重连测试替代。

第二阶段用两个具体场景验证自动化：用户主动创建的定时 CI 检查，以及一个外部失败事件触发的诊断任务。两者使用同一任务执行与交付路径。按实际返工样本增加能力目录、显式项目记忆和反馈统计。

已有群工具可支撑显式 Agent 交接。先确保交接后能看见负责人、子任务结果和失败，再决定是否需要父子任务聚合。完整 DAG 编辑器、多套 workflow 引擎、跨机器 Agent 联邦、独立手机 App 和持续全群监听都不建议进入这一轮。

产品完成标准建议用五条真实旅程：

1. 用户只拿手机，在飞书选择项目、发起任务、补充截图并得到文件结果。
2. Agent 提问后，用户回答能恢复原任务；审批拒绝和无权限点击均有正确结果。
3. 两个项目并行，任务列表、话题、附件、权限和最终通知不串。
4. 确认收到但尚未执行、执行中、待回答和交付期间分别重启服务，状态和恢复能力与卡片说明一致。
5. 定时任务遇到重复触发或投递失败，只按约定创建执行，并能单独重试结果交付。

适合衡量的指标是“飞书内完成率”：从飞书发起、无需打开 Web/终端便完成必要交互并收到产物的任务，占飞书任务的比例。并行记录等待用户时长、交付失败率、用户要求修改的比例和重启后可恢复比例。**当前基线及提升幅度均为 unverified**；应先采集再定目标。

## 本轮验证及边界

代码核查覆盖 Lark listener/coordinator、Session 路由、卡片动作、群管理、Relay、Runtime 权限接口、Schedule API 与存储、PTY 生产装配、skill/usage 入口。缺口结论通过对应执行路径与调用方检索核对；未把独立 Agent 自身能做的事等同于 Dutydeck 已提供的一致产品能力。

本轮实际通过：

- 6 个测试文件、189 项测试：Session 路由和 full-trust 约束、飞书命令、群配置与权限、卡片动作、Schedule 禁用管理、Relay HTTP 问答。
- 1 个隔离服务重启场景：已完成一轮的任务跨两次服务生命周期使用同一 tmux pane/PID，最终停止销毁进程，隔离 tmux 残留为 0。

报告经独立审读，已修正单卡终态、运行中重启行为及结果展示范围，并补充入站确认窗口和 live_lark 边界。测试没有修改断言。`pnpm exec vitest` 触发环境自动安装检查后因无 TTY 退出；改用已安装的 `node node_modules/vitest/vitest.mjs run …` 完成上述 189 项测试，没有重装依赖。

未运行真实飞书收发、云端付费 Agent 或当前 Botmux 运行实例。竞品能力来自官方资料/源码，不能据此声称做过跨产品性能或稳定性实测。真实租户权限、移动端渲染和用户身份授权仍需后续联调。

本仓 parity 清单仍把运行中最终结果重建、Schedule executor/activation、跨运行时双消费者隔离列为未关闭项；真实飞书场景需要外部测试环境。[可执行清单](../tests/e2e/botmux-parity/cases.json)、[测试范围](../tests/e2e/botmux-parity/README.md)。这些限制仍影响迁移准备度。
