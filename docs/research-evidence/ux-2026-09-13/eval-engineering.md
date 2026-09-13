# 飞书指挥 Agent 体验候选优化：工程可行性评估

日期：2026-09-13　方式：只读代码核查 + 平台证据核对，未改任何代码。
输入：`docs/research-evidence/github-2026-09-13/github-im-agent-research.md`（§4 共 12 条）、`docs/research-evidence/ux-2026-09-13/current-feishu-surface-audit.md`（§5 共 11 点）、`docs/research-evidence/lark-2026-09-13/raw/` 平台证据。
代码基线：master（2026-09-13 工作区）。路径前缀 `L=apps/server/src/lark/`。

## 成本口径

- **S**：单模块内修改，无新持久化状态，有现成测试位。
- **M**：跨模块但边界清晰（渲染+回调+配置），或引入少量可恢复状态。
- **L**：新持久化状态/协议/守护进程恢复语义，或新触发面全链路。
- **XL**：平台能力未验证、依赖外部系统常驻，或大重写。

证据强度约定：代码事实带 `file:line`；平台行为在证据库无文档/源码支撑的，一律标 **unverified**，不靠竞品 README 的断言下结论。

## 覆盖关系（12+11 合并去重，无遗漏）

| 本评估 | 竞品 12 条 | 盘点 11 点 / 核查问题 |
|---|---|---|
| E1 reaction 回执三态 | #1 | 问题② |
| E2 审批宽限期与双通道 | #2 | 问题③ |
| E3 过程卡详细度三档 | #3 | — |
| E4 CardKit 实体真流式 | #3 的平台底座 | 问题① |
| E5 执行端离线可见性/结果诚实性 | #4 | — |
| E6 云文档评论 @bot | #5 | 问题⑪ |
| E7 执行中消息语义（队列/抢占/👍/多图） | #6 | 问题④ |
| E8 话题生命周期与空闲轮换 | #7 | — |
| E9 多 bot 真 at 接力 | #8 | 问题⑧ |
| E10 卡片表单结构化问答 | #9 | 粗糙点 1 |
| E11 Agent Bus 投递语义/fan-out | #10 | — |
| E12 零配置上手 | #11 | — |
| E13 agent 反向发消息的克制 | #12 | — |
| E14 /work 卡改 PATCH | — | 粗糙点 2、问题⑤ |
| E15 /tasks 行内操作 | — | 粗糙点 3、问题⑥ |
| E16 /help 翻页按钮 | — | 粗糙点 4 |
| E17 移动端按钮尺寸/终端可用性 | — | 粗糙点 5、问题⑩ |
| E18 Web 深链覆盖与兜底 | — | 粗糙点 6、问题⑨ |
| E19 文件型结果验收标注 | — | 粗糙点 7 |
| E20 群内操作者归属与 agent 显示名 | — | 粗糙点 8 |
| E21 通知粒度（建议维持） | — | 粗糙点 9 |
| E22 会话切换器与卡稀释 | — | 粗糙点 10 |
| E23 未知命令提示 | — | 粗糙点 11 |
| E24 欢迎语与 bot 菜单 | — | 问题⑦、盘点 §4 |

---

## E1 reaction 回执三态（ack/处理中/done）——出站暂缓，入站随 E7

**现状**。只有单态：入站处理开始打 `OK`（`L/coordinator.ts:576`，API 封装 `L/service.ts:1006-1015` add / `:1017-1019` delete），进度卡首帧送达后撤销（`L/coordinator.ts:1633`，另有失败/解析失败等 5 处撤销兜底 `:597,:605,:690,:748,:1107-1113`）。入站 reaction 事件在 `L/listener.ts:151-155` 显式注册为 no-op，注释明确"不是控制面"。出站 scope 已具备（`im:message.reactions:write_only`，`L/open-platform-configurator.ts:18`）。

**核查结论**。

1. 出站三态本身是 S：再加两个调用时点即可（处理中表情、完成保留表情）。
2. 但竞品 cc-connect 给 done 表情的核心职责是"卡片原地更新不推送，done 表情承担手机推送"。**reaction 变更是否产生移动端推送/红点，平台证据库无任何文档支撑——unverified**（raw 全目录检索"表情+通知/红点/推送"零命中；cc-connect 的说法是 README 断言）。真机验证前不能把通知职责迁到 reaction。
3. Dutydeck 现有契约比三态更强：完成通知由**独立结果新消息**承担（`L/coordinator.ts:1823-1842`，产品文档明确 PATCH 不提醒）。done 表情与之重复；处理中表情与 1s 心跳卡重复。每任务新增 2-4 次 reaction API 调用，全部经过 per-app 限流闸（`L/service.ts:1256` 注释覆盖 reaction），纯增成本。
4. 入站 reaction 若要变控制面（👍 升级，见 E7），需在配置器事件订阅里追加 `im.message.reaction.created_v1`；当前只订阅 `im.message.receive_v1`（`L/open-platform-configurator.ts:26,:90-107`）。追加成本低：更新接口走 `operation: 'add'` 增量模式（`:91-98`），同款调用再 add 一个事件即可，无覆盖风险。

**成本**：出站三态 S；入站控制面 M（事件订阅合并 + reaction→消息→任务映射 + 过滤 bot 自身事件，详见 E7）。

**风险**：reaction 通知语义未验证导致"以为通知了实际没通知"；bot 自己 addReaction 的事件回流误触发；API 调用放大。

**姿态**：**出站三态暂缓**（现有 OK + 双卡终态已覆盖"收到/完成"两件事，先真机验证 reaction 通知再议；失败态补一个持久 ⚠ 是可选 S）。入站 👍 随 E7 立项。

## E2 审批宽限期 + 本地/IM 先答先赢 + 永不自动拒绝——grace 直接做（ACP），PTY 双通道驳回

