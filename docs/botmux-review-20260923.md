# Botmux 近 14 天提交评估（2026-09-23）

本文是评估快照；落实情况见[改进吸收交付记录](botmux-adoption-20260923.md)。

有 6 项值得做，其中 2 项偏急：

- **主服务进程挂了不会被自动拉起。**
- **TraeX（以及走终端模式的 Codex）在完全信任模式下启动时，就绪判断会误判，30 秒后报「启动尚未就绪」。**

后一项目前没有线上用户受影响：线上 Codex 走 ACP，库里也没有 TraeX 会话。它的影响是一旦有人选用 TraeX，任务就会失败。

## 范围

| 项目 | 内容 |
|---|---|
| Botmux | `../botmux`，与 origin/master 一致（`2716996`） |
| 窗口 | 2026-09-09 ~ 09-23，非 merge 提交 140 个 |
| 已评估过的部分 | 09-15 14:20 ~ 09-22 14:20 及其后 6 个提交，见 [9-22 评估](botmux-review-20260922.md)，五项已吸收，本轮不重复 |
| 本轮新看 | 09-09 ~ 09-15 的 45 个、09-22 之后的 12 个，外加上轮未讨论的 `914eca3`（supervisor 自愈） |
| Dutydeck 基线 | master `ff0d415` |

CI、发版签名、docs-site、Dashboard 专属 UI 这几类提交只看了标题和改动统计，都判为不相关。botmux 独有后端的提交同样只看了这两项，包括 TraeX 转写、沙箱、zmx、MiMo、Mojo、Cursor。其余提交逐个读 diff，并对照 dutydeck 的对应代码核对。

## 值得做

| # | 问题（来源提交） | 用户会遇到什么 | 建议 | 优先级 / 工作量 |
|---|---|---|---|---|
| 1 | 进程挂掉后无人重拉（`914eca3`） | 主服务（4310）进程崩溃或被误杀后，飞书机器人一直离线，systemd 仍显示 active | 见下文 1 | 高；Tag 约 10 分钟，主服务 1–2 天 |
| 2 | TraeX/Codex 终端模式就绪误判（验证 `2716996` 时发现） | 选 TraeX 且完全信任：每次启动都在 30 秒后失败 | 就绪判断接受真实的输入框占位词和页脚后缀 | 高（选用 TraeX 前必须修）；0.5–1 天 |
| 3 | 目录信任弹窗（`2716996`、`7a24cf9`） | 在未受信任目录启动 Codex/TraeX 会停在「Trust and continue」，30 秒后报启动未就绪，飞书里无法处理 | 完全信任模式按进程注入目录信任；ask 模式识别到信任页立即报错 | 中；0.5 天，排在 2 之后 |
| 4 | restart 前不检查 SQLite 能否加载（`ead85e5`） | 用错 node 版本执行 restart，旧进程被停，新进程起不来 | restart/start 停旧进程前先试加载 better-sqlite3；Tag unit 的 node 改用绝对路径 | 中；约半天 |
| 5 | 已解散群没过滤（`57e8e93`） | 群管理页出现已解散的群；只要机器人待过一个已解散群，按姓名填授权名单就整体保存失败 | `listChats` 过滤非 `normal` 状态的群；同步时把不在本次列表里的群标为非成员 | 中；约半天 |
| 6 | 开放平台登录态「半失效」（`7de0828`） | 自动配置飞书应用时一直报「读取权限目录失败」，点重试不会重新扫码 | 识别登出信号后删除缓存的登录态 | 低-中；约半天 |

### 1. 进程挂掉后无人重拉

- **4310**：
  - unit 为 `Type=oneshot` + `RemainAfterExit=yes`，重启策略 `Restart=no`（模板见 `apps/server/src/autostart/autostart.ts:283-299`）。
  - `dutydeck start` 以 detached 方式拉起子进程后，父进程退出（`apps/server/src/daemon/daemon.ts:315-331`）。
  - 之后子进程无论崩溃、被 SIGKILL 还是被 SIGTERM，都不会被重拉，systemd 仍显示 `active (exited)`。
  - `apps/server/src/cli.ts:86-90` 的注释假设存在「supervisor 重拉」，但这条生产路径上没有 supervisor。
- **4311**：
  - unit 为 `Restart=on-failure`。
  - 进程收到 SIGTERM 后正常关闭并 `exit(0)`（`cli.ts:62-85`），所以被外部误杀后不会重拉，这和上游的故障形态相同；崩溃和 SIGKILL 会重拉。
