# Dutydeck 1.0 架构

> 本文档是 1.0 的架构事实源。设计以当前产品闭环为边界，避免为假设中的未来能力增加层次。

## 领域与运行边界

```text
Web / Lark / HTTP
        ↓
Application commands and queries
        ↓
Task runtime ── durable state ── event journal
        ↓                              ↓
AgentDriver                    snapshots / projections
  ├─ ACPX
  ├─ PTY CLI
  └─ compatibility transports
```

- 通道只负责把用户动作翻译为命令并渲染投影，不拥有任务状态。
- Runtime 负责状态迁移、队列、中断、恢复、审批和规范化事件。
- Driver 负责供应商协议翻译和会话恢复差异。
- Storage 负责事务、迁移、有界读取和必要投影。
- Web 使用有界初始查询加增量事件，不依赖完整事件历史渲染首屏。
- 飞书开放平台接入拆成私密 Web session、后台配置 job 和纯配置核心：核心只接受受限的 `/developers/v1/*` client，不接触 App Secret；job 对同一应用的活跃配置去重，避免重放非幂等发版。

包只有在存在真实运行时、所有权或发布边界时才保留。只转发少量 helper 的包应合并；workflow 等实验能力只有形成端到端入口后才进入发布产品。

## 可恢复执行

排队任务必须持久化恢复所需的全部已有语义：可见 prompt、agent prompt、风险策略和队列顺序；来源身份、Agent、模型与工作区由持久化 Session 提供。运行中任务遇到非正常退出后变为明确的 interrupted；排队任务以相同执行和授权语义恢复。缺少执行上下文的旧队列记录必须安全中断，不能按更宽松的默认值执行。

事件按运行拥有严格递增序号和稳定类型。有界游标读取是新界面的默认路径；旧全量接口在迁移期保持兼容。允许合并流式文本 delta，但不能丢失终态、审批、工具边界和最终回答。

## 安全边界

- 默认权限不使用 `full-trust`；完全信任必须显式、可见并限定范围。
- 远程 Web 提供完整认证体验，而不是只保护 API 后返回不可用页面。
- 远程浏览器只提交一次访问令牌，后续通过 HttpOnly、SameSite Cookie 认证 fetch、SSE 与 WebSocket；令牌不得进入 URL 或前端存储。
- 远程访问令牌和会话 capability 解决不同问题，不能互相替代。
- 凭证不得进入 prompt、卡片、浏览器响应、普通日志或 ACPX 持久化环境。
- 开放平台 Cookie 原子写入用户目录的私有文件（目录 `0700`、文件 `0600`）；CSRF、Cookie、App Secret 与账号内部 ID 不进入 job 状态或错误信息。
- ACPX `session_options` 的持久化对象键递归遵循 `snake_case`。群聊工具只写入 `dutydeck_group_tools_url` 与 `dutydeck_group_tools_token`；大写旧键只能在读取边界兼容。

## 必守不变量

- 会话侧 `POST /api/relay/sessions/:id/{send,ask}` 仅使用会话 HMAC capability；查看和回答 ask 等人类路由仍使用远程访问认证。
- 带外事件通过 `runtime.publishSessionEvent()` 同时完成落库、序号推进和在线 fan-out。
- 固定 session id 的 CLI 在 fresh 与 resume 使用同一种、供应商特定的 id 形态。
- 桥接 skill 默认不写入用户全局 skill 目录。
- 飞书回复/话题路由和终态卡片对账能够跨 daemon 重启。
- 飞书权限按 tenant/user bucket 精确映射控制台目录 ID；事件与回调只增量补缺并回读。存量发版必须严格读回白名单和黑名单可见范围，任一结构不可解析即停止；版本号覆盖未发布草稿计算，创建和发布不自动重放。
- 修改 ACPX session 配置或环境注入时，增加真实 `AcpxAdapter` + 持久化 session key 回归测试。

## 兼容策略

- 首次不可逆迁移前备份旧数据库，旧历史保持可读。
- 主要 CLI 行为兼容；需要重做的 HTTP 契约采用版本化迁移。
- 用户文档直接解释 Dutydeck；历史来源保留在版本历史或 NOTICE，不再构成产品模型。
- `/api/sessions/*` 在兼容期继续作为内部运行 API；Web 与飞书使用 Task/Run 语言，不复制一套平行状态机。
