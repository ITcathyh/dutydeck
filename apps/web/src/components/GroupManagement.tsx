import { useState, useMemo, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  Search,
  RefreshCw,
  Check,
  ChevronDown,
  ChevronRight,
  Shield,
  ArrowLeft,
  UserPlus,
  ExternalLink
} from 'lucide-react';
import {
  api,
  ApiError,
  type Agent,
  type LarkBotConfig,
  type ManagedGroupBot,
  type RoleChange
} from '../api';
import type {
  GroupBinding,
  PresentationOverride,
  RoleAssignment
} from '@dutydeck/shared';
import { Badge, Banner, Button, Card, EmptyState, Input, Select, Spinner } from './primitives';
import { AgentSelect, CompactSelect } from './CompactSelect';
import { DirectoryPicker } from './DirectoryPicker';
import { CollaborationPanel } from './CollaborationPanel';
import { useDraftStore, type GroupAccessMode, type GroupBotDraft, type PresentationToggle } from '../draft-store';
import { toastStore } from '../useToasts';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';

export type GroupManagementProps = {
  selectedChatId?: string;
  selectedAppId?: string;
  onSelectGroup(chatId: string, appId?: string): void;
  onNavigateToBot(appId: string): void;
  agents: Agent[];
};

export type { GroupBotDraft };

/*
  群内角色只开放两档，且 can_operate 的范围只到本群。

  admin 与 bot_runs 刻意不出现在这个界面上：admin 是跨群的管理授权，bot_runs 让
  一个人能操作这个 Bot 在**所有群**里的任务——两者都会从「配置这一个群」的动作里
  溢出到别的群去。契约明写群保存只能授予属于本群的角色，所以选项在这里就不给，
  而不是给了再靠服务端拒绝。
*/
const groupRoleKinds = ['can_talk', 'can_operate'] as const;
type GroupRoleKind = (typeof groupRoleKinds)[number];
const groupOperateScopes = ['own_runs', 'group_runs'] as const;
type GroupOperateScope = (typeof groupOperateScopes)[number];

const accessModeLabels: Record<GroupAccessMode, string> = {
  inherit: '继承 Bot 默认访问策略',
  all_chat_members: '本群所有成员都可以使用',
  allowlist: '仅指定成员可以使用',
  owner_only: '仅安装者本人可以使用',
  disabled: '在本群停用（不响应任何人）'
};

const replyModeLabels: Record<string, string> = { chat: '在群内回复', shared: '共用一个话题', 'new-topic': '每次新建话题', 'chat-topic': '在原话题回复' };
const mentionPolicyLabels: Record<string, string> = { always: '每次都需要 @', topic: '新话题需要 @，话题内直接续聊', ambient: '直接响应群消息', never: '无需 @' };

/**
 * 群内某个 Bot 的草稿键。
 *
 * **用服务端返回的 group.key 而不是 chatId**：chatId 只在单个租户内唯一，
 * 跨租户拿到同一个 ID 时，两个不同的群会共用同一份草稿——用户在 A 群填的目录
 * 会出现在 B 群的表单里，保存下去就是配错群。group.key 是服务端按已验证的
 * 租户 + 品牌边界算出来的，正是为这件事存在的。
 */
export const groupBotDraftKey = (groupKey: string, appId: string) => `${groupKey}:${appId}`;

/** 群级呈现里的布尔项。顺序即界面顺序。 */
const PRESENTATION_TOGGLES = [
  { key: 'presentationCompletionReactionOnly', label: '完成时只贴表情、不发结果卡', hint: '开启后任务完成只对原消息贴一个表情，不再发结果卡。' },
  { key: 'presentationSilentProgress', label: '中间进展静默', hint: '开启后不发中间进展，只保留最终结果。' },
  { key: 'presentationGroupCardMention', label: '群卡片 @ 发起人', hint: '群内审批卡与结果卡是否 @ 发起人。' },
  { key: 'presentationHideTraceOnComplete', label: '完成后折叠执行过程', hint: '结果卡里是否默认收起执行过程。' },
  { key: 'presentationStructuredAskCards', label: '结构化问答卡片', hint: '问答用结构化组件还是文字选项。' }
] as const satisfies ReadonlyArray<{ key: keyof GroupBotDraft; label: string; hint: string }>;

/** 两份群草稿的**用户可编辑内容**是否相同。baseRevision 是元数据，不参与比较。 */
function sameGroupDraftContent(left: GroupBotDraft, right: GroupBotDraft): boolean {
  const strip = ({ baseRevision: _ignored, ...rest }: GroupBotDraft) => rest;
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}

/** 一次保存提交所固定下来的东西。见 saveMutation 的注释。 */
type GroupSaveVariables = { key: string; appId: string; chatId: string; draft: GroupBotDraft };

/*
  群级呈现覆盖 <-> 草稿。

  布尔项在界面上是三态（继承 / 本群开 / 本群关），不是复选框：复选框只能表达开与
  关，表达不了「跟随 Bot 默认」，一渲染就等于替用户做了选择。
*/
const toggleFromOverride = (item: { mode: 'inherit' | 'set'; value?: boolean }): PresentationToggle =>
  item.mode === 'set' ? (item.value ? 'on' : 'off') : 'inherit';
const toggleToOverride = (toggle: PresentationToggle): { mode: 'inherit' } | { mode: 'set'; value: boolean } =>
  toggle === 'inherit' ? { mode: 'inherit' } : { mode: 'set', value: toggle === 'on' };

function presentationDraft(binding?: GroupBinding) {
  const override = binding?.presentationOverride;
  return {
    presentationStructuredAskCards: override ? toggleFromOverride(override.structuredAskCards) : 'inherit' as const,
    presentationGroupCardMention: override ? toggleFromOverride(override.groupCardMention) : 'inherit' as const,
    presentationHideTraceOnComplete: override ? toggleFromOverride(override.hideTraceOnComplete) : 'inherit' as const,
    presentationCompletionReactionOnly: override ? toggleFromOverride(override.completionReactionOnly) : 'inherit' as const,
    presentationSilentProgress: override ? toggleFromOverride(override.silentProgress) : 'inherit' as const,
    presentationPushIntervalMode: override?.pushIntervalMs.mode === 'set' ? 'set' as const : 'inherit' as const,
    presentationPushIntervalValue: override?.pushIntervalMs.mode === 'set' ? String(override.pushIntervalMs.value) : '',
    presentationTraceLimitMode: override?.traceLimit.mode === 'set' ? 'set' as const : 'inherit' as const,
    presentationTraceLimitValue: override?.traceLimit.mode === 'set' ? String(override.traceLimit.value) : ''
  };
}

/** 数字项填不出合法值时的提示；返回 undefined 表示可以保存。 */
function presentationInputError(draft: GroupBotDraft): string | undefined {
  const pushIntervalMs = Number(draft.presentationPushIntervalValue);
  const traceLimit = Number(draft.presentationTraceLimitValue);
  if (draft.presentationPushIntervalMode === 'set' && !(Number.isInteger(pushIntervalMs) && pushIntervalMs >= 500 && pushIntervalMs <= 20000)) {
    return '本群推送间隔要填 500-20000 之间的整数。';
  }
  if (draft.presentationTraceLimitMode === 'set' && !(Number.isInteger(traceLimit) && traceLimit >= 1 && traceLimit <= 200)) {
    return '本群 Trace 阶段上限要填 1-200 之间的整数。';
  }
  return undefined;
}

