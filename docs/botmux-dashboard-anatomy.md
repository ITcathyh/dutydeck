# Botmux Dashboard 结构解剖

> 目标：把 botmux dashboard 的**布局骨架与信息架构**拆到可复刻的粒度。
> 所有行号基于 `/data00/home/huangyuhang.edu/ai/botmux/src/dashboard/web/`，快照时间 2026-09-03。
> 下文凡写 `style.css:8436` 均指该目录下的文件。

---

## 0. 读之前必须知道的两件事

### 0.1 有两份 token，后加载的那份赢

`index.html:18-19`：

```html
<link rel="stylesheet" href="/assets/style.css">        <!-- 31861 行 -->
<link rel="stylesheet" href="/assets/design-tokens.css"><!-- 236 行 -->
```

`design-tokens.css` 在后，两者都写 `:root`，**同优先级后来居上**。所以 `style.css:5-95` 和 `style.css:8100-8131` 里那两组 `:root` 定义的同名 token **全部是死值**。构建脚本 `scripts/build-dashboard.mjs:35` 确认两份都会拷进产物。

实际生效的差异（左边死值，右边生效值）：

| token | style.css（死） | design-tokens.css（活） |
|---|---|---|
| `--accent` | `#565ee4` | `#4f56e8` |
| `--border` | `#cbd4df` | `#e3e6ee` |
| `--radius-md` | `10px` | **`8px`** |
| `--radius-lg` | `14px` | **`12px`** |
| `--radius-xl` | `= --radius-lg` | **`16px`**（独立档） |
| `--button-height` | `34px` | **`32px`** |
| `--button-compact-height` | `34px` | **`28px`** |
| `--button-padding-x` | `15px` | `14px` |

**但布局变量是反过来的**——`design-tokens.css` 定义了 `--topbar-h: 56px` / `--sidebar-w: 248px`（`:117-118`），而 topbar 自己用的是另一个名字：

| 变量 | 定义处 | 被谁用 |
|---|---|---|
| `--topbar-h: 56px` | `design-tokens.css:117` | 只有 1 处：`style.css:8203` 侧栏的 `top` 计算 |
| `--topbar-height: 60px` | `style.css:60`、`style.css:8127` | topbar 自己的 `min-height`（`:8444`），共 4 处 |
| `--sidebar-w: 248px` | `design-tokens.css:118` | `style.css:8197`、`:8207`（都带 `, 248px` 兜底） |
| `--sidebar-width: 236px / 190px` | `style.css:59`、`style.css:8126` | **0 处引用，死配置** |

> **实际渲染：topbar 高 60px，侧栏宽 248px。**
> 题面说的「顶栏 56px」是 token 名义值，侧栏用它算自己的 `top` 偏移，于是侧栏顶边比 topbar 底边少 4px——这是个既存的 off-by-4，不是设计意图。复刻时统一成一个变量即可。

### 0.2 `.page` 作用域会二次覆盖全局组件样式

文件靠后有一段 `.page :where(...)` 的重写（`style.css:13981+`、`15841+`）。几乎所有真实页面都套在 `.page` 里，所以**文件前部 `button` / `.card` 的全局定义不是用户看到的样子**。详见 §E。

---

## A. 整体外壳

### A3. 组合方式（先说结构，后面 1/2 才有坐标系）

**顶栏横向贯穿到顶，侧栏在顶栏下面。但侧栏不是栅格列——它是 `position: fixed` 的悬浮卡片。**

JSX 骨架，`app.tsx:1266-1378`：

```
<>
  <div className="aurora">          ← 固定背景光斑，仅暗色主题（app.tsx:1268）
  <div className="app-shell">       ← flex column, height:100dvh, overflow:hidden
    <header className="topbar">     ← sticky top:0, 贯穿全宽
      <div className="topbar-left">     品牌 + 版本 chip
      <div className="topbar-actions">  状态菜单 / 语言 / 主题 / 文档 / 头像
    </header>
    <div className="chrome-body">   ← flex:1, display:BLOCK（不是 grid！）
      <aside className="sidebar">   ← position:fixed，脱离文档流
      <div className="workspace">   ← margin-left 让位给 fixed 侧栏
        <dialog id="create-session-modal">
        <BotOnboardingDialog>
        <main id="root">            ← 路由页面挂载点，唯一的滚动容器
      </div>
    </div>
  </div>
  <AuthExpiredOverlay> <ToastStack> <ConfirmModalRoot>
</>
```

CSS，`style.css:8167-8215`：

```css
.app-shell {
  position: relative; z-index: 1;
  height: 100dvh; min-height: 0;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.chrome-body {
  flex: 1; min-height: 0;
  display: block;                              /* 注意：块级，不是 grid */
  padding: 16px var(--chrome-x) 24px 0;        /* --chrome-x: 32px */
  overflow: hidden;
}
.workspace {
  min-width: 0; min-height: 0;
  height: 100%;
  display: flex; flex-direction: column;
  overflow: visible;
  margin-left: calc(var(--sidebar-w, 248px) + 48px);   /* 248 + 48 = 296px */
}
.sidebar {
  position: fixed;
  top: calc(var(--topbar-h) + 16px);   /* 56 + 16 = 72px */
  bottom: 16px;
  left: 16px;
  z-index: 15;
  width: var(--sidebar-w, 248px);
  display: flex; flex-direction: column;
  padding: var(--sp-4) var(--sp-3);    /* 16px 12px */
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);     /* 12px */
  background: var(--surface);
  box-shadow: var(--sh-md);
  overflow-y: auto;
}
```

ASCII（桌面 ≥981px）：

```
┌────────────────────────────────────────────────────────────────┐
│ .topbar   sticky top:0  z-20  min-height:60px  padding:0 32px  │
│ ┌──────────────┐                        ┌───────────────────┐  │
│ │ topbar-left  │      (中列留空)         │  topbar-actions   │  │
│ └──────────────┘                        └───────────────────┘  │
│  grid-template-columns: max-content minmax(220px,1fr) max-content
├────────────────────────────────────────────────────────────────┤
│ .chrome-body   display:block   padding:16px 32px 24px 0         │
│                                                                 │
│  ┌──────────────┐ ←16px 间隙→ ┌──────────────────────────────┐ │
│  │  .sidebar    │              │ .workspace                   │ │
│  │  FIXED       │              │  margin-left: 248+48 = 296px │ │
│  │  left:16px   │              │  ┌────────────────────────┐  │ │
│  │  top:72px    │              │  │ main#root              │  │ │
│  │  bottom:16px │              │  │  overflow-y: auto      │  │ │
│  │  w:248px     │              │  │  ← 唯一滚动容器         │  │ │
│  │  r:12px      │              │  │  padding:12px 32px 24px 0│ │ │
│  │  卡片+阴影    │              │  │                        │  │ │
│  └──────────────┘              │  └────────────────────────┘  │ │
│                                 └──────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

关键点：
- **侧栏是悬浮卡片，不是栅格列**。它四周留 16px 空隙、有 12px 圆角和 `--sh-md` 阴影，视觉上「浮」在背景上。`.chrome-body` 因此不需要 grid，直接 `display:block`，靠 `.workspace` 的 `margin-left: 296px` 让位。
- 侧栏与主区之间的 48px 中，16px 是侧栏左边距、248px 是宽度，剩下 296-16-248 = **32px 是视觉间隙**。
- **`main` 是唯一滚动容器**（`style.css:387-396`）。`.app-shell` 和 `.chrome-body` 都是 `overflow:hidden`，topbar 和侧栏永不滚动。
  ```css
  main {
    width: calc(100% + var(--chrome-x));
    max-width: none;
    flex: 1; min-height: 0;
    margin-right: calc(-1 * var(--chrome-x));   /* 负 margin 把滚动条推到视口边缘 */
    padding: 12px var(--chrome-x) 24px 0;
    overflow-x: hidden; overflow-y: auto;
  }
  ```
  负 margin + 等量 padding 的组合，让滚动条贴在视口右缘而不是内容区右缘——内容仍有 32px 右留白。

> **botmux 做得好的地方**：滚动容器唯一且明确。topbar/侧栏在 `overflow:hidden` 的祖先里，天然不参与滚动，不需要任何 `position:sticky` 补丁去「钉住」它们。

### A1. 顶栏（实际 60px）里有什么

`app.tsx:1270-1324`，`style.css:8436-8452`：

```css
.topbar {
  position: sticky; top: 0; z-index: 20;
  display: grid;
  grid-template-columns: max-content minmax(220px, 1fr) max-content;
  align-items: center;
  column-gap: 16px;
  min-height: var(--topbar-height);          /* 60px */
  padding: 0 var(--chrome-x);                /* 0 32px */
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(16px);               /* 毛玻璃 */
  border-bottom: 0;                          /* 不用 border，用 ::after 渐变线 */
  box-shadow: 0 12px 36px rgba(0,0,0,.12);
}
```

分隔线不是 `border-bottom`，而是 `::after` 的**两端淡出渐变线**（`style.css:8453-8469`）：

```css
.topbar::after {
  content: ""; position: absolute;
  left: var(--chrome-x); right: var(--chrome-x); bottom: 0;
  height: 1px; pointer-events: none;
  background: linear-gradient(90deg,
    transparent 0%,
    color-mix(in srgb, var(--border) 58%, transparent) 16%,
    color-mix(in srgb, var(--border) 92%, transparent) 50%,
    color-mix(in srgb, var(--border) 58%, transparent) 84%,
    transparent 100%);
}
```

中列 `minmax(220px, 1fr)` **是空的**——没有全局搜索。左右两列靠 `justify-content: space-between` 顶开。

**从左到右：**

| # | 元素 | 类 | 内容与交互 | 尺寸 |
|---|---|---|---|---|
| 1 | 品牌链接 | `.brand` → `href="#/"` | 点击回概览 | `display:flex; gap:9px`（`:9020`） |
| 1a | Logo 图 | `.brand-mark` > `.brand-logo-img` | `/assets/brand-logo.png`，`fetchpriority=high` 预加载 | 28×28px，`border-radius:6px`（`:9075-9091`） |
| 1b | 字标 "Botmux" | `.brand-wordmark` | 渐变文字 + 8s 循环高光扫过 | 16px / italic / 650，`line-height:28px`（`:9036-9047`） |
| 1c | "Dashboard" | `.brand-product` | 同上但灰色渐变 | 16px / italic / 650（`:9049-9060`） |
| 2 | 版本 chip | `.dashboard-version-control` | 有新版本时展开更新面板，可刷新/回滚 | `margin: -2px 0 0 37px`，挂在品牌下方（`:9062-9066`） |
| — | *（中列空）* | | | `minmax(220px, 1fr)` |
| 3 | 会话总览按钮 | `.connection-status` `#status` | 点击/hover 展开状态浮层 | 高 `--topbar-control-size` = **38px**，`padding:0 12px`，`radius:999px`，11px/700（`:210-227`） |
| 4 | 语言切换 | `.topbar-locale-toggle` | 显示 `CN`/`EN`，点击切换并 `POST` 持久化 | **38×38px** 圆形（`:9318-9334`） |
| 5 | 主题菜单 | `.theme-menu-btn` | 自定义 listbox（原生 select 放不下 SVG 图标） | 38×38px 圆形 |
| 6 | 文档外链 | `.topbar-docs-link` | `deepcoldy.github.io/botmux`，`target=_blank` | 38×38px 圆形 |
| 7 | 用户头像 | `.topbar-owner` | 有头像显示图，否则 SVG 占位人形；`onError` 时移除 img | 38×38px 圆，`overflow:hidden`（`:9377-9389`） |

