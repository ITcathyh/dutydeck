import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, LockKeyhole, MessageSquare, RefreshCw, ShieldAlert, Users, X } from 'lucide-react';
import { ApiError, foundationApi, type GroupMatrixCell, type PublicSecretRef } from '../api';
import type { GroupBinding, PublicChannelBotFoundation, UpdateGroupBindingInput } from '@dockmux/shared';
import { IconButton } from './ui';

type Draft = {
  bindingId: string;
  expectedRevision: number;
  oncall: boolean;
  groupReplyMode: 'inherit' | 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  mentionPolicy: 'inherit' | 'always' | 'topic' | 'never' | 'ambient';
  read: 'inherit' | 'allow' | 'deny';
  discover: 'inherit' | 'allow' | 'deny';
  send: 'inherit' | 'allow' | 'deny';
};

function draftFromBinding(binding: GroupBinding): Draft {
  return {
    bindingId: binding.id,
    expectedRevision: binding.revision,
    oncall: binding.oncall,
    groupReplyMode: binding.routingOverride.groupReplyMode.mode === 'inherit' ? 'inherit' : binding.routingOverride.groupReplyMode.value,
    mentionPolicy: binding.routingOverride.mentionPolicy.mode === 'inherit' ? 'inherit' : binding.routingOverride.mentionPolicy.value,
    read: binding.groupToolsOverride.read,
    discover: binding.groupToolsOverride.discover,
    send: binding.groupToolsOverride.send
  };
}

function bindingUpdate(draft: Draft): UpdateGroupBindingInput {
  return {
    expectedRevision: draft.expectedRevision,
    oncall: draft.oncall,
    routingOverride: {
      groupReplyMode: draft.groupReplyMode === 'inherit' ? { mode: 'inherit' } : { mode: 'set', value: draft.groupReplyMode },
      mentionPolicy: draft.mentionPolicy === 'inherit' ? { mode: 'inherit' } : { mode: 'set', value: draft.mentionPolicy }
    },
    groupToolsOverride: { read: draft.read, discover: draft.discover, send: draft.send }
  };
}

const labelByMembership = { member: 'Bot 已在群中', not_member: 'Bot 不在群中', inaccessible: '无法读取群状态', unknown: '群状态未知' } as const;
const labelByTool = { inherit: '继承 Bot 默认', allow: '群级允许', deny: '群级禁止' } as const;

function CellCard({ cell, writesEnabled, creating, createError, onCreate, onEdit }: { cell: GroupMatrixCell; writesEnabled: boolean; creating: boolean; createError?: Error; onCreate(): void; onEdit(binding: GroupBinding): void }) {
  const displayName = cell.remoteFact?.displayName ?? cell.externalChatId;
  return <article className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-4 shadow-[var(--shadow-card)]">
    <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--status-info-soft)] text-[var(--status-info)]"><Users size={16}/></span><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[var(--text-primary)]">{displayName}</div><div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]">{cell.externalChatId}</div></div><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${cell.severity === 'blocked' ? 'bg-[var(--status-danger-soft)] text-[var(--status-danger)]' : 'bg-[var(--surface-muted)] text-[var(--text-secondary)]'}`}>{cell.desiredPolicy ? '已配置 · 未接管' : '未配置'}</span></div>
    <div className="mt-3 grid gap-2 text-xs text-[var(--text-secondary)] sm:grid-cols-2">
      <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2"><div className="text-[10px] font-semibold text-[var(--text-muted)]">远端事实</div><div className="mt-1">{cell.remoteFact ? labelByMembership[cell.remoteFact.membershipState] : '尚无同步事实'}</div></div>
      <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2"><div className="text-[10px] font-semibold text-[var(--text-muted)]">路由策略</div><div className="mt-1">回复 {cell.effectiveSummary?.routing.groupReplyMode.value ?? '未解析'} · 提及 {cell.effectiveSummary?.routing.mentionPolicy.value ?? '未解析'}</div></div>
      <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2"><div className="text-[10px] font-semibold text-[var(--text-muted)]">权限来源</div><div className="mt-1">talk: {cell.permissionSummary.talkSource} · operate: {cell.permissionSummary.canOperateAssignments} · admin: {cell.permissionSummary.adminAssignments}</div></div>
      <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2"><div className="text-[10px] font-semibold text-[var(--text-muted)]">群工具</div><div className="mt-1">read {cell.effectiveSummary?.groupTools.read.allowed ? '允许' : '禁止'} · send {cell.effectiveSummary?.groupTools.send.allowed ? '允许' : '禁止'}</div></div>
    </div>
    {cell.blockers.length > 0 && <div className="mt-3 space-y-1.5">{cell.blockers.map(blocker => <div key={blocker.code} className="flex items-start gap-2 rounded-lg bg-[var(--status-warning-soft)] px-3 py-2 text-[11px] leading-4 text-[var(--status-warning)]"><AlertTriangle size={13} className="mt-0.5 shrink-0"/><span><strong>{blocker.code}</strong><br/>下一步：{blocker.action}</span></div>)}</div>}
    {createError && <p role="alert" className="mt-3 text-[11px] text-[var(--status-danger)]">{createError instanceof ApiError && createError.status === 403 ? '需要 owner/admin 权限才能创建绑定。' : `创建失败：${createError.message}`}</p>}
    <div className="mt-3 flex justify-end"><button type="button" disabled={!writesEnabled || creating} title={!writesEnabled ? '需要接入管理权限 evaluator' : undefined} onClick={() => cell.desiredPolicy ? onEdit(cell.desiredPolicy) : onCreate()} className="rounded-lg border border-[var(--border-strong)] px-3 py-2 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-45">{cell.desiredPolicy ? '编辑群策略' : creating ? '正在创建…' : '配置此群'}</button></div>
  </article>;
}

