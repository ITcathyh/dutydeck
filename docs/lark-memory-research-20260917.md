# Agent 记忆对标调研（2026-09-17）

> 目的：为 Dutydeck 飞书机器人的记忆能力定方案。覆盖 Anthropic 官方产品、字节内部 5 个自研产品与 2 个灰度 harness、开源与商业产品 14 个。
> 证据等级：**已确认** = 读了官方文档或一手设计文档全文；**二手** = 来自搜索摘要或转述；标 `unverified` 的不作为设计依据。
> 内部文档原文副本在本次会话 scratchpad，未入库。

## 一、结论

1. **常驻只放索引，正文按需读。** 没有一个成熟产品把全部记忆拼进每轮 prompt。Claude Code 只常驻 `MEMORY.md` 首 200 行 / 25 KB，主题文件按需读；Hermes 常驻两个文件合计约 3.6 K 字符；Argos 常驻 `_index.md`；Devin 只常驻触发描述；Letta 常驻带字符上限的 block。当前实现「每轮注入 60 条 / 6 KB」要改。
2. **写入侧比召回侧重要。** 内部 Nexus 测评：1039 题通过率 52.6%，其中记忆服务真正生效只有 24.0%，55.7% 靠 Agent 用 grep 遍历日记文件兜底；失败的 62% 是抓取阶段只拿到元数据、事实从未入库。Argos 实测用户主动说「记住」只覆盖约 19% 的应记内容。所以必须有后台兜底提取，而且提取要拿到完整对话。
3. **整理（dreaming）是标配，且不能只靠一个 prompt。** Letta 已把 sleep-time 更名 Dreaming（步数阈值或 compaction 触发，后台子 agent 合并教训并写入 git 化的 MemFS）；Codex 在会话空闲时后台提取，抽取与整理用不同模型；Argos V0 用单个 skill 自由整理，出现相似 topic 爆炸和「用户纠正 A、下次召回 B」，V1 改成 Agent 决策（UPDATE/NEW/SPLIT/NOOP）→ 确定性门禁（结构检查，最多重试 3 轮）→ 定时合并三段。
4. **整理和兜底提取从主会话 fork，不起独立 agent。** Argos：fork 后前缀 100% 命中，cached token ≥90%，成本降到 1/5；独立 Extractor Agent 被验证为「贵或差二选一」。Hermes 的 Background Review 同理，且新消息到来即取消，后台永不阻塞前台。
5. **双层存储：只追加的原始层 + 正交的精炼层。** Argos `source/日期.md` + `refined/{entity}/{topic}.md`；OpenClaw `memory/日期.md` + `MEMORY.md`；Coze Claw `recent_memory` + `MEMORY`；TencentDB L0 账本 → L1 原子事实 → L2 场景 Markdown → L3 persona。更正旧结论用显式替换（team-memory `supersedes`、Hermes `replace`、Zep 失效区间），不是新增一条。
6. **两类记忆要分开：人写的规则 vs 机器学到的经验。** Claude Code 的 CLAUDE.md vs auto memory、Codex 的 AGENTS.md vs memories（官方定位后者为「辅助回忆层，不是必须始终生效的规则源」）、Cursor 的 Rules vs Memories。对应到本项目：bot 级 `preInjectPrompt` / 群级人设是规则层，记忆是经验层。
7. **按场景隔离可写文件与权限。** Coze Claw 的挂载矩阵：主人私聊才有 SECRET；群聊只挂 MEMORY / CONTACT / recent_memory；非主人场景基础设定只读。team-memory 个人 / 项目 / 团队三级，写入时确认可见范围。Claude Tag 按 channel 隔离，私有 channel 不外泄。
8. **记忆来自不可信内容时是攻击面。** Cursor Automations 文档明示「不可信输入可能写入误导性记忆影响后续运行」；Codex 写入前脱敏；Devin 建议须人工批准才保存；OpenClaw flush 期间只留 read/write 两个工具且路径必须精确匹配，MEMORY.md 强制只读。

## 二、对标表

