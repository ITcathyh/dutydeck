import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, ArrowDown, BookOpen, Bot, BrainCircuit, Check, ChevronDown, ChevronRight, CircleStop, CircleX, CornerDownRight, Database, ExternalLink, Eye, EyeOff, FilePenLine, FlaskConical, Folder, FolderOpen, GitBranch, Globe2, ListEnd, LoaderCircle, Menu, MessageSquare, PanelRightClose, Plus, RefreshCw, Search, Send, Settings2, Square, Terminal, Trash2, Users, Wrench, X, Zap } from 'lucide-react';
import { validateHighRiskPattern } from '@dockmux/shared';
import { api, type Agent, type DockEvent, type Session, type Task } from './api';
import { canSaveHardGate, canToggleHardGate } from './lark-config-form';
import { useDockStore } from './store';
import { buildTimeline, buildTimelineSections, type TimelineActivityGroup, type TimelineEvent } from './timeline';
import { MarkdownContent } from './MarkdownContent';
import { Composer } from './Composer';
import { buildPrompt, commandsFromEvents, contextStatsFromEvents, getModelReadiness, type ComposerReference } from './composer-utils';
import { useTimelineAutoScroll } from './useTimelineAutoScroll';
import { elapsedMilliseconds, formatElapsed, groupToolActivityRows, toolActionLabel, toolDescription, toolPresentation, type ToolKind } from './tool-presentation';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';

const stateLabels: Record<string, string> = {
  created: '已创建', starting: '启动中', idle: '就绪', thinking: '思考中', running_tool: '正在调用工具', waiting_for_permission: '等待授权', interrupting: '正在取消', interrupted: '已取消', completed: '已完成', failed: '失败', stopped: '已停止'
};
const stateTone: Record<string, string> = { starting: 'bg-amber-500', thinking: 'bg-amber-500', running_tool: 'bg-blue-500', waiting_for_permission: 'bg-orange-500', failed: 'bg-red-500', stopped: 'bg-zinc-400', interrupted: 'bg-zinc-500', completed: 'bg-emerald-500', idle: 'bg-emerald-500' };
const busyStates = new Set(['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting']);
const parseMemberNames = (value: string) => [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))];

function DockmuxIcon({ className = '' }: { className?: string }) {
  return <img src="/dockmux.svg" alt="" aria-hidden="true" className={className}/>;
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 transition-[color,background-color,transform] duration-200 hover:bg-zinc-100 hover:text-zinc-900 active:scale-[.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 disabled:pointer-events-none disabled:opacity-30">{children}</button>;
}

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'danger' | 'warning';
  busy?: boolean;
  error?: string;
  onConfirm(): void;
  onCancel(): void;
};

