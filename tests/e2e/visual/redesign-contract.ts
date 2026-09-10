/**
 * 改版验收契约：把「怎么算改对了」写成常量，断言只引用这里。
 *
 * 这份文件是**验收标准，不是回归基线**。写下它的时候三个团队还没改完，所以里面
 * 每一条对当前线上都应该是红的。改完之后变绿——红转绿的条数就是改版的进度条。
 *
 * 每条都标注了「现状 → 目标」，方便对着报告核对。
 */

/**
 * 品牌色色相区间。
 *
 * 现状 `--action-primary: #0f766e`（teal 700）→ H≈176，落在青绿。
 * 目标是靛蓝族：indigo-500 `#6366f1` H≈239、indigo-600 `#4f46e5` H≈243，
 * botmux 参照色 `#7b82f5` H≈236。区间取 225–255：
 * - 下界 225 排除掉纯蓝（#3b82f6 H≈217），保证「蓝紫」而不是「天蓝」；
 * - 上界 255 排除掉紫罗兰（#8b5cf6 H≈258）。
 */
export const BRAND_HUE = { min: 225, max: 255 } as const;

/** 明确排除区：命中即说明还是墨绿/青。teal 系全部落在 165–195。 */
export const FORBIDDEN_TEAL_HUE = { min: 160, max: 200 } as const;

/** 品牌色不能是灰——饱和度下限，防止「改成中性蓝灰」蒙混过关。 */
export const BRAND_MIN_SATURATION = 45;

/**
 * 顶栏高度。现状：不存在顶栏（0）。目标 56px，容差 ±2 给 border/subpixel。
 *
 * 注意这个值**刻意不等于 botmux 的实际渲染值**。botmux 有两套同义变量在打架：
 * `--topbar-h: 56px`（design-tokens.css:117，全站仅 1 处引用——侧栏拿它算自己的 top）
 * 和 `--topbar-height: 60px`（style.css:60，topbar 自己的 min-height）。实际渲染 60px，
 * 于是侧栏顶边比 topbar 底边少 4px —— 这是 botmux 的 off-by-4 既存 bug，不是设计意图
 * （docs/botmux-dashboard-anatomy.md §「布局变量是反过来的」）。
 * 我们取单一值 56px，顶栏与侧栏共用它，不复刻这个 bug。
 */
export const TOPBAR_HEIGHT = { value: 56, tolerance: 2 } as const;

/** 侧栏宽度。现状桌面 292px（移动抽屉 304px）。目标 248px，与 botmux `--sidebar-w` 一致。 */
export const SIDEBAR_WIDTH = { value: 248, tolerance: 2 } as const;

/**
 * 侧栏是**悬浮卡片**，不是贴边通栏。
 *
 * botmux 的 `.chrome-body` 是 `display: block` 不是 grid；侧栏 `position: fixed`，
 * 四周留 16px 空隙、12px 圆角、1px 边框带阴影，视觉上「浮」在背景上；主区靠
 * `margin-left: calc(248px + 48px)` 让位（anatomy §A1）。
 *
 * 现状 dutydeck 侧栏是 `fixed inset-y-0 left-0` 的贴边通栏，圆角 0、左边距 0。
 * 只断宽度会让「把 292 改成 248 但仍然贴边」蒙混过关，所以形态要单独断。
 */
export const SIDEBAR_CARD = {
  /** 距视口左边/上边的空隙下限。botmux 是 16px，留 8px 下限允许我们自己收紧。 */
  minInset: 8,
  /** 圆角下限。botmux `--radius-lg` = 12px；dutydeck 自己的 `--radius-md` = 10px 也可接受。 */
  minRadius: 8
} as const;

/**
 * 浅色主题下侧栏底色的亮度下限。
 *
 * 现状 `--sidebar-surface: #16201f`，相对亮度 ≈0.011 —— 浅色主题下侧栏仍是恒深色，
 * 与 `#f5f7f6`（≈0.90）的画布并排，视觉上像两个应用拼在一起。
 * 目标：侧栏跟随主题。阈值取 0.5，落在「明显偏浅」一侧，不卡边界。
 */
export const LIGHT_SIDEBAR_MIN_LUMINANCE = 0.5;

/** 深色主题下侧栏必须仍是深底，防止「跟随主题」被实现成「恒浅色」。 */
export const DARK_SIDEBAR_MAX_LUMINANCE = 0.2;

/**
 * 侧栏功能导航区必须是**分组结构**，不只是几个链接。
 *
 * botmux 侧栏是「顶部 2 个创建操作 + 19 项导航分 5 组」（概览 / 协作 / 数字员工 /
 * 分析 / 管理，anatomy §A2 的 `NAV_GROUPS`）。dutydeck 现状是「一个任务列表 + 底部
 * 一颗『Agent 与设置』按钮」，四个功能（Agent / 飞书 / 群与权限 / 自动化）全塞在
 * 那颗按钮后面的弹层里，从侧栏看不到它们存在。
 *
 * 所以判据分两层：入口本身要直达（NAV_ENTRIES），以及它们要被组织成分组
 * （MIN_GROUPS）——只把四个链接平铺出来仍然不算改对，19 项平铺是不可读的。
 */
export const SIDEBAR_NAV_ENTRIES = ['Agent 与设置', '飞书接入'] as const;
/** 至少要有几个直达入口才算「有导航区」——两个就够证明不再是单一弹层入口。 */
export const SIDEBAR_NAV_MIN_ENTRIES = 2;
/** 至少几个分组。botmux 是 5 组；dutydeck 功能面更窄，2 组（任务 / 配置）即算成立。 */
export const SIDEBAR_NAV_MIN_GROUPS = 2;
