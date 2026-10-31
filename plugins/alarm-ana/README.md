# alarm-ana 外部插件

将 alarm_ana 的运维查询和单条报警代操作注册为 Dutydeck 业务工具。提供只读 `alarm-ops` skill，根因排查交给 `/oncall` 飞书 Oncall 机器人。没有自动触发场景、定时任务或卡片动作。

| 工具 | 作用 | 既有接口 |
|---|---|---|
| `alarm-ana/alarm_trace` | 按跨源身份、消息 ID 反查，或按条件搜索；解释分级、投递和认领 | `GET /api/alarm-trace` |
| `alarm-ana/known_issues` | 查同报警键的历史结论、处理人、时间、待办和证据链接 | `GET /api/known-issues`，独立读取 token |
| `alarm-ana/ops_health` | 读已有健康快照、快照年龄和异常摘要 | `GET /api/ops-health` |
| `alarm-ana/ack`、`silence`、`comment` | 代请求人认领、静默或备注 | `POST /api/agent-actions` |

查询有 JSON Schema 参数限制和跨字段校验；单次 HTTP 最多 8 秒，拒绝重定向。响应最多读取 2 MB，再按业务字段裁剪：每个数组最多 20 项、字符串最多 1000 字符、查询约 24,000 个序列化字符预算，动作回执约 2,400。`truncated=true` 表示裁剪，不能把未返回内容当作不存在。保留必要的消息/群证据链接，不直接返回 chat_id、open_id、运行目录、凭据或原始 prompt。

## 写入与回执

插件只连接 IPv4 回环地址 `http://127.0.0.1:<port>`，不持有或传递 `DASHBOARD_ADMIN_TOKEN`。`read_token` 只发送给历史结论读取接口，值必须是服务端独立 `DASHBOARD_READ_TOKEN`。即使机器人处于 ask 模式，安装信任、绑定与工具授权仍须分别完成；不能用权限模式代替工具授权。

动作不暴露 `apply` 开关：每次固定 `apply:true`，`requester` 由宿主可信调用者身份填入，`task_ref` 固定为 Dutydeck 动作 ID。是否真实写入完全由 alarm_ana 的 `AGENT_ACTION_WRITE_ENABLED` 决定；默认关闭时记 intent 和 `outcome=skipped`。此时 `dry_run` 可能为 false，因为它反映请求中的 apply，不代表写入已发生。

宿主返回 `status=succeeded` 只表示拿到插件回执。解析 JSON `receipt` 后按 `outcome` 报告：`ok` 才是后端确认成功；`skipped`、`rejected`、`failed` 原样转述并带原因；`unknown`、`outcome=null` 或只有 intent 都是结果未知。网络失败、超时和无法识别的回执也返回 `outcome=unknown`，不自动重试、不换 call-id。通过只读追溯查 `task_ref`，必要时人工核对 Argos；本插件没有会重发动作的 reconcile 实现。

同一任务内重试必须保留 `--call-id`，宿主复用已记账动作；后端再按 `(task_ref, action, source_key, record_id)` 去重成功、未知或仅 intent 的请求。后端允许重试 skipped/failed，因此不能把“使用了 task_ref”理解为任何情况下都只会追加一次台账。

## 安装前确认

以下是管理员手册，本次开发不执行其中的安装、授权、重启或群消息步骤。

1. 确认目标 Dutydeck 支持 API v1 的 registerQuery/registerAction、绑定 secret 和 tool-grant；仅有版本号不足以确认能力。先在准备安装的版本运行下文离线检查。
2. 用 `systemctl --user list-units 'dutydeck*' --all` 和 `systemctl --user show <unit> --property=WorkingDirectory,ExecStart,KillMode,LoadState` 定位实际实例，填入其数据库、监听地址、unit 和插件源码路径，不读取或打印整份环境文件。
3. 确认 Dutydeck 与 alarm_ana Dashboard 同机，后者可经 `127.0.0.1:8765` 访问；如果采用别的端口，绑定 endpoint 同步改变。
4. 由 alarm_ana 维护人确认当前 `AGENT_ACTION_WRITE_ENABLED` 关闭、实际 runtime_root 与独立读取 token。开写属于另一次明确授权，不是安装步骤；不要给插件管理 token。
5. 选择测试群、同一机器人 app 下测试请求人的 open_id，以及一条真实可追溯的测试报警身份。确认测试人有权查看相关报警和历史结论。

本文沿用已安装 todo-capture 的本地目录来源和 bot 作用域方式；它只有声明式场景，而本插件包含可执行 provider，必须单独审阅并确认信任。

## 离线检查

在 Dutydeck 仓库根目录，使用根 package.json 要求的 Node/pnpm：

