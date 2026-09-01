import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, Check, ChevronDown, File, FolderOpen, Gauge, ListEnd, Plus, RefreshCw, Send, Sparkles, Square, X, Zap } from 'lucide-react';
import type { AgentModel, Session, SkillReference, Task } from '../api';
import { formatTokens, replaceSlashQuery, slashQuery, type ComposerReference, type ContextStats, type ModelReadiness } from '../composer-utils';
import { composerCapabilities, mergeComposerCommands, type ComposerCommandAction } from '../composer-commands';
import { Badge, Banner, Button, IconButton, Input, Popover, Spinner, usePopoverTrigger } from './primitives';
import { busyStates } from './ui';

export type SendMode = 'queue' | 'interrupt';
type ComposerPanel = 'commands' | 'file' | 'models' | 'reasoning' | undefined;
/** 面板里一行命令。available=false 时仍然列出，但禁用并显示 unavailableReason。 */
type VisibleCommand = { name: string; description: string; action: ComposerCommandAction; available: boolean; aliases: string[]; unavailableReason?: string };

/*
  面板触发按钮的共同外形。三颗按钮（斜杠菜单 / 模型 / 思考深度）都必须自报
  aria-expanded 与 aria-haspopup，否则读屏用户完全不知道它们会展开一个面板。

  这里刻意用原生 <button> 而不是 IconButton 原语：IconButton 的 props 形状已冻结
  为 { label, size, tone, disabled, onClick, children }，不透传其余属性，挂不上
  aria-expanded / aria-haspopup。见文末报告里给负责人的原语 API 缺口备注。
*/
const panelTriggerClass = 'flex h-10 min-w-0 items-center gap-1.5 rounded-md px-2 text-caption text-subtle transition-colors duration-fast ease-out hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

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

function QueuedTasks({ tasks, cancellingTaskId, steeringTaskId, onCancel, onSteer }: { tasks: Task[]; cancellingTaskId?: string; steeringTaskId?: string; onCancel(id: string): void; onSteer(id: string): void }) {
  if (!tasks.length) return null;
  const frozen = Boolean(cancellingTaskId) || Boolean(steeringTaskId);
  return <div className="mx-4 overflow-hidden rounded-t-xl border border-b-0 border-queued-border bg-queued-soft shadow-card backdrop-blur">
    <div className="flex items-center gap-2 border-b border-queued-border px-3.5 py-2 text-caption font-semibold text-queued">
      <ListEnd size={13}/>
      <span>待执行指令</span>
      <Badge tone="queued" variant="outline">{tasks.length}</Badge>
      <span className="ml-auto text-caption font-normal text-queued">当前任务完成后依次执行</span>
    </div>
    <div className="max-h-32 overflow-y-auto">{tasks.map(task => <div key={task.id} className="group flex items-center gap-2 px-3.5 py-1.5 text-caption text-secondary hover:bg-hover">
      <span className="min-w-0 flex-1 truncate">{task.prompt}</span>
      <span className="shrink-0 text-caption text-subtle">排队中</span>
      {/* 「打断当前任务并执行」会掐掉正在跑的那一步，属于契约 §9 的主要交互：40px，不走 sm 豁免。 */}
      <Button size="md" variant="ghost" disabled={frozen} onClick={() => onSteer(task.id)}>{steeringTaskId === task.id ? '正在打断' : '打断当前任务并执行'}</Button>
      <IconButton label={`取消排队：${task.prompt}`} disabled={frozen} onClick={() => onCancel(task.id)}><X size={14}/></IconButton>
    </div>)}</div>
  </div>;
}

