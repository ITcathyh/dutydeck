import { useRef, useState, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateWorkItemInput, WorkItem, WorkPlan, WorkTemplate } from '@dutydeck/shared';
import { X } from 'lucide-react';
import { api, type Agent, type Session, type WorkItemRequest } from '../api';
import { Banner, Button, Dialog, Field, IconButton, Input, Select, Spinner, Textarea } from './primitives';

const statusLabels: Record<string, string> = { pending: '待执行', preparing: '准备中', accepted: '执行端已接收', running: '执行中', waiting: '等待回答', completed: '已完成', failed: '失败', interrupted: '已中断', skipped: '已跳过', cancelling: '正在取消', cancelled: '已取消', blocked: '需要处理' };
const deliveryLabels = { pending: '等待送达', delivered: '已送达', error: '送达失败', not_requested: '未请求通知' };
type Submission = { signature: string; key: string } | undefined;
type Props = { session: Session; agents: Agent[]; onSelectSession(id: string): void };
type Action =
  | { kind: 'respond'; item: WorkItem; request: WorkItemRequest; answer: string }
  | { kind: 'create'; input: CreateWorkItemInput }
  | { kind: 'run'; template: WorkTemplate; goal: string; idempotencyKey: string }
  | { kind: 'template'; item: WorkItem; name: string }
  | { kind: 'cancel'; item: WorkItem }
  | { kind: 'retry'; item: WorkItem; stepId: string }
  | { kind: 'answer'; item: WorkItem; stepId: string; answer: string };

// Session changes remount all local drafts and mutation observers, including direct prop updates.
export function WorkItemsPanel(props: Props) {
  return <SessionWorkItems key={props.session.id} {...props}/>;
}

