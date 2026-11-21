import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Session, type SteeringResult, type Task } from './api';
import type { SendMode } from './components/Composer';
import { busyStates } from './components/ui';
import { buildPrompt, getModelReadiness, splitPromptFileReferences } from './composer-utils';
import { acknowledgeComposerDraft, readComposerDraft, updateComposerDraft, useComposerDraft } from './composer-draft';
import type { EventWindow } from './event-history';
import { currentInstance } from './instance';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { requestId } from './request-id';
import { SendOperationStore } from './send-operations';
import { useDockStore } from './store';
import { toastStore } from './useToasts';

type QueueCancelOperation = { id: string; editDraftKey?: string; task?: Task };
const queueCancelOperations = new Map<string, QueueCancelOperation>();
const queueCancelKey = (sessionId: string, taskId: string) => JSON.stringify([currentInstance(), sessionId, taskId]);

// 只有明确未投递的指令继续排队；结果未知时由人在执行记录下方选择重新执行、标为已完成或标为失败。
const steeringSkipped: Record<string, string> = {
  promptRequired: '正在执行的那一轮此刻接不了插话（还没交给 Agent，或已经结束）。', unsupported: '当前 Agent 不支持插话。',
  incompatible: '这条指令的执行设置与正在执行的这一轮不同。'
};
const steeringToast = ({ outcome, error }: SteeringResult, task: Task) => {
  if (task.status === 'reconcile_required') return { kind: 'warning' as const, key: 'steering', title: '插话投递结果未知', description: '这条指令可能已送达，也可能没有。不会自动重发：请在执行记录下方选择重新执行、标为已完成或标为失败。' };
  if (outcome === 'failed' && task.status !== 'queued') return { kind: 'info' as const, key: 'steering', title: '插话请求未确认', description: '这条指令已不在队列中，请查看最新执行记录核对。' };
  return outcome === 'injected'
    ? { kind: 'success' as const, key: 'steering', title: '已插话到当前这一轮', description: 'Agent 会在这一轮里接着处理这条指令。' }
    : outcome === 'moved'
      ? { kind: 'info' as const, key: 'steering', title: '没有插话', description: task.status === 'cancelled' ? '这条指令在插话之前已被取消。' : task.status === 'running' ? '这条指令在插话之前已经开始执行，按普通的一轮处理。' : '这条指令已不在队列中，请查看最新执行记录核对。' }
    : outcome === 'startedNewTurn'
      ? { kind: 'warning' as const, key: 'steering', title: 'Agent 用这条指令另起了一轮', description: '那一轮不在执行记录里，结果不会显示在这里。' }
      : { kind: 'info' as const, key: 'steering', title: '没有插话，这条指令在排队', description: `${steeringSkipped[outcome] ?? `插话失败${error ? `：${error}` : '。'}`}当前任务完成后会执行它。` };
};

export type SendFailure = { sessionId: string; message: string; retry: boolean };

