# Dockmux 融合架构

> AgentDock（ACP 多 Agent 工作台）× Botmux（飞书话题群 ↔ CLI 桥接）的融合 fork。
> 本文档是团队分工与模块边界的唯一事实源。

## 1. 融合 thesis

两个项目互补，不重叠：

| 能力 | 来源 | 处置 |
|---|---|---|
| 运行时状态机（队列/中断/重启恢复/终态判定） | agent-dock | **保留** |
| SQLite 持久化 + 仓储契约 | agent-dock | **保留**，补迁移框架 |
| 飞书 trace 卡片（卡片即 CoT） | agent-dock | **保留，禁止劣化**（必保特色） |
| Web 工作台（时间线/Markdown 流式渲染） | agent-dock | **保留**，拆巨石组件 |
| ACP 驱动（AcpxAdapter） | agent-dock | **保留** |
| 29 个 CLI 适配器生态 | botmux | **移植**为 PtyCliDriver |
| 7 种会话后端（tmux/pty/…） | botmux | **移植** pty + tmux（MVP） |
| idle 检测 + xterm 截屏 | botmux | **移植** |
| 话题群会话模型 + owner 身份边界 | botmux | **移植**进飞书通道 |
| v3 workflow 引擎 / skills / fleet | botmux | **后期**，不在 MVP |

**核心动作**：agent-dock 的 `AgentDriver` 接口是唯一接缝。新增 `PtyCliDriver` 实现该接口，内部包装 botmux 的「适配器 + 后端 + idle 检测」栈，把 PTY 输出与 CLI transcript 翻译成 `NormalizedDriverEvent` 事件流。飞书 trace 卡片因此天然能渲染 botmux 生态里所有 CLI 的执行过程。

## 2. 模块地图与团队所有权

```
apps/
  server/                    Fastify + CLI + daemon + 飞书通道
    src/lark/                【Team Lark】飞书通道（trace 卡片在此，禁劣化）
    src/daemon/              【Team Platform】daemon 自管理
    src/auth/                【Team Platform】新增：访问认证
    src/terminal/            【Team Platform】新增：xterm WS 代理（供 Web 终端）
    其余                     【Team Platform】
  web/                       【Team Web】React 工作台
packages/
  shared/                    【Team Core】类型 + 仓储契约 + driver 契约（driver.ts 已落盘）
  agent-runtime/             【Team Core】运行时状态机 + 多驱动路由
  storage/                   【Team Core】SQLite 仓储 + 迁移框架
  acp-client/                【Team Core】AcpxAdapter（保留，小修）
  transports/                【Team Core】探测 + JSONL/pipe/PTY 兼容传输（保留）
  config/                    【Team Core】应用配置 + Agent 发现（扩展 pty-cli 发现）
  renderer/                  【Team Core】事件渲染助手（保留）
  cli-adapters/              【Team PTY】新增：botmux 适配器移植（29 个 CLI）
  session-backends/          【Team PTY】新增：pty + tmux 后端移植
  pty-driver/                【Team PTY】新增：PtyCliDriver = 适配器+后端+idle → 事件流
  terminal-renderer/         【Team PTY】新增：xterm-headless 截屏（从 botmux 移植）
```

**所有权规则**：
- 每个目录只有一个团队能改。跨团队需求 → 找仲裁（项目负责人）改契约，不直接改别人目录。
- 根 `package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json` 只有 Team Platform 能改（加依赖走申请）。
- 团队不碰 git（不 commit）；负责人在检查点统一提交。

## 3. 驱动契约（接缝，已落盘 packages/shared/src/driver.ts）

```ts
interface AgentDriver {
  start(): Promise<void>;                    // ACP: ensureSession / PTY: spawn CLI
  send(prompt: string): Promise<void>;       // 轮次结束时发 completed 事件
  interrupt(): Promise<void>;                // 中断当前轮，保留会话
  resume(): Promise<void>;                   // ACP resume / tmux reattach / CLI --resume
  stop(options?): Promise<void>;
  resolvePermission?(id, approved): Promise<boolean>;
  setModel?(m): Promise<void>;  setReasoningEffort?(e): Promise<void>;
  setRiskPolicy?(p?): void;     setPermissionMode?(m): void;
}
type NormalizedDriverEvent = { type: EventType; data: any; raw?: string };
```

事件流 9+1 类：`text` / `thinking` / `tool_call` / `tool_result` / `permission_request` / `status` / `error` / `completed` / `task` / `raw_terminal`。data 形态见 `driver.ts` 注释。

