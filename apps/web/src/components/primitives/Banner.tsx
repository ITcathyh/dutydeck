import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { cn } from './cn';

export type BannerTone = 'danger' | 'warning' | 'info' | 'success';

export type BannerProps = {
  tone: BannerTone;
  role?: 'alert' | 'status';
  title?: ReactNode;
  action?: { label: string; onClick(): void; busy?: boolean };
  onDismiss?(): void;
  children: ReactNode;
};

/* 契约 §5 白名单第 5 类：状态语义色的软底卡片允许配同色外圈。 */
const toneClass: Record<BannerTone, string> = {
  danger: 'border-danger-border bg-danger-soft text-danger',
  warning: 'border-warning-border bg-warning-soft text-warning',
  info: 'border-info-border bg-info-soft text-info',
  success: 'border-success-border bg-success-soft text-success'
};

/*
  收敛 17 处错误横幅 + 17 处警告横幅。

  role 的默认值按语义分流：danger 是「有件事已经坏了」，必须打断读屏当前朗读
  （alert）；warning / info / success 是背景信息，插队播报反而扰人（status）。
  调用方可以覆盖，但覆盖需要理由。
*/
export function Banner({ tone, role = tone === 'danger' ? 'alert' : 'status', title, action, onDismiss, children }: BannerProps) {
  return <div role={role} className={cn('flex items-start gap-3 rounded-md border px-3 py-2.5 text-caption', toneClass[tone])}>
    <div className="min-w-0 flex-1">
      {title && <div className="text-body font-semibold">{title}</div>}
      <div className={cn('min-w-0', Boolean(title) && 'mt-1')}>{children}</div>
    </div>
    {action && <Button size="sm" variant="secondary" loading={action.busy} onClick={action.onClick}>{action.label}</Button>}
    {onDismiss && <IconButton label="关闭提示" onClick={onDismiss}><X size={15}/></IconButton>}
  </div>;
}
