import { X } from 'lucide-react';
import type { Session } from '../api';
import { IconButton } from './ui';

export type SystemPromptModalProps = { open: boolean; session?: Session; onClose(): void };

export function SystemPromptModal({ open, session, onClose }: SystemPromptModalProps) {
  if (!open || !session?.systemPrompt) return null;
  return <div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-[var(--overlay-scrim)] p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="ui-dialog flex max-h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] shadow-[var(--shadow-dialog)]">
      <div className="flex items-center border-b border-[var(--border-subtle)] px-4 py-3"><div className="min-w-0"><h2 className="text-[14px] font-semibold text-[var(--text-primary)]">系统提示词</h2><p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">该任务运行创建时注入的系统提示词</p></div><span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span></div>
      <div className="overflow-y-auto px-4 py-4"><pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-[var(--text-secondary)]">{session.systemPrompt}</pre></div>
    </div>
  </div>;
}
