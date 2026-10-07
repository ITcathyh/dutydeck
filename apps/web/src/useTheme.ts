import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyThemePreference, readStoredTheme, resolveTheme, writeStoredTheme, type ResolvedTheme, type ThemePreference } from './theme';
import { useMediaQuery } from './useMediaQuery';

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
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');

  useEffect(() => { applyThemePreference(preference); }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeStoredTheme(next);
    applyThemePreference(next);
  }, []);

  const resolved = useMemo(() => resolveTheme(preference, systemDark), [preference, systemDark]);
  return { preference, resolved, systemDark, setPreference };
}
