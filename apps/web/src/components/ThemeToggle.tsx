import { Monitor, Moon, Sun } from 'lucide-react';
import { themeHints, themeLabels, themePreferences, type ResolvedTheme, type ThemePreference } from '../theme';

const icons: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

// 外观选择用一组 radio 语义的分段控件：三个选项同时可见，当前值靠 aria-checked 与文字标签表达，
// 不依赖颜色或高亮单独表意。
//
// 所有视口都只显示图标：三段带文字的按钮在桌面顶栏占掉约 230px，比搜索框还抢眼，
// 而外观是低频设置。文字留在 sr-only 里，title 与 aria-label 给出完整文案与提示，
// 读屏与 radiogroup 语义不受影响。
//
// 只剩图标后横向仅 px-2.5×2 + 14px = 34px，低于契约 §9 的 40px 触控目标，
// 所以补 min-w-10 —— 触控目标是「区域」不是「高度」。
export function ThemeToggle({ preference, resolved, onChange, className = '' }: {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  onChange(next: ThemePreference): void;
  className?: string;
}) {
  const resolvedLabel = resolved === 'dark' ? '深色' : '浅色';
  // 圆角取档（契约 §3，半径 ≈ 高度 / 3.5）：外框高 = 40px 分段项 + 2×2px padding = 44px，
  // 落在 31–47px 档 → rounded-md（10px）。内嵌项本身 40px 也落在同一档，但同心圆角必须
  // 内小于外，否则两条弧线重叠看起来像描歪的边；内半径 = 外半径 − padding = 10 − 2 = 8px，
  // 就近取下一档 rounded-sm（6px）。
  return <div role="radiogroup" aria-label="界面外观" className={`flex items-center gap-1 rounded-md border border-default bg-surface p-0.5 ${className}`}>
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
        title={`${themeLabels[option]}：${hint}`}
        aria-label={`${themeLabels[option]}：${hint}`}
        onClick={() => onChange(option)}
        className={`flex min-h-10 min-w-10 items-center justify-center rounded-sm px-2.5 transition-colors duration-fast ease-out ${selected ? 'bg-action-soft text-action' : 'text-subtle hover:bg-hover hover:text-primary'}`}
      ><Icon aria-hidden="true" size={15}/><span className="sr-only">{themeLabels[option]}</span></button>;
    })}
  </div>;
}
