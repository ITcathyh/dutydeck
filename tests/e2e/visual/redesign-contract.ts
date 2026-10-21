/** Calm Workbench：方案 §14/15 的视觉与布局契约。建议色值以明暗与对比度验收。 */
export const BRAND_HUE = { min: 15, max: 35 } as const;
export const FORBIDDEN_TEAL_HUE = { min: 160, max: 200 } as const;
export const BRAND_MIN_SATURATION = 40;
export const TOPBAR_HEIGHT = { desktop: 61, mobile: 54, tolerance: 2 } as const;
export const SIDEBAR_WIDTH = { value: 234, min: 208, max: 320 } as const;
export const SIDEBAR_COLLAPSED_WIDTH = 68;
export const LIGHT_SIDEBAR_MIN_LUMINANCE = 0.5;
export const DARK_SIDEBAR_MAX_LUMINANCE = 0.2;
export const SIDEBAR_NAV_ENTRIES = ['工作台', '全部任务', '自动化'] as const;
export const MIN_TOUCH_TARGET = 44;
