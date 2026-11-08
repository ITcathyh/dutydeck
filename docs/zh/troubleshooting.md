# 已知限制与常见问题

> [← 返回 README](../../README.md) · [全部文档](../../README.md#docs) · [English](../en/troubleshooting.md)

## 已知限制 <a id="known-limits"></a>

- **本机 `~/.claude/settings.json` 的 allow 规则会绕过飞书逐项审批。** 飞书里 `ask` / `approve-reads` 的 Claude 终端模式虽然固定用 `default` 权限模式启动，但本机 `permissions.allow` 里的规则仍然生效，命中的操作不会出飞书审批卡。需要严格逐项审批时，清理本机的 allow 规则。
- **ACP 侧预先放行时，`/plan` 的计划阶段拦不住写操作。** 计划阶段靠拒绝 Agent 发来的每个权限请求来拦写。Claude ACP 如果自己预先配了允许规则（如 settings 里的 allow 列表）或默认模式是 bypass，这些操作根本不会来问 Dutydeck。用 `/plan` 时，ACP 侧不要预先放行写操作。
- **凭据保护按规则匹配，不是隔离。** 换个写法（编码、拼接路径、写脚本再执行）可能绕过；完全信任模式下，不在允许名单里的人仍能让 Agent 以本机用户身份运行任意命令。对外开放的机器人用强制拦截，或者不给它完全信任。
- **高危命令正则按原始文本匹配，不是沙箱。** 引号、反斜杠、路径前缀或子 shell 改写（如 `"rm" -rf`、`\rm`、`/bin/rm`、`$(rm …)`、`git 'push'`）都可能绕过；`git -C . push` 这类中间夹了选项的写法同样匹配不到。它只缩小暴露面，口径和凭据保护一致。
- Cursor 终端会话只有原始屏幕输出时，即使回放中可见回答，也可能因缺少规范化最终正文而记为失败。
- 验证门禁目前只对飞书任务生效，且需要先配验证命令。
- 终端模式下，Traex 没有用量数据；Codex 有按轮 token 与估算金额，但暂不计入用量上限。两者都不受美元上限约束。
- 用量金额是估算，不含加价项（见“用量与成本”），不是账单。
- 触发器的普通 token 鉴权不带时间戳和 nonce，靠 HTTPS 或内网保护传输；HMAC 签名请求带时间戳和一次性 nonce。见“插件 → 安全说明”。
- Web 的“群与权限”等草稿页默认隐藏，见“实验功能”。

---

## 常见问题与排障 (FAQ) <a id="faq"></a>

### Q1: 在飞书给机器人发消息，没有反应，也没贴 `👌`？
1. 运行 `dutydeck doctor`，看「飞书监听」一栏是否正常。
2. 到飞书开放平台检查应用是否开启了 **「机器人能力」**，事件订阅方式为 **长连接**（已订阅 `im.message.receive_v1`）。
3. 检查机器人是否在群里；群聊里消息是否 `@` 了机器人（按“话题内免 @”以上的强度时，在已认领的话题里可以不 @）。
4. 默认 Agent 没装或登录过期也会表现为不回：`doctor` 会对默认 Agent 跑 `--version`，并点名找不到的命令。
5. 长连接断开后先由飞书 SDK 自己重连。重连卡住（例如代理接受连接却不回包）超过 10 分钟时，Dutydeck 会只重建这条长连接，进行中的会话不受影响；仍然卡住就按同样的间隔再重建。间隔用守护进程的环境变量 `DUTYDECK_LARK_RECONNECT_STALL_MS`（毫秒）调整，最小 60 秒，`0` 关闭。`doctor` 提示「Dutydeck 已在 … 重建长连接，仍未恢复」时，说明重建过但还没连上，优先检查到飞书开放平台的网络和代理。

### Q2: 提示 `Persisted key policy violation`？
- **原因**：ACPX 持久化键名必须是全小写 `snake_case`。
- **解决**：不要把大写环境变量名直接写进 ACPX session 配置；群聊工具的运行时变量用 `dutydeck_group_tools_url` 和 `dutydeck_group_tools_token`。

### Q3: 自定义 Agent 没出现在列表里，或提示找不到命令？
- **原因**：守护进程是非交互子进程，不读 `~/.bashrc`、`~/.zshrc` 里的 alias；`command` 找不到的 Agent 不会被登记。
- **解决**：`dutydeck doctor` 会点名没登记的 Agent 和它的命令。在 `DUTYDECK_AGENTS_JSON` 里把 `command` 改成可执行文件的绝对路径（如 `/usr/local/bin/claude`），再 `dutydeck restart`。

### Q4: 飞书里报“逐项确认”相关的错误，或会话启动失败？
- 所选 Agent 不支持飞书逐项审批时（只有 ACP 和 Claude Code / Seed / Relay 终端模式支持），机器人只能用 `full-trust`。修法二选一：
  - `dutydeck settings bot set <appId> permissionMode=full-trust fullTrustConfirmed=true`（Agent 会无人值守地执行命令和改文件）；
  - 换成 ACP 或 Claude 终端模式的 Agent。

### Q5: 能否在同一台机器上运行多个机器人？
- 可以。每个机器人有自己的默认工作区、Agent 和飞书应用凭据，服务不同的群组。

### Q6: Claude Code / CCFlash 已完成，飞书卡片却提示工具未返回结果？
- 旧版本可能把 CLI 日志中的历史请求快照当成本轮工具调用。升级后，这些快照不会进入执行记录或确认本轮指令已接收；真实工具缺少结果时仍会提示失败。

### Q7: Claude 终端会话报“Claude 启动尚未就绪（最后屏幕：X）”？
- Claude 启动 30 秒内既没出现空输入框，也没出现可识别的确认页。任务还没写入，按失败记录，处理后可以重发。括号里是最后一屏的类别：
  - **目录信任页未能核对**：屏幕停在目录信任页，但页上的目录和会话目录对不上、页面不完整，或者 `full-trust` 下已认出这一页、自动确认的按键却一直没生效。打开终端确认目录；如果页上的目录不是你预期的，检查会话或机器人配置的工作目录。
  - **空白**：终端里没有任何内容。检查 Claude 命令能否启动，再看守护进程日志（`journalctl --user -u <unit>`）。
  - **未识别**：屏幕上是 Dutydeck 不认识的提示。打开终端查看并处理当前提示。
- 目录很长、在信任页上从字符中间折成多行时，也能认出是当前目录：`ask` / `approve-reads` 下提示“Claude 正在确认此目录是否可信”，请在终端确认；`full-trust` 下自动选择信任该目录。目录含空格且恰好在空格处折行时可能认不出，超时后报“目录信任页未能核对”，在终端手动确认一次信任即可。

### Q8: 报 tmux socket 被删、原终端仍在运行，无法启动会话？
- **原因**：Linux 上 `/tmp` 清理了 tmux socket 文件，但原 tmux server 和 pane 仍在；Dutydeck 会拒绝再启动一个同名 server，避免同一会话同时跑两个 CLI。
- **处理**：按 tmux 手册向原 server 进程发送 `SIGUSR1` 重建 socket，或结束原 tmux server 后重新发送消息。可把 `TMUX_TMPDIR` 指到不会被清理的目录，或让 `systemd-tmpfiles` 排除 tmux 目录。非 Linux 不做这项内核检查，行为保持原样。开启 `remain-on-exit` 时，Dutydeck 下次启动会回收自己留下且所有 pane 都已退出的死会话；仍有运行中 pane 的会话会保留。
