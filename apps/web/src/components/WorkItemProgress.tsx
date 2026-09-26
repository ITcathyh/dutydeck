import { useId, useState, type ReactNode } from 'react';
import type { WorkItem } from '@dutydeck/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Agent, Session } from '../api';
import { sessionPath } from '../app-route';
import { Badge, Banner, Button, Spinner } from './primitives';
import { useWorkItems, useWorkItemRequests, workStatusLabels } from './workItemQueries';

type Props = { emptyState?: ReactNode; session: Session; agents: Agent[]; onOpenItem(id: string): void; onSelectSession(id: string): void };

export function WorkItemProgress(props: Props) {
  return props.session.source === 'work_item' ? null : <SessionProgress key={props.session.id} {...props}/>;
}

function SessionProgress({ session, agents, onOpenItem, onSelectSession, emptyState }: Props) {
  const records = useWorkItems(session.id);
  if (records.isSuccess && !records.data.items.length) return emptyState ?? null;
  return <section aria-label="目标进度" className="mb-6 min-w-0 space-y-3">
    {records.isLoading && <Spinner label="读取目标进度"/>}
    {records.isError && <Banner tone="danger" action={{ label: '重试读取目标', busy: records.isFetching, onClick: () => void records.refetch() }}>目标读取失败：{records.error.message}。{records.data ? '下方为上次读取的数据。' : '暂时无法确认是否有目标。'}</Banner>}
    {records.data?.items.map(item => <GoalProgress key={item.id} item={item} session={session} agents={agents} onOpen={() => onOpenItem(item.id)} onSelectSession={onSelectSession}/>)}
  </section>;
}

