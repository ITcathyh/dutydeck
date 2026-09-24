import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateSessionScheduleInput, PublicSessionSchedule as SessionSchedule } from '@dutydeck/shared';
import { api, type Session } from '../api';
import { sessionDisplayName } from '../run-summary';
import { Banner, Button, Field, Input, Select, Spinner, Textarea } from './primitives';

const ciLabels: Record<string, string> = { waiting: '等待构建', dispatching: '提交续作中', accepted: '已提交续作', completed: '续作已结束', cancelled: '已取消', expired: '已过期', stale_head: '提交已变化，等待停止', session_inactive: '会话已结束', revoked: '权限已撤销', error: '查询失败' };
const conditionLabels: Record<string, string> = { pending: '待检查', passed: '条件满足', skipped: '条件不满足，已跳过', error: '条件检查失败', invalidated: '已失效' };

export function scheduleNextExecution(item: SessionSchedule): string {
  if (!item.enabled) return '未启用，暂无下一次执行';
  if (!item.nextDueAt) return '无下一次执行';
  return `下一次执行：${new Date(item.nextDueAt).toLocaleString('zh-CN', { timeZone: item.timezone, hour12: false })} · ${item.timezone}`;
}

export function SessionAutomationPanel({ session, initialScheduleId, openCreateForm = false, taskTitle }: { session: Session; initialScheduleId?: string; openCreateForm?: boolean; taskTitle?: string }) {
  const qc = useQueryClient();
  const queryKey = ['automation', session.id];
  const records = useQuery({ queryKey, queryFn: () => api.automation(session.id), retry: false, refetchInterval: query => query.state.error ? false : 10_000 });
  const [workflow, setWorkflow] = useState('');
  const [ciPrompt, setCiPrompt] = useState('');
  const [ttlHours, setTtlHours] = useState(24);
  const [editing, setEditing] = useState<SessionSchedule>();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'interval' | 'cron' | 'at' | 'daily' | 'weekly'>('at');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState('1');
  const openedSchedule = useRef<string | undefined>(undefined);
  const [minutes, setMinutes] = useState(60);
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [at, setAt] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [condition, setCondition] = useState<'always' | 'github_new_failure'>('always');
  const [conditionWorkflow, setConditionWorkflow] = useState('');
  const [notice, setNotice] = useState('');
  const data = records.isError ? undefined : records.data;
  const readOnly = !data || Boolean(session.archivedAt) || ['stopped', 'failed'].includes(session.state);
  const refresh = () => qc.invalidateQueries({ queryKey });
  const subscribe = useMutation({ mutationFn: () => api.subscribeCi(session.id, { ...(workflow.trim() ? { workflow: workflow.trim() } : {}), ...(ciPrompt.trim() ? { prompt: ciPrompt.trim() } : {}), ttlSeconds: ttlHours * 3600 }), onSuccess: () => { setNotice('已开始等待当前提交的 GitHub Actions；续作开始前可取消等待。'); refresh(); } });
  const cancel = useMutation({ mutationFn: (input: { id: string; revision: number }) => api.cancelCi(session.id, input.id, input.revision), onSettled: refresh });
  const toggle = useMutation({ mutationFn: (item: SessionSchedule) => api.updateSchedule(session.id, item.id, { expectedRevision: item.revision, enabled: !item.enabled }), onSuccess: async (_result, item) => { await refresh(); setNotice(item.enabled ? '计划已停用。' : '计划已启用。'); }, onError: refresh });
  const save = useMutation({ mutationFn: () => {
    const [hour, minute] = time.split(':').map(Number);
    const trigger: CreateSessionScheduleInput['trigger'] = kind === 'daily' || kind === 'weekly'
      ? { kind: 'cron', expression: `${minute} ${hour} * * ${kind === 'daily' ? '*' : weekday}` }
      : kind === 'interval'
        ? editing?.trigger.kind === 'interval' && editing.trigger.everySeconds === minutes * 60 ? editing.trigger : { kind, everySeconds: minutes * 60, anchorAt: new Date().toISOString() }
        : kind === 'cron' ? { kind, expression: cron } : { kind, localDateTime: at };
    const input: CreateSessionScheduleInput = {
      name: name.trim(), prompt: prompt.trim(), timezone,
      trigger,
      dstPolicy: editing?.dstPolicy ?? { gap: 'skip', overlap: 'first' },
      condition: condition === 'always' ? { kind: 'always' } : { kind: 'github_new_failure', ...(conditionWorkflow.trim() ? { workflow: conditionWorkflow.trim() } : {}) }
    };
    return editing ? api.updateSchedule(session.id, editing.id, { ...input, expectedRevision: editing.revision }) : api.createSchedule(session.id, input);
  }, onSuccess: async () => { await refresh(); setNotice(editing ? '计划已更新。' : '计划已保存，点击「启用」后才会运行。'); setEditing(undefined); setName(''); setPrompt(''); }, onError: refresh });
  const edit = (item: SessionSchedule) => {
    setEditing(item); setName(item.name); setPrompt(item.prompt); setTimezone(item.timezone); setKind(item.trigger.kind); setCondition(item.condition.kind);
    if (item.trigger.kind === 'interval') setMinutes(item.trigger.everySeconds / 60);
    if (item.trigger.kind === 'cron') setCron(item.trigger.expression);
    if (item.trigger.kind === 'at') setAt(item.trigger.localDateTime);
    setConditionWorkflow(item.condition.kind === 'github_new_failure' ? item.condition.workflow ?? '' : '');
  };
  useEffect(() => {
    if (!initialScheduleId || openedSchedule.current === initialScheduleId) return;
    const item = data?.schedules.find(item => item.id === initialScheduleId);
    if (item) { edit(item); openedSchedule.current = initialScheduleId; }
  }, [initialScheduleId, data]);
  const error = records.error ?? subscribe.error ?? cancel.error ?? toggle.error ?? save.error;

  return <section className="space-y-3">
    <h3 className="text-body font-semibold">自动续作</h3>
    <p className="text-caption text-secondary">自动任务排入本任务，沿用当前目录和上下文。GitHub 仓库与提交从此目录读取；每分钟检查一次。</p>
    <p className="break-all text-caption text-secondary">所属任务：{sessionDisplayName(session, taskTitle, `${session.agentId} · ${session.cwd}`)} · 目录：{session.cwd}</p>
    {records.isLoading && <Spinner label="读取自动任务"/>}
    {error && <Banner tone="danger">{error.message}{records.isError && <Button onClick={() => void records.refetch()}>重新读取</Button>}</Banner>}
    {notice && <p role="status" className="text-caption text-secondary">{notice}</p>}
    {!readOnly && <details className="rounded-lg border border-default p-3">
      <summary className="cursor-pointer text-caption font-semibold">等待 GitHub Actions 完成</summary>
      <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); subscribe.mutate(); }}>
        <Field label="工作流（可选）"><Input value={workflow} onChange={event => setWorkflow(event.target.value)} placeholder="工作流文件名或 ID；留空等待本提交的构建"/></Field>
        <Field label="构建结束后执行的指令（可选）"><Textarea rows={2} value={ciPrompt} onChange={event => setCiPrompt(event.target.value)} placeholder="留空则检查 CI 结果并报告下一步"/></Field>
        <Field label="最长等待小时数"><Input type="number" min={1} max={168} value={ttlHours} onChange={event => setTtlHours(Number(event.target.value))}/></Field>
        <Button type="submit" variant="primary" loading={subscribe.isPending}>开始等待</Button>
      </form>
    </details>}
    {data?.subscriptions.map(item => <div key={item.id} className="rounded-lg border border-default p-3 text-caption">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong>{ciLabels[item.status] ?? item.status}</strong>{['waiting', 'dispatching', 'accepted', 'error'].includes(item.status) && !readOnly && <Button onClick={() => cancel.mutate({ id: item.id, revision: item.revision })} disabled={cancel.isPending}>取消等待</Button>}</div>
      <p className="mt-1 text-secondary">{item.repository.slug} · {item.headSha.slice(0, 12)}{item.workflow ? ` · ${item.workflow}` : ''}</p>
      <p className="text-subtle">截止 {new Date(item.expiresAt).toLocaleString()}</p>
      {item.error && <p className="text-danger">{item.error}</p>}
      {item.delivery.status === 'error' && <p className="text-warning">结果通知失败，正在重试通知：{item.delivery.error}</p>}
    </div>)}
    {!readOnly && <details open={editing || openCreateForm ? true : undefined} className="rounded-lg border border-default p-3">
      <summary className="cursor-pointer text-caption font-semibold">{editing ? '编辑计划' : '为此任务创建计划'}</summary>
      <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
        <Field label="计划名称"><Input required value={name} maxLength={200} onChange={event => setName(event.target.value)}/></Field>
        <Field label="执行指令"><Textarea required rows={2} value={prompt} maxLength={20000} onChange={event => setPrompt(event.target.value)}/></Field>
        <Field label="触发方式"><Select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="at">一次</option><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">固定间隔</option><option value="cron">高级 Cron</option></Select></Field>
        {(kind === 'daily' || kind === 'weekly') && <Field label="执行时间" hint="按下方时区的当地时间执行"><Input type="time" required value={time} onChange={event => setTime(event.target.value)}/></Field>}
        {kind === 'weekly' && <Field label="星期"><Select value={weekday} onChange={event => setWeekday(event.target.value)}>{['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'].map((label, index) => <option key={index} value={index}>{label}</option>)}</Select></Field>}
        {kind === 'daily' || kind === 'weekly' ? null : kind === 'interval' ? <Field label="间隔分钟数"><Input type="number" min={1} required value={minutes} onChange={event => setMinutes(Number(event.target.value))}/></Field> : kind === 'cron' ? <Field label="Cron 表达式"><Input required value={cron} onChange={event => setCron(event.target.value)}/></Field> : <Field label="指定时区的本地时间"><Input type="datetime-local" required value={at} onChange={event => setAt(event.target.value)}/></Field>}
        <Field label="时区"><Input required value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Asia/Shanghai"/></Field>
        <p className="text-caption text-subtle">夏令时不存在的时间{editing?.dstPolicy.gap === 'shift_forward' ? '顺延' : '跳过'}；重复时间执行{editing?.dstPolicy.overlap === 'second' ? '第二次' : '第一次'}。服务离线后最多补一次，同一计划不重叠执行。</p>
        <Field label="执行条件"><Select value={condition} onChange={event => setCondition(event.target.value as typeof condition)}><option value="always">每次到期执行</option><option value="github_new_failure">GitHub 出现新的失败构建时执行</option></Select></Field>
        {condition === 'github_new_failure' && <Field label="检查的工作流（可选）"><Input value={conditionWorkflow} onChange={event => setConditionWorkflow(event.target.value)}/></Field>}
        <div className="flex gap-2"><Button type="submit" variant="primary" loading={save.isPending}>保存计划</Button>{editing && <Button onClick={() => setEditing(undefined)}>取消编辑</Button>}</div>
      </form>
    </details>}
    {data?.schedules.map(item => <div key={item.id} className="rounded-lg border border-default p-3 text-caption">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong>{item.name} · {item.enabled ? '已启用' : '已停用'}</strong>{!readOnly && <div className="flex gap-2"><Button onClick={() => edit(item)}>编辑</Button><Button disabled={toggle.isPending} onClick={() => toggle.mutate(item)}>{item.enabled ? '停用' : '启用'}</Button></div>}</div>
      <p className="mt-1 text-secondary">{item.prompt}</p>
      <p className="text-secondary">{scheduleNextExecution(item)}</p>
      <p className="text-subtle">{item.timezone} · 沿用任务上下文 · {session.cwd}</p>
    </div>)}
    {!!data?.occurrences.length && <details><summary className="cursor-pointer text-caption">最近触发记录</summary><div className="mt-2 space-y-2">{data.occurrences.slice(0, 20).map(item => <p key={item.id} className="text-caption">{new Date(item.scheduledForUtc).toLocaleString()} · {conditionLabels[item.conditionStatus] ?? item.conditionStatus}{item.taskId ? ' · 任务已接收' : ''}{item.error ? ` · ${item.error}` : ''}{item.delivery.status === 'error' ? ' · 通知失败，等待重试' : ''}</p>)}</div></details>}
  </section>;
}