3–7 装在 `.topbar-actions`（`style.css:9091-9100`）：`display:flex; gap:14px; margin-left:auto; flex-wrap:nowrap`。其中 4/5/6 再套一层 `.topbar-tool-group`（`:9306-9314`）`gap:12px`。

**状态浮层**（`TopbarStatusMenu`，`app.tsx:454-545`）是顶栏唯一的复杂交互：

- 触发：点击 / hover / focus 三种；`Escape` 关闭并把焦点还给按钮（`app.tsx:502-508`）。
- **自动弹出**：待处理数从 0 变正数时自动展开 4 秒（`app.tsx:1212-1229`），但如果主题菜单开着就不抢（`:1221`）。
- 内容三段（`app.tsx:520-542`）：
  1. `.topbar-attention-notice` —— 最久未处理会话的一句话摘要 + 「去处理」链接到 `#/sessions`，仅在有待处理时出现
  2. `.topbar-status-list` —— 4 行 `label / 数字`：工作中、空闲、待处理（`hot` 时红）、在线 bot
  3. `.topbar-status-donut` —— **conic-gradient 甜甜圈**，`app.tsx:432-438`：
     ```js
     `conic-gradient(var(--accent) 0 ${workingDeg}deg,
                     var(--warning) ${workingDeg}deg ${attentionDeg}deg,
                     var(--success) ${attentionDeg}deg 360deg)`
     ```
     中心叠数字总数。总数为 0 时退化为 `conic-gradient(var(--border) 0 360deg)` 灰环。

> **好在哪**：数字与图形共用同一份 `dashboardStatusSummary()`（`app.tsx:394-418`），不可能对不上；甜甜圈用 conic-gradient 而非 SVG/canvas，零依赖零布局抖动。

### A2. 侧栏（248px）完整结构

`app.tsx:1326-1361`。**没有折叠/展开**，宽度恒定 248px（工作台内的会话栏可折叠，那是另一套，见 §D）。

```
┌─ .sidebar ─────────────────────┐  fixed, 248px, padding:16px 12px
│ ┌ .sidebar-create-actions ───┐ │  ← 顶部固定操作区（仅登录后）
│ │  [+💬] 创建会话             │ │
│ │  [+🤖] 创建机器人           │ │
│ └────────────────────────────┘ │  border-bottom + margin/padding-bottom:10px
│                                 │
│ ┌ .sidebar-nav ──────────────┐ │  flex:1, overflow-y:auto
│ │  概览            ← 组标题   │ │
│ │    ▦ 工作台                 │ │
│ │  协作                       │ │
│ │    💬 会话控制              │ │
│ │    ▶ 驾驶舱                 │ │
│ │    👥 群组管理              │ │
│ │    🕐 定时任务              │ │
│ │    ⚙ 工作流                 │ │
│ │    🏢 办公室                │ │
│ │  数字员工                   │ │
│ │    🛡 角色管理              │ │
│ │    📋 Skill 管理            │ │
│ │    ✎ 自定义                 │ │
│ │    🤖 Bot 配置              │ │
│ │  分析                       │ │
│ │    📊 监控看板              │ │
│ │    📈 数据洞察              │ │
│ │    💬 反馈分析              │ │
│ │  管理                       │ │
│ │    🔌 Webhook               │ │
│ │    🌐 团队协作              │ │
│ │    ⊞ 插件                   │ │
│ │      └ (pinned 插件缩进)    │ │
│ │    ▤ 白板                   │ │
│ │    ⚙ 全局设置        ●红点  │ │
│ └────────────────────────────┘ │
└────────────────────────────────┘  ← 无底部固定区
```

**分 5 段**，注册表在 `app.tsx:184-190`：

```js
const NAV_GROUPS = [
  { id: 'overview',  labelKey: 'nav.group.overview',  items: ['overview'] },
  { id: 'collab',    labelKey: 'nav.group.collab',    items: ['sessions','agent-workbench','groups','schedules','workflows','office'] },
  { id: 'workforce', labelKey: 'nav.group.workforce', items: ['roles','skills','customization','bot-defaults'] },
  { id: 'analytics', labelKey: 'nav.group.analytics', items: ['monitoring','insights','feedback'] },
  { id: 'manage',    labelKey: 'nav.group.manage',    items: ['connectors','team','plugins','whiteboards','settings'] },
];
```

组标题文案（`i18n.ts:29-33`）：概览 / 协作 / 数字员工 / 分析 / 管理。

> **好在哪**：`NAV_GROUPS` 只存 id，不复制权限逻辑。可见性过滤（`manage` 项需登录）、client-shell 过滤、pinned 插件插入全部由 `sidebarNavItems()`（`app.tsx:240-252`）一条链路负责，分组只管排版。注释在 `app.tsx:178-183` 明确写了这个约定。

**顶部固定区**（`.sidebar-create-actions`，`style.css:8221-8258`）——注意是**顶部**不是底部，而且是**操作**不是导航：

```css
.sidebar-create-actions {
  display: grid; gap: 4px;
  flex: 0 0 auto;
  margin-bottom: 10px; padding-bottom: 10px;
  border-bottom: 1px solid var(--border-soft);
}
button.sidebar-create-btn {
  display: flex; align-items: center; gap: 11px;
  min-height: 36px;
  padding: 8px 10px;                                  /* ≥981px 时 8px 12px 8px 16px */
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--border-soft));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--accent-strong);
  font-size: 13px; font-weight: 600;
  text-align: left;
}
```

**虚线边框 + 6% accent 底色**，和实线的导航项在形态上区分开——一眼能看出「这是动作，不是页面」。

**没有底部固定区。** `.sidebar-foot` 只在 `@media (max-width:980px)` 里被 `display:none`（`style.css:6790`），桌面端 JSX 里根本没渲染这个节点——是历史残留的死 CSS。

**组标题**（`style.css:8297-8308`）：

```css
.nav-group-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-4);              /* #b0b6c6 亮 / #4c566a 暗 */
  text-transform: uppercase;
  letter-spacing: .7px;
  padding: 0 var(--sp-3) var(--sp-2);   /* 0 12px 8px */
  margin-top: var(--sp-4);              /* 16px */
}
.nav-group:first-child .nav-group-title { margin-top: 0; }
```

**导航项**（`style.css:8309-8404`）：

```css
.sidebar-nav a {
  position: relative;
  display: flex; align-items: center;
  min-height: 36px;
  gap: 11px;
  padding: 8px 10px;
  border-radius: var(--radius-lg);     /* 12px */
  color: var(--muted);
  font-size: 13px; font-weight: 600;
  isolation: isolate;
  transition: background-color 180ms ease, color 160ms ease,
              box-shadow 180ms ease, transform 180ms ease;
}
@media (min-width: 981px) {
  .sidebar-nav a { padding-right: 12px; padding-left: 16px; }
}
.sidebar-nav a svg { width:16px; height:16px; fill:none; stroke:currentColor;
                     stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.sidebar-nav { gap: 2px; }              /* 项间距仅 2px */
```

底色走 `::before` 伪元素（`z-index:-1`，配合 `isolation:isolate`），这样 hover 时可以做 `scaleX` 微动画：

```css
.sidebar-nav a::before {
  content: ""; position: absolute; inset: 0; z-index: -1;
  border-radius: inherit;
  background: var(--surface-muted);
  opacity: 0;
  transform: scaleX(0.96);
  transition: opacity 180ms ease, transform 180ms ease, background-color 180ms ease;
}
.sidebar-nav a:hover           { color: var(--fg); }
.sidebar-nav a:hover::before   { opacity: 1; transform: scaleX(1); }   /* 0.96→1 横向展开 */

.sidebar-nav a.active          { background: transparent; box-shadow: none; color: var(--accent-strong); }
.sidebar-nav a.active::before  { background: var(--accent-soft); opacity: 1; transform: scaleX(1); }
.sidebar-nav a.active svg      { transform: translateX(1px); }
.sidebar-nav a.active::after {          /* 左侧 3px 指示条 */
  content: ""; position: absolute;
  left: -3px; top: 8px; bottom: 8px;
  width: 3px;
  border-radius: var(--radius-full);
  background: var(--accent);
}
```

三态总结：

| 态 | 底色 | 文字 | 额外 |
|---|---|---|---|
| 默认 | 透明 | `--muted` | — |
| hover | `--surface-muted`，`scaleX` 0.96→1 | `--fg` | — |
| active | `--accent-soft` | `--accent-strong` | 左侧 3px accent 竖条（`::after`，探出 3px）+ 图标右移 1px |

指示条用 `::after` 而不是 `border-left`，因为 `::before` 已被底色占用；注释（`style.css:8393-8394`）特意提醒锚点**不能** `overflow:hidden`，否则 `left:-3px` 探出的部分会被裁掉。

**设置项的更新红点**（`app.tsx:272-282`，`style.css:8411-8423`）：有新版本时 `#/settings` 项挂一个 `InfoTip` 包裹的 7px 红点，`box-shadow: 0 0 0 2px var(--surface)` 做描边。

**Pinned 插件项**（`style.css:8425-8433`）：`margin-left:12px` 缩进 + `color:var(--faint)` + 图标缩到 14px，作为「插件」项的视觉子级，但 DOM 上是平级兄弟。

### A4. 移动端退化

断点全景（`style.css` 共 100+ 个 `@media`，影响外壳的如下）：

| 断点 | 影响外壳的变化 |
|---|---|
| **980px** | 主断点，见下 |
| 720px | 页面级（`.sessions-page`/`.groups-page` 改为文档流滚动，`:27104+`） |
| 620px | 工作台会话行 54px→60px、触控目标放大 |
| 520px | `--topbar-control-size` 38px→34px；topbar `padding:0 12px`、`column-gap:8px` |
| `(hover: none)` | 触控目标 ≥44px，行内操作常驻显示 |

**≤980px 的外壳退化**（`style.css:13451-13527`）——**侧栏从悬浮卡片变成顶部横向滚动 rail**：

```css
@media (max-width: 980px) {
  .chrome-body {
    display: flex; flex-direction: column;    /* 从 block 改回 flex 纵向 */
    height: auto; padding: 0;
    overflow: hidden;
  }
  .topbar {
    grid-template-columns: minmax(0,max-content) minmax(0,1fr) max-content;
    column-gap: 12px;
    padding: 0 16px;                          /* 32→16 */
  }
  .sidebar {
    position: static;                         /* 取消 fixed */
    width: auto; height: auto;
    margin: 0; padding: 10px 16px;
    border: 0;
    border-bottom: 1px solid var(--border);   /* 卡片边框→单条下边线 */
    border-radius: 0;
    box-shadow: none;                         /* 去阴影 */
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(14px);
  }
  .sidebar-nav {
    display: flex;                            /* 纵向→横向 */
    gap: 8px;
    overflow-x: auto; overflow-y: hidden;
    padding: 0 0 2px;
  }
  .sidebar-nav .nav-group       { display: contents; }   /* 组容器消失，锚点直接参与 flex */
  .sidebar-nav .nav-group-title { display: none; }       /* 组标题隐藏 */
  .sidebar-nav a                { flex: 0 0 auto; }
  .workspace {
    flex: 1; min-height: 0;
    overflow: hidden;
    margin-left: 0;                           /* 取消让位 */
  }
}
```

