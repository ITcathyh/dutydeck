import { useEffect, useRef } from 'react';
import type { WorkbenchView } from './workspace-model';

// 全局键盘快捷键的唯一注册表与调度器。
//
// 三条设计前提，决定了下面所有分支：
// 1. 不抢输入：中文用户在 Composer 里连续敲字是主路径，单键快捷键在输入态必须完全沉默，
//    输入法组字期间（isComposing / keyCode 229）任何快捷键都不得触发。
// 2. 不撒谎：没有 handler、when() 为假、或 session 作用域但当前没有打开运行的快捷键一律「惰性」，
//    并且帮助面板必须据此显示「当前不可用」，而不是假装可用。调度与展示共用 shortcutAvailability。
// 3. 不越权：只有真正命中并执行了某个快捷键才调用 preventDefault，其余按键原样交还浏览器。

/** 'global' 任何时候可用；'session' 仅在打开了某个任务运行时可用。 */
export type ShortcutScope = 'global' | 'session';

export type ShortcutDefinition = {
  id: string;
  /** 规范书写形式：'Mod+K'、'?'、'g t'（空格分隔即为需要依次按下的和弦）。 */
  keys: string;
  /** 可选的等价写法，例如 '?' 的常规别名 'Mod+/'；帮助面板会同时展示两者。 */
  aliasKeys?: string;
  label: string;
  group: string;
  scope: ShortcutScope;
  /** 额外守卫：返回 false 时快捷键惰性，并在帮助面板显示为当前不可用。 */
  when?(): boolean;
};

export type ShortcutPlatform = 'mac' | 'other';
export type ShortcutHandlers = Partial<Record<string, () => void>>;
export type UseKeyboardShortcutsOptions = {
  /** 交给弹窗独占键盘时传 false，整套快捷键立即停用并清空和弦缓冲。 */
  enabled?: boolean;
  /** 是否已打开某个任务运行；决定 scope: 'session' 的快捷键是否可用。默认 false（宁可惰性，不可误触）。 */
  sessionOpen?: boolean;
  /** 仅测试注入；缺省按 navigator 探测。 */
  platform?: ShortcutPlatform;
  /** 和弦第二个键的等待窗口，超时后前缀作废。 */
  chordTimeoutMs?: number;
};

/** 和弦前缀的等待窗口：够慢到能想起第二个键，够快到不会误吞后续输入。 */
export const CHORD_TIMEOUT_MS = 1500;

export const shortcutGroups = ['导航', '任务', '视图', '帮助'] as const;

export const shortcutDefinitions: ShortcutDefinition[] = [
  { id: 'command-palette', keys: 'Mod+K', label: '打开命令面板，搜索任务与操作', group: '导航', scope: 'global' },
  { id: 'focus-search', keys: '/', label: '聚焦任务搜索框', group: '导航', scope: 'global' },
  { id: 'go-task-center', keys: 'g t', label: '回到任务中心总览', group: '导航', scope: 'global' },
  { id: 'go-settings', keys: 'g s', label: '打开设置与接入', group: '导航', scope: 'global' },
  { id: 'go-lark-setup', keys: 'g l', label: '打开飞书 Bot 绑定向导', group: '导航', scope: 'global' },
  { id: 'toggle-navigation', keys: 'Mod+B', label: '展开或收起任务列表导航', group: '导航', scope: 'global' },
  { id: 'create-task', keys: 'n', label: '新建任务运行', group: '任务', scope: 'global' },
  { id: 'interrupt-run', keys: '.', label: '中断当前运行，停在已完成的步骤', group: '任务', scope: 'session' },
  { id: 'restart-run', keys: 'Shift+R', label: '重启当前任务运行，从空白上下文重来', group: '任务', scope: 'session' },
  { id: 'archive-run', keys: 'e', label: '归档当前任务运行，需二次确认', group: '任务', scope: 'session' },
  { id: 'toggle-detail-tab', keys: 't', label: '在执行记录与终端之间切换', group: '视图', scope: 'session' },
  { id: 'toggle-raw-log', keys: 'l', label: '打开或关闭原始运行日志面板', group: '视图', scope: 'session' },
  { id: 'view-all', keys: '1', label: '列出全部任务运行', group: '视图', scope: 'global' },
  { id: 'view-active', keys: '2', label: '只看进行中的任务运行', group: '视图', scope: 'global' },
  { id: 'view-queued', keys: '3', label: '只看已排队的任务运行', group: '视图', scope: 'global' },
  { id: 'view-attention', keys: '4', label: '只看待你处理的任务运行', group: '视图', scope: 'global' },
  { id: 'view-failed', keys: '5', label: '只看失败的任务运行，修正后重新运行', group: '视图', scope: 'global' },
  { id: 'view-completed', keys: '6', label: '只看已完成的任务运行', group: '视图', scope: 'global' },
  { id: 'view-archived', keys: '7', label: '只看已归档的任务运行', group: '视图', scope: 'global' },
  { id: 'toggle-help', keys: '?', aliasKeys: 'Mod+/', label: '打开或关闭快捷键帮助', group: '帮助', scope: 'global' }
];

