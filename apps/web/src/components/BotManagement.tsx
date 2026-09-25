import type { LarkSetupTarget } from '../app-route';
import { useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  ExternalLink,
  Plus,
  Search,
  Trash2,
  ChevronDown,
  ChevronRight,
  Shield,
  ArrowLeft,
  Check
} from 'lucide-react';
import {
  api,
  ApiError,
  type Agent,
  type LarkBotConfig,
  type RiskControlMode
} from '../api';
import { buildLarkBotAppLink, projectLarkBotStatus } from '../lark-status';
import { useDraftStore, type BotDraft } from '../draft-store';
import { Badge, Banner, Button, Card, EmptyState, Field, IconButton, Input, Select, Spinner, Textarea } from './primitives';
import { AgentSelect, CompactSelect } from './CompactSelect';
import { DirectoryPicker } from './DirectoryPicker';
import { ConfirmDialog } from './ConfirmDialog';
import { toastStore } from '../useToasts';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';

export type BotManagementProps = {
  selectedAppId?: string;
  onSelectBot(appId: string): void;
  onOpenLarkSetup(target?: LarkSetupTarget): void;
  onSelectGroup(chatId: string, appId?: string): void;
  agents: Agent[];
  larkListeningDisabled?: boolean;
};

export type { BotDraft };

function initialDraft(bot: LarkBotConfig): BotDraft {
  return {
    // 记下编辑起点的版本，保存时用它做 CAS（不用刷新后的 activeBot.revision）。
    baseRevision: bot.revision,
    workspace: bot.workspace ?? '',
    defaultAgentId: bot.defaultAgentId ?? '',
    defaultModel: bot.defaultModel ?? '',
    defaultReasoningEffort: bot.defaultReasoningEffort ?? '',
    p2pMode: bot.p2pMode ?? 'chat',
    groupReplyMode: bot.groupReplyMode ?? '',
    mentionPolicy: bot.mentionPolicy ?? 'always',
    defaultGroupParticipation: bot.defaultGroupParticipation ?? 'off',
    preInjectPrompt: bot.preInjectPrompt ?? '',
    listening: bot.listening ?? true,
    groupToolsEnabled: bot.groupToolsEnabled ?? false,
    groupToolsAllowSend: bot.groupToolsAllowSend ?? false,
    memoryEnabled: bot.memoryEnabled ?? true,
    memoryAutoExtract: bot.memoryAutoExtract ?? true,
    memoryAgentId: bot.memoryAgentId ?? '',
    memoryModel: bot.memoryModel ?? '',
    executionMode: bot.executionMode ?? 'single',
    leaderAgentId: bot.leaderAgentId ?? '',
    workerAgentIds: bot.workerAgentIds ?? [],
    riskControlMode: bot.riskControlMode ?? 'off',
    highRiskPattern: bot.highRiskPattern ?? ''
  };
}

function hasDraftChanges(original: LarkBotConfig, draft: BotDraft): boolean {
  // baseRevision 不参与比较：它是元数据，不是用户改的字段。
  if ((original.workspace ?? '') !== draft.workspace) return true;
  if ((original.defaultAgentId ?? '') !== draft.defaultAgentId) return true;
  if ((original.defaultModel ?? '') !== draft.defaultModel) return true;
  if ((original.defaultReasoningEffort ?? '') !== draft.defaultReasoningEffort) return true;
  if ((original.p2pMode ?? 'chat') !== draft.p2pMode) return true;
  if ((original.groupReplyMode ?? '') !== draft.groupReplyMode) return true;
  if ((original.mentionPolicy ?? 'always') !== draft.mentionPolicy) return true;
  if ((original.defaultGroupParticipation ?? 'off') !== draft.defaultGroupParticipation) return true;
  if ((original.preInjectPrompt ?? '') !== draft.preInjectPrompt) return true;
  if ((original.listening ?? true) !== draft.listening) return true;
  if ((original.groupToolsEnabled ?? false) !== draft.groupToolsEnabled) return true;
  if ((original.groupToolsAllowSend ?? false) !== draft.groupToolsAllowSend) return true;
  if ((original.memoryEnabled ?? true) !== draft.memoryEnabled) return true;
  if ((original.memoryAutoExtract ?? true) !== draft.memoryAutoExtract) return true;
  if ((original.memoryAgentId ?? '') !== draft.memoryAgentId) return true;
  if ((original.memoryModel ?? '') !== draft.memoryModel) return true;
  if ((original.executionMode ?? 'single') !== draft.executionMode) return true;
  if ((original.leaderAgentId ?? '') !== draft.leaderAgentId) return true;
  if ([...(original.workerAgentIds ?? [])].sort().join('\n') !== [...draft.workerAgentIds].sort().join('\n')) return true;
  if ((original.riskControlMode ?? 'off') !== draft.riskControlMode) return true;
  if ((original.highRiskPattern ?? '') !== draft.highRiskPattern) return true;
  return false;
}