**现状（对竞品建议的事实修正较多）**。

- 无宽限：`L/workflow-interactions.ts:104-162` observe() 收到首条 live pending 事件立即发卡。
- **无任何超时/自动拒绝**：`packages/agent-runtime/src/index.ts:1147-1184` resolvePermission 无超时分支。竞品建议的"永不自动拒绝"现状已满足，是保持项不是新开发。
- **"先答先赢"已实现**：claim token + generation 围栏 + driver 可用性复查 + 决议先落审计（同上 `:1147-1184`，含 PERMISSION_ACCEPTED_AUDIT_FAILED 特例）。IM 卡与 Web（`apps/server/src/app.ts:240` POST resolvePermission）共用同一决议入口，**ACP 协议下 IM ↔ Web 双通道先答先赢今天就成立**。
- **但 tlive 的"终端 ↔ 远程卡并行竞赛"在当前架构不存在**，且两个协议方向互斥：
  - ACP：`packages/acp-client/src/index.ts:328` resolvePermission 只是 promise 钩子（allow_once/reject_once），权限弹窗由 Dutydeck 自己渲染（Web/IM），agent 进程侧没有第二个应答终端；
  - PTY：`packages/pty-driver` 没有 resolvePermission，审批走终端原生 stdin，不进 runtime 权限 map；`getPendingPermissions()` 对无 resolvePermission 方法的 driver 直接返回 `[]`（`packages/agent-runtime/src/index.ts:1142-1145`），observe 因此**根本不发审批卡**。pty-cli 的 'ask' 模式只能终端批，'full-trust' 无需批（runtime `:619-624`）。
- 重启语义：pending/resolving 重启即 expired 并 PATCH"已失效"（`L/workflow-interactions.ts:54-67`）。
- 卡侧一次性决议、CAS、鉴权（high_risk.execute + 白名单操作者）齐全（respond 链路），grace 不需要新鉴权。

**要做的改动（10s grace，仅 ACP）**。observe 改为：pending 事件到达 → 起 10s 定时器（不发卡）→ 窗口内监听该 request 的 resolution/removed，已被任一端回答或被 agent 撤回则取消；超时再走现有发卡路径。

**成本**：**M**。跨 workflow-interactions 与 coordinator 的事件订阅时序；不碰 runtime 协议（先答先赢已在）。

**风险与回归面**：① grace 窗口内 daemon 重启，pending 卡在重启后 expired——恢复路径必须对"窗口内未发卡"的 pending 补发卡（当前 initialize 只处理有卡记录的）；② 窗口内 request 被 agent 取消的竞态；③ 发卡后 60s waiting 空闲提醒需抑制（竞品 tlive 同款），否则一事项两条通知；④ 分辨率变化（permissionMode 切换）与 grace 定时器的世代围栏。

**PTY 双通道**：要把终端原生权限提示解析进 runtime 权限 map 并双向驱动 stdin（CCBot/tlive hook 路线），pty-driver 大改且依赖 Claude Code PTY 提示格式稳定性——**XL，驳回**；产品姿态上 pty-cli 'ask' 就该在终端答，不要承诺手机能批。

**姿态**：**直接做 10s grace（M，ACP only，可配置可关）**；"永不自动拒绝"维持；PTY 双通道驳回并写明架构原因。

## E3 过程卡详细度三档（off/brief/detailed）——直接做，M（偏小）

**现状**。过程卡已做大量降噪：thinking 永不渲染原文（只计数/"内部分析已完成"）、最近 5 阶段窗口、工具分组折叠、失败灯突出、密钥脱敏、final_output 截断 6000 字（`L/card-renderer.ts` 全文；截断常量 `:850`）；最终答案取 agent 原文，无启发式过滤——已满足竞品"最终答案不过滤"的纪律。

**改动**。在 renderLarkCardElements 增加 view 档位：off（仅状态行 + typing 式静态文案）/brief（现状：工具名+一句话）/detailed（工具参数 + 截断输出）。配置项进 StoredLarkConfig（`L/config.ts` 已有同类归一化位）。

**成本**：**M**（渲染分支 + 配置 + 测试矩阵；24KB/180 组件预算与单槽合并逻辑不动）。

**风险**：detailed 档在大工具输出下触发剥分组逻辑（`L/service.ts:621-668`），需保证"绝不剥成空"规则在新档位仍成立；低。

**姿态**：**直接做**，默认 brief 保持现状。

## E4 CardKit 卡片实体真流式——暂缓，L；先做 PoC 验证移动端收益

**现状（纠正报告口径）**。

- 卡片 config 的 `streaming_mode: state === 'running'` **已经在发**（`L/service.ts:577`；终态 false `:662`，同卡另有 update_multi `:575`）。所以"流式卡片开关"不是差距。
- 但传输层不是真流式：每 `pushIntervalMs`（默认 1000ms，配置被夹在 500–20000ms，`L/config.ts:171,:300,:449`）做一次**全卡 JSON 重渲染 PATCH**（`L/service.ts:769`），由 coordinator 单槽合并 + updateChain 串行化（`L/coordinator.ts:1773-1819,:1864-1871`）。这是"1s 节拍的整卡更新"，不是 CardKit 元素级流式。
- 竞品 LangBot/lark-channel-bridge 用的是 cardkit v1 实体：card create（cardkit:card:write 权限）→ msg_type=interactive 以 `{type:'card',data:{card_id}}` **只发一次** → 元素级 content API 前缀增量，10 次/秒，**10 分钟自动关流式**；流式期间交互回调要更新卡必须先 settings 关 streaming_mode；流式卡不可转发；JSON 2.0、客户端 7.20+（证据 `raw/f_cardstream`）。SDK 1.73.0 已含 `client.cardkit.v1.card` 全套（create/settings/update/batchUpdate/idConvert）。

