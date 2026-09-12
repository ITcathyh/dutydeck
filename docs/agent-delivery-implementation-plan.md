# 工作目录、证据、Skill 与自动续作实施计划

基线：`f0d9bc1`。用户已授权实施调研建议，并指定 GitHub Actions 为 CI 来源。开发在独立 worktree 完成，完成代码不等于启用真实计划或部署服务。

## 冻结范围与接口

1. **工作目录与验证（Runtime 单元）**：新建 Session 接受 `workspaceMode: shared | worktree`，省略保持兼容；Web 默认选 worktree。受管目录按 Session 分配，保存基线、分支和准备状态；重新连接必须校验原目录，失败不得回退。保留所有归档目录，本轮不提供自动删除。工作目录准备失败可定位并重试。验证由用户明确提交命令，平台在会话目录执行，和 Agent 轮次互斥；记录开始/结束、退出码、有限日志和执行前后代码指纹。执行状态与验证状态分开，代码变化后显示证据过期。
   - `runtime.getWorkspace(id)`、`runtime.getVerifications(id)`、`runtime.runVerification(id, {command, timeoutSeconds?}, actorId?)`。
   - `StartSessionInput.workspaceMode?`；数据放 ConfigRepository，使用 CAS 保存准备过程和验证状态。
   - `RuntimeOptions.prepareTaskPrompt?(session,prompt,skillRequests?)` 在接收任务时解析并保存最终 prompt 与 Skill 快照；`dispatch` 最后增加 `skillRequests?: string[]`。重启和排队只使用已保存内容。公开 Task 只暴露 Skill 元数据，不暴露正文。
2. **Skill（独立解析单元）**：`prepareSkillPrompt(cwd,prompt,skillRequests?) -> {agentPrompt,skillDeliveries}`，只允许当前发现目录内的规范文件，按完整路径消除同名歧义。支持兼容 `/skills 名称` 的已发现名称解析。统一采用明确的 prompt 内容注入，标记 `mode: prompt`，不伪造原生支持；保存名称、规范路径、来源、SHA256。选中不可读技能时报错，不假称投递成功。不改用户配置和 ACPX 环境。
3. **自动任务（服务端单元）**：新增以真实 Session 为运行绑定的 DutyDeck 自有计划，复用现有 trigger/timezone/DST 计算与 ConfigRepository CAS、Runtime 幂等 dispatch。现有 foundation 及 Botmux 导入定义继续保持禁用。每个计划复用指定 Session；同计划不重叠，停机最多补一次，条件分为 always 与 GitHub 新失败，明确记录 skip/error。计划默认 disabled，用户通过页面显式启用。任务终态和交付结果分别保存；重试通知不得重新执行。
4. **GitHub 续作（与自动任务同单元）**：从 Session cwd 的 origin 解析 github.com 仓库与 HEAD，支持指定 workflow；服务端通过 GitHub REST 轮询，无公开 webhook。私有仓库使用服务端环境 `DUTYDECK_GITHUB_TOKEN`（兼容 `GH_TOKEN/GITHUB_TOKEN`），令牌不入数据库/响应/日志。一次性订阅绑定 repo + commit，有期限，可取消；持久接收、合并一次查询内的结果，启动前重新读取，旧 HEAD/归档/停止/权限撤销不再唤醒。复用原 Session 队列。可从 Web 管理，飞书可用 `/ci` 查看等待和取消。
   - 新模块 `SessionAutomationService` 接收 repositories/runtime/authorize/prepareDelivery/deliver/githubToken，提供 listBySession/createSchedule/updateSchedule/subscribeCi/cancelCi/tick/close。
   - 自动化 API 必须调用主应用提供的会话授权；后台每次触发及运行时再次核权。使用稳定任务幂等键覆盖已接收但未记账的重启窗口。
5. **入口与展示（controller）**：服务装配、Web 新会话选项、验证与自动化面板、结构化 Skill 选择、飞书 CI 命令和结果路由；修正 README 与 Schedule capability 的已实现能力口径。

## 验证与验收

- 真实临时 Git 仓库：并发两个 Session 不共用 cwd；脏源目录不被移动；准备失败无 Agent 启动；重启复用且身份不匹配拒绝；归档保留文件。
- 真实子进程：成功、失败、超时、输出截断、执行期间/之后代码变化、验证与 Agent 互斥及重启中断。
- Skill：同名不同来源、路径/符号链接越界、读取失败、内容快照、排队后改文件和服务重启保持旧快照；两种 Driver 收到实际正文。
- 自动化：两个服务竞争同 tick；重复 tick/重启；条件 skip/error；停机有界补偿；撤销、过期、旧 generation/HEAD 拒绝；任务忙碌入队；通知失败仅补通知。
- GitHub：按官方响应格式构造 fetch/Response fixture，验证固定主机、匿名优先、令牌回退、拒绝重定向和不泄露错误正文；另行尝试只读公共 API，不触发真实 Agent 或 CI。
- 完整 typecheck、相关单测/集成测试与构建；整合后由未参与编写的 reviewer 审完整 diff，controller 裁决并修复有效问题。

## 分工与边界

