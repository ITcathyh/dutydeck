import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutomationDeliveryTarget, CreateSessionScheduleInput, PublicSessionSchedule as SessionSchedule } from '@dutydeck/shared';
import { api, ApiError, type Session } from '../api';
import { sessionPath } from '../app-route';
import { ConfirmDialog } from './ConfirmDialog';
import { sessionDisplayName } from '../run-summary';
import { Banner, Button, Field, Input, Select, Spinner, Textarea, Dialog } from './primitives';

const ciLabels: Record<string, string> = { waiting: '等待构建', dispatching: '提交续作中', accepted: '已提交续作', completed: '续作已结束', cancelled: '已取消', expired: '已过期', stale_head: '提交已变化，等待停止', session_inactive: '会话已结束', revoked: '权限已撤销', error: '查询失败' };
export const runLabels: Record<string, string> = { pending: '等待执行', accepted: '已接收', completed: '已完成', failed: '执行失败', interrupted: '已中断', skipped: '已跳过', error: '执行出错', invalidated: '已失效', blocked: '执行受阻' };
const conditionLabels: Record<string, string> = { pending: '待检查', passed: '条件满足', skipped: '条件不满足，已跳过', error: '条件检查失败', invalidated: '已失效' };

export function scheduleNextExecution(item: SessionSchedule): string {
  if (!item.enabled) return '未启用，暂无下一次执行';
  if (!item.nextDueAt) return '无下一次执行';
  return `下一次执行：${new Date(item.nextDueAt).toLocaleString('zh-CN', { timeZone: item.timezone, hour12: false })} · ${item.timezone}`;
}

export function scheduleRule(item: SessionSchedule): string {
  const trigger = item.trigger;
  if (trigger.kind === 'at') return `仅一次 · ${trigger.localDateTime.replace('T', ' ')} · ${item.timezone}`;
  if (trigger.kind === 'interval') return `每 ${trigger.everySeconds / 60} 分钟 · ${item.timezone}`;
  const [minute, hour, day, month, weekday] = trigger.expression.trim().split(/\s+/);
  if (/^\d+$/.test(minute ?? '') && /^\d+$/.test(hour ?? '') && day === '*' && month === '*') {
    const time = `${hour!.padStart(2, '0')}:${minute!.padStart(2, '0')}`;
    if (weekday === '*') return `每天 ${time} · ${item.timezone}`;
    if (weekday === '1-5') return `每个工作日 ${time} · ${item.timezone}`;
    if (/^[0-6]$/.test(weekday ?? '')) return `每周${'日一二三四五六'[Number(weekday)]} ${time} · ${item.timezone}`;
  }
  return `Cron ${trigger.expression} · ${item.timezone}`;
}

export function automationSource(session: Session): string {
  const context = session.sourceContext;
  if (context) return `飞书${context.chat.type === 'group' ? '群' : '私聊'}：${context.chat.name || context.chat.id}${context.topic ? ` · 话题：${context.topic.title || context.topic.id}` : ''}`;
  return session.source === 'lark' ? '飞书来源（当前未提供群与话题详情）' : session.source ? `来源：${session.source}` : 'Web 任务';
}

export function scheduleDelivery(target: AutomationDeliveryTarget | undefined, session: Session): string {
  if (!target || target.kind === 'unavailable') return '未能核实保存的投递位置，请重新读取后再启用';
  if (target.kind === 'task') return `当前任务 · ${target.sessionId}（结果保留在任务内）`;
  const context = session.sourceContext;
  const chatName = context && context.chat.id === target.chatId ? context.chat.name : '';
  return `飞书 · ${chatName ? `${chatName} · ` : ''}${target.chatId} · ${target.replyInThread ? '话题内回复' : '回复消息'} ${target.replyMessageId} · 机器人 ${target.appId}`;
}

