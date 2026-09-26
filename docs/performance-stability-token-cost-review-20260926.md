# Dutydeck 执行性能、稳定性、token 效率与成本审查

审查基线：2026-09-26，提交 `42e373a`。范围覆盖运行时、ACP/PTY、调度与恢复、飞书收发、群判定、记忆、用量账本、SQLite、HTTP/SSE、Web 及现有性能基准；按要求不讨论安全问题。本次只交付审查和方案，没有改业务代码、线上配置或重启服务。

最值得先做的是：修复熔断半开并发；补齐 attempt 查询索引并收窄查询；取消等待结果时的全历史重放；把预算检查移到跨群检索之前；跳过没有内容变化的记忆整理。随后优化群判定模型分工、Web 长历史加载及主线程同步工作。当前没有依据建议数据库迁移、引入分布式队列或重写 transport 生命周期。

**证据与 ROI 口径**

- **已确认**：源码调用链或隔离复现可证明的行为。**实测**：本机合成样本的当次结果，不代表线上延迟、发生频率或节省金额。**estimate**：投入、收益公式和验收目标。**unverified**：线上规模、真实 provider 费率、缓存命中、账单、故障率和大转录样本分布。
- 未读取线上业务数据库、未调用真实模型、未发送飞书消息。浏览器基准使用临时 SQLite、mock runtime 和回环测试服务器。字符数不是 token 数；减少重复 prompt 不意味着费用同比下降，还要扣除已有缓存收益。
- 投入均为 estimate：熟悉项目的一名工程师的人日，含针对性回归；各项可能共享改造，不宜直接相加。排序综合收益确定性、影响范围、触发频率、投入和回归风险，不制造没有数据支撑的精确 ROI 分数。

| 分级 | ROI 含义 | 本次判断 |
|---|---|---|
| P0 | 已确认持续故障、不可控支出或数据丢失，需要立即止损；收益明显高于实施和回归代价 | **暂无证据支持 P0。** 本次没有线上故障率、账单或容量告急证据；不以合成压力样本冒充线上事故。若后续监测证实，应将对应 P1/P2 上调。 |
| P1 | 缺口已确认，直接影响常用链路或存在低投入、确定的重复工作消除机会 | 优先排期；同级优先做投入小、边界清楚的项目。 |
| P2 | 机制已确认，但收益较依赖并发、历史长度、使用方式，或需要较多状态改造 | 根据实测使用分布和 P1 后瓶颈推进。 |
| P3 | 主要收益仍待真实 provider/负载验证，或只有高规模才值得增加复杂度 | 先小范围评测，满足条件再实施。 |

**P1：优先排期的改造**

