# Real Native Session Fixtures & Provenance

本文档记录真实三客户端（Codex CLI、TRAE CLI、Claude Code）的原生日志采样、字段级结构投影、数据保真度及字段说明。所有样本均来自真实 CLI 运行产生的原始日志，保留原生身份结构、源时间戳、实际模型名称与真实 usage 数值。

---

## 1. 真实样本概览

| 文件名 | 客户端 | 流类型 | 行数 | 字节数 | SHA256 校验和 | 采样时间 (UTC) | 客户端版本 | 原生 Session ID |
|---|---|---|---|---|---|---|---|---|
| `codex.jsonl` | codex | main | 32 | 21,286 | `8855c11c4386249a626f158d74fdb0503064cec2d0cf5cb4d101964261ac6987` | 2026-10-03T02:45:40Z | `codex-cli 0.160.0` | `01a0ffa7-270b-72f1-be55-21dde8e42935` |
| `traex.jsonl` | traex | main | 18 | 14,247 | `754d2548800ceb4af06f45c2a91c5ccfa5328276a22e260a2d9228c168d4235b` | 2026-10-03T02:45:07Z | `traecli 0.208.1-alpha.5` | `01a0ffa6-a71d-79b3-9a87-d386f1808e41` |
| `claude-main.jsonl` | claude | main | 6 | 6,157 | `df6d31d43478c20916984cab9da0a8de7761219861a54d5319305b8202d1068b` | 2026-10-03T02:55:10Z | `2.1.288 (Claude Code)` | `0192e000-7a3b-7000-8000-000000000001` |
| `claude-subagent.jsonl` | claude | subagent | 8 | 7,693 | `edc45222add9bb1f9a43dd06478b8ce3547389c1c7b5406878cf532a99d4f0ad` | 2026-10-03T02:55:11Z | `2.1.288 (Claude Code)` | `0192e000-7a3b-7000-8000-000000000001` (agentId: `a01e15e2adc99f940`) |

注：采样时间均基于源文件记录的真实 UTC 时间戳（ISO 8601 UTC），非本地时区 PRC。

---

## 2. 采样执行与结构投影说明

