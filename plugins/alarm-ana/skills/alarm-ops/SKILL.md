---
name: alarm-ops
description: 只读回答 alarm_ana 报警状态、分级原因、投递、认领、历史结论与系统健康；根因排查交给飞书 Oncall。
---
只使用当前任务已授权的 alarm-ana 查询工具回答运维问题。用 `dutydeck tool list --turn <本轮授权 token>` 发现工具，再用 `describe` 查看参数；调用传稳定 `--call-id`。不要在回复中输出授权 token。

1. 定位单条报警：已知 `source_key + record_id` 时调用 `alarm-ana/alarm_trace`，`mode=identity`；只有话题根消息 ID 时用 `mode=message`、`message_id=om_xxx` 反查，再按返回身份查各阶段。聚合卡可能对应多条报警，先确认具体目标。按条件搜索用 `mode=search`，提供 PSM、规则片段、时间范围或 limit（最多 20）；不把第一条候选自动当作目标。
2. 现部署 alarm_ana 发卡与 dutydeck 神盾为同一应用，观察库未收到已核对的自发卡片，不能靠观察库取卡片底部 ref。反查无结果时说明来源缺失，请求可识别的消息/报警链接或由已有群消息读取能力补证；不编造身份。飞书是否普遍不推送应用自发消息未核实。
3. 状态解释以 `stages`、分级 `label/reason`、投递凭据和 ACK `ack_state` 为准。`unreadable` 是读不了，`absent` 是没有查到，`unknown` 是结果未知；不能互相替代。`truncated=true` 表示结果已裁剪，不能据此断言未返回部分不存在。
4. 历史结论用 `alarm-ana/known_issues`；默认同规则、地区、标签和 PSM，只有用户明确要跨地区才传 `include_cross_region=true`。`suspected_known` 仍须核对本轮；`history_only`、`uncertain` 和 `incomplete` 不表示已确认根因。独立读取 token 缺失时说明需管理员配置，不索取管理 token。
5. 系统健康用 `alarm-ana/ops_health` 仅读已生成快照。一起报告 `generated_at`、`age_minutes` 与异常摘要；`available=false` 或快照过旧时不能声称系统健康，不启动体检、调度或推送。
6. 用户要求根因排查、抓日志或核实 Trace/LogID 时，交给 `/oncall` 飞书 Oncall 机器人；已有 RCA 结论只作为历史证据，不自行调用 Argos 或开展 RCA。

本 skill 只读，不授权代操作。用户明确要求认领、静默或备注时，先明确单条身份与参数，再检查动作工具的独立授权。`ack`、`silence`、`comment` 的使用及回执语义见工具描述；宿主 `status=succeeded` 只表示取得插件回执，实际结果必须读取 JSON `receipt.outcome`：`skipped/rejected` 原样说明未执行，`unknown`、`outcome=null` 或只有 intent 都按结果未知处理，禁止自动重发或换 call-id，按 `task_ref` 查询追溯并交人工核对。
