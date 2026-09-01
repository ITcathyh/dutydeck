# Dockmux Web 设计系统契约

> 日期：2026-09-01
> 状态：重构执行契约。Phase 0 产出此契约的实现，Phase 1 三个团队并发消费。
> 上位规范：`docs/interaction-design-2026-08-30.md`（产品范式与交互秩序）。本文只管**视觉与组件层**，不改那份文档定义的任何信息秩序。

## 0. 为什么需要这份契约

重构前实测（`apps/web`，约 5000 行）：

| 症状 | 实测 |
| --- | --- |
| 共享 UI 原语 | 27 个组件文件 / **2 个原语**（IconButton、DockmuxIcon） |
| 内联 `var(--token)` | **1390 处**，className 占源码字符 **19.3%** |
| 硬编码字号 | **247 处**，叠加 Tailwind 6 级 ≈ **14 档并存** |
| 圆角 | 5 档散落，无取档规则 |
| Tailwind 自定义色 | `ink/canvas/line/accent` **零引用**，死配置 |
| Dialog 遮罩壳 | **11 份**手写副本；9 个 `role=dialog` / **0 个 portal** / 5 档手工 z-index |
| 次要按钮 / 错误横幅 / 警告横幅 | 28 / 17 / 17 份手写副本 |
| Escape 监听 | **7 份**独立实现，行为还不一致 |
| 任务行 | **3 份**平行实现，措辞已开始漂移 |

语义层（`workspace-model.ts`、`ui.tsx`）已经建立了很好的"单一副本"纪律，长注释记录了反复被"同一判断散在 N 处然后漂移"咬过的历史。**这份契约把同一条纪律套用到视觉层。**

## 1. 不可妥协的六条

1. **Token 只有一处定义**。任何颜色、字号、间距、圆角、阴影、层级的字面量，只允许出现在 `tokens.css`。组件里出现第二个字面量即为缺陷。
2. **组件消费语义类，不消费 token 名**。写 `bg-surface`，不写 `bg-[var(--surface-default)]`。token 名是实现细节。
3. **尺度必须肉眼可辨**。相邻档位差异不足以区分时，合并档位，不新增。
4. **默认无线**。分层优先用表面色差与留白；边框需要理由（见 §5）。
5. **规范由测试守护**。每条可机检的规则都必须有对应断言，否则视为未落地。
6. **不破坏行为契约**。基线 `1913 passed / 1 failed`（失败项 `claude-launcher.test.ts` 是本机环境污染，与前端无关）。27 个 dom 测试文件约 504 个用例是硬约束。

## 2. 字号：6 档（从 14 档收敛）

`docs/interaction-design-2026-08-30.md` §7.3 要求正文 14px、辅助文字不回退到 8–10px、11px 仅用于低频元数据。当前有 90 处 10px、8 处 9px，系统性违规。

| 语义类 | size / line-height | 用途 | 迁移自 |
| --- | --- | --- | --- |
| `text-meta` | 11px / 16px | **仅限**低频元数据：runId、精确时间戳、版本号 | `text-[9px]` `text-[10px]` `text-[11px]` |
| `text-caption` | 12px / 18px | 辅助说明、字段提示、徽标 | `text-xs` `text-[12px]` |
| `text-body` | 14px / 22px | **正文默认**。正文与所有交互控件的默认字号 | `text-sm` `text-[13px]` `text-[14px]` |
| `text-title` | 16px / 24px | 卡片标题、区块标题、Dialog 标题 | `text-base` `text-[15px]` |
| `text-heading` | 20px / 28px | 页面次级标题 | `text-lg` `text-xl` |
| `text-display` | 28px / 36px | 页面主标题（任务中心 h1） | `text-2xl` `text-[28px]` |

**禁止**：任意 `text-[Npx]`；`text-meta` 用于任何可交互元素或正文。

字重 3 档：`font-normal` 400 / `font-medium` 500 / `font-semibold` 600。禁止 650、760 等任意值。