| 产品 | 存储 | 作用域 | 进入模型的方式 | 写入者 | 整理 / 触发 | 用户控制 | 证据 |
|---|---|---|---|---|---|---|---|
| Claude Code auto memory | `~/.claude/projects/<repo>/memory/`：`MEMORY.md` 索引 + 主题文件；frontmatter `type` 与 `modified` | 按 git 仓库（跨 worktree 共享），机器本地 | 索引首 200 行 / 25 KB 常驻；主题文件按需读 | Claude 会话中自写；用户说「记住」 | 无后台流程；写超限时提醒重写索引 | `/memory` 查看编辑；`autoMemoryEnabled` | 已确认 |
| Claude API `memory_20250818` | 客户端实现，`/memories` 目录，六命令 view/create/str_replace/insert/delete/rename | 应用自定 | API 自动注入「先 view 记忆目录」协议；按需读 | Claude 工具调用 | 无内建；建议搭配 compaction | 应用自管；须做路径穿越防护 | 已确认 |
| Claude Tag | Anthropic 托管 | 按 channel；公开 channel 记忆 workspace 共享，私有隔离 | 未公开 | 用户「remember for this channel」+ Claude 自动 | 未公开 | 管理员查看 / 编辑 / 删除 | 已确认（机制细节未公开） |
| Codex memories | `~/.codex/memories/` Markdown | 本机用户 | 「辅助回忆层」注入 | 后台抽取器 | 会话空闲触发；`extract_model` / `consolidation_model` 分离；跳过短会话；脱敏；限流则跳过 | 默认关闭；`/memories` 每聊天开关 | 已确认 |
| Cursor Memories | 托管 | 项目 × 个人 | 自动生成的 rule | agent；用户按需 | 无 | Settings；Automations 版有注入警告 | 部分 `unverified`（文档页不可达） |
| Cline Memory Bank | 6 个 Markdown | 项目 | 每次任务全量读 | agent 按指令 | 用户说「update memory bank」 | git | 已确认 |
| Devin Knowledge | 组织级文本条目 + 触发描述 | org / enterprise / repo / 个人开关 | 触发描述匹配后整条读入 | 用户创建；Devin 建议但不自动保存 | 无 | 批准 / 编辑 / 停用 / 宏 | 已确认 |
| Shopify River | 仓库 skills + AGENTS.md；Postgres 会话 | zone / repo / channel | skills 按需 | 人 + agent | 人工从对话挖模式回写 skill | code review | 已确认 |
| Mem0 | 向量 + SQLite | user / session / agent | top-k 检索 | LLM 抽取 | 2026-04 起只 ADD 不 UPDATE/DELETE | API | 已确认 |
| Letta | context block（字符上限）+ MemFS（git）+ archival | agent；block 可共享 | block 常驻 | agent 工具 + Dreaming 子 agent | 步数阈值或 compaction；可选二审但不问人 | `/remember` `/doctor`、git、read_only | 已确认 |
| Zep / Graphiti | 双时态知识图 | user / thread / group | 混合检索 + 有效期过滤 | 按 episode 摄入 | 持续增量；矛盾置失效不删 | 时点查询 | 已确认 |
| TencentDB Agent Memory | SQLite + FTS5 + sqlite-vec；L2/L3 Markdown | user / session | L2/L3 引导，L1/L0 下钻 | 异步管线 | L1 每 1/2/4/8/16 轮 warm-up 后每 5 轮 + idle；四元决策 store/update/merge/skip | 编辑 Markdown；可回溯到源消息 | 触发节奏来自知识库 2026-05-30 源文（二手） |
| LangMem | LangGraph store | namespace | 检索或 profile 注入 | 热路径工具或后台 | 应用调度，建议空闲后 | store API | 已确认 |
| **Argos「阿狗」**（内部） | 文件系统：`source/日期.md` 只追加 + `refined/{entity}/{topic}.md` + `_index.md` | 按 Project（团队 / 群） | SessionStart hook 注入 `_index.md`；正文按需读 | 用户「记住」+ 每 3 轮 fork 主会话兜底提取 | Dream skill（UPDATE/NEW/SPLIT/NOOP）→ CriticGate → 定时 Consolidation | 文件可 diff / 回滚 | 已确认 |
| **team-memory / Team Mind**（内部） | 服务端 + MCP | 个人 / 项目 / 团队 | 新会话注入「近期团队记忆」；十余个 MCP 工具按需查 | Hook 采集 + `save_memory` | `supersedes` 显式替换 | Web 页；`in_repo` 只采公司项目 | 已确认 |
| **Coze Claw 3.5**（内部） | 按场景挂载文件矩阵，TOS | 主人 / 非主人 × 私聊 / 群 / 项目 / 邮件 | 挂载文件 | SummaryAgentV2 | 每日定时 + `context_compact_end`；先写成功再推进 cursor | 群聊不给 SECRET；非主人基础设定只读 | 已确认 |
| **豆包长期记忆**（内部） | Saved Memory 版本化 + User Insight + History 向量库 | 按用户 | Saved Memory 拼 System Prompt；History 走 `SearchChatHistory` 工具，上限 16 K token | 2.5B 小模型准实时抽取 | 每日离线推理 | Saved Memory 可编辑，Insight 不可 | 已确认 |
| **Hermes**（内部灰度） | `USER.md` ≤1375 字符 + `MEMORY.md` ≤2200 字符 + SQLite FTS5 | agent | 两个文件常驻 System Prompt；历史走 `session_search` | agent 工具 + Background Review | 每约 10 轮 fork 后台自省；新消息即取消；`replace/remove` 走 staged approval | 写满即失败交回 Agent 决策；Frozen Snapshot 下轮生效 | 已确认；Nexus 测得原生覆盖率仅 2.3% |
| **OpenClaw**（内部） | `MEMORY.md` 用户维护 + `memory/日期.md` 自动追加 | agent | 检索：分块 + embedding + BM25 → SQLite，MMR 去重、时间衰减，可降级纯 FTS | Memory Flush 子 agent | compaction 前抢救写入（阈值 = 窗口 − 20000 − 4000） | flush 期间只留 read/write，MEMORY.md 只读 | 已确认；Nexus 测得失败 case 平均 27.3 次工具调用 |

