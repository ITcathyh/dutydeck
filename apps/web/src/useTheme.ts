import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyThemePreference, readStoredTheme, resolveTheme, systemPrefersDark, writeStoredTheme, type ResolvedTheme, type ThemePreference } from './theme';

export type ThemeController = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  systemDark: boolean;
  setPreference(next: ThemePreference): void;
};

/**
 * 主题偏好的唯一入口：默认跟随系统，选择后持久化。
 * 系统外观变化只在 preference 为 system 时改变结果，但监听始终保持，
 * 以便用户从显式选择切回跟随系统时立刻拿到正确的系统值。
 */
export function useTheme(): ThemeController {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => typeof window === 'undefined' ? 'system' : readStoredTheme());
  const [systemDark, setSystemDark] = useState(() => typeof window === 'undefined' ? false : systemPrefersDark());

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    // Safari 14 之前只有 addListener，但本项目其他 matchMedia 用法同样只用 addEventListener，保持一致。
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => { applyThemePreference(preference); }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeStoredTheme(next);
    applyThemePreference(next);
  }, []);

  const resolved = useMemo(() => resolveTheme(preference, systemDark), [preference, systemDark]);
  return { preference, resolved, systemDark, setPreference };
}
