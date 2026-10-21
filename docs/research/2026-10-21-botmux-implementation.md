# Botmux 近期提交融入 Dutydeck：实施与验收

2026-10-21。代码验收版本：`201e800de33a14dc01002cb35c81db5aeffd470c`；Dutydeck 起点：`97f0275b568790097c1c04ce29bdd2b4d6799d47`。

**14 项全部完成，Astra 独立审查通过，构建、类型检查、整仓测试与 smoke 全部通过。** 本报告记录用户要求的完整 P0–P3 范围，不按实施批次拆结论。实现使用 Sol；协议分析与独立审查使用 Astra。

Botmux 已从 `81f97825126938f5ad50d5354062eb937bcb6768` rebase 至 `6025e5a8f8276a94889307240df02c44f310ce0f`，无冲突。本轮审阅固定区间含 125 个提交、124 个 first-parent 提交；本地 HEAD 与已拉取的 `origin/master` 差距为 0/0。候选选择及不建议移植的内容见[原始完整分析](2026-10-21-botmux-review.md)。

## P0–P3 完成范围

本轮未确认 P0。P1 五项、P2 六项、P3 三项均已实现。

| 级别 | 改动及实际效果 | 上游参考 | 验证重点 |
| --- | --- | --- | --- |
| P1 | Claude 回答后写记忆时，最终卡保留本轮有效回答；只识别真实同轮、指定记忆目录、成功配对的 Write/Edit | `1d7dbbfe3` | 原生 transcript→tailer→卡片；业务文件、失败写入、旧轮次不提升为答案 |
| P1 | Agent/Bash/Monitor 原生后台任务单独跟踪；独立后台工作不阻塞已回答的主回合，晚到通知不吞下一轮正文 | `f89419093` | 实际 JSONL 样本、主/后台状态、TaskStop/到期、单次新输入与旧通知交错；原必要子任务等待测试保留 |
| P1 | 飞书卡片字符串 value 先归一再合并表单；操作者和会话身份仍取可信事件 | `7d0a0d7e5` | 真实注册回调、对象/字符串/表单组合、恶意身份字段与重复回调 |
| P1 | SSE 增加命名心跳、静默恢复、旧连接隔离、单次重连调度；每次回前台立即补查状态 | `6f7182642` | 实际 HTTP 心跳不占事件序号；零/一心跳、代理缓冲、短/长隐藏、旧回调、分页补偿 |
| P1 | Unix socket 按字节预算选择短路径；初始化失败安全拒绝并清理自有资源 | `ad545ca54` | Linux 长 TMPDIR、非 ASCII、权限/监听故障、旧目录安全清理 |
| P2 | relay 在启动时初始化 stderr，避免终端关闭后延迟初始化干扰退出 | `d7c65f0d6` | 独立 tmux 与真实 Node relay/忽略 SIGHUP 子进程退出 |
| P2 | 精确识别 Codex 容量不足，区别于配额、鉴权、限流和其他失败 | `bbd4b3a23` | 原生已绑定终态、精确枚举/句子和反例 |
| P2 | 正向识别 Codex 模型迁移菜单，选择保留现有模型，再确认回到输入区 | `b1fc8a2b3` | 固定上游原生菜单样本、唯一高亮、未知屏不猜键、次数上限 |
| P2 | 可信插件可直接生成私有文件；模型只得到固定回执，原请求人经独立飞书 OAuth 下载 | `67e9ac6f3`、`dd97eeac6` | 真实插件安装→CLI 子进程→HTTP 身份解析→BLOB→回执→浏览器授权下载；Bob/错误应用/旧轮次/CSRF 拒绝 |
| P2 | 周期任务可请求停用自身计划；只在原轮次成功且确认交付后执行，用户修改计划后旧请求失效 | `85de606a7` | 原 actor/attempt/代际、CAS、落库后丢回执、撤权、失败/未知交付、用户重新启用 |
| P2 | 自定义静态 Card 2.0 body 进入现有唯一最终结果账本；明确拒收不另发替代正文 | `3295fbf16` | 冻结摘要/body、白名单、原回复路由、并发/重启、拒收状态与成功交付分开记账 |
| P3 | 已确认可安全重试的 Codex 容量失败最多自动重试两次，等待 30/90 秒并持久化；新输入或停止取消尚未提交的重试 | `bbd4b3a23` | preparing/授权等待竞争、提交原子检查、重启恢复、原身份复验；已提交或未知结果不盲目重放 |
| P3 | 最终结果支持 `publish`、`reply-agent`、`both`，各目的地独立确认，只补发缺失部分 | `d888b72d0` | 全部执行终态、原身份和目标冻结、丢回执/撤权恢复；历史验收恢复不能把回传文本当卡片 PATCH |
| P3 | 裸 `/new` 结束真实 worktree 会话后，提供旧会话工作目录入口，登录后可直接展开 | `b76c3afbc` | 实际 App/AuthGate/归档会话深链；打开链接不预览或删除，原忙/脏目录保护仍生效 |

## 可用入口