## 三、反例与实测数据（都来自一手文档）

- Nexus Bot 二期（LifeBench 1039 题）：通过率 52.65%；记忆服务真正生效 24.0%；文件遍历兜底 55.7%；失败 62% 源于抓取只拿到元数据。系统性漏捕三类：对话里转述的第三方信息、特定时间窗细节、聊天记录里提到的他人信息。MEMORY.md 存泛化模式不存具体实例会答错；top-10 纯语义召回不够，需叠加实体 / 日期过滤。
- Argos：用户主动「记住」只覆盖约 19%；V0 单 skill 整理导致相似 topic 爆炸与更新不一致；fork 主会话提取成本 1/5、cached ≥90%。2025 年做过 mem0 式 RAG 记忆，放弃理由是 topic 边界被埋进向量空间，不可解释、不可 diff、不可回滚。
- Hermes：原生记忆覆盖率约 2.3%，新记忆覆盖旧记忆；靠 `session_search` 兜底才没有明显更差。
- OpenClaw：找不到记忆时「反复 grep → 上限耗尽 → 编造或拒答」，失败 case 平均 27.3 次工具调用。
- team-memory：装完 Hook / MCP 不够，必须把用法写进 CLAUDE.md / AGENTS.md，否则 agent 不主动查、还会把结论写进本地记忆导致团队搜不到。
- 评测方法：测记忆能力必须关掉文件遍历工具，否则会把 24% 误读成 52%。

## 四、对 Dutydeck 现有实现的修订

现有实现（未提交）：按机器人 + 聊天存 SQLite `configs` KV，墓碑删除，`/remember` `/memory` `/forget`，Agent 工具 `dutydeck memory list|add|remove`，每轮全量注入（≤60 条 / 6 KB）。账本、命令、Agent 工具面可复用；要改的是「怎么给 Agent 看」和「谁来整理」。

| 项 | 现状 | 修订 | 依据 |
|---|---|---|---|
| 注入 | 每轮全量 | 常驻 ≤ 2–3 KB 的 `MEMORY.md` 索引（按主题分节、一句一条、带编号）+ 一行「细节读目录或 `memory search`」；正文按需读 | 结论 1 |
| 存储 | SQLite 账本 | SQLite 账本仍是权威源；派生 `.dutydeck/memory/<appId>/<chatId>/{MEMORY.md, ledger.jsonl, topics/*.md}`，可重建 | 结论 5、Argos / Letta 用文件的理由 |
| 写入 | 用户 `/remember` + Agent 随手 `add` | 用户显式写入保留；Agent 实时写收窄为「用户明确要求」；跨任务事实交给兜底提取 | 结论 2、8 |
| 兜底提取 | 无 | 每 N 轮（起始 3）在该聊天的会话上 fork 一轮提取，输入含完整对话与最终回答；产出 claim 写入账本 `source=extraction` | Argos、Hermes |
| 整理 | 无 | 三段：Agent 决策（UPDATE/NEW/SPLIT/NOOP，按 topic 边界）→ 确定性门禁（结构、编号回指、非空证据、上限）→ 定时合并；触发 = 累计 8 轮完成或空闲 30 分钟或 `/memory consolidate`；同聊天单飞 | 结论 3 |
| 更正 | 墓碑 + 新增 | 增加 `supersedes` 字段，视图行只展示最新，账本保留链 | 结论 5 |
| 用户原话 | 可被改写 | `source=user` 条目整理时不得改写，只能标过时 | Devin、Hermes 对删除的谨慎 |
| 权限矩阵 | 单一 | 群聊 vs 私聊、发起人 vs 其他成员分别定可写集合；凭据类永不入库 | 结论 7、8 |
| 检索 | 无 | `memory search <关键词>`：账本 LIKE / FTS，加时间与来源过滤；不上向量库 | Argos 弃 RAG、Nexus 建议实体 / 日期过滤 |
| 常驻上限 | 截断 | 索引写满时整理失败并交回 Agent 缩写，不静默截断 | Hermes |
| 评测 | 无 | 用小样本题集测；测时关闭文件遍历，只看记忆路径命中 | Nexus |

