import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, type Agent, type PermissionMode, type Session, type Task } from '../api';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';
import { permissionLabels } from './ui';
import { Banner, Button, Dialog, IconButton, Spinner, Textarea, Field } from './primitives';
import { AgentSelect, CompactSelect } from './CompactSelect';
import { DirectoryPicker } from './DirectoryPicker';
import { currentInstance } from '../instance';
import { newSessionDrafts } from '../new-session-drafts';

export type NewSessionModalProps = {
  open: boolean;
  onClose(): void;
  onOpenAgentSetup?(): void;
  agents: Agent[];
  initialAgentId?: string;
  capabilities?: { platform: string; directoryPicker: boolean; filePicker: boolean };
} & ({ mode?: 'task'; onCreated(session: Session, task: Task): void; onSessionCreated?: never }
  | { mode: 'schedule'; onSessionCreated(session: Session): void; onCreated?: never });

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

export function NewSessionModal({ open, onClose, onOpenAgentSetup, onCreated, onSessionCreated, mode = 'task', agents, initialAgentId, capabilities }: NewSessionModalProps) {
  const qc = useQueryClient();
  const draftKey = `${currentInstance() ?? '@local'}:${mode}`;
  const [draft] = useState(() => {
    const saved = newSessionDrafts.get(draftKey);
    return initialAgentId && saved?.agentId !== initialAgentId ? undefined : saved;
  });
  const completed = useRef(false);
  const [agentId, setAgentId] = useState(initialAgentId ?? draft?.agentId ?? 'codex');
  const [cwd, setCwd] = useState(draft?.cwd ?? '');
  const [workspaceMode, setWorkspaceMode] = useState<'shared' | 'worktree'>(draft?.workspaceMode ?? 'worktree');
  const [model, setModel] = useState(draft?.model ?? '');
  const [codexProfile, setCodexProfile] = useState(draft?.codexProfile ?? '');
  const [reasoningEffort, setReasoningEffort] = useState(draft?.reasoningEffort ?? '');
  const selectedAgent = agents.find(agent => agent.id === agentId);
  const legacyPtyUnsupported = isLegacyPtyAgent(selectedAgent);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => draft?.permissionMode ?? initialPermissionMode(agents.find(agent => agent.id === (initialAgentId ?? 'codex')) ?? agents[0]));
  const [fullTrustConfirmed, setFullTrustConfirmed] = useState(Boolean(draft?.createdSession));
  const [goal, setGoal] = useState(draft?.goal ?? '');
  const [createdSession, setCreatedSession] = useState<Session | undefined>(draft?.createdSession);
  const latestDraft = useRef({ agentId, cwd, workspaceMode, model, reasoningEffort, permissionMode, goal, createdSession });
  latestDraft.current = { agentId, cwd, workspaceMode, model, codexProfile, reasoningEffort, permissionMode, goal, createdSession };
  useEffect(() => () => {
    if (!completed.current) newSessionDrafts.set(draftKey, latestDraft.current);
  }, [draftKey]);
  const agentModels = useQuery({ queryKey: agentModelsQueryKey(agentId, model), queryFn: () => loadAgentModels(agentId, model || undefined), enabled: open && Boolean(selectedAgent) && !legacyPtyUnsupported, initialData: () => readCachedAgentModels(agentId, model || undefined), initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 5 * 60_000 });
  useEffect(() => {
    if (!agentModels.data || agentModels.isFetching || !reasoningEffort) return;
    if (!agentModels.data.reasoningEfforts.some(option => option.id === reasoningEffort)) setReasoningEffort('');
  }, [agentModels.data, agentModels.isFetching, reasoningEffort]);
  useEffect(() => {
    if (!agents.length || agents.some(agent => agent.id === agentId)) return;
    const fallback = agents.find(agent => !isLegacyPtyAgent(agent)) ?? agents[0];
    setAgentId(fallback.id);
    setPermissionMode(initialPermissionMode(fallback));
    setModel(''); setReasoningEffort('');
    setFullTrustConfirmed(false);
  }, [agents, agentId]);
  const create = useMutation({
    mutationFn: async () => {
      const session = createdSession ?? await api.create({ agentId, permissionMode, workspaceMode, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(codexProfile ? { codexProfile } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
      if (!createdSession) setCreatedSession(session);
      if (mode === 'schedule') return { session, task: undefined };
      const result = await api.send(session.id, goal.trim(), 'queue');
      return { session, task: result.task };
    },
    onSuccess: ({ session, task }) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      if (task) qc.setQueryData<Task[]>(['tasks', session.id], [task]);
      completed.current = true; newSessionDrafts.delete(draftKey);
      setCreatedSession(undefined); setGoal('');
      if (task) onCreated?.(session, task);
      else onSessionCreated?.(session);
    }
  });
  if (!open) return null;

  if (agents.length === 0) return <Dialog open onClose={onClose} label="需要先准备 Agent" size="sm" closeOnEscape={!create.isPending} closeOnScrim={!create.isPending}>
    <Dialog.Header>
      <h2 className="text-title font-semibold text-primary">先准备一个 Agent</h2>
      <span className="ml-auto"><IconButton label="关闭" onClick={onClose} disabled={create.isPending}><X size={16}/></IconButton></span>
    </Dialog.Header>
    <Dialog.Body>Dutydeck 没有检测到可用的 Agent CLI。安装并登录 Codex、Claude Code 等 CLI 后重启 Dutydeck，再回来创建任务。</Dialog.Body>
    <Dialog.Footer>
      <Button variant="secondary" onClick={onClose} disabled={create.isPending}>稍后再说</Button>
      <Button variant="primary" onClick={onOpenAgentSetup ?? onClose} disabled={create.isPending}>查看添加方法</Button>
    </Dialog.Footer>
  </Dialog>;

  const submitDisabled = create.isPending || legacyPtyUnsupported || !selectedAgent || (mode === 'task' && !goal.trim()) || (permissionMode === 'full-trust' && !fullTrustConfirmed);
  // 提交进行中禁用所有关闭入口：会把一个已经发出的写操作丢在半路（契约 §8.1）。
  return <Dialog open onClose={onClose} label={mode === 'schedule' ? '创建定时任务' : '创建新任务'} size="sm" closeOnEscape={!create.isPending} closeOnScrim={!create.isPending}>
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); if (!submitDisabled) create.mutate(); }} className="flex min-h-0 flex-1 flex-col">
      <Dialog.Header>
        <div>
          <h2 className="text-title font-semibold text-primary">{mode === 'schedule' ? '创建定时任务' : '创建新任务'}</h2>
          <p className="mt-1 text-caption text-subtle">{mode === 'schedule' ? '先准备运行环境，再填写执行指令与时间。会启动空闲 Agent，保存计划后需另行启用。' : '写清目标即可开始；模型和推理强度可以使用 Agent 默认值。'}</p>
        </div>
        <span className="ml-auto"><IconButton label="关闭" onClick={onClose} disabled={create.isPending}><X size={16}/></IconButton></span>
      </Dialog.Header>
      <Dialog.Body>
        <div className="space-y-4">
          {mode === 'task' && <Field label="任务目标">
            <Textarea autoFocus required aria-label="任务目标" value={goal} disabled={create.isPending} onChange={event => setGoal(event.target.value)} rows={3} placeholder="例如：修复登录超时问题，补齐回归测试并通过构建" className="resize-y"/>
          </Field>}
          <DirectoryPicker
            value={cwd}
            onChange={setCwd}
            label="工作目录"
            description="填写运行 Dutydeck 的这台机器上的目录；留空会使用 Agent 的默认工作区。"
            placeholder="留空则使用 Agent 默认目录"
            allowNative={Boolean(capabilities?.directoryPicker)}
            disabled={create.isPending || Boolean(createdSession)}
          />
          <fieldset disabled={create.isPending || Boolean(createdSession)} className="contents disabled:opacity-60">
            <SelectField label="工作目录方式">
              <CompactSelect value={workspaceMode} options={[{ value: 'worktree', label: '独立 Git 工作目录', meta: '从当前提交创建分支；后续追问复用，不带入未提交改动' }, { value: 'shared', label: '直接使用所选目录', meta: '适用于非 Git 目录，或需要使用现有未提交改动' }]} onChange={value => setWorkspaceMode(value as 'shared' | 'worktree')} placeholder="选择工作目录方式" disabledText=""/>
            </SelectField>
            <SelectField label="执行任务的 Agent">
              <AgentSelect agents={agents} value={agentId} onChange={value => { const nextAgent = agents.find(agent => agent.id === value); setAgentId(value); setPermissionMode(initialPermissionMode(nextAgent)); setFullTrustConfirmed(false); setModel(''); setCodexProfile(''); setReasoningEffort(''); }}/>
            </SelectField>
            <div>
              {!legacyPtyUnsupported && <SelectField label="操作权限">
                <CompactSelect options={supportedPermissionModes(selectedAgent).map(value => ({ value, ...permissionOptions[value] }))} value={permissionMode} placeholder="选择操作权限" disabledText="" onChange={value => { setPermissionMode(value as PermissionMode); setFullTrustConfirmed(false); }}/>
              </SelectField>}
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
                {(agentModels.data?.profiles?.length ?? 0) > 0 && <SelectField label="Codex profile">
                  <CompactSelect options={[{ value: '', label: '使用 Agent 默认 profile' }, ...(agentModels.data?.profiles ?? []).map(item => ({ value: item.id, label: item.name }))]} value={codexProfile} placeholder="选择 profile" disabledText="使用 Agent 默认 profile" onChange={setCodexProfile}/>
                </SelectField>}
                {agentModels.data?.source === 'acp' && agentModels.data.reasoningEfforts.length > 0 && <SelectField label="推理强度">
                  <CompactSelect options={[{ value: '', label: agentModels.data.defaultReasoningEffort ? `使用模型默认强度 (${agentModels.data.defaultReasoningEffort})` : '使用模型默认强度' }, ...agentModels.data.reasoningEfforts.map(item => ({ value: item.id, label: item.name }))]} value={reasoningEffort} placeholder="选择推理强度" disabledText="" onChange={setReasoningEffort}/>
                </SelectField>}
              </div>
            </details>
          </fieldset>
          {legacyPtyUnsupported && <Banner tone="danger">旧 PTY 兼容协议无法提供可靠的权限控制或交互审批。请在上方改选 ACP 或 PTY CLI Agent。{onOpenAgentSetup && <Button disabled={create.isPending} onClick={onOpenAgentSetup}>查看添加方法</Button>}</Banner>}
          <p className="text-caption text-subtle">关闭后保留本次填写内容，直到创建成功；草稿仅保留在当前页面，刷新后清除。</p>
          {create.error && <Banner tone="danger">{createdSession ? `任务已创建，但目标发送失败：${create.error.message}。再次提交只会重试发送，不会重复创建任务。` : <>{create.error.message}<p className="mt-2">请检查所选 Agent 和工作目录；可用「浏览」重新选目录。独立工作目录需要 Git 仓库，若要直接使用现有目录，请明确选择「直接使用所选目录」后重试。</p></>}</Banner>}
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>取消</Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={submitDisabled} className="min-w-24">{mode === 'schedule' ? '下一步：设置计划' : createdSession ? '重试发送' : '创建并执行'}</Button>
      </Dialog.Footer>
    </form>
  </Dialog>;
}