## 3. 圆角：4 档 + full，按高度取档

取档公式（借鉴 botmux，已验证）：**半径 ≈ 元素高度 / 3.5**，每档 1.4–1.7× 递进。

| 语义类 | 值 | 适用元素高度 | 典型 | 迁移自 |
| --- | --- | --- | --- | --- |
| `rounded-sm` | 6px | ≤30px | 徽标、chip、内联标签、kbd | `rounded-md` |
| `rounded-md` | 10px | 31–47px | 按钮、输入框、下拉、列表行 | `rounded-lg` |
| `rounded-lg` | 14px | ≥48px | 卡片、面板、popover | `rounded-xl` |
| `rounded-xl` | 20px | 大型容器 | Dialog、Composer 外框 | `rounded-2xl` |
| `rounded-full` | 999px | **仅正圆** | 状态点、头像、圆形图标钮 | `rounded-full` |

**禁止**：`rounded-full` 用在矩形上（药丸形徽标用 `rounded-sm`）。

## 4. 间距：4px 基准

沿用 Tailwind 默认 4px 刻度（`1`=4px … `12`=48px）。**禁止任意值** `p-[Npx]` / `gap-[Npx]`。当前存在 `gap-1.5`（6px）等半档，允许保留 `.5` 档（2px 粒度），但不引入 4px 网格外的值。

## 5. 边框：白名单

默认 `border: 0`。只有以下 5 类允许画线，颜色只能取 `border-default` / `border-subtle` / `border-strong`：

1. 内容区与固定工具条之间的功能性边界（header 底边、Composer 顶边）
2. 输入类控件的可点击边界（input / select / 次要按钮）
3. 脱离文档流的浮层外圈（Dialog / Popover / Toast）
4. `:focus-visible` 焦点环
5. 状态语义色的软底卡片外圈（`status-*-soft` 配 `status-*-border`）

其余分层交给表面色差（`surface-canvas` → `surface-default` → `surface-muted` → `surface-hover`）与留白。

## 6. 表面层与亮度约束

四层表面，相邻层亮度比落在 **1.08–1.5**（低于 1.02 看不见，高于 1.6 读成"块"而非"层"）：

`surface-canvas`（页面底） → `surface-default`（卡片/面板） → `surface-muted`（内嵌区块） → `surface-hover`（悬浮/选中）

侧栏保留独立的 `sidebar-*` 深色盘（双主题下恒深色），这是刻意的导航底盘，不与内容表面混用。

三档文字（`text-primary` / `text-secondary` / `text-muted`）在四个表面上均须 ≥4.5:1（WCAG AA）。

## 7. 层级：z-index token 化

取消 5 档手工 z-index。统一为：

| token | 值 | 用途 |
| --- | --- | --- |
| `z-base` | 0 | 常规内容 |
| `z-sticky` | 100 | 吸顶工具条、浮动汉堡钮、回到底部 |
| `z-drawer` | 800 | 移动侧栏、原始日志抽屉 |
| `z-dialog` | 900 | 所有模态（由 Dialog 原语统一 portal 到 body） |
| `z-toast` | 1000 | Toast |

**所有模态必须经 Dialog 原语 portal 到 `document.body`**，不再在组件树里就地渲染。

`useDialogFocus` 里的两段补偿逻辑（"猜最后一个 dialog"、"手工遍历兄弟节点打 inert"）
**Phase 1 期间不得删除**。Phase 0 实测确认它们仍被依赖：

- `NewSessionModal.tsx:35` 与 `LarkConfigModal.tsx:17` 调用了 hook 但**不挂 ref**，
  删掉"猜最后一个 dialog"这两个弹层的焦点根本进不去；
- "兄弟节点 inert"是 `App.dom.test.tsx:120` 那条 `<main inert>` 断言的来源。

清理时机改挂 **Phase 2**：等 11 份遮罩壳全部迁到 `<Dialog>`、两个漏挂 ref 的弹层
一并修好之后再删，并同步核对上述断言。

