import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { currentInstance } from '../instance';
import { api, ApiError } from '../api';
import { sessionPath } from '../app-route';
import { MarkdownContent, copyToClipboard } from '../MarkdownContent';
import { PlanHistory } from './AutomationHistory';
import { automationTime, runLabels } from './automation-display';
import { UnknownTasksPanel } from './UnknownTasksPanel';
import { Banner, Button, Spinner } from './primitives';

const attemptLabels: Record<string, string> = { preparing: '准备执行', active: '正在执行', suspended: '等待恢复', reconcile_required: '结果未知，等待核对', legacy_unresolved: '旧版证据不足，等待核对', settled: '已结算', completed: '已完成', failed: '执行失败', interrupted: '已中断', cancelled: '已取消', unknown: '结果未知' };
const blockLabels: Record<string, string> = { reconcile_required: '原始执行缺少最终回执', legacy_output_unresolved: '旧版输出无法验证归属', legacy_input_unresolved: '旧版执行输入无法核实', admission_conflict: '执行身份与保存的输入不一致' };
const deliveryLabels: Record<string, string> = { not_requested: '无需对外投递', pending: '等待投递', sending: '正在投递', delivered: '已确认投递', error: '投递失败，等待安全重试', unknown: '投递结果未知，需核对', suppressed: '未投递' };

