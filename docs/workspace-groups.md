# 工作区展示分组（Workspace Groups）

Dutydeck 提供工作区展示分组能力，用于在 Dashboard 任务列表中对大量 Agent 会话进行纯展示层面的聚合分类。展示分组不改变任务底层的实际工作目录（`session.cwd`）与进程运行时。

## 1. 核心概念与规则优先级

- **界面入口**：Dashboard 侧栏点击「整理分组」即可打开管理对话框。
- **全安装共享**：分组配置保存在 Dutydeck 配置库中，当前安装的所有会话与客户端共享同一套分组。
- **优先级**：**单任务手动覆盖 > 目录规则 > 自动目录**。
  - 目录规则与自动目录默认基于任务源目录（优先读取 `workspaceSourceCwd`，未设置时读取 `cwd`）；针对 Git worktree 派生的任务，明确按其归属的源项目主仓库路径判定。
- **安全保留**：删除分组仅解除映射关系，相关任务与目录自动回退按目录规则展示，不会删除任何任务数据。

## 2. CLI 命令与用法示例

CLI 支持人类开发者与 Agent 自动化调用，默认连接本地运行中的 daemon 服务；所有命令均返回结构化 JSON（支持 `--json`），参数校验失败时非零退出。

### 常用操作示例

```bash
# 1. 查询当前分组快照
dutydeck workspace-groups list --json

# 2. 创建新分组（返回 snapshot 中包含 createdGroupId，如 wg_01j7abc）
dutydeck workspace-groups create "核心业务研发"

# 3. 重命名分组
dutydeck workspace-groups rename wg_01j7abc "核心业务（归档）"

# 4. 按目录移动（绑定目录规则，支持重复 --directory，必须为绝对路径）
dutydeck workspace-groups move wg_01j7abc --directory /data00/repo1 --directory /data00/repo2

# 5. 批量任务移动（设置单任务手动覆盖）
dutydeck workspace-groups move wg_01j7abc session-1 session-2

# 6. 同时移动目录与任务
dutydeck workspace-groups move wg_01j7abc session-1 --directory /data00/repo1

# 7. 重置归属（清除单任务覆盖或目录规则，恢复按目录规则/自动目录展示）
dutydeck workspace-groups reset session-1 --directory /data00/repo1

# 8. 删除分组（仅清除分组关联，保留全部任务）
dutydeck workspace-groups delete wg_01j7abc
```

### 非 Daemon（前台测试服务）用法

若 Dutydeck 以后台非 daemon 模式（如前台命令直接拉起）运行，需显式指定服务地址与数据库路径：

```bash
dutydeck workspace-groups list \
  --url http://127.0.0.1:4310 \
  --database /absolute/path/to/dutydeck.db
```
