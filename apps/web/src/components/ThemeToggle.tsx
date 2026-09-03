import { Monitor, Moon, Sun } from 'lucide-react';
import { themeHints, themeLabels, themePreferences, type ResolvedTheme, type ThemePreference } from '../theme';

const icons: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

// 外观选择用一组 radio 语义的分段控件：三个选项同时可见，当前值靠 aria-checked 与文字标签表达，
// 不依赖颜色或高亮单独表意。
//
// 文字在移动端隐藏（sm: 以下只留图标）：三段带文字的按钮在 390px 宽屏上要占掉整行，
// 把真实任务挤到折叠线以下（docs/interaction-design-2026-08-30.md §7.2）。
// 隐藏的只是视觉文本——aria-label 已含完整文案与提示，读屏与 radiogroup 语义不受影响。
//
// 但文字一隐藏，横向就只剩 px-2.5×2 + 14px 图标 = 34px，低于契约 §9 的 40px 触控目标：
// 高度达标而**宽度**不达标，只查 min-h 的断言看不见它。三颗按钮紧挨着，点错一颗就换掉
// 整个界面的主题。所以补 min-w-10 —— 触控目标是「区域」不是「高度」。
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
        title={hint}
        aria-label={`${themeLabels[option]}：${hint}`}
        onClick={() => onChange(option)}
        className={`flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-sm px-2.5 text-caption font-medium transition-colors duration-fast ease-out ${selected ? 'bg-action-soft text-action' : 'text-secondary hover:bg-hover hover:text-primary'}`}
      ><Icon aria-hidden="true" size={14}/><span className="hidden sm:inline">{themeLabels[option]}</span></button>;
    })}
  </div>;
}
