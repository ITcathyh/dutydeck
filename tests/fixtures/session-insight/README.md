# Session Insight Test Fixtures and Provenance

本文档记录 Session Insight V1 契约与样本材料说明、SHA256 校验和、采样时间、客户端版本以及合成边界用例说明。

## 1. 样本概览与真实 Usage 缺失说明 (NEEDS_CONTEXT)

- **真实日志与真实 Usage 缺失声明 (`NEEDS_CONTEXT`)**：
  `pty-driver-dialects` 为既有驱动最小投影，省略了 usage 字段；`upstream-sanitized` 为上游 synthetic 测试数据，无真实采集证明，其内部数值与时间仅为用例构造，不可作为真实生产环境 usage 的数据依据。严禁为满足统计口径而造数。针对真实环境中真实 usage 的完整样本，明确报告为 **`NEEDS_CONTEXT`**。
- **客户端版本与采样时间**：
  测试材料无真实客户端版本，统一记录为 **`unknown`**；上游测试数据内部的 timestamp 仅为用例构造时间，无真实采集证明，采样时间统一记录为 **`unknown`**。
- **边界样本覆盖 (Synthetic)**：
  为了验证累计值增量、reset 行为、多 message 聚合、子 Agent 关联及复杂工具方言，提供了明确标 `synthetic` 的边界用例。
- **Golden JSON 性质说明**：
  `golden/` 目录下的 JSON 仅作为跨 Go/TS 的**协议接口契约定义与反序列化示例**（Protocol Fixture），并非当前无状态 Go 引擎实测产物。待 T1 引擎 CLI 交付后，将产出真实引擎执行结果进行比对。

---

## 2. 既有脱敏材料

### 2.1 pty-driver 方言投影 (`pty-driver-dialects/`)
来源：`packages/pty-driver/src/fixtures/transcript-dialects/`（采样时间：2026-09-26，脱敏投影，Client version: `unknown`）

| 文件名 | 客户端 | 字节数 | SHA256 校验和 | 采样时间 | 备注 |
|---|---|---|---|---|---|
| `claude.jsonl` | claude | 183 | `67a7d5a8ffb733f0624f200fb36587c6f5217dafccee4c51ba5d2ce298aefddd` | 2026-09-26 | 真实 assistant text 记录的最小 schema projection（不是 tool_use），真实 usage 省略 |
| `codex.jsonl` | codex | 131 | `6e96f8eecf40e7dba0eaf33e43f651188642e8856f2322e19240066a29b6c970` | 2026-09-26 | task_complete 最小投影，真实 usage 省略 |
| `traex.jsonl` | traex | 116 | `c7077707483bbdd9bdbb7a9488edc8fd3127fa0833e5674d36f42bb2b531cd14` | 2026-09-26 | agent_message 最小投影，真实 usage 省略 |

### 2.2 上游引擎测试数据 (`upstream-sanitized/`)
来源：上游 `session-insight-engine` 之 `server/internal/sessioninsight/testdata/`（上游测试套件脱敏结构，非生产证明，Client version: `unknown`，采集时间: `unknown`）

| 文件名 | 客户端 | 字节数 | SHA256 校验和 | 备注 |
|---|---|---|---|---|
| `claude-main.jsonl` | claude | 2505 | `37e8177fe8cb9340aa0d47302ad9c86aaa850f4974e38bd7f8bb76687930c3e9` | 含 compact_boundary, tool_use, tool_result, thinking, text, malformed line |
| `claude-subagent-worker.jsonl` | claude | 491 | `bf16dfeee5d2b12609db22dd9399c929031973cadcbd0a30c218786f52150094` | worker 子 agent，isSidechain: true |
| `codex-modern.jsonl` | codex | 1990 | `f66ad0fbd34f253890804aa22bf89130c0d017eb11210e789f16c7adc4f5ded7` | 含 reasoning, function_call/output, token_count (total & last) |
| `codex-legacy.jsonl` | codex | 541 | `d6c9e2ea4373264aa8aa8b283e30da978cfa24ac43a104dff31746b56712cace` | 归档 legacy 格式，function_call/output |
| `traex-modern.jsonl` | traex | 2278 | `baa60788cc6bd95819607e9d35b792f4c06e032aaaf4558e5b96736c787063a7` | 含 exec_command_end, history_mutation, sub_agent_activity |
| `traex-legacy.jsonl` | traex | 755 | `06f8149cb06bf458a709f34fa9da87c160afd54060e97fecac9997678664018a` | 早期 trae 格式，response_item 包装 |

