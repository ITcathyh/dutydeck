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
 * 参照设计规范 `#7b82f5` H≈236。区间取 225–255：
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
 * 注意统一使用 56px 单一基准。避免因历史设计中 `--topbar-h: 56px` 与
 * `--topbar-height: 60px` 两套同义变量不一致导致的 4px 错位偏差。
 * 我们取单一值 56px，顶栏与侧栏共用它，保证对齐。
 */
export const TOPBAR_HEIGHT = { value: 56, tolerance: 2 } as const;

/** 侧栏宽度。现状桌面 292px（移动抽屉 304px）。目标 248px（--sidebar-w）。 */
export const SIDEBAR_WIDTH = { value: 248, tolerance: 2 } as const;

/**
 * 侧栏是**悬浮卡片**，不是贴边通栏。
 *
 * 侧栏卡片规范：侧栏 `position: fixed`，四周留有 16px 空隙、12px 圆角、
 * 1px 边框带阴影，视觉上「浮」在背景上；主区靠 `margin-left` 让位。
 *
 * 现状 dutydeck 侧栏是 `fixed inset-y-0 left-0` 的贴边通栏，圆角 0、左边距 0。
 * 只断宽度会让「把 292 改成 248 但仍然贴边」蒙混过关，所以形态要单独断。
 */
export const SIDEBAR_CARD = {
  /** 距视口左边/上边的空隙下限。基准 16px，留 8px 下限允许收紧。 */
  minInset: 8,
  /** 圆角下限。大圆角基准 12px；中圆角 10px 也可接受。 */
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
 * 侧栏规划为「顶部创建操作 + 分组导航」（概览 / 协作 / 数字员工 / 分析 / 管理 等）。
 * dutydeck 现状是「一个任务列表 + 底部一颗『Agent 与设置』按钮」，四个功能（Agent / 飞书 /
 * 群与权限 / 自动化）全塞在那颗按钮后面的弹层里，从侧栏看不到它们存在。
 *
 * 所以判据分两层：入口本身要直达（NAV_ENTRIES），以及它们要被组织成分组
 * （MIN_GROUPS）——只把四个链接平铺出来仍然不算改对，平铺是不可读的。
 */
export const SIDEBAR_NAV_ENTRIES = ['Agent 与设置', '飞书接入'] as const;
/** 至少要有几个直达入口才算「有导航区」——两个就够证明不再是单一弹层入口。 */
export const SIDEBAR_NAV_MIN_ENTRIES = 2;
/** 至少几个分组。完整导航可达 5 组；dutydeck 当前功能面，2 组（任务 / 配置）即算成立。 */
export const SIDEBAR_NAV_MIN_GROUPS = 2;
