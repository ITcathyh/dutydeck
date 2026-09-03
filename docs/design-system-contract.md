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

侧栏走独立的 `sidebar-*` 命名空间，但**取值全部是 `var()` 引用、跟随主题**
（`tokens.css:164-175` 的 11 个 token，`design-tokens.test.ts` 有断言强制它们不得
写成硬编码副本）。命名空间的意义是「侧栏可以整体换一套映射而不动内容表面」，
不是「侧栏恒深色」。

> 2026-09-03 更正：本段原文是「侧栏保留独立的 `sidebar-*` 深色盘（双主题下恒深色）」。
> 那在 Team-Palette 冻结色板后就不成立了，是 Team-Sidebar 发现并报上来的。
> 留着这句反话的代价不是抽象的——旧 `SessionList` 里三处手写块正是拿「恒深色」
> 当理由，而那个理由已经死了。

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
type ButtonBase = {
  size?: 'sm' | 'md' | 'lg';                                // 默认 md (40px)
  loading?: boolean;                                        // 自动 aria-busy + spinner
  icon?: ReactNode; iconEnd?: ReactNode;
  fullWidth?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

// 2026-09-03 收紧：tone 一旦出现，variant 必须同时出现（见 §17.4）。
// 对**正确用法**完全兼容，只让「传 tone 却不声明强调级别」编译不过。
type ButtonProps = ButtonBase & (
  | { tone?: undefined; variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }  // 默认 secondary
  | { tone: 'default' | 'inverse'; variant: 'primary' | 'secondary' | 'ghost' | 'danger' }
);
// tone 只对 secondary / ghost 有效果（inverse = surface-inverse 底）；
// primary / danger 自带语义色，在任何底上不变，tone 对它们是空操作。

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
  侧栏里要用得靠 arbitrary variant 覆盖（原本的理由「恒深色侧栏上浅色主题会深字
  压深底」已随色板重做失效，但**待办本身仍成立**：原语缺 sidebar 变体，
  调用点只能绕过语义层）
- `IconButton` 透传 rest props，让 Composer 三个面板触发钮也能收敛

### 一致性测试的实际拦截记录

它不是摆设，本轮真的拦下了两次：
- 我把通知里的「撤销」写成 `Button size="sm"`（32px），触控断言当场红；
- `white/[.07]` 躲过了原生色阶正则——**测试漏了**，已补第 5 条规则并补 token。

## 15. 对齐 botmux 时刻意不抄的地方（2026-09-03）

本轮要求「样式先对齐 botmux 的 dashboard」。下面每一条都是**看过 botmux 的值、
量过数据之后决定不抄的**。写在这里是因为：不写的话，半年后有人比对两仓色值，
会把这些当成「漏迁」直接抄回去，把无障碍下限一起抄没。

**判定原则：botmux 是参考不是权威。** 它是纯桌面英文界面，dockmux 有移动抽屉、
中文正文和读屏用户。抄它的克制感，不抄它的历史包袱。

| # | botmux 的做法 | 实测 | dockmux 取值 | 为什么 |
| --- | --- | --- | --- | --- |
| 1 | 三级文字 `#8a92a8` | 白底 **3.11:1** | `--text-muted: #5a6379`（**6.01:1**） | AA 要 4.5。`#8a92a8` 保留给 `--status-neutral-solid`——那是圆点填充，不承载文字 |
| 2 | `--surface-hover: #f3f4f8` | 对 muted 只有 **1.055** | `#e0e5f1`（**1.087**） | 契约 §6 地板 1.08。botmux 能容忍是因为它侧栏 hover 走 `::before` 覆盖层，压根没用 surface token |
| 3 | `--topbar-h: 56px` 与 `--topbar-height: 60px` 并存 | 前者只有 1 个消费方（侧栏 `top`），顶栏自己用后者 | 全仓只有 `h-topbar`（56px） | 这是 botmux 的 off-by-4 **bug**，不是设计。见 `design-tokens.css:117` vs `style.css:60` |
| 4 | `--button-height: 32px` | — | 主按钮 40px，`size="sm"`(32px) 仅限非关键密集工具条 | dockmux 侧栏在 `<md` 是 `fixed` 抽屉，是触控界面。契约 §9 |
| 5 | `html { font-size: 13px }` | — | 正文 14px | 13px 是英文界面遗产，中文字形在该尺寸笔画粘连 |

第 1、2 条是 Team-Palette 拿实测数字推翻我原指令的——我原话是「照抄 botmux 色值」，
它算出对比度不达标后拒绝执行并附了数据，我复核后采纳。**这是期望的行为**：
指令和实测冲突时，数据赢。

侧栏映射到 `surface-default`（白）而非 `surface-muted`，这条是**跟着** botmux 的
（`style.css:8215 background: var(--surface)`）：侧栏是浮起的卡片不是凹陷的槽，
用 muted 既读错层次，又会吃掉 hover 的对比余量。

## 16. `--surface-raised` 在浅色下语义不成立（2026-09-03，已知缺陷，Phase 2）

Team-Surface 的亮度实测发现浅色下 `--surface-raised` ≡ `--surface-default`
（都是 `#ffffff`），于是 `Composer.tsx:293` 的 `focus-within:bg-raised`
**零视觉变化**。深色下两者是分开的（`#1b2330` vs `#151b26`，比值 1.093），
所以这是「一半能用」——最难被发现的那种。

**我试过改取值，改不好。** 候选值实测：

| 候选 | 对白比值 | 正文对比 | 问题 |
| --- | --- | --- | --- |
| `#f7f8fc` | 1.061 | 14.98 | 低于 §6 地板 1.08 |
| `#f4f5fa` | 1.089 | 14.61 | 与 `--surface-canvas`(#f4f5f8) 比值 **1.0013**，浮层贴到画布上就消失 |
| `#f2f4f9` | 1.100 | 14.45 | 同上，仍与 canvas 太近 |

根因不是取值没选好，**是这个 token 的语义在浅色主题下不成立**：深色的
「浮起 = 更亮」在浅色下无处可亮——`--surface-default` 已经是纯白。给它更暗的值，
比值能满足 §6，读起来却是「凹陷」，语义正好反过来。

**所以本轮不动色板。** 浅色下「浮起」的正确载体是阴影和边框，不是底色：
`shadow-card / panel / overlay` 三档已经在表达这件事。Phase 2 的修法是让
`bg-raised` 在浅色下退化为不改底色、由 `shadow-*` 承担层次，而不是硬凑一个色值。

紧急度不高，原因是两个消费者都不止这一层反馈：
- `Composer.tsx:293` 焦点态还有 `focus-within:-translate-y-0.5` 与
  `focus-within:border-action`，用户没有失去焦点反馈，只是这一层是死的；
- `ToastViewport.tsx:43` 自带 `border` + `shadow-panel`。

同批测出的 `--code-inline-bg` ≡ `--surface-muted`（深浅都重合）**不改**：
`MarkdownContent.tsx:76` 带 `ring-1 ring-inset ring-code-inline-border`，
按 §6 自己的口径，有描边时亮度比不是约束条件。

深色 `surface → danger-soft` 1.022 同理，那些位置都有边框，不改。

## 17. 尺度层实测（2026-09-03）

§15 管的是**颜色**该不该抄，这一节管**尺度**——圆角、表面亮度、间距节奏。
色板相同、布局相同，尺度不对照样难看。三项全部实测，结论跟着数据。

### 17.1 圆角：保持 6/10/14/20，一个字节都不改

**不要把档位改成 botmux 的 6/8/12/16。** 这不是保守，是因为抄过去会同时抄进一个 bug
并且**背离 botmux 自己写明的公式**。

botmux 里有三层互相矛盾的圆角声明：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| L1 | `style.css:35` | 注释：「档位定义见下面第二个 `:root`（**那份才是最终生效的**）」 |
| L2 | `style.css:8112-8118` | 注释写明公式**「半径 ≈ 高度 / 3.5」**，声明 `sm:6px / md:10px / lg:14px`，并给出取档区间：≤30 取 sm、31–47 取 md、≥48 取 lg |
| L3 | `design-tokens.css:96-100` | `sm:6 / md:8 / lg:12 / xl:16`，**无注释、无公式、无理由** |

`index.html:18-19` 先加载 `style.css` 后加载 `design-tokens.css`，同为 `:root` 同优先级，
**L3 赢**。于是 L2 那段自称「最终生效」的注释描述的是一份**死值**。

也就是说：**botmux 实际渲染的 6/8/12/16，是加载顺序的产物，不是任何人的设计决定；
它唯一写下过设计意图的地方（L2）声明的恰恰就是 6/10/14——与 dockmux 现行档位完全一致。**
抄 L3 = 抄一个覆盖事故，还要顺带背弃 L2 那条我们和它共用的 ÷3.5 公式。

实测同样支持保持不动。全仓 60 组「元素实际高度 ↔ 圆角档位」配对，套 §3 公式算理论值：

| 方案 | 平均绝对偏差 | 最大偏差 | 逐元素胜负 |
| --- | --- | --- | --- |
| **6/10/14/20（现行）** | **1.55px** | 6.9px | **39 胜** / 3 负 / 18 平 |
| 6/8/12/16（botmux 生效值） | 2.56px | 7.4px | 3 胜 / 39 负 / 18 平 |

分档看，差距全部来自 md 档——那也是消费最密集的一档：

| 档 | 样本 | 高度中位数 | 理论值 | 现行 | botmux | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| `sm` | 18 | 22px | 6.3 | 6px（偏 1.40） | 6px（偏 1.40） | 平（两案同值） |
| `md` | **36** | **40px** | **11.4** | **10px（偏 1.38）** | 8px（偏 3.14） | **现行，差 2.3×** |
| `lg` | 5 | 48px | 13.7 | 14px（偏 2.23） | 12px（偏 2.51） | 现行 |
| `xl` | 1 | 46px | 13.1 | 20px（偏 6.86） | 16px（偏 2.86） | 见下 |

md 档装着 36 个消费点（`Button` 三档、`Field` 输入框、`IconButton` 命中区、
Composer 五个面板项、CompactSelect、各类 40px 行），全部聚在 40px。40/3.5 = 11.4，
**10px 几乎正中，8px 偏了 3.4px**——按钮会明显发方。这一档独自决定了总分。

`xl` 只有一个消费点且**它本身取错了档**：`TimelineItem.tsx` 用户气泡实测 46px
（`py-3` 上下 24 + `text-body` 行高 22），理论 13.1px，却写了 `rounded-xl`(20px)，
偏 6.9px——这是 60 组里唯一的真实错档，已改为 `rounded-lg`。**改完之后 `xl`(20px)
在主区零消费**，只剩 Dialog 与 Composer 外框在用，符合 §3「大型容器」的定位。

> 结论：`--radius-sm/md/lg/xl = 6/10/14/20` **保持不动**。下一个想对齐 botmux 圆角的人，
> 请先读 `style.css:8112` 那段注释——它和我们用的是同一条公式，得出的也是同一组值。

### 17.2 表面亮度：5 处实际叠放低于 §6 地板

§6 要求相邻表面亮度比落在 1.08–1.5。Team-Palette 报的是**梯级**比值（浅 1.090/1.160/1.087、
深 1.096/1.093/1.123），那是「按顺序相邻的两层」。但组件里真实发生的叠放不总是相邻档，
所以按**实际 DOM 嵌套**重测。绝大多数达标，5 处不达标：

| # | 实际叠放 | 浅色 | 深色 | 出现在 | 性质 |
| --- | --- | --- | --- | --- | --- |
| 1 | `surface-raised` 套 `surface-default` | **1.000** | 1.093 | `Composer` 的 `focus-within:bg-raised` | **真缺陷**：浅色下两者都是 `#ffffff`，写了焦点反馈但**用户看不见** |
| 2 | `code-inline-bg` 套 `surface-muted` | **1.000** | **1.000** | 行内 `code` 落在任何 muted 块里 | **真缺陷**：两者恒等（浅 `#eceef4` / 深 `#1b2330`），行内代码在 muted 上完全消失 |
| 3 | `surface-muted` 套 `surface-canvas` | **1.064** | 1.198 | `Card tone="muted"` 直接放在页面底 | 浅色略低于地板 |
| 4 | `terminal-bg` 套 `surface-canvas` | **1.026** | **1.021** | 终端面板 | 终端自带边框，且是整块深色内容区，色差不承载分层 |
| 5 | `surface`/`muted` 套同色 | **1.000** | **1.000** | `Card` 套 `Card`、muted 套 muted | 结构问题，不是 token 问题 |

**第 1、2 条是色板层的真缺陷，已裁决，见 §16**：`--surface-raised` 的根因不是取值没选好
而是「浮起 = 更亮」在浅色下语义不成立（`surface-default` 已是纯白），Phase 2 让 `bg-raised`
在浅色退化为由 `shadow-*` 承担层次；`--code-inline-bg` 因 `MarkdownContent.tsx` 自带
`ring-1 ring-inset ring-code-inline-border` 而**不改**。第 4 条不改：终端是「屏幕」不是
「卡片」（botmux `.wb-pane` 同样刻意零边框零圆角零阴影），分层由边框承担。

第 3 条（浅色 `canvas → muted` 1.064）本轮不改：唯一的消费形态是 `Card tone="muted"`
直接铺在页面底，而现存调用点全都嵌在 `Card`/`Dialog` 里（对 `surface` 是 1.160，达标）。
真出现「muted 直铺 canvas」时，正解是那里本就该用 `tone="default"`。

**一条方法论**：语义软底（`*-soft`）不适用 §6 的 1.08 地板。深色下
`surface→danger-soft` 只有 1.022、`surface→info-soft` 1.040、`surface→queued-soft` 1.031，
看着全是违规——但它们**每一处都配了同色 `*-border` 外圈**（契约 §5 白名单第 5 类），
实测边框对底的对比是 1.23–1.75，分层由边框承载而非色差。**判断「这层看不看得见」要看
它实际用什么承载分层，不能只量背景色。**

### 17.3 间距节奏：不需要改

量了主区的间距分布，没有发现「过松显得空洞」或「过紧显得挤」的系统性问题，
所以本轮**不动间距**。记录现状供后续比对：

- `gap`：`gap-2`(8px) 61 处、`gap-3`(12px) 31、`gap-1.5`(6px) 23、`gap-1`(4px) 15
  —— 四档占 92%，节奏收敛，无需干预。
- `padding`：`px-3`(12) 35、`py-2`(8) 26、`px-2.5`(10) 23、`px-4`(16) 21、`px-5`(20) 12。
- 时间线纵向：`my-3`/`my-4`/`my-5`/`my-6` 四档并存（ActivityPanel 3、Banner 与最终输出 4、
  中间输出 5、用户气泡 6）。**这是刻意的**：间距在这里编码「这条与上一条的关系有多紧」，
  不是随手取值，合并会让连续输出和话轮切换看起来一样。

botmux 主区用 `--sp-*` 变量（4/8/12/16/24/32/40/48），dockmux 走 Tailwind 4px 刻度，
两者同为 4px 基准，**节奏本身没有差异**——botmux 的「克制感」来自它主工作区是等宽字体
终端 iframe（`.wb-pane` 零边框零圆角零阴影），不来自间距更小。那是形态差异，不是尺度差异，
dockmux 的主区是聊天时间线，不适用。

### 17.4 `Button` 的 `tone` 收紧为「必须同时声明 variant」

尺度实测期间顺带查出的两个缺陷，都不是尺度问题，但都属原语层，记在这里。

**缺陷 1：设置浮层没有主操作层级。** 7 个调用点（`ControlCenterModal` 6 处 +
`ScheduleFoundationPanel` 1 处）只写 `tone="inverse"` 不写 `variant`，于是全部落到
默认的 `secondary`，拿到 `bg-inverse` 深藏青而不是品牌靛蓝 `bg-action`。
「用它创建任务」和「连接 Bot」视觉权重一样重——这个界面从来没有主次。

7 个人犯同一个错，就不是调用方的问题。根因有两层：

1. `tone="inverse"` 是当时唯一「一个词就能得到实心按钮」的写法。想强调的人自然抓它。
2. `inverseClass.primary` / `.danger` 与 `variantClass` 的对应项**字节完全相同**——
   `tone` 在 4 档里有 2 档是空操作，却摆出一份完整的四向映射。看起来像在声明什么，
   实际什么也没声明。

修法是三层，不是补 7 个 prop：类型签名让漏传编译不过（`ButtonProps` 改成联合类型）；
`inverseClass` 改 `Partial` 只留真正有差异的 `secondary` / `ghost`；7 个调用点补
`variant="primary"`。修完设置浮层是 **6 primary / 3 secondary / 1 ghost**。

**缺陷 2：`ThemeToggle` 移动端 34px 宽。** 高度 `min-h-10` 达标，但文字带
`hidden sm:inline`，窄屏只剩 `px-2.5`×2 + 14px 图标 = **34px**。三颗按钮紧挨着，
点错一颗换掉整个界面主题。补 `min-w-10`。

> **这条比缺陷本身更值得记**：§9 说的是「触控目标 ≥40px」——那是一块**区域**。
> 但全仓既有的触控断言（TerminalKeyBar / CommandPalette / Tabs / ToastViewport /
> PermissionCard / ShortcutHelpSheet）查的全是 `min-h-10` / `h-10`，**只覆盖高度一个轴**。
> 34px 宽的按钮从这个缺口整个漏过去，而所有断言都是绿的。

两条都补了 `design-consistency.test.ts` 断言（现 11 条），且都用**重新引入缺陷**验证过会红。

**附带的教训：断言自己也会有 bug。** 宽度断言第一版写的是 `/<button[^>]*>/`，
而 `onClick={() => …}` 里的 `>` 会让它提前截断，`className` 根本进不了匹配——
结果是**修好之后反而误报**。改成花括号感知的 `openingTags()` 才对。
同期还有两次同类事故（协调人被自己的注释判红、Team-Verify 的容差恰好放过一个色值），
三次全是「断言写得不够精确」而非产品代码有问题。**新断言必须用「反向引入缺陷」验证，
只看它变绿等于没验。**

### 补记：当日实际是五次，且最后一种不会变红（2026-09-03 收尾）

上面记了三次。全天汇总后是五次，另外两次来自 e2e：

4. Playwright 的 `name` **默认子串匹配**——任务名「待归档任务」被侧栏行的可访问名
   「归档任务」命中，`.first()` 抓到侧栏行而不是归档按钮。症状酷似产品坏了。
   修法：`exact: true` + 避开词组。
5. **`0 === 0` 恒真**：`hasText: '当前不可用：先打开一个任务运行'` 在文案改名后匹配
   不到，`count()` 返回 0，而被比较的另一边恰好也是 0。

第 5 种和前四种**性质不同，也危险得多**：前四种都会让测试变红，红了自然有人查；
它绿着通过，测的东西已经整个消失，仪表盘反而更好看。

一般形式是：**「找不到」的返回值恰好是一个合法的期望值**——`count()` 返回 0、
`filter()` 返回空数组、`?.` 短路成 undefined。跑测试发现不了，因为它本来就绿。

**已上防线**：`scripts/check-e2e-copy.mjs`，挂在 `verify-redesign.mjs` 的闸 2.5。
它不看测试结果，只把 e2e 脚本里的 locator 文案逐个回查 `apps/web/src` 是否还存在。
纯文本比对，毫秒级，`--quick` 也不跳过。用当日 4 处真实失效验证过能抓到。

为什么需要它而不是「以后更仔细点」：那 4 处全部出自本分支自己的两次改名
（5babe68、f7a5e10），**靠人记得回来同步已经失败过两次**。

它有一个写在文件里的**已知缺口**：`assert(toast.includes('任务运行已归档'))`
这种形式抓不到。加进正则会误报 9 处（HTTP 响应体检查、串台测试自造的标记），
而一条天天误报的检查三个月内一定会被注释掉——那时连现在的覆盖也没了。
宁可漏报不误报。补缺口的正解是在 e2e 侧提供 `assertUiText()` 这样的专用断言，
让「这是界面文案」在语法上可识别，而不是继续加正则。