function presentationOverrideFromDraft(draft: GroupBotDraft): PresentationOverride {
  const pushIntervalMs = Number(draft.presentationPushIntervalValue);
  const traceLimit = Number(draft.presentationTraceLimitValue);
  return {
    structuredAskCards: toggleToOverride(draft.presentationStructuredAskCards),
    groupCardMention: toggleToOverride(draft.presentationGroupCardMention),
    // 数字项填不出合法值时退回继承，而不是提交一个服务端必然拒绝的 0。
    pushIntervalMs: draft.presentationPushIntervalMode === 'set' && Number.isInteger(pushIntervalMs) && pushIntervalMs >= 500 && pushIntervalMs <= 20000
      ? { mode: 'set', value: pushIntervalMs } : { mode: 'inherit' },
    traceLimit: draft.presentationTraceLimitMode === 'set' && Number.isInteger(traceLimit) && traceLimit > 0
      ? { mode: 'set', value: traceLimit } : { mode: 'inherit' },
    hideTraceOnComplete: toggleToOverride(draft.presentationHideTraceOnComplete),
    completionReactionOnly: toggleToOverride(draft.presentationCompletionReactionOnly),
    silentProgress: toggleToOverride(draft.presentationSilentProgress)
  };
}

function initialDraftFromBinding(binding?: GroupBinding): GroupBotDraft {
  if (!binding) {
    return {
      // 还没有绑定：expectedRevision 用 0 表示「请创建」。
      baseRevision: 0,
      agentMode: 'inherit',
      agentValue: '',
      workspaceMode: 'inherit',
      workspaceValue: '',
      modelMode: 'inherit',
      modelValue: '',
      reasoningMode: 'inherit',
      reasoningValue: '',
      groupReplyMode: 'inherit',
      mentionPolicy: 'inherit',
      accessMode: 'inherit',
      accessPrincipalIds: [],
      oncall: false,
      toolRead: 'inherit',
      toolDiscover: 'inherit',
      toolSend: 'inherit',
      ...presentationDraft(),
      roleChanges: []
    };
  }

  return {
    // 记下编辑起点的版本；保存时用它，不用刷新后的 binding.revision。
    baseRevision: binding.revision,
    agentMode: binding.agentOverride.mode === 'set' ? 'set' : 'inherit',
    agentValue: binding.agentOverride.mode === 'set' ? binding.agentOverride.value : '',
    workspaceMode: binding.workspaceOverride.mode === 'set' ? 'set' : 'inherit',
    workspaceValue: binding.workspaceOverride.mode === 'set' ? binding.workspaceOverride.value : '',
    modelMode: binding.modelOverride.mode,
    modelValue: binding.modelOverride.mode === 'set' ? binding.modelOverride.value : '',
    reasoningMode: binding.reasoningOverride.mode,
    reasoningValue: binding.reasoningOverride.mode === 'set' ? binding.reasoningOverride.value : '',
    groupReplyMode: binding.routingOverride.groupReplyMode.mode === 'set' ? binding.routingOverride.groupReplyMode.value : 'inherit',
    mentionPolicy: binding.routingOverride.mentionPolicy.mode === 'set' ? binding.routingOverride.mentionPolicy.value : 'inherit',
    accessMode: binding.accessOverride.mode,
    accessPrincipalIds: [...binding.accessOverride.principalIds],
    oncall: binding.oncall,
    toolRead: binding.groupToolsOverride.read,
    toolDiscover: binding.groupToolsOverride.discover,
    toolSend: binding.groupToolsOverride.send,
    ...presentationDraft(binding),
    roleChanges: []
  };
}

/**
 * 有效值的显示文案。
 *
 * `source === 'unconfigured'`（或 value 缺失）表示**服务端没有解析出这一项**，
 * 此时运行时沿用 legacy 行为。界面必须说「按现有默认行为」，不能替它填一个
 * 具体取值——写成「chat-topic」就是在声称一个尚未生效的配置已经生效。
 */
function effectiveText(explained: { value?: string; source?: string } | undefined, fallback: string): string {
  if (explained?.source === 'group_clear') return '使用 Agent 默认';
  if (!explained || explained.value === undefined || explained.source === 'unconfigured') return fallback;
  return explained.value;
}

