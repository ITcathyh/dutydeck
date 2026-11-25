# rovetap-jobs 安装使用说明

可选的飞书 `/job` 派单接收器，以独立插件 service（`service.mode: "auto"`，仅用 Node.js 内置模块，要求 Node ≥ 22.12）运行：在 Dutydeck Agent 处理之前经 `eventHandlers` 截获 `/job`，核对**有证据归属**的引用/合并转发材料，通过本机 `pairfob project submit/status` 向固定 RoveTap 项目 leader 建单，并在原话题回执与同步阶段。识别的命令回 `stop`（Dutydeck 不再派 Agent），其余消息回 `continue`。

下面是一条可复制照做的路径：**RoveTap 开通 → 受限配置 → 安装启动并绑定 eventHandlers → 授权群里发令验证**。

---

## 1. RoveTap / pairfob 开通

在运行 Dutydeck 的同一台机器、同一系统用户下准备好绝对路径可执行的 `pairfob`，开通项目入口并绑定固定 leader（子命令是单数 `project-job`）：

```bash
pairfob hub project-job enable \
  --project rovetap \
  --leader pl_0123456789abcdef01234567
```

- alias：1–32 位小写字母/数字/`_`/`-`；leader：`pl_` 加 24 位十六进制。
- 可用 `--socket`、`--token-file` 覆盖默认位置；默认 socket 为 `<hub-state-dir>/project-job.sock`，token 文件为 `<hub-state-dir>/project-jobs/<project>.token`（0600），state dir 默认 `~/.local/state/rovetap-hub`。
- 命令输出 JSON 里的 `socket`、`token_file` 下一步要填；令牌本身不打印。**完成后重启 pairfob hub**，专用 socket 才开始监听。

## 2. 飞书准备与受限配置

### 2.1 飞书应用（同一个 Dutydeck 机器人应用）

在开放平台核对后**创建并发布新版本**：

1. 事件订阅含 `im.message.receive_v1`；权限含消息/群历史读取（`im:message` 或 `im:message:readonly`、`im:chat:read`）。用 `dutydeck lark create` 建的应用或对机器人发 `/repair` 会自动补齐标准事件与权限。
2. **群消息可见性决定 @ 用法**：只有「接收群聊中 @ 机器人消息」权限（如 `im:message.group_at_msg:readonly`）时，飞书只投递 @ 了机器人的群消息，此时必须用 `@机器人 /job`，并按下面填写 `selfOpenId`；已开通「获取群组中所有消息」（配置器标识 `im:message.group_msg`）并发布后，裸 `/job` 也会投递，可不配 `selfOpenId`。
3. 应用可用范围包含派单群和指挥官，机器人已被拉进派单群。国际版 Lark 把配置里的 `lark.baseUrl` 改为 `https://open.larksuite.com`。

### 2.2 只在插件数据目录写配置（不要写进源码仓）

数据目录是**目标实例数据库所在目录**下的 `plugins/.data/rovetap-jobs/`。例如数据库 `/var/lib/dutydeck/dutydeck.db`，则：

```bash
DATA_DIR=/var/lib/dutydeck/plugins/.data/rovetap-jobs   # 按目标实例实际数据库目录替换
sudo -u dutydeck install -d -m 700 "$DATA_DIR"          # 属主换成运行 Dutydeck 的用户
cd "$DATA_DIR"
umask 077
openssl rand -hex 32 > handler-token                    # eventHandlers 共享 bearer，不回显
read -rs APP_SECRET && printf '%s' "$APP_SECRET" > app-secret && unset APP_SECRET
```

需要 `@机器人 /job` 时，用同一应用凭证取机器人自身 open_id（命令只打印 `ou_...`，不打印 token；先 `export APP_ID=cli_...`）：

