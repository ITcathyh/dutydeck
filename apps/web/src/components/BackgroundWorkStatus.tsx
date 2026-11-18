import { memo, useMemo } from 'react';
import type { DockEvent } from '../api';

const kindLabels: Record<string, string> = { agent: 'Agent', shell: '命令', monitor: '监控' };
const stateLabels: Record<string, string> = { running: '运行中', completed: '已完成', failed: '失败', killed: '已终止', stopped: '已停止', expired: '已到期' };
const terminalStates = new Set(['completed', 'failed', 'killed', 'stopped', 'expired']);
const ownLabel = (labels: Record<string, string>, value: string) => Object.prototype.hasOwnProperty.call(labels, value) ? labels[value]! : value;
type BackgroundTask = { id: string; kind: string; state: string };

const BackgroundTaskList = memo(function BackgroundTaskList({ tasks }: { tasks: BackgroundTask[] }) {
  return <ul className="mt-1 max-h-[40dvh] space-y-1 overflow-y-auto pr-1">{tasks.map(task => <li key={task.id}>{ownLabel(kindLabels, task.kind)} · {ownLabel(stateLabels, task.state)} · <span className="font-mono">{task.id}</span></li>)}</ul>;
});

// 只呈现会话级原生生命周期；不向当前轮次追加回答或修改任务状态。
export const BackgroundWorkStatus = memo(function BackgroundWorkStatus({ events }: { events: DockEvent[] }) {
  let event: DockEvent | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const item = events[index]!;
    if (item.type === 'status' && item.data.state === 'background_work') { event = item; break; }
  }
  const taskData = event?.data.tasks;
  const tasks = useMemo(() => (Array.isArray(taskData) ? taskData : []).filter((task: unknown): task is BackgroundTask =>
    task !== null && typeof task === 'object'
    && typeof (task as BackgroundTask).id === 'string'
    && typeof (task as BackgroundTask).kind === 'string'
    && typeof (task as BackgroundTask).state === 'string'
  ), [taskData]);
  if (!event) return null;
  const count = event.data.count;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0 || (count === 0 && tasks.length === 0)) return null;
  const laterInput = count > 0 && event.data.mainTurnEnded === true && events.some(item => item.sequence > event.sequence && item.type === 'text' && item.data.role === 'user' && !item.data.steering);
  const allTasksTerminal = tasks.every(task => terminalStates.has(task.state));
  return <div role="status" className="shrink-0 border-b border-default bg-surface px-4 py-2 text-caption text-secondary">
    {count > 0 && event.data.mainTurnEnded === true && !laterInput ? '主回合已结束 · ' : ''}{count > 0 ? `后台子任务运行中（${count}）` : allTasksTerminal ? '后台子任务已结束' : '后台子任务状态'}
    {tasks.length > 0 && <details className="mt-1 text-subtle"><summary className="cursor-pointer">后台任务详情</summary>
      <BackgroundTaskList tasks={tasks}/>
    </details>}
  </div>;
});
