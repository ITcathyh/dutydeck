import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { currentInstance } from '../instance';
import { api } from '../api';
import { automationRunPath } from '../app-route';
import { Button, Spinner, Banner } from './primitives';
import { runLabels, automationTime } from './automation-display';
export { automationTime } from './automation-display';



export function AutomationHistory({ sessionId, scheduleId, timezone }: { sessionId: string; scheduleId: string; timezone: string }) {
  const [offset, setOffset] = useState(0);
  const history = useQuery({ queryKey: ['automation-history', currentInstance() ?? null, sessionId, scheduleId, offset], queryFn: () => api.automationHistory(sessionId, scheduleId, offset), retry: false });
  return <div className="mt-3 space-y-2">
    {history.isPending && <Spinner label="读取此计划的历史"/>}
    {history.isError && <Banner tone="danger" action={{ label: '重试', onClick: () => void history.refetch() }}>此计划历史读取失败，不能确认是否有记录：{history.error.message}</Banner>}
    {history.data && !history.isError && <>
      {!history.data.total && <p className="text-caption text-secondary">此计划尚无触发记录。</p>}
      {history.data.occurrences.map(item => <div key={item.id} className="border-t border-default py-2 text-caption">
        <a className="text-link underline" href={automationRunPath(sessionId, scheduleId, item.id)}>查看本次运行 · {automationTime(item.scheduledForUtc, timezone)}</a>
        <p>{runLabels[item.runStatus] ?? item.runStatus} · {item.delivery.status === 'delivered' ? '已确认投递' : '投递状态见详情'}</p>
        {item.error && <p className="text-danger">{item.error}</p>}
      </div>)}
      {history.data.total > 20 && <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>较新记录</Button>
        <span className="text-caption">第 {offset + 1}–{Math.min(offset + 20, history.data.total)} 条 / {history.data.total} 条</span>
        <Button disabled={offset + 20 >= history.data.total} onClick={() => setOffset(offset + 20)}>较早记录</Button>
      </div>}
    </>}
  </div>;
}

export function PlanHistory({ sessionId, scheduleId, timezone, label = '此计划的运行历史' }: { sessionId: string; scheduleId: string; timezone: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer">{label}</summary>{open && <AutomationHistory sessionId={sessionId} scheduleId={scheduleId} timezone={timezone}/>}</details>;
}