补充规则 `style.css:27082-27102`：`.sidebar` 宽度锁 100%、`.sidebar-nav` 加 `overscroll-behavior-x: contain` + `touch-action: pan-x` + `-webkit-overflow-scrolling: touch`。

> **好在哪**：`display: contents` 让分组容器在窄屏「消失」，锚点直接成为 flex 子项——不需要为移动端写第二套 DOM，也不需要 JS 判断。`app.tsx:261` 的注释明确写了「桌面分组导航与移动端横向 rail 共用同一份渲染」（`renderNavAnchor`）。

**没有抽屉、没有汉堡菜单、没有遮罩。** 全站 `grep drawer/overlay/backdrop` 在外壳层面无匹配——移动端就是「顶栏 + 横向 rail + 内容」三层堆叠。

注：`style.css:6764-6800` 还有一段更早的 `@media (max-width:980px)`，写的是 `border-right:0` / `.app-shell{grid-template-columns:1fr}` 这类针对**旧栅格布局**的规则。侧栏早已改成 fixed，`.app-shell` 也不再是 grid，这段基本是死代码，被 `:13451` 那段覆盖。复刻时不要照抄。

---

## B. 侧栏细节：工作台会话列表

> 注意：这一节说的**不是** A2 的全局导航侧栏，而是 `#/agent-workbench` 驾驶舱里那条会话栏（`agent-workbench-session-list.tsx`，642 行）。dutydeck 要对标的是这个。

**它有自己的一套 token**，不复用 dashboard 的语义色。`style.css:28445-28553` 定义 `.agent-workbench-page, .agent-workbench-dock` 作用域下的 `--wb-*`：

| `--wb-*` | 别名 | 暗色 | 亮色 |
|---|---|---|---|
| `--wb-text` | `--text-1` | `#e4ebf2` | `#131820` |
| `--wb-muted` | `--text-2` | `#afbecd` | `#3b4855` |
| `--wb-faint` | `--text-3` | `#a2b2c3` | `#46525f` |
| `--wb-accent` / `--wb-focus` | `--accent` | `#6fcbf7` | `#0b5f8f` |
| `--wb-success` | `--ok` | `#63d6a0` | `#0f6141` |
| `--wb-warning` | `--warn` | `#edb95c` | `#6b4904` |
| `--wb-danger` | `--err` | `#f58a94` | `#9e2531` |

`design-tokens.css` 里的 `--st-need/--st-work/--st-todo/--st-idle`（`:55-62`）**工作台一处都没用**——那四个只服务 `.stat-chip--*`（`style.css:30637`）和看板卡片（`:31245`）。

### B5. 会话行的完整解剖

行是 **2 列 grid**（`14px minmax(0,1fr)`）+ 一个绝对定位的操作浮层。JSX 在 `agent-workbench-session-list.tsx:506-635`：

```
┌─ .wb-session-row ──────────────────────────── 54px ─────────┐
│ ┌──┐ ┌──────────────────────────────────────────────────┐  │
│ │! │ │ 会话标题…                                         │  │  ← .wb-session-title
│ │  │ ├──────────────────────────────────────────────────┤  │
│ │14│ │ [话题] 需要选择仓库          ● 3分钟前            │  │  ← .wb-session-meta
│ └──┘ └──────────────────────────────────────────────────┘  │
│  ↑     ↑       ↑                  ↑  ↑                      │
│  状态  kind    reason/subtitle    │  时间戳                 │
│  字符  徽标                       未读点                     │
│                                                              │
│              [聊天][定位][跳转][终端]  ← .wb-session-row-actions
│              绝对定位, right:14px, hover 才显形               │
└──────────────────────────────────────────────────────────────┘
   padding: 5px 14px 5px 22px    grid: 14px minmax(0,1fr)  gap:4px
```

| # | 元素 | 类 | 字号/尺寸 | 颜色 | 位置 |
|---|---|---|---|---|---|
| 1 | 状态字符（`!` / `●` / `↺`） | `.wb-session-state-mark` | 12px（继承），列宽 14px | needs-you `--wb-danger`；active `--wb-success`；recent `--wb-faint`（`:28914-28916`） | grid 第 1 列 |
| 2 | 文案块 | `.wb-session-copy` | `display:grid; gap:4px`（`:28917`） | — | grid 第 2 列 |
| 3 | 标题 | `.wb-session-title` | 12px / **700**，`line-height:1.5` + `padding-block:1px` = 20px 行盒 | `--wb-text` | 第 1 行，单行省略 |
| 4 | 元信息行 | `.wb-session-meta` | **11px**，`display:flex; justify-content:space-between; gap:6px` | `--text-3` | 第 2 行，18px |
| 4a | 类型徽标 话题/群/单聊 | `.wb-session-kind` | 11px，`padding:0 5px`，`line-height:16px`（总高 18px），`border:1px solid --border-keep`，`radius:6px` | `--text-3` | 元信息行最左 |
| 4b | 原因 / 副标题 | `.wb-session-reason` / 裸 `<span>` | 11px | 原因 `--wb-warning`；副标题 `--text-3` | 紧随徽标，`margin-right:auto` 撑开 |
| 4c | 未读点 | `.wb-unread-dot` | **8×8px** 圆 | `--wb-accent` | 时间戳**左侧**（不是最右） |
| 4d | 时间戳 | `<time>`（无类） | 11px，`flex:none` | `--text-3` | 最右 |
| 5 | 悬浮操作 | `.wb-session-row-actions` | 见下 | — | 绝对定位覆盖 |

**没有头像。** 全行零图片。

副标题内容 = `sessionSecondary()`（`agent-workbench-session-list.tsx:203-205`）= `botName · cliId · repoName`。
时间戳 = `formatWorkbenchRelativeTime()`（`agent-workbench-model.ts:636-651`），用 `Intl.RelativeTimeFormat` 的 `short` 风格，45 秒内显示「刚刚」，为 0 显示 `—`。

**悬浮操作浮层**（`style.css:29852-29876`）：

```css
.wb-session-row-actions {
  position: absolute; top: 50%; right: 14px; z-index: 2;
  display: flex; gap: 4px;
  padding: 2px 4px;
  border: 1px solid var(--border-keep);
  border-radius: var(--radius-lg);
  background: var(--bg-l2);
  box-shadow: var(--shadow-pop);
  transform: translateY(-50%);
  opacity: 0; pointer-events: none;
  transition: opacity .14s ease-out;
}
.wb-session-row:hover       .wb-session-row-actions,
.wb-session-row:focus-within .wb-session-row-actions { opacity: 1; pointer-events: auto; }

@media (hover: none) {      /* 触控设备：选中行常驻显示 */
  .wb-session-row.is-selected .wb-session-row-actions { opacity: 1; pointer-events: auto; }
}
```

按钮本身 `.wb-session-row-action`（`style.css:29656-29675`）：`height:20px; min-height:0; padding:0 6px; border:0; background:transparent; font-size:11px`。
`min-height:0` 是**专门用来打败 dashboard 全局 `button{min-height:32px}` 的**——注释在 `:29664`。

按钮组：`聊天`（飞书链接）/ `定位`（仅 thread，有 30s 冷却）/ `跳转`（仅 thread）/ `终端`。

> **好在哪**：整行点击区用 `.wb-session-copy-link::after { position:absolute; inset:0 }`（`style.css:28927-28935`）铺满，而操作按钮 `z-index:2` 浮在其上——既保证「点哪都能选中」，又不会让操作按钮被链接吞掉。

### B6. 分组与排序

**分组维度用户可选**，默认 `status`。类型 `WorkbenchGroupDimension = 'status'|'bot'|'chat'|'kind'|'cli'|'time'`（`agent-workbench-model.ts:14`），选项文案「状态 / 机器人 / 会话位置 / 类型 / CLI / 活跃时间」（`:17-24`）。

核心函数 `groupWorkbenchSessionsForDimension`（`agent-workbench-model.ts:490-542`）：

- **「待你处理」永远抽出来置顶**，不管当前是哪个维度（`:500-514`，`:536-539` push 到最前）。归属判定 `classifyWorkbenchSession`（`:323-329`）：有 `attentionSummary()` 原因，或未读且未关闭。
- 组内排序、组间排序两套逻辑：
  - `status`/`kind`/`time` 用固定语义序 `FIXED_GROUP_ORDER`（`:393-397`，`:518-524` 排序）
  - `bot`/`chat`/`cli` 这类自由文本按**组内最新会话时间倒序**，同分再 `label.localeCompare`（`:526-532`）
- 空桶不产出（注释 `:486-489`）。
- 时间分桶：`timeBucketBounds` `:416-425`，`timeGroupLabel` `:427-433` → 今天/昨天/本周/更早。

**组内排序只有一个比较器**，`agent-workbench-model.ts:473-475`：

```js
function byActivityDesc(a, b) {
  return sessionActivityAt(b) - sessionActivityAt(a) || a.sessionId.localeCompare(b.sessionId);
}
```

活跃时间倒序，同分用 sessionId 字典序兜底（保证稳定）。`sessionActivityAt`（`:331-334`）取值优先级：`agentAttention.at` → `lastMessageAt` → `closedAt` → `spawnedAt` → `0`。

**组标题**（JSX `agent-workbench-session-list.tsx:478-493`）是个 `<button>`，4 列 grid：

```
┌─ .wb-session-group.wb-session-group-toggle ── 30px ──┐
│ ▾   !   待你处理                                  3  │
│ 14  14  minmax(0,1fr)                          auto  │
└──────────────────────────────────────────────────────┘
   padding: 5px 14px 3px 22px
```

```css
/* style.css:29963-29989 —— 生效规则（基础规则 :28837 被这条 0,2,0 特异性覆盖） */
.wb-session-group.wb-session-group-toggle {
  width: 100%; min-height: 0;
  grid-template-columns: 14px 14px minmax(0, 1fr) auto;
  padding: 5px 14px 3px 22px;
  border: 0; border-radius: 0;
  background: transparent;
  font-size: 11px;
  line-height: 1.5;
  letter-spacing: .09em;
  text-align: left;
  white-space: nowrap; overflow: hidden;
  cursor: pointer;
}
.wb-session-group-needs-you { color: var(--wb-danger); }   /* :28853 */
.wb-session-group-active    { color: var(--wb-success); }  /* :28854 */
```

- **11px / letter-spacing .09em / 无 `text-transform`**（中文不能大写）。加粗靠 JSX 里的 `<strong>`。
- **有计数**：末列裸 `<span>{item.count}</span>`，且是**折叠前的真实数量**（`:583`）。
- **不吸顶**。它是 `position:absolute`（`:28835`）由虚拟滚动定位，会跟着滚走。
- 高度 **30px**，硬编码在 `workbenchListItemHeight`（`agent-workbench-model.ts:610`）。
- hover 底色同样走 `::before` 伪元素（`:29993-30002`，`inset:1px 8px`，`radius:12px`）。

### B7. 三态视觉

**所有状态都画在 `::before` 垫片上，行本身永远 `background:transparent`**（`style.css:28897-28913`）：

```css
.wb-session-row::before {
  content: ""; position: absolute; z-index: -1;
  inset: 2px 8px;                       /* 上下留 2px，左右留 8px */
  border-radius: var(--radius-lg);
  background: transparent;
  transition: background-color .14s ease-out;
}
.wb-session-row:hover::before      { background: var(--bg-l3); }
.wb-session-row.is-selected::before {
  background: var(--bg-l3);             /* 和 hover 同色，故意的 */
  box-shadow: inset 2px 0 0 var(--accent);   /* 2px 左侧条 */
}
.wb-session-row.is-selected .wb-session-title { color: var(--accent); }
```

