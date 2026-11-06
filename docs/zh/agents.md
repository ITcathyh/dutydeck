# Agent 配置与权限姿态 <a id="agent-config"></a>

> [← 返回 README](../../README.md) · [全部文档](../../README.md#docs) · [English](../en/agents.md)

Dutydeck 默认优先用终端适配器运行本机已安装的 CLI Agent，新会话的终端后端默认是 `tmux`；同一入口同时支持终端与 ACP 时优先终端。没有可用终端适配器或其命令不可用时，仍按原规则发现 ACP（Agent Client Protocol）入口。已配置的 Herdr 后端、已有会话的协议和权限保持不变；`DUTYDECK_AGENTS_JSON` 显式指定的协议、命令和权限优先。

内置 CodeM（`codem`）终端适配器使用显式 `--session` / `--resume` 会话标识，不使用“最近会话”猜测；需要本机已安装 `codem` 命令，权限为 `full-trust` 时追加 `--yolo`。

内置 Kimi（`kimi`）终端适配器在权限为 `full-trust` 时，新建和恢复会话启动前都会在后台异步读一次 `kimi --help`（用与启动 Kimi 相同的清洗后环境，最多等 3 秒；每个命令每个进程只读一次）：帮助里列出 `--auto`（Never Ask）就传 `--auto`，否则（含读取失败或超时）传 `--yolo`。Kimi Code 里 `--yolo` 只放行普通工具调用，高危操作仍会停下等人确认；同样叫 `kimi` 的 Python 版 kimi-cli 没有 `--auto`，在那里 `--yolo` 就是全部放行。

内置 Codex 的 `codex`、`codex-cli` 终端入口及「Codex (ACP)」（`codex-acp`）在发现探测和启动执行进程时，优先遵循显式设置的 `CODEX_PATH`，支持指向 `PATH` 之外的可执行程序；未显式设置时使用 Dutydeck 进程 `PATH` 中的 Codex，沿用用户的登录和配置；升级用户安装的 Codex 后，新启动的进程自动使用新版本。找不到用户安装或显式指定路径的 Codex 时会报错，不使用 ACP 适配器缓存中的版本。

Codex 终端 Agent 会从 `CODEX_HOME/config.toml` 读取 `[profiles.<name>]` 配置，并在 Web 新建任务时提供 profile 选择；选择结果只作用于新会话，未选择时沿用 Agent 默认 profile。profile 名称不会写入 Agent 的环境变量。

## 1. 自定义 Agent (`DUTYDECK_AGENTS_JSON`)

用环境变量 `DUTYDECK_AGENTS_JSON` 注册自定义 Agent。

### 示例：接入 Claude Code（经代理网关）
```json
[
  {
    "id": "ccflash",
    "name": "CCFlash (Claude Code)",
    "protocol": "pty-cli",
    "adapterId": "claude-code",
    "command": "claude",
    "args": ["--settings", "/home/username/.claude/ccflash.settings.json"],
    "model": "claude-sonnet-5-5",
    "permissionMode": "ask"
  }
]
```

配套的 `ccflash.settings.json`：
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8320",
    "ANTHROPIC_AUTH_TOKEN": "your-proxy-token"
  }
}
```

> **最佳实践**：
> - 用 `--settings` 指定独立配置文件，避免多任务并发时改动全局 `~/.claude/settings.json`。
> - `command` 必须是二进制的绝对路径或 `PATH` 里的可执行程序，不能用 shell alias。
> - `command` 找不到的 Agent **不会被登记**。`dutydeck doctor` 会报 fail 并点名这个 Agent 和命令，daemon 启动日志也会告警。
> - 默认的 tmux 后端下，Agent 配置里的 `env.PATH`（包括空串）会原样作为 Agent 进程的 `PATH`，`command` 只写命令名时也在这个 `PATH` 里查找；是否登记仍按 Dutydeck 服务自己的 `PATH` 判断。自定义 `PATH` 时要包含 `command` 所在目录，或把 `command` 写成绝对路径，否则 Agent 能登记却启动失败。
> - `DUTYDECK_AGENTS_JSON` 写错（JSON 语法或字段）时，报错会点名这个变量。

### 示例：接入标准 ACP Agent
```json
[
  {
    "id": "custom-acp",
    "name": "My Custom ACP",
    "protocol": "acp",
    "command": "/usr/local/bin/my-acp-agent",
    "args": ["serve"],
    "permissionMode": "ask"
  }
]
```

`timeout` 以秒为单位，默认 `600`，必须能精确换算为 1–2147483647 的整数毫秒（即 `0.001`–`2147483.647` 秒）。ACP Agent 一轮超时后如果一直不回应取消，从超时起过了 `timeout` 与 60 秒中较长的一段，系统会结束这个会话卡住的 Agent 进程，不影响其他会话。上一轮仍记为结果未知、不重发，按原规则等人确认；在此之前确认不了，因为 Agent 还没停下。期间发出、正在等的消息不会发给 Agent，会话里说明原因并提示直接重发。之后的消息会自动拉起新的 Agent 进程，按原会话记录接回；接不上时按现有的会话恢复规则处理。模型目录的备用 CLI 探测使用该 Agent 实际配置的直接 CLI 可执行路径、清洗后的 `env` 和 `cwd`，只透传已支持的全局选项（带值选项须分开参数和值）。其他启动参数、等号形式或包装命令不执行备用探测，保留配置中的默认模型，不替换成宿主命令。

### 终端任务状态与恢复

Claude Code 终端会话优先使用 OSC 7501 状态信号判断忙碌、等待审批和完成；信号不可用时自动回退到屏幕识别，后续有效信号可重新接管；与本轮输入绑定、且写在最新忙态信号之后的原生终态（包括守护进程重启接回的轮次），或真实审批已裁决时，可解除丢失信号留下的忙态。

终端模式（`pty-cli`）CLI 空闲时自行退出后，下一条任务会先确认旧进程已退出并退役，再按既有原生会话恢复规则重建终端；无法确认安全恢复时，该任务会以“未提交”失败。已提交但结果未知的任务仍需核对，不自动重发。

Unix PTY 在退出关闭读端前最多补读 1 MiB 尾部数据，保留 UTF-8 解码、暂停/恢复和先输出后退出的顺序；直接终端与 pane 中继使用同一实现。此退出路径已在 Linux / Node 22 验证，macOS 尚未验证，Windows 沿用原实现。

Claude Code 日志已显示支持整轮结束标记（`turn_duration`）时，分块回答会等该标记再结束，保留同轮后续文本、Stop hook 收尾和晚到错误；没有该标记的旧格式保留兼容收尾。调用 Skill 工具产生的工具上下文不会被误判为新的用户输入，Skill 调用结束后的最终答案和任务完成事件正常交付。

Claude Code 在 Linux 上提供可核验的原生 PID 状态时，Dutydeck 会跟随同一已验证进程在 `/clear`、`/resume` 或 `/branch` 后切换采集来源，并持久保存新的恢复身份；新文件中的已有历史不重复投递。执行中的轮次遇到来源切换会进入“结果未知”，需走既有人工核对入口，不自动重发。空文件或只有元数据的新文件不作为冷恢复目标，也不会因此退回切换前的旧上下文。缺少进程出生标识等字段的旧版 CLI，以及 macOS，继续使用既有 marker 归属路径，不承诺跟随原生切换。

Linux 上，原生 PID 状态缺失或暂时无法核验时仍按既有 marker 采集；这类情况或最新会话身份尚未确认写入数据库时，自动空闲清理和正常服务关闭会保留原终端。只有能完整核实为原会话进程、已确认空闲且为 `full-trust`，并且没有未决任务、权限等待或后台任务的 tmux 终端可自动重新接管；其余保持阻塞，等待人工确认。

自动空闲清理关闭终端后，最多等 10 秒确认原进程都已退出（Claude 终端外层的状态转发进程会随 Claude 一起退出）。仍没能确认时，服务日志记一条告警，发给这个会话的消息直接报“停止受阻”（`DRIVER_STOP_UNVERIFIED`），不会排进队列不动；后台 45 秒后复核，每次复核都会再停一次终端，之后间隔加倍、最长 30 分钟一次，确认退出后自动恢复，不用重启或手动回收；第一次复核仍未通过时在会话里提醒一次（飞书会话发到原话题）。原生会话一直确认不了的终端（比如卡在启动确认框），闲置超过释放阈值再加 18 小时后照常回收并记一条告警；原生记录留在磁盘上，回收只结束进程。服务启动时，某个会话保存的工作目录不在了（比如 worktree 被删），只跳过这个会话并在日志和会话里记下原因，其他会话照常恢复。

终端 Agent 正在跑构建、测试或 git、不停起短命子进程时，停止、删除和空闲回收照样能结束它的 tmux 会话，并把这期间出现的子进程一起纳入退出确认；启动或接回时没取到终端身份的，停止时会补取。停止本身失败（没能结束终端）时，会话的“停止受阻”原因写明失败原因，再次停止会重试。tmux 的 socket 文件被删（例如 /tmp 定期清理）而 Agent 进程还在时，不再误判 Agent 已退出。Agent 子进程不再继承 Dutydeck 所在 tmux pane 的 `TMUX`、`TMUX_PANE`（在 Agent 配置的 `env` 里显式写的保留），Agent 里的 tmux 命令不会打到你自己的 pane。

会话的 Agent 被空闲回收或服务重启后，下一条消息会重新拉起 Agent。这次拉起失败时，这条消息报失败并带出原因，Dutydeck 随即确认启动到一半的进程已经退出：确认了，下一条消息照常重新拉起；确认不了，按上面同样的规则后台复核，期间新消息直接报“停止受阻”并说明后台会自动恢复，不会静默排队。

在 Web 会话里切换模型或思考强度时，会先对照 Agent 公布的可选值（与飞书 `/model`、`/effort` 同一份列表）；值不在列表里直接报错，配置没有改动。Agent 在调用前明确拒绝某个值时，会话照常可用；只有切换结果说不准（比如 Agent 已收到请求但没有确认）时，会话才记为配置未知并拒绝新消息，报错里写明用 `dutydeck recovery restore-configuration` 恢复。

Codex 在同一原生会话切换日志文件时，会校验会话归属、读完旧文件的完整记录，再接续新文件；复制的历史不会重复投递，其他会话的文件不会被接入。

Codex 和 TraeX 恢复原生会话时，只使用能确认属于当前会话的记录；继承的上下文不足以证明归属时会拒绝恢复，避免续接其他会话。Codex 会话空闲释放后，下一轮会恢复已验证的原生上下文。

Codex 和 TraeX 终端任务按当前原生轮次的成功、失败或取消事件结算，部分回答不抵消随后出现的失败；取消记为中断。Codex 恢复中的轮次即使尚无正文输出，只要确认了对应输入和失败或取消终态，也会按该终态结束。TraeX 可读取含大型模型目录的会话元数据，正常接收最终回答并结束任务；恢复会先读完同一会话的旧日志段，再读取新段；新版 canonical 记录保留过程、输入回执和最终回答，并去除镜像重复。

TraeX 用完整终端画面区分忙碌与就绪，兼容独立一行的快捷键页脚；正文或草稿里的状态引用不作为活动页脚。Codex 支持 `›` / `»` 输入提示及 0.164.0 仅显示模型与每周剩余额度的状态栏，信任和更新菜单不视为输入就绪。Cursor 普通输入只发一次 Enter，保留多行输入和普通任务排队；不附带空输入的第二次控制动作。Claude Code、Seed、Relay 的空输入框可被识别为空闲，以便继续处理待确认任务的恢复操作；支持空输入框与权限模式栏之间最多两行自定义 `statusLine`，恢复会话后也能提交首条消息。

Codex 当前父轮明确启动的直接子任务若报告额度耗尽或请求限流，Web 和飞书进度记录会显示固定诊断，不展示上游错误原文。父任务继续；Dutydeck 不因该诊断自动重试或切换账号。这是有界的尽力观察，恢复前已启动的子任务不会补报；TraeX 尚未启用此诊断。

Claude 的后台 Agent、Bash 和 Monitor 按原生任务 ID 单独计数。主轮已有明确回答、且 CLI 没有继续等待子任务时可以完成，后台任务继续运行；旧版 pending 计数和明确的 Waiting 画面仍等待合并结果。晚到通知保留原输入归属，不成为下一轮回答。重启会重建后台状态，非持久 Monitor 按 CLI 期限到期；`/clear` 后旧日志仅用于核对已知后台任务的停止通知。Claude 在已知项目 memory 目录成功执行 Write/Edit 后，最终结果保留同轮正文和后记；普通业务文件或 Bash 命令不触发此规则。

Codex 明确报告模型容量已满、且本次没有业务工具或权限调用时，最多自动续跑两次，分别等待 30 秒和 90 秒，每次单独记录执行 attempt。停止或新输入取消尚未提交的续跑；每次提交重新检查原请求者的当前权限，重启保留等待时间和取消状态。提交或完成结果未知时不自动重放；429、额度、鉴权和普通服务端错误不属于模型容量错误。多步骤工作会等待这条已核验的自动重试链，成功后继续下游步骤；人工另行重跑的结果不会被自动认领。

Codex 显示可识别的模型迁移菜单时，Dutydeck 只选 “Use existing model”，再等待输入框；选中行或菜单不明确时留给人工处理。终端采集 socket 支持较长或非 ASCII 的临时目录路径。

Kiro 3.x 未验证：Kiro 3.0.0 发布说明称 Kiro CLI 已改为单个独立的 `kiro-cli` 二进制（[CLI changelog](https://kiro.dev/changelog/cli/)），没有说明是否仍提供 `kiro-cli-chat`。内置 Kiro ACP 只在找到 `kiro-cli-chat` 时登记，终端模式（`kiro-cli chat`）不受影响。

不要在 Dutydeck 里打开 Claude 的 `CLAUDE_CODE_RETRY_WATCHDOG`：它等额度重置时没有输出、进程 CPU 也不活跃，会被终端任务的空闲超时（Agent 的 `timeout`，默认 600 秒）当作卡死结束。

### 终端模式 Agent 与飞书审批

- Claude Code / Seed / Relay 的终端模式支持飞书审批，`ask` 和 `approve-reads` 都可用，靠 PermissionRequest hook 实现。
- 其它终端模式 CLI 只能用 `full-trust`。已有 `ask` / `approve-reads` 机器人切换默认 Agent 时，保存会拒绝不支持审批的 Agent，保留原 Agent 与权限；不会自动提升权限。历史不兼容配置在会话启动时仍会报错，两条修法是：`dutydeck settings bot set <appId> permissionMode=full-trust fullTrustConfirmed=true`，或换成 ACP / Claude 终端模式 Agent。
- 飞书会话里的 Claude 终端模式固定用 `default` 权限模式启动，本机 `~/.claude` 里设的 `auto` 等默认模式不生效。注意下面[已知限制](troubleshooting.md#known-limits)里的 allow 规则。
- Web 发起的 Claude 终端会话选 `ask` 或 `approve-reads` 时不改 Claude 的权限模式，沿用本机 Claude 的默认模式：默认是 `auto` 时，写文件和执行命令可能不经审批直接执行。需要审批时出现的是终端里的原生确认，不走 Dutydeck 审批卡；要逐项确认，在终端里按 Shift+Tab 切到需确认的模式，或把本机 Claude 的默认权限模式改掉。

---

## 2. 权限模式 (Permission Posture)

机器人（飞书）可用 `ask`、`approve-reads`、`full-trust`。`deny-all` 不能用于飞书机器人，只能用在 Agent 配置 / Web 会话上。

| 权限模式 | 行为 | 适用 |
|---|---|---|
| `ask` | 写文件、执行命令等特权操作挂起，在飞书 / Web 推送审批。**新建机器人的默认值**，前提是所选 Agent 支持飞书审批（见上） | 日常开发 |
| `approve-reads` | 自动放行读取和搜索，写操作和命令执行需审批；访问网络不算读操作。支持 ACP 和 Claude 终端模式 | 代码审查、问题排查 |
| `deny-all` | 自动拒绝一切特权操作。不能用于飞书机器人 | 只读探索 |
| `full-trust` | 跳过所有确认，直接放行 | 隔离沙箱或无人值守流水线。所选 Agent 不支持飞书审批时，机器人只能用它，并需要确认 |

Codex ACP 的非完全信任会话在每轮原生请求（包括恢复后）使用 `untrusted` 审批策略、用户审查和只读沙箱，写入或提权命令先交给 Dutydeck 审批；不会使用 Codex ACP 的自动审查。Codex 原生策略仍可直接放行其判定安全的读取，因此不保证每个只读动作都产生审批请求；`approve-reads` 也会放行执行端明确声明的读取和搜索。`full-trust` 明确使用原生完全访问策略。上述设置只作用于该子进程，不修改全局 Codex 配置。

默认值按入口略有不同：`lark create` 默认 `ask`，所选 Agent 不支持审批时必须加 `--full-trust`；Web 向导里，所选 Agent 支持审批则默认 `ask`，否则默认 `full-trust`。

飞书邮箱准入与身份查询遇到已确认的账号无效、跨应用或不可见错误时，同一客户端最多缓存失败 60 秒，修复权限后可能需等待这段时间再试。机器人配置刷新或凭据更换会清除缓存；成功身份、限流、服务端错误、网络错误和超时不缓存，撤销权限仍会在后续查询时检查。

### 按工作区记住的审批 <a id="workspace-approval-rules"></a>

飞书审批卡上的「本工作区允许此类命令」把命令存成工作区规则（SQLite 表 `workspace_approval_rules`，记录机器人、创建人和创建时间），服务重启后仍生效。这张表随数据库 schema 升级加入；升级后旧版程序会拒绝打开这个数据库，回滚只能恢复部署前的数据库备份。不使用模型判断，只做确定性的命令文字匹配：

- **生效范围**：只作用于飞书来源、非 `full-trust` 会话里由飞书用户亲自发起的轮次，且只在本来会弹审批卡的请求上生效。Web、定时、自动化和 CI/PR 触发的轮次照常弹卡；Web 审批卡没有这个按钮。
- **机器人与工作区**：规则只对建规则的那个机器人生效，不跨机器人共享。工作区是这条命令的执行目录（Agent 报告、审批卡「目录」一行显示的那个目录）的真实路径（realpath）；之后的命令也按它自己的执行目录匹配，必须与规则的工作区是同一个目录，子目录、上级目录和别的目录都不算。Agent 没报执行目录、报的是相对路径或目录不存在时，不出现按钮，也不按规则放行。Git worktree 与主检出是不同的工作区，规则不互通。家目录和文件系统根 `/` 不能建规则，执行目录是这两处时不出现按钮。
- **哪些命令能建规则**：只认执行端交来的字符串原文命令；被脱敏、截断的，数组形式的（如 Codex 的命令数组）都不给按钮。只有下面这些命令能建规则，规则就是左边的命令词，其余命令（包括 `pnpm install`、`npm init`、`npm config`、`git stash`、`git branch`、`pnpm exec`、各种 shell 与解释器）一律不能：

  | 规则 | 后面还能带的参数 |
  |---|---|
  | `git status`、`git diff`、`git log`、`git show` | 只读的展示选项（如 `--short`、`--stat`、`--name-only`、`--cached`、`--oneline`、`-<数字>`）和路径/版本；`--output`、`--ext-diff`、`--textconv`、`--no-index` 等不行 |
  | `pnpm test`、`npm test`、`yarn test`、`pnpm run <脚本>`、`npm run <脚本>` | 不带任何选项，只能带位置参数（如测试文件） |
  | `cargo test`、`cargo build`、`cargo check` | `--release`、`--workspace`、`-p`、`--features`、`--locked` 等；`--config`、`--manifest-path`、`--target-dir`、`--` 不行 |
  | `go test`、`go build`、`go vet` | `-v`、`-race`、`-count=<数字>`、`-run=<名字>` 等；包只能写 `.`、`./...` 这类相对路径；`-exec`、`-o`、`-ldflags` 等不行 |
  | `make <目标>` | 不带任何参数 |
  | `pytest` | `-q`、`-v`、`-x`、`-s`、`-k`、`--lf`、`--ff` 和测试路径；`-p`、`-c`、`--basetemp` 等不行 |

  位置参数不能以 `-` 开头、不能含 `=`、不能是绝对路径、不能含 `..` 路径段。`pnpm lint` 这类脚本简写不收（脚本不存在时 pnpm 会改为执行同名程序），用 `pnpm run lint`。
- **怎样算覆盖**：命令的每一段都按上表重新判断，判断出的规则在库里才算覆盖：`pnpm test` 覆盖 `pnpm test src/a.test.ts`，不覆盖 `pnpm test --filter x` 和 `pnpm testx`；库里已有、但不在上表里的旧规则不生效。命令里出现环境变量赋值前缀、`$(`、反引号、`<(`、任何重定向、管道、单个 `&`、换行、heredoc、引号、括号或花括号时一律弹卡；复合命令只按 `&&` 和 `;` 拆，每段都要被规则覆盖，例如 `pnpm test && curl x` 照常弹卡。
- **优先级**：插件 `permission.request` hook 的允许或拒绝、Agent 自身的拒绝规则先于本规则。每次匹配前都重跑高危正则，命中的命令永远弹卡；自动允许前还会检查发起人此刻仍有高危执行权限。规则不会放宽未授权发送人的高危拦截。
- **谁能建**：规则对整个机器人生效，所以按机器人级身份判断，不看卡片所在群的群级角色。接入群管理的机器人只认机器人级管理员（不限定群的 admin 角色）；未接入群管理的机器人只认非空访问白名单里的人。点的人还要能批准这条请求。
- **记录**：自动允许的审批记录写明命中的规则；进度卡上的标注写明来源是工作区规则还是「本会话允许」。
- **风险**：规则只看命令文字，不看命令实际执行什么。允许 `pnpm test` 后，Agent 改了 package.json 里的脚本（或 Makefile、conftest.py、`.cargo/config.toml`、`.git/config` 这类仓库内配置），就能借这条命令执行任意代码。只给你信得过其脚本内容的仓库建规则。
- **查看与撤销**：Web「设置 → Agent → 按工作区允许的命令」或 `dutydeck settings approval-rules list [--app <机器人>] [--workspace <目录>] / remove <规则 ID>`（安装管理员）。撤销立即生效，不留缓存。

---

## 3. 核心环境变量一览

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `DUTYDECK_HOST` | `127.0.0.1` | 监听 IP（局域网访问设为 `0.0.0.0`） |
| `DUTYDECK_PORT` | `4310` | Web 与 API 端口 |
| `DUTYDECK_AUTH` | `true` | 非本机访问是否要求认证（填 `false` 关闭；在非回环地址关闭认证会拒绝启动，除非加 `--unsafe-no-auth`） |
| `DUTYDECK_DEFAULT_CWD` | 启动路径 | 默认工作区绝对路径 |
| `DUTYDECK_DATABASE_URL` | `<cwd>/.dutydeck/dutydeck.db` | SQLite 数据库文件路径 |
| `DUTYDECK_AGENTS_JSON` | `[]` | 自定义 Agent 注册列表 |
| `DUTYDECK_CLEANUP_INTERVAL_MS` | `300000` | 周期清理间隔，整数毫秒，范围 1–2147483647 |
| `DUTYDECK_DRIVER_IDLE_TIMEOUT_MS` | `21600000` | 空闲终端释放阈值，非负毫秒；`0` 禁用，不受周期定时器的 32 位上限限制；仍有原生后台任务的会话不释放 |
| `DUTYDECK_USAGE_PRICING_JSON` | 内置价格表 | 整表覆盖用量估算的单价 |
| `DUTYDECK_USAGE_PRICING_EXTRA_JSON` | 不设 | 在价格表上按型号叠加单价，格式 `{"version"?: "...", "models": [{"match": "...", "inputPerMTok": ..., "cachedInputPerMTok": ..., "outputPerMTok": ...}]}`，条目可带可选的 `provider`；基础表里型号名和 `provider` 都相同（不分大小写）的条目被替换，其他 provider 的同名条目保留，同一型号和 `provider` 不能重复写，不允许 `default`。设置后这些型号的花费开始计入月度上限，已设上限的实例可能比以前更早被拦；写错时服务起不来，`dutydeck doctor` 会报 `usage.pricing` 失败并点名变量 |
| `DUTYDECK_DEPLOY_WINDOW` | 不限 | `dutydeck deploy` 允许的时段，如 `10:00-11:00,16:00-17:00`（Asia/Shanghai） |
| `LARK_APP_ID` | - | 仅 `dutydeck lark send` 等命令行发卡片的备用来源 |
| `LARK_APP_SECRET` | - | 同上。机器人用 `dutydeck setup` 配置，Secret 存在机器人配置里，不需要它 |

CI 相关的令牌和 webhook 密钥**不再是环境变量**，见[插件](plugins.md)。