### 2.1 结构投影与自由文本 Placeholder 规则
为避免将数万字符的系统开发指令、环境配置、长文档全文或个人配置带入测试仓库，本 fixture 对自由文本字段采用轻量 placeholder 投影，原生结构字段保持不变：
- **保留字段（未改动）**：
  - 核心元数据：`type`, `status`, `timestamp`, `model`, `exit_code`
  - 身份与调用关系：`sessionId`, `agentId`, `isSidechain`, `uuid`, `parentUuid`, `toolUseId`, `callId`, `turn_id`, `commit_id`
  - 完整用量数值：`input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `reasoning_output_tokens`, `total_tokens`, `model_context_window`
  - 工具标识与安全测试命令：`cat file_a.txt file_b.txt`, `printf 'hello from test\n'`, `exit 1`
- **Placeholder 投影字段**：
  - `session_meta.base_instructions` → `"<base_instructions_placeholder>"`
  - `developer` / `system` prompt 文本 → `"<developer_instructions_placeholder>"` / `"<system_instructions_placeholder>"`
  - `world_state.state` → `"<world_state_placeholder>"`
  - `turn_context` 中的 sandbox/permission 文本 → `"<permission_profile_placeholder>"` 等
  - `tool_result` / `AgentMessage` / `thinking` 文本 → 相应占位符，保留结构对象。
  - `thinking.signature` → `"<signature_placeholder>"`（不透明 blob 不参与分析计算）。

### 2.2 Claude 过滤行映射与范围 (Filtered Line Mapping)
Claude 运行时会在日志中交替写入大批内部系统附件（如 `attachment`, `queue-operation`, `atis-latch`, `last-prompt`, `cost-state`），这些附件包含环境快照与内部 latch，不参与 session insight 的指标与 trace 计算。为保证测试集紧凑，按规则过滤了非分析附件行。

- **`claude-main.jsonl` (原 29 行，过滤保留 6 行核心事件)**：
  - 过滤类型：原 L1-L2 (queue-operation), L5-L11, L13-L17, L23-L24 (attachment), L12, L19, L26 (atis-latch), L18, L25, L28 (last-prompt), L29 (cost-state)。
  - 保留映射：
    - Fixture L1 ← 原 L3: `system` 初始化
    - Fixture L2 ← 原 L4: `user` 用户提问
    - Fixture L3 ← 原 L20: `assistant` 思考与 Agent 启动准备 (usage_in: 22935, out: 751)
    - Fixture L4 ← 原 L21: `assistant` 工具调用 `tool_use: Agent` (同 messageId, usage 去重验证)
    - Fixture L5 ← 原 L22: `user` 工具返回 `tool_result: Agent`
    - Fixture L6 ← 原 L27: `assistant` 最终纯文本响应 (usage_in: 3566, out: 77)
- **`claude-subagent.jsonl` (原 21 行，过滤保留 8 行核心事件)**：
  - 过滤类型：原 L2-L9, L13-L16, L20 (`attachment`)。
  - 保留映射：
    - Fixture L1 ← 原 L1: `user` 接收子任务 (`isSidechain: true`, `agentId: "a01e15e2adc99f940"`)
    - Fixture L2 ← 原 L10: `assistant` 思考
    - Fixture L3 ← 原 L11: `assistant` 工具调用 `tool_use: Read` (读取 file_a.txt, usage_in: 19242, out: 620)
    - Fixture L4 ← 原 L12: `user` 工具返回 `tool_result: Read`
    - Fixture L5 ← 原 L17: `assistant` 思考 (命中缓存)
    - Fixture L6 ← 原 L18: `assistant` 工具调用 `tool_use: Read` (读取 file_b.txt, usage_in: 4048, out: 79)
    - Fixture L7 ← 原 L19: `user` 工具返回 `tool_result: Read`
    - Fixture L8 ← 原 L21: `assistant` 最终纯文本回复 `content: text` (usage_in: 4181, out: 260)

### 2.3 Claude 父子流关联依据 (Parent-Child Proof)
无需依赖未入库的外部 sidecar 文件，主子流父子关系直接由已入库的日志记录证实：
- `claude-main.jsonl` L4 发起 Agent 工具调用：`id: "call_739645"`, `name: "Agent"`；
- `claude-main.jsonl` L5 接收工具执行结果：`tool_use_id: "call_739645"`, `toolUseResult.agentId: "a01e15e2adc99f940"`；
- `claude-subagent.jsonl` 的全部 8 行记录均显式携带 `isSidechain: true` 与 `agentId: "a01e15e2adc99f940"`，与主流回调中的 `agentId` 完全一致；
- 两者共享相同的 `sessionId: "0192e000-7a3b-7000-8000-000000000001"`。

---

## 3. 原始字段关系、预期值与未观测字段 (Recorded vs Unobserved)

### 3.1 Codex 样本 (`codex.jsonl`)
- **记录的字段 (Recorded Fields)**:
  - 4 处 `event_msg` (type=`token_count`):
    - L17: `total: 22946`, `input: 22886`, `cached: 0`, `cache_write: 0`, `output: 60`, `reasoning: 0`
    - L22: `total: 46000`, `input: 45907`, `cached: 22656`, `cache_write: 0`, `output: 93`, `reasoning: 0`
    - L27: `total: 69143`, `input: 68953`, `cached: 45677`, `cache_write: 0`, `output: 190`, `reasoning: 0`
    - L31: `total: 92353`, `input: 92147`, `cached: 68725`, `cache_write: 0`, `output: 206`, `reasoning: 0`
  - 工具执行退出码：
    - L14 (cat): `exit_code: 0`, `status: completed`
    - L20 (printf): `exit_code: 0`, `status: completed`
    - L25 (exit 1): `exit_code: 1`, `status: failed`
- **数值关系与基线状态**:
  - 实测满足：`total_tokens === input_tokens + output_tokens`。
  - **未知基线 (Unknown Baseline)**：首个 token_count 样本（22,946）在日志中缺少显式零基线证明（无 zero/reset 原生事件）；根据规范 §4.2，其首样本增量应标为 unknown baseline，不可假设为全量增量。
- **未观测值 (Unobserved)**:
  - 无独立的 `cache_read_input_tokens` 字段；`cache_write_input_tokens` 均为 0；无每个调用粒度的 token 消耗。

### 3.2 TraeX 样本 (`traex.jsonl`)
- **记录的字段 (Recorded Fields)**:
  - 2 处 `event_msg` (type=`token_count`):
    - L14: `total: 18349`, `input: 18246`, `creation: 18243`, `cached: 0`, `output: 103`, `reasoning: 0`
    - L17: `total: 36849`, `input: 36736`, `creation: 18487`, `cached: 18243`, `output: 113`, `reasoning: 0`
  - 专有结构：`history_mutation` (包含 `display_completions`, `commit_id`, `turn_id`)；嵌套工具调用 `code-mode-nested:29:call_8s9Ss1Lh8IoJ4LimHZMgDcPy:exec-...`；退出码 0 与 1。
- **数值等式与互斥关系评估**:
  - 实测等式：`total_tokens === input_tokens + output_tokens`。
  - 实测观察：在 L17 中，`cached_input_tokens (18243) + cache_creation_input_tokens (18487) = 36730`，接近 `input_tokens (36736)`。
  - **互斥关系结论：`unverified`**。实测等式仅表明数值关系，不能直接推导四桶是否互斥；在缺少官方方言明确证据时，四桶互斥关系记录为 unverified，不能依据等式强行计算合成 tracked total。

### 3.3 Claude 主会话与子会话样本 (`claude-main.jsonl`, `claude-subagent.jsonl`)
- **记录的字段 (Recorded Fields)**:
  - 主会话：
    - L3-L4: `input_tokens: 22935`, `cache_read_input_tokens: 0`, `output_tokens: 751`
    - L6: `input_tokens: 3566`, `cache_read_input_tokens: 0`, `output_tokens: 77`
  - 子会话 (`isSidechain: true`, `agentId: "a01e15e2adc99f940"`)：
    - L2-L3: `input_tokens: 19242`, `cache_read_input_tokens: 0`, `output_tokens: 620`
    - L5-L6: `input_tokens: 4048`, `cache_read_input_tokens: 16187`, `output_tokens: 79`
    - L8: `input_tokens: 4181`, `cache_read_input_tokens: 16187`, `output_tokens: 260`
  - 父子关联：主会话 L4 `tool_use: Agent` 生成 `id: "call_739645"`；L5 `toolUseResult.agentId: "a01e15e2adc99f940"`，与子会话全部行 `agentId` 一致。
- **未观测值 (Unobserved)**:
  - Claude 不直接记录 context_window 与 reasoning_output_tokens（本轮 flash 模型 thinking_tokens 为 0）。

---

## 4. 最小人工可读字段核对表

供 Controller 逐条核对核心字段与预期行为：

| 文件 | 行号 | 记录类型 (`type`) | 关键字段与数值 | 预期解析行为 |
|---|---|---|---|---|
| `codex.jsonl` | L1 | `session_meta` | `cwd: /workspace/test-sandbox`, `model: gpt-6-astra` | 初始化原生 Session，解析出主模型 |
| `codex.jsonl` | L14 | `event_msg` | `CommandExecution`, `exit_code: 0`, `status: completed` | 记录成功工具调用 (cat) |
| `codex.jsonl` | L17 | `event_msg` | `token_count: total 22946, input 22886, cached 0, out 60` | 首个样本，基线状态为 unknown baseline |
| `codex.jsonl` | L20 | `event_msg` | `CommandExecution`, `exit_code: 0`, `status: completed` | 记录成功工具调用 (printf) |
| `codex.jsonl` | L22 | `event_msg` | `token_count: total 46000, input 45907, cached 22656, out 93` | 增量计算 (delta total = 23054) |
| `codex.jsonl` | L25 | `event_msg` | `CommandExecution`, `exit_code: 1`, `status: failed` | 记录失败工具调用 (exit 1)，计入 toolFailures |
| `codex.jsonl` | L31 | `event_msg` | `token_count: total 92353, input 92147, cached 68725, out 206` | 终轮累计 Token，无 reset 标记 |
| `traex.jsonl` | L1 | `session_meta` | `cwd: /workspace/test-sandbox`, `model: GPT-6-Astra` | 初始化原生 Session，解析出主模型 |
| `traex.jsonl` | L7 | `history_mutation` | 包含 `display_completions`, `commit_id`, `turn_id` | Trae 专有补全/函数调用结构保留 |
| `traex.jsonl` | L10 | `event_msg` | 嵌套 callId, `exit_code: 0`, `status: completed` | 记录成功工具调用 (cat) |
| `traex.jsonl` | L12 | `event_msg` | 嵌套 callId, `exit_code: 1`, `status: failed` | 记录失败工具调用 (exit 1)，计入 toolFailures |
| `traex.jsonl` | L14 | `event_msg` | `token_count: total 18349, input 18246, creation 18243, out 103` | 首轮用量记录 |
| `traex.jsonl` | L17 | `event_msg` | `token_count: total 36849, input 36736, cached 18243, creation 18487` | 四桶互斥未证实，totalTracked 标 unverified |
| `claude-main.jsonl` | L1 | `system` | `content: <system_instructions_placeholder>` | 系统初始化提示 |
| `claude-main.jsonl` | L2 | `user` | `content: Please launch a subagent...` | 主会话用户任务入口 |
| `claude-main.jsonl` | L3 | `assistant` | `model: gemini-3.8-flash`, `input: 22935, cache_read: 0, out: 751` | 启动思考与用量快照 |
| `claude-main.jsonl` | L4 | `assistant` | `tool_use: Agent`, `id: call_739645`, 同 messageId | 派生子 Agent，验证同 messageId 用量去重 |
| `claude-main.jsonl` | L5 | `user` | `tool_result: Agent`, `agentId: a01e15e2adc99f940` | 子 Agent 完成回调，建立父子关联 |
| `claude-main.jsonl` | L6 | `assistant` | `content: text`, `input: 3566, out: 77` | 主会话最终回复 |
| `claude-subagent.jsonl` | L1 | `user` | `isSidechain: true`, `agentId: a01e15e2adc99f940` | 子 Agent 启动，验证 isSidechain 与 agentId |
| `claude-subagent.jsonl` | L3 | `assistant` | `tool_use: Read`, `file_a.txt`, `input: 19242, out: 620` | 子流首次工具调用 |
| `claude-subagent.jsonl` | L4 | `user` | `tool_result: Read`, 成功读取 | 子流工具配对 |
| `claude-subagent.jsonl` | L6 | `assistant` | `tool_use: Read`, `file_b.txt`, `input: 4048, cache_read: 16187, out: 79` | 子流缓存命中工具调用 |
| `claude-subagent.jsonl` | L8 | `assistant` | `content: text`, `input: 4181, out: 260` | 子流最终完成回复 |

---

## 5. 机器核验脚本说明

目录内提供可重复核验脚本 `verify-fidelity.mjs`，执行命令：
```bash
# 1. 基础完整性与 Canary 扫描自检：
node verify-fidelity.mjs

# 2. 对照外部原始源日志比对数值一致性（不自动扫描 HOME，需显式传参）：
node verify-fidelity.mjs \
  --codex-raw <path-to-raw-codex-rollout.jsonl> \
  --traex-raw <path-to-raw-traex-rollout.jsonl> \
  --claude-main-raw <path-to-raw-claude-main.jsonl> \
  --claude-sub-raw <path-to-raw-claude-subagent.jsonl>
```
