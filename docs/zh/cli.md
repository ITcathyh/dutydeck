# CLI 与运维速查 <a id="cli-reference"></a>

> [← 返回 README](../../README.md) · [全部文档](../../README.md#docs) · [English](../en/cli.md)

收尾需要人查看时，Agent 可在本轮结束前用 `dutydeck session report --status waiting --question "一个具体问题"`，或 `--status blocked --summary "一句原因"`。它们会进入飞书 `/tasks` 和网页「待你处理」，结果卡首行显示问题或原因；原会话开始下一轮或通过已有操作处理后自动清除。`ready` 表示完成（默认无需报告），`dropped` 表示无需处理；需要固定选项并阻塞等待回答时继续用 `session ask --choices`。

## 1. 守护进程日常管理

```bash
# 启动后台守护进程
dutydeck start [--cwd /path] [--port 4310] [--host 0.0.0.0]

# 查看服务状态
dutydeck status

# 平滑重启（保留已验证可恢复的 tmux 任务，等待其余任务）
dutydeck restart

# 停止守护进程
dutydeck stop

# 更新全局 Dutydeck 包并自动重启
dutydeck update

# 一键诊断（端口、SQLite、Agent 可执行性与默认 Agent、飞书监听、守护进程是否以 root 运行、型号是否缺价格（机器人配置的非别名型号，以及近 30 天用量记录里没能计价的型号）、库文件空闲页等）
dutydeck doctor
```

服务启动失败或运行中崩溃时，会在数据库所在目录写一份 `last-abnormal-exit.json`（时间、类型、退出码、脱敏后的错误首行、版本和数据库路径）；数据库目录还不存在时不写，也不会写到 `last-daemon-dir` 指向的其他实例。`dutydeck doctor` 读到 7 天内、且属于同一个数据库的记录时，在「守护进程」一项后面接一句「X 小时前异常退出（…）」：当前实例已就绪且是之后启动的，写「已自动恢复」，否则提示去看 journalctl。这一项的级别不变，没有记录时输出和以前一样。

`restart` 先暂停领取新任务。已提交成功、恢复日志与原轮身份可验证的 `full-trust` tmux 任务继续在原 CLI 进程里运行，新服务接回同一轮，不重发输入；其余任务继续等待结束。ACP、普通 PTY、Herdr、提交中、缺少恢复日志或身份，以及待审批或高危权限门禁未授权的任务都不会跳过等待。systemd 只在当前 `KillMode=process` 时保留任务；其他值或读不到时全量等待。旧服务不支持恢复计数、排空失败或租约续期失败时也全量等待。`--drain-timeout` 控制等待上限，`--force` 保留原来的强制重启行为，当前 Agent 自己的会话仍自动排除。`deploy` 使用同一保留策略，ACP 等不可保留的任务仍等待结束。

Codex 的 `codex` 入口默认使用终端模式，`codex-cli` 入口继续兼容。已有 ACP 会话继续通过 ACP 续跑，新会话使用当前默认协议；机器人权限不会自动提升。Codex 等不支持飞书逐项审批的终端 Agent，在 `ask` / `approve-reads` 下新开飞书会话会被拒绝；需要逐项审批时，选择内置「Codex (ACP)」（`codex-acp`），或选择 Claude Code / Seed / Relay 等支持审批的终端 Agent。只有原本已获 `full-trust` 权限、且恢复证据完整的 tmux 任务能跨服务重启继续运行；首次提交尚无日志位置的任务仍会等待结束。接回后跑完的任务和普通任务一样，触发一次插件 `task.completed` hook、触发器结果回投和触发器运行状态更新；接回后被停止或结果仍未知的不触发。主轮结束后仍有原生后台任务时，安全重启和部署的排空也会等待它们结束；直接终止进程或 `--force` 不提供此保证。

**停服**：收到停止信号后依次关闭各模块，正常停完写一条「停服各阶段耗时」日志（`shutdownMs`，毫秒，如 `runtime`、`http`、`database`）。超过 12 秒仍没停完就强制退出（退出码 1），日志写明还没结束的阶段（含已运行时长）、没开始的阶段和已完成阶段的耗时；12 秒低于 unit 的 `TimeoutStopSec=15`，进程会在被 systemd 强杀之前自己带着这些信息退出。

**并发启动**：服务进程在写状态文件之前先取得守护目录（`.dutydeck/daemon`）的排他锁并持有到退出。同一目录同时执行两次 `start` 时只有一个起来，另一个报已在运行；锁随进程退出（包括被强杀）释放，不需要手动清理。状态文件先写临时文件再改名，`status` 等命令不会读到写了一半的内容。

**守护日志轮转**：`.dutydeck/daemon/dutydeck.log` 超过 10MB 时，在新进程打开它之前轮转成 `.1`（最多保留 `.1`–`.3`）：detached 启动前，以及 `start` / `restart` / `restart --unit` / `deploy` 调用 `systemctl start` 或 `restart` 之前。旧进程停服期间的最后几行写进 `.1`。systemd 因崩溃自动重拉时不轮转，下一次 restart 或 deploy 时补上。

`GET /api/system/activity` 的 `runningTasks` 包含正在执行主轮的会话，以及主轮已结束但仍有原生后台任务的会话；同一会话只计一次。显式加 `?restart=true` 才检查恢复证据并返回 `restartBlockers` 和 `recoverableTasks`；未进入排空时不减去可恢复任务，`excludeSessionId` 同时适用于这三个计数。

## 2. 版本发布与部署 (`deploy`)

```bash
# 把构建好的检出目录发布为不可变版本：排空 → 切换 releases/current → 重启 → 健康检查；失败时按条件回滚
dutydeck deploy --source /path/to/checkout

# 先看会删什么、能释放多少空间，再清理旧版本和旧部署记录
dutydeck deploy prune --releases /path/to/releases --dry-run
dutydeck deploy prune --releases /path/to/releases
```

- **停机窗口**：新进程初始化完成即开始监听 HTTP，飞书长连接随后在后台并行建立。`deploy` 和 `restart` 在 `/health` 通过后还要等 `/health/ready` 报告就绪，即启动时的飞书长连接同步已有结果（已连上，或已失败并排了退避重连），才算重启完成、轮到下一个 unit；飞书平台故障导致连不上不会触发回滚。旧版本没有 `/health/ready` 时只看 `/health`。飞书「消息监听已连接」日志带 `connectMs`（毫秒）：`identity` 查询机器人身份并加载 SDK、`recovery` 恢复上个进程留下的入站记录、`reconcile` 卡片对账，以及 `total`。Web 断线后最长每 5 秒重试一次；Agent 调用群协作工具和回传命令（`dutydeck send`、`ask`、`report` 等）遇到连接被拒时最长等待 90 秒（不超过该次请求的期限），连接中途断开等可能已送达的请求不重试。配上下面的 [systemd socket 激活](#socket-activation) 后，重启期间的 HTTP 连接排队等待，不再被拒。开始监听后写一条「启动各阶段耗时」日志（`startupMs`，毫秒）：`boot` 进程与模块加载、`plugins`、`config`、`database` 打开库、`migrate` 迁移、`wiring`、`insight`、`integrations`、`relay`、`agentDefaults`、`agents` 登记 Agent、`sessions` 恢复会话与对账、`routes`、`listen`，以及 `total`。
- **部署窗口**：环境变量 `DUTYDECK_DEPLOY_WINDOW`（如 `10:00-11:00,16:00-17:00`）限制部署时段，窗口外加 `--now` 才部署。
- **Web 静态资源**：构建时为 JS、CSS、HTML 等文本文件生成 `.br` 与 `.gz` 压缩副本；浏览器声明支持时直接返回压缩副本（带 `Content-Encoding` 与 `Vary: Accept-Encoding`），否则、或请求带 `Range` 时返回原文件。HEAD 请求检查文件可读性与大小，返回与 GET 相同的响应头，不读取文件正文。
- **失败与中断**：部署失败、中途出错或被 Ctrl-C / kill / ssh 断开打断时，都会写 `status: failed` 的部署记录（被信号打断的另记 `aborted_by`），先等已发出的排空续期请求结束，再让旧服务退出排空、恢复执行新任务，不再等租约到期，避免迟到的续期再次暂停服务；被打断后不再切换版本、重启或回滚。
- **并发部署与清理**：共用同一个实际发布根目录的操作互斥，包括不同 unit 的部署、`--no-restart` 和手动 `deploy prune`（含 `--dry-run`）。已有操作进行时，后来的命令会明确报忙并拒绝执行，待前一操作结束后重试；不同发布根目录可独立操作。
- **备份期间保持暂停接单**：排空后先备份数据库再切换版本，备份期间每 5 秒续一次排空。续期失败，或备份结束时又有任务在执行，部署不切换版本、不重启，旧服务继续运行，记为失败并写明原因；等任务结束后重新部署，确认可以中断任务时加 `--force`。
- **回滚**：健康检查不过时先停服务。多个 unit 共用同一个 `current` 时，以目标 unit 实际运行的版本为回滚目标；无法核实运行版本时拒绝切换。目标已停服时，历史上部署成功的版本只有在数据库 schema 与当前匹配才作为回滚候选；确认 schema 没变才自动切回，schema 变了就停止自动回滚，保护数据，不会恢复旧数据库快照。
- **缺地址或数据库时拒绝**：目标 unit 没记录可用的健康检查地址或数据库路径（例如被 `dutydeck stop` 停过）时，deploy 直接拒绝，不切换版本也不重启。先启动该 unit 让它记下地址，或用 `--runtime` 指向写有 `address`、`databasePath` 的 `deployment.json`。
- **自动清理**：每次部署成功后保留最新 5 个发布目录；部署记录按 unit 分别保留最新 5 个，每个 unit 只有最新 2 份记录留着数据库备份（含本次），同一发布根下依次部署多个 unit 时互不挤占。更早的记录只删备份文件、保留 `manifest.json`；`manifest.json` 里没记 unit 的旧记录不按份数删备份。deploy 建的记录超过 24 小时仍没有 `manifest.json`（部署进程被强制杀掉留下的），不占保留个数，直接删除。`current`、它的上一版和仍被运行中进程引用的版本永远保留；自动清理和手动 `deploy prune` 都会额外保留各 unit 最近一次成功部署的版本。清理失败只告警，不影响部署结果。
- **历史数据保留**：服务每小时分批清理一次数据库里的历史数据，只动已结束的任务，未结束、结果未知和旧版待退役会话的数据不动：终端模式超过 30 天的轮次只留最后一屏的内容；旧版本存的会话状态快照和工具调用镜像超过 30 天删除；群策略、群绑定、群信息和角色的修订记录每项只留最近 20 条。事件记录本身不删，Web 历史仍然完整连续。已有旧库的终端输出存在缺口时，网页仍可展开历史轮次、原始日志和执行追踪，显示剩余记录；读取未到达请求终点或分页异常仍会报错，可重试。清理不做 VACUUM，数据库文件不会变小，腾出的空间留给后续写入复用；要缩小文件，按下面的[停机 VACUUM](#vacuum)步骤操作。`dutydeck doctor` 在空闲页占库文件三成以上且不少于 64MB 时提示一次，不会自动执行。
- **手动清理** `deploy prune`：选项 `--releases/--runtime/--unit`、`--keep N`（默认 5）、`--dry-run`、`--include-unmarked`、`--json`。手工部署留下的记录（没有 `created_by: dutydeck deploy` 标记）默认不动，只有加 `--include-unmarked` 才会清，并且仍被进程引用或 1 小时内改过的会跳过。最近 1 小时内改过的 `.partial` 目录同样跳过（可能是正在进行的部署）。
- **单 Bot 独立进程**：`dutydeck start --foreground --database /path/to/bot.db --bot-app-id cli_xxx`。
- **拆分机器人数据**：`scripts/split-bot-runtimes.mts` 会把空闲终端状态、排队受阻和结果未知提醒、计划逾期提醒随所属会话迁入对应机器人的库；未知或无法确认归属的记录仍会阻止拆分。
- **systemd 服务与数据库解析**：对直接以 `node cli.js` 启动的 unit，管理命令（`restart`、`status`、`deploy` 等）按 ExecStart 显式参数 > unit 环境变量 > `WorkingDirectory/.env` 解析目标数据库和监听地址；相对工作目录以 `WorkingDirectory` 为基准。unit 环境变量包括 `Environment=` 和 `EnvironmentFile=`，后者按 systemd 的引号与注释规则解析，并按顺序覆盖前者。缺少 `.env` 可继续，不可读或关键配置无效时拒绝操作；`EnvironmentFile=` 只有带 `-` 前缀且文件不存在时跳过，其他读不到的文件、相对路径或通配路径，以及无法解析的 `Environment=` 项，都会拒绝操作；数据库未配置时回落到 `<cwd>/.dutydeck/dutydeck.db`。部署备份和 schema 回滚检查使用同一实际数据库。`start --foreground` 仍读取守护状态，`deploy --runtime` 显式元数据继续优先。

### systemd socket 激活（重启不拒绝连接）<a id="socket-activation"></a>

服务重启时，旧进程关闭端口到新进程开始监听之间有一段空档，这段时间的 Web 请求和 Agent 回传会被拒绝。给 unit 配一个同名的 `.socket` 后，端口由 systemd 持有，重启期间的连接在内核里排队，等新进程接手。服务启动时识别 systemd 传入的监听 socket（`LISTEN_FDS`）并直接使用；没有传入时照旧自己绑定端口。

```ini
# ~/.config/systemd/user/<unit>.socket：地址与端口必须和服务的 --host/--port 一致，只写一行 ListenStream=
[Socket]
ListenStream=127.0.0.1:4310
FreeBind=true

[Install]
WantedBy=sockets.target
```

```ini
# ~/.config/systemd/user/<unit>.service.d/socket-activation.conf
[Unit]
Requires=<unit>.socket
After=<unit>.socket
```

写好后执行 `systemctl --user daemon-reload && systemctl --user enable <unit>.socket`，再用 `dutydeck restart --unit <unit>` 切换：systemd 停掉旧进程、拉起 `.socket`，再把它交给新进程。切换前先部署包含本功能的版本，旧版本会忽略传入的 socket、自己再绑同一端口而启动失败。启用后：

- `restart`、`deploy` 只重启服务，不动 `.socket`；`dutydeck stop` 和部署回滚时的停服会连同 `.socket` 一起停，否则下一个连接会把服务重新拉起；`dutydeck start` 连同 `.socket` 一起启动。
- systemd 传入多个 socket，或传入的端口与配置的 `--port` 不一致时，服务拒绝启动。
- 传入的 socket 只由服务进程持有，不会被 tmux、Agent 等子进程继承。
- 回退：`systemctl --user disable --now <unit>.socket`，删掉 `.socket` 文件和上面的 drop-in，`daemon-reload` 后 `systemctl --user start <unit>`，服务恢复自己绑端口。

要让已验证可恢复的 tmux 任务跨重启保留，unit 还需要 `KillMode=process`（`dutydeck autostart` 生成的 unit 已包含）；其他取值会在停服时把 unit cgroup 里的 tmux 和 Agent 一起杀掉，重启只能等所有任务结束。

### 停机 VACUUM <a id="vacuum"></a>

VACUUM 会重写整个库文件，期间独占数据库，必须先停服。在部署窗口里按下面的顺序做，命令都在 daemon 根目录（unit 的 `WorkingDirectory`）里执行：

1. 确认网页上没有正在执行的任务。`dutydeck stop` 不等任务结束。
2. `dutydeck stop`，再用 `dutydeck status` 确认已停止。受 systemd 托管时它会调用 `systemctl --user stop`，unit 不会被重拉。
3. 备份：`dutydeck backup create --database <库文件> --data-dir <库所在目录> --output <数据目录之外的新目录>`。
4. 确认磁盘剩余空间不小于库文件大小，VACUUM 需要临时写一份完整副本。
5. 执行 VACUUM。本机没有 `sqlite3` 时用发布目录自带的驱动：

   ```bash
   node -e "const D=require(process.argv[1]); const db=new D(process.argv[2]); db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); db.close()" \
     "$PWD/.dutydeck/releases/current/node_modules/better-sqlite3" "$PWD/.dutydeck/dutydeck.db"
   ```

   有 `sqlite3` 时等价于 `sqlite3 .dutydeck/dutydeck.db 'PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'`。
6. `dutydeck start` 启动，`dutydeck doctor` 里的空闲页提示消失。出问题时停服，用第 3 步的备份按「离线备份与隔离恢复」恢复到新目录核对。

### 离线备份与隔离恢复

```bash
dutydeck backup create --database /path/to/runtime/dutydeck.db --data-dir /path/to/runtime --output /path/to/backups/snapshot-1
dutydeck backup inspect --archive /path/to/backups/snapshot-1
dutydeck backup restore --archive /path/to/backups/snapshot-1 --target /path/to/restored-runtime
```

三条命令均输出 JSON，必须显式提供路径，不从 `.env` 或 daemon 记录猜测源实例。源数据库须直接位于数据目录中且已升级到当前 schema；有活跃使用者时拒绝备份。输出和恢复目标目录必须不存在、父目录必须存在；备份放在源数据目录之外，恢复不覆盖已有目录。

备份包含 SQLite 主数据、插件非秘密配置 / 绑定 / 锁文件、引用的不可变插件包，以及冻结数据库引用的产物快照。持有数据库和插件写锁期间复制，并检查组件哈希、快照大小、schema、SQLite 完整性和外键；缺少引用的产物快照或内容不一致会失败。清单列出缺失及排除项。备份目录为 0700、文件为 0600；完整数据库可能含仍可用于源实例的认证令牌、分享签名密钥及敏感正文；归档没有额外加密，不是无密钥备份。

只排除外部凭据文件（如 `.env`、secret-provider 文件及私钥文件），数据库内的凭据完整保留。原生 CLI 会话、外部工作目录 / worktree、外部服务和插件运行数据等不默认打包；缺失、旧式可变或包含符号链接的不可变插件整包不复制，列为缺失依赖。预检与恢复均报告 `status: quarantined`，不代表完整可运行的实例。恢复副本保留任务的未知结果与提交事实，禁止启动服务和附加运行时，不自动重放任务；本命令不补凭据或解除隔离，后续启用须单独核对依赖并授权。

## 3. 开机自启 (`autostart`)

```bash
dutydeck autostart enable   # 注册开机自启（Linux systemd --user / macOS launchd）
dutydeck autostart status   # 查看自启状态
dutydeck autostart disable  # 关闭自启
```

- Linux unit 与 macOS LaunchAgent 都前台运行 `dutydeck start --foreground`，工作目录是 daemon 根目录，输出追加到 `.dutydeck/daemon/dutydeck.log`。服务崩溃或非零退出后，systemd 按 `Restart=always` 重拉；launchd 按 `KeepAlive.SuccessfulExit=false` 重拉，间隔至少 30 秒，`dutydeck stop` 的正常退出不重拉，已有实例在跑时也不会反复重拉。macOS 上以前注册过的 LaunchAgent 是后台模式，崩溃后没人拉起，`autostart status` 会报漂移，重跑 `dutydeck autostart enable` 后重新登录生效。受 launchd 托管时，`dutydeck restart` 照常排空、等任务结束，再执行 `launchctl kickstart -k gui/<uid>/com.dutydeck.server`：launchd 先停旧进程再按 plist 拉起新的，新进程仍受它看护；命令行上的服务参数传不过去，要写进根目录 `.env`。job 没加载（比如自启已关闭）时照旧由 CLI 起后台进程。
- 守护进程还在运行时，`autostart disable` 拒绝执行（macOS 移除 job 会连带停掉它），先 `dutydeck stop`。
- PATH 是合并而不是覆盖：重跑 `enable` 时，写进 unit / plist 的 PATH 是当前 shell 的 PATH（保持原顺序）加上原 PATH 里多出来、且目录仍存在的项；重复项只保留第一次出现的位置，含 `/tmp/arg0/` 的 Agent 会话临时目录两边都丢掉，node 所在目录不在其中时追加到末尾。首次 `enable` 同样会去重、去掉 `/tmp/arg0/` 项、补上 node 目录，其余保持当前 shell 的顺序。漂移判断不比较 PATH：当前 shell 的 PATH 里有 unit / plist 没有的目录时，`autostart status` 和 `doctor` 只提示一行，重跑 enable 会把它们并进去。
- 合并只增不减，用更窄的 PATH 重跑 `enable` 不会让它变窄。要收窄，直接编辑 unit 里的 `Environment=PATH=`（Linux，改完运行 `systemctl --user daemon-reload` 再 `dutydeck restart`）或 plist 里的 `PATH`（macOS，重新登录后生效）；也可以先 `dutydeck stop`、`dutydeck autostart disable`（Linux 上会删除 unit 文件），再在想要的 shell 里运行 `dutydeck autostart enable`。之后在更宽的 shell 里重跑 `enable`，多出来的目录会再并进去。
- 通过 `<releases>/current` 软链运行时，`enable` 和 `status` 都按 `current` 路径比较和写入，不会把 unit 钉在当时的具体版本上；`current` 已指向别的版本、unit 却还写着旧版本路径时，照常报漂移。

## 4. 命令行管理配置 (`dutydeck settings`)

Web 控制台里的机器人设置、群聊策略和用量上限，都可以用命令行改，方便脚本化和让 Agent 自己管理配置：

绑定国际 Lark 应用时，用 `dutydeck settings bot add <app-id> brand=lark --app-secret-fd 0`。未通过 `LARK_OPEN_API_BASE_URL` 覆盖服务地址时，`brand=lark` 向国际 Lark 域校验凭据，省略品牌默认走飞书。`brand`、App Secret 和成员名单走同一校验步骤，与默认 Agent、权限或监听等设置分开提交。开启了飞书任务派发通道（`LARK_TASK_AGENT_ENABLED`）时，每轮拉取任务前，以及任务交给消息处理时，都会检查机器人当前保存的发起人名单（`allowedUsers` / `allowedEmails`）和监听开关。两项名单都清空或关闭监听后不再接单；交接时发现通道已关闭的在途任务退回待派，重新开放后可继续处理且不会重复派发。已经通过交接检查的任务不撤回；补上名单后不用重启即可接单。普通私聊里名单为空仍表示对所有人开放。

`ou_` 身份按应用隔离。更换应用时，管理员和高危审批人名单即使省略也会用目标应用校验；确定无效会拒绝保存，原配置和修订号不变。允许机器人名单须在目标应用重新按姓名解析，或显式清空。Web 和 CLI 的所有保存步骤遵守相同身份边界；临时网络或联系人权限不足仍按“无法判定”处理，不当作确定无效。

| 控制台模块 | CLI 命令 |
|---|---|
| 机器人设置 | `dutydeck settings bot list / show / set / add / remove / install-hook` |
| 群聊协作策略 | `dutydeck settings group list / show / set / members / sync` |
| 实验草稿 Bot 与 SecretRef 引用 | `dutydeck settings channel-bot list / show / set` |
| 实验草稿群绑定策略 | `dutydeck settings group-binding list / show / add / set` |
| 月度用量上限 | `dutydeck settings usage show / set-cap / remove-cap` |
| 按工作区允许的命令（只能查看与撤销） | `dutydeck settings approval-rules list [--app <机器人>] [--workspace <目录>] / remove <规则 ID>` |
| 主终端后端 | `dutydeck settings terminal-backend [tmux\|herdr]` |
| 工作区分组 | `dutydeck workspace-groups` |
| 只读配置来源 | `dutydeck settings explain --session <session-id>` |

```bash
dutydeck settings bot show cli_xxx                           # 查看机器人全部配置
dutydeck settings bot set cli_xxx adhdMode=true              # 开启 ADHD 友好模式
dutydeck settings bot set cli_xxx notifyQuietHours=22:00-08:00
dutydeck settings bot set cli_xxx groupReplyMode=auto        # 清除群回复模式覆盖，恢复默认自动路由
dutydeck settings bot install-hook cli_xxx --prepare fallbackAgentId=codex-acp workspace=/path/to/workspace  # 按未保存配置准备 Hook
dutydeck settings group set oc_xxx participation=selective   # 设置群聊按需参与
dutydeck settings usage set-cap 50 --app cli_xxx             # 设置月度用量上限（美元）
dutydeck settings approval-rules list --workspace .          # 查看本目录的工作区审批规则（按真实路径比较）
dutydeck settings approval-rules remove war_xxx              # 撤销一条规则，下一条同类命令恢复弹卡
dutydeck settings group set oc_xxx 'scenarios={"alarm":{"enabled":true,"params":{"levels":["P0","P1"]}}}'  # 改告警初筛的级别
```

强制风控下更换工作区、默认 Agent、兜底或分流 Agent 时，先在机器人设置点「配置拦截 Hook」，再保存。Hook 检查和安装使用当前草稿的工作区及所有候选 Agent；安装只写 Hook 文件，不保存其他草稿，也不降低现有强制风控。CLI 的 `install-hook --prepare [key=value...]` 同样只准备文件，支持 `workspace`、`defaultAgentId`、`fallbackAgentId` 和 `defaultAgentWeights`；准备后再用 `bot set` 保存。省略 `--prepare` 且不传草稿参数时，沿用安装并保存高危正则/提醒模式的行为，已开启强制风控的机器人保持强制模式。保存失败会保留草稿，只有版本冲突才提示并发修改。

保存接口对私聊模式、群回复模式、群记忆范围、Claude 自带记忆和应用品牌使用严格枚举校验；非法值返回 `400 INVALID_LARK_CONFIG`，不会清除已保存值。`groupReplyMode=null` 仍用于清除覆盖，CLI 用 `groupReplyMode=auto`。

群里的场景包用 `scenarios={"<包 id>":{"enabled":true|false,"params":{...}}}` 改，`params` 只写要改的键，`{"<包 id>":null}` 删掉这个包的绑定；`group show` 列出本群可用的包、参数和当前绑定。`direct` 模式的包（如告警初筛）要先在群里点确认卡开启过一次，之后才能用命令行或 Web 改。旧的 `alarm=<JSON>`（平铺的告警订阅）作为弃用别名保留一个版本，会转成 `scenarios.alarm`，输出里带弃用提示。

实验页「群配置与权限」里的 Bot 用 `channel-bot` 管理，参数是 `list` 返回的内部 `id`，不是飞书 App ID：

```bash
dutydeck settings channel-bot list
dutydeck settings channel-bot show <id>
dutydeck settings channel-bot set <id> credentialRef=<secret-ref-id> --expected-revision 3
dutydeck settings channel-bot set <id> credentialRef=null
```

可改 `externalAppId`、`displayName`、`brand=feishu|lark`、`credentialRef` 和 `state=staged|disabled`。省略的键保持原值，`credentialRef=null` 清除引用；不传 `--expected-revision` 时使用刚读取的版本，版本冲突会拒绝保存。命令只改草稿元数据，监听仍停用；已接入运行时的机器人继续用 `settings bot` 管理。支持同样的 `--instance`、`--url` 和 `--database` 目标选项，不返回凭据值。

实验页「群配置与权限」中的群绑定策略草稿使用 `group-binding` 管理，沿用与 `channel-bot` 相同的草稿寻址、运行保护与版本并发控制（CAS）：

```bash
dutydeck settings group-binding list [--bot <内部 channel-bot id>]
dutydeck settings group-binding show <binding-id>
dutydeck settings group-binding add <binding-id> --bot <内部 channel-bot id> --chat <外部群 chat-id> [key=value...]
dutydeck settings group-binding set <binding-id> <key=value...> [--expected-revision N]
```

`add` 创建处于暂存状态的离线草稿绑定（初始 `state=staged`，`add` 时不接受 `state` 键），必须指定内部 Channel Bot ID（`--bot`）与外部群 ID（`--chat`），不会覆盖已有绑定。策略覆盖字段对齐 GroupBinding API 与界面，包括 `routingOverride`、`groupToolsOverride`、`rolePolicyOverride`、`reviewReasons`、`oncall` 等覆盖项；`set` 可修改这些字段，并支持设置 `state=staged|disabled|needs_review|archived`（不支持 `active`）。更新时省略的键保持原值；不传 `--expected-revision` 时默认使用刚读取的版本，版本冲突时拒绝保存。这些命令仅操作离线的实验草稿绑定，不代表已激活运行时群策略，也不包含自动迁移应用；运行中的机器人群配置继续使用 `dutydeck settings group` 管理。

示例：
```bash
# 新建离线策略草稿（开启值班）
dutydeck settings group-binding add draft-group --bot draft-bot --chat oc_example oncall=true

# 使用 CAS 乐观锁更新路由覆盖与群工具权限
dutydeck settings group-binding set draft-group 'routingOverride={"groupReplyMode":{"mode":"set","value":"chat-topic"},"mentionPolicy":{"mode":"set","value":"topic"}}' 'groupToolsOverride={"read":"deny","discover":"deny","send":"deny"}' --expected-revision 1
```

机器人自动欢迎默认开启。设置 `welcomeEnabled=false` 可关闭入群和首次私聊欢迎；保存后立即生效，不改变用户消息处理。需要群里只在被 @ 时回复时，同时使用 `mentionPolicy=always` 和 `defaultGroupParticipation=off`。

```bash
dutydeck settings bot set cli_xxx welcomeEnabled=false
```

飞书事件可按应用注册多个 HTTP 处理器，按数组顺序依次调用。当前支持卡片点击 `card.action.trigger` 和消息接收 `im.message.receive_v1`：

```bash
dutydeck settings bot set cli_xxx 'eventHandlers=[{"id":"observer","eventTypes":["card.action.trigger"],"url":"https://receiver.example/events","token":"<观察服务令牌>"},{"id":"buttons","eventTypes":["card.action.trigger"],"owner":"sample-service","legacyActions":["ack"],"url":"http://127.0.0.1:14432/events","token":"<接收服务令牌>"}]'
dutydeck settings bot set cli_xxx 'eventHandlers=[{"id":"messages","eventTypes":["im.message.receive_v1"],"url":"https://receiver.example/messages","token":"<接收服务令牌>"}]'
dutydeck settings bot set cli_xxx eventHandlers=null  # 关闭；[] 也可清空
```

每项包含唯一且稳定的 `id`（1–64 位字母、数字、点、下划线或连字符）、非空 `eventTypes`、`url` 和 `token`。卡片处理器可加 `owner`，匹配 `action.value.owner`；`legacyActions` 只匹配没有 owner 的旧卡片，不能包含 Dutydeck 内置动作。没有这两个筛选字段时，匹配全部非内置卡片。消息处理器收到应用订阅接入的全部消息事件，包括尚未经过聊天白名单或群权限检查的消息；接收服务自行授权业务动作。包含消息事件的处理器不能配置卡片筛选字段；处理两类事件且不筛选时可在同一项列出两个事件类型。

Dutydeck 发出 `POST`，带 `Authorization: Bearer <token>` 和 `Content-Type: application/json`：

```json
{"version":1,"app_id":"<连接配置中的 App ID>","handler_id":"buttons","event_type":"card.action.trigger","event":{"event_id":"<平台事件 ID>","operator":{},"context":{},"action":{}}}
```

`event` 是完整的 SDK 事件，保留 event_id、operator、context、action、token 以及消息内容等原字段；示例仅展示部分字段。卡片回调会先统一平铺或 `{event,header}` 包装、对象或 JSON 字符串的 action value，以及无显式 value 时的 behavior value；表单结果统一放在 `action.value.form_value`。操作者和群/消息身份只取事件字段，不取 value 中的同名内容。顶层 `app_id` 来自可信连接配置，`handler_id` 来自注册项。接收服务返回 HTTP 200 或 202，JSON 必须包含同一 `event_id` 和 `decision`：

```json
{"event_id":"<同一事件 ID>","decision":"continue"}
{"event_id":"<同一事件 ID>","decision":"stop","toast":{"type":"success","content":"已受理。"}}
```

`continue` 才会调用下一个匹配项，全部继续后进入原有内置处理和权限检查；`stop` 立即停止，消息也不会触发欢迎卡。202 只表示传播决定已经确定，不代表业务已完成。`toast` 可选，类型只允许 `success`、`info`、`warning`、`error`，content 必须是非空字符串；只有卡片 stop 的 toast 会回给用户。接收服务执行业务副作用时须在回执前持久受理，并以 `app_id + handler_id + event_id` 去重，重复事件返回原传播决定。

整个外部处理链共用 2 秒预算，包含所有请求和回执正文读取。错误、超时、重定向或无效回执都会停止后续处理；卡片显示失败或结果待确认，消息回调抛出失败交给 SDK。没有后台重试或新增持久队列；平台再次投递时接收服务仍须幂等。内置 `task_id`、`taskId`、`dutydeck_*` 和兼容的 `dockmux_workflow` 卡片完全跳过外部处理器，保留原有去重与鉴权；启用卡片处理器时，owner 与内置标记混合或没有匹配接收项的外部 owner 会被拒绝。只注册消息处理器时卡片维持原处理。

注册数组整体替换，省略 `eventHandlers` 的保存保留原数组；公开 API 和 CLI 不返回 token。编辑、排序时，相同 id 省略 token 会沿用原令牌；新增 id 或修改 URL 时必须显式提供 token。URL 只允许 HTTPS 或本机 HTTP（`127.0.0.1`、`localhost`、`[::1]`），禁止 URL 用户信息、fragment 和重定向。存储的注册项无效时，公开配置显示不含密钥的 `eventHandlersError`，该机器人不能启动监听；原始配置保留，必须明确替换合法数组或提交 null 才能修改该机器人。

旧 `cardActionForwarding` 配置仍由同一事件链内部兼容：请求保持 `{"version":1,"app_id":"<可信 App ID>","event":<完整 SDK 事件>}`，接收端落库后返回 `202 {"status":"accepted","event_id":"<同一事件 ID>"}`，重复返回 `200 {"status":"duplicate","event_id":"<同一事件 ID>"}`，两种回执均停止传播。旧配置与非空 `eventHandlers` 不能同时启用。接收端增加 `decision:"stop"` 后，可用一次保存原子迁移：

```bash
dutydeck settings bot set cli_xxx cardActionForwarding=null 'eventHandlers=[{"id":"buttons","eventTypes":["card.action.trigger"],"owner":"sample-service","legacyActions":["ack"],"url":"http://127.0.0.1:14432/events","token":"<原接收服务令牌>"}]'
```

旧客户端忽略增加的 decision 字段；旧配置损坏时仍显示 `cardActionForwardingError`，需明确修复或清除旧字段。

### 机器人设置键

`dutydeck settings bot set <app-id> key=value ...` 能改的全部键如下，`dutydeck settings bot show` 显示当前值。省略的键保持原值；布尔值写 `true` / `false`，名单可写逗号分隔或 JSON 数组。默认值指已保存的配置里没有这个键时服务端按什么处理。

| 键 | 作用 | 默认值 |
|---|---|---|
| `eventHandlers` | 飞书事件的外部 HTTP 处理器（卡片点击、消息接收），按数组顺序调用，见上文；`null` 或 `[]` 关闭 | 无 |
| `cardActionForwarding` | 旧版卡片回调转发，仍兼容；不能与非空 `eventHandlers` 同时启用 | 无 |
| `welcomeEnabled` | 入群和首次私聊时发欢迎 | `true` |
| `workspace` | 新会话的默认工作目录，须是绝对路径 | 无 |
| `workspaceAliases` | `/new --cwd <别名>` 的别名表，JSON 对象 `{"别名":"/绝对路径"}` | 无 |
| `webBaseUrl` | 控制台地址，卡片「查看详情」等 Web 入口从它生成 | 新建时沿用已有机器人的地址 |
| `webMobileReachable` | 手机能否打开 `webBaseUrl`；`false` 时不保存地址，卡片不显示「查看详情」 | `true` |
| `displayName` | 自定义展示名，只用于展示 | 无 |
| `brand` | `feishu` / `lark`，决定开放平台域名；与 App Secret、成员名单同一步提交 | `feishu` |
| `defaultAgentId` | 默认 Agent；Agent 设置步骤必填 | 无 |
| `fallbackAgentId` | 兜底 Agent：主 Agent 起不来、限流或额度耗尽且本轮还没有输出时，自动切换一次；须与默认 Agent 不同，留空关闭 | 无 |
| `fallbackModel` | 兜底 Agent 切换时用的模型 | 兜底 Agent 的默认模型 |
| `defaultAgentWeights` | 新会话按权重在多个 Agent 间分流，JSON 数组；`[]` 关闭 | 不分流 |
| `defaultModel` | 默认模型 | Agent 自身的默认模型 |
| `defaultReasoningEffort` | 默认推理强度 | Agent 自身的默认值 |
| `permissionMode` | 飞书任务的确认方式：`ask` 逐项确认、`approve-reads` 只读操作自动放行、`full-trust` 完全信任 | 已存配置缺这个键时按 `approve-reads` 处理（`fullTrustConfirmed=true` 的按 `full-trust`）；Web 新建表单在选 Agent 前预填 `full-trust`；新建时不传则按默认 Agent 决定，能在飞书逐项审批的为 `ask`，否则为 `full-trust` |
| `fullTrustConfirmed` | 确认飞书任务以完全信任无人值守运行；`full-trust` 下改 Agent 或开监听前必须为 `true` | `false` |
| `roleTitle` | 角色名称，用于展示和提示词 | 无 |
| `roleScope` | 负责范围，用于展示和提示词 | 无 |
| `preInjectPrompt` | 机器人级预置指令，随每轮飞书任务交给 Agent | 空 |
| `verificationCommand` | 平台验证命令，在会话工作目录执行；未设置时结果卡不提验证、不给「运行验证」按钮 | 无 |
| `listening` | 是否连接飞书、接收消息 | `false` |
| `mentionPolicy` | 群里的唤醒方式：`always` / `topic` / `never` / `ambient` | 新建机器人为 `topic`；已存配置缺这个键时按 `always` |
| `defaultGroupParticipation` | 群里不 @ 时的默认参与模式：`off` / `observe` / `selective` / `eager` | `off` |
| `p2pMode` | 私聊路由：`chat` 整段私聊一个会话，`thread` 每条顶层私聊一个话题 | `chat` |
| `groupReplyMode` | 普通群回复模式：`chat` / `shared` / `new-topic` / `chat-topic`；`auto` 清除覆盖 | 自动路由 |
| `idleCompactEnabled` | 会话空闲后自动压缩上下文 | `true`（Web 新建表单的默认值里没有这一项，由服务端补上） |
| `idleCompactHours` | 空闲多少小时后压缩，至少 1 | `24` |
| `groupToolsEnabled` | 允许 Agent 使用群工具；Leader 模式需要开启 | `false` |
| `groupToolsAllowSend` | 群工具可以发消息；要先开 `groupToolsEnabled` | `false` |
| `memoryEnabled` | 会话记忆；`false` 时不注入记忆，相关命令和工具不可用 | `defaultGroupParticipation` 为 `selective` / `eager` 时开启，否则关闭 |
| `memoryAutoExtract` | 后台自动提取和整理记忆；`false` 时只能用 `/memory consolidate` 手动触发 | `true` |
| `groupMemoryScope` | 群聊记忆范围：`shared` 各群共用一个池，`per-group` 每群一个池；切换不迁移数据 | `shared` |
| `claudeAutoMemory` | 群聊里 Claude 自带的 auto memory：`inherit` 沿用 Claude 自己的设置，`off` 在开着会话记忆的机器人的群聊 Claude 家族会话里关闭（见 [features.md](features.md)） | `inherit` |
| `memoryAgentId` | 跑记忆提取和整理的 Agent | 沿用 `defaultAgentId` |
| `memoryModel` | 跑记忆提取和整理的模型 | 沿用 `defaultModel` |
| `busyTriage` | 忙时先判断：执行中问进度由宿主直接回复，补充当前任务会尝试插话；关闭时照常排队 | `false` |
| `botLoopGuard` | 机器人互聊门禁，防止机器人之间来回对话 | `false` |
| `decisionAgentId` | 群里判断要不要接话的 Agent | 沿用 `memoryAgentId`，再回落 `defaultAgentId` |
| `decisionModel` | 群里判断要不要接话的模型 | 同上，沿用对应模型 |
| `responseAgentId` | 群里直接回复用的 Agent | 沿用 `memoryAgentId`，再回落 `defaultAgentId` |
| `responseModel` | 群里直接回复用的模型 | 同上，沿用对应模型 |
| `executionMode` | `single` 或 `layered`（Leader 模式：接待 + Leader + Worker；需开群工具，见[Leader 模式](lark.md#leader-mode)） | `single` |
| `leaderAgentId` | Leader 模式的 Leader Agent | 无 |
| `workerAgentIds` | Leader 模式的 Worker Agent，1 到 8 个 | 无 |
| `leaderSkill` | Leader 指引：技能名、`插件名/技能名`，或 `SKILL.md`（或其所在目录）的绝对路径。以 `/` 或 `~/` 开头按绝对路径读，其余依次按插件引用、相对工作目录的路径、技能名匹配（重名报错）；绝对路径不要求在技能目录里，只带 `SKILL.md`，同目录引用文件由 Leader 按需自己读；技能目录会跳过指向目录外的软链接，放在别处的指引请填绝对路径。`leaderSkill=` 清空，改回内置规则 | 空（内置规则） |
| `structuredAskCards` | 提问用结构化卡片；`false` 时改用文字选项和引用回复 | `true` |
| `groupCardMention` | 群里的卡片 @ 发起人：结果卡卡尾、审批和提问卡卡首 | `true` |
| `pushIntervalMs` | 进度卡刷新间隔，500–20000 毫秒 | `1000` |
| `traceLimit` | 过程卡最多保留的记录条数；`null` 恢复默认 | `50` |
| `hideTraceOnComplete` | 任务完成后收起过程卡的记录；精简过程卡开启时对过程卡不生效 | `true`（Web 新建表单的默认值里没有这一项，由服务端补上） |
| `compactTrace` | 精简过程卡，各阶段只显示一行 | `true` |
| `showAgentName` | 卡片标题栏显示 Agent 简称 | `false` |
| `completionReactionOnly` | 完成时只对触发消息贴表情，不发结果卡；可被群设置覆盖 | `false` |
| `silentProgress` | 中间进展完全静默，只保留最终结果；可被群设置覆盖 | `false` |
| `adhdMode` | ADHD 友好输出，每轮飞书任务附加对应的输出要求 | `false` |
| `urgentEnabled` | 审批或提问卡长时间无人处理时发飞书应用内加急，收件人手机上会出现强提醒 | `false` |
| `urgentThresholdMs` | 卡片发出多久仍无人处理才加急，至少 60000；`null` 恢复默认 | 10 分钟 |
| `urgentMaxPerHourPerChat` | 每个群每小时最多加急几次；`null` 恢复默认 | `3` |
| `notifyMentionAction` | 「需要你操作」一档 @ 发起人；要先开 `groupCardMention` | `true` |
| `notifyMentionDone` | 「完成」一档 @ 发起人；要先开 `groupCardMention` | `true` |
| `notifyQuietHours` | 免打扰时段 `HH:MM-HH:MM`（daemon 本地时区，可跨零点）；时段内只有「需要你操作」仍 @，加急推迟到时段结束；留空清除 | 无 |
| `pinLongTasks` | 长任务的进度卡自动置顶；置顶会改写群成员的会话列表 | `false` |
| `pinAfterMs` | 任务跑多久算长任务，至少 1000；`null` 恢复默认 | 10 分钟 |
| `allowedUsers` | 发起人名单，JSON 数组 `[{"openId":"ou_…","name":"…"}]`；与 `allowedEmails` 都为空时不限制 | 空 |
| `allowedUserNames` | 按姓名指定发起人名单，保存时解析成 `allowedUsers` | 空 |
| `allowedEmails` | 按邮箱指定发起人名单 | 空 |
| `allowedBots` | 发起人名单受限时仍放行的其他机器人，格式同 `allowedUsers` | 空 |
| `allowedBotNames` | 按名字指定 `allowedBots`，保存时解析 | 空 |
| `peerBotsAllowed` | 发起人名单受限时，是否放行同群里已授权的其他机器人（需开群工具） | `true` |
| `highRiskAllowedUsers` | 强制风控下可以执行高危命令的人，格式同 `allowedUsers`；与 `highRiskAllowedEmails` 都为空时不额外限制 | 空 |
| `highRiskAllowedUserNames` | 按姓名指定 `highRiskAllowedUsers`，保存时解析 | 空 |
| `highRiskAllowedEmails` | 按邮箱指定高危命令执行人 | 空 |
| `highRiskPattern` | 高危命令正则；留空恢复内置规则 | 内置规则 |
| `riskControlMode` | 高危命令风控：`off` 关闭、`guidance` 只提醒、`enforced` 强制拦截 | `off` |

### 改定时计划的频率

`dutydeck schedule update` 用 `--every`、`--cron` 或 `--at` 改触发时间，三者一次只能用一个，其余设置不变；完整用法见[通用定时任务](web-console.md)。

```bash
dutydeck schedule update schedule_xxx --session ses_xxx --every 60                    # 改成每 60 分钟一次，从现在开始计
dutydeck schedule update schedule_xxx --session ses_xxx --cron '30 8 * * 1-5'         # 改成工作日 08:30
dutydeck schedule update schedule_xxx --session ses_xxx --at 2026-12-01T09:00          # 改成一次性，按计划时区
```

改成一次性前，先清掉完成条件和截止时间（`--input '{"completionCondition":null,"deadlineAt":null}'`），一次性计划不能带这两项。

## 5. 终端后端与 Herdr 侧边子任务空间

- **主终端后端**：在 `tmux`（默认）与 `Herdr`（Linux，>= 0.9.0）之间选择，设置后新建的 `pty-cli` 会话生效。选择 Herdr 时异步检查版本，等待期间服务可继续处理其他请求。
- **Herdr 侧边空间**：主 Agent 可通过环境注入的 `$dutydeck_herdr_command` 派发并行子任务。每个会话有专属 named session，可在侧边 pane 运行命令、抓日志，不阻塞主任务。

## 6. 远程访问与安全策略

- Dutydeck 默认只监听 `127.0.0.1`。
- 局域网访问：启动时指定 `--host 0.0.0.0`。非本机访问需要认证：**浏览器用访问密码登录**，先设置 `dutydeck auth password set`（或 `--generate` 生成随机密码）；**CLI、脚本和 API 用 access token**：
  ```bash
  dutydeck auth token          # 查看当前 Token（首次使用自动生成）
  dutydeck auth token --rotate # 生成新 Token，旧的立即失效
  ```
  退出登录后仍可直接用同一密码再次登录。轮换 Token 或重设访问密码后，凭旧凭据已打开的实时流和终端连接（包括经主服务转发到其他实例的）在 10 秒内断开。`auth` 命令写哪个库：有 `--database` 用它；否则用 `DUTYDECK_DATABASE_URL`（相对路径与 `start` 一样按 Dutydeck 根目录解析）；都没有时用进程身份核验通过、正在运行的 daemon 的库，daemon 崩溃后残留的状态文件不作数，改用根目录默认的 `.dutydeck/dutydeck.db`。输出里的 `database` 是实际写入的库。`secret` 与 `lark create` 用同一规则。
- 不要在非本机地址上用 `--no-auth`：外部人员可能借 Agent 在宿主机上执行命令。在非回环地址关闭认证会拒绝启动，除非显式加 `--unsafe-no-auth`。
- **凭据保护**：机器人对外开放后，防止群里其他人借 Agent 套出本机的令牌、密钥和 Agent 会话记录。跟随机器人设置里的「风险控制」，只约束不在「高危操作允许名单」里的发送人和其他机器人；名单里的人照常使用，完全信任模式也不受影响。
  - 约束提示：给 Agent 加一条规则，不读取、复制、输出或发送凭据和 Agent 会话记录（如 `~/.claude`、`~/.claude.json`、`~/.codex`），被要求时一句话拒绝。
  - 强制拦截：另外在工具调用前检查，拦下读写凭据文件和会话记录（如 `~/.codex/auth.json`、`~/.ssh` 私钥、`.env`）、打印环境变量里的密钥这类操作，命令不会执行，Agent 收到拦截原因。Claude Code（终端和 ACP）和完全信任模式的 Codex 终端，这个检查随启动参数传给本次启动的 Agent，不改 `~/.claude`、`~/.codex` 下的全局配置；Codex 走 ACP 时由工作区里的拦截 Hook 检查，Cursor、Trae 和 Pi 也由工作区 Hook（Pi 是项目扩展）检查，命令类工具（如 Cursor 的 `Shell`、Pi 的 `bash`）和文件工具用同一套规则。本轮风控策略文件（`.dutydeck/` 下）和这些 Hook 配置（`.codex/hooks.json`、`.cursor/hooks.json`、`.trae/hooks.json`、`.claude/settings.json`、`.pi/extensions/`）同样受保护，Agent 不能改掉拦截再执行；Hook 文件和本版本生成的内容不一致时显示未安装，需要重新安装。
  - Codex（包括 `codex-acp`）的工作区 Hook 只有被原生 Codex 加载、启用，并信任当前内容哈希时才算就绪；仅有 `hooks.json` 文件不够。保存强制风控或启动会话时会通过无模型调用的 `config/read`、`hooks/list` 检查；不支持检查、出错或超过 5 秒均拒绝放行。请使用该 Agent 相同的 `CODEX_PATH` / `CODEX_HOME`，在目标工作区确认项目信任，再用 `/hooks` 仅审核 Dutydeck PreToolUse Hook，最后在 Web 点「重新检查 Hook」。Dutydeck 不自动信任项目或其他 Hook。
  - Claude Code 终端（包括 adapter 为 `claude-code` 的自定义 Agent，如 ccflash）和经 Dutydeck 启动的 ACP Claude，这个检查同时管高危操作正则，开强制拦截不用装工作区 Hook。自定义的 ACP Claude 要用随版本发布的 `dist/agents/claude-acp.mjs` 启动，自己拷贝出去的旧版本不带这个检查。
  - 任何模式下，飞书卡片、结果和群工具发出的消息都会把常见格式的密钥（如 `sk-ant-`、`ghp_`、JWT）和服务、Agent 环境变量里的密钥值替换成 `[REDACTED]`。Agent 回复和审批请求里写的飞书卡片标签（如 `<at id=all></at>`、`<text_tag>`、`<font>`）按文字显示，不会 @ 人或显示成彩色标签。

## 7. 给 Agent 用的命令行（`dutydeck agent`）

飞书会话里的 Agent 用 `dutydeck agent` 做通用操作。宿主每轮提供绑定本次执行的完整命令前缀：`<绝对路径> agent --turn <本轮凭证>`，并列出可用能力。Agent 直接沿用该前缀，不自行查询或猜测当前任务。下文示例用 `$TURN` 表示宿主提供的本轮凭证；受控插件导出另有 `plugin-tool` 入口，见[受控插件结果](plugins.md#受控插件结果)。

群协作的无人交互后台委托在 `ask` 或未配置权限时，仅分析冻结材料，不提供工具、Herdr 或交互提问指引；显式配置 `approve-reads` / `full-trust` 的委托保留工具提示。材料不足会说明缺口和未完成部分，不能因此报告“没有新增”。结果由后台调度器投递。

- **工具审批**：在 `ask` / `approve-reads` 下，已注入工具凭证的会话使用本会话的精确命令前缀执行单条 `dutydeck agent …` 时，Claude Code / Seed / Relay 终端模式和 ACP 会自动放行工具审批，并记录原因。拼接、重定向、展开等 shell 语法仍照常审批；`group send-file` 会把本地文件原样发到群里，始终要人工审批。`send-file` 只能发会话工作目录和系统临时目录下本会话的交付目录（`dutydeck-artifacts/<会话>`）里的文件，`.env`、私钥、凭据文件、Agent 会话记录、实例数据目录（数据库、密钥、附件等）和硬链接一律拒绝。高风险拦截和写操作确认卡照旧。其他终端 CLI 不支持这项精确放行。 Web 和飞书卡片审批共享执行端的最终回执；原审批卡按实际决定显示「已允许」「已拒绝」，真正过期或失效的请求保留相应状态。审批提交期间不会因待审批列表暂时隐藏请求而标成失效，服务重启后也会按持久回执补齐卡片。
- **帮助**：`dutydeck agent --help` 开头是写给 Agent 的快速说明；每个子命令的 `--help` 有一行 `Risk`（`read` 只读、`write-confirm` 发确认卡、`write` 直接生效）和例子。帮助不需要服务或凭证。
- **输出**：stdout 只有一个 JSON。成功 `{"ok":true,"data":...}`；失败 `{"ok":false,"error":{"code","message","hint"?,"params"?:[{"name","reason"}]}}`，退出码非 0。`params` 指出哪个参数不对，能给可选值时写在 `reason` 里。
- **查看**：`status`、`agents`、`tasks [--page]`、`queue`、`schedules`、`ci`，以及 `group`、`history`、`memory`、`work`、`collaborate` 的读取命令。结果直接交给 Agent，不在群里发卡；权限与这一轮的发起人在原话题自己发这条命令相同。
- **写入**：`session new/resume/fork`、`retry`、`plan --task`、`schedule create/enable/disable`、`queue cancel/top`、`access grant/revoke --member`、`pr open`、`ci wait/fix/cancel`、`repair` 在这一轮的请求消息下发确认卡，点「确认」后与对应的斜杠命令走同一条路执行。`group send`、`memory add` 等照旧直接生效。`schedule create/update` 不能设置计划的前置命令（`--condition-command`），它只能在 Web 计划面板或本机 `dutydeck schedule` 设置，见[通用定时任务](web-console.md)。写入命令都支持 `--dry-run`：只返回将要做什么、要不要确认、确认卡上写什么，不执行、不发卡。
- **修订目标计划**：`work revise <目标编号> --file revision.json`，JSON 为 `{"expectedRevision":<show 返回的 revision>,"plan":{完整新计划},"reason":"原因"}`；`--dry-run` 由服务计算影响（保留、重跑、先停止、删除、新增），不改动目标。只收窄的修订直接生效，扩大范围或目标本身要求确认时记为待确认修订，等用户「确认修订」；在此之前目标按当前计划继续执行。规则见 [目标计划修订](web-console.md#work-plan-revision)；旧入口 `dutydeck work revise` 用法相同。
- **任务归属**：读取、写入、最终交付和交接都校验本次执行的 `--turn`。缺失、旧任务或同任务旧尝试的凭证会被拒绝；晚到的旧请求不会改算到新任务和新请求人。帮助仍可离线查看。
- **升级旧会话**：旧提示词里的无轮次工具调用不再接受。使用宿主在本轮提供的新命令前缀；上一轮的前缀不能跨轮复用。旧的群工具、历史和记忆入口可在顶层传入凭证，例如 `dutydeck --agent-turn "$TURN" group self`。

`dutydeck agent --turn "$TURN" settings show` 只读查看机器人常用设置；`dutydeck agent --turn "$TURN" settings set defaultAgentId=codex notifyQuietHours=22:00-08:00` 先发确认卡，机器人管理员点确认才保存。用户可以直接说「以后默认用 codex」「晚上十点到早上八点别推送」，让 Agent 代办。可改的只有默认 Agent、模型、推理强度、私聊模式（`p2pMode`）、群回复模式（`groupReplyMode`）、免打扰（`notifyQuietHours`）、两档通知 @（`notifyMentionAction` / `notifyMentionDone`）、忙时判断（`busyTriage`）和机器人互聊门禁（`botLoopGuard`）；权限、白名单和凭据不开放。免打扰留空可清除。群回复选择「自动」（或设置 `groupReplyMode=auto`）会清除已保存的显式覆盖，恢复默认自动路由；更新时省略的字段保持原值。群有单独覆盖时，`show` 仍返回机器人默认值；群回复模式为 `null` 表示尚未显式设置，沿用旧路由。

确认权限与管理机器人设置的入口一致：托管群需要机器人管理权限（`channel_bot.update`），只有高风险操作授权不能确认；未托管时，需要明确的部署成员或邮箱名单，名单为空不能确认。确认卡绑定发卡时的配置版本；期间 Web 改过设置，旧卡会拒绝覆盖，需要重新提出变更。

## 8. 自动只读巡检

实例启动约 5 分钟后首次巡检，之后每小时检查长连接、未确认的结果投递、排队受阻、结果未知、逾期计划及后台记忆作业。发现新问题时汇总私信机器人所有者；同一问题恢复前只报一次，恢复时不发消息。巡检不修改或重试任务，Web 实例不发私信。私信发送失败时约 5 分钟后重发同一条（同一去重编号），直到去重窗口（55 分钟）用完；之后结果仍未知时不重复私信，可在 doctor 中查看。私信被飞书以缺权限拒收时不记为结果未知，每天最多重试一次，doctor 显示缺少的权限，在开放平台开通后最多 24 小时内会重发；若这批私信之前有过结果未知的发送，仍按结果未知处理、不再重发。24 小时后没有要发的内容、该机器人停止监听，或找不到可私信的接收人时，doctor 不再显示这条提示。运行 `dutydeck doctor` 可查看未恢复的问题及首次发现时间。

已恢复的巡检发现保留 7 天，每个范围最多保留最近 1000 条；活动问题和未完成通知引用的记录不清理。

巡检另检查最新未清除的等决定/受阻报告是否超过 24 小时，以及未受理入站或仍在判断/确认的消息是否等待超过 1 小时；已拒绝、静默、已处理及取消/过期确认不算积压。这些阈值固定，巡检只汇总所有者，不代替用户决策或重发任务。

「结果未知」按当前执行记录是否已结算判断：已结案的不再报，之前报过的下一轮记为已恢复；机器人发的、群参与不会判断的消息不算入站积压。巡检还报告定时计划最近一次触发出错、会话停止未核实（发给它的消息会失败）、终端已不在但记录仍是运行中、计划建好超过 24 小时还没启用，都并入同一封每小时私信。接收人依次取允许名单第一人、创建该应用的人（在群里发过请求而被登记的成员不算）；都取不到时只在 `dutydeck doctor` 显示「巡检无人接收」，日志每天最多提示一次。加入允许名单会限制谁能使用机器人，只为接收巡检私信时不要这样做。

飞书卡片对账把已结算的结果未知卡算作处理完。还有卡没处理完时，排队或执行中的任务照常每 5 秒对账一次；只剩等人处理或等重发的，间隔逐轮翻倍、最长 1 分钟，且只重查这些卡；有新消息或任务状态变化时立即回到 5 秒并重查全部。
