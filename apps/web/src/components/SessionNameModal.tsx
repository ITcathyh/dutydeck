import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_NAME_MAX_LENGTH } from '@dutydeck/shared';
import { api, type Session } from '../api';
import { Banner, Button, Dialog, IconButton, Input } from './primitives';

export type SessionNameModalProps = {
  open: boolean;
  session: Session | null | undefined;
  onClose(): void;
};

export function SessionNameModal({ open, session, onClose }: SessionNameModalProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open && session) {
      setName(session.name ?? '');
      setError(undefined);
      setPending(false);
    }
  }, [open, session]);

  if (!open || !session) return null;

  const targetSession = session;
  const currentTrimmedName = targetSession.name?.trim() ?? '';
  const trimmed = name.trim();
  const hasExistingName = Boolean(currentTrimmedName);
  const isUnchanged = trimmed === currentTrimmedName;
  const saveDisabled = pending || trimmed.length === 0 || isUnchanged;
  const resetDisabled = pending || !hasExistingName;

  async function mutateName(nextName: string | null) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await queryClient.cancelQueries({ queryKey: ['sessions'] });
      const result = await api.setSessionName(targetSession.id, nextName);
      await queryClient.cancelQueries({ queryKey: ['sessions'] });
      queryClient.setQueryData<Session[]>(['sessions'], current => {
        if (!current) return current;
        return current.map(item => item.id === targetSession.id ? { ...item, name: result.name } : item);
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名会话失败');
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    if (saveDisabled) return;
    void mutateName(trimmed);
  }

  function handleReset() {
    if (resetDisabled) return;
    void mutateName(null);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="重命名会话"
      size="sm"
      closeOnEscape={!pending}
      closeOnScrim={!pending}
    >
      <Dialog.Header className="items-center justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-title font-semibold text-primary">重命名会话</h2>
        </div>
        <IconButton label="关闭" disabled={pending} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </Dialog.Header>
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <Dialog.Body className="space-y-3">
          <div className="space-y-1.5">
            <div className="min-w-0 flex-1">
              <Input
                autoFocus
                aria-label="会话名称"
                maxLength={SESSION_NAME_MAX_LENGTH}
                value={name}
                disabled={pending}
                onChange={event => setName(event.target.value)}
                placeholder="输入会话名称"
              />
            </div>
            <p className="text-caption text-subtle">名称用于识别会话，不会修改原始对话。</p>
          </div>
          {error && <Banner tone="danger">{error}</Banner>}
        </Dialog.Body>
        <Dialog.Footer className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={resetDisabled}
            onClick={handleReset}
          >
            恢复默认名称
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={saveDisabled}
              loading={pending}
              className="min-w-20"
            >
              保存
            </Button>
          </div>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
