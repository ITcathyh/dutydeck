import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unknownTaskActionLabels, unknownTaskRetryWarning, type UnknownTaskAction } from '@dutydeck/shared';
import { api, ApiError, type Session, type Task, type UnknownTask } from '../api';
import { toastStore } from '../useToasts';
import { Button } from './primitives';
import { ConfirmDialog } from './ConfirmDialog';

const done: Record<UnknownTaskAction, string> = {
  retry: '原请求已重新排进队列，按顺序执行。', completed: '这一轮按人工确认结算为已完成，不会重发。', failed: '这一轮按人工确认结算为失败，不会重发。'
};

/** 结果未知的那几轮：与飞书提醒卡同样的事实摘要和三个操作。重新执行要在确认框里再确认一次。 */
export function UnknownTasksPanel({ session, tasks }: { session: Session; tasks: Task[] }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<UnknownTask>();
  const pending = tasks.filter(task => task.status === 'reconcile_required').map(task => task.id).join(',');
  const unknown = useQuery({ queryKey: ['unknown-tasks', session.id, pending], queryFn: () => api.unknownTasks(session.id), enabled: Boolean(pending) && !session.archivedAt, retry: false });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['tasks', session.id] }), qc.invalidateQueries({ queryKey: ['unknown-tasks', session.id] })]);
  const resolve = useMutation({
    mutationFn: ({ task, action }: { task: UnknownTask; action: UnknownTaskAction }) =>
      api.resolveUnknownTask(session.id, task.taskId, { target: task.target, action, ...(action === 'retry' ? { allowDuplicateEffects: true as const } : {}) }),
    onSuccess: (_result, { task, action }) => {
      setConfirming(undefined);
      toastStore.push({ kind: 'success', key: `unknown-task-${task.taskId}`, title: `已${unknownTaskActionLabels[action]}`, description: done[action] });
      void refresh();
    },
    onError: (error, { task }) => {
      // 已被别人处理或状态变了：关掉确认框，按最新状态重画。
      setConfirming(undefined);
      toastStore.push({ kind: 'error', key: `unknown-task-${task.taskId}`, title: '没有处理成功', description: error.message });
      void refresh();
    }
  });
  if (!pending || session.archivedAt) return null;
  if (unknown.isError) return unknown.error instanceof ApiError && unknown.error.status === 403 ? null : <p className="my-3 text-caption text-subtle">结果未知的任务读取失败：{unknown.error.message}</p>;
  const items = unknown.data ?? [];
  if (!items.length) return null;
  const busy = (task: UnknownTask, action: UnknownTaskAction) => resolve.isPending && resolve.variables?.task.taskId === task.taskId && resolve.variables.action === action;
  return <>
    {items.map(task => <section key={`${task.taskId}:${task.target}`} aria-label={`结果未知：${task.prompt}`} className="my-3 rounded-md border border-warning-border bg-warning-soft p-3 text-caption">
      <h3 className="font-semibold text-warning">这一轮的结果未知，需要你决定怎么处理</h3>
      <p className="mt-1 line-clamp-2 break-words text-secondary">{task.prompt}</p>
      <ul className="mt-2 space-y-0.5 text-secondary">{task.factLines.map(line => <li key={line}>{line}</li>)}</ul>
      <p className="mt-2 text-subtle">为避免重复执行，Dutydeck 不会自动重发。可以先看上面的执行记录确认做到了哪一步，再选择。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={resolve.isPending} onClick={() => setConfirming(task)}>{unknownTaskActionLabels.retry}</Button>
        <Button size="sm" variant="secondary" loading={busy(task, 'completed')} disabled={resolve.isPending} onClick={() => resolve.mutate({ task, action: 'completed' })}>{unknownTaskActionLabels.completed}</Button>
        <Button size="sm" variant="secondary" loading={busy(task, 'failed')} disabled={resolve.isPending} onClick={() => resolve.mutate({ task, action: 'failed' })}>{unknownTaskActionLabels.failed}</Button>
      </div>
    </section>)}
    <ConfirmDialog open={Boolean(confirming)} title="确认重新执行？" description={`${unknownTaskRetryWarning}确认后按原请求排进队列。`} confirmLabel={unknownTaskActionLabels.retry}
      busy={confirming ? busy(confirming, 'retry') : false} onCancel={() => setConfirming(undefined)} onConfirm={() => confirming && resolve.mutate({ task: confirming, action: 'retry' })}/>
  </>;
}
