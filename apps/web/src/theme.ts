// 主题偏好：system | light | dark。跟随系统时不写 data-theme，由 index.css 的
// prefers-color-scheme 分支接管；显式选择时写 data-theme，让选择在两个方向上都能压过系统。
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'dutydeck.theme';
export const themePreferences: ThemePreference[] = ['system', 'light', 'dark'];

// 文案说明「这个选项会带来什么」，不用「切换」这类没有对象的抽象动词。
export const themeLabels: Record<ThemePreference, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
export const themeHints: Record<ThemePreference, string> = {
  system: '由系统外观决定，系统切换时同步跟随',
  light: '始终使用浅色界面，忽略系统外观',
  dark: '始终使用深色界面，忽略系统外观'
};

export const isThemePreference = (value: unknown): value is ThemePreference => typeof value === 'string' && (themePreferences as string[]).includes(value);

/** 读取持久化偏好；localStorage 在隐私模式下会直接抛错，读不到就回落到跟随系统。 */
export function readStoredTheme(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch { return 'system'; }
}

/** 写入失败不影响本次会话的主题表现，只是下次打开会回到跟随系统。 */
export function writeStoredTheme(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch { /* 存储不可用时静默降级，不打断主题选择 */ }
}

/** 系统是否为深色；matchMedia 在测试环境可能缺失，缺失时按浅色处理。 */
export function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch { return false; }
}

export const resolveTheme = (preference: ThemePreference, systemDark: boolean): ResolvedTheme =>
  preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

/** 把偏好落到 documentElement：跟随系统时移除属性，显式选择时写入具体值。 */
export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

/** 供 xterm.js 等无法消费 CSS 变量的运行时读取真实颜色值；jsdom 返回空串时用兜底值。 */
export function readThemeColor(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch { return fallback; }
}
