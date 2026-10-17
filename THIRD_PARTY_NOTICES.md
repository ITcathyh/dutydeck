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
