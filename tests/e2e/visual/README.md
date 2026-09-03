# 视觉 e2e

断言**真实渲染的计算样式**，不是源码里的类名字符串——类名对了但 CSS 没生效
（token 没定义、被更高优先级覆盖、Tailwind 没生成那条规则）在类名断言里是绿的，
在这里是红的。这是 `tests/e2e/botmux-parity/`（全是后端契约）没覆盖的那块洞。

## 跑

```bash
# 只跑视觉 e2e
npx playwright test --config tests/e2e/visual/playwright.config.ts

# 单条
npx playwright test --config tests/e2e/visual/playwright.config.ts -g "侧栏宽 248px"

# 连同三道回归闸一起（推荐，见下）
node scripts/verify-redesign.mjs
```

服务绑外部主机名而非 loopback，`127.0.0.1` 会 ERR_CONNECTION_REFUSED。
默认打 `http://10.37.33.49:4310`，换实例设 `DOCKMUX_E2E_BASE_URL`。

**这些用例读的是 `apps/web/dist` 的构建产物，不是源码。** 改完源码要
`pnpm build` 才能看到变化（服务从磁盘读，不必重启）。曾经因为这个把已经改好的
色板测成全红。

## 红 / 绿的含义

标题前缀就是状态，不用去翻代码：

| 前缀 | 含义 |
|---|---|
| `[红→绿]` | **改版目标**。写下时是红的，改完该变绿。红转绿的条数 = 进度条。 |
| `[绿]` / `[绿·护栏]` | **不许弄坏**。现在就是绿的，变红说明改版碰坏了东西。 |

`scripts/verify-redesign.mjs` 按这个前缀分别统计，护栏变红会单独告警。

## 文件

| 文件 | 作用 |
|---|---|
| `redesign-contract.ts` | 验收目标的**唯一数值来源**（顶栏 56px、侧栏 248px、品牌色相区间…）。改目标改这里，不要散在断言里。 |
| `color.ts` | 颜色度量：rgb 解析、转 HSL、相对亮度、「灰阶不带绿」判据。 |
| `fixtures.ts` | 页面装配：主题落地、等待策略、沿祖先链取有效背景色。 |
| `palette.spec.ts` | 品牌色是靛蓝、灰阶不带绿。 |
| `shell.spec.ts` | 顶栏、侧栏宽度与形态、侧栏跟随主题、侧栏分组导航。 |
| `pages.spec.ts` | 详情页 / 设置浮层 / 命令面板。 |

## 两个反直觉的地方

**`waitUntil: 'networkidle'` 在详情页永远不触发。** 那页开着 SSE 长连接，实测
30s 超时。统一走 `domcontentloaded` + 等 DOM 锚点（`settle()`），别改回去。

**「灰阶不带绿」的容差必须是 0。** `--surface-canvas` 改版前是 `#f5f7f6`，
G-B 恰好等于 1；留 1 的容差会把要抓的缺陷整个放过去（实测 tolerance=1 时这条
断言全绿）。这些是从 token 直接解析的不透明色，没有抗锯齿舍入要吸收。

## 截图存档

```bash
node scripts/shoot-redesign.mjs before --botmux   # 改造前基线 + botmux 参照
node scripts/shoot-redesign.mjs after             # 改造后
```

写到 `docs/assets/redesign-{tag}/`，命名 `{page}-{viewport}-{theme}.png`，
同一格子的 before/after 文件名完全一致，便于并排比。附 `manifest.json` 记录
来源 URL 与时间。

`--botmux` 只在 botmux dashboard 确实活着时才截，没跑就跳过，不去硬启别人的
守护进程。
