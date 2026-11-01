import { useQuery } from '@tanstack/react-query';
import { api, type Task, type TaskAuthorization } from '../api';

export function authorizationLabel(record: TaskAuthorization): string {
  if (record.via === 'participation_confirmed') return `确认人 ${record.actorOpenId ?? '未记录'}${record.decisionId ? `（判断记录 ${record.decisionId}）` : ''}`;
  if (record.strength === 'inferred') return `推断${record.via === 'scenario_direct' ? '（管理员配置的场景规则）' : record.via === 'group_rule' ? '（群唤醒规则）' : ''}${record.decisionId ? `（判断记录 ${record.decisionId}）` : ''}`;
  const labels: Partial<Record<TaskAuthorization['via'], string>> = {
    mention: '被 @', direct: '私聊', topic_followup: '话题续接', answer_reply: '回复提问', addressed: '规则识别的呼叫', command: '显式命令', task_channel: '飞书任务指派', schedule: '已授权的定时计划', automation: '已授权的自动跟进'
  };
  return labels[record.via] ?? '明确授权';
}

export function TaskAuthorizationPanel({ sessionId, tasks }: { sessionId: string; tasks: Task[] }) {
  const records = useQuery({ queryKey: ['taskAuthorizations', sessionId, tasks.map(task => task.id).join(',')], queryFn: () => api.taskAuthorizations(sessionId), refetchInterval: 5_000 });
  if (records.isError) return <p className="text-caption text-secondary">依据：暂时无法读取。</p>;
  if (!records.data?.length) return null;
  const latestTask = tasks.at(-1);
  const current = records.data.find(record => record.taskId === latestTask?.id);
  const earlier = records.data.filter(record => record.taskId !== latestTask?.id).reverse();
  const line = (record: TaskAuthorization) => <p key={record.taskId} className="break-all text-caption text-secondary" title={record.policyVersion ? `规则版本：${record.policyVersion}` : undefined}>依据：{authorizationLabel(record)}</p>;
  return <div aria-label="任务授权依据">
    {current ? line(current) : latestTask ? <p className="text-caption text-secondary">依据：本轮未记录。</p> : null}
    {earlier.length > 0 && <details className="mt-1"><summary className="cursor-pointer text-caption text-subtle">此前各轮依据</summary>
      {earlier.map(record => <div key={record.taskId} className="mt-2"><p className="truncate text-caption text-subtle">{tasks.find(task => task.id === record.taskId)?.prompt.slice(0, 80) ?? record.taskId}</p>{line(record)}</div>)}
    </details>}
  </div>;
}