| 编号 / 方向 | 问题与当前证据 | 最小改造方案 | 收益与验收标准（目标为 estimate） | 投入 / ROI 判断 |
|---|---|---|---|---|
| 01 稳定性：熔断半开没有单次探测隔离 | `api-gate.ts:500` 只拦截 open 状态，切换到 half-open 后其他并发仍进入。隔离复现：首个探测未完成，8 个调用全部进入。已有令牌桶与失败计数，缺口是半开的并发所有权。 | 明确探测 owner/generation；半开期间其他调用快速失败或有界等待；令牌等待后复核状态；成功、失败、取消均释放探测占用，旧请求不得关闭新一代熔断。 | 故障恢复期间由多个并发试探变成一个受控探测，减少上游继续抖动时的请求与等待。验收：8/100 并发时仅一项进入；取消、晚到成功和重试不会错误复位。 | **0.5–1 日**。确定缺陷、影响所有经过网关的 JSON 调用、改动较小。 |
| 02 性能：attempt 历史查询缺少匹配索引且读取过宽 | `task-execution.ts:54` 按 session 查询并排序；`:511` 获取单 task 前读取整个 session 的 attempts。现有 active partial index 不覆盖历史查询。10 万 attempt 样本 EXPLAIN 为全表 SCAN + 临时排序；补 `(session_id,number,id)` 后变为索引搜索。样本 p95 5.20→0.102ms，仅为方向证据。 | 增加复合索引；单 task 走已有 `(task_id,number)` 索引直接读取；claimNext 检查活跃状态时利用现有 partial index，不解码所有历史 JSON。 | 查询工作从总 attempt 数 A 收窄到该 session 的 a 或 task 的 t。验收：10 万/100 万样本的相应 EXPLAIN 无全表扫描及临时排序；claim/recovery 状态语义不变。不能把约 51 倍样本比值当全服务提速。 | **0.5–1 日**。接收、查询、恢复共同受益，收益机制明确。 |
| 03 性能：等待结果每次重放会话全部旧事件 | `agent-runtime/index.ts:1893` 的 send waiter 从 `afterSequence:0` 订阅，每个事件都会触发当前 task 状态检查。5 万历史事件的 publisher 样本产生 250 页读取、227ms 总回放。该数值不含 SQLite/任务投影，也不是一次同步卡顿。 | 从当前高水位订阅，注册后立即 inspect 当前账本状态；保留订阅前/期间已经完成的竞争处理，无需重放历史。 | 每次等待的旧历史工作由 O(H) 降到 O(1)，只处理后续变化。验收：订阅前完成、订阅安装时完成、queued 取消、retry 首 attempt 绑定均正常。 | **0.5–1 日**。边界集中，可直接消除反复累积的无效工作。 |
| 04 性能 / 成本：预算耗尽仍先构造跨群快照 | `group-participation.ts:392` 先 snapshot，`:402/410` 才检查费用/次数；`team-context.ts:73` 先扫所有已加入群，再只取前 8 群远端历史。100 群、两次“谢谢”合成查询触发 200 次 observation、200 次 followup、16 次远端历史读取。已有 500ms 合并、按群单飞和来源条数限制，仍未避免检索前浪费。 | 预算和次数检查前置；先用当前消息/本群必要材料判定是否需跨群资料；明确需要时检索。群目录及本地检索结果按 revision/短 TTL 复用，不能把可读性和来源完整性假定为永久不变。 | 被预算拒绝的触发应不再读取远端历史；普通消息成本不再随全部群数线性增长。验收：拒绝路径远端检索数为 0；统计每次有效决策 API 数、P95 和回答证据覆盖。 | **2–4 日**。直接减少 I/O、API 配额及决策前延迟，群越多越有价值。 |
| 05 token / 成本：分类、回复、记忆共用模型配置 | `readonly-decider.ts:132/139` 的 decision/response 均使用 `memoryAgentId/memoryModel`，未配置则回落执行默认模型；`memory-pipeline.ts:700` 同样使用它。已有廉价模型入口，但给 memory 换小模型也会影响群回复，无法单独调优。 | 将分类、回复、记忆的模型选择独立；先回放 silent/reply/act 样本；适合分类的小模型先行，低置信升档；保留现有配置兼容。不要只凭“模型便宜”自动降级执行任务。 | 以同一回放任务集的新旧总费用差衡量；所有阶段的输入/输出/缓存、升档和返工成本各计入一次。验收：误介入/漏答率不退化，按 origin+model 比较成本、P95、升档率。 | **2–3 日**。后台调用重复频率较高；实际金额取决于当前所用模型，尚未核账。 |
| 06 token / 成本：记忆未变化也周期性全量整理 | `memory-pipeline.ts:389/460/635` 按完成轮数增加计数，8 轮或索引超额触发整理；只要 entries 非空就可整理，连续提取空 facts 不会阻止。已有池级单飞、退避和有限重试。 | 保存上次整理的内容 hash/revision；内容无变化、未超预算、未到时间性过期检查窗口时跳过；保留手动整理和事实到期处理。 | 非空记忆一直不变的理想串行情形，24 个完成轮次会到期 8 次提取、3 次整理；可消除其中 3 次无内容变化整理，提取不变。验收：这类场景自动整理为 0，过期事实仍能清理；记录每个新增有效事实的成本。 | **1–2 日**。避免完整后台调用，收益比单纯压缩几十字提示更直接。 |
| 07 性能 / 稳定性：每秒 tmux 同步探活阻塞主线程 | `tmux-backend.ts:707` 每实例每秒 probeSession/getPid；`:518/181` 使用同步子进程。4 个实例、每条假命令人为延迟 100ms，一次集中探活阻塞 881ms。此为故障注入，非线上 tmux 延迟。 | 高频探活改异步并 single-flight；保留 unknown 状态和连续 3 次失败语义；需要时按 tmux server 批量查询，避免探活重叠。 | 不再让 `N×两条命令耗时` 占用 HTTP/SSE 的事件循环。验收：注入慢 tmux 时 HTTP/SSE p99 保持在预算内，未知状态不误判退出。 | **2–3 日**。主线程资源被全服务共享；不需要重写全部后端。 |
| 08 性能 / 稳定性：JSONL 积压同步读完、未完成行无内存上限 | `transcript/tail.ts:254/266` 按整个新增文件段分配、同步读取、拼接解析。合成 50.75MB/5 万行一次 flush 占主线程 142ms；无换行追加 16MiB 全留 pending。已有 offset/checkpoint，普通运行从 EOF 开始，并非反复全文件重读。 | 周期轮询分块读取并按字节/时间预算 yield；终态 flush 必须等待截至确定文件水位的 drain 完成，idle完成、checkpoint和停止路径一起适配（driver.ts:784/792 当前依赖同步 flush）。未完成行分段缓冲，超大记录不能静默丢弃。若保留同步终态 flush，应明确终态积压停顿尚未消除。 | 控制恢复突发停顿及长行内存复制，避免积压越大单次停顿越长。验收：真实 Claude/Codex/Traex transcript 样本、部分行、截断恢复、去重和终态均正确；真实外部样本验证本次 **unverified**，实施必须补齐；最后一条记录超过单批预算、恰在 idle 前追加时，completed 仍须晚于该记录且归属原 Attempt。 | **2–4 日**。恢复与大输出下价值高，需认真验证解析契约。 |
| 09 性能：Web 首屏等全历史串行下载完才展示 | `event-history.ts:24` 每次 1,000 条连续向前读到结束；`App.tsx:261/267` 成功后才开启流；分享页同样使用。5 万事件实测 51 次请求。已有游标分页和 AbortSignal，但 UI 没有实现首屏渐进加载。 | 先展示尾页，以尾页最大 sequence 连接 SSE 并补读此后的事件；滚动到顶部自动补更早页，保留已加载记录、去重及滚动锚点；分享页一起修正。 | 首屏历史往返从约 H/1000 降为 1–2 页。50ms RTT、5 万事件时，原串行往返约 2.55秒（estimate，未计传输/渲染）。验收：5 万/50 万历史首屏请求数不随 H 增长，并达到仓库 800ms 目标；尾页读取至建连间新增超过200条事件仍不得漏失。 | **2–3 日**。可复用现有分页，无需改存储模型。 |
| 10 性能：实时更新重建全历史，折叠内容仍构造组件 | `event-history.ts:40/60` 复制数组，补 B 条执行 B 次合并；`App.tsx:271` 全 timeline 派生；`TimelineView.tsx:52` 挂载全部 sections；`ActivityPanel.tsx:29` 收起仍构造 groups。5 万事件派生 p95 94.50ms；补 200 条 p95 140.17ms，均不含 React paint。已有 Map/memo，不等于整条链路增量。 | 先一次性合并补页、taskId Map、收起时延迟构造详情；再按帧合批增量、保持旧 turn 引用、仅更新受影响 turn；按 turn 做可变高度窗口渲染，并与第 09 项共享滚动锚点。 | 补页全拷贝 B 次→1 次；派生工作收窄至新增内容；DOM 数量随视口而非历史 turn 数增长。验收：5 万历史补 200 条目标 <20ms，端到端增量 paint p95<80ms；展开、复制、定位与交互顺序不丢失。 | **组合 4–7 日**；仅批量合并/Map/延迟详情约 **1–2 日**。先做小修再决定完整窗口化，收益不可与第 09 项重复累计。 |
| 11 性能：会话摘要 N+1，每个前台页面每 15 秒重复读取 | `app.ts:206` 列全部 sessions 后逐 session getTasks、过滤并排序；`App.tsx:196/197` 独立轮询 sessions/summary。2,000 session/10,000 task 样本为 2,000 次 task 查询、323.48ms、273,781B。已有 task session 索引和后台暂停轮询。 | 批量查询 first 有效 prompt、latestUpdated、queuedCount；API 增加游标/增量，先保持 15秒兜底，不急于新建全局推送基础设施。 | 数据查询从 O(S) 次→固定几次；前台 U 个页面的 task 查询量原约 `U×S/15` 次/秒。验收：核心摘要数据查询 ≤3 次，取消/空 prompt 过滤语义不变；同样本目标 <100ms。 | **1–2 日**。低投入，长期会话增长下收益明确。 |
| 12 成本：估价漏 cache-write，未知成本不受美元上限完整覆盖 | `usage-ledger.ts:36` 估价不包含已接收的 cacheWriteTokens；单独 100 万 cache-write token 得到 0。仅在 provider 未报告成本、转用 token 估价时触发。未知模型回落固定默认费率；unavailable 记录没有 costUsd，聚合为 0。已有 reported/estimated/unavailable 标记和费率 JSON 覆盖，不是完全未记账。 | 补 cache-write 费率，明确 provider/model/rate-version；未知费率明确标记而不伪装准确价格。保留 provider 报告优先；对未知成本后台任务提供次数/时长兜底，并明确美元预算的覆盖率。 | 纠正预算依据与省费比较口径；不直接创造模型折扣，无法据此推算线上漏记金额。验收：cache-write-only、未知模型、PTY unavailable；跟踪计量覆盖率和账单偏差，未知值不得误报为“免费”。 | **2–3 日**。其他成本优化依赖这一口径，宜靠前。 |
| 13 稳定性 / API 成本：请求总期限不统一，重试层数相乘 | `routes.ts:63` 默认 global fetch，listener 继承；`service.ts:1909` 未统一传取消/总 deadline。部分 workbench 请求已有 15秒包装，不能说全项目无超时。`coordinator-dispatch.ts:629` 终态最多 3 次，网关默认每次最多 4 次尝试，持续错误可达 12 次 HTTP 尝试。 | 将生命周期取消、总 deadline、剩余尝试预算贯穿 token 获取、排队、HTTP 和 body 消费；终态持久化重投仍保留，在线重试按一个预算管理，加入抖动。contact SDK、form 上传也逐条核对接入范围。 | 控制坏网络下卡片交付与停机等待上界，避免层层重复退避。验收：无响应/慢 body/429/取消夹具下总时间与次数受控；最终交付不丢、重投不重复。**不要**直接给 ACP stop 外包 Promise.race，避免破坏资源回收。 | **2–3 日**。补齐现有保护的调用边界，不改正常交付协议。 |

