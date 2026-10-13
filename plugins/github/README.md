# github 插件

给 DutyDeck 提供 GitHub 的 CI 能力：

- `/ci wait`、Web「等待 CI 完成」、定时任务的「CI 出现新的失败构建时执行」：按当前提交查询 GitHub Actions 构建。
- 失败日志：读取失败 job 和失败步骤，日志只取末尾 3000 字符。
- Pull Request：创建 PR、读取行内评审意见和普通评论、发评论（需要 token）。
- Webhook（可选）：`POST /api/hooks/github`，用 `X-Hub-Signature-256` 校验。配了 webhook 后，`/ci wait`、`/ci fix` 改为等 GitHub 推送结果，`/ci fix` 会按规则把失败交给 Agent 修复。

## 安装

```sh
dutydeck plugin install ./plugins/github --yes
printf %s "$TOKEN" | dutydeck plugin config github token --value-fd 0          # 可选，私有仓库和 PR 操作需要
printf %s "$SECRET" | dutydeck plugin config github webhook_secret --value-fd 0 # 可选，启用 webhook
dutydeck restart
```

`token` 和 `webhook_secret` 都是敏感配置，存在 DutyDeck 的密钥存储里。查询构建时先不带 token，公开仓库不需要 token；返回 401/403/404 时再带 token 重试。

## Webhook

在 GitHub 仓库 Settings → Webhooks 里：

- Payload URL：`https://<DutyDeck 地址>/api/hooks/github`
- Content type：`application/json`（`application/x-www-form-urlencoded` 也支持）
- Secret：与 `webhook_secret` 相同
- 事件：Workflow runs、Pull requests

一个提交的全部 workflow run 都结束后才通知一次：全部成功为通过，有失败为失败。PR 合入或关闭后停止等待。