function GoalProgress({ item, session, agents, onOpen, onSelectSession }: { item: WorkItem; session: Session; agents: Agent[]; onOpen(): void; onSelectSession(id: string): void }) {
  const defaultExpanded = !['completed', 'cancelled'].includes(item.status);
  const [disclosure, setDisclosure] = useState({ status: item.status, expanded: defaultExpanded });
  // Reset only on a status transition; refreshing the same status preserves a user's choice.
  if (disclosure.status !== item.status) setDisclosure({ status: item.status, expanded: defaultExpanded });
  const expanded = disclosure.status === item.status ? disclosure.expanded : defaultExpanded;
  const stepsId = useId();
  const requests = useWorkItemRequests(session.id, item);
  const hasRunning = item.steps.some(step => step.status === 'running');
  const completed = item.steps.filter(step => step.status === 'completed').length;
  const skipped = item.steps.filter(step => step.status === 'skipped').length;
  const attention = item.steps.filter(step => ['running', 'waiting', 'failed', 'blocked'].includes(step.status));
  const needsAction = ['waiting', 'failed', 'blocked'].includes(item.status) || item.steps.some(step => ['waiting', 'failed', 'blocked'].includes(step.status)) || (hasRunning && Boolean(requests.data?.length));
  const readOnly = Boolean(session.archivedAt) || ['stopped', 'failed'].includes(session.state);
  return <article aria-label={`目标：${item.title}`} className="min-w-0 border-b border-default py-3">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <button type="button" aria-expanded={expanded} aria-controls={stepsId} aria-label={`${expanded ? '收起' : '展开'}目标：${item.title}`} className="flex min-h-10 min-w-0 flex-1 basis-full items-center sm:basis-auto gap-2 rounded text-left text-body font-semibold hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" onClick={() => setDisclosure({ status: item.status, expanded: !expanded })}>
        {expanded ? <ChevronDown size={16} className="shrink-0"/> : <ChevronRight size={16} className="shrink-0"/>}<span className="min-w-0 break-words [overflow-wrap:anywhere]">{item.title}</span>
      </button>
      <Badge tone={item.status === 'completed' ? 'success' : item.status === 'failed' ? 'danger' : ['waiting', 'blocked'].includes(item.status) ? 'warning' : item.status === 'running' ? 'info' : 'neutral'}>{workStatusLabels[item.status]}</Badge>
      <span className="text-caption text-secondary">完成 {completed}/{item.plan.steps.length} 步{skipped ? ` · 跳过 ${skipped} 步` : ''}</span>
      <Button size="sm" className="min-h-10" variant="ghost" onClick={onOpen}>{needsAction && !readOnly ? '查看详情 / 处理' : '查看详情'}</Button>
      {item.output && <Button size="sm" className="min-h-10" variant="ghost" onClick={onOpen}>查看成果</Button>}
    </div>
    {!!attention.length && <p className="mt-2 break-words text-caption text-secondary [overflow-wrap:anywhere]">{attention.map(step => `${workStatusLabels[step.status]}：${item.plan.steps.find(definition => definition.id === step.id)?.title ?? step.id}`).join('；')}</p>}
    {attention.filter(step => step.status === 'failed' && step.attempts.at(-1)?.error).map(step => <p key={step.id} className="mt-2 whitespace-pre-wrap break-words text-caption text-danger [overflow-wrap:anywhere]">{item.plan.steps.find(definition => definition.id === step.id)?.title ?? step.id}：{step.attempts.at(-1)!.error}</p>)}
    {item.error && <p className="mt-2 whitespace-pre-wrap break-words text-caption text-danger [overflow-wrap:anywhere]">{item.error}</p>}
    {hasRunning && requests.isLoading && <p className="mt-2 text-caption text-subtle">正在检查授权与提问…</p>}
    {hasRunning && requests.isError && <div className="mt-2"><Banner tone="danger" action={{ label: '重试读取执行请求', busy: requests.isFetching, onClick: () => void requests.refetch() }}>执行请求读取失败：{requests.error.message}。{requests.data ? '下方请求为上次读取的数据。' : '待处理事项暂时无法确认。'}</Banner></div>}
    {hasRunning && requests.data?.map(request => <p key={`${request.stepId}:${request.kind}:${request.requestId}`} className="mt-2 break-words text-caption text-warning [overflow-wrap:anywhere]">{request.kind === 'permission' ? '需要操作授权' : '执行中提问'} · {item.plan.steps.find(step => step.id === request.stepId)?.title ?? request.stepId}：{request.text}</p>)}
    {item.delivery.status === 'error' && <p className="mt-2 break-words text-caption text-warning [overflow-wrap:anywhere]">成果通知送达失败{item.delivery.error ? `：${item.delivery.error}` : ''}</p>}
    {readOnly && <p className="mt-2 text-caption text-subtle">此会话已结束或归档，目标仅供查看。</p>}
    <div id={stepsId} hidden={!expanded}>
      <ol aria-label="进度步骤" className="mt-3 space-y-1 border-l border-default pl-3">
        {item.plan.steps.map(definition => {
          const step = item.steps.find(record => record.id === definition.id);
          const attempt = step?.attempts.at(-1);
          return <li key={definition.id} className="min-w-0">
            <details>
              <summary className="min-h-10 cursor-pointer rounded py-2 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
                <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 align-top">
                  <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{definition.title}</span>
                  <span className={step?.status === 'failed' ? 'text-danger' : ['waiting', 'blocked'].includes(step?.status ?? '') ? 'text-warning' : 'text-secondary'}>{workStatusLabels[step?.status ?? 'pending']}</span>
                  <span className="min-w-0 break-words text-subtle [overflow-wrap:anywhere]">{definition.kind === 'wait' ? '用户回答' : agents.find(agent => agent.id === definition.agentId)?.name ?? definition.agentId}</span>
                  {attempt && attempt.number > 1 && <span className="text-secondary">第 {attempt.number} 次尝试</span>}
                </span>
              </summary>
              <div className="space-y-2 pb-3 pl-4 text-caption">
                <p className="break-words text-subtle [overflow-wrap:anywhere]">依赖：{definition.dependsOn.length ? definition.dependsOn.map(id => item.plan.steps.find(value => value.id === id)?.title ?? id).join('、') : '无'}</p>
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{definition.instruction}</p>
                {step?.answer !== undefined && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">已保存回答：{step.answer}</p>}
                {step?.attempts.map(record => <div key={record.id} className="space-y-1">
                  <p className="text-secondary">第 {record.number} 次尝试 · {workStatusLabels[record.status]}</p>
                  {record.error && <p className="whitespace-pre-wrap break-words text-danger [overflow-wrap:anywhere]">{record.error}</p>}
                  {record.output && <p className="text-secondary">已有步骤产物，可在目标详情查看。</p>}
                  {record.sessionId && <a href={sessionPath(record.sessionId)} className="inline-block text-link hover:underline" onClick={event => { if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onSelectSession(record.sessionId!); } }}>查看第 {record.number} 次尝试的执行记录</a>}
                </div>)}
              </div>
            </details>
          </li>;
        })}
      </ol>
    </div>
  </article>;
}