**成本**：**L**。card_id 实体生命周期（建/发一次/关流降级回普通 PATCH/14 天有效期/重启后 card_id 恢复）、与现有 PATCH 单槽 + 5s 对账 + 终态双卡 + 冻结契约（`L/coordinator.ts:1763-1862`）的整合、24KB 预算路径保留。最大语义冲突：**运行卡带"中断"按钮，而流式期间回调更新卡必须先关流式模式**——取消/中断的交互时序要重设计。

**风险**：7.20 以下客户端呈现（unverified 覆盖率）；不可转发削弱卡片作为历史凭证的可传播性；10 分钟后必须降级，长任务仍回到 PATCH，两套渲染路径长期并存；更新风暴从 1/s 上限放宽到 10/s，反而更容易触发限流。

**姿态**：**暂缓**。前置一个 spike：同内容在移动端对比 1s PATCH 与 CardKit 的体感差异、验证中断按钮时序。桌面端 1s 节拍已流畅，收益主要在手机，未实测前不值得 L。

## E5 Runner/执行端离线显式排队、outcome_unknown——完整形态驳回（架构不允许），恢复注解做 S

**现状**。runtime queued 任务持久化并在重启后重新 scheduleQueue（`packages/agent-runtime/src/index.ts` initialize：running 除 pty-cli recovery 外 interrupted `:275-286`，queued 重新入队）；飞书侧 queued 卡有"正在排队，前面还有 N 个任务"（`L/coordinator.ts:2003-2004`）+ 取消按钮；终态 PATCH 重试 3 次（`:1676`）；文件交付有 CAS 状态机 + 60s 租约 + 不确定不重发的雏形（`L/artifact-delivery.ts`）；结果投递状态持久（final_delivery_state，`L/coordinator.ts:464-473`）。

**核查结论**。OpenTag 的 runner_offline 投影需要一个常驻 control plane 在执行端离线时代发状态。Dutydeck 是本地优先：daemon 与执行端同机，daemon 不跑时飞书侧**没有任何己方进程能发那张卡**——这不是功能缺口，是架构形态差异。要做就得引入 always-on 中继（XL，且违背本地优先）。

**成本/姿态**：完整离线投影 **XL，驳回**。可做的便宜版本（**S，先做小版本**）：daemon 启动恢复后，对 replayed 任务（`:1980` 已有 replayed 标记）在卡上显式注明"守护进程重启期间排队/中断"；审计消息发送不确定路径，确认保持"不确定只补文字、不重放审批/文件"的纪律（基本已具备，差测试固化）。

## E6 云文档评论区 @bot 触发——暂缓待平台 spike，通过后 L

**现状**。无任何相关代码。平台侧：SDK 1.73.0 **含** `drive.notice.comment_add_v1` 事件，normalizeComment 带 fileToken/fileType/commentId/operator/is_mentioned（node-sdk es bundle 实测）；竞品 lark-channel-bridge 已做出但留下明确的坑史：全文评论/选段评论/已有 thread 内 reply 三种落点，回复 API 曾拒发、thread reply 事件曾被 SDK 丢弃（`raw/f_bridge.txt:53-57,:287,:305`）。

**工程映射**（spike 通过后的路径）：

1. listener 注册第三类事件（register 字符串键机制现成，`L/listener.ts:125-155`）；配置器按现有 `operation: 'add'` 模式（`L/open-platform-configurator.ts:91-98`）追加事件订阅。
2. 评论回复 OAPI + 三类评论落点适配（service 新模块，L 的主体之一）。
3. 会话键：`doc:${fileToken}` 与现有 `thread:/user:/message:` 前缀同构（`L/session-resolver.ts:38-45`），sourceId 拼接（`:67-74`）可自然扩展，**会话隔离层可行且便宜**；cwd 路由需要"文档关联项目/回落默认目录"新逻辑。
4. 文档正文读取（docx/drive API + scope + 租户域名 feishu/larksuite）是独立一块，不做的话 agent 只能看到评论文本。

**unverified（必须先平台核查）**：① 该事件在**长连接 mode=4** 自建应用下是否投递（SDK 有 dispatcher 类型不代表长连接已开通；精细化事件文档显示部分新事件仅 agent 身份订阅）；② 所需 drive scope 准确名称与发布审核；③ 评论回复 API 在自建应用下对三类评论是否都可用。

**成本**：**L**（新触发面全链路 + 文档读取 + 测试矩阵）。

**风险**：ACPX 约束——若为文档会话注入环境/选项，持久化键必须 snake_case，且不要把 doc token 塞进 `acpx.session_options.env` 当 UPPER 变量；会话键走 sourceId 即可，不动 session_options。多租户文档权限误判是提权面，评论回复必须校验 is_mentioned 且只回触发文档。

**姿态**：**暂缓，先做 1 天 spike 验①②③**；通过后按 L 立项。差异化卡位价值真实（竞品中仅一家做出）。

## E7 执行中消息：可见队列 / 命令抢占 / 👍 升级 / 多图暂存——拆三个版本直接做

**现状（多数原语已存在）**。

- **串行排队已实现**：普通消息经 group.tail 串行 + runtime `dispatch('queue')` 持久队列（`L/coordinator.ts:1982-1984`，幂等键 `lark:<appId>:<msgId>:<turn>`），每条排队消息有自己的 queued 卡（`:1611,:1625-1627`），卡上显示 queuedAhead 计数（`:2003-2004`）+ 取消按钮。
- **/stop、/new 抢占已实现**：斜杠命令在 `group.tail` 链接之前**内联执行**（`L/coordinator.ts:619`，命令不占轮次不建卡 `:609-617`），/cancel 直接 `runtime.interrupt`（`:816,:809-821`）；/new 有 epoch 防旧轮。
- **👍 升级的 runtime 原语已存在但没接到 IM**：`steerQueued()`（`packages/agent-runtime/src/index.ts:922-933`，排队任务提到队首并终止当前轮）目前只被 Web 用（`apps/server/src/app.ts:222`）；LarkRuntime 接口（`L/listener.ts:23-39`）没有该方法，coordinator 无转调。
- **多图**：同一条 post 富文本里的多图已聚合（`L/message-content.ts`），跨消息无暂存——手机连图是多条独立消息事件，每条各起一轮。