```sh
pnpm exec tsc -p plugins/alarm-ana/tsconfig.json
pnpm exec vitest run plugins/alarm-ana
node --import tsx apps/server/src/cli.ts plugin validate ./plugins/alarm-ana --strict --json
node --import tsx apps/server/src/cli.ts plugin test ./plugins/alarm-ana --strict --json
```

测试使用 HTTP mock、临时插件数据目录和内存数据库。安装加载测试将本地副本安装到临时目录，删除源副本后通过真实 PluginHost/业务工具服务验证授权与去重；不会连接线上 Dashboard、Lark 或 Argos。发布包只需 manifest、`index.mjs` 和 skills，无 npm 运行时依赖；可另行在本目录 `npm pack --ignore-scripts`，再从 tarball 离线校验。

## 安装到 bot，先绑定测试群

先替换所有占位符；`dutydeck_database` 和 `dutydeck_url` 必须属于同一实例。以下变量不包含凭据：

```sh
plugin_source=/path/to/dutydeck/plugins/alarm-ana
dutydeck_database=/path/to/runtime/dutydeck.db
dutydeck_url=http://127.0.0.1:4310
dutydeck_unit='<已核对的unit>'
bot_app_id=cli_aa27b64f4a389bb3
test_chat_id='<测试群chat_id>'
requester_open_id='<测试请求人在该app下的open_id>'
```

安装只授予 provider 执行信任，不授予任何业务工具调用权。审阅文件后，在终端运行并确认 `providers` 信任提示：

```sh
dutydeck --database "$dutydeck_database" plugin install "$plugin_source" --scope "bot:$bot_app_id"
```

如已审阅且使用非交互发布脚本，确切命令是上条追加 `--yes`；它表示管理员确认信任可执行代码。插件复制到目标数据库同目录的 `plugins/` 下。由实例管理员安排获准的重启窗口，执行 `dutydeck restart --unit "$dutydeck_unit"` 使插件生效，本手册不要求强制重启。

独立读取 token 通过隐藏输入创建，不出现在命令行或输出：

```sh
dutydeck settings plugin-binding secret-set alarm-ana dashboard_read_v1 --database "$dutydeck_database"
dutydeck settings plugin-binding set alarm-ana --database "$dutydeck_database" --url "$dutydeck_url" \
  --app "$bot_app_id" --chat "$test_chat_id" \
  'config={"endpoint":"http://127.0.0.1:8765"}' \
  'secrets={"read_token":"plugin.alarm-ana.dashboard_read_v1"}' \
  'skills=["alarm-ana/alarm-ops"]'
dutydeck settings plugin-binding explain alarm-ana --database "$dutydeck_database" --url "$dutydeck_url" \
  --app "$bot_app_id" --chat "$test_chat_id"
dutydeck settings plugin-binding list --database "$dutydeck_database" --url "$dutydeck_url"
```

从列表中取该测试群绑定的 `id`，填入 `binding_id`。secret 名称不可覆盖，轮换时创建新名称并更新绑定引用。若不配置独立读取 token，可省略 secret 创建与 `secrets=...`，其余查询仍可用，known_issues 会明确报缺少凭据。

## 工具授权

只给测试请求人、测试群绑定授权；不要把安装级信任误当作该授权。`tool-grant` 不带 `--database`/`--url`，自动连接本机已就绪的实例；0.0.8（`4d4f5e1`）上带这两个参数会报 `PLUGIN_TOOL_DATABASE_REQUIRED`。授权资源 `*` 的查询可以读取绑定的整个 alarm_ana 数据范围，不按群过滤，所以必须确认请求人有该读取权限。

```sh
binding_id='<上一步实际绑定id>'
for tool in alarm_trace known_issues ops_health; do
  dutydeck tool-grant set --json \
    "{\"id\":\"alarm-ana-test-$tool\",\"toolId\":\"alarm-ana/$tool\",\"bindingId\":\"$binding_id\",\"actor\":{\"kind\":\"channel\",\"id\":\"$requester_open_id\",\"appId\":\"$bot_app_id\"},\"effects\":[\"read\"],\"resources\":[\"*\"],\"operations\":[\"invoke\"],\"enabled\":true}"
done
```

动作单独授权，只覆盖一个已确认的测试报警。下例 source_key/record_id 用真实身份替换，资源与工具的定位目标完全一致；其值只含字母数字和 `_ . -`。只在循环里列出本次已获准的动作，静默还须由用户明确给出 1～240 分钟，备注最多 500 字。