export function GroupManagement({
  selectedChatId,
  selectedAppId,
  onSelectGroup,
  onNavigateToBot,
  agents
}: GroupManagementProps) {
  const qc = useQueryClient();
  const [filterText, setFilterText] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'custom' | 'issues'>('all');
  const [activeEditingAppId, setActiveEditingAppId] = useState<string | null>(selectedAppId ?? null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [newRolePrincipal, setNewRolePrincipal] = useState('');
  const [newRoleKind, setNewRoleKind] = useState<GroupRoleKind>('can_talk');
  const [newRoleOperateScope, setNewRoleOperateScope] = useState<GroupOperateScope>('own_runs');
  /*
    上一次同步里失败的 Bot。

    留在页面上而不是只发一条 toast：toast 几秒就消失，而「哪个机器人没同步成功」
    是用户接下来要去修的事，得一直看得见。
  */
  const [syncFailures, setSyncFailures] = useState<Array<{ appId: string; name: string; message: string }>>([]);
  const autoSyncedBots = useRef(new Set<string>());
  /* 草稿在模块级 store 里，切走视图不丢；理由见 draft-store.ts 头注释。 */
  const drafts = useDraftStore(state => state.groupBotDrafts);
  const conflicts = useDraftStore(state => state.groupBotConflicts);
  const setGroupBotDraft = useDraftStore(state => state.setGroupBotDraft);
  const clearGroupBotDraft = useDraftStore(state => state.clearGroupBotDraft);
  const setGroupBotConflict = useDraftStore(state => state.setGroupBotConflict);

  useEffect(() => {
    if (selectedAppId) {
      setActiveEditingAppId(selectedAppId);
    }
  }, [selectedAppId]);

  // 拉取全部 Managed Groups
  const groupsQuery = useQuery({
    queryKey: ['lark-management-groups'],
    queryFn: api.managementGroups,
    staleTime: 15_000
  });

  // 拉取全部 Bot 配置，用于获得 Bot 默认值与 Label
  const larkConfig = useQuery({
    queryKey: ['lark-config'],
    queryFn: api.larkConfig,
    staleTime: 30_000
  });

  // 原生目录对话框只在 macOS 可用；Linux 上按真实能力隐藏。
  const systemCapabilities = useQuery({
    queryKey: ['system-capabilities'],
    queryFn: api.systemCapabilities,
    staleTime: Infinity
  });

  const botsMap = useMemo(() => {
    const map = new Map<string, LarkBotConfig>();
    for (const b of larkConfig.data?.bots ?? []) {
      map.set(b.appId, b);
    }
    return map;
  }, [larkConfig.data]);
  const needsAutoSync = [...botsMap.keys()].some(appId => !autoSyncedBots.current.has(appId));

  const groups = useMemo(() => groupsQuery.data?.groups ?? [], [groupsQuery.data]);

  /*
    当前选中的群。

    同一个 chatId 可能在多个租户下各出现一次（服务端刻意不按名字或 ID 合并，
    保留各自的 group.key）。所以选中时先按 appId 收窄到「这个 Bot 所在的那一个」，
    只有在没有 appId 线索时才退回首项——否则跨租户同 ID 会让用户改到另一个群上。
  */
  const activeGroup = useMemo(() => {
    // 没有 selectedChatId 就是「在列表页」，不自动选首项——否则窄屏点「返回群聊
    // 列表」后详情立刻又占满屏幕，永远退不回去。
    if (!selectedChatId) return undefined;
    const matches = groups.filter(g => g.chatId === selectedChatId);
    if (matches.length === 0) return undefined;
    if (matches.length > 1 && selectedAppId) {
      const scoped = matches.find(g => g.bots.some(b => b.appId === selectedAppId));
      if (scoped) return scoped;
    }
    return matches[0];
  }, [groups, selectedChatId, selectedAppId]);

  const activeChatId = activeGroup?.chatId;
  const activeGroupKey = activeGroup?.key;

  // 过滤群聊
  const filteredGroups = useMemo(() => {
    return groups.filter(g => {
      const q = filterText.trim().toLowerCase();
      const matchText = !q || g.name.toLowerCase().includes(q) || g.chatId.toLowerCase().includes(q);
      if (!matchText) return false;

      if (filterType === 'custom') {
        return g.bots.some(b => Boolean(b.binding));
      }
      if (filterType === 'issues') {
        return g.bots.some(b => b.membership !== 'member' || Boolean(b.error));
      }
      return true;
    });
  }, [groups, filterText, filterType]);

  // 当前正在编辑的 Bot
  const activeBotEntry: ManagedGroupBot | undefined = useMemo(() => {
    if (!activeGroup) return undefined;
    if (activeEditingAppId) {
      const found = activeGroup.bots.find(b => b.appId === activeEditingAppId);
      if (found) return found;
    }
    return activeGroup.bots[0];
  }, [activeGroup, activeEditingAppId]);

  const editingAppId = activeBotEntry?.appId;
  // 草稿按 group.key 分键，不按 chatId：跨租户同 ID 不能共用一份草稿。
  const draftKey = activeGroupKey && editingAppId ? groupBotDraftKey(activeGroupKey, editingAppId) : '';

  // 当前草稿
  const currentDraft: GroupBotDraft | undefined = useMemo(() => {
    if (!draftKey || !activeBotEntry) return undefined;
    return drafts[draftKey] ?? initialDraftFromBinding(activeBotEntry.binding);
  }, [draftKey, activeBotEntry, drafts]);

  const updateDraft = (patch: Partial<GroupBotDraft>) => {
    if (!draftKey || !currentDraft) return;
    setGroupBotDraft(draftKey, { ...currentDraft, ...patch });
  };

  const resetDraft = () => {
    if (draftKey) clearGroupBotDraft(draftKey);
  };

  /*
    冲突后「放弃修改并载入最新」必须真的重新请求：只清草稿会回落到缓存里那份
    已经过期的绑定——正是它触发了 409，用户对着旧值改完再存还是 409。
  */
  const discardAndReload = async () => {
    resetDraft();
    await groupsQuery.refetch();
  };

  // 检查是否有未保存修改
  const presentationError = currentDraft ? presentationInputError(currentDraft) : undefined;
  const isDirty = useMemo(() => {
    if (!activeBotEntry || !currentDraft) return false;
    const initial = initialDraftFromBinding(activeBotEntry.binding);
    return JSON.stringify(initial) !== JSON.stringify(currentDraft);
  }, [activeBotEntry, currentDraft]);

  /*
    群成员，用于「仅指定成员」名单与角色授权两处的 principal 来源。

    两处都要用，所以拉取条件是「展开了角色区 或 选了 allowlist」，不是只看角色区——
    否则用户切到「仅指定成员」会面对一个空下拉，只能手打 principal_ 开头的不透明 ID。
  */
  const needsMembers = rolesOpen || currentDraft?.accessMode === 'allowlist';
  const membersQuery = useQuery({
    queryKey: ['lark-group-members', editingAppId, activeChatId],
    queryFn: async () => {
      const members = [];
      let pageToken: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await api.groupMembers(editingAppId!, activeChatId!, pageToken);
        members.push(...page.members);
        if (!page.hasMore) return { members };
        if (!page.pageToken || seen.has(page.pageToken)) throw new Error('群成员列表未完整返回，请重试。');
        pageToken = page.pageToken; seen.add(pageToken);
      } while (true);
    },
    enabled: Boolean(editingAppId && activeChatId && needsMembers),
    staleTime: 60_000
  });
  const members = membersQuery.data?.members ?? [];
  const memberName = (principalId: string) => members.find(m => m.principalId === principalId)?.name ?? principalId;

  // 模型选项
  const effectiveAgentId = currentDraft?.agentMode === 'set' && currentDraft.agentValue
    ? currentDraft.agentValue
    : (editingAppId ? botsMap.get(editingAppId)?.defaultAgentId : '');

  const agentOptions = useQuery({
    queryKey: agentModelsQueryKey(effectiveAgentId, currentDraft?.modelMode === 'set' ? currentDraft.modelValue : undefined),
    queryFn: () => loadAgentModels(effectiveAgentId!, currentDraft?.modelMode === 'set' ? currentDraft.modelValue : undefined),
    enabled: Boolean(effectiveAgentId),
    initialData: () => effectiveAgentId ? readCachedAgentModels(effectiveAgentId, currentDraft?.modelMode === 'set' ? currentDraft.modelValue : undefined) : undefined,
    staleTime: 5 * 60_000
  });

  /*
    保存群内某个 Bot 的设置。

    **提交对象由 variables 固定，不读闭包里的 activeChatId / editingAppId /
    currentDraft / draftKey。**

    请求在飞的时候用户可以切到另一个群、或同一个群里的另一个 Bot：那一刻
    draftKey 已经指向别的对象，而回调仍在为上一次提交执行。读闭包会把 A 的成功
    清掉 B 的草稿、把 A 的 409 贴到 B 的编辑器上。

    另一半是「保存期间继续编辑同一个对象」：成功后只在草稿内容与提交内容一致时
    才清，不一致就保留新改动，并把 baseRevision 换成这次保存后的新版本——否则
    下一次保存会带着过期的 expectedRevision，撞出一个本不该有的 409。
  */
  const saveMutation = useMutation({
    mutationFn: async ({ appId, chatId, draft }: GroupSaveVariables) => {
      const patch: Partial<GroupBinding> = {
        agentOverride: draft.agentMode === 'set' && draft.agentValue.trim()
          ? { mode: 'set', value: draft.agentValue.trim() }
          : { mode: 'inherit' },
        workspaceOverride: draft.workspaceMode === 'set' && draft.workspaceValue.trim()
          ? { mode: 'set', value: draft.workspaceValue.trim() }
          : { mode: 'inherit' },
        modelOverride: draft.modelMode === 'set' && draft.modelValue.trim()
          ? { mode: 'set', value: draft.modelValue.trim() }
          : draft.modelMode === 'clear'
          ? { mode: 'clear' }
          : { mode: 'inherit' },
        reasoningOverride: draft.reasoningMode === 'set' && draft.reasoningValue.trim()
          ? { mode: 'set', value: draft.reasoningValue.trim() }
          : draft.reasoningMode === 'clear'
          ? { mode: 'clear' }
          : { mode: 'inherit' },
        routingOverride: {
          groupReplyMode: draft.groupReplyMode === 'inherit'
            ? { mode: 'inherit' }
            : { mode: 'set', value: draft.groupReplyMode },
          mentionPolicy: draft.mentionPolicy === 'inherit'
            ? { mode: 'inherit' }
            : { mode: 'set', value: draft.mentionPolicy }
        },
        groupToolsOverride: {
          read: draft.toolRead,
          discover: draft.toolDiscover,
          send: draft.toolSend
        },
        // 「机器人在本群说多少话」：逐字段覆盖 Bot 级呈现设置，没动过的项保持 inherit。
        presentationOverride: presentationOverrideFromDraft(draft),
        /*
          谁能在本群使用这个 Bot。这一项与 oncall / 角色是三件不同的事：
          accessOverride 决定「本群的访问范围」，角色决定「具体某个人能做什么」，
          oncall 只表达值班行为。只靠后两者就等于没有群级访问范围可配。

          principalIds 只在 allowlist 下有意义（shared 的 schema 会拒绝其他组合），
          所以别的模式一律送空数组。
        */
        accessOverride: {
          mode: draft.accessMode,
          principalIds: draft.accessMode === 'allowlist' ? draft.accessPrincipalIds : []
        },
        oncall: draft.oncall
      };

      return api.updateGroupBotBinding(appId, chatId, {
        /*
          用编辑起点的版本，不是当下 binding.revision：群列表每 15 秒刷新一次，
          别人保存过之后再拿刷新到的版本提交，CAS 会放行并覆盖对方的修改。
        */
        expectedRevision: draft.baseRevision,
        patch,
        roleChanges: draft.roleChanges.length > 0 ? draft.roleChanges : undefined
      });
    },
    onSuccess: (result, variables) => {
      const { key, draft } = variables;
      const latest = useDraftStore.getState().groupBotDrafts[key];
      if (!latest || sameGroupDraftContent(latest, draft)) {
        // 等待期间没再改：草稿的使命结束。
        clearGroupBotDraft(key);
      } else {
        // 等待期间又改了：保住新改动，基准换成刚保存出来的版本。
        setGroupBotDraft(key, { ...latest, baseRevision: result?.binding?.revision ?? latest.baseRevision,
          roleChanges: latest.roleChanges.filter(change => !draft.roleChanges.includes(change)).map(change => change.kind === 'update'
            ? { ...change, expectedRevision: result.roles.find(role => role.id === change.id)?.revision ?? change.expectedRevision } : change)
        });
        setGroupBotConflict(key, undefined);
      }
      void qc.invalidateQueries({ queryKey: ['lark-management-groups'] });
      if (!result) return;
      toastStore.push({
        kind: result.applied ? 'success' : 'info',
        key: `save-group-${key}`,
        title: '群内 Bot 配置已保存',
        description: result.applied ? '执行设置用于新话题，权限立即生效。' : result.error ?? '配置已保存，请同步群聊以确认是否生效。'
      });
    },
    onError: (error: unknown, variables) => {
      const { key } = variables;
      if (error instanceof ApiError && error.status === 409) {
        setGroupBotConflict(key, error.message);
        toastStore.push({
          kind: 'error',
          key: `conflict-group-${key}`,
          title: '保存遇到并发冲突',
          description: error.message
        });
      } else {
        toastStore.push({
          kind: 'error',
          key: `error-group-${key}`,
          title: '保存群配置失败',
          description: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });

  /** 提交当前对象。variables 在这里定格，之后切走也不影响这次请求的归属。 */
  const submitSave = () => {
    if (!activeChatId || !editingAppId || !currentDraft || !draftKey) return;
    saveMutation.mutate({ key: draftKey, appId: editingAppId, chatId: activeChatId, draft: currentDraft });
  };

  /** 只有「正在保存的就是当前这个对象」时才显示忙碌态。 */
  const savingThisBot = saveMutation.isPending && saveMutation.variables?.key === draftKey;

  /*
    同步群聊：**顺序同步全部已配置的 Bot**，不是只同步当前这一个。

    只同步当前 Bot 有个死结：第二个 Bot 还没出现在群列表里，用户就选不到它，
    也就永远同步不了它——它会一直不在列表里。逐个跑完再刷新，谁失败就点名谁，
    成功的那部分照常可见（部分成功不谎报为全部成功，也不因为一个失败就丢弃全部）。
  */
  const syncMutation = useMutation({
    mutationFn: async ({ appIds }: { appIds: string[]; automatic: boolean }) => {
      if (appIds.length === 0) throw new Error('还没有配置飞书 Bot，无法同步群聊');
      const failures: Array<{ appId: string; name: string; message: string }> = [];
      for (const appId of appIds) {
        const name = botsMap.get(appId)?.name || appId;
        try {
          const result = await api.syncGroups(appId);
          // 服务端也可能在 2xx 里报告部分失败，同样要如实计入。
          if (result.error) failures.push({ appId, name, message: result.error });
        } catch (error) {
          failures.push({ appId, name, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return { total: appIds.length, failures };
    },
    onSuccess: async ({ total, failures }, { appIds, automatic }) => {
      // 无论成败都刷新一次：成功的那几个 Bot 的群必须立刻可见。
      await qc.cancelQueries({ queryKey: ['lark-management-groups'] });
      await qc.invalidateQueries({ queryKey: ['lark-management-groups'] });
      setSyncFailures(previous => [...previous.filter(failure => !appIds.includes(failure.appId)), ...failures]);
      if (failures.length === 0) {
        if (automatic) return;
        toastStore.push({
          kind: 'success',
          key: 'sync-groups',
          title: `已同步 ${total} 个机器人的群聊`
        });
        return;
      }
      toastStore.push({
        kind: 'error',
        key: 'sync-groups-partial',
        title: failures.length === total ? '群聊同步失败' : `${total - failures.length} 个机器人同步成功，${failures.length} 个失败`,
        description: failures.map(f => `${f.name}：${f.message}`).join('；')
      });
    },
    onError: (error: unknown) => {
      toastStore.push({
        kind: 'error',
        key: 'sync-groups-err',
        title: '群聊同步失败',
        description: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const { mutate: syncGroups, isPending: syncingGroups } = syncMutation;
  useEffect(() => {
    const appIds = [...botsMap.keys()].filter(appId => !autoSyncedBots.current.has(appId));
    if (syncingGroups || !appIds.length) return;
    // 每次进入页面为各 Bot 自动同步一次；空结果或失败由用户重试，避免循环请求。
    for (const appId of appIds) autoSyncedBots.current.add(appId);
    syncGroups({ appIds, automatic: true });
  }, [botsMap, syncingGroups, syncGroups]);

  // 添加 Role 变更
  const handleAddRole = () => {
    if (!newRolePrincipal.trim() || !currentDraft) return;
    const change: RoleChange = {
      kind: 'create',
      principalId: newRolePrincipal.trim(),
      role: newRoleKind,
      operateScope: newRoleKind === 'can_operate' ? newRoleOperateScope : 'none',
      actionGates: {
        terminalWrite: false,
        highRisk: false,
        groupToolsSend: false
      }
    };
    updateDraft({
      roleChanges: [...currentDraft.roleChanges, change]
    });
    setNewRolePrincipal('');
  };

  // 撤销已有 Role
  const handleRevokeRole = (role: RoleAssignment) => {
    if (!currentDraft) return;
    const change: RoleChange = {
      kind: 'update',
      id: role.id,
      expectedRevision: role.revision,
      patch: {
        state: 'revoked'
      }
    };
    updateDraft({
      roleChanges: [...currentDraft.roleChanges, change]
    });
  };

  const botConfig = editingAppId ? botsMap.get(editingAppId) : undefined;
  const botDisplayName = botConfig?.name || editingAppId || 'Bot';

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* 顶部标头 */}
      <header className="flex shrink-0 items-center justify-between border-b border-subtle bg-surface px-4 py-3 sm:px-6">
        <div>
          <h1 className="text-heading font-semibold text-primary">群聊管理</h1>
          <p className="mt-0.5 text-caption text-subtle">
            选择群聊，再配置群内机器人。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            loading={syncMutation.isPending}
            disabled={!botsMap.size}
            onClick={() => syncMutation.mutate({ appIds: [...botsMap.keys()], automatic: false })}
            className="shrink-0 text-caption"
            title="逐个同步所有已配置机器人可见的群聊"
          >
            <RefreshCw size={14} className="mr-1.5" />
            同步群聊
          </Button>
        </div>
      </header>

      {/*
        同步结果。部分成功也如实说清：成功的群已经刷新出来了，失败的逐个点名，
        不把「有几个没同步上」藏进一条会消失的提示里。
      */}
      {syncFailures.length > 0 && (
        <div className="shrink-0 px-4 pt-3 sm:px-6">
          <Banner tone="warning" onDismiss={() => setSyncFailures([])}>
            <div>
              <strong className="block">
                {syncFailures.length === botsMap.size ? '群聊同步失败' : `${botsMap.size - syncFailures.length} 个机器人同步成功，${syncFailures.length} 个失败`}
              </strong>
              <ul className="mt-1 space-y-0.5 text-caption">
                {syncFailures.map(f => <li key={f.appId}>{f.name}：{f.message}</li>)}
              </ul>
            </div>
          </Banner>
        </div>
      )}

      {/* 主区分栏：左侧群列表 + 右侧群详情 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左侧群列表 */}
        <aside
          className={`flex w-full flex-col border-r border-subtle bg-surface md:w-80 lg:w-96 ${
            activeGroup ? 'hidden md:flex' : 'flex'
          }`}
        >
          {/* 筛选与搜索 */}
          <div className="space-y-2 border-b border-subtle p-3">
            <div className="relative">
              <Input
                value={filterText}
                onChange={e => setFilterText(e.target.value)}
                placeholder="搜索群名称或 Chat ID…"
                className="pl-8 text-caption"
              />
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
            </div>
            <div className="flex gap-1 text-meta">
              <button
                type="button"
                onClick={() => setFilterType('all')}
                className={`rounded px-2 py-0.5 ${filterType === 'all' ? 'bg-inverse text-surface font-medium' : 'text-secondary hover:bg-hover'}`}
              >
                全部 ({groups.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterType('custom')}
                className={`rounded px-2 py-0.5 ${filterType === 'custom' ? 'bg-inverse text-surface font-medium' : 'text-secondary hover:bg-hover'}`}
              >
                单独配置
              </button>
              <button
                type="button"
                onClick={() => setFilterType('issues')}
                className={`rounded px-2 py-0.5 ${filterType === 'issues' ? 'bg-inverse text-surface font-medium' : 'text-secondary hover:bg-hover'}`}
              >
                待处理
              </button>
            </div>
          </div>

          {/* 群列表展示 */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {groupsQuery.isError ? (
              <div className="p-4">
                <Banner tone="danger" action={{ label: '重试', onClick: () => void groupsQuery.refetch() }}>
                  加载群列表失败：{groupsQuery.error.message}
                </Banner>
              </div>
            ) : groupsQuery.isLoading || !groups.length && (larkConfig.isPending || needsAutoSync || syncingGroups) ? (
              <div className="grid h-48 place-items-center">
                <Spinner label={needsAutoSync || syncingGroups ? '正在同步飞书群聊…' : '正在读取群聊列表…'} />
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="p-6 text-center space-y-3">
                <p className="text-caption text-subtle">
                  {filterText ? '没有找到符合条件的群聊' : '暂未发现任何飞书群聊'}
                </p>
                {!filterText && (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={syncMutation.isPending}
                    disabled={!botsMap.size}
                    onClick={() => syncMutation.mutate({ appIds: [...botsMap.keys()], automatic: false })}
                  >
                    <RefreshCw size={14} className="mr-1.5" />
                    立即同步群聊
                  </Button>
                )}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {filteredGroups.map(group => {
                  // 按 key 比较而不是 chatId：跨租户同 ID 的两个群否则会同时高亮。
                  const isSelected = activeGroup?.key === group.key;
                  const hasCustom = group.bots.some(b => Boolean(b.binding));
                  const botCount = group.bots.length;
                  return (
                    <li key={group.key}>
                      <button
                        type="button"
                        aria-current={isSelected ? 'true' : undefined}
                        onClick={() => {
                          /*
                            带上这个群里的第一个 Bot 的 appId：URL 里只有 chatId 时，
                            跨租户同 ID 的两个群无法区分，App 侧会退回首项。传了 appId
                            就能收窄到用户真正点的那一个。
                          */
                          onSelectGroup(group.chatId, group.bots[0]?.appId);
                          setActiveEditingAppId(null);
                        }}
                        className={`flex w-full flex-col rounded-lg p-3 text-left transition-colors ${
                          isSelected
                            ? 'bg-action-soft text-primary'
                            : 'hover:bg-hover text-secondary'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <strong className="truncate text-body font-semibold text-primary">
                            {group.name || '未命名群聊'}
                          </strong>
                          {hasCustom && <Badge tone="accent">单独配置</Badge>}
                        </div>
                        <div className="mt-1 flex items-center justify-between text-meta text-subtle">
                          <span className="truncate font-mono">{group.chatId}</span>
                          <span>{botCount} 个 Bot</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* 右侧群详情与群内 Bot 编辑区 */}
        <main
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-canvas p-4 sm:p-6 ${
            !activeGroup ? 'hidden md:flex md:items-center md:justify-center' : 'flex'
          }`}
        >
          {!activeGroup ? (
            <EmptyState
              icon={<Users size={36} className="text-subtle" />}
              title="未选择群聊"
              description="请从左侧选择群聊，查看和调整群内机器人的设置。"
            />
          ) : (
            <div className="mx-auto w-full min-w-0 max-w-4xl space-y-4">
              {/* 移动端返回群列表按钮 */}
              <div className="md:hidden">
                <Button variant="ghost" size="sm" onClick={() => onSelectGroup('')}>
                  <ArrowLeft size={14} className="mr-1" />
                  返回群聊列表
                </Button>
              </div>

              {/* 冲突提示 */}
              {draftKey && conflicts[draftKey] && (
                <Banner tone="danger">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <strong className="block">别人刚改过这个群的设置</strong>
                      <p className="mt-1 text-caption">
                        {conflicts[draftKey]}。你填的内容已保留，没有被提交。可以放弃自己的修改、载入最新设置后重来。
                      </p>
                    </div>
                    <Button variant="secondary" size="sm" loading={groupsQuery.isFetching} onClick={() => void discardAndReload()}>
                      放弃修改并载入最新
                    </Button>
                  </div>
                </Banner>
              )}

              <div className="flex items-center justify-between gap-2">
                <h2 className="text-title font-semibold text-primary">{activeGroup.name || '未命名群聊'}</h2>
                <span className="truncate font-mono text-meta text-subtle">{activeGroup.chatId}</span>
              </div>
              {activeBotEntry?.error && <Banner tone="warning">{activeBotEntry.error}</Banner>}

              {/* 该群已知 Bot 清单 */}
              <Card padding="md" className="space-y-2">
                <div>
                  <h3 className="text-body font-semibold text-primary">群内机器人</h3>
                </div>

                <div className="divide-y divide-subtle rounded-md border border-subtle bg-surface">
                  {activeGroup.bots.map(b => {
                    const bConfig = botsMap.get(b.appId);
                    const isCurrentEditing = activeBotEntry?.appId === b.appId;
                    const hasCustom = Boolean(b.binding);
                    return (
                      <div
                        key={b.appId}
                        className={`flex flex-wrap items-center justify-between gap-2 p-2.5 ${
                          isCurrentEditing ? 'bg-hover' : ''
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <strong className="truncate text-body font-semibold text-primary">
                              {bConfig?.name || b.appId}
                            </strong>
                            <Badge tone={b.membership === 'member' ? 'success' : 'neutral'}>
                              {b.membership === 'member' ? '已在群' : '状态未知'}
                            </Badge>
                            {hasCustom ? (
                              <Badge tone={b.applied ? 'accent' : 'warning'}>{b.applied ? '已生效' : '未生效'}</Badge>
                            ) : (
                              <Badge tone="neutral">继承 Bot 默认</Badge>
                            )}
                          </div>
                          <div className="mt-1 hidden flex-wrap items-center gap-x-2 text-caption text-subtle md:flex">
                            <span>Agent: {effectiveText(b.effective?.agent, bConfig?.defaultAgentId ?? '按现有默认行为')}</span>
                            <span aria-hidden="true">·</span>
                            <span>目录: {effectiveText(b.effective?.workspace, bConfig?.workspace ?? '按现有默认行为')}</span>
                            <span aria-hidden="true">·</span>
                            <span>模型: {effectiveText(b.effective?.model, bConfig?.defaultModel ?? '按现有默认行为')}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant={isCurrentEditing ? 'primary' : 'secondary'}
                            size="sm"
                            /*
                              走 URL 而不是只改本地 state：刷新或分享链接要能回到
                              「这个群里的这个 Bot」，否则刷新后又落回第一个 Bot。
                            */
                            onClick={() => { setActiveEditingAppId(b.appId); onSelectGroup(activeGroup.chatId, b.appId); }}
                          >
                            {isCurrentEditing ? '正在编辑' : '配置'}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* 群内具体 Bot 的详细配置编辑器 */}
              {activeBotEntry && currentDraft && (
                <div className="space-y-6 rounded-lg border border-action-border bg-surface p-4 sm:p-6 shadow-card">
                  <div className="flex items-center justify-between border-b border-subtle pb-3">
                    <div>
                      <span className="text-meta font-semibold uppercase tracking-wider text-action">
                        正在配置
                      </span>
                      <h3 className="text-title font-semibold text-primary">
                        {activeGroup.name} / {botDisplayName}
                      </h3>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onNavigateToBot(activeBotEntry.appId)}
                    >
                      <ExternalLink size={13} className="mr-1" />
                      查看 Bot 默认设置
                    </Button>
                  </div>

                  {/* 1. 执行设置：Agent、目录、模型、推理强度 */}
                  <div className="space-y-4">
                    <h4 className="text-body font-semibold text-primary">执行设置</h4>

                    {/* Agent 覆盖 */}
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="text-caption font-medium text-secondary">
                          执行 Agent
                        </label>
                        <div className="flex flex-wrap items-center gap-2 text-caption">
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="radio"
                              name="agentMode"
                              checked={currentDraft.agentMode === 'inherit'}
                              onChange={() => updateDraft({ agentMode: 'inherit' })}
                            />
                            <span>继承 Bot 默认 ({botConfig?.defaultAgentId || '未配置'})</span>
                          </label>
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="radio"
                              name="agentMode"
                              checked={currentDraft.agentMode === 'set'}
                              onChange={() => updateDraft({ agentMode: 'set', agentValue: agents[0]?.id ?? '' })}
                            />
                            <span>本群单独设置</span>
                          </label>
                        </div>
                      </div>
                      {currentDraft.agentMode === 'set' && (
                        <div className="pt-1">
                          <AgentSelect
                            agents={agents}
                            value={currentDraft.agentValue}
                            onChange={val => updateDraft({ agentValue: val })}
                          />
                        </div>
                      )}
                    </div>

                    {/* 工作目录覆盖 */}
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="text-caption font-medium text-secondary">
                          工作目录
                        </label>
                        <div className="flex flex-wrap items-center gap-2 text-caption">
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="radio"
                              name="workspaceMode"
                              checked={currentDraft.workspaceMode === 'inherit'}
                              onChange={() => updateDraft({ workspaceMode: 'inherit' })}
                            />
                            <span>继承 Bot 默认 ({botConfig?.workspace || '默认'})</span>
                          </label>
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="radio"
                              name="workspaceMode"
                              checked={currentDraft.workspaceMode === 'set'}
                              onChange={() => updateDraft({ workspaceMode: 'set' })}
                            />
                            <span>本群单独设置</span>
                          </label>
                        </div>
                      </div>
                      {currentDraft.workspaceMode === 'set' && (
                        <DirectoryPicker
                          value={currentDraft.workspaceValue}
                          onChange={val => updateDraft({ workspaceValue: val })}
                          placeholder="例如 /data/projects/oncall"
                          allowNative={Boolean(systemCapabilities.data?.directoryPicker)}
                        />
                      )}
                    </div>

                    {/* 模型覆盖（支持 inherit / clear / set 三态） */}
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="text-caption font-medium text-secondary">
                          模型
                        </label>
                        <div className="flex flex-wrap items-center gap-2 text-caption">
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="radio"
                              name="modelMode"
                              checked={currentDraft.modelMode === 'inherit'}
                              onChange={() => updateDraft({ modelMode: 'inherit' })}
                            />
                            <span>继承 Bot 默认</span>
                          </label>
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="radio"
                              name="modelMode"
                              checked={currentDraft.modelMode === 'clear'}
                              onChange={() => updateDraft({ modelMode: 'clear' })}
                            />
                            <span>使用 Agent 默认</span>
                          </label>
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="radio"
                              name="modelMode"
                              checked={currentDraft.modelMode === 'set'}
                              onChange={() => updateDraft({ modelMode: 'set' })}
                            />
                            <span>本群单独指定</span>
                          </label>
                        </div>
                      </div>
                      {currentDraft.modelMode === 'set' && (
                        <CompactSelect
                          options={[
                            { value: '', label: '选择模型…' },
                            ...(agentOptions.data?.models ?? []).map(m => ({ value: m.id, label: m.name }))
                          ]}
                          value={currentDraft.modelValue}
                          placeholder="选择本群模型"
                          disabledText=""
                          onChange={val => updateDraft({ modelValue: val })}
                        />
                      )}
                    </div>
                  </div>

                  {/* 2. 消息触发与回复行为 */}
                  <div className="space-y-4 border-t border-subtle pt-4">
                    <h4 className="text-body font-semibold text-primary">触发与回复</h4>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-caption font-medium text-secondary">
                          群回复方式
                        </label>
                        <Select
                          value={currentDraft.groupReplyMode}
                          onChange={e => updateDraft({ groupReplyMode: e.target.value as any })}
                        >
                          <option value="inherit">继承 Bot 默认（{replyModeLabels[botConfig?.groupReplyMode ?? ''] ?? '自动选择'}）</option>
                          {Object.entries(replyModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </Select>
                        <p className="mt-1 text-meta text-subtle">
                          当前生效：{replyModeLabels[activeBotEntry.effective?.routing.groupReplyMode.value ?? ''] ?? '按现有默认行为'}
                        </p>
                      </div>

                      <div>
                        <label className="mb-1 block text-caption font-medium text-secondary">
                          提及唤醒规则
                        </label>
                        <Select
                          value={currentDraft.mentionPolicy}
                          onChange={e => updateDraft({ mentionPolicy: e.target.value as any })}
                        >
                          <option value="inherit">继承 Bot 默认（{mentionPolicyLabels[botConfig?.mentionPolicy ?? ''] ?? '按 Bot 设置'}）</option>
                          {Object.entries(mentionPolicyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </Select>
                        <p className="mt-1 text-meta text-subtle">
                          当前生效：{mentionPolicyLabels[activeBotEntry.effective?.routing.mentionPolicy.value ?? ''] ?? '按现有默认行为'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/*
                    谁能在本群使用这个 Bot。

                    独立成一节，不折进「高级」：它是权限而不是偏好，藏起来会让人以为
                    「配了 oncall 或加了角色」就等于限定了访问范围——那是三件不同的事。
                  */}
                  <div className="space-y-3 border-t border-subtle pt-4">
                    <h4 className="text-body font-semibold text-primary">谁能在本群使用</h4>
                    <div>
                      <label className="mb-1 block text-caption font-medium text-secondary" htmlFor="group-access-mode">
                        访问范围
                      </label>
                      <Select
                        id="group-access-mode"
                        value={currentDraft.accessMode}
                        onChange={e => updateDraft({ accessMode: e.target.value as GroupAccessMode })}
                      >
                        {(Object.keys(accessModeLabels) as GroupAccessMode[]).map(mode => (
                          <option key={mode} value={mode}>{accessModeLabels[mode]}</option>
                        ))}
                      </Select>
                      <p className="mt-1 text-meta text-subtle">
                        当前生效：{accessModeLabels[(activeBotEntry.effective?.access.mode ?? 'inherit') as GroupAccessMode] ?? '按现有默认行为'}
                        {activeBotEntry.effective?.access.source === 'bot_default' ? '（来自 Bot 默认）' : ''}
                      </p>
                    </div>

                    {currentDraft.accessMode === 'allowlist' && (
                      <div className="space-y-2 rounded-md bg-muted p-3">
                        <div className="text-caption font-medium text-secondary">
                          允许使用的成员（{currentDraft.accessPrincipalIds.length} 人）
                        </div>

                        {currentDraft.accessPrincipalIds.length === 0 ? (
                          <p className="text-meta text-warning">
                            名单为空时保存会被拒绝：请至少选择一位成员，或改回其他访问范围。
                          </p>
                        ) : (
                          <ul className="space-y-1">
                            {currentDraft.accessPrincipalIds.map(principalId => (
                              <li key={principalId} className="flex items-center justify-between rounded bg-surface px-2.5 py-1.5 text-caption">
                                <span className="min-w-0">
                                  <span className="font-medium text-primary">{memberName(principalId)}</span>
                                  <span className="ml-2 font-mono text-meta text-subtle">{principalId}</span>
                                </span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => updateDraft({ accessPrincipalIds: currentDraft.accessPrincipalIds.filter(id => id !== principalId) })}
                                >
                                  移出名单
                                </Button>
                              </li>
                            ))}
                          </ul>
                        )}

                        <div className="flex flex-wrap items-end gap-2">
                          <div className="w-full sm:w-auto sm:flex-1">
                            <label className="mb-1 block text-meta font-medium text-secondary" htmlFor="group-access-member">
                              添加群成员
                            </label>
                            {members.length > 0 ? (
                              <Select
                                id="group-access-member"
                                value=""
                                onChange={e => {
                                  const id = e.target.value;
                                  if (id && !currentDraft.accessPrincipalIds.includes(id)) {
                                    updateDraft({ accessPrincipalIds: [...currentDraft.accessPrincipalIds, id] });
                                  }
                                }}
                              >
                                <option value="">选择群成员…</option>
                                {members
                                  .filter(m => !currentDraft.accessPrincipalIds.includes(m.principalId))
                                  .map(m => <option key={m.principalId} value={m.principalId}>{m.name}（{m.principalId}）</option>)}
                              </Select>
                            ) : (
                              <p className="text-meta text-subtle">
                                {membersQuery.isLoading ? '正在读取群成员…' : membersQuery.isError ? `无法读取群成员：${membersQuery.error.message}` : '该群暂无可选成员。'}
                              </p>
                            )}
                          </div>
                          {membersQuery.isError && (
                            <Button variant="secondary" size="sm" onClick={() => void membersQuery.refetch()}>
                              重试读取成员
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 3. 成员操作角色与授权 (can_talk / can_operate) */}
                  <div className="space-y-3 border-t border-subtle pt-4">
                    <button
                      type="button"
                      onClick={() => setRolesOpen(v => !v)}
                      className="flex w-full items-center justify-between text-left text-body font-semibold text-primary"
                    >
                      <span className="flex items-center gap-2">
                        <Shield size={16} className="text-sidebar-accent" />
                        成员使用与操作授权 ({activeBotEntry.roles.length} 条)
                      </span>
                      {rolesOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>

                    {rolesOpen && (
                      <div className="space-y-3 pt-2">
                        <p className="text-caption text-subtle">
                          细化控制谁可以在本群与此 Bot 对话 (`can_talk`)，以及谁能操作/终止任务 (`can_operate`)。
                        </p>

                        {/* 已有角色列表 */}
                        {activeBotEntry.roles.length === 0 ? (
                          <div className="rounded bg-muted p-3 text-caption text-subtle">
                            尚未为该群配置独立角色授权；默认遵循群访问策略。
                          </div>
                        ) : (
                          <ul className="divide-y divide-subtle rounded border border-subtle">
                            {activeBotEntry.roles.map(role => {
                              const isRevoked = role.state === 'revoked';
                              return (
                                <li key={role.id} className="flex items-center justify-between p-2.5 text-caption">
                                  <div>
                                    <div className="font-medium text-primary">
                                      {memberName(role.principalId)}
                                    </div>
                                    {/* 名字解析不出来时不再重复打印同一串 ID。 */}
                                    {memberName(role.principalId) !== role.principalId && (
                                      <div className="font-mono text-meta text-subtle">{role.principalId}</div>
                                    )}
                                    <div className="text-meta text-subtle">
                                      {role.role === 'can_talk' ? '可对话 (can_talk)' : role.role === 'admin' ? '管理员 (admin)' : `可操作 (can_operate · ${role.operateScope})`}
                                    </div>
                                  </div>
                                  <div>
                                    {isRevoked ? (
                                      <Badge tone="danger">已撤销</Badge>
                                    ) : (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => handleRevokeRole(role)}
                                        className="text-danger hover:bg-danger-soft"
                                      >
                                        撤销授权
                                      </Button>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}

                        {/* 待提交的 Role 变更 */}
                        {currentDraft.roleChanges.length > 0 && (
                          <div className="rounded-md border border-warning-border bg-warning-soft p-3 text-caption">
                            <strong className="block text-warning font-semibold">待提交的角色变更：</strong>
                            <ul className="mt-1 list-disc pl-4 space-y-0.5">
                              {currentDraft.roleChanges.map((rc, idx) => (
                                <li key={idx}>
                                  {rc.kind === 'create'
                                    ? `新增授权：${memberName(rc.principalId)} -> ${rc.role === 'can_talk' ? '可对话' : `可操作（${rc.operateScope}）`}`
                                    : `更新授权：${rc.id} -> ${rc.patch.state ?? 'active'}`}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* 添加角色表单 */}
                        <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted p-3">
                          <div className="w-full sm:w-auto sm:flex-1">
                            <label className="mb-1 block text-meta font-medium text-secondary" htmlFor="group-role-principal">
                              成员
                            </label>
                            {members.length > 0 ? (
                              <Select
                                id="group-role-principal"
                                value={newRolePrincipal}
                                onChange={e => setNewRolePrincipal(e.target.value)}
                              >
                                <option value="">选择群成员…</option>
                                {members.map(m => (
                                  <option key={m.principalId} value={m.principalId}>
                                    {m.name}（{m.principalId}）
                                  </option>
                                ))}
                              </Select>
                            ) : (
                              <Input
                                id="group-role-principal"
                                value={newRolePrincipal}
                                onChange={e => setNewRolePrincipal(e.target.value)}
                                placeholder="输入 principal_xxx"
                                className="font-mono text-meta"
                              />
                            )}
                          </div>

                          <div className="w-full sm:w-32">
                            <label className="mb-1 block text-meta font-medium text-secondary" htmlFor="group-role-kind">权限</label>
                            {/*
                              只有对话与操作两档。admin 是跨群管理授权，从「配置这一个群」
                              的动作里授出去会溢出到别的群，所以这里根本不提供。
                            */}
                            <Select
                              id="group-role-kind"
                              value={newRoleKind}
                              onChange={e => setNewRoleKind(e.target.value as GroupRoleKind)}
                            >
                              <option value="can_talk">对话 (talk)</option>
                              <option value="can_operate">操作 (operate)</option>
                            </Select>
                          </div>

                          {newRoleKind === 'can_operate' && (
                            <div className="w-full sm:w-36">
                              <label className="mb-1 block text-meta font-medium text-secondary" htmlFor="group-role-scope">范围</label>
                              {/*
                                范围最大到本群。bot_runs 会让这个人能操作该 Bot 在**所有群**
                                里的任务，同样是从本群配置里溢出，所以不作为选项。
                              */}
                              <Select
                                id="group-role-scope"
                                value={newRoleOperateScope}
                                onChange={e => setNewRoleOperateScope(e.target.value as GroupOperateScope)}
                              >
                                <option value="own_runs">仅本人任务</option>
                                <option value="group_runs">本群全部任务</option>
                              </Select>
                            </div>
                          )}

                          <Button
                            variant="secondary"
                            disabled={!newRolePrincipal.trim()}
                            onClick={handleAddRole}
                          >
                            <UserPlus size={14} className="mr-1" />
                            添加
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 4. 高级群工具覆盖 */}
                  <div className="space-y-3 border-t border-subtle pt-4">
                    <button
                      type="button"
                      onClick={() => setAdvancedOpen(v => !v)}
                      className="flex w-full items-center justify-between text-left text-body font-semibold text-primary"
                    >
                      <span className="flex items-center gap-2">
                        <Shield size={16} className="text-sidebar-accent" />
                        群工具与值班设置（高级）
                      </span>
                      {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>

                    {advancedOpen && (
                      <div className="space-y-4 pt-2">
                        <label className="block space-y-1 text-caption text-secondary">
                          <span>推理强度</span>
                          <Select value={currentDraft.reasoningMode === 'set' ? currentDraft.reasoningValue : currentDraft.reasoningMode}
                            onChange={e => updateDraft(e.target.value === 'inherit' || e.target.value === 'clear' ? { reasoningMode: e.target.value, reasoningValue: '' } : { reasoningMode: 'set', reasoningValue: e.target.value })}>
                            <option value="inherit">继承 Bot 默认</option>
                            <option value="clear">使用 Agent 默认</option>
                            {(agentOptions.data?.reasoningEfforts ?? []).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                          </Select>
                        </label>
                        <label className="flex flex-wrap items-center gap-2 text-caption">
                          <input
                            type="checkbox"
                            checked={currentDraft.oncall}
                            onChange={e => updateDraft({ oncall: e.target.checked })}
                            className="rounded border-default text-action focus:ring-action"
                          />
                          <span className="font-medium text-primary">启用本群 Oncall 模式</span>
                        </label>

                        <div className="grid gap-3 sm:grid-cols-3 text-caption">
                          <div>
                            <label className="mb-1 block font-medium text-secondary">读取工具 (read)</label>
                            <Select
                              value={currentDraft.toolRead}
                              onChange={e => updateDraft({ toolRead: e.target.value as any })}
                            >
                              <option value="inherit">继承 Bot 默认</option>
                              <option value="allow">群级允许</option>
                              <option value="deny">群级禁止</option>
                            </Select>
                          </div>
                          <div>
                            <label className="mb-1 block font-medium text-secondary">发现工具 (discover)</label>
                            <Select
                              value={currentDraft.toolDiscover}
                              onChange={e => updateDraft({ toolDiscover: e.target.value as any })}
                            >
                              <option value="inherit">继承 Bot 默认</option>
                              <option value="allow">群级允许</option>
                              <option value="deny">群级禁止</option>
                            </Select>
                          </div>
                          <div>
                            <label className="mb-1 block font-medium text-secondary">发送工具 (send)</label>
                            <Select
                              value={currentDraft.toolSend}
                              onChange={e => updateDraft({ toolSend: e.target.value as any })}
                            >
                              <option value="inherit">继承 Bot 默认</option>
                              <option value="allow">群级允许</option>
                              <option value="deny">群级禁止</option>
                            </Select>
                          </div>
                        </div>

                        {/* 本群里机器人说多少话。每一项都可以只在这个群改，不影响同一个 Bot 的其他群。 */}
                        <div className="space-y-3 border-t border-subtle pt-4 text-caption">
                          <div className="font-medium text-primary">本群消息呈现</div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            {PRESENTATION_TOGGLES.map(({ key, label, hint }) => (
                              <div key={key}>
                                <label className="mb-1 block font-medium text-secondary">{label}</label>
                                <Select
                                  aria-label={label}
                                  value={currentDraft[key]}
                                  onChange={e => updateDraft({ [key]: e.target.value as PresentationToggle })}
                                >
                                  <option value="inherit">继承 Bot 默认</option>
                                  <option value="on">本群开启</option>
                                  <option value="off">本群关闭</option>
                                </Select>
                                <div className="mt-1 text-meta text-subtle">{hint}</div>
                              </div>
                            ))}
                            <div>
                              <label className="mb-1 block font-medium text-secondary">Trace 阶段上限</label>
                              <Select
                                aria-label="Trace 阶段上限"
                                value={currentDraft.presentationTraceLimitMode}
                                onChange={e => updateDraft({ presentationTraceLimitMode: e.target.value as 'inherit' | 'set' })}
                              >
                                <option value="inherit">继承 Bot 默认</option>
                                <option value="set">本群单独设置</option>
                              </Select>
                              {currentDraft.presentationTraceLimitMode === 'set' && (
                                <Input
                                  aria-label="本群 Trace 阶段上限值"
                                  className="mt-1 font-mono"
                                  type="number"
                                  min={1}
                                  max={200}
                                  value={currentDraft.presentationTraceLimitValue}
                                  onChange={e => updateDraft({ presentationTraceLimitValue: e.target.value })}
                                />
                              )}
                              <div className="mt-1 text-meta text-subtle">心跳卡片最多保留几个执行阶段。</div>
                            </div>
                            <div>
                              <label className="mb-1 block font-medium text-secondary">推送间隔</label>
                              <Select
                                aria-label="推送间隔"
                                value={currentDraft.presentationPushIntervalMode}
                                onChange={e => updateDraft({ presentationPushIntervalMode: e.target.value as 'inherit' | 'set' })}
                              >
                                <option value="inherit">继承 Bot 默认</option>
                                <option value="set">本群单独设置</option>
                              </Select>
                              {currentDraft.presentationPushIntervalMode === 'set' && (
                                <Input
                                  aria-label="本群推送间隔毫秒"
                                  className="mt-1 font-mono"
                                  type="number"
                                  min={500}
                                  max={20000}
                                  step={100}
                                  value={currentDraft.presentationPushIntervalValue}
                                  onChange={e => updateDraft({ presentationPushIntervalValue: e.target.value })}
                                />
                              )}
                              <div className="mt-1 text-meta text-subtle">500-20000 毫秒；改卡片的刷新节奏。</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 底部聚合保存条 */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle pt-4">
                    <div className="text-caption text-subtle">
                      {presentationError ? (
                        <span className="font-medium text-danger">{presentationError}</span>
                      ) : isDirty ? (
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
                        onClick={resetDraft}
                      >
                        放弃修改
                      </Button>
                      <Button
                        variant="primary"
                        disabled={!isDirty || Boolean(presentationError)}
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

              {/* 通用协作管理：按群 + Bot 隔离，panel 内部以 appId:chatId 为 key 重建 */}
              {activeBotEntry && (
                <CollaborationPanel
                  appId={activeBotEntry.appId}
                  chatId={activeGroup.chatId}
                  groupName={activeGroup.name}
                  botName={botsMap.get(activeBotEntry.appId)?.name}
                />
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
