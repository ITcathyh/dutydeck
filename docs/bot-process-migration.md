# 一个 bot 一个进程：离线分库

`scripts/split-bot-runtimes.mts` 把现有 SQLite 的会话和相关历史按 bot 分区，保留无渠道来源的会话到 `web` 分区。它只读或写 SQLite 和新产物目录，不创建 Runtime，不恢复原生 agent，不连接飞书，不安装或启动 unit。

默认只生成 JSON 计划。计划在 SQLite 只读事务中统计每张表的源行数、各目标行数、阻塞项和保留的未决资源。即使源服务仍在线也可以检查；在线 owner 会显示为阻塞项。

```sh
node --import tsx scripts/split-bot-runtimes.mts \
  --database /absolute/source/dutydeck.db \
  --output /absolute/new/bot-runtimes > split-plan.json
```

退出码：`0` 计划可执行或 apply 完成，`2` 计划发现阻塞，`1` 参数、验证或执行错误。输出目录必须尚不存在，空目录也不复用。

## 切换步骤

1. 构建包含 bot 归属检查和源库迁移标记检查的新 CLI。保留原服务的 host、port、默认工作目录、必要环境变量，以及 `DUTYDECK_INSTANCES_JSON`。已有独立 Tag 等 peer 必须原样写入 `existing-peers.json`；确实没有 peer 时文件内容为 `[]`。
2. 在获准切换时，让原服务正常停止并禁止旧 unit 自动重新启动。不要强制中断正在执行的任务。源库 marker 只能拦截支持它的新版本；旧 binary 仍可能打开源库，不能保留旧服务自动拉起。迁移期间不得另起源 runtime。
3. 显式执行 apply，web 使用原来的访问地址和端口，bot 端口独立分配。下面参数只是示例，不能直接用于其他安装。

```sh
node --import tsx scripts/split-bot-runtimes.mts \
  --database /absolute/source/dutydeck.db \
  --output /absolute/new/bot-runtimes \
  --apply --cli-file /absolute/checkout/apps/server/dist/cli.js \
  --cwd /absolute/agent-default-workspace \
  --web-host 0.0.0.0 --web-port 4310 --base-port 4400 \
  --existing-peers /absolute/existing-peers.json
```

4. 检查 `manifest.json`、`peers.json`、各分区 `dutydeck.db`、`.env` 和 `.service` 文件。bot 从 base-port + 1 起分配端口，已有 peer 与 web 端口冲突会被拒绝。web 保留原认证数据；bot unit 使用 `--local-only`。每个 unit 使用独立 WorkingDirectory、数据库、daemon 目录，日志进入各自 journal。unit 共享同一份构建 CLI，不复制应用依赖；PATH 使用生成时的 PATH。需要的额外服务环境变量应在安装 unit 前核对。
5. 安装并启动审核后的新 unit，核验各 bot listener、Dashboard 聚合、旧分享链接、会话归属和已有队列。工具本身不执行这一步。各分区 `.env` 持久保存数据库、daemon 目录、unit、host/port、默认工作目录及 bot 身份；web 也保存 peers。即使 stop 清掉 daemon 状态，CLI 仍可从当前分区目录读取 `.env` 定位所属服务。后续重启使用 `dutydeck restart --unit <对应unit>`，不要直接重启 systemd unit。

安装新 unit 后，可在对应分区目录启动、查看和重启；未将 `dutydeck` 加入 PATH 时，使用构建时选定的绝对 Node 和 CLI 路径：

```sh
cd /absolute/new/bot-runtimes/cli_example
/absolute/node /absolute/checkout/apps/server/dist/cli.js start
/absolute/node /absolute/checkout/apps/server/dist/cli.js status
/absolute/node /absolute/checkout/apps/server/dist/cli.js restart --unit dutydeck-cli-example.service
```

CLI 使用 Node `loadEnvFile()` 读取当前目录的 `.env`，文件按 Node 格式生成并逐值回读验证，不要用 shell `source` 加载。已有同名导出环境变量优先于 `.env`，运行命令时不能继承另一分区的 DUTYDECK 设置。

## 保留与限制

