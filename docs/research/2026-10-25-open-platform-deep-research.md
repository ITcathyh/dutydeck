# Dutydeck 开放能力深度调研：从插件注册走向可治理的能力平台

评估日期：2026-10-25

本文回答两个问题：Dutydeck 现在已经开放了什么；如果希望其他团队通过插件定制自己的 Agent、工具、自动化和界面，下一步最值得做什么。

本文把用户所说的「Claude Mods」解释为 Claude Code 官方插件中的 function-hook mods，以及 `claude-code-mods` 和 `awesome-claude-code-mods` 这类社区生态。`botmux` 按 `deepcoldy/botmux`（Lark/CLI 桥接项目）分析；同名 Telegram 项目不在范围内。

## 结论先行

Dutydeck 的插件基础已经超过“只能放几份 Skill”的阶段：公开 SDK、清单、绑定、秘密引用、场景包、hooks、CI provider、查询/动作工具、幂等账本、MCP/HTTP/CLI 和插件生命周期都已存在。当前开放程度的主要短板是扩展能力没有统一成一套可发现、可组合、可隔离、可验证的公开契约。

建议把后续方向定为「声明式能力 + 受控宿主服务 + 少量可信进程内扩展」三层模型：

1. 声明式层：清单、Skill、命令、场景、触发器、工具 schema 和 UI 描述可以被静态检查、展示和按会话快照。
2. 宿主服务层：需要网络、长驻进程或较高权限的 provider 运行在独立进程，通过宿主注入的身份、绑定和预算访问 Dutydeck。
3. 可信进程内层：只给内置插件或明确批准的高信任插件，保留低延迟的 provider/hook 能力。

第一优先级是修复四个会限制生态的断点：活动包更新的一致性、hook 环境泄漏、触发器重放保护、以及插件能力在 Web/MCP/CLI 中不可见。它们会直接影响外部作者是否敢安装、调试和长期维护插件。

## 当前基线：已经开放的能力与实际边界

| 能力面 | 当前实现 | 开放程度判断 |
|---|---|---|
| 包和作者 SDK | `@dutydeck/plugin-sdk` 独立发布；`definePlugin`、query/action、CI provider、结果工具、场景 provider、hook handler 均有公开类型；安装不执行 `npm install`，作者需 bundle 运行依赖 | 基础完整，发布门槛仍偏高 |
| 组成方式 | 清单可声明 `commands`、`agents`、`skills`、`triggers`、`hooks`、`providers`、`scenarios`、`bindingConfig`、`userConfig` | 组合面广，但不同扩展使用不同配置和生命周期语义 |
| 绑定与秘密 | Bot/群/工作区绑定、revision、`getSecret`、工具 grant、查询/动作账本、unknown/reconcile | 工具动作的可靠性和授权已经较强 |
| 事件扩展 | `task.received`、`task.beforeRun`、`permission.request`、`task.completed`、`verification.completed`、`notify`；支持 deny/ask/追加上下文/替换 prompt | 事件数量有限，尚未形成统一 middleware 契约 |
| 外部触发 | token/HMAC 触发器，带目标 Bot/群、会话模式、去重键和并发限制 | 能用，但没有统一的异步状态、取消、时间戳/nonce 语义 |
| Web 和 MCP | Web 能编辑绑定和技能；工具有 HTTP/MCP/CLI；MCP 目前只有 initialize、ping、tools/list、tools/call，`tools/listChanged=false` | 宿主可管理面不足，插件不能声明自己的 Web 面板 |
| 运行隔离 | provider 在 daemon 进程内加载；hook 子进程继承 daemon 全部环境变量；安装信任按 `agents`、`hooks:<event>`、`providers` 粗粒度确认 | 适合自用和可信插件，不适合默认承诺不可信第三方隔离 |
| 更新和诊断 | 有 install/update、candidate/activate/rollback、validate、doctor；provider 需要重启生效 | 已有治理骨架，但活动 provider、hook、Skill 路径必须统一固定到同一版本 |

