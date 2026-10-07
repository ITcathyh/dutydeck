# Agent Dock 开发约束

## ACPX 持久化键名

- ACPX 会持久化 `session_options`，并递归校验其中所有对象的键名；持久化键必须使用 `snake_case`。
- 不要把 `UPPER_SNAKE_CASE` 环境变量名直接写入 `acpx.session_options.env`，否则保存会话时会触发 `Persisted key policy violation`。
- Agent Dock 群聊工具的运行时变量使用 `dutydeck_group_tools_url` 和 `dutydeck_group_tools_token`。如果需要兼容旧的大写变量，只能在读取边界兼容，写入 ACPX session 的键仍必须是小写 `snake_case`。
- 修改 ACPX session 配置或环境变量注入逻辑时，必须增加使用真实 `AcpxAdapter` 和持久化 session key 的回归测试；仅 mock ACP 客户端无法覆盖持久化键名校验。

## 重启线上服务

重启线上服务用 `dutydeck restart`，它会等正在执行的任务结束；不要直接用 `systemctl --user restart dutydeck.service`。只有 restart 等待超时、并且确认可以中断这些任务时，才用 `dutydeck restart --force`。在 Agent 会话里执行 `dutydeck restart` 时会自动排除当前会话自己那一轮，不必为「命令本身占着一个 running 任务」而加 --force。

## Dashboard 设置与 CLI 同步

Dashboard 上能改的设置都要能用 `dutydeck settings` 改（`apps/server/src/settings-cli.ts`），用户靠它让 Agent 管理配置。新增或修改 dashboard 的设置项、取值范围或保存接口时，在同一个改动里更新对应的 `dutydeck settings` 命令、键表和 `settings-cli.test.ts`；新的设置面板要加对应命令。机器人、群配置、群协作和接话的键表用 `satisfies` 绑定了服务端保存接口的类型，接口加字段而键表没加会编译失败；枚举取值和新面板没有这层检查，要自己核对。