function SessionWorkItems({ session, agents, onSelectSession }: Props) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [notice, setNotice] = useState('');
  const submission = useRef<Submission>(undefined);
  const qc = useQueryClient();
  const queryKey = ['work-items', session.id];
  const records = useQuery({ queryKey, queryFn: () => api.workItems(session.id), enabled: open, refetchInterval: open ? 5_000 : false });
  const mutation = useMutation({
    mutationFn: async (action: Action): Promise<unknown> => {
      switch (action.kind) {
        case 'respond': return api.respondWorkItemRequest(session.id, action.item.id, { stepId: action.request.stepId, taskId: action.request.taskId, requestId: action.request.requestId, kind: action.request.kind, answer: action.answer });
        case 'create': return api.createWorkItem(session.id, action.input);
        case 'run': return api.runWorkTemplate(session.id, action.template.id, { version: action.template.version, goal: action.goal, idempotencyKey: action.idempotencyKey });
        case 'template': return api.saveWorkTemplate(session.id, action.item.id, action.name);
        case 'cancel': return api.cancelWorkItem(session.id, action.item.id, action.item.revision);
        case 'retry': return api.retryWorkStep(session.id, action.item.id, action.stepId, action.item.revision);
        case 'answer': return api.answerWorkStep(session.id, action.item.id, action.stepId, action.answer, action.item.revision);
      }
    },
    onSuccess: (result, action) => {
      if (action.kind === 'respond') setNotice('响应已提交，正在读取执行状态。');
      else if (action.kind === 'template') setNotice(`已保存流程模板「${action.name}」。`);
      else {
        const item = result as WorkItem;
        qc.setQueryData<{ items: WorkItem[]; templates: WorkTemplate[] }>(queryKey, current => current ? { ...current, items: [item, ...current.items.filter(existing => existing.id !== item.id)] } : undefined);
        setSelectedId(item.id);
        setNotice(action.kind === 'cancel' ? '已提交取消请求；各步骤的停止状态见下方。' : action.kind === 'answer' ? '回答已保存。' : action.kind === 'retry' ? '已提交单步重试。' : '目标已接收。');
      }
    },
    onSettled: async () => { await Promise.all([qc.invalidateQueries({ queryKey }), qc.invalidateQueries({ queryKey: ['work-item-requests', session.id] })]); }
  });
  const readOnly = Boolean(session.archivedAt) || ['stopped', 'failed'].includes(session.state);
  const disabled = readOnly || mutation.isPending || records.isFetching || records.isError || !records.data;
  const items = records.data?.items ?? [];
  const selected = items.find(item => item.id === selectedId) ?? items[0];
  const requests = useQuery({ queryKey: ['work-item-requests', session.id, selected?.id], queryFn: () => api.workItemRequests(session.id, selected!.id), enabled: open && Boolean(selected?.steps.some(step => step.status === 'running')), refetchInterval: open ? 5_000 : false });
  const act = (action: Action) => { if (!disabled) { setNotice(''); mutation.mutate(action); } };

  return <>
    <button type="button" className="text-caption text-accent hover:underline" onClick={() => setOpen(true)}>目标、步骤与成果</button>
    {open && <Dialog open onClose={() => setOpen(false)} label="目标、步骤与成果" size="lg">
      <Dialog.Header><h2 className="text-title font-semibold">目标、步骤与成果</h2><span className="ml-auto"><IconButton label="关闭目标详情" onClick={() => setOpen(false)}><X size={16}/></IconButton></span></Dialog.Header>
      <Dialog.Body><div className="space-y-5">
        <p className="text-caption text-secondary">在飞书使用 /work 进入同一目标入口。这里查看当前会话的步骤、等待事项和完整成果；子任务的执行记录可从各步骤打开。</p>
        <p className="break-all text-caption text-subtle">当前目录：{session.cwd}</p>
        {records.isLoading && <Spinner label="读取工作项目标"/>}
        {records.error && <Banner tone="danger" action={{ label: '重新读取', busy: records.isFetching, onClick: () => void records.refetch() }}>目标读取失败：{records.error.message}。重新读取成功后才能操作。</Banner>}
        {mutation.error && <Banner tone="danger">{mutation.error.message}。请核对最新步骤后再操作。</Banner>}
        {notice && <p role="status" className="text-caption text-secondary">{notice}</p>}
        {readOnly && <p className="text-caption text-subtle">此会话已结束或归档，目标仅供查看。</p>}
        {!readOnly && <CreateGoal submission={submission} agents={agents} templates={records.data?.templates ?? []} disabled={disabled} onSubmit={action => { setNotice(''); return mutation.mutateAsync(action); }}/>}
        {records.isSuccess && !items.length && <p className="text-body text-secondary">当前会话还没有工作项目标。可以创建研究目标，或从飞书 /work 发起。</p>}
        {!!items.length && <section className="space-y-3" aria-label="当前会话的目标">
          <Field label="选择目标"><Select value={selected?.id ?? ''} onChange={event => { setSelectedId(event.target.value); setNotice(''); mutation.reset(); }} disabled={mutation.isPending}>
            {items.map(item => <option key={item.id} value={item.id}>{item.title} · {statusLabels[item.status]}</option>)}
          </Select></Field>
          {selected?.steps.some(step => step.status === 'running') && <section aria-label="执行中的授权与提问" className="space-y-3">
            {requests.isLoading && <Spinner label="读取执行请求"/>}
            {requests.error && <Banner tone="danger" action={{ label: '重新读取执行请求', busy: requests.isFetching, onClick: () => void requests.refetch() }}>执行请求读取失败：{requests.error.message}</Banner>}
            {requests.data?.map(request => <ExecutionRequest key={`${selected.id}:${request.stepId}:${request.kind}:${request.requestId}`} request={request} title={selected.plan.steps.find(step => step.id === request.stepId)?.title ?? request.stepId} disabled={disabled || requests.isFetching || requests.isError} onAnswer={answer => act({ kind: 'respond', item: selected, request, answer })}/>)}
          </section>}
          {selected && <GoalDetails key={selected.id} item={selected} session={session} agents={agents} disabled={disabled} onAction={act} onSelectSession={id => { setOpen(false); onSelectSession(id); }}/>}
        </section>}
      </div></Dialog.Body>
    </Dialog>}
  </>;
}

