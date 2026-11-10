# 插件 <a id="plugins"></a>

> [← 返回 README](../../README.md) · [全部文档](../../README.md#docs) · [English](../en/plugins.md)

插件给 Dutydeck 加命令、Agent、skills、外部触发器、hook、CI 提供方、受控结果工具和场景包。核心里没有任何平台专用代码，GitHub 和可配置代码托管 CI 的能力以及告警初筛都是插件。

## 目录结构

```text
my-plugin/
├── .dutydeck-plugin/plugin.json   清单（必需）
├── commands/*.md                  斜杠命令（提示词模板或只读查询映射）
├── agents/*.json                  Agent 定义（格式同 DUTYDECK_AGENTS_JSON 的一项）
├── skills/                        skills 目录
├── triggers/<id>.json             外部触发器
├── hooks/hooks.json               hook 配置
├── scenarios/*.json               场景包
└── index.mjs                      providers 入口（CI 提供方、场景包 provider、进程内 hook）
```

`plugin.json` 用严格校验，出错会报文件名和字段。字段：

| 字段 | 说明 |
|---|---|
| `name` | 必填，kebab-case，最长 64 |
| `version`、`description` | 可选 |
| `commands` / `agents` / `skills` / `triggers` | 目录，默认 `commands/`、`agents/`、`skills/`、`triggers/`；默认路径不存在就当没有 |
| `hooks` | hook 配置文件，默认 `hooks/hooks.json` |
| `providers` | ESM 入口文件，没有默认值 |
| `scenarios` | 场景包目录，默认 `scenarios/`；默认路径不存在就当没有 |
| `userConfig` | `{ <snake_case 键>: { description, sensitive? } }`，插件的配置项 |

路径必须在插件目录内；显式声明了但不存在算错误。

## 七类组件

| 组件 | 作用 | 需要信任确认 |
|---|---|---|
| commands | 默认把 `/<name>` 换成 prompt 模板，`$ARGUMENTS` 替换为参数；也可显式映射到公开只读查询，不启动 Agent。`/<插件名>:<name>` 总能用；没有重名时 `/<name>` 也可用。与内置命令同名会被拒绝；`compact`、`clear`、`init`、`review` 等 Agent 自带命令名只能用 `/<插件名>:<name>` | 否 |
| agents | 注册 Agent，先于 `DUTYDECK_AGENTS_JSON` 合并，同 id 以环境变量为准，不能替换内置 Agent。带来源标记：插件停用或卸载并重启后随之移除 | **是** |
| skills | 作为一个 skills 根目录加载 | 否 |
| triggers | 外部系统通过 HTTP 触发一次任务（见下） | 否 |
| hooks | 在任务生命周期的几个点执行你的命令（见下） | **是**（按事件分别确认，如 `hooks:task.received`） |
| providers | 入口模块导出 `register(api)`，注册 CI 提供方、场景包 provider 或进程内 hook；模块加载和注册合计最多等 15 秒，超时跳过这个插件，忽略后续注册 | **是** |
| scenarios | 场景包：群里出现某类消息时按包里写好的规则处理（见[怎么写场景包](#scenario-packs)）。包本身是 JSON，不执行代码；它引用的 provider 随 providers 一起确认 | 否 |

只读直查命令在命令文件 frontmatter 中使用 `query` 和 `argument`，对应查询须通过 SDK 显式声明 `commandOutput: 'chat'`。例如配置并授权 [fake-ticket](../../examples/plugins/fake-ticket/README.md) 后，飞书发送 `/fake-ticket:ticket-status T-1` 只返回标题和状态，不创建 Agent 会话。宿主要求可信真人入站、有效绑定及对应用户、工具、只读效果和精确资源的授权，并在投递前复核；能与机器人聊天不代表能读业务数据。只接受显式声明可向原聊天所有人公开输出的查询；私有结果应走受控导出，写动作不能映射。重复事件或重启后的未知执行不自动重放。旧提示词命令和未开放聊天输出的查询保持原行为；作者契约见 [Plugin SDK](../../packages/plugin-sdk/README.md)。

## 信任确认

agents、hooks、providers 会执行代码或命令，安装时要确认。daemon 只加载**已启用、且所有需确认能力都已确认**的插件。

- 交互终端里会列出能力并询问；非交互环境必须加 `--yes`，否则拒绝并列出要确认的能力。
- `plugin update` 时只有**新增**的能力才重新确认；同一能力下 hook 命令变了不会再问。
- npm 来源打包时不执行 prepare 等脚本（`--ignore-scripts`），避免确认前就跑插件代码。

## 作用域

`--scope` 决定插件在哪里生效：

- `global`（默认）：处处生效。
- `bot:<appId>`：只对这个机器人的会话生效；触发器的目标机器人也必须是它。Web 会话没有机器人，所以 bot 作用域的命令、skills、hooks 在 Web 里不生效。
- `workspace:<绝对路径>`：会话工作目录在该路径下才生效。触发器也检查此范围：新会话启动前检查机器人的工作目录，复用会话检查该会话的实际目录；作用域根和目标目录均解析符号链接，按真实路径比较，指向范围内的别名可用。缺少目录、解析失败或越界时不启动新会话、不派发任务。
- agents 不受作用域限制，全局合并。

## 内置插件 <a id="builtin-plugins"></a>

随 Dutydeck 发布的插件在 `builtin-plugins/`（打包后在 `dist/builtin-plugins`）。daemon 先加载它们，再加载已安装的插件。现在只有一个：`alarm`，提供告警初筛和同一告警规则的关联，群里怎么用见[群聊协作机制](lark.md)。

- 免信任确认，作用域固定为 `global`，一直启用，不能卸载。`plugin list` 里标「内置」。
- 外部插件不能和内置插件同名，安装时会被拒绝；已装的同名插件不会加载，`plugin list` 和 `doctor` 会提示。
- 外部插件里和内置场景包 id 相同的包会被跳过（插件其余部分照常加载），免得接过群里已经确认的绑定。

## CLI

```bash
dutydeck plugin install <来源> [--scope global|bot:<appId>|workspace:<路径>] [--yes] [--json]
dutydeck plugin list [--json]
dutydeck plugin validate <目录>
dutydeck plugin init <名字> [--dir <目录>]
dutydeck plugin config <插件> <键> --value <值>          # 非敏感值
printf %s "$SECRET" | dutydeck plugin config <插件> <键> --value-fd 0   # 敏感值只能这样传
dutydeck plugin trigger-token <插件>/<触发器> [--rotate]
dutydeck plugin update [名字] [--yes]       # 只准备候选包
dutydeck plugin status <名字> [--json]
dutydeck plugin activate <名字> [--json]  # 离线激活候选
dutydeck plugin rollback <名字> [--json]  # 离线恢复上一版本
dutydeck plugin enable <名字>
dutydeck plugin disable <名字>
dutydeck plugin uninstall <名字>
```

- `<来源>`：本地目录、`git+https://…`、`git@…`、`file://…`（`#ref` 固定分支、标签或提交）、`npm:包名@版本`。git 来源按提交 SHA 固定。
- `plugin update` 只准备不可变候选包；活动 Host 的 provider、hook 和技能路径始终指向原包，重启也不会自动激活候选。若候选包被修改，排空并停止服务后再次 `plugin update` 可从相同来源修复，再执行激活；活动或上一版本的损坏目录不会被原地覆盖。包内相对符号链接受支持；包外、绝对或无法解析的链接会拒绝安装和更新。内容摘要能识别不改版本号的变化；没有内容变化时不重复产生候选。多进程修改通过存储锁串行提交。启动时最多等 30 秒插件存储锁（盖过一次 `plugin activate` 的隔离验证）；锁仍被占用、`plugins.lock.json` 损坏或 `.hosts/` 租约写不进去时，daemon 照常启动，但**只加载内置插件，外部插件一个都不加载**：运行日志记一条带出错文件路径的警告，插件诊断列出原因，`dutydeck doctor` 的「插件库」项报 fail；绑定了外部插件的会话会拒绝新任务。按原因修复后重启 daemon 才会重新加载外部插件。`.hosts/` 里同一数据库的已停止或进程已退出的旧租约在下次启动时清掉；无法解析的租约保留，仍会阻止激活，需要人工处理。
- `plugin status` 区分选定包、候选、上一版本、实际加载的 Host 和切换阻塞。激活/回退使用离线检查：先在当前版本完成或取消未完成任务，并核对该插件未决动作；运行 `dutydeck stop`，systemd 托管实例用 `systemctl --user stop <unit>` 停止共用插件目录的所有实例，再执行 `plugin activate` 或 `plugin rollback`，成功后 `dutydeck start` / `systemctl --user start <unit>`。存在存活 Host、待恢复任务或该插件 unknown 操作时拒绝切换；租约会识别已退出进程，但 daemon 退出不代表 tmux 任务已完成。缺少插件依赖信息的未完成旧任务会保守阻塞，已终态历史和无关插件动作不阻塞。
- 激活会在可终止的独立 Node 进程里验证已信任 provider 的导入/注册，使用临时数据目录和最小环境；这不是恶意代码沙箱。原活动版本保留供回退，不承诺按会话运行多版 provider，也不自动回退插件私有数据。安装与启停仍需重新启动 Host；卸载同样要求没有活动消费者。
- `plugin validate` 也校验场景包（格式、模板变量、正则、参数），出错报文件和字段；`plugin validate --strict` 进一步检查宿主兼容范围、权限声明、技能引用和资源边界。`plugin inspect <目录|tarball|来源> --json` 输出能力、权限足迹和 digest；`plugin test <目录|tarball|来源>` 在隔离 Host fixture 中验证注册结果。`install`、`update` 不因场景包的问题失败，但会列出不会加载的包和原因。
- 数据放在数据库所在目录的 `plugins/` 下：`plugins.lock.json`（来源、固定版本、作用域、已确认能力）、`.artifacts/<名字>/<内容摘要>/`（不可变安装副本）、`.hosts/`（Host 代际及数据库记录；旧 `<名字>/` 布局保留兼容）、`.data/<名字>/`（插件自己的可写目录）。`.trigger-tokens.json` 和 `.config.json` 权限 0600；敏感配置存在本机密钥存储里。

## 外部触发器

触发器让外部系统（监控、CI、脚本）发一个 HTTP 请求，在指定机器人的指定群里开一个任务。仓库里有可运行的示例 `examples/plugins/hello`。

`triggers/<id>.json`：

```json
{
  "auth": { "type": "token", "header": "x-dutydeck-token" },
  "target": { "botAppId": "{{config.bot_app_id}}", "chatId": "{{config.chat_id}}", "session": "new" },
  "prompt": "外部系统发来一条 ping，请简短回复并复述其中的消息：\n{{payload.message}}",
  "dedupeKey": "{{payload.id}}",
  "maxConcurrent": 2
}
```

- 地址：`POST /api/plugins/<插件>/triggers/<id>`，免 Web 登录，靠触发器自己的令牌或签名鉴权。
- 鉴权：`token`（请求头里带令牌，可带 `Bearer ` 前缀）或 `hmac-sha256`。HMAC 触发器还必须带时间戳头（默认 `x-dutydeck-timestamp`，Unix 秒）、一次性 nonce 头（默认 `x-dutydeck-nonce`）和签名头；签名是 `HMAC-SHA256(secret, timestamp + "\\n" + nonce + "\\n" + SHA256(rawBody))`，十六进制，可带 `sha256=` 前缀。时间戳默认允许前后 300 秒，nonce 只能使用一次。令牌用 `dutydeck plugin trigger-token <插件>/<id>` 查看或 `--rotate` 轮换，轮换立即生效。并发创建或轮换不同触发器的令牌时，各次成功操作都会保留。
- `target` 的值可以写 `{{config.<键>}}`，引用插件配置；配置没填齐时触发器不可用。`session` 为 `new`（每次新会话）或 `reuse`。
- 返回码：`202 {runId, sessionId, taskId, statusUrl}` 已接受；`200 {duplicate:true, runId}` 重复事件；`400` 请求体不是 JSON；`401` 令牌、签名、时间戳无效或 nonce 已使用；`404` 触发器不存在或插件未启用；`413` 请求体超过 1 MiB；`429` 达到 `maxConcurrent`；`502` 投递失败（同时撤销去重记录，可重试）。可用相同鉴权请求 `GET .../runs/<runId>` 查询状态，并对仍在队列、尚未提交给 Agent 的运行 `POST .../cancel`；HMAC 查询和取消也要为零请求体生成新 nonce 和签名，nonce 只用一次；已开始执行的运行保持 running，取消不会撤回已发出的外部副作用。
- 也可使用统一任务入口 `POST /api/plugin-triggers/v1/runs?plugin=<插件>&triggerId=<触发器>`，状态和取消地址分别是 `/api/plugin-triggers/v1/runs/<runId>` 与 `/cancel`（查询参数带回 `plugin`、`triggerId`）。请求头 `Idempotency-Key` 与清单中的 `idempotencyKey` 模板都会参与 24 小时去重；`dryRun=true` 只校验鉴权和模板，不启动任务。
- 去重 24 小时，重启后仍有效；去重键是 `dedupeKey` 渲染结果，没写就用整个请求体。`maxConcurrent` 默认 4，范围 1 到 32。活跃任务和仍占并发名额的工作项（包括首次等确认）超过 24 小时仍保留运行记录，重启后可查询并继续占位；已结束的过期记录会清除。去重到期不等于取消旧运行，同一事件在新窗口可按并发规则产生新运行。
- 模板里 `{{payload.a.b}}` 取请求体字段，`{{payload}}` 取整个请求体。进入 prompt 的每个取值都被当作**不可信数据**包裹（带随机边界，单个取值最多 2 万字符）。模板读不到鉴权头、`authorization` 和 `cookie`。
- 任务结果以文本发回目标群，最多 8000 字符。
- **启动工作项模板**：把 `prompt` 换成 `workTemplate`（两者只能写一个），触发时按已保存的工作项模板开一个工作项，而不是发一段提示词：

  ```json
  "workTemplate": { "session": "{{config.template_session}}", "id": "{{config.template_id}}", "version": 2, "goal": "处理告警：{{payload.title}}" }
  ```

  `session` 是保存模板的会话编号，`id` 与 `version` 见 `GET /api/sessions/<会话>/work-items` 返回的 `templates`（会话里的 Agent 也可用 `dutydeck work templates --turn "$TURN"`）；三者都可写 `{{config.<键>}}`，`version` 可写数字或解析为正整数的配置。模板只能在保存它的会话里启动，这个会话必须是 `target` 那个机器人在 `target.chatId` 里的飞书会话；`target.session` 不使用。工作项以安装者身份启动，是否要人工确认沿用模板启动的规则（飞书群里须在群内确认后才执行），结果按工作项自己的交付发回该会话的原话题。`goal` 和 `prompt` 一样渲染，外部取值同样包成不可信数据。
  - 接受时返回 `202 {runId, sessionId, workItemId, awaitingConfirmation, statusUrl}`。模板或版本不存在、模板所在会话不存在或不属于目标群、作用域不允许、会话不可运行或交付位置无法确认时返回 `422 PLUGIN_TRIGGER_TEMPLATE_UNAVAILABLE`，`cause` 是原因代码（如 `WORK_TEMPLATE_NOT_FOUND`），不创建工作项，同时撤销去重记录，修好配置后可用同一事件重发。
  - 运行状态跟随工作项：等确认为 `queued`，执行中或等待人工为 `running`，完成 `succeeded`，失败 `failed`，取消 `cancelled`，结果待核对为 `unknown`。等确认、执行中、等待人工和结果待核对的工作项都占 `maxConcurrent` 名额。`cancel` 只取消首次确认前、还没有任何步骤执行过的工作项；已开始的（包括正等人确认计划修订的）保持 `running`，到工作项里停止；失败但带待确认修订的工作项也按 `running` 计、继续占名额，失败后才收到修订的会在下一次触发时重新占回（限触发后 24 小时内的运行记录）。触发器启动的工作项不归属模板会话里此刻正在运行的那一轮，不沿用它的风险策略，也不计入它的用量。

```bash
dutydeck plugin install examples/plugins/hello --yes
dutydeck plugin config hello bot_app_id --value cli_xxx
dutydeck plugin config hello chat_id --value oc_xxx
dutydeck plugin trigger-token hello/ping        # 记下令牌
dutydeck restart
curl -X POST http://127.0.0.1:4310/api/plugins/hello/triggers/ping \
  -H 'content-type: application/json' -H "x-dutydeck-token: $TOKEN" \
  -d '{"id":"1","message":"hi"}'
```

## 业务查询与动作工具

可信 provider 用公开 `@dutydeck/plugin-sdk` 的 `api.registerQuery` / `api.registerAction` 注册工具。必须声明可序列化的 JSON Schema、兼容版本和资源选择器；输入只支持 object、array、string、number、integer、boolean 及 SDK 列出的边界字段，object 必须关闭额外字段。查询返回模型可见 JSON；动作返回短回执。私有文件继续走下节受控结果接口。

安装和启用插件后，还要配置 Bot/群或精确工作区绑定，并由安装管理员单独授予工具权限。绑定业务配置不能扩大授权。授权按 `toolId`、`bindingId`、可信 actor、读写效果、资源及 invoke/reconcile 操作匹配，默认拒绝；资源 `*` 显式允许该工具的所有资源。示例授权：

```bash
dutydeck tool-grant set --database /path/to/dutydeck.db --json '{"id":"ticket-close","toolId":"fake-ticket/close","bindingId":"<绑定ID>","actor":{"kind":"installation_owner","id":"installation_owner"},"effects":["write"],"resources":["ticket:T-1"],"operations":["invoke","reconcile"]}'
dutydeck tool-grant list --database /path/to/dutydeck.db
dutydeck tool-grant revoke ticket-close --database /path/to/dutydeck.db
```

飞书 actor 使用 `{"kind":"channel","appId":"cli_xxx","id":"ou_xxx"}`。Web 当前任务使用已认证的安装者；宿主从持久化任务取得 actor/session/task/attempt，不接受调用参数或 MCP `_meta` 覆盖。`cwd` 是实际工作目录，`workspaceRoot` 是绑定选择使用的原项目目录；Web 不伪造 chatId。

```bash
# 当前任务内，沿用宿主给出的完整命令前缀与 TURN
dutydeck tool list --turn "$TURN"
dutydeck tool list --summary --turn "$TURN"
dutydeck tool describe fake-ticket/get --turn "$TURN"
# 插件声明以下 guide 后可读取
dutydeck tool manual fake-ticket/get guide --turn "$TURN"
dutydeck tool call fake-ticket/get --json '{"ticket":"T-1"}' --call-id read-1 --turn "$TURN"
dutydeck tool call fake-ticket/close --json '{"ticket":"T-1"}' --call-id close-1 --turn "$TURN"
dutydeck tool reconcile <actionId> --turn "$TURN"
```

`list` 保留完整参数定义；`--summary` 只列有权工具的摘要，`describe` 按工具读取详情，`manual` 按逻辑 ID 读取可选参考资料。每次读取都重新校验本轮身份、绑定和授权。插件需在清单显式声明手册，例如已注册 `get` 工具：

```json
{"toolManuals":{"get":{"guide":{"description":"可选参考资料","path":"manuals/guide.md","maxBytes":16384}}}}
```

手册为包内 UTF-8 文本，`maxBytes` 为 1–65536，默认 16384；它不替代必需 SOP 或 `skillResources`。

HTTP 提供 `/api/plugin-tools/list`、`/summary`、`/describe`、`/manual`、`/call`、`/reconcile`；MCP Streamable HTTP 工具端点为 `/api/plugin-tools/mcp`，支持 initialize、ping、tools/list、tools/call，未提供资源或采样能力。两者都要求会话 relay Bearer 和 `x-dutydeck-tool-turn`。MCP 工具名为 `插件__工具`，参数为 `{input,callId}`；核对工具为 `dutydeck_reconcile`。JSON-RPC id 只关联请求，不作为幂等键。管理 `/api/plugins/tool-grants` 只接受安装管理员权限。

动作 ID 由宿主按工具、会话、任务和稳定 callId 生成；同次重试保留参数和 callId。重复执行返回账本状态，超时或失去响应记为 unknown，不自动重新执行。核对同时检查原操作者的当前 invoke 权限与当前核对人的 reconcile 权限；绑定修订或 handler 版本不兼容时拒绝核对并保留未知状态。工具执行须遵守 AbortSignal，并在外部系统用 actionId 去重；宿主超时不能保证外部副作用已取消。插件代码属于受信代码，不提供进程沙箱。

可打包示例与假工单服务协议见 [fake-ticket](../../examples/plugins/fake-ticket/README.md)。

## 插件绑定、技能与作者 SDK

安装决定允许加载哪些代码和作用域；绑定决定每次调用使用哪个群或项目的配置。控制中心「插件与技能」提供绑定编辑、停用和已保存配置解释，命令行走相同校验：

```bash
dutydeck settings plugin-binding list
dutydeck settings plugin-binding set team-faq --app cli_bot --chat oc_a 'config={"docs_dir":"/srv/runbooks/a"}'
dutydeck settings plugin-binding set team-faq --app cli_bot --chat oc_b 'config={"docs_dir":"/srv/runbooks/b"}'
dutydeck settings plugin-binding set team-faq --workspace /srv/project 'config={"docs_dir":"/srv/runbooks/project"}'
dutydeck settings plugin-binding explain team-faq --app cli_bot --chat oc_a
dutydeck settings plugin-binding set team-faq --app cli_bot --chat oc_a enabled=false --expected-revision 1
```

群绑定完整覆盖 Bot 默认绑定，未填字段只取清单默认值。Web 按规范化后的项目根目录精确匹配；CLI 编辑时由目标服务器解析工作区别名（包括符号链接），并保留已有配置和版本；停用绑定也可重新启用。托管 worktree 使用可信会话的原项目目录。带 Bot/群的请求不回退到工作区绑定。绑定更新使用版本比较，下一次受控调用重新解析；旧调用的秘密访问器发现版本变化或停用会拒绝。新管理接口只接受安装管理员，任务凭据不能改绑定。

清单可声明 `apiVersion: 1`（不支持的版本拒绝加载）、`host`/`dependencies`、`permissions`（`secrets/network/filesystem/effects` 只做可审计声明）和声明式 Web `slots`（`settings`、`command_palette`、`task_panel`、`result_card`，元素只能是文本、状态、表格或指向已注册命令/工具的动作）。绑定管理页会渲染这些元素作为受限预览；动作在缺少任务上下文时保持禁用，不执行插件自带脚本或任意 URL。`bindingConfig` 支持 `string`、`number`、`integer`、`boolean`、`string_list`、`secret`，以及适用的 `required/default/enum/min/max`。普通配置与秘密引用分开保存，值、默认值和枚举类型不匹配时拒绝。秘密只能通过本地隐藏输入或文件描述符创建：

```bash
dutydeck settings plugin-binding secret-set my-plugin group-a --value-fd 0
# 上一条从 stdin 读取，返回引用 plugin.my-plugin.group-a；不把明文写进命令参数。
dutydeck settings plugin-binding set my-plugin --app cli_bot --chat oc_a 'secrets={"token":"plugin.my-plugin.group-a"}'
```

秘密引用按插件隔离；轮换时新建引用并更新绑定版本，不覆盖旧引用。provider 的 `context` / `match` 和业务工具在调用时取得宿主注入的 `bindingId`、`revision`、只读 `config` 与 `getSecret(key)`；读取未声明的秘密键会拒绝。解释与任务快照不保存秘密值。旧 `api.config` 仍是安装级字符串配置，旧 hooks、Agent 和 CI 的安装级行为保留，面板标明 Agent/CI 的全局兼容能力。

技能使用稳定引用 `包名/技能目录名`，`SKILL.md` 支持标准 YAML 多行说明。旧 `/skills 名字` 遇到同名歧义会要求选择具体引用或路径。插件、Bot、群绑定和工作区作用域同时限制目录发现与实际读取；停用后不能借显式引用继续读取。清单 `requiredSkills` 与绑定 `skills` 是每轮共同 SOP；场景的 `skills` 只在该场景实际被选中后冻结，支持 model 判定/回复/执行及 direct 机器人消息。未选场景的 SOP 不混入当前任务。目录扫描会隔离坏条目并显示诊断和未完整标记；选择正常技能不受无关坏项阻断。显式选中或必需技能出错仍拒绝执行，目录未完整时不会擅自消解名称歧义。

宿主把必需 SOP 与清单 `skillResources` 声明的有限文本直接加入提示词，readonly 后端也能收到；单个技能最多 128 KiB，单份引用最多 64 KiB（默认 16 KiB），合计最多 512 KiB，拒绝包外链接与非文本资源。最终内容在 `task.beforeRun` 后检查并冻结：旧 hook 替换的技能标为 `replaced`；删掉必需 SOP 会明确拒收。旧记录缺少状态时显示「未核实」，不能证明最终投递。正文与引用快照不承诺冻结脚本、provider 进程或所有可执行代码。

插件安装只解包产物，不运行 npm install。作者若运行时 import `definePlugin` 或第三方库，须在发布前将依赖 bundle 到 provider 入口（例如 `esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.mjs`），并把 `dist` 和 `.dutydeck-plugin` 纳入 npm files；不要把 `@dutydeck/plugin-sdk` 标记为 external。只使用 `import type` 时无需 SDK 运行依赖。验收另覆盖独立安装 SDK、bundle、打包、删除作者目录，再由真实 Host 加载和调用。

作者可使用独立发布包 `@dutydeck/plugin-sdk`，其中 `definePlugin`、`PluginBindingContext`、场景、query/action、CI provider 及受控结果工具的作者类型不依赖 server 或私有 shared 包。仓库验收会将 SDK tarball 安装进空目录，用 TypeScript 编译第三方示例并实际 import。`plugins/team-faq` 是可独立 `npm pack` 的双群示例；打包包含清单、provider、场景、SOP 与引用文本，移除源目录后仍可安装运行。详见 [team-faq 用法](../../plugins/team-faq/README.md)。

### 把 Leader 指引做成插件技能 <a id="leader-guide"></a>

[Leader 模式](lark.md#leader-mode)里 Leader 按哪套规则办事，由机器人设置 `leaderSkill` 指向的技能决定。想把一套规则分发给多个机器人或团队，可以把它做成只含一个技能的插件：没有命令、Hook 或 provider，安装不需要信任确认。示例 [leader](../../examples/plugins/leader/README.md) 提供了通用的指引：开工先看什么、哪些事 Leader 自己定、哪些事上报、验收问哪几件、上报怎么写。

```bash
dutydeck plugin install ./examples/plugins/leader --scope bot:<appId> --yes
dutydeck restart
dutydeck settings bot set <appId> leaderSkill=leader-guide/leader
```

想让 Leader 每次运行都带上的引用文件，写进清单的 `skillResources`；其余引用文件在 `SKILL.md` 里写明路径，Leader 需要时自己读（要求 Leader Agent 能读技能目录）。不做成插件也行：技能目录会跳过指向目录外的软链接，放在别处的指引，`leaderSkill` 直接填 `SKILL.md`（或其所在目录）的绝对路径；这种来源不内联 `skillResources`，同目录的引用文件由 Leader 按路径自己读。授权账本和决定记录由宿主在每次运行里提供，指引里不要让 Leader 自己维护文件。

## 插件服务

同一插件服务的启动、停止、重启和自动重启按请求顺序处理，重启会先结束旧实例再启动新实例。在 POSIX 系统上，停止等待所属进程组中的 worker 一起退出；宽限期后仍未退出的会被强制结束。父进程先退出不会提前显示「已停止」。清退失败会返回错误，只有旧实例清理完成后才能再次启动。主动脱离进程组的后代不在清理范围内；Windows 仍只管理直接子进程。

## 受控插件结果

可信 `providers` 插件可通过 `api.registerResultTool({ name, description, inputSchema, execute })` 注册导出工具：`inputSchema.parse(input)` 校验参数，`execute(input, { invocationId, requester, signal })` 返回 `Promise<{ files: Array<{ name: string, data: Uint8Array }> }>`。工具返回文件名与字节，不提供文件路径、接收人或模型可见正文。宿主保存字节并发固定查看回执，模型只收到 `deliveryId`、`status`、`fileCount`；`delivered` 仅表示通知送达，不表示下载成功或整轮任务完成。

可选示例 [private-export](../../examples/plugins/private-export/README.md) 使用真实清单 `.dutydeck-plugin/plugin.json`，其 `providers` 指向 `providers.mjs`。从源码检出目录安装，私有数据源 `<source_url>/<reportId>` 返回报告字节：

```bash
dutydeck plugin install ./examples/plugins/private-export
# 从 stdin 提供私有数据源 URL，不把报告正文放进 Agent 参数
dutydeck plugin config private-export source_url --value-fd 0
dutydeck restart
```

设置机器人的既有 `webBaseUrl` 为与机器人共享数据库的 HTTPS Web 地址，例如 `dutydeck settings bot set cli_xxx webBaseUrl=https://dutydeck.example`。在**同一个飞书/Lark 应用**启用网页登录，将 `<webBaseUrl>/api/plugin-results/oauth/callback` 加入 OAuth redirect allowlist。回调来自已保存配置，不使用请求 Host；没有新增设置键或面板。配置步骤参见[飞书官方网页登录流程](https://open.feishu.cn/solutions/detail/qrcode?lang=zh-CN)；用户 `open_id` [按应用隔离](https://open.feishu.cn/document/platform-overveiw/basic-concepts/user-identity-introduction/introduction)。

Agent 必须处在可信真人发起的飞书当前任务中，使用本轮提示词提供的 turn（下例 `$TURN` 表示该值）：

```bash
dutydeck plugin-tool list --turn "$TURN"
dutydeck plugin-tool call private-export/export-report --json '{"reportId":"weekly"}' --call-id weekly-export-1 --turn "$TURN"
```

同一次调用重试保持 call ID 和参数不变；缺少或过期 turn、同 ID 不同参数会被拒绝。定时或自动任务、机器人来源、Web 安装管理员及无法证明真人身份的请求不能导出。

打开回执链接后，原请求者须在原机器人应用中以飞书账号登录；独立浏览器会话有效 30 分钟。安装管理员 token、普通 Web 登录、share token 和 Agent capability 不提供下载权限，转发链接也不授权其他人。每次下载复验原任务与原 actor 的当前权限；确认撤权、取消或中断时拒绝并删除结果字节。任务状态待核对时保持 pending，等待核对或过期，不重新执行未知调用。

固定限制：每调用最多 8 文件、每文件 10 MiB、每调用 32 MiB；每请求者未过期结果 128 MiB、全局 1 GiB；每请求者同时执行 1 次、全局 4 次；执行超时 60 秒，迟到输出丢弃。结果 24 小时后立即不可访问，清理回收字节，保留小型幂等记录；过期调用不自动重跑。文件始终作为 `application/octet-stream` 附件下载，不内联 HTML/SVG。

通知沿用原任务位置、相同 provider UUID 和持久确认回执。未确认发送仅在首次发送起一小时内重试，超出后显示 unknown 并停止重发；通知失败不重新执行插件。OAuth 只取本应用登录身份，不请求 `offline_access` 或业务资源 scope；access token 仅在后端短暂用于 `user_info`，不保存或刷新。

此保证覆盖宿主受控 API 数据流。插件是同进程可信 JS，无法阻止恶意可信插件自行打印秘密或同一 OS UID 进程读取宿主文件。独立数据库的实例必须使用保存该结果的 Web 地址，不做跨实例代理。真实飞书 OAuth/redirect 配置与生产联通性在本次隔离验证中为 **unverified**，需部署者另行配置和验证。

## Hook 协议

`hooks/hooks.json` 按事件列出命令：

```json
{
  "task.received": [
    { "command": ["node", "hooks/log-event.mjs"], "timeout": 5000 }
  ]
}
```

- `command`：字符串走 `/bin/sh -c`，数组直接执行；工作目录是插件根目录。`timeout` 必填，100 到 600000 毫秒。`onFailure` 为 `ignore`（默认）或 `block`。`matcher` 是可选正则（匹配对象见下表），安装时会检查不会灾难性回溯。
- **输入**：stdin 收到一份 JSON：`{ event, plugin, eventId?, bindingRevision?, actor?, botAppId?, chatId?, sessionId?, taskId?, attemptId?, cwd?, payload }`。`eventId`、`actor` 和 `bindingRevision` 由宿主生成，插件不能覆盖；任务和工具入口能提供的 session/task/attempt 身份也在顶层传递。
- **环境变量**：只继承 `PATH`、`HOME`、临时目录、locale、时区等基础变量，另加 `DUTYDECK_PLUGIN_NAME`、`DUTYDECK_PLUGIN_ROOT`、`DUTYDECK_PLUGIN_DATA`、非敏感的 `DUTYDECK_PLUGIN_CONFIG_<KEY>` 和 `DUTYDECK_HOOK_EVENT`；秘密只能经 binding accessor 读取。
- **输出**：exit 0 放行，stdout 可以是 JSON：`decision`（`allow` / `deny` / `ask`）、`reason`、`additionalContext`、`updatedPrompt`。exit 2 阻断，stderr 作为原因。其他非零退出码或超时是非阻断错误；`onFailure: block` 时改为阻断。超时会杀掉整个进程组并立即返回。stdout 上限 64 KiB，超出按“没有输出”处理；stderr 上限 8 KiB。
- **顺序**：按插件名排序，再按声明顺序。`deny` 立即生效并结束；其余按 `ask` 优于 `allow` 合并。
- **进程内 hook**：`api.registerHookHandler(event, handler, { timeout?, matcher? })` 注册的 handler 收到 `(input, { signal })`，超时（默认 10 秒）后宿主不再等结果并 abort `signal`；handler 应把它传给自己发起的请求，及时停下后台工作。

| 事件 | 触发点 | payload | `matcher` 匹配 | 哪些输出生效 |
|---|---|---|---|---|
| `task.received` | 任务进入（Web、飞书、自动化、触发器都经过） | source, namespace, key, prompt, mode, actor | 会话 source | `deny` 拒收任务（403 `PLUGIN_HOOK_DENIED`） |
| `task.beforeRun` | 任务开始前，skills 处理之后、prompt 冻结之前 | source, prompt, skills | 会话 source | `deny` 拒收；`additionalContext` 追加；`updatedPrompt` 替换 |
| `tool.beforeCall` | 业务工具授权通过、实际调用前 | tool, input, resource, actor | 工具名 | `deny` 阻断；身份由宿主盖章 |
| `permission.request` | 审批发出之前 | 完整的权限请求 | 请求标题 | `allow` / `deny` 直接代为决定、不再出人工审批；其他结果，或代为决定的审批记录写入失败时，照常走人工审批 |
| `task.completed` | 任务结算后，异步 | status, prompt, source；顶层带 taskId | status | 无 |
| `verification.completed` | 验证跑完后，异步 | 验证结果，加 source | status | 无 |
| `notify` | CI 通知和触发器结果发出之前 | `ci_notice`（title, text, failed）或 `trigger_result`（taskId, status, text） | kind | `deny` 时不发 |
| `delivery.completed` | 业务工具调用完成后（成功、失败、未知或被 gate 拒绝） | tool, status, actionId（如有） | kind | 仅异步观察 |

群协作的判定、回复生成和记忆整理这三类后台会话也经过 `task.received` 和 `task.beforeRun`，输入带所属机器人的 `botAppId`，`bot:<appId>` 作用域的 hook 对它们生效；记忆整理会话不带 `chatId`。对这三类会话，`task.beforeRun` 只认 `deny`，`additionalContext` 和 `updatedPrompt` 会被忽略并记一条警告日志；`permission.request` 也只认 `deny`，`allow` 会被忽略并记警告日志，审批照常走原流程（不论插件作用域）。这三类会话结算时的 `task.completed`（以及适用时的 `verification.completed`）同样带 `botAppId`，bot 作用域的 hook 也会收到，可以用 payload 里的 `source`（`lark-decision`、`lark-response`、`lark-memory`）区分。

目前 `notify` 只覆盖 CI 通知和触发器结果，飞书任务结果卡的推送不经过它。

## CI 提供方

核心里 `/ci`、自动续作、Web「等待 CI 完成」、定时任务条件、`POST /api/hooks/<提供方 id>` 都经 CI 提供方插件。**没装任何 CI 插件时**：飞书 `/ci` 回“未配置”并给出安装方法；Web 显示“未安装 CI 插件”；普通定时任务不受影响。

提供方在 `providers` 入口里调用 `api.registerCiProvider(provider)` 注册。接口（类型见 `packages/shared/src/plugins.ts`）：

- `id`、`displayName`（必填，出现在卡片、提示词和 Web 上）、可选 `changeRequestLabel(n)`；
- `matchRepository(remoteUrl)`：远端地址归自己就返回仓库（`{owner, name, slug}`），否则返回 `undefined`；
- `getPipelineStatus(query)`（轮询用）、`getFailureLogs(repository, runId)`（补失败日志）；
- 宿主给每次异步调用（构建状态、失败日志、PR 各方法、`webhook.verify` / `parse`）都设总时限，默认 25 秒；provider 可以用 `callTimeoutMs: { <方法名>: 毫秒 }` 按方法申请更长时间（例如要逐页读的评论），宿主夹到 1 秒和自己的上限之间：`getPipelineStatus` 最多 25 秒（CI 等待的轮询租约是 30 秒），其余最多 120 秒（PR 跟进每 2 分钟看一次）。超时按这次调用失败处理并记一条警告日志：轮询这一轮跳过、下一轮再查，不会拖住其他定时任务。每个方法最后多一个参数 `{ signal }`，超时时 abort，请传给 `fetch` 等请求并停止后续分页。`createPullRequest`、`postComment` 超时不代表没执行，宿主不会自动重试，报错里会提示先到平台核对；
- 可选 PR 方法，`/pr` 和 Web「开 PR」会实际用到：`createPullRequest`（开 PR）、`listReviewComments`（读评审意见）、`postComment`（回复），以及 `getPullRequest(repository, number)`，返回 `{ state: 'open' | 'closed' | 'merged', headSha?, headBranch?, baseBranch?, headRepository?, title?, url? }`，用来发现 PR 已合并或关闭。同时给出 `headBranch` 和 `headRepository` 的插件才支持 `/pr follow` 认领已有 PR；`headRepository` 与工作区仓库不一致时按来自 fork 拒绝认领，没给时无法排除 fork，也拒绝认领。没实现 `getPullRequest` 的插件只能靠 webhook 的 merge_request 事件发现合并或关闭；两者都没有时，跟进会一直轮询，直到达到轮次上限或有人手动停止。`listReviewComments` 返回的每条 `CiReviewComment` 带 `trusted`、`isBot`、`authorAssociation`：**不给 `trusted: true` 的评论不会被自动处理**，只会发“需要你决定”卡片。github 插件的判定是 `author_association` 为 OWNER、MEMBER、COLLABORATOR 之一且不是 Bot 账号。`postComment` 返回的 `id` 要和 `listReviewComments` 里同一条评论的 `id` 写法一致，否则会把自己的回复当成新评论；
- 可选 `webhook: { verify(req), parse(req) }`：`verify` 可返回 `signedAt`（宿主据此做 5 分钟重放窗口）；`parse` 返回统一的 `CiWebhookEvent`，请求体有问题时抛出 `statusCode: 400`。事件里 `timeIsAdvisory: true` 表示 `occurredAt` 只用于排序，不做重放窗口检查。缺哪个可选方法，对应能力就不可用。

仓库自带两个 CI 插件（从源码检出目录安装；npm 发布包里不带它们）：

| 插件 | 提供 | 配置项 |
|---|---|---|
| `plugins/github` | GitHub Actions 构建状态与失败日志（取失败 job 和步骤，日志末尾 3000 字符）；PR 创建、状态读取、评论读写（供 `/pr` 和 Web「开 PR」使用）；可选 webhook `POST /api/hooks/github`（`X-Hub-Signature-256`） | `github.token`（可选，私有仓库和 PR 操作需要；公开仓库只等构建时不用）、`github.webhook_secret`（可选，填了才启用 webhook） |
| `plugins/codebase` | 可配置代码托管主机的流水线和 MR webhook `POST /api/hooks/codebase`；也是 CI webhook 插件示例 | `codebase.host`（可选，默认 `git.example.com`）、`codebase.webhook_secret`（可选，敏感值） |

```bash
dutydeck plugin install ./plugins/github --yes
printf %s "$TOKEN"  | dutydeck plugin config github token --value-fd 0
printf %s "$SECRET" | dutydeck plugin config github webhook_secret --value-fd 0
dutydeck restart
```

代码托管 CI 示例插件：

```bash
dutydeck plugin install ./plugins/codebase --yes
dutydeck plugin config codebase host --value git.example.com
printf %s "$SECRET" | dutydeck plugin config codebase webhook_secret --value-fd 0
dutydeck restart
```

开 PR 需要 `github.token`（写操作必须有令牌），令牌要有 pull requests 读写权限；读私有仓库的 Actions 构建另需 Actions 读权限。推送本身不用这个令牌，用本机 git 凭据。签名、令牌、`X-Dutydeck-Event-Id` 等细节见各插件目录下的 `README.md`。GitHub 没配 webhook 时用轮询等构建；配了之后 `/ci wait`、`/ci fix` 改为等 GitHub 推送。

相关变化：

- 定时任务里“CI 出现新的失败构建时执行”的条件名是 `ci_new_failure`；旧的 `github_new_failure` 仍可读、仍可传入。
- `GET /api/sessions/:id/automation/ci-providers` 返回已加载的 CI 提供方列表。
- 飞书 `/ci` 只要装了任一 CI 插件就可用；装了 github 插件但没填 token 时，公开仓库也能等构建。
- `/pr` 只要有实现了 `createPullRequest` 的 CI 插件就可用。webhook 型插件的 merge_request 合并或关闭事件会让 PR 跟进立即停止，pipeline 事件会立即触发一次检查。

## 怎么写场景包 <a id="scenario-packs"></a>

场景包让机器人在群里遇到某类消息时按写好的规则处理，例如来源机器人发告警就起初筛任务。一个包是插件 `scenarios/` 目录下的一个 JSON 文件，格式和每个字段的限制以 `packages/shared/src/scenarios.ts` 的 schema 为准。例子：`builtin-plugins/alarm`（`direct` 模式，带关联 provider）和 `plugins/team-faq`（`model` 模式，带上下文 provider）。

包里写的是：参数（群里开启时确认、Web 上可改，类型有 `integer`、`string_list`、`bot_list`）、触发条件、执行指令、群里开关的说法和确认卡文案、`/status` 的一行、「为什么没回」的说明、Web 上的说明。包 id 是 kebab-case，最长 32。

包的 `version` 用 semver。大版本不变时，群里已有的绑定照常生效，包新增的参数按包里的默认值算；大版本变了，已有绑定要在群里重新确认，升级前发出的开启确认卡也失效，要重新说一次。

**两种模式**

- `direct`：只由机器人消息触发。命中后不调判定模型，按去重和每小时上限决定起不起任务，起任务时以群里确认过的人的名义走和 @ 机器人相同的路径。下面这些是强制契约，包里省略了只会得到默认值，不会变成不限：
  - 只处理 `trigger.sourceBotsParam` 指定的那个参数里列出的来源机器人（`bot_list`，`role: "source"`），排除本机器人自己；包里别的 `role: "source"` 参数只让这些机器人不算群里会接话的机器人，不触发；
  - 必须有确认人：开启只能在群里点确认卡完成，Web 只能改已确认过的绑定。所以包里必须写开关短语 `phrases`（`enable`、`disable` 都不能为空），没写的包校验不通过；
  - `trigger.filter.keywordsAnyParam` 指向一个 `string_list` 参数，正文不含其中任一关键字的消息记为级别不符、不起任务；参数为空时不过滤。`trigger.filter` 只用于 `direct`，`model` 包写了校验不通过，`model` 用 `trigger.match` 选消息；
  - 去重：`dedupe` 用核心的 `source_text_v1`（来源加正文，去掉链接、数字、长十六进制串和空白后比较，时间、数值、实例号变了仍算同一条）或包自己的 provider；去重窗口参数 1–168 小时，每小时上限参数 1–30；
  - 多机器人群里只由接话人处理；每条消息的结论（起了、级别不符、重复、超上限、不是接话人、缺确认人、出错弃权）都记一条，「为什么没回」能查到。
- `model`：由真人消息触发，只在 `按需` 和 `积极` 档生效，@ 机器人或回复机器人的消息不走包。命中后交给参与判定模型，包提供判定指引和上下文：
  - 判定时，指引写在判定 prompt 里，包的上下文（provider 的 `context`）作为不可信材料附上，最多 `decisionChars` 字；判定为接时，回复或任务用同一份上下文（最多 `maxChars` 字）和 `execution.instruction`，不会再调一次 provider。
  - 命中的包算这个机器人的负责范围：没配负责范围、也不是接话人时，按需档也能接这类消息。反过来，命中的消息也按范围判断：积极档「默认都接」、单真人群「默认接」对它不再直接生效，角色负责范围和场景分别判断，任一成立就接。场景弃权不会撤销角色范围或明确叫本机器人的接话资格；仅依赖团队答疑场景时，命中关键字但 runbook 没覆盖的问题仍不接。指引只说明什么时候该接，不能放宽核心规则。
  - 多个 `model` 包命中同一条消息时，按包 id 排序只用第一个。
  - 判定后、发出回复或起任务前，会再查一次本群这个包是否仍开着，关了就不发。
  - 群里开启不需要确认人，可以直接在 Web 或 `scenarios=` 里开；群里的开关说法会发一张确认卡，卡上没有参数要填。

包里可以写 `topicOwnership: { "sourceTopics": "neutral" }`（目前 `alarm` 用）：多机器人群里，来源机器人发的消息开出的话题不算别的机器人的话题；只有读到别的机器人已在话题里发过言、或者话题读不完、读取失败时才让路。这不保证只有一个机器人接。

**provider 与信任**

包可以引用插件在 `register(api)` 里用 `api.registerScenarioProvider(provider)` 注册的 provider：`match`（补充匹配或给去重键）、`correlationKey`（关联上一轮用的键）、`context`（`model` 模式的上下文）。provider 是插件代码，安装时随 `providers` 一起确认。每次调用都有截止时间（`match` 500 毫秒，一轮关联合计 1 秒，`context` 默认 5 秒、最多 15 秒），超时的结果丢弃。引用的 provider 没注册时整个包跳过。

**正则**

触发和群里开关说法里的正则只允许 `i`、`m`、`s`、`u` 标志（取全部匹配由宿主加 `g`），源码最长 1000 字符。正则在宿主的隔离线程里执行，单次 200 毫秒，输入最多取前 4000 字符。`validate` 对可能灾难性回溯的写法只给提示，安全靠隔离执行和超时。

**模板变量**

文案里可以写 `{变量}` 和一层条件 `{变量?有值时:为空时}`。每个位置能用的变量是固定的，写了别的变量校验不通过：

| 位置 | 可用变量 |
|---|---|
| `execution.instruction`、`execution.intro` | `{source}`（来源机器人名字，`model` 模式的 instruction 不能用变量） |
| `correlation.prompt` | `{date}` |
| `correlation.cardLine` | `{date}`、`{headline}`、`{url}` |
| `confirm.enableSummary`、`disableSummary`、`enabledResult` | `{summary}` 和各参数 |
| `status.summary` | 各参数 |
| `explain.*` | `{time}`、`{reason}`、`{snippet}` |
| `web.description` | `{requesterId}` 和各参数 |

标题、名词、判定指引、参数说明、`reasons` 等是字面文字，不能写变量。消息正文和模型输出不会插进任何指令位置：来源消息原文和上一轮结论都作为不可信材料跟在指令后面，来源机器人的名字插进模板前会去掉换行和括号类字符。

**出错时**

包的 JSON 校验不过时跳过这个包，插件其余部分照常加载，`plugin list` 和 `doctor` 会列出原因；引用的 provider 没注册、包 id 冲突时也跳过这个包，原因写在 daemon 日志里。运行时正则或 provider 出错、超时，这条消息这个包弃权：`direct` 记一条弃权记录，不起任务；`model` 的上下文 provider 超时、出错、返回格式不对，或者一条材料都没有而 `missing` 不为空时，这条消息按没有这个包重新判定，判定记录里记下原因，`/status` 计入「取材料失败」，「为什么没回」会说明。同一条消息命中多个 `direct` 包时，按包 id 排序只处理第一个。

# 升级说明：CI 环境变量迁移到插件

以前用环境变量配 CI 的部署，**升级后这些变量不再生效**：`DUTYDECK_GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN`、`DUTYDECK_CODEBASE_WEBHOOK_SECRET`。升级后要：

1. `dutydeck plugin install ./plugins/github --yes`（或 `./plugins/codebase`）；
2. 用 `dutydeck plugin config …` 填回令牌、代码托管主机或 webhook 密钥（对应 `github.token`、`github.webhook_secret`、`codebase.host`、`codebase.webhook_secret`；敏感值用 `--value-fd 0`）；
3. `dutydeck restart`。

不这样做的话：旧的等待订阅和 `github_new_failure` 定时条件不再生效，Web 显示“未安装 CI 插件”，`/api/hooks/codebase` 返回 404（现在由 codebase 插件提供，需要装插件）。旧订阅数据仍可读，缺 provider 字段的旧订阅按 GitHub 处理。不做自动迁移。

## 安全说明

- 只装可信来源的插件。agents、hooks、providers 会在你的机器上执行命令，安装时的确认不是形式。
- **providers 代码和 daemon 同进程、同信任级别**，没有沙箱。它在 `register(api)` 里留下的定时器、连接或回调如果抛出未处理的异常或拒绝，整个 daemon 会按 Node 默认行为退出（受 systemd 托管时会被重新拉起，但重启时只有满足条件的任务能保住）。崩溃日志 `Fatal …` 之后会多一行指出错误栈里出现的插件名，这些外部插件同时被**隔离**：下次启动整包不加载；daemon 在加载某个插件的 providers 时卡死后被杀或重启，下次启动也会隔离它。被隔离的插件在插件诊断、`dutydeck plugin status/list` 和 `dutydeck doctor`（fail）里标出；修复或确认后运行 `dutydeck plugin enable <名字>` 解除隔离再重启（`activate`、`rollback`、`uninstall` 也会清除）。内置插件不隔离。hook 子进程和插件服务是独立进程，崩溃不会带倒 daemon。
- hook 子进程只继承基础环境变量；插件秘密通过 binding accessor 提供，不进入 hook 环境。
- **触发器地址只走 HTTPS 或内网。** HMAC 请求带短时有效的时间戳和一次性 nonce；token 请求仍依赖传输层保护。外部材料会被包成不可信数据，但这不能消除提示词注入风险；不要把外部触发器指向 `full-trust` 机器人。
- 触发器的 prompt 模板把外部数据当不可信内容包裹，但这只降低提示词注入的风险，不能保证 Agent 不被诱导。触发出来的会话沿用机器人的权限模式，别给面向外部的触发器配 `full-trust` 机器人。
- git 来源用提交 SHA 固定；`plugin update` 新增能力会重新确认。
- 触发出来的会话若机器人是 `ask` 模式，审批卡可能只在 Web 上出现，飞书侧不一定有（未验证）。
