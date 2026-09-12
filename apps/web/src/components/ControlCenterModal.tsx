import type { LarkSetupTarget } from '../app-route';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Bot,
  CalendarClock,
  ChevronRight,
  KeyRound,
  MessageSquare,
  Plus,
  Settings2,
  Users,
  X
} from 'lucide-react';
import { ApiError, foundationApi, scheduleApi, type Agent, type LarkBotConfig } from '../api';
import { projectLarkBotStatus } from '../lark-status';
import { Badge, Banner, Button, Card, Dialog, EmptyState, Field, IconButton, Input, Select, Spinner } from './primitives';
import { permissionLabels } from './ui';

export type ControlCenterSection = 'agents' | 'lark' | 'groups' | 'automation';

type Props = {
  open: boolean;
  initialSection?: ControlCenterSection;
  agents: Agent[];
  legacyBots: LarkBotConfig[];
  /** LarkConfig.listeningDisabled：本次启动是否整体禁用监听，影响所有 Bot 的真实可用性。 */
  larkListeningDisabled?: boolean;
  /** Bot 状态读取失败/进行中：不得把 pending 或 error 当成「还没有 Bot」。 */
  larkBotsLoading?: boolean;
  larkBotsFailed?: boolean;
  larkBotsRetrying?: boolean;
  onRetryLarkBots?(): void;
  authRequired?: boolean;
  onClose(): void;
  onCreateTask(agentId: string): void;
  onOpenLarkSetup(target?: LarkSetupTarget): void;
  onOpenGroups(): void;
  onOpenSchedules(): void;
};

const sections: Array<{ id: ControlCenterSection; label: string; description: string; Icon: typeof Bot }> = [
  { id: 'agents', label: 'Agent', description: '准备本机执行者', Icon: Bot },
  { id: 'lark', label: '飞书 Bot', description: '连接消息入口', Icon: MessageSquare },
  { id: 'groups', label: '群与权限', description: '群聊范围与操作权限', Icon: Users },
  { id: 'automation', label: '自动化', description: '任务计划与草稿', Icon: CalendarClock }
];

/*
  三档就绪语气收进 <Badge>：原来是一个 full 圆角、10px 字号的手写 span，同时违反
  契约 §3（矩形不得用 full 圆角）与 §2（禁止 10px 以下）。ready 对应 action-soft 底 +
  action 文字，正是 Badge 的 accent 档，不需要新增语气。
*/
function statePill(label: string, tone: 'neutral' | 'ready' | 'blocked' = 'neutral') {
  return <Badge tone={tone === 'ready' ? 'accent' : tone === 'blocked' ? 'warning' : 'neutral'}>{label}</Badge>;
}