- 支持 `source=null` 且无 source_id 的 web 会话，以及 source_id 以 appId 开头的 `lark`、`lark-memory` 会话。session、任务、事件、映射、原生上下文、执行命令和相关资源只进入所属分区。公共 agents、projects 和认证设置复制到各分区。
- legacy 模式以 `lark.bots` 为当前 bot 集合；已不在集合中的旧 bot 元数据只保留在源库，计数标为 `retained_source`。不会启动或迁移已独立运行的 Tag 数据库。
- 生成目标必须满足服务启动检查：每个 bot 在 `lark.bots` 中恰有一条匹配配置。即使 authority 为 v2，缺失该条目也会报告 `BOT_STARTUP_CONFIG_UNSUPPORTED` 并拒绝退役源库。
- bot 配置只保留本 bot；web 不含 bot 配置。web 的 `dutydeck.bot_session_routes` 保存旧 session 路由，现有 bot `webBaseUrl` 添加 `/instances/bot-<appId中下划线替换为连字符>`，已有匹配前缀不重复添加。会话和分享签名数据不重新生成。
- 只支持当前 `live_lark_config` secret provider。`local-file-v1` 等 provider 会拒绝 apply，避免新数据库路径导致密钥文件丢失。不会读取或复制整个 secrets 目录。
- queued、reconcile_required 和已有 stop block 原样保留。未确认的 local_only 资源只有在存在匹配 session/run 的持久 stop block 时才能迁移，目标仍保持阻塞；legacy 未决资源也保持阻塞。不会把状态改为成功、取消任务或伪造 gone 观测。运行中任务、未闭合资源创建、无法证明已死亡的 process 资源和未知归属状态会拒绝。
- 已归档会话在 runtime 初始化时不恢复，历史 provenance、creation closure 和退休收据完整保留旧 databaseEntity。新数据库只初始化自己的控制身份，不改写历史证据；旧退休命令的重复调用可能因旧 entity 被拒绝，应保留原收据，不重复执行退休。
- 原生 session ID、cwd 和 ACPX/PTY 外部状态不移动。源 runtime 停止且不得重新运行是必要前提；源数据保留仅用于离线核查或受控回滚，不能与新分区同时恢复相同会话。
- 结果卡、附件 upload/message 和 reaction 回执按其持久归属分区；换轮保留的 `earlier_message_ids` 也参与旧轮回执归属。只有真实存在的投递 KV 才检查幂等键归属冲突。`trace_<hash>` 导出回执目前会阻塞迁移：其键依赖导出当时的文本，现有回执没有 app/session，无法从持久记录可靠确定所属分区；工具不会猜测归属或丢弃回执。
- 定时执行、协作执行等未实现归属规则的非空表，以及未知运行 KV，明确拒绝。工具不进行通用跨版本 schema 升级。

## 原子性与故障处理

apply 在源 `BEGIN IMMEDIATE` 写锁内重新检查全部 access 的完整主机、boot、namespace、PID、start 身份。活着或无法证明已死亡的 owner 都会拒绝；工具不发送信号、不删除源 control/access。逐表复制后检查行数、外键和 SQLite integrity。

新产物先写在输出目录同层的私有 staging 目录，每个 staging DB 暂带阻止启动的迁移 marker。所有分区通过检查后，才向源 configs 提交 `dutydeck.bot_process_migration`。随后解除目标 staging marker 并原子重命名目录。源库的所有业务数据保留，不删除会话。

源 marker 提交前失败：事务回滚并删除本次 staging，可以修正阻塞后重试。源 marker 提交后、目录发布前失败：工具报 `SOURCE_RETIRED_RECOVERY_REQUIRED` 并保留 staging；不要删除 staging、清除源 marker 或重启源。人工核对 manifest、源 marker 和每个目标的计数/外键/identity 后完成发布，或在所有目标和相关 agent 都停止的前提下制定回滚。工具不会自动猜测这一阶段的恢复动作。

当前测试覆盖两 bot + web 的真实 SQLite、结构化 bot/secret 及其历史、真实 native selection/provenance、映射、源数据保留、新 inode 控制身份、重复执行、活/未知 owner、未知归属、secret provider、peer 冲突、v2 缺失启动配置、staging 失败回滚、systemd unit 实际校验以及带空格路径的 `.env` Node 加载回读；真实 runtime 在迁移后仍拒绝未验证 local_only 的 restart，driver factory 不会被调用。
