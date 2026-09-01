import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, X } from 'lucide-react';
import { api, type Agent, type PermissionMode, type Session, type Task } from '../api';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';
import { permissionLabels } from './ui';
import { Banner, Button, Dialog, Field, IconButton, Input, Spinner, Textarea } from './primitives';
import { AgentSelect, CompactSelect } from './CompactSelect';

export type NewSessionModalProps = {
  open: boolean;
  onClose(): void;
  onOpenAgentSetup?(): void;
  onCreated(session: Session, task: Task): void;
  agents: Agent[];
  capabilities?: { platform: string; directoryPicker: boolean; filePicker: boolean };
};

// label 一律来自 components/ui.tsx 的 permissionLabels，这里只补每个模式的说明文案。
const permissionOptions: Record<PermissionMode, { label: string; meta: string }> = {
  ask: { label: permissionLabels.ask, meta: '遇到受控操作时询问' },
  'approve-reads': { label: permissionLabels['approve-reads'], meta: '读取自动放行，写操作询问' },
  'deny-all': { label: permissionLabels['deny-all'], meta: '拒绝所有受控操作' },
  'full-trust': { label: permissionLabels['full-trust'], meta: '不等待审批，风险最高' }
};

const isPtyCliAgent = (agent?: Agent) => agent?.protocol === 'pty-cli';
const isLegacyPtyAgent = (agent?: Agent) => agent?.protocol === 'pty';
const isPtyAgent = isPtyCliAgent;
const supportedPermissionModes = (agent?: Agent): PermissionMode[] => isLegacyPtyAgent(agent) ? [] : isPtyCliAgent(agent) ? ['ask', 'full-trust'] : ['ask', 'approve-reads', 'deny-all', 'full-trust'];
const initialPermissionMode = (agent?: Agent): PermissionMode => supportedPermissionModes(agent).includes(agent?.permissionMode ?? 'ask') ? (agent?.permissionMode ?? 'ask') : 'ask';

/*
  这四个字段用的是 CompactSelect（自绘下拉，触发器是 <button>），刻意**不套** <Field>。

  Field 会渲染 <label htmlFor={controlId}>，而 CompactSelect 的触发按钮拿不到那个 id
  （契约把 controlId 留给原生控件），结果是一个指向空气的 label：点它不聚焦任何东西，
  读屏也建立不起关联——比现在这个朴素的 <span> 标签更糟，因为它看起来像做了关联。
  CompactSelect 已经消费 useFieldControl().describedBy，将来若给触发器补上 controlId，
  这里可以整体换成 Field，那才是真的接上了。
*/
function SelectField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span className="text-caption font-medium text-secondary">{label}</span>{children}</div>;
}