**改动与成本**。

1. **队列聚合可见（S）**：运行卡心跳渲染时从 `runtime.getTasks` 取本 scope queued 列表，附"待执行 N 条"摘要（比现在仅计数多两行摘要）。注意单槽合并与 24KB 预算。
2. **👍 升级（M）**：配置器按 `operation: 'add'` 模式追加订阅 reaction 事件（见 E1）；listener reaction handler 过滤 operator==bot 自身（bot 自己的 OK 回流，`L/listener.ts:151-155` 注释已预警）；emoji 白名单（建议仅 ThumbUp/👍）+ 去重；经 messageId 反查任务（inbox/card mapping 有 messageId）；queued 态→LarkRuntime 暴露 steerQueued 并转调。running 态的"并入本轮"语义 steerQueued 不支持（它是杀轮重排），第一版只支持排队项升级，文案如实。
3. **多图暂存窗口（M）**：per-scope 内存暂存 + 短窗口（建议 1-2s 而非竞品 500ms，飞书事件本身有抖动）等文字，窗口到时无文字也提交；重启不恢复暂存（图片已物化为本地文件 `L/session-resolver.ts:156-173`，丢的只是合批，可接受）。

**风险**：reaction 事件重复投递的幂等；误 steer（白名单解决）；暂存窗口拖慢纯图片任务的首响（必须有上限定时器）。

**姿态**：**三个小版本依次直接做（S→M→M）**。这是被低估的高 ROI 区：原语都在，缺的是接线。

## E8 话题=会话=目录强绑定 / 关闭话题杀任务 / 空闲轮换——大部分暂缓或驳回

**现状**。thread/root 权威路由成熟（`L/session-resolver.ts:189-230`，root_id/thread_id 判据防引用气泡误带）；cwd 走全局 config + `/new --cwd`（scope 内生效）；会话持久 resume 是刻意设计（`session-resolver.ts:333-388`）。

**核查**。

- "关闭话题自动杀任务"依赖话题解散/关闭事件——**平台证据库未见此类事件，unverified**，没有可靠信号源。**驳回**；已有 /new 显式结束 + /stop 覆盖需求。
- 空闲 30 分钟自动轮换（cc-connect reset_on_idle_mins）：M（per-group 定时器、重启后重算、queued 边界），但与本产品"持久会话 + resume + 引用续作"的核心契约冲突，自动丢上下文是投诉高发区。**暂缓**；若要做必须默认关闭、可配置、轮换前在话题内留提示。
- thread 级 workspace 绑定：M，需求未被当前用户痛点证明（主流是单 workspace 配置）。**暂缓**。

**姿态**：**驳回话题关闭联动（平台无信号，标 unverified）；空闲轮换暂缓且默认关；不立项 thread 工作区绑定**。

## E9 多 bot 真 at 接力——@name 改写直接做（M）；两跳强制只约束自家 bot（M）

**现状（纠正报告）**。

- 竞品建议的 (a) 申请 `im:message.group_at_msg.include_bot:readonly`——**配置器已申请**（`L/open-platform-configurator.ts:13`，另有 `:16` group_msg.include_bot:read）。报告/策略文档"要补 scope"对配置器已过时；存量 bot 需 /repair 式重新发布才补权（见 E12）。
- 群工具 `send --to` **已经写真 at**：`<at user_id="${openId|memberId}">名称</at>`（`L/agent-tools.ts:611`），目标解析 peers+members 含重名消歧（`:600-609`）。
- 缺口 1：agent **自由输出**里的 `@名字`不改写——只在工具 send 路径生效；普通回复经 markdown 渲染，@ 是纯文本，对端 bot 收不到唤醒（include_bot 下只有真 at 标签才触发）。
- 缺口 2："一次用户请求最多主动交接两跳"**只存在于提示词**（`L/agent-tools.ts:671`），无服务端强制。

**改动**。

1. @name 改写（**M**）：出站最终文本统一在消息构造前过一道改写器（结果投递与文本消息各一个出口），名称→open_id 解析复用 membersFor/peersFor 缓存；bot 映射优先、真人懒加载匹配；只改精确匹配的 token，邮箱/路径中的 @ 不动；text 与 post 两种消息类型分别出 at 标签。
2. 两跳强制（**M，且只能约束 Dutydeck 自家 agent**）：hop 计数随群工具 HMAC capability 上下文透传（不落 ACPX env），send 工具执行处超限拒绝；异构 bot 不遵守我方头，无法强制——这是分布式事实，产品文案不能承诺"全群两跳"。防自环已有一半（bot 发送者仅被精确 @ 才唤醒，`L/coordinator.ts:557`），需补"不响应自己刚发出消息"的服务端去重，不能只靠 prompt。

**风险**：误 at 真人（重名/歧义→拒绝改写并提示用 openId，沿用 `:607` 的 409 策略）；循环 at 风暴；include_bot 开通后群内他 bot 消息量上升，mentionPolicy 白名单要复测。

**ACPX 约束**：hop 计数走工具调用上下文，禁止写入 `acpx.session_options`；若确需持久化键，snake_case 且不得复用 UPPER_SNAKE 环境名。

**姿态**：**直接做改写（M）与自家两跳闸（M）**；对异构接力只做防环不做承诺。

## E10 卡片表单结构化问答（AskUserQuestion）——单选/多选直接做 M；多问游标暂缓 L

