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
  return <div className="ui-overlay fixed inset-0 z-50 grid place-items-center bg-zinc-950/35 p-4 backdrop-blur-[3px]" onMouseDown={event => { if (!busy && event.currentTarget === event.target) onCancel(); }}>
    <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" className="ui-dialog w-full max-w-[420px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_28px_90px_rgba(24,24,27,.24)]">
      <div className="flex gap-3.5 px-5 pb-4 pt-5">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${danger ? 'bg-red-50 text-red-600 ring-1 ring-red-100' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-100'}`}><AlertTriangle size={19} strokeWidth={1.8}/></div>
        <div className="min-w-0 pt-0.5"><h2 id="confirm-dialog-title" className="text-[15px] font-semibold tracking-[-.01em] text-zinc-900">{title}</h2><p id="confirm-dialog-description" className="mt-1.5 text-[12px] leading-5 text-zinc-500">{description}</p></div>
      </div>
      {error && <div className="mx-5 mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-700">{error}</div>}
      <div className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50/70 px-5 py-3.5">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="h-9 rounded-lg border border-zinc-300 bg-white px-3.5 text-[12px] font-medium text-zinc-700 shadow-sm transition-[background-color,border-color,transform] hover:border-zinc-400 hover:bg-zinc-50 active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40 disabled:cursor-not-allowed disabled:opacity-45">取消</button>
        <button type="button" disabled={busy} onClick={onConfirm} className={`flex h-9 min-w-24 items-center justify-center rounded-lg px-3.5 text-[12px] font-medium text-white shadow-sm transition-[background-color,transform] active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45 ${danger ? 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-400/50' : 'bg-zinc-900 hover:bg-zinc-700 focus-visible:ring-zinc-400/50'}`}>{busy ? <><RefreshCw size={12} className="mr-1.5 animate-spin"/>处理中</> : confirmLabel}</button>
      </div>
    </div>
  </div>;
}