export function NewSessionModal({ open, onClose, onOpenAgentSetup, onCreated, agents, capabilities }: NewSessionModalProps) {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState('codex');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const selectedAgent = agents.find(agent => agent.id === agentId);
  const legacyPtyUnsupported = isLegacyPtyAgent(selectedAgent);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => initialPermissionMode(agents.find(agent => agent.id === 'codex') ?? agents[0]));
  const [fullTrustConfirmed, setFullTrustConfirmed] = useState(false);
  const [goal, setGoal] = useState('');
  const [createdSession, setCreatedSession] = useState<Session>();
  const agentModels = useQuery({ queryKey: agentModelsQueryKey(agentId, model), queryFn: () => loadAgentModels(agentId, model || undefined), enabled: open && Boolean(agentId), initialData: () => readCachedAgentModels(agentId, model || undefined), initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 5 * 60_000 });
  useEffect(() => {
    if (!agentModels.data || agentModels.isFetching || !reasoningEffort) return;
    if (!agentModels.data.reasoningEfforts.some(option => option.id === reasoningEffort)) setReasoningEffort('');
  }, [agentModels.data, agentModels.isFetching, reasoningEffort]);
  useEffect(() => {
    if (!agents.length || agents.some(agent => agent.id === agentId)) return;
    setAgentId(agents[0].id);
    setPermissionMode(initialPermissionMode(agents[0]));
    setFullTrustConfirmed(false);
  }, [agents, agentId]);
  const create = useMutation({
    mutationFn: async () => {
      const session = createdSession ?? await api.create({ agentId, permissionMode, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
      if (!createdSession) setCreatedSession(session);
      const result = await api.send(session.id, goal.trim(), 'queue');
      return { session, task: result.task };
    },
    onSuccess: ({ session, task }) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.setQueryData<Task[]>(['tasks', session.id], [task]);
      setCreatedSession(undefined); setGoal('');
      onCreated(session, task);
    }
  });
  const pickNewWorkspace = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => setCwd(result.path) });
  if (!open) return null;

  if (agents.length === 0) return <Dialog open onClose={onClose} label="需要先准备 Agent" size="sm">
    <Dialog.Header>
      <h2 className="text-title font-semibold text-primary">先准备一个 Agent</h2>
      <span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span>
    </Dialog.Header>
    <Dialog.Body>Dockmux 没有检测到可用的 Agent CLI。安装并登录 Codex、Claude Code 等 CLI 后重启 Dockmux，再回来创建任务。</Dialog.Body>
    <Dialog.Footer>
      <Button variant="secondary" onClick={onClose}>稍后再说</Button>
      <Button variant="primary" onClick={onOpenAgentSetup ?? onClose}>查看添加方法</Button>
    </Dialog.Footer>
  </Dialog>;

  if (legacyPtyUnsupported) return <Dialog open onClose={onClose} label="无法创建旧 PTY 任务" size="sm">
    <Dialog.Header>
      <h2 className="text-title font-semibold text-primary">无法创建任务</h2>
      <span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span>
    </Dialog.Header>
    <Dialog.Body>
      <Banner tone="danger">旧 PTY 兼容协议无法提供可靠的权限控制或交互审批，请改用 ACP 或 PTY CLI Agent。</Banner>
    </Dialog.Body>
    <Dialog.Footer><Button variant="primary" disabled>创建并执行</Button></Dialog.Footer>
  </Dialog>;

  const submitDisabled = create.isPending || !goal.trim() || (permissionMode === 'full-trust' && !fullTrustConfirmed);
  // 提交进行中不允许 Escape / 点遮罩关闭：会把一个已经发出的写操作丢在半路（契约 §8.1）。
  return <Dialog open onClose={onClose} label="创建新任务" size="sm" closeOnEscape={!create.isPending} closeOnScrim={!create.isPending}>
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }} className="flex min-h-0 flex-1 flex-col">
      <Dialog.Header>
        <div>
          <h2 className="text-title font-semibold text-primary">创建新任务</h2>
          <p className="mt-1 text-caption text-subtle">写清目标即可开始；模型和推理强度可以使用 Agent 默认值。</p>
        </div>
        <span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span>
      </Dialog.Header>
      <Dialog.Body>
        <div className="space-y-4">
          <Field label="任务目标">
            <Textarea autoFocus required aria-label="任务目标" value={goal} onChange={event => setGoal(event.target.value)} rows={3} placeholder="例如：修复登录超时问题，补齐回归测试并通过构建" className="resize-y"/>
          </Field>
          <fieldset disabled={Boolean(createdSession)} className="contents disabled:opacity-60">
            <SelectField label="执行任务的 Agent">
              <AgentSelect agents={agents} value={agentId} onChange={value => { const nextAgent = agents.find(agent => agent.id === value); setAgentId(value); setPermissionMode(initialPermissionMode(nextAgent)); setFullTrustConfirmed(false); setModel(''); setReasoningEffort(''); }}/>
            </SelectField>
            <Field label="工作目录" hint="填写运行 Dockmux 的这台机器上的目录；留空会使用 Agent 的默认工作区。" error={pickNewWorkspace.error?.message}>
              <span className="flex gap-2">
                <Input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="留空则使用 Agent 默认目录" className="min-w-0 flex-1"/>
                <Button variant="secondary" disabled={!capabilities?.directoryPicker || pickNewWorkspace.isPending} onClick={() => pickNewWorkspace.mutate()} icon={<FolderOpen size={14}/>}>{capabilities?.directoryPicker ? '选择目录' : '手动输入'}</Button>
              </span>
            </Field>
            <div>
              <SelectField label="操作权限">
                <CompactSelect options={supportedPermissionModes(selectedAgent).map(value => ({ value, ...permissionOptions[value] }))} value={permissionMode} placeholder="选择操作权限" disabledText="" onChange={value => { setPermissionMode(value as PermissionMode); setFullTrustConfirmed(false); }}/>
              </SelectField>
              {isPtyAgent(selectedAgent) && permissionMode === 'ask' && <p className="mt-1.5 text-caption text-warning">此 CLI 的操作确认在终端中完成；任务停住时可直接打开「终端」处理。</p>}
              {permissionMode === 'full-trust' && <label className="mt-2 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft p-2.5 text-caption text-danger">
                <input type="checkbox" checked={fullTrustConfirmed} onChange={event => setFullTrustConfirmed(event.target.checked)} className="mt-0.5"/>
                <span><strong className="block">确认允许 Agent 直接操作此工作目录</strong>完全信任会跳过操作确认，只用于你信任的任务和目录。</span>
              </label>}
            </div>
            <details className="rounded-lg border border-default bg-muted p-3">
              <summary className="cursor-pointer text-caption font-semibold text-secondary">模型与推理设置（可选）</summary>
              <div className="mt-3 space-y-4">
                <SelectField label="模型">
                  {!agentModels.data && (agentModels.isLoading || agentModels.isFetching)
                    ? <div className="mt-1.5 flex h-10 items-center rounded-md border border-default bg-surface px-3"><Spinner label="正在读取可用模型"/></div>
                    : <CompactSelect options={[{ value: '', label: agentModels.data?.defaultModel ? `使用 Agent 默认模型 (${agentModels.data.defaultModel})` : '使用 Agent 默认模型' }, ...(agentModels.data?.models ?? []).map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))]} value={model} placeholder="选择模型" disabledText="使用 Agent 默认模型" onChange={value => { setModel(value); setReasoningEffort(''); }}/>}
                </SelectField>
                {agentModels.data?.source === 'acp' && agentModels.data.reasoningEfforts.length > 0 && <SelectField label="推理强度">
                  <CompactSelect options={[{ value: '', label: agentModels.data.defaultReasoningEffort ? `使用模型默认强度 (${agentModels.data.defaultReasoningEffort})` : '使用模型默认强度' }, ...agentModels.data.reasoningEfforts.map(item => ({ value: item.id, label: item.name }))]} value={reasoningEffort} placeholder="选择推理强度" disabledText="" onChange={setReasoningEffort}/>
                </SelectField>}
              </div>
            </details>
          </fieldset>
          {create.error && <Banner tone="danger">{createdSession ? `任务已创建，但目标发送失败：${create.error.message}。再次提交只会重试发送，不会重复创建任务。` : create.error.message}</Banner>}
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="secondary" onClick={onClose}>取消</Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={submitDisabled} className="min-w-24">{createdSession ? '重试发送' : '创建并执行'}</Button>
      </Dialog.Footer>
    </form>
  </Dialog>;
}
