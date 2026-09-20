import type { LarkSetupTarget } from '../app-route';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, Check, ExternalLink, Eye, EyeOff, FolderOpen, Plus, Trash2, Wrench, X } from 'lucide-react';
import { validateHighRiskPattern } from '@dutydeck/shared';
import { api, type Agent, type RiskControlMode } from '../api';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from '../model-cache';
import { Badge, Banner, Button, Dialog, Field, IconButton, Input, Select, Skeleton, Spinner, Textarea } from './primitives';
import { ConfirmDialog } from './ConfirmDialog';
import { AgentSelect, CompactSelect } from './CompactSelect';
import { MemberNameTagInput } from './MemberNameTagInput';
import { LarkAppCreationPanel } from './LarkAppCreationPanel';

export type LarkConfigModalProps = { agents: Agent[]; target?: LarkSetupTarget; onClose(): void };

/** `/new --cwd <别名>` 别名表的编辑行；两端留空的行在保存时丢弃。 */
type WorkspaceAliasRow = { alias: string; path: string };

/*
  两个阈值的下限必须和 apps/server/src/lark/config.ts 的 saveLarkConfig 校验一致，
  否则用户填完、点保存才被服务端拒绝。
  加急 ≥60 秒：更短就等于卡片一发出去就推强提醒横幅，那不叫「提醒无人处理」。
  置顶 ≥1 秒：置顶随时可撤、终态自动撤，不需要同样的下限。
*/
const minUrgentThresholdSeconds = 60;
const minPinAfterSeconds = 1;

/** 秒 ↔ 毫秒：这两项在配置里是毫秒，但让人按秒填才读得懂。空串表示沿用服务端默认。 */
const secondsFromMs = (value: number | undefined) => value === undefined ? '' : String(Math.round(value / 1000));
const msFromSeconds = (value: string) => {
  const seconds = Number(value.trim());
  return value.trim() && Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
};

/** 编辑行折回后端接受的别名表；同名后写覆盖先写，与服务端归一化口径一致。 */
const workspaceAliasTable = (rows: readonly WorkspaceAliasRow[]): Record<string, string> => {
  const table: Record<string, string> = {};
  for (const row of rows) {
    const alias = row.alias.trim();
    const path = row.path.trim();
    if (alias && path) table[alias] = path;
  }
  return table;
};

/*
  S7 Web 出口健康提示的 web 侧分类。apps/web 不能依赖 apps/server，
  规则与文案必须与 apps/server/src/lark/config.ts 的 describeWebBaseUrlReachability
  保持一致；改动分类规则时两边同步，测试各自钉一份边界矩阵。
*/
const webBaseUrlUnsetMessage = '未配置公网 Web 地址：审批/问答卡片没有网页出口，手机无法打开详情。';
const webBaseUrlLocalMessage = 'Web 地址只在本机或内网可达：手机外网打不开，卡片上的“查看详情”没有出口。';
const webBaseUrlInvalidMessage = 'Web 地址不是合法的 http(s) 链接：卡片上的“查看详情”不会渲染，请改为手机可达的公网地址。';

function describeWebBaseUrlReachability(webBaseUrl: string): { kind: 'unset' | 'local' | 'public'; message?: string } {
  const trimmed = webBaseUrl.trim();
  if (!trimmed) return { kind: 'unset', message: webBaseUrlUnsetMessage };
  // ftp:// 等非 http(s) 协议不能补成 https://（new URL 会把主机名误读成协议段），直接判不可用。
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1]!)) return { kind: 'local', message: webBaseUrlInvalidMessage };
  // normalizeWebBaseUrl 会把非 http(s) 输入误补成 https://<原串>（ftp://x → https://ftp://x），
  // 归一化后的存储态会在主机段内出现第二个 ://；hydrate 回填的是存储态，需同样判畸形，避免警示漏报。
  // 只看首个路径分隔符之前的主机段，避免误伤路径或参数里自带 URL 的合法公网地址。
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*:\/\//i.test(trimmed)) return { kind: 'local', message: webBaseUrlInvalidMessage };
  let parsed: URL;
  try {
    parsed = new URL(scheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { kind: 'local', message: webBaseUrlInvalidMessage };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'local', message: webBaseUrlInvalidMessage };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) return { kind: 'local', message: webBaseUrlInvalidMessage };
  const local = hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.local') || (() => {
    if (hostname.includes(':')) {
      const firstHextet = parseInt(hostname.slice(0, 4), 16);
      return Number.isInteger(firstHextet) && ((firstHextet >= 0xfe80 && firstHextet <= 0xfebf) || (firstHextet >= 0xfc00 && firstHextet <= 0xfdff));
    }
    const parts = hostname.split('.');
    if (parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
      const [first = 0, second = 0] = parts.map(Number);
      return first === 0 || first === 10 || first === 127
        || (first === 169 && second === 254)
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168);
    }
    return false;
  })();
  return local ? { kind: 'local', message: webBaseUrlLocalMessage } : { kind: 'public' };
}

/*
  四个手写开关（primitives 里没有 Switch 原语）。轨道是真正的胶囊滑块，
  契约 §3 允许 rounded-full。aria-label 必填：靠旁边的文本认不出这是哪个开关。

  关态轨道用 `bg-neutral-solid`：`border-strong` 只登记在 borderColor 里，没有同名的
  背景语义类，而中性实心灰正是「关闭」该有的语义。
*/
function Switch({ id, label, checked, disabled, onToggle }: { id: string; label: string; checked: boolean; disabled?: boolean; onToggle(): void }) {
  return <button
    type="button"
    id={id}
    role="switch"
    aria-label={label}
    aria-checked={checked}
    disabled={disabled}
    onClick={onToggle}
    className="ml-auto flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed"
  ><span className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors duration-fast ease-out ${checked && !disabled ? 'bg-inverse' : 'bg-neutral-solid'}`}><span className={`h-4 w-4 rounded-full bg-surface shadow-card transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}/></span></button>;
}