**现状**。ask 卡是 readOnly 橙卡，正文"回复此卡片即可回答"（`L/workflow-interactions.ts:143-145`），/answer 文本兜底；编号已从卡上移除，引用卡片回落（`:134-142`）。

**平台核查（纠正竞品口径）**：表单容器、input、select 是 **JSON 2.0 卡片原生组件**，回调体带 `inputs`（证据 `raw/f_card101.txt:38,:533-544`），**不要求 CardKit 实体**。竞品 LangBot 恰好用 cardkit，但那是它的技术选型不是平台门槛。现有 card.action.trigger 分发可直接承载。

**改动**。ask 事件携带选项时渲染单/多选按钮（或 select），回调经现有 respond CAS 落决议；自由文本问题可用 input 组件（替代"回复此卡片"）。前置核实：runtime 的 relay ask 事件结构是否透传 choices（未在本轮展开，实现前确认 schema，成本定级不变）。

**成本**：单选/多选/input **M**（渲染 + 回调 value 设计 + 复用 workflow CAS/鉴权）；tlive 式多问游标（Question 2/3、Back、末题整批提交）**L**（broker 多问队列持久化 + 游标 + 重启过期 + Skip 放行本地）。

**风险**：回调 3 秒内必须先回 200（现有 toast 模式已合规）；表单卡仅 ACP/relay ask 有意义，PTY 无结构化问题源；移动端 input 体验需真机看。

**姿态**：**直接做单/多选 + input（M）**，顺带消灭粗糙点 1 的 /answer 编号依赖；多问游标暂缓。

## E11 Agent Bus 幂等键 / 落盘后回执 / fan-out 闸门——大部分不适用，只留两件小事

**现状**。`group send` 已支持 `--idempotency-key`（透传至 sendText/replyText，`L/agent-tools.ts:150-151,:582-619`），底层飞书消息 API 用 uuid 去重（`:588` 默认 dutydeck-uuid）；runtime dispatch 有自己的任务幂等键（sha256 原子去重）。work 步骤持久化 + revision CAS 完整。

**核查**。MetaBot Bus 是 RPC 式投递（稳定 session 键 + 幂等 + 四态 + 结果落盘后再回执）；Dutydeck 群协作是**消息传递 + wait 轮询**范式，没有"父任务等子任务结果"的同步链，强抄 Bus 是范式错配。

**姿态**：**驳回 Bus 化**。只保留：① send 幂等键文档化 + 去掉默认随机 uuid 让 agent 重试真正命中同一去重（行为确认项，S）；② fan-out/两跳闸并入 E9。不引入 pre-agent 委派钩子等重机制。

## E12 零配置上手（二维码绑定 / /repair 增量补权 / /upgrade）——大部分已完成，剩 S 自检

**现状**。一键建 bot + 权限/事件/回调配置 + 建版本发布 + 审核状态校验已全流程实现（`L/open-platform-configurator.ts:59-149`，近期 commit 7df4a29/1015251）；二维码登录已在（commit e5f7359/59dc01f）。权限更新本身就是幂等"读目录→更新→回读校验"（`:59-72`）。

**缺口**。存量 bot 新增 scope/事件（如 E9 的 include_bot、E7 的 reaction 事件）后需要一个**一键"修复配置并重新发布"**入口，而不是让用户翻后台——成本 S-M（把 configurator 现有流程包成 CLI/IM 命令 + 发布后的审核态提示）。会话内 /upgrade 依赖部署方式（npm/本地），需求弱。

**姿态**：**不立项二维码/建 bot（已完成）**；做 /repair 式配置修复（S-M，且是 E7/E9 订阅扩容的前置依赖）；/upgrade 暂缓。

## E13 agent 反向发消息（草稿/开关/预算）——暂缓草稿，保留只读开关

**现状**。群工具有 HMAC capability token + 授权流程（GROUP_TOOL_AUTHORIZATION_REQUIREMENT 引导）、allowSend 只读配置（`L/agent-tools.ts` prompt 按 allowSend 分叉）、managed group 角色授权完整。

**核查**。"草稿/待确认卡再让人点发送"= 新交互类型 + CAS + 二次确认（M），但 bot 名义发送的主体没变，草稿只延迟不降噪；真正的误发重灾区（agent 幻觉乱发）靠只读模式 + 白名单已能关死。预算/频控与 api-gate 的 QPS 限流是两层东西，新增每日预算需要持久计数（M），无证据表明当前是痛点。

**姿态**：**暂缓**。保留并文档化只读开关；reaction 状态标注随 E1（暂缓）。

## E14 /work 卡每次点击发新卡 → PATCH 原卡——直接做，M

**现状核实（问题⑤）**。callback 末尾对**被点击的卡 reply 一张全新卡**（`L/workbench.ts:234-237`），幂等键含 messageId+revision+操作（`:236`）；channelMappings 存 messageId + extra{workId,revision} 且回调做完整 CAS（`:225-228`：chatId/workId/sessionId/revision 全对得上才放行）。**幂等、revision、并发闸门都已具备**，不是障碍。

**为什么当初是新卡**：card.action.trigger 必须快速返回，reply 新卡是回调里最省事的响应方式；旧卡 PATCH 需要异步触发。

**改动**。回调先回 toast（"目标状态已更新"现成），随后用 context.messageId 走普通 PATCH 覆盖原卡（service.update 现成，任务卡已用同一机制）；mapping 与 revision 不变；revision CAS 失败（卡已过期）回退为发新卡。注意 work 卡状态变化无推送需求（用户正盯着卡点），PATCH 无红点不是问题。

**成本**：**M**（send 的消息映射分新发/PATCH 两路 + 回调返回值调整 + 点击视口位置用 toast 补反馈 + 幂等键重定）。