function CreateGoal({ agents, templates, disabled, onSubmit, submission }: { submission: RefObject<Submission>; agents: Agent[]; templates: WorkTemplate[]; disabled: boolean; onSubmit(action: Action): Promise<unknown> }) {
  const [mode, setMode] = useState('research');
  const [goal, setGoal] = useState('');
  const [agentIds, setAgentIds] = useState(['', '', '']);
  const template = templates.find(item => `${item.id}:${item.version}` === mode);
  const selectedAgents = agentIds.map((id, index) => id || agents[Math.min(index, agents.length - 1)]?.id || '');
  const valid = goal.trim() && (mode === 'research' ? selectedAgents.every(id => agents.some(agent => agent.id === id)) : template);
  const submit = async () => {
    if (disabled || !valid) return;
    const plan: WorkPlan = { title: '研究与汇总', steps: [
      { id: 'analysis_1', title: '方案与证据分析', kind: 'agent', agentId: selectedAgents[0], instruction: '围绕用户目标独立研究可行方案，核实来源，保存事实、引用和结论。', dependsOn: [], workspaceMode: 'shared' },
      { id: 'analysis_2', title: '风险与替代方案分析', kind: 'agent', agentId: selectedAgents[1], instruction: '围绕用户目标独立研究风险、限制与替代方案，核实来源并保存引用。', dependsOn: [], workspaceMode: 'shared' },
      { id: 'summary', title: '汇总完整报告', kind: 'agent', agentId: selectedAgents[2], instruction: '读取两份分析产物，核对冲突与证据，形成回应用户目标的完整报告，保留引用与未核实事项。', dependsOn: ['analysis_1', 'analysis_2'], workspaceMode: 'shared' }
    ], outputStepId: 'summary' };
    const signature = JSON.stringify({ mode, goal: goal.trim(), ...(template ? { version: template.version } : { plan }) });
    if (submission.current?.signature !== signature) submission.current = { signature, key: crypto.randomUUID() };
    const key = submission.current.key;
    try {
      await onSubmit(template ? { kind: 'run', template, goal: goal.trim(), idempotencyKey: key } : { kind: 'create', input: { goal: goal.trim(), plan, idempotencyKey: key } });
      submission.current = undefined;
      setGoal('');
    } catch { /* Keep the same key when retrying an unchanged request after an uncertain response. */ }
  };
  return <details className="rounded-lg border border-default p-3">
    <summary className="cursor-pointer text-caption font-semibold">新建目标或复用模板</summary>
    <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset className="space-y-3" disabled={disabled}>
        <Field label="执行流程"><Select value={mode} onChange={event => setMode(event.target.value)}><option value="research">研究：两份独立分析 → 汇总</option>{templates.map(item => <option key={`${item.id}:${item.version}`} value={`${item.id}:${item.version}`}>{item.name} · 版本 {item.version}</option>)}</Select></Field>
        <Field label="本次目标"><Textarea required rows={3} maxLength={32000} value={goal} onChange={event => setGoal(event.target.value)} placeholder="描述问题、材料链接和期望成果"/></Field>
        {mode === 'research' && <>
          {['方案分析 Agent', '风险分析 Agent', '汇总 Agent'].map((label, index) => <Field key={label} label={label}><Select value={selectedAgents[index]} onChange={event => setAgentIds(current => current.map((id, i) => i === index ? event.target.value : id))}>{!agents.length && <option value="">尚无已配置 Agent</option>}{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></Field>)}
          <p className="text-caption text-subtle">可以由同一 Agent 的独立会话分析。研究步骤使用当前目录；已配置不代表已登录或工具已获授权，执行时会检查。</p>
        </>}
        {template && <p className="text-caption text-subtle">使用已保存的版本 {template.version}，共 {template.plan.steps.length} 个步骤；仅替换本次目标。</p>}
        <Button type="submit" variant="primary" disabled={disabled || !valid}>开始目标</Button>
      </fieldset>
    </form>
  </details>;
}

function GoalDetails({ item, session, agents, disabled, onAction, onSelectSession }: { item: WorkItem; session: Session; agents: Agent[]; disabled: boolean; onAction(action: Action): void; onSelectSession(id: string): void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [templateName, setTemplateName] = useState(item.title);
  const cancellable = ['running', 'waiting', 'failed', 'blocked'].includes(item.status);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-body font-semibold">{item.title} · {statusLabels[item.status]}</h3>{cancellable && <Button disabled={disabled} onClick={() => onAction({ kind: 'cancel', item })}>取消目标</Button>}</div>
    <p className="whitespace-pre-wrap text-body">{item.goal}</p>
    <p className="text-caption text-subtle">修订 {item.revision} · 更新于 {new Date(item.updatedAt).toLocaleString()} · {deliveryLabels[item.delivery.status]}</p>
    {item.error && <Banner tone="danger">{item.error}</Banner>}
    {item.delivery.error && <Banner tone="warning">成果通知：{item.delivery.error}</Banner>}
    {item.output && <section aria-label="最终成果" className="space-y-2 rounded-lg bg-muted p-3"><h4 className="text-body font-semibold">最终成果</h4><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-body">{item.output.text}</pre><p className="break-all text-caption text-subtle">来源步骤 {item.output.stepId} · {item.output.digest}</p></section>}
    <ol className="space-y-3" aria-label="目标步骤">
      {item.plan.steps.map(definition => {
        const step = item.steps.find(record => record.id === definition.id);
        const status = step?.status ?? 'pending';
        return <li key={definition.id} className="rounded-lg border border-default p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-caption font-semibold">{definition.title} · {statusLabels[status]}</h4>{step?.status === 'failed' && item.status === 'failed' && <Button disabled={disabled} onClick={() => onAction({ kind: 'retry', item, stepId: step.id })}>重试此步骤</Button>}</div>
          <p className="mt-1 text-caption text-secondary">{definition.kind === 'wait' ? '等待用户回答' : `执行 Agent：${agents.find(agent => agent.id === definition.agentId)?.name ?? definition.agentId}`}</p>
          <p className="text-caption text-subtle">依赖：{definition.dependsOn.length ? definition.dependsOn.map(id => item.plan.steps.find(value => value.id === id)?.title ?? id).join('、') : '无'}</p>
          {definition.kind === 'agent' && <p className="break-all text-caption text-subtle">工作目录：{definition.workspaceMode === 'worktree' ? `独立工作目录（基于 ${session.cwd}；实际路径见执行记录）` : session.cwd}</p>}
          {definition.when && <p className="text-caption text-subtle">执行条件：{definition.when.stepId} 回答为「{definition.when.equals}」</p>}
          <p className="mt-2 whitespace-pre-wrap text-caption">{definition.instruction}</p>
          {!!definition.skills?.length && <p className="text-caption text-subtle">所需 Skill：{definition.skills.join('、')}</p>}
          {step?.answer !== undefined && <p className="mt-2 whitespace-pre-wrap text-caption">已保存回答：{step.answer}</p>}
          {status === 'waiting' && ['running', 'waiting'].includes(item.status) && <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); if (!disabled && answers[definition.id]?.trim()) onAction({ kind: 'answer', item, stepId: definition.id, answer: answers[definition.id].trim() }); }}>
            <Field label={`回答：${definition.title}`}><Textarea required maxLength={4000} disabled={disabled} value={answers[definition.id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [definition.id]: event.target.value }))}/></Field>
            <Button type="submit" variant="primary" disabled={disabled || !answers[definition.id]?.trim()}>提交回答</Button>
          </form>}
          {step?.attempts.map(attempt => <details key={attempt.id} className="mt-3">
            <summary className="cursor-pointer text-caption">第 {attempt.number} 次尝试 · {statusLabels[attempt.status]}</summary>
            <p className="mt-2 text-caption text-subtle">{new Date(attempt.updatedAt).toLocaleString()}{attempt.taskId ? ` · 指令 ${attempt.taskId}` : ''}</p>
            {attempt.error && <p className="mt-1 whitespace-pre-wrap text-caption text-danger">{attempt.error}</p>}
            {attempt.output && <><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-caption">{attempt.output.text}</pre><p className="break-all text-caption text-subtle">产物指纹 {attempt.output.digest}</p></>}
            {attempt.sessionId && <a className="mt-2 inline-block text-caption text-accent hover:underline" href={`/sessions/${encodeURIComponent(attempt.sessionId)}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onSelectSession(attempt.sessionId!); } }}>查看此尝试的执行记录</a>}
          </details>)}
        </li>;
      })}
    </ol>
    <details className="rounded-lg border border-default p-3"><summary className="cursor-pointer text-caption font-semibold">保存为流程模板</summary><form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (!disabled && templateName.trim()) onAction({ kind: 'template', item, name: templateName.trim() }); }}><div className="min-w-0 flex-1"><Field label="模板名称"><Input required maxLength={200} disabled={disabled} value={templateName} onChange={event => setTemplateName(event.target.value)}/></Field></div><Button type="submit" disabled={disabled || !templateName.trim()}>保存模板</Button></form><p className="mt-2 text-caption text-subtle">保存步骤定义与执行角色；再次运行时填写新的目标。</p></details>
  </div>;
}

function ExecutionRequest({ request, title, disabled, onAnswer }: { request: WorkItemRequest; title: string; disabled: boolean; onAnswer(answer: string): void }) {
  const [answer, setAnswer] = useState('');
  return <section className="space-y-3 rounded-lg border border-default p-3">
    <h4 className="text-body font-semibold">{title} · {request.kind === 'permission' ? '需要操作授权' : '执行中提问'}</h4>
    <p className="whitespace-pre-wrap text-body">{request.text}</p>
    {request.kind === 'permission' ? <div className="flex gap-2"><Button disabled={disabled} onClick={() => onAnswer('reject')}>拒绝此操作</Button><Button variant="primary" disabled={disabled} onClick={() => onAnswer('approve')}>批准此操作</Button></div> : <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (!disabled && answer.trim()) onAnswer(answer.trim()); }}><Field label={`执行回答：${title}`}><Textarea required maxLength={4000} disabled={disabled} value={answer} onChange={event => setAnswer(event.target.value)}/></Field><Button type="submit" variant="primary" disabled={disabled || !answer.trim()}>发送执行回答</Button></form>}
  </section>;
}