```sh
source_key='<已确认的数据源>'
record_id='<已确认的源内报警id>'
for tool in ack silence comment; do
  dutydeck tool-grant set --json \
    "{\"id\":\"alarm-ana-test-$tool\",\"toolId\":\"alarm-ana/$tool\",\"bindingId\":\"$binding_id\",\"actor\":{\"kind\":\"channel\",\"id\":\"$requester_open_id\",\"appId\":\"$bot_app_id\"},\"effects\":[\"write\"],\"resources\":[\"http://127.0.0.1:8765/alarm/$source_key/$record_id\"],\"operations\":[\"invoke\"],\"enabled\":true}"
done
dutydeck tool-grant list
```

## 测试群验收与演练记账

1. 由已授权测试人在测试群 @ 神盾，提供真实话题根消息 ID。Agent 在本轮运行 `dutydeck tool list --turn <本轮授权token>` 和 `dutydeck tool describe alarm-ana/alarm_trace --turn <本轮授权token>`，先用 `mode=message` 反查，再用 `mode=identity` 查询具体报警；候选搜索使用 `mode=search`。确认分级原因、投递证据、ACK 未知与来源读不了的状态都如实报告。
2. 查询 known_issues，确认独立读取凭据已配置、返回结论/时间/处理人及可点击的证据链接；查询 ops_health，确认同时报告快照年龄。再用未授权测试人或未绑定群验证工具不可调用。
3. 由维护人再次确认写入开关关闭后，测试人明确请求单条报警演练，例如静默 30 分钟。Agent 调用示例：

   ```sh
   dutydeck tool call alarm-ana/silence --turn <本轮授权token> --call-id alarm-ana-silence-test-1 \
     --json '{"source_key":"<已确认的数据源>","record_id":"<已确认的源内报警id>","minutes":30}'
   ```

   记录宿主返回的 `actionId`，解析 receipt，必须是 `outcome=skipped`，不能只看宿主 succeeded 或 dry_run。以同一个 call-id 重复调用，宿主应复用相同 actionId 和回执，不再提交第二次 POST。
4. 维护人本地只读核对 `<runtime_root>/agent_actions.ndjson`。下面只打印配对状态、动作和结果，不打印台账中的请求人或参数：

   ```sh
   python3 - <runtime_root>/agent_actions.ndjson <上一步actionId> <<'PY'
   import json, sys
   rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
   matching = [row for row in rows if row.get("task_ref") == sys.argv[2]]
   intents = {row["action_id"] for row in matching if row.get("phase") == "intent"}
   outcomes = [row for row in matching if row.get("phase") == "outcome"]
   assert outcomes and all(row.get("outcome") == "skipped" for row in outcomes)
   assert all(row["action_id"] in intents for row in outcomes)
   print({"intent_count": len(intents), "outcome_count": len(outcomes), "outcome": "skipped"})
   PY
   ```

   演练验收需要同一 task_ref 下至少一个配对 intent/outcome 且 outcome 全为 skipped；台账不存在、只有 intent 或返回 unknown 都不能通过。完成后撤销测试动作授权。扩大绑定范围、换真实报警或打开写入开关都需另行确认。

## 回滚

先撤销本次创建的授权，阻止后续调用；已发出的动作仍须按回执和台账核对，撤销不能撤回外部写入：

```sh
for tool in ack silence comment alarm_trace known_issues ops_health; do
  dutydeck tool-grant revoke "alarm-ana-test-$tool"
done
dutydeck settings plugin-binding set alarm-ana --database "$dutydeck_database" --url "$dutydeck_url" \
  --app "$bot_app_id" --chat "$test_chat_id" enabled=false
dutydeck --database "$dutydeck_database" plugin disable alarm-ana
```

在实例管理员确认的窗口执行 `dutydeck restart --unit "$dutydeck_unit"`，核对插件已停用、工具不可发现，即完成常规回滚。只撤销本次实际存在的 grant；未创建的 ID 会报不存在。

需要彻底卸载时，另在获准停机窗口中，先完成任务并核对未知动作，再停止所有共用该插件目录/数据库的实例。对于已核对的 systemd unit，逐个执行 `systemctl --user stop <unit>`；不能把 disable 后重启当作停止。然后检查：

```sh
dutydeck --database "$dutydeck_database" plugin status alarm-ana
```

只有所有运行时已停、status 无 blockers 时才继续；仍有任务或动作阻断则由当前兼容版本先恢复核对，不能强制跳过。满足条件后：

```sh
dutydeck --database "$dutydeck_database" plugin uninstall alarm-ana
```

卸载完成后，由实例管理员对本轮停止的 unit 逐个执行 `systemctl --user start <unit>`，确认工具不可用及原有功能正常。

此处回滚是撤销授权、停用或卸载新插件，不要求存在上一版本。不要删除 alarm_ana 台账、Dutydeck 数据库或恢复备份，也不要改动 todo-capture。若只是插件升级回退，应另按宿主 `plugin status/rollback` 的停机与恢复依赖检查执行，不能在有未知动作时盲目切换。
