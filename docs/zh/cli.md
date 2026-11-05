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

# 一键诊断（端口、SQLite、Agent 可执行性与默认 Agent、飞书监听等）
dutydeck doctor
```

`restart` 先暂停领取新任务。已提交成功、恢复日志与原轮身份可验证的 `full-trust` tmux 任务继续在原 CLI 进程里运行，新服务接回同一轮，不重发输入；其余任务继续等待结束。ACP、普通 PTY、Herdr、提交中、缺少恢复日志或身份，以及待审批或高危权限门禁未授权的任务都不会跳过等待。systemd 只在当前 `KillMode=process` 时保留任务；其他值或读不到时全量等待。旧服务不支持恢复计数、排空失败或租约续期失败时也全量等待。`--drain-timeout` 控制等待上限，`--force` 保留原来的强制重启行为，当前 Agent 自己的会话仍自动排除。`deploy` 使用同一保留策略，ACP 等不可保留的任务仍等待结束。

Codex 的 `codex` 入口默认使用终端模式，`codex-cli` 入口继续兼容。已有 ACP 会话继续通过 ACP 续跑，新会话使用当前默认协议；机器人权限不会自动提升。Codex 等不支持飞书逐项审批的终端 Agent，在 `ask` / `approve-reads` 下新开飞书会话会被拒绝；需要逐项审批时，选择内置「Codex (ACP)」（`codex-acp`），或选择 Claude Code / Seed / Relay 等支持审批的终端 Agent。只有原本已获 `full-trust` 权限、且恢复证据完整的 tmux 任务能跨服务重启继续运行；首次提交尚无日志位置的任务仍会等待结束。接回后跑完的任务和普通任务一样，触发一次插件 `task.completed` hook、触发器结果回投和触发器运行状态更新；接回后被停止或结果仍未知的不触发。主轮结束后仍有原生后台任务时，安全重启和部署的排空也会等待它们结束；直接终止进程或 `--force` 不提供此保证。

`GET /api/system/activity` 的 `runningTasks` 包含正在执行主轮的会话，以及主轮已结束但仍有原生后台任务的会话；同一会话只计一次。显式加 `?restart=true` 才检查恢复证据并返回 `restartBlockers` 和 `recoverableTasks`；未进入排空时不减去可恢复任务，`excludeSessionId` 同时适用于这三个计数。

## 2. 版本发布与部署 (`deploy`)

```bash
# 把构建好的检出目录发布为不可变版本：排空 → 切换 releases/current → 重启 → 健康检查；失败时按条件回滚
dutydeck deploy --source /path/to/checkout

