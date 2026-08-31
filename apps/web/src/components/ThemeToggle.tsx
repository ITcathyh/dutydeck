import { Monitor, Moon, Sun } from 'lucide-react';
import { themeHints, themeLabels, themePreferences, type ResolvedTheme, type ThemePreference } from '../theme';

const icons: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

// 外观选择用一组 radio 语义的分段控件：三个选项同时可见，当前值靠 aria-checked 与文字标签表达，
// 不依赖颜色或高亮单独表意。
export function ThemeToggle({ preference, resolved, onChange, className = '' }: {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  onChange(next: ThemePreference): void;
  className?: string;
}) {
  const resolvedLabel = resolved === 'dark' ? '深色' : '浅色';
  return <div role="radiogroup" aria-label="界面外观" className={`flex items-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] p-0.5 ${className}`}>
    {themePreferences.map(option => {
      const Icon = icons[option];
      const selected = preference === option;
      // 跟随系统时把当前实际生效的外观写进无障碍名称，避免用户只看到「跟随系统」却不知道现在是深色还是浅色。
      const hint = option === 'system' && selected ? `${themeHints.system}；当前为${resolvedLabel}` : themeHints[option];
      return <button
        key={option}
        type="button"
        role="radio"
        aria-checked={selected}
        title={hint}
        aria-label={`${themeLabels[option]}：${hint}`}
        onClick={() => onChange(option)}
        className={`flex min-h-10 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${selected ? 'bg-[var(--action-soft)] text-[var(--action-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'}`}
      ><Icon aria-hidden="true" size={14}/><span>{themeLabels[option]}</span></button>;
    })}
  </div>;
}