| 态 | 底色 | 标题色 | 额外 |
|---|---|---|---|
| hover | `--bg-l3` | 不变 | 操作浮层淡入 |
| **选中** | `--bg-l3`（**与 hover 同色**） | `--accent` | `inset 2px 0 0 accent` 左条 |
| 忙碌/未读 | **无专门样式** | — | 仅靠 8px 未读点 + reason 文案 + 被归入「待你处理」 |

两个刻意的设计决定，都有注释佐证：
1. 选中态与 hover **同底色**（注释 `:28906-28907`）——理由是再引入第二种灰只会变噪音，选中靠左侧条和标题变色区分即可。
2. 左侧条用 `box-shadow: inset` 而非 `border-left`（注释 `:28871-28874`）——这样它会跟随 12px 圆角走，`border-left` 会在圆角处露出直角。

**`.is-unread` 类在 CSS 里零匹配**——JSX（`:510`）挂了这个类但没有对应规则，是个纯钩子。

**无任何 pulse/blink 动画。** 整个工作台段落（style.css 约 28400–30400 行）零 `@keyframes`、零 `animation:`。唯一的动效是 `transition: background-color .14s ease-out`，且被无障碍开关全量关掉：

```css
/* style.css:29461-29464 */
@media (prefers-reduced-motion: reduce) {
  .agent-workbench-page *, .agent-workbench-dock * {
    scroll-behavior: auto !important;
    transition: none !important;
    animation: none !important;
  }
}
```

### B8. 列表顶部

会话栏是 3 行 grid：`grid-template-rows: 38px 38px minmax(0,1fr)`（`style.css:28708`）——标题 38px、搜索 38px、列表占满。

```
┌─ .wb-session-rail ─────────────────┐
│ ● 会话 12        [状态▾] [◐] [«]  │ 38px  .wb-rail-heading
├────────────────────────────────────┤
│ ⌕ 搜索…                        [×] │ 38px  .wb-session-search
├────────────────────────────────────┤
│ (虚拟滚动列表)                      │ 1fr   .wb-session-list
└────────────────────────────────────┘
```

**第 1 行**（JSX `agent-workbench-session-list.tsx:405-443`）：在线圆点（`●`/`○`，绿/红）+ `会话` + 总数 + 分组维度 `<select>` + 外观按钮 `◐` + 折叠按钮 `«`。

```css
.wb-rail-heading {                     /* :28760-28772 */
  display: flex; align-items: center; gap: 8px;
  padding: 0 12px 0 22px;              /* 左 22 对齐行内状态字符列 */
}
.wb-rail-heading button { width:24px; height:24px; padding:0; border:0;
                          border-radius:var(--radius-sm); background:transparent; }
.wb-group-dim {                        /* :29935-29952 */
  height: 24px; max-width: 96px;
  padding: 0 16px 0 6px;
  border: 0; border-radius: var(--radius-md);
  background-color: transparent;
  font-size: 11px; line-height: 24px;
}
```

**第 2 行**（JSX `:444-461`）搜索框：

```css
.wb-session-search {                   /* :28798-28824 */
  display: flex; align-items: center; gap: 5px;
  margin: 6px 8px 4px;                 /* 8px 左右 == ::before 垫片的 inset */
  padding: 0 14px;                     /* 14 让 ⌕ 落在 22px 基线上 */
  border: 0; border-radius: var(--radius-md);
  background: var(--bg-l2);
}
.wb-session-search:focus-within { outline: 2px solid var(--accent); outline-offset: -2px; }
.wb-session-search input { width:100%; height:26px; padding:0; border:0; outline:0;
                           background:transparent; }
```

`ArrowDown` 从搜索框直接跳进列表并选中下一项（`:452-458`）。

**没有筛选 tab/chip，没有「新建会话」按钮。** 筛选就是那个分组 `<select>`；新建在全局侧栏顶部（§A2）。

**折叠态**（JSX `:378-401`）：整条 rail 收成 40px 宽（触控 44px），显示竖排文字 + `.wb-rail-count` 待处理数徽标（`style.css:28744-28756`，`min-width:18px`，`background:var(--badge-todo)`）。

### B9. 空列表

```jsx
{matchedCount === 0 ? <p className="wb-session-empty">没有匹配的会话</p> : null}
```
（`agent-workbench-session-list.tsx:638`）

```css
.wb-session-empty {                    /* style.css:28959 */
  position: absolute;
  inset: 60px 8px auto;                /* 距顶 60px，左右 8px，bottom:auto */
  color: var(--wb-faint);
  text-align: center;
}
```

一行字，**无图标、无插画、无按钮**，12px 继承字号。
触发条件是 `matchedCount`（`:260-263`）= 折叠前的组内总数，所以**把所有组折叠起来不会误显示空状态**。

### 附：虚拟滚动与折叠（复刻时的硬约束）

**折叠**：逐组，持久化到 localStorage。

- 状态 `collapsedGroups: ReadonlySet<string>`（`:236-238`），键是维度前缀的（`bot:Builder`、`time:今天`），所以一个 Set 天然跨维度分区不串台（注释 `:234-235`）。
- 存储键 `botmux.agent-workbench.collapsed.v1`，上限 200 条，按插入序淘汰最旧（`agent-workbench-storage.ts:20,26,211,223-244`）。
- 折叠的组**把行整个从 items 里剔除**（`agent-workbench-model.ts:587` `if (collapsed) continue;`），所以总滚动高度真的会缩短，`j`/`k` 键也会跳过。
- 键盘冲突防护：`fromGroupToggle()`（`:84-87`）检查 `closest('.wb-session-group-toggle')`，否则 Enter/Space 会同时触发折叠和选中。

**虚拟滚动**：手写，无库。

- `computeVirtualWindow(items, scrollTop, viewportHeight, overscanPx = 240, touch)`（`agent-workbench-model.ts:614-634`），前缀和 + 线性扫描。
- 行高是**契约**：桌面 54px（`style.css:29606`）、触控 ≤620px 60px（`:29796`）、组标题 30px（`agent-workbench-model.ts:610`）。CSS 注释 `:29597-29605` 和模型 `:603-612` 双向提醒：改一处不改另一处，列表会滚过头。
- 垂直预算写在注释 `:29636-29638`：`54 = 5 padding + 42 内容 + 5 padding + 2 余量`，内容 `42 = 标题 20 + gap 4 + 元信息 18`。
- `useTouchRowMetrics()`（`:209-220`）用 `matchMedia('(max-width: 620px)')` 镜像 CSS 断点，保证 JS 和 CSS 不会各说各话。
- 滚动容器 `contain: strict`（`:28831`），这也是 `z-index:-1` 的垫片不会掉到 rail 后面的原因。

> **好在哪**：行高作为 JS/CSS 双向契约被显式注释 + 单测（`agent-workbench-style.test.ts` 锁定组标题与行的 padding 相等）钉住。这是虚拟列表最容易腐坏的地方。

---

## C. 功能入口的组织

### C10. 全站页面清单

路由注册表 `dashboard-routes.ts:32-75`，**23 条路由**，全部 `import()` 懒加载。匹配是 `hash.startsWith(routePrefix)`（`:78`），所以**注册顺序即优先级**——`#/connectors/logs`（`:60`）必须排在 `#/connectors`（`:62`）前面。

| 路由 | 页面文件 | 侧栏入口 | 分组 | 需登录 |
|---|---|---|---|---|
| `#/`（默认） | `overview-page.tsx` | 工作台 | 概览 | 否 |
| `#/sessions` | `sessions-page.tsx` (4096 行) | 会话控制 | 协作 | 否 |
| `#/agent-workbench` | `agent-workbench-page.tsx` | 驾驶舱 | 协作 | 否 |
| `#/groups` | `groups-page.tsx` | 群组管理 | 协作 | 否 |
| `#/schedules` | `schedules-page.tsx` | 定时任务 | 协作 | 否 |
| `#/workflows` | `v3-page.tsx` | 工作流 | 协作 | 否 |
| `#/office` | `office-page.tsx` | 办公室 | 协作 | 否 |
| `#/roles` | `roles-page.tsx` | 角色管理 | 数字员工 | **是** |
| `#/roles/profile` | 同上 | *（页内 tab）* | — | 是 |
| `#/skills` | `skills-page.tsx` | Skill 管理 | 数字员工 | 是 |
| `#/customization` | `customization-page.tsx` | 自定义 | 数字员工 | 是 |
| `#/bot-defaults` | `bot-defaults-page.tsx` (6325 行) | Bot 配置 | 数字员工 | 是 |
| `#/monitoring` | `monitoring-page.tsx` | 监控看板 | 分析 | 否 |
| `#/insights` | `insights-page.tsx` | 数据洞察 | 分析 | 是 |
| `#/feedback` | `feedback-page.tsx` | 反馈分析 | 分析 | 是 |
| `#/connectors` | `connectors-page.tsx` | Webhook | 管理 | 是 |
| `#/connectors/logs` | 同上 | *（页内 tab）* | — | 是 |
| `#/webhook-logs` | 同上 | *（旧别名）* | — | 是 |
| `#/team` | `team-federation-page.tsx` | 团队协作 | 管理 | 是 |
| `#/team/manage` | 同上 | *（页内 tab）* | — | 是 |
| `#/plugins` | `plugin-page.tsx` | 插件 | 管理 | 是 |
| `#/whiteboards` | `whiteboards-page.tsx` | 白板 | 管理 | 是 |
| `#/settings` | `settings-page.tsx` | 全局设置 | 管理 | 否 |
| `#/monitor-room` | `monitor-room.ts` | **无侧栏入口** | — | — |
| `#/agent-workbench-dock` | `agent-workbench-dock-page.tsx` | **无侧栏入口** | — | — |

**入口渠道只有两个半：**

1. **侧栏** —— 19 个入口，唯一的主导航
2. **页内 tab** —— `#/roles/profile`、`#/connectors/logs`、`#/team/manage` 只能先进父页再点 tab
3. **无入口的孤儿路由**：
   - `#/monitor-room`：只有 `monitor-room-store.ts:81` 用 `url.hash = '#/monitor-room'` 跳进去；`isActiveNav`（`app.tsx:227-231`）特意让它高亮「会话控制」，说明它被当作 sessions 的子页面
   - `#/agent-workbench-dock`：桌面/移动客户端专用无边框壳，`app.tsx:1238-1244` 判定

**顶栏不承载任何页面导航**——只有状态浮层里那个「去处理」链到 `#/sessions`（`app.tsx:522`）。

### C11. 设置类功能的组织：**分散，不是一个大设置页**

**结论：8 条顶级路由，26 个末级目的地，没有统一入口。**

`#/settings` **不是**其他设置页的父级——它页内没有任何链接指向 bot-defaults / skills / roles / connectors / team / customization。这 8 条路由还被拆在**两个不相干的侧栏分组**里（`数字员工` 和 `管理`，`app.tsx:187,189`）。

完整层级树：