/** 数字键 1–7 与工作台筛选视图的对应关系，供 App 侧一次性接线。 */
export const workbenchViewShortcutIds: Record<WorkbenchView, string> = {
  all: 'view-all',
  active: 'view-active',
  queued: 'view-queued',
  attention: 'view-attention',
  failed: 'view-failed',
  completed: 'view-completed',
  archived: 'view-archived'
};

type Step = {
  /** 归一化后的标识，用于识别和弦前缀是否同一个键。 */
  id: string;
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  /** undefined 表示「不校验 Shift」：符号键本身就要按 Shift 才能打出（如 ?）。 */
  shift?: boolean;
};

const namedKeyAliases: Record<string, string> = { esc: 'Escape', escape: 'Escape', enter: 'Enter', space: ' ', tab: 'Tab' };

const parseStep = (raw: string): Step => {
  const parts = raw.split('+').filter(Boolean);
  const key = parts.pop() ?? raw;
  const modifiers = parts.map(part => part.toLowerCase());
  const normalizedKey = namedKeyAliases[key.toLowerCase()] ?? key;
  const alphanumeric = /^[a-z0-9]$/i.test(normalizedKey);
  const symbol = normalizedKey.length === 1 && !alphanumeric;
  const explicitShift = modifiers.includes('shift');
  return {
    id: raw.toLowerCase(),
    key: normalizedKey,
    mod: modifiers.includes('mod'),
    ctrl: modifiers.includes('ctrl') || modifiers.includes('control'),
    meta: modifiers.includes('meta') || modifiers.includes('cmd'),
    alt: modifiers.includes('alt') || modifiers.includes('option'),
    // 符号键不校验 Shift；字母/数字/具名键默认要求 Shift 未按下，从而拒绝 Mod+Shift+K 命中 Mod+K。
    shift: explicitShift ? true : symbol ? undefined : false
  };
};

const parseKeys = (keys: string): Step[] => keys.trim().split(/\s+/).filter(Boolean).map(parseStep);

/** keys 是否为需要依次按下的和弦（如 'g t'）。 */
export const isChordKeys = (keys: string): boolean => parseKeys(keys).length > 1;

/** Mod 之外没有其它修饰键的单键（含 Shift+字母），在输入框内必须完全沉默。 */
const holdsCommandModifier = (step: Step) => step.mod || step.ctrl || step.meta || step.alt;

export function detectPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'other';
  const agentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const source = agentData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(source) ? 'mac' : 'other';
}

const sameKey = (eventKey: string, stepKey: string) => eventKey.toLowerCase() === stepKey.toLowerCase();

