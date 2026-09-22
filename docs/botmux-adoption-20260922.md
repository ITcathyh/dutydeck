# Botmux 改进吸收交付记录

五项改进已集成到 `feat/botmux-adoption-20260922`，独立代码审查通过，发现的问题均已修复并复验。交付 worktree 为 `../dutydeck-botmux-adoption-20260922`；原 checkout 的未提交工作保留，尚未合入 master、推送或部署。

Botmux master 首次从 `737c76b` rebase 到 `6ab79c7`，收尾再次同步到 `5d1d635d5`，两次均无冲突，合计前进 26 个提交。2026-09-22 19:28（UTC+8）核对，本地 master 与此次 fetch 的 origin/master 差异为 `0 / 0`。近七天窗口、最初 83 个提交的筛选依据见[评估报告](botmux-review-20260922.md)；本次落实其中五项建议，未整体合并此前的优化分支。

| 改动 | 实际行为 |
|---|---|
| daemon 身份 | 保存并复核 host、boot、PID namespace、PID 与出生时间；stop/restart 每次发信号前检查。旧记录、未知身份与替换后的状态有明确诊断。 |
| Codex / TraeX 输入 | 当前视口须有可输入 composer 及初始化证据；loading、resuming、运行中、菜单和草稿继续等待。包含真实 TraeX 屏幕及 Codex 恢复、紧凑页脚样本。 |
| 编辑补 @ | 更新事件只提供消息 ID，再拉取权威作者、正文及话题；人类首次补 @ 后进入原权限与持久 inbox，重复事件和重启不会重复执行。 |
| 显式最终答复 | `group send --final --turn` 绑定当前任务、attempt 和回复位置；成功终态更新同一张答复卡，保留验证、导出及已有验收入口。普通发送和失败诊断沿原流程。 |
| 复制反馈 | Clipboard API 拒绝后尝试旧接口；只有实际成功显示“已复制”，失败提示可重试，清理临时节点、焦点选区和异步反馈。 |

显式答复通过同一配置仓库实例的任务锁与固定平台发送标识协调实时交付和重启恢复。卡片放不下完整正文时发送附件；终态新增验证信息后再次检查预算。已不可更新的答复卡只补平台状态与操作入口。为使恢复能识别原 attempt，补回了数据库已有但读取时遗漏的 `currentAttemptId` 字段。

## 收尾新增提交

补筛 `6ab79c7..5d1d635d5` 的六个提交，未发现需要返修上述五项的遗漏。以下结论来自生产 diff 和本项目实际入口核对，相关 CLI / RPC / 上游 CI 未作运行验证。

| 提交 | 本项目取舍 |
|---|---|
| `5d1d635` Aiden Codex 启动、模型和推理强度 | 上游修复 `aiden x codex` 包装路径。本项目现有 adapter 直接启动 CLI，包装能力需另做适配，自定义包装行为未验证。 |
| `2b37ee0` 自动关闭空闲会话 | 有产品价值，需单独定义关闭条件；当前已有 idle driver 回收，自动关闭历史会话属于另一种生命周期操作。 |
| `cee7594` XPI 关闭后清除积压 | 当前没有上游专用的跨身份积压协议；已有普通任务关闭、取消队列和未知结果对账链，不直接移植。 |
| `b5fc175` Pi 首轮 extension 落盘 | 当前为 Node 构建、PTY 输入，不经过 Bun 虚拟路径加载 extension 的故障链。 |
| `0e85710` ARM64 musl CI 等待 | 本项目没有同一 Bun 二进制构建链；现有 smoke 已等待本次进程监听及健康检查，窗口为 45 秒。 |
| `46bbe34` 继承授权续跑、定时幂等、RPC 身份 | 已有冻结 actor、固定请求标识、原子认领和未知 attempt 保守恢复。自动续跑授权及 RPC 双进程身份核验值得单独设计，不能直接替换现有控制链。 |

逐项代码位置与边界记录在 `artifacts/dispatch/upstream-late-review.md`，同步证据在 `upstream-refresh.json`。

## 验证记录

最终整合验证（业务代码 `d49d757`）：

| 检查 | 修改前基线 | 整合后 |
|---|---:|---:|
| 全仓测试 | 5066 通过、7 跳过、1 失败 | 5261 通过、7 跳过、1 失败 |
| packages / Web / server 构建 | 通过 | 通过 |
| 全仓类型检查 | 通过 | 通过 |
| 隔离浏览器冒烟 | 68 项通过 | 68 项通过 |

唯一既有失败是 `apps/server/src/database-cli.test.ts:132`：测试固定期望 schema 23，基线已有 migration 24。没有为通过本次验收修改该断言。

功能回归覆盖自建 detached 子进程 start → status → restart → stop、真实 SQLite 关闭重开后的编辑去重、显式答复与终态并发、重建 coordinator 后调用验证入口并更新同卡、执行验收回调、长结果、话题发送失败，以及浏览器 DOM 的复制拒绝与卸载。飞书验证回调测试模拟 `runtime.runVerification`，证明入口接通，不代表该测试运行了验证子进程。

独立审查共复现五项问题，均已修复：真实 CLI 样本误拒绝、迟到 daemon 子进程覆盖新代状态、ready 发布覆盖未知状态、损坏交付收据阻塞恢复，以及附件成功但摘要失败后重复发附件。损坏收据现在按原平台发送标识恢复并 CAS 替换缓存；部分交付保留已成功的附件收据，只补摘要。最终 reviewer 独立重跑 106 项定向测试和 7 个修复后探针，全部通过，无未解决的 P1/P2。

## 交付边界

- 冒烟使用真实 Chromium 和本地 server，Agent CLI 为隔离模拟程序；飞书 provider 为测试替身。真实飞书更新事件、应用订阅发布、真实 CLI 版本矩阵和浏览器剪贴板权限弹窗均为 `unverified`。
- daemon 的 Linux 自建进程生命周期已实测；Darwin 使用真实解析逻辑配 OS 命令 fixture，原生 macOS 为 `unverified`。代际检查不等于内核原子的启动或发信号操作。
- 显式最终答复未引入跨 daemon 的 exactly-once 保证，也未改变 ACPX session 配置或注入环境变量。按触发人隔离 CLI 授权仍是独立能力范围。

验证日志、worker 回执与独立审查证据位于本地忽略目录 `artifacts/dispatch/`；[实施计划](botmux-adoption-plan-20260922.md)记录设计和验收边界。
