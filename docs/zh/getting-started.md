# 3 分钟快速上手 <a id="quick-start"></a>

> [← 返回 README](../../README.md) · [全部文档](../../README.md#docs) · [English](../en/getting-started.md)

## 1. 环境准备

- **Node.js**：`>= 22.12.0`
- **包管理器**：`pnpm >= 11`
- **终端后端**：默认终端模式需要安装 `tmux`；已显式配置的 Herdr 仍可使用。
- **已安装并登录的 Agent CLI**：Claude Code（`claude`）、Codex 或其他支持 ACP / CLI 的智能体。

## 2. 全局安装与配置

```bash
# 从默认 npm registry 全局安装 Dutydeck
pnpm add -g @byted/dutydeck

# 运行交互式配置向导（可重复运行）
dutydeck setup
```

向导会探测本机可用的 Agent、设置默认工作目录，并可选地绑定飞书机器人。绑定时：

- 默认 Agent 和 App Secret 存在机器人配置里（与 Web 面板是同一份），不写进 `.env`。编号选择按 Enter 接受标记的默认项，输入其他编号切换；交互时 App Secret 用隐藏输入。
- 新建机器人时会问是否立即开启监听，默认是。
- 新建机器人的权限为 `ask`。所选 Agent 必须支持飞书审批（ACP 或 Claude Code / Seed / Relay 终端模式）；不支持时不会保存机器人配置，需换用支持审批的 Agent 后以 `--agent <id>` 重跑，向导不会自动开启完全信任。此前已完成的开放平台绑定不会回滚。

脚本和 CI 里跳过交互：

```bash
# 只配本机，不绑飞书
dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes

# 绑定飞书应用：Secret 从管道读，不要放进命令行参数
printf %s "$LARK_SECRET" | dutydeck setup --lark-app-id cli_xxx --lark-app-secret-fd 0 --agent claude --listen --yes
```

向导选项：`--agent <id>` 指定默认 Agent（必须是检测到的 CLI）、`--lark-app-secret-fd <fd>` 从文件描述符读 Secret、`--listen` 同时开启监听。已在运行的服务要 `dutydeck restart` 才会读到新的机器人配置。

机器人配置完成后，交互式 setup 会用默认 No 的专用问题询问是否验证飞书收发；拒绝则不监听也不发送。同意并启动临时监听后，终端显示一次性 UUID，请在飞书里私聊机器人发送这段验证码。只有在有界时间内收到包含本次 UUID 的用户私聊，机器人才回复该消息并携带同一 UUID。回复被飞书接受表示「入站通过、出站已发送」，仍需你在飞书确认收到；超时则入站未验证，且不发送任何消息。`--yes`、非交互和 `--json` 不进入该验证。此流程不改变机器人权限，也不持久化用户 open_id。

如果终端提示 `dutydeck: command not found`，说明全局可执行目录不在 `PATH`。pnpm 安装可运行 `pnpm setup`，按提示把全局可执行目录加入 `PATH` 后重开终端；npm 安装可用 `npm prefix -g` 找到全局前缀并配置其可执行目录。也可以不修改 `PATH`，改用 `pnpm dlx @byted/dutydeck setup` 或 `npx @byted/dutydeck setup`。

在已有 `.env` 的目录重跑向导时，屏幕上只显示向导自己管理的默认工作目录、端口、监听地址、仅本机开关和飞书 App ID；App Secret 只显示末 4 位，`.env` 里的其他配置（如 `DUTYDECK_AGENTS_JSON`）只列名称，不显示内容。

## 3. 启动守护进程与状态检查

```bash
# 启动后台守护进程
dutydeck start

# 健康诊断（有问题会给出可直接复制的修复命令）
dutydeck doctor

# 查看守护进程运行状态
dutydeck status
```

`doctor` 会对每个机器人的默认 Agent 执行一次 `--version`（5 秒超时，不调用模型）；当前目录没有 `.env` 时，改读 `last-daemon-dir` 记录的 daemon 目录，并说明读了哪一个。`terminal.backend` 一项还会检查 tmux 命令、版本和私有临时 socket 的创建与退出，不连接默认 tmux server；所有调用都带 `-f /dev/null`，`XDG_CONFIG_HOME` 指向私有目录，测试会话只运行受控存活命令，不加载 `/etc/tmux.conf`、XDG 配置或用户 `default-command`。缺少 tmux 时按提示安装或修正 `PATH`，只使用 ACP 或已改用 Herdr 的配置不会因 tmux 缺失被判为致命错误。

启动后浏览器访问：
- **Web 控制台**：`http://127.0.0.1:4310`（本机访问免密）

前台交互启动且读不到任何机器人配置时，监听地址下会显示 `setup`、`doctor` 和实际 Web 地址，每次满足条件都会显示，不记录“已提示”状态。`--json`、非 TTY 和 daemon 子进程不显示这段提示。

---

## 源码二次开发与调试模式

```bash
# 1. 克隆代码仓库并安装依赖
git clone https://github.com/ITcathyh/dutydeck.git
cd dutydeck
pnpm install

# 2. 配置环境变量
cp .env.example .env

# 3. 启动前后端热重载开发模式
pnpm dev
```

本地开发地址：
- **Web 前端**：`http://127.0.0.1:4311`
- **后端 API**：`http://127.0.0.1:4310`（前端请求自动代理到此端口）
