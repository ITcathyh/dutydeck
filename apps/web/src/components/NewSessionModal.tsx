import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, RefreshCw, X } from 'lucide-react';
import { api, type Agent, type PermissionMode, type Session, type Task } from '../api';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';
import { IconButton } from './ui';
import { AgentSelect, CompactSelect } from './CompactSelect';

export type NewSessionModalProps = {
  open: boolean;
  onClose(): void;
  onCreated(session: Session, task: Task): void;
  agents: Agent[];
  capabilities?: { platform: string; directoryPicker: boolean; filePicker: boolean };
};

const permissionOptions: Record<PermissionMode, { label: string; meta: string }> = {
  ask: { label: '交互确认', meta: '遇到受控操作时询问' },
  'approve-reads': { label: '自动读取', meta: '读取自动放行，写操作询问' },
  'deny-all': { label: '全部拒绝', meta: '拒绝所有受控操作' },
  'full-trust': { label: '完全信任', meta: '不等待审批，风险最高' }
};

const isPtyCliAgent = (agent?: Agent) => agent?.protocol === 'pty-cli';
const isLegacyPtyAgent = (agent?: Agent) => agent?.protocol === 'pty';
const isPtyAgent = isPtyCliAgent;
const supportedPermissionModes = (agent?: Agent): PermissionMode[] => isLegacyPtyAgent(agent) ? [] : isPtyCliAgent(agent) ? ['ask', 'full-trust'] : ['ask', 'approve-reads', 'deny-all', 'full-trust'];
const initialPermissionMode = (agent?: Agent): PermissionMode => supportedPermissionModes(agent).includes(agent?.permissionMode ?? 'ask') ? (agent?.permissionMode ?? 'ask') : 'ask';

