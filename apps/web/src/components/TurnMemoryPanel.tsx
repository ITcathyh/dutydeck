import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type LarkTurnMemoryEntry, type Session } from '../api';
import { toastStore } from '../useToasts';
import { Button } from './primitives';

const sourceLabels: Record<LarkTurnMemoryEntry['source'], string> = { user: '用户', agent: 'Agent', extraction: '提取', consolidation: '整理' };

const formatTurnTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

/** 飞书任务每一轮注入了哪些记忆、新写入了哪些记忆；每条可一键删除，权限与服务端 /forget 同一道门。 */
export function TurnMemoryPanel({ session }: { session: Session }) {
  const qc = useQueryClient();
  const memory = useQuery({ queryKey: ['sessionMemory', session.id], queryFn: () => api.sessionMemory(session.id), refetchInterval: 5_000 });
  const forget = useMutation({
    mutationFn: ({ taskId, memoryId }: { taskId: string; memoryId: string }) => api.forgetSessionMemory(session.id, taskId, memoryId),
    onSuccess: (_result, variables) => {
      void qc.invalidateQueries({ queryKey: ['sessionMemory', session.id] });
      toastStore.push({ kind: 'success', key: `forget-memory-${variables.memoryId}`, title: `已删除记忆 ${variables.memoryId}`, description: '之后的任务不再带上这条记忆。' });
    },
    onError: error => toastStore.push({ kind: 'error', key: 'forget-memory', title: '删除记忆失败', description: error.message })
  });
  if (memory.isError) return <p className="my-3 text-caption text-subtle">记忆记录读取失败</p>;
  const turns = memory.data?.turns ?? [];
  if (!turns.length) return null;
  const list = (taskId: string, label: string, entries: LarkTurnMemoryEntry[]) => entries.length ? <div className="mt-1">
    <p className="text-caption text-secondary">{label}（{entries.length} 条）</p>
    <ul className="mt-1 space-y-1">{entries.map(entry => <li key={entry.id} className="flex items-start justify-between gap-2">
      <p className="min-w-0 text-caption text-secondary"><span className="text-subtle">{sourceLabels[entry.source] ?? entry.source} · {entry.id}</span> <span className="line-clamp-2 break-words">{entry.content}</span></p>
      {entry.deletedAt
        ? <span className="shrink-0 text-caption text-subtle">已删除</span>
        : <Button variant="ghost" size="sm" aria-label={`删除记忆 ${entry.id}`} disabled={forget.isPending && forget.variables?.memoryId === entry.id} onClick={() => forget.mutate({ taskId, memoryId: entry.id })}>删除</Button>}
    </li>)}</ul>
  </div> : null;
  return <aside aria-label="本轮记忆" className="my-3 rounded-lg bg-muted px-4 py-2">
    {turns.map(turn => <section key={turn.taskId} className="py-1">
      <p className="text-caption text-subtle">{formatTurnTime(turn.at)}{turn.shared ? ' · 群共享记忆' : ''}</p>
      {list(turn.taskId, '用到的记忆', turn.injected)}
      {list(turn.taskId, '新记下的记忆', turn.written)}
    </section>)}
    <p className="mt-1 text-caption text-subtle">后台提取的新记忆会在提取完成后出现在这里。</p>
  </aside>;
}