---

## 3. 合成边界样本 (`synthetic/`)
构造时间：2026-10-03，人工合成构造，遵循设计文档第 4.2 节累计与分桶语义。Client version: `unknown`。

| 文件名 | 客户端 | 字节数 | SHA256 校验和 | 核心验证语义 |
|---|---|---|---|---|
| `cumulative-100-to-150.jsonl` | codex | 751 | `cbc896a50367f7c6301b035466363b04c3a8a8f846a8e845c763c1480005a24a` | 未知基线 100→150：首增量为 null，观察区间增量 50，源最后累计值 150，全范围总量 partial/null |
| `reset-150-to-10-no-reset.jsonl` | codex | 669 | `697aef4edcc4b3d6a10596f044a96e8b6731d622f0a8ce6a563678ff94741c29` | 150→10 无 reset 证据：标记 conflict，不计入负数，不计入新增 10 |
| `reset-150-to-10-with-reset.jsonl` | codex | 793 | `a5bef23b03de3367a2f8e47108970672ae1d0b599c2d5022e9cf39f7418fc5e1` | 150→10 伴随明确 session_reset/epoch 证据：开启新计数 epoch，新 epoch 首增量为 10（注意：纯 context_compacted 不构成 reset 证据） |
| `claude-two-messages.jsonl` | claude | 1027 | `1230885d2d704ae005725298cd1f500a006413b6628efd72f4fde3cfc55f6f4a` | 两个独立 assistant 消息 (m1=100, m2=20)：跨 message 合计 120，不是流累计下降 |
| `claude-same-message-dedup.jsonl` | claude | 846 | `af9c27ba1eecb3890c0dec08a6bcc5dc31e2626b31d11974832b8eb23620f47d` | 同一 messageId 多次流式输出：取有效最大快照去重，不重复累计 |
| `claude-main.jsonl` | claude | 603 | `4eca389acf9738934ae7fdc35a2ef4dfc34dcad94e90530fad96b2ad906006e3` | 主流与子流共享 sessionId，通过 agentId 区分；主流调用 subagent |
| `claude-subagent.jsonl` | claude | 574 | `728656d756c42e57554d829fb49cf066dc947f4d56323eac07f4d31598c2de69` | 子流 isSidechain: true，独立 agentId，独立 usage 统计 |
| `traex-special-tools.jsonl` | traex | 1599 | `27924dbd623af62b9b713f41f29adbe6a2fe4676a4524509e7677fbadd79eacd` | CollabAgentToolCall, TerminalInteraction, sub_agent_activity, inter_agent_communication, history_mutation |

---

## 4. 跨 Go/TS Golden 契约 (`golden/`)

- `golden/analyze-request.golden.json`: 标准输入示例，符合 `AnalyzeFilesRequest` (schemaVersion: 1)
- `golden/analyze-result.golden.json`: 协议响应契约示例，符合 `AnalyzeFilesResult` (schemaVersion: 1)，每项严格对应输入：缺 reasoning/rawTotal/contextWindow 标 unavailable/unknown；输入缺 cache 字段时 cacheRead/cacheWrite 为 null/unavailable（不伪称 0），四桶不完整时 totalTracked 为 null/partial；工具只有 tool_use 无配对 result 标 unknown；主流未证实完整子流标 partial。