关键代码证据：[`packages/plugin-sdk/src/index.ts`](/data00/home/huangyuhang.edu/ai/dutydeck/packages/plugin-sdk/src/index.ts:1)、[`packages/shared/src/plugins.ts`](/data00/home/huangyuhang.edu/ai/dutydeck/packages/shared/src/plugins.ts:26)、[`apps/server/src/plugins/host.ts`](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/plugins/host.ts:1)、[`apps/server/src/plugins/tool-service.ts`](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/plugins/tool-service.ts:1)。已有的 10 月 22 日开放能力评估补充了绑定、技能投递和工具授权的历史问题：[2026-10-22-extensibility-review.md](/data00/home/huangyuhang.edu/ai/dutydeck/docs/research/2026-10-22-extensibility-review.md)。

## 同类产品的做法

### Botmux：把插件当成一个可管理的运行单元

Botmux 的公开插件指南把一个 npm 包拆成固定贡献点：Skill、每插件最多一个 MCP、CLI、Dashboard 页面和 Host Service。长期运行的代码放 Host Service，Agent 工具放 MCP/Skill，运维入口放 CLI；没有一个让插件任意插入 daemon 的通用 hook。插件安装、启用和 Bot 绑定分开，启用时生成会话级 Skill/MCP snapshot。

它最值得吸收的不是目录名字，而是运行边界：

- Host Service 独立进程：FleetSupervisor 负责启动、停止、自动重启、热加载、状态和日志文件、lifetime lock、崩溃恢复，并阻止服务运行时卸载。插件故障不会直接拖垮 Botmux 主进程。
- MCP Gateway 盖章身份：Gateway 去掉模型提交的保留 header/metadata，再注入宿主验证过的 caller identity；缺身份时 fail closed。插件不能靠伪造 `_meta` 把自己变成可信调用方。
- 外部触发是任务 API：`/api/trigger` 区分 sync、async、fire-and-forget，支持已有 session、幂等键、dry-run、取消和轮询；外部材料明确标成不可信数据。
- 平台连接由网关托管：卡片动作网关负责长连接、ACK、去重、超时和 token；插件只声明 selector 与相对 endpoint，通过私有服务接收回调。这样插件不直接拥有飞书长连接，也不会因为一个插件超时让共享连接退出。
- 市场与信任分离：`plugin-market` 只是发现索引，npm 发布不会自动建立信任。这个设计保留了生态发现能力，也提醒我们不能把“上架”当成“可安全安装”。

Botmux 当前的局限同样有参考价值：插件依赖主要按 ID 管理，市场兼容性元数据尚未强制校验；npm lifecycle 可能执行；新增 CLI adapter 仍需改核心源码。开放入口增加后，治理和兼容性必须同步增加。

