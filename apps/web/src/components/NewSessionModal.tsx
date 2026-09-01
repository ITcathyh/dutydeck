import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, RefreshCw, X } from 'lucide-react';
import { api, type Agent, type PermissionMode, type Session, type Task } from '../api';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';
import { useDialogFocus } from '../useDialogFocus';
import { IconButton, permissionLabels } from './ui';
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

export function NewSessionModal({ open, onClose, onOpenAgentSetup, onCreated, agents, capabilities }: NewSessionModalProps) {
  const qc = useQueryClient();
  useDialogFocus(open);
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
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || create.isPending) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [create.isPending, onClose, open]);
  if (!open) return null;
  if (agents.length === 0) return <div className="ui-overlay fixed inset-0 z-20 grid place-items-center bg-[var(--overlay-scrim)] p-4 backdrop-blur-[2px]"><div role="dialog" aria-modal="true" aria-label="需要先准备 Agent" className="ui-dialog w-full max-w-md rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] p-5 shadow-[var(--shadow-dialog)]"><div className="flex items-center"><h2 className="text-base font-semibold">先准备一个 Agent</h2><span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span></div><p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">Dockmux 没有检测到可用的 Agent CLI。安装并登录 Codex、Claude Code 等 CLI 后重启 Dockmux，再回来创建任务。</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-[var(--border-strong)] px-3 text-sm font-medium">稍后再说</button><button type="button" onClick={onOpenAgentSetup ?? onClose} className="min-h-10 rounded-lg bg-[var(--surface-inverse)] px-3 text-sm font-semibold text-[var(--text-inverse)]">查看添加方法</button></div></div></div>;
  if (legacyPtyUnsupported) return <div className="ui-overlay fixed inset-0 z-20 grid place-items-center bg-[var(--overlay-scrim)] p-4 backdrop-blur-[2px]"><div role="dialog" aria-modal="true" aria-label="无法创建旧 PTY 任务" className="ui-dialog w-full max-w-md rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] p-5 shadow-[var(--shadow-dialog)]"><div className="flex items-center"><h2 className="text-base font-semibold">无法创建任务</h2><span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span></div><p role="alert" className="mt-4 rounded-lg border border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] px-3 py-2 text-xs leading-5 text-[var(--status-danger)]">旧 PTY 兼容协议无法提供可靠的权限控制或交互审批，请改用 ACP 或 PTY CLI Agent。</p><div className="mt-5 flex justify-end"><button type="button" disabled className="rounded-lg bg-[var(--action-primary)] px-3.5 py-2 text-xs font-semibold text-[var(--text-on-action)] opacity-50">创建并执行</button></div></div></div>;
  const submitDisabled = create.isPending || !goal.trim() || (permissionMode === 'full-trust' && !fullTrustConfirmed);
  return <div className="ui-overlay fixed inset-0 z-20 grid place-items-center bg-[var(--overlay-scrim)] p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><form role="dialog" aria-modal="true" aria-label="创建新任务" onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }} className="ui-dialog max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] p-5 shadow-[var(--shadow-dialog)]"><div className="flex items-center"><div><h2 className="text-base font-semibold">创建新任务</h2><p className="mt-1 text-xs text-[var(--text-muted)]">写清目标即可开始；模型和推理强度可以使用 Agent 默认值。</p></div><span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span></div>
    <div className="mt-5 space-y-4"><label className="block"><span className="text-xs font-semibold text-[var(--text-primary)]">任务目标</span><textarea autoFocus required aria-label="任务目标" value={goal} onChange={event => setGoal(event.target.value)} rows={3} placeholder="例如：修复登录超时问题，补齐回归测试并通过构建" className="mt-1.5 w-full resize-y rounded-xl border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 py-2.5 text-sm leading-6 outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--action-primary)]"/></label><fieldset disabled={Boolean(createdSession)} className="contents disabled:opacity-60"><div><span className="text-xs font-medium text-[var(--text-secondary)]">执行任务的 Agent</span><AgentSelect agents={agents} value={agentId} onChange={value => { const nextAgent = agents.find(agent => agent.id === value); setAgentId(value); setPermissionMode(initialPermissionMode(nextAgent)); setFullTrustConfirmed(false); setModel(''); setReasoningEffort(''); }}/></div><label className="block"><span className="text-xs font-medium text-[var(--text-secondary)]">工作目录</span><span className="mt-1.5 flex gap-2"><input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="留空则使用 Agent 默认目录" className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--border-strong)] px-3 text-sm outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-strong)]"/><button type="button" disabled={!capabilities?.directoryPicker || pickNewWorkspace.isPending} onClick={() => pickNewWorkspace.mutate()} className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"><FolderOpen size={14}/>{capabilities?.directoryPicker ? '选择目录' : '手动输入'}</button></span><p className="mt-1.5 text-[11px] leading-4 text-[var(--text-muted)]">填写运行 Dockmux 的这台机器上的目录；留空会使用 Agent 的默认工作区。</p>{pickNewWorkspace.error && <p className="mt-1.5 text-xs text-[var(--status-danger)]">{pickNewWorkspace.error.message}</p>}</label><div><span className="text-xs font-medium text-[var(--text-secondary)]">操作权限</span><CompactSelect options={supportedPermissionModes(selectedAgent).map(value => ({ value, ...permissionOptions[value] }))} value={permissionMode} placeholder="选择操作权限" disabledText="" onChange={value => { setPermissionMode(value as PermissionMode); setFullTrustConfirmed(false); }}/>{isPtyAgent(selectedAgent) && permissionMode === 'ask' && <p className="mt-1.5 text-[11px] leading-4 text-[var(--status-warning)]">此 CLI 的操作确认在终端中完成；任务停住时可直接打开「终端」处理。</p>}{permissionMode === 'full-trust' && <label className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] p-2.5 text-[11px] leading-4 text-[var(--status-danger)]"><input type="checkbox" checked={fullTrustConfirmed} onChange={event => setFullTrustConfirmed(event.target.checked)} className="mt-0.5"/><span><strong className="block">确认允许 Agent 直接操作此工作目录</strong>完全信任会跳过操作确认，只用于你信任的任务和目录。</span></label>}</div><details className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-muted)] p-3"><summary className="cursor-pointer text-xs font-semibold text-[var(--text-secondary)]">模型与推理设置（可选）</summary><div className="mt-3 space-y-4"><div><span className="text-xs font-medium text-[var(--text-secondary)]">模型</span>{!agentModels.data && (agentModels.isLoading || agentModels.isFetching) ? <div className="mt-1.5 flex h-10 items-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-default)] px-3 text-sm text-[var(--text-muted)]"><RefreshCw size={13} className="mr-2 animate-spin"/>正在读取可用模型</div> : <CompactSelect options={[{ value: '', label: agentModels.data?.defaultModel ? `使用 Agent 默认模型 (${agentModels.data.defaultModel})` : '使用 Agent 默认模型' }, ...(agentModels.data?.models ?? []).map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))]} value={model} placeholder="选择模型" disabledText="使用 Agent 默认模型" onChange={value => { setModel(value); setReasoningEffort(''); }}/>}</div>{agentModels.data?.source === 'acp' && agentModels.data.reasoningEfforts.length > 0 && <div><span className="text-xs font-medium text-[var(--text-secondary)]">推理强度</span><CompactSelect options={[{ value: '', label: agentModels.data.defaultReasoningEffort ? `使用模型默认强度 (${agentModels.data.defaultReasoningEffort})` : '使用模型默认强度' }, ...agentModels.data.reasoningEfforts.map(item => ({ value: item.id, label: item.name }))]} value={reasoningEffort} placeholder="选择推理强度" disabledText="" onChange={setReasoningEffort}/></div>}</div></details></fieldset>
    </div>
    {create.error && <p role="alert" className="mt-3 text-xs text-[var(--status-danger)]">{createdSession ? `任务已创建，但目标发送失败：${create.error.message}。再次提交只会重试发送，不会重复创建任务。` : create.error.message}</p>}<div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-[var(--border-strong)] px-3.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">取消</button><button type="submit" disabled={submitDisabled} className="min-h-10 min-w-24 rounded-lg bg-[var(--action-primary)] px-3.5 text-xs font-semibold text-[var(--text-on-action)] hover:bg-[var(--action-primary-hover)] disabled:opacity-50">{create.isPending ? <RefreshCw className="mx-auto animate-spin" size={14}/> : createdSession ? '重试发送' : '创建并执行'}</button></div>
  </form></div>;
}
