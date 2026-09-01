import { cn } from './cn';

export type SkeletonProps = { variant?: 'text' | 'block' | 'row'; lines?: number; className?: string };

/*
  收敛 12 处手写 animate-pulse。

  整块 aria-hidden + role=presentation：骨架是「内容还没到」的视觉占位，
  读屏念出一串空盒子毫无意义。加载态的可访问播报由 Spinner 的 role=status 负责，
  两者分工，不要在骨架上再挂一个 aria-live。
*/
export function Skeleton({ variant = 'text', lines = 1, className }: SkeletonProps) {
  const shape = {
    text: 'h-3.5 rounded-sm',
    block: 'h-20 rounded-md',
    row: 'h-12 rounded-md'
  }[variant];
  return <div aria-hidden="true" role="presentation" className={cn('space-y-2', className)}>
    {Array.from({ length: Math.max(1, lines) }, (_, index) => <div
      key={index}
      className={cn('animate-pulse bg-muted', shape, variant === 'text' && index === lines - 1 && lines > 1 && 'w-2/3')}
    />)}
  </div>;
}
