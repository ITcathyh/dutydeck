import type { ReactNode } from 'react';
import type { Session } from '../../api';
import { effectiveStatus } from '../ui';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'queued' | 'accent';

export type BadgeProps = {
  tone?: BadgeTone;
  variant?: 'soft' | 'outline';
  children: ReactNode;
};

/* soft = 语义色软底 + 同色描边（契约 §5 白名单第 5 类）；outline = 只留描边，用于密集列表里避免整行发花。 */
const softClass: Record<BadgeTone, string> = {
  neutral: 'border-subtle bg-muted text-subtle',
  success: 'border-success-border bg-success-soft text-success',
  warning: 'border-warning-border bg-warning-soft text-warning',
  danger: 'border-danger-border bg-danger-soft text-danger',
  info: 'border-info-border bg-info-soft text-info',
  queued: 'border-queued-border bg-queued-soft text-queued',
  accent: 'border-action-soft bg-action-soft text-action'
};

const outlineClass: Record<BadgeTone, string> = {
  neutral: 'border-default text-subtle',
  success: 'border-success-border text-success',
  warning: 'border-warning-border text-warning',
  danger: 'border-danger-border text-danger',
  info: 'border-info-border text-info',
  queued: 'border-queued-border text-queued',
  accent: 'border-action text-action'
};

/** 徽标高度 ~22px，按「高度 / 3.5」取 rounded-sm。契约 §3 明令禁止在矩形上用 rounded-full。 */
export function Badge({ tone = 'neutral', variant = 'soft', children }: BadgeProps) {
  return <span className={cn(
    'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-caption font-medium',
    variant === 'soft' ? softClass[tone] : outlineClass[tone]
  )}>{children}</span>;
}

export type StatusBadgeProps = { session: Session };

/*
  一条任务的状态徽标。文案与「归档优先」判据全部来自 ui.tsx:effectiveStatus。

  这里刻意只把 state 映射到语义 tone，不再判 `session.archivedAt`——归档由
  effectiveStatus 的 status.archived 回答，那是全站唯一判据（见 ui.tsx 的长注释：
  在调用点补 guard 只会把「N 份不同的判断」变成「N 份相同的判断」）。
*/
const stateBadgeTone: Record<string, BadgeTone> = {
  failed: 'danger',
  stopped: 'danger',
  waiting_for_permission: 'warning',
  interrupted: 'warning',
  created: 'warning',
  idle: 'warning',
  completed: 'success'
};

export function StatusBadge({ session }: StatusBadgeProps) {
  const status = effectiveStatus(session);
  const tone: BadgeTone = status.archived ? 'neutral' : stateBadgeTone[session.state] ?? 'info';
  return <Badge tone={tone}>{status.label}</Badge>;
}
