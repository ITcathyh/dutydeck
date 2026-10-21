import type { DockEvent } from '../api';

const kindLabels: Record<string, string> = { agent: 'Agent', shell: '命令', monitor: '监控' };
const stateLabels: Record<string, string> = { running: '运行中', completed: '已完成', failed: '失败', killed: '已终止', stopped: '已停止', expired: '已到期' };

// 只呈现会话级原生生命周期；不向当前轮次追加回答或修改任务状态。
export function BackgroundWorkStatus({ events }: { events: DockEvent[] }) {
  let event: DockEvent | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const item = events[index]!;
    if (item.type === 'status' && item.data.state === 'background_work') { event = item; break; }
  }
  if (!event || typeof event.data.count !== 'number' || event.data.count <= 0) return null;
  const tasks = Array.isArray(event.data.tasks) ? event.data.tasks : [];
  const laterInput = events.some(item => item.sequence > event.sequence && item.type === 'text' && item.data.role === 'user' && !item.data.steering);
  return <div role="status" className="shrink-0 border-b border-default bg-surface px-4 py-2 text-caption text-secondary">
    {event.data.mainTurnEnded === true && !laterInput ? '主回合已结束 · ' : ''}后台子任务运行中（{event.data.count}）
    {tasks.length > 0 && <details className="mt-1 text-subtle"><summary className="cursor-pointer">后台任务详情</summary>
      <ul className="mt-1 space-y-1">{tasks.map((task: { id: string; kind: string; state: string }) => <li key={task.id}>{kindLabels[task.kind] ?? task.kind} · {stateLabels[task.state] ?? task.state} · <span className="font-mono">{task.id}</span></li>)}</ul>
    </details>}
  </div>;
}