function newId(prefix: string) {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function permissionLabel(value: Agent['permissionMode']) {
  return permissionLabels[value];
}

export function ControlCenterModal({
  open,
  initialSection = 'agents',
  agents,
  legacyBots,
  larkListeningDisabled = false,
  larkBotsLoading = false,
  larkBotsFailed = false,
  larkBotsRetrying = false,
  onRetryLarkBots,
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

  const channelBots = matrix.data?.bots ?? [];
  const refs = secretRefs.data?.secretRefs ?? [];
  const availableLarkRefs = refs.filter(ref => ref.kind === 'lark_app_secret' && ref.status === 'configured' && ref.availability === 'available');
  const cells = channelBots.flatMap(entry => entry.cells);
  const missingBindings = cells.filter(cell => !cell.desiredPolicy).length;
  const scheduleCount = schedules.data?.schedules.length ?? 0;
  const nextStep = useMemo(() => {
    if (agents.length === 0) return { title: '准备第一个 Agent', detail: '安装并登录一个受支持的 CLI，然后重启 Dutydeck。', action: () => setSection('agents' as const) };
    /*
      Bot 状态未就绪时既不能说「还没有 Bot」，也不能沿用缓存说「监听已启动」。
      larkConfig 失败后 isLoading=false、data=undefined，若直接落到下面的
      `legacyBots.length === 0` 就会把「读不到」说成「没有」。
    */
    if (larkBotsLoading) return { title: '正在读取飞书接入状态', detail: '正在同步机器人配置与监听状态…', action: onOpenLarkSetup };
    if (larkBotsFailed) return { title: '重试读取飞书接入状态', detail: legacyBots.length ? '已有配置记录，但这一次状态读取失败，无法确认机器人当前能否收到消息。' : '状态读取失败，因此无法判断是否已配置机器人。', action: onRetryLarkBots ?? onOpenLarkSetup };
    if (legacyBots.length === 0) return { title: '连接飞书 Bot', detail: 'Agent 已可用。飞书是下达任务的主入口；也可以先在 Web 创建任务。', action: onOpenLarkSetup };
    /*
      建议下一步只能按**真实状态**给，不能按 Bot 条数宣称「已可用」。
      判据复用 lark-status.ts 的投影（与首页、侧栏同一份），这里不再自己拼条件：
      原先的 `!setupComplete || !activeListening` 漏掉了两种同样收不到消息的情况——
      用户主动暂停监听（listening=false）与本次启动整体禁用监听（listeningDisabled），
      两者都会让这里说出「N 个飞书 Bot 已可用」。
    */
    const unavailable = legacyBots
      .map(bot => ({ bot, status: projectLarkBotStatus(bot, larkListeningDisabled, false) }))
      .find(entry => entry.status.key !== 'listening');
    if (unavailable) return { title: `继续设置 ${unavailable.bot.name}`, detail: `${unavailable.status.label}：${unavailable.status.description}。`, action: () => onOpenLarkSetup({ appId: unavailable.bot.appId }) };
    /*
      到这里每个 Bot 都是「监听已启动」。措辞上限也就是「监听已启动」——它不证明
      消息已送达，所以不写「已可用」。

      标题必须与 action 一致：这颗按钮打开的是绑定/管理向导，不会把用户送进飞书，
      也不该替用户挑一个 Bot 跳转。原先叫「到飞书下达任务」，点下去却弹出配置向导。
      「下一步是去飞书发消息」这件事放在 detail 里说，标题只描述这颗按钮真的会做什么。
    */
    return { title: '管理飞书 Bot', detail: `${legacyBots.length} 个飞书 Bot 监听已启动，可在飞书私聊发目标或群聊 @机器人；这里可以调整机器人配置。`, action: onOpenLarkSetup };
  }, [agents.length, larkBotsFailed, larkBotsLoading, larkListeningDisabled, legacyBots, onOpenLarkSetup, onRetryLarkBots]);

  /*
    提交中不允许关闭（契约 §8.1）：把「什么算忙」交给 closeOnEscape / closeOnScrim，
    而不是在 onClose 里 return——后者仍会让 Escape 被 preventDefault 吃掉，
    嵌套浮层就再也收不到那次按键。
  */
  const busy = createBot.isPending;

  return <Dialog open={open} onClose={onClose} label="Dutydeck 设置与接入" size="xl" closeOnEscape={!busy} closeOnScrim={!busy}>
    <Dialog.Header>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-action-soft text-action"><Settings2 size={18}/></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-title font-semibold text-primary">设置与接入</h2>{authRequired === false ? statePill('受信开发机模式', 'ready') : authRequired === true ? statePill('访问令牌保护') : statePill('正在检查访问模式')}</div>
        <p className="mt-1 text-caption text-subtle">准备 Agent、连接飞书 Bot；迁移草稿和高级策略不会挡住日常任务。</p>
      </div>
      <IconButton label="关闭设置与接入" onClick={onClose}><X size={16}/></IconButton>
    </Dialog.Header>
    {authRequired === false && <div className="shrink-0 px-5 pt-3"><Banner tone="info"><strong>受信开发机模式：</strong>当前实例无需粘贴访问 token。请只在受信网络或已有上游鉴权的环境中使用。</Banner></div>}

    <div className="grid min-h-0 flex-1 md:grid-cols-[230px_minmax(0,1fr)]">
      <aside className="border-b border-subtle bg-muted p-3 md:border-b-0 md:border-r">
        <Card padding="sm" className="mb-3">
          <div className="text-caption font-semibold uppercase tracking-[.12em] text-subtle">建议下一步</div>
          <div className="mt-1 text-body font-semibold text-primary">{nextStep.title}</div>
          <p className="mt-1 text-caption text-secondary">{nextStep.detail}</p>
          <Button variant="primary" className="mt-2 w-full" onClick={() => nextStep.action()}><span className="flex w-full items-center justify-between">继续<ArrowRight size={14}/></span></Button>
        </Card>
        {/*
          可访问名是 label + description 两段拼出来的（App.dom.test.tsx 断言
          /^Agent 准备本机执行者$/），所以 description 那段即使在窄屏隐藏也必须留在
          按钮里；data-dialog-initial-focus 是 useDialogFocus 的入口焦点锚点。
        */}
        <nav aria-label="设置与接入导航" className="grid grid-cols-2 gap-1 md:grid-cols-1">{sections.map(item => <button key={item.id} type="button" data-dialog-initial-focus={section === item.id ? '' : undefined} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)} className={`flex min-h-12 items-center gap-2 rounded-md px-3 text-left ${section === item.id ? 'bg-surface text-primary shadow-card' : 'text-secondary hover:bg-hover'}`}><item.Icon size={15}/><span className="min-w-0"><strong className="block text-caption font-semibold">{item.label}</strong><span className="hidden truncate text-caption text-subtle md:block">{item.description}</span></span><ChevronRight size={13} className="ml-auto hidden md:block"/></button>)}</nav>
      </aside>

      <div className="min-h-0 overflow-y-auto p-5">
        {section === 'agents' && <AgentSection agents={agents} legacyBots={legacyBots} onCreateTask={onCreateTask} onOpenLarkSetup={onOpenLarkSetup}/>}
        {section === 'lark' && <LarkSection agents={agents} legacyBots={legacyBots} larkListeningDisabled={larkListeningDisabled} larkBotsLoading={larkBotsLoading} larkBotsFailed={larkBotsFailed} larkBotsRetrying={larkBotsRetrying} onRetryLarkBots={onRetryLarkBots} capabilities={capabilities} matrix={matrix} secretRefs={secretRefs} channelBots={channelBots} availableLarkRefs={availableLarkRefs} createOpen={createOpen} setCreateOpen={setCreateOpen} displayName={displayName} setDisplayName={setDisplayName} externalAppId={externalAppId} setExternalAppId={setExternalAppId} brand={brand} setBrand={setBrand} createBot={createBot} onOpenLarkSetup={onOpenLarkSetup}/>}
        {section === 'groups' && <GroupsSection cells={cells} missingBindings={missingBindings} repositoriesWired={capabilities.data?.repositoriesWired === true} onOpenLarkSetup={onOpenLarkSetup} onOpenGroups={onOpenGroups}/>}
        {section === 'automation' && <AutomationSection scheduleCount={scheduleCount} capabilities={scheduleCapabilities} onOpenSchedules={onOpenSchedules}/>}
      </div>
    </div>
  </Dialog>;
}