## 8. 动效

沿用现有 `.ui-*` 动画类与 keyframes（`index.css` 已有 11 个，且有测试守着"不得自造 keyframes"）。时长收敛为 2 档：

- `duration-fast` 120ms ease-out：hover、focus、色彩过渡
- `duration-normal` 180ms cubic-bezier(.16,1,.3,1)：浮层进出、位移

`prefers-reduced-motion: reduce` 分支必须保留现有 4 条 `!important`（`app-smoke.test.ts:45` 断言）。

## 8.1 Escape 的嵌套语义（Phase 0 补充，已采纳）

一次 Escape **只关最上面一层**。`useEscapeKey` 内部维护 LIFO 栈，只有栈顶的监听响应。

不能靠 `stopPropagation` 解决：所有监听都挂在 `document` 同一阶段，互相不取消；
`stopImmediatePropagation` 依赖注册顺序，恰恰是不可靠的那个东西。所以显式维护栈。

典型形状是"模态里套浮层"（`NewSessionModal` 的 Agent 选择器）：没有这条规则，用户
想收起下拉会连整张填了一半的表单一起丢掉。

各浮层"什么算忙"的差异一律通过 `enabled` 参数表达，不在 hook 内判断：
- 提交中不允许关闭的（ConfirmDialog / LarkConfigModal / NewSessionModal / ControlCenterModal）传 `open && !busy`
- 无条件关闭的（ShortcutHelpSheet）传 `open`

## 9. 触控目标

`docs/interaction-design-2026-08-30.md` §7.3：**≥40px**，高频移动操作建议 44px。当前 9 个按钮低于此线，其中包括风险最高的权限审批按钮（`PermissionCard.tsx:11`，32px）和不可逆的归档按钮（`ui.tsx:124`，32px）。

| size | 高度 | 用途 |
| --- | --- | --- |
| `sm` | 32px | **仅限**非关键的密集工具条，且必须有 ≥40px 的等价入口 |
| `md` | 40px | **默认**。所有主要交互 |
| `lg` | 44px | 移动端高频操作（TerminalKeyBar 已达标） |

图标按钮的**视觉尺寸**可以是 32px，但**命中区**必须 ≥40px（用 padding 或 `::before` 扩展）。

## 10. 原语 API 契约

目录 `apps/web/src/components/primitives/`。**Phase 0 已冻结此 API，Phase 1 三队并发消费，不得擅改签名。**

### 导入纪律（Phase 1 硬规则）

**一律从 `components/primitives` 导入，不从 `components/ui` 导入任何组件。**

`IconButton` 现在有两份同名导出：`ui.tsx` 的旧版（32px 命中区）和 `primitives/` 的新版
（40px 命中区）。import 错了触控修复就不生效，而且**看不出来**——两者视觉一致。
契约 §9 要修的 9 个低于 40px 的按钮（含 `PermissionCard` 的权限审批钮与 RunHeader
的归档钮）全都依赖这次替换。

`ui.tsx` 保留的是**语义函数**，继续从那里导入：`effectiveStatus` / `sidebarStatusVisual` /
`createTaskAffordance` / `stateLabels` / `permissionLabels` / `busyStates` / `parseMemberNames`。

迁移完成后由 Phase 2 删除 `ui.tsx` 的 `IconButton` 与 `stateBadgeStyle`
（后者在 `WorkspaceOverview` / `CommandPalette` 迁到 `StatusBadge` 后即无引用）。