**风险**：PATCH 后用户丢失"点击前快照"——卡是状态投影，新卡也不保留历史，语义无损；终态/失败通知若依赖"新消息提醒"会丢，需保留 waiting/状态指纹变化时推新卡的现有规则（`L/workbench.ts:150,:156-161` 审计点 9）。

**姿态**：**直接做（M）**，长目标卡堆是实测最明显的粗糙点，且设施齐全。

## E15 /tasks 行内 approve/cancel/retry + Web 深链——直接做，M

**现状**。每行仅"返回原会话"open_url，且 applink 白名单只放行 applink.feishu.cn/applink.larksuite.com 的 https（`L/task-dashboard.ts:111-112,:147-156`）；翻页 callback 在 `:170-182`，PAGE_SIZE 10。

**改动**。行按钮按任务状态渲染（queued→取消、running→中断、failed/interrupted→重试），action value 带 task_id——**coordinator.handleAction 已按 task_id + turn 分发且带白名单鉴权与 stale 检查**（`L/coordinator.ts:1146-1290`，`:1215-1228`），dashboard 复用同一回调通道即可，无需新鉴权。行内 approve 仅对带 pending permission 的任务行（数据来自 getTasks + getPendingPermissions，渲染时拼装）。操作后重渲染当前页（翻页是 PATCH 同卡机制）。Web 深链用 E18 的 safeLarkWebUrl 同款校验加一个 open_url。

**成本**：**M**（渲染行按钮 + action 路由复用 + 操作后页内状态刷新 + 组件预算：10 行 ×（列+摘要+2 按钮）约 60-75 元素，180 预算内）。

**风险**：列表快照过期导致死按钮——现有 stale/终态检查已回 toast 兜底，可接受；行 approve 绕过审批卡 CAS？必须复用 workflow-interactions.respond 而不是直接 resolvePermission（保持一次性决议与审计链）。

**姿态**：**直接做（M）**。与 E14/E10 同属"消灭手敲编号"的高 ROI 组。

## E16 /help 翻页按钮——直接做，S

**现状**。/help 是 markdown 卡（`L/commands.ts:388-445`，header/body/footer 三元素，6 条/页），翻页只能手打 `/help 2`（`:430-433`）。能力门隐藏逻辑现成（`:241-248`）。

**改动**：footer 加"上一页/下一页"callback 按钮（新 action `help_page`，card.action.trigger 已注册），只读操作走通用白名单；页码夹边界。S。

**姿态**：**直接做**。

## E17 移动端按钮尺寸 + 手机终端可用性——尺寸直接做 S；PTY 手机化驳回 XL

**现状（问题⑩）**。进度卡按钮统一 `size:'small'`（`L/card-actions.ts:234`，全仓唯一显式 size）；workbench（`:31`）、workflow（`workflow-interactions.ts:31`）、dashboard（`:150,:178`）的按钮**都没设 size，即飞书默认尺寸**——默认尺寸在线上三类卡已长期可用，这是已验证事实；尺寸枚举全集（tiny/medium/large 的确切取值）平台证据库未检索到，**标 unverified（查官方卡片按钮文档确认，不影响实施）**。

**改动**。进度卡主操作（中断/重试/取消）删掉 `size:'small'` 走默认尺寸；若将来要"大号主按钮"再按文档枚举加。桌面密度影响：每状态最多 2 个按钮（`larkCardActionBudget.maxButtons`），默认尺寸可接受。S。

**手机端 PTY**（/work terminal|input|key 长命令，`L/workbench.ts:188-194`）：要做好等于 tlive 的 xterm.js 共享 PTY + 软键盘工具条，XL 且与飞书面无关（是 Web 终端工程）。**驳回在飞书内解决**；手机端覆盖审批/问答即可（E2/E10），终端原生交互本就不该在手机做。

**姿态**：**按钮尺寸直接做（S）**；PTY 手机化驳回。

## E18 Web 深链覆盖与"无 webBaseUrl 兜底"——补覆盖（S，随 E15），兜底驳回

**现状（问题⑨，修正盘点口径）**。

- 唯一通用出口是页脚"查看详情"，自带协议校验 safeLarkWebUrl，未配置 webBaseUrl 时整行不渲染（`L/service.ts:415-427`）；card-actions 刻意不重复渲染同去向按钮（`:245-253` 注释）。
- **/work 卡其实有 Web 出口**：workbench.send 透传了 webBaseUrl（`L/workbench.ts:121`），走同一 buildLarkCard 入口即自动带页脚。盘点粗糙点 6 说"/work 卡无链接"**不成立**。
- **审批/问答卡确实没有**：`L/workflow-interactions.ts:150-153` 的 reply 参数未传 webBaseUrl，且这类卡 readOnly。
- /tasks 行无 Web 链接（`:147-156`，随 E15 补）。

**关于兜底**。本地优先架构下 webBaseUrl 指向用户自己的 daemon Web，未配置或只绑 localhost 时手机必然不可达——**不存在一个有意义的"默认公网兜底地址"**，补一个注定打不开的按钮正是 `card-actions.ts:249-253` 注释拒绝的事。可做的是配置侧健康检查：webBaseUrl 留空时在设置 UI/启动日志明确提示"卡片将无 Web 出口"（S，配置 UX，不是卡片侧兜底）。

**姿态**：**审批/问答卡补传 webBaseUrl（S）+ E15 行链接**；**驳回卡片侧兜底**，改做配置提示（S）。

## E19 文件型结果的验收状态——reaction 标注，S，直接做

**现状**。文件消息平台侧不可 PATCH；现状是验收状态进回执卡与任务列表，原文件不变（`L/coordinator.ts:469-473` 英文注释明确）；result-delivery 在有验收按钮时往 `执行结果.md` 里追加指引文本（`L/result-delivery.ts:19-21`）。

