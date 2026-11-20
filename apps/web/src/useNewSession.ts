import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Agent, type PermissionMode, type Session, type Task } from './api';
import { currentInstance } from './instance';
import { newSessionDrafts, type NewSessionDraft } from './new-session-drafts';
import { requestId } from './request-id';
import { toastStore } from './useToasts';

export const isLegacyPtyAgent = (agent?: Agent) => agent?.protocol === 'pty';
export const supportedPermissionModes = (agent?: Agent): PermissionMode[] =>
  isLegacyPtyAgent(agent) ? [] : agent?.protocol === 'pty-cli' ? ['ask', 'full-trust'] : ['ask', 'approve-reads', 'deny-all', 'full-trust'];

function agentDefaults(agent?: Agent) {
  const permissionMode = agent?.permissionMode ?? 'ask';
  return { permissionMode: supportedPermissionModes(agent).includes(permissionMode) ? permissionMode : 'ask' as const, model: '', codexProfile: '', reasoningEffort: '' };
}

function initialDraft(agents: Agent[], agentId = 'codex'): NewSessionDraft {
  const agent = agents.find(item => item.id === agentId) ?? agents.find(item => !isLegacyPtyAgent(item)) ?? agents[0];
  return { agentId: agent?.id ?? agentId, ...agentDefaults(agent), cwd: '', workspaceMode: 'worktree', goal: '' };
}

type NewSessionOptions = {
  agents: Agent[];
  initialAgentId?: string;
  mode?: 'task' | 'schedule';
  onCreated?(session: Session, task: Task): void;
  onSessionCreated?(session: Session): void;
};

export const sharedWorkspaceNotice = '这个目录不是 Git 仓库，已改为直接使用所选目录';
const usedSharedFallback = (draft: NewSessionDraft, session?: Session) => draft.workspaceMode === 'worktree' && session?.workspaceMode === 'shared';

export function useNewSession({ agents, initialAgentId, mode = 'task', onCreated, onSessionCreated }: NewSessionOptions) {
  const qc = useQueryClient();
  const draftKey = `${currentInstance() ?? '@local'}:${mode}`;
  const [saved, setSaved] = useState(() => {
    const draft = newSessionDrafts.get(draftKey);
    return initialAgentId && draft?.agentId !== initialAgentId && !draft?.createdSession ? undefined : draft;
  });
  const defaults = initialDraft(agents, saved?.agentId ?? initialAgentId);
  const draft = !saved ? defaults : saved.agentId === defaults.agentId || saved.createdSession ? saved
    : { ...defaults, cwd: saved.cwd, workspaceMode: saved.workspaceMode, goal: saved.goal };
  const selectedAgent = agents.find(agent => agent.id === draft.agentId);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const busy = useRef(false);

  const save = useCallback((next: NewSessionDraft) => {
    latestDraft.current = next;
    setSaved(next);
    newSessionDrafts.set(draftKey, next);
  }, [draftKey]);
  const update = useCallback((patch: Partial<NewSessionDraft>) => {
    if (!busy.current) save({ ...latestDraft.current, ...patch });
  }, [save]);

  const create = useMutation({
    retry: false,
    mutationFn: async (submitted: NewSessionDraft) => {
      const { agentId, cwd, workspaceMode, permissionMode, model, codexProfile, reasoningEffort, goal, createdSession, sendOperation } = submitted;
      const session = createdSession ?? await api.create({ agentId, permissionMode, workspaceMode, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(codexProfile ? { codexProfile } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
      if (mode === 'schedule') return { session, task: undefined };
      const prompt = goal.trim();
      const operation = sendOperation?.goal === prompt ? sendOperation : { goal: prompt, key: requestId() };
      save({ ...submitted, createdSession: session, sendOperation: operation });
      const result = await api.send(session.id, prompt, 'queue', undefined, operation.key);
      return { session, task: result.task };
    },
    onSuccess: ({ session, task }, submitted) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      if (task) qc.setQueryData<Task[]>(['tasks', session.id], [task]);
      newSessionDrafts.delete(draftKey);
      setSaved({ ...submitted, goal: '', createdSession: undefined, sendOperation: undefined });
      if (task) onCreated?.(session, task);
      else onSessionCreated?.(session);
      if (usedSharedFallback(submitted, session)) toastStore.push({ kind: 'info', title: sharedWorkspaceNotice });
    },
    onSettled: () => { busy.current = false; }
  });

  const blocked = !draft.createdSession && (!selectedAgent || isLegacyPtyAgent(selectedAgent));
  const hasUsableAgent = agents.some(agent => !isLegacyPtyAgent(agent));
  const needsConfirmation = !draft.createdSession && draft.permissionMode === 'full-trust';
  const canSubmit = !create.isPending && !blocked && (mode === 'schedule' || Boolean(draft.goal.trim()));
  return {
    mode, draft, selectedAgent, hasUsableAgent, needsConfirmation, canSubmit,
    pending: create.isPending, error: create.error, sharedFallback: usedSharedFallback(draft, draft.createdSession),
    update,
    selectAgent(agentId: string) { update({ agentId, ...agentDefaults(agents.find(agent => agent.id === agentId)) }); },
    selectInitialAgent(agentId?: string) {
      if (busy.current || !agentId || agentId === draft.agentId || draft.createdSession) return;
      save(initialDraft(agents, agentId));
      create.reset();
    },
    submit(confirmed = false) {
      if (busy.current || !canSubmit || (needsConfirmation && !confirmed)) return;
      busy.current = true;
      create.mutate(draft);
    }
  };
}

export type NewSessionCreation = ReturnType<typeof useNewSession>;
