# Dutydeck 本轮交付与验收

工作目录：`/data00/home/huangyuhang.edu/ai/dutydeck-full-product-20260914`。分支：`feat/full-product-parity-20260914`，集成基线 `b1520be`。原共享 checkout 未修改。

2026-09-15 按用户要求停止扩功能，本轮现有改动已完成集成、独立复核和本地端到端验收。尚未全面追平 Botmux。普通开发由 ccflash 在独立 worktree 完成，controller 负责设计、整合与验收；全程未读取 memory、个人知识库或历史会话。

## 改了什么

| 范围 | 实际变化 | 交付边界 |
|---|---|---|
| 任务运行 | 任务接收、排队次序、每次执行与结果写入 SQLite；事件先落库再广播，重复请求复用原任务 | Runtime、WorkItem、自动化和服务已接通 |
| 停止与结果隔离 | 停止等待在途写入，隔离旧回调；无法确认执行结果时保留待核对状态 | 不保证 daemon 重启后自动接管仍在运行的 PTY 任务 |
| ACP 与普通进程驱动 | 保存原提交和原生会话归属；JSONL/Pipe 等待完整结果与输出尾声，避免提前报失败 | 使用真实 AcpxAdapter、持久 session key 和本地进程验证；真实供应商未验收 |
| 工作项与自动化 | 按原任务的固定执行尝试读取完整结果；修复来源错接、CI 阻塞原因丢失、迟到回调覆盖取消或完成状态 | 不承诺真实外部消息恰好送达一次 |
| 工作台与 Web | 修复卡片回执尚未写回时误拒当前任务；任务状态事件触发完整数据回读，避免局部字段覆盖缓存导致白屏 | 保留现有界面与查询方式，没有增加新的状态合并框架 |
| 数据库维护 | 增加只读状态查询、显式离线升级、迁移排他与回滚保护；全新库直接启用执行账本 | 旧库仍需停服务后显式升级 |
| Bot 配置和凭据 | 增加 V2 表结构、读取、事务、六个基础配置命令和五个凭据命令，检查当前权限、引用、版本与重放 | 属于存储组件；尚未统一接入管理界面、监听器和全部旧入口 |

新 supervisor、PID namespace、工作流引擎接入、更多执行器与远端设备控制未继续开发。Mira、Riff、Mojo 按用户要求排除。

## 最终验收结果

| 检查 | 实际结果 |
|---|---|
| 完整构建（包、Web、server） | `pnpm build` 通过 |
| workspace 类型检查 | `pnpm typecheck` 通过；相关修改测试另有组件 strict 检查 |
| 后端全量测试 | 191 文件，3179 通过、0 失败、7 跳过 |
| 前端全量测试 | 81 文件，1038 通过、0 失败、0 跳过 |
| 全量合计 | 两个 Vitest project 均完整运行：272 文件，4217 通过、0 失败、7 跳过 |
| Chromium 终端回归 | 10/10 通过：桌面/移动端滚动、刷新后的历史、真实 tmux 重连 |
| 构建产物的产品冒烟 | 实际 CLI、SQLite、HTTP、SSE、WebSocket、Chromium、tmux/PTY 全流程通过，exit 0 |
| 完整集成差异独立复核 | 162 个改动文件核对通过，无未解决的阻塞 finding |
| 实际打包 | shared/storage/runtime/acp-client/transports/server 六包成功；解包后的 CLI `--help` 成功，无测试或 node_modules 混入 |

后端通过后只改了四个 Web 文件；其余 545 个源码/配置文件逐个哈希核对未变。最终 Web 合入后再次完成完整构建和 workspace 类型检查。7 条跳过来自本机不可用的 Zellij/zmx 实机后端测试，不计作通过。

产品冒烟实际经过：首次使用与 Bot 绑定入口、创建任务与显示最终回复、Skill 正文投递、执行验证命令、三步骤目标与成果、目标终端人工确认、同一进程续聊、递增事件游标、终端 WebSocket、静态页面和 API 404。Agent 使用本地模拟 CLI，浏览器、数据库、网络接口与终端进程真实运行；未调用真实模型或飞书。临时进程、私有 tmux 和目录已清理。脚本末尾的“68 项”是旧的固定文案，本记录以实际命令退出和经过的流程为依据。

复现命令（从本 worktree 执行）：

```sh
pnpm build
pnpm typecheck
pnpm exec vitest run --project node --maxWorkers 2
pnpm exec vitest run --project web --maxWorkers 2
pnpm exec playwright test --config tests/e2e/terminal/playwright.config.ts --workers 1
node scripts/e2e-smoke.mjs --port 14573
```

详细证据位于 `/tmp/dutydeck-full-product-20260914/`：`closeout-backend-gate.json`、`closeout-final-gate.json`、两个 `closeout-*-tests.json`、`closeout-terminal-browser.receipt.json`、`closeout-integrated-independent-review.report.md`。独立复核还实际重跑了两个自动化并发反例与 41 条 Web 回归；这些数字不重复加进全量总数。

## 使用与限制

- 旧数据库查询和离线升级见 [数据库命令](database-execution.md)。本轮未操作用户的真实数据库、生产服务或飞书消息。
- 重启后无法确认原执行资源归属时，任务保持待核对且不自动重发。终端能重新显示，不代表任务已自动恢复执行。
- Bot V2 配置组件尚未完成产品入口切换，不宣称新配置体系已全面生效。
- 真实模型供应商、真实飞书、macOS/Windows、远端部署与完整 Botmux 迁移均未完成端到端验收。

原 [能力追平方案](full-product-parity-plan.md) 及其他设计文档保留为后续参考，其中未实施内容不属于本轮完成清单。收尾前的逐次实施记录保存在临时证据目录 `full-product-execution-before-closeout.md`；最终状态以本文件为准。
