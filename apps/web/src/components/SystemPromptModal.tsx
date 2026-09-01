import { X } from 'lucide-react';
import type { Session } from '../api';
import { Dialog, IconButton } from './primitives';

export type SystemPromptModalProps = { open: boolean; session?: Session; onClose(): void };

/*
  只读的提示词查看器。

  重构前它是全站唯一一个**完全没有对话框语义**的遮罩：没有 role="dialog"、
  没有 aria-modal、没有焦点管理、也没有 Escape，读屏用户既不知道自己进了模态，
  键盘用户也退不出去（只能用鼠标点那颗关闭按钮）。换成 Dialog 原语后四项一次补齐。

  没有提示词时整块不渲染，而不是画一个空弹层——契约 §10 的同一条纪律：
  「读不到」不是空态，不给用户一个永远为空的面板。
*/
export function SystemPromptModal({ open, session, onClose }: SystemPromptModalProps) {
  return <Dialog open={open && Boolean(session?.systemPrompt)} onClose={onClose} label="系统提示词" size="md">
    <Dialog.Header className="items-center">
      <div className="min-w-0 flex-1">
        <h2 className="text-title font-semibold text-primary">系统提示词</h2>
        <p className="mt-0.5 truncate text-caption text-subtle">该任务创建时注入的系统提示词</p>
      </div>
      <IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton>
    </Dialog.Header>
    <Dialog.Body>
      <pre className="m-0 whitespace-pre-wrap break-words font-mono text-caption text-secondary">{session?.systemPrompt}</pre>
    </Dialog.Body>
  </Dialog>;
}
