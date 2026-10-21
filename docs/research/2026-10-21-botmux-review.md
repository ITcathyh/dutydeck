# Botmux 增量审查：先补结果交付与状态一致性

日期：2026-10-21。对照 Dutydeck `97f0275b568790097c1c04ce29bdd2b4d6799d47`，审查 Botmux 从 `81f97825126938f5ad50d5354062eb937bcb6768` 到 `6025e5a8f8276a94889307240df02c44f310ce0f` 的增量。

**优先吸收四项：回答后写 memory 仍保留业务正文、用原生事件识别后台任务、统一卡片回调解析、SSE 静默断流恢复。** 四项都找到当前 Dutydeck 的具体缺口，并用隔离探针复现了相应解析或渲染行为。随后补 Unix socket 长路径处理、relay 的 stderr 初始化，以及 Codex 容量错误分类。

不建议整批 cherry-pick。Dutydeck 已有独立的执行账本、恢复协调、最终答复投递、Agent 配置和记忆机制。Botmux 的 worker、主副本、完整沙箱及模板下发系统，与这些实现的边界不同。值得引入的产品增量是受控插件结果、周期任务自停和自定义最终卡片；它们应单独设计，不能混入可靠性补丁。

本次只做分析。Botmux 已 rebase 到上述上游版本，ahead/behind 为 `0/0`；Dutydeck 未改功能代码、未部署，也未操作线上会话。共筛查 **125 条提交记录，124 条 first-parent 提交**。对核心候选读取实现 diff、相关测试并交叉检查 Dutydeck；其余仅做变更面筛选，**不宣称 125 条均已逐文件深审**。实际验证为 21 份现有测试、354 项通过，以及四个隔离探针脚本。

## 一、建议先做的四项

| 顺序 | 用户遇到的问题 | 当前证据 | 最小融入范围 | 复杂度估计 |
|---|---|---|---|---|
| 1 | Agent 已写完整答案，结果卡只剩“我记下了……” | 真实结果卡渲染器复现正文未进入最终卡 | 结果提取层识别有证据的 memory 后处理；不放宽全部工具前文本 | 中 |
| 2 | 主回合结束时，仍运行的 Agent/Bash 未被结构化计数识别 | 上游真实格式样本中有两个后台启动，当前 tailer 计数为 0 | Claude 后台任务生命周期集合，兼容旧字段；主回合与后台状态分开 | 中 |
| 3 | 某些表单卡提交后动作丢失 | 当前 listener 的字符串 value 被展开成字符索引对象 | 入口先解析，再合并 form；各路由共用解析结果 | 小 |
| 4 | Web 页面停在旧状态；旧流回调干扰新连接 | 现有 SSE 无静默看门狗；探针复现旧流投递、重复 error 多连 | 可观测心跳、连接代次校验、幂等重连、后台挂起与恢复校准 | 中 |

### 1. 最终卡片应保留 memory 后处理前的答案