# 先看会删什么、能释放多少空间，再清理旧版本和旧部署记录
dutydeck deploy prune --releases /path/to/releases --dry-run
dutydeck deploy prune --releases /path/to/releases
```

- **停机窗口**：新进程初始化完成即开始监听 HTTP，飞书长连接随后在后台并行建立，健康检查不等待飞书握手；连接失败按原有退避重连。Web 断线后最长每 5 秒重试一次；Agent 调用群协作工具遇到连接被拒时最长等待 90 秒，连接中途断开等可能已送达的请求不重试。开始监听后写一条「启动各阶段耗时」日志（`startupMs`，毫秒）：`boot` 进程与模块加载、`plugins`、`config`、`database` 打开库、`migrate` 迁移、`wiring`、`insight`、`integrations`、`relay`、`agentDefaults`、`agents` 登记 Agent、`sessions` 恢复会话与对账、`routes`、`listen`，以及 `total`。
- **部署窗口**：环境变量 `DUTYDECK_DEPLOY_WINDOW`（如 `10:00-11:00,16:00-17:00`）限制部署时段，窗口外加 `--now` 才部署。
- **Web 静态资源**：HEAD 请求检查文件可读性与大小，返回与 GET 相同的 `Content-Length`，不读取文件正文。
- **失败与中断**：部署失败、中途出错或被 Ctrl-C / kill / ssh 断开打断时，都会写 `status: failed` 的部署记录（被信号打断的另记 `aborted_by`），先等已发出的排空续期请求结束，再让旧服务退出排空、恢复执行新任务，不再等租约到期，避免迟到的续期再次暂停服务；被打断后不再切换版本、重启或回滚。
- **并发部署与清理**：共用同一个实际发布根目录的操作互斥，包括不同 unit 的部署、`--no-restart` 和手动 `deploy prune`（含 `--dry-run`）。已有操作进行时，后来的命令会明确报忙并拒绝执行，待前一操作结束后重试；不同发布根目录可独立操作。
- **备份期间保持暂停接单**：排空后先备份数据库再切换版本，备份期间每 5 秒续一次排空。续期失败，或备份结束时又有任务在执行，部署不切换版本、不重启，旧服务继续运行，记为失败并写明原因；等任务结束后重新部署，确认可以中断任务时加 `--force`。
- **回滚**：健康检查不过时先停服务。多个 unit 共用同一个 `current` 时，以目标 unit 实际运行的版本为回滚目标；无法核实运行版本时拒绝切换。目标已停服时，历史上部署成功的版本只有在数据库 schema 与当前匹配才作为回滚候选；确认 schema 没变才自动切回，schema 变了就停止自动回滚，保护数据，不会恢复旧数据库快照。
- **缺地址或数据库时拒绝**：目标 unit 没记录可用的健康检查地址或数据库路径（例如被 `dutydeck stop` 停过）时，deploy 直接拒绝，不切换版本也不重启。先启动该 unit 让它记下地址，或用 `--runtime` 指向写有 `address`、`databasePath` 的 `deployment.json`。
- **自动清理**：每次部署成功后保留最新 5 个发布目录；部署记录按 unit 分别保留最新 5 个，每个 unit 只有最新 2 份记录留着数据库备份（含本次），同一发布根下依次部署多个 unit 时互不挤占。更早的记录只删备份文件、保留 `manifest.json`；`manifest.json` 里没记 unit 的旧记录不按份数删备份。deploy 建的记录超过 24 小时仍没有 `manifest.json`（部署进程被强制杀掉留下的），不占保留个数，直接删除。`current`、它的上一版和仍被运行中进程引用的版本永远保留；自动清理和手动 `deploy prune` 都会额外保留各 unit 最近一次成功部署的版本。清理失败只告警，不影响部署结果。
- **历史数据保留**：服务每小时分批清理一次数据库里的历史数据，只动已结束的任务，未结束、结果未知和旧版待退役会话的数据不动：终端模式超过 30 天的轮次只留最后一屏的内容；旧版本存的会话状态快照和工具调用镜像超过 30 天删除；群策略、群绑定、群信息和角色的修订记录每项只留最近 20 条。事件记录本身不删，Web 历史仍然完整连续。已有旧库的终端输出存在缺口时，网页仍可展开历史轮次、原始日志和执行追踪，显示剩余记录；读取未到达请求终点或分页异常仍会报错，可重试。清理不做 VACUUM，数据库文件不会变小，腾出的空间留给后续写入复用；要缩小文件，停服后对数据库执行 `VACUUM`。
- **手动清理** `deploy prune`：选项 `--releases/--runtime/--unit`、`--keep N`（默认 5）、`--dry-run`、`--include-unmarked`、`--json`。手工部署留下的记录（没有 `created_by: dutydeck deploy` 标记）默认不动，只有加 `--include-unmarked` 才会清，并且仍被进程引用或 1 小时内改过的会跳过。最近 1 小时内改过的 `.partial` 目录同样跳过（可能是正在进行的部署）。
- **单 Bot 独立进程**：`dutydeck start --foreground --database /path/to/bot.db --bot-app-id cli_xxx`。
- **拆分机器人数据**：`scripts/split-bot-runtimes.mts` 会把空闲终端状态、排队受阻和结果未知提醒、计划逾期提醒随所属会话迁入对应机器人的库；未知或无法确认归属的记录仍会阻止拆分。
- **systemd 服务与数据库解析**：对直接以 `node cli.js` 启动的 unit，管理命令（`restart`、`status`、`deploy` 等）按 ExecStart 显式参数 > unit 环境变量 > `WorkingDirectory/.env` 解析目标数据库和监听地址；相对工作目录以 `WorkingDirectory` 为基准。缺少 `.env` 可继续，不可读或关键配置无效时拒绝操作；数据库未配置时回落到 `<cwd>/.dutydeck/dutydeck.db`。部署备份和 schema 回滚检查使用同一实际数据库。`start --foreground` 仍读取守护状态，`deploy --runtime` 显式元数据继续优先。

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
dutydeck settings group set oc_xxx 'scenarios={"alarm":{"enabled":true,"params":{"levels":["P0","P1"]}}}'  # 改告警初筛的级别
```

强制风控下更换工作区、默认 Agent、兜底或分流 Agent 时，先在机器人设置点「配置拦截 Hook」，再保存。Hook 检查和安装使用当前草稿的工作区及所有候选 Agent；安装只写 Hook 文件，不保存其他草稿，也不降低现有强制风控。CLI 的 `install-hook --prepare [key=value...]` 同样只准备文件，支持 `workspace`、`defaultAgentId`、`fallbackAgentId` 和 `defaultAgentWeights`；准备后再用 `bot set` 保存。省略 `--prepare` 且不传草稿参数时，沿用安装并保存高危正则/提醒模式的行为，已开启强制风控的机器人保持强制模式。保存失败会保留草稿，只有版本冲突才提示并发修改。

