import { useEffect, useRef } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'danger' | 'warning';
  busy?: boolean;
  error?: string;
  onConfirm(): void;
  onCancel(): void;
};

export function ConfirmDialog({ open, title, description, confirmLabel, tone = 'warning', busy = false, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = requestAnimationFrame(() => cancelRef.current?.focus());
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [open, busy, onCancel]);
  if (!open) return null;
  const danger = tone === 'danger';
  return <div className="ui-overlay fixed inset-0 z-50 grid place-items-center bg-[var(--overlay-scrim)] p-4 backdrop-blur-[3px]" onMouseDown={event => { if (!busy && event.currentTarget === event.target) onCancel(); }}>
    <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" className="ui-dialog w-full max-w-[420px] overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] shadow-[var(--shadow-dialog)]">
      <div className="flex gap-3.5 px-5 pb-4 pt-5">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${danger ? 'bg-[var(--status-danger-soft)] text-[var(--status-danger)] ring-1 ring-[var(--status-danger-border)]' : 'bg-[var(--status-warning-soft)] text-[var(--status-warning)] ring-1 ring-[var(--status-warning-border)]'}`}><AlertTriangle size={19} strokeWidth={1.8}/></div>
        <div className="min-w-0 pt-0.5"><h2 id="confirm-dialog-title" className="text-[15px] font-semibold tracking-[-.01em] text-[var(--text-primary)]">{title}</h2><p id="confirm-dialog-description" className="mt-1.5 text-[12px] leading-5 text-[var(--text-muted)]">{description}</p></div>
      </div>
      {error && <div className="mx-5 mb-4 rounded-lg border border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] px-3 py-2 text-[11px] leading-4 text-[var(--status-danger)]">{error}</div>}
      <div className="flex justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-muted)] px-5 py-3.5">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="h-9 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3.5 text-[12px] font-medium text-[var(--text-secondary)] shadow-[var(--shadow-card)] transition-[background-color,border-color,transform] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-45">取消</button>
        <button type="button" disabled={busy} onClick={onConfirm} className={`flex h-9 min-w-24 items-center justify-center rounded-lg px-3.5 text-[12px] font-medium shadow-[var(--shadow-card)] transition-[background-color,transform] active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45 ${danger ? 'bg-[var(--status-danger-solid)] text-[var(--text-on-action)] hover:bg-[var(--status-danger)] focus-visible:ring-[var(--status-danger-solid)]' : 'bg-[var(--surface-inverse)] text-[var(--text-inverse)] hover:bg-[var(--surface-inverse-hover)] focus-visible:ring-[var(--border-strong)]'}`}>{busy ? <><RefreshCw size={12} className="mr-1.5 animate-spin"/>处理中</> : confirmLabel}</button>
      </div>
    </div>
  </div>;
}