export function AutomationRunDetail({ sessionId, scheduleId, occurrenceId }: { sessionId: string; scheduleId: string; occurrenceId: string }) {
  const detail = useQuery({ queryKey: ['automation-run', currentInstance() ?? null, sessionId, scheduleId, occurrenceId], queryFn: () => api.automationRun(sessionId, scheduleId, occurrenceId), retry: false, refetchInterval: query => query.state.error ? false : 10_000 });
  const executionId = detail.data?.executionSessionId;
  const needsRecovery = detail.data?.occurrence.runStatus === 'blocked';
  const session = useQuery({ queryKey: ['session', currentInstance() ?? null, executionId], queryFn: () => api.session(executionId!), enabled: Boolean(executionId) && needsRecovery, retry: false });
  const tasks = useQuery({ queryKey: ['tasks', currentInstance() ?? null, executionId], queryFn: () => api.tasks(executionId!), enabled: Boolean(executionId) && needsRecovery, retry: false });
  const [copied, setCopied] = useState('');
  if (detail.isPending) return <Spinner label="读取本次运行"/>;
  if (detail.isError) return <Banner tone="danger" action={{ label: '重新读取', onClick: () => void detail.refetch() }}>{detail.error instanceof ApiError && detail.error.status === 404 ? '这次运行不存在或已无法定位，未跳转到最新聊天。' : `本次运行读取失败：${detail.error.message}`}</Banner>;
  const { schedule, occurrence, input, attempts, times } = detail.data;
  const timezone = schedule.timezone;
  const result = occurrence.result;
  const latestAttempt = attempts.slice().sort((a, b) => b.number - a.number)[0];
  const executionLabel = occurrence.runStatus === 'accepted'
    ? latestAttempt ? latestAttempt.state === 'settled' ? '执行尝试已结束，等待计划结算' : attemptLabels[latestAttempt.state] ?? '执行状态待核实' : '已接收，尚无开始执行记录'
    : runLabels[occurrence.runStatus] ?? occurrence.runStatus;
  return <section className="min-w-0 space-y-4" aria-label="单次运行详情">
    <h2 className="text-title font-semibold">{schedule.name} · 单次运行</h2>
    <p className="break-all text-caption text-subtle">运行 {occurrence.id} · 配置版本 {occurrence.generation} · 当前计划版本 {schedule.generation}</p>
    <p>{executionLabel} · 条件：{({ pending: '待检查', passed: '已满足', skipped: '不满足，已跳过', error: '检查失败', invalidated: '已失效' })[occurrence.conditionStatus]} · {deliveryLabels[occurrence.delivery.status] ?? occurrence.delivery.status}</p>
    {occurrence.blockReason && <Banner tone="warning">本轮等待核对或恢复：{blockLabels[occurrence.blockReason] ?? occurrence.blockReason}。结果未知不能视为未执行，也不会自动重发。</Banner>}
    {occurrence.misfire && <p className="text-caption text-secondary">错过时点的持久处理决定：{({ lateness_window_expired: '超过补跑有效期，跳过不执行', missed_time_skipped: '错过时点，跳过不执行', missed_times_coalesced: '错过的多个时点合并补一次' } as Record<string, string>)[occurrence.misfire.reason] ?? (occurrence.misfire.policy === 'skip' ? '跳过，不补执行' : '合并补一次')} · 覆盖 {automationTime(occurrence.misfire.from, timezone)} 至 {automationTime(occurrence.misfire.to, timezone)}</p>}
    {occurrence.error && <p className="text-danger">{occurrence.error}</p>}
    <dl className="grid gap-2 text-caption sm:grid-cols-2">
      {([['原定时点', times.scheduledForUtc], ['发现到期', times.discoveredAt], ['进入队列', times.acceptedAt], ['开始执行', times.startedAt], ['账本结算', times.settledAt], ['投递状态更新时间', times.deliveryUpdatedAt]] as const).map(([label, time]) => <div key={label}><dt className="text-subtle">{label}</dt><dd>{automationTime(time, timezone)}</dd></div>)}
    </dl>
    <details><summary className="cursor-pointer">本轮冻结的执行输入</summary>
      {input ? <div className="space-y-2 py-2 text-caption"><p className="whitespace-pre-wrap break-words">{input.prompt}</p><p className="break-all">执行身份：{input.agentId ?? '未记录'} · 模型 {input.model ?? '未记录'} · 权限 {input.permissionMode ?? '未记录'} · 目录 {input.cwd ?? '未记录'}</p></div> : <p className="text-caption text-secondary">历史记录未保留可验证的冻结输入，不能用当前计划内容代替。</p>}
    </details>
    <section className="min-w-0 space-y-2"><h3 className="font-semibold">最终结果</h3>{result && <p className="break-all text-caption text-secondary">已验证结果来源：尝试 {result.attemptId} · 结算 {result.settlementId}{result.attemptId !== occurrence.runtimeAttemptId ? `。原始尝试 ${occurrence.runtimeAttemptId ?? '未记录'} 的事实独立保留，后继结果不证明原始尝试未执行。` : ''}</p>}
      {result?.output.text ? <><Button onClick={async () => setCopied(await copyToClipboard(result.output.text) ? '原文已复制' : '复制失败，请重试')}>复制结果原文</Button>{copied && <p role="status">{copied}</p>}<div className="markdown min-w-0"><MarkdownContent>{result.output.text}</MarkdownContent></div></> : <p className="text-caption text-secondary">{occurrence.resultBoundary === 'legacy_output_unresolved' ? '旧记录无法验证结果归属；请查看原任务证据。' : '本次运行尚无可验证的最终输出。未使用最新聊天代替。'}</p>}
      {occurrence.delivery.error && <p className="text-warning">投递说明：{occurrence.delivery.error}</p>}
    </section>
    <details><summary className="cursor-pointer">执行尝试与恢复关系（{attempts.length}）</summary>
      {attempts.length ? attempts.map(attempt => <div key={attempt.attemptId} className="my-2 break-all text-caption">
        <p>尝试 {attempt.number} · {attempt.attemptId}{attempt.attemptId === occurrence.runtimeAttemptId ? ' · 原始尝试' : ' · 后继尝试'} · {attemptLabels[attempt.outcome ?? attempt.state] ?? attempt.state}</p>
        <p>创建 {automationTime(attempt.createdAt, timezone)} · 更新 {automationTime(attempt.updatedAt, timezone)}</p>
        {attempt.decision && <p>人工处置：{attempt.decision.action === 'retry' ? '明确要求重试' : attempt.decision.action === 'confirm_result' ? '人工确认结果' : '人工取消'} · 决策 {attempt.decision.decisionId} · 操作者 {attempt.decision.actor.kind === 'installation_owner' ? '工作台所有者' : attempt.decision.actor.kind === 'channel' ? attempt.decision.actor.id : '身份未记录'} · 证据 {attempt.decision.evidenceRefs.join('、')}</p>}
        {attempt.manualRetry && <p>人工明确重试的后继 · 来源尝试 {attempt.manualRetry.causeAttemptId} · 决策 {attempt.manualRetry.decisionId}。原始未知结果不因此改写为未执行。</p>}
        {attempt.automaticRetry && <p>容量恢复后继，来源 {attempt.automaticRetry.causeAttemptId}</p>}
      </div>) : <p className="text-caption text-secondary">尚未创建执行尝试，或历史证据未保存。</p>}
    </details>
    {(session.isError || tasks.isError) && occurrence.runStatus === 'blocked' && <p className="text-caption text-warning">核对所需任务信息读取失败，请重新读取或打开执行任务核实。未自动执行任何恢复操作。</p>}
    {needsRecovery && occurrence.taskId && session.data && <UnknownTasksPanel session={session.data} tasks={tasks.data ?? []} taskId={occurrence.taskId}/>}
    <a href={sessionPath(executionId)} className="text-link underline">打开执行任务查看过程证据</a>
    <PlanHistory sessionId={sessionId} scheduleId={scheduleId} timezone={timezone} label="此计划的其他运行"/>
  </section>;
}
