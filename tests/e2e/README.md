# Dutydeck E2E 测试与验收矩阵

## 1. 环境准备与命令契约

### 基础依赖

- **运行时环境**：Node.js `>= 22.12.0`、包管理器 `pnpm 11`
- **系统工具**：`git`、`tmux`（用于后台 PTY 会话隔离与受控终端生命周期管理）
- **浏览器**：Playwright Chromium

```bash
# 安装依赖与 Chromium 支持
pnpm install
pnpm exec playwright install --with-deps chromium
```

### 命令契约

| 命令 | 适用阶段 | 行为说明 |
|---|---|---|
| `pnpm e2e` | 本地核心验证 | 构建当前源码并在 Chromium 下执行核心 Playwright 套件 |
| `pnpm e2e:core:run` | CI 门禁 | PR 与 master push 步骤，直接运行已构建的核心套件 |
| `pnpm e2e:full` | 本地扩展验证 | 构建当前源码并执行核心套件与合成飞书场景 |
| `pnpm e2e:full:run` | CI 定时与手动 | Daily Schedule 与 workflow_dispatch，运行已构建扩展全量套件 |
| `pnpm smoke` | 轻量快速冒烟 | 使用隔离假 CLI 运行基础链路，用于手动排障 |

## 2. 测试产物与定位排查

测试产物统一保存在 `artifacts/e2e/<run-id>/` 目录下：

- `results.json`：汇总测试结果及上下文元数据（Git SHA、dirty 状态、runId、mock 边界与执行时间戳）。
- `html/index.html`：Playwright HTML 可视化报告。
- `test-results/<case>/trace.zip` 或 `smoke/smoke-trace.zip`：失败步骤的时间轴 trace。若用例在浏览器启动前失败，无 DOM trace，排查请直接查阅服务端日志。
- `server.log` 与现场截图（`*.png`）：服务端完整日志与失败时刻快照。测试运行期间创建的临时 SQLite 与 tmux 服务在退出时自动清理，排查请以产物日志与 trace 为准。

### 查看报告与 Trace

均从仓库根目录执行：

```bash
# 启动本地服务查看 HTML 报告
pnpm exec playwright show-report artifacts/e2e/<run-id>/html

# 时间轴交互式审查 Trace（或从 HTML 报告附件中直接点击打开）
pnpm exec playwright show-trace artifacts/e2e/<run-id>/test-results/<case>/trace.zip
```

### 推荐排查流程

1. 查看控制台或 GitHub Actions 运行摘要，获取非零退出码与失败用例名称。
2. 本地定位或从 CI Artifacts 下载解压 `artifacts/e2e/<run-id>/`。
3. 优先核对失败快照 `*.png` 与控制台错误；若需进一步诊断交互细节，执行 `show-trace` 逐帧复现网络请求与操作流。
4. 若在服务启动或初始化阶段失败，查阅 `server.log` 确认进程启动输出与环境状态。

## 3. 覆盖矩阵

### 核心套件（Core - 真实冒烟断言矩阵，断言数以本轮产物为准）

- **Agent 发现与配置脱敏**：发现 ACP 与 PTY Agent，自定义模型正常生效，公开接口不泄露 command/args/env/cwd 等启动配置。
- **初始页面与 Bot 入口**：首屏空状态使用引导，协作入口 Bot 概览与真实接入状态展示，首屏唯一主操作「绑定飞书 Bot」向导。
- **Web 任务与 Worktree**：任务创建选择 Agent 与权限确认，默认 Git worktree 隔离并经由 PTY 投递项目 Skill 正文回流。
- **真实验证与计划**：浏览器执行真实验证命令并展示通过证据，任务保存停用计划后保持停用且不生成自动轮次。
- **目标编排与受控终端**：多步骤目标独立 Session 执行与汇总指纹，不可变流程模板版本，受控终端人工确认与过期写入拦截。
- **API 运行态与回流**：创建 PTY 会话，SSE 递增 sequence 游标，resume 续聊防历史回放，终端 WebSocket 连通及未知 `/api/*` 返回 404 JSON。

### 工作区浏览器套件（Workspace）

- **工作区分组**：一源仓库两 worktree 侧栏归一项目，切换核对真实 cwd、branch 与历史回复。
- **安全策略阻断**：演示未跟踪文件安全策略阻断清理流程。
- **指纹失效验证**：演示添加未跟踪文件致使旧指纹 409 失效（未提交、未合入分支等其他安全保护由单测覆盖）。
- **持久保留与清理**：安全清理成功后工作区独立目录已删，但任务历史与只读状态持久保留。

### 合成飞书套件（Synthetic Lark）

- 基于合成 transport 与模拟平台，覆盖 Lark 机器人管理、App 一键创建默认流程及 pending-review 审核流。

## 4. CI 门禁与边界说明

- **CI 执行策略**：PR 与 master push 运行 core 套件，定时 UTC 18:17（北京时间次日 02:17）与手动 dispatch 运行 full 套件；无论成败保留产物 14 天；schedule 需推入默认分支后生效，required checks 需在托管端按需设置。
- **真实环境边界**：真实模型/真实飞书未纳入，另需专用测试环境与凭据。
- **存量脚本边界**：既有 `tests/e2e/visual`、`tests/e2e/terminal`、`tests/e2e/botmux-parity` 及独立 product 脚本未纳入此常态化 CI gate。

## 5. 新增用例规范

- **断言用户可见结果**：断言 UI 元素呈现、流式推送与状态机演进，持久 mapping 证据等真实状态应予以校验。
- **不放宽业务成功**：严格断言业务逻辑与数据终态，严禁弱化预期条件。
- **不靠 retry 洗绿**：用例与 CI 步骤均不配置 retry，直接暴露真实偶发问题。
- **环境隔离与清理**：使用 fixture 提供私有 HOME、隔离临时目录、真实动态端口与独立 tmux 会话，并在 cleanup 中逆序释放资源。
- **用例分级管理**：新增 spec 默认归入 core；涉及扩展场景时显式标注为 extended。