**协议路由**：`agent.protocol` 新增 `'pty-cli'`。runtime 的 driverFactory 按 protocol 分发：`acp` → AcpxAdapter，`pty-cli` → PtyCliDriver，其余走 transports 探测。

## 4. PtyCliDriver 设计（Team PTY 的核心）

```
send(prompt)
  → adapter.buildArgs() + backend.spawn()        （首轮 start 时已 spawn）
  → adapter.writeInput(prompt) 写 PTY
  → idle-detector 观察 backend.onData 屏幕流
  → 轮次结束（idle 确认）→ 发 completed
事件来源（三路合并）：
  1. transcript  tail（claude-code JSONL / codex rollout）→ thinking/tool_call/tool_result/text
  2. 屏幕流      xterm-headless 缓冲 → raw_terminal（兜底，永不丢）
  3. 控制帧      OSC 777（runner 类 CLI）→ 结构化事件
interrupt()  → backend 发送 Ctrl-C（或 runner abort）
resume()     → tmux reattach（后端存活）或 adapter.buildResumeCommand() 重 spawn
```

**MVP 适配器集**（8 个，按价值排序）：claude-code、codex、gemini、opencode、grok、cursor、kimi、traex。
其余 21 个适配器在 MVP 后批量移植（接口一致，机械工作）。

**MVP 后端**：`pty`（最薄）+ `tmux`（botmux 默认，daemon 重启不丢会话）。zellij/zmx/herdr/riff/mojo 后期。

## 5. 飞书通道（Team Lark）

**保留**：trace 卡片渲染（`listener.ts` 的 toolPanel/groupPanel/buildLarkCardElements）、卡片更新链（限流退避/内容拒绝修补/终态对账）、长连接监听池、群协作工具、高危门禁三层。

**移植 botmux**：
- 话题群路由：thread-scope anchor = rootMessageId，`reply_in_thread`；普通群按 user scope
- owner 身份边界：`ou_` app-scoped，跨应用只用邮箱/手机号/`on_`（移植 botmux `setup/owner-identity.ts` 的规则）
- 多 bot 配置：botmux bots.json 模型 → dockmux `configs` 表

**重构**：`listener.ts`（1616 行）拆为 `coordinator.ts`（唤醒/会话隔离）/ `card-renderer.ts`（trace→卡片元素）/ `reconciler.ts`（终态对账）/ `session-resolver.ts`。**卡片渲染逻辑逐行搬运，不改视觉**。

## 6. Web 工作台（Team Web）

- 拆 `App.tsx`（564 行）→ `components/`（SessionList / Timeline / Composer / LarkConfigModal / PermissionCard / ActivityPanel / TerminalView）
- SSE 自动重连（Last-Event-ID 回放，指数退避）
- 新增 `TerminalView`：xterm.js 直连 `/api/terminal/:sessionId` WS，PTY 会话可看实时终端
- 保留：timeline 合并逻辑、MarkdownContent（Prism 同步高亮）、tool-presentation

## 7. 平台（Team Platform）

- daemon 保留 agent-dock 的 daemonize 方案（不移植 botmux fleet supervisor，后期）
- 新增访问认证：HMAC token（借鉴 botmux dashboard/auth），`--local-only` 之外强制
- 终端 WS 代理：`/api/terminal/:sessionId` → runtime driver 的 backend 屏幕流
- CI：typecheck + test + build 三件套
- 测试基建：vitest 已有；spawn 子进程的测试注意运行时无关

## 8. MVP 验收标准

1. `pnpm build && pnpm test` 全绿（基线 304 测试 + 新增测试）
2. `dockmux` 启动后，Web 工作台能创建 **ACP agent**（如 claude via ACP）会话并流式对话——不回归
3. 能创建 **pty-cli agent**（claude-code via PTY）会话：发消息 → trace 卡片/Web 时间线显示思考过程 + 工具调用折叠面板 + 终态
4. 飞书机器人（配置后）：话题群 @ 机器人 → 回复在话题内 → 卡片流式更新 trace → 终态对账一致
5. 卡片视觉与 agent-dock 基线一致（trace 面板/状态灯/折叠分组）
6. pty-cli 会话中断/重连/重启恢复可用

## 9. 里程碑

- **M0（已完成）**：fork 脚手架 + rebrand + 基线绿
- **M1（本次冲刺）**：MVP 验收 1-6
- **M2**：剩余 21 适配器 + zellij/zmx 后端 + skills 系统
- **M3**：v3 workflow 引擎移植 + fleet 多 bot 监管 + Electron 壳