```bash
APP_ID=cli_xxxxxxxxxxxxxxxx node --input-type=module -e '
import { readFile } from "node:fs/promises";
const secret = (await readFile("./app-secret", "utf8")).trim();
const t = await (await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: process.env.APP_ID, app_secret: secret }),
})).json();
const i = await (await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
  headers: { authorization: `Bearer ${t.tenant_access_token}` },
})).json();
console.log(i.bot.open_id);'
```

国际版 Lark 把脚本里两处 `open.feishu.cn` 换成 `open.larksuite.com`。

在 `$DATA_DIR/config.json` 写入（全部 `cli_/oc_/ou_` 与域名为占位值；`selfOpenId` 不用 @ 形式可留空字符串）：

```json
{
  "appId": "cli_xxxxxxxxxxxxxxxx",
  "appSecretFile": "./app-secret",
  "handlerTokenFile": "./handler-token",
  "selfOpenId": "ou_xxxxxxxxxxxxxxxx",
  "allowedChatIds": ["oc_xxxxxxxxxxxxxxxx"],
  "commanderOpenIds": ["ou_yyyyyyyyyyyyyyyy"],
  "listen": { "host": "127.0.0.1", "port": 14517, "path": "/lark/events" },
  "pairfob": {
    "bin": "/usr/local/bin/pairfob",
    "project": "rovetap",
    "socket": "/home/dutydeck/.local/state/rovetap-hub/project-job.sock",
    "tokenFile": "/home/dutydeck/.local/state/rovetap-hub/project-jobs/rovetap.token"
  },
  "webBaseUrl": "https://rovetap.example.com/workbench",
  "reply": { "mode": "lark-api" }
}
```

`chmod 600 config.json`。必填与边界：

- `appId`：被绑定 eventHandlers 的机器人 app；处理器校验信封外层 `app_id` 必须与它一致。
- `handlerToken(File)`：与第 3 步 eventHandlers token 相同的 bearer。
- `appSecret(File)`：回读材料和默认 `lark-api` 回执都要用。
- **限群与授权只说一次**：`allowedChatIds`（`oc_...`）和 `commanderOpenIds`（`ou_...`）都要显式填，空数组等于全部拒绝。非允许群的命令静默停止；白名单外真人会在话题收到无权限说明；非真人发送者拒绝且不回复。群 ID/成员可用 `dutydeck settings group sync/list/members`（必要时加 `--database`）查询。
- `listen.port` 默认 `0` 是随机端口，eventHandlers 需要稳定 URL，所以**固定一个空闲 loopback 端口**；host 保持 `127.0.0.1`。`listen.host` 只接受本机回环（`127.x.x.x`、`::1`、`localhost`），填 `0.0.0.0` 或局域网地址会在启动时直接报错退出。
- `pairfob.bin` 必须绝对路径且当前用户可执行；`pairfob.project` 与 `hub project-job enable --project` 一致；`pairfob.tokenFile` 是必需的项目令牌文件（也可用环境变量 `ROVETAP_PROJECT_TOKEN_FILE`，但宿主会清洗 service 环境，建议显式写配置），socket 建议一并显式填写。
- **启动即校验必需项**：缺少 `appSecret(File)`、`pairfob.bin`、`pairfob.tokenFile`（或文件不可读/为空、bin 不可执行）时，service 不会带病运行，而是在 stderr 打印 `[rovetap-jobs] failed to start: <含配置键名与路径的原因>` 并以状态码 1 退出；按提示补配置后重启即可，不会出现 `/job` 被 stop 却永远没有回执。
- `webBaseUrl` 填工作台**普通地址**（origin+路径）。误粘带 token 的配对/登录链接时，原 query/fragment 会被清除；含 `user:pass@` userinfo 时不生成链接——敏感段不会进飞书。最终链接固定为 `<origin/路径>?task=<taskId>&leader=<leaderId>`。
- 其他可选项（`projectAliases`、`reply.mode=dutydeck-cli`、`lark.baseUrl`、`limits` 等）以 `service/config.mjs` 的默认值为准。

## 3. 安装、启动并绑定 eventHandlers