**P2：结合真实使用分布推进**

| 编号 / 方向 | 问题与当前证据 | 最小改造方案 | 收益与验收标准（目标为 estimate） | 投入 / ROI 判断 |
|---|---|---|---|---|
| 14 成本：月度预算是已结算准入门槛，不能约束在途支出 | `usage-ledger.ts:190` 只看已记成本；子任务沿根任务归因且绕过新根任务准入。上限 $1、已记 $0.99 的固定账本夹具中，10 次 admit 全部通过。现有设计明确不打断正在执行的任务；这是软上限的行为边界。 | 若需要可预测上限，为根任务原子预留额度，真正开始前复核，取消/失败/结算释放；子任务共享根预算。保留软限兼容，明确允许的 overshoot 和无法计量任务策略。 | 减少多个任务争用同一剩余额度导致的超支；预留是估算，仍不能承诺严格零超额。验收：并发、排队、重放、崩溃、跨月不重复占用；监测 overshoot/预留等待。 | **3–5 日**。先完成第 12 项，否则按不完整成本预留也不可靠。 |
| 15 性能 / 成本：跨会话没有执行槽上限 | `agent-runtime/index.ts:1962` 的串行门按 session。真实 Runtime+内存账本+mock driver 12 个 session dispatch 得到 active/peak=12。已有单 session 队列、claim 和恢复 hold，不是没有排队机制。 | durable claim 前分配全局运行槽，跨 session 公平轮转；取消/退出释放。先全局上限，有证据再加 provider 维度；另测 idle driver 内存，不能把运行槽当进程总数上限。 | 活跃执行资源从约 N×r 受控至 C×r，代价是排队时延。验收：高并发公平、不丢单、重启可恢复；比较吞吐、等待 P95 与 RSS。 | **2–4 日**。生产峰值并发和资源水位未采集，先测再选 C。 |
| 16 token：decision 与 response 重复携带完整冻结快照 | `readonly-decider.ts:118/126` 两阶段新会话都序列化 snapshot。30×4,000 字符材料经已有截断后，decision 52,503字符、response 51,235字符。现有隔离有语义价值，本群/跨群也已有字数预算。 | 保留两阶段隔离；分类只给介入判定材料；回复传 trigger、已接受 evidence、必要父消息与覆盖说明。不要以同会话复用替代证据边界。 | 减少输入和序列化体积；省费需按 input/cache token 实测，不能将 103,738 字符直接换算 token 或全价费用。验收：事实覆盖、引用准确率不退化，分阶段输入 token 明显下降。 | **2–3 日**。与第 04/05 项共享材料组织及评测。 |
| 17 token / 稳定性：记忆提取没有总输入预算 | `memory-pipeline.ts:613` 只截 answer 至 4,000字符，task.prompt 原样；一次最多 12轮。生产 builder 输入 12个100k字符请求及每轮4k回答，产出 1,249,337字符。此为边界样本，真实飞书/其他入口的大请求频率未验证。 | 对提取任务设置总 token/字节预算及单轮材料限额，按预算分批；超长材料保留关键段和截断说明，必要时按需读取。不要截断正常执行任务的用户要求。 | 防止一个后台批次异常膨胀、超模型上下文或拖长等待。验收：任意输入下总提取 prompt 有上界，并评测事实召回和材料丢弃比例。 | **1–2 日**。低投入；优先级随真实长材料频率调整。 |
| 18 token：未变化的长期指令与记忆索引每轮重发 | `coordinator-dispatch.ts:1002/1016/1077` 每轮重发 instructions、preInjectPrompt 和 memory index。群历史已按水位增量，不应把整个执行 prompt 说成全历史重复。 | 为配置/记忆记录注入版本；首次、变更、resume/压缩后完整注入，其余给必要增量。provider 生命周期无法确认时保留全量回退。 | 未变索引长 M、N 轮，可去重约 `(N−1)×M` 字符；缓存会改变金额收益。验收：恢复/压缩后无约定遗忘，对比输入及缓存 token；不能只删除文本就宣布省费。 | **2–4 日**。比第 06 项复杂，需覆盖 provider 差异。 |
| 19 API 效率：token 缓存缺 single-flight，部分路径反复建客户端 | `service.ts:1884` 只缓存已完成 token，没有共享在途 promise；隔离测试 8 个并发业务请求产生 8 次取 token。`workbench.ts:332` 等工厂路径又每次创建 service，使实例缓存无法跨调用保留。 | 按 app 与配置版本复用客户端/凭据缓存，token 刷新 single-flight；刷新失败可重试、配置变化失效；保留不同应用隔离。 | 同一冷启动或到期突发 B 次刷新→1次；减少认证 API 和排队。验收：8/100并发只刷新一次，失败后可恢复，配置变化不复用旧 token。此处 token 是认证令牌，收益主要是 API/延迟，不是 LLM token。 | **0.5–1.5 日**。低投入，但频率低于每条消息必经的重复上下文。 |
| 20 性能：自动化 tick 多次扫描全部历史记录 | `session-automation.ts:816/819/1467` 读取、JSON/schema 解析全部 schedule/occurrence/CI，包括已完成项；`storage/index.ts:331` 使用 substr 前缀过滤。已有 >1,000条恢复测试，简单加 LIMIT 会漏恢复。 | 为 active、due、待交付记录建立可查询投影/索引；热循环仅查当前要处理的集合；低频分批全量修复保留，不能复用过时快照破坏 CAS。 | tick 工作从历史 H 收窄至活跃 A；线上 H/A 未知。验收：10万终态+100活跃下 tick 时间随 A 变化，旧恢复和交付幂等测试保持。 | **3–5 日**。长期运行价值大，迁移及恢复一致性成本高于普通索引。 |
| 21 稳定性 / 延迟：CI 轮询串行占住整轮自动化 | `session-automation.ts:837/1195` 逐条 await GitHub，tick 单飞。已有每请求10秒默认超时、nextPollAt、lease；不是无限等待。 | 小并发池和整轮时间预算，隔离 schedule planning 与外部网络等待，保留每个订阅的 lease/CAS。 | N项各T秒由约 N×T→ceil(N/C)×T。20项×10秒、C=4约200→50秒，仅公式估计。验收：慢 fetch 下定时任务不饿死、同订阅不重入、API 并发受控。 | **1–2 日**。有多项并行 CI 时收益明显。 |
| 22 资源成本：核心历史与活跃 tmux 日志持续增长 | 会话 archive 只标 archivedAt（`agent-runtime/index.ts:2302`）；核心 events/tasks 未发现同等冷归档机制。`tmux-backend.ts:587` 持续 cat >> 临时文件，只在退出/detach等清理。已有 observation retention、退出清理和6小时 idle回收，不是所有数据永不清理。 | 先统计每 session 行数/字节和日志增长，归档项退出活跃列表；明确保留要求后分批导出/冷归档；原始日志容量受控轮转，验证 pipe-pane/tail 重绑定无缺口。 | 热数据和活跃日志有可预测容量，备份/列表/恢复不随全部历史无界增长。线上磁盘告急与增长率 **unverified**。验收：冷数据可读回、账本/幂等引用完整、连续日志不丢不重、前台延迟不退化。 | **指标与列表1–2日；冷归档3–5日；日志轮转2–3日**。先测容量再实施后两项。 |
| 23 性能：重连 SSE 与 HTTP 同时补同一缺口 | `app.ts:460` 非零 after 做 SSE replay；`useSessionStream.ts:45` open 时又 HTTP reconcile，可能从同一水位各读一遍。已有 sequence 去重和 SSE 背压；正确性保护不消除重复读取/解析。 | 明确恢复通道职责；SSE replay 完成后仅对真实 gap 才用 HTTP，或由 SSE 单独负责 resume。保留必要任务/会话元信息刷新。 | 减少重连重复请求、字节和第 10 项数组合并。实际重复比例取决于竞态，未实测，不能承诺固定减半。验收：断线期间1万事件每条只从一个通道下载，人为 gap 仍可补齐。 | **0.5–1 日**。收益取决于断线频率，放在正常更新路径后。 |
| 24 性能 / 验证成本：入口包超预算，微基准与 UI 链路不一致 | Web build成功，entry gzip **224,962B**，现有预算 **143,360B**；原样 history benchmark失败。`main.tsx:6` 静态引入分享页，分享页静态引入 TimelineView，削弱 App 的 lazy 分块；现有 microbench“首屏”只取200条，UI却先取全历史。 | 分享页按路由 lazy，语法高亮按需要加载；先修实际 bundle 依赖，再细分大块。基准显式使用 development 源码条件或先构建 packages，加入真实 UI 加载/派生路径、失败前输出全部指标；将功能基准和容量/输入大小矩阵接入实际 CI 执行。 | 达现有门槛需要减少至少 **81,602B**，为当前入口的 **36.3%**；这是目标差额，不是已实现收益，也不保证一处 lazy 即达标。验收：entry≤143,360B，浏览器冷首屏/增量/重连都达原预算，不能通过放宽阈值解决。 | **1–2 日**起。已失败的门槛需修复；相较任务稳定性和反复模型调用，业务收益次之。 |

