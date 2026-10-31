import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConfigurationExplanation, ConfigurationField } from '@dutydeck/shared';
import { configurationApi } from '../api';
import { Button } from './primitives';

const sourceLabels: Record<string, string> = { bot_default: '继承机器人默认', group_override: '群显式覆盖', group_clear: '群显式清空', unconfigured: '未配置', bot_ceiling: '机器人能力上限' };
const valueOf = (field: ConfigurationField) => field.status === 'unknown' ? '未记录（unknown）' : field.status === 'unverified' ? '未核验（unverified）' : field.status === 'unset' ? '未设置' : typeof field.value === 'boolean' ? field.value ? '是' : '否' : String(field.value);
export function ConfigurationSources({ explanation }: { explanation: ConfigurationExplanation }) {
  return <div className="space-y-4">{explanation.sections.map((section, index) => <section key={index} aria-label={section.title}>
    <h3 className="text-body font-semibold">{section.title}</h3><p className="my-1 text-caption text-secondary">{section.note}</p>
    <dl className="space-y-1">{section.fields.map(item => <div key={item.key} className="rounded bg-surface px-3 py-2">
      <dt className="text-caption text-subtle">{item.label}</dt><dd className="break-words text-body">{valueOf(item)}</dd>
      <details className="text-caption text-secondary"><summary className="cursor-pointer">来源：{sourceLabels[item.source] ?? item.source}{item.revision !== undefined ? ` · revision ${item.revision}` : ''}</summary>{item.reason && <p className="break-words">{item.reason}</p>}</details>
    </div>)}</dl>
  </section>)}</div>;
}
export function ConfigurationExplanationPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [attemptId, setAttemptId] = useState('');
  const query = useQuery({ queryKey: ['configuration', sessionId, taskId, attemptId], queryFn: () => configurationApi.explain(sessionId, taskId || undefined, attemptId || undefined), enabled: open });
  const task = query.data?.tasks.find(item => item.id === taskId);
  return <aside className="my-2 max-h-[60vh] overflow-auto rounded-lg bg-muted px-4 py-2" aria-label="配置来源">
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>配置来源</Button>
    {open && <div className="mt-2 space-y-3">
      <p className="text-caption text-secondary">只读查看已保存默认、当前会话和指定任务的历史证据。</p>
      <label className="block text-caption">历史任务<select aria-label="历史任务" value={taskId} onChange={event => { setTaskId(event.target.value); setAttemptId(''); }} className="ml-2 rounded border border-default bg-surface p-1"><option value="">仅查看当前配置</option>{query.data?.tasks.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
      {taskId && <label className="block text-caption">执行尝试<select aria-label="执行尝试" value={attemptId} onChange={event => setAttemptId(event.target.value)} className="ml-2 rounded border border-default bg-surface p-1"><option value="">当前 attempt</option>{task?.attempts.map(item => <option key={item.id} value={item.id}>第 {item.number} 次 · {item.state}</option>)}</select></label>}
      <Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>刷新配置来源</Button>
      {query.isLoading && <p role="status">正在读取配置来源…</p>}
      {query.isError && <p role="alert">配置来源读取失败：{query.error.message}</p>}
      {query.data && <ConfigurationSources explanation={query.data}/>}
    </div>}
  </aside>;
}