```ts
// Button.tsx
type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';  // 默认 secondary
  size?: 'sm' | 'md' | 'lg';                                // 默认 md (40px)
  tone?: 'default' | 'inverse';                             // inverse = surface-inverse 底
  loading?: boolean;                                        // 自动 aria-busy + spinner
  icon?: ReactNode; iconEnd?: ReactNode;
  fullWidth?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

// IconButton.tsx  —— 保留现有导出名与 props 形状（8 个文件 14 处在用）
type IconButtonProps = {
  label: string;              // 同时作 title + aria-label
  size?: 'sm' | 'md';         // 视觉 32/40，命中区恒 >=40
  tone?: 'default' | 'danger';
  disabled?: boolean; onClick(): void; children: ReactNode;
};

// Card.tsx
type CardProps = {
  tone?: 'default' | 'muted' | 'dashed';         // dashed = 空态虚线框
  padding?: 'none' | 'sm' | 'md' | 'lg';         // 0 / 12 / 16 / 24
  as?: 'div' | 'section' | 'article' | 'aside';
} & HTMLAttributes<HTMLElement>;

// Badge.tsx
type BadgeProps = {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'queued' | 'accent';
  variant?: 'soft' | 'outline';   // 默认 soft
  children: ReactNode;
};
// StatusBadge 消费 ui.tsx:effectiveStatus，取代 stateBadgeStyle 的字符串拼接
type StatusBadgeProps = { session: Session };

// Banner.tsx  —— 收敛 17 处错误横幅 + 17 处警告横幅
type BannerProps = {
  tone: 'danger' | 'warning' | 'info' | 'success';
  role?: 'alert' | 'status';        // danger 默认 alert，其余默认 status
  title?: ReactNode;
  action?: { label: string; onClick(): void; busy?: boolean };
  onDismiss?(): void;
  children: ReactNode;
};

// Dialog.tsx  —— portal 到 body，内建焦点陷阱 + Escape + inert 背景
type DialogProps = {
  open: boolean;
  onClose(): void;
  label: string;                    // aria-label
  size?: 'sm' | 'md' | 'lg' | 'xl'; // 420 / 640 / 960 / 1152
  role?: 'dialog' | 'alertdialog';
  closeOnEscape?: boolean;          // 默认 true；busy 时传 false
  closeOnScrim?: boolean;           // 默认 true
  initialFocus?: RefObject<HTMLElement>;
  children: ReactNode;
};
// 子组件：Dialog.Header / Dialog.Body / Dialog.Footer
// 内部复用现有 useDialogFocus（已是完整实现），仅补 portal

// Popover.tsx  —— Composer 5 个面板 + CompactSelect 复用
type PopoverProps = {
  open: boolean; onClose(): void;
  anchor: RefObject<HTMLElement>;
  placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  width?: number | 'anchor' | 'auto';
  children: ReactNode;
};
// 触发器必须由调用方补 aria-expanded / aria-haspopup —— 提供 usePopoverTrigger() 返回这两个属性

// Tabs.tsx  —— 详情页 timeline|terminal，内建 roving tabindex + 方向键/Home/End
type TabsProps<T extends string> = {
  value: T; onChange(value: T): void;
  label: string;
  items: Array<{ id: T; label: string; icon?: ReactNode }>;
};

// EmptyState.tsx  —— 收敛 21 处手写空态；三种语义不可混用
type EmptyStateProps = {
  tone?: 'neutral' | 'positive' | 'guide';
  // neutral  = 当前视图无结果（灰）
  // positive = 没有待办是好消息（绿勾），不得用灰色失望感呈现
  // guide    = 首次引导（带主 CTA）
  icon?: ReactNode; title: string; description?: string;
  primaryAction?: { label: string; onClick(): void; disabled?: boolean };
  secondaryAction?: { label: string; onClick(): void };
};
// 「无权限/读不到」不属于空态：整块隐藏，不画一个永远为空的面板

// Skeleton.tsx  —— 收敛 12 处 animate-pulse
type SkeletonProps = { variant?: 'text' | 'block' | 'row'; lines?: number; className?: string };

// Spinner.tsx  —— 收敛 19 处 animate-spin + 17 种「正在…」文案
type SpinnerProps = { size?: 'sm' | 'md'; label?: string };  // label 存在时渲染 role=status aria-live=polite

// Field.tsx  —— 收敛 14 处输入框手写
type FieldProps = {
  label: string; hint?: string; error?: string;
  required?: boolean; htmlFor?: string;
  children: ReactNode;   // Input / Textarea / Select / CompactSelect
};
// 自动接 aria-describedby（hint + error）与 aria-invalid
// 同目录附 Input / Textarea / Select，统一 40px 高与边框态

// Toolbar.tsx  —— 页头工具栏与筛选条
type ToolbarProps = { label: string; children: ReactNode };

// Kbd.tsx
type KbdProps = { children: ReactNode };
```

