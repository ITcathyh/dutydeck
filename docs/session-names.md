# 会话自定义名称（Session Names）

Dutydeck 为普通会话提供可持久化的自定义名称功能，Dashboard 与 CLI 共用。自定义名称纯粹作为展示元数据，不更改原始 `task.prompt`、`runId`、`cwd`、`state`、`updatedAt`、队列与底层执行驱动。

## 1. 核心概念与规则

- **展示元数据**：自定义名称仅用于界面与 CLI 展示；未设置或被清除后，会自动回退按原有的任务标题显示。
- **允许改名状态**：普通会话在运行中（busy）、空闲（idle）或已归档（archived）状态下均可改名。
- **限制与拒绝**：
  - 由目标编排托管的会话（`work_item`）禁止改名，接口与 CLI 会拒绝。
  - 名称输入必须为 1..80 字符的单行字符串（trim 后计算），禁止包含换行符；空字符串视为无效输入并报错。
- **恢复原名（清除）**：传入 `null` 即可清除自定义名称，恢复按原任务标题显示。
- **权限安全**：仅安装管理员（Installation Owner）有权修改会话名称，未授权请求将以 403 拦截。

## 2. Web UI 入口

- **入口位置**：在 Web 仪表盘的会话详情页顶部，会话标题旁提供编辑/重命名入口。
- **交互方式**：
  - 点击标题旁的编辑按钮后即可输入新名称。
  - 提交非空合法文本即完成重命名。
  - 空文本禁止保存；若需恢复默认标题，点击「恢复默认名称」按钮。

## 3. CLI 命令与用法

CLI 提供 `dutydeck session` 命令组管理会话名称，均支持 `--url` / `--database` 参数，返回格式化 JSON，遇到错误时返回非零退出码。

### 常用命令示例

```bash
# 1. 查看会话列表（包含自定义 name 字段）
dutydeck session list --json

# 2. 重命名会话（1..80 字符，无换行）
dutydeck session rename <session-id> "重构权限模块" --json

# 3. 恢复/清除会话自定义名称（恢复按默认任务标题显示）
dutydeck session reset-name <session-id> --json
```

### 源码运行方式

在未全局安装 CLI 时，可通过 Node.js 直接运行构建后的 CLI 脚本：

```bash
# 构建完整项目产物
pnpm build:packages && pnpm --dir apps/web build && pnpm --dir apps/server build

# 通过 node 运行 CLI
node apps/server/dist/cli.js session list --json
node apps/server/dist/cli.js session rename <session-id> "测试改名" --json
node apps/server/dist/cli.js session reset-name <session-id> --json

# 指定显式服务地址与数据库路径（用于非 daemon 场景）
node apps/server/dist/cli.js session rename <session-id> "测试改名" \
  --url http://127.0.0.1:4310 \
  --database /path/to/dutydeck.db \
  --json
```
