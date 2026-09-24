import { useState } from 'react';
import { type Query, useQueries } from '@tanstack/react-query';
import { api, ApiError, type RunSummary, type Session } from '../api';
import { sessionDisplayName } from '../run-summary';
import { Banner, Button, Card, EmptyState, Spinner } from './primitives';
import { ScheduleFoundationPanel } from './ScheduleFoundationPanel';
import { scheduleNextExecution, SessionAutomationPanel } from './SessionAutomationPanel';

const pageSize = 8;

// Mounted only while the automation entry is open. Each page uses the existing
// session authorization boundary and shares cache/invalidation with task details.
export function AutomationOverview({ sessions, summaries = {}, onSelectSession }: { sessions: Session[]; summaries?: Record<string, RunSummary>; onSelectSession(sessionId: string): void }) {
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ sessionId: string; scheduleId?: string }>();
  const [draftsOpen, setDraftsOpen] = useState(false);
  const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageSessions = sessions.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const queries = useQueries({ queries: pageSessions.map(session => ({
    queryKey: ['automation', session.id],
    queryFn: () => api.automation(session.id),
    retry: false,
    enabled: !selected,
    refetchInterval: (query: Query) => query.state.error ? false : 10_000,
    refetchIntervalInBackground: false
  })) });
  const selectedSession = sessions.find(session => session.id === selected?.sessionId);

  return <div className="space-y-5">
    {selectedSession ? <section className="space-y-3">
      <div className="flex flex-wrap gap-2"><Button onClick={() => setSelected(undefined)}>返回任务计划</Button><Button onClick={() => onSelectSession(selectedSession.id)}>打开所属任务</Button></div>
      <SessionAutomationPanel key={selectedSession.id} session={selectedSession} initialScheduleId={selected?.scheduleId} openCreateForm={!selected?.scheduleId} taskTitle={sessionDisplayName(selectedSession, summaries[selectedSession.id]?.prompt, `${selectedSession.agentId} · ${selectedSession.cwd}`)}/>
    </section> : <section className="space-y-3" aria-label="任务计划">
      <h2 className="text-title font-semibold">任务计划</h2>
      <p className="text-body text-secondary">启用后按时执行，沿用所属任务的目录和上下文。在这里与任务详情中编辑的是同一份计划。</p>
      {!sessions.length && <EmptyState title="暂无任务" description="创建任务后，可为任务设置自动执行计划。"/>}
      {pageSessions.map((session, index) => {
        const query = queries[index]!;
        if (query.isPending) return <Spinner key={session.id} label="读取任务计划"/>;
        if (query.error instanceof ApiError && [401, 403, 404].includes(query.error.status)) return null;
        return <Card key={session.id} as="article" padding="md" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-body font-semibold">{sessionDisplayName(session, summaries[session.id]?.prompt, `${session.agentId} · ${session.cwd}`)}</h3><Button onClick={() => onSelectSession(session.id)}>打开任务</Button></div>
          <p className="break-all text-caption text-secondary">{session.agentId} · 目录：{session.cwd}</p>
          {query.isError ? <Banner tone="danger" action={{ label: '重试', onClick: () => void query.refetch() }}>计划读取失败，无法确认当前状态。</Banner> : query.data && <>
            {query.data.schedules.map(item => <div key={item.id} className="space-y-1 rounded-md bg-muted p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-body">{item.name} · {item.enabled ? '已启用' : '已停用'}</strong><Button onClick={() => setSelected({ sessionId: session.id, scheduleId: item.id })}>查看 / 编辑计划</Button></div>
              <p className="text-caption text-secondary">{scheduleNextExecution(item)}</p>
              <p className="text-caption text-secondary">{item.timezone} · 沿用任务上下文</p>
            </div>)}
            {!query.data.schedules.length && <p className="text-caption text-secondary">此任务暂无定时计划。</p>}
            <Button onClick={() => setSelected({ sessionId: session.id })}>{session.archivedAt || ['stopped', 'failed'].includes(session.state) ? '查看自动化记录' : '为此任务创建计划'}</Button>
          </>}
        </Card>;
      })}
      {pageCount > 1 && <div className="flex flex-wrap items-center gap-3"><Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span className="text-caption text-secondary">任务页 {currentPage + 1} / {pageCount} · 每页最多 {pageSize} 个任务</span><Button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
    </section>}
    <Card as="section" tone="muted" padding="md" className="space-y-2">
      <h2 className="text-body font-semibold">导入与管理草稿</h2>
      <p className="text-caption text-secondary">仅保存草稿。可维护导入定义和预览触发时间，草稿不会自动执行。</p>
      <Button onClick={() => setDraftsOpen(true)}>管理草稿</Button>
    </Card>
    <ScheduleFoundationPanel open={draftsOpen} onClose={() => setDraftsOpen(false)}/>
  </div>;
}