export function LarkConfigModal({ agents, target, onClose }: LarkConfigModalProps) {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig });
  const capabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });
  const [confirmation, setConfirmation] = useState<'incomplete' | 'discard' | 'delete'>();
  const [openPlatformJobId, setOpenPlatformJobId] = useState('');
  const [creationBusy, setCreationBusy] = useState(false);
  const [creationNeedsSetup, setCreationNeedsSetup] = useState('');
  const [creationPendingReview, setCreationPendingReview] = useState('');
  const hydratedSelection = useRef<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const enableListeningAfterNewBot = useRef(false);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null); const [step, setStep] = useState<1 | 2>(1); const [name, setName] = useState(''); const [workspace, setWorkspace] = useState(''); const [webBaseUrl, setWebBaseUrl] = useState(typeof window !== 'undefined' ? window.location.origin : ''); const [appId, setAppId] = useState(''); const [appSecret, setAppSecret] = useState(''); const [restrictUsers, setRestrictUsers] = useState(false); const [allowedUserNames, setAllowedUserNames] = useState<string[]>([]); const [allowedBotNames, setAllowedBotNames] = useState<string[]>([]); const [peerBotsAllowed, setPeerBotsAllowed] = useState(true); const [defaultAgentId, setDefaultAgentId] = useState(''); const [defaultModel, setDefaultModel] = useState(''); const [defaultReasoningEffort, setDefaultReasoningEffort] = useState(''); const [fullTrustConfirmed, setFullTrustConfirmed] = useState(false); const [permissionMode, setPermissionMode] = useState<'ask' | 'full-trust'>('full-trust'); const [preInjectPrompt, setPreInjectPrompt] = useState(''); const [groupToolsEnabled, setGroupToolsEnabled] = useState(false); const [groupToolsAllowSend, setGroupToolsAllowSend] = useState(false); const [memoryEnabled, setMemoryEnabled] = useState(true); const [memoryAutoExtract, setMemoryAutoExtract] = useState(true); const [memoryAgentId, setMemoryAgentId] = useState(''); const [memoryModel, setMemoryModel] = useState(''); const [highRiskAllowedUserNames, setHighRiskAllowedUserNames] = useState<string[]>([]); const [highRiskPattern, setHighRiskPattern] = useState(''); const [riskControlMode, setRiskControlMode] = useState<RiskControlMode>('off'); const [showSecret, setShowSecret] = useState(false); const [listening, setListening] = useState(false); const [pushIntervalMs, setPushIntervalMs] = useState(1000); const [traceLimit, setTraceLimit] = useState('50'); const [structuredAskCards, setStructuredAskCards] = useState(true); const [groupCardMention, setGroupCardMention] = useState(false); const [completionReactionOnly, setCompletionReactionOnly] = useState(false); const [silentProgress, setSilentProgress] = useState(false); const [workspaceAliasRows, setWorkspaceAliasRows] = useState<WorkspaceAliasRow[]>([]); const [verificationCommand, setVerificationCommand] = useState(''); const [urgentEnabled, setUrgentEnabled] = useState(false); const [urgentThresholdSeconds, setUrgentThresholdSeconds] = useState(''); const [urgentMaxPerHourPerChat, setUrgentMaxPerHourPerChat] = useState(''); const [pinLongTasks, setPinLongTasks] = useState(false); const [pinAfterSeconds, setPinAfterSeconds] = useState('');
  const current = config.data?.bots.find(bot => bot.appId === selectedAppId);
  const webBaseUrlReachability = useMemo(() => describeWebBaseUrlReachability(webBaseUrl), [webBaseUrl]);
  const highRiskPatternValidation = useMemo(() => validateHighRiskPattern(highRiskPattern), [highRiskPattern]);
  const hookStatus = useQuery({ queryKey: ['lark-hook-status', current?.appId, defaultAgentId], queryFn: () => api.larkHookStatus(current!.appId, defaultAgentId), enabled: Boolean(current && defaultAgentId && riskControlMode === 'enforced' && step === 2) });
  const agentOptions = useQuery({ queryKey: agentModelsQueryKey(defaultAgentId, defaultModel), queryFn: () => loadAgentModels(defaultAgentId, defaultModel || undefined), enabled: Boolean(defaultAgentId), initialData: () => readCachedAgentModels(defaultAgentId, defaultModel || undefined), initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 5 * 60_000 });
  const openPlatformJob = useQuery({
    queryKey: ['lark-open-platform-job', openPlatformJobId],
    queryFn: () => api.larkOpenPlatformSetupJob(openPlatformJobId),
    enabled: Boolean(openPlatformJobId),
    refetchInterval: query => ['preparing', 'waiting_for_scan', 'configuring'].includes(query.state.data?.status ?? '') ? 1_000 : false
  });
  const startOpenPlatformSetup = useMutation({
    mutationFn: (forceLogin: boolean) => api.startLarkOpenPlatformSetup(appId.trim(), forceLogin),
    onSuccess: job => { setOpenPlatformJobId(job.id); qc.setQueryData(['lark-open-platform-job', job.id], job); }
  });
  const enforcedHookReady = Boolean(hookStatus.data?.supported && hookStatus.data.installed && hookStatus.data.writable);
  const legacyHighRiskNeedsMigration = Boolean(riskControlMode !== 'off' && current?.highRiskAllowedEmails.length && !highRiskAllowedUserNames.length);
  useEffect(() => {
    if (!agentOptions.data || agentOptions.isFetching || !defaultReasoningEffort) return;
    if (!agentOptions.data.reasoningEfforts.some(option => option.id === defaultReasoningEffort)) setDefaultReasoningEffort('');
  }, [agentOptions.data, agentOptions.isFetching, defaultReasoningEffort]);
  useEffect(() => {
    if (!config.data || selectedAppId !== null) return;
    const initialBot = target && target !== 'new' ? config.data.bots.find(bot => bot.appId === target.appId) : target === 'new' ? undefined : config.data.bots[0];
    setSelectedAppId(target && target !== 'new' ? target.appId : initialBot?.appId ?? '');
    setStep(!target && initialBot && !initialBot.setupComplete ? 2 : 1);
  }, [config.data, selectedAppId, target]);
  useEffect(() => {
    if (!config.data || selectedAppId === null) return;
    if (hydratedSelection.current === selectedAppId) return;
    hydratedSelection.current = selectedAppId;
    const bot = config.data.bots.find(item => item.appId === selectedAppId);
    setName(bot?.name ?? ''); setWorkspace(bot?.workspace ?? ''); setWebBaseUrl(bot?.webBaseUrl ?? (typeof window !== 'undefined' ? window.location.origin : '')); setAppId(bot?.appId ?? ''); setAppSecret(''); setOpenPlatformJobId(''); setRestrictUsers(Boolean(bot?.allowedUsers.length || bot?.allowedEmails.length)); setAllowedUserNames((bot?.allowedUsers ?? []).map(user => user.name)); setAllowedBotNames((bot?.allowedBots ?? []).map(b => b.name)); setPeerBotsAllowed(bot?.peerBotsAllowed !== false);
    setDefaultAgentId(agents.some(agent => agent.id === bot?.defaultAgentId) ? bot?.defaultAgentId ?? '' : agents[0]?.id ?? '');
    setDefaultModel(bot?.defaultModel ?? ''); setDefaultReasoningEffort(bot?.defaultReasoningEffort ?? ''); setFullTrustConfirmed(bot?.fullTrustConfirmed ?? false); setPermissionMode(bot?.permissionMode ?? 'full-trust'); setListening(enableListeningAfterNewBot.current ? true : bot?.listening ?? true); enableListeningAfterNewBot.current = false; setPushIntervalMs(bot?.pushIntervalMs ?? 1000); setTraceLimit((bot?.traceLimit ?? 10).toString());
    setPreInjectPrompt(bot?.preInjectPrompt ?? ''); setGroupToolsEnabled(bot?.groupToolsEnabled ?? false); setGroupToolsAllowSend(bot?.groupToolsAllowSend ?? false); setMemoryEnabled(bot?.memoryEnabled ?? true); setMemoryAutoExtract(bot?.memoryAutoExtract ?? true); setMemoryAgentId(bot?.memoryAgentId ?? ''); setMemoryModel(bot?.memoryModel ?? ''); setStructuredAskCards(bot?.structuredAskCards ?? true); setGroupCardMention(bot?.groupCardMention ?? false); setCompletionReactionOnly(bot?.completionReactionOnly ?? false); setSilentProgress(bot?.silentProgress ?? false); setWorkspaceAliasRows(Object.entries(bot?.workspaceAliases ?? {}).map(([alias, path]) => ({ alias, path }))); setVerificationCommand(bot?.verificationCommand ?? '');
    setUrgentEnabled(bot?.urgentEnabled ?? false); setUrgentThresholdSeconds(secondsFromMs(bot?.urgentThresholdMs)); setUrgentMaxPerHourPerChat(bot?.urgentMaxPerHourPerChat === undefined ? '' : String(bot.urgentMaxPerHourPerChat)); setPinLongTasks(bot?.pinLongTasks ?? false); setPinAfterSeconds(secondsFromMs(bot?.pinAfterMs));
    setHighRiskAllowedUserNames((bot?.highRiskAllowedUsers ?? []).map(user => user.name)); setHighRiskPattern(bot?.highRiskPattern ?? ''); setRiskControlMode(bot?.riskControlMode ?? 'off');
  }, [config.data, agents, selectedAppId]);
  const inspect = useMutation({ mutationFn: () => api.inspectLarkBot({ appId: appId.trim(), appSecret: appSecret.trim() }), onSuccess: result => setName(result.appName) });
  const save = useMutation({
    mutationFn: () => step === 1
      ? api.saveLarkConfig({ stage: 'lark', ...(current ? { originalAppId: current.appId } : {}), appId: appId.trim(), ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}), workspace: workspace.trim(), workspaceAliases: workspaceAliasTable(workspaceAliasRows), verificationCommand: verificationCommand.trim(), webBaseUrl: webBaseUrl.trim(), structuredAskCards, groupCardMention, completionReactionOnly, silentProgress, urgentEnabled, urgentThresholdMs: urgentThresholdMs ?? null, urgentMaxPerHourPerChat: urgentQuota ?? null, pinLongTasks, pinAfterMs: pinAfterMs ?? null, allowedUserNames: restrictUsers ? allowedUserNames : [], allowedEmails: [], allowedBotNames, peerBotsAllowed, pushIntervalMs, traceLimit: Number(traceLimit) })
      : api.saveLarkConfig({ stage: 'agent', originalAppId: current!.appId, defaultAgentId, defaultModel, defaultReasoningEffort, fullTrustConfirmed, permissionMode, preInjectPrompt, listening, groupToolsEnabled, groupToolsAllowSend, memoryEnabled, memoryAutoExtract, memoryAgentId, memoryModel, highRiskAllowedUserNames, highRiskAllowedEmails: [], highRiskPattern, riskControlMode }),
    onSuccess: data => { if (step === 1 && !current) enableListeningAfterNewBot.current = true; qc.setQueryData(['lark-config'], data); const savedId = appId.trim(); setSelectedAppId(savedId); setAppSecret(''); void qc.invalidateQueries({ queryKey: ['lark-hook-status', savedId] }); if (step === 1) setStep(2); else onClose(); }
  });
  const installHook = useMutation({
    mutationFn: async () => {
      const saved = await api.saveLarkConfig({ stage: 'agent', originalAppId: current!.appId, defaultAgentId, defaultModel, defaultReasoningEffort, fullTrustConfirmed, permissionMode, preInjectPrompt, listening, groupToolsEnabled, groupToolsAllowSend, memoryEnabled, memoryAutoExtract, memoryAgentId, memoryModel, highRiskAllowedUserNames, highRiskAllowedEmails: [], highRiskPattern, riskControlMode: 'guidance' });
      qc.setQueryData(['lark-config'], saved);
      return api.installLarkHook(current!.appId, highRiskPattern);
    },
    onSuccess: result => { qc.setQueryData(['lark-hook-status', current!.appId, defaultAgentId], result); setRiskControlMode('enforced'); void qc.invalidateQueries({ queryKey: ['lark-config'] }); }
  });
  const remove = useMutation({ mutationFn: () => api.deleteLarkConfig(current!.appId), onSuccess: data => { qc.setQueryData(['lark-config'], data); const firstBot = data.bots[0]; setSelectedAppId(firstBot?.appId ?? ''); setStep(firstBot && !firstBot.setupComplete ? 2 : 1); setConfirmation(undefined); } });
  const pickWorkspace = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => setWorkspace(result.path) });
  const agentCapabilitiesPending = step === 2 && Boolean(defaultAgentId) && !agentOptions.data && (agentOptions.isLoading || agentOptions.isFetching);
  const agentCapabilitiesReady = step !== 2 || Boolean(agentOptions.data);
  const missingTarget = Boolean(selectedAppId && config.data && !current);
  // 服务端会静默丢掉指向相对路径的别名，所以这里必须先挡住：别名存不进去却不报错，
  // 用户下次 `/new --cwd <别名>` 才会发现，那时已经无从追查。
  const invalidWorkspaceAliases = workspaceAliasRows.filter(row => row.alias.trim() && row.path.trim() && !row.path.trim().startsWith('/'));
  // 服务端会直接拒绝越界阈值，所以这里先挡住：填完点保存才被拒是最没必要的一次往返。
  const urgentThresholdMs = msFromSeconds(urgentThresholdSeconds);
  const urgentQuota = urgentMaxPerHourPerChat.trim() ? Number(urgentMaxPerHourPerChat.trim()) : undefined;
  const pinAfterMs = msFromSeconds(pinAfterSeconds);
  const reminderErrors = [
    urgentThresholdSeconds.trim() && (urgentThresholdMs === undefined || urgentThresholdMs < minUrgentThresholdSeconds * 1000) ? `加急等待时间至少 ${minUrgentThresholdSeconds} 秒，留空表示用默认的 10 分钟。` : '',
    urgentMaxPerHourPerChat.trim() && (urgentQuota === undefined || !Number.isInteger(urgentQuota) || urgentQuota < 1) ? '每群每小时加急次数必须是不小于 1 的整数，留空表示用默认的 3 次。' : '',
    pinAfterSeconds.trim() && (pinAfterMs === undefined || pinAfterMs < minPinAfterSeconds * 1000) ? `置顶等待时间至少 ${minPinAfterSeconds} 秒，留空表示用默认的 10 分钟。` : ''
  ].filter(Boolean);
  const canSave = !creationBusy && !missingTarget && (step === 1
    ? Boolean(appId.trim() && (current || appSecret.trim()) && (!restrictUsers || allowedUserNames.length) && !invalidWorkspaceAliases.length && !reminderErrors.length && Number.isInteger(pushIntervalMs) && pushIntervalMs >= 500 && pushIntervalMs <= 20000)
    : Boolean(current && defaultAgentId && (permissionMode === 'ask' ? agentOptions.data?.source === 'acp' : fullTrustConfirmed) && agentCapabilitiesReady && (riskControlMode === 'off' || highRiskPatternValidation.valid) && !legacyHighRiskNeedsMigration && (riskControlMode !== 'enforced' || enforcedHookReady)));
  const formError = save.error ?? remove.error ?? pickWorkspace.error ?? inspect.error ?? startOpenPlatformSetup.error ?? openPlatformJob.error ?? installHook.error ?? (agentOptions.data ? undefined : agentOptions.error) ?? hookStatus.error ?? config.error;
  const permissionSettingsUrl = /^cli_[\w-]+$/.test(appId.trim()) ? `https://open.larkoffice.com/app/${encodeURIComponent(appId.trim())}/auth` : undefined;
  const permissionRelatedError = Boolean(formError && /权限|permission|通讯录|邮箱|open[_ ]?id|资源点|visible range/i.test(formError.message));
  const requestClose = useCallback(() => {
    const incompleteDraft = Boolean(current && !current.setupComplete);
    const unsavedNewBot = !current && selectedAppId === '' && Boolean(appId.trim() || appSecret.trim() || workspace.trim());
    if (incompleteDraft || unsavedNewBot) { setConfirmation(incompleteDraft ? 'incomplete' : 'discard'); return; }
    onClose();
  }, [appId, appSecret, current, onClose, selectedAppId, workspace]);
  /*
    Escape / 点遮罩关闭的门禁。

    `!confirmation` 是双保险：ConfirmDialog 打开时 Escape 应该只收掉确认框，
    不该连整张填了一半的向导一起关掉。ConfirmDialog 注册在 useEscapeKey 的 LIFO
    栈更上层本来就会先响应，但把条件写在这里，语义不依赖注册顺序。
    提交中（save / remove）不允许关闭：会把一个已发出的写请求丢在半路。
  */
  const dismissible = !confirmation && !save.isPending && !remove.isPending;
  const addBot = () => {
    const focusName = selectedAppId === '' && (appId || appSecret) ? 'appId' : 'newAppName';
    setSelectedAppId('');
    setStep(1);
    requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>(`input[name="${focusName}"]`)?.focus());
  };
  const onAppCreated = async (createdAppId: string, configured: boolean, pendingReview = false) => {
    const latest = await api.larkConfig();
    if (!latest.bots.some(bot => bot.appId === createdAppId)) throw new Error('尚未读取到已创建机器人的配置，请重试连接。');
    enableListeningAfterNewBot.current = configured;
    setCreationNeedsSetup(configured ? '' : createdAppId);
    setCreationPendingReview(pendingReview ? createdAppId : '');
    qc.setQueryData(['lark-config'], latest);
    setSelectedAppId(createdAppId);
    setStep(configured ? 2 : 1);
  };
  return <>
  <Dialog open onClose={requestClose} label={current ? `更新飞书 Bot：${current.name}` : '绑定飞书 Bot'} size="md" closeOnEscape={dismissible} closeOnScrim={dismissible}>
    {/* <form> 插在 Dialog 与 Header/Body/Footer 之间会打断 flex 链，所以自己接上。 */}
    <form ref={form} onSubmit={event => { event.preventDefault(); if (canSave) save.mutate(); }} className="flex min-h-0 flex-1 flex-col">
      <Dialog.Header className="flex-wrap"><div className="min-w-0 flex-1"><h2 className="text-body font-semibold text-primary">{current ? `更新飞书 Bot：${current.name}` : '绑定飞书 Bot'}</h2><p className="mt-0.5 text-caption text-subtle">Bot 负责收发消息，Agent 负责执行任务</p></div><div className="order-3 mt-2 flex w-full shrink-0 items-center justify-end gap-0.5 sm:order-none sm:ml-auto sm:mt-0 sm:w-auto"><a href="https://open.larkoffice.com/app" target="_blank" rel="noreferrer" className="flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-caption font-medium text-subtle transition-colors duration-fast ease-out hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">飞书开发者后台<ExternalLink size={12}/></a><a href="https://open.larkoffice.com/page/launcher?from=backend_oneclick" target="_blank" rel="noreferrer" className="flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-caption font-medium text-secondary transition-colors duration-fast ease-out hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">快速创建应用<ExternalLink size={12}/></a></div><IconButton label="关闭" onClick={requestClose}><X size={15}/></IconButton></Dialog.Header>
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-subtle bg-muted px-3 py-2">
        {config.data?.bots.map(bot => <button key={bot.appId} type="button" disabled={creationBusy} onClick={() => { setSelectedAppId(bot.appId); setStep(bot.setupComplete ? 1 : 2); }} className={`flex h-10 max-w-[250px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-caption font-medium transition-colors duration-fast ease-out ${selectedAppId === bot.appId ? 'border border-default bg-surface text-primary shadow-card' : 'border border-transparent text-subtle hover:bg-hover hover:text-primary'}`}><Bot size={13} className="shrink-0"/><span title={bot.name} className="min-w-0 max-w-32 truncate">{bot.tabLabel}</span>{bot.setupComplete ? <span title="配置完成" className="shrink-0"><Badge tone="success"><Check size={9}/>已配置</Badge></span> : <span className="shrink-0"><Badge tone="warning">待配置</Badge></span>}{bot.activeListening && !config.data?.listeningDisabled && bot.listening && <span title="监听已启动" className="h-1.5 w-1.5 shrink-0 rounded-full bg-success-solid"/>}</button>)}
        <button type="button" disabled={creationBusy} aria-pressed={selectedAppId === ''} onClick={addBot} className={`flex h-10 shrink-0 items-center gap-1 rounded-md px-2.5 text-caption font-medium transition-colors duration-fast ease-out ${selectedAppId === '' ? 'border border-default bg-surface text-primary shadow-card' : 'border border-transparent text-subtle hover:bg-hover hover:text-primary'}`}><Plus size={13}/>新增机器人</button>
      </div>
      <Dialog.Body className="space-y-3.5">
        {config.isLoading ? <Skeleton variant="row" lines={3}/> : missingTarget ? <Banner tone="warning">找不到指定机器人。请选择已有机器人或点击新增机器人。</Banner> : <>
          <div className="mb-1 grid grid-cols-2 rounded-md bg-muted p-1"><button type="button" onClick={() => setStep(1)} className={`min-h-10 rounded-md px-3 text-caption font-medium transition-colors duration-fast ease-out ${step === 1 ? 'bg-surface text-primary shadow-card' : 'text-subtle'}`}><span className="mr-1.5 inline-grid h-5 w-5 place-items-center rounded-full bg-inverse text-meta text-on-inverse">1</span>连接飞书应用</button><button type="button" disabled={!current} onClick={() => setStep(2)} className={`min-h-10 rounded-md px-3 text-caption font-medium transition-colors duration-fast ease-out disabled:opacity-40 ${step === 2 ? 'bg-surface text-primary shadow-card' : 'text-subtle'}`}><span className="mr-1.5 inline-grid h-5 w-5 place-items-center rounded-full bg-inverse text-meta text-on-inverse">2</span>选择 Agent 并启用</button></div>
          <p role={selectedAppId === '' ? 'status' : undefined} className="-mt-1 text-caption text-subtle">{step === 1 ? current ? '填写飞书应用凭据并配置必要能力；成员范围可以留空，稍后再收紧。' : '正在新增机器人。可以创建新应用，或填写已有应用的 App ID 和 App Secret，再点击“下一步”。' : '选择处理飞书消息的 Agent、确认工作方式并启用监听。'}</p>
          {agents.length === 0 && <Banner tone="warning" role="alert">当前没有可用 Agent。你可以先保存飞书应用，但完成绑定前需要安装并登录 Agent CLI，然后重启 Dutydeck。</Banner>}
          {current?.appId === creationPendingReview && <Banner tone="warning">应用已提交发布，正在等待飞书管理员审核。可以先保存 Agent 设置，审核通过后生效。</Banner>}
          {step === 1 ? <>
          {current?.appId === creationNeedsSetup && openPlatformJob.data?.status !== 'completed' && <Banner tone="warning">应用已创建，自动配置尚未完成。请先点击“自动配置”，或到飞书后台核对权限和发布状态。</Banner>}
          {!current && <LarkAppCreationPanel onCreated={onAppCreated} onBusyChange={setCreationBusy}/>}
          <fieldset disabled={creationBusy} className="space-y-3.5 disabled:opacity-50">
          {!current && <h3 className="text-caption font-semibold text-secondary">已有飞书应用？填写凭据手动绑定</h3>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="机器人名称"><Input value={name} readOnly placeholder="校验凭证后自动识别" className="bg-muted font-mono text-subtle"/></Field>
            <Field label="App ID"><Input name="appId" value={appId} onChange={event => { setAppId(event.target.value); setName(''); setOpenPlatformJobId(''); }} placeholder="cli_xxx" autoComplete="off" className="font-mono"/></Field>
          </div>
          {/*
            🔒 凭据只写不读。

            `appSecret` state 恒以 '' 起步（hydrate 时也显式 setAppSecret('')），编辑
            已有 bot 时只用 placeholder「已保存」表示后端存着一份，**绝不回填明文**。
            留空提交 = 保持不变，由 save 的 mutationFn 里那段
            `...(appSecret.trim() ? { appSecret } : {})` 保证——键根本不进请求体。
            这套语义一行都不许改，测试有对应守卫。
          */}
          <Field label="App Secret" hint={current ? '留空不修改' : undefined}>
            <span className="relative block">
              <Input value={appSecret} onChange={event => setAppSecret(event.target.value)} type={showSecret ? 'text' : 'password'} placeholder={current ? '已保存' : '输入 App Secret'} autoComplete="new-password" className="pr-10 font-mono"/>
              {/* IconButton 是 40×40，套进 40px 高的输入框会撑破它；这里保留手写按钮，
                  但命中区做到 40×40（契约 §9），输入框补 pr-10 让出位置。 */}
              <button type="button" onClick={() => setShowSecret(value => !value)} aria-label={showSecret ? '隐藏 Secret' : '显示 Secret'} className="absolute right-0 top-0 grid h-10 w-10 place-items-center rounded-md text-subtle hover:bg-hover hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{showSecret ? <EyeOff size={13}/> : <Eye size={13}/>}</button>
            </span>
          </Field>
          <div className="rounded-lg bg-muted p-3">
            <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="text-caption font-semibold text-primary">自动配置飞书能力</div><p className="mt-0.5 text-caption text-subtle">一次配置消息、群聊、附件、联系人、长连接事件与卡片回调，共 16 项必要权限，并保留当前应用可见范围后发布。</p></div><div className="flex shrink-0 items-center gap-1"><Button variant="secondary" size="sm" icon={<Wrench size={11}/>} loading={startOpenPlatformSetup.isPending || ['preparing', 'configuring'].includes(openPlatformJob.data?.status ?? '')} disabled={!appId.trim() || ['waiting_for_scan'].includes(openPlatformJob.data?.status ?? '')} onClick={() => startOpenPlatformSetup.mutate(false)}>{openPlatformJob.data?.status === 'failed' ? '重试' : openPlatformJob.data?.status === 'completed' ? '重新配置' : '自动配置'}</Button>{openPlatformJob.data?.status === 'failed' && <Button variant="ghost" size="sm" disabled={startOpenPlatformSetup.isPending} onClick={() => startOpenPlatformSetup.mutate(true)}>更换账号</Button>}</div></div>
            {openPlatformJob.data?.status === 'waiting_for_scan' && openPlatformJob.data.qrDataUrl && <div className="mt-3 flex items-center gap-3 rounded-md bg-surface p-2.5"><img src={openPlatformJob.data.qrDataUrl} alt="飞书开放平台登录二维码" className="h-28 w-28 rounded-md bg-surface"/><div className="text-caption text-subtle"><div className="font-medium text-primary">{openPlatformJob.data.scanConfirmed ? '已扫码，等待飞书确认' : '请用飞书扫码'}</div><div className="mt-1">仅用于登录开发者后台并配置当前 App ID；Cookie 私密保存在本机，不会读取或展示 App Secret。</div></div></div>}
            {openPlatformJob.data?.status === 'configuring' && <div className="mt-2 text-caption text-subtle">正在为 {openPlatformJob.data.accountName ?? '当前账号'} · {openPlatformJob.data.tenantName ?? '当前企业'} 配置并回读验证…</div>}
            {openPlatformJob.data?.status === 'completed' && <div className="mt-2"><Banner tone="success"><div className="flex items-center gap-1.5 font-medium"><Check size={11}/>已为 {openPlatformJob.data.accountName ?? '当前账号'} · {openPlatformJob.data.tenantName ?? '当前企业'} 完成配置并发布</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5"><span>{openPlatformJob.data.result?.scopeCount ?? 16} 项权限</span><span>{openPlatformJob.data.result?.eventCount ?? 1} 个事件</span><span>{openPlatformJob.data.result?.callbackCount ?? 1} 个回调</span>{openPlatformJob.data.result?.versionId && <span className="font-mono">版本 {openPlatformJob.data.result.versionId}</span>}</div>{Boolean(openPlatformJob.data.result?.skippedScopes?.length) && <div className="mt-1">本企业权限目录缺少 {openPlatformJob.data.result!.skippedScopes!.join('、')}，已跳过未申请，对应功能不可用。</div>}</Banner></div>}
            {openPlatformJob.data?.status === 'failed' && <div className="mt-2"><Banner tone="danger">{openPlatformJob.data.error ?? '自动配置失败，请重试'}</Banner></div>}
          </div>
          <Field label="默认工作区" hint="飞书创建的新任务默认在这个代码目录执行。">
            <span className="flex gap-2">
              <Input value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="输入运行 Dutydeck 的机器上的绝对路径" className="min-w-0 flex-1 font-mono"/>
              <Button variant="secondary" icon={<FolderOpen size={13}/>} disabled={!capabilities.data?.directoryPicker || pickWorkspace.isPending} onClick={() => pickWorkspace.mutate()}>{capabilities.data?.directoryPicker ? '选择目录' : '手动输入'}</Button>
            </span>
          </Field>
          <details className="rounded-lg bg-muted p-3"><summary className="min-h-10 cursor-pointer py-2 text-caption font-semibold text-secondary">访问范围与高级设置（可选）</summary><div className="mt-3 space-y-3.5">
          <Field label="Web 访问地址（可选）" hint="配置后，飞书卡片底部会显示“查看详情”链接，指向该域名下的任务 Trace 页面。">
            <Input value={webBaseUrl} onChange={event => setWebBaseUrl(event.target.value)} placeholder="https://dutydeck.example.com" className="font-mono"/>
          </Field>
          {/* S7：留空或只绑本机/内网时，卡片的“查看详情”在手机上注定打不开，必须就地提示，不做公网兜底。 */}
          {webBaseUrlReachability.kind !== 'public' && <Banner tone="warning">{webBaseUrlReachability.message}</Banner>}
          <div className="border-t border-subtle pt-3.5">
            <div className="text-caption font-medium text-secondary">工作区别名（可选）</div>
            <p className="mt-0.5 text-caption text-subtle">飞书里用 <code>/new --cwd 别名</code> 切换到对应目录；路径必须是绝对路径。留空表示只用上面的默认工作区。</p>
            <div className="mt-2.5 space-y-2">
              {workspaceAliasRows.map((row, index) => <div key={index} className="flex items-center gap-2">
                <Input id={`lark-alias-name-${index}`} aria-label={`别名 ${index + 1}`} value={row.alias} placeholder="别名" className="w-32 shrink-0 font-mono" onChange={event => setWorkspaceAliasRows(rows => rows.map((item, position) => position === index ? { ...item, alias: event.target.value } : item))}/>
                <Input id={`lark-alias-path-${index}`} aria-label={`别名 ${index + 1} 的绝对路径`} value={row.path} placeholder="/绝对/路径" className="font-mono" onChange={event => setWorkspaceAliasRows(rows => rows.map((item, position) => position === index ? { ...item, path: event.target.value } : item))}/>
                <IconButton label={`删除第 ${index + 1} 个别名`} tone="danger" onClick={() => setWorkspaceAliasRows(rows => rows.filter((_, position) => position !== index))}><Trash2 size={13}/></IconButton>
              </div>)}
              <Button variant="secondary" icon={<Plus size={12}/>} onClick={() => setWorkspaceAliasRows(rows => [...rows, { alias: '', path: '' }])}>添加别名</Button>
            </div>
            {invalidWorkspaceAliases.length > 0 && <div className="mt-2"><Banner tone="warning">别名路径必须以 / 开头的绝对路径，否则保存时会被丢弃：{invalidWorkspaceAliases.map(row => row.alias.trim()).join('、')}</Banner></div>}
          </div>
          <Field label="验证命令（可选）" hint="结果卡的验证状态与“运行验证”按钮依赖它；留空时结果卡不提验证，也不显示该按钮。命令在上面的工作区里执行。">
            <Input value={verificationCommand} onChange={event => setVerificationCommand(event.target.value)} placeholder="pnpm test" className="font-mono"/>
          </Field>
          <div className="space-y-2.5 border-t border-subtle pt-3.5">
            <div className="flex items-center rounded-md bg-surface px-3 py-2 shadow-card"><div className="min-w-0"><label htmlFor="lark-switch-structured-ask" className="cursor-pointer text-caption font-medium text-primary">结构化问答卡片（默认开启）</label><div className="mt-0.5 text-caption text-subtle">问答卡渲染单选、多选与输入框等结构化组件；低版本飞书客户端可能不支持，会回退为引用卡片回复。</div></div><Switch id="lark-switch-structured-ask" label="结构化问答卡片（默认开启）" checked={structuredAskCards} onToggle={() => setStructuredAskCards(value => !value)}/></div>
            <div className="flex items-center rounded-md bg-surface px-3 py-2 shadow-card"><div className="min-w-0"><label htmlFor="lark-switch-group-mention" className="cursor-pointer text-caption font-medium text-primary">群卡片 @ 发起人（实验能力，默认关闭）</label><div className="mt-0.5 text-caption text-subtle">群内审批卡与结果卡 @ 发起人，免打扰时也能亮屏提醒；触达效果尚待真机验证，私聊不受影响。</div></div><Switch id="lark-switch-group-mention" label="群卡片 @ 发起人（实验能力，默认关闭）" checked={groupCardMention} onToggle={() => setGroupCardMention(value => !value)}/></div>
            <div className="flex items-center rounded-md bg-surface px-3 py-2 shadow-card"><div className="min-w-0"><label htmlFor="lark-switch-completion-reaction" className="cursor-pointer text-caption font-medium text-primary">完成时只贴表情、不发结果卡（默认关闭）</label><div className="mt-0.5 text-caption text-subtle">任务完成时只对原消息贴一个表情，不再发结果卡；想看结果仍可在 Web 里查。可在群配置里按群覆盖。</div></div><Switch id="lark-switch-completion-reaction" label="完成时只贴表情、不发结果卡（默认关闭）" checked={completionReactionOnly} onToggle={() => setCompletionReactionOnly(value => !value)}/></div>
            <div className="flex items-center rounded-md bg-surface px-3 py-2 shadow-card"><div className="min-w-0"><label htmlFor="lark-switch-silent-progress" className="cursor-pointer text-caption font-medium text-primary">中间进展静默（默认关闭）</label><div className="mt-0.5 text-caption text-subtle">执行期间不发中间进展，只保留最终结果。可在群配置里按群覆盖。</div></div><Switch id="lark-switch-silent-progress" label="中间进展静默（默认关闭）" checked={silentProgress} onToggle={() => setSilentProgress(value => !value)}/></div>
            <div className="flex items-center rounded-md bg-surface px-3 py-2 shadow-card"><div className="min-w-0"><label htmlFor="lark-switch-urgent" className="cursor-pointer text-caption font-medium text-primary">长时间没人处理时发加急（默认关闭）</label><div className="mt-0.5 text-caption text-subtle">审批卡或提问卡挂太久时，给该回答的那个人推一条飞书应用内加急，免打扰也会亮屏。只加急要回答的人，不会加急全群。</div></div><Switch id="lark-switch-urgent" label="长时间没人处理时发加急（默认关闭）" checked={urgentEnabled} onToggle={() => setUrgentEnabled(value => !value)}/></div>
            {urgentEnabled && <div className="flex gap-2 pl-3">
              <div className="flex-1"><Field label="加急前等待（秒）" hint={`留空用默认的 10 分钟；最少 ${minUrgentThresholdSeconds} 秒。`}>
                <Input inputMode="numeric" value={urgentThresholdSeconds} placeholder="600" onChange={event => setUrgentThresholdSeconds(event.target.value)}/>
              </Field></div>
              <div className="flex-1"><Field label="每群每小时最多加急" hint="留空用默认的 3 次。">
                <Input inputMode="numeric" value={urgentMaxPerHourPerChat} placeholder="3" onChange={event => setUrgentMaxPerHourPerChat(event.target.value)}/>
              </Field></div>
            </div>}
            <div className="flex items-center rounded-md bg-surface px-3 py-2 shadow-card"><div className="min-w-0"><label htmlFor="lark-switch-pin" className="cursor-pointer text-caption font-medium text-primary">长任务进度卡置顶（默认关闭）</label><div className="mt-0.5 text-caption text-subtle">任务跑够设定时长后把进度卡置顶到会话顶部，任务结束自动取消置顶。置顶会出现在所有群成员的会话里。</div></div><Switch id="lark-switch-pin" label="长任务进度卡置顶（默认关闭）" checked={pinLongTasks} onToggle={() => setPinLongTasks(value => !value)}/></div>
            {pinLongTasks && <div className="pl-3">
              <Field label="跑多久算长任务（秒）" hint={`留空用默认的 10 分钟；最少 ${minPinAfterSeconds} 秒。`}>
                <Input inputMode="numeric" value={pinAfterSeconds} placeholder="600" onChange={event => setPinAfterSeconds(event.target.value)}/>
              </Field>
            </div>}
            {reminderErrors.length > 0 && <Banner tone="warning">{reminderErrors.join('')}</Banner>}
          </div>
          {!current && <Button variant="secondary" fullWidth icon={<Bot size={12}/>} loading={inspect.isPending} disabled={!appId.trim() || !appSecret.trim()} onClick={() => inspect.mutate()}>校验凭证并识别机器人名称</Button>}
          <div className="border-t border-subtle pt-3.5">
            <div className="flex items-start justify-between gap-3"><div><div className="text-caption font-medium text-secondary">可使用机器人的成员</div><p className="mt-0.5 text-caption text-subtle">输入飞书真实姓名；保存时解析为稳定的 open_id，不读取邮箱。</p></div><div className="flex shrink-0 rounded-md bg-muted p-0.5"><button type="button" onClick={() => setRestrictUsers(false)} className={`min-h-10 rounded-sm px-2 text-caption font-medium ${!restrictUsers ? 'bg-surface text-primary shadow-card' : 'text-subtle'}`}>所有人</button><button type="button" onClick={() => setRestrictUsers(true)} className={`min-h-10 rounded-sm px-2 text-caption font-medium ${restrictUsers ? 'bg-surface text-primary shadow-card' : 'text-subtle'}`}>指定成员</button></div></div>
            {restrictUsers && <div className="mt-3 space-y-2.5">
              {Boolean(current?.allowedEmails.length && !current.allowedUsers.length) && <Banner tone="warning">检测到旧邮箱白名单。请重新填写真实姓名；保存后将迁移为 open_id 白名单并停止查询通讯录。</Banner>}
              <div><div className="text-caption font-medium text-subtle">成员真实姓名</div><MemberNameTagInput value={allowedUserNames} onChange={setAllowedUserNames} placeholder="输入姓名后按 Enter"/><p className="mt-1 text-caption text-subtle">支持 Enter、逗号或粘贴多行生成标签。保存时精确匹配；找不到或不同用户同名时不会保存。</p></div>
            </div>}
          </div>
          <div className="border-t border-subtle pt-3.5">
            <div className="flex items-start justify-between gap-3"><div><div className="text-caption font-medium text-secondary">可调用机器人的其他机器人</div><p className="mt-0.5 text-caption text-subtle">输入机器人名称；保存时在群成员中解析为 open_id。已配置的群协作 peer 机器人默认放行，无需填写。</p></div></div>
            <div className="mt-3 space-y-2.5">
              <div><div className="text-caption font-medium text-subtle">机器人名称</div><MemberNameTagInput value={allowedBotNames} onChange={setAllowedBotNames} placeholder="输入机器人名称后按 Enter"/><p className="mt-1 text-caption text-subtle">留空则仅允许 peer 机器人（如下方开关开启）。</p></div>
              <div className="flex items-center rounded-md bg-surface px-3 py-2 shadow-card"><div className="min-w-0"><label htmlFor="lark-switch-peer-bots" className="cursor-pointer text-caption font-medium text-primary">群协作 peer 机器人默认放行</label><div className="mt-0.5 text-caption text-subtle">开启后，已配置的群协作 peer 机器人无需加入上方名单即可调用；关闭后仅上方名单内的机器人可调用。</div></div><Switch id="lark-switch-peer-bots" label="群协作 peer 机器人默认放行" checked={peerBotsAllowed} onToggle={() => setPeerBotsAllowed(value => !value)}/></div>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="飞书推送间隔" hint="500-20000 ms"><Input type="number" min={500} max={20000} step={100} value={pushIntervalMs} onChange={event => setPushIntervalMs(Number(event.target.value))} className="font-mono"/></Field>
            <Field label="Trace 阶段上限" hint="默认 50；心跳渲染时最多保留最近 N 个执行阶段，超过飞书 24KB / 180 组件限制时仍会自动裁剪较早记录。"><Input type="number" min={1} max={200} step={1} value={traceLimit} onChange={event => setTraceLimit(event.target.value)} className="font-mono"/></Field>
          </div></div></details>
          </fieldset>
          </> : <>
          <div><span className="text-caption font-medium text-secondary">默认 Agent</span><AgentSelect agents={agents} value={defaultAgentId} onChange={value => { setDefaultAgentId(value); setDefaultModel(''); setDefaultReasoningEffort(''); }}/></div>
          <Field label="操作确认方式" hint="飞书逐项确认支持 ACP Agent；修改后在会话空闲时应用，新操作仍受群权限与高危策略约束。"><CompactSelect options={[{ value: 'full-trust', label: '完全信任：自动执行操作' }, { value: 'ask', label: '飞书逐项确认：等待批准后执行' }]} value={permissionMode} placeholder="选择操作确认方式" disabledText="" onChange={value => setPermissionMode(value as 'ask' | 'full-trust')}/></Field>
          {permissionMode === 'ask' && agentOptions.data?.source !== 'acp' && <p className="text-caption text-warning">当前 Agent 尚未确认支持 ACP，请选择支持 ACP 的 Agent 后保存。</p>}
          {permissionMode === 'full-trust' && <label className="flex items-start gap-2.5 rounded-md border border-warning-border bg-warning-soft px-3 py-2.5"><input type="checkbox" checked={fullTrustConfirmed} onChange={event => setFullTrustConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 rounded-sm border-warning-solid"/><span><span className="block text-caption font-semibold text-warning">确认飞书任务以 full-trust 运行</span><span className="mt-0.5 block text-caption text-warning">无人值守 Agent 可执行本机命令和修改文件；取消确认后不能保存完全信任配置；也可以切换为飞书逐项确认。</span></span></label>}
          <div className={`flex items-center rounded-md bg-surface px-3 py-2.5 shadow-card ${config.data?.listeningDisabled ? 'opacity-50' : ''}`}><div className="min-w-0"><label htmlFor="lark-switch-listening" className="cursor-pointer text-body font-medium text-primary">监听飞书消息</label><div className="mt-0.5 text-caption text-subtle">{config.data?.listeningDisabled ? '本次启动已通过 --no-lark-listen 禁用，保存值不受影响' : !listening ? '保持关闭，仅保存机器人配置' : current?.activeListening ? '监听已启动，可到飞书发送消息' : '完成配置后立即接收机器人消息'}</div></div><Switch id="lark-switch-listening" label="监听飞书消息" checked={listening} disabled={config.data?.listeningDisabled} onToggle={() => setListening(value => !value)}/></div>
          {!agentOptions.data && (agentOptions.isLoading || agentOptions.isFetching) ? <div className="flex min-h-10 items-center rounded-md bg-muted px-2.5"><Spinner label="正在读取 Agent 配置"/></div> : <>
            {agentOptions.data?.source === 'acp' && agentOptions.data.models.length > 0 && <div><span className="text-caption font-medium text-secondary">默认模型</span><CompactSelect options={[{ value: '', label: agentOptions.data.defaultModel ? `Agent 默认 (${agentOptions.data.defaultModel})` : '使用 Agent 默认模型' }, ...agentOptions.data.models.map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))]} value={defaultModel} placeholder="选择默认模型" disabledText="" onChange={value => { setDefaultModel(value); setDefaultReasoningEffort(''); }}/></div>}
            {agentOptions.data?.source === 'acp' && agentOptions.data.reasoningEfforts.length > 0 && <div><span className="text-caption font-medium text-secondary">推理强度</span><CompactSelect options={[{ value: '', label: agentOptions.data.defaultReasoningEffort ? `Agent 默认 (${agentOptions.data.defaultReasoningEffort})` : '使用 Agent 默认强度' }, ...agentOptions.data.reasoningEfforts.map(item => ({ value: item.id, label: item.name }))]} value={defaultReasoningEffort} placeholder="选择推理强度" disabledText="" onChange={setDefaultReasoningEffort}/></div>}
          </>}
          <Field label="预注入 Prompt（可选，默认空）" hint="每轮飞书对话都会在用户请求前隐式注入，不会在 Agent 聊天记录中重复显示为用户消息。">
            <Textarea value={preInjectPrompt} onChange={event => setPreInjectPrompt(event.target.value)} rows={3} placeholder="例如：请始终使用中文回答，并优先给出结论。" className="resize-y"/>
          </Field>
          <div className="rounded-md bg-surface px-3 py-2.5 shadow-card"><div className="flex items-center"><div className="min-w-0"><label htmlFor="lark-switch-group-tools" className="cursor-pointer text-body font-medium text-primary">启用 Agent 群协作工具</label><div className="mt-0.5 text-caption text-subtle">允许 Agent 在当前飞书群发现其他已配置 Agent，并读取增量消息</div></div><Switch id="lark-switch-group-tools" label="启用 Agent 群协作工具" checked={groupToolsEnabled} onToggle={() => setGroupToolsEnabled(value => !value)}/></div>{groupToolsEnabled && <div className="mt-3 flex items-center border-t border-subtle pt-3"><div className="min-w-0"><label htmlFor="lark-switch-group-send" className="cursor-pointer text-caption font-medium text-primary">允许 Agent 发消息与 @交接</label><div className="mt-0.5 text-caption text-subtle">关闭后仅保留 self、peers、messages 和 wait 只读能力</div></div><Switch id="lark-switch-group-send" label="允许 Agent 发消息与 @交接" checked={groupToolsAllowSend} onToggle={() => setGroupToolsAllowSend(value => !value)}/></div>}<p className="mt-2 text-caption text-subtle">缺少群成员、消息或发消息权限时，Agent 会停止对应操作并给出管理员授权链接；不会索要 App Secret。</p></div>
          <div className="rounded-md bg-surface px-3 py-2.5 shadow-card"><div className="flex items-center"><div className="min-w-0"><label htmlFor="lark-switch-memory" className="cursor-pointer text-body font-medium text-primary">启用会话记忆</label><div className="mt-0.5 text-caption text-subtle">每个聊天保留跨会话的长期记忆，并在每轮任务前注入索引</div></div><Switch id="lark-switch-memory" label="启用会话记忆" checked={memoryEnabled} onToggle={() => setMemoryEnabled(value => !value)}/></div>{memoryEnabled && <><div className="mt-3 flex items-center border-t border-subtle pt-3"><div className="min-w-0"><label htmlFor="lark-switch-memory-auto" className="cursor-pointer text-caption font-medium text-primary">自动提取与整理</label><div className="mt-0.5 text-caption text-subtle">关闭后只能用 /memory consolidate 手动触发</div></div><Switch id="lark-switch-memory-auto" label="自动提取与整理" checked={memoryAutoExtract} onToggle={() => setMemoryAutoExtract(value => !value)}/></div><div className="mt-3"><Field label="整理 Agent" hint="留空则沿用机器人默认 Agent。"><CompactSelect options={[{ value: '', label: '沿用机器人默认 Agent' }, ...agents.map(agent => ({ value: agent.id, label: agent.name }))]} value={memoryAgentId} placeholder="选择整理 Agent" disabledText="" onChange={setMemoryAgentId}/></Field></div><div className="mt-3"><Field label="整理模型" hint="留空则沿用默认模型。"><Input value={memoryModel} onChange={event => setMemoryModel(event.target.value)} placeholder="可选，例如 gpt-4o-mini"/></Field></div></>}<p className="mt-2 text-caption text-subtle">记忆按聊天隔离，仅作为参考内容注入，不授予操作权限。</p></div>
          <div className="rounded-md bg-surface px-3 py-2.5 shadow-card">
            <Field label="风险控制" hint="关闭：不附加限制；约束提示：向 Agent 注入高危操作约束；强制拦截：同时由 Agent Hook 拦截高危工具调用。">
              {/* 可访问名必须逐字保持「风险控制」：测试用 getByRole('combobox', { name: '风险控制' }) 定位。 */}
              <Select aria-label="风险控制" value={riskControlMode} onChange={event => setRiskControlMode(event.target.value as RiskControlMode)}><option value="off">关闭</option><option value="guidance">约束提示</option><option value="enforced">强制拦截</option></Select>
            </Field>
          </div>
          {riskControlMode !== 'off' && <div className="rounded-lg bg-muted p-3"><div className="text-body font-semibold text-primary">高危操作规则</div><p className="mt-1 text-caption text-subtle">{riskControlMode === 'enforced' ? '未在允许名单内的发送人会收到约束提示，并由当前 Agent 的 Hook 强制拦截匹配操作。' : '未在允许名单内的发送人会收到隐式约束提示；此模式不安装或启用工具调用拦截。'}</p>
            <div className="mt-3"><div className="text-caption font-medium text-secondary">允许执行高危操作的成员 <span className="font-normal text-subtle">留空则继承普通成员名单</span></div><p className="mt-0.5 text-caption text-subtle">输入真实姓名，保存时解析为 open_id。</p>
              {legacyHighRiskNeedsMigration && <div className="mt-2"><Banner tone="warning">检测到旧高危邮箱名单。请重新选择成员后再保存，避免意外扩大高危权限。</Banner></div>}
              <MemberNameTagInput value={highRiskAllowedUserNames} onChange={setHighRiskAllowedUserNames} placeholder="输入姓名后按 Enter"/>
            </div>
            {/*
              错误既走 Field 的 `error`，又保留 AlertTriangle 图标——两者不是二选一。

              只手写错误行时 Field 不知道有错，textarea 的 aria-describedby 是 null：
              读屏用户听得到「无效」（aria-invalid），却永远听不到**为什么**无效。
              而这里的原因恰恰是不可推测的——「正则语法错误」和「灾难性回溯」是两种
              完全不同的修法，猜不出来。所以 error 必须交给 Field 去建立关联。

              图标则改为纯装饰（aria-hidden）叠在 Field 的错误文本上：Field 已经用
              role=alert 播报了文字，图标再进可访问树只会让读屏多念一个无意义的图形。
              视觉锚点留给眼睛，语义关联留给读屏，各取所需。
            */}
            <div className="relative mt-3">
              <Field label="高危操作正则表达式" error={highRiskPatternValidation.valid ? undefined : highRiskPatternValidation.error}>
                <Textarea value={highRiskPattern} onChange={event => setHighRiskPattern(event.target.value)} rows={4} className={`resize-y font-mono ${highRiskPatternValidation.valid ? '' : 'border-danger-border focus:border-danger'}`}/>
              </Field>
              {!highRiskPatternValidation.valid && <AlertTriangle aria-hidden="true" size={11} className="pointer-events-none absolute bottom-1 left-0 text-danger"/>}
            </div>
            {riskControlMode === 'enforced' && <div className="mt-3 space-y-2 border-t border-default pt-3"><div className="text-caption font-medium text-primary">拦截 Hook</div><div className="mt-0.5 text-caption text-subtle">{hookStatus.isLoading || hookStatus.isFetching ? '正在检查当前 Agent…' : enforcedHookReady ? `已为 ${defaultAgentId} 配置，可启用强制拦截` : hookStatus.data?.reason ?? `当前 Agent ${defaultAgentId} 尚未配置可写 Hook`}</div>{hookStatus.isSuccess && !enforcedHookReady && <Button variant="secondary" fullWidth icon={<Wrench size={12}/>} disabled={!current || installHook.isPending || legacyHighRiskNeedsMigration || !workspace.trim() || !highRiskPatternValidation.valid || hookStatus.data?.supported === false} onClick={() => installHook.mutate()}>{installHook.isPending ? '正在配置拦截 Hook' : '配置拦截 Hook'}</Button>}{hookStatus.data?.supported === false && <Banner tone="warning">{hookStatus.data.reason}</Banner>}{hookStatus.data?.trustInstructions && <Banner tone="info">{hookStatus.data.trustInstructions}</Banner>}</div>}
          </div>}
          </>}
        </>}
        {formError && <Banner tone="danger">{formError.message}{permissionRelatedError && permissionSettingsUrl && <a href={permissionSettingsUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-10 items-center gap-1 font-medium text-danger underline decoration-danger-border underline-offset-2 hover:text-danger-solid">打开当前机器人的权限配置<ExternalLink size={11}/></a>}</Banner>}
      </Dialog.Body>
      {/*
        「删除配置」用 ghost + 危险文字色，不用 variant="danger" 的实心底：它待在
        次要位置，实心红会把视觉重量压过右侧真正的主操作（下一步 / 完成配置）。
      */}
      <Dialog.Footer className="justify-start">{current ? <Button variant="ghost" icon={<Trash2 size={13}/>} className="text-danger hover:bg-danger-soft hover:text-danger" onClick={() => { remove.reset(); setConfirmation('delete'); }}>删除配置</Button> : <span className="text-caption text-subtle">App ID 将作为唯一主键，不能重复配置</span>}{step === 2 && <span className="ml-auto"><Button variant="ghost" onClick={() => setStep(1)}>上一步</Button></span>}<span className={step === 2 ? '' : 'ml-auto'}><Button variant="ghost" onClick={requestClose}>{creationBusy ? '稍后查看' : step === 2 && current && !current.setupComplete ? '稍后完成' : '取消'}</Button></span><Button type="submit" variant="secondary" tone="inverse" className="min-w-20" disabled={!canSave || save.isPending}>{save.isPending ? (step === 1 ? '验证中' : '保存中') : agentCapabilitiesPending ? '读取模型中' : step === 1 ? '下一步' : '完成配置'}</Button></Dialog.Footer>
    </form>
  </Dialog>
  <ConfirmDialog
    open={Boolean(confirmation)}
    tone={confirmation === 'delete' ? 'danger' : 'warning'}
    title={confirmation === 'delete' ? '删除机器人配置？' : confirmation === 'incomplete' ? '稍后再完成配置？' : '放弃未保存的配置？'}
    description={confirmation === 'delete' ? `将删除“${current?.name ?? '当前机器人'}”的凭证、监听和风险控制配置。已有任务记录不会删除。` : confirmation === 'incomplete' ? 'Agent 配置尚未完成。若已开启监听，机器人仍会接收消息，并提示发送人补充运行配置。' : '当前填写的机器人信息尚未保存，关闭后需要重新填写。'}
    confirmLabel={confirmation === 'delete' ? '确认删除' : confirmation === 'incomplete' ? '稍后完成' : '放弃修改'}
    busy={confirmation === 'delete' && remove.isPending}
    error={confirmation === 'delete' && remove.error ? remove.error.message : undefined}
    onCancel={() => { if (!remove.isPending) setConfirmation(undefined); }}
    onConfirm={() => { if (confirmation === 'delete') remove.mutate(); else { setConfirmation(undefined); onClose(); } }}
  />
  </>;
}
