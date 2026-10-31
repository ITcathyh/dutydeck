# Third-Party Notices / 第三方开源许可与版权声明

Dutydeck 源码中包含或派生自以下第三方开源项目的代码与资源。本文件记录这些组件的来源、版权声明及对应许可证全文。

本文件仅记录源码仓库中直接吸收、派生或内置的第三方内容，不替代 `package.json` 中声明的各外部 npm 依赖包各自自带的许可证与版权声明。

---

## 1. Botmux

- **项目来源**: https://github.com/deepcoldy/botmux
- **固定参考版本（原移植范围）**: commit `ba847cae5d190e6c87a3c57452074921be3d1c58`
- **新增参考快照（2026-10-02）**: commit `fd8a3d953c644bf47c144ea26afd4f2f1c4af1eb`
- **实际移植与派生代码范围**:
  目前已确认的移植或派生实现包括：
  - `packages/cli-adapters`: 部分 CLI 适配层接口与命令行参数构建逻辑；
  - `packages/session-backends`: 部分会话后端管理、进程生命周期控制与能力抽象；
  - `packages/pty-driver`: PTY 驱动、空闲检测机制（idle detection）及 transcript 解析逻辑（`packages/pty-driver/src/transcript`）；
  - `packages/terminal-renderer`: 虚拟终端与终端输出序列化渲染；
  - `packages/relay/src/cli-contract.ts`: 移植并对齐了源 CLI 交互退出码契约（`relayAskExitCodes`）；
  - `apps/server/src/lark/chat-mode.ts`: 移植了群形态（话题群与普通群模式切换）识别及带 TTL 缓存的 helper。

  新增快照的参考与派生范围：
  - `packages/shared/runtime/child-environment.mjs`: 参考会话身份环境键集合、`cli-identity/<session>.bin` 路径识别与关联 shell/git 环境清理规则，并用于 PTY、ACP 及 Herdr 子进程环境隔离；
  - `packages/pty-driver/src/transcript`: 参考新版原生 CLI transcript 事件的识别与归一化机制；
  - `packages/cli-adapters`、`packages/pty-driver`、`packages/session-backends`: 参考输入提交回执机制，将原生 CLI 输入写入结果传递到运行时。

  2026-10-15 新增的实际派生与保留材料：

  - `apps/server/src/lark/resource-range-download.ts`：区间响应校验、固定 offset 写入和重试前截断做法适配自 commit `1b6e05358cfa85b2b0d1a2c0353e9952f29ce0b8` 的 `src/im/lark/resource-range-download.ts`；保留 Botmux 版权声明，按下列 MIT 许可使用。
  - `packages/pty-driver/src/transcript/fixtures/traex-0.209.1-rollout.jsonl`：从 commit `81f97825126938f5ad50d5354062eb937bcb6768` 的 `test/fixtures/traex-tape/two-turns.json` 提取 TraeX 0.209.1 的 12 条 rollout 记录（4697 字节），未复制完整 PTY 录像包；按下列 MIT 许可使用。

  - `packages/cli-adapters/src/fixtures/traex-startup/0.209.1-footers.json`：从同一 `81f97825126938f5ad50d5354062eb937bcb6768` 的 `test/fixtures/traex-tape/two-turns.json` 渲染并脱敏提取 12 个 TraeX 0.209.1 状态切换视口（10150 字节），未保留完整 549-chunk 录像；按下列 MIT 许可使用。

  2026-10-17：`packages/session-backends/src/program-status-{parser,probe-relay,relay}.ts` 与 `packages/pty-driver/src/idle-detector.ts` 的 OSC 7501 分帧、pane 内握手和权威状态逻辑参考并适配自 botmux（握手中继 commit `4dfd7c0de`），按下列 MIT 许可使用。

  原生终态、TraeX 分段与 canonical 适配另参考 `bf6507dd4`、`0f332b75a`、`20e5f32cf`、`9308dbc90`；上述既有 transcript 派生范围继续适用。终端就绪与提交语义修复参考 `3c5371bef90a1f52633c2d632760ed01c171c28b`、`69ed3c2dde5ce8714ff529f4de50da68d943fead`、`0623210c2bdc9b5bb351bd9f1334925c0ec8099c`、`0064e4e6a`，没有复制官方 Codex/Cursor 发行源码。问答、图片提取、投递保护、timer、模型探测和子任务诊断修复按 Dutydeck 现有接口独立实现，相关上游设计参考不表示复制其全部实现。

  2026-10-21 新增的实际派生、复制材料与设计参考：

  - `packages/pty-driver/src/fixtures/claude-background-tasks/{before-clear,after-clear}.jsonl`：从 commit `f894190935bc994ef46ff8c03c4eefc613cd27e8` 的 `test/fixtures/claude-background-tasks/` 原样复制两份已脱敏原生 JSONL 样本；样本中的命令不执行，按下列 MIT 许可使用。后台生命周期解析参考该提交的 `src/services/claude-transcript.ts` 所用结构化启动、通知、Monitor 与 TaskStop 约定，按 Dutydeck 数据流独立实现。
  - `apps/web/src/sse.ts`：心跳节奏判定、旧连接所有权隔离与后台挂起设计参考并适配自 commit `6f7182642d271991ceb3f84b8389d90ed1c7e03e` 的 `src/dashboard/web/store.ts`，按下列 MIT 许可使用。保留 Dutydeck 的 EventSource 退避、sequence 游标、分页恢复和查询校准，并增加零/一心跳启动门限与完整销毁；新增测试独立编写，未复制上游 fixture。
  - `packages/session-backends/src/program-status-relay.ts`：在既有派生中继上应用 commit `d7c65f0d6` 的提前初始化 stderr 修复，按下列 MIT 许可使用。
  - Claude memory 正文保留行为参考 `1d7dbbfe3`，socket 字节预算与失败清理参考 `ad545ca54`，Codex 容量判别参考 `bbd4b3a23` 的 `src/services/codex-transcript.ts`，模型迁移菜单判定参考 `b1fc8a2b3` 的 `src/utils/codex-model-migration-dialog.ts`。这些实现按 Dutydeck 现有接口独立编写，未复制上游宽泛正文提取、重试调度器或 worker 状态机。菜单测试文字转录自该工具记载的 Codex 0.162.1 原生画面样例（`Meet GPT-6 Sol`、两项模型选项和确认页脚），不是本次真实 Codex 运行采集或复制的上游 fixture 文件。
  - 受控插件结果的产品协议参考 `67e9ac6f3`、`dd97eeac6`，OAuth 字段链另参考 Botmux `src/utils/user-token.ts`。工具注册、SQLite 结果存储、独立 viewer session 与 CLI 按 Dutydeck 既有机制独立实现，未复制上游 MCP/stdio envelope、sandbox、业务 scope 集合或 token 持久化/刷新实现。`examples/plugins/private-export/` 和 `tests/fixtures/private-export-agent.mjs` 是本次构造的合成示例与测试，未复制上游业务数据或凭据。

  2026-10-31 新增派生与协议参考 / additions and protocol references：

  - `packages/session-backends/src/spawn-pty.ts`：Unix PTY 退出补读适配自 Botmux `8c8f232305163bf940bb15f52b1aa5414e4e709e`，由直接终端、pane 中继和兼容 transport 共用，按下列 MIT 许可使用；未移植上游 Bun 读循环。 / The shared Unix exit-drain adapter derives from this MIT-licensed commit; the upstream Bun read loop was not ported.
  - `packages/pty-driver/src/claude-native-session.ts`：原生 PID 状态与可恢复会话内容协议参考 `f54efb8b889`、`17296ac7fba`；本轮进程出生身份核验、来源归属及执行账本接线按 Dutydeck 接口独立实现。 / Native PID-state and resumable-content contracts reference these commits; the new process-identity proofs, ownership checks and ledger integration are independently implemented for Dutydeck.
  - `packages/pty-driver/src/fixtures/claude-native-session.mjs`：本仓构造的 Node 子进程与原生协议格式合成夹具，不是官方 Claude 源码、模型输出录像或从真实会话脱敏提取的记录。 / This repository-created Node-process/protocol fixture is synthetic, not official Claude source, recorded model output or a sanitized real-session capture.
  - 附件持有者与实例隔离设计参考 `66a0b309a`、`61627ff9f`；目标应用身份校验原则参考 `c251c8655`、`ffc70e755`。`apps/server/src/resource-retention.ts`、附件持久引用及配置保存校验按既有 inbox、执行账本和身份 helper 独立适配，未复制上游会话存储结构。 / Attachment ownership/isolation and target-app identity principles reference these commits; retention, durable references and save validation adapt Dutydeck's existing inbox, ledger and identity helpers without copying upstream session storage.
  - Bot 字段搜索设计参考 `33aef3d50`、`36b27cd4f`，宿主直查命令方向参考 `e7e035516`，均在 Botmux 快照 `313e0166182eaf7beda7e47dd260c53f9a686716` 下对照。搜索定位、公开 SDK 的聊天输出声明、授权及投递按 Dutydeck 既有接口独立实现；fake-ticket 状态示例与新增测试材料为本仓合成，不包含上游业务数据。 / Settings search and host query commands reference these designs at the stated snapshot. Navigation, public SDK chat-output opt-in, authorization and delivery are independently implemented; the fake-ticket status example and new test data are synthetic and contain no upstream business data.