```
设置类功能（无统一根）
│
├── #/settings ──────────────── 左侧 rail（滚动锚点式，非 tab）
│   │   layout: .settings-layout (settings-page.tsx:757)
│   │   rail:   <SettingsNav> (:1067) → nav.settings-nav (:1099)
│   │   注册表: const groups (:1070-1096) — 3 组 11 项
│   │   内容:   .settings-content (:759) — 所有 section 同时挂载
│   ├── 通用 (moduleGeneral :1072)
│   │   ├── settings-access          访问控制
│   │   ├── settings-cards           卡片
│   │   ├── settings-group-creation  建群
│   │   ├── settings-experimental    实验特性
│   │   ├── settings-overload        过载
│   │   ├── settings-whiteboard      白板
│   │   ├── settings-repo-picker     仓库选择
│   │   └── settings-schedule        定时
│   ├── 会议 (moduleMeeting :1085)
│   │   └── settings-vc
│   └── 系统 (moduleSystem :1091)
│       ├── settings-maintenance
│       └── settings-update
│
├── #/bot-defaults ──────────── 顶部横向 tab（useState，5 个）
│   │   注册表: BOT_DEFAULTS_TABS (bot-defaults-page.tsx:156-162)
│   │   组件:   BotDefaultsTabs (:164) → nav.bd-tab-bar > div.bd-tabs[role=tablist]
│   ├── common   常用    → BotAgentSection / WorkingDirSection / RoleSection
│   ├── sessions 会话    → SessionMode / SubstituteMode / CrossBot / SessionCap / StartupCommands / SummaryTrigger
│   ├── security 安全    → Sandbox / CodexAuth / SandboxPaths / Grant / SlashCommandPermissions
│   ├── cards    卡片    → CardBehavior / FeedbackSettings / ReplyStyle / Brand
│   └── advanced 高级    → BackendType / CodexAppDisplay / EnvelopeInjection / SenderTag
│
├── #/roles ─────────────────── 三层嵌套
│   ├── L1 hash tab: nav.roles-subnav.insight-tabs (roles-page.tsx:1021-1027)
│   │   ├── #/roles          分组
│   │   └── #/roles/profile  画像
│   ├── L2 左侧树: .roles-tree-panel (:1038)   ← 页内第二个 rail
│   └── L3 分段控件: .roles-editor-switch.segmented (:1125)  角色/监听器
│       └── L3b 成员/机器人 (:1846,:1854)
│
├── #/skills ────────────────── 顶部横向 tab（useState，4 个，无注册表）
│   │   strip: div.skills-tabs[role=tablist] (skills-page.tsx:1576)
│   ├── library  （默认）
│   ├── packs
│   ├── bots
│   └── delivery
│
├── #/connectors ────────────── hash tab（2 个）
│   │   组件: ConnectorsSubNav (connectors-page.tsx:338) → nav.connectors-subnav.insight-tabs
│   ├── #/connectors       Webhooks
│   └── #/connectors/logs  日志（别名 #/webhook-logs）
│
├── #/team ──────────────────── hash tab（2 个）
│   │   组件: TeamSubNav (team-federation-page.tsx:74) → nav.team-subnav.insight-tabs
│   ├── #/team         我的团队  → TeamHomePage (:277)
│   └── #/team/manage  团队管理  → TeamManagePage (:757)
│
└── #/customization ─────────── 无 tab，且完全脱离设计系统
    │   .cz-page (customization-page.tsx:328)
    │   <style>{PAGE_CSS}</style> (:329)  ← 全站唯一内联 CSS 的页面
    │   标题硬编码中文「自定义中心」(:333)，不走 i18n
    ├── 改动历史（条件渲染 :367）
    ├── 内置 Prompt 片段 (:383)
    └── 内置 Skill 覆盖 (:406)
```

**四种互不兼容的页内导航模式**，三套 CSS 类族：

| 模式 | 用在 | tab 类 | URL 可深链 | 键盘支持 |
|---|---|---|---|---|
| 滚动锚点 rail | settings | `.settings-nav-link` | 否 | 无 |
| hash 链接 tab | roles / connectors / team | `.insight-tabs` / `.itab` | **是** | 原生链接 |
| useState 按钮 tab | bot-defaults | `.bd-tabs` / `.bd-tab` | 否 | **完整**（←→/Home/End，`:180-213`） |
| useState 按钮 tab | skills | `.skills-tabs` | 否 | 无 |
| 分段控件 | roles 内层 | `.segmented` | 否 | 无 |

`#/settings` 的 rail **不是 tab**——每项是 `<button>`，点了调 `scrollIntoView({behavior:'smooth'})`（`settings-page.tsx:1109`），内容全部同时挂载。没有 `aria-current`，没有滚动位置反查，所以**rail 永远不高亮你在哪一节**。另外 `:906` 那个 `<SettingsBlock title={sectionWorkflow}>` **没写 `id`**，rail 够不着它。

**页头没有共享组件**：7 个页面里 6 个手抄同一段 JSX 字面量 `<div className="page-heading"><div><p className="eyebrow">…</p><h1>…</h1></div><div className="page-heading-actions">…</div></div>`。`dashboard-components.tsx` 导出的 `SectionHeader`（`:50`）渲染的是 `.sect-head`，那是**面板**标题不是**页面**标题。

> 这一块是 botmux 的**弱项**，不建议照抄：8 条路由 + 4 种页内导航 + 3 套 tab 类族，用户要记住「哪个设置在哪个路由下」。dutydeck 若要对标，建议取它的 `NAV_GROUPS` 分组思路（§A2），但设置侧收敛成单一层级。

### C12. 命令面板：**有，但只在 Insights 页内，不是全局**

`insights-page.tsx:1531` `function CommandPalette({palette, items, onClose, onInput, onChoose})`。

- **触发**：`insights-page.tsx:1926` —— `if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey))`，在 `:1951` 用 `document.addEventListener('keydown', onKey)` 注册。
- **致命限制**：这个监听器写在 `InsightsPage` 的 `useEffect` 里，**只在 `#/insights` 挂载期间存在**。在其他任何页面按 Cmd/Ctrl+K 都没反应。
- **渲染**：`createPortal(node, document.body)`（`:1568`）。结构：
  ```
  #insight-palette .insights-page.insight-palette[.palette-anchored|.palette-centered]  (:1549)
  ├── .modal-backdrop            (:1550)
  └── .palette-panel[.anchored] role=dialog aria-modal=false  (:1552)
      ├── input.palette-input autoFocus   (:1557)
      ├── .palette-list                   (:1558)
      │   └── .palette-item[.on] > .pal-label + .pal-sub  (:1560-1562)
      └── .mut.palette-empty              (:1563)
  ```
- **内容**（`paletteItems` `:1680-1693`）只有两类：5 个 Insight tab（`insights.ts:87-93`）+ 最多 20 条匹配的会话记录。**索引了 0 个设置项、0 个路由、0 个命令。**
- 键盘：Escape `:1932`、↓ `:1936`、↑ `:1939`、Enter `:1942`，`:1930` 有输入法合成守卫。

全目录 grep `cmdk|command-?palette|quick-?open|spotlight|hotkey` 只命中这一处。**无 cmdk 依赖，无全局面板。**

**全局快捷键注册表：不存在。** grep `keymap|keyBindings|registerShortcut|shortcutRegistry|accelerator` 零匹配。`metaKey|ctrlKey` 全目录仅 2 处：上面那个 Cmd+K，和 `agent-workbench-session-list.tsx:354` 的一个守卫。键盘处理是 15 个各自为政的 `addEventListener('keydown')`，其中几个用了捕获阶段（`skills-page.tsx:540`、`sessions-page.tsx:251`），彼此顺序靠位置决定，没有仲裁者。

### 附：共享 UI 组件清单（`dashboard-components.tsx`，619 行）

| 导出 | 行 | 用途 | 渲染类 |
|---|---|---|---|
| `Html` | 26 | 注入可信 HTML，`display:contents` 不产生盒子 | — |
| `LoadingState` | 31 | 加载态，`role=status aria-live=polite` | `.page-loading`, `.page-loading-spin` |
| `SectionHeader` | 50 | **面板**标题 + 计数 + 提示 | `.sect-head.overview-panel-head` |
| `HeaderAction` | 66 | 面板头的链接式动作 | `a.sect-head-action` |
| `HeaderControls` | 73 | 面板头的控件容器 | `.sect-head-controls` |
| `CreateActionButton` | 97 | 主「新建」按钮，内建加号 | `.ui-create-action` |
| `RefreshIconButton` | 107 | 纯图标刷新，带 busy 态 | `.ui-refresh-button.is-loading` |
| `floatingPortalHost()` | 132 | 选 portal 目标：优先最近的 `dialog[open]`——原生 dialog 在浏览器 top layer，body portal 会被压在后面，与 z-index 无关 | — |
| `InfoTip` | 136 | `?` 帮助气泡，body portal，上下翻转，160ms 延迟隐藏（让指针能移过去选文字，`:175-178`） | `.ui-info-tip`, `.ui-info-pop` |
| `OverflowText` | 226 | 用 `ResizeObserver` 检测真实溢出才显示完整气泡 | `.ui-overflow-text.is-overflowing` |
| `FieldTitle` | 341 | 表单字段标签 + 可选 InfoTip | `.ui-field-title` |
| `OverviewList` 等 4 个 | 355-376 | 列表原语，`kind: 'session'\|'schedule'\|'group'` → 修饰类 | `.overview-list-item-{kind}` |
| `dropdownPlacement()` | 410 | **纯函数**，可单测：算 `{dropUp, maxHeight}`，仅当下方放不下且上方更宽裕才翻转，高度下限 140px | — |
| `DropdownMenu<T>` | 437 | `<details>` 式下拉：搜索框、禁用项、外点关闭、视口感知定位 | `.sect-sort-menu`, `.sect-sort-pop` |
| `SortMenu<T>` | 617 | 纯别名，`return <DropdownMenu {...props} />` | 同上 |

`SectionHeader` 的 CSS（`style.css:9859-9905`）值得抄：

```css
.sect-head { display:flex; align-items:flex-end; flex-wrap:wrap; gap:10px;
             min-height: var(--section-title-row-height); }   /* 36px */
.sect-head h2 {
  display: inline-flex; align-items: center; gap: 8px;
  min-height: var(--section-title-text-height);   /* 24px */
  font-size: var(--section-title-font-size);      /* 15px */
  font-weight: 700;
  line-height: var(--section-title-text-height);
}
.sect-head h2::before {                            /* 标题前的 accent 圆点 */
  content: ""; width: var(--section-title-dot-size); height: var(--section-title-dot-size);  /* 7px */
  flex: none; border-radius: var(--radius-full);
  background: var(--accent);
}
.hero-page .sect-head h2::before {                 /* 概览页改成竖条 */
  width: 3px; height: 14px; border-radius: var(--radius-full);
}
.sect-head .sect-head-count {                      /* 计数胶囊 */
  display:inline-flex; align-items:center;
  height: 24px; padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--accent);
  font-size: 11px; font-weight: 700; line-height: 1;
}
.sect-head-controls { margin-left: auto; display:inline-flex; align-items:center; gap:8px; }
```

**UI kit 的缺口**：没有 `PageHeader`、没有 `Tabs`、没有 `SettingsSection`。这正是 §C11 那 7 个页面各造各的轮子的原因。

---

## D. 主工作区

> **先破一个预期**：驾驶舱**不是聊天应用**。没有消息列表、没有气泡、没有输入框、没有工具调用渲染、没有事件类型联合。所谓「会话内容区」是一个**指向 tmux/xterm 终端页 `/s/<sessionId>` 的 `<iframe>`**。
> 验证：`grep -c "textarea\|composer\|bubble"` 在 `agent-workbench-view.tsx` 和 `agent-workbench-panes.tsx` 均为 **0**。

