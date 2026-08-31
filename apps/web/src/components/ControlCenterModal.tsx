import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarClock,
  ChevronRight,
  KeyRound,
  MessageSquare,
  Plus,
  RefreshCw,
  Settings2,
  Users,
  X
} from 'lucide-react';
import { ApiError, foundationApi, scheduleApi, type Agent, type LarkBotConfig } from '../api';
import { useDialogFocus } from '../useDialogFocus';
import { IconButton } from './ui';

export type ControlCenterSection = 'agents' | 'lark' | 'groups' | 'automation';

type Props = {
  open: boolean;
  initialSection?: ControlCenterSection;
  agents: Agent[];
  legacyBots: LarkBotConfig[];
  authRequired?: boolean;
  onClose(): void;
  onCreateTask(): void;
  onOpenLarkSetup(): void;
  onOpenGroups(): void;
  onOpenSchedules(): void;
};

const sections: Array<{ id: ControlCenterSection; label: string; description: string; Icon: typeof Bot }> = [
  { id: 'agents', label: 'Agent', description: '准备本机执行者', Icon: Bot },
  { id: 'lark', label: '飞书 Bot', description: '连接消息入口', Icon: MessageSquare },
  { id: 'groups', label: '群与权限', description: '群聊范围与操作权限', Icon: Users },
  { id: 'automation', label: '自动化', description: '定时任务预览', Icon: CalendarClock }
];