function AgentSection({ agents, legacyBots, onCreateTask, onOpenLarkSetup }: { agents: Agent[]; legacyBots: LarkBotConfig[]; onCreateTask(agentId: string): void; onOpenLarkSetup(): void }) {
  return <section aria-labelledby="control-agents">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="control-agents" className="text-title font-semibold text-primary">Agent</h3><p className="mt-1 text-caption text-subtle">Agent 是在这台机器上执行任务的 CLI。Dutydeck 会自动发现已安装并登录的受支持 CLI。</p></div>{statePill(agents.length ? `${agents.length} 个可用` : '尚未找到', agents.length ? 'ready' : 'blocked')}</div>
    {agents.length > 0 && <div className="mt-4 grid gap-3 sm:grid-cols-2">{agents.map(agent => {
      const boundBots = legacyBots.filter(bot => bot.defaultAgentId === agent.id);
      return <Card key={agent.id} as="article" padding="md">
        <div className="flex items-center gap-2"><Bot size={16} className="text-action"/><h4 className="text-body font-semibold text-primary">{agent.name}</h4>{statePill('可创建任务', 'ready')}</div>
        <p className="mt-1 text-meta text-subtle">{agent.version ? `${agent.version} · ` : ''}{agent.protocol === 'pty-cli' ? '终端 CLI' : agent.protocol.toUpperCase()}</p>
        {/* 「已绑定」不是「已连接」：这里只数了 defaultAgentId 指向本 Agent 的 Bot，没有读任何监听状态。 */}
        <div className="mt-3 grid grid-cols-2 gap-2 text-caption text-secondary"><div className="rounded-md bg-muted p-2">默认权限<br/><strong className="text-primary">{permissionLabel(agent.permissionMode)}</strong></div><div className="rounded-md bg-muted p-2">飞书 Bot<br/><strong className="text-primary">{boundBots.length ? `${boundBots.length} 个已绑定` : '尚未绑定'}</strong></div></div>
        <div className="mt-3 flex gap-2"><Button variant="primary" className="flex-1" onClick={() => onCreateTask(agent.id)}>用它创建任务</Button><Button variant="secondary" onClick={() => onOpenLarkSetup()}>{boundBots.length ? '管理 Bot' : '连接 Bot'}</Button></div>
      </Card>;
    })}</div>}
    <div className={`mt-4 rounded-lg border p-4 ${agents.length ? 'border-default bg-muted' : 'border-warning-border bg-warning-soft'}`}>
      <h4 className="text-body font-semibold text-primary">{agents.length ? '添加另一个 Agent' : '添加第一个 Agent'}</h4>
      <ol className="mt-2 space-y-2 text-caption text-secondary"><li><strong className="text-primary">1.</strong> 在运行 Dutydeck 的机器上安装并登录 Codex、Claude Code、Gemini 等受支持 CLI。</li><li><strong className="text-primary">2.</strong> 在终端运行 <code className="rounded-sm bg-inverse px-1.5 py-1 text-on-inverse">dutydeck restart</code>，让 Dutydeck 重新检测。</li><li><strong className="text-primary">3.</strong> 回到此页确认 Agent 显示为“可用”，再创建任务或连接飞书 Bot。</li></ol>
      <details className="mt-3 text-caption text-secondary"><summary className="cursor-pointer font-semibold text-primary">自定义 Agent</summary><p className="mt-2">通过 <code>DUTYDECK_AGENTS_JSON</code> 配置自定义 ACP/CLI 后重启。启动命令、环境变量、密钥和 system prompt 不会发送到浏览器。</p></details>
    </div>
  </section>;
}