三个界面形态：

| 形态 | 入口 | 文件 |
|---|---|---|
| 完整工作台（双栏） | `#/agent-workbench` | `agent-workbench-view.tsx` (699 行) |
| 轻量 dock（飞书侧边栏） | `#/agent-workbench-dock` | `agent-workbench-dock-view.tsx` (168 行) |
| 面板（终端 / 网页预览） | 两者内部渲染 | `agent-workbench-panes.tsx` (1227 行) |

### D13. 会话详情页结构

**双栏，不是三栏**：`[会话栏 | 6px 拖拽条 | 工作区]`。

```
┌─ .agent-workbench-page  grid  grid-template-rows: minmax(0,1fr)  h:100% ──┐
│┌─ .wb-desktop-layout  grid-template-columns: var(--wb-rail-width) 6px 1fr ┐│
││ .wb-session-rail    │ ⋮ │ .wb-workspace  grid-rows: 46px minmax(0,1fr)  ││
││ grid-rows           │sep│ ┌───────────────────────────────────────────┐ ││
││   38px 标题         │ 6 │ │ .wb-workspace-header            46px      │ ││
││   38px 搜索         │ px│ │  标题+副标题 │ 关闭终端✕ │ ⋯              │ ││
││   1fr  虚拟列表     │   │ ├───────────────────────────────────────────┤ ││
││                     │   │ │ .wb-pane-stack   flex column              │ ││
││ 默认 300px          │   │ │ └ .wb-pane  grid-rows: 34px auto 1fr      │ ││
││ 范围 176–460px      │   │ │    ├ 34px  .wb-pane-titlebar              │ ││
││ 折叠 40px（触控44） │   │ │    ├ auto  .wb-pane-feedback（空则消失）  │ ││
││                     │   │ │    └ 1fr   .wb-pane-frame-shell > iframe  │ ││
│└─────────────────────┴───┴───────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────────────────┘
```

```css
/* style.css:28686-28704 */
.agent-workbench-page {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  width: 100%; height: 100%; min-height: 0; overflow: hidden;
}
.wb-desktop-layout {
  display: grid;
  grid-template-columns: var(--wb-rail-width) 6px minmax(0, 1fr);
  min-height: 0; overflow: hidden;
}
.wb-desktop-layout.is-rail-collapsed {
  grid-template-columns: var(--wb-rail-width) minmax(0, 1fr);   /* 拖拽条消失 */
}
```

宽度常量（`agent-workbench-model.ts:3-6`）：

```ts
export const WORKBENCH_RAIL_DEFAULT   = 300;
export const WORKBENCH_RAIL_MIN       = 176;
export const WORKBENCH_RAIL_MAX       = 460;
export const WORKBENCH_RAIL_COLLAPSED = 40;
```

还有第三种状态——**终端关闭时会话栏独占整页**（`style.css:29582-29591`）：

```css
.wb-desktop-layout.is-terminal-closed { grid-template-columns: minmax(0, 1fr); }
.wb-desktop-layout.is-terminal-closed > .wb-rail-separator,
.wb-desktop-layout.is-terminal-closed > .wb-workspace { display: none; }
.wb-desktop-layout.is-terminal-closed .wb-session-rail {
  width: 100%; max-width: var(--wb-rail-width);
}
```

**会话栏与工作区之间没有 `border-right`**——分隔完全靠 `--bg-l1` 与 `--bg-l0` 的色差（注释 `style.css:28711-28713`）。

**头部（46px）**，从左到右（`agent-workbench-view.tsx:555-577`）：

| 位置 | 元素 | 内容 |
|---|---|---|
| 左 | `.wb-workspace-title > strong` | 会话标题，`max-width:58vw`，溢出省略 |
| 左（第 2 行） | `.wb-workspace-title > small` | `botName · cliId · repoName`，~10px，`--wb-muted` |
| — | *（`justify-content:space-between` 撑开）* | |
| 右 | `.wb-terminal-toggle` | 「关闭终端 ✕」，仅终端开着时出现 |
| 右 | `.wb-more-btn` | `⋯` 溢出菜单（外观设置 / 常驻链接） |

```css
/* style.css:29003-29035 */
.wb-workspace-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; min-width: 0;
  padding: 0 16px;
  border: 0;
  border-bottom: 1px solid var(--border-keep);   /* 白名单五类实线之一 */
  background: var(--bg-l0);
}
.wb-workspace { grid-template-rows: 46px minmax(0, 1fr); }   /* :29997 */
```

**没有状态 chip 在这一层**——状态 chip 在下面一行的面板标题栏里。

**整个工作台是等宽字体**：`font: 12px/1.4 var(--mono)`（`style.css:28500`）。

### D14. 内容如何呈现

**没有消息类型联合。** 唯一的类型分支是**终端控制权模式**（`agent-workbench-panes.tsx:744-752`）：

```ts
const status = controlled ? '可输入'
  : paneMode === 'unknown' ? '未知'
    : paneMode === 'loading' ? '检查中' : '只读';
const chipClass = controlled ? 'is-controlled'
  : paneMode === 'unknown' ? 'is-unknown'
    : paneMode === 'loading' ? 'is-checking' : 'is-readonly';
const chipGlyph = controlled ? '◆'
  : paneMode === 'unknown' ? '◇'
    : paneMode === 'loading' ? '⋯' : '◌';
```

```css
/* style.css:29177-29200 */
.wb-mode-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--border-keep);   /* 环永远是中性色 */
  border-radius: var(--radius-sm);        /* 6px */
  font-size: 11px;
  letter-spacing: .06em;
}
.wb-mode-chip.is-controlled { color: var(--ok);     background: var(--wb-success-soft); }
.wb-mode-chip.is-readonly   { color: var(--warn);   background: var(--wb-warning-soft); }
.wb-mode-chip.is-unknown    { color: var(--text-2); background: var(--bg-l3); }
.wb-mode-chip.is-checking   { color: var(--text-3); background: var(--bg-l3); }
```

`*-soft` = `color-mix(in srgb, var(--ok) 12%, transparent)`（`:28481,28483`）。
**语义只走文字色 + 12% 填充，1px 环恒定 `--border-keep`**（注释 `:29187-29188`）——这条规则值得抄。

**面板骨架**（可复用单元），`style.css:29129-29138`：

```css
.wb-pane {
  display: grid;
  grid-template-rows: 34px auto minmax(0, 1fr);   /* 标题栏 | 反馈行 | 画布 */
  border: 0;
  border-radius: 0;
  background: var(--term-canvas-bg, var(--term-bg));
  box-shadow: none;
  overflow: hidden;
}
```

刻意无边框、无圆角、无阴影——注释 `:29123-29128` 写「终端是屏幕，不是卡片」。

反馈行（第 2 行 `auto`，空了自动塌陷）：

```css
/* style.css:29201-29212 */
.wb-pane-feedback {
  overflow: hidden; padding: 4px 8px; border: 0;
  color: var(--text-2); background: var(--bg-l1);
  font-size: 11px; text-overflow: ellipsis; white-space: nowrap;
}
.wb-pane-feedback:empty { display: none; }
```

**四种覆盖态**（相当于「错误 / 权限请求」），共用 `.wb-pane-empty`（`style.css:29260-29273`：`display:grid; place-content:center; gap:7px; padding:20px; text-align:center`，字形 22px，`p { max-width:460px }`）：

| 状态 | JSX | 类 | CSS |
|---|---|---|---|
| WebSocket 被拦（iOS） | `panes.tsx:872-880` | `.wb-ws-blocked` | `:29278-29297`，`position:absolute; inset:0; z-index:3` |
| 控制权未知（遮住 iframe） | `panes.tsx:355-373,884` | `.wb-control-unknown` | `:29302-29315`，`z-index:4`，抢焦点 `tabIndex={-1}` |
| 首次权限检查 | `panes.tsx:886-892` | `.wb-control-checking` | `:29319-29325`，`z-index:4` |
| 无终端 / 无凭据 | `panes.tsx:898-917` | — | 基础 `.wb-pane-empty` |

> **安全设计值得抄**：控制权未知时 **iframe 根本不挂载**（`panes.tsx:856` + 注释 `:29299-29301`）——覆盖层只能挡指针，挡不住键盘进入已聚焦的 iframe。

**真正的聊天气泡在会话页，不在工作台**（`sessions-page.tsx:1866-1875`，`style.css:3955-3993`）：

```css
.history-list   { display: grid; gap: 4px; }
.history-msg    { display: flex; gap: 8px; align-items: flex-start; max-width: 82%; }
.history-msg.group-start:not(:first-child) { margin-top: 8px; }
.history-msg-meta { display:flex; gap:8px; margin-bottom:3px; color: var(--faint); font-size: 11px; }
.history-bubble {
  padding: 8px 11px;
  border-radius: var(--radius-lg);      /* 12px */
  border: 1px solid var(--border-soft);
  background: var(--surface-raised);
  font-size: 13px; line-height: 1.55;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
```

**用户消息不是右对齐气泡——全部左对齐。** 每条都是「头像 + 气泡」，`max-width:82%` 齐左，靠 `group-start`/`continuation` 做连续消息分组（同一发言人的后续消息隐藏头像和元信息行），**不靠左右分边**。没有 `is-self` 变体，没有工具调用折叠，没有 diff 渲染器。

### D15. 分栏 / 抽屉 / 多面板

**已上线：单面板 + 开关，无 tab。** `.wb-pane-stack` 里恒定一个 `TerminalPane`。切换方式 = 会话行的「终端」按钮（`session-list.tsx:617-630`）→ `openSessionTerminal`（`view.tsx:422-426`），关闭 = 头部「关闭终端 ✕」（`view.tsx:563-570`）。意图状态机在 `agent-workbench-terminal-control.ts`。

**已实现但未接线：递归分栏树。** `WorkbenchPaneRegion` / `PaneTreeNode` / `SplitPane`（`panes.tsx:1090-1183`）完整实现并导出，但 `agent-workbench-view.tsx:52-56` **只 import 了 `TerminalPane` / `WebPane` / `WorkbenchInfo`**。类型在 `model.ts:66-75`，`paneTreeForLayout`（`:218-230`）能产出单面板或「终端|网页」横向分栏。

```css
/* style.css:29139-29158 */
.wb-pane-split { display: flex; overflow: hidden; }
.wb-pane-split.is-horizontal { flex-direction: row; }
.wb-pane-split.is-horizontal > :first-child { flex: 0 0 calc(var(--wb-split-first)  - 3px); }
.wb-pane-split.is-horizontal > :last-child  { flex: 0 0 calc(var(--wb-split-second) - 3px); }
.wb-pane-separator {
  display: grid; place-items: center;
  flex: 0 0 6px; padding: 0; border: 0;
  color: var(--wb-faint); background: var(--wb-bg);
}
.wb-pane-split.is-horizontal > .wb-pane-separator { cursor: col-resize; }
.wb-pane-split.is-vertical   > .wb-pane-separator { cursor: row-resize; }
```

比例夹在 **0.28–0.72**（`model.ts:184-187`）。

**`WorkbenchInfoDrawer`**（`panes.tsx:1212-1223`）——右侧抽屉，同样导出但桌面端未用（只有移动端「信息」页用了它的 body）。CSS `style.css:29327-29366`：

