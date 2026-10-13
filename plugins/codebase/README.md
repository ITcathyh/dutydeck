# codebase 插件

字节 Codebase（`code.byted.org`）的 CI 插件，接收流水线和 MR 的 webhook。也是给内部平台写 CI 插件的示例：平台相关的地址识别、验签和载荷解析都在 `provider.mjs` 里，订阅、去重、重放窗口和修复规则由 DutyDeck 负责。

## 安装

```sh
dutydeck plugin install ./plugins/codebase --yes
printf %s "$SECRET" | dutydeck plugin config codebase webhook_secret --value-fd 0
dutydeck restart
```

把 Codebase 或 EventHub 的 webhook 指向 `https://<DutyDeck 地址>/api/hooks/codebase`。工作区的 origin 是 `code.byted.org` 仓库时，飞书里的 `/ci wait`、`/ci fix` 会等这里推送的流水线结果。

## 校验方式

- 签名：`X-Dutydeck-Signature: sha256=<hex>`，内容是 HMAC-SHA256(webhook_secret, `${X-Dutydeck-Timestamp}.${原始请求体}`)，必须带 `X-Dutydeck-Timestamp`。
- 令牌：`X-Dutydeck-Token`、`Authorization: Bearer` 或 URL 参数 `?token=`（表单只能填 URL 时用）。带了 `X-Dutydeck-Timestamp` 时同样校验 5 分钟窗口。

`X-Dutydeck-Event-Id` 用于去重；没有时用载荷里的 `event_id` / `id`，再没有就按请求体去重。

## 载荷

支持两种：

- DutyDeck 信封：`type` 为 `codebase.pipeline`（`status`、`sha`、`pipeline.id/url`、`failures[]`）或 `codebase.merge_request`（`action`、`mr`）。
- GitLab 风格：`object_kind` 为 `pipeline` 或 `merge_request`。

转发方把事件包在 `data`、`payload` 或 `event` 里也能识别。Codebase / EventHub 的原始载荷没有拿到样本核实。
