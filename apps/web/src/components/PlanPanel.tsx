import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import { api, ApiError, type PlanAction, type Session, type Task } from '../api';
import { toastStore } from '../useToasts';
import { Button } from './primitives';

const done: Record<PlanAction, string> = { approve: '已批准，Agent 开始按计划执行。', revise: '已提交修改意见，Agent 会重新出计划。', cancel: '已取消，这份计划不会执行。' };
const deadline = (at: string) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

/** 先出计划：最近一轮是计划轮时，在执行记录末尾给出批准、提修改意见、取消。计划正文就是那一轮的最后回复。 */
export function PlanPanel({ session, tasks }: { session: Session; tasks: Task[] }) {
  const qc = useQueryClient();
  const [feedback, setFeedback] = useState('');
  const latest = tasks.reduce<Task | undefined>((last, task) => !last || Date.parse(task.createdAt) >= Date.parse(last.createdAt) ? task : last, undefined);
  const planning = Boolean(latest && /^\/plan(\s|$)/.test(latest.prompt.trim()));
  const plan = useQuery({ queryKey: ['plan', session.id, latest?.id, latest?.status], queryFn: () => api.planState(session.id), enabled: planning && !session.archivedAt, retry: false });
  const decide = useMutation({
    mutationFn: ({ taskId, action }: { taskId: string; action: PlanAction }) => api.decidePlan(session.id, taskId, action, action === 'revise' ? feedback.trim() : undefined),
    onSuccess: (_result, { action }) => {
      setFeedback('');
      toastStore.push({ kind: 'success', key: `plan-${session.id}`, title: done[action] });
      void qc.invalidateQueries({ queryKey: ['tasks', session.id] });
      void qc.invalidateQueries({ queryKey: ['plan', session.id] });
    },
    onError: error => {
      toastStore.push({ kind: 'error', key: `plan-${session.id}`, title: '计划没有处理成功', description: error.message });
      void qc.invalidateQueries({ queryKey: ['plan', session.id] });
    }
  });
  if (!planning || session.archivedAt || !plan.data) return plan.isError && !(plan.error instanceof ApiError && plan.error.status === 403) ? <p className="my-3 text-caption text-subtle">计划状态读取失败：{plan.error.message}</p> : null;
  const state = plan.data;
  if (state.state === 'planning') return <p className="my-3 flex items-center gap-2 text-caption text-subtle"><ClipboardList size={13}/>正在出计划：Agent 只调研、不改文件，计划出来后在这里批准。</p>;
  if (state.state !== 'pending' || !state.taskId) return null;
  const taskId = state.taskId;
  const busy = (action: PlanAction) => decide.isPending && decide.variables?.action === action;
  return <section aria-label="执行计划待批准" className="my-3 rounded-md border border-info-border bg-info-soft p-3 text-caption">
    <h3 className="flex items-center gap-1.5 font-semibold text-info"><ClipboardList size={13}/>计划已出，等你决定</h3>
    {state.operable ? <>
      <p className="mt-1 text-secondary">上面最后一条回复就是计划，Agent 还没有改任何东西。批准后在本会话按计划执行；要调整就写下修改意见，Agent 会重新出计划。{state.expiresAt ? `${deadline(state.expiresAt)}（北京时间）前未处理，这份计划失效。` : ''}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" loading={busy('approve')} disabled={decide.isPending} onClick={() => decide.mutate({ taskId, action: 'approve' })}>批准执行</Button>
        <Button size="sm" variant="secondary" loading={busy('cancel')} disabled={decide.isPending} onClick={() => decide.mutate({ taskId, action: 'cancel' })}>取消</Button>
      </div>
      <textarea aria-label="修改意见" value={feedback} maxLength={2000} onChange={event => setFeedback(event.target.value)} placeholder="写下要怎么改这份计划"
        className="mt-2 min-h-16 w-full resize-y rounded-md border border-default bg-surface px-2.5 py-2 text-body text-primary outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus-ring"/>
      <div className="mt-1.5"><Button size="sm" variant="secondary" loading={busy('revise')} disabled={decide.isPending || !feedback.trim()} onClick={() => decide.mutate({ taskId, action: 'revise' })}>提修改意见</Button></div>
    </> : <p className="mt-1 text-secondary">这份计划来自飞书，请在飞书的计划卡上批准、修改或取消。</p>}
  </section>;
}