export function useSessionActions(activeSessionId: string | undefined, {
  active, tasks, selectSession, setActionError, setSendFailure
}: {
  active?: Session;
  tasks: { data?: Task[] };
  selectSession(id?: string): void;
  setActionError: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSendFailure: React.Dispatch<React.SetStateAction<SendFailure | undefined>>;
}) {
  const qc = useQueryClient();
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [bulkArchiveIds, setBulkArchiveIds] = useState<string[]>([]);
  const composerDraft = useComposerDraft(activeSessionId);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const pendingSends = useIsMutating({ mutationKey: ['composer-send'], predicate: mutation => (mutation.state.variables as { sessionId?: string } | undefined)?.sessionId === activeSessionId });
  const { text: prompt, references: composerReferences, mode: sendMode, planFirst } = composerDraft.draft;
  // queue/interrupt 的未确认操作只在同一标签页内跨刷新保留，另一标签页视为新请求。
  const sendOperations = useRef<SendOperationStore | null>(null);
  const sendOperationStore = sendOperations.current ??= new SendOperationStore();
  const activeModels = useQuery({ queryKey: agentModelsQueryKey(active?.agentId, active?.model), queryFn: () => loadAgentModels(active!.agentId, active!.model), enabled: Boolean(active && !active.archivedAt), initialData: () => active ? readCachedAgentModels(active.agentId, active.model) : undefined, initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 60_000 });

  useEffect(() => {
    if (!queueCancelOperations.size) return;
    for (const task of tasks.data ?? []) {
      if (task.status !== 'queued' && task.status !== 'cancelled') queueCancelOperations.delete(queueCancelKey(task.sessionId, task.id));
    }
  }, [tasks.data]);
  // A cancellation event can remove the queue row before the HTTP response arrives.
  const retryQueuedEdits = Array.from(queueCancelOperations.values()).flatMap(({ task, editDraftKey }) => {
    if (!task || editDraftKey !== composerDraft.key) return [];
    const status = tasks.data?.find(current => current.id === task.id)?.status;
    return status === undefined || status === 'cancelled' ? [task] : [];
  });

  const send = useMutation({
    mutationKey: ['composer-send'],
    retry: false,
    mutationFn: ({ sessionId, message, mode, skillRequests, plan, idempotencyKey }: { sessionId: string; message: string; mode: SendMode; skillRequests?: string[]; draftKey: string; submittedDraft: typeof composerDraft.draft; plan?: boolean; idempotencyKey?: string; reusedUnknownOperation: boolean }) => plan ? api.plan(sessionId, message) : mode === 'steer' ? api.send(sessionId, message, mode, skillRequests) : api.send(sessionId, message, mode, skillRequests, idempotencyKey),
    onSuccess: (result, variables) => {
      if (variables.idempotencyKey) sendOperationStore.delete(variables.draftKey, variables.idempotencyKey);
      setSendFailure(current => current?.sessionId === variables.sessionId ? undefined : current);
      acknowledgeComposerDraft(variables.draftKey, variables.submittedDraft);
      qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => current?.some(task => task.id === result.task.id) ? current : [...(current ?? []), result.task]);
      void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId], exact: true });
      if (result.steering && (result.task.status === 'queued' || result.steering.outcome !== 'promptRequired')) toastStore.push(steeringToast(result.steering, result.task));
    },
    onError: (error, variables) => {
      if (variables.sessionId !== useDockStore.getState().activeSessionId) return;
      const unknown = !(error instanceof ApiError) || error.status === 408 || error.status >= 500 || error.code === 'unknown_outcome' || (variables.reusedUnknownOperation && error.status === 401);
      if (!unknown) {
        if (variables.idempotencyKey) sendOperationStore.delete(variables.draftKey, variables.idempotencyKey);
        setActionError(error.message);
        return;
      }
      if (variables.plan) { setActionError(error.message); return; }
      setSendFailure({
        sessionId: variables.sessionId,
        retry: variables.mode !== 'steer',
        message: variables.mode === 'steer'
          ? `插话结果未知：${error.message}。请先核对现有任务和执行记录；为避免重复执行，不会自动重发。`
          : `发送结果未知：${error.message}。可重试同一草稿；若服务端已接受，将返回原任务，不会重复执行。`
      });
    }
  });
  const cancelQueued = useMutation({ mutationFn: ({ sessionId, taskId, operation }: { sessionId: string; taskId: string; key: string; operation: QueueCancelOperation; prompt?: string }) => api.cancelQueued(sessionId, taskId, operation.id), onSuccess: (result, variables) => {
    const { key, operation } = variables;
    if (queueCancelOperations.get(key) !== operation) return;
    qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => current?.map(task => task.id === result.id ? result : task));
    setActionError(undefined);
    if (operation.editDraftKey) {
      if (result.canEditQueued === false) {
        queueCancelOperations.delete(key);
        setActionError('这条待执行指令已取消。原来选择的 Skill 无法恢复。');
        return;
      }
      const draft = readComposerDraft(operation.editDraftKey);
      const restored = splitPromptFileReferences(result.prompt);
      const references = new Map(draft.references.map(reference => [reference.id, reference]));
      for (const reference of restored.references) if (!references.has(reference.id)) references.set(reference.id, reference);
      for (const value of result.skillRequests ?? []) {
        const id = `skill-${value}`;
        const label = result.skillDeliveries?.find(skill => skill.path === value || skill.ref === value)?.name ?? value;
        if (!references.has(id)) references.set(id, { id, kind: 'skill', label, value });
      }
      updateComposerDraft(operation.editDraftKey, { text: [draft.text, restored.text].filter(text => text.trim()).join('\n\n'), references: [...references.values()] });
      queueCancelOperations.delete(key);
      requestAnimationFrame(() => {
        if (useDockStore.getState().activeSessionId !== variables.sessionId) return;
        const input = composerInput.current;
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      });
      return;
    }
    // 撤销只能把指令重新排到队尾，拿不回原来的任务 ID 和位置，所以 description 必须说清楚，不假装能还原现场。
    queueCancelOperations.delete(key);
    const restorable = result.canEditQueued === false ? undefined : variables.prompt?.trim();
    toastStore.push({ kind: 'success', key: `cancel-queued-${variables.taskId}`, title: '已取消 1 条待执行指令', description: restorable ? '恢复会把这条指令重新排到队列末尾，不会回到原来的位置。' : undefined, action: restorable ? { label: '重新加入队尾', run: () => api.send(variables.sessionId, restorable, 'queue', result.skillRequests, requestId()).then(() => { void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }) } : undefined });
  }, onError: (error, { key, operation }) => {
    const current = queueCancelOperations.get(key);
    if (current && current !== operation) return;
    if (error instanceof ApiError && error.status === 409) operation.task = undefined;
    setActionError(error.message);
    toastStore.push({ kind: 'error', key: 'cancel-queued', title: '取消待执行指令失败', description: error.message });
  } });
  const cancelQueueTask = (sessionId: string, taskId: string, editDraftKey?: string) => {
    const key = queueCancelKey(sessionId, taskId);
    const operation = queueCancelOperations.get(key) ?? { id: requestId() };
    const task = qc.getQueryData<Task[]>(['tasks', sessionId])?.find(item => item.id === taskId);
    operation.editDraftKey = editDraftKey;
    operation.task = editDraftKey ? operation.task ?? task : undefined;
    queueCancelOperations.set(key, operation);
    cancelQueued.mutate({ sessionId, taskId, key, operation, prompt: task?.prompt });
  };
  const steerQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.steerQueued(sessionId, taskId), onSuccess: (_result, variables) => { setActionError(undefined); void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }, onError: error => setActionError(error.message) });
  const injectQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.injectQueued(sessionId, taskId), onSuccess: (result, variables) => { setActionError(undefined); toastStore.push(steeringToast(result, result.task)); void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }, onError: error => setActionError(error.message) });
  const archive = useMutation({ mutationFn: (sessionId: string) => api.archive(sessionId), onSuccess: result => { qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); setArchiveConfirm(false); selectSession(undefined); toastStore.push({ kind: 'success', key: 'archive', title: '任务已归档', description: '历史指令和执行记录仍可在「已归档」筛选中查看。' }); }, onError: error => setActionError(error.message) });
  const bulkArchive = useMutation({
    mutationFn: async (ids: string[]) => {
      const archived = new Map<string, Session>();
      const failures: Array<{ id: string; message: string }> = [];
      for (const id of new Set(ids)) {
        try { archived.set(id, await api.archive(id)); }
        catch (error) { failures.push({ id, message: error instanceof Error ? error.message : String(error) }); }
      }
      return { archived, failures };
    },
    onSuccess: async ({ archived, failures }) => {
      await qc.cancelQueries({ queryKey: ['sessions'], exact: true });
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => archived.get(session.id) ?? session));
      setBulkArchiveIds(failures.map(failure => failure.id));
      toastStore.push({
        kind: failures.length ? archived.size ? 'warning' : 'error' : 'success',
        key: 'bulk-archive',
        title: failures.length ? `已清理 ${archived.size} 个任务，${failures.length} 个失败` : `已清理 ${archived.size} 个任务`,
        description: failures.length ? '失败项已保留，可重试。' : '历史指令和执行记录可在「已归档」中查看。'
      });
    }
  });
  const restart = useMutation({ mutationFn: api.restart, onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void qc.invalidateQueries({ queryKey: ['sessions'] }); void qc.invalidateQueries({ queryKey: ['events', activeSessionId] }); void qc.invalidateQueries({ queryKey: ['tasks', activeSessionId] }); toastStore.push({ kind: 'success', key: 'restart', title: '任务已重新启动', description: '这是一个全新的 Agent 进程，会从空白上下文开始；之前的对话不会带过来。' }); }, onError: error => { setActionError(error.message); toastStore.push({ kind: 'error', key: 'restart', title: '重新启动失败', description: error.message }); } });
  const resolvePermission = useMutation({ mutationFn: ({ sessionId, permissionId, approved, reason }: { sessionId: string; permissionId: string; approved: boolean; reason?: string }) => reason ? api.permission(sessionId, permissionId, approved, reason) : api.permission(sessionId, permissionId, approved), onSuccess: (_result, variables) => { qc.setQueryData<EventWindow>(['events', variables.sessionId], current => { if (!current) return current; const next = current.events.map(event => event.type === 'permission_request' && (event.data.id === variables.permissionId || event.id === variables.permissionId) ? { ...event, data: { ...event.data, status: variables.approved ? 'approved' : 'rejected', ...(variables.reason ? { reason: variables.reason } : {}) } } : event); return { ...current, events: next, previousEvents: undefined, changes: undefined }; }); }, onError: (error, variables) => { setActionError(error.message); void qc.invalidateQueries({ queryKey: ['events', variables.sessionId] }); void qc.invalidateQueries({ queryKey: ['sessions'] }); } });
  const resolveActivePermission = useCallback((permissionId: string, approved: boolean, reason?: string) => resolvePermission.mutateAsync({ sessionId: active!.id, permissionId, approved, reason }), [active?.id, resolvePermission.mutateAsync]);
  const pickComposerFile = useMutation({ mutationFn: api.selectFile, onError: error => setActionError(error.message) });
  const refreshModels = useMutation({ mutationFn: ({ agentId: targetAgentId, currentModel }: { agentId: string; currentModel?: string }) => loadAgentModels(targetAgentId, currentModel, true), onSuccess: (result, variables) => { setActionError(undefined); qc.setQueryData(agentModelsQueryKey(variables.agentId, variables.currentModel), result); }, onError: error => setActionError(error.message) });
  const switchModel = useMutation({ mutationFn: ({ sessionId, nextModel }: { sessionId: string; nextModel: string }) => api.setSessionModel(sessionId, nextModel), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void activeModels.refetch(); }, onError: error => setActionError(error.message) });
  const switchReasoningEffort = useMutation({ mutationFn: ({ sessionId, nextReasoningEffort }: { sessionId: string; nextReasoningEffort: string }) => api.setSessionReasoningEffort(sessionId, nextReasoningEffort), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); }, onError: error => setActionError(error.message) });
  const modelReadiness = getModelReadiness({ loaded: activeModels.data !== undefined, loading: activeModels.data === undefined && (activeModels.isPending || activeModels.isFetching || refreshModels.isPending), switching: switchModel.isPending, failed: activeModels.data === undefined && activeModels.isError });
  const submit = () => {
    if (modelReadiness.kind !== 'ready') { setActionError(modelReadiness.reason); return; }
    if (planFirst && active?.source === 'lark') { setActionError('飞书会话请在飞书发送 /plan；如需直接执行，请先改为普通消息。'); return; }
    const message = buildPrompt(prompt, composerReferences);
    if (!activeSessionId) { setActionError('请先选择要发送消息的任务。'); return; }
    if (!message) { setActionError('请先填写消息或添加引用，再重试发送。'); return; }
    const draftKey = composerDraft.key!;
    const submittedDraft = composerDraft.draft;
    const skillRequests = composerReferences.filter(reference => reference.kind === 'skill').map(reference => reference.value);
    const snapshot = JSON.stringify({ message, skillRequests, mode: sendMode, planFirst });
    const previous = sendOperationStore.get(draftKey, snapshot);
    const retry = planFirst ? undefined : previous;
    // interrupt 被接受后页面可能已经空闲；同一未知响应的重试仍须沿用最初的实际 mode。
    const mode = retry?.mode ?? (busyStates.has(active?.state ?? '') ? sendMode : 'queue');
    const idempotencyKey = !planFirst && mode !== 'steer' ? retry?.key ?? requestId() : undefined;
    if (idempotencyKey && mode !== 'steer' && !retry) sendOperationStore.set(draftKey, { snapshot, mode, key: idempotencyKey });
    setSendFailure(undefined);
    send.mutate({ sessionId: activeSessionId, message, draftKey, submittedDraft, mode, skillRequests, plan: planFirst, idempotencyKey, reusedUnknownOperation: Boolean(retry) });
  };
  const act = async (action: string) => { try { setActionError(undefined); await api.action(activeSessionId!, action); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };

  return {
    composerDraft, composerInput, prompt, composerReferences, sendMode, planFirst, pendingSends,
    archiveConfirm, setArchiveConfirm, bulkArchiveIds, setBulkArchiveIds, retryQueuedEdits,
    send, submit, act, cancelQueued, cancelQueueTask, steerQueued, injectQueued, archive, bulkArchive,
    restart, resolvePermission, resolveActivePermission, pickComposerFile, activeModels, refreshModels,
    switchModel, switchReasoningEffort, modelReadiness
  };
}