function ConfirmDialog({ open, title, description, confirmLabel, tone = 'warning', busy = false, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = requestAnimationFrame(() => cancelRef.current?.focus());
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [open, busy, onCancel]);
  if (!open) return null;
  const danger = tone === 'danger';
  return <div className="ui-overlay fixed inset-0 z-50 grid place-items-center bg-zinc-950/35 p-4 backdrop-blur-[3px]" onMouseDown={event => { if (!busy && event.currentTarget === event.target) onCancel(); }}>
    <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" className="ui-dialog w-full max-w-[420px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_28px_90px_rgba(24,24,27,.24)]">
      <div className="flex gap-3.5 px-5 pb-4 pt-5">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${danger ? 'bg-red-50 text-red-600 ring-1 ring-red-100' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-100'}`}><AlertTriangle size={19} strokeWidth={1.8}/></div>
        <div className="min-w-0 pt-0.5"><h2 id="confirm-dialog-title" className="text-[15px] font-semibold tracking-[-.01em] text-zinc-900">{title}</h2><p id="confirm-dialog-description" className="mt-1.5 text-[12px] leading-5 text-zinc-500">{description}</p></div>
      </div>
      {error && <div className="mx-5 mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-700">{error}</div>}
      <div className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50/70 px-5 py-3.5">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="h-9 rounded-lg border border-zinc-300 bg-white px-3.5 text-[12px] font-medium text-zinc-700 shadow-sm transition-[background-color,border-color,transform] hover:border-zinc-400 hover:bg-zinc-50 active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40 disabled:cursor-not-allowed disabled:opacity-45">取消</button>
        <button type="button" disabled={busy} onClick={onConfirm} className={`flex h-9 min-w-24 items-center justify-center rounded-lg px-3.5 text-[12px] font-medium text-white shadow-sm transition-[background-color,transform] active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45 ${danger ? 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-400/50' : 'bg-zinc-900 hover:bg-zinc-700 focus-visible:ring-zinc-400/50'}`}>{busy ? <><RefreshCw size={12} className="mr-1.5 animate-spin"/>处理中</> : confirmLabel}</button>
      </div>
    </div>
  </div>;
}

type CompactOption = { value: string; label: string; meta?: string };
function CompactSelect({ options, value, placeholder, disabledText, disabled = false, onChange }: { options: CompactOption[]; value: string; placeholder: string; disabledText: string; disabled?: boolean; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div ref={root} className="relative mt-1.5">
    <button type="button" disabled={disabled || !options.length} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex h-9 w-full items-center rounded-md border border-zinc-300 bg-white px-2.5 text-left text-[13px] outline-none hover:border-zinc-400 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400">
      <span className="min-w-0 flex-1 truncate">{selected?.label ?? (options.length ? placeholder : disabledText)}</span>
      {selected?.meta && <span className="ml-3 max-w-[48%] truncate font-mono text-[10px] text-zinc-400">{selected.meta}</span>}
      <ChevronDown size={13} className={`ml-2 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}/>
    </button>
    {open && <div role="listbox" className="ui-popover absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-44 overscroll-contain overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-[0_12px_32px_rgba(24,24,27,.12)] [transform:translateZ(0)]">
      {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }} className="flex min-h-8 w-full items-center rounded-md px-2 text-left text-[12px] text-zinc-700 transition-colors hover:bg-zinc-100">
        <span className="w-5 shrink-0 text-zinc-800">{option.value === value && <Check size={12}/>}</span><span className="min-w-0 flex-1 truncate">{option.label}</span>{option.meta && <span className="ml-3 max-w-[55%] truncate font-mono text-[10px] text-zinc-400">{option.meta}</span>}
      </button>)}
    </div>}
  </div>;
}

function AgentSelect({ agents, value, disabled, onChange }: { agents: Agent[]; value: string; disabled?: boolean; onChange(value: string): void }) {
  return <CompactSelect options={agents.map(agent => ({ value: agent.id, label: agent.name, meta: agent.version }))} value={value} placeholder="选择 Agent" disabledText="未扫描到可用 Agent" disabled={disabled} onChange={onChange}/>;
}

function MemberNameTagInput({ value, placeholder, onChange }: { value: string[]; placeholder: string; onChange(value: string[]): void }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (raw = draft) => {
    const additions = parseMemberNames(raw);
    if (additions.length) onChange([...new Set([...value, ...additions])]);
    setDraft('');
  };
  const remove = (name: string) => onChange(value.filter(item => item !== name));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') { event.preventDefault(); commit(); }
    else if (event.key === 'Backspace' && !draft && value.length) remove(value[value.length - 1]!);
  };
  return <div role="group" aria-label="成员真实姓名" onClick={() => inputRef.current?.focus()} className="mt-2 flex min-h-11 cursor-text flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border border-zinc-300 bg-zinc-50/70 p-2 transition-[border-color,box-shadow,background-color] focus-within:border-zinc-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-zinc-200/80">
    {value.map(item => <span key={item} title={item} className="flex h-7 max-w-full items-center rounded-md border border-zinc-200 bg-white pl-2.5 pr-1 text-[11px] font-medium text-zinc-700 shadow-[0_1px_1px_rgba(24,24,27,.04)]">
      <span className="min-w-0 truncate">{item}</span>
      <button type="button" aria-label={`移除 ${item}`} onPointerDown={event => event.preventDefault()} onClick={() => remove(item)} className="ml-1.5 grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"><X size={11}/></button>
    </span>)}
    <input ref={inputRef} aria-label="输入成员真实姓名" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} onBlur={() => commit()} onPaste={event => { const text = event.clipboardData.getData('text'); if (/[\n,，]/.test(text)) { event.preventDefault(); commit(`${draft}\n${text}`); } }} placeholder={value.length ? '继续添加成员…' : placeholder} className="h-7 min-w-36 flex-[1_0_9rem] border-0 bg-transparent px-1 text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400"/>
  </div>;
}

function LarkConfigModal({ agents, onClose }: { agents: Agent[]; onClose(): void }) {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig });
  const capabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });
  const [confirmation, setConfirmation] = useState<'incomplete' | 'discard' | 'delete'>();
  const hydratedSelection = useRef<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null); const [step, setStep] = useState<1 | 2>(1); const [name, setName] = useState(''); const [workspace, setWorkspace] = useState(''); const [webBaseUrl, setWebBaseUrl] = useState(typeof window !== 'undefined' ? window.location.origin : ''); const [appId, setAppId] = useState(''); const [appSecret, setAppSecret] = useState(''); const [restrictUsers, setRestrictUsers] = useState(false); const [allowedUserNames, setAllowedUserNames] = useState<string[]>([]); const [allowedBotNames, setAllowedBotNames] = useState<string[]>([]); const [peerBotsAllowed, setPeerBotsAllowed] = useState(true); const [defaultAgentId, setDefaultAgentId] = useState(''); const [defaultModel, setDefaultModel] = useState(''); const [defaultReasoningEffort, setDefaultReasoningEffort] = useState(''); const [preInjectPrompt, setPreInjectPrompt] = useState(''); const [groupToolsEnabled, setGroupToolsEnabled] = useState(false); const [groupToolsAllowSend, setGroupToolsAllowSend] = useState(false); const [highRiskAllowedUserNames, setHighRiskAllowedUserNames] = useState<string[]>([]); const [highRiskPattern, setHighRiskPattern] = useState(''); const [gateEnabled, setGateEnabled] = useState(false); const [softGateEnabled, setSoftGateEnabled] = useState(false); const [hardGateEnabled, setHardGateEnabled] = useState(false); const [hookTrustConfirmed, setHookTrustConfirmed] = useState(false); const [showSecret, setShowSecret] = useState(false); const [listening, setListening] = useState(false); const [pushIntervalMs, setPushIntervalMs] = useState(1000); const [traceLimit, setTraceLimit] = useState('50');
  const current = config.data?.bots.find(bot => bot.appId === selectedAppId);
  const agentSelectionSaved = Boolean(current?.setupComplete && current.defaultAgentId === defaultAgentId);
  const defaultAgentLocked = Boolean(hardGateEnabled || current?.hardGateEnabled);
  const highRiskPatternValidation = useMemo(() => validateHighRiskPattern(highRiskPattern), [highRiskPattern]);
  const hookStatus = useQuery({ queryKey: ['lark-hook-status', current?.appId, defaultAgentId], queryFn: () => api.larkHookStatus(current!.appId), enabled: Boolean(agentSelectionSaved && gateEnabled && step === 2) });
  const agentOptions = useQuery({ queryKey: agentModelsQueryKey(defaultAgentId, defaultModel), queryFn: () => loadAgentModels(defaultAgentId, defaultModel || undefined), enabled: Boolean(defaultAgentId), initialData: () => readCachedAgentModels(defaultAgentId, defaultModel || undefined), initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 5 * 60_000 });
  const hardGateFormState = { enabled: hardGateEnabled, persisted: Boolean(current?.hardGateEnabled), agentSelectionSaved, hookInstalled: Boolean(hookStatus.data?.installed) };
  const hardGateReadyToSave = canSaveHardGate(hardGateFormState);
  const hardGateCanToggle = canToggleHardGate(hardGateFormState);
  const hardGateHookMissing = Boolean(hardGateEnabled && current?.hardGateEnabled && hookStatus.isSuccess && !hookStatus.data.installed);
  const legacyHighRiskNeedsMigration = Boolean(gateEnabled && current?.highRiskAllowedEmails.length && !highRiskAllowedUserNames.length);
  useEffect(() => {
    if (!agentOptions.data || agentOptions.isFetching || !defaultReasoningEffort) return;
    if (!agentOptions.data.reasoningEfforts.some(option => option.id === defaultReasoningEffort)) setDefaultReasoningEffort('');
  }, [agentOptions.data, agentOptions.isFetching, defaultReasoningEffort]);
  useEffect(() => {
    if (!config.data || selectedAppId !== null) return;
    const firstBot = config.data.bots[0];
    setSelectedAppId(firstBot?.appId ?? '');
    setStep(firstBot && !firstBot.setupComplete ? 2 : 1);
  }, [config.data, selectedAppId]);
  useEffect(() => {
    if (!config.data || selectedAppId === null) return;
    if (hydratedSelection.current === selectedAppId) return;
    hydratedSelection.current = selectedAppId;
    const bot = config.data.bots.find(item => item.appId === selectedAppId);
    setName(bot?.name ?? ''); setWorkspace(bot?.workspace ?? ''); setWebBaseUrl(bot?.webBaseUrl ?? (typeof window !== 'undefined' ? window.location.origin : '')); setAppId(bot?.appId ?? ''); setAppSecret(''); setRestrictUsers(Boolean(bot?.allowedUsers.length || bot?.allowedEmails.length)); setAllowedUserNames((bot?.allowedUsers ?? []).map(user => user.name)); setAllowedBotNames((bot?.allowedBots ?? []).map(b => b.name)); setPeerBotsAllowed(bot?.peerBotsAllowed !== false);
    setDefaultAgentId(agents.some(agent => agent.id === bot?.defaultAgentId) ? bot?.defaultAgentId ?? '' : agents[0]?.id ?? '');
    setDefaultModel(bot?.defaultModel ?? ''); setDefaultReasoningEffort(bot?.defaultReasoningEffort ?? ''); setListening(bot?.listening ?? false); setPushIntervalMs(bot?.pushIntervalMs ?? 1000); setTraceLimit((bot?.traceLimit ?? 10).toString());
    setPreInjectPrompt(bot?.preInjectPrompt ?? ''); setGroupToolsEnabled(bot?.groupToolsEnabled ?? false); setGroupToolsAllowSend(bot?.groupToolsAllowSend ?? false); setHighRiskAllowedUserNames((bot?.highRiskAllowedUsers ?? []).map(user => user.name)); setHighRiskPattern(bot?.highRiskPattern ?? ''); setGateEnabled(bot?.gateEnabled ?? false); setSoftGateEnabled(bot?.gateEnabled ?? false); setHardGateEnabled(bot?.hardGateEnabled ?? false); setHookTrustConfirmed(bot?.hookTrustConfirmed ?? false);
  }, [config.data, agents, selectedAppId]);
  const inspect = useMutation({ mutationFn: () => api.inspectLarkBot({ appId: appId.trim(), appSecret: appSecret.trim() }), onSuccess: result => setName(result.appName) });
  const save = useMutation({
    mutationFn: () => step === 1
      ? api.saveLarkConfig({ stage: 'lark', ...(current ? { originalAppId: current.appId } : {}), appId: appId.trim(), ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}), workspace: workspace.trim(), webBaseUrl: webBaseUrl.trim(), allowedUserNames: restrictUsers ? allowedUserNames : [], allowedEmails: [], allowedBotNames, peerBotsAllowed, listening, pushIntervalMs, traceLimit: Number(traceLimit) })
      : api.saveLarkConfig({ stage: 'agent', originalAppId: current!.appId, defaultAgentId, defaultModel, defaultReasoningEffort, preInjectPrompt, groupToolsEnabled, groupToolsAllowSend, highRiskAllowedUserNames, highRiskAllowedEmails: [], highRiskPattern, gateEnabled, softGateEnabled: gateEnabled, hardGateEnabled, hookTrustConfirmed }),
    onSuccess: data => { qc.setQueryData(['lark-config'], data); const savedId = appId.trim(); setSelectedAppId(savedId); setAppSecret(''); void qc.invalidateQueries({ queryKey: ['lark-hook-status', savedId] }); if (step === 1) setStep(2); else onClose(); }
  });
  const installHook = useMutation({
    mutationFn: async () => {
      const saved = await api.saveLarkConfig({ stage: 'agent', originalAppId: current!.appId, defaultAgentId, defaultModel, defaultReasoningEffort, preInjectPrompt, listening, groupToolsEnabled, groupToolsAllowSend, highRiskAllowedUserNames, highRiskAllowedEmails: [], highRiskPattern, gateEnabled: true, softGateEnabled: true, hardGateEnabled: false, hookTrustConfirmed: false });
      qc.setQueryData(['lark-config'], saved);
      return api.installLarkHook(current!.appId, highRiskPattern);
    },
    onSuccess: result => { qc.setQueryData(['lark-hook-status', current!.appId, defaultAgentId], result); setGateEnabled(true); setSoftGateEnabled(true); setHardGateEnabled(false); setHookTrustConfirmed(true); void qc.invalidateQueries({ queryKey: ['lark-config'] }); }
  });
  const remove = useMutation({ mutationFn: () => api.deleteLarkConfig(current!.appId), onSuccess: data => { qc.setQueryData(['lark-config'], data); const firstBot = data.bots[0]; setSelectedAppId(firstBot?.appId ?? ''); setStep(firstBot && !firstBot.setupComplete ? 2 : 1); setConfirmation(undefined); } });
  const pickWorkspace = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => setWorkspace(result.path) });
  const agentCapabilitiesPending = step === 2 && Boolean(defaultAgentId) && !agentOptions.data && (agentOptions.isLoading || agentOptions.isFetching);
  const agentCapabilitiesReady = step !== 2 || Boolean(agentOptions.data);
  const canSave = step === 1
    ? Boolean(appId.trim() && (current || appSecret.trim()) && (!restrictUsers || allowedUserNames.length) && Number.isInteger(pushIntervalMs) && pushIntervalMs >= 500 && pushIntervalMs <= 20000)
    : Boolean(current && defaultAgentId && agentCapabilitiesReady && (!gateEnabled || highRiskPatternValidation.valid) && !legacyHighRiskNeedsMigration && hardGateReadyToSave);
  const larkCredentialsReady = Boolean(current || (appId.trim() && appSecret.trim()));
  const formError = save.error ?? remove.error ?? pickWorkspace.error ?? inspect.error ?? installHook.error ?? (agentOptions.data ? undefined : agentOptions.error) ?? config.error;
  const permissionSettingsUrl = /^cli_[\w-]+$/.test(appId.trim()) ? `https://open.larkoffice.com/app/${encodeURIComponent(appId.trim())}/auth` : undefined;
  const permissionRelatedError = Boolean(formError && /权限|permission|通讯录|邮箱|open[_ ]?id|资源点|visible range/i.test(formError.message));
  const requestClose = () => {
    const incompleteDraft = Boolean(current && !current.setupComplete);
    const unsavedNewBot = !current && selectedAppId === '' && Boolean(appId.trim() || appSecret.trim() || workspace.trim());
    if (incompleteDraft || unsavedNewBot) { setConfirmation(incompleteDraft ? 'incomplete' : 'discard'); return; }
    onClose();
  };
  const inputClass = 'mt-1.5 h-9 w-full rounded-md border border-zinc-300 px-2.5 font-mono text-[12px] outline-none placeholder:text-zinc-400 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-200';
  return <><div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-zinc-950/25 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) requestClose(); }}>
    <form onSubmit={event => { event.preventDefault(); if (canSave) save.mutate(); }} className="ui-dialog flex max-h-[calc(100dvh-2rem)] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-[0_20px_64px_rgba(24,24,27,.18)]">
      <div className="flex items-center border-b border-zinc-100 px-4 py-3"><div className="min-w-0"><h2 className="text-[14px] font-semibold text-zinc-900">飞书机器人</h2><p className="mt-0.5 truncate text-[11px] text-zinc-500">每个机器人拥有独立工作区和会话</p></div><div className="ml-auto flex shrink-0 items-center gap-0.5"><a href="https://open.larkoffice.com/app" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50">飞书开发者后台<ExternalLink size={12}/></a><a href="https://open.larkoffice.com/page/launcher?from=backend_oneclick" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50">快速创建机器人<ExternalLink size={12}/></a></div><span className="ml-1"><IconButton label="关闭" onClick={requestClose}><X size={15}/></IconButton></span></div>
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-100 bg-zinc-50/70 px-3 py-2">
        {config.data?.bots.map(bot => <button key={bot.appId} type="button" onClick={() => { setSelectedAppId(bot.appId); setStep(bot.setupComplete ? 1 : 2); }} className={`flex h-8 max-w-[250px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium transition-colors ${selectedAppId === bot.appId ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-500 hover:bg-white/70 hover:text-zinc-800'}`}><Bot size={13} className="shrink-0"/><span title={bot.name} className="min-w-0 max-w-32 truncate">{bot.tabLabel}</span>{bot.setupComplete ? <span title="配置完成" className="flex shrink-0 items-center gap-0.5 rounded bg-emerald-50 px-1 py-0.5 text-[9px] font-medium text-emerald-700"><Check size={9}/>已配置</span> : <span className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[9px] text-amber-700">待配置</span>}{bot.activeListening && <span title="长连接已连接" className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"/>}</button>)}
        <button type="button" onClick={() => { setSelectedAppId(''); setStep(1); }} className={`flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[11px] font-medium ${selectedAppId === '' ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-500 hover:bg-white/70 hover:text-zinc-800'}`}><Plus size={13}/>新增机器人</button>
      </div>
      <div className="space-y-3.5 overflow-y-auto px-4 py-4">
        {config.isLoading ? <div className="space-y-2.5"><div className="h-9 animate-pulse rounded-md bg-zinc-100"/><div className="h-9 animate-pulse rounded-md bg-zinc-100"/><div className="h-9 animate-pulse rounded-md bg-zinc-100"/></div> : <>
          <div className="mb-1 grid grid-cols-2 rounded-lg bg-zinc-100 p-1"><button type="button" onClick={() => setStep(1)} className={`rounded-md px-3 py-2 text-[11px] font-medium transition-colors ${step === 1 ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}><span className="mr-1.5 inline-grid h-4 w-4 place-items-center rounded-full bg-zinc-900 text-[9px] text-white">1</span>飞书与白名单</button><button type="button" disabled={!current} onClick={() => { if (step === 1 && canSave) save.mutate(); else if (step !== 2) setStep(2); }} className={`rounded-md px-3 py-2 text-[11px] font-medium transition-colors disabled:opacity-40 ${step === 2 ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}><span className="mr-1.5 inline-grid h-4 w-4 place-items-center rounded-full bg-zinc-900 text-[9px] text-white">2</span>Agent 与门禁</button></div>
          <p className="-mt-1 text-[10px] leading-4 text-zinc-400">{step === 1 ? '直接填写真实姓名；点击“下一步”时会在机器人所在群中精确解析为 open_id 并统一保存。' : 'Agent 配置不影响长连接；收到消息时才会校验运行配置。'}</p>
          {step === 1 ? <>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block"><span className="text-[11px] font-medium text-zinc-700">机器人名称</span><input value={name} readOnly placeholder="校验凭证后自动识别" className={`${inputClass} bg-zinc-50 text-zinc-500`}/></label><label className="block"><span className="text-[11px] font-medium text-zinc-700">App ID</span><input value={appId} onChange={event => { setAppId(event.target.value); setName(''); }} placeholder="cli_xxx" autoComplete="off" className={inputClass}/></label></div>
          <label className="block"><span className="flex items-center text-[11px] font-medium text-zinc-700">App Secret{current && <span className="ml-2 font-normal text-zinc-400">留空不修改</span>}</span><span className="relative mt-1.5 block"><input value={appSecret} onChange={event => setAppSecret(event.target.value)} type={showSecret ? 'text' : 'password'} placeholder={current ? '已保存' : '输入 App Secret'} autoComplete="new-password" className="h-9 w-full rounded-md border border-zinc-300 px-2.5 pr-9 font-mono text-[12px] outline-none placeholder:text-zinc-400 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-200"/><button type="button" onClick={() => setShowSecret(value => !value)} aria-label={showSecret ? '隐藏 Secret' : '显示 Secret'} className="absolute right-0.5 top-0.5 grid h-8 w-8 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">{showSecret ? <EyeOff size={13}/> : <Eye size={13}/>}</button></span></label>
          <label className="block"><span className="text-[11px] font-medium text-zinc-700">工作区</span><span className="mt-1.5 flex gap-2"><input value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="选择或输入绝对路径" className="h-9 min-w-0 flex-1 rounded-md border border-zinc-300 px-2.5 font-mono text-[12px] outline-none placeholder:text-zinc-400 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-200"/><button type="button" disabled={!capabilities.data?.directoryPicker || pickWorkspace.isPending} onClick={() => pickWorkspace.mutate()} className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"><FolderOpen size={13}/>{capabilities.data?.directoryPicker ? '选择' : '仅支持 Mac'}</button></span></label>
          <label className="block"><span className="text-[11px] font-medium text-zinc-700">Web 访问地址 <span className="font-normal text-zinc-400">可选</span></span><input value={webBaseUrl} onChange={event => setWebBaseUrl(event.target.value)} placeholder="https://dockmux.example.com" className={inputClass}/><p className="mt-1 text-[10px] leading-4 text-zinc-400">配置后，飞书卡片底部会显示“查看详情”链接，指向该域名下的会话 Trace 页面。</p></label>
          {!current && <button type="button" disabled={!appId.trim() || !appSecret.trim() || inspect.isPending} onClick={() => inspect.mutate()} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">{inspect.isPending ? <RefreshCw size={12} className="animate-spin"/> : <Bot size={12}/>}校验凭证并识别机器人名称</button>}
          <div className="border-t border-zinc-100 pt-3.5">
            <div className="flex items-start justify-between gap-3"><div><div className="text-[11px] font-medium text-zinc-700">可使用机器人的成员</div><p className="mt-0.5 text-[10px] leading-4 text-zinc-400">输入飞书真实姓名；保存时解析为稳定的 open_id，不读取邮箱。</p></div><div className="flex shrink-0 rounded-md bg-zinc-100 p-0.5"><button type="button" onClick={() => setRestrictUsers(false)} className={`h-7 rounded px-2 text-[10px] font-medium ${!restrictUsers ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}>所有人</button><button type="button" onClick={() => setRestrictUsers(true)} className={`h-7 rounded px-2 text-[10px] font-medium ${restrictUsers ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`}>指定成员</button></div></div>
            {restrictUsers && <div className="mt-3 space-y-2.5">
              {Boolean(current?.allowedEmails.length && !current.allowedUsers.length) && <div className="border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">检测到旧邮箱白名单。请重新填写真实姓名；保存后将迁移为 open_id 白名单并停止查询通讯录。</div>}
              <div><div className="text-[10px] font-medium text-zinc-500">成员真实姓名</div><MemberNameTagInput value={allowedUserNames} onChange={setAllowedUserNames} placeholder="输入姓名后按 Enter"/><p className="mt-1 text-[10px] leading-4 text-zinc-400">支持 Enter、逗号或粘贴多行生成标签。保存时精确匹配；找不到或不同用户同名时不会保存。</p></div>
            </div>}
          </div>
          <div className="border-t border-zinc-100 pt-3.5">
            <div className="flex items-start justify-between gap-3"><div><div className="text-[11px] font-medium text-zinc-700">可调用机器人的其他机器人</div><p className="mt-0.5 text-[10px] leading-4 text-zinc-400">输入机器人名称；保存时在群成员中解析为 open_id。已配置的群协作 peer 机器人默认放行，无需填写。</p></div></div>
            <div className="mt-3 space-y-2.5">
              <div><div className="text-[10px] font-medium text-zinc-500">机器人名称</div><MemberNameTagInput value={allowedBotNames} onChange={setAllowedBotNames} placeholder="输入机器人名称后按 Enter"/><p className="mt-1 text-[10px] leading-4 text-zinc-400">留空则仅允许 peer 机器人（如下方开关开启）。</p></div>
              <div className="flex items-center rounded-lg border border-zinc-200 bg-white px-3 py-2"><div className="min-w-0"><div className="text-[11px] font-medium text-zinc-800">群协作 peer 机器人默认放行</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">开启后，已配置的群协作 peer 机器人无需加入上方名单即可调用；关闭后仅上方名单内的机器人可调用。</div></div><button type="button" role="switch" aria-checked={peerBotsAllowed} onClick={() => setPeerBotsAllowed(value => !value)} className={`ml-auto flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${peerBotsAllowed ? 'bg-zinc-900' : 'bg-zinc-300'}`}><span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${peerBotsAllowed ? 'translate-x-4' : 'translate-x-0'}`}/></button></div>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block"><span className="flex items-center text-[11px] font-medium text-zinc-700">飞书推送间隔<span className="ml-2 font-normal text-zinc-400">500-20000 ms</span></span><input type="number" min={500} max={20000} step={100} value={pushIntervalMs} onChange={event => setPushIntervalMs(Number(event.target.value))} className={inputClass}/></label><label className="block"><span className="flex items-center text-[11px] font-medium text-zinc-700">Trace 阶段上限<span className="ml-2 font-normal text-zinc-400">默认 50</span></span><input type="number" min={1} max={200} step={1} value={traceLimit} onChange={event => setTraceLimit(event.target.value)} className={inputClass}/><p className="mt-1 text-[10px] leading-4 text-zinc-400">心跳渲染时最多保留最近 N 个执行阶段；超过飞书 24KB / 180 组件限制时仍会自动裁剪较早记录。</p></label></div>
          <div className="border-t border-zinc-100 pt-3.5">
            <div className={`flex items-center ${config.data?.listeningDisabled || !larkCredentialsReady ? 'opacity-50' : ''}`}><div className="min-w-0"><div className="text-[12px] font-medium text-zinc-800">监听飞书消息</div><div className="mt-0.5 text-[10px] text-zinc-400">{config.data?.listeningDisabled ? '本次启动已通过 --no-lark-listen 禁用，保存值不受影响' : !larkCredentialsReady ? '请先填写飞书凭证' : current?.activeListening ? '长连接已连接' : !current?.setupComplete ? '可先监听；收到消息时再校验 Agent 运行配置' : '使用长连接接收机器人消息'}</div></div><button type="button" role="switch" aria-checked={listening} disabled={config.data?.listeningDisabled || !larkCredentialsReady} onClick={() => setListening(value => !value)} className={`ml-auto flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed ${listening && !config.data?.listeningDisabled && larkCredentialsReady ? 'bg-zinc-900' : 'bg-zinc-300'}`}><span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${listening ? 'translate-x-4' : 'translate-x-0'}`}/></button></div>
          </div>
          </> : <>
          <div><span className="flex items-center text-[11px] font-medium text-zinc-700">默认 Agent{defaultAgentLocked && <span className="ml-2 font-normal text-zinc-400">硬门禁已开启，保存关闭后解锁</span>}</span><AgentSelect agents={agents} value={defaultAgentId} disabled={defaultAgentLocked} onChange={value => { setDefaultAgentId(value); setDefaultModel(''); setDefaultReasoningEffort(''); setHardGateEnabled(false); setHookTrustConfirmed(false); }}/></div>
          {!agentOptions.data && (agentOptions.isLoading || agentOptions.isFetching) ? <div className="flex h-9 items-center rounded-md bg-zinc-50 px-2.5 text-[11px] text-zinc-400"><RefreshCw size={12} className="mr-2 animate-spin"/>正在读取 Agent 配置</div> : <>
            {agentOptions.data?.source === 'acp' && agentOptions.data.models.length > 0 && <div><span className="text-[11px] font-medium text-zinc-700">默认模型</span><CompactSelect options={[{ value: '', label: agentOptions.data.defaultModel ? `Agent 默认 (${agentOptions.data.defaultModel})` : '使用 Agent 默认模型' }, ...agentOptions.data.models.map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))]} value={defaultModel} placeholder="选择默认模型" disabledText="" onChange={value => { setDefaultModel(value); setDefaultReasoningEffort(''); }}/></div>}
            {agentOptions.data?.source === 'acp' && agentOptions.data.reasoningEfforts.length > 0 && <div><span className="text-[11px] font-medium text-zinc-700">推理强度</span><CompactSelect options={[{ value: '', label: agentOptions.data.defaultReasoningEffort ? `Agent 默认 (${agentOptions.data.defaultReasoningEffort})` : '使用 Agent 默认强度' }, ...agentOptions.data.reasoningEfforts.map(item => ({ value: item.id, label: item.name }))]} value={defaultReasoningEffort} placeholder="选择推理强度" disabledText="" onChange={setDefaultReasoningEffort}/></div>}
          </>}
          <label className="block"><span className="text-[11px] font-medium text-zinc-700">预注入 Prompt <span className="font-normal text-zinc-400">可选，默认空</span></span><textarea value={preInjectPrompt} onChange={event => setPreInjectPrompt(event.target.value)} rows={3} placeholder="例如：请始终使用中文回答，并优先给出结论。" className="mt-1.5 w-full resize-y rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-[12px] leading-5 outline-none placeholder:text-zinc-400 focus:border-zinc-500"/><p className="mt-1 text-[10px] leading-4 text-zinc-400">每轮飞书对话都会在用户请求前隐式注入，不会在 Agent 聊天记录中重复显示为用户消息。</p></label>
          <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5"><div className="flex items-center"><div className="min-w-0"><div className="text-[12px] font-medium text-zinc-800">启用 Agent 群协作工具</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">允许 Agent 在当前飞书群发现其他已配置 Agent，并读取增量消息</div></div><button type="button" role="switch" aria-checked={groupToolsEnabled} onClick={() => setGroupToolsEnabled(value => !value)} className={`ml-auto flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${groupToolsEnabled ? 'bg-zinc-900' : 'bg-zinc-300'}`}><span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${groupToolsEnabled ? 'translate-x-4' : 'translate-x-0'}`}/></button></div>{groupToolsEnabled && <div className="mt-3 flex items-center border-t border-zinc-100 pt-3"><div className="min-w-0"><div className="text-[11px] font-medium text-zinc-800">允许 Agent 发消息与 @交接</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">关闭后仅保留 self、peers、messages 和 wait 只读能力</div></div><button type="button" role="switch" aria-checked={groupToolsAllowSend} onClick={() => setGroupToolsAllowSend(value => !value)} className={`ml-auto flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${groupToolsAllowSend ? 'bg-zinc-900' : 'bg-zinc-300'}`}><span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${groupToolsAllowSend ? 'translate-x-4' : 'translate-x-0'}`}/></button></div>}<p className="mt-2 text-[10px] leading-4 text-zinc-400">缺少群成员、消息或发消息权限时，Agent 会停止对应操作并给出管理员授权链接；不会索要 App Secret。</p></div>
          <div className="flex items-center rounded-lg border border-zinc-200 bg-white px-3 py-2.5"><div className="min-w-0"><div className="text-[12px] font-medium text-zinc-800">启用高危操作门禁</div><div className="mt-0.5 text-[10px] leading-4 text-zinc-400">启用后强制开启软门禁，并可继续配置 Hook 硬门禁</div></div><button type="button" role="switch" aria-checked={gateEnabled} onClick={() => { const next = !gateEnabled; setGateEnabled(next); setSoftGateEnabled(next); if (!next) setHardGateEnabled(false); }} className={`ml-auto flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${gateEnabled ? 'bg-zinc-900' : 'bg-zinc-300'}`}><span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${gateEnabled ? 'translate-x-4' : 'translate-x-0'}`}/></button></div>
          {gateEnabled && <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-3"><div className="text-[12px] font-semibold text-zinc-800">高危操作门禁</div><p className="mt-1 text-[10px] leading-4 text-zinc-500">不在允许名单内的发送人会收到软门禁 Prompt；开启硬门禁后，再通过 ACP 权限层和 Agent 原生工具调用 Hook 拦截。</p>
            <div className="mt-3"><div className="text-[11px] font-medium text-zinc-700">允许执行高危操作的成员 <span className="font-normal text-zinc-400">留空则继承普通成员名单</span></div><p className="mt-0.5 text-[10px] leading-4 text-zinc-400">输入真实姓名，保存时解析为 open_id。</p>
              {legacyHighRiskNeedsMigration && <div className="mt-2 border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">检测到旧高危邮箱名单。请重新选择成员后再保存，避免意外扩大高危权限。</div>}
              <MemberNameTagInput value={highRiskAllowedUserNames} onChange={setHighRiskAllowedUserNames} placeholder="输入姓名后按 Enter"/>
            </div>
            <label className="mt-3 block"><span className="text-[11px] font-medium text-zinc-700">高危操作正则表达式</span><textarea value={highRiskPattern} onChange={event => setHighRiskPattern(event.target.value)} rows={4} aria-invalid={!highRiskPatternValidation.valid} className={`mt-1.5 w-full resize-y rounded-md border bg-white px-2.5 py-2 font-mono text-[11px] leading-5 outline-none ${highRiskPatternValidation.valid ? 'border-zinc-300 focus:border-zinc-500' : 'border-red-300 focus:border-red-500 focus:ring-1 focus:ring-red-100'}`}/>{!highRiskPatternValidation.valid && <p className="mt-1.5 flex items-start gap-1 text-[10px] leading-4 text-red-600"><AlertTriangle size={11} className="mt-0.5 shrink-0"/>{highRiskPatternValidation.error}</p>}</label>
            <div className="mt-3 flex items-center"><div><div className="text-[11px] font-medium text-zinc-800">软门禁</div><div className="text-[10px] text-zinc-400">门禁启用后固定开启，隐式注入禁止绕过的安全 Prompt</div></div><button type="button" role="switch" aria-checked disabled className="ml-auto flex h-5 w-9 cursor-not-allowed items-center rounded-full bg-zinc-900 p-0.5"><span className="h-4 w-4 translate-x-4 rounded-full bg-white shadow-sm"/></button></div>
            <div className={`mt-3 flex items-center ${!hookStatus.data?.installed && !hardGateEnabled ? 'opacity-60' : ''}`}><div><div className="text-[11px] font-medium text-zinc-800">硬门禁</div><div className="text-[10px] text-zinc-400">{hookStatus.data?.installed ? 'Hook 已配置，可以开启硬门禁' : agentSelectionSaved ? hookStatus.data?.reason ?? '请先检测并配置 Hook' : '点击下方按钮会先保存当前默认 Agent，再检测并配置 Hook'}</div></div><button type="button" role="switch" aria-checked={hardGateEnabled} disabled={!hardGateCanToggle} onClick={() => setHardGateEnabled(value => !value)} className={`ml-auto flex h-5 w-9 items-center rounded-full p-0.5 disabled:cursor-not-allowed ${hardGateEnabled ? 'bg-zinc-900' : 'bg-zinc-300'}`}><span className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${hardGateEnabled ? 'translate-x-4' : ''}`}/></button></div>
            {hardGateHookMissing && <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">已保存的硬门禁 Hook 当前未检测到。其他设置仍可保存；如需恢复硬门禁，请先关闭上方开关，再重新检测并配置 Hook。</div>}
            <button type="button" disabled={!current || hardGateEnabled || installHook.isPending || legacyHighRiskNeedsMigration || !workspace.trim() || !highRiskPatternValidation.valid || hookStatus.data?.supported === false} onClick={() => installHook.mutate()} className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"><Wrench size={12}/>{installHook.isPending ? '正在检测并配置 Hook' : hookStatus.data?.installed ? '重新检测并配置 Hook' : '检测并配置 Hook'}</button>
            {hookStatus.data?.supported === false && <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">{hookStatus.data.reason}</div>}
            {hookStatus.data?.trustInstructions && <div className="mt-2 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-[10px] leading-4 text-zinc-500">{hookStatus.data.trustInstructions}</div>}
          </div>}
          </>}
        </>}
        {formError && <div className="rounded-md border border-red-100 bg-red-50 px-2.5 py-2 text-[11px] leading-4 text-red-700"><div>{formError.message}</div>{permissionRelatedError && permissionSettingsUrl && <a href={permissionSettingsUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-medium text-red-800 underline decoration-red-300 underline-offset-2 hover:text-red-950">打开当前机器人的权限配置<ExternalLink size={11}/></a>}</div>}
      </div>
      <div className="flex items-center border-t border-zinc-100 px-4 py-3">{current ? <button type="button" onClick={() => { remove.reset(); setConfirmation('delete'); }} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-red-600 hover:bg-red-50"><Trash2 size={13}/>删除配置</button> : <span className="text-[10px] text-zinc-400">App ID 将作为唯一主键，不能重复配置</span>}{step === 2 && <button type="button" onClick={() => setStep(1)} className="ml-auto rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100">上一步</button>}<button type="button" onClick={requestClose} className={`${step === 2 ? '' : 'ml-auto'} rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100`}>{step === 2 && current && !current.setupComplete ? '稍后完成' : '取消'}</button><button type="submit" disabled={!canSave || save.isPending} className="ml-1 min-w-20 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-35">{save.isPending ? (step === 1 ? '验证中' : '保存中') : agentCapabilitiesPending ? '读取模型中' : step === 1 ? '下一步' : '完成配置'}</button></div>
    </form>
  </div><ConfirmDialog
    open={Boolean(confirmation)}
    tone={confirmation === 'delete' ? 'danger' : 'warning'}
    title={confirmation === 'delete' ? '删除机器人配置？' : confirmation === 'incomplete' ? '稍后再完成配置？' : '放弃未保存的配置？'}
    description={confirmation === 'delete' ? `将删除“${current?.name ?? '当前机器人'}”的凭证、监听和门禁配置。已有会话记录不会删除。` : confirmation === 'incomplete' ? 'Agent 配置尚未完成。若已开启监听，机器人仍会接收消息，并提示发送人补充运行配置。' : '当前填写的机器人信息尚未保存，关闭后需要重新填写。'}
    confirmLabel={confirmation === 'delete' ? '确认删除' : confirmation === 'incomplete' ? '稍后完成' : '放弃修改'}
    busy={confirmation === 'delete' && remove.isPending}
    error={confirmation === 'delete' && remove.error ? remove.error.message : undefined}
    onCancel={() => { if (!remove.isPending) setConfirmation(undefined); }}
    onConfirm={() => { if (confirmation === 'delete') remove.mutate(); else { setConfirmation(undefined); onClose(); } }}
  /></>;
}

function ToolKindIcon({ kind, size = 14 }: { kind: ToolKind; size?: number }) {
  if (kind === 'read') return <BookOpen size={size}/>;
  if (kind === 'edit') return <FilePenLine size={size}/>;
  if (kind === 'search') return <Search size={size}/>;
  if (kind === 'web') return <Globe2 size={size}/>;
  if (kind === 'git') return <GitBranch size={size}/>;
  if (kind === 'test') return <FlaskConical size={size}/>;
  if (kind === 'database') return <Database size={size}/>;
  if (kind === 'agent') return <Users size={size}/>;
  if (kind === 'terminal') return <Terminal size={size}/>;
  return <Wrench size={size}/>;
}

function ToolCard({ event, ongoing = false, preferDescription = true }: { event: TimelineEvent; ongoing?: boolean; preferDescription?: boolean }) {
  const data = event.data; const done = data.status === 'completed'; const failed = data.status === 'failed'; const terminal = done || failed;
  const [open, setOpen] = useState(ongoing && !terminal); const hasDetails = data.input !== undefined || data.output !== undefined;
  const presentation = toolPresentation(data);
  const elapsed = formatElapsed(elapsedMilliseconds(data.startedAt ?? event.timestamp, terminal ? data.completedAt ?? event.timestamp : undefined));
  const statusLabel = failed ? '失败' : done ? '已完成' : '执行中'; const actionLabel = preferDescription ? toolDescription(data) ?? toolActionLabel(presentation, terminal) : toolActionLabel(presentation, terminal);
  const tone = failed ? 'text-red-500' : done ? 'text-emerald-600' : 'text-blue-500';
  return <div className="overflow-hidden">
    <button type="button" disabled={!hasDetails} onClick={() => setOpen(value => !value)} className="group/tool flex min-h-9 w-full items-center gap-2 py-1.5 text-left transition-colors hover:text-zinc-800 disabled:cursor-default">
      <span className={`grid h-5 w-5 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={13}/></span><span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500"><span className="font-medium text-zinc-700">{actionLabel}</span>{presentation.detail && <span title={presentation.detail} className="ml-1.5 font-mono text-zinc-400">{presentation.detail}</span>}</span>
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] tabular-nums text-zinc-400">{elapsed && <span>{elapsed}</span>}{!terminal ? <LoaderCircle size={11} className="animate-spin text-blue-500"/> : <span className={`h-1.5 w-1.5 rounded-full ${failed ? 'bg-red-500' : 'bg-emerald-500'}`}/>}<span className={tone}>{statusLabel}</span>{hasDetails && (open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>)}</span>
    </button>
    {open && hasDetails && <div className="mb-2 ml-7 border-l border-zinc-200 pl-3"><pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap border-0 bg-transparent py-1 text-[10px] leading-5 text-zinc-500">{JSON.stringify({ ...(data.input !== undefined ? { input: data.input } : {}), ...(data.output !== undefined ? { output: data.output } : {}) }, null, 2)}</pre></div>}
  </div>;
}

function ToolBatch({ description, events, ongoing = false }: { description: string; events: TimelineEvent[]; ongoing?: boolean }) {
  const [open, setOpen] = useState(ongoing && events.some(event => event.data.status !== 'completed' && event.data.status !== 'failed'));
  const failedCount = events.filter(event => event.data.status === 'failed').length;
  const completedCount = events.filter(event => event.data.status === 'completed').length;
  const failed = failedCount > 0;
  const running = events.some(event => event.data.status !== 'completed' && event.data.status !== 'failed');
  const presentation = toolPresentation(events[0]!.data);
  const tone = failed ? 'text-red-500' : running ? 'text-blue-500' : 'text-emerald-600';
  const statusLabel = failed && completedCount ? '部分失败' : failed ? '失败' : running ? '执行中' : '已完成';
  return <div className="overflow-hidden">
    <button type="button" onClick={() => setOpen(value => !value)} className="flex min-h-9 w-full items-center gap-2 py-1.5 text-left transition-colors">
      <span className={`grid h-5 w-5 shrink-0 place-items-center ${tone}`}><ToolKindIcon kind={presentation.kind} size={13}/></span>
      <span title={description} className="min-w-0 flex-1 truncate text-[11px] font-medium text-zinc-700">{description}</span><span className="shrink-0 whitespace-nowrap text-[10px] text-zinc-400">{events.length} 次操作</span>
      {running ? <LoaderCircle size={11} className="shrink-0 animate-spin text-blue-500"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-red-500' : 'bg-emerald-500'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[10px] ${tone}`}>{statusLabel}</span>
      {open ? <ChevronDown size={12} className="shrink-0 text-zinc-400"/> : <ChevronRight size={12} className="shrink-0 text-zinc-400"/>}
    </button>
    {open && <div className="mb-2 ml-7 border-l border-zinc-200 pl-3">{events.map(event => <ToolCard key={event.id} event={event} ongoing={ongoing} preferDescription={false}/>)}</div>}
  </div>;
}

function ActivityContent({ events, ongoing = false }: { events: TimelineEvent[]; ongoing?: boolean }) {
  const rows = groupToolActivityRows(events);
  return <div className="space-y-1">
    {rows.map(row => row.kind === 'batch' ? <ToolBatch key={row.id} description={row.description} events={row.events} ongoing={ongoing}/> : row.event.type === 'text' ? null : row.event.type === 'thinking' ? <div key={row.event.id} className="py-1.5">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-zinc-600"><BrainCircuit size={13}/><span>思考过程</span></div>
      <div className="markdown pl-5 text-[12px] leading-5 text-zinc-500"><MarkdownContent>{row.event.data.text ?? ''}</MarkdownContent></div>
    </div> : <ToolCard key={row.event.id} event={row.event} ongoing={ongoing}/>) }
  </div>;
}

function ActivityGroupPanel({ group, ongoing = false }: { group: TimelineActivityGroup; ongoing?: boolean }) {
  const [open, setOpen] = useState(ongoing);
  const toolCount = group.events.filter(event => event.type === 'tool_call' || event.type === 'tool_result').length;
  const thinkingCount = group.events.filter(event => event.type === 'thinking').length;
  const countLabel = [thinkingCount ? `${thinkingCount} 段思考` : '', toolCount ? `${toolCount} 次工具调用` : ''].filter(Boolean).join(' · ');
  const elapsed = formatElapsed(elapsedMilliseconds(group.startedAt, ongoing ? undefined : group.completedAt));
  const hasFailure = group.events.some(event => (event.type === 'tool_call' || event.type === 'tool_result') && event.data.status === 'failed');
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="reasoning-group group/stage border-b border-zinc-200 text-sm text-zinc-500 last:border-b-0">
    <summary className="flex min-h-10 cursor-pointer select-none items-center gap-2 py-2 text-[12px] font-medium text-zinc-500 outline-none transition-colors hover:text-zinc-800 focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-inset">
      <span title={group.label} className="min-w-0 flex-1 truncate text-zinc-700">{group.label}</span>
      {elapsed && <span className="shrink-0 whitespace-nowrap tabular-nums text-[10px] text-zinc-400">{elapsed}</span>}
      {ongoing ? <LoaderCircle size={11} className="shrink-0 animate-spin text-blue-500"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasFailure ? 'bg-red-500' : 'bg-emerald-500'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[10px] ${ongoing ? 'text-blue-600' : hasFailure ? 'text-red-600' : 'text-emerald-600'}`}>{ongoing ? '执行中' : hasFailure ? '部分失败' : '已完成'}</span>
      <ChevronRight size={13} className="shrink-0 text-zinc-400 transition-transform group-open/stage:rotate-90"/>
    </summary>
    <div className="pb-3 pl-5">
      {countLabel && <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-zinc-500"><Wrench size={14}/><span>{countLabel}</span></div>}
      <ActivityContent events={group.events} ongoing={ongoing}/>
    </div>
  </details>;
}

function ActivityPanel({ groups, ongoing, hasAnswer = false, taskStatus = 'running', modelLabel, startedAt, completedAt }: { groups: TimelineActivityGroup[]; ongoing: boolean; hasAnswer?: boolean; taskStatus?: string; modelLabel: string; startedAt?: string; completedAt?: string }) {
  const [open, setOpen] = useState(ongoing);
  const elapsed = formatElapsed(elapsedMilliseconds(startedAt ?? groups[0]?.startedAt, ongoing ? undefined : completedAt ?? groups.at(-1)?.completedAt));
  const interrupted = taskStatus === 'interrupted' || taskStatus === 'cancelled';
  const failed = taskStatus === 'failed';
  const incomplete = taskStatus === 'incomplete';
  const statusLabel = ongoing ? '执行中' : interrupted ? '已取消' : failed ? '已失败' : incomplete ? '未完成' : '已完成';
  const statusTone = ongoing ? 'text-blue-600' : interrupted ? 'text-zinc-500' : failed ? 'text-red-600' : incomplete ? 'text-amber-600' : 'text-emerald-600';
  const missingFinal = !ongoing && !hasAnswer;
  const missingFinalText = interrupted ? '任务已中断，未产生最终输出。' : failed ? '任务执行失败，未产生最终输出。' : 'Agent 未返回最终输出。';
  return <>
  <details open={open} onToggle={event => setOpen(event.currentTarget.open)} aria-live={ongoing ? 'polite' : undefined} aria-label={`${modelLabel} 执行过程`} className="reasoning ui-timeline-item group/turn my-3 border-b border-zinc-200 text-sm text-zinc-500">
    <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 py-2.5 text-[12px] font-medium text-zinc-500 outline-none transition-colors hover:text-zinc-800 focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-inset">
      <span className="whitespace-nowrap">{elapsed ? `${ongoing ? '已耗时' : '耗时'} ${elapsed}` : '查看执行过程'}</span>
      {ongoing ? <LoaderCircle size={11} className="shrink-0 animate-spin text-blue-500"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${interrupted ? 'bg-zinc-400' : failed ? 'bg-red-500' : incomplete ? 'bg-amber-500' : 'bg-emerald-500'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[10px] ${statusTone}`}>{statusLabel}</span>
      <ChevronRight size={13} className="shrink-0 text-zinc-400 transition-transform group-open/turn:rotate-90"/>
      {groups.length > 0 && <span className="ml-auto text-[10px] tabular-nums text-zinc-400">{groups.length} 个阶段</span>}
    </summary>
    <div className="pb-3 pl-5">
      {groups.length ? groups.map((group, index) => <ActivityGroupPanel key={group.id} group={group} ongoing={ongoing && index === groups.length - 1}/>) : <div className="flex items-center gap-2 py-2 text-[11px] text-zinc-400"><LoaderCircle size={12} className="animate-spin"/>等待模型输出</div>}
    </div>
  </details>
  {missingFinal && <div role="status" className="ui-timeline-item my-4 flex items-center gap-2 text-[12px] text-zinc-500">{failed ? <CircleX size={14} className="text-red-500"/> : interrupted ? <CircleStop size={14} className="text-zinc-400"/> : <MessageSquare size={14} className={incomplete ? 'text-amber-500' : 'text-zinc-400'}/>}<span>{missingFinalText}</span></div>}
  </>;
}

function PermissionCard({ event }: { event: TimelineEvent }) {
  return <div className="ui-timeline-item my-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3.5">
    <div className="flex items-start gap-3"><div className="mt-0.5 grid h-7 w-7 place-items-center rounded-lg bg-orange-100 text-orange-700"><Square size={13}/></div><div className="min-w-0 flex-1"><div className="text-sm font-semibold text-zinc-900">操作已拦截</div><p className="mt-1 text-sm leading-6 text-zinc-600">{event.data.title}</p>
      <div className="mt-2 text-xs font-medium text-zinc-500">{event.data.status === 'pending' ? '历史授权请求已失效；当前版本固定使用完全访问' : event.data.status}</div>
    </div></div>
  </div>;
}

function TimelineItem({ event, final = false, assistantLabel = 'Agent' }: { event: TimelineEvent; final?: boolean; assistantLabel?: string }) {
  if (event.type === 'tool_call' || event.type === 'tool_result') return <ToolCard event={event}/>;
  if (event.type === 'permission_request') return <PermissionCard event={event}/>;
  if (event.type === 'warning') return <aside role="status" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-amber-200 bg-amber-50/75 shadow-[0_4px_14px_rgba(180,83,9,.045)]">
    <div className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700"><AlertTriangle size={14}/></span><div className="min-w-0"><div className="text-[13px] font-semibold text-amber-950">{event.data.warningKind === 'skill' ? 'Skill 提示' : 'Agent 警告'}</div><div className="mt-1 text-[13px] leading-5 text-amber-800"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'error') return <aside role="alert" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-red-200 bg-red-50/80 shadow-[0_4px_14px_rgba(185,28,28,.045)]">
    <div className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-red-100 text-red-700"><CircleX size={14}/></span><div className="min-w-0"><div className="text-[13px] font-semibold text-red-950">Agent 错误</div><div className="mt-1 text-[13px] leading-5 text-red-800"><MarkdownContent>{event.data.message ?? 'Agent 运行失败'}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'thinking') return null;
  const user = event.data.role === 'user';
  if (user) return <div className="ui-timeline-item my-6 flex justify-end"><div className="max-w-[84%] rounded-2xl rounded-br-md bg-zinc-900 px-4 py-3 text-[14px] leading-6 text-zinc-50 shadow-[0_3px_12px_rgba(24,24,27,.1)] sm:max-w-[78%]"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></div></div>;
  if (final) return <article aria-label={`${assistantLabel} 最终输出`} className="assistant-output markdown ui-timeline-item my-4 max-w-[78ch] text-[14px] leading-6 text-zinc-800"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
  return <article className="assistant-output markdown ui-timeline-item my-5 max-w-[78ch] text-[14px] leading-6 text-zinc-800"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
}

function SessionRow({ session, agent, botName, active, onClick }: { session: Session; agent?: Agent; botName?: string; active: boolean; onClick(): void }) {
  const lark = session.source === 'lark';
  return <button onClick={onClick} className={`ui-session-row group relative mb-1 w-full rounded-xl border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 active:scale-[.99] ${active ? 'border-zinc-200/80 bg-white shadow-[0_2px_8px_rgba(24,24,27,.055)]' : 'border-transparent hover:border-zinc-200/60 hover:bg-white/65'}`}>
    <div className="flex items-center gap-2"><span aria-label={stateLabels[session.state]} className={`h-1.5 w-1.5 shrink-0 rounded-full ${busyStates.has(session.state) ? 'ui-status-pulse' : ''} ${stateTone[session.state] ?? 'bg-zinc-400'}`}/><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-800">{agent?.name ?? session.agentId}</span>{lark ? <span className="max-w-24 shrink-0 truncate rounded-md bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium text-zinc-500">{botName ?? '飞书'}</span> : <span className="text-[10px] text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100">{stateLabels[session.state]}</span>}</div>
    <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-3.5 text-[11px] text-zinc-500">{lark && <MessageSquare size={10} className="shrink-0 text-zinc-400"/>}<span title={!session.archivedAt && !lark ? session.cwd : undefined} className="truncate">{session.archivedAt ? '已归档，只读' : lark ? '飞书对话记录' : session.cwd}</span></div>
  </button>;
}

type SendMode = 'queue' | 'interrupt';

function LegacyComposer({ state, value, sending, mode, queuedTasks, cancellingTaskId, steeringTaskId, onChange, onModeChange, onSubmit, onInterrupt, onCancelQueued, onSteerQueued }: { state: string; value: string; sending: boolean; mode: SendMode; queuedTasks: Task[]; cancellingTaskId?: string; steeringTaskId?: string; onChange(value: string): void; onModeChange(mode: SendMode): void; onSubmit(): void; onInterrupt(): void; onCancelQueued(taskId: string): void; onSteerQueued(taskId: string): void }) {
  const [modeOpen, setModeOpen] = useState(false);
  const busy = busyStates.has(state);
  const canSend = value.trim().length > 0 && !sending && !['starting', 'interrupting', 'stopped', 'failed'].includes(state);
  const keyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (canSend) onSubmit(); }
  };
  return <div className="bg-gradient-to-t from-[#f7f8fa] via-[#f7f8fa] to-transparent px-4 pb-5 pt-7 sm:px-8"><div className="mx-auto max-w-[820px]">
    {queuedTasks.length > 0 && <div className="mx-4 overflow-hidden rounded-t-2xl border border-b-0 border-zinc-200/80 bg-white/90 shadow-[0_-5px_18px_rgba(24,24,27,.025)] backdrop-blur">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3.5 py-2 text-[11px] font-medium text-zinc-500"><ListEnd size={13}/><span>等待发送</span><span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-500">{queuedTasks.length}</span></div>
      <div className="max-h-28 overflow-y-auto">{queuedTasks.map(task => <div key={task.id} className="group flex items-center gap-2.5 px-3.5 py-2 text-[12px] text-zinc-600 hover:bg-zinc-50">
        <CornerDownRight size={13} className="shrink-0 text-zinc-400"/><span className="min-w-0 flex-1 truncate">{task.prompt}</span><span className="shrink-0 text-[10px] text-zinc-400">排队中</span><button type="button" disabled={Boolean(cancellingTaskId) || Boolean(steeringTaskId)} onClick={() => onSteerQueued(task.id)} aria-label={`立即发送：${task.prompt}`} title="停止当前任务并立即发送" className="h-6 shrink-0 rounded-md px-2 text-[10px] font-medium text-zinc-600 transition-[background-color,color,opacity,transform] hover:bg-zinc-900 hover:text-white active:scale-[.97] disabled:cursor-wait disabled:opacity-35">{steeringTaskId === task.id ? '处理中' : '立即发送'}</button><button type="button" disabled={Boolean(cancellingTaskId) || Boolean(steeringTaskId)} onClick={() => onCancelQueued(task.id)} aria-label={`取消排队：${task.prompt}`} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 opacity-70 hover:bg-zinc-200 hover:text-zinc-700 disabled:cursor-wait disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"><X size={12}/></button>
      </div>)}</div>
    </div>}
    <div className={`relative rounded-2xl border border-zinc-200/80 bg-white p-2 shadow-[0_8px_28px_rgba(24,24,27,.065)] ring-1 ring-zinc-950/[.025] transition-[border-color,box-shadow] focus-within:border-zinc-400/70 focus-within:shadow-[0_10px_32px_rgba(24,24,27,.085)] focus-within:ring-2 focus-within:ring-zinc-950/[.035] ${queuedTasks.length ? 'rounded-t-[10px] border-t-zinc-200/60' : ''}`}>
    <textarea aria-label="消息" value={value} onChange={event => onChange(event.target.value)} onKeyDown={keyboard} placeholder="给 Agent 发送消息" rows={2} className="max-h-48 min-h-14 w-full resize-none border-0 bg-transparent px-2.5 py-2 text-[14px] leading-6 text-zinc-900 outline-none placeholder:text-zinc-400"/>
    <div className="flex items-center px-1 pb-1"><span className="hidden px-1.5 text-[11px] text-zinc-400 sm:inline">Enter 发送，Shift + Enter 换行</span><div className="ml-auto flex items-center gap-1">
      {busy && value.trim() && <div className="relative"><button type="button" onClick={() => setModeOpen(open => !open)} aria-expanded={modeOpen} aria-label="选择发送方式" className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium transition-colors ${mode === 'interrupt' ? 'bg-orange-50 text-orange-700 hover:bg-orange-100' : 'text-zinc-600 hover:bg-zinc-100'}`}>{mode === 'interrupt' ? <Zap size={13}/> : <ListEnd size={13}/>}<span>{mode === 'interrupt' ? '立即' : '排队'}</span><ChevronDown size={12}/></button>
        {modeOpen && <div className="absolute bottom-10 right-0 z-10 w-64 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1.5 shadow-[0_16px_45px_rgba(24,24,27,.16)]">
          <button type="button" onClick={() => { onModeChange('queue'); setModeOpen(false); }} className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-50 ${mode === 'queue' ? 'bg-zinc-50' : ''}`}><ListEnd size={15} className="mt-0.5 shrink-0 text-zinc-500"/><span><span className="block text-xs font-medium text-zinc-800">排队发送</span><span className="mt-0.5 block text-[10px] leading-4 text-zinc-500">当前任务结束后自动发送</span></span>{mode === 'queue' && <Check size={13} className="ml-auto mt-0.5 text-zinc-700"/>}</button>
          <button type="button" onClick={() => { onModeChange('interrupt'); setModeOpen(false); }} className={`mt-1 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-orange-50 ${mode === 'interrupt' ? 'bg-orange-50' : ''}`}><Zap size={15} className="mt-0.5 shrink-0 text-orange-600"/><span><span className="block text-xs font-medium text-zinc-800">打断并立即发送</span><span className="mt-0.5 block text-[10px] leading-4 text-zinc-500">终止当前 Agent 进程后发送</span></span>{mode === 'interrupt' && <Check size={13} className="ml-auto mt-0.5 text-orange-700"/>}</button>
        </div>}
      </div>}
      {busy && !value.trim() ? <button type="button" onClick={onInterrupt} aria-label="中断当前任务" className="grid h-8 w-8 place-items-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 active:scale-[.97]"><Square size={11} fill="currentColor"/></button> : <button type="button" disabled={!canSend} onClick={onSubmit} aria-label={busy && mode === 'interrupt' ? '打断并立即发送' : busy ? '排队发送' : '发送消息'} className={`grid h-8 w-8 place-items-center rounded-full text-white transition-colors active:scale-[.97] disabled:bg-zinc-200 disabled:text-zinc-400 ${busy && mode === 'interrupt' ? 'bg-orange-600 hover:bg-orange-500' : 'bg-zinc-900 hover:bg-zinc-700'}`}><Send size={13}/></button>}
    </div></div>
  </div></div></div>;
}

export default function App() {
  const qc = useQueryClient(); const { activeSessionId, setActive, rawVisible, toggleRaw } = useDockStore();
  const [sidebarOpen, setSidebarOpen] = useState(false); const [newOpen, setNewOpen] = useState(false); const [larkOpen, setLarkOpen] = useState(false); const [archivedOpen, setArchivedOpen] = useState(false); const [sessionFilter, setSessionFilter] = useState('all'); const [agentId, setAgentId] = useState('codex'); const [cwd, setCwd] = useState(''); const [model, setModel] = useState(''); const [reasoningEffort, setReasoningEffort] = useState(''); const [prompt, setPrompt] = useState(''); const [composerReferences, setComposerReferences] = useState<ComposerReference[]>([]); const [sendMode, setSendMode] = useState<SendMode>('queue'); const [actionError, setActionError] = useState<string>(); const [archiveConfirm, setArchiveConfirm] = useState(false); const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const selectSession = (id: string) => { setActive(id); setPrompt(''); setComposerReferences([]); window.history.replaceState(null, '', `/sessions/${encodeURIComponent(id)}`); };
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents }); const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 2_000 }); const larkConfig = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig, refetchInterval: 5_000 }); const systemCapabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });
  const agentModels = useQuery({ queryKey: agentModelsQueryKey(agentId, model), queryFn: () => loadAgentModels(agentId, model || undefined), enabled: newOpen && Boolean(agentId), initialData: () => readCachedAgentModels(agentId, model || undefined), initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 5 * 60_000 });
  useEffect(() => {
    if (!agentModels.data || agentModels.isFetching || !reasoningEffort) return;
    if (!agentModels.data.reasoningEfforts.some(option => option.id === reasoningEffort)) setReasoningEffort('');
  }, [agentModels.data, agentModels.isFetching, reasoningEffort]);
  useEffect(() => { if (agents.data?.length && !agents.data.some(agent => agent.id === agentId)) setAgentId(agents.data[0].id); }, [agents.data, agentId]);
  useEffect(() => {
    if (activeSessionId) return;
    const match = window.location.pathname.match(/^\/sessions\/([^/]+)$/);
    if (match?.[1]) setActive(decodeURIComponent(match[1]));
  }, [activeSessionId, setActive]);
  const events = useQuery({ queryKey: ['events', activeSessionId], queryFn: () => api.events(activeSessionId!), enabled: !!activeSessionId });
  const tasks = useQuery({ queryKey: ['tasks', activeSessionId], queryFn: () => api.tasks(activeSessionId!), enabled: !!activeSessionId, refetchInterval: 2_000 });
  const sortedSessions = useMemo(() => [...(sessions.data ?? [])].sort((left, right) => (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)), [sessions.data]);
  const visibleSessions = useMemo(() => sortedSessions.filter(session => !session.archivedAt && (sessionFilter === 'all' || sessionFilter === 'local' ? sessionFilter === 'all' || session.source !== 'lark' : session.source === 'lark' && session.sourceId?.startsWith(`${sessionFilter}:`))), [sortedSessions, sessionFilter]);
  const archivedSessions = useMemo(() => sortedSessions.filter(session => session.archivedAt), [sortedSessions]);
  const active = sortedSessions.find(session => session.id === activeSessionId); const activeAgent = agents.data?.find(agent => agent.id === active?.agentId);
  const activeOutputLabel = active?.model ?? activeAgent?.name ?? active?.agentId ?? 'Agent';
  const activeModels = useQuery({ queryKey: agentModelsQueryKey(active?.agentId, active?.model), queryFn: () => loadAgentModels(active!.agentId, active!.model), enabled: Boolean(active && !active.archivedAt), initialData: () => active ? readCachedAgentModels(active.agentId, active.model) : undefined, initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 60_000 });
  const skills = useQuery({ queryKey: ['skills', active?.cwd], queryFn: () => api.skills(active?.cwd), enabled: Boolean(active && !active.archivedAt), staleTime: 60_000 });
  const timeline = useMemo(() => buildTimeline(events.data, tasks.data), [events.data, tasks.data]); const timelineSections = useMemo(() => buildTimelineSections(timeline, tasks.data), [timeline, tasks.data]); const raw = useMemo(() => events.data?.filter(event => event.type === 'raw_terminal').map(event => event.raw ?? event.data.text).join('') ?? '', [events.data]);
  let latestUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index--) if (timeline[index].type === 'text' && timeline[index].data.role === 'user') { latestUserIndex = index; break; }
  const awaitingAnswer = busyStates.has(active?.state ?? '') && latestUserIndex >= 0 && !timeline.slice(latestUserIndex + 1).some(event => event.type === 'text' && event.data.role !== 'user');
  const timelineScroll = useTimelineAutoScroll(activeSessionId, timeline, awaitingAnswer);
  const hasOngoingActivity = timelineSections.some(section => section.kind === 'activity' && section.isLatestTurn && awaitingAnswer);
  const create = useMutation({
    mutationFn: () => api.create({ agentId, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) }),
    onSuccess: session => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      selectSession(session.id); setNewOpen(false); setActionError(undefined);
    },
    onError: error => setActionError(error.message)
  });
  const send = useMutation({ mutationFn: ({ sessionId, message, mode }: { sessionId: string; message: string; mode: SendMode }) => api.send(sessionId, message, mode), onSuccess: (result, variables) => { if (variables.sessionId === activeSessionId) { setPrompt(''); setComposerReferences([]); setSendMode('queue'); } qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => [...(current ?? []).filter(task => task.id !== result.task.id), result.task]); }, onError: error => setActionError(error.message) });
  const cancelQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.cancelQueued(sessionId, taskId), onSuccess: (result, variables) => qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => current?.map(task => task.id === result.id ? result : task)), onError: error => setActionError(error.message) });
  const steerQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.steerQueued(sessionId, taskId), onSuccess: (_result, variables) => { setActionError(undefined); void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }, onError: error => setActionError(error.message) });
  const archive = useMutation({ mutationFn: (sessionId: string) => api.archive(sessionId), onSuccess: result => { qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); setArchiveConfirm(false); setActive(undefined); window.history.replaceState(null, '', '/'); }, onError: error => setActionError(error.message) });
  const pickNewWorkspace = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => setCwd(result.path), onError: error => setActionError(error.message) });
  const pickComposerFile = useMutation({ mutationFn: api.selectFile, onError: error => setActionError(error.message) });
  const refreshModels = useMutation({
    mutationFn: ({ agentId: targetAgentId, currentModel }: { agentId: string; currentModel?: string }) => loadAgentModels(targetAgentId, currentModel, true),
    onSuccess: (result, variables) => { setActionError(undefined); qc.setQueryData(agentModelsQueryKey(variables.agentId, variables.currentModel), result); },
    onError: error => setActionError(error.message)
  });
  const switchModel = useMutation({ mutationFn: ({ sessionId, nextModel }: { sessionId: string; nextModel: string }) => api.setSessionModel(sessionId, nextModel), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void activeModels.refetch(); }, onError: error => setActionError(error.message) });
  const switchReasoningEffort = useMutation({ mutationFn: ({ sessionId, nextReasoningEffort }: { sessionId: string; nextReasoningEffort: string }) => api.setSessionReasoningEffort(sessionId, nextReasoningEffort), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); }, onError: error => setActionError(error.message) });
  const modelReadiness = getModelReadiness({ loaded: activeModels.data !== undefined, loading: activeModels.data === undefined && (activeModels.isPending || activeModels.isFetching || refreshModels.isPending), switching: switchModel.isPending, failed: activeModels.data === undefined && activeModels.isError });
  useEffect(() => {
    if (!activeSessionId || !active || !events.isSuccess) return;
    const cached = qc.getQueryData<DockEvent[]>(['events', activeSessionId]) ?? [];
    const after = cached.reduce((sequence, event) => Math.max(sequence, event.sequence), 0);
    const stream = new EventSource(`/api/sessions/${activeSessionId}/stream?after=${after}`);
    const receive = (message: MessageEvent<string>) => {
      if (typeof message.data !== 'string' || !message.data) return;
      let event: DockEvent;
      try { event = JSON.parse(message.data) as DockEvent; }
      catch { return; }
      qc.setQueryData<DockEvent[]>(['events', activeSessionId], current => {
        if (!current?.length) return [event];
        const existing = current.findIndex(item => item.sequence === event.sequence);
        if (existing < 0) return [...current, event];
        const next = [...current]; next[existing] = event; return next;
      });
      if (event.type === 'status' && Object.hasOwn(stateLabels, event.data.state)) qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === activeSessionId ? { ...session, state: event.data.state, ...(typeof event.data.model === 'string' ? { model: event.data.model } : {}), ...(typeof event.data.reasoningEffort === 'string' ? { reasoningEffort: event.data.reasoningEffort } : {}) } : session));
      if (event.type === 'task' && event.data.task) qc.setQueryData<Task[]>(['tasks', activeSessionId], current => [...(current ?? []).filter(task => task.id !== event.data.task.id), event.data.task]);
    };
    for (const name of ['text','thinking','tool_call','tool_result','permission_request','status','task','error','completed','raw_terminal']) stream.addEventListener(name, receive as EventListener);
    return () => stream.close();
  }, [activeSessionId, active?.runId, events.isSuccess, qc]);
  const submit = () => { if (modelReadiness.kind !== 'ready') return; const message = buildPrompt(prompt, composerReferences); if (message && activeSessionId) send.mutate({ sessionId: activeSessionId, message, mode: busyStates.has(active?.state ?? '') ? sendMode : 'queue' }); };
  const act = async (action: string) => { try { setActionError(undefined); await api.action(activeSessionId!, action); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };

  return <div className="relative flex h-[100dvh] min-h-[100dvh] overflow-hidden bg-[#f7f8fa] font-sans text-zinc-900">
    {sidebarOpen && <button type="button" aria-label="关闭会话列表" onClick={() => setSidebarOpen(false)} className="ui-overlay fixed inset-0 z-10 bg-zinc-950/20 backdrop-blur-[1px] md:hidden"/>}
    <aside className={`fixed inset-y-0 left-0 z-20 flex w-[286px] shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-[#f1f3f5] shadow-[12px_0_36px_rgba(24,24,27,.08)] transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)] md:static md:w-[268px] md:translate-x-0 md:shadow-none ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="flex h-14 min-w-[268px] items-center gap-2.5 px-4"><DockmuxIcon className="h-7 w-7 shrink-0"/><span className="text-sm font-semibold tracking-[-.02em]">Dockmux</span></div>
      <div className="min-w-[268px] px-2.5"><button onClick={() => { setActionError(undefined); setNewOpen(true); }} className="flex h-9 w-full items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-[13px] font-medium shadow-[0_1px_2px_rgba(24,24,27,.06)] hover:bg-zinc-50 active:scale-[.99]"><Plus size={15}/>新建 Session</button></div>
      <div className="mt-5 min-w-[268px] px-4 text-[10px] font-semibold uppercase tracking-[.12em] text-zinc-500">会话列表</div>
      <div className="mt-2 flex min-w-[268px] gap-1 overflow-x-auto px-2 pb-1">{larkConfig.data?.bots.map(bot => <button key={bot.appId} type="button" onClick={() => setSessionFilter(bot.appId)} className={`flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-medium ${sessionFilter === bot.appId ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:bg-white/60'}`}><Bot size={11}/>{bot.tabLabel}</button>)}<button type="button" onClick={() => setSessionFilter('local')} className={`h-7 shrink-0 rounded-lg px-2 text-[10px] font-medium ${sessionFilter === 'local' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:bg-white/60'}`}>本地</button><button type="button" onClick={() => setSessionFilter('all')} className={`h-7 shrink-0 rounded-lg px-2 text-[10px] font-medium ${sessionFilter === 'all' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:bg-white/60'}`}>全部</button></div>
      <div className="mt-1 min-w-[268px] flex-1 overflow-y-auto px-2">{sessions.isLoading ? <div className="space-y-2 px-2"><div className="h-14 animate-pulse rounded-xl bg-zinc-200/70"/><div className="h-14 animate-pulse rounded-xl bg-zinc-200/50"/></div> : visibleSessions.length ? visibleSessions.map(session => <SessionRow key={session.id} session={session} agent={agents.data?.find(item => item.id === session.agentId)} botName={larkConfig.data?.bots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { selectSession(session.id); setSidebarOpen(false); }}/>) : <div className="px-3 py-6 text-xs leading-5 text-zinc-500">当前分类暂无会话。</div>}{archivedOpen && archivedSessions.length > 0 && <div className="mt-3 border-t border-zinc-200 pt-2"><div className="px-3 py-1 text-[10px] font-medium text-zinc-400">已归档，只读</div>{archivedSessions.map(session => <SessionRow key={session.id} session={session} agent={agents.data?.find(item => item.id === session.agentId)} botName={larkConfig.data?.bots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { selectSession(session.id); setSidebarOpen(false); }}/>)}</div>}</div>
      <div className="min-w-[268px] px-2 pb-1"><button type="button" onClick={() => setArchivedOpen(value => !value)} className={`flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[12px] font-medium transition-colors ${archivedOpen ? 'bg-white/75 text-zinc-900' : 'text-zinc-600 hover:bg-white/75 hover:text-zinc-900'}`}><Archive size={14}/><span>归档会话</span><span className="ml-auto text-[10px] tabular-nums text-zinc-400">{archivedSessions.length}</span></button></div>
      <div className="min-w-[268px] px-2 pb-2"><button type="button" onClick={() => setLarkOpen(true)} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[12px] font-medium text-zinc-600 transition-[background-color,color,transform] duration-200 hover:bg-white/75 hover:text-zinc-900 active:scale-[.99]"><Settings2 size={14}/><span>飞书设置</span></button></div>
      <div className="min-w-[268px] border-t border-zinc-200 px-4 py-3 text-[10px] text-zinc-400">ACPX 运行时 <span className="font-mono">0.13.0</span></div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      {active ? <><header className="flex h-14 shrink-0 items-center border-b border-zinc-200 bg-white/80 px-3 backdrop-blur sm:px-4">
        <span className="mr-1 md:hidden"><IconButton label="打开会话列表" onClick={() => setSidebarOpen(true)}><Menu size={16}/></IconButton></span>
        <div className="min-w-0"><div className="flex items-center gap-2 text-[13px] font-semibold"><span>{activeAgent?.name ?? active.agentId}</span><span className={`h-1.5 w-1.5 rounded-full ${stateTone[active.state] ?? 'bg-zinc-400'}`}/><span className="text-[11px] font-normal text-zinc-500">{stateLabels[active.state] ?? active.state}</span></div><div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-400"><Folder size={11}/><span title={active.cwd} className="truncate">{active.cwd}</span>{active.model && <span className="shrink-0">({active.model})</span>}</div></div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">{!active.archivedAt && busyStates.has(active.state) && <IconButton label="中断当前任务" onClick={() => void act('interrupt')}><Square size={14}/></IconButton>}{active.systemPrompt && <IconButton label="查看系统提示词" onClick={() => setSystemPromptOpen(true)}><BookOpen size={14}/></IconButton>}{!active.archivedAt && <IconButton label="永久归档" disabled={archive.isPending} onClick={() => { archive.reset(); setArchiveConfirm(true); }}><Archive size={15}/></IconButton>}<button type="button" disabled={!raw} onClick={toggleRaw} aria-label="原始日志" className={`ml-1 flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 sm:ml-2 sm:px-2.5 ${rawVisible ? 'border-zinc-800 bg-zinc-900 text-white' : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50'}`}><Terminal size={13}/><span className="hidden sm:inline">原始日志</span></button></div>
      </header>
      {actionError && <div className="flex items-center border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"><span>{actionError}</span><button className="ml-auto" onClick={() => setActionError(undefined)} aria-label="关闭错误提示"><X size={13}/></button></div>}
      <div className="flex min-h-0 flex-1"><section className="flex min-w-0 flex-1 flex-col"><div className="relative min-h-0 flex-1"><div ref={timelineScroll.containerRef} onScroll={timelineScroll.onScroll} className="absolute inset-0 overscroll-contain overflow-y-auto"><div className="mx-auto w-full max-w-[820px] px-5 py-8 sm:px-8 sm:py-10">
        {events.isLoading ? <div className="space-y-5"><div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200"/><div className="h-4 w-1/2 animate-pulse rounded bg-zinc-200"/><div className="h-20 animate-pulse rounded-xl bg-zinc-100"/></div> : timeline.length ? <>{timelineSections.map(section => section.kind === 'event' ? <TimelineItem key={section.event.id} event={section.event} final={section.final} assistantLabel={activeOutputLabel}/> : <ActivityPanel key={`${section.id}-${section.hasAnswer ? 'settled' : 'active'}`} groups={section.groups} hasAnswer={section.hasAnswer} taskStatus={section.taskStatus} ongoing={section.isLatestTurn && awaitingAnswer} modelLabel={activeOutputLabel} startedAt={section.startedAt} completedAt={section.completedAt}/>)}{awaitingAnswer && !hasOngoingActivity && <ActivityPanel groups={[]} ongoing modelLabel={activeOutputLabel} startedAt={timeline[latestUserIndex]?.timestamp}/>}</> : <div className="flex min-h-[55vh] flex-col items-center justify-center text-center"><div className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-200 bg-white text-zinc-500 shadow-sm"><MessageSquare size={18}/></div><h2 className="mt-4 text-sm font-semibold">开始对话</h2><p className="mt-1 max-w-xs leading-5 text-xs text-zinc-500">让 Agent 检查代码、实现改动或讲解当前项目。</p></div>}
        </div></div>{!timelineScroll.isFollowing && <button type="button" onClick={timelineScroll.scrollToBottom} className="absolute bottom-4 right-5 z-10 flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 shadow-[0_8px_24px_rgba(24,24,27,.12)] transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40" aria-label="回到最新消息"><ArrowDown size={13}/>回到底部</button>}</div>{active.archivedAt ? <div className="border-t border-zinc-200 bg-white/75 px-4 py-3 text-center text-xs text-zinc-500">该会话已永久归档，仅支持查看。</div> : <Composer state={active.state} value={prompt} references={composerReferences} sending={send.isPending} mode={sendMode} queuedTasks={tasks.data?.filter(task => task.status === 'queued') ?? []} cancellingTaskId={cancelQueued.variables?.taskId} steeringTaskId={steerQueued.variables?.taskId} skills={skills.data ?? []} models={activeModels.data?.models ?? []} reasoningEfforts={activeModels.data?.reasoningEfforts ?? []} currentModel={active.model ?? activeModels.data?.defaultModel} currentReasoningEffort={active.reasoningEffort ?? activeModels.data?.defaultReasoningEffort} context={contextStatsFromEvents(events.data)} advertisedCommands={commandsFromEvents(events.data)} filePicker={Boolean(systemCapabilities.data?.filePicker)} modelReadiness={modelReadiness} switchingModel={switchModel.isPending || busyStates.has(active.state)} switchingReasoningEffort={switchReasoningEffort.isPending || busyStates.has(active.state)} refreshingModels={activeModels.isFetching || refreshModels.isPending} onChange={setPrompt} onReferencesChange={setComposerReferences} onModeChange={setSendMode} onSubmit={submit} onInterrupt={() => void act('interrupt')} onCancelQueued={taskId => cancelQueued.mutate({ sessionId: active.id, taskId })} onSteerQueued={taskId => steerQueued.mutate({ sessionId: active.id, taskId })} onPickFile={async () => (await pickComposerFile.mutateAsync()).path} onModelChange={nextModel => switchModel.mutate({ sessionId: active.id, nextModel })} onReasoningEffortChange={nextReasoningEffort => switchReasoningEffort.mutate({ sessionId: active.id, nextReasoningEffort })} onRefreshModels={() => refreshModels.mutate({ agentId: active.agentId, currentModel: active.model })}/>}</section>
        {rawVisible && <aside className="ui-side-panel fixed inset-y-0 right-0 z-20 flex w-full max-w-[420px] shrink-0 flex-col border-l border-zinc-200 bg-white text-zinc-700 shadow-[-16px_0_48px_rgba(24,24,27,.12)] lg:static lg:z-auto lg:w-[420px] lg:shadow-none"><div className="flex h-11 items-center border-b border-zinc-200 px-3 text-xs font-medium"><Terminal size={13} className="mr-2"/>原始终端输出<span className="ml-auto"><IconButton label="关闭原始终端" onClick={toggleRaw}><PanelRightClose size={14}/></IconButton></span></div><pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap border-0 bg-zinc-50/60 p-4 font-mono text-[11px] leading-5 text-zinc-600">{raw || '当前 Session 暂无原始输出。'}</pre></aside>}
      </div></> : <div className="relative grid flex-1 place-items-center p-8"><span className="absolute left-3 top-3 md:hidden"><IconButton label="打开会话列表" onClick={() => setSidebarOpen(true)}><Menu size={17}/></IconButton></span><div className="ui-empty-state max-w-md text-center"><DockmuxIcon className="mx-auto h-12 w-12"/><h1 className="mt-5 text-xl font-semibold tracking-[-.03em]">选择 Agent，开始工作</h1><p className="mt-2 text-sm leading-6 text-zinc-500">在同一个工作台中运行 Codex、Claude、Cursor、Pi、TraeX 或自定义 ACP Agent。</p><button onClick={() => setNewOpen(true)} className="mt-5 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-[background-color,transform,box-shadow] duration-200 hover:bg-zinc-700 hover:shadow-[0_6px_18px_rgba(24,24,27,.14)] active:scale-[.98]">新建 Session</button></div></div>}
    </main>
    {newOpen && <div className="ui-overlay fixed inset-0 z-20 grid place-items-center bg-zinc-950/30 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) setNewOpen(false); }}><form onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }} className="ui-dialog w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_24px_80px_rgba(24,24,27,.2)]"><div className="flex items-center"><div><h2 className="text-base font-semibold">新建 Session</h2><p className="mt-1 text-xs text-zinc-500">选择 Agent 和工作目录。</p></div><span className="ml-auto"><IconButton label="关闭" onClick={() => setNewOpen(false)}><X size={16}/></IconButton></span></div>
      <div className="mt-5 space-y-4"><div><span className="text-xs font-medium text-zinc-700">Agent</span><AgentSelect agents={agents.data ?? []} value={agentId} onChange={value => { setAgentId(value); setModel(''); setReasoningEffort(''); }}/></div><div><span className="text-xs font-medium text-zinc-700">模型 <span className="font-normal text-zinc-400">可选</span></span>{!agentModels.data && (agentModels.isLoading || agentModels.isFetching) ? <div className="mt-1.5 flex h-10 items-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-400"><RefreshCw size={13} className="mr-2 animate-spin"/>正在通过 ACP 查询模型</div> : <CompactSelect options={[{ value: '', label: agentModels.data?.defaultModel ? `使用 Agent 默认模型 (${agentModels.data.defaultModel})` : '使用 Agent 默认模型' }, ...(agentModels.data?.models ?? []).map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))]} value={model} placeholder="选择模型" disabledText="使用 Agent 默认模型" onChange={value => { setModel(value); setReasoningEffort(''); }}/>}</div>{agentModels.data?.source === 'acp' && agentModels.data.reasoningEfforts.length > 0 && <div><span className="text-xs font-medium text-zinc-700">推理强度 <span className="font-normal text-zinc-400">可选</span></span><CompactSelect options={[{ value: '', label: agentModels.data.defaultReasoningEffort ? `使用模型默认强度 (${agentModels.data.defaultReasoningEffort})` : '使用模型默认强度' }, ...agentModels.data.reasoningEfforts.map(item => ({ value: item.id, label: item.name }))]} value={reasoningEffort} placeholder="选择推理强度" disabledText="" onChange={setReasoningEffort}/></div>}<label className="block"><span className="text-xs font-medium text-zinc-700">工作目录</span><span className="mt-1.5 flex gap-2"><input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="留空则使用 Agent 默认目录" className="h-10 min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 text-sm outline-none placeholder:text-zinc-400 focus:border-zinc-500"/><button type="button" disabled={!systemCapabilities.data?.directoryPicker || pickNewWorkspace.isPending} onClick={() => pickNewWorkspace.mutate()} className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"><FolderOpen size={14}/>{systemCapabilities.data?.directoryPicker ? '选择' : '仅支持 Mac'}</button></span></label>
      </div>
      {create.error && <p className="mt-3 text-xs text-red-600">{create.error.message}</p>}<div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => setNewOpen(false)} className="rounded-lg border border-zinc-300 px-3.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50">取消</button><button type="submit" disabled={create.isPending} className="min-w-20 rounded-lg bg-zinc-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50">{create.isPending ? <RefreshCw className="mx-auto animate-spin" size={14}/> : '创建'}</button></div>
    </form></div>}
    {larkOpen && <LarkConfigModal agents={agents.data ?? []} onClose={() => setLarkOpen(false)}/>}
    <ConfirmDialog open={archiveConfirm} tone="danger" title="归档此会话？" description="归档后会话将变为只读且无法恢复。历史消息和执行记录会保留在归档列表中。" confirmLabel="确认归档" busy={archive.isPending} error={archive.error?.message} onCancel={() => { if (!archive.isPending) setArchiveConfirm(false); }} onConfirm={() => { if (active) archive.mutate(active.id); }}/>
    {systemPromptOpen && active?.systemPrompt && <div className="ui-overlay fixed inset-0 z-30 grid place-items-center bg-zinc-950/30 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) setSystemPromptOpen(false); }}>
      <div className="ui-dialog flex max-h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
        <div className="flex items-center border-b border-zinc-100 px-4 py-3"><div className="min-w-0"><h2 className="text-[14px] font-semibold text-zinc-900">系统提示词</h2><p className="mt-0.5 truncate text-[11px] text-zinc-500">该 Session 创建时注入的系统提示词</p></div><span className="ml-auto"><IconButton label="关闭" onClick={() => setSystemPromptOpen(false)}><X size={16}/></IconButton></span></div>
        <div className="overflow-y-auto px-4 py-4"><pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-zinc-700">{active.systemPrompt}</pre></div>
      </div>
    </div>}
  </div>;
}
