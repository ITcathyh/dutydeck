import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export type CardProps = {
  tone?: 'default' | 'muted' | 'dashed';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  as?: 'div' | 'section' | 'article' | 'aside';
} & HTMLAttributes<HTMLElement>;

const paddingClass = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-6' } as const;

/*
  契约 §4「默认无线」：default 与 muted 靠表面色差分层，不画边框。
  只有 dashed（空态框）例外——虚线是「这里本该有内容」的语义，不是分层手段。
*/
const toneClass = {
  default: 'bg-surface shadow-card',
  muted: 'bg-muted',
  dashed: 'border border-dashed border-default bg-transparent'
} as const;

export function Card({ tone = 'default', padding = 'md', as: Element = 'div', className, children, ...rest }: CardProps) {
  return <Element {...rest} className={cn('rounded-lg', toneClass[tone], paddingClass[padding], className)}>{children}</Element>;
}