/** 两份草稿的**用户可编辑内容**是否相同。baseRevision 是元数据，不参与比较。 */
function sameDraftContent(left: BotDraft, right: BotDraft): boolean {
  const strip = ({ baseRevision: _ignored, ...rest }: BotDraft) => rest;
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

/** 能当 Leader 的 Agent：旧版 PTY 不行；终端模式没有 deny-all，要机器人和该 Agent 都是完全信任。与服务端保存校验一致。 */
function leaderUsable(agent: Agent, bot: LarkBotConfig): boolean {
  if (agent.protocol === 'pty') return false;
  return agent.protocol !== 'pty-cli' || (agent.permissionMode === 'full-trust' && bot.permissionMode !== 'ask' && bot.permissionMode !== 'approve-reads');
}

function formatMemoryTime(iso?: string): string {
  return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '';
}

/** 一次保存提交所固定下来的东西。见 saveMutation 的注释。 */
type BotSaveVariables = { appId: string; draft: BotDraft; fullTrustConfirmed: boolean };

export function BotManagement({
  selectedAppId,
  onSelectBot,
  onOpenLarkSetup,
  onSelectGroup,
  agents,
  larkListeningDisabled = false
}: BotManagementProps) {
  const qc = useQueryClient();
  const [filterText, setFilterText] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deleteConfirmAppId, setDeleteConfirmAppId] = useState<string | null>(null);
  /*
    草稿在模块级 store 里，不在这个组件里。

    这个组件是 <main> 按 primaryNav 分派的一级视图，切去任务或群聊即卸载。
    草稿放 useState 会让「改了目录 → 切走看一眼 → 切回来」静默丢字段，
    而契约要求切换对象与视图都不能丢（见 draft-store.ts 头注释）。
  */
  const drafts = useDraftStore(state => state.botDrafts);
  const conflicts = useDraftStore(state => state.botConflicts);
  const setBotDraft = useDraftStore(state => state.setBotDraft);
  const clearBotDraft = useDraftStore(state => state.clearBotDraft);
  const setBotConflict = useDraftStore(state => state.setBotConflict);

  const larkConfig = useQuery({
    queryKey: ['lark-config'],
    queryFn: api.larkConfig,
    staleTime: 30_000
  });

  const managedGroups = useQuery({
    queryKey: ['lark-management-groups'],
    queryFn: api.managementGroups,
    staleTime: 30_000
  });

  // 原生目录对话框只在 macOS 可用；Linux 上按真实能力隐藏，避免摆一颗必然失败的按钮。
  const systemCapabilities = useQuery({
    queryKey: ['system-capabilities'],
    queryFn: api.systemCapabilities,
    staleTime: Infinity
  });

  const bots = useMemo(() => larkConfig.data?.bots ?? [], [larkConfig.data]);

  /*
    当前选中的 Bot。

    **没有 selectedAppId 时不自动选中首项**：窄屏的「返回机器人列表」正是靠清空
    selectedAppId 实现的，自动回退到 bots[0] 会让详情立刻又占满屏幕，用户永远
    退不回列表。桌面端两栏并存，右侧显示空态提示也比选错对象好。
  */
  const activeBot = useMemo(
    () => selectedAppId ? bots.find(b => b.appId === selectedAppId) : undefined,
    [bots, selectedAppId]
  );

  const activeAppId = activeBot?.appId;

  // 获得当前 activeBot 的 draft
  const currentDraft: BotDraft | undefined = useMemo(() => {
    if (!activeBot) return undefined;
    return drafts[activeBot.appId] ?? initialDraft(activeBot);
  }, [activeBot, drafts]);

  const updateCurrentDraft = (patch: Partial<BotDraft>) => {
    if (!activeAppId || !currentDraft) return;
    setBotDraft(activeAppId, { ...currentDraft, ...patch });
  };

  const resetCurrentDraft = () => {
    if (activeAppId) clearBotDraft(activeAppId);
  };

  /**
   * 冲突后「放弃草稿并载入最新」。
   *
   * 必须真的重新请求一次：只清草稿的话，界面回落到的是 React Query 缓存里那份
   * **已经过期的**配置——正是它触发了 409。用户会对着旧值继续编辑，再保存一次
   * 还是 409。
   */
  const discardAndReload = async () => {
    resetCurrentDraft();
    await larkConfig.refetch();
  };

  const isDirty = activeBot && currentDraft ? hasDraftChanges(activeBot, currentDraft) : false;

  // 模型选项
  const agentOptions = useQuery({
    queryKey: agentModelsQueryKey(currentDraft?.defaultAgentId, currentDraft?.defaultModel),
    queryFn: () => loadAgentModels(currentDraft!.defaultAgentId, currentDraft?.defaultModel || undefined),
    enabled: Boolean(currentDraft?.defaultAgentId),
    initialData: () => currentDraft?.defaultAgentId ? readCachedAgentModels(currentDraft.defaultAgentId, currentDraft.defaultModel || undefined) : undefined,
    staleTime: 5 * 60_000
  });

  // 机器人的群共享会话记忆状态
  const memoryStatusQuery = useQuery({
    queryKey: ['lark-memory-status', activeAppId],
    queryFn: () => api.larkMemoryStatus(activeAppId!),
    enabled: Boolean(activeAppId && currentDraft?.memoryEnabled),
    staleTime: 30_000,
    refetchInterval: query => query.state.data?.groups?.running ? 10_000 : false
  });

  /*
    保存。

    **提交对象由 variables 固定，不读闭包里的 activeBot / currentDraft。**

    请求在飞的时候用户可以切到别的 Bot：那一刻组件重渲染，activeAppId 已经指向
    B，而 onSuccess / onError 仍在为 A 的请求执行。读闭包会把 A 的成功清掉 B 的
    草稿，或把 A 的 409 贴到 B 的详情上——两者都是在改一个用户没提交过的对象。
    variables 是 react-query 给回调的「这次提交的是什么」，只有它是对的。

    另一半是「保存期间继续编辑同一个对象」：成功后不能无条件清草稿，否则用户在
    等待期间敲的字会被抹掉。所以只在草稿内容与提交内容一致时才清；不一致就保留
    新改动，并把它的 baseRevision 换成这次保存后的新版本——不换的话下一次保存会
    带着已经过期的 expectedRevision，撞出一个本不该有的 409。
  */
  const saveMutation = useMutation({
    mutationFn: async ({ appId, draft, fullTrustConfirmed }: BotSaveVariables) => api.saveLarkConfig({
      stage: 'agent',
      originalAppId: appId,
      appId,
      defaultAgentId: draft.defaultAgentId,
      defaultModel: draft.defaultModel,
      defaultReasoningEffort: draft.defaultReasoningEffort,
      workspace: draft.workspace,
      p2pMode: draft.p2pMode,
      groupReplyMode: draft.groupReplyMode || undefined,
      mentionPolicy: draft.mentionPolicy,
      defaultGroupParticipation: draft.defaultGroupParticipation,
      preInjectPrompt: draft.preInjectPrompt,
      listening: draft.listening,
      groupToolsEnabled: draft.groupToolsEnabled,
      groupToolsAllowSend: draft.groupToolsAllowSend,
      memoryEnabled: draft.memoryEnabled,
      memoryAutoExtract: draft.memoryAutoExtract,
      memoryAgentId: draft.memoryAgentId,
      memoryModel: draft.memoryModel,
      executionMode: draft.executionMode,
      leaderAgentId: draft.leaderAgentId,
      workerAgentIds: draft.workerAgentIds,
      riskControlMode: draft.riskControlMode,
      highRiskPattern: draft.highRiskPattern,
      fullTrustConfirmed,
      // 用编辑起点的版本，不是当下 activeBot.revision：后者可能已被后台刷新
      // 成别人保存后的新版本，拿它提交会让 CAS 放行并静默覆盖对方的修改。
      expectedRevision: draft.baseRevision
    }),
    onSuccess: (nextConfig, variables) => {
      const { appId, draft } = variables;
      const latest = useDraftStore.getState().botDrafts[appId];
      const savedRevision = nextConfig?.bots.find(b => b.appId === appId)?.revision;
      if (!latest || sameDraftContent(latest, draft)) {
        // 等待期间没再改：草稿的使命结束。
        clearBotDraft(appId);
      } else {
        // 等待期间又改了：保住新改动，但基准换成刚保存出来的版本。
        setBotDraft(appId, { ...latest, baseRevision: savedRevision ?? latest.baseRevision });
        setBotConflict(appId, undefined);
      }
      if (nextConfig) qc.setQueryData(['lark-config'], nextConfig);
      void qc.invalidateQueries({ queryKey: ['lark-config'] });
      toastStore.push({
        kind: 'success',
        key: `save-bot-${appId}`,
        title: '机器人默认配置已保存',
        description: '新开启的对话和话题将使用此默认配置。'
      });
    },
    onError: (error: unknown, variables) => {
      const { appId } = variables;
      if (error instanceof ApiError && error.status === 409) {
        setBotConflict(appId, error.message);
        toastStore.push({
          kind: 'error',
          key: `conflict-bot-${appId}`,
          title: '配置存在并发冲突',
          description: error.message
        });
      } else {
        toastStore.push({
          kind: 'error',
          key: `error-bot-${appId}`,
          title: '保存失败',
          description: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });

  /** 提交当前对象。variables 在这里定格，之后切走也不影响这次请求的归属。 */
  const submitSave = () => {
    if (!activeBot || !currentDraft) return;
    saveMutation.mutate({ appId: activeBot.appId, draft: currentDraft, fullTrustConfirmed: activeBot.fullTrustConfirmed });
  };

  /** 只有「正在保存的就是当前这个对象」时才显示忙碌态，否则切过去的 B 会跟着转圈。 */
  const savingThisBot = saveMutation.isPending && saveMutation.variables?.appId === activeAppId;

  // 删除 Bot
  const deleteMutation = useMutation({
    mutationFn: (appId: string) => api.deleteLarkConfig(appId),
    onSuccess: (nextConfig) => {
      setDeleteConfirmAppId(null);
      if (nextConfig) qc.setQueryData(['lark-config'], nextConfig);
      void qc.invalidateQueries({ queryKey: ['lark-config'] });
      toastStore.push({ kind: 'success', key: 'delete-bot', title: '机器人已移除' });
    }
  });

  // 过滤后的 Bot 列表
  const filteredBots = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return bots;
    return bots.filter(b =>
      b.name.toLowerCase().includes(query) ||
      b.appId.toLowerCase().includes(query) ||
      (b.workspace && b.workspace.toLowerCase().includes(query))
    );
  }, [bots, filterText]);

  // 该 Bot 参与的群聊
  const botGroups = useMemo(() => {
    if (!activeBot || !managedGroups.data?.groups) return [];
    return managedGroups.data.groups.filter(g =>
      g.bots.some(b => b.appId === activeBot.appId)
    );
  }, [activeBot, managedGroups.data]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* 顶部标题与主要操作 */}
      <header className="flex shrink-0 items-center justify-between border-b border-subtle bg-surface px-4 py-3 sm:px-6">
        <div>
          <h1 className="text-heading font-semibold text-primary">机器人管理</h1>
          <p className="mt-0.5 text-caption text-subtle">
            统一配置飞书 Bot 的默认执行 Agent、模型、工作目录与触发规则。
          </p>
        </div>
        <Button variant="primary" onClick={() => onOpenLarkSetup('new')} className="shrink-0 text-caption">
          <Plus size={14} className="mr-1.5" />
          添加飞书 Bot
        </Button>
      </header>

      {/* 主体分栏：列表 + 详情（响应式单列适配） */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左侧 Bot 列表 */}
        <aside
          className={`flex w-full flex-col border-r border-subtle bg-surface md:w-80 lg:w-96 ${
            activeBot ? 'hidden md:flex' : 'flex'
          }`}
        >
          <div className="border-b border-subtle p-3">
            <div className="relative">
              <Input
                value={filterText}
                onChange={e => setFilterText(e.target.value)}
                placeholder="搜索 Bot 名称或 App ID…"
                className="pl-8 text-caption"
              />
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {larkConfig.isLoading ? (
              <div className="grid h-48 place-items-center">
                <Spinner label="正在读取机器人列表…" />
              </div>
            ) : filteredBots.length === 0 ? (
              <div className="p-6 text-center text-caption text-subtle">
                {filterText ? '没有匹配的机器人' : '暂无配置的飞书 Bot'}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {filteredBots.map(bot => {
                  const status = projectLarkBotStatus(bot, larkListeningDisabled);
                  const isSelected = activeBot?.appId === bot.appId;
                  const hasDraft = drafts[bot.appId] && hasDraftChanges(bot, drafts[bot.appId]);
                  return (
                    <li key={bot.appId}>
                      <button
                        type="button"
                        onClick={() => onSelectBot(bot.appId)}
                        className={`flex w-full flex-col rounded-lg p-3 text-left transition-colors ${
                          isSelected
                            ? 'bg-action-soft text-primary'
                            : 'hover:bg-hover text-secondary'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <strong className="truncate text-body font-semibold text-primary">
                            {bot.name || '未命名 Bot'}
                          </strong>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </div>
                        <div className="mt-1 flex items-center justify-between text-meta text-subtle">
                          <span className="truncate font-mono">{bot.appId}</span>
                          {hasDraft && <span className="text-warning">● 未保存修改</span>}
                        </div>
                        <div className="mt-1.5 truncate text-caption text-subtle">
                          {bot.defaultAgentId ? `Agent: ${bot.defaultAgentId}` : '未设默认 Agent'}
                          {bot.workspace ? ` · ${bot.workspace}` : ''}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* 右侧 Bot 详情编辑器 */}
        <main
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-canvas p-4 sm:p-6 ${
            !activeBot ? 'hidden md:flex md:items-center md:justify-center' : 'flex'
          }`}
        >
          {!activeBot || !currentDraft ? (
            <EmptyState
              icon={<Bot size={36} className="text-subtle" />}
              title="未选择机器人"
              description="请从左侧选择要配置的飞书 Bot，或点击右上角添加新 Bot。"
            />
          ) : (
            <div className="mx-auto w-full max-w-4xl space-y-6">
              {/* 移动端返回列表按钮 */}
              <div className="md:hidden">
                <Button variant="ghost" size="sm" onClick={() => onSelectBot('')}>
                  <ArrowLeft size={14} className="mr-1" />
                  返回机器人列表
                </Button>
              </div>

              {/* 冲突提示 */}
              {conflicts[activeBot.appId] && (
                <Banner tone="danger">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <strong className="block">别人刚改过这个机器人的配置</strong>
                      <p className="mt-1 text-caption">
                        {conflicts[activeBot.appId]}。你填的内容已保留，没有被提交。可以放弃自己的修改、载入最新配置后重来，也可以逐项核对后再保存一次。
                      </p>
                    </div>
                    <Button variant="secondary" size="sm" loading={larkConfig.isFetching} onClick={() => void discardAndReload()}>
                      放弃修改并载入最新
                    </Button>
                  </div>
                </Banner>
              )}

              {/* Bot 头部名片卡 */}
              <Card padding="md" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle pb-3">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-info-soft text-info">
                      <Bot size={20} />
                    </span>
                    <div>
                      <h2 className="text-title font-semibold text-primary">
                        {activeBot.name || '未命名 Bot'}
                      </h2>
                      <p className="font-mono text-meta text-subtle">{activeBot.appId}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {buildLarkBotAppLink(activeBot.appId) && (
                      <a
                        href={buildLarkBotAppLink(activeBot.appId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center rounded-md border border-default bg-surface px-3 py-1.5 text-caption font-medium text-secondary shadow-card hover:bg-hover"
                      >
                        <ExternalLink size={13} className="mr-1.5" />
                        在飞书打开
                      </a>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => onOpenLarkSetup({ appId: activeBot.appId })}>
                      重新绑定 / 更新凭据
                    </Button>
                    <IconButton
                      label="删除此 Bot"
                      tone="danger"
                      onClick={() => setDeleteConfirmAppId(activeBot.appId)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                </div>

                {/* 快速状态条 */}
                <div className="flex flex-wrap items-center justify-between gap-2 text-caption">
                  <Badge tone={projectLarkBotStatus(activeBot, larkListeningDisabled).tone}>
                    {projectLarkBotStatus(activeBot, larkListeningDisabled).label}
                  </Badge>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <span className="text-secondary font-medium">接收飞书消息</span>
                    <input
                      type="checkbox"
                      checked={currentDraft.listening}
                      onChange={e => updateCurrentDraft({ listening: e.target.checked })}
                      className="rounded border-default text-action focus:ring-action"
                    />
                  </label>
                </div>
              </Card>

              {/* 区块 1：默认行为配置 */}
              <Card padding="lg" className="space-y-4">
                <div>
                  <h3 className="text-body font-semibold text-primary">默认设置</h3>
                  <p className="mt-0.5 text-caption text-subtle">
                    没有单独配置的群，以及私聊，都用这里的执行设置。执行设置用于新对话，群参与模式保存后生效。
                  </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-caption font-medium text-secondary">
                      默认执行 Agent
                    </label>
                    <AgentSelect
                      agents={agents}
                      value={currentDraft.defaultAgentId}
                      onChange={val => updateCurrentDraft({ defaultAgentId: val, defaultModel: '', defaultReasoningEffort: '' })}
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-caption font-medium text-secondary">
                      默认模型
                    </label>
                    <CompactSelect
                      options={[
                        { value: '', label: agentOptions.data?.defaultModel ? `使用 Agent 默认 (${agentOptions.data.defaultModel})` : '使用 Agent 默认' },
                        ...(agentOptions.data?.models ?? []).map(m => ({ value: m.id, label: m.name, meta: m.id !== m.name ? m.id : undefined }))
                      ]}
                      value={currentDraft.defaultModel}
                      placeholder="选择默认模型"
                      disabledText=""
                      onChange={val => updateCurrentDraft({ defaultModel: val, defaultReasoningEffort: '' })}
                    />
                  </div>
                </div>

                <DirectoryPicker
                  value={currentDraft.workspace}
                  onChange={val => updateCurrentDraft({ workspace: val })}
                  label="默认工作目录"
                  description="新任务默认在这个目录下执行；留空则用 Agent 自己的默认目录。"
                  allowNative={Boolean(systemCapabilities.data?.directoryPicker)}
                />

                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <label className="mb-1.5 block text-caption font-medium text-secondary" htmlFor="bot-p2p-mode">
                      私聊时
                    </label>
                    <Select
                      id="bot-p2p-mode"
                      value={currentDraft.p2pMode}
                      onChange={e => updateCurrentDraft({ p2pMode: e.target.value as 'chat' | 'thread' })}
                    >
                      <option value="chat">直接在聊天里回复</option>
                      <option value="thread">每个任务开一个话题</option>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-caption font-medium text-secondary" htmlFor="bot-group-reply">
                      群里回复到哪
                    </label>
                    <Select
                      id="bot-group-reply"
                      value={currentDraft.groupReplyMode}
                      onChange={e => updateCurrentDraft({ groupReplyMode: e.target.value as any })}
                    >
                      <option value="">自动选择</option>
                      <option value="chat">直接回在群里</option>
                      <option value="shared">回在同一个话题里</option>
                      <option value="new-topic">每个任务开一个话题</option>
                      <option value="chat-topic">回在提问所在的话题里</option>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-caption font-medium text-secondary" htmlFor="bot-mention">
                      群里怎样才唤醒
                    </label>
                    <Select
                      id="bot-mention"
                      value={currentDraft.mentionPolicy}
                      onChange={e => updateCurrentDraft({ mentionPolicy: e.target.value as any })}
                    >
                      <option value="always">每次都要 @ 它</option>
                      <option value="topic">新话题要 @，同一话题里可以直接说</option>
                      {/*
                        never 与 ambient 都是「不用 @」。原先这里把 never 写成
                        「从不响应」，与运行时相反——那会让人以为选它等于关掉这个群。
                      */}
                      <option value="ambient">群里任何消息都响应</option>
                      <option value="never">不用 @ 也会响应</option>
                    </Select>
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-caption font-medium text-secondary" htmlFor="bot-default-group-participation">
                    默认群参与模式
                  </label>
                  <Select
                    id="bot-default-group-participation"
                    value={currentDraft.defaultGroupParticipation}
                    onChange={e => updateCurrentDraft({ defaultGroupParticipation: e.target.value as BotDraft['defaultGroupParticipation'] })}
                  >
                    <option value="off">关闭</option>
                    <option value="observe">仅观察</option>
                    <option value="selective">Tag 按需参与</option>
                  </Select>
                  <p className="mt-1.5 text-caption text-subtle">
                    选择「Tag 按需参与」后，所有群默认先判断普通消息是否需要回复；决定回复时用 OK 标记开始处理。群可单独覆盖。关闭时沿用唤醒规则，仅观察时不自动回复普通消息。
                  </p>
                  {currentDraft.defaultGroupParticipation !== 'off' && (!currentDraft.groupToolsEnabled || currentDraft.defaultGroupParticipation === 'selective' && !currentDraft.groupToolsAllowSend) && (
                    <p className="mt-1.5 text-caption text-warning">
                      此模式需要在高级设置开启「允许它读取群聊内容」；Tag 回复还需要「允许它主动往群里发消息」。当前权限尚未满足。
                    </p>
                  )}
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="mb-1.5 block text-caption font-medium text-secondary" htmlFor="bot-execution-mode">
                      执行方式
                    </label>
                    <Select
                      id="bot-execution-mode"
                      value={currentDraft.executionMode}
                      onChange={e => updateCurrentDraft({ executionMode: e.target.value as BotDraft['executionMode'] })}
                    >
                      <option value="single">单 Agent：默认 Agent 直接完成</option>
                      <option value="layered">分层协作：PMO + Leader + Worker</option>
                    </Select>
                    <p className="mt-1.5 text-caption text-subtle">
                      分层协作只在群聊生效，单聊仍由默认 Agent 直接处理。群聊里默认 Agent 当 PMO 负责接待和答复；改代码、跑测试这类任务写成简报交给 Leader，Leader 只读拆解并指派 Worker，最后由 Leader 验收。计划要点「开始执行」才派发，每个 Worker 完成后自动停止它的会话。
                    </p>
                  </div>
                  {currentDraft.executionMode === 'layered' && (
                    <>
                      <div>
                        <label className="mb-1.5 block text-caption font-medium text-secondary" htmlFor="bot-leader-agent">
                          Leader Agent
                        </label>
                        <Select
                          id="bot-leader-agent"
                          value={currentDraft.leaderAgentId}
                          onChange={e => updateCurrentDraft({ leaderAgentId: e.target.value })}
                        >
                          <option value="">选择 Leader Agent</option>
                          {agents.filter(agent => leaderUsable(agent, activeBot)).map(agent => (
                            <option key={agent.id} value={agent.id}>{agent.name}</option>
                          ))}
                          {/* 已选的 Leader 被删或不能用时照样列出，否则下拉框显示空选项、保存却被拒。 */}
                          {currentDraft.leaderAgentId && !agents.some(agent => agent.id === currentDraft.leaderAgentId && leaderUsable(agent, activeBot)) && (
                            <option value={currentDraft.leaderAgentId}>{currentDraft.leaderAgentId}（不可用，请重选）</option>
                          )}
                        </Select>
                        <p className="mt-1.5 text-caption text-subtle">
                          ACP Agent 以 deny-all 规划。终端模式 Agent 以完全信任规划和验收，「不改文件」只靠提示词约束；机器人为完全信任、且该 Agent 在 DUTYDECK_AGENTS_JSON 里设为 full-trust 时才可选。
                        </p>
                      </div>
                      <fieldset>
                        <legend className="mb-1.5 block text-caption font-medium text-secondary">Worker Agent（最多 8 个）</legend>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {/* 已删除的 Worker 也列出来，否则取消不掉，保存一直被拒。 */}
                          {[...agents, ...currentDraft.workerAgentIds.filter(id => !agents.some(agent => agent.id === id)).map(id => ({ id, name: `${id}（已不存在）` }))].map(agent => (
                            <label key={agent.id} className="flex items-center gap-2 text-caption">
                              <input
                                type="checkbox"
                                checked={currentDraft.workerAgentIds.includes(agent.id)}
                                onChange={e => updateCurrentDraft({ workerAgentIds: e.target.checked ? [...currentDraft.workerAgentIds, agent.id] : currentDraft.workerAgentIds.filter(id => id !== agent.id) })}
                                className="rounded border-default text-action focus:ring-action"
                              />
                              <span>{agent.name}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      {(!currentDraft.groupToolsEnabled || !currentDraft.leaderAgentId || !currentDraft.workerAgentIds.length) && (
                        <p className="text-caption text-warning">
                          分层协作需要选择 Leader 和至少一个 Worker，并在高级设置开启「允许它读取群聊内容」。
                        </p>
                      )}
                    </>
                  )}
                </div>

                <Field label="每次任务前自动加一句话" hint="可选。会在每一轮对话前附加给 Agent，用来固定语言、格式或注意事项。">
                  <Textarea
                    rows={2}
                    value={currentDraft.preInjectPrompt}
                    onChange={e => updateCurrentDraft({ preInjectPrompt: e.target.value })}
                    placeholder="可选，例如：在回复前先用中文确认要点"
                  />
                </Field>

                <div className="space-y-3 border-t border-subtle pt-4">
                  <h4 className="text-caption font-semibold text-primary">会话记忆</h4>
                  <label className="flex items-center gap-2 text-caption">
                    <input
                      type="checkbox"
                      checked={currentDraft.memoryEnabled}
                      onChange={e => updateCurrentDraft({ memoryEnabled: e.target.checked })}
                      className="rounded border-default text-action focus:ring-action"
                    />
                    <span>启用会话记忆</span>
                  </label>
                  {currentDraft.memoryEnabled && (
                    <>
                      <label className="flex items-center gap-2 text-caption">
                        <input
                          type="checkbox"
                          checked={currentDraft.memoryAutoExtract}
                          onChange={e => updateCurrentDraft({ memoryAutoExtract: e.target.checked })}
                          className="rounded border-default text-action focus:ring-action"
                        />
                        <span>自动提取与整理</span>
                      </label>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-caption font-medium text-secondary" htmlFor="bot-memory-agent">
                            整理 Agent
                          </label>
                          <Select
                            id="bot-memory-agent"
                            value={currentDraft.memoryAgentId}
                            onChange={e => updateCurrentDraft({ memoryAgentId: e.target.value })}
                          >
                            <option value="">沿用机器人默认 Agent</option>
                            {agents.map(agent => (
                              <option key={agent.id} value={agent.id}>{agent.name}</option>
                            ))}
                          </Select>
                        </div>
                        <Field label="整理模型" hint="留空则沿用默认模型。">
                          <Input
                            value={currentDraft.memoryModel}
                            onChange={e => updateCurrentDraft({ memoryModel: e.target.value })}
                            placeholder="可选，例如 gpt-4o-mini"
                          />
                        </Field>
                      </div>
                    </>
                  )}
                  {activeBot && currentDraft.memoryEnabled && (
                    <div className="rounded-md border border-subtle bg-muted p-3 space-y-1.5 text-caption text-secondary">
                      {memoryStatusQuery.isLoading ? (
                        <p className="text-subtle">读取中…</p>
                      ) : memoryStatusQuery.isError ? (
                        <p className="text-warning">记忆状态读取失败</p>
                      ) : memoryStatusQuery.data?.groups ? (
                        <>
                          <p>
                            群共享记忆：{memoryStatusQuery.data.groups.liveEntries} 条 · {memoryStatusQuery.data.groups.topics} 个主题 · 待提取 {memoryStatusQuery.data.groups.pendingTurns} 轮
                          </p>
                          <p>
                            上次提取 {memoryStatusQuery.data.groups.lastExtractionAt ? formatMemoryTime(memoryStatusQuery.data.groups.lastExtractionAt) : '尚未提取'} · 上次整理 {memoryStatusQuery.data.groups.lastConsolidationAt ? formatMemoryTime(memoryStatusQuery.data.groups.lastConsolidationAt) : '尚未整理'}
                          </p>
                          {memoryStatusQuery.data.groups.running && (
                            <p>
                              正在运行：{memoryStatusQuery.data.groups.running.kind === 'extraction' ? '提取' : '整理'}
                            </p>
                          )}
                          <p>
                            {memoryStatusQuery.data.groups.lastRun ? (
                              <>
                                <span>{`上次运行：${memoryStatusQuery.data.groups.lastRun.kind === 'extraction' ? '提取' : '整理'} · ${formatMemoryTime(memoryStatusQuery.data.groups.lastRun.at)} · `}</span>
                                {memoryStatusQuery.data.groups.lastRun.ok ? (
                                  <span>成功</span>
                                ) : (
                                  <span className="text-warning">
                                    失败{memoryStatusQuery.data.groups.lastRunLabel ? ` ${memoryStatusQuery.data.groups.lastRunLabel}` : ''}
                                  </span>
                                )}
                              </>
                            ) : (
                              '上次运行：尚未运行'
                            )}
                          </p>
                          <p className="pt-1 text-meta text-subtle">
                            私聊的记忆各自独立，在对应私聊里发 /memory 查看。
                          </p>
                        </>
                      ) : null}
                    </div>
                  )}
                  <p className="text-caption text-subtle">各群共享同一份记忆，私聊各自独立；仅作为参考内容注入，不授予操作权限。</p>
                </div>
              </Card>

              {/* 区块 2：参与的群聊 */}
              <Card padding="lg" className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-body font-semibold text-primary">已参与的群聊 ({botGroups.length})</h3>
                    <p className="mt-0.5 text-caption text-subtle">
                      此 Bot 在各群中的配置与覆盖状态；点击可直接跳转到对应群聊进行精确调整。
                    </p>
                  </div>
                </div>

                {botGroups.length === 0 ? (
                  <div className="rounded-md border border-subtle bg-muted p-4 text-center text-caption text-subtle">
                    暂未发现该 Bot 参与的群聊。可前往「群聊」页面同步群列表或入群后查看。
                  </div>
                ) : (
                  <ul className="divide-y divide-subtle rounded-md border border-subtle bg-surface">
                    {botGroups.map(group => {
                      const groupBot = group.bots.find(b => b.appId === activeBot.appId);
                      const hasOverride = Boolean(groupBot?.binding);
                      return (
                        <li key={group.key} className="flex items-center justify-between p-3">
                          <div className="min-w-0 flex-1">
                            <strong className="block truncate text-caption font-semibold text-primary">
                              {group.name}
                            </strong>
                            <div className="mt-0.5 flex items-center gap-2 text-meta text-subtle">
                              <span className="font-mono">{group.chatId}</span>
                              <span>·</span>
                              <span>{hasOverride ? '已单独配置' : '继承 Bot 默认'}</span>
                            </div>
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onSelectGroup(group.chatId, activeBot.appId)}
                          >
                            配置本群
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              {/* 区块 3：接入与权限（折叠展开） */}
              <Card padding="md" className="space-y-3">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen(v => !v)}
                  className="flex w-full items-center justify-between text-left text-body font-semibold text-primary"
                >
                  <span className="flex items-center gap-2">
                    <Shield size={16} className="text-sidebar-accent" />
                    权限与风险控制
                  </span>
                  {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>

                {advancedOpen && (
                  <div className="space-y-4 border-t border-subtle pt-3">
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-2 text-caption">
                        <input
                          type="checkbox"
                          checked={currentDraft.groupToolsEnabled}
                          onChange={e => updateCurrentDraft({ groupToolsEnabled: e.target.checked })}
                          className="rounded border-default text-action focus:ring-action"
                        />
                        <span>允许它读取群聊内容</span>
                      </label>
                      <label className="flex items-center gap-2 text-caption">
                        <input
                          type="checkbox"
                          checked={currentDraft.groupToolsAllowSend}
                          onChange={e => updateCurrentDraft({ groupToolsAllowSend: e.target.checked })}
                          className="rounded border-default text-action focus:ring-action"
                        />
                        <span>允许它主动往群里发消息</span>
                      </label>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-caption font-medium text-secondary" htmlFor="bot-risk-mode">
                          遇到高危命令时
                        </label>
                        <Select
                          id="bot-risk-mode"
                          value={currentDraft.riskControlMode}
                          onChange={e => updateCurrentDraft({ riskControlMode: e.target.value as RiskControlMode })}
                        >
                          <option value="off">不做检查</option>
                          <option value="guidance">提醒 Agent 谨慎执行</option>
                          <option value="enforced">拒绝未授权的高危命令</option>
                        </Select>
                      </div>

                      <Field label="哪些命令算高危" hint="正则表达式，匹配到的命令按上面的方式处理。">
                        <Input
                          value={currentDraft.highRiskPattern}
                          onChange={e => updateCurrentDraft({ highRiskPattern: e.target.value })}
                          placeholder="例如 rm -rf|mkfs"
                          className="font-mono text-meta"
                        />
                      </Field>
                    </div>
                  </div>
                )}
              </Card>

              {/* 底部保存条 */}
              <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-default bg-surface p-4 shadow-card">
                <div className="text-caption text-subtle">
                  {isDirty ? (
                    <span className="font-medium text-warning">● 有未保存的修改</span>
                  ) : (
                    <span>已保存。</span>
                  )}
                  <span className="ml-2 hidden sm:inline text-meta text-subtle">
                    （执行设置用于新话题，权限立即生效）
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    disabled={!isDirty || savingThisBot}
                    onClick={resetCurrentDraft}
                  >
                    放弃修改
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!isDirty}
                    loading={savingThisBot}
                    onClick={submitSave}
                  >
                    <Check size={14} className="mr-1.5" />
                    保存配置
                  </Button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={Boolean(deleteConfirmAppId)}
        tone="danger"
        title="移除此飞书 Bot？"
        description="移除后将停止该 Bot 的全部监听，并清除其在 Dutydeck 中的本地配置绑定。"
        confirmLabel="确认移除"
        busy={deleteMutation.isPending}
        onCancel={() => setDeleteConfirmAppId(null)}
        onConfirm={() => {
          if (deleteConfirmAppId) deleteMutation.mutate(deleteConfirmAppId);
        }}
      />
    </div>
  );
}