在包含 `plugins/rovetap-jobs` 的 Dutydeck 检出/发布目录、仓库根执行。默认 `global` 作用域即实际生效，无需 `--scope`：

```bash
dutydeck plugin validate plugins/rovetap-jobs --strict     # 可选
dutydeck plugin install ./plugins/rovetap-jobs --yes        # 非交互必须 --yes 确认 service 能力
dutydeck restart                                           # systemd 用户单元：dutydeck restart --unit <unit>
```

宿主会以 `node service/main.mjs` 启动 auto service，配置自动取自 `$DUTYDECK_PLUGIN_DATA/config.json`。确认健康：

```bash
curl -sS http://127.0.0.1:14517/healthz        # {"ok":true,"plugin":"rovetap-jobs"}
cat "$DATA_DIR/service.json"                    # 实际 host/port/path/pid
```

最后绑定消息事件处理器（token 从文件读入变量，不回显；成功输出的配置 JSON 也不含 token）：

```bash
HANDLER_TOKEN="$(cat "$DATA_DIR/handler-token")"
dutydeck settings bot set cli_xxxxxxxxxxxxxxxx \
  "eventHandlers=[{\"id\":\"rovetap-jobs\",\"eventTypes\":[\"im.message.receive_v1\"],\"url\":\"http://127.0.0.1:14517/lark/events\",\"token\":\"$HANDLER_TOKEN\"}]"
unset HANDLER_TOKEN
```

- URL 只允许 HTTPS 或本机 HTTP，同机用上面的回环地址。
- **该数组整体替换、会覆盖旧条目**：机器人已有 eventHandlers 时，先 `dutydeck settings bot show cli_xxx` 复制原数组，把 `rovetap-jobs` 这一项追加后整体提交。相同 id 且 URL 不变可省略 token 沿用旧值；新 id 或改 URL 必须带 token。保存后用 `bot show` 核对，损坏时会出现 `eventHandlersError`。
- 顺序原因：外部处理链只有 2 秒共享回执预算；接收器不可达时该消息在当次投递不会进入 Dutydeck Agent，飞书会重投。所以先让 service 健康，再绑 eventHandlers。

## 4. 授权群里发令验证

在 `allowedChatIds` 的群里、用 `commanderOpenIds` 内的账号发送：

```text
/job rovetap 请跟进这条反馈
```

- **裸 `/job`**：只要飞书把群消息投递给应用（已发布 `im:message.group_msg`）即可识别，不依赖 `selfOpenId`。
- **`@机器人 /job ...`**：只有 @ 的 open_id 与配置的可信 `selfOpenId` 精确匹配事件 `mentions` 时，前导 @ 才会被消去并识别。未配或不匹配（@ 的是别人、文本看起来像 `@_user_1` 但没有对应事件提及）时，本插件回 `continue`，消息按普通 @ 机器人进入 Dutydeck，不会产生 RoveTap 单。
- `/job` 必须在消息开头；句中出现的 `/job` 是普通文本。`/job @未知别名 ...` 会回执「不明确的项目」并停止传播；裸的非别名词按指令正文处理；空指令用默认文案。
- 正常路径：材料核对、建单成功后，原话题出现「✅ RoveTap 项目已接单」（含任务号与可选链接），随后 doing/done/failed 等阶段只通知变化；缺材料/无权限时收到对应引导。Dutydeck 不会另起 Agent 回答该命令。

## 材料与权限边界

每条 `/job` 只附**一个**经回读证明的文字材料：