**P3：先测再决定**

| 编号 / 方向 | 问题或待验证假设 | 最小行动 | 收益与验收 | 投入 / ROI 判断 |
|---|---|---|---|---|
| 25 token：记忆后台会话长期复用可能积累旧批次 | `memory-pipeline.ts:706` 复用同 agent/model 会话，每次又提供当前批次完整材料。provider 可能自动压缩/缓存，实际输入增长尚未验证；复用也节省启动成本。 | 采样第1/5/10/20轮 input/cache/output token，比较固定轮数或上下文阈值换会话。确认有净收益再实现轮换。 | 只在旧上下文增加的成本高于缓存与启动收益时采用；事实提取质量不退化。不能直接宣称线上计费呈平方增长。 | **评测1日；实现1–2日**。不作为已证实的费用事故。 |
| 26 性能：多订阅按订阅者重复空闲读库 | `persistent-event-publisher.ts:155/174/221` 每秒 wake，独立 cursor 各查页。1个会话20订阅空闲 tick 实测20次页读取。慢订阅隔离、分页及 clone 都是现有有效保护。 | 先每 session 查一次高水位，无新增不 drain；同水位共享页只在高订阅规模下进一步评测，保持各 cursor 独立。 | 空闲读取约 O(订阅者S)→O(会话U)，单用户单连接收益很小。验收：1/20/100订阅SQL数，慢订阅不影响其他连接、无漏回放。 | **1–2 日**水位短路；共享页暂缓。 |