```css
.wb-info-drawer {
  position: absolute; top: 106px; right: 0; bottom: 0; z-index: 8;
  width: min(330px, 42%);
  border: 0; border-left: 1px solid var(--border-keep);
  border-radius: var(--radius-lg) 0 0 var(--radius-lg);
  background: var(--bg-l2); box-shadow: var(--shadow-pop);
  overflow: auto;
}
.wb-info-content dl > div {
  display: grid; grid-template-columns: 92px minmax(0, 1fr);
  gap: 8px; padding: 7px 0;
}
```

**分段控件惯用法**（`style.css:30033-30082`）——容器管圆角 + `overflow:hidden`，子项永远方角：

```css
.wb-seg {
  display: flex; align-items: stretch; flex: 0 0 auto;
  padding: 0; border: 0;
  border-radius: var(--radius-lg);
  background: var(--bg-l2);
  overflow: hidden;                       /* 子项方角被容器裁成圆角 */
}
.agent-workbench-page .wb-seg-item {
  min-width: var(--touch-target); min-height: var(--touch-target);
  padding: 0 10px; border: 0; border-radius: 0;
  color: var(--text-2); background: transparent;
  font-size: 12px; font-weight: 500;
}
.wb-seg-item:hover, .wb-seg-item.is-on { background: var(--bg-l3); }
```

### D 附：移动端与拖拽条

**移动端不是「收起」，是「下钻堆栈」。** 注释 `view.tsx:632-636` 明确：不做页内 tab bar，否则会和飞书自己的 tab bar 叠成两层导航。

JS 断点阶梯（`agent-workbench-model.ts:247-295`），由 `useViewportWidth`（`view.tsx:122-132`，`resize` 监听）驱动：

| 宽度 | `step` | 效果 |
|---|---|---|
| `< 620` | `mobile-stack` | `mode:'mobile'`，强制折叠会话栏，`chatMode:'jump'` |
| `< 960` | `chat-jump` | 桌面，强制 `paneMode:'focus'`，聊天跳出页面 |
| `< 1120` | `focus` | 桌面，强制 `paneMode:'focus'` |
| `< 1280` | `rail-collapsed` | 尊重用户的 `paneMode` |
| `≥ 1280` | `full` | 全部尊重 |

注意 `railCollapsed` 在桌面**任何宽度都不强制**（注释 `model.ts:257-260` + `view.tsx:491-500`）——折叠和它的恢复入口必须共存亡。

移动端页面态 `type MobilePage = 'sessions' | 'workspace' | 'preview' | 'info'`（`view.tsx:98`），结构 `view.tsx:637-668`：

```css
/* style.css:29386 —— 一行，同时只有一个在流内 */
.wb-mobile-stack { display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; overflow: hidden; }

/* style.css:29724-29786 */
.wb-mobile-detail {
  display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;   /* 底部抽屉形状 */
  background: var(--bg-l1); overflow: hidden;
}
.wb-mobile-back { min-height: 44px; padding: 0 8px; border: 0;
                  border-radius: var(--radius-md); color: var(--accent); background: transparent; }
.wb-mobile-detail-seg button[aria-current="page"] {
  color: var(--text-1); font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--accent);   /* 下划线用 inset 阴影 */
}
```

**去重规则**（`style.css:29841-29846`）——手机上隐藏工作区头部，因为详情栏已经有标题和切换器：

```css
@media (max-width: 620px) {
  .wb-mobile-detail .wb-workspace-header { display: none; }
  .wb-mobile-detail .wb-workspace { grid-template-rows: minmax(0, 1fr); }   /* 必须同时改成 1 行 */
}
```

注释 `:29835-29840` 点出这个坑：头部 `display:none` 后不占 grid 格，若还留着开头的 `auto` 行，它会吃掉面板堆栈，终端渲染成 0 高。

**指针类型与宽度分开判断**（`style.css:29807-29829`）：

```css
@media (hover: none) {
  .agent-workbench-page, .agent-workbench-dock { --touch-target: 44px; }
  .wb-session-row-action { min-width: 44px; height: 44px; padding: 0 10px; font-size: 13px; }
  .wb-desktop-layout.is-rail-collapsed:not(.is-terminal-closed) { grid-template-columns: 44px minmax(0, 1fr); }
  .wb-session-rail.is-collapsed { width: 44px; }
}
```

横屏 iPad（1024–1366px + `hover:none`）在这段出现前会同时漏掉宽度查询和桌面默认值。

**拖拽条实现**（`agent-workbench-view.tsx:428-478`），四个值得抄的细节：

```js
const resizeRail = (event) => {
  event.preventDefault();
  const separator = event.currentTarget;          // React 在 handler 后会清空 currentTarget，先存
  separator.setPointerCapture?.(event.pointerId); // ① 不捕获的话指针滑进 iframe 就丢事件
  const root = rootRef.current;
  root?.classList.add('is-rail-dragging');
  const startX = event.clientX;
  const startWidth = layout.railWidth;
  let pendingX = startX, appliedX = startX, frame = 0;
  const apply = () => { frame = 0; appliedX = pendingX;
                        updateLayout({ railWidth: startWidth + appliedX - startX }); };
  const move = (next) => { pendingX = next.clientX;
                           if (frame === 0) frame = window.requestAnimationFrame(apply); };  // ② 每帧一次
  const stop = () => {
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0; }
    if (pendingX !== appliedX) apply();           // ③ 补最后一次采样，否则停在两帧之间会丢像素
    root?.classList.remove('is-rail-dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    separator.removeEventListener('lostpointercapture', stop);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  separator.addEventListener('lostpointercapture', stop);   // ④ 捕获丢失不触发 pointerup
};
```

键盘可达：`ArrowLeft/Right` 每次 ±8px（`view.tsx:472-477`），元素是 `<button role="separator" aria-orientation="vertical" aria-valuenow={...}>`。

```css
/* style.css:28965-28989 —— 6px 热区全透明，只有 3×28 的小药丸可见 */
.wb-rail-separator {
  z-index: 2; display: grid; place-items: center;
  width: 6px; min-width: 6px; padding: 0; border: 0;
  color: transparent; background: transparent;
  cursor: col-resize;
}
.wb-rail-separator > span {
  display: block; width: 3px; height: 28px;
  border-radius: var(--radius-full);
  background: var(--border-keep);
  transition: background-color .14s ease-out;
}
.wb-rail-separator:hover > span,
.wb-rail-separator:focus-visible > span { background: var(--text-3); }

/* style.css:30019-30020 —— 拖拽时锁掉选中和 iframe 命中 */
.agent-workbench-page.is-rail-dragging { user-select: none; }
.agent-workbench-page.is-rail-dragging iframe { pointer-events: none; }
```

宽度持久化是**全局的，不按会话存**（`view.tsx:300-305`，debounce 250ms）——按会话存会导致每次切会话侧栏跳一下（注释 `view.tsx:274-281`）。

---

## E. 视觉气质（确切数值）

### E16. 卡片

**全站有两套卡片体系，取值不同。**

**Dashboard 侧**——基础定义有 5 处，但**真实页面看到的是被 `.page` 拍平后的版本**：

```css
/* style.css:679-686 —— 基础 */
.panel, .metric-card, .bd-card {
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);       /* 8px */
  box-shadow: var(--shadow);
}
/* style.css:13365-13371 */
.card { border: 1px solid var(--border-soft); border-radius: var(--radius-xl);  /* 16px */
        background: var(--surface); box-shadow: var(--shadow); padding: 16px 18px; }

/* style.css:13981-13987 —— 真实页面生效的覆盖 */
.page :where(.card, .bd-card, .panel, .metric-card, .roles-tree-panel,
             .roles-editor-panel, .v3r-graph-card, .v3r-panel) {
  border-color: var(--border-soft);
  border-radius: var(--radius-lg);    /* 12px —— 把 8/16 统一成 12 */
  background: var(--surface);
  box-shadow: none;                   /* ← 阴影被抹掉 */
}
```

**结论：页面里的卡片是平的——`background: var(--surface)` + `1px solid #eceef4` + `12px` 圆角 + 无阴影。** 基础规则里那些 `var(--shadow)` 全部失效。

内边距：`.card` 16px 18px；`.panel-header` 16px 18px（`:699-706`）；`.metric-card` 14px 15px（`:731-733`）；`.bd-tile` 4px 18px 16px（`:11147-11153`，上边距刻意小）。

**工作台侧**：`.wb-pane` **零边框零圆角零阴影**（见 D14）；`.wb-session-row` 也没有卡片壳，靠 `::before` 垫片画底色。

### E17. 按钮

**没有 `.btn` 类**，样式挂在裸 `button` 元素和 `.btn-link` 上。

```css
/* style.css:2188-2205 —— 全局基础 */
button, .btn-link {
  min-height: 32px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 0 var(--button-padding-x);     /* 14px */
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);        /* 6px */
  background: var(--surface-raised);
  color: var(--fg);
  line-height: 1;
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: default; }

/* style.css:15841-15856 —— .page 内真实生效 */
.page :where(button:not(.card-act):not(.term-btn):not(.modal-close)…, .btn-link:not(.card-act):not(.term-btn)) {
  min-height: var(--button-height);       /* 32px */
  padding: 0 var(--button-padding-x);     /* 14px */
  border-radius: var(--radius-full);      /* 999px —— 全圆胶囊 */
  font-weight: 650;                       /* 非常规可变字重 */
  line-height: 1;
  box-shadow: none;
  transition: border-color 150ms ease, background-color 150ms ease,
              color 150ms ease, transform 150ms ease;
}
```

**页面里的按钮是 32px 高的胶囊，不是 6px 圆角矩形。**

| 类型 | 高 | 圆角 | 字号/字重 | 背景 | 边框 | 文字 |
|---|---|---|---|---|---|---|
| **主** `.primary` | 32px | 999px | 继承 / 650 | `var(--accent)` | `var(--accent)` | `var(--on-accent)` |
| **次** `.ghost` | **28px** | 999px | **12px** / 650 | `color-mix(surface 72%, transparent)` | `var(--border-soft)` | `var(--muted)` |
| **危险** `.danger` | 32px | 999px | 继承 / 650 | **透明** | `color-mix(danger 48%, border-soft)` | `var(--danger)` |

```css
/* style.css:15857-15868 */
.page :where(button.primary, .btn-link.primary) {
  border-color: var(--accent); background: var(--accent);
  color: var(--on-accent); box-shadow: none;
}
.page :where(button.primary, .btn-link.primary):hover {
  border-color: var(--accent-strong);
  background: color-mix(in srgb, var(--accent) 88%, white 12%);
}
/* style.css:15870-15880 —— 危险键是描边不是实心 */
.page :where(button.contrast, button.danger) {
  border-color: color-mix(in srgb, var(--danger) 48%, var(--border-soft));
  background: transparent; color: var(--danger);
}
.page :where(button.contrast, button.danger):hover {
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 9%, transparent);
}
/* style.css:15893-15898 —— 次级键 hover 上浮 1px */
.page :where(button.ghost, …):hover {
  border-color: color-mix(in srgb, var(--accent) 42%, var(--border-soft));
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--accent-strong);
  transform: translateY(-1px);
}
```

**同一语义有三种长相**，这是 botmux 的不一致处，不建议抄：
- `.page` 内：主=实心，危险=描边
- `dialog` 内（`style.css:4338-4356`）：主**反转成描边**
- `.confirm-modal-footer`（`:30515-30553`）：又变回实心