function matchesStep(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, step: Step, platform: ShortcutPlatform): boolean {
  if (!sameKey(event.key, step.key)) return false;
  // Mod 在 macOS 上是 ⌘、其它平台是 Ctrl；绝不同时接受两者，否则 mac 上 Ctrl+K 会误触发。
  const modPressed = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const otherPressed = platform === 'mac' ? event.ctrlKey : event.metaKey;
  if (step.mod) {
    if (!modPressed || otherPressed) return false;
  } else {
    if (event.metaKey !== step.meta) return false;
    if (event.ctrlKey !== step.ctrl) return false;
  }
  if (event.altKey !== step.alt) return false;
  if (step.shift !== undefined && event.shiftKey !== step.shift) return false;
  return true;
}

/**
 * 单个事件是否命中 keys。和弦（'g t'）无法由单个事件命中，一律返回 false，
 * 和弦的分步识别只发生在 useKeyboardShortcuts 内部的缓冲里。
 */
export function matchesShortcut(event: KeyboardEvent, keys: string, platform: ShortcutPlatform = detectPlatform()): boolean {
  if (event.isComposing) return false;
  const steps = parseKeys(keys);
  return steps.length === 1 && matchesStep(event, steps[0]!, platform);
}

const macModifierLabels: Record<string, string> = { mod: '⌘', meta: '⌘', cmd: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧' };
const otherModifierLabels: Record<string, string> = { mod: 'Ctrl', meta: 'Win', cmd: 'Win', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift' };
const namedKeyLabels: Record<string, string> = { escape: 'Esc', enter: 'Enter', ' ': 'Space', tab: 'Tab', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' };

/**
 * 把规范写法拆成逐个 <kbd> 的展示片段：'Mod+K' → mac ['⌘','K']、其它 ['Ctrl','K']；
 * 和弦 'g t' → ['G','T']（顺序语义由调用方用「依次按」表达）。
 */
export function formatShortcutKeys(keys: string, platform: ShortcutPlatform = detectPlatform()): string[] {
  const modifierLabels = platform === 'mac' ? macModifierLabels : otherModifierLabels;
  return keys.trim().split(/\s+/).filter(Boolean).flatMap(raw => {
    const parts = raw.split('+').filter(Boolean);
    const key = parts.pop() ?? raw;
    const normalizedKey = namedKeyAliases[key.toLowerCase()] ?? key;
    const label = namedKeyLabels[normalizedKey.toLowerCase()] ?? (normalizedKey.length === 1 ? normalizedKey.toUpperCase() : normalizedKey);
    return [...parts.map(part => modifierLabels[part.toLowerCase()] ?? part), label];
  });
}

const isActionable = (definition: ShortcutDefinition, handlers: ShortcutHandlers, sessionOpen: boolean): boolean => {
  if (typeof handlers[definition.id] !== 'function') return false;
  if (definition.scope === 'session' && !sessionOpen) return false;
  if (definition.when && !definition.when()) return false;
  return true;
};

/**
 * 当前真正可触发的快捷键集合。帮助面板直接吃这份结果，
 * 保证「面板写着可用」与「按下去有反应」永远是同一个判断。
 */
export function shortcutAvailability(handlers: ShortcutHandlers, options: { sessionOpen?: boolean; enabled?: boolean } = {}): Record<string, boolean> {
  const { sessionOpen = false, enabled = true } = options;
  return Object.fromEntries(shortcutDefinitions.map(definition => [definition.id, enabled && isActionable(definition, handlers, sessionOpen)]));
}

/**
 * 判断事件目标是否处于可编辑控件内（含 contenteditable 祖先）。
 * 命中时单键快捷键必须沉默，只放行带 Mod / Ctrl / Meta / Alt 的组合键。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editable = target.closest('input, textarea, select, [contenteditable], [role="textbox"], [role="searchbox"]');
  if (!editable) return false;
  // 勾选框、单选、按钮型 input 不吃字符输入，单键快捷键在它们身上应当照常生效。
  if (editable instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes(editable.type);
  if (editable instanceof HTMLTextAreaElement || editable instanceof HTMLSelectElement) return true;
  const attribute = editable.getAttribute('contenteditable');
  // jsdom 不实现 isContentEditable，属性判断必须排在前面，否则测试里 contenteditable 形同虚设。
  if (attribute !== null) return attribute !== 'false';
  return editable.getAttribute('role') === 'textbox' || editable.getAttribute('role') === 'searchbox';
}

type CompiledShortcut = { definition: ShortcutDefinition; sequences: Step[][] };

const compiled: CompiledShortcut[] = shortcutDefinitions.map(definition => ({
  definition,
  sequences: [parseKeys(definition.keys), ...(definition.aliasKeys ? [parseKeys(definition.aliasKeys)] : [])]
}));

/**
 * 注册全局快捷键。handlers 存在 ref 里逐帧同步，因此 handler 变化不需要重挂监听，
 * 也不会读到上一轮渲染的闭包。
 *
 * 有意不接管 Escape：App 的移动端导航抽屉、ConfirmDialog、ControlCenterModal 都已各自处理 Escape，
 * 再加一层全局监听只会造成一次按键关闭两层浮层。浮层的 Escape 由浮层自己负责。
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, options: UseKeyboardShortcutsOptions = {}): void {
  const { enabled = true, sessionOpen = false, platform, chordTimeoutMs = CHORD_TIMEOUT_MS } = options;
  const handlersRef = useRef(handlers);
  const configRef = useRef({ sessionOpen, platform, chordTimeoutMs });
  const chordRef = useRef<{ prefix: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    handlersRef.current = handlers;
    configRef.current = { sessionOpen, platform, chordTimeoutMs };
  });

  useEffect(() => {
    const clearChord = () => {
      if (!chordRef.current) return;
      clearTimeout(chordRef.current.timer);
      chordRef.current = null;
    };
    if (!enabled) {
      clearChord();
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // 中文输入法组字期间浏览器仍会派发 keydown，此时任何劫持都会吃掉候选词操作。
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Dead' || event.key === 'Unidentified' || event.key === 'Process') return;
      const { sessionOpen: runOpen, platform: injectedPlatform, chordTimeoutMs: timeout } = configRef.current;
      const resolvedPlatform = injectedPlatform ?? detectPlatform();
      const editable = isEditableTarget(event.target);
      const actionable = compiled.filter(entry => isActionable(entry.definition, handlersRef.current, runOpen));
      const armed = chordRef.current?.prefix;
      clearChord();

      const run = (id: string) => {
        event.preventDefault();
        handlersRef.current[id]?.();
      };

      // 1) 续上未完成的和弦。前缀已按下时，后续的裸按键只能用来完成和弦：
      //    没匹配上就静默作废，绝不让 g 之后的 e 意外触发归档。带 Mod 的组合键不受和弦影响。
      const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (armed !== undefined && !editable) {
        const continued = actionable.find(entry => entry.sequences.some(sequence => sequence.length > 1 && sequence[0]!.id === armed && matchesStep(event, sequence[1]!, resolvedPlatform)));
        if (continued) {
          run(continued.definition.id);
          return;
        }
        if (plainKey) return;
      }

      // 2) 单键 / 组合键。输入态只放行带命令修饰键的组合。
      for (const entry of actionable) {
        for (const sequence of entry.sequences) {
          if (sequence.length !== 1) continue;
          const step = sequence[0]!;
          if (editable && !holdsCommandModifier(step)) continue;
          if (!matchesStep(event, step, resolvedPlatform)) continue;
          run(entry.definition.id);
          return;
        }
      }

      // 3) 起一个和弦前缀。仅当确实存在可用的和弦时才缓冲，且不 preventDefault——
      //    前缀本身还没执行任何动作。
      if (editable) return;
      const prefix = actionable.flatMap(entry => entry.sequences).find(sequence => sequence.length > 1 && matchesStep(event, sequence[0]!, resolvedPlatform));
      if (!prefix) return;
      chordRef.current = { prefix: prefix[0]!.id, timer: setTimeout(clearChord, timeout) };
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearChord();
    };
  }, [enabled]);
}