保存接口对私聊模式、群回复模式、群记忆范围和应用品牌使用严格枚举校验；非法值返回 `400 INVALID_LARK_CONFIG`，不会清除已保存值。`groupReplyMode=null` 仍用于清除覆盖，CLI 用 `groupReplyMode=auto`。

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
  退出登录后仍可直接用同一密码再次登录。
- 不要在非本机地址上用 `--no-auth`：外部人员可能借 Agent 在宿主机上执行命令。在非回环地址关闭认证会拒绝启动，除非显式加 `--unsafe-no-auth`。
- **凭据保护**：机器人对外开放后，防止群里其他人借 Agent 套出本机的令牌、密钥和 Agent 会话记录。跟随机器人设置里的「风险控制」，只约束不在「高危操作允许名单」里的发送人和其他机器人；名单里的人照常使用，完全信任模式也不受影响。
  - 约束提示：给 Agent 加一条规则，不读取、复制、输出或发送凭据和 Agent 会话记录（如 `~/.claude`、`~/.claude.json`、`~/.codex`），被要求时一句话拒绝。
  - 强制拦截：另外在工具调用前检查，拦下读写凭据文件和会话记录（如 `~/.codex/auth.json`、`~/.ssh` 私钥、`.env`）、打印环境变量里的密钥这类操作，命令不会执行，Agent 收到拦截原因。Claude Code（终端和 ACP）和完全信任模式的 Codex 终端，这个检查随启动参数传给本次启动的 Agent，不改 `~/.claude`、`~/.codex` 下的全局配置；Codex 走 ACP 时由工作区里的拦截 Hook 检查。
  - Codex（包括 `codex-acp`）的工作区 Hook 只有被原生 Codex 加载、启用，并信任当前内容哈希时才算就绪；仅有 `hooks.json` 文件不够。保存强制风控或启动会话时会通过无模型调用的 `config/read`、`hooks/list` 检查；不支持检查、出错或超过 5 秒均拒绝放行。请使用该 Agent 相同的 `CODEX_PATH` / `CODEX_HOME`，在目标工作区确认项目信任，再用 `/hooks` 仅审核 Dutydeck PreToolUse Hook，最后在 Web 点「重新检查 Hook」。Dutydeck 不自动信任项目或其他 Hook。
  - Claude Code 终端（包括 adapter 为 `claude-code` 的自定义 Agent，如 ccflash）和经 Dutydeck 启动的 ACP Claude，这个检查同时管高危操作正则，开强制拦截不用装工作区 Hook。自定义的 ACP Claude 要用随版本发布的 `dist/agents/claude-acp.mjs` 启动，自己拷贝出去的旧版本不带这个检查。
  - 任何模式下，飞书卡片、结果和群工具发出的消息都会把常见格式的密钥（如 `sk-ant-`、`ghp_`、JWT）和服务、Agent 环境变量里的密钥值替换成 `[REDACTED]`。

## 7. 给 Agent 用的命令行（`dutydeck agent`）