type QueryLike<T> = { data?: T; isError: boolean; isLoading: boolean; refetch(): unknown };

function LarkSection({ agents, legacyBots, larkListeningDisabled, larkBotsLoading, larkBotsFailed, larkBotsRetrying, onRetryLarkBots, capabilities, matrix, secretRefs, channelBots, availableLarkRefs, createOpen, setCreateOpen, displayName, setDisplayName, externalAppId, setExternalAppId, brand, setBrand, createBot, onOpenLarkSetup }: {
  agents: Agent[];
  legacyBots: LarkBotConfig[];
  larkListeningDisabled: boolean;
  larkBotsLoading: boolean;
  larkBotsFailed: boolean;
  larkBotsRetrying: boolean;
  onRetryLarkBots?(): void;
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
  onOpenLarkSetup(target?: LarkSetupTarget): void;
}) {
  return <section aria-labelledby="control-lark">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="control-lark" className="text-title font-semibold text-primary">飞书 Bot</h3><p className="mt-1 text-caption text-subtle">Bot 负责在飞书收发消息，Agent 负责执行任务。绑定向导会把两者一次连好。</p></div><Button variant="primary" icon={<Plus size={15}/>} onClick={() => onOpenLarkSetup('new')}>{legacyBots.length ? '绑定新 Bot' : '绑定飞书 Bot'}</Button></div>
    {/*
      读取失败自成一档，且排在「还没有飞书 Bot」之前：larkConfig 失败后
      legacyBots 是空数组，直接走空态就会把「读不到」说成「没有」。
      有缓存时下面仍列出 Bot，但每张卡片都投影成「状态未确认」。
    */}
    {larkBotsFailed && <Banner tone="warning" action={onRetryLarkBots ? { label: larkBotsRetrying ? '重试中…' : '重试', busy: larkBotsRetrying, onClick: onRetryLarkBots } : undefined}>
      {legacyBots.length ? '飞书接入状态读取失败，下面的机器人状态未确认。' : '飞书接入状态读取失败，无法判断是否已配置机器人。'}
    </Banner>}
    {larkBotsLoading
      ? <div className="mt-4"><Spinner label="正在读取飞书接入状态…"/></div>
      : legacyBots.length === 0
        // 失败时不渲染「还没有飞书 Bot」引导：上面的 Banner 已说明状态未知。
        ? larkBotsFailed ? null : <EmptyState tone="guide" icon={<MessageSquare size={22}/>} title="还没有飞书 Bot" description="准备 App ID 和 App Secret；向导会校验应用、配置飞书能力，再让你选择默认 Agent、工作区和监听状态。" primaryAction={{ label: '开始绑定', onClick: onOpenLarkSetup }}/>
        : <div className="mt-4 space-y-2">{legacyBots.map(bot => {
        const agent = agents.find(item => item.id === bot.defaultAgentId);
        // 就绪判据与首页、侧栏同源，含 listening 与本次启动禁用监听两项，
        // 也含读取失败（此时状态未确认，不沿用缓存说「监听已启动」）。
        const status = projectLarkBotStatus(bot, larkListeningDisabled, false, larkBotsFailed);
        const ready = status.key === 'listening';
        return <Card key={bot.appId} as="article" padding="md"><div className="flex flex-wrap items-center gap-2"><MessageSquare size={15} className="text-action"/><h4 className="text-body font-semibold text-primary">{bot.name}</h4>{statePill(status.label, ready ? 'ready' : 'blocked')}</div><div className="mt-3 grid gap-2 text-caption sm:grid-cols-3"><div className="rounded-md bg-muted p-2 text-subtle">默认 Agent<br/><strong className="text-primary">{agent?.name || bot.defaultAgentId?.trim() || '未选择'}</strong></div><div className="rounded-md bg-muted p-2 text-subtle">工作区<br/><strong className="block truncate text-primary" title={bot.workspace}>{bot.workspace || '使用 Agent 默认目录'}</strong></div><div className="rounded-md bg-muted p-2 text-subtle">消息监听<br/><strong className="text-primary">{status.label}</strong></div></div><Button variant="secondary" className="mt-3" onClick={() => onOpenLarkSetup({ appId: bot.appId })}>{ready ? '管理设置' : '继续设置'}</Button></Card>;
      })}</div>}

    <details className="mt-6 rounded-lg border border-default bg-muted p-4">
      <summary className="cursor-pointer text-caption font-semibold text-secondary">迁移与高级草稿</summary>
      <p className="mt-2 text-caption text-secondary">以下是新控制面迁移草稿，只能离线保存，当前版本不能据此启动 Bot。日常接入请使用上方“绑定飞书 Bot”。</p>
      {(capabilities.isError || matrix.isError || secretRefs.isError) && <div className="mt-3"><Banner tone="danger">高级草稿状态读取失败。<button type="button" className="ml-1 font-semibold underline" onClick={() => { void capabilities.refetch(); void matrix.refetch(); void secretRefs.refetch(); }}>重试</button></Banner></div>}
      {capabilities.data?.blockers.length ? <details className="mt-3 rounded-md border border-warning-border bg-warning-soft p-3"><summary className="cursor-pointer text-caption font-semibold text-warning">查看 {capabilities.data.blockers.length} 项技术阻断</summary><div className="mt-2 space-y-2">{capabilities.data.blockers.map(blocker => <div key={blocker.code} className="text-caption text-warning"><strong>{blocker.code}</strong> · {blocker.message}<br/>下一步：{blocker.action}</div>)}</div></details> : null}
      <div className="mt-4 flex items-center justify-between gap-3"><h4 className="text-body font-semibold text-primary">ChannelBot 草稿</h4><Button variant="secondary" icon={<Plus size={14}/>} disabled={!capabilities.data?.writesEnabled} onClick={() => setCreateOpen(value => !value)}>创建 staged Bot</Button></div>
      {/*
        三个控件从手写 <label><input> 迁到 <Field> + <Input>/<Select>：Field 负责
        htmlFor/id 绑定（点标签能聚焦控件），显式 aria-label 保留原有可访问名
        （「ChannelBot 显示名称」而非可见的「显示名称」），两者不冲突。
      */}
      {createOpen && <form onSubmit={(event: FormEvent) => { event.preventDefault(); createBot.mutate(); }} className="mt-3 rounded-lg border border-default bg-surface p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="显示名称"><Input aria-label="ChannelBot 显示名称" value={displayName} onChange={event => setDisplayName(event.target.value)}/></Field>
          <Field label="飞书 App ID"><Input aria-label="ChannelBot App ID" value={externalAppId} onChange={event => setExternalAppId(event.target.value)}/></Field>
          <Field label="品牌"><Select value={brand} onChange={event => setBrand(event.target.value as 'feishu' | 'lark')}><option value="feishu">飞书</option><option value="lark">Lark</option></Select></Field>
        </div>
        <p className="mt-3 text-caption text-subtle">不需要 App Secret。结果固定为 staged / listener disabled，不能收发消息。</p>
        {createBot.error && <div className="mt-2"><Banner tone="danger">{createBot.error instanceof ApiError && createBot.error.status === 403 ? '需要 owner/admin 权限才能创建草稿。' : `创建失败：${createBot.error.message}`}</Banner></div>}
        <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" variant="primary" loading={createBot.isPending} disabled={!displayName.trim() || !externalAppId.trim()}>保存 staged 草稿</Button></div>
      </form>}
      <div className="mt-3 space-y-2">{channelBots.map(entry => <Card key={entry.bot.id} as="article" padding="sm"><div className="flex flex-wrap items-center gap-2"><Bot size={14}/><strong className="text-caption text-primary">{entry.bot.displayName}</strong>{statePill(`${entry.bot.state} / listener disabled`)}{statePill(entry.bot.credentialStatus === 'configured' ? 'SecretRef ready' : `credential ${entry.bot.credentialStatus}`, entry.bot.credentialStatus === 'configured' ? 'ready' : 'blocked')}</div></Card>)}</div>
      {matrix.isLoading && <div className="mt-3"><Spinner label="正在读取高级草稿…"/></div>}
      <Card padding="sm" className="mt-4"><div className="flex items-center gap-2"><KeyRound size={14}/><h4 className="text-caption font-semibold text-primary">SecretRef metadata</h4><span className="ml-auto text-caption text-subtle">可用 {availableLarkRefs.length}</span></div>{availableLarkRefs.length === 0 && <p className="mt-2 text-caption text-secondary">高级迁移凭据只能通过本机 CLI 写入：<code className="ml-1 rounded-sm bg-inverse px-1.5 py-1 text-on-inverse">dutydeck secret set &lt;ref-id&gt;</code></p>}</Card>
    </details>
  </section>;
}

