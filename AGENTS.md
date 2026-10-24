# Dutydeck 开发与运维约束

## 代码入口

| 改动领域 | 入口与职责 |
|---|---|
| 服务与命令行 | `apps/server/src/cli-program.ts` 定义命令；`cli.ts` 处理调用；`service.ts` 组装服务；`daemon/` 管重启、部署和实例寻址 |
| 飞书与插件宿主 | `apps/server/src/lark/` 管消息、卡片和机器人；`apps/server/src/plugins/` 管插件加载、绑定和工具 |
| Web 工作台 | `apps/web/src/`；API 客户端在 `api.ts`，实时流在 `sse.ts`、`useSessionStream.ts` |
| 执行与恢复 | `packages/agent-runtime/`（包名 `@dutydeck/runtime`）管任务调度、执行账本、权限和恢复 |
| Agent 与终端 | `packages/acp-client/` 管 ACP/ACPX；`cli-adapters/` 管 CLI 差异；`pty-driver/` 管终端驱动；`session-backends/` 管 tmux/Herdr |
| 契约与持久化 | `packages/shared/` 管跨端类型与校验；`config/` 管环境配置与 Agent 发现；`storage/` 管 SQLite、仓储和迁移；`secret-provider/` 管密钥 |
| 插件交付 | `builtin-plugins/` 随包发布；`plugins/` 是需安装的仓库自带插件；`examples/plugins/` 是示例；`packages/plugin-sdk/` 是公开作者接口 |

项目是通用产品，不写公司或个人环境的定制逻辑；新增平台专用集成放插件。修改对外插件接口时保持 SDK 可独立安装，不引入 server 或私有 shared 包依赖。

## 工作目录与本地运行

- 主检出是部署源，不在里面切分支。多轮功能或修复用独立 worktree：`git worktree add ../dutydeck-<主题>-<日期> -b <type>/<主题>-<日期>`；不要把主检出的 `.env` 复制进去。
- Node 要满足根 `package.json` 的 `engines`，pnpm 用 `packageManager` 指定版本。新 worktree 执行 `pnpm install --frozen-lockfile`，再 `pnpm build:packages`；共享包的类型声明与普通运行入口依赖 `dist`，根 Vitest 则通过 alias 读取源码。
- 本机仓库根 `.env` 指向线上 runtime，CLI 会读取实际 shell cwd 的 `.env`。`--cwd` 只改 Agent 默认目录；只覆盖数据库和端口仍不能隔离 daemon 管理命令，它们可能通过 `~/.dutydeck/last-daemon-dir` 找到已有实例。
- 手动调试用临时数据目录、空闲端口和前台根命令。以下从检出根执行，`14310` 先确认空闲；退出用该前台进程的 Ctrl-C，不用无目标的 `dutydeck stop/restart`：

```sh
dutydeck_scratch=$(mktemp -d)
DUTYDECK_DATABASE_URL="$dutydeck_scratch/dutydeck.db" \
DUTYDECK_DEFAULT_CWD="$dutydeck_scratch" \
DUTYDECK_DAEMON_DIR="$dutydeck_scratch/.dutydeck/daemon" \
pnpm exec tsx apps/server/src/cli.ts --local-only --port 14310 --no-lark-listen
```

- Web 热更新另起 `DUTYDECK_API_URL=http://127.0.0.1:14310 pnpm dev:web --port <空闲前端端口>`。Vite 默认代理到 `4310`，只换后端端口会把页面请求发到错误实例。
- 自动化复用 `tests/e2e/acceptance/harness.ts` 的临时数据库、动态端口、子进程私有 HOME 和独立 tmux socket；只清理本轮资源，不对宿主默认 tmux 执行 `kill-server`。

## 改动时保持的契约