export function NewSessionModal({ open, onClose, onCreated, agents, capabilities }: NewSessionModalProps) {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState('codex');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const selectedAgent = agents.find(agent => agent.id === agentId);
  const legacyPtyUnsupported = isLegacyPtyAgent(selectedAgent);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => initialPermissionMode(agents.find(agent => agent.id === 'codex') ?? agents[0]));
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
  if (legacyPtyUnsupported) return <div className="ui-overlay fixed inset-0 z-20 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[2px]"><div role="dialog" aria-label="无法创建旧 PTY 任务" className="ui-dialog w-full max-w-md rounded-2xl border border-slate-200 bg-[var(--paper)] p-5 shadow-[0_24px_80px_rgba(15,23,42,.22)]"><div className="flex items-center"><h2 className="text-base font-semibold">无法创建任务</h2><span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span></div><p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">旧 PTY 兼容协议无法提供可靠的权限控制或交互审批，请改用 ACP 或 PTY CLI Agent。</p><div className="mt-5 flex justify-end"><button type="button" disabled className="rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white opacity-50">创建并执行</button></div></div></div>;
  return <div className="ui-overlay fixed inset-0 z-20 grid place-items-center bg-slate-950/35 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><form onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }} className="ui-dialog w-full max-w-md rounded-2xl border border-slate-200 bg-[var(--paper)] p-5 shadow-[0_24px_80px_rgba(15,23,42,.22)]"><div className="flex items-center"><div><div className="text-[9px] font-semibold uppercase tracking-[.14em] text-teal-700">New task</div><h2 className="mt-1 text-base font-semibold">创建任务运行</h2><p className="mt-1 text-xs text-zinc-500">选择工作区和执行该任务的 Agent。</p></div><span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span></div>
    <div className="mt-5 space-y-4"><label className="block"><span className="text-xs font-semibold text-slate-800">任务目标</span><textarea autoFocus required aria-label="任务目标" value={goal} onChange={event => setGoal(event.target.value)} rows={3} placeholder="例如：修复登录超时问题，补齐回归测试并通过构建" className="mt-1.5 w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm leading-6 outline-none placeholder:text-slate-400 focus:border-teal-600"/></label><fieldset disabled={Boolean(createdSession)} className="contents disabled:opacity-60"><div><span className="text-xs font-medium text-zinc-700">Agent</span><AgentSelect agents={agents} value={agentId} onChange={value => { const nextAgent = agents.find(agent => agent.id === value); setAgentId(value); setPermissionMode(initialPermissionMode(nextAgent)); setModel(''); setReasoningEffort(''); }}/></div><div><span className="text-xs font-medium text-zinc-700">模型 <span className="font-normal text-zinc-400">可选</span></span>{!agentModels.data && (agentModels.isLoading || agentModels.isFetching) ? <div className="mt-1.5 flex h-10 items-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-400"><RefreshCw size={13} className="mr-2 animate-spin"/>正在通过 ACP 查询模型</div> : <CompactSelect options={[{ value: '', label: agentModels.data?.defaultModel ? `使用 Agent 默认模型 (${agentModels.data.defaultModel})` : '使用 Agent 默认模型' }, ...(agentModels.data?.models ?? []).map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))]} value={model} placeholder="选择模型" disabledText="使用 Agent 默认模型" onChange={value => { setModel(value); setReasoningEffort(''); }}/>}</div>{agentModels.data?.source === 'acp' && agentModels.data.reasoningEfforts.length > 0 && <div><span className="text-xs font-medium text-zinc-700">推理强度 <span className="font-normal text-zinc-400">可选</span></span><CompactSelect options={[{ value: '', label: agentModels.data.defaultReasoningEffort ? `使用模型默认强度 (${agentModels.data.defaultReasoningEffort})` : '使用模型默认强度' }, ...agentModels.data.reasoningEfforts.map(item => ({ value: item.id, label: item.name }))]} value={reasoningEffort} placeholder="选择推理强度" disabledText="" onChange={setReasoningEffort}/></div>}<div><span className="text-xs font-medium text-zinc-700">权限姿态</span><CompactSelect options={supportedPermissionModes(selectedAgent).map(value => ({ value, ...permissionOptions[value] }))} value={permissionMode} placeholder="选择权限姿态" disabledText="" onChange={value => setPermissionMode(value as PermissionMode)}/>{isPtyAgent(selectedAgent) && permissionMode === 'ask' && <p className="mt-1.5 text-[11px] leading-4 text-amber-700">此 CLI 的权限确认在终端中完成；运行停住时可直接打开「终端」处理。</p>}{permissionMode === 'full-trust' && <p className="mt-1.5 text-[11px] leading-4 text-rose-700">完全信任会跳过 Agent 的操作确认，仅用于你信任的任务和工作目录。</p>}</div><label className="block"><span className="text-xs font-medium text-zinc-700">工作目录</span><span className="mt-1.5 flex gap-2"><input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="留空则使用 Agent 默认目录" className="h-10 min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-500"/><button type="button" disabled={!capabilities?.directoryPicker || pickNewWorkspace.isPending} onClick={() => pickNewWorkspace.mutate()} className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"><FolderOpen size={14}/>{capabilities?.directoryPicker ? '选择' : '仅支持 Mac'}</button></span>{pickNewWorkspace.error && <p className="mt-1.5 text-xs text-red-600">{pickNewWorkspace.error.message}</p>}</label></fieldset>
    </div>
    {create.error && <p role="alert" className="mt-3 text-xs text-red-600">{createdSession ? `任务运行已创建，但目标派发失败：${create.error.message}。再次提交只会重试派发。` : create.error.message}</p>}<div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-zinc-300 px-3.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50">取消</button><button type="submit" disabled={create.isPending || !goal.trim()} className="min-w-24 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-600 disabled:opacity-50">{create.isPending ? <RefreshCw className="mx-auto animate-spin" size={14}/> : createdSession ? '重试派发' : '创建并执行'}</button></div>
  </form></div>;
}
