import { cn } from './cn';

export type SpinnerProps = { size?: 'sm' | 'md'; label?: string };

/*
  收敛 19 处 animate-spin + 17 种「正在…」文案。

  带 label 时必须进可访问树：读屏用户看不到转圈，只有 role=status + aria-live=polite
  才会把「正在保存…」念出来。不带 label 时纯装饰，整块 aria-hidden，
  否则每个加载态都会给读屏用户念一个无意义的图形节点。
*/
export function Spinner({ size = 'sm', label }: SpinnerProps) {
  const circle = <span
    aria-hidden="true"
    className={cn(
      'inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent',
      size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5'
    )}
  />;
  if (!label) return circle;
  return <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-caption text-secondary">{circle}{label}</span>;
}