- Runtime writer：`packages/agent-runtime/**`、共享 Session/Task 类型及独立 workspace/verification 类型。
- 自动化 writer：新增 server automation/GitHub 模块与测试；新增共享自动化类型。不得修改 app.ts/service.ts/Web/foundation 禁用契约。
- Skill writer：`apps/server/src/skill-catalog.ts`、新 `skill-delivery.ts` 及测试。不得修改 Runtime/app.ts/service.ts/Web。
- Controller：其余入口/页面/文档/整合。各 writer 独立 worktree，不 commit、不回退其他人的改动。

## 整合时明确的边界

- 自动化运行前分 prepare / submit 两次核权；submit 以源记录的 CAS 确定“已开始”。取消、停用、修改 generation 在这个时间点前成功，才承诺不发送。Git HEAD 是外部文件状态，紧邻发送前再次读取，仍不能与外部 Git 写入构成数据库原子事务。
- GitHub 等待针对查询时已出现且匹配的工作流；空结果继续等，超过 100 个运行记录时报错。不能预知之后才创建的新工作流。
- 后台会扫描保留的历史记录；已去掉每个到期计划重复扫描全部轮次的成本，尚未增加历史清理或数据库索引。不能据此声称已验证大规模调度吞吐。
- 自动化交付在创建计划或等待时固定会话、机器人与话题位置，完成时重新核权，只重试通知。终态中断不显示为执行失败。
- 浏览器能力来自当前 Driver 的方法支持或平台条件；进程缺失时显示尚未验证，恢复能力必须在实际重连时检查。
- GitHub 线上验证：匿名请求返回 403 限流，当前环境未发现可用服务端令牌。已完成接口实现和模拟响应测试，鉴权后的线上查询为 **unverified**。

## 审查与交付说明

独立 reviewer 检查了基线上的完整改动和新增源码。已修复工作目录准备过程的持久化时机、验证准入竞态、验证证据错绑、自动任务提交前撤销、超过 1000 条历史后的处理遗漏、取消队列任务后的自动化终态、Skill 鼠标/键盘选择路径，以及话题回报位置和中断状态。平台验证通过 Linux 进程组、启动时钟和随机标记确认归属，持久化身份后才放行命令；不能确认身份时保留阻塞。

使用约束：

- 工作目录隔离与验证互斥针对同一 Runtime。不能让多个 daemon 同时驱动同一 Session，也不能把它当成宿主机沙箱。
- 验证指纹覆盖 HEAD、跟踪文件及非忽略的未跟踪文件，递归处理子模块，排除 `.dutydeck`；依赖缓存、被 Git 忽略的文件及外部服务变化不由该指纹证明。
- 已知服务环境中的敏感值在验证命令、输出和错误保存前脱敏。用户命令主动读取宿主文件或自行脱离进程组，仍属于普通本机进程权限范围。
- 没有启动真实 Agent／飞书通知／真实计划／GitHub 工作流，也没有部署或推送。本轮浏览器验收使用临时 Git 仓库、临时数据库和假 CLI。

## 最终验收（2026-09-12）

代码位于分支 `feat/agent-delivery-20260912`，独立 worktree 为 `/data00/home/huangyuhang.edu/ai/dutydeck-agent-delivery-20260912`。下列检查使用该 worktree 的源码及构建产物，未将结果部署到运行中的服务。

| 检查 | 实测结果 | 覆盖与限制 |
| --- | --- | --- |
| 全仓 Vitest | 192 个测试文件，2800 通过，0 失败，7 跳过 | 跳过项为可选 Zellij／zmx 实机测试 |
| 最终 Runtime 回归 | 110 / 110 通过 | 包含全仓测试后的末次修复：不安全恢复时仍载入持久化队列，停止／归档能取消它 |
| TypeScript | 15 个项目通过 | 末次 Runtime 修改后再次完成 Runtime 编译；Server 类型检查已通过 |
| 生产构建 | Web 与 Server 通过 | 最后一次 Runtime 修改后重新生成 Server bundle |
| Chromium 冒烟 | 53 项断言通过 | 真 Git／SQLite／PTY／SSE／WS，假 Agent CLI；创建默认 worktree、Skill 正文到达 CLI、平台验证及停用计划均实际走通 |
| 独立审查 | 有效问题均已修复并复核 | reviewer 另行运行进程强杀恢复、提交前撤权和恢复阻塞入口测试 |
| 改动格式 | `git diff --check` 通过 | 主工作区的用户文件未改动 |

复现入口：

```bash
pnpm exec vitest run --maxWorkers=3
pnpm exec vitest run packages/agent-runtime/src --maxWorkers=3
node scripts/e2e-smoke.mjs --port 14587 --timeout 180000
```

构建使用包内 TypeScript、Web Vite 和 `apps/server/scripts/build.mjs`；本轮没有宣称现有根目录 `pnpm build` 或 GitHub 托管 runner 已跑通。根脚本仍使用历史 server 包筛选名 `dutydeck`，实际包名为 `@byted/dutydeck`；这属于既有脚本问题，未混入本次会话自动化改动。

本机验收日志：`/tmp/dutydeck-agent-delivery-accepted-tests-20260912.json`、`/tmp/dutydeck-agent-delivery-final-runtime-20260912.json`、`/tmp/dutydeck-agent-delivery-final-typecheck-20260912.log`、`/tmp/dutydeck-agent-delivery-accepted-build-20260912.log`、`/tmp/dutydeck-agent-delivery-accepted-smoke-20260912.log`。GitHub 线上鉴权仍为 **unverified**；使用前需为服务端提供可读目标仓库 Actions 的令牌。