### 共享 hooks（同期落地，消除重复实现）

```ts
useMediaQuery(query: string): boolean   // 合并 App.tsx:131 与 SessionList.tsx:34 两份独立 matchMedia
useEscapeKey(enabled: boolean, handler: () => void)  // 合并 7 处独立 Escape 监听
```

`useDialogFocus` 保留现有实现（已正确），由 Dialog 原语内部调用；补 portal 后可删除"猜最后一个 dialog"与"手工遍历兄弟节点"两段补偿逻辑。

## 11. 数据层修复（本轮同步进行）

审计查出的真实缺陷，与视觉重构同期修：

1. **`DockEvent.data: any`**（`api.ts:27`）→ 按 `type` 收敛为判别联合。TimelineItem / ToolCard / ActivityPanel / composer-utils 目前全在 `any` 上做属性访问，后端字段改名不会有编译错误。
2. **飞书深链落 not-found**（`apps/server/src/lark/service.ts:349,364`）→ 无 sessionId 时应生成 `/`（任务中心），当前生成的 `/sessions` 会命中 not-found。
3. **`Composer.tsx:63` 重复的忙碌态判定** → 改用 `ui.tsx:26` 已导出的 `busyStates`。这正是 `ui.tsx` 大段注释警告的那类漂移。
4. **浮层无 URL 状态** → 9 个浮层全无 URL 表示，无法分享、后退键不关闭、刷新即丢失。至少让设置中心与飞书向导可深链。
5. **`session.error` 在详情页不可见** → RunHeader 说"查看失败详情"，但页面上没有失败详情。`sessionErrorSummary`（含 10 条正则脱敏管线）应在详情页消费。
6. **`/goal` `/fast` 空壳命令**（`Composer.tsx:12-13`）→ 服务端无任何实现，从 `baseCommands` 移除，或明确标注为文本片段插入。

## 12. 一致性测试（Phase 2 必须落地）

botmux 的教训：它定义了 8 档字号 token，实际引用 41 次，硬编码 px 上千次。**Token 没有强制力就只是愿望。** 以下每条都要有断言：

1. `src/**/*.tsx` 中不得出现 `text-[Npx]`（白名单：无）
2. 不得出现 `rounded-[Npx]`、`p-[Npx]`、`gap-[Npx]`
3. 不得出现 `bg-[var(--...)]` / `text-[var(--...)]` / `border-[var(--...)]` 形式的内联 token（应使用语义类）
4. 不得出现 Tailwind 原生调色板类（`bg-zinc-*` 等）—— 现有 3 个测试已覆盖，保留
5. 可交互元素（`<button>` / `<a>` / `role=button`）的高度类必须 ≥ `min-h-10`，`sm` 尺寸需显式标注豁免
6. 所有 `role="dialog"` 必须带 `aria-modal`，且必须来自 Dialog 原语
7. token 定义与本文档表格一致（照 botmux `agent-workbench-style.test.ts` 的做法，把数值白名单抄进测试）
8. `.ui-*` 动画类不得新增 keyframes（现有测试已覆盖，保留）

## 13. 迁移映射速查