参考 [1d7dbbfe3](https://github.com/deepcoldy/botmux/commit/1d7dbbfe3)。典型顺序是：模型给出业务结论 → 写入自身 memory → 补一句“另外，我保存了两条记忆”。上游修复从 transcript 取最终文本时跨过已识别的 memory 工具调用，合并正文与后记，并保留正文长度和尾哨兵等约束。正文至少 200 字且长于后记只是上游启发式，不能单独证明它就是最终答案。

Dutydeck 的原始正文仍在事件账本里，runtime 摘要也会拼接正文。问题出在最终卡片选择：[apps/server/src/lark/card-renderer.ts:1119](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/card-renderer.ts:1119) 取最后一条 text，并要求它位于所有活动之后；`:1129` 生成 finalText，`:1223` 默认隐藏过程。实时结果的 [coordinator-dispatch.ts:1315](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/coordinator-dispatch.ts:1315) 与重启对账的 [reconciler.ts:415](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/reconciler.ts:415) 都经过这段代码。人工核对后的 verifiedOutput 是另一条路径，不能替普通结果补正文。

隔离探针用合成的归一化事件给真实 `renderLarkResultElements` 输入“300 多字正文 → Write memory → tool_result → 短后记”，最终卡只含后记，`result_contains_answer=false`。这证明最终呈现缺口，**不代表原始事件数据已丢失，也不是线上发生频率的测量**。

最小改法是在结果提取处保留有明确来源证据的主回答。优先使用 Claude 原生工具类型、确切 Write/Edit 路径与 tool_use_id 配对；不要照搬“Bash 命令提到 memory 路径就视为后处理”的宽泛判断。普通业务文件写入、工具执行前的计划、跨任务旧文本都不能因此成为最终结论。是否允许“写完 memory 后没有后记”的正文作为结果，需要明确契约，不能顺手放宽 runtime 终态。

验收应贯穿脱敏原生 transcript、tailer、runtime events 和结果卡，覆盖 memory 后记、有无尾文、业务 Write 反例、显式最终答复以及重启对账。运行 card-renderer、coordinator、reconciler 相关测试和 smoke。改动位置集中，难点是证明哪段正文属于本轮最终答案。

### 2. 后台计数要跟随任务生命周期

参考 [f89419093](https://github.com/deepcoldy/botmux/commit/f89419093)。上游按任务 ID 跟踪 Agent、Bash 和 Monitor，读取启动结果与完成、停止通知；卡片明确显示“主回合已结束，后台子任务仍在运行”。非持久 Monitor 还有超时边界。

Dutydeck [packages/pty-driver/src/transcript/claude.ts:330](/data00/home/huangyuhang.edu/ai/dutydeck/packages/pty-driver/src/transcript/claude.ts:330) 目前从 `system/turn_duration` 读取 pendingBackgroundAgentCount/pendingWorkflowCount，缺字段按 0 处理；`:455` 写入 backgroundWork。[packages/pty-driver/src/driver.ts:1730](/data00/home/huangyuhang.edu/ai/dutydeck/packages/pty-driver/src/driver.ts:1730) 结合屏幕 waiting 文本或该计数延迟完成，并保留一小时上限和中断放行。

本次读取上游新增的 `test/fixtures/claude-background-tasks/before-clear.jsonl` 前 7 条，包含 Agent 和 Bash 的两个成功异步启动，以及没有旧计数字段的 turn_duration。当前真实 `ClaudeTranscriptTailer` 返回 `background_after_agent_and_bash_launch=0`。这是确认的结构化解析缺口；**完整飞书卡片是否在某次真实 CLI 会话中提前显示完成仍为 unverified**，因为屏幕 waiting 可能补救部分情况。

建议在 Claude tailer 内增加按 ID 跟踪的生命周期集合，同时兼容旧计数。不要只把新增数量接到现有“有后台任务就暂不完成”的条件：长期 Monitor 或 shell 可以跨用户轮次存在，不能让主任务因此挂一小时。应区分主回答已经交付、等待必要子任务才能形成答案，以及仅有独立后台工作三种情况；后台结果需要绑定原任务或明确作为后续事件处理。

验收样本需包含重复完成通知、TaskStop 没有对应通知、Monitor 更新不算结束、Monitor 到期、clear 与重启、下一条用户输入，以及旧计数字段。除了 parser 单测，还要验证 driver 终态与卡片/Web 的状态一致。

### 3. 卡片入口先解析 value，再合并表单

参考 [7d0a0d7e5](https://github.com/deepcoldy/botmux/commit/7d0a0d7e5)。Dutydeck [apps/server/src/lark/listener.ts:326](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/listener.ts:326) 直接取 `event.action.value`，随后把它与 form_value 展开合并。当 value 是 JSON 字符串时，展开得到数字字符键，action、task_id 等路由字段消失。

下游并非完全不支持字符串：[apps/server/src/lark/card-actions.ts:652](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/card-actions.ts:652) 和 [card-action-forwarding.ts:31](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/card-action-forwarding.ts:31) 都有解析；但字符串已经变成字符索引对象，后续解析无法补救。[event-pipeline.ts:65](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/event-pipeline.ts:65) 只为分类解析 value，不改写传给 listener 的事件。

源码接线探针确认“对象 value + 表单”保留动作，“字符串 value + 表单”丢 action 和 task_id。上游还兼容 `{event,header}` 包装和 Card 2.0 `behaviors[].value`。这两种形态在当前隔离探针也失败，但 **真实 SDK 是否把它们原样交给注册 handler 尚未验证**，应分别列为兼容项，不能都描述成已发生的生产故障。

最小改法是复用已有解析函数，在接入入口归一成普通对象后再合并 form。内置动作分类、外部转发、去重和最终 handler 共用同一结果。operator、chat、message 等身份继续来自可信事件；显式 action.value 畸形时不能随意回退到 behavior，改变用户点击的动作语义。

验收在 mock SDK 注册的真实 listener callback 上覆盖 object/string × 有无 form，选单、多选、自由文本和确认卡；同时验证恶意 value.operator 无法覆盖真实操作者、内置动作不被外部 handler 抢走、重复 event_id 只执行一次。诊断若增加，只记录字段类型和受控动作名，不记录原始表单、token 或整份回调。

### 4. SSE 既要能恢复，也要认出旧连接

参考 [6f7182642](https://github.com/deepcoldy/botmux/commit/6f7182642)。上游把后台标签页的长连接挂起，恢复前台时重新对账；对已证明实时送达的心跳流设置看门狗，避免代理静默断流后浏览器仍显示 OPEN。其测试同时覆盖缓冲代理，防止把批量释放心跳的正常链路反复关闭。

Dutydeck [apps/web/src/sse.ts:123](/data00/home/huangyuhang.edu/ai/dutydeck/apps/web/src/sse.ts:123) 仅在 onerror 时手动退避重连，没有静默断流检测。`:129` 和 `:134` 只检查整个 SessionStream 是否 closed，没有检查回调是否属于当前 source；`:140` 给所有 source 共用 receive，`:144` 甚至不检查关闭状态。服务端 [apps/server/src/app.ts:619](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/app.ts:619) 每 15 秒发的是注释心跳 `: heartbeat`，浏览器 EventSource 不把它交给监听器，客户端不能直接拿它计时。

真实类转译后的隔离探针测得：静默 open 后没有 timer；已 close 的旧 source 迟到 text 仍进入 onEvent；旧 source 连续两次 error 后创建了 3 条 source，其中 2 条仍 open。后两项证明状态机缺少保护；**真实浏览器产生这些时序的频率、生产反代是否静默断流、HTTP/1.1 连接是否被占满，均未实测**。

Dutydeck 已有可靠的恢复基础：[apps/web/src/useSessionStream.ts:75](/data00/home/huangyuhang.edu/ai/dutydeck/apps/web/src/useSessionStream.ts:75) 在 open 后补事件、tasks 和 sessions，有 sequence gap 时分页追赶。应保留这些机制，不搬上游全局 store 和 Bot roster 摘要。最小改动包括：

- 服务端新增命名心跳，带服务端时间戳，不占业务事件 sequence，也不写事件账本。
- source/generation 校验覆盖 event、open、error；同一失败只排一个 timer，旧回调无副作用。
- 依据同源心跳的到达节奏判断实时性，再启用 stale 检测，避免误杀缓冲代理。
- 后台延时挂起，前台恢复立即补查，再保留 open 时的校准；React cleanup 清 timer 和 visibility 监听。

验收需覆盖持续心跳、静默流、批量代理、隐藏期间不重连、前台补事件、旧 source 的所有迟到回调、重复 error 和组件卸载。现有 23 项 Web 测试通过，说明本次发现的是已有覆盖外的组合。改到 Web 主流程后还需 smoke。

这一看门狗有适用边界：上游初始 realtime=false，0 帧或仅 1 帧心跳不足以启用检测。因此它只修复已建立实时心跳后发生的断流；首连一直静默或长期缓冲仍需靠独立快照校准，不能宣称所有静默连接都能自动恢复。

## 二、随后补小范围可靠性改进

### 长 TMPDIR 已在 tmux 采集器上复现

参考 [ad545ca54](https://github.com/deepcoldy/botmux/commit/ad545ca54)。上游原问题发生在 MCP Unix socket；Dutydeck 没有同一个网关，但 [packages/session-backends/src/tmux-capture.ts:45](/data00/home/huangyuhang.edu/ai/dutydeck/packages/session-backends/src/tmux-capture.ts:45) 直接在当前 tmpdir 下创建长前缀目录，`:47` 拼出 out.sock，`:75` 在 listen callback 直接 chmod。[tmux-backend.ts:580](/data00/home/huangyuhang.edu/ai/dutydeck/packages/session-backends/src/tmux-backend.ts:580) 创建采集器，`:591` 等待监听。

在本机 Linux 隔离执行真实 TmuxCapture，65 字节 socket 路径正常监听，151 字节路径触发 callback 的 `uncaught ENOENT`。测试只创建临时 Unix socket，关闭后删除自建目录，未启动 tmux 或产品服务。**这不是 macOS EINVAL 的复现；macOS 仍待验。**

建议为 socket 选择短且受控的根目录，按字节预算处理路径，保留 mkdtemp 独占 0700 目录与 0600 socket。同步调整 `cleanAbandonedTmuxCapture` 当前“父目录必须等于 tmpdir”的安全规则，并使监听后初始化失败走 reject 和资源回收。无需引入上游整个 session TMPDIR 生命周期。

验收包含短/长/非 ASCII TMPDIR、监听和 chmod 失败、收发与关闭、旧目录清理的 owner/PID/权限校验。复杂度估计低到中。

### relay 预热 stderr 改动小，macOS 必须单独验证

参考 [d7c65f0d6](https://github.com/deepcoldy/botmux/commit/d7c65f0d6)。上游在 tty 还存活的初始化阶段执行 `void process.stderr`，避免 tmux 关窗后才懒初始化 stderr、影响退出升级。Dutydeck 的 [packages/session-backends/src/program-status-relay.ts:36](/data00/home/huangyuhang.edu/ai/dutydeck/packages/session-backends/src/program-status-relay.ts:36) 只初始化 stdin/stdout，stderr 出现在错误分支；正常发布入口 [program-status-launch.ts:5](/data00/home/huangyuhang.edu/ai/dutydeck/packages/session-backends/src/program-status-launch.ts:5) 使用 plain node，存在与上游相同的代码形态。10/17 第三方声明也确认该 relay 的派生关系。

建议只在初始化处预热 stderr，不更改关闭策略。测试必须用 plain node 的构建产物和私有 tmux socket，让子进程忽略 SIGHUP，关 pane 后确认 relay 与子进程都消失。tsx 可能预先触碰 stderr，掩盖原问题。本次未在 macOS 复现，**平台触发 unverified**；Linux 验证只能证明不回归。复杂度估计小，验证成本主要在 macOS。

### 先区分 Codex capacity，再考虑自动续跑

参考 [bbd4b3a23](https://github.com/deepcoldy/botmux/commit/bbd4b3a23)。当前 [packages/pty-driver/src/transcript/native-turn.ts:80](/data00/home/huangyuhang.edu/ai/dutydeck/packages/pty-driver/src/transcript/native-turn.ts:80) 把 `ServerOverloaded` / “Selected model is at capacity” 归为 `native_task_failed,retryable:false`，隔离探针已复现。可以先补精确分类和用户提示，不能把所有 429、5xx、鉴权或额度错误一起重试。

自动续跑涉及新的执行 attempt。Dutydeck [packages/agent-runtime/src/index.ts:1388](/data00/home/huangyuhang.edu/ai/dutydeck/packages/agent-runtime/src/index.ts:1388)、`:1489` 已有恢复账本，应复用，并在退避后重新检查 stop、新输入、原 actor 和当前权限。不要另设一个 timer 直接 send。分类复杂度估计小；可靠自动续跑估计大，建议拆开。

另有 [b1fc8a2b3](https://github.com/deepcoldy/botmux/commit/b1fc8a2b3) 的 Codex 模型迁移菜单处理值得后排。当前 [screen-ready-helper.ts:109](/data00/home/huangyuhang.edu/ai/dutydeck/packages/cli-adapters/src/adapters/screen-ready-helper.ts:109) 会拒绝编号选项菜单，探针返回 `migration_picker_ready=false`，因此没有证明上游“首条消息被菜单吞掉”的同形故障。差距是自动选择 Use existing model 并重新等待 composer，能减少首轮超时。必须基于明确菜单和权威视口，未知画面保留人工处理，不能自动切到新模型。

## 三、现有能力应继续复用

| 上游变化 | Dutydeck 当前实现与证据 | 融入判断 |
|---|---|---|
| [43ad2b429](https://github.com/deepcoldy/botmux/commit/43ad2b429) node-pty 修 macOS fd 泄漏 | session-backends、transports 与 lock 已是 1.2.0-beta.15 | 不重复升级；不表示 relay stderr 已修 |
| [8eff34345](https://github.com/deepcoldy/botmux/commit/8eff34345) 超大恢复历史限额 | [transcript/tail.ts:112](/data00/home/huangyuhang.edu/ai/dutydeck/packages/pty-driver/src/transcript/tail.ts:112) 分块读取，`:116` 限单记录，`:424` 有界读取；tail-budget 11 项通过 | 已覆盖目标，不换成超限跳 EOF 丢历史 |
| [757b43dc1](https://github.com/deepcoldy/botmux/commit/757b43dc1)、[fc2db0bba](https://github.com/deepcoldy/botmux/commit/fc2db0bba) 重启与外部恢复 | runtime [index.ts:3071](/data00/home/huangyuhang.edu/ai/dutydeck/packages/agent-runtime/src/index.ts:3071) 管 transition/stop/replace/reconnect；恢复绑定原 attempt/resource/submission；额外 39 项恢复测试通过 | 借竞态测试场景，不搬另一套 workerReady IPC/看门狗状态机 |
| [db667c629](https://github.com/deepcoldy/botmux/commit/db667c629)、[6b0f60fda](https://github.com/deepcoldy/botmux/commit/6b0f60fda) tmux 身份与测试隔离 | [tmux-backend.ts:111](/data00/home/huangyuhang.edu/ai/dutydeck/packages/session-backends/src/tmux-backend.ts:111) 区分冷启动缺 socket，`:423` attach 前验归属，`:669` 核 marker；私有 tmux 身份测试通过 | 不替换当前物理身份与 owner 证明；新增测试继续使用独立 socket |
| [3295fbf16](https://github.com/deepcoldy/botmux/commit/3295fbf16) 唯一最终答复 | [agent-tools.ts:1152](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/agent-tools.ts:1152) 的 send --final 绑定 task/attempt，[explicit-final.ts:18](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/explicit-final.ts:18) 起持久化去重和恢复，47 项通过 | 唯一最终答复已具备；完整自定义卡 JSON 是另一个增量 |
| [25b3a6383](https://github.com/deepcoldy/botmux/commit/25b3a6383) 合并转发话题 | [task-context.ts:470](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/task-context.ts:470) 展开 merge_forward，实际调用在 [coordinator-dispatch.ts:1039](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/coordinator-dispatch.ts:1039)；36 项上下文测试通过 | 列表占位是设计选择，不能误判为不支持 |
| [be4853282](https://github.com/deepcoldy/botmux/commit/be4853282) 持久提醒 | [agent-tools.ts:1475](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/agent-tools.ts:1475) 指向 schedule create，[agent-schedule-request.ts:42](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/agent-schedule-request.ts:42) 先持久化停用计划再确认启用 | 不新增另一种定时体系 |
| [8139885f8](https://github.com/deepcoldy/botmux/commit/8139885f8) 原生 Slash 注册 | [app-creation.ts:295](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/app-creation.ts:295) 已在权限满足时同步；相关权限和 repair 用例存在，本次未运行该注册用例 | 核心能力已有，不重复做 |
| [dcd40a41a](https://github.com/deepcoldy/botmux/commit/dcd40a41a)、[1b8734655](https://github.com/deepcoldy/botmux/commit/1b8734655) Bot-Agent 配置 | Bot 引用独立 Agent；[agent-model-settings.ts:19](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/agent-model-settings.ts:19) 有共享与 bot 作用域，`:53` 合并 PATCH，`:73` 保留 agent 的 command/args/env | 不引入 agents.json 模板再物化到 Bot 的第二配置层；关系图可以以后独立做 |
| [46171f581](https://github.com/deepcoldy/botmux/commit/46171f581) 共享记忆 | [lark/memory.ts:1](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/memory.ts:1) 起已有 bot+群池/私聊、按群隔离、CAS、来源追溯；后台 pipeline 有持久作业 | 不以“补记忆”名义引入 OpenViking；跨宿主项目语义检索另评估 |
| [5f8175ab5](https://github.com/deepcoldy/botmux/commit/5f8175ab5) worktree 安全扫描 | [workspace.ts:505](/data00/home/huangyuhang.edu/ai/dutydeck/packages/agent-runtime/src/workspace.ts:505) 拒绝 tracked/untracked/ignored，`:488` 拒绝初始化子模块，`:524` 检查隐藏 index，`:632` 删除不用 --force | 不搬允许确认删除脏树的内容指纹体系；4 MiB 状态输出限制是潜在可用性问题，失败会阻断清理 |

两项不能写成“已完全覆盖”：[3196b9c0c](https://github.com/deepcoldy/botmux/commit/3196b9c0c) 的授权卡重启持久化，在 Dutydeck 有 repository/CAS 基础，但本次没有独立进程重启确认卡的全路径验证；[70342bb28](https://github.com/deepcoldy/botmux/commit/70342bb28) 的 allowedUsers 校验 helper 能区分确定缺失与暂时错误，却未确认所有保存入口都实际调用。后者值得单独追配置写入链，当前不作完成判断。

## 四、产品增量按真实使用场景排期

### 受控插件结果最值得单独设计

[67e9ac6f3](https://github.com/deepcoldy/botmux/commit/67e9ac6f3) + [dd97eeac6](https://github.com/deepcoldy/botmux/commit/dd97eeac6) 让符合协议的本地插件把业务结果交给宿主保存与投递，模型只收到 delivered、deliveryId、fileCount 等回执。查看页面再次校验请求者身份、有效期和撤销状态；转发链接不自动获得权限。

这适合报表导出、敏感查询结果等确定性工具。Dutydeck 当前 [packages/shared/src/plugins.ts:203](/data00/home/huangyuhang.edu/ai/dutydeck/packages/shared/src/plugins.ts:203) 的 PluginApi 提供 CI、hook、scenario provider；hook 输出可进入 prompt。已有文件交付和不可信数据包裹，不能证明具备“正文不进模型、仅原请求者可读”的相同协议。

最小设计也需包含可信 requester/task 绑定、数据与模型回执分离、持久 artifact、TTL/配额、身份授权、发送幂等和终态结算。应复用 Dutydeck 的身份与投递账本，选一个真实插件验证；不为此引入整个 Botmux MCP gateway，也不把普通 bearer 分享链接当作所有者授权。上游只对显式 host-delivery envelope 的本地 stdio 分支替换结果，不能承诺任意插件数据都不会进入模型。

验收关键是结果 canary 不出现在 Agent 输入、普通事件和日志里；转发者拒绝访问；跨 bot/task 不串用；写盘/发送/ack 各边界可恢复；过期、配额、符号链接和重复终态受控。复杂度估计高。

### 周期任务自停与自定义卡都应扩现有协议

| 增量 | 当前差距 | 建议边界 |
|---|---|---|
| [85de606a7](https://github.com/deepcoldy/botmux/commit/85de606a7) 周期任务达到目标后停止 | [agent-request-tools.ts:22](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/agent-request-tools.ts:22) 明确限制自动轮次管理任务；一次任务已会自动停用 | 只允许成功交付后停用本 occurrence 绑定的 schedule，ID 由宿主给出；保留历史，不开放任意 schedule 删除。失败或投递未知不提前停 |
| [3295fbf16](https://github.com/deepcoldy/botmux/commit/3295fbf16) 完整自定义最终卡 | send --final 目前接收文本，[explicit-final.ts:104](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/lark/explicit-final.ts:104) 构造固定 Markdown 卡 | 增加受校验的 card body，仍复用 task/attempt、原回复位置、确定性 UUID、未知投递对账和终态更新 |
| [d888b72d0](https://github.com/deepcoldy/botmux/commit/d888b72d0) 结果发布与上级会话回传分开 | 已有 send --final 与 reply-agent，不能说结果总会唤醒上级 | 若要一次操作同时发布与回传，为每个目标记独立状态，防回传重试重复发布；暂不新增一整套 report 命令 |
| [b76c3afbc](https://github.com/deepcoldy/botmux/commit/b76c3afbc) 结束会话后清 worktree 入口 | 已有预览、清理和忙会话保护，聊天入口可更便捷 | 先链接已有清理页面或能力，继续拒绝脏树，不复制 force 删除与额外 job 存储 |

周期任务自停与自定义卡复杂度均估计中。前者必须验证不能停其他任务、权限撤销、投递未知、落库失败恢复；后者验证非法卡拒绝、一次交付、completion 不补发第二份、重启回执仍一致。

### 其余产品变化暂缓

- [46171f581](https://github.com/deepcoldy/botmux/commit/46171f581) 的 OpenViking 示例提供跨 Agent、按用户与 Git 项目共享的主动检索，这与 Dutydeck 群记忆不同。示例明确限制同 OS 用户，项目 scope 只是检索约定；多人 Bot 不能直接共用个人身份。若需要，做默认关闭的插件或独立 Skill，保留现有群记忆边界。
- [190fa2089](https://github.com/deepcoldy/botmux/commit/190fa2089) 零注入有明确取舍。Dutydeck 的 optimized prompt policy 不等于 zero；当前注入还承担角色、群指令、记忆、结果指引和风险提示。不能用一个开关清空后宣称行为等价。
- [d29a9d477](https://github.com/deepcoldy/botmux/commit/d29a9d477) 是新增宿主 login shell/tmux/herdr 管理终端。Dutydeck 的终端依附 runtime session，每次 input/resize 重验 terminal.write；慢客户端断开后用快照恢复。可借多端活跃控制者与尺寸同步，不因上游加 shell 就扩大产品权限面。[3f9e87af3](https://github.com/deepcoldy/botmux/commit/3f9e87af3) 也提醒：管理身份可能经反代访问，不能把“本地管理”误写成物理本机限制。
- [144fc159a](https://github.com/deepcoldy/botmux/commit/144fc159a)、[62abc52b0](https://github.com/deepcoldy/botmux/commit/62abc52b0) 的 Herdr 指定宿主/workspace/tab/split，需要重新界定外部 pane 的归属与清理。Dutydeck 当前创建自有 workspace；只有确认共用宿主需求后再做，并同步 settings CLI。
- [1648f8ee0](https://github.com/deepcoldy/botmux/commit/1648f8ee0) 的 Claude `/btw` 旁路回答不入普通 transcript。上游靠视口、问题匹配和剪贴板捕获，并有主动按键副作用；这是独立能力，优先级低于普通结果正文保留。

## 五、不迁入上游专有架构

| 提交组 | 不直接融入的原因 |
|---|---|
| [16f093ec7](https://github.com/deepcoldy/botmux/commit/16f093ec7)、[d0ba221b2](https://github.com/deepcoldy/botmux/commit/d0ba221b2) | 完整 COW/bwrap 沙箱、relay outbox、skill manifest 快照是 Botmux 特定生命周期。Dutydeck 当前检查的启动链无同形沙箱；可保留“先卸载再回收、活 pane 不删目录”的设计约束，不为修复引入整套沙箱 |
| [7b4c83ed4](https://github.com/deepcoldy/botmux/commit/7b4c83ed4)、[467929675](https://github.com/deepcoldy/botmux/commit/467929675)、[6025e5a8f](https://github.com/deepcoldy/botmux/commit/6025e5a8f) | 分别是 Cursor transcript footer、Pi transcript 终态、内置 dsh runner。Dutydeck 当前 factory 没有 Cursor/Pi 同等 tailer，dsh 依赖外部 runner；不能推定相同执行路径。以后扩适配器时带入对应 fixture |
| [b32d1f4dc](https://github.com/deepcoldy/botmux/commit/b32d1f4dc) | 上游 Bun/axios 媒体上传 keep-alive 池，与 Dutydeck fetch/FormData/请求预算路径不同；当前 fetch 池是否存在相似故障 unverified |
| [fdfafa31d](https://github.com/deepcoldy/botmux/commit/fdfafa31d)、[283d18758](https://github.com/deepcoldy/botmux/commit/283d18758)、[87ff7d77c](https://github.com/deepcoldy/botmux/commit/87ff7d77c)、[25fe22cca](https://github.com/deepcoldy/botmux/commit/25fe22cca) | 上游 trigger-user UAT、设备码、团队 Bot Owner 跨平台委派。Dutydeck 使用宿主 capability、活跃 task actor 与写边界重验；没有证据需要复制整套凭据代理 |
| [20ebe19e4](https://github.com/deepcoldy/botmux/commit/20ebe19e4) | 上游扫描正文 @Name 再改写；Dutydeck 主要渲染确定 ID 或显式目标，不引入全文扫描再补代码区排除 |
| [7731bb043](https://github.com/deepcoldy/botmux/commit/7731bb043)、[1e8b101eb](https://github.com/deepcoldy/botmux/commit/1e8b101eb)、[270f30e89](https://github.com/deepcoldy/botmux/commit/270f30e89) | 自动入群开工、修改真实群负责人、跨 Bot 关闭后解散群，均是外部可见产品动作；当前缺少必要场景，不作为可靠性修复附带实现 |
| [062acbbfe](https://github.com/deepcoldy/botmux/commit/062acbbfe)、[b6f71758d](https://github.com/deepcoldy/botmux/commit/b6f71758d)、[e729afbd5](https://github.com/deepcoldy/botmux/commit/e729afbd5) | macOS Herdr launcher、Bun darwin-x64 发行、Bun 版本告警；Dutydeck Linux Herdr 与 pnpm/Node 发行路径不同 |
| [fef5d883d](https://github.com/deepcoldy/botmux/commit/fef5d883d)、[d92abfde9](https://github.com/deepcoldy/botmux/commit/d92abfde9)、[8aa13739b](https://github.com/deepcoldy/botmux/commit/8aa13739b)、[423ccf647](https://github.com/deepcoldy/botmux/commit/423ccf647) | Botmux 自绘滚动条、侧栏层级、特定选中样式和标题编辑 effect。Dutydeck 组件不同，应先复现自己的 UI 问题，不搬局部 CSS 或控件 |
| [cfdb101ea](https://github.com/deepcoldy/botmux/commit/cfdb101ea) | Botmux CDN xterm 插件版本漂移；Dutydeck 本地 bundle 和 lock 已固定解析结果，无同形 CDN 问题 |
| [c2bf3df73](https://github.com/deepcoldy/botmux/commit/c2bf3df73) | 内部 Devbox/merlin 导出解析，不适合进入 Dutydeck 通用产品核心 |
| [d17195e7f](https://github.com/deepcoldy/botmux/commit/d17195e7f)、[0418b8f39](https://github.com/deepcoldy/botmux/commit/0418b8f39) | 可借“删源码措辞断言、保留行为验证”的原则，不能根据上游删测试数量批量删除本仓测试 |
| [c837478fe](https://github.com/deepcoldy/botmux/commit/c837478fe)、[09f7d071b](https://github.com/deepcoldy/botmux/commit/09f7d071b) | 共享真机排队、lane/lease、聊天模式矩阵可作测试设计参考；runner、Midscene 与 pages 工作流不直接移植 |

配置、说明与测试要随实际实施一并更新：用户可见行为更新 README 中英文；新增 Web 设置同步 `dutydeck settings`。每项改造先形成最小独立改动，再运行类型检查和受影响测试；会话生命周期、终端、卡片或 Web 主流程还需 smoke/e2e。本报告没有批准或执行任何生产变更。

## 附录 A：证据等级与验证记录

已复现：当前代码或原样提取的接线逻辑在隔离输入下产生所述结果。代码证据：定位到实际数据流，未完成真实环境实验。unverified：平台、线上形态、发生频率或端到端效果尚未验证。测试全绿只证明现有断言，不能覆盖本次另外构造的边界。

### 隔离探针

| 脚本 | 执行方式 | 实测输出与边界 |
|---|---|---|
| `/tmp/dutydeck-botmux-runtime-probe.mts` | `node --import tsx /tmp/dutydeck-botmux-runtime-probe.mts` | 后台计数 0；菜单 ready=false；capacity 为 generic 不可重试；最终卡只有 memory 后记。读取库内脱敏 fixture，临时文件结束后删除；不执行 fixture 里的 shell |
| `/tmp/dutydeck-lark-callback-probe.mjs` | `node /tmp/dutydeck-lark-callback-probe.mjs` | 对象+form 正常；字符串+form 丢动作；behavior-only 和 envelope 也失败，但后两者 SDK 实际入口形态待验 |
| `/tmp/dutydeck-sse-review-probe.cjs` | `node /tmp/dutydeck-sse-review-probe.cjs` | 静默 open 无 timer；旧 source 事件被接收 1 次；重复 error 后共 3 条 source、2 条 open。真实类转译，EventSource/timer/URL 依赖为替身 |
| `/tmp/dutydeck-socket-review-probe.cjs` | `node /tmp/dutydeck-socket-review-probe.cjs` | Linux 路径 65 bytes 正常，151 bytes 为 uncaught ENOENT。真实 TmuxCapture，仅临时 Unix socket；测试捕获异常后清理，未启动 tmux |

原始 stdout：

```text
background_after_agent_and_bash_launch=0
migration_picker_ready=false
capacity_error={"type":"error","data":{"code":"native_task_failed","message":"Selected model is at capacity. Please try a different model.","retryable":false}}
result_output={"tag":"markdown","element_id":"final_output","content":"另外，我保存了两条记忆。","text_align":"left","text_size":"normal_v2","margin":"0px"}
result_contains_answer=false

{"objectForm":"preserved","jsonStringForm":"lost action and task_id","behaviorOnly":"value lost","envelope":"value and operator lost"}

open silent stream scheduled timers: 0
late closed-source event delivered: 1
duplicate error created total sources: 3 still open: 2

{"label":"short","pathBytes":65,"outcome":"listening"}
{"label":"long","pathBytes":151,"outcome":"uncaught ENOENT"}
```

### 现有测试

```sh
pnpm vitest run packages/pty-driver/src/driver-background.test.ts packages/pty-driver/src/transcript/tail-budget.test.ts packages/pty-driver/src/transcript/claude-terminal.test.ts packages/pty-driver/src/transcript/native-terminal.test.ts packages/pty-driver/src/driver-recovery.test.ts packages/pty-driver/src/driver-drain-races.test.ts packages/session-backends/src/owned-tmux.test.ts apps/server/src/recovery-routes.test.ts
# 8 files / 80 tests passed，10.70s

pnpm vitest run packages/agent-runtime/src/restart-recovery.test.ts packages/agent-runtime/src/execution-recovery.test.ts apps/server/src/lark/task-recovery.test.ts
# 3 files / 39 tests passed，6.75s

pnpm vitest run apps/server/src/lark/card-actions.test.ts apps/server/src/lark/card-callback-dedup.test.ts apps/server/src/lark/task-context.test.ts apps/server/src/lark/explicit-final.test.ts apps/server/src/agent-request-tools.test.ts apps/server/src/lark/owner-identity.test.ts apps/server/src/lark/group-management.test.ts apps/server/src/lark/schedule-and-repair.test.ts
# 8 files / 212 tests passed，15.67s

pnpm vitest run apps/web/src/sse-reconnect.dom.test.ts apps/web/src/useSessionStream.dom.test.tsx
# 2 files / 23 tests passed，2.43s
```

测试使用替身、临时 SQLite 或私有 tmux socket，未访问线上 unit、数据库或真实飞书。没有为变绿修改断言。只读分析未运行全仓 typecheck/smoke/e2e；未运行 macOS、真实付费 CLI、完整浏览器反代、OpenViking 服务或真实飞书回调。复杂度均为估计，所有建议功能均未实施。

### 已有材料与追溯

已完整阅读 [THIRD_PARTY_NOTICES.md](/data00/home/huangyuhang.edu/ai/dutydeck/THIRD_PARTY_NOTICES.md) 与 [10 月 13 日产品调研](/data00/home/huangyuhang.edu/ai/dutydeck/docs/research/2026-10-13-dutydeck-product-review.md)。前者记录 10/15–17 已有下载、TraeX 样本、OSC 7501 等派生；后者关于“没有插件”“没有按群记忆范围”的旧判断已不适用于当前代码，本文未复用其旧运行数字。

分工证据保存在 [运行时笔记](/tmp/dutydeck-botmux-runtime-review.md)、[飞书笔记](/tmp/dutydeck-botmux-lark-review.md)、[Web 与产品笔记](/tmp/dutydeck-botmux-product-review.md)。Rebase 与基线记录为 [meta.json](/tmp/dutydeck-botmux-20261021-meta.json)，原始提交清单为 [commits.txt](/tmp/dutydeck-botmux-20261021-commits.txt)。这些 `/tmp` 文件是本次复核材料，可能随临时目录清理；关键结论、输出和审查范围已保留在本文。

## 附录 B：提交覆盖清单

“核心 diff”表示读取相关实现及必要测试并对照 Dutydeck，不表示该提交每个文档、平台分支和测试都已逐行审计。“变更面”表示读取标题与改动范围、部分样例或作架构筛选；它不能支持“功能已完整覆盖”的断言。以下列出实际核心 diff 清单；其余记录完成标题或变更面筛选，完整 125 条见上方 commits.txt。未深入项不充当排除所有问题的证据。

### 核心 diff 与交叉检查

- 运行时与原生输出：[f89419093](https://github.com/deepcoldy/botmux/commit/f89419093)、[1d7dbbfe3](https://github.com/deepcoldy/botmux/commit/1d7dbbfe3)、[757b43dc1](https://github.com/deepcoldy/botmux/commit/757b43dc1)、[16f093ec7](https://github.com/deepcoldy/botmux/commit/16f093ec7)、[1648f8ee0](https://github.com/deepcoldy/botmux/commit/1648f8ee0)、[b1fc8a2b3](https://github.com/deepcoldy/botmux/commit/b1fc8a2b3)、[43ad2b429](https://github.com/deepcoldy/botmux/commit/43ad2b429)、[36c04fa6f](https://github.com/deepcoldy/botmux/commit/36c04fa6f)、[7b4c83ed4](https://github.com/deepcoldy/botmux/commit/7b4c83ed4)、[8eff34345](https://github.com/deepcoldy/botmux/commit/8eff34345)、[fc2db0bba](https://github.com/deepcoldy/botmux/commit/fc2db0bba)、[bbd4b3a23](https://github.com/deepcoldy/botmux/commit/bbd4b3a23)、[db667c629](https://github.com/deepcoldy/botmux/commit/db667c629)、[d7c65f0d6](https://github.com/deepcoldy/botmux/commit/d7c65f0d6)、[ad545ca54](https://github.com/deepcoldy/botmux/commit/ad545ca54)、[144fc159a](https://github.com/deepcoldy/botmux/commit/144fc159a)、[062acbbfe](https://github.com/deepcoldy/botmux/commit/062acbbfe)、[d238cff96](https://github.com/deepcoldy/botmux/commit/d238cff96)、[6025e5a8f](https://github.com/deepcoldy/botmux/commit/6025e5a8f)、[467929675](https://github.com/deepcoldy/botmux/commit/467929675)。另核对 [6b0f60fda](https://github.com/deepcoldy/botmux/commit/6b0f60fda) 的测试隔离原则。
- 飞书、身份与定时：[b32d1f4dc](https://github.com/deepcoldy/botmux/commit/b32d1f4dc)、[20ebe19e4](https://github.com/deepcoldy/botmux/commit/20ebe19e4)、[3196b9c0c](https://github.com/deepcoldy/botmux/commit/3196b9c0c)、[25b3a6383](https://github.com/deepcoldy/botmux/commit/25b3a6383)、[25fe22cca](https://github.com/deepcoldy/botmux/commit/25fe22cca)、[283d18758](https://github.com/deepcoldy/botmux/commit/283d18758)、[cb67070e9](https://github.com/deepcoldy/botmux/commit/cb67070e9)、[85de606a7](https://github.com/deepcoldy/botmux/commit/85de606a7)、[87ff7d77c](https://github.com/deepcoldy/botmux/commit/87ff7d77c)、[fdfafa31d](https://github.com/deepcoldy/botmux/commit/fdfafa31d)、[7d0a0d7e5](https://github.com/deepcoldy/botmux/commit/7d0a0d7e5)、[3295fbf16](https://github.com/deepcoldy/botmux/commit/3295fbf16)、[d888b72d0](https://github.com/deepcoldy/botmux/commit/d888b72d0)、[1e8b101eb](https://github.com/deepcoldy/botmux/commit/1e8b101eb)、[7731bb043](https://github.com/deepcoldy/botmux/commit/7731bb043)、[02d52bd12](https://github.com/deepcoldy/botmux/commit/02d52bd12)、[be4853282](https://github.com/deepcoldy/botmux/commit/be4853282)、[0f5ba1b65](https://github.com/deepcoldy/botmux/commit/0f5ba1b65)、[70342bb28](https://github.com/deepcoldy/botmux/commit/70342bb28)、[d5d631a4a](https://github.com/deepcoldy/botmux/commit/d5d631a4a)。
- Web、配置、结果与清理：[6f7182642](https://github.com/deepcoldy/botmux/commit/6f7182642)、[dcd40a41a](https://github.com/deepcoldy/botmux/commit/dcd40a41a)、[190fa2089](https://github.com/deepcoldy/botmux/commit/190fa2089)、[67e9ac6f3](https://github.com/deepcoldy/botmux/commit/67e9ac6f3)、[5f8175ab5](https://github.com/deepcoldy/botmux/commit/5f8175ab5)、[b76c3afbc](https://github.com/deepcoldy/botmux/commit/b76c3afbc)、[d29a9d477](https://github.com/deepcoldy/botmux/commit/d29a9d477)、[1b8734655](https://github.com/deepcoldy/botmux/commit/1b8734655)、[0e4cc9916](https://github.com/deepcoldy/botmux/commit/0e4cc9916)、[62abc52b0](https://github.com/deepcoldy/botmux/commit/62abc52b0)、[fef5d883d](https://github.com/deepcoldy/botmux/commit/fef5d883d)、[d92abfde9](https://github.com/deepcoldy/botmux/commit/d92abfde9)、[423ccf647](https://github.com/deepcoldy/botmux/commit/423ccf647)、[8aa13739b](https://github.com/deepcoldy/botmux/commit/8aa13739b)、[cfdb101ea](https://github.com/deepcoldy/botmux/commit/cfdb101ea)、[3f9e87af3](https://github.com/deepcoldy/botmux/commit/3f9e87af3)、[dd97eeac6](https://github.com/deepcoldy/botmux/commit/dd97eeac6)、[e729afbd5](https://github.com/deepcoldy/botmux/commit/e729afbd5)、[19fa491d1](https://github.com/deepcoldy/botmux/commit/19fa491d1)。这里的 d29a9d477 只覆盖终端边界、协议与相关测试，未逐行审核全部客户端和回放实现。

### 变更面筛选与明确未完成的深审

[46171f581](https://github.com/deepcoldy/botmux/commit/46171f581) 完整读了示例 DESIGN/README 并检查示例结构，未验证真实服务或逐行审计全部 Python/Node 安装器；[d0ba221b2](https://github.com/deepcoldy/botmux/commit/d0ba221b2)、[c2bf3df73](https://github.com/deepcoldy/botmux/commit/c2bf3df73) 看过相关核心片段，未遍历全部沙箱/Devbox 分支。[270f30e89](https://github.com/deepcoldy/botmux/commit/270f30e89) 只补读跨 Bot 解散的 inventory/close 依赖，[24e88fed6](https://github.com/deepcoldy/botmux/commit/24e88fed6) 没有完成实质卡片 diff 审阅。

[8139885f8](https://github.com/deepcoldy/botmux/commit/8139885f8) 在元数据筛选后另核对了 Dutydeck 注册链路。[187b0d37e](https://github.com/deepcoldy/botmux/commit/187b0d37e)、[6e47b952b](https://github.com/deepcoldy/botmux/commit/6e47b952b)、[b6f71758d](https://github.com/deepcoldy/botmux/commit/b6f71758d)、[c837478fe](https://github.com/deepcoldy/botmux/commit/c837478fe)、[09f7d071b](https://github.com/deepcoldy/botmux/commit/09f7d071b)、[d17195e7f](https://github.com/deepcoldy/botmux/commit/d17195e7f)、[0418b8f39](https://github.com/deepcoldy/botmux/commit/0418b8f39)、[f4301ffbf](https://github.com/deepcoldy/botmux/commit/f4301ffbf)、[d06d38563](https://github.com/deepcoldy/botmux/commit/d06d38563) 主要检查变更面与相关样例，没有对全部 UI、发行、测试治理文件深审。其余未出现在核心清单的提交仅作范围筛选；没有据此声称对应能力不存在、已完整覆盖或无需后续审查。

独立复核已重跑四个探针，输出与本文一致；复核没有把合成输入提升为线上或跨平台证据。正式报告是本地分析文件，路径被仓库 `docs/` 忽略规则排除，本次未提交。后续实施范围建议按前述四项、socket 与 stderr 六个独立改动拆分；capacity 分类及菜单自动保留旧模型放第二批，受控插件结果另出设计。