function GroupsSection({ cells, missingBindings, repositoriesWired, onOpenLarkSetup, onOpenGroups }: { cells: Array<unknown>; missingBindings: number; repositoriesWired: boolean; onOpenLarkSetup(target?: LarkSetupTarget): void; onOpenGroups(): void }) {
  return <section aria-labelledby="control-groups">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="control-groups" className="text-title font-semibold text-primary">群与权限</h3><p className="mt-1 text-caption text-subtle">决定哪些群可以使用 Bot，以及聊天权限和操作权限的边界。</p></div>{statePill(cells.length ? `${cells.length} 个已发现群` : '尚未发现群', cells.length && !missingBindings ? 'ready' : 'blocked')}</div>
    {cells.length === 0
      ? <EmptyState tone="guide" icon={<Users size={21}/>} title="还没有可配置的群" description="先完成 Bot 绑定并把机器人加入飞书群，Dutydeck 收到群消息后会在这里展示。" primaryAction={{ label: '检查 Bot 设置', onClick: onOpenLarkSetup }}/>
      : <><div className="mt-4 grid gap-3 sm:grid-cols-3"><Card padding="md" tone="muted"><div className="text-caption font-semibold text-subtle">已配置群</div><div className="mt-1 text-heading font-semibold text-primary">{cells.length - missingBindings}/{cells.length}</div></Card><Card padding="md" tone="muted"><div className="text-caption font-semibold text-subtle">权限原则</div><div className="mt-1 text-body font-semibold text-primary">能聊天 ≠ 能操作终端</div><p className="mt-1 text-caption text-subtle">高风险操作单独授权</p></Card><div className="rounded-lg border border-warning-border bg-warning-soft p-4"><div className="text-caption font-semibold text-warning">高级策略运行时</div><div className="mt-1 text-body font-semibold text-warning">尚未启用</div></div></div><Button variant="primary" className="mt-4 w-full" disabled={!repositoriesWired} onClick={onOpenGroups}><span className="flex w-full items-center justify-between">查看群配置<ArrowRight size={15}/></span></Button></>}
  </section>;
}

function AutomationSection({ scheduleCount, capabilities, onOpenSchedules }: { scheduleCount: number; capabilities: QueryLike<Awaited<ReturnType<typeof scheduleApi.capabilities>>>; onOpenSchedules(): void }) {
  return <section aria-labelledby="control-automation">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="control-automation" className="text-title font-semibold text-primary">自动化</h3><p className="mt-1 text-caption text-subtle">查看各任务的定时执行计划，沿用所属任务的目录和上下文。</p></div>{statePill(`${scheduleCount} 个导入草稿`)}</div>
    <div className="mt-4"><Banner tone="info" title="导入草稿不会自动执行">
      <p>任务内创建并启用的计划会按时运行；导入定义仅保存为草稿，可单独管理和预览。</p>
    </Banner></div>
    {capabilities.isError && <div className="mt-3"><Banner tone="danger">草稿状态读取失败。<button type="button" className="ml-1 font-semibold underline" onClick={() => void capabilities.refetch()}>重试</button></Banner></div>}
    <Button variant="primary" className="mt-4 w-full" onClick={onOpenSchedules}><span className="flex w-full items-center justify-between">查看任务计划<ArrowRight size={15}/></span></Button>
  </section>;
}