- **验证**：用隔离 unit 加真实的 daemonize 代码复现了以上行为，没有碰线上进程。线上是否真的发生过静默宕机，没有证据，为 `unverified`。
- **建议**：
  - Tag unit 改成 `Restart=always`。改的是线上参数，需要你确认。
  - 主服务在 Linux 上改为 `Type=simple` 前台运行，加 `Restart=always` 和限速。
  - 同时让 `dutydeck stop/restart` 在 unit 已安装时走 `systemctl --user`，否则手动停止会被 systemd 立刻拉回。
  - macOS launchd 需要对应调整。

### 2. TraeX/Codex 终端模式就绪误判

这是验证信任弹窗时，用真实 tmux 后端加 `prepareInput` 实跑发现的，不是上游提交修的内容。

- **Codex 0.156.1**：
  - 完全信任模式固定带 `--dangerously-bypass-hook-trust`，页脚末尾因此多出 `⚠ 1 warning · f2 to view`。
  - `packages/cli-adapters/src/adapters/screen-ready-helper.ts:16` 的 `PATH_FOOTER` 是整行严格匹配，这一整行被判为「未初始化」。
- **TraeX**：
  - 页脚带 `☢ Full Access (shift+tab to cycle) · ← for agents`，这个后缀不被接受。
  - 输入框占位词每次启动随机取一条（二进制里共 11 条，例如 `Implement {feature}`），但第 13 行只认其中一条。
  - 结果是 4 次完全信任启动全部失败。
- **测试盲区**：现有 51 项就绪测试全部通过，说明 fixture 没有覆盖这些画面。
- **修复**：
  - 页脚允许末尾带警告数、权限标识、分支；输入框接受已知占位词。
  - 用真实屏幕做 fixture，样本在 `tmp-botmux-probe/cli-pty/out/`。
  - 占位词和未提交草稿在纯文本里区分不了。默认做法是用已知占位词列表，更稳的做法是带颜色读屏，识别暗色显示的占位词。

### 3. 目录信任弹窗

- **实测触发条件**：
  - `--cwd` 指到未受信任的目录会弹。信任不会从父目录继承，只看目录本身。
  - 在未受信任的仓库上开 worktree 也会弹。
  - 源仓库根受信任时，它的 worktree 继承信任，不弹。
  - 默认工作区是 shared，不是 worktree（`packages/agent-runtime/src/index.ts:1397`）。
- **完全信任模式**：注入 `-c projects={"<cwd>"={trust_level="trusted"}}`。实测能去掉弹窗，`~/.codex/config.toml` 和 `~/.trae/traecli.toml` 的哈希前后不变。做法与 Claude 现有处理一致（`claude-family.ts:157-176`）。
- **ask 模式**：不自动信任，识别到信任页就立即报「目录未受信任」。信任目录会让仓库自带的配置和 hooks 生效，在 ask 模式下自动信任等于放大权限。

### 4. restart 前的解释器检查

- **现状**：
  - 4310 的 unit 已经钉死 node 绝对路径（v22.23.1）。
  - 但 `daemonRestart`（`apps/server/src/daemon/command.ts:231-256`）先停旧进程，停之前不检查当前解释器能否加载 better-sqlite3。
- **实测**：用本机的 node v26 执行 restart，旧进程被杀，新进程报 `NODE_MODULE_VERSION` 不匹配并退出。
- **Tag 的风险**：Tag unit 用的是 `~/.local/bin/node`，这个软链由 botmux 安装脚本用 `ln -sf` 维护。一旦被改指向别的大版本，Tag 启动即崩，按代码推断会反复重启（`unverified`）。

### 5. 已解散群

- **现状**：`service.ts:1163` 读取了 `chat_status`，但全仓没有使用它。
- **影响**：
  - 群同步把列表里每个群都写成成员（`group-management.ts:229-233`）。
  - 按姓名解析授权名单时逐个群拉取成员（`service.ts:1231-1236`），遇到已解散群报 232009，整体抛错。
- **验证**：探针用真实 service 加模拟响应复现了抛错。线上是否真的返回 `dissolved_save` 状态的群，没有样本，为 `unverified`。
- **建议**：
  - 缺少 `chat_status` 字段时保留该群，这点和上游不同。否则一旦某个租户不返回这个字段，所有群都会被过滤掉。
  - 同步只做 upsert，所以已写入的幽灵群要单独清理。

### 6. 开放平台登录态半失效