- 自定义最终卡：`dutydeck agent group send '可检索摘要' --final --card-file body.json`。body 上限 28,000 字节，宿主管理身份、回复位置、状态和唯一投递。
- 选择投递目的地：上述命令加 `--delivery publish|reply-agent|both`；仅回传模式不接受发布卡片。
- 周期任务自停：`dutydeck agent schedule stop-self`，不接受任意计划编号。
- 受控插件：`dutydeck plugin-tool list --turn <token>`；`dutydeck plugin-tool call <plugin/tool> --json '<JSON>' --call-id <稳定ID> --turn <token>`。
- 完整中文/英文操作说明见 [README](../../README.md)、[README.en](../../README.en.md)；实际示例见 [private-export](../../examples/plugins/private-export/README.md)。

受控插件新增独立四表及 migration 40；既有数据库升级、外键、旧数据保留与失败回滚均纳入回归。容量重试复用现有 TaskAttempt JSON，无新增执行账本表。没有新增 Dashboard 设置项；公开设置入口仍沿现有 CLI。

## Astra 独立审查与返修

两位未参与实现的 Astra 审查者覆盖完整非插件差异、插件完整链路、后续修复，以及双语文档和来源声明。最终均为 **PASS_WITH_LIMITATIONS**，没有未解决的阻塞 finding。

| 已确认问题 | 级别 | 修复与独立复验 |
| --- | --- | --- |
| 容量重试已进入 preparing 时，新输入仍可能让旧输入再次提交 | P1 | 提交前取消范围及原子检查补齐；实际发送从 `old, old, new` 变为 `old, new` |
| 旧后台通知使下一轮正文和终态被吞掉 | P1 | 按原生输入/通知 ancestry 区分；单次 B 输入即可正常完成，A 后记不进入 B |
| 自定义卡被明确拒收后又发布默认正文 | P2 | 冻结意图仍有效；固定失败状态回执不计业务交付成功 |
| 仅回传模式在任务失败/中断/取消后改为群内发布 | P1 | 所有终态读取冻结模式；文本回执不绑定卡片验收、不进入 PATCH |
| 短暂隐藏后回前台没有立即校准 | P2 | 健康连接可保留，每次真实回前台仍校准一次 |
| 历史已验收记录在重启后把回传文本重新绑定为结果卡 | P2 | 恢复绑定和反馈更新都核对持久账本中的完整原 scope/attempt 与消息类型 |
| 浏览器登录先被 `Origin:null` 拒绝，随后又被 CSP 阻止跳转 | P1 | 公开壳保留同源 Origin，CSP 只允许后端可信 OAuth origin；严格 nonce/Origin 不放宽，回调/文件仍不发送 referrer |

非插件原六个独立探针全部通过；最后独立正式回归 3 文件、175 项通过。插件原两个 Chromium 探针各访问 OAuth 一次、无 CSP 错误；固定代码版本上独立回归 17 文件、348 项通过，含 Alice 下载、Bob 与跨源请求拒绝。两个固定 Botmux transcript fixture 经独立逐字节核对；三段既有许可证全文未变，来源见 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)。

## 整体验证

以下命令在独立整合 worktree、固定代码版本 `201e800d` 上执行，使用临时数据库、空闲端口、假 CLI/provider 和独立 tmux，未执行生产部署。

| 命令 | 实测结果 |
| --- | --- |
| `pnpm build` | 通过 |
| `pnpm typecheck` | 全 workspace 通过 |
| `pnpm vitest run --maxWorkers=4 --reporter=json --outputFile=/tmp/dutydeck-integrated-final-tests.json` | 668 个文件，10,841 项通过、0 失败，原有 20 项跳过；进程退出码 0 |
| `pnpm smoke --port 0 --artifact-dir /tmp/dutydeck-botmux-final-smoke` | 68 项断言通过，浏览器、临时服务/目录、SSE 与独立终端清理通过 |

首轮完整测试为 10,793 通过、39 失败、20 跳过：38 项旧测试仍期望 migration 39，已逐项更新为明确版本 40，旧数据/FK/回滚断言保留；另有一项未改动的 terminal-stream 固定等待时序断言，单独重跑 6 项通过，原断言在最终完整运行中也通过。最终运行限制为 4 个 worker，全部用例仍参与；没有通过删除断言或跳过失败用例完成验收。

## 验证边界与交付状态

- Linux 本机 PTY/tmux/Unix socket、实际 Chromium、真实 SQLite 与 HTTP 链路已测；真实付费 Claude/Codex 服务、macOS 故障触发、真实飞书应用 OAuth 配置和生产反代未实测。
- 插件结果保护限定在受控 API；不承诺隔离恶意可信 JavaScript 插件或具有同 UID 主机文件访问能力的人。实际启用仍需安装可信插件并配置网页登录回调。
- SSE 已观测为缓冲的链路免于按静默强制重连；无法绝对识别这类链路所有静默故障，回前台会主动补查。零/一心跳未知链路使用保守恢复门限。
- 不将网络不确定时的固定 UUID 重试称为无限期 exactly-once。未知执行不自动重跑，通知重试受已有一小时窗口限制。
- 所有代码、测试、双语说明和来源声明均在独立 worktree 完成并验证。未推送、部署、重启生产，未修改 `.env`、systemd、凭据或生产数据库。
