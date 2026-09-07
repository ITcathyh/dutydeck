# Dashboard 群聊与机器人管理交付

本轮已将主要入口收敛为「任务 / 机器人 / 群聊」，常用配置在当前对象旁直接编辑，没有新增新手引导。参考 botmux 的群内 Bot 操作方式，接通了群配置到实际任务执行的链路。

## 操作与生效方式

- **机器人**：直接修改默认 Agent、模型、目录、触发和回复方式；新增或更换凭据沿用绑定入口。
- **群聊**：同步 Bot 可见群，选择群和其中一个 Bot，独立设置 Agent、目录、模型、触发、访问成员及群工具。模型支持继承 Bot、使用 Agent 默认、单独指定。
- **目录**：创建任务、Bot 默认和群内配置共用服务器目录选择器，支持 Linux 服务端目录浏览。
- **保存**：切换页面或对象保留草稿；并发修改返回冲突并保留输入。保存期间继续编辑、切换对象也不会清空其他草稿。
- **布局**：桌面列表与详情并列；窄屏在列表和详情之间切换。高级设置折叠，主要按钮始终可达。
- **生效边界**：Agent、模型和目录作用于新话题；旧话题保留原执行上下文。群禁用、成员和工具授权按当前策略校验。

Bot 默认仍以现有 `lark.bots` 为唯一来源，群覆盖复用 GroupBinding 和 RoleAssignment。发现群只保存事实；明确保存群配置后才接入执行。离线导入记录不会因同步自动激活，也没有新增一套监听器。

## 验收证据

- 全量 Vitest：164 个文件，2420 项通过、7 项跳过。
- 浏览器端到端：13 个场景通过，覆盖桌面、390px 窄屏、目录选择、草稿、并发冲突、两个 Bot × 两个群的独立配置、继承与清空、话题隔离、重启续聊、权限撤销和 Dashboard 续聊身份。
- 权限验证使用真实 AcpxAdapter 和实际启动的测试 CLI：Alice 执行期间，排队的 Bob 不会改变当前权限；Bob 开始执行后才获得自己的权限。ACPX 持久化键名回归通过。
- 独立复查发现的草稿串对象、目录失败仍可选择、授权撤销、角色重新授予、旧会话与排队身份等问题已修复；最后一轮相关测试 26/26 通过，确认没有剩余阻塞项。见 [复查结论](dashboard-acceptance/review.md)。

E2E 使用真实 Chromium、HTTP 服务、SQLite、任务运行时及 AcpxAdapter；飞书传输和模型侧 CLI 使用可控测试替身，未向真实飞书群发消息，也未验证线上应用权限。原生 CLI 高风险拦截未就绪时的 409 阻断有单独验收；ACP 权限场景通过测试夹具配置，不代表已验证所有厂商的原生 hook。

最新时间、逐项结果和实际进程记录见 [机器可读结果](dashboard-e2e-results.json)。页面截图：[机器人](dashboard-acceptance/bots-desktop.png)、[群聊桌面](dashboard-acceptance/groups-desktop.png)、[群聊窄屏](dashboard-acceptance/groups-mobile.png)。

## 复验

在仓库根目录、依赖与 Chromium 已安装且 Web 已构建时运行：

```sh
node node_modules/vitest/vitest.mjs run
node --conditions=development --import tsx scripts/e2e-lark-management.mts
```

构建采用现有 TypeScript/Vite/服务端构建脚本；未修改依赖或锁文件。原有分析与方案见 [设计分析](lark-dashboard-management-design.md)。Herdr 中的 ccflash 完成前端及返修；普通 `claude --dangerously-skip-permissions` 因未登录无法执行，服务端由主控完成，独立 Codex 负责复查。