**图标按钮** `.card-act`（`style.css:4053-4083`，被显式排除在胶囊规则外）：`30×30px`，`border-radius: var(--radius-sm)`（6px，保持方形感），图标 15×15 `stroke-width:1.4`，`:active { transform: scale(0.9) }`。

**表单控件**（`style.css:1712-1761`）：`min-height:34px; padding:7px 11px; border:1px solid var(--border); border-radius:8px; font-size:13px`；焦点 `border-color:var(--accent) + box-shadow: 0 0 0 3px var(--accent-soft)`。

> ⚠️ **输入框 34px，按钮 32px——并排放在工具条里对不齐。** 这是既存 bug。

### E18. 列表行高与间距

| 组件 | 高度 | 内边距 | 分隔方式 |
|---|---|---|---|
| `.overview-list-item`（`:1609-1633`） | `min-height: 46px` | `9px 10px` | **各自 1px 边框 + gap** |
| `.wb-item`（`:15075-15104`） | — | `12px` | 各自边框 |
| `.wb-session-row`（`:29606`） | **54px**（触控 60px） | `5px 14px 5px 22px` | **无边框**，靠 `::before` 垫片 |
| 工作台组标题（`:29963`） | **30px** | `5px 14px 3px 22px` | 无 |
| `.schedule-list-row`（`:14108`） | `min-height: 84px` | `11px 12px` | 各自边框 |
| `.session-card`（`:2645-2660`） | `min-height: 132px` | `11px` | 各自边框 |
| `th, td`（`:1962-1970`） | — | `11px 13px` | `border-bottom` |
| 侧栏导航项（`:8309`） | `min-height: 36px` | `8px 12px 8px 16px` | gap 2px |

```css
/* style.css:1609-1633 —— dashboard 的标准行：每行是独立的圆角胶囊 */
.overview-list-item {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 46px;
  padding: 9px 10px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--surface-muted) 36%, transparent);
  transition: border-color 150ms ease, background-color 150ms ease, transform 150ms ease;
}
.overview-list-item:hover {
  border-color: color-mix(in srgb, var(--accent) 32%, var(--border-soft));
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  transform: translateY(-1px);
}
```

**Dashboard 的列表行不用 `border-bottom` 分隔线**——每行是独立的带边框圆角块，靠 gap 隔开，hover 上浮 1px。工作台反过来：完全无边框，靠垫片色差。

### E19. 何时画边框，何时靠留白/色差 —— **这是本文最有价值的一条**

**工作台段落有三条硬约束**，写在 `style.css:28412-28418`，并由 `test/agent-workbench-style.test.ts` **机器强制**：

```
① 实线只给白名单五类，颜色只能取 var(--border-keep)：
   1. 内容区 ↔ 固定工具条的功能性边界
   2. chip 的 1px 亮环
   3. 脱离文档流的浮层外圈
   4. :focus-visible 焦点环
   5. 选中态的 accent 内投影
   其余一律 border: 0，分层交给 --bg-l0..l3 的色差和留白。
② 每个 border-radius 只能是 var(--radius-sm|md|lg|full) / 0 / 50%，
   裸像素值是漂移 bug，样式契约测试会拦。
③ 段内零渐变、零装饰阴影；只有浮层用 --shadow-pop。
```

测试实际断言（`test/agent-workbench-style.test.ts:84,108-123`）：

```js
expect(block).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);   // 零渐变
const allowed = /^(?:0|50%|var\(--radius-(?:sm|md|lg|full)\))$/;       // 圆角白名单
```

**四级表面色阶**（`style.css:28447-28450` 暗 / `28508-28511` 亮），相邻档亮度比控制在 1.08–1.5：

| token | 暗色 | 亮色 | 用途 |
|---|---|---|---|
| `--bg-l0` | `#141922` | `#e8ecf1` | 最底层（工作区头部） |
| `--bg-l1` | `#19212c` | `#f3f6f9` | 会话栏、面板标题栏、反馈行 |
| `--bg-l2` | `#202a36` | `#ffffff` | 浮层、搜索框、分段控件槽 |
| `--bg-l3` | `#333f4e` | `#c9d7e8` | hover / 选中 / 分段控件激活 |
| `--border-keep` | `#2e3a48` | `#c2cdda` | **唯一的线条色** |

**判断规律（可直接复用）**：

1. **相邻两块是「同一平面的不同区域」→ 不画线**，换 `--bg-lN` 档位。例：会话栏 vs 工作区（差 l1/l0）。
2. **相邻两块是「内容 vs 固定工具条」→ 画线**。例：`.wb-workspace-header` 的 `border-bottom`——因为工具条不随内容滚动，需要一条功能性边界。
3. **脱离文档流的东西（菜单、抽屉、气泡）→ 画线 + `--shadow-pop`**。它浮在不确定的背景上，色差不可靠。
4. **小尺寸元素（chip、徽标）→ 画 1px 中性环**，语义只走文字色和 12% 填充。环不承载语义。
5. **状态（hover / 选中）→ 永远用色块，不用线**。选中的方向感靠 `inset` 内投影（`box-shadow: inset 2px 0 0 var(--accent)`），不用 `border-left`——后者在圆角处会露直角。

Dashboard 侧没有这套机器约束，所以出现了 §0.1、§E17 那些不一致。**工作台这套是 botmux 明显更成熟的部分，dutydeck 应当照抄这个方法论而不是抄具体色值。**

### E20. 渐变、模糊、动效

**渐变：55 处 `linear-gradient` + 17 处 `radial-gradient`，但核心 UI 是平的。**

集中在三个地方：

1. **品牌标识**（`style.css:9036-9069`）——字标是三色渐变 + 8s 循环高光扫过：
   ```css
   .topbar .brand-wordmark {
     background-image:
       linear-gradient(102deg, transparent 44%, color-mix(in srgb, var(--brand-accent-bright) 78%, #fff) 50%, transparent 56%),
       linear-gradient(135deg, var(--brand-accent-cyan) 0%, var(--brand-accent) 52%, var(--brand-accent-pink) 100%);
     background-size: 250% 100%, 100% 100%;
     -webkit-background-clip: text;
     -webkit-text-fill-color: transparent;
     animation: topbar-brand-sheen 8s linear infinite;
   }
   @keyframes topbar-brand-sheen {
     from { background-position: 145% 50%, 0 50%; }
     to   { background-position: -45% 50%, 0 50%; }
   }
   ```
2. **顶栏状态甜甜圈**——`conic-gradient`，见 §A1。
3. **分隔线**——topbar `::after` 和 `.page-heading::after` 都是两端淡出的 `linear-gradient`，不是纯色 border（见 §A1、§C 页头）。
4. `style.css:20390+` 是可选的 `[data-skin="cyber"]` 皮肤（扫描线、雨、网格），**不是默认外观**。

**背景光斑 `.aurora`**（`app.tsx:1268`，`style.css:8160-8165`）：

```css
.aurora   { display: none; position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.aurora i { position: absolute; border-radius: 50%; filter: blur(110px); opacity: 0.30; }
.aurora .a1 { width:520px; height:420px; left:-20px;  top:-200px;    background:#1b4dff; opacity:.18; }
.aurora .a2 { width:520px; height:440px; right:-90px; top:-80px;     background:#00c2d8; opacity:.17; }
.aurora .a3 { width:620px; height:420px; left:38%;    bottom:-280px; background:#6b3df0; opacity:.13; }
:root[data-theme="light"] .aurora { display: none; }
```

**注意 `.aurora` 基础规则就是 `display:none`**，只在暗色 + default skin 下被打开——亮色主题完全看不到。

**模糊：40 处 `backdrop-filter`，其中 9 处是 `none`（新版扁平设计主动拆掉旧毛玻璃）。**

| 位置 | 值 |
|---|---|
| `.topbar`（`:8447`） | `blur(16px)` |
| 移动端 `.sidebar`（`:13502`） | `blur(14px)` |
| `dialog::backdrop`（`:4176`） | `blur(3px)` |
| 暗色卡片若干（`:10179` 等） | `blur(18-20px)` |
| `.page` 内卡片（`:13994`） | **`none`**（拆掉） |

**动效：50 个 `@keyframes`，约 25 个属于 cyber 皮肤。** 核心 UI 只有：

| 动画 | 位置 | 值 |
|---|---|---|
| 页面进入 | `:587-597`，用于 `.page`（`:612`） | `opacity 0→1 + translateY(6px)→0`，`0.35s ease both` |
| 浮层进入 | `:598-608` | 同上但 `translate(-50%, 6px)` |
| 看板卡入场 | `:2675-2678` | `280ms ease backwards`，按 `nth-child` 错开 30/75/120/165/210ms，**仅首次绘制** |
| 待处理列脉冲 | `:2639-2642` | 扩散 box-shadow 环，只在「待你处理」列 |
| 品牌高光 | `:9069` | 8s linear infinite |
| 确认弹窗 | `:30481-30484` | `translateY(12px) scale(.98)` → none |

**两档过渡时长**：`150ms ease`（`.page` 内按钮/tab/行）和 `.15s ease`（表单控件、`.card-act`）；token 里另有 `--t-fast: 120ms ease-out` / `--t-norm: 180ms ease-out`。工作台统一用 `.14s ease-out`。

**`prefers-reduced-motion` 至少 9 处响应**，工作台是整段 `!important` 全关（`:29461-29464`）。

---

## 附录：给 dutydeck 的可抄清单

**建议直接抄的（有证据支撑其优越性）：**

1. **工作台的三条样式硬约束 + 契约测试**（§E19）——`test/agent-workbench-style.test.ts` 用正则拦渐变和裸像素圆角。这是唯一能防止设计系统腐坏的机制。
2. **四级表面色阶 `--bg-l0..l3` + 单一线条色 `--border-keep`**（§E19）——比「哪里该画线」的口头约定可执行得多。
3. **`display: contents` 做移动端导航降级**（§A4）——一套 DOM 两种布局，零 JS。
4. **`NAV_GROUPS` 只存 id、不复制权限逻辑**（§A2）——可见性过滤集中在一条链路。
5. **虚拟列表行高的 JS/CSS 双向契约**（§B 附）——注释 + 单测双保险。
6. **拖拽条的四个细节**（§D 附）——pointer capture、rAF 合帧、`lostpointercapture` 兜底、收尾补一次 apply。
7. **选中态用 `box-shadow: inset` 而非 `border-left`**（§B7）——跟随圆角。
8. **控制权未知时不挂载 iframe**（§D14）——覆盖层挡不住键盘。
9. **`SectionHeader` 的 `::before` 圆点 + 计数胶囊**（§C 附）。
10. **状态数字与图形共用同一份 summary 函数**（§A1）。

**明确不要抄的：**

1. **两份 token 文件互相覆盖**（§0.1）——`--topbar-h` / `--topbar-height` 双变量导致 4px 错位，`--sidebar-width` 是纯死配置。
2. **`.page` 作用域二次覆盖全局组件**（§0.2）——同一个按钮要读三处 CSS 才知道长什么样。
3. **设置分散在 8 条路由 + 4 种页内导航模式 + 3 套 tab 类族**（§C11）。
4. **主/危险按钮在 dialog 内外长相不同**（§E17）。
5. **输入框 34px vs 按钮 32px**（§E17）。
6. **命令面板只在单个页面内有效**（§C12）——Cmd+K 在其他 22 个路由上都是哑的。
7. **`style.css:6764` 那段针对旧栅格布局的 `@media`**——已是死代码。
8. **`customization-page.tsx` 内联 `<style>` + 硬编码中文**（§C11）。
