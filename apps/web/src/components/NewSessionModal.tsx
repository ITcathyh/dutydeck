import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, RefreshCw, X } from 'lucide-react';
import { api, type Agent, type Session } from '../api';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';
import { IconButton } from './ui';
import { AgentSelect, CompactSelect } from './CompactSelect';

export type NewSessionModalProps = {
  open: boolean;
  onClose(): void;
  onCreated(session: Session): void;
  agents: Agent[];
  capabilities?: { platform: string; directoryPicker: boolean; filePicker: boolean };
};

export function NewSessionModal({ open, onClose, onCreated, agents, capabilities }: NewSessionModalProps) {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState('codex');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const agentModels = useQuery({ queryKey: agentModelsQueryKey(agentId, model), queryFn: () => loadAgentModels(agentId, model || undefined), enabled: open && Boolean(agentId), initialData: () => readCachedAgentModels(agentId, model || undefined), initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 5 * 60_000 });
  useEffect(() => {
    if (!agentModels.data || agentModels.isFetching || !reasoningEffort) return;
    if (!agentModels.data.reasoningEfforts.some(option => option.id === reasoningEffort)) setReasoningEffort('');
  }, [agentModels.data, agentModels.isFetching, reasoningEffort]);
  useEffect(() => { if (agents.length && !agents.some(agent => agent.id === agentId)) setAgentId(agents[0].id); }, [agents, agentId]);
  const create = useMutation({
    mutationFn: () => api.create({ agentId, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) }),
    onSuccess: session => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      onCreated(session);
    }
  });
  const pickNewWorkspace = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => setCwd(result.path) });
  if (!open) return null;  return <div className="ui-overlay fixed inset-0 z-20 grid place-items-center bg-zinc-950/30 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><form onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }} className="ui-dialog w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_24px_80px_rgba(24,24,27,.2)]"><div className="flex items-center"><div><h2 className="text-base font-semibold">新建 Session</h2><p className="mt-1 text-xs text-zinc-500">选择 Agent 和工作目录。</p></div><span className="ml-auto"><IconButton label="关闭" onClick={onClose}><X size={16}/></IconButton></span></div>
    <div className="mt-5 space-y-4"><div><span className="text-xs font-medium text-zinc-700">Agent</span><AgentSelect agents={agents} value={agentId} onChange={value => { setAgentId(value); setModel(''); setReasoningEffort(''); }}/></div><div><span className="text-xs font-medium text-zinc-700">模型 <span className="font-normal text-zinc-400">可选</span></span>{!agentModels.data && (agentModels.isLoading || agentModels.isFetching) ? <div className="mt-1.5 flex h-10 items-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-400"><RefreshCw size={13} className="mr-2 animate-spin"/>正在通过 ACP 查询模型</div> : <CompactSelect options={[{ value: '', label: agentModels.data?.defaultModel ? `使用 Agent 默认模型 (${agentModels.data.defaultModel})` : '使用 Agent 默认模型' }, ...(agentModels.data?.models ?? []).map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))]} value={model} placeholder="选择模型" disabledText="使用 Agent 默认模型" onChange={value => { setModel(value); setReasoningEffort(''); }}/>}</div>{agentModels.data?.source === 'acp' && agentModels.data.reasoningEfforts.length > 0 && <div><span className="text-xs font-medium text-zinc-700">推理强度 <span className="font-normal text-zinc-400">可选</span></span><CompactSelect options={[{ value: '', label: agentModels.data.defaultReasoningEffort ? `使用模型默认强度 (${agentModels.data.defaultReasoningEffort})` : '使用模型默认强度' }, ...agentModels.data.reasoningEfforts.map(item => ({ value: item.id, label: item.name }))]} value={reasoningEffort} placeholder="选择推理强度" disabledText="" onChange={setReasoningEffort}/></div>}<label className="block"><span className="text-xs font-medium text-zinc-700">工作目录</span><span className="mt-1.5 flex gap-2"><input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="留空则使用 Agent 默认目录" className="h-10 min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-500"/><button type="button" disabled={!capabilities?.directoryPicker || pickNewWorkspace.isPending} onClick={() => pickNewWorkspace.mutate()} className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"><FolderOpen size={14}/>{capabilities?.directoryPicker ? '选择' : '仅支持 Mac'}</button></span>{pickNewWorkspace.error && <p className="mt-1.5 text-xs text-red-600">{pickNewWorkspace.error.message}</p>}</label>
    </div>
    {create.error && <p className="mt-3 text-xs text-red-600">{create.error.message}</p>}<div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-zinc-300 px-3.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50">取消</button><button type="submit" disabled={create.isPending} className="min-w-20 rounded-lg bg-zinc-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50">{create.isPending ? <RefreshCw className="mx-auto animate-spin" size={14}/> : '创建'}</button></div>
  </form></div>;
}