飞书会话里的 Agent 用 `dutydeck agent` 做通用操作。宿主每轮提供绑定本次执行的完整命令前缀：`<绝对路径> agent --turn <本轮凭证>`，并列出可用能力。Agent 直接沿用该前缀，不自行查询或猜测当前任务。下文示例用 `$TURN` 表示宿主提供的本轮凭证；受控插件导出另有 `plugin-tool` 入口，见[受控插件结果](plugins.md#受控插件结果)。

群协作的无人交互后台委托在 `ask` 或未配置权限时，仅分析冻结材料，不提供工具、Herdr 或交互提问指引；显式配置 `approve-reads` / `full-trust` 的委托保留工具提示。材料不足会说明缺口和未完成部分，不能因此报告“没有新增”。结果由后台调度器投递。

- **工具审批**：在 `ask` / `approve-reads` 下，已注入工具凭证的会话使用本会话的精确命令前缀执行单条 `dutydeck agent …` 时，Claude Code / Seed / Relay 终端模式和 ACP 会自动放行工具审批，并记录原因。拼接、重定向、展开等 shell 语法仍照常审批；高风险拦截和写操作确认卡照旧。其他终端 CLI 不支持这项精确放行。 Web 和飞书卡片审批共享执行端的最终回执；原审批卡按实际决定显示「已允许」「已拒绝」，真正过期或失效的请求保留相应状态。审批提交期间不会因待审批列表暂时隐藏请求而标成失效，服务重启后也会按持久回执补齐卡片。
- **帮助**：`dutydeck agent --help` 开头是写给 Agent 的快速说明；每个子命令的 `--help` 有一行 `Risk`（`read` 只读、`write-confirm` 发确认卡、`write` 直接生效）和例子。帮助不需要服务或凭证。
- **输出**：stdout 只有一个 JSON。成功 `{"ok":true,"data":...}`；失败 `{"ok":false,"error":{"code","message","hint"?,"params"?:[{"name","reason"}]}}`，退出码非 0。`params` 指出哪个参数不对，能给可选值时写在 `reason` 里。
- **查看**：`status`、`agents`、`tasks [--page]`、`queue`、`schedules`、`ci`，以及 `group`、`history`、`memory`、`work`、`collaborate` 的读取命令。结果直接交给 Agent，不在群里发卡；权限与这一轮的发起人在原话题自己发这条命令相同。
- **写入**：`session new/resume/fork`、`retry`、`plan --task`、`schedule create/enable/disable`、`queue cancel/top`、`access grant/revoke --member`、`pr open`、`ci wait/fix/cancel`、`repair` 在这一轮的请求消息下发确认卡，点「确认」后与对应的斜杠命令走同一条路执行。`group send`、`memory add` 等照旧直接生效。写入命令都支持 `--dry-run`：只返回将要做什么、要不要确认、确认卡上写什么，不执行、不发卡。
- **任务归属**：读取、写入、最终交付和交接都校验本次执行的 `--turn`。缺失、旧任务或同任务旧尝试的凭证会被拒绝；晚到的旧请求不会改算到新任务和新请求人。帮助仍可离线查看。
- **升级旧会话**：旧提示词里的无轮次工具调用不再接受。使用宿主在本轮提供的新命令前缀；上一轮的前缀不能跨轮复用。旧的群工具、历史和记忆入口可在顶层传入凭证，例如 `dutydeck --agent-turn "$TURN" group self`。

`dutydeck agent --turn "$TURN" settings show` 只读查看机器人常用设置；`dutydeck agent --turn "$TURN" settings set defaultAgentId=codex notifyQuietHours=22:00-08:00` 先发确认卡，机器人管理员点确认才保存。用户可以直接说「以后默认用 codex」「晚上十点到早上八点别推送」，让 Agent 代办。可改的只有默认 Agent、模型、推理强度、私聊模式（`p2pMode`）、群回复模式（`groupReplyMode`）、免打扰（`notifyQuietHours`）、两档通知 @（`notifyMentionAction` / `notifyMentionDone`）、忙时判断（`busyTriage`）和机器人互聊门禁（`botLoopGuard`）；权限、白名单和凭据不开放。免打扰留空可清除。群回复选择「自动」（或设置 `groupReplyMode=auto`）会清除已保存的显式覆盖，恢复默认自动路由；更新时省略的字段保持原值。群有单独覆盖时，`show` 仍返回机器人默认值；群回复模式为 `null` 表示尚未显式设置，沿用旧路由。

确认权限与管理机器人设置的入口一致：托管群需要机器人管理权限（`channel_bot.update`），只有高风险操作授权不能确认；未托管时，需要明确的部署成员或邮箱名单，名单为空不能确认。确认卡绑定发卡时的配置版本；期间 Web 改过设置，旧卡会拒绝覆盖，需要重新提出变更。

## 8. 自动只读巡检

实例启动约 5 分钟后首次巡检，之后每小时检查长连接、未确认的结果投递、排队受阻、结果未知、逾期计划及后台记忆作业。发现新问题时汇总私信机器人所有者；同一问题恢复前只报一次，恢复时不发消息。巡检不修改或重试任务，Web 实例不发私信。私信发送失败时约 5 分钟后重发同一条（同一去重编号），直到去重窗口（55 分钟）用完；之后结果仍未知时不重复私信，可在 doctor 中查看。运行 `dutydeck doctor` 可查看未恢复的问题及首次发现时间。

已恢复的巡检发现保留 7 天，每个范围最多保留最近 1000 条；活动问题和未完成通知引用的记录不清理。

巡检另检查最新未清除的等决定/受阻报告是否超过 24 小时，以及未受理入站或仍在判断/确认的消息是否等待超过 1 小时；已拒绝、静默、已处理及取消/过期确认不算积压。这些阈值固定，巡检只汇总所有者，不代替用户决策或重发任务。

「结果未知」按当前执行记录是否已结算判断：已结案的不再报，之前报过的下一轮记为已恢复；机器人发的、群参与不会判断的消息不算入站积压。巡检还报告定时计划最近一次触发出错、会话停止未核实（发给它的消息会失败）、终端已不在但记录仍是运行中、计划建好超过 24 小时还没启用，都并入同一封每小时私信。接收人依次取允许名单第一人、创建该应用的人（在群里发过请求而被登记的成员不算）；都取不到时只在 `dutydeck doctor` 显示「巡检无人接收」，日志每天最多提示一次。

飞书卡片对账把已结算的结果未知卡算作处理完。还有卡没处理完时，排队或执行中的任务照常每 5 秒对账一次；只剩等人处理或等重发的，间隔逐轮翻倍、最长 1 分钟，且只重查这些卡；有新消息或任务状态变化时立即回到 5 秒并重查全部。
