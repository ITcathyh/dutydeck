# Botmux 改进吸收交付记录（2026-09-23）

[评估报告](botmux-review-20260923.md) 提出的 6 项改进，加上 2 项低优先级改进，都已经在独立 worktree `../dutydeck-bm0923-integration`（分支 `feat/bm0923-integration`，基线 master `5bce4ff`）实现完毕，并通过了独立审查和复核。目前改动都在工作区里，没有提交，没有合入 master，也没有部署。线上 unit 需要按下文的迁移步骤手工切换。

## 改动

| 改动 | 用户能感知到的变化 |
|---|---|
| 进程被误杀后自愈 | 主服务的 unit 由「一次性启动」改为 systemd 直接托管前台进程（`start --foreground`、`Restart=always`、熔断 10 次/300 秒、`KillMode=process`）。进程崩溃、被 SIGKILL 或被外部 SIGTERM 后，约 3 秒内会被重新拉起。`dutydeck stop/restart/start` 在服务受托管时改走 `systemctl --user`，因此手动 stop 后服务保持停止。tmux 和 agent 在重启前后都不会被杀掉。 |
| restart 前先检查解释器 | 执行 restart、托管模式下的 start，以及 `autostart enable` 之前，先用实际会运行新进程的那个 node 试加载 better-sqlite3。加载失败时直接拒绝，旧进程继续运行，报错信息里带解释器路径、版本和 ABI 编号。 |
| 自启配置的保护 | 服务还在运行时拒绝 `autostart disable`，因为这时 disable 会让 systemd 回收 cgroup，连带杀掉 tmux 和 agent。unit 里如果有模板之外的手工配置（例如 `EnvironmentFile`），`enable` 拒绝重写，并提示先把这些配置移到 drop-in。托管标记变量不会再被 agent 继承。 |
| Codex/TraeX 终端模式就绪判断 | 完全信任模式下，真实界面里的页脚后缀（警告数、Full Access、分支段、截断的路径）和 TraeX 的 11 条随机占位词都能被识别，不会再等 30 秒后超时。遇到普通文字或未提交的草稿，仍然判定为未就绪。 |
| 目录信任 | 完全信任模式在 fresh 启动和 resume 时都通过进程级 `-c projects={...}` 预置目录信任，不写用户配置。非完全信任模式下，只有信任页的标题行和编号菜单行同时出现，才判定为信任页，并立即报「需要先信任工作目录」。 |
| TraeX 低额度提醒 | 启动参数里加上 `notice.hide_rate_limit_model_nudge=true`，写法与 Codex 相同。 |
| tmux 陈旧环境 | 创建 pane 之前，把只存在于 tmux 全局环境、本次又没有传入的变量在 session 级移除，避免陈旧的 `ANTHROPIC_*` 这类变量漏进 agent 进程。 |
| 已解散群 | 群列表跳过 `chat_status` 存在且不是 `normal` 的群；缺少这个字段的群保留。同步群时按创建时间分页，只有在完整拿到所有分页后，才把缺席的群标为 `not_member`，群重新出现后恢复。 |
| 开放平台登录态半失效 | 识别登出信号（HTTP 401、`4101`、`99991641`+`LogoutReason=40`、「请重新登录」）后删除登录缓存，并透传 `session_expired` 和「请重新扫码」的提示。之后点「重试」会直接走扫码。普通错误对象里不再携带原始响应。 |

改动规模：34 个文件，约 +2900 行，其中大部分是测试。完整 diff 在 integration worktree 里，用 `git diff` 查看（新文件已经用 intent-to-add 标记）。

## 没做的

| 项 | 原因 |
|---|---|
| Claude `<synthetic>` 占位行的剩余边界 | 没有用真实 CLI 复现，先复现再改。 |
| A1 内存准入的合入前清单 | A1 分支没有合入，master 上也没有内存准入。 |
| 审查 L1 | 迁移到一半、unit 停在 active (exited) 时执行 start 会报错，但报错里已经提示改用 `systemctl --user restart`。 |
| 审查 L3 | 回滚顺序已写进下文。 |
| 审查 L5 | 两个任务并发删除登录缓存的概率很低，后果只是多扫一次码。 |
| 审查 L6 | `show-environment -g` 失败属于和现有其他 tmux 命令同一类的失败。 |
| 审查 L7 | 当前 shell 连不上 user systemd 时，start 会退回 detached，最坏情况是这一代进程不会被自动拉起。 |
| 复核 N2 | 迁移到一半时 disable 会被拒绝，这是偏安全的做法。放弃迁移应该走下文的回滚步骤；如果改成 `systemctl stop`，在旧的 control-group 模式下会杀掉 tmux。 |
| macOS launchd | 没有改，本机无法验证。macOS 上进程崩溃后仍然不会自动拉起。 |

## 验证

| 检查 | 基线 `5bce4ff` | 整合后 |
|---|---:|---:|
| 全量测试 | 5413 通过、7 跳过、2 失败 | 5534 通过、7 跳过、3 失败 |
| `pnpm build` | 通过 | 通过 |
| `pnpm typecheck` | 通过 | 通过 |