- **设置同步**：Dashboard 可保存的服务端设置须有对应 CLI。修改设置项、范围或保存接口时，同步 `apps/server/src/settings-cli.ts` 的命令、键表及 `settings-cli.test.ts`；新增机器人设置还要更新 `scripts/e2e-bot-settings.mts` 的显式矩阵。`satisfies` 检查键覆盖，不能替代枚举、清空语义和新面板的核对；浏览器本地偏好不属于服务端设置。
- **ACPX 持久化**：`session_options` 递归要求小写 `snake_case`；群工具用 `dutydeck_group_tools_url`、`dutydeck_group_tools_token`。供应商的大写环境变量经 `prepareAcpxAgentLaunch` 的 launcher 传递，不直接塞进持久化 `env`。修改此链路须用真实 `AcpxAdapter` 和持久化 session key 回归，参照 `packages/acp-client/src/acpx.test.ts`。
- **子进程环境**：复用 `packages/shared/runtime/child-environment.mjs` 清洗继承环境，再合并显式 Agent 配置与当前会话凭证；不要修改 daemon 的全局 `process.env` 来切账号或会话。改动同时检查 ACP、PTY 和恢复路径的 `child-environment.test.ts`。
- **任务与恢复**：沿用执行账本和原生回执区分未提交、执行中与结果未知。超时、断线或重启不能当作“没有执行”自动重发；改生命周期时覆盖停止、迟到回执和恢复后的轮次归属，不能仅凭终端出现文本判完成。入口在 `packages/agent-runtime/`，跨层回归在 `tests/`。
- **数据库升级**：结构变化同步 `packages/storage/src/schema.ts` 与 `migrations.ts`，追加迁移版本；测试已有数据升级、重复打开和外键完整性。旧程序会拒绝更高 schema，不能把切回旧代码当作数据库回滚。
- **打包入口**：新增共享包、子路径导出或运行时资源时，核对包 `exports/files`、根与 Web 的 Vitest alias、`apps/server/scripts/build.mjs` 的打包映射和资源复制；源码测试通过不能证明发布产物可运行。
- 用户可见的行为、命令或配置变化，同一个改动里更新 `README.md` 和 `README.en.md`；`CLAUDE.md` 只引用本文件，项目执行规则集中维护在这里。

## 验证

代码改动均须通过 `pnpm typecheck` 和受影响测试的 `pnpm exec vitest run <测试路径>`。从仓库根运行，Node 与 Web/jsdom 由根配置分流；需要限定时用 `--project=node` 或 `--project=web`。

| 额外影响范围 | 追加检查 |
|---|---|
| 会话生命周期、ACP/PTY、终端连接 | `pnpm build` 后 `pnpm smoke --port 0`；smoke 直接读构建产物，不自动构建 |
| Web 主流程、跨端状态流转 | `pnpm e2e`（构建并跑 core） |
| 飞书卡片、机器人接入与设置 | 对应 `apps/server/src/lark/` 测试，加 `pnpm e2e:full`（core + 合成飞书 extended）；普通 smoke 不覆盖飞书投递与回调 |
| 发布、launcher 或插件 SDK/资源 | `pnpm build`，再跑对应打包/安装测试，验证脱离源码目录后仍能使用 |

E2E 需要 `git`、`tmux` 和 Playwright Chromium；命令、场景及产物位置见 [tests/e2e/README.md](tests/e2e/README.md)。默认使用假 CLI/合成飞书，不能据此宣称真实模型、飞书发送或卡片点击已验证。纯文档改动核对命令、路径、全文一致性及 `git diff --check`，不要求跑无关产品测试。

## 运维

- **先定位实例**：`systemctl --user list-units 'dutydeck*' --all`；用 `systemctl --user show <unit> --property=WorkingDirectory,ExecStart,KillMode,LoadState` 核对目标，必要时查看 unit 配置中的数据库和端口。默认 `dutydeck.service` 可能已 mask；不假定只有一个实例或所有实例共享发布目录。不要输出整份 `.env` 或含密钥的环境配置。
- **诊断**：在核实目标目录与环境后用 `dutydeck status`、`dutydeck doctor`，日志看 `journalctl --user -u <unit>`。`status` 没有 `--unit`，不能靠这个参数选择实例。CLI 不在 PATH 时，用目标 unit `ExecStart` 中的 node 和 CLI 入口。
- **重启**：用 `dutydeck restart --unit <unit>`，不用 `systemctl --user restart`。仅当当前 `KillMode=process` 时，它才保留已验证可恢复、无权限等待或未授权高危门禁的 `full-trust` tmux 任务；其余任务等待结束，当前 Agent 自己那一轮自动排除。部署仍等待所有正在执行的任务及原生后台任务，不沿用重启的保留策略。
- **部署**：改动合入主检出并提交后，在主检出跑 `pnpm install --frozen-lockfile && pnpm build`，再 `dutydeck deploy --source <主检出> --unit <unit>`。按 unit 实际引用的 `<releases>/current` 分组，同组所有目标依次部署；只更新部分会让其余 unit 在下次重启时换版本，同一发布根的部署与清理不能并发。
- **部署验收**：每个 unit 都检查 `<releases>/../deployments/<时间>-<sha>/manifest.json` 的 `status=deployed`，并核对运行状态与启动日志；`staged` 只表示版本已准备。健康检查失败只在 schema 兼容时自动回滚代码，不恢复旧数据库快照。
- **需用户授权的操作**：`--force`（不等任务结束）、`deploy --now`（越过部署窗口）；修改 systemd unit、`.env`、机器人凭据或权限模式；删除或覆盖 `.dutydeck/` 下的数据库、发布目录和部署记录。清理旧版本先跑 `dutydeck deploy prune --unit <unit> --dry-run`，核对范围再执行；它也会删除旧部署记录中的数据库备份。