| 旧写法 | 新写法 |
| --- | --- |
| `text-[9px]` `text-[10px]` `text-[11px]` | `text-meta`（仅元数据）或 `text-caption` |
| `text-xs` `text-[12px]` | `text-caption` |
| `text-sm` `text-[13px]` `text-[14px]` | `text-body` |
| `text-base` `text-[15px]` | `text-title` |
| `text-lg` `text-xl` | `text-heading` |
| `text-2xl` `text-[28px]` | `text-display` |
| `rounded-md` → `rounded-sm` ; `rounded-lg` → `rounded-md` ; `rounded-xl` → `rounded-lg` ; `rounded-2xl` → `rounded-xl` | 按 §3 高度取档核对 |
| `bg-[var(--surface-default)]` | `bg-surface` |
| `bg-[var(--surface-canvas)]` | `bg-canvas` |
| `bg-[var(--surface-muted)]` | `bg-muted` |
| `text-[var(--text-primary)]` | `text-primary` |
| `text-[var(--text-secondary)]` | `text-secondary` |
| `text-[var(--text-muted)]` | `text-subtle`（避让 Tailwind 的 `text-muted` 语义冲突） |
| `border-[var(--border-default)]` | `border-default` |
| `shadow-[var(--shadow-card)]` | `shadow-card` |
| 手写遮罩壳 11 份 | `<Dialog>` |
| 手写次要按钮 28 份 | `<Button variant="secondary">` |
| 手写错误/警告横幅 34 份 | `<Banner tone="danger|warning">` |
| 手写空态 21 份 | `<EmptyState>` |
| 手写骨架 12 份 | `<Skeleton>` |
| 手写 spinner 19 份 | `<Spinner>` |

## 14. Phase 1 落地实况（2026-09-01）

三队并发交付 + 整合，实测结果与契约的差异如下。**差异都有实测支撑，不是妥协。**

| 项 | 契约目标 | 实测 |
| --- | --- | --- |
| 内联 `var(--token)` | 0 | **0** |
| 硬编码字号 | 0 | **0** |
| 共享原语 | — | **16 个** |
| 测试 | 不低于 1913 | **2206 passed / 1 failed**（失败项为本机环境污染） |

### 已知例外（各有实测依据）

1. **`CommandPalette` 不用 `useEscapeKey`**。三个 jsdom 探针实测：只用 hook →
   外层 React `onKeyDown` 仍被调用（1/1）；hook + React `stopPropagation` → 0/0；
   hook + 原生 `stopPropagation` → 0/0。React 挂在 root container 而 `document`
   在冒泡链末端，中途 stop 会连 hook 一起掐死。**要兼得须把 hook 改捕获阶段**——
   那是冻结 API，挂 Phase 2，届时三处探针要重跑。

2. **`LarkConfigModal` 的「显示 Secret」保留手写按钮**。`IconButton` 是 40×40，
   套进 40px 高的输入框会撑破它；手写版命中区仍做到 40×40，输入框补 `pr-10`。

3. **`shadow-row-active` 单列一档**。侧栏选中行的左侧色条是「选中」的视觉承载而非
   分层阴影，复用 card/panel 那五档语义不符。

### Phase 2 待办（本轮刻意不做）

- 删 `ui.tsx` 的 `IconButton` 与 `stateBadgeStyle`（已确认全仓无引用，是死代码）
- 删 `useDialogFocus` 的两段补偿逻辑（前提：11 份壳全迁完 + 两个漏挂 ref 的弹层修好，
  本轮已满足前半，需复核 `App.dom.test.tsx` 的 inert 断言）
- `useEscapeKey` 改捕获阶段，然后统一 `CommandPalette`
- 原语加 `tone="sidebar"`：`Skeleton`/`EmptyState`/`Button` 都写死内容表面色，
  套到恒深色侧栏上浅色主题会深字压深底，目前靠 arbitrary variant 覆盖
- `IconButton` 透传 rest props，让 Composer 三个面板触发钮也能收敛

### 一致性测试的实际拦截记录

它不是摆设，本轮真的拦下了两次：
- 我把通知里的「撤销」写成 `Button size="sm"`（32px），触控断言当场红；
- `white/[.07]` 躲过了原生色阶正则——**测试漏了**，已补第 5 条规则并补 token。
