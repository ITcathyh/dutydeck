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

## 3. Session Insight (待授权 / 本地联调)

- **项目来源**: https://github.com/ITcathyh/session-insight
- **固定参考版本**: commit `0bf5f1c95e89384f6379357aa515d385b2bf4e1e`
- **使用范围**: 内置或分发的预编译二进制执行文件（`dist/assets/session-insight/*/session-insight`）
- **许可与分发声明**:
  上游原项目标注为 `Private project. Not licensed for redistribution.`，尚未提供开源许可证或公开发布授权。
  目前仅用于本地联调与测试，未经授权不得随正式发行包对外分发。待权利人确认授权后补齐许可证全文。
