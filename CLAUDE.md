# Agent Dock 开发约束

## ACPX 持久化键名

- ACPX 会持久化 `session_options`，并递归校验其中所有对象的键名；持久化键必须使用 `snake_case`。
- 不要把 `UPPER_SNAKE_CASE` 环境变量名直接写入 `acpx.session_options.env`，否则保存会话时会触发 `Persisted key policy violation`。
- Agent Dock 群聊工具的运行时变量使用 `dutydeck_group_tools_url` 和 `dutydeck_group_tools_token`。如果需要兼容旧的大写变量，只能在读取边界兼容，写入 ACPX session 的键仍必须是小写 `snake_case`。
- 修改 ACPX session 配置或环境变量注入逻辑时，必须增加使用真实 `AcpxAdapter` 和持久化 session key 的回归测试；仅 mock ACP 客户端无法覆盖持久化键名校验。