来源：[Botmux plugins](https://deepcoldy.github.io/botmux/en/plugins)、[hooks](https://deepcoldy.github.io/botmux/en/hooks)、[task trigger API](https://deepcoldy.github.io/botmux/en/api-task-trigger)、[companion API](https://deepcoldy.github.io/botmux/en/companion-api)、[card-action gateway 设计](https://github.com/deepcoldy/botmux/blob/master/docs/design/2026-09-02-card-action-plugin-gateway.md)、[Host Service supervisor 设计](https://deepcoldy.github.io/botmux/en/plugin-service-supervisor)。

### Claude Code Mods：把事件、UI 和插件包统一成 middleware 生态

Claude Code 官方插件把 `skills/`、`agents/`、`commands/`、`hooks/hooks.json`、`.mcp.json`、`bin/` 和 `output-styles/` 放进同一个带 `.claude-plugin/plugin.json` 的包。插件既可以用 `--plugin-dir` 临时试运行，也可以通过 marketplace catalog 安装；project scope 写入项目设置；`/plugin` UI 负责 Discover、Installed、Errors；`claude plugin validate` 在安装前校验。

官方 Mods API 进一步把 hook 做成 middleware：handler 收到事件和 `next()`，可以观察、传递不可变的改写事件，或者直接 answer/short-circuit。事件覆盖 tool call/check、prompt submit、turn、session、subagent、command 和 UI render；matcher 支持值、数组、正则和通配符。多个 mod 按顺序串成链，失败和超时有明确处理。

Mods API 还提供受控的宿主服务：`$.ui`、`$.model`、`$.fs`、`$.process`、`$.http`、`$.mcp`、`$.store`、跨 session 消息和后台任务。每个 API 有明确预算，例如 hook 10 秒、单文件 4 MiB、store 总 JSON 4 MiB、进程默认 30 秒。UI 以 terminal/Desktop/VS Code 都能降级的元素树描述，而不是让插件直接改宿主 DOM。

Claude Code 的开放性有一个必须同时学习的反例：Mods 在 Claude Code 进程内运行，拥有当前用户的文件、环境变量、网络和工具批准能力，不受 sandbox 保护。官方因此提供 `allowManagedModsOnly`、`allowManagedHooksOnly`、`disableAllHooks`、插件前后置顺序和是否允许覆盖 deny rule 等组织策略。开放能力和组织治理是同一个产品面，不能只开放 API 不开放审计和禁用开关。

生态侧的 `claude-code-mods` 用一个 marketplace 管理多个独立 mod，支持预览、勾选、排序、按项目安装、dry-run 和 fork；`awesome-claude-code-mods` 自动扫描 GitHub，记录事件、访问能力和 `claude plugin validate` 结果，并允许按 capability 过滤。官方 `plugin-evals` 还支持 with/without plugin 对照、MCP mock/replay、tool order、file existence、LLM grader 和成本上限。

来源：[插件概览](https://code.claude.com/docs/en/plugins/overview)、[组件](https://code.claude.com/docs/en/plugins/components)、[Mods 概览](https://code.claude.com/docs/en/plugins/mods/overview)、[Mods events](https://code.claude.com/docs/en/plugins/mods/events)、[Mods API](https://code.claude.com/docs/en/plugins/mods/api)、[依赖](https://code.claude.com/docs/en/plugins/dependencies)、[plugin evals](https://code.claude.com/docs/en/plugins/plugin-evals)、[claude-code-mods](https://github.com/hamzafer/claude-code-mods)、[awesome catalog](https://github.com/karanb192/awesome-claude-code-mods)。

## 对照结论

| 维度 | Dutydeck | Botmux | Claude Code Mods | 对 Dutydeck 的判断 |
|---|---|---|---|---|
| 插件组合 | 清单可组合 commands/agents/skills/triggers/hooks/providers/scenarios | Skill/MCP/CLI/Dashboard/Service 五类固定入口 | Skill/agent/command/hook/MCP/bin/UI mod | Dutydeck 入口已经够多，接下来应统一语义和生命周期 |
| 进程模型 | provider 同进程，hook 子进程 | Service 独立进程，MCP 走 Gateway | mod 同进程，权限由组织策略管理 | 同时保留可信快速路径和隔离服务路径，不能只选其中一边 |
| 事件模型 | 6 个固定事件，返回 decision/context/prompt | gate 与异步事件分层 | `next()` middleware，可 observe/rewrite/short-circuit | 引入小而稳定的 middleware 契约，禁止任意宿主状态改写 |
| 身份与幂等 | 工具动作有 action ledger；触发器较轻 | Gateway 注入可信 caller；trigger 有幂等/取消 | 事件上下文和 API 由宿主注入 | 统一“宿主盖章身份 + 事件/动作 ID + 状态查询” |
| UI | 绑定面板，插件不能注入页面 | 固定插件 Dashboard 路由 | UI render site 和元素树 | 先做声明式 slot/panel/card，不开放任意前端脚本 |
| 分发与治理 | 本地/Git/npm、候选激活、trust confirmation | npm 包、机器/Bot 启用、市场索引 | marketplace、scope、semver 依赖、managed policy | 增加 capability footprint、锁定来源和兼容矩阵 |
| 验证 | validate/doctor/打包测试 | npm pack/validate/运行状态 | validate + eval suite + mock/replay | 建立插件测试工具和真实调用回放 |

## 建议的目标架构

### 1. 先把“能力声明”从入口字段中抽出来

当前清单字段直接决定加载哪些文件，但安装前无法给出一个完整、可比较的权限足迹。建议引入向后兼容的 manifest v2；先做声明和诊断，不立即增加所有执行能力：

```json
{
  "name": "ticketing",
  "version": "2.1.0",
  "apiVersion": 2,
  "host": { "api": ">=1 <3", "channels": ["web", "lark"] },
  "entrypoints": {
    "provider": "dist/provider.mjs",
    "service": "dist/service.mjs",
    "commands": "commands",
    "skills": "skills",
    "hooks": "hooks/hooks.json"
  },
  "capabilities": ["tools.query", "tools.action", "events.task.beforeRun", "ui.panel"],
  "permissions": {
    "secrets": ["ticket_token"],
    "network": ["api.example.com"],
    "filesystem": [],
    "effects": ["external_write"]
  },
  "dependencies": { "other-plugin": ">=1.3 <2" }
}
```

落地时保持最小化：`host`、`capabilities`、`permissions`、`dependencies` 四项先进入 schema；`entrypoints` 可由现有字段兼容生成。`permissions` 只做声明与安装前展示，真正授权仍由 binding、tool grant 和宿主策略决定。清单不应成为插件自授予权限的入口。

### 2. 增加独立 Host Service，暂不把所有 provider 都改成 RPC

对外部作者开放时，建议新增 `service` entrypoint 和一个宿主 supervisor：

- stdin/stdout 或 loopback HTTP 只传版本化 JSON-RPC；调用上下文由宿主注入，插件不能提交 actor、binding、workspaceRoot 等保留字段。
- 宿主按 manifest 给服务最小环境、秘密引用、网络域和每次调用预算；默认不继承 daemon 全部环境变量。
- 服务有 `start/stop/restart/status/logs`，状态写入 durable state；更新采用 active/candidate/previous 目录，运行中服务先 drain，再切换。
- 服务崩溃只让该插件进入 degraded；工具调用返回可诊断的 unavailable，不把宿主主进程判为失败。

已有可信 provider 先保持不变，内置插件和明确批准的高信任包继续走进程内路径。这样不会一次性重写现有插件，但给第三方插件一条可安全演进的通道。

### 3. 把 hooks 扩成小型 middleware，而不是不断增加特殊事件

保留现有事件，新增事件时统一描述四件事：输入 schema、是否同步 gate、允许的输出效果、超时和失败策略。推荐效果只有：

- `observe`：记录或产生诊断，不改变任务；
- `rewrite`：返回新的不可变输入，宿主重新校验并记录摘要；
- `deny/ask`：仅在明确的同步 gate 中生效；
- `emit`：发布异步事件，不能递归修改当前任务。

事件优先顺序建议为 `session.start`、`task.received`、`task.beforeRun`、`tool.beforeCall`、`tool.afterCall`、`task.completed`、`delivery.completed`、`session.closed`。第一批只实现 `tool.beforeCall` 和 `delivery.completed`，因为它们正好覆盖业务授权和结果投递；不要一次开放整个 Agent 内核。

每个事件都必须带 `eventId`、`sessionId`、`taskId`、`attemptId`、`actor` 和 `bindingRevision`。插件不能从 payload 中覆盖这些字段，宿主在日志中记录“原始事件摘要、插件输出摘要、最终决策”。

### 4. 把外部触发器升级成统一任务 API

当前 trigger 已有 token/HMAC、去重和并发，但外部调用者无法用同一套契约完成异步任务的查询和取消。建议增加版本化 `/api/plugin-triggers/v1`：

- `POST /runs`：返回 `202`、`runId` 和 `statusUrl`；支持 `idempotencyKey`、`dryRun`、`session: new|reuse`；
- `GET /runs/:id`：返回 queued/running/succeeded/failed/unknown/cancelled 和结果摘要；
- `POST /runs/:id/cancel`：只取消仍可取消的宿主工作，不宣称能撤销已经发出的外部副作用；
- HMAC 请求必须覆盖 timestamp、nonce、body hash，并由宿主做时间窗和 nonce 去重；
- 传入的 webhook/业务文本统一包成 untrusted data，宿主生成的顶层 task instruction 才是可信指令；
- 回调身份用宿主盖章，插件和模型都不能通过请求体自报 actor。

这套 API 同时服务 CI、告警、工单、定时任务和第三方自动化，避免每个插件再定义一套状态机。

### 5. 用声明式 slot 开放 Web，而不是允许任意 React 注入

Web 当前只暴露插件绑定和技能编辑。下一步建议提供四类稳定 slot：`settings`、`command_palette`、`task_panel`、`result_card`。插件提交 JSON schema 和元素树：text、link、table、status、button、form；按钮只能调用宿主已注册的 command/tool，不能带任意 URL、脚本或未声明的 secret。

Web API 先提供 `GET /api/plugins/:id/capabilities`、`GET /api/plugins/:id/diagnostics` 和 `GET/POST /api/plugins/:id/slots/:slot`。插件前端不直接访问 server 私有包；需要复杂交互时，使用独立 iframe/页面并通过同一 host service API 通信。

### 6. 把“发现”和“信任”分开，并给作者可重复的验证工具

建议新增：

- `dutydeck plugin inspect <source> --json`：输出清单、来源 digest、入口、capability、permission、依赖和宿主兼容范围；
- `dutydeck plugin validate --strict`：检查 schema、包外路径、依赖、重复 command/tool/event、声明与实际入口不一致；
- `dutydeck plugin test <dir>`：用 host fixture 验证 query/action、hook、trigger、result delivery 和 unknown/reconcile；
- `dutydeck plugin eval <dir>`：支持固定输入回放、MCP mock、工具调用顺序、文件/结果断言和成本上限；
- 一个只存元数据的 catalog：显示来源、固定 commit/version、最近 validate 结果、权限足迹和人工审核状态，不代替安装信任。

市场先做发现索引，不自动执行安装；安装器继续使用不可变 artifact、来源锁定和显式 trust。这样既能让作者找到插件，也不会把目录运营变成安全背书。

## 分阶段路线与验收门槛

| 优先级 | 改动 | 完成判据 |
|---|---|---|
| P0 | 修复 active/candidate 混版；活动 Host 固定同一 artifact root；更新时 drain/切换/回滚一致 | 更新或回滚后 provider、hook、skills、commands 来自同一 digest；重启和失败恢复都有测试 |
| P0 | Hook 最小环境；秘密只经声明的 binding accessor；触发器增加 timestamp/nonce/body hash；宿主盖章 caller identity | hook 无法读取 daemon 未声明秘密；重放请求被拒绝；伪造 actor/binding 被拒绝；审计日志能关联 eventId |
| P0 | Web 暴露插件状态、capability footprint、诊断、工具授权入口 | 管理员不进 CLI 也能看到插件为何未加载、需要哪些权限、哪些绑定生效 |
| P1 | `service` entrypoint + supervisor；可信 provider 继续兼容 | 杀掉插件服务不影响 daemon；服务重启不丢 action ledger；更新前能 drain，未知动作可 reconcile |
| P1 | 统一 event envelope 和首批 `tool.beforeCall`/`delivery.completed` middleware | 同一事件在 Web、Lark、自动化入口形状一致；超时/失败/顺序可预测；插件输出不能绕过宿主授权 |
| P1 | 统一异步触发 API 和 run 状态/取消/幂等 | CI、告警和自定义插件复用同一状态查询；重复 `idempotencyKey` 不重复起任务 |
| P1 | typed binding config、host compatibility、semver 依赖与 lock | 安装前能发现不兼容和缺依赖；配置 UI/CLI 共用 schema；敏感值不进入快照和日志 |
| P2 | Web slot/panel/card；插件 command/tool 进入 command palette/MCP 动态发现 | 插件能提供受限设置页和结果卡；禁用插件后页面和命令不残留；MCP `tools/list` 能反映版本变化 |
| P2 | catalog、plugin eval、mock/replay、第三方审核状态 | 每个发布包有可复现的 validate/eval 记录和 digest；能按 capability/风险筛选 |

P0 先让插件版本、身份、秘密和诊断可被可靠解释；P1 再扩大运行面；P2 最后扩大 UI 和生态分发。

## 不建议直接照搬的方案

- 不把所有第三方 provider 都改成 Claude Mods 式同进程脚本；Dutydeck 需要长任务、外部副作用和恢复账本，独立服务更容易定义失败和重启语义。
- 不把 Botmux 的市场索引当成安全仓库；市场只能证明“有人登记了这个包”，不能证明入口没有恶意行为。
- 不让插件直接注入任意 React、浏览器脚本或飞书长连接；先开放宿主托管的 slot、网关和回调协议。
- 不把 Skill 文本、hook 输出或 manifest 的 `allowed-tools` 声明当成授权；真正的权限仍由宿主 actor、binding、grant 和 action ledger 决定。
- 不先设计覆盖所有 Agent 后端的“大一统 SDK”；先稳定事件 envelope、绑定上下文、工具动作和服务 RPC 这四个跨后端共同点。

## 建议的第一批试点

用一个外部 `ticketing` 插件贯穿新契约：同一包绑定两个群，分别使用不同 endpoint 和 secret；提供一个查询工具、一个带 idempotency key 的关闭动作、一个 `tool.beforeCall` 审批策略、一个 `delivery.completed` 结果卡和一个异步 webhook 触发。试点应同时覆盖进程内 provider 与 Host Service 两种模式。

验收要复现以下结果：

1. 两个群的配置、秘密、工具授权和结果不会串用。
2. 宿主重启、插件服务崩溃、网络超时后，动作不会被重复执行；unknown 能通过原 handler 版本核对。
3. hook、工具、触发器、Web 和 MCP 看到的 actor、binding revision、event/action ID 一致且不能由插件伪造。
4. 禁用、回滚或候选包失败后，旧活动包仍能完成已有会话，新的会话不会混入候选版本。
5. `plugin inspect/validate/test/eval` 能在脱离源码目录的 tarball 上给出同样结果。

这条试点链路走通后，再决定是否开放更复杂的 UI、跨插件依赖和 Agent adapter SPI。它能用较小的新增 API 验证开放平台最关键的四件事：能力可发现、身份可验证、执行可恢复、版本可回退。

## 参考资料与代码入口

- Dutydeck：[`packages/plugin-sdk/src/index.ts`](/data00/home/huangyuhang.edu/ai/dutydeck/packages/plugin-sdk/src/index.ts:1)、[`packages/shared/src/plugins.ts`](/data00/home/huangyuhang.edu/ai/dutydeck/packages/shared/src/plugins.ts:26)、[`apps/server/src/plugins/host.ts`](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/plugins/host.ts:1)、[`apps/server/src/plugins/tool-service.ts`](/data00/home/huangyuhang.edu/ai/dutydeck/apps/server/src/plugins/tool-service.ts:1)、[`README.md` 插件章节](/data00/home/huangyuhang.edu/ai/dutydeck/README.md:780)、[既有开放能力评估](/data00/home/huangyuhang.edu/ai/dutydeck/docs/research/2026-10-22-extensibility-review.md)。
- Botmux：[`deepcoldy/botmux`](https://github.com/deepcoldy/botmux)、[plugins](https://deepcoldy.github.io/botmux/en/plugins)、[hooks](https://deepcoldy.github.io/botmux/en/hooks)、[task trigger API](https://deepcoldy.github.io/botmux/en/api-task-trigger)、[companion API](https://deepcoldy.github.io/botmux/en/companion-api)。
- Claude Code： [plugins overview](https://code.claude.com/docs/en/plugins/overview)、[components](https://code.claude.com/docs/en/plugins/components)、[mods overview](https://code.claude.com/docs/en/plugins/mods/overview)、[mods events](https://code.claude.com/docs/en/plugins/mods/events)、[mods API](https://code.claude.com/docs/en/plugins/mods/api)、[dependencies](https://code.claude.com/docs/en/plugins/dependencies)、[plugin evals](https://code.claude.com/docs/en/plugins/plugin-evals)。
- 社区生态：[claude-code-mods](https://github.com/hamzafer/claude-code-mods)、[awesome-claude-code-mods](https://github.com/karanb192/awesome-claude-code-mods)。