1. **显式引用优先**：带 `parent_id` 时重新调消息接口读取，并证明其 `chat_id` 与当前群一致、话题（`thread_id`/`root_id`，或引用消息本身就是话题根）一致。引用已删除/撤回、归属字段缺失、跨群跨话题、正文只剩 `@_user_n` 占位或合并转发英文壳文案，都会被拒绝并提示重新引用。
2. **无引用时只在原生话题 `omt_...` 内找唯一合并转发**：会翻页枚举完整话题（预算 `limits.threadScan`，默认 30 条）。没有 `omt_` 话题（不做群历史扫描）、翻页不完整或窗口截断导致唯一性无法证明、存在多条更早的 `merge_forward`、命令或候选时间无法证明先后，都转为请指挥官**显式引用**其中一条。命令时间取自真实事件的 `message.create_time` 并随任务持久化；事件缺时间且命令消息回读不到时同样不放行，因此命令之后才到达的“材料”不会被绿灯信任。普通逐条转发的文本在平台事件里与手打文本无法区分，不是自动候选——直接引用它即可。
3. 列表内容不被信任，命中的 id 一律重新获取并复核范围；合并转发子项只在 `upperMessageId` 证明父子关系时展开，嵌套合并转发不展开；只读机器人在本群/本话题有权看到的副本，不接触私聊，不读取被提及账号的内容。
4. **指令与材料各有固定 4000 Unicode 码点上限**（Rove 提交契约，按码点而非 UTF-16 长度计）：材料按码点截断、不拆代理对，截断后缀计入上限；指令超长不截断，会回执写明本实例的实际上限（`limits.maxInstructionChars`，默认 4000）并请指挥官精简重发。`limits.maxMaterialChars` 与 `limits.maxInstructionChars` 都只能调小，配更大值也会被夹到 4000。材料首版只取文本与富文本（post）正文中的文字。
5. `/job` 命令本身必须是发送者新打的 `text`；带转发来源或非文本（post/图片/文件/merge_forward 等）的命令消息不识别为命令，照常 `continue`。

## 提交结果三分支：可安全重试、明确终局反馈、未知只核对

HTTP 层只做鉴权、解析和一条原子持久事务（`$DATA_DIR/rovetap-jobs-state.json`）后立即回执，pairfob 调用与飞书回复都在后台 worker。对照真实 `cmd/pairfob/project.go` 的 code/exit，提交结果分三类处理：

- **确定一个字节都没发出**：CLI 根本没拉起（如 `pairfob.bin` 路径错误），或信封为 `unreachable`（Go 侧只在拨 unix socket 失败、尚未写请求时给出，exit 1）。已解析材料保留，任务退回队列按指数退避后**用同一 payload 重新 submit**。
- **明确终局拒绝/配置错误**：`configuration_error`（socket/令牌配置问题，exit 2）、`not_found`（提交时绑定的 project leader 不存在），以及 `forbidden`/`conflict`/`invalid_argument` 等 exit 4 明确裁决。任务置为 `failed`，原话题收到带错误码、可据此找管理员处理的说明，**不再自行 submit 或 status 核对**。注意 `status` 查询返回的 `not_found` 语义不同：可能只是枢纽尚未可见，仍按未知路径退避核对，不会据此判失败。
- **结果未知**：`unknown_outcome`（exit 5，写字节后断线/超时/回执残缺）、进程被杀、stdout 无法辨认、`internal`/`usage` 等不能证明枢纽拒绝的码，**绝不重复 submit**，而是用稳定来源键（`app_id + message_id`）调 `pairfob project status --key` 核对；进程重启会把中断中的提交（`submitting`）转入核对。

发现新阶段（含 done/failed/cancelled 终态）时，阶段值、`sentPhases` 去重、待发阶段回执与 accepted/终态在**同一个 `store.mutate` 事务**落库，确认持久化后才发送；即使在落库后、发送前崩溃，重启也会从同一份状态把接单与完成等回执补齐，且同一阶段只通知一次。飞书回复默认走带持久 `uuid` 的 reply API，在 1 小时 uuid 去重窗口内重试不重复发帖。

## 重启与端口独占