function CommandPanel({ commands, skills, onChoose, onPickSkill }: { commands: VisibleCommand[]; skills: SkillReference[]; onChoose(command: VisibleCommand): void; onPickSkill(skill: SkillReference): void }) {
  return <div className="max-h-80 overflow-y-auto">
    <div className="px-2.5 pb-1.5 pt-1 text-caption font-semibold text-subtle">命令</div>
    {/*
      DOM 形状受测试约束：命令名必须是「button > span > span:first-child」。
      Composer.dom.test.tsx 的 commandButton() 用这条选择器按命令名精确取按钮，
      避免撞到描述文本里的同名字样。重排这层嵌套会让那组用例静默抓错元素。
    */}
    {commands.map(command => <button
      key={command.name}
      type="button"
      disabled={!command.available}
      aria-disabled={command.available ? undefined : true}
      onMouseDown={event => event.preventDefault()}
      onClick={() => onChoose(command)}
      className={`flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left ${command.available ? 'hover:bg-hover' : 'cursor-not-allowed opacity-60'}`}
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-muted font-mono text-body text-secondary">/</span>
      <span className="min-w-0">
        <span className="block text-body font-medium text-primary">/{command.name}</span>
        <span className={`block truncate text-caption ${command.available ? 'text-subtle' : 'text-warning'}`}>{command.available ? command.description : command.unavailableReason ?? command.description}</span>
      </span>
    </button>)}
    {skills.length > 0 && <div className="mx-2 mt-1 border-t border-subtle px-0.5 pb-1 pt-2 text-caption font-semibold text-subtle">Skills</div>}
    {skills.map(skill => <button
      key={skill.path}
      type="button"
      onMouseDown={event => event.preventDefault()}
      onClick={() => onPickSkill(skill)}
      className="flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-hover"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-warning-soft text-warning"><Sparkles size={13}/></span>
      <span className="min-w-0">
        <span className="block text-body font-medium text-primary">{skill.name}</span>
        <span className="block truncate text-caption text-subtle">{skill.description || skill.path}</span>
      </span>
    </button>)}
    {/*
      下拉里的「一行都没匹配上」不是 EmptyState 那种空态：EmptyState 是 icon + 标题 +
      描述 + CTA 的整块引导（py-10），塞进一个下拉里会把面板撑成两倍高。这里保持一行文本。
    */}
    {!commands.length && !skills.length && <div className="px-3 py-5 text-center text-caption text-subtle">没有匹配项</div>}
  </div>;
}

function FilePanel({ filePath, filePicker, onFilePathChange, onPickFile, onConfirm }: { filePath: string; filePicker: boolean; onFilePathChange(value: string): void; onPickFile(): void; onConfirm(): void }) {
  return <div className="p-3">
    <div className="text-body font-semibold text-primary">引用本地文件</div>
    <p className="mt-1 text-caption text-subtle">输入绝对路径，Agent 将从本机工作区读取该文件。</p>
    <div className="mt-3 flex gap-2">
      <Input
        autoFocus
        aria-label="本地文件路径"
        value={filePath}
        onChange={event => onFilePathChange(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onConfirm(); } }}
        placeholder="/Users/name/project/file.ts"
        className="min-w-0 flex-1 font-mono"
      />
      {filePicker && <IconButton label="选择本地文件" size="md" onClick={onPickFile}><FolderOpen size={15}/></IconButton>}
      <Button variant="secondary" tone="inverse" disabled={!filePath.trim()} onClick={onConfirm}>引用</Button>
    </div>
  </div>;
}