function statePill(label: string, tone: 'neutral' | 'ready' | 'blocked' = 'neutral') {
  const classes = tone === 'ready'
    ? 'bg-teal-50 text-teal-700'
    : tone === 'blocked'
      ? 'bg-amber-50 text-amber-800'
      : 'bg-slate-100 text-slate-600';
  return <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${classes}`}>{label}</span>;
}

function newId(prefix: string) {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function permissionLabel(value: Agent['permissionMode']) {
  return ({ ask: '操作前确认', 'approve-reads': '自动读取', 'deny-all': '全部拒绝', 'full-trust': '完全信任' } as const)[value];
}

export function ControlCenterModal({
  open,
  initialSection = 'agents',
  agents,
  legacyBots,
  authRequired,
  onClose,
  onCreateTask,
  onOpenLarkSetup,
  onOpenGroups,
  onOpenSchedules
}: Props) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<ControlCenterSection>(initialSection);
  const [createOpen, setCreateOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [externalAppId, setExternalAppId] = useState('');
  const [brand, setBrand] = useState<'feishu' | 'lark'>('feishu');
  const dialogRef = useDialogFocus(open);

  const capabilities = useQuery({ queryKey: ['foundation-capabilities'], queryFn: foundationApi.capabilities, enabled: open, retry: false });
  const matrix = useQuery({ queryKey: ['foundation-group-matrix'], queryFn: foundationApi.groupMatrix, enabled: open && capabilities.data?.repositoriesWired === true, retry: false });
  const secretRefs = useQuery({ queryKey: ['foundation-secret-refs'], queryFn: foundationApi.secretRefs, enabled: open && capabilities.data?.repositoriesWired === true, retry: false });
  const scheduleCapabilities = useQuery({ queryKey: ['schedule-capabilities'], queryFn: scheduleApi.capabilities, enabled: open, retry: false });
  const schedules = useQuery({ queryKey: ['schedule-foundation-list'], queryFn: scheduleApi.list, enabled: open && scheduleCapabilities.data?.repositoriesWired === true, retry: false });
  const createBot = useMutation({
    mutationFn: () => foundationApi.createChannelBot({ id: newId('channel-bot'), externalAppId: externalAppId.trim(), displayName: displayName.trim(), brand }),
    onSuccess: async () => {
      setDisplayName('');
      setExternalAppId('');
      setCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['foundation-group-matrix'] });
    }
  });

  useEffect(() => {
    if (open) setSection(initialSection);
    else {
      setCreateOpen(false);
      createBot.reset();
    }
  }, [open, initialSection]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || createBot.isPending) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [createBot.isPending, onClose, open]);

  const channelBots = matrix.data?.bots ?? [];
  const refs = secretRefs.data?.secretRefs ?? [];
  const availableLarkRefs = refs.filter(ref => ref.kind === 'lark_app_secret' && ref.status === 'configured' && ref.availability === 'available');
  const cells = channelBots.flatMap(entry => entry.cells);
  const missingBindings = cells.filter(cell => !cell.desiredPolicy).length;
  const scheduleCount = schedules.data?.schedules.length ?? 0;
  const nextStep = useMemo(() => {
    if (agents.length === 0) return { title: '准备第一个 Agent', detail: '安装并登录一个受支持的 CLI，然后重启 Dockmux。', action: () => setSection('agents' as const) };
    if (legacyBots.length === 0) return { title: '创建任务，或连接飞书 Bot', detail: 'Agent 已可用。你可以直接在 Web 工作，也可以让它从飞书接收任务。', action: onOpenLarkSetup };
    const incomplete = legacyBots.find(bot => !bot.setupComplete || !bot.activeListening);
    if (incomplete) return { title: `继续设置 ${incomplete.name}`, detail: incomplete.setupComplete ? '配置已保存，但消息监听尚未连接。' : '还需要选择 Agent、工作区并完成权限确认。', action: onOpenLarkSetup };
    return { title: '开始一个新任务', detail: `${agents.length} 个 Agent、${legacyBots.length} 个飞书 Bot 已可用。`, action: onCreateTask };
  }, [agents.length, legacyBots, onCreateTask, onOpenLarkSetup]);

  if (!open) return null;
  const scheduleBlockers = scheduleCapabilities.data?.blockers.filter(blocker => blocker.code !== 'schedule_ui_entry_unwired') ?? [];

  return <div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-slate-950/45 p-3 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-label="Dockmux 设置与接入" className="flex max-h-[94dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-[var(--paper)] shadow-[0_30px_100px_rgba(15,23,42,.34)]">
      <header className="flex items-start gap-3 border-b border-slate-200 px-5 py-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-teal-300"><Settings2 size={18}/></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold text-slate-900">设置与接入</h2>{authRequired === false ? statePill('受信开发机模式', 'ready') : authRequired === true ? statePill('访问令牌保护') : statePill('正在检查访问模式')}</div>
          <p className="mt-1 text-xs leading-5 text-slate-500">准备 Agent、连接飞书 Bot；迁移草稿和高级策略不会挡住日常任务。</p>
        </div>
        <IconButton label="关闭设置与接入" onClick={onClose}><X size={16}/></IconButton>
      </header>
      {authRequired === false && <div className="border-b border-teal-200 bg-teal-50 px-5 py-2.5 text-xs text-teal-800"><strong>受信开发机模式：</strong>当前实例无需粘贴访问 token。请只在受信网络或已有上游鉴权的环境中使用。</div>}

      <div className="grid min-h-0 flex-1 md:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-slate-50 p-3 md:border-b-0 md:border-r">
          <div className="mb-3 rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400">建议下一步</div>
            <div className="mt-1 text-sm font-semibold text-slate-900">{nextStep.title}</div>
            <p className="mt-1 text-xs leading-5 text-slate-600">{nextStep.detail}</p>
            <button type="button" onClick={nextStep.action} className="mt-2 flex min-h-9 w-full items-center justify-between rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white">继续<ArrowRight size={14}/></button>
          </div>
          <nav aria-label="设置与接入导航" className="grid grid-cols-2 gap-1 md:grid-cols-1">{sections.map(item => <button key={item.id} type="button" data-dialog-initial-focus={section === item.id ? '' : undefined} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)} className={`flex min-h-12 items-center gap-2 rounded-lg px-3 text-left ${section === item.id ? 'bg-white text-slate-950 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white/70'}`}><item.Icon size={15}/><span className="min-w-0"><strong className="block text-xs font-semibold">{item.label}</strong><span className="hidden truncate text-[10px] text-slate-400 md:block">{item.description}</span></span><ChevronRight size={13} className="ml-auto hidden md:block"/></button>)}</nav>
        </aside>

        <div className="min-h-0 overflow-y-auto p-5">
          {section === 'agents' && <AgentSection agents={agents} legacyBots={legacyBots} onCreateTask={onCreateTask} onOpenLarkSetup={onOpenLarkSetup}/>} 
          {section === 'lark' && <LarkSection agents={agents} legacyBots={legacyBots} capabilities={capabilities} matrix={matrix} secretRefs={secretRefs} channelBots={channelBots} availableLarkRefs={availableLarkRefs} createOpen={createOpen} setCreateOpen={setCreateOpen} displayName={displayName} setDisplayName={setDisplayName} externalAppId={externalAppId} setExternalAppId={setExternalAppId} brand={brand} setBrand={setBrand} createBot={createBot} onOpenLarkSetup={onOpenLarkSetup}/>} 
          {section === 'groups' && <GroupsSection cells={cells} missingBindings={missingBindings} repositoriesWired={capabilities.data?.repositoriesWired === true} onOpenLarkSetup={onOpenLarkSetup} onOpenGroups={onOpenGroups}/>} 
          {section === 'automation' && <AutomationSection scheduleCount={scheduleCount} blockers={scheduleBlockers} capabilities={scheduleCapabilities} onOpenSchedules={onOpenSchedules}/>} 
        </div>
      </div>
    </section>
  </div>;
}

function AgentSection({ agents, legacyBots, onCreateTask, onOpenLarkSetup }: { agents: Agent[]; legacyBots: LarkBotConfig[]; onCreateTask(): void; onOpenLarkSetup(): void }) {
  return <section aria-labelledby="control-agents">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="control-agents" className="text-base font-semibold text-slate-900">Agent</h3><p className="mt-1 text-xs leading-5 text-slate-500">Agent 是在这台机器上执行任务的 CLI。Dockmux 会自动发现已安装并登录的受支持 CLI。</p></div>{statePill(agents.length ? `${agents.length} 个可用` : '尚未找到', agents.length ? 'ready' : 'blocked')}</div>
    {agents.length > 0 && <div className="mt-4 grid gap-3 sm:grid-cols-2">{agents.map(agent => {
      const boundBots = legacyBots.filter(bot => bot.defaultAgentId === agent.id);
      return <article key={agent.id} className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2"><Bot size={16} className="text-teal-700"/><h4 className="text-sm font-semibold text-slate-900">{agent.name}</h4>{statePill('可创建任务', 'ready')}</div>
        <p className="mt-1 text-[11px] text-slate-500">{agent.version ? `${agent.version} · ` : ''}{agent.protocol === 'pty-cli' ? '终端 CLI' : agent.protocol.toUpperCase()}</p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600"><div className="rounded-lg bg-slate-50 p-2">默认权限<br/><strong className="text-slate-900">{permissionLabel(agent.permissionMode)}</strong></div><div className="rounded-lg bg-slate-50 p-2">飞书 Bot<br/><strong className="text-slate-900">{boundBots.length ? `${boundBots.length} 个已连接` : '尚未连接'}</strong></div></div>
        <div className="mt-3 flex gap-2"><button type="button" onClick={onCreateTask} className="min-h-9 flex-1 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white">用它创建任务</button><button type="button" onClick={onOpenLarkSetup} className="min-h-9 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700">{boundBots.length ? '管理 Bot' : '连接 Bot'}</button></div>
      </article>;
    })}</div>}
    <div className={`mt-4 rounded-xl border p-4 ${agents.length ? 'border-slate-200 bg-slate-50' : 'border-amber-200 bg-amber-50'}`}>
      <h4 className="text-sm font-semibold text-slate-900">{agents.length ? '添加另一个 Agent' : '添加第一个 Agent'}</h4>
      <ol className="mt-2 space-y-2 text-xs leading-5 text-slate-600"><li><strong className="text-slate-900">1.</strong> 在运行 Dockmux 的机器上安装并登录 Codex、Claude Code、Gemini 等受支持 CLI。</li><li><strong className="text-slate-900">2.</strong> 在终端运行 <code className="rounded bg-slate-900 px-1.5 py-1 text-teal-200">dockmux restart</code>，让 Dockmux 重新检测。</li><li><strong className="text-slate-900">3.</strong> 回到此页确认 Agent 显示为“可用”，再创建任务或连接飞书 Bot。</li></ol>
      <details className="mt-3 text-xs text-slate-600"><summary className="cursor-pointer font-semibold text-slate-800">自定义 Agent</summary><p className="mt-2 leading-5">通过 <code>DOCKMUX_AGENTS_JSON</code> 配置自定义 ACP/CLI 后重启。启动命令、环境变量、密钥和 system prompt 不会发送到浏览器。</p></details>
    </div>
  </section>;
}

type QueryLike<T> = { data?: T; isError: boolean; isLoading: boolean; refetch(): unknown };

function LarkSection({ agents, legacyBots, capabilities, matrix, secretRefs, channelBots, availableLarkRefs, createOpen, setCreateOpen, displayName, setDisplayName, externalAppId, setExternalAppId, brand, setBrand, createBot, onOpenLarkSetup }: {
  agents: Agent[];
  legacyBots: LarkBotConfig[];
  capabilities: QueryLike<Awaited<ReturnType<typeof foundationApi.capabilities>>>;
  matrix: QueryLike<Awaited<ReturnType<typeof foundationApi.groupMatrix>>>;
  secretRefs: QueryLike<Awaited<ReturnType<typeof foundationApi.secretRefs>>>;
  channelBots: Awaited<ReturnType<typeof foundationApi.groupMatrix>>['bots'];
  availableLarkRefs: Awaited<ReturnType<typeof foundationApi.secretRefs>>['secretRefs'];
  createOpen: boolean;
  setCreateOpen(value: boolean | ((value: boolean) => boolean)): void;
  displayName: string;
  setDisplayName(value: string): void;
  externalAppId: string;
  setExternalAppId(value: string): void;
  brand: 'feishu' | 'lark';
  setBrand(value: 'feishu' | 'lark'): void;
  createBot: { mutate(): void; error: Error | null; isPending: boolean };
  onOpenLarkSetup(): void;
}) {
  return <section aria-labelledby="control-lark">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="control-lark" className="text-base font-semibold text-slate-900">飞书 Bot</h3><p className="mt-1 text-xs leading-5 text-slate-500">Bot 负责在飞书收发消息，Agent 负责执行任务。绑定向导会把两者一次连好。</p></div><button type="button" onClick={onOpenLarkSetup} className="flex min-h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white"><Plus size={15}/>{legacyBots.length ? '绑定新 Bot' : '绑定飞书 Bot'}</button></div>
    {legacyBots.length === 0 ? <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-7 text-center"><MessageSquare size={22} className="mx-auto text-teal-700"/><h4 className="mt-3 text-sm font-semibold text-slate-900">还没有飞书 Bot</h4><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-600">准备 App ID 和 App Secret；向导会校验应用、配置飞书能力，再让你选择默认 Agent、工作区和监听状态。</p><button type="button" onClick={onOpenLarkSetup} className="mt-4 min-h-10 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white">开始绑定</button></div> : <div className="mt-4 space-y-2">{legacyBots.map(bot => {
      const agent = agents.find(item => item.id === bot.defaultAgentId);
      const ready = bot.setupComplete && bot.activeListening;
      return <article key={bot.appId} className="rounded-xl border border-slate-200 bg-white p-4"><div className="flex flex-wrap items-center gap-2"><MessageSquare size={15} className="text-teal-700"/><h4 className="text-sm font-semibold text-slate-900">{bot.name}</h4>{statePill(ready ? '可使用' : bot.setupComplete ? '监听未连接' : '设置未完成', ready ? 'ready' : 'blocked')}</div><div className="mt-3 grid gap-2 text-xs sm:grid-cols-3"><div className="rounded-lg bg-slate-50 p-2 text-slate-500">默认 Agent<br/><strong className="text-slate-900">{agent?.name ?? bot.defaultAgentId ?? '未选择'}</strong></div><div className="rounded-lg bg-slate-50 p-2 text-slate-500">工作区<br/><strong className="block truncate text-slate-900" title={bot.workspace}>{bot.workspace || '使用 Agent 默认目录'}</strong></div><div className="rounded-lg bg-slate-50 p-2 text-slate-500">消息监听<br/><strong className="text-slate-900">{bot.activeListening ? '已连接' : bot.listening ? '正在等待连接' : '已关闭'}</strong></div></div><button type="button" onClick={onOpenLarkSetup} className="mt-3 min-h-9 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700">{ready ? '管理设置' : '继续设置'}</button></article>;
    })}</div>}

    <details className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <summary className="cursor-pointer text-xs font-semibold text-slate-700">迁移与高级草稿</summary>
      <p className="mt-2 text-xs leading-5 text-slate-600">以下是新控制面迁移草稿，只能离线保存，当前版本不能据此启动 Bot。日常接入请使用上方“绑定飞书 Bot”。</p>
      {(capabilities.isError || matrix.isError || secretRefs.isError) && <div role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">高级草稿状态读取失败。<button type="button" className="ml-1 font-semibold underline" onClick={() => { void capabilities.refetch(); void matrix.refetch(); void secretRefs.refetch(); }}>重试</button></div>}
      {capabilities.data?.blockers.length ? <details className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3"><summary className="cursor-pointer text-xs font-semibold text-amber-950">查看 {capabilities.data.blockers.length} 项技术阻断</summary><div className="mt-2 space-y-2">{capabilities.data.blockers.map(blocker => <div key={blocker.code} className="text-[11px] leading-5 text-amber-900"><strong>{blocker.code}</strong> · {blocker.message}<br/>下一步：{blocker.action}</div>)}</div></details> : null}
      <div className="mt-4 flex items-center justify-between"><h4 className="text-sm font-semibold text-slate-900">ChannelBot 草稿</h4><button type="button" onClick={() => setCreateOpen(value => !value)} disabled={!capabilities.data?.writesEnabled} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 disabled:opacity-40"><Plus size={14}/>创建 staged Bot</button></div>
      {createOpen && <form onSubmit={(event: FormEvent) => { event.preventDefault(); createBot.mutate(); }} className="mt-3 rounded-xl border border-slate-200 bg-white p-4"><div className="grid gap-3 sm:grid-cols-3"><label className="text-xs text-slate-600"><span>显示名称</span><input aria-label="ChannelBot 显示名称" value={displayName} onChange={event => setDisplayName(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-white px-2"/></label><label className="text-xs text-slate-600"><span>飞书 App ID</span><input aria-label="ChannelBot App ID" value={externalAppId} onChange={event => setExternalAppId(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-white px-2"/></label><label className="text-xs text-slate-600"><span>品牌</span><select value={brand} onChange={event => setBrand(event.target.value as 'feishu' | 'lark')} className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-white px-2"><option value="feishu">飞书</option><option value="lark">Lark</option></select></label></div><p className="mt-3 text-[11px] text-slate-500">不需要 App Secret。结果固定为 staged / listener disabled，不能收发消息。</p>{createBot.error && <p role="alert" className="mt-2 text-xs text-rose-700">{createBot.error instanceof ApiError && createBot.error.status === 403 ? '需要 owner/admin 权限才能创建草稿。' : `创建失败：${createBot.error.message}`}</p>}<div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => setCreateOpen(false)} className="min-h-9 px-3 text-xs text-slate-600">取消</button><button type="submit" disabled={createBot.isPending || !displayName.trim() || !externalAppId.trim()} className="min-h-9 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white disabled:opacity-40">保存 staged 草稿</button></div></form>}
      <div className="mt-3 space-y-2">{channelBots.map(entry => <article key={entry.bot.id} className="rounded-lg border border-slate-200 bg-white p-3"><div className="flex flex-wrap items-center gap-2"><Bot size={14}/><strong className="text-xs text-slate-900">{entry.bot.displayName}</strong>{statePill(`${entry.bot.state} / listener disabled`)}{statePill(entry.bot.credentialStatus === 'configured' ? 'SecretRef ready' : `credential ${entry.bot.credentialStatus}`, entry.bot.credentialStatus === 'configured' ? 'ready' : 'blocked')}</div></article>)}</div>
      {matrix.isLoading && <p role="status" className="mt-3 text-xs text-slate-500"><RefreshCw size={13} className="mr-1 inline animate-spin"/>正在读取高级草稿…</p>}
      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3"><div className="flex items-center gap-2"><KeyRound size={14}/><h4 className="text-xs font-semibold text-slate-900">SecretRef metadata</h4><span className="ml-auto text-xs text-slate-500">可用 {availableLarkRefs.length}</span></div>{availableLarkRefs.length === 0 && <p className="mt-2 text-[11px] leading-5 text-slate-600">高级迁移凭据只能通过本机 CLI 写入：<code className="ml-1 rounded bg-slate-900 px-1.5 py-1 text-teal-200">dockmux secret set &lt;ref-id&gt;</code></p>}</div>
    </details>
  </section>;
}

function GroupsSection({ cells, missingBindings, repositoriesWired, onOpenLarkSetup, onOpenGroups }: { cells: Array<unknown>; missingBindings: number; repositoriesWired: boolean; onOpenLarkSetup(): void; onOpenGroups(): void }) {
  return <section aria-labelledby="control-groups">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="control-groups" className="text-base font-semibold text-slate-900">群与权限</h3><p className="mt-1 text-xs leading-5 text-slate-500">决定哪些群可以使用 Bot，以及聊天权限和操作权限的边界。</p></div>{statePill(cells.length ? `${cells.length} 个已发现群` : '尚未发现群', cells.length && !missingBindings ? 'ready' : 'blocked')}</div>
    {cells.length === 0 ? <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center"><Users size={21} className="mx-auto text-slate-500"/><h4 className="mt-3 text-sm font-semibold text-slate-900">还没有可配置的群</h4><p className="mt-1 text-xs leading-5 text-slate-600">先完成 Bot 绑定并把机器人加入飞书群，Dockmux 收到群消息后会在这里展示。</p><button type="button" onClick={onOpenLarkSetup} className="mt-4 min-h-9 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700">检查 Bot 设置</button></div> : <><div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-slate-200 p-4"><div className="text-[10px] font-semibold text-slate-400">已配置群</div><div className="mt-1 text-xl font-semibold text-slate-900">{cells.length - missingBindings}/{cells.length}</div></div><div className="rounded-xl border border-slate-200 p-4"><div className="text-[10px] font-semibold text-slate-400">权限原则</div><div className="mt-1 text-sm font-semibold text-slate-900">能聊天 ≠ 能操作终端</div><p className="mt-1 text-xs text-slate-500">高风险操作单独授权</p></div><div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="text-[10px] font-semibold text-amber-700">高级策略运行时</div><div className="mt-1 text-sm font-semibold text-amber-950">尚未启用</div></div></div><button type="button" onClick={onOpenGroups} disabled={!repositoriesWired} className="mt-4 flex min-h-10 w-full items-center justify-between rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"><span>查看群配置</span><ArrowRight size={15}/></button></>}
  </section>;
}

function AutomationSection({ scheduleCount, blockers, capabilities, onOpenSchedules }: { scheduleCount: number; blockers: Array<{ code: string; message: string; action: string }>; capabilities: QueryLike<Awaited<ReturnType<typeof scheduleApi.capabilities>>>; onOpenSchedules(): void }) {
  return <section aria-labelledby="control-automation">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="control-automation" className="text-base font-semibold text-slate-900">自动化</h3><p className="mt-1 text-xs text-slate-500">编辑定时任务草稿并预览下一次触发时间。</p></div>{statePill(`${scheduleCount} 个草稿`)}</div>
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-amber-950"><AlertTriangle size={15}/>当前版本不会自动执行</div><p className="mt-1 text-xs leading-5 text-amber-800">你可以编辑和预览，但自动化执行器尚未接入。页面不会把草稿误报为正在运行。</p>{capabilities.data && blockers.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-[11px] font-semibold">查看技术阻断</summary><div className="mt-2 space-y-1.5">{blockers.map(blocker => <div key={blocker.code} className="rounded-lg bg-white/70 px-3 py-2 text-[11px] leading-5"><strong>{blocker.code}</strong> · {blocker.message}<br/>下一步：{blocker.action}</div>)}</div></details>}</div>
    {capabilities.isError && <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">自动化状态读取失败。<button type="button" className="ml-1 font-semibold underline" onClick={() => void capabilities.refetch()}>重试</button></div>}
    <button type="button" onClick={onOpenSchedules} disabled={!capabilities.data?.repositoriesWired} className="mt-4 flex min-h-10 w-full items-center justify-between rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"><span>编辑与预览自动化</span><ArrowRight size={15}/></button>
  </section>;
}