**落地顺序与收益核算**

第一批先做 01、02、03、06 的小范围修改，并在 04 中先完成预算前置。每项独立验证、独立交付；这些工作不依赖新架构。同步完成 12 的计量修正，以免后续降本评测使用错误口径。第二批按观测结果选择模型分工/检索输入（04、05、16）或 Web 长历史（09–11）；运行多 PTY 时提前做 07、08。第三批才引入预留预算、全局运行槽、历史冷热分离等状态较多的改造。

性能收益不能跨层直接相加：02/03 同时影响结果等待，09/10/24 同时影响首屏，04/05/16 同时影响一次群回复。业务最终指标应是“成功交付任务的成本与等待时间”，而非单个 token 单价或单次 SQL 耗时。

建议利用现有账本增加以下观测：accepted→真正开始的排队时间、开始→首输出、completed→成功交付、每个 origin 的模型调用次数与 input/output/cache-read/cache-write、unavailable 占比、每个成功交付的总成本、失败/重试成本、事件循环延迟、活跃 driver/RSS、DB/转录文件增长。端到端 event-loop 指标可使用 Node 的 [Performance measurement APIs](https://nodejs.org/api/perf_hooks.html)；这里不预设必须引入一套新的监控平台。

模型费用核算应分别计算非缓存输入、缓存读取、缓存写入和输出，再加 provider 特有费用；优先对齐实际账单，不把仓库默认估价表当成当前采购价。同口径业务量与质量门槛下，月度净收益估算 = 旧方案总交付成本 − 新方案总交付成本 − 未计入前项的新增运维成本；两种交付成本均包含模型升档、失败和返工。回收周期 = 工程投入成本 ÷ 月度净收益。当前缺少真实使用分布和账单，不提供虚构的“每月节省 X 元”或统一降本百分比。

保留当前 SQLite 路线。WAL 已启用，也已有事件游标索引；先消除宽查询和重复查询，再评估写入批处理或独立数据库线程。WAL 仍是单 writer，checkpoint 也有延迟/耐久性取舍，不能用调低同步保障换取表面性能。[SQLite WAL 官方说明](https://www.sqlite.org/wal.html)

**本次验证记录**

| 检查 | 当次结果 | 能证明与不能证明的范围 |
|---|---|---|
| `pnpm typecheck` | 15个 workspace 项目通过 | 当前类型检查通过；不等于完整功能 E2E 通过。 |
| 飞书 API/交付相关5组测试 | **159/159通过**，8.18秒 | api-gate、service、result-delivery、artifact-delivery、reconciler；新增半开并发缺口由额外隔离复现发现，既有测试通过不表示无缺陷。 |
| 上下文/成本相关6组测试 | **81/81通过**，8.93秒 | usage-ledger、usage-cap.integration、team-context、memory-pipeline、group-task-context、readonly-decider；包含真实 AcpxAdapter配本地假服务。 |
| 运行时/调度相关7组测试 | **110/110通过**，12.83秒 | persistent-event-publisher、queue-hold、acp lifecycle、failure-isolation、session-automation、github-actions、ask-broker。 |
| Web build | 通过；入口 gzip 224,962B | 构建成功不代表性能预算成功；有分享页静态依赖影响 lazy chunk 的构建告警。 |
| 原样 history benchmark | **失败**：224,962B >143,360B | 其余断言排在包大小前且未失败，但脚本最后才打印指标，未获得当次其他准确 p95，不能补写估值。现成脚本的 storage 导入解析到 dist，本次未重建全部 packages，源码/产物同步性未核验；本次 Web 构建得到的包大小证据不受影响。 |
| 原样 browser benchmark | **未完成 / unverified**：15分钟验证预算，到15分20秒检查仍未结束，SIGINT中止、退出130；stdout/stderr为空，没有最终p95 | 临时DB/mock runtime；不是断言失败，也不据此推断线上性能。本次Node、esbuild、Chromium的8个进程均确认退出，自有临时DB目录已清理。现成脚本的包产物同步性亦未核验。 |
| SQL/UI 合成微基准 | 5万历史51页；摘要2千次task读取；EXPLAIN确认索引缺口；详细值见问题表 | 直接导入 storage/src、task-execution-migration.ts 等当前被测源码；与浏览器基准并行，绝对耗时受负载影响；timeline/index一般20样本、reconcile仅5样本，其样本p95不当作稳定线上SLA。短文本/小JSON不能替代真实payload分布。 |
| 运行时合成复现 | 50k回放250页/227ms；4假tmux watcher阻塞881ms；JSONL 50.75MB同步142ms/未完成行16MiB；12 session峰值12；20订阅20读 | 进程延迟人为注入，driver和event source为mock；仅证明机制与扩展方向。 |
| 成本/网关合成复现 | 半开8/8放行；取token8次；cache-write-only估价0；近预算10次准入；双prompt103,738字符；提取prompt1,249,337字符 | 不包含真实模型token/缓存/价格测量；不证明线上实际超支或超长输入发生率。 |

本次没有运行全量测试（已统计 packages/apps/tests 下有388个 .test.ts/.test.tsx 文件），也没有完成真实模型、真实上游抖动、真实大转录和长期负载的 E2E。实施相关改造时，应增加对应回归，特别是 ACP session/env 变更必须使用真实 AcpxAdapter 和持久化 session key，不能只 mock 客户端。

本次临时复现入口：`/tmp/dutydeck-runtime-audit/reproduce.mjs`（`node --import tsx`），`/tmp/dutydeck-data-ui-audit.mts`（仓库环境下 `node --import tsx`），结果 `/tmp/dutydeck-data-ui-audit-results.json`，原样构建/基准状态 `/tmp/dutydeck-data-ui-benchmark-status.txt`。它们只用于隔离验证，不进入业务构建。时间数字来自当次运行而非预计优化结果。

**主要源码定位**

以下路径均相对仓库根目录，行号对应本次审查基线。

| 范围 | 代码位置 |
|---|---|
| 飞书网关与客户端 | [api-gate.ts](../apps/server/src/lark/api-gate.ts):500；[service.ts](../apps/server/src/lark/service.ts):1884、1909；[routes.ts](../apps/server/src/lark/routes.ts):63；[workbench-fetch.ts](../apps/server/src/workbench-fetch.ts):2；[coordinator-dispatch.ts](../apps/server/src/lark/coordinator-dispatch.ts):629 |
| 任务执行与事件 | [runtime](../packages/agent-runtime/src/index.ts):1893、1962、2302；[publisher](../packages/agent-runtime/src/persistent-event-publisher.ts):155、174、221；[task-execution](../packages/storage/src/task-execution.ts):54、511、628；[migration](../packages/storage/src/task-execution-migration.ts):18 |
| PTY | [tmux-backend](../packages/session-backends/src/tmux-backend.ts):181、518、587、707；[tail](../packages/pty-driver/src/transcript/tail.ts):254、266 |
| 群与记忆 | [group-participation](../apps/server/src/lark/group-participation.ts):392；[team-context](../apps/server/src/lark/team-context.ts):73；[readonly-decider](../apps/server/src/lark/readonly-decider.ts):118、132；[memory-pipeline](../apps/server/src/lark/memory-pipeline.ts):389、460、613、635、700、706；[coordinator-dispatch](../apps/server/src/lark/coordinator-dispatch.ts):1002、1016、1077 |
| 成本与调度 | [usage-ledger](../apps/server/src/usage-ledger.ts):36、190；[usage storage](../packages/storage/src/usage-ledger.ts):63；[session-automation](../apps/server/src/session-automation.ts):816、837、1195、1467 |
| HTTP / Web | [app](../apps/server/src/app.ts):206、382、460；[event-history](../apps/web/src/event-history.ts):24、40、60；[App](../apps/web/src/App.tsx):196、261、271；[TimelineView](../apps/web/src/components/TimelineView.tsx):52；[ActivityPanel](../apps/web/src/components/ActivityPanel.tsx):29；[useSessionStream](../apps/web/src/useSessionStream.ts):45；[main](../apps/web/src/main.tsx):6 |
| 基准与存储 | [benchmark-history](../scripts/benchmark-history.mts)；[benchmark-browser](../scripts/benchmark-browser.mts)；[storage](../packages/storage/src/index.ts):147、307、331 |

独立复核已完成；采纳了终态 flush 屏障、SSE 建连水位、收益公式与行号四项修正，避免优化方案破坏事件归属或重复计算收益。

交付状态：审查与方案；优化尚未实施。未改动既有 `docs/README.md`、`.claude/` 或竞争研究文档。
