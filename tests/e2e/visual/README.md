# Calm Workbench 视觉验收

断言 Chromium 真实计算样式与可访问语义。标准来自 `dutydeck-prototype.html` 和设计方案 §14/15：暖白、石墨、橙棕强调色，贴左全高侧栏，桌面 61px / 移动 54px 顶栏。宽度默认 234px、可在 208–320px 调整，移动触控目标至少 44px。

```bash
# 先构建；只指向隔离测试实例的随机端口，不使用线上 4310。
DUTYDECK_E2E_BASE_URL=http://127.0.0.1:<test-port> pnpm exec playwright test -c tests/e2e/visual/playwright.config.ts
# 自行启动/清理隔离服务，覆盖真实 HTTP、SQLite、Git、mock ACP/PTY CLI 与浏览器操作。
pnpm exec playwright test -c tests/e2e/acceptance/playwright.config.ts --project=core calm-workbench.spec.ts
```

`DUTYDECK_E2E_BASE_URL` 必填。视觉用例读取 `apps/web/dist`，源码变更后须重新 build。视觉主题同时覆盖显式选择与跟随系统；详情页有 SSE，因此等待 `domcontentloaded` 加真实界面锚点，不等待 `networkidle`。

| 文件 | 验收内容 |
| --- | --- |
| `redesign-contract.ts` | 颜色与几何标准的数值来源 |
| `color.ts` | 色相、低彩度、亮度与文字对比度 |
| `palette.spec.ts` | 真实主操作橙棕色、暖白画布、正文对比度 |
| `shell.spec.ts` | 顶栏、贴边侧栏、独立主导航、主题、移动触控目标 |
| `pages.spec.ts` | 详情能力门控、设置与命令面板语义、关闭与溢出 |
| `ux-navigation.spec.ts` | 审批首屏、指定 Agent 创建、凭据对象、浮层焦点、证据与历史 |
| `../acceptance/calm-workbench.spec.ts` | 草稿/引用/发送竞争、搜索定位、键盘布局、390px 主流程与截图 |

标题 `[红→绿]` 代表原型改造目标，`[绿]` 代表保留的功能护栏，供 `scripts/verify-redesign.mjs` 汇总。旧版靛蓝、冷灰通道和悬浮侧栏目标已由本次原型取代；审批事实、能力边界、焦点管理与真实功能断言仍保留。

Calm 验收最后一个测试保存 1440px / 390px、明暗两种主题的工作台、对话、真实改动、结果检视截图，写到本轮 `artifacts/e2e/<run-id>/test-results/`。CLI、任务和代码差异均为隔离夹具，截图不代表线上执行。