function SecretRefSelector({ bot, refs, writesEnabled, pending, error, conflict, onSave }: {
  bot: PublicChannelBotFoundation;
  refs: PublicSecretRef[];
  writesEnabled: boolean;
  pending: boolean;
  error?: Error;
  conflict?: PublicChannelBotFoundation;
  onSave(secretRefId: string | undefined, expectedRevision: number): void;
}) {
  const [selected, setSelected] = useState(bot.selectedSecretRefId ?? '');
  useEffect(() => setSelected(bot.selectedSecretRefId ?? ''), [bot.selectedSecretRefId, bot.revision]);
  const eligible = refs.filter(ref => ref.kind === 'lark_app_secret');
  return <div className="mb-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-muted)] px-3 py-3">
    <div className="flex flex-wrap items-end gap-2"><label className="min-w-56 flex-1 text-[11px] font-semibold text-[var(--text-secondary)]"><span>SecretRef（仅 metadata）</span><select aria-label={`${bot.displayName} SecretRef`} value={selected} disabled={!writesEnabled || pending} onChange={event => setSelected(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-2 text-xs"><option value="">不绑定 SecretRef</option>{eligible.map(ref => <option key={ref.id} value={ref.id} disabled={ref.status !== 'configured' || ref.availability !== 'available'}>{ref.id} · {ref.status}/{ref.availability}</option>)}</select></label><button type="button" disabled={!writesEnabled || pending || selected === (bot.selectedSecretRefId ?? '')} onClick={() => onSave(selected || undefined, bot.revision)} className="h-9 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3 text-xs font-semibold text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-45">{pending ? '保存中…' : '保存引用'}</button></div>
    {eligible.length === 0 && <p className="mt-2 text-[11px] text-[var(--status-warning)]">尚无 Lark SecretRef。请在远程机终端运行 <code>dockmux secret set &lt;id&gt; --value-fd 0</code>；不要在 Web 粘贴凭据。</p>}
    {error && <p role="alert" className="mt-2 text-[11px] text-[var(--status-danger)]">{conflict ? <>Bot 配置已变化到 revision {conflict.revision}；你的 SecretRef 选择仍保留。<button type="button" onClick={() => onSave(selected || undefined, conflict.revision)} className="ml-2 font-semibold underline">基于新版本重试</button></> : error instanceof ApiError && error.status === 403 ? '需要 owner/admin 权限才能保存引用。' : `SecretRef 保存失败：${error.message}`}</p>}
  </div>;
}

export function GroupPolicyModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const queryClient = useQueryClient();
  const capabilities = useQuery({ queryKey: ['foundation-capabilities'], queryFn: foundationApi.capabilities, enabled: open, retry: false });
  const matrix = useQuery({ queryKey: ['foundation-group-matrix'], queryFn: foundationApi.groupMatrix, enabled: open && capabilities.data?.repositoriesWired === true, retry: false });
  const secretRefs = useQuery({ queryKey: ['foundation-secret-refs'], queryFn: foundationApi.secretRefs, enabled: open && capabilities.data?.repositoriesWired === true, retry: false });
  const [draft, setDraft] = useState<Draft>();
  const [conflict, setConflict] = useState<GroupBinding>();
  const [botConflicts, setBotConflicts] = useState<Record<string, PublicChannelBotFoundation>>({});
  const save = useMutation({
    mutationFn: (current: Draft) => foundationApi.updateGroupBinding(current.bindingId, bindingUpdate(current)),
    onSuccess: async () => { setDraft(undefined); setConflict(undefined); await queryClient.invalidateQueries({ queryKey: ['foundation-group-matrix'] }); },
    onError: error => {
      if (error instanceof ApiError && error.code === 'FOUNDATION_REVISION_CONFLICT' && error.current) setConflict(error.current as GroupBinding);
    }
  });
  const saveBotSecret = useMutation({
    mutationFn: ({ botId, expectedRevision, secretRefId }: { botId: string; expectedRevision: number; secretRefId?: string }) => foundationApi.updateChannelBot(botId, { expectedRevision, credentialRef: secretRefId ?? null }),
    onSuccess: async (_value, variables) => { setBotConflicts(current => { const next = { ...current }; delete next[variables.botId]; return next; }); await Promise.all([queryClient.invalidateQueries({ queryKey: ['foundation-group-matrix'] }), queryClient.invalidateQueries({ queryKey: ['foundation-secret-refs'] })]); },
    onError: (error, variables) => {
      if (error instanceof ApiError && error.code === 'FOUNDATION_REVISION_CONFLICT' && error.current) setBotConflicts(current => ({ ...current, [variables.botId]: error.current as PublicChannelBotFoundation }));
    }
  });
  const createBinding = useMutation({
    mutationFn: ({ channelBotId, externalChatId }: { channelBotId: string; externalChatId: string }) => foundationApi.createGroupBinding({
      id: `group-binding-${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
      channelBotId,
      externalChatId
    }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['foundation-group-matrix'] }); }
  });
  useEffect(() => { if (!open) { setDraft(undefined); setConflict(undefined); setBotConflicts({}); save.reset(); } }, [open]);
  if (!open) return null;
  const capability = capabilities.data;
  const permissionBlocked = capability && !capability.permissionEvaluatorWired;
  return <div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-[var(--overlay-scrim)] p-3 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section role="dialog" aria-label="群配置与权限" className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] shadow-[var(--shadow-overlay)]">
      <header className="flex items-start gap-3 border-b border-[var(--border-default)] px-5 py-4"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--action-soft)] text-[var(--action-primary)]"><MessageSquare size={18}/></span><div className="min-w-0 flex-1"><div className="text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--action-primary)]">Offline management</div><h2 className="mt-1 text-base font-semibold text-[var(--text-primary)]">群配置与权限</h2><p className="mt-1 text-xs text-[var(--text-muted)]">仅编辑 staged/disabled 策略；不会启动飞书监听或接管消息。</p></div><IconButton label="关闭群配置" onClick={onClose}><X size={16}/></IconButton></header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {capabilities.isLoading && <div role="status" className="flex min-h-40 items-center justify-center text-sm text-[var(--text-muted)]"><RefreshCw size={15} className="mr-2 animate-spin"/>正在读取管理能力…</div>}
        {capabilities.isError && <div role="alert" className="rounded-xl border border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] p-4 text-sm text-[var(--status-danger)]">无法读取群策略能力：{capabilities.error.message}<button type="button" onClick={() => void capabilities.refetch()} className="ml-3 underline">重试</button></div>}
        {capability && <div className={`rounded-xl border p-4 ${capability.runtimeWired ? 'border-[var(--action-soft-hover)] bg-[var(--action-soft)]' : 'border-[var(--status-warning-border)] bg-[var(--status-warning-soft)]'}`}><div className="flex items-center gap-2 text-sm font-semibold text-[var(--status-warning)]"><LockKeyhole size={15}/>尚未接入运行时</div><p className="mt-1 text-xs leading-5 text-[var(--status-warning)]">策略可以离线查看和校验，但生产消息、终端和 Agent 执行入口保持 fail-closed。</p><div className="mt-2 flex flex-wrap gap-2">{capability.blockers.map(blocker => <span key={blocker.code} title={blocker.action} className="rounded-full bg-[var(--surface-default)] px-2 py-1 text-[10px] font-medium text-[var(--status-warning)]">{blocker.message} · {blocker.action}</span>)}</div></div>}
        {permissionBlocked && <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] p-4 text-xs leading-5 text-[var(--status-danger)]"><ShieldAlert size={15} className="mt-0.5 shrink-0"/><span><strong>编辑已禁用：缺少 owner/admin 权限解析。</strong><br/>下一步：由 WP1b 接入统一 permission evaluator；当前草稿不会提交。</span></div>}
        {capability && !capability.secretInspectorWired && <div role="alert" className="mt-3 rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-soft)] p-4 text-xs text-[var(--status-warning)]"><strong>SecretRef 选择已禁用：</strong>metadata-only 文件可用性检查尚未接入；Web 不会尝试解析或测试凭据值。</div>}
        {capability?.repositoriesWired === false && <div className="mt-4 rounded-xl border border-dashed border-[var(--border-strong)] p-6 text-center"><Bot size={22} className="mx-auto text-[var(--text-muted)]"/><h3 className="mt-3 text-sm font-semibold text-[var(--text-primary)]">群策略仓储尚未接入运行时</h3><p className="mt-1 text-xs text-[var(--text-muted)]">下一步：完成 WP1b repository wiring 后重新打开此页面。</p></div>}
        {matrix.isLoading && <div role="status" className="mt-4 text-center text-sm text-[var(--text-muted)]">正在加载群配置矩阵…</div>}
        {matrix.isError && <div role="alert" className="mt-4 rounded-xl border border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] p-4 text-sm text-[var(--status-danger)]">群配置读取失败：{matrix.error.message}<button type="button" onClick={() => void matrix.refetch()} className="ml-3 underline">重试</button></div>}
        {secretRefs.isError && <div role="alert" className="mt-4 rounded-xl border border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] p-4 text-sm text-[var(--status-danger)]">SecretRef metadata 读取失败；请在远程机运行 <code>dockmux secret list</code> 检查。</div>}
        {matrix.data?.bots.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-[var(--border-strong)] p-6 text-center text-sm text-[var(--text-muted)]">尚无 staged/disabled ChannelBot。先通过管理 API 创建安全草稿；此页面不会创建或启用 listener。</div>}
        <div className="mt-4 space-y-5">{matrix.data?.bots.map(entry => <section key={entry.bot.id}><div className="mb-2 flex items-center gap-2"><Bot size={15} className="text-[var(--text-muted)]"/><h3 className="text-sm font-semibold text-[var(--text-primary)]">{entry.bot.displayName}</h3><span className="rounded-full bg-[var(--surface-muted)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">{entry.bot.state} · rev {entry.bot.revision}</span><span className={`rounded-full px-2 py-1 text-[10px] ${entry.bot.credentialStatus === 'configured' ? 'bg-[var(--status-success-soft)] text-[var(--status-success)]' : 'bg-[var(--status-danger-soft)] text-[var(--status-danger)]'}`}>凭据 {entry.bot.credentialStatus}</span></div>{entry.bot.credentialStatus !== 'configured' && <div className="mb-3 rounded-lg bg-[var(--status-danger-soft)] px-3 py-2 text-xs text-[var(--status-danger)]"><strong>Bot 保持禁用：</strong>{entry.bot.credentialStatus === 'unreadable' ? '所选 SecretRef 文件缺失或不可读。下一步：在远程机运行 dockmux secret list 检查，并用 rotate 修复。' : '缺少可用 SecretRef。下一步：选择已配置且可读的 SecretRef。'} 此页面不会读取、测试或回显 App Secret。</div>}<SecretRefSelector bot={entry.bot} refs={secretRefs.data?.secretRefs ?? []} writesEnabled={Boolean(capability?.writesEnabled && capability.secretInspectorWired)} pending={saveBotSecret.isPending && saveBotSecret.variables?.botId === entry.bot.id} error={saveBotSecret.variables?.botId === entry.bot.id ? saveBotSecret.error ?? undefined : undefined} conflict={botConflicts[entry.bot.id]} onSave={(secretRefId, expectedRevision) => saveBotSecret.mutate({ botId: entry.bot.id, expectedRevision, secretRefId })}/><div className="grid gap-3 lg:grid-cols-2">{entry.cells.map(cell => { const creatingThis = createBinding.isPending && createBinding.variables?.channelBotId === entry.bot.id && createBinding.variables.externalChatId === cell.externalChatId; const failedThis = createBinding.isError && createBinding.variables?.channelBotId === entry.bot.id && createBinding.variables.externalChatId === cell.externalChatId; return <CellCard key={cell.externalChatId} cell={cell} writesEnabled={Boolean(capability?.writesEnabled)} creating={creatingThis} createError={failedThis ? createBinding.error : undefined} onCreate={() => createBinding.mutate({ channelBotId: entry.bot.id, externalChatId: cell.externalChatId })} onEdit={binding => { setDraft(draftFromBinding(binding)); setConflict(undefined); save.reset(); }}/>; })}</div></section>)}</div>
      </div>
      {draft && <form onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(draft); }} className="border-t border-[var(--border-default)] bg-[var(--surface-default)] px-5 py-4"><div className="flex items-center"><div><h3 className="text-sm font-semibold text-[var(--text-primary)]">编辑群策略</h3><p className="mt-0.5 text-[11px] text-[var(--text-muted)]">基于 revision {draft.expectedRevision}；保存后 Bot 仍保持 disabled。</p></div><button type="button" onClick={() => { setDraft(undefined); setConflict(undefined); }} className="ml-auto text-xs text-[var(--text-muted)]">取消</button></div>
        {conflict && <div role="alert" className="mt-3 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-soft)] px-3 py-2 text-xs leading-5 text-[var(--status-warning)]"><strong>配置已被其他修改覆盖。</strong>当前版本是 revision {conflict.revision}；你的草稿仍保留。<button type="button" onClick={() => setDraft(current => current ? { ...current, expectedRevision: conflict.revision } : current)} className="ml-2 font-semibold underline">基于新版本重试</button></div>}
        {save.error && !conflict && <div role="alert" className="mt-3 rounded-lg bg-[var(--status-danger-soft)] px-3 py-2 text-xs text-[var(--status-danger)]">{save.error instanceof ApiError && save.error.status === 403 ? '需要 owner/admin 权限才能保存。下一步：检查权限分配或接入 evaluator。' : `保存失败：${save.error.message}`}</div>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><label className="text-xs text-[var(--text-secondary)]"><span>回复模式</span><select value={draft.groupReplyMode} onChange={event => setDraft({ ...draft, groupReplyMode: event.target.value as Draft['groupReplyMode'] })} className="mt-1 h-9 w-full rounded-lg border border-[var(--border-strong)] px-2"><option value="inherit">继承</option><option value="chat">chat</option><option value="shared">shared</option><option value="new-topic">new-topic</option><option value="chat-topic">chat-topic</option></select></label><label className="text-xs text-[var(--text-secondary)]"><span>提及策略</span><select value={draft.mentionPolicy} onChange={event => setDraft({ ...draft, mentionPolicy: event.target.value as Draft['mentionPolicy'] })} className="mt-1 h-9 w-full rounded-lg border border-[var(--border-strong)] px-2"><option value="inherit">继承</option><option value="always">always</option><option value="topic">topic</option><option value="never">never</option><option value="ambient">ambient</option></select></label>{(['read', 'discover', 'send'] as const).map(tool => <label key={tool} className="text-xs text-[var(--text-secondary)]"><span>群工具 {tool}</span><select value={draft[tool]} onChange={event => setDraft({ ...draft, [tool]: event.target.value as Draft[typeof tool] })} className="mt-1 h-9 w-full rounded-lg border border-[var(--border-strong)] px-2">{Object.entries(labelByTool).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>)}</div>
        <label className="mt-3 flex items-center gap-2 text-xs text-[var(--text-secondary)]"><input type="checkbox" checked={draft.oncall} onChange={event => setDraft({ ...draft, oncall: event.target.checked })}/>oncall 群成员只获得 can_talk，不获得 operate/admin</label>
        <div className="mt-3 flex justify-end"><button type="submit" disabled={save.isPending || !capability?.writesEnabled} className="rounded-lg bg-[var(--surface-inverse)] px-4 py-2 text-xs font-semibold text-[var(--text-inverse)] disabled:cursor-not-allowed disabled:opacity-40">{save.isPending ? '保存中…' : '保存禁用态策略'}</button></div>
      </form>}
    </section>
  </div>;
}
