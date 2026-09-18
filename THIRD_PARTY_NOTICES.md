# Third-Party Notices / 第三方开源许可与版权声明

Dutydeck 源码中包含或派生自以下第三方开源项目的代码与资源。本文件记录这些组件的来源、版权声明及对应许可证全文。

本文件仅记录源码仓库中直接吸收、派生或内置的第三方内容，不替代 `package.json` 中声明的各外部 npm 依赖包各自自带的许可证与版权声明。

---

## 1. Botmux

- **项目来源**: https://github.com/deepcoldy/botmux
- **固定参考版本**: commit `ba847cae5d190e6c87a3c57452074921be3d1c58`
- **实际移植与派生代码范围**:
  目前已确认的移植或派生实现包括：
  - `packages/cli-adapters`: 部分 CLI 适配层接口与命令行参数构建逻辑；
  - `packages/session-backends`: 部分会话后端管理、进程生命周期控制与能力抽象；
  - `packages/pty-driver`: PTY 驱动、空闲检测机制（idle detection）及 transcript 解析逻辑（`packages/pty-driver/src/transcript`）；
  - `packages/terminal-renderer`: 虚拟终端与终端输出序列化渲染；
  - `packages/relay/src/cli-contract.ts`: 移植并对齐了源 CLI 交互退出码契约（`relayAskExitCodes`）；
  - `apps/server/src/lark/chat-mode.ts`: 移植了群形态（话题群与普通群模式切换）识别及带 TTL 缓存的 helper。

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