待用户决定：作用域是否只按聊天（对标 Claude Tag）还是加按项目目录（对标 Claude Code auto memory）；整理是否现在做；整理模型是否与机器人 Agent 相同。

## 五、证据边界

- Claude Tag 的记忆检索机制、是否有后台整理：官方未公开。
- Cursor Memories 的观察者与批准流程：文档页不可达，二手。
- Gemini CLI `save_memory` 是否仍存在：仓库文档与站点文档相互矛盾。
- TencentDB 触发节奏：来自知识库 2026-05-30 对源文章的记录，未重读仓库。
- 内部：飞豆 / AIME / iDA / 飞书 Aily 未找到记忆设计文档；`bytedcli insearch` 的四个来源（feishu drive / messages、bytedance.net、bytetech.info）未鉴权或超时，结论主要来自飞书文档搜索。

## 六、来源

官方：
- https://code.claude.com/docs/en/memory
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://claude.com/docs/claude-tag/users/memory.md ｜ https://support.claude.com/en/articles/15594475
- https://support.claude.com/en/articles/11817273（claude.ai memory）
- https://learn.chatgpt.com/docs/customization/memories?surface=app（Codex memories）
- https://developers.openai.com/codex/guides/agents-md
- https://geminicli.com/docs/cli/gemini-md/ ｜ https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/memory.md
- https://cursor.com/changelog/1-0 ｜ https://cursor.com/help/ai-features/automations
- https://docs.cline.bot/best-practices/memory-bank
- https://docs.devin.ai/product-guides/knowledge
- https://docs.factory.ai/guides/power-user/memory-management
- https://shopify.engineering/under-the-river

开源：
- https://github.com/mem0ai/mem0 ｜ https://docs.mem0.ai/open-source/graph-memory
- https://docs.letta.com/guides/agents/memory-blocks ｜ https://docs.letta.com/guides/agents/sleep-time-agents
- https://arxiv.org/abs/2507.03724 ｜ https://github.com/MemTensor/MemOS
- https://arxiv.org/abs/2501.13956 ｜ https://github.com/getzep/graphiti
- https://github.com/TencentCloud/TencentDB-Agent-Memory
- https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- https://arxiv.org/abs/2304.03442（Generative Agents）

内部（飞书文档，需登录）：
- Argos《让 Agent 越用越懂你：记忆、做梦与自进化的技术实现》 https://bytedance.larkoffice.com/docx/WTWXdT9XxoClqPx3UGScSgYinFf
- team-memory / Team Mind https://bytedance.larkoffice.com/docx/VgoDdiCN4oLFk3xTZjKcVIz0nRe
- Coze Claw 3.5 记忆整理改造 https://bytedance.larkoffice.com/docx/XaIfdu29poy1RaxPXgDcxii9nZb
- 豆包长期记忆设计方案 https://bytedance.larkoffice.com/wiki/XcEPwkezLimEEZkJJyqcdYELnjf
- Nexus Bot Memory 二期测评 https://bytedance.larkoffice.com/docx/LwNJdPA42oFN0rxvBsecE1einHg
- Hermes 记忆系统 https://bytedance.larkoffice.com/wiki/RuCJwvXzjiDBiNkMPTdc9Uw4nkc ｜ https://bytedance.larkoffice.com/wiki/Ui6FwvlIhiI88GkiYMMcSL1dn5g
- OpenClaw 记忆系统源码分析 https://bytedance.larkoffice.com/docx/UuBvdEEs8oJPoYx8uU3cEEHenZx

知识库（本机）：`entities/agent-memory.md`、`notes/2026-05-05-agent-memory-ledger-views-policy.md`、`notes/2026-05-30-tencentdb-agent-memory.md`、`notes/2026-05-04-personal-harness-design.md`、`notes/2026-05-26-shopify-river-lehrwerkstatt.md`