function ModelsPanel({ models, currentModel, switching, refreshing, modelReadiness, onPick, onRefresh }: { models: AgentModel[]; currentModel?: string; switching: boolean; refreshing: boolean; modelReadiness: ModelReadiness; onPick(id: string): void; onRefresh(): void }) {
  return <div>
    <div className="flex items-center gap-2 border-b border-subtle px-3 py-2">
      <Gauge size={13} className="text-subtle"/>
      <span className="text-body font-semibold text-primary">切换模型</span>
      {/* Spinner 带 label 时自带 role=status aria-live=polite：读屏用户看不到转圈，只有播报能告诉他「还在刷」。 */}
      <span className="ml-auto">{refreshing
        ? <Spinner size="sm" label="正在刷新…"/>
        : <IconButton label="刷新模型列表" onClick={onRefresh}><RefreshCw size={14}/></IconButton>}</span>
    </div>
    <div className="max-h-72 overflow-y-auto p-1.5">
      {models.map(model => <button
        key={model.id}
        type="button"
        disabled={switching || model.id === currentModel}
        onClick={() => onPick(model.id)}
        className="flex min-h-10 w-full items-center rounded-md px-2.5 py-2 text-left text-body text-secondary hover:bg-hover disabled:opacity-55"
      >
        <span className="w-5">{model.id === currentModel && <Check size={13}/>}</span>
        <span className="min-w-0 flex-1 truncate">{model.name}</span>
        {model.name !== model.id && <span className="ml-3 max-w-[48%] truncate font-mono text-meta text-subtle">{model.id}</span>}
      </button>)}
      {!models.length && <div className="p-1.5">{modelReadiness.kind === 'blocked'
        ? <Banner tone="danger">{modelReadiness.reason}</Banner>
        : <p className="px-3 py-5 text-center text-caption text-subtle">{modelReadiness.kind === 'ready' ? 'Agent 未提供可切换模型' : modelReadiness.reason}</p>}</div>}
    </div>
  </div>;
}

function ReasoningPanel({ efforts, current, switching, onPick }: { efforts: AgentModel[]; current?: string; switching: boolean; onPick(id: string): void }) {
  return <div>
    <div className="flex items-center gap-2 border-b border-subtle px-3 py-2.5">
      <BrainCircuit size={13} className="text-subtle"/>
      <span className="text-body font-semibold text-primary">思考深度</span>
    </div>
    <div className="max-h-72 overflow-y-auto p-1.5">
      {efforts.map(effort => <button
        key={effort.id}
        type="button"
        disabled={switching || effort.id === current}
        onClick={() => onPick(effort.id)}
        className="flex min-h-10 w-full items-center rounded-md px-2.5 py-2 text-left text-body text-secondary hover:bg-hover disabled:opacity-55"
      >
        <span className="w-5">{effort.id === current && <Check size={13}/>}</span>
        <span className="min-w-0 flex-1 truncate">{effort.name}</span>
      </button>)}
      {!efforts.length && <p className="px-3 py-6 text-center text-caption text-subtle">当前模型未提供思考深度选项</p>}
    </div>
  </div>;
}

function ReferenceChips({ references, onChange }: { references: ComposerReference[]; onChange(next: ComposerReference[]): void }) {
  if (!references.length) return null;
  return <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-1.5 pt-1">{references.map(reference => <span key={reference.id} className="flex max-w-full items-center gap-1 rounded-sm border border-default bg-muted py-0.5 pl-2 text-caption text-secondary">
    {reference.kind === 'file' ? <File size={12}/> : <Sparkles size={12}/>}
    <span className="truncate font-mono">/{reference.kind === 'skill' ? 'skills' : 'file'} {reference.label}</span>
    <IconButton label={`移除引用 ${reference.label}`} onClick={() => onChange(references.filter(item => item.id !== reference.id))}><X size={13}/></IconButton>
  </span>)}</div>;
}

function ContextMeter({ context }: { context: ContextStats }) {
  return <div className="hidden min-w-0 items-center gap-2 text-caption text-subtle sm:flex">
    <span className="truncate">上下文 {formatTokens(context.used)}{context.size !== undefined ? ` / ${formatTokens(context.size)}` : ''}</span>
    {/* 6px 高的进度条：rounded-sm（6px）在这个高度上就是全圆角，不需要违反「rounded-full 仅正圆」。 */}
    {context.size !== undefined && <span className="h-1.5 w-12 overflow-hidden rounded-sm bg-muted"><span className="block h-full rounded-sm bg-subtle" style={{ width: `${context.percentage ?? 0}%` }}/></span>}
    <span className="whitespace-nowrap">压缩 {formatTokens(context.compacted)}</span>
  </div>;
}