- **版权与许可证全文**:

```
MIT License

Copyright (c) 2026 botmux contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. SVG Spinners (bouncing-ball)

- **项目来源**: https://github.com/n3r4zzurr0/svg-spinners/blob/main/svg-smil/bouncing-ball.svg
- **使用范围**: `apps/server/src/lark/assets/dutydeck-bouncing-ball.webp`（动画素材源于 bouncing-ball.svg），相关许可证同时保存在 `apps/server/src/lark/assets/SVG-SPINNERS-LICENSE.txt`。
- **版权与许可证全文**:

```
The MIT License (MIT)

Copyright (c) Utkarsh Verma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 3. Session Insight 测试材料来源

- **项目来源**: https://github.com/ITcathyh/session-insight
- **参考版本**: commit `0bf5f1c95e89384f6379357aa515d385b2bf4e1e`
- **保留范围**: `tests/fixtures/session-insight/upstream-sanitized/` 的脱敏测试材料；来源与样本性质详见 `tests/fixtures/session-insight/README.md`。
- **许可说明**: 上游标注为 `Private project. Not licensed for redistribution.`，未记录再分发授权。上述材料仅用于仓库内测试，不随 npm 包发布。
- **运行时**: Dutydeck 使用仓库内独立实现的 TypeScript 分析器，构建为 `dist/assets/session-insight/cli.js`；发布包不包含上游 Go 源码或二进制。本条来源记录不授予上游代码或测试材料新的许可。

---

## 4. i-have-adhd

- **项目来源**: https://github.com/ayghri/i-have-adhd
- **参考版本**: commit `723af7d9afaf43eb871dbcce6129e2bf80de90d5`
- **派生范围**: `apps/server/src/lark/adhd-mode.ts` 的回复规则改编自 `skills/i-have-adhd/SKILL.md`（中文改写并去掉了技能唤起与会话保持的说明）。
- **版权与许可证全文**:

```
MIT License

Copyright (c) 2026 Ayoub Ghriss

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