- 唯一的既有失败是 `apps/server/src/database-cli.test.ts:132`，测试期望 schema 23，实际是 24，本轮没有改它。另外 2 项是全量并发下的计时抖动，每轮出现的用例都不一样：基线出现的是 artifact-delivery；整合后几轮先后出现过 acp-client、agent-runtime、leader-delegation、legacy-session-retirement。这些用例单独跑都能通过（最后两项各连跑 3 次），也都没有经过本轮改动的代码路径。
- 每个单元都确认过新增测试在修复前失败、修复后通过。守护进程单元另外做了变异检查：逐项去掉修复，确认测试会变红。
- 真实环境验证，都在隔离条件下进行（临时 unit、临时端口和数据库、隔离的 tmux socket）：
  - **systemd**：SIGKILL 和外部 SIGTERM 后进程被重拉；CLI stop 后保持停止；restart 后新 pid 就绪；用 node26 执行 restart 在停旧进程之前就被拒绝；旧 oneshot unit 的迁移演练通过；disable 和 enable 的拒绝逻辑用真实的 `systemctl show` 输出复核过。
  - **CLI**：以下场景都在 3 秒内就绪，且没有弹出信任页：TraeX 在默认目录；Codex/TraeX 在未受信任目录；Codex/TraeX 在指向未受信任目录的软链路径；resume 时带上信任参数。不带信任参数 resume 会弹信任页，这一点实测确认过。非完全信任模式下遇到信任页，不到 1 秒就报错。`~/.codex/config.toml` 和 `~/.trae/traecli.toml` 的哈希前后一致。
  - **tmux**：带着陈旧全局变量启动的 server，新建的 pane 里不再有这些变量；PATH、HOME 和本次传入的变量都正常。
- 独立审查：第一轮提出 2 条 high、3 条 medium、7 条 low，采纳了其中 7 条并已修复。复核确认这 7 条都已解决，新发现 2 条 low，其中 N1 已修复，N2 不修（原因见上表）。审查报告在 `/data00/home/huangyuhang.edu/dispatch-bm0923/review-report.md`。

## 主服务迁移步骤（未执行）

这些步骤要在分支合入并构建之后执行，需要选一个能接受约 10 秒中断的时间。下文中 `NODE22` 指 `/data00/home/huangyuhang.edu/.local/share/botmux/node-v22.23.1-linux-x64/bin/node`，`CLI` 指 `apps/server/dist/cli.js`。

1. 把旧 unit 备份到 unit 目录之外：`cp ~/.config/systemd/user/dutydeck.service ~/dutydeck.service.oneshot.bak`。
2. 把 `EnvironmentFile` 移到 drop-in，并从主文件里删掉。线上的 agent 配置来自这个文件；如果不先移走，enable 会拒绝执行。
   ```
   mkdir -p ~/.config/systemd/user/dutydeck.service.d
   printf '[Service]\nEnvironmentFile=/data00/home/huangyuhang.edu/ai/dutydeck/.dutydeck/codex-agent.env\n' > ~/.config/systemd/user/dutydeck.service.d/env.conf
   sed -i '/^EnvironmentFile=/d' ~/.config/systemd/user/dutydeck.service
   ```
3. 执行 `$NODE22 $CLI autostart enable`，然后检查：
   - `autostart status` 不报 stale；
   - `systemctl --user show dutydeck.service -p EnvironmentFiles` 的输出里包含 `codex-agent.env`；
   - ExecStart 用的是 node22。
4. 执行 `$NODE22 $CLI stop`，再执行 `systemctl --user restart dutydeck.service`。这一步不能用 `dutydeck start`，因为此时 unit 还停在旧的 active (exited) 状态。
5. 验证：
   - 状态文件里有 `supervisor`，并且 MainPID 与状态文件里的 pid 一致；
   - `/health` 返回 200；
   - Web 上的 agent 列表是 `codex`。
   - 可选：`kill -KILL <MainPID>`，确认服务会被重新拉起。
6. 以后要取消开机自启，按这个顺序操作：先 `dutydeck stop`，再 `dutydeck autostart disable`。

回滚时要先恢复 unit，再回滚代码。顺序反过来的话，旧 CLI 不认识 `--foreground`，会一直重试直到触发熔断。

1. 执行 `$NODE22 $CLI stop`。
2. 删除 `dutydeck.service.d`，把备份恢复回去，然后执行 `systemctl --user daemon-reload`。
3. 回滚代码，执行 `pnpm build`。
4. 执行 `systemctl --user start dutydeck.service`。

## Tag（4311）unit 建议（未执行）

当前配置有两个问题：`Restart=on-failure` 在进程被外部 SIGTERM 停掉后不会重拉；ExecStart 里的 node 是 `~/.local/bin/node` 软链，botmux 的安装脚本会改写这个软链。建议改成下面这样（与现有内容相比，只改 `Restart`、node 路径，并加上熔断设置）：

```
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
ExecStart=/data00/home/huangyuhang.edu/.local/share/botmux/node-v22.23.1-linux-x64/bin/node …（其余参数不变）
Restart=always
RestartSec=3
```

## 证据位置

- 各单元的实现和返修报告：`/data00/home/huangyuhang.edu/dispatch-bm0923/{daemon,cli,tmux,chats,oplogin}-report.md`
- 探针、真实屏幕样本和审查日志：`/data00/home/huangyuhang.edu/tmp-botmux-probe/`