**改动**。验收终态后对原文件消息 addReaction（✅/📝），复用 E1 同一套 API 与限流；映射存 mapping.extra（result_feedback_state 已持久化，`:466`），重启对账可幂等补发（先 list reactions 或容忍重复——reaction API 幂等行为 unverified，建议先查后写）。S。

**风险**：reaction API 对文件型消息是否可用（文件消息也是 om_ 普通消息，预期可用，**实测确认，标 unverified**）；重复打表情。

**姿态**：**直接做（S）**，不要试图让文件消息本身可变。

## E20 群内操作者归属 + agent 显示名——直接做，S-M

**现状**。白名单内任何人可取消/重试他人任务是刻意设计（`L/coordinator.ts:1215-1224` 注释：保证 AI 协作链中人能干预），但卡上不显示操作者；work 卡步骤直接印原始 agentId（`L/workbench.ts:40`），而 LarkRuntime.listAgents 已能提供 name（`L/listener.ts:25` 可选方法）。

**改动**。① agentId→name 解析渲染（S，peers/listAgents 已有数据源）；② 操作者注记：回调带 operatorOpenId，中断/取消/重试后在状态行写"由 X 操作"（M：操作者要进 task 事件/持久字段才能扛心跳重绘与重启，runtime.interrupt 已有 actorId 参数可承接）。

**姿态**：**直接做（S 先做 agent 名，M 做操作者归属）**。

## E21 通知粒度——建议维持现状，不立项

终态靠独立结果新消息提醒、过程靠 PATCH 不打扰（`L/coordinator.ts:1823-1842`，docs/product-1.0.md:61 明说 PATCH 不提醒）；/work 只在 waiting 或状态指纹变化时推新卡（`L/workbench.ts:150,:156-161`）。竞品里最吵的事故（每个 chunk 点亮手机）现有架构天然免疫。唯一变量是 E1 的 done reaction 通知语义（unverified），在验证前不改通知模型。

**姿态**：**维持**。

## E22 会话切换器与卡片稀释——切换器暂缓 M；卡稀释主要靠 E14/E16

**现状**。切换上下文靠 /new（会 stop 旧会话）+ /tasks；命令回执是新卡。持久会话查询能力齐全（findPersistedLarkSession/listPersistedLarkSessions，`L/session-resolver.ts:255-287`），但 resolveLarkSession 总是选最近可复用会话，没有"显式固定到某条 session"的绑定态。

**改动**。飞书内会话切换器 = 列表卡 + "切换"按钮 + 新的 pinned 绑定（持久化 + /new 解绑 + 配置变更兼容性重走 `:333-348` 那套），M-L。卡稀释的主要源头是 /work 新卡（E14 解决）和 /help（E16），命令即时回执保留新消息形态有通知价值，不动。

**姿态**：**切换器暂缓（M，先观察 E15 行操作落地后是否还痛）**；不为"卡稀释"再立项目。

## E23 未知命令"你是不是想用"——直接做，S

**现状**。未识别 /xxx 刻意包裹 `[Dutydeck 非命令原文]` 透传给 agent，防路径误判（`L/commands.ts:274-278,:74-79`）。

**改动**。仅当输入与某条已注册且当前可用（过能力门）命令编辑距离 ≤2 或前缀匹配时，在透传任务卡/回执里附一行"你是不是想用 /xxx？"，**不阻断、不改写**透传。S。

**风险**：路径 `/usr/...` 与命令几乎不会编辑距离 ≤2，天然安全；阈值要保守。

**姿态**：**直接做**。

## E24 欢迎语 + bot 菜单——欢迎直接做 S；菜单用"发消息"型先做小版本 M