export function Composer({ state, session, value, references, sending, mode, queuedTasks, cancellingTaskId, steeringTaskId, skills, models, reasoningEfforts, currentModel, currentReasoningEffort, context, advertisedCommands, filePicker, modelReadiness, switchingModel, switchingReasoningEffort, refreshingModels, onChange, onReferencesChange, onModeChange, onSubmit, onInterrupt, onCancelQueued, onSteerQueued, onPickFile, onModelChange, onReasoningEffortChange, onRefreshModels, onShowStatus, onRestart, onCreateTask, onOpenHelp }: {
  state: string; session?: Pick<Session, 'state' | 'archivedAt'>; value: string; references: ComposerReference[]; sending: boolean; mode: SendMode; queuedTasks: Task[]; cancellingTaskId?: string; steeringTaskId?: string;
  skills: SkillReference[]; models: AgentModel[]; reasoningEfforts: AgentModel[]; currentModel?: string; currentReasoningEffort?: string; context: ContextStats; advertisedCommands: Array<{ name: string; description: string }>; filePicker: boolean; modelReadiness: ModelReadiness; switchingModel: boolean; switchingReasoningEffort: boolean; refreshingModels: boolean;
  onChange(value: string): void; onReferencesChange(value: ComposerReference[]): void; onModeChange(mode: SendMode): void; onSubmit(): void; onInterrupt(): void; onCancelQueued(taskId: string): void; onSteerQueued(taskId: string): void; onPickFile(): Promise<string | undefined>; onModelChange(model: string): void; onReasoningEffortChange(reasoningEffort: string): void; onRefreshModels(): void;
  // 命令注册表驱动的动作。未传时对应命令不出现在面板里（见 commands 的 filter）。
  onShowStatus?(): void; onRestart?(): void; onCreateTask?(): void; onOpenHelp?(): void;
}) {
  const [panel, setPanel] = useState<ComposerPanel>();
  const [filePath, setFilePath] = useState('');
  const [modeOpen, setModeOpen] = useState(false);
  // 斜杠查询会自动弹出命令面板。用户显式收起（Escape / 点外部）后必须记住这一次已经收起过，
  // 否则关不掉：commandPanel 是从 query 推导出来的，onClose 无处落笔，下一帧照样为 true。
  const [slashDismissed, setSlashDismissed] = useState(false);
  const textarea = useAutoResizeTextarea(value);
  // 四个上方面板共用 Composer 外壳作锚点：它们本来就渲染在同一处、同一宽度。
  // 锚点包住 textarea 是刻意的——否则「输入 / 弹出面板后点一下输入框」会被 Popover 的
  // 外部点击判成关闭。
  const shell = useRef<HTMLDivElement>(null);
  const modeAnchor = useRef<HTMLButtonElement>(null);

  const busy = busyStates.has(state);
  const canSend = modelReadiness.kind === 'ready' && (value.trim().length > 0 || references.length > 0) && !sending && !['starting', 'interrupting', 'stopped', 'failed'].includes(state);
  const modelLabel = modelReadiness.kind === 'ready' ? currentModel || '默认模型' : modelReadiness.label;
  const sendLabel = modelReadiness.kind === 'ready' ? '发送消息' : modelReadiness.reason;
  const query = slashQuery(value, textarea.current?.selectionStart ?? value.length);
  // 命令表来自 composer-commands.ts 的单一注册表，与飞书那份共享同一套设计模式：
  // 真实能力支撑 + 诚实门控。没有对应回调的动作型命令直接不列出，避免点了没反应。
  const commands = useMemo<VisibleCommand[]>(() => {
    const capabilities = composerCapabilities({ session, queuedCount: queuedTasks.length, models: models.length, reasoningEfforts: reasoningEfforts.length });
    const handlers: Partial<Record<ComposerCommandAction, unknown>> = { status: onShowStatus, restart: onRestart, new: onCreateTask, help: onOpenHelp };
    return mergeComposerCommands(advertisedCommands, capabilities)
      .filter(command => !(command.action in handlers) || Boolean(handlers[command.action]))
      .map(command => ({ name: command.name, description: command.description, action: command.action, available: command.available, aliases: command.aliases ?? [], ...(command.unavailableReason ? { unavailableReason: command.unavailableReason } : {}) }));
  }, [advertisedCommands, models.length, onCreateTask, onOpenHelp, onRestart, onShowStatus, queuedTasks.length, reasoningEfforts.length, session]);
  // 别名也参与过滤：输入 /stop 必须能找到 cancel，否则别名等于不存在。
  const visibleCommands = commands.filter(command => query === undefined || command.name.toLowerCase().includes(query) || command.aliases.some(alias => alias.toLowerCase().includes(query)) || command.description.toLowerCase().includes(query));
  const visibleSkills = skills.filter(skill => query === undefined || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query));
  const commandPanel = panel === 'commands' || (query !== undefined && panel === undefined && !slashDismissed);

  // 斜杠查询消失（清空输入、把 / 删掉）时解除「已收起」记忆，下次再打 / 还要能自动弹。
  useEffect(() => { if (query === undefined) setSlashDismissed(false); }, [query]);
  /*
    缺陷修复：发送模式菜单曾是幽灵浮层。触发按钮的渲染条件是 `busy && value.trim()`，
    输入一清空按钮就消失，菜单却留在屏幕上，既点不到触发器也没有外部点击 / Escape 监听。
    这里两道都上：open 直接与触发器可见性挂钩（菜单不可能比按钮活得久），
    同时把 modeOpen 状态收回来，免得下次按钮出现时菜单自己弹开。
  */
  const modeTriggerVisible = busy && Boolean(value.trim());
  useEffect(() => { if (!modeTriggerVisible) setModeOpen(false); }, [modeTriggerVisible]);

  const slashTrigger = usePopoverTrigger(commandPanel, 'menu');
  const modelsTrigger = usePopoverTrigger(panel === 'models', 'listbox');
  const reasoningTrigger = usePopoverTrigger(panel === 'reasoning', 'listbox');
  const modeTrigger = usePopoverTrigger(modeOpen && modeTriggerVisible, 'menu');

  const closePanel = () => { setPanel(undefined); setSlashDismissed(true); };
  const removeSlash = () => onChange(replaceSlashQuery(value, '', textarea.current?.selectionStart ?? value.length));
  const chooseCommand = (command: VisibleCommand) => {
    // 不可用的命令仍然列在面板里（消失会让用户以为自己记错了），但点不动。
    if (!command.available) return;
    if (command.action === 'insert') {
      onChange(replaceSlashQuery(value, `/${command.name} `, textarea.current?.selectionStart ?? value.length));
      setPanel(undefined);
      requestAnimationFrame(() => textarea.current?.focus());
      return;
    }
    removeSlash();
    if (command.action === 'model') { setPanel('models'); return; }
    if (command.action === 'file' || command.action === 'reasoning') { setPanel(command.action); return; }
    // 直接执行型命令：清掉斜杠、收起面板，动作交给上层回调。
    setPanel(undefined);
    if (command.action === 'cancel') { queuedTasks.length && !busy ? onCancelQueued(queuedTasks[queuedTasks.length - 1]!.id) : onInterrupt(); return; }
    if (command.action === 'status') { onShowStatus?.(); return; }
    if (command.action === 'restart') { onRestart?.(); return; }
    if (command.action === 'new') { onCreateTask?.(); return; }
    if (command.action === 'help') onOpenHelp?.();
  };
  const addReference = (kind: ComposerReference['kind'], label: string, referenceValue: string) => {
    const normalized = referenceValue.trim();
    if (!normalized || references.some(reference => reference.kind === kind && reference.value === normalized)) return;
    onReferencesChange([...references, { id: `${kind}-${normalized}`, kind, label, value: normalized }]);
    setPanel(undefined); setFilePath('');
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const keyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组字保护：中文输入法确认候选词时也会发 Enter，keyCode 229 是老版本浏览器的同一信号。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && (panel || query !== undefined)) { event.preventDefault(); closePanel(); return; }
    // Enter 落到第一个**可用**命令上：落到禁用项会让人以为按键失灵。
    if (event.key === 'Enter' && !event.shiftKey && commandPanel && (visibleCommands.some(command => command.available) || visibleSkills[0])) {
      event.preventDefault();
      const firstAvailable = visibleCommands.find(command => command.available);
      if (firstAvailable) chooseCommand(firstAvailable);
      else { removeSlash(); addReference('skill', visibleSkills[0]!.name, visibleSkills[0]!.name); }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (canSend) onSubmit(); }
  };
  const openPicker = async () => { const path = await onPickFile(); if (path) setFilePath(path); };
  const confirmFile = () => addReference('file', filePath.split('/').at(-1) || filePath, filePath);

  return <div className="bg-gradient-to-t from-canvas via-canvas to-transparent px-4 pb-5 pt-7 sm:px-8"><div className="mx-auto max-w-[880px]">
    <QueuedTasks tasks={queuedTasks} cancellingTaskId={cancellingTaskId} steeringTaskId={steeringTaskId} onCancel={onCancelQueued} onSteer={onSteerQueued}/>

    <div ref={shell} className={`relative rounded-xl border border-default bg-surface p-2 shadow-panel ring-1 ring-inset ring-subtle backdrop-blur-sm transition-[transform,border-color,box-shadow,background-color] duration-normal ease-out focus-within:-translate-y-0.5 focus-within:border-action focus-within:bg-raised ${queuedTasks.length ? 'rounded-t-md' : ''}`}>
      {/*
        5 个面板全部走 Popover 原语：portal 到 body（面板原先锚在 overflow-hidden 的
        输入框壳里，各自手写 z-index），并统一拿到外部点击关闭 + Escape 关闭 + 焦点归还。
      */}
      <Popover open={commandPanel} onClose={closePanel} anchor={shell} placement="top-start" width="anchor">
        <CommandPanel
          commands={visibleCommands}
          skills={visibleSkills}
          onChoose={chooseCommand}
          onPickSkill={skill => { removeSlash(); addReference('skill', skill.name, skill.name); }}
        />
      </Popover>

      <Popover open={panel === 'file'} onClose={closePanel} anchor={shell} placement="top-start" width="anchor">
        <FilePanel filePath={filePath} filePicker={filePicker} onFilePathChange={setFilePath} onPickFile={() => void openPicker()} onConfirm={confirmFile}/>
      </Popover>

      <Popover open={panel === 'models'} onClose={closePanel} anchor={shell} placement="top-start" width="anchor">
        <ModelsPanel
          models={models}
          currentModel={currentModel}
          switching={switchingModel}
          refreshing={refreshingModels}
          modelReadiness={modelReadiness}
          onPick={id => { onModelChange(id); setPanel(undefined); }}
          onRefresh={onRefreshModels}
        />
      </Popover>

      <Popover open={panel === 'reasoning'} onClose={closePanel} anchor={shell} placement="top-start" width="anchor">
        <ReasoningPanel
          efforts={reasoningEfforts}
          current={currentReasoningEffort}
          switching={switchingReasoningEffort}
          onPick={id => { onReasoningEffortChange(id); setPanel(undefined); }}
        />
      </Popover>

      <ReferenceChips references={references} onChange={onReferencesChange}/>

      <div className="flex items-center px-2.5 pt-1 text-caption font-semibold uppercase tracking-wider text-action">
        {busy ? '追加执行要求' : '下一步指令'}
        <span className="ml-auto font-normal normal-case tracking-normal text-subtle">Enter 执行 · Shift + Enter 换行</span>
      </div>

      <textarea
        ref={textarea}
        aria-label="消息"
        value={value}
        onChange={event => { onChange(event.target.value); if (panel !== 'file' && panel !== 'models' && panel !== 'reasoning') setPanel(undefined); }}
        onKeyDown={keyboard}
        placeholder={busy ? '补充要求；可选择排队或立即介入当前执行' : '描述要完成的目标、范围和验收要求…'}
        rows={1}
        className="max-h-48 min-h-16 w-full resize-none overflow-y-auto border-0 bg-transparent px-2.5 py-2 text-body text-primary outline-none placeholder:text-subtle focus-visible:outline-none"
      />

      <div className="flex min-w-0 items-center gap-1 px-1 pb-1">
        <button
          type="button"
          aria-label="打开斜杠菜单"
          aria-expanded={slashTrigger['aria-expanded']}
          aria-haspopup={slashTrigger['aria-haspopup']}
          onClick={() => (commandPanel ? closePanel() : setPanel('commands'))}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-subtle transition-colors duration-fast ease-out hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        ><Plus size={16}/></button>

        <button
          type="button"
          title={modelReadiness.kind === 'ready' ? '切换模型' : modelReadiness.reason}
          aria-expanded={modelsTrigger['aria-expanded']}
          aria-haspopup={modelsTrigger['aria-haspopup']}
          onClick={() => setPanel(panel === 'models' ? undefined : 'models')}
          className={`${panelTriggerClass} max-w-40`}
        ><Gauge size={13}/><span className="truncate">{modelLabel}</span><ChevronDown size={12}/></button>

        <button
          type="button"
          title="调整思考深度"
          aria-expanded={reasoningTrigger['aria-expanded']}
          aria-haspopup={reasoningTrigger['aria-haspopup']}
          onClick={() => setPanel(panel === 'reasoning' ? undefined : 'reasoning')}
          className={panelTriggerClass}
        ><BrainCircuit size={13}/><span className="truncate">{currentReasoningEffort || '默认深度'}</span><ChevronDown size={12}/></button>

        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <ContextMeter context={context}/>

          {modeTriggerVisible && <button
            ref={modeAnchor}
            type="button"
            aria-expanded={modeTrigger['aria-expanded']}
            aria-haspopup={modeTrigger['aria-haspopup']}
            onClick={() => setModeOpen(open => !open)}
            className={`flex h-10 items-center gap-1 rounded-md px-2 text-caption font-medium transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${mode === 'interrupt' ? 'bg-warning-soft text-warning' : 'text-secondary hover:bg-hover'}`}
          >{mode === 'interrupt' ? <Zap size={13}/> : <ListEnd size={13}/>}<span>{mode === 'interrupt' ? '立即' : '排队'}</span><ChevronDown size={12}/></button>}

          <Popover open={modeOpen && modeTriggerVisible} onClose={() => setModeOpen(false)} anchor={modeAnchor} placement="top-end" width={224}>
            <button type="button" onClick={() => { onModeChange('queue'); setModeOpen(false); }} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-body text-secondary hover:bg-hover"><ListEnd size={14}/>排队发送</button>
            <button type="button" onClick={() => { onModeChange('interrupt'); setModeOpen(false); }} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-body text-secondary hover:bg-warning-soft hover:text-warning"><Zap size={14}/>打断并立即发送</button>
          </Popover>

          {busy && !value.trim() && !references.length
            ? <button type="button" onClick={onInterrupt} aria-label="中断当前任务" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-inverse text-on-inverse transition-colors duration-fast ease-out hover:bg-inverse-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"><Square size={12} fill="currentColor"/></button>
            : <span className="shrink-0" title={modelReadiness.kind === 'ready' ? undefined : modelReadiness.reason}>
              <button
                type="button"
                disabled={!canSend}
                onClick={onSubmit}
                aria-label={sendLabel}
                className={`grid h-10 w-10 place-items-center rounded-full transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-subtle ${busy && mode === 'interrupt' ? 'bg-attention-solid text-on-action hover:bg-warning-solid' : 'bg-inverse text-on-inverse hover:bg-inverse-hover'}`}
              ><Send size={14}/></button>
            </span>}
        </div>
      </div>
    </div>
  </div></div>;
}
