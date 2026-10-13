# hello 示例插件

- `/greet <名字>`：插件命令。
- `POST /api/plugins/hello/triggers/ping`：外部触发器，请求头 `x-dutydeck-token` 带令牌，JSON 里的 `message` 作为不可信数据放进 prompt，`id` 用于去重。
- `task.received` hook：把每个新任务的 hook 输入追加到插件数据目录的 `events.jsonl`。

```sh
dutydeck plugin validate examples/plugins/hello
dutydeck plugin install examples/plugins/hello --yes
dutydeck plugin config hello bot_app_id --value cli_xxx
dutydeck plugin config hello chat_id --value oc_xxx
dutydeck plugin trigger-token hello/ping
dutydeck restart
curl -X POST http://127.0.0.1:4310/api/plugins/hello/triggers/ping \
  -H 'content-type: application/json' -H "x-dutydeck-token: $TOKEN" \
  -d '{"id":"1","message":"hi"}'
```
