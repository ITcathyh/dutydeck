import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2Off } from 'lucide-react';
import { api, ApiError } from '../api';
import { buildTimeline, buildTimelineSections } from '../timeline';
import { createEventWindow, loadEventHistory, type EventWindow } from '../event-history';
import { sessionDisplayName } from '../run-summary';
import { sessionErrorSummary } from '../workspace-model';
import { useSessionStream } from '../useSessionStream';
import { useTheme } from '../useTheme';
import { busyStates, DutydeckIcon, effectiveStatus, stateTone } from './ui';
import { Badge, Banner, Card, EmptyState, Spinner } from './primitives';
import { TimelineView } from './TimelineView';

/**
 * 飞书卡片「查看详情」打开的只读分享页：只有这一个任务的状态、执行记录和结果。
 *
 * 数据走和工作台同一套接口与缓存键（['sessions'] 里只放这一个会话），实时流因此能原样复用
 * useSessionStream；请求都带着分享 token（api.ts 的 withShareToken），服务端只放行这个会话的读接口。
 * 页面上没有侧栏、任务列表、设置，也没有链回工作台的入口；不给任何写操作——授权卡只显示状态。
 */
export function SharedSessionPage({ sessionId }: { sessionId: string }) {
  useTheme();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: async () => [await api.session(sessionId)], retry: false, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const session = sessions.data?.[0];
  const events = useQuery({ queryKey: ['events', sessionId], queryFn: async ({ signal }) => { const history = await loadEventHistory(sessionId, signal); const cached = qc.getQueryData<EventWindow>(['events', sessionId]); return createEventWindow([...history.events, ...(cached?.events ?? [])]); }, enabled: Boolean(session), staleTime: Infinity });
  const tasks = useQuery({ queryKey: ['tasks', sessionId], queryFn: () => api.tasks(sessionId), enabled: Boolean(session) });
  const streamStatus = useSessionStream(session ? sessionId : undefined, session?.runId, events.isSuccess);
  const eventList = events.data?.events ?? [];
  const timeline = useMemo(() => buildTimeline(eventList, tasks.data), [eventList, tasks.data]);
  const timelineSections = useMemo(() => buildTimelineSections(timeline, tasks.data), [timeline, tasks.data]);
  const latestUserIndex = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index--) if (timeline[index].type === 'text' && timeline[index].data.role === 'user') return index;
    return -1;
  }, [timeline]);
  const awaitingAnswer = busyStates.has(session?.state ?? '') && latestUserIndex >= 0 && !timeline.slice(latestUserIndex + 1).some(event => event.type === 'text' && event.data.role !== 'user');
  const hasOngoingActivity = timelineSections.some(section => section.kind === 'activity' && section.isLatestTurn && awaitingAnswer);

  if (sessions.isPending) return <main className="grid min-h-[100dvh] place-items-center bg-canvas"><Spinner size="sm" label="正在打开任务详情…"/></main>;
  if (!session) {
    // 401/404 都是同一句：不区分「链接被改过」「密钥已轮换」「任务不存在」，也不给工作台入口。
    const unavailable = sessions.error instanceof ApiError && [401, 403, 404].includes(sessions.error.status);
    return <main className="grid min-h-[100dvh] place-items-center bg-canvas p-5">
      <Card as="section" padding="lg" className="w-full max-w-md">
        <EmptyState icon={<Link2Off size={22}/>} title={unavailable ? '链接无效或已失效' : '暂时打不开这个任务'}
          description={unavailable ? '请回到飞书卡片重新点「查看详情」；如果仍然打不开，请联系机器人管理员。' : sessions.error?.message ?? '请稍后刷新重试。'}/>
      </Card>
    </main>;
  }

  const firstPrompt = [...(tasks.data ?? [])].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).find(task => task.prompt?.trim())?.prompt.trim();
  const title = sessionDisplayName(session, firstPrompt, '任务详情');
  const status = effectiveStatus(session);
  const queued = tasks.data?.filter(task => task.status === 'queued').length ?? 0;
  const errorSummary = sessionErrorSummary(session.error);
  const connection = streamStatus === 'open' ? '实时同步' : streamStatus === 'reconnecting' ? '正在重连' : '正在连接';
  return <div className="flex h-[100dvh] min-h-[100dvh] flex-col overflow-hidden bg-canvas font-sans text-primary">
    <header className="shrink-0 border-b border-default bg-surface">
      <div className="flex min-h-14 items-center gap-2.5 px-3 pt-1 sm:px-5">
        <DutydeckIcon className="h-6 w-6 shrink-0"/>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title font-semibold text-primary" title={title}>{title}</h1>
          <div className="mt-0.5 truncate text-caption text-subtle">{session.model ?? session.agentId} · 只读查看</div>
        </div>
      </div>
      <div className="flex min-h-10 items-center gap-2.5 px-3 pb-1.5 sm:px-5">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5">
          <span aria-label={status.label} className={`h-2 w-2 shrink-0 rounded-full ${status.busy ? 'ui-status-pulse' : ''} ${status.archived ? 'bg-neutral-solid' : stateTone[session.state] ?? 'bg-neutral-solid'}`}/>
          <strong className="text-caption font-semibold text-primary">{status.label}</strong>
        </span>
        {queued > 0 && <Badge tone="queued">待执行指令 {queued} 条</Badge>}
        <span className="ml-auto shrink-0 text-meta text-subtle">{connection}</span>
      </div>
      {errorSummary && <div className="px-3 pb-3 sm:px-5"><Banner tone="danger" title="失败详情">{errorSummary}</Banner></div>}
    </header>
    {events.isError && <div className="shrink-0 px-4 py-2"><Banner tone="danger">执行记录加载失败：{events.error.message}</Banner></div>}
    <TimelineView activeSessionId={sessionId} eventsLoading={events.isLoading} timeline={timeline} timelineSections={timelineSections}
      awaitingAnswer={awaitingAnswer} hasOngoingActivity={hasOngoingActivity} latestUserIndex={latestUserIndex} activeOutputLabel={session.model ?? session.agentId}
      renderProgress={emptyState => emptyState ? <p className="py-10 text-center text-caption text-subtle">这个任务还没有执行记录。</p> : null}/>
  </div>;
}
