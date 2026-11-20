import { useId, useRef } from 'react';
import { ArrowUp, ChevronDown } from 'lucide-react';
import { imeCompositionHandlers, isImeKey } from '../ime';
import { isLegacyPtyAgent, type NewSessionCreation } from '../useNewSession';
import { NewSessionFeedback, workspaceModeLabels } from './NewSessionModal';
import { PromptTemplates } from './PromptTemplates';
import { Button, Card, Textarea } from './primitives';
import { permissionLabels } from './ui';

export function HomeTaskComposer({ creation, onOpenSettings }: { creation: NewSessionCreation; onOpenSettings(): void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const settingsDescription = useId();
  const { draft, selectedAgent, hasUsableAgent, needsConfirmation, pending, canSubmit, update } = creation;
  const { goal, createdSession } = draft;
  if (!createdSession && !hasUsableAgent) return null;

  const agent = selectedAgent?.name ?? draft.agentId;
  const directory = createdSession?.workspaceSourceCwd ?? (draft.cwd || '默认目录');
  const workspace = workspaceModeLabels[createdSession?.workspaceMode ?? draft.workspaceMode];
  const permission = permissionLabels[draft.permissionMode];
  const submit = () => {
    if (!canSubmit) return;
    if (needsConfirmation) onOpenSettings();
    else creation.submit();
  };
  const applyTemplate = (body: string) => {
    const separator = goal.endsWith('\n\n') ? '' : goal.endsWith('\n') ? '\n' : '\n\n';
    update({ goal: goal.trim() ? `${goal}${separator}${body}` : body });
    input.current?.focus();
  };

  return <div className="mb-7 min-w-0 space-y-3">
    <Card padding="sm">
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); submit(); }}>
        <Textarea
          ref={input}
          aria-label="有什么要做的？"
          placeholder="有什么要做的？"
          enterKeyHint="send"
          rows={3}
          value={goal}
          disabled={pending}
          onChange={event => update({ goal: event.target.value })}
          {...imeCompositionHandlers}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || isImeKey(event)) return;
            event.preventDefault();
            if (!event.repeat) submit();
          }}
          className="max-h-64 min-h-24 resize-y text-base"
        />
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <button type="button" aria-label="修改任务设置" aria-describedby={settingsDescription} disabled={pending} onClick={onOpenSettings}
            title={`${agent} · ${directory} · ${workspace} · ${permission}`}
            className="flex min-h-11 w-full min-w-0 items-center gap-1 rounded-md px-1 text-left text-caption text-secondary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50 sm:w-auto sm:flex-1 sm:gap-1.5 sm:px-2">
            <span className="max-w-[30%] shrink-0 truncate font-medium">{agent}</span>
            <span aria-hidden="true">·</span><span className="min-w-0 truncate">{directory}</span>
            <span aria-hidden="true">·</span><span className="shrink-0">{workspace}</span>
            <span aria-hidden="true">·</span><span className="shrink-0">{permission}</span>
            <ChevronDown size={14} className="shrink-0" aria-hidden="true"/>
          </button>
          <span id={settingsDescription} hidden>{agent} · {directory} · {workspace} · {permission}</span>
          <Button type="submit" variant="primary" className="ml-auto" icon={<ArrowUp size={16}/>} loading={pending} disabled={!canSubmit}>{createdSession ? '重试发送' : '发送目标'}</Button>
        </div>
        {!createdSession && isLegacyPtyAgent(selectedAgent) && <p className="text-caption text-warning">请在任务设置中选择支持权限控制的 Agent。</p>}
        <NewSessionFeedback creation={creation}/>
      </form>
    </Card>
    <PromptTemplates disabled={pending} onApply={applyTemplate}/>
  </div>;
}
