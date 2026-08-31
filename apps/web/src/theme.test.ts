import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyThemePreference, isThemePreference, readStoredTheme, readThemeColor, resolveTheme, systemPrefersDark, THEME_STORAGE_KEY, themeLabels, writeStoredTheme } from './theme';

const mockMatchMedia = (dark: boolean) => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: dark, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
};

describe('主题偏好模型', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('只接受三个合法偏好值', () => {
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('sepia')).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });

  it('默认跟随系统，读到脏数据同样回落到跟随系统', () => {
    expect(readStoredTheme()).toBe('system');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readStoredTheme()).toBe('system');
  });

  it('显式选择会被持久化，跟随系统则清除存储', () => {
    writeStoredTheme('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
    writeStoredTheme('system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readStoredTheme()).toBe('system');
  });

  it('localStorage 不可用时静默降级，不抛错也不影响本次选择', () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('隐私模式禁用存储'); });
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('隐私模式禁用存储'); });
    expect(readStoredTheme()).toBe('system');
    expect(() => writeStoredTheme('dark')).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('跟随系统时由系统深浅决定结果，显式选择时压过系统', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('跟随系统不写 data-theme，显式选择才写具体值', () => {
    applyThemePreference('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyThemePreference('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyThemePreference('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('缺少 matchMedia 时按浅色处理，不抛错', () => {
    const original = window.matchMedia;
    // @ts-expect-error 故意移除以模拟不支持 matchMedia 的环境
    window.matchMedia = undefined;
    expect(systemPrefersDark()).toBe(false);
    window.matchMedia = original;
  });

  it('能读到系统深色偏好', () => {
    mockMatchMedia(true);
    expect(systemPrefersDark()).toBe(true);
    mockMatchMedia(false);
    expect(systemPrefersDark()).toBe(false);
  });

  it('读不到 CSS 变量时回落到兜底色，供 xterm 等运行时使用', () => {
    expect(readThemeColor('--not-defined-token', '#fafafa')).toBe('#fafafa');
  });

  it('三个选项都有说明「会带来什么」的中文文案', () => {
    expect(themeLabels.system).toBe('跟随系统');
    expect(themeLabels.light).toBe('浅色');
    expect(themeLabels.dark).toBe('深色');
  });
});
