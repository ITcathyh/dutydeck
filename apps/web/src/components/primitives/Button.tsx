import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonTone = 'default' | 'inverse';

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: ButtonTone;
  loading?: boolean;
  icon?: ReactNode;
  iconEnd?: ReactNode;
  fullWidth?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

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

/** inverse 只改「默认」与「次要」两档的底色，主色与危险色在反色底上仍然要保持自己的语义。 */
const inverseClass: Record<ButtonVariant, string> = {
  primary: 'bg-action text-on-action hover:bg-action-hover',
  secondary: 'bg-inverse text-on-inverse hover:bg-inverse-hover',
  ghost: 'bg-transparent text-on-inverse hover:bg-inverse-hover',
  danger: 'bg-danger-solid text-on-action hover:bg-danger'
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
      tone === 'inverse' ? inverseClass[variant] : variantClass[variant],
      fullWidth && 'w-full',
      className
    )}
  >
    {loading ? <Spinner size="sm"/> : icon}
    {children}
    {iconEnd}
  </button>;
}
