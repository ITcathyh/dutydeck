import type { ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from './Button';
import { cn } from './cn';

export type EmptyStateTone = 'neutral' | 'positive' | 'guide';

export type EmptyStateProps = {
  tone?: EmptyStateTone;
  icon?: ReactNode;
  title: string;
  description?: string;
  primaryAction?: { label: string; onClick(): void; disabled?: boolean };
  secondaryAction?: { label: string; onClick(): void };
};

/*
  收敛 21 处手写空态。三种 tone 语义不可混用（契约 §10）：

  - neutral  当前视图筛不出结果。灰色，陈述事实。
  - positive 「没有待办」是好消息。必须是绿勾，不能沿用灰色空盒子——把
             「你已经处理完了」画成失望的灰，是在为一件好事道歉。默认图标
             给绿勾正是为此：调用方不传 icon 时也不会退化成灰。
  - guide    首次引导，带主 CTA。

  「无权限 / 读不到」不属于空态：整块隐藏，不要画一个永远为空的面板。
*/
const toneIconClass: Record<EmptyStateTone, string> = {
  neutral: 'bg-muted text-subtle',
  positive: 'bg-success-soft text-success',
  guide: 'bg-action-soft text-action'
};

export function EmptyState({ tone = 'neutral', icon, title, description, primaryAction, secondaryAction }: EmptyStateProps) {
  const glyph = icon ?? (tone === 'positive' ? <CheckCircle2 size={22} strokeWidth={1.8}/> : undefined);
  return <div className="ui-empty-state grid place-items-center px-6 py-10 text-center">
    {glyph && <span className={cn('mb-3 grid h-12 w-12 place-items-center rounded-lg', toneIconClass[tone])}>{glyph}</span>}
    <p className={cn('text-title font-semibold', tone === 'neutral' ? 'text-secondary' : 'text-primary')}>{title}</p>
    {description && <p className="mt-1.5 max-w-md text-caption text-subtle">{description}</p>}
    {(primaryAction || secondaryAction) && <div className="mt-4 flex items-center gap-2">
      {primaryAction && <Button variant="primary" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>{primaryAction.label}</Button>}
      {secondaryAction && <Button variant="secondary" onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>}
    </div>}
  </div>;
}