export function SessionAutomationPanel({ session, initialScheduleId, openCreateForm = false, taskTitle }: { session: Session; initialScheduleId?: string; openCreateForm?: boolean; taskTitle?: string }) {
  const qc = useQueryClient();
  const queryKey = ['automation', session.id];
  const records = useQuery({ queryKey, queryFn: () => api.automation(session.id), retry: false, refetchInterval: query => query.state.error ? false : 10_000 });
  const providers = useQuery({ queryKey: ['ci-providers', session.id], queryFn: () => api.ciProviders(session.id), retry: false });
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
  const [condition, setCondition] = useState<'always' | 'ci_new_failure'>('always');
  const [conditionWorkflow, setConditionWorkflow] = useState('');
  const [notice, setNotice] = useState('');
  const [enabling, setEnabling] = useState<SessionSchedule>();
  const [deleting, setDeleting] = useState<SessionSchedule>();
  const runRequests = useRef(new Map<string, { expectedRevision: number; idempotencyKey: string }>());
  const data = records.isError ? undefined : records.data;
  const enablingTarget = enabling ? data?.deliveryTargets?.[enabling.id] : undefined;
  const readOnly = !data || Boolean(session.archivedAt) || ['stopped', 'failed'].includes(session.state);
  const refresh = () => qc.invalidateQueries({ queryKey });
  // 只有能主动查询构建状态的 CI 插件支持在 Web 上等待构建；webhook 型的从飞书 /ci 发起。
  const pollingProviders = providers.data?.providers.filter(item => item.polling) ?? [];
  const providerName = (id?: string) => providers.data?.providers.find(item => item.id === id)?.displayName ?? id ?? 'CI';
  const subscribe = useMutation({ mutationFn: () => api.subscribeCi(session.id, { ...(workflow.trim() ? { workflow: workflow.trim() } : {}), ...(ciPrompt.trim() ? { prompt: ciPrompt.trim() } : {}), ttlSeconds: ttlHours * 3600 }), onSuccess: result => { setNotice(`已开始等待当前提交的 ${providerName(result.subscription.provider)}；续作开始前可取消等待。`); refresh(); } });
  const cancel = useMutation({ mutationFn: (input: { id: string; revision: number }) => api.cancelCi(session.id, input.id, input.revision), onSettled: refresh });
  const toggle = useMutation({ mutationFn: (item: SessionSchedule) => api.updateSchedule(session.id, item.id, { expectedRevision: item.revision, enabled: !item.enabled }), onSuccess: async (_result, item) => { await refresh(); setEnabling(undefined); setNotice(item.enabled ? '计划已停用，已保留内容与触发记录，可随时重新启用。' : '计划已启用。'); }, onError: refresh });
  const run = useMutation({ mutationFn: (item: SessionSchedule) => {
    let request = runRequests.current.get(item.id);
    if (!request) { request = { expectedRevision: item.revision, idempotencyKey: crypto.randomUUID() }; runRequests.current.set(item.id, request); }
    return api.runSchedule(session.id, item.id, request);
  }, onSuccess: async (_result, item) => { runRequests.current.delete(item.id); await refresh(); setNotice('已提交立即执行，可在最近触发记录中查看结果；原计划时间保持不变。'); }, onError: (error, item) => {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) { runRequests.current.delete(item.id); void refresh(); }
  } });
  const remove = useMutation({ mutationFn: (item: SessionSchedule) => api.deleteSchedule(session.id, item.id, item.revision), onSuccess: async (_result, item) => { if (editing?.id === item.id) setEditing(undefined); setDeleting(undefined); await refresh(); setNotice('计划已删除，触发记录已保留；正在运行的任务会继续。'); }, onError: refresh });
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
      condition: condition === 'always' ? { kind: 'always' } : { kind: 'ci_new_failure', ...(conditionWorkflow.trim() ? { workflow: conditionWorkflow.trim() } : {}) }
    };
    return editing ? api.updateSchedule(session.id, editing.id, { ...input, expectedRevision: editing.revision }) : api.createSchedule(session.id, input);
  }, onSuccess: async () => { await refresh(); setNotice(editing ? '计划已更新。' : '计划已保存，点击「启用」后才会运行。'); setEditing(undefined); setName(''); setPrompt(''); }, onError: refresh });
  const edit = (item: SessionSchedule) => {
    setEditing(item); setName(item.name); setPrompt(item.prompt); setTimezone(item.timezone); setKind(item.trigger.kind); setCondition(item.condition.kind);
    if (item.trigger.kind === 'interval') setMinutes(item.trigger.everySeconds / 60);
    if (item.trigger.kind === 'cron') setCron(item.trigger.expression);
    if (item.trigger.kind === 'at') setAt(item.trigger.localDateTime);
    setConditionWorkflow(item.condition.kind === 'ci_new_failure' ? item.condition.workflow ?? '' : '');
  };
  useEffect(() => {
    if (!initialScheduleId || openedSchedule.current === initialScheduleId) return;
    const item = data?.schedules.find(item => item.id === initialScheduleId);
    if (item) { edit(item); openedSchedule.current = initialScheduleId; }
  }, [initialScheduleId, data]);
  const error = records.error ?? subscribe.error ?? cancel.error ?? toggle.error ?? save.error ?? run.error;

  return <section className="space-y-3">
    <h3 className="text-body font-semibold">任务自动化</h3>
    <p className="text-caption text-secondary">自动任务排入本任务，沿用当前目录和上下文。CI 的仓库与提交从此目录读取；每分钟检查一次。</p>
    <p className="break-all text-caption text-secondary">所属任务：{sessionDisplayName(session, taskTitle, `${session.agentId} · ${session.cwd}`)} · 目录：{session.cwd}</p>
    <p className="text-caption text-secondary">{automationSource(session)}</p>
    {records.isLoading && <Spinner label="读取自动任务"/>}
    {error && <Banner tone="danger">{error.message}{records.isError && <Button onClick={() => void records.refetch()}>重新读取</Button>}</Banner>}
    {notice && <p role="status" className="text-caption text-secondary">{notice}</p>}
    {!readOnly && <details className="rounded-lg border border-default p-3">
      <summary className="cursor-pointer text-caption font-semibold">等待 CI 完成</summary>
      {providers.isSuccess && !pollingProviders.length ? <p className="mt-3 text-caption text-secondary">未安装 CI 插件。用 dutydeck plugin install 安装 CI 插件并重启服务后，才能在这里等待构建结果。</p>
      : <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); subscribe.mutate(); }}>
        {!!pollingProviders.length && <p className="text-caption text-subtle">由 {pollingProviders.map(item => item.displayName).join('、')} 查询构建结果。</p>}
        <Field label="工作流（可选）"><Input value={workflow} onChange={event => setWorkflow(event.target.value)} placeholder="工作流文件名或 ID；留空等待本提交的构建"/></Field>
        <Field label="构建结束后执行的指令（可选）"><Textarea rows={2} value={ciPrompt} onChange={event => setCiPrompt(event.target.value)} placeholder="留空则检查 CI 结果并报告下一步"/></Field>
        <Field label="最长等待小时数"><Input type="number" min={1} max={168} value={ttlHours} onChange={event => setTtlHours(Number(event.target.value))}/></Field>
        <Button type="submit" variant="primary" loading={subscribe.isPending}>开始等待</Button>
      </form>}
    </details>}
    {data?.subscriptions.map(item => <div key={item.id} className="rounded-lg border border-default p-3 text-caption">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong>{ciLabels[item.status] ?? item.status}</strong>{['waiting', 'dispatching', 'accepted', 'error'].includes(item.status) && !readOnly && <Button onClick={() => cancel.mutate({ id: item.id, revision: item.revision })} disabled={cancel.isPending}>取消等待</Button>}</div>
      <p className="mt-1 text-secondary">{providerName(item.provider)} · {item.repository.slug} · {item.headSha.slice(0, 12)}{item.workflow ? ` · ${item.workflow}` : ''}</p>
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
        <Field label="执行条件"><Select value={condition} onChange={event => setCondition(event.target.value as typeof condition)}><option value="always">每次到期执行</option><option value="ci_new_failure" disabled={providers.isSuccess && !pollingProviders.length && condition !== 'ci_new_failure'}>CI 出现新的失败构建时执行{providers.isSuccess && !pollingProviders.length ? '（未安装 CI 插件）' : ''}</option></Select></Field>
        {condition === 'ci_new_failure' && <Field label="检查的工作流（可选）"><Input value={conditionWorkflow} onChange={event => setConditionWorkflow(event.target.value)}/></Field>}
        <div className="flex gap-2"><Button type="submit" variant="primary" loading={save.isPending}>保存计划</Button>{editing && <Button onClick={() => setEditing(undefined)}>取消编辑</Button>}</div>
      </form>
    </details>}
    {data?.schedules.map(item => <div key={item.id} className="rounded-lg border border-default p-3 text-caption">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong>{item.name} · {item.enabled ? '已启用' : '已停用'}</strong>{!readOnly && <div className="flex flex-wrap gap-2"><Button disabled={run.isPending} onClick={() => run.mutate(item)}>立即执行</Button><Button onClick={() => edit(item)}>编辑</Button><Button disabled={toggle.isPending} onClick={() => { toggle.reset(); if (item.enabled) toggle.mutate(item); else setEnabling(item); }}>{item.enabled ? '停用' : '启用'}</Button><Button variant="danger" onClick={() => { remove.reset(); setDeleting(item); }}>删除</Button></div>}</div>
      <p className="mt-2 whitespace-pre-wrap break-words text-body text-secondary">{item.prompt}</p>
      <p className="mt-2 text-secondary">{scheduleRule(item)}</p>
      <details className="mt-1 text-subtle"><summary className="cursor-pointer">精确规则与执行条件</summary><p className="mt-1 break-all">{item.trigger.kind === 'cron' ? item.trigger.expression : item.trigger.kind === 'interval' ? `每 ${item.trigger.everySeconds} 秒，自 ${item.trigger.anchorAt} 起` : item.trigger.localDateTime}</p><p>{item.condition.kind === 'always' ? '每次到期执行' : `CI 新失败 · ${item.condition.provider}${item.condition.workflow ? ` · ${item.condition.workflow}` : ''}`}</p></details>
      <p className="text-secondary">{scheduleNextExecution(item)}</p>
      <p className="text-subtle">{item.timezone} · 沿用任务上下文 · {session.cwd}</p>
      <p className="break-all text-secondary">投递位置：{scheduleDelivery(data.deliveryTargets?.[item.id], session)}</p>
      <p className="mt-1 text-secondary">最近结果：{(() => { const latest = data.occurrences.filter(occurrence => occurrence.scheduleId === item.id).sort((a, b) => b.scheduledForUtc.localeCompare(a.scheduledForUtc))[0]; return latest ? `${runLabels[latest.runStatus] ?? latest.runStatus} · ${new Date(latest.scheduledForUtc).toLocaleString('zh-CN', { timeZone: item.timezone, hour12: false })} · ${item.timezone}` : '尚无触发记录'; })()}</p>
      {item.trigger.kind === 'at' && <p className="text-subtle">一次计划仅自动触发一次；是否执行成功请查看触发记录。</p>}
    </div>)}
    {!!data?.occurrences.length && <details><summary className="cursor-pointer text-caption">最近触发记录</summary><div className="mt-2 space-y-2">{data.occurrences.slice(-20).reverse().map(item => <div key={item.id} className="text-caption">
      <p>{data.schedules.find(schedule => schedule.id === item.scheduleId)?.name ?? `历史计划 ${item.scheduleId}`} · {new Date(item.scheduledForUtc).toLocaleString()} · {runLabels[item.runStatus] ?? item.runStatus} · {conditionLabels[item.conditionStatus] ?? item.conditionStatus}</p>
      {item.taskId && <a className="text-link underline" href={sessionPath(session.id)}>查看执行任务 · {item.taskId}</a>}
      {item.error && <p className="text-danger">{item.error}</p>}
      {item.delivery.status === 'error' && <p className="text-warning">通知失败，等待重试</p>}
    </div>)}</div></details>}
    <Dialog open={Boolean(enabling) && !readOnly} onClose={() => setEnabling(undefined)} label="确认启用计划" size="md" role="alertdialog" closeOnEscape={!toggle.isPending} closeOnScrim={!toggle.isPending}>
      <Dialog.Header><h3 className="text-title font-semibold">确认启用计划</h3></Dialog.Header>
      {enabling && <Dialog.Body className="space-y-3">
        <h4 className="text-body font-semibold">{enabling.name}</h4>
        <p className="whitespace-pre-wrap break-words text-body">{enabling.prompt}</p>
        <dl className="space-y-2 text-caption text-secondary">
          <div><dt className="font-semibold">何时运行</dt><dd>{scheduleRule(enabling)}</dd></div>
          <div><dt className="font-semibold">执行条件</dt><dd>{enabling.condition.kind === 'always' ? '每次到期执行' : `CI 出现新的失败构建时执行 · ${enabling.condition.workflow ?? '所有工作流'}`}</dd></div>
          <div><dt className="font-semibold">所属任务与目录</dt><dd className="break-all">{sessionDisplayName(session, taskTitle, session.id)} · {session.cwd}</dd></div>
          <div><dt className="font-semibold">保存的投递位置</dt><dd className="break-all">{scheduleDelivery(enablingTarget, session)}</dd></div>
        </dl>
        <p className="text-caption text-secondary">启用后按规则排入本任务执行。停用会保留计划和历史，正在运行的任务会继续。</p>
        {data?.schedules.find(item => item.id === enabling.id)?.revision !== enabling.revision && <Banner tone="warning">计划已更新，请取消并重新检查最新计划后启用。</Banner>}
        {toggle.error && <Banner tone="danger">{toggle.error.message}</Banner>}
      </Dialog.Body>}
      <Dialog.Footer><Button data-dialog-initial-focus disabled={toggle.isPending} onClick={() => setEnabling(undefined)}>暂不启用</Button><Button variant="primary" loading={toggle.isPending} disabled={!enabling || !enablingTarget || enablingTarget.kind === 'unavailable' || data?.schedules.find(item => item.id === enabling.id)?.revision !== enabling.revision} onClick={() => { if (enabling) toggle.mutate(enabling); }}>确认启用</Button></Dialog.Footer>
    </Dialog>
    <ConfirmDialog open={Boolean(deleting)} title="删除定时计划" description={`删除「${deleting?.name ?? ''}」后将停止未来和排队中的计划执行，保留触发记录。正在运行的任务会继续。`} confirmLabel="删除计划" tone="danger" busy={remove.isPending} error={remove.error?.message} onConfirm={() => { if (deleting) remove.mutate(data?.schedules.find(item => item.id === deleting.id) ?? deleting); }} onCancel={() => { if (!remove.isPending) setDeleting(undefined); }}/>
  </section>;
}
