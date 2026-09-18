import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, MessageSquare, Users, X } from 'lucide-react';
import { ApiError, foundationApi, type GroupMatrixCell, type PublicSecretRef } from '../api';
import type { GroupBinding, PublicChannelBotFoundation, UpdateGroupBindingInput } from '@dutydeck/shared';
import { Badge, Banner, Button, Card, Dialog, EmptyState, Field, IconButton, Select, Spinner } from './primitives';
import { CollaborationPanel } from './CollaborationPanel';

type CollaborationScopeTarget = {
  appId: string;
  chatId: string;
  groupName: string;
  botName: string;
};

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

/** 卡片内的 4 个只读事实块。标题是真元数据（text-meta），正文是辅助说明（text-caption）。 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rounded-md bg-muted px-3 py-2">
    <div className="text-meta font-semibold text-subtle">{label}</div>
    <div className="mt-1 text-caption text-secondary">{children}</div>
  </div>;
}

function CellCard({ cell, bot, writesEnabled, creating, createError, onCreate, onEdit, onOpenCollaboration }: { cell: GroupMatrixCell; bot: PublicChannelBotFoundation; writesEnabled: boolean; creating: boolean; createError?: Error; onCreate(): void; onEdit(binding: GroupBinding): void; onOpenCollaboration(target: CollaborationScopeTarget): void }) {
  const displayName = cell.remoteFact?.displayName ?? cell.externalChatId;
  return <Card as="article">
    <div className="flex items-start gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-info-soft text-info"><Users size={16}/></span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-semibold text-primary">{displayName}</div>
        <div className="mt-0.5 truncate font-mono text-meta text-subtle">{cell.externalChatId}</div>
      </div>
      <Badge tone={cell.severity === 'blocked' ? 'danger' : 'neutral'}>{cell.desiredPolicy ? '已配置 · 未接管' : '未配置'}</Badge>
    </div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <Fact label="远端事实">{cell.remoteFact ? labelByMembership[cell.remoteFact.membershipState] : '尚无同步事实'}</Fact>
      <Fact label="路由策略">回复 {cell.effectiveSummary?.routing.groupReplyMode.value ?? '未解析'} · 提及 {cell.effectiveSummary?.routing.mentionPolicy.value ?? '未解析'}</Fact>
      <Fact label="权限来源">talk: {cell.permissionSummary.talkSource} · operate: {cell.permissionSummary.canOperateAssignments} · admin: {cell.permissionSummary.adminAssignments}</Fact>
      <Fact label="群工具">read {cell.effectiveSummary?.groupTools.read.allowed ? '允许' : '禁止'} · send {cell.effectiveSummary?.groupTools.send.allowed ? '允许' : '禁止'}</Fact>
    </div>
    {cell.blockers.length > 0 && <div className="mt-3 space-y-1.5">{cell.blockers.map(blocker => <Banner key={blocker.code} tone="warning"><strong>{blocker.code}</strong><br/>下一步：{blocker.action}</Banner>)}</div>}
    {createError && <div className="mt-3"><Banner tone="danger">{createError instanceof ApiError && createError.status === 403 ? '需要 owner/admin 权限才能创建绑定。' : `创建失败：${createError.message}`}</Banner></div>}
    <div className="mt-3 flex justify-end gap-2">
      <Button variant="ghost" onClick={() => onOpenCollaboration({ appId: bot.externalAppId, chatId: cell.externalChatId, groupName: displayName, botName: bot.displayName })}>通用协作</Button>
      <Button
        variant="secondary"
        disabled={!writesEnabled || creating}
        title={!writesEnabled ? '需要接入管理权限 evaluator' : undefined}
        onClick={() => cell.desiredPolicy ? onEdit(cell.desiredPolicy) : onCreate()}
      >{cell.desiredPolicy ? '编辑群策略' : creating ? '正在创建…' : '配置此群'}</Button>
    </div>
  </Card>;
}

/*
  metadata-only 的凭据引用选择器。

  这里**只选 ref id**：没有凭据值输入框，没有「测试凭据」按钮，也不回显任何 secret。
  option 只暴露 id 与 status/availability 两个 metadata 字段。迁移到 <Field>/<Select>
  时必须保持这个边界——加一个 <Input> 就等于把 Web 变成了凭据录入面。
*/
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
  return <Card tone="muted" padding="sm" className="mb-3 space-y-2">
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-56 flex-1">
        <Field label="SecretRef（仅 metadata）">
          <Select aria-label={`${bot.displayName} SecretRef`} value={selected} disabled={!writesEnabled || pending} onChange={event => setSelected(event.target.value)}>
            <option value="">不绑定 SecretRef</option>
            {eligible.map(ref => <option key={ref.id} value={ref.id} disabled={ref.status !== 'configured' || ref.availability !== 'available'}>{ref.id} · {ref.status}/{ref.availability}</option>)}
          </Select>
        </Field>
      </div>
      <Button variant="secondary" disabled={!writesEnabled || pending || selected === (bot.selectedSecretRefId ?? '')} onClick={() => onSave(selected || undefined, bot.revision)}>{pending ? '保存中…' : '保存引用'}</Button>
    </div>
    {eligible.length === 0 && <Banner tone="warning">尚无 Lark SecretRef。请在远程机终端运行 <code>dutydeck secret set &lt;id&gt; --value-fd 0</code>；不要在 Web 粘贴凭据。</Banner>}
    {error && (conflict
      ? <Banner tone="warning" role="alert" action={{ label: '基于新版本重试', onClick: () => onSave(selected || undefined, conflict.revision) }}>Bot 配置已变化到 revision {conflict.revision}；你的 SecretRef 选择仍保留。</Banner>
      : <Banner tone="danger">{error instanceof ApiError && error.status === 403 ? '需要 owner/admin 权限才能保存引用。' : `SecretRef 保存失败：${error.message}`}</Banner>)}
  </Card>;
}