- **现状**：`open-platform-session.ts:170-184` 只要 `/app` 页面能拿到 csrf 就复用缓存的登录态。
- **问题**：
  - 管理接口返回登出信号时，`post`（`245-254`）只保留 HTTP 状态和顶层 code，丢掉了 `4101`、`LogoutReason=40` 这些字段，也不删除缓存。
  - Web 上的「重试」传 `forceLogin=false`，所以会带着同一份失效缓存再失败一次。
- **建议**：最小改法是识别到登出信号就删除缓存，下次重试自动走扫码。真实响应的形状取自上游描述，本项目没有样本（`unverified`）。

## 低优先

| 项 | 说明 |
|---|---|
| TraeX 关闭低额度换模型提醒（`44cba24`） | Codex 已经注入了关闭参数（`codex.ts:21-23`），TraeX 没有（`traex.ts:82-102`）。实测带上这个参数能正常启动；它是否真能关掉弹窗，需要额度超过 90% 的账号才能验证。约半小时 |
| tmux 全局环境漏进 pane（与 `cb023fa` 相关） | dutydeck 显式传入的环境没问题，但 tmux 全局环境里有、这次没传的变量会被 pane 继承，包括有意剥掉的 `ANTHROPIC_*`。当前 tmux server 由 dutydeck 自己启动，不会触发。建议启动 pane 前对这些变量执行 `set-environment -r`。约 2–3 小时 |
| Claude `<synthetic>` 占位行（`7f8139b`） | `6f84d2e` 已把它判为失败。残留一个边界：`--resume` 启动时如果补写占位行，本轮会被误判失败。未用真实 CLI 复现，先复现再改 |
| A1 内存准入合入前清单（`4e6109f`、`5b68efa`、`5722be9`） | A1 分支未合入，master 和线上都没有内存准入。合入 A1 前要修的点：按 15% 预留且不封顶，本机（251 GiB）要求空闲 37.75 GiB 才放行，建议封顶 4 GiB；发起回收后不等结果就复检；只读 cgroup 根目录；doctor 提示写「暂缓」，实际直接失败 |

## 已有或不适用

| 提交 | 结论 |
|---|---|
| `e939d6d` / `b78d842` 分开显示等待与执行耗时 | 已有：「用时」从进入 running 开始计，排队阶段另显示「排队等待」。上游这个功能默认关闭，不补 |
| `43f228a` 结构化失败可见 | 已有：显式 final 只在成功时抑制自动结果，失败一定会发诊断 |
| `b769f2c` 话题内附件 | 已有（`b6834db`） |
| `25c00bf` 附件消息 ID | 已有：`group send-file` 返回消息 ID，并按指纹做幂等 |
| `dc32768` / `ba70056` Codex nudge | 已有（`codex.ts:21-23`） |
| `cfbb71d` Codex 启动投递 | 已有加载闸门；Claude 自动续跑的前提功能不存在 |
| `798943c` worktree 回收 | 已有带指纹校验的安全清理；本机托管 worktree 为 0 |
| `8853752` / `56f2c2f` / `c8344ab` headless、话题指令头、按群模型 | 已有等价能力：REST 接口、`/new --agent --model --effort`、群级覆盖 |
| `e636f93` / `60b460c` / `2773ce0` / `a166213` / `ea772e1` | 不适用：dutydeck 没有仓库选择卡、授权申请卡、投票式反馈卡、带 token 的终端链接和重启汇总通知 |
| `78e17d5` / `8946fef` / `857c724` / `646eda5` | 不适用：读屏已是纯文本；生产走 tmux 粘贴；提问规则按「需要用户决策」触发；两个实例不共享库 |

## 验证与副作用

- **验证方式**：三组提交分别由独立子代理读 diff、对照代码、跑隔离探针；每组的关键代码证据和真实屏幕，我又逐条抽查过一遍。探针与屏幕样本在 `/data00/home/huangyuhang.edu/tmp-botmux-probe/`。
- **未做的事**：没有改代码，没有重启服务，没有调用真实飞书，没有打印密钥。
- **副作用**：
  - 17:53 第一次启动 TraeX 探针时，TraeX 很可能自动从 0.205.1-alpha.3 升级到了 0.207.1-alpha.12。旧版本目录仍在，未回退，因为 TraeX 下次启动很可能又会自己升级。本机的 botmux fleet 和 traex-bridge 下次启动 TraeX 时会用新版。
  - 回退命令：`ln -sfn ~/.local/share/traex/releases/0.205.1-alpha.3-linux-x86_64.3TzW5U ~/.local/share/traex/current`
- **其他发现**：本机以 ask 模式启动 Codex/TraeX 时，会先弹 hooks 审核页，同样会超时。这是本机 hooks 配置导致的，不在本轮范围。