**现状（问题⑦）**。listener 只注册三类事件（`L/listener.ts:125-156`）；全仓无菜单配置；无欢迎语。SDK 1.73.0 含 `im.chat.member.bot.added_v1` 事件键（node-sdk bundle 实测），但配置器只订阅 receive_v1。平台菜单证据（`raw/f_botmenuapi`、`raw/f_botmenuprd`）：菜单经 application-v7 application-ability PATCH 配置（bot_menu_enable/bot_menus），点击事件 `application.bot.menu_v6`——**该事件键在 SDK 1.73.0 不存在，长连接下 register 自定义键能否收到未实测（unverified）**；但菜单动作有四类（跳转链接/触发事件/展开子菜单/**发送消息**），"发送消息"型点击后等价于用户发出一条预定义文本，走现有 receive_v1 + 命令解析，**完全绕开菜单事件缺口**。菜单项配置随应用版本发布审核（与 configurator 现有发布流程衔接）。

**改动**。

1. 欢迎语（S-M）：注册 bot.added 事件发群欢迎（配置器按 `operation: 'add'` 模式追加订阅）；私聊首条欢迎用持久化"已欢迎 chat"标记（config/inbox store），避免每条消息判一次。
2. 菜单（M，小版本）：用"发消息"型放 5 个高频命令（/tasks、/new、/help、/status、/work），OAPI 配置接进 configurator 发布链；悬浮两级各 5 个上限足够。切换类 Switch 组件是灰度 PRD（`raw/f_botmenuprd` 标注 v0.1 草稿、千人千面 API 灰度中），**不碰**。

**风险**：菜单 OAPI 在长连接自建应用的可用性 + 是否随版本审核（unverified，spike 项，但比 E6 便宜——失败就回退纯命令）；欢迎语在大群刷屏风险（只在 bot 被拉入时一次）；竞品 0 家用菜单是参考信息不是否决理由——本产品有 12 条命令，菜单降记忆负担的价值比那些项目真实。

**姿态**：**欢迎语直接做（S-M）**；菜单做"发消息"型小版本（M），事件型菜单待 SDK/平台验证后再说。

---

## 平台能力核查附注（回答证据边界，均影响立项排序）

| 能力 | 核查结论 | 对项目的含义 |
|---|---|---|
| reaction 变更的移动端通知 | **unverified**：平台证据库无文档；仅 cc-connect README 断言 done 表情能推送 | E1 不把通知职责迁给 reaction，先真机测 |
| 话题关闭/解散事件 | **unverified**：证据库无此事件 | E8 关闭话题杀任务驳回 |
| `application.bot.menu_v6` | SDK 1.73.0 无此键；菜单 OAPI 有文档 | E24 用"发消息"型菜单绕开 |
| drive.notice.comment_add_v1 长连接投递 + scope + 回复 API | SDK 有事件类型，投递/权限/回复三点 **unverified** | E6 先 spike |
| 卡片按钮 size 枚举全集 | **unverified**；默认尺寸（不设 size）已在线上验证 | E17 直接删 small 即可 |
| reaction 对文件消息可用性/幂等 | **unverified**，预期同普通消息 | E19 先实测 |
| 消息加急 urgent_app/sms/phone | OAPI 在 SDK 中存在（im/v1/messages/:id/urgent_*）；竞品 0 用；信噪比治理文档显示加急人数受平台限额管控 | 不立项。审批催办的收益被 E2 grace 覆盖，且加急是打扰重灾区 |
| 群置顶 pin | OAPI 在 SDK 中存在（im/v1/pins） | 暂缓：pin 是群级共享资源，管理/取消权限复杂，queued 卡生命周期短，收益低 |
| url.preview.get | SDK 无此键；需公网回调 + URL 规则注册审批，3 秒返回 | 与本地优先架构冲突，**驳回** |
| H5 网页应用免登 | 平台支持完整（JSAPI 免登，raw/f_webapp），但是独立大工程 | Web 控制台已存在，嵌入飞书工作台是分发话题，XL，暂缓 |
| 群内"仅某人可见"临时卡 | 仅服务台（helpdesk）场景接口，需 helpdesk_id（raw/f_ephemeral）；通用延时卡 open_ids 独享**仅 JSON 1.0 + update_multi:false**（raw/f_carddelay），与现有 JSON 2.0 + update_multi:true 栈（service.ts:575）不兼容 | 两条路都**驳回**，不要规划"群内私密卡" |
| CardKit 流式 | SDK/文档齐全，规则苛刻（10 分钟自动关流、回调更新须先关流式、不可转发、14 天有效、7.20+） | 见 E4，L，暂缓 |

## 报告与代码不符清单（供修正上游报告）

1. **"流式卡片是差距"不准确**：`config.streaming_mode` 已按 running 态开关在发（`L/service.ts:577`）；差距只在 CardKit 元素级流式，不在开关。
2. **"要补 include_bot scope"已过时**：配置器 scope 列表已含两个 include_bot 权限（`L/open-platform-configurator.ts:13,:16`）；缺的是存量 bot 重新发布（E12 /repair）。
3. **"审批无本地/IM 先答先赢"不准确**：ACP 下 IM↔Web 先答先赢已实现（runtime `:1147-1184`）；真正的事实是 ACP 无终端通道、PTY 无 IM 通道，双通道在协议层互斥。
4. **"没有审批宽限/会自动拒绝"**：无宽限属实；但**现状本来就永不自动拒绝**，无任何超时 deny 逻辑。
5. **"/work 卡无 Web 链接"不成立**：workbench 透传了 webBaseUrl（`L/workbench.ts:121`），页脚自动渲染；真正缺链接的是审批/问答卡（`L/workflow-interactions.ts:150-153`）。
6. **"卡片表单需要 cardkit v1"是误读**：表单容器/input/select 是 JSON 2.0 原生组件（raw/f_card101），现有卡栈可用。
7. **"执行期消息如何排队语义未见产品化"**：串行队列 + queued 卡 + 取消 + /stop 内联抢占均已实现（`L/coordinator.ts:619,:816,:1982,:2003`）；缺的是队列聚合渲染、👍 接线（runtime steerQueued 已有）、跨消息多图窗口。
8. **"两跳只靠提示词"属实**（`L/agent-tools.ts:671`），但要补充：服务端强制也只能约束 Dutydeck 自家 agent，异构 bot 无协议可强制。
9. **"零配置建 bot 是最大门槛"已被近期工作解决大半**：一键建 bot/发布/校验/扫码登录均在仓库中，剩下的是 /repair 式增量补权。
10. **盘点粗糙点 1 说 /answer 无编号无法回答**：引用卡片回复的回落路径已实现（`L/workflow-interactions.ts:134-142`），痛的是发现不了这条路径——E10 表单化是正解。

## 建议实施顺序（按 ROI/风险）

1. **S 批（单模块、立竿见影）**：E16 help 翻页、E23 未知命令提示、E17 按钮默认尺寸、E19 文件验收 reaction、E20 agent 显示名、E7-1 队列聚合摘要、E18 审批卡补 webBaseUrl、E5 恢复注解。
2. **M 批（跨模块、边界清晰）**：E14 /work 卡 PATCH、E15 /tasks 行操作、E10 表单问答、E7-2 👍 steer、E7-3 多图窗口、E9 真 at 改写 + 自家两跳闸、E2 ACP 审批 10s grace、E3 过程卡三档、E24 欢迎语 + "发消息"型菜单、E12 /repair 配置修复（是 E7/E9/E24 订阅扩容的前置，应提前）。
3. **spike 后再定**：E4 CardKit（移动端体感 PoC）、E6 云文档评论（长连接投递/scope/回复三点验证）。
4. **驳回/暂缓（敢说的部分）**：E5 常驻离线投影（本地优先架构无对端，XL）、E8 话题关闭联动（平台无事件）、E17 PTY 手机化（XL）、E11 Bus 化（范式错配）、独享/临时卡（JSON 1.0-only/服务台限定）、url.preview（需公网回调）、E22 切换器（先看 E15 后是否还痛）、E13 草稿卡（痛点未证实）。