export function GroupPolicyModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const queryClient = useQueryClient();
  const capabilities = useQuery({ queryKey: ['foundation-capabilities'], queryFn: foundationApi.capabilities, enabled: open, retry: false });
  const matrix = useQuery({ queryKey: ['foundation-group-matrix'], queryFn: foundationApi.groupMatrix, enabled: open && capabilities.data?.repositoriesWired === true, retry: false });
  const secretRefs = useQuery({ queryKey: ['foundation-secret-refs'], queryFn: foundationApi.secretRefs, enabled: open && capabilities.data?.repositoriesWired === true, retry: false });
  const [draft, setDraft] = useState<Draft>();
  const [conflict, setConflict] = useState<GroupBinding>();
  const [botConflicts, setBotConflicts] = useState<Record<string, PublicChannelBotFoundation>>({});
  // 通用协作面板的目标 scope；与静态禁用策略编辑互不影响。
  const [collaborationTarget, setCollaborationTarget] = useState<CollaborationScopeTarget>();
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
  useEffect(() => { if (!open) { setDraft(undefined); setConflict(undefined); setBotConflicts({}); setCollaborationTarget(undefined); save.reset(); } }, [open]);
  const capability = capabilities.data;
  const permissionBlocked = capability && !capability.permissionEvaluatorWired;
  // 写操作进行中时不允许 Escape / 点遮罩关闭：会把一个已经发出的 CAS 写请求丢在半路。
  const busy = save.isPending || saveBotSecret.isPending || createBinding.isPending;
  // 通用协作二级 Dialog 打开时，外层不能被同一个 Escape 一起关掉。
  return <Dialog open={open} onClose={onClose} label="群配置与权限" size="lg" closeOnEscape={!busy && !collaborationTarget} closeOnScrim={!busy && !collaborationTarget}>
    <Dialog.Header>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-action-soft text-action"><MessageSquare size={18}/></span>
      <div className="min-w-0 flex-1">
        <div className="text-meta font-semibold uppercase tracking-[.12em] text-action">Offline management</div>
        <h2 className="mt-1 text-title font-semibold text-primary">群配置与权限</h2>
        <p className="mt-1 text-caption text-subtle">仅编辑 staged/disabled 策略；不会启动飞书监听或接管消息。</p>
      </div>
      <IconButton label="关闭群配置" onClick={onClose}><X size={16}/></IconButton>
    </Dialog.Header>
    <Dialog.Body className="space-y-3">
      {capabilities.isLoading && <div className="flex min-h-40 items-center justify-center"><Spinner label="正在读取管理能力…"/></div>}
      {capabilities.isError && <Banner tone="danger" action={{ label: '重试', onClick: () => void capabilities.refetch() }}>无法读取群策略能力：{capabilities.error.message}</Banner>}
      {capability && <Banner tone="warning" title="尚未接入运行时">
        策略可以离线查看和校验，但生产消息、终端和 Agent 执行入口保持 fail-closed。
        <div className="mt-2 flex flex-wrap gap-2">{capability.blockers.map(blocker => <span key={blocker.code} title={blocker.action}><Badge tone="warning">{blocker.message} · {blocker.action}</Badge></span>)}</div>
      </Banner>}
      {permissionBlocked && <Banner tone="danger" title="编辑已禁用：缺少 owner/admin 权限解析。">下一步：由 WP1b 接入统一 permission evaluator；当前草稿不会提交。</Banner>}
      {capability && !capability.secretInspectorWired && <Banner tone="warning" role="alert"><strong>SecretRef 选择已禁用：</strong>metadata-only 文件可用性检查尚未接入；Web 不会尝试解析或测试凭据值。</Banner>}
      {capability?.repositoriesWired === false && <Card tone="dashed" padding="none">
        <EmptyState tone="neutral" icon={<Bot size={22}/>} title="群策略仓储尚未接入运行时" description="下一步：完成 WP1b repository wiring 后重新打开此页面。"/>
      </Card>}
      {matrix.isLoading && <div className="flex justify-center"><Spinner label="正在加载群配置矩阵…"/></div>}
      {matrix.isError && <Banner tone="danger" action={{ label: '重试', onClick: () => void matrix.refetch() }}>群配置读取失败：{matrix.error.message}</Banner>}
      {secretRefs.isError && <Banner tone="danger">SecretRef metadata 读取失败；请在远程机运行 <code>dutydeck secret list</code> 检查。</Banner>}
      {matrix.data?.bots.length === 0 && <Card tone="dashed" padding="none">
        <EmptyState tone="neutral" title="尚无 staged/disabled ChannelBot" description="先通过管理 API 创建安全草稿；此页面不会创建或启用 listener。"/>
      </Card>}
      <div className="space-y-5">{matrix.data?.bots.map(entry => <section key={entry.bot.id}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Bot size={15} className="text-subtle"/>
          <h3 className="text-body font-semibold text-primary">{entry.bot.displayName}</h3>
          <Badge>{entry.bot.state} · rev {entry.bot.revision}</Badge>
          <Badge tone={entry.bot.credentialStatus === 'configured' ? 'success' : 'danger'}>凭据 {entry.bot.credentialStatus}</Badge>
        </div>
        {entry.bot.credentialStatus !== 'configured' && <div className="mb-3"><Banner tone="danger"><strong>Bot 保持禁用：</strong>{entry.bot.credentialStatus === 'unreadable' ? '所选 SecretRef 文件缺失或不可读。下一步：在远程机运行 dutydeck secret list 检查，并用 rotate 修复。' : '缺少可用 SecretRef。下一步：选择已配置且可读的 SecretRef。'} 此页面不会读取、测试或回显 App Secret。</Banner></div>}
        <SecretRefSelector
          bot={entry.bot}
          refs={secretRefs.data?.secretRefs ?? []}
          writesEnabled={Boolean(capability?.writesEnabled && capability.secretInspectorWired)}
          pending={saveBotSecret.isPending && saveBotSecret.variables?.botId === entry.bot.id}
          error={saveBotSecret.variables?.botId === entry.bot.id ? saveBotSecret.error ?? undefined : undefined}
          conflict={botConflicts[entry.bot.id]}
          onSave={(secretRefId, expectedRevision) => saveBotSecret.mutate({ botId: entry.bot.id, expectedRevision, secretRefId })}
        />
        <div className="grid gap-3 lg:grid-cols-2">{entry.cells.map(cell => {
          const creatingThis = createBinding.isPending && createBinding.variables?.channelBotId === entry.bot.id && createBinding.variables.externalChatId === cell.externalChatId;
          const failedThis = createBinding.isError && createBinding.variables?.channelBotId === entry.bot.id && createBinding.variables.externalChatId === cell.externalChatId;
          return <CellCard
            key={cell.externalChatId}
            cell={cell}
            bot={entry.bot}
            writesEnabled={Boolean(capability?.writesEnabled)}
            creating={creatingThis}
            createError={failedThis ? createBinding.error : undefined}
            onCreate={() => createBinding.mutate({ channelBotId: entry.bot.id, externalChatId: cell.externalChatId })}
            onEdit={binding => { setDraft(draftFromBinding(binding)); setConflict(undefined); save.reset(); }}
            onOpenCollaboration={setCollaborationTarget}
          />;
        })}</div>
      </section>)}</div>
    </Dialog.Body>
    {draft && <form onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(draft); }} className="shrink-0 space-y-3 border-t border-subtle bg-muted px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <h3 className="text-body font-semibold text-primary">编辑群策略</h3>
          <p className="mt-0.5 text-caption text-subtle">基于 revision {draft.expectedRevision}；保存后 Bot 仍保持 disabled。</p>
        </div>
        <span className="ml-auto"><Button variant="ghost" onClick={() => { setDraft(undefined); setConflict(undefined); }}>取消</Button></span>
      </div>
      {conflict && <Banner tone="warning" role="alert" title="配置已被其他修改覆盖。" action={{ label: '基于新版本重试', onClick: () => setDraft(current => current ? { ...current, expectedRevision: conflict.revision } : current) }}>当前版本是 revision {conflict.revision}；你的草稿仍保留。</Banner>}
      {save.error && !conflict && <Banner tone="danger">{save.error instanceof ApiError && save.error.status === 403 ? '需要 owner/admin 权限才能保存。下一步：检查权限分配或接入 evaluator。' : `保存失败：${save.error.message}`}</Banner>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="回复模式">
          <Select value={draft.groupReplyMode} onChange={event => setDraft({ ...draft, groupReplyMode: event.target.value as Draft['groupReplyMode'] })}>
            <option value="inherit">继承</option><option value="chat">chat</option><option value="shared">shared</option><option value="new-topic">new-topic</option><option value="chat-topic">chat-topic</option>
          </Select>
        </Field>
        <Field label="提及策略">
          <Select value={draft.mentionPolicy} onChange={event => setDraft({ ...draft, mentionPolicy: event.target.value as Draft['mentionPolicy'] })}>
            <option value="inherit">继承</option><option value="always">always</option><option value="topic">topic</option><option value="never">never</option><option value="ambient">ambient</option>
          </Select>
        </Field>
        {(['read', 'discover', 'send'] as const).map(tool => <Field key={tool} label={`群工具 ${tool}`}>
          <Select value={draft[tool]} onChange={event => setDraft({ ...draft, [tool]: event.target.value as Draft[typeof tool] })}>
            {Object.entries(labelByTool).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>)}
      </div>
      <label className="flex items-center gap-2 text-caption text-secondary"><input type="checkbox" checked={draft.oncall} onChange={event => setDraft({ ...draft, oncall: event.target.checked })}/>oncall 群成员只获得 can_talk，不获得 operate/admin</label>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" tone="inverse" loading={save.isPending} disabled={!capability?.writesEnabled}>{save.isPending ? '保存中…' : '保存禁用态策略'}</Button>
      </div>
    </form>}

    {/* 通用协作管理：只读/编辑真实运行配置，与上方 staged/disabled 静态策略完全独立 */}
    {collaborationTarget && (
      <Dialog
        open
        onClose={() => setCollaborationTarget(undefined)}
        label={`通用协作 · ${collaborationTarget.botName} · ${collaborationTarget.groupName}`}
        size="xl"
      >
        <Dialog.Header>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-title font-semibold text-primary">群通用协作管理</h2>
            <p className="mt-1 text-caption text-subtle">
              {collaborationTarget.botName} · {collaborationTarget.groupName}（{collaborationTarget.chatId}）。此处读取和修改的是真实协作配置，不等同于上方未接管的禁用态策略。
            </p>
          </div>
          <IconButton label="关闭通用协作" onClick={() => setCollaborationTarget(undefined)}><X size={16}/></IconButton>
        </Dialog.Header>
        <Dialog.Body>
          <CollaborationPanel
            appId={collaborationTarget.appId}
            chatId={collaborationTarget.chatId}
            groupName={collaborationTarget.groupName}
            botName={collaborationTarget.botName}
          />
        </Dialog.Body>
      </Dialog>
    )}
  </Dialog>;
}
