import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileDiff } from 'lucide-react';
import { api, type Session } from '../api';
import { Banner, Button, EmptyState, Spinner } from './primitives';
import { TurnDiffContent } from './TurnDiffPage';

export function SessionChangesPanel({ session, onBack }: { session: Session; onBack?(): void }) {
  const turns = useQuery({ queryKey: ['turnDiffs', session.id], queryFn: () => api.turnDiffs(session.id), refetchInterval: 10_000 });
  const [selected, setSelected] = useState('');
  const items = [...turns.data ?? []].reverse();
  const taskId = items.some(item => item.taskId === selected) ? selected : items[0]?.taskId;
  return <section className="min-w-0" aria-label="任务改动">
    <div className="flex flex-wrap items-center gap-3 border-b border-default bg-surface px-3 py-3 sm:px-5">
      <label className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-caption text-secondary">改动范围
        <select aria-label="改动轮次" className="min-h-11 max-w-full rounded-md border border-default bg-surface px-2 text-primary" value={taskId ?? ''} onChange={event => setSelected(event.target.value)} disabled={!items.length}>
          {!items.length && <option value="">尚无改动记录</option>}
          {items.map((item, index) => <option key={item.taskId} value={item.taskId}>第 {items.length - index} 个有改动的轮次{index === 0 ? '（最新）' : ''} · {item.summary.files} 个文件 · +{item.summary.additions} −{item.summary.deletions}</option>)}
        </select>
      </label>
      {onBack && <Button variant="ghost" onClick={onBack}>回到对话</Button>}
    </div>
    {turns.isPending && <div className="grid min-h-40 place-items-center"><Spinner label="读取改动轮次…"/></div>}
    {turns.error && <div className="p-4"><Banner tone="danger">读取改动失败：{turns.error.message}<Button variant="ghost" onClick={() => void turns.refetch()}>重试</Button></Banner></div>}
    {!turns.isPending && !turns.error && !taskId && <EmptyState icon={<FileDiff size={22}/>} title="尚无本轮改动" description="只有在 Git 仓库中完成且记录到文件差异的轮次才会出现在这里。"/>}
    {taskId && <TurnDiffContent key={`${session.id}:${taskId}`} sessionId={session.id} taskId={taskId} shared={false} readOnly={Boolean(session.archivedAt) || session.source === 'work_item' || ['stopped', 'failed'].includes(session.state)} embedded/>}
  </section>;
}