固定 `listen.port` 同时只允许一个代际持有：新版先独占绑定端口，成功后才恢复在途状态；绑定失败的旧/重复进程直接退出，不读写状态、不发回执。关停时本代**继续持有该端口**直到在途 HTTP 回执、worker 链路与存储写入全部排空，期间新请求得到带 `Retry-After` 的 `503 {"error":{"code":"shutting_down","retryable":true}}`，Dutydeck/飞书会安全重投（持久收件箱去重）；排空完成后才关闭监听释放固定端口，因此重叠启动的第二实例在此期间会 `EADDRINUSE`，不会并发恢复同一状态。

## 手动运行与测试

```bash
node plugins/rovetap-jobs/service/main.mjs --config "$DATA_DIR/config.json"
# 配置发现顺序：--config、$ROVETAP_JOBS_CONFIG、$DUTYDECK_PLUGIN_DATA/config.json、
# ~/.config/dutydeck/rovetap-jobs.json
pnpm exec vitest run plugins/rovetap-jobs/test
```

## 原话题回执

飞书 reply API 沿用每条回执持久保存的 UUID。重试须使用原发送后端和同一个 UUID，并且每次请求须在首次尝试起一小时内发出。获取凭据和限流退避都计入这段时间。若首次走 `dutydeck-cli`，CLI 会自行生成 UUID。送达结果未知时保留该状态。旧记录若缺少发送后端或 UUID 的证据，也保留为未知。

请在支持话题回复的群启用插件。在首次回复明确遇到合并转发根消息不可回复（230072）时，插件使用同一个 UUID 回复原话题内的 `/job` 命令。整个群不支持话题回复（230071）时，回执记为发送失败。

## 排错速查

| 现象 | 检查 |
|---|---|
| 发 `/job` 两边都没反应 | 飞书群消息可见性（裸 `/job` 需 `im:message.group_msg`）；eventHandlers 已绑定且无 `eventHandlersError`；`curl /healthz`；固定端口与 URL 一致。 |
| `@机器人 /job` 变成 Dutydeck 普通对话 | `selfOpenId` 未配/填错，或 @ 的不是该应用机器人；用 2.2 的命令取 `bot.open_id`，改配置后重启 service。 |
| 401 / 403 `app_mismatch` | handlerToken 两边不一致；`appId` 与被绑机器人不一致。 |
| 回执要求引用 | 按提示引用那条反馈再发 `/job`：多条转发、话题枚举不完整、引用被删/跨话题/无文字都会这样，属设计行为。 |
| 回执无任务链接 | 未配 `webBaseUrl`，或其含 userinfo 被拒绝；改成普通 HTTPS 工作台地址后重启 service。 |
| pairfob 一直核对 | `pairfob.bin` 绝对路径可执行、hub 已重启、socket/tokenFile 与 `hub project-job enable` 输出一致；用 `project status --key <source-key>` 只读核对，不要换新键重发。若话题已收到 `configuration_error`/`not_found`/`conflict` 说明，则属明确终局，按提示修配置或绑定后重新发 `/job`；`unreachable` 会自动退避重提，无需人工重发。 |
| 重启瞬间 eventHandlers 收到 503 `shutting_down` | 旧代仍在排空并独占固定端口，503 明确可重投，Dutydeck/飞书重投后由持久收件箱去重；排空结束端口释放，新代才能绑定，属正常无损重启。 |
| service 反复退出 | 看宿主/unit stderr 的 `[rovetap-jobs] failed to start: ...`（不含密钥）：配置缺 `appSecret`/`pairfob.bin`/`pairfob.tokenFile`、token 文件或 bin 路径不可用、`listen.host` 非回环都会在启动时这样指出键名/路径。连续崩溃超上限后 supervisor 停止自动重启，修复后 `dutydeck restart` 或 `POST /api/plugins/rovetap-jobs/service/restart`（安装管理员）。 |

安全：仅监听 loopback，bearer + 外层 app_id + 群/指挥官白名单；config 与 token 文件 0600，日志不打印令牌/secret/材料全文；一个实例服务一个飞书应用、一组派单群和一个 pairfob 项目；插件是可信本机代码，不提供沙箱。
