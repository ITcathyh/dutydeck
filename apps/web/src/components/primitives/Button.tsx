import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonTone = 'default' | 'inverse';

type ButtonBase = {
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconEnd?: ReactNode;
  fullWidth?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/*
  `tone` 与 `variant` 正交，但**只有 variant 表达强调级别**——传 tone 不等于「这是主操作」。

  这条区分此前只写在注释里，7 个调用点（ControlCenterModal 6 处 + ScheduleFoundationPanel 1 处）
  同时踩了同一个坑：只写 `tone="inverse"` 不写 `variant`，于是落到默认的 secondary，
  拿到 `bg-inverse` 深藏青而不是品牌靛蓝。7 个调用点犯同一个错，说明这是 API 的问题不是
  调用方的问题——`tone="inverse"` 是当时唯一一个「一个词就能得到实心按钮」的写法，
  想要强调的人自然会去抓它。

  修法是让「传了 tone 却没声明强调级别」**编译不过**，而不是再写一句注释：
  下面的联合类型要求 tone 一旦出现，variant 必须同时出现。运行时行为完全不变，
  签名对**正确用法**保持兼容（契约 §10 冻结的是签名，不是让错误用法继续编译）。
*/
export type ButtonProps = ButtonBase & (
  | { tone?: undefined; variant?: ButtonVariant }
  | { tone: ButtonTone; variant: ButtonVariant }
);

/*
  高度即触控目标（契约 §9）：md 40px 是默认，sm 32px 只允许用在有 ≥40px 等价入口的
  密集工具条上，lg 44px 给移动端高频操作。圆角按「高度 / 3.5」取档：32/40/44 全部
  落在 31–47px 区间，所以三档共用 rounded-md。
*/
const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-md px-2.5 text-caption',
  md: 'h-10 gap-2 rounded-md px-3.5 text-body',
  lg: 'h-11 gap-2 rounded-md px-4 text-body'
};

const variantClass: Record<ButtonVariant, string> = {
  primary: 'bg-action text-on-action hover:bg-action-hover',
  // 次要按钮是契约 §5 白名单第 2 类：输入类控件的可点击边界，允许画线。
  secondary: 'border border-default bg-surface text-secondary shadow-card hover:bg-hover',
  ghost: 'bg-transparent text-secondary hover:bg-muted hover:text-primary',
  danger: 'bg-danger-solid text-on-action hover:bg-danger'
};

/*
  inverse 只对「次要」与「幽灵」两档有意义——它们靠中性表面色表意，换到反色底上必须换底。
  主色与危险色自带语义色，在任何底上都保持自己的样子，所以这里**不列** primary / danger：
  它们走 variantClass 那一份，避免同一段类名抄两遍后各自漂移（此前两份确实字节相同，
  等于 `tone` 在这两档上是空操作，却让调用方以为自己声明了什么）。
*/
const inverseClass: Partial<Record<ButtonVariant, string>> = {
  secondary: 'bg-inverse text-on-inverse hover:bg-inverse-hover',
  ghost: 'bg-transparent text-on-inverse hover:bg-inverse-hover'
};

export function Button({ variant = 'secondary', size = 'md', tone = 'default', loading = false, icon, iconEnd, fullWidth = false, disabled, className, children, type = 'button', ...rest }: ButtonProps) {
  // loading 期间按钮必须点不动：只置 aria-busy 而仍可点击，会让用户重复提交。
  const inactive = disabled || loading;
  return <button
    {...rest}
    type={type}
    disabled={inactive}
    aria-busy={loading || undefined}
    className={cn(
      'inline-flex shrink-0 items-center justify-center font-medium transition-colors duration-fast ease-out',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
      'disabled:cursor-not-allowed disabled:opacity-50',
      sizeClass[size],
      (tone === 'inverse' && inverseClass[variant]) || variantClass[variant],
      fullWidth && 'w-full',
      className
    )}
  >
    {loading ? <Spinner size="sm"/> : icon}
    {children}
    {iconEnd}
  </button>;
}
