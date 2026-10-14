# Dutydeck 开发与运维约束

## 仓库

- `apps/server`：守护进程、API、飞书接入和 `dutydeck` CLI（命令定义在 `src/cli-program.ts`）；`apps/web`：Web 工作台；`packages/*`：共享包；`plugins/`：内置插件；`tests/`：跨包集成测试与 E2E。
- 项目是通用产品，不写公司或个人环境的定制逻辑；平台集成做成插件。
- 仓库根的 `.env` 指向线上 runtime：在仓库根起服务或执行 CLI，操作的就是线上。本地调试服务时，用临时目录的 `DUTYDECK_DATABASE_URL` 和空闲端口覆盖。
- 多轮的功能或修复在独立 worktree 里做（`git worktree add ../dutydeck-<主题>-<日期> -b <type>/<主题>-<日期>`）；主检出是部署源，不在里面切分支。

## 开发

- 完成标准：`pnpm typecheck` 和受影响文件的 `pnpm vitest run <路径>` 通过；改到会话生命周期、终端驱动、飞书卡片或 Web 主流程时，再跑 `pnpm smoke` 或 `pnpm e2e`。
- 用户可见的行为、命令或配置变化，同一个改动里更新 `README.md` 和 `README.en.md`。
- ACPX 会持久化 `session_options` 并递归校验键名，持久化键只能是 `snake_case`；`UPPER_SNAKE_CASE` 环境变量名写进 `acpx.session_options.env` 会触发 `Persisted key policy violation`。群聊工具变量用 `dutydeck_group_tools_url` 和 `dutydeck_group_tools_token`，旧的大写名只在读取边界兼容。改 ACPX session 配置或环境变量注入时，加使用真实 `AcpxAdapter` 和持久化 session key 的回归测试，mock ACP 客户端测不到键名校验。
- Dashboard 能改的设置都要能用 `dutydeck settings` 改（`apps/server/src/settings-cli.ts`）。新增或修改 dashboard 的设置项、取值范围或保存接口时，同一个改动里更新对应命令、键表和 `settings-cli.test.ts`，新设置面板加对应命令。机器人、群配置、群协作和接话的键表用 `satisfies` 绑定了保存接口类型，漏字段会编译失败；枚举取值和新面板没有这层检查，要自己核对。

## 运维

- 线上实例：`systemctl --user list-units 'dutydeck*' --all` 列出所有 unit（通常一个 Web 实例加每个机器人一个进程，默认的 `dutydeck.service` 可能已 mask），`systemctl --user cat <unit>` 看发布目录、数据库和端口。`dutydeck` 不在 PATH 上时，用 unit `ExecStart` 里的 node 执行 `<releases>/current/dist/cli.js`。
- 排查：`dutydeck status`、`dutydeck doctor`；日志看 `journalctl --user -u <unit>`。
- 重启：用 `dutydeck restart --unit <unit>`，它会等正在执行的任务结束，并自动排除当前 Agent 会话自己那一轮；不用 `systemctl --user restart`。
- 部署：改动已在主检出提交，在主检出跑 `pnpm install --frozen-lockfile && pnpm build`，再对每个 unit 依次执行 `dutydeck deploy --source <主检出> --unit <unit>`。所有 unit 共用同一个 `<releases>/current`，只部署一部分会让其余 unit 在下次重启时换版本。每个 unit 部署后确认 `<releases>/../deployments/<时间>-<sha>/manifest.json` 的 `status` 是 `deployed`，且日志里没有启动错误。
- 以下操作先征得用户同意：`--force`（不等任务结束就重启）、`deploy --now`（越过 `DUTYDECK_DEPLOY_WINDOW`）；修改 systemd unit、`.env`、机器人凭据或权限模式；删除或覆盖 `.dutydeck/` 下的数据库、发布目录和部署记录（清理旧版本先跑 `dutydeck deploy prune --unit <unit> --dry-run`）。
