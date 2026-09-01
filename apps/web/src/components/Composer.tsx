import { type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, Check, ChevronDown, File, FolderOpen, Gauge, ListEnd, Plus, RefreshCw, Send, Sparkles, Square, X, Zap } from 'lucide-react';
import type { AgentModel, SkillReference, Task } from '../api';
import { formatTokens, replaceSlashQuery, shouldDismissComposerPanel, slashQuery, type ComposerReference, type ContextStats, type ModelReadiness } from '../composer-utils';

export type SendMode = 'queue' | 'interrupt';
type ComposerCommand = { name: string; description: string; action: 'file' | 'model' | 'reasoning' | 'insert' };
type ComposerPanel = 'commands' | 'file' | 'models' | 'reasoning' | undefined;

const baseCommands: ComposerCommand[] = [
  { name: 'file', description: '引用本地文件路径', action: 'file' },
  { name: 'goal', description: '创建或继续一个 Goal', action: 'insert' },
  { name: 'fast', description: '使用快速执行模式', action: 'insert' },
  { name: 'model', description: '切换当前任务模型', action: 'model' },
  { name: 'reasoning', description: '调整当前任务思考深度', action: 'reasoning' }
];

function useAutoResizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(192, Math.max(64, textarea.scrollHeight))}px`;
  }, [value]);
  return ref;
}

function useDismissComposerPanel(popover: RefObject<HTMLDivElement | null>, panel: ComposerPanel, setPanel: Dispatch<SetStateAction<ComposerPanel>>) {
  useEffect(() => {
    if (!panel) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const insidePopover = Boolean(popover.current?.contains(target));
      const onPanelTrigger = target instanceof Element && Boolean(target.closest('[data-composer-panel-trigger]'));
      if (shouldDismissComposerPanel({ insidePopover, onPanelTrigger })) setPanel(undefined);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [panel, popover, setPanel]);
}

function QueuedTasks({ tasks, cancellingTaskId, steeringTaskId, onCancel, onSteer }: { tasks: Task[]; cancellingTaskId?: string; steeringTaskId?: string; onCancel(id: string): void; onSteer(id: string): void }) {
  if (!tasks.length) return null;
  return <div className="mx-4 overflow-hidden rounded-t-2xl border border-b-0 border-[var(--status-queued-border)] bg-[var(--status-queued-soft)] shadow-[var(--shadow-card)] backdrop-blur">
    <div className="flex items-center gap-2 border-b border-[var(--status-queued-border)] px-3.5 py-2 text-[11px] font-semibold text-[var(--status-queued)]"><ListEnd size={13}/><span>待执行指令</span><span className="rounded-full bg-[var(--status-queued-border)] px-1.5 py-0.5 text-[10px] tabular-nums">{tasks.length}</span><span className="ml-auto text-[9px] font-normal text-[var(--status-queued)]">当前任务完成后依次执行</span></div>
    <div className="max-h-28 overflow-y-auto">{tasks.map(task => <div key={task.id} className="group flex items-center gap-2.5 px-3.5 py-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"><span className="min-w-0 flex-1 truncate">{task.prompt}</span><span className="text-[10px] text-[var(--text-muted)]">排队中</span><button type="button" disabled={Boolean(cancellingTaskId) || Boolean(steeringTaskId)} onClick={() => onSteer(task.id)} className="h-6 rounded-md px-2 text-[10px] font-medium hover:bg-[var(--status-attention-solid)] hover:text-[var(--text-on-action)] disabled:opacity-35">{steeringTaskId === task.id ? '正在打断' : '打断当前任务并执行'}</button><button type="button" disabled={Boolean(cancellingTaskId) || Boolean(steeringTaskId)} onClick={() => onCancel(task.id)} aria-label={`取消排队：${task.prompt}`} className="grid h-6 w-6 place-items-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-secondary)] disabled:opacity-30"><X size={12}/></button></div>)}</div>
  </div>;
}

export function Composer({ state, value, references, sending, mode, queuedTasks, cancellingTaskId, steeringTaskId, skills, models, reasoningEfforts, currentModel, currentReasoningEffort, context, advertisedCommands, filePicker, modelReadiness, switchingModel, switchingReasoningEffort, refreshingModels, onChange, onReferencesChange, onModeChange, onSubmit, onInterrupt, onCancelQueued, onSteerQueued, onPickFile, onModelChange, onReasoningEffortChange, onRefreshModels }: {
  state: string; value: string; references: ComposerReference[]; sending: boolean; mode: SendMode; queuedTasks: Task[]; cancellingTaskId?: string; steeringTaskId?: string;
  skills: SkillReference[]; models: AgentModel[]; reasoningEfforts: AgentModel[]; currentModel?: string; currentReasoningEffort?: string; context: ContextStats; advertisedCommands: Array<{ name: string; description: string }>; filePicker: boolean; modelReadiness: ModelReadiness; switchingModel: boolean; switchingReasoningEffort: boolean; refreshingModels: boolean;
  onChange(value: string): void; onReferencesChange(value: ComposerReference[]): void; onModeChange(mode: SendMode): void; onSubmit(): void; onInterrupt(): void; onCancelQueued(taskId: string): void; onSteerQueued(taskId: string): void; onPickFile(): Promise<string | undefined>; onModelChange(model: string): void; onReasoningEffortChange(reasoningEffort: string): void; onRefreshModels(): void;
}) {
  const [panel, setPanel] = useState<ComposerPanel>();
  const [filePath, setFilePath] = useState('');
  const [modeOpen, setModeOpen] = useState(false);
  const textarea = useAutoResizeTextarea(value);
  const popover = useRef<HTMLDivElement>(null);
  useDismissComposerPanel(popover, panel, setPanel);
  const busy = ['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting'].includes(state);
  const canSend = modelReadiness.kind === 'ready' && (value.trim().length > 0 || references.length > 0) && !sending && !['starting', 'interrupting', 'stopped', 'failed'].includes(state);
  const modelLabel = modelReadiness.kind === 'ready' ? currentModel || '默认模型' : modelReadiness.label;
  const sendLabel = modelReadiness.kind === 'ready' ? '发送消息' : modelReadiness.reason;
  const query = slashQuery(value, textarea.current?.selectionStart ?? value.length);
  const commands = useMemo(() => {
    const names = new Set(baseCommands.map(command => command.name));
    return [...baseCommands, ...advertisedCommands.filter(command => !names.has(command.name)).map(command => ({ ...command, action: 'insert' as const }))];
  }, [advertisedCommands]);
  const visibleCommands = commands.filter(command => query === undefined || command.name.toLowerCase().includes(query) || command.description.toLowerCase().includes(query));
  const visibleSkills = skills.filter(skill => query === undefined || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query));
  const commandPanel = panel === 'commands' || (query !== undefined && panel === undefined);

  const removeSlash = () => onChange(replaceSlashQuery(value, '', textarea.current?.selectionStart ?? value.length));
  const chooseCommand = (command: ComposerCommand) => {
    if (command.action === 'insert') {
      onChange(replaceSlashQuery(value, `/${command.name} `, textarea.current?.selectionStart ?? value.length));
      setPanel(undefined);
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    removeSlash(); setPanel(command.action === 'model' ? 'models' : command.action);
  };
  const addReference = (kind: ComposerReference['kind'], label: string, referenceValue: string) => {
    const normalized = referenceValue.trim();
    if (!normalized || references.some(reference => reference.kind === kind && reference.value === normalized)) return;
    onReferencesChange([...references, { id: `${kind}-${normalized}`, kind, label, value: normalized }]);
    setPanel(undefined); setFilePath('');
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const keyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && (panel || query !== undefined)) { event.preventDefault(); setPanel(undefined); return; }
    if (event.key === 'Enter' && !event.shiftKey && commandPanel && (visibleCommands[0] || visibleSkills[0])) { event.preventDefault(); if (visibleCommands[0]) chooseCommand(visibleCommands[0]); else { removeSlash(); addReference('skill', visibleSkills[0]!.name, visibleSkills[0]!.name); } return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (canSend) onSubmit(); }
  };
  const openPicker = async () => { const path = await onPickFile(); if (path) setFilePath(path); };

  return <div className="bg-gradient-to-t from-[var(--surface-canvas)] via-[var(--surface-canvas)] to-transparent px-4 pb-5 pt-7 sm:px-8"><div className="mx-auto max-w-[880px]">
    <QueuedTasks tasks={queuedTasks} cancellingTaskId={cancellingTaskId} steeringTaskId={steeringTaskId} onCancel={onCancelQueued} onSteer={onSteerQueued}/>
    <div className={`relative rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] p-2 shadow-[var(--shadow-panel)] ring-1 ring-inset ring-[var(--border-subtle)] backdrop-blur-sm transition-[transform,border-color,box-shadow,background-color] duration-300 ease-out focus-within:-translate-y-0.5 focus-within:border-[var(--action-primary)] focus-within:bg-[var(--surface-raised)] focus-within:shadow-[var(--shadow-panel)] ${queuedTasks.length ? 'rounded-t-[10px]' : ''}`}>
      {(commandPanel || panel === 'file' || panel === 'models' || panel === 'reasoning') && <div ref={popover} className="ui-popover absolute bottom-[calc(100%+8px)] left-0 z-20 w-full overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] shadow-[var(--shadow-dialog)] sm:left-2 sm:w-[460px]">
        {commandPanel && <div className="max-h-80 overflow-y-auto p-1.5"><div className="px-2.5 pb-1.5 pt-1 text-[10px] font-semibold text-[var(--text-muted)]">命令</div>{visibleCommands.map(command => <button key={command.name} type="button" onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(command)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-hover)]"><span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--surface-muted)] font-mono text-[13px] text-[var(--text-secondary)]">/</span><span className="min-w-0"><span className="block text-[12px] font-medium text-[var(--text-primary)]">/{command.name}</span><span className="block truncate text-[10px] text-[var(--text-muted)]">{command.description || 'Agent 提供的命令'}</span></span></button>)}{visibleSkills.length > 0 && <div className="mx-2 mt-1 border-t border-[var(--border-subtle)] px-0.5 pb-1 pt-2 text-[10px] font-semibold text-[var(--text-muted)]">Skills</div>}{visibleSkills.map(skill => <button key={skill.path} type="button" onMouseDown={event => event.preventDefault()} onClick={() => { removeSlash(); addReference('skill', skill.name, skill.name); }} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-hover)]"><span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--status-warning-soft)] text-[var(--status-warning)]"><Sparkles size={13}/></span><span className="min-w-0"><span className="block text-[12px] font-medium text-[var(--text-primary)]">{skill.name}</span><span className="block truncate text-[10px] text-[var(--text-muted)]">{skill.description || skill.path}</span></span></button>)}{!visibleCommands.length && !visibleSkills.length && <div className="px-3 py-5 text-center text-xs text-[var(--text-muted)]">没有匹配项</div>}</div>}
        {panel === 'file' && <div className="p-3"><div className="text-xs font-semibold text-[var(--text-primary)]">引用本地文件</div><p className="mt-1 text-[10px] text-[var(--text-muted)]">输入绝对路径，Agent 将从本机工作区读取该文件。</p><div className="mt-3 flex gap-2"><input autoFocus value={filePath} onChange={event => setFilePath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addReference('file', filePath.split('/').at(-1) || filePath, filePath); } }} placeholder="/Users/name/project/file.ts" className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border-strong)] px-3 font-mono text-[11px] outline-none focus:border-[var(--action-primary)]"/>{filePicker && <button type="button" onClick={() => void openPicker()} className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]" aria-label="选择本地文件"><FolderOpen size={14}/></button>}<button type="button" disabled={!filePath.trim()} onClick={() => addReference('file', filePath.split('/').at(-1) || filePath, filePath)} className="h-9 rounded-lg bg-[var(--surface-inverse)] px-3 text-xs font-medium text-[var(--text-inverse)] disabled:bg-[var(--surface-muted)] disabled:text-[var(--text-muted)]">引用</button></div></div>}
        {panel === 'models' && <div><div className="flex items-center border-b border-[var(--border-subtle)] px-3 py-2.5"><Gauge size={13} className="mr-2 text-[var(--text-muted)]"/><span className="text-xs font-semibold">切换模型</span>{refreshingModels && <span className="ml-auto text-[10px] text-[var(--text-muted)]">正在刷新…</span>}<button type="button" disabled={refreshingModels} onClick={onRefreshModels} className={`${refreshingModels ? 'ml-1' : 'ml-auto'} grid h-7 w-7 place-items-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-wait disabled:text-[var(--text-muted)]`} aria-label={refreshingModels ? '正在刷新模型列表' : '刷新模型列表'} title={refreshingModels ? '正在刷新模型列表' : '刷新模型列表'}><RefreshCw size={12} className={refreshingModels ? 'animate-spin' : ''}/></button></div><div className="max-h-72 overflow-y-auto p-1.5">{models.map(model => <button key={model.id} type="button" disabled={switchingModel || model.id === currentModel} onClick={() => { onModelChange(model.id); setPanel(undefined); }} className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-55"><span className="w-5">{model.id === currentModel && <Check size={12}/>}</span><span className="min-w-0 flex-1 truncate">{model.name}</span>{model.name !== model.id && <span className="ml-3 max-w-[48%] truncate font-mono text-[10px] text-[var(--text-muted)]">{model.id}</span>}</button>)}{!models.length && <div className={`mx-1 my-1 rounded-lg px-3 py-5 text-center text-xs ${modelReadiness.kind === 'blocked' ? 'bg-[var(--status-danger-soft)] text-[var(--status-danger)]' : 'text-[var(--text-muted)]'}`}>{modelReadiness.kind === 'ready' ? 'Agent 未提供可切换模型' : modelReadiness.reason}</div>}</div></div>}
        {panel === 'reasoning' && <div><div className="flex items-center border-b border-[var(--border-subtle)] px-3 py-2.5"><BrainCircuit size={13} className="mr-2 text-[var(--text-muted)]"/><span className="text-xs font-semibold">思考深度</span></div><div className="max-h-72 overflow-y-auto p-1.5">{reasoningEfforts.map(effort => <button key={effort.id} type="button" disabled={switchingReasoningEffort || effort.id === currentReasoningEffort} onClick={() => { onReasoningEffortChange(effort.id); setPanel(undefined); }} className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-55"><span className="w-5">{effort.id === currentReasoningEffort && <Check size={12}/>}</span><span className="min-w-0 flex-1 truncate">{effort.name}</span></button>)}{!reasoningEfforts.length && <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">当前模型未提供思考深度选项</div>}</div></div>}
      </div>}
      {references.length > 0 && <div className="flex flex-wrap gap-1.5 px-2.5 pb-1.5 pt-1">{references.map(reference => <span key={reference.id} className="flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface-muted)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">{reference.kind === 'file' ? <File size={11}/> : <Sparkles size={11}/>}<span className="truncate font-mono">/{reference.kind === 'skill' ? 'skills' : 'file'} {reference.label}</span><button type="button" onClick={() => onReferencesChange(references.filter(item => item.id !== reference.id))} aria-label={`移除引用 ${reference.label}`} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={10}/></button></span>)}</div>}
      <div className="flex items-center px-2.5 pt-1 text-[9px] font-semibold uppercase tracking-[.13em] text-[var(--action-primary)]">{busy ? '追加执行要求' : '下一步指令'}<span className="ml-auto font-normal normal-case tracking-normal text-[var(--text-muted)]">Enter 执行 · Shift + Enter 换行</span></div><textarea ref={textarea} aria-label="消息" value={value} onChange={event => { onChange(event.target.value); if (panel !== 'file' && panel !== 'models' && panel !== 'reasoning') setPanel(undefined); }} onKeyDown={keyboard} placeholder={busy ? '补充要求；可选择排队或立即介入当前执行' : '描述要完成的目标、范围和验收要求…'} rows={1} className="max-h-48 min-h-16 w-full resize-none overflow-y-auto border-0 bg-transparent px-2.5 py-2 text-[14px] leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus-visible:outline-none"/>
      <div className="flex min-w-0 items-center gap-1 px-1 pb-1"><button type="button" data-composer-panel-trigger onClick={() => setPanel(panel === 'commands' ? undefined : 'commands')} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]" aria-label="打开斜杠菜单"><Plus size={14}/></button><button type="button" data-composer-panel-trigger onClick={() => setPanel(panel === 'models' ? undefined : 'models')} title={modelReadiness.kind === 'ready' ? '切换模型' : modelReadiness.reason} className="flex h-8 min-w-0 max-w-40 items-center gap-1.5 rounded-lg px-2 text-[10px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"><Gauge size={12}/><span className="truncate">{modelLabel}</span><ChevronDown size={10}/></button><button type="button" data-composer-panel-trigger onClick={() => setPanel(panel === 'reasoning' ? undefined : 'reasoning')} className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[10px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"><BrainCircuit size={12}/><span className="truncate">{currentReasoningEffort || '默认深度'}</span><ChevronDown size={10}/></button><div className="ml-auto flex min-w-0 items-center gap-1.5"><div className="hidden min-w-0 items-center gap-2 text-[10px] text-[var(--text-muted)] sm:flex"><span className="truncate">上下文 {formatTokens(context.used)}{context.size !== undefined ? ` / ${formatTokens(context.size)}` : ''}</span>{context.size !== undefined && <span className="h-1.5 w-12 overflow-hidden rounded-full bg-[var(--surface-muted)]"><span className="block h-full rounded-full bg-[var(--text-muted)]" style={{ width: `${context.percentage ?? 0}%` }}/></span>}<span className="whitespace-nowrap">压缩 {formatTokens(context.compacted)}</span></div>
        {busy && value.trim() && <button type="button" onClick={() => setModeOpen(open => !open)} className={`flex h-8 items-center gap-1 rounded-lg px-2 text-[10px] font-medium ${mode === 'interrupt' ? 'bg-[var(--status-warning-soft)] text-[var(--status-warning)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'}`}>{mode === 'interrupt' ? <Zap size={12}/> : <ListEnd size={12}/>}<span>{mode === 'interrupt' ? '立即' : '排队'}</span><ChevronDown size={10}/></button>}
        {modeOpen && <div className="absolute bottom-12 right-10 z-20 w-56 rounded-xl border border-[var(--border-default)] bg-[var(--surface-default)] p-1.5 shadow-[var(--shadow-dialog)]"><button type="button" onClick={() => { onModeChange('queue'); setModeOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-[var(--surface-hover)]"><ListEnd size={13}/>排队发送</button><button type="button" onClick={() => { onModeChange('interrupt'); setModeOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-[var(--status-warning-soft)]"><Zap size={13}/>打断并立即发送</button></div>}
        {busy && !value.trim() && !references.length ? <button type="button" onClick={onInterrupt} aria-label="中断当前任务" className="grid h-8 w-8 place-items-center rounded-full bg-[var(--surface-inverse)] text-[var(--text-inverse)] hover:bg-[var(--surface-inverse-hover)]"><Square size={11} fill="currentColor"/></button> : <span className="shrink-0" title={modelReadiness.kind === 'ready' ? undefined : modelReadiness.reason}><button type="button" disabled={!canSend} onClick={onSubmit} aria-label={sendLabel} className={`grid h-8 w-8 place-items-center rounded-full disabled:cursor-not-allowed disabled:bg-[var(--surface-muted)] disabled:text-[var(--text-muted)] ${busy && mode === 'interrupt' ? 'bg-[var(--status-attention-solid)] text-[var(--text-on-action)] hover:bg-[var(--status-warning-solid)]' : 'bg-[var(--surface-inverse)] text-[var(--text-inverse)] hover:bg-[var(--surface-inverse-hover)]'}`}><Send size={13}/></button></span>}
      </div></div>
    </div></div></div>;
}
