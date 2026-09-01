import { Fragment, useEffect } from 'react';
import { Keyboard, X } from 'lucide-react';
import { useDialogFocus } from '../useDialogFocus';
import { detectPlatform, formatShortcutKeys, shortcutDefinitions, shortcutGroups, type ShortcutDefinition, type ShortcutPlatform } from '../useKeyboardShortcuts';

// 快捷键帮助面板。它是快捷键的唯一「说明书」，因此不允许比实际能力说得更多：
// available 里为 false 的条目必须带出「当前不可用」文本，而不是只靠灰度暗示。

export type ShortcutHelpSheetProps = {
  open: boolean;
  onClose(): void;
  /** 快捷键 id -> 此刻是否真的可触发。整表缺省视为全部可用；给了表但缺某个 id 视为该项未接线。 */
  available?: Record<string, boolean>;
  /** 仅测试注入；缺省按 navigator 探测。 */
  platform?: ShortcutPlatform;
};

const kbdClass = 'inline-flex min-w-6 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-muted)] px-1.5 py-[3px] font-sans text-[11px] font-semibold leading-4 text-[var(--text-secondary)]';

/** 渲染一条规范写法；空格分隔的和弦用「然后」表达按下顺序，避免被误读成同时按。 */
function KeyCombo({ keys, platform }: { keys: string; platform: ShortcutPlatform }) {
  const steps = keys.trim().split(/\s+/).filter(Boolean);
  return <span className="flex flex-wrap items-center justify-end gap-1">
    {steps.map((step, stepIndex) => <Fragment key={`${step}-${stepIndex}`}>
      {stepIndex > 0 && <span className="text-[11px] text-[var(--text-muted)]">然后</span>}
      {formatShortcutKeys(step, platform).map((part, partIndex) => <kbd key={`${part}-${partIndex}`} className={kbdClass}>{part}</kbd>)}
    </Fragment>)}
  </span>;
}

function ShortcutRow({ definition, actionable, platform }: { definition: ShortcutDefinition; actionable: boolean; platform: ShortcutPlatform }) {
  return <li className="flex min-h-10 items-center gap-3 rounded-lg px-2 py-1.5 odd:bg-[var(--surface-muted)]">
    <span className="min-w-0 flex-1">
      <span className={`block text-[13px] leading-5 ${actionable ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{definition.label}</span>
      {!actionable && <span className="mt-0.5 block text-[11px] leading-4 text-[var(--text-muted)]">当前不可用{definition.scope === 'session' ? '：先打开一个任务' : ''}</span>}
    </span>
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      <KeyCombo keys={definition.keys} platform={platform}/>
      {definition.aliasKeys && <><span className="text-[11px] text-[var(--text-muted)]">或</span><KeyCombo keys={definition.aliasKeys} platform={platform}/></>}
    </span>
  </li>;
}

export function ShortcutHelpSheet({ open, onClose, available, platform }: ShortcutHelpSheetProps) {
  const dialogRef = useDialogFocus(open);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  const resolvedPlatform = platform ?? detectPlatform();
  const isActionable = (definition: ShortcutDefinition) => available ? available[definition.id] === true : true;
  // 分组顺序固定，注册表新增的未知分组追加在后面，不会被静默丢弃。
  const groupNames = [...shortcutGroups.filter(group => shortcutDefinitions.some(definition => definition.group === group)), ...[...new Set(shortcutDefinitions.map(definition => definition.group))].filter(group => !(shortcutGroups as readonly string[]).includes(group))];
  const unavailableCount = shortcutDefinitions.filter(definition => !isActionable(definition)).length;

  return <div className="ui-overlay fixed inset-0 z-50 grid place-items-center bg-[var(--overlay-scrim)] p-3 backdrop-blur-[3px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-label="键盘快捷键帮助" className="ui-dialog flex max-h-[92dvh] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] shadow-[var(--shadow-dialog)]">
      <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-4 py-3.5 sm:px-5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--action-soft)] text-[var(--action-primary)]"><Keyboard size={18} strokeWidth={1.8}/></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-[-.01em] text-[var(--text-primary)]">键盘快捷键</h2>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">在输入框内打字时，单键快捷键不生效；带 <kbd className={kbdClass}>{resolvedPlatform === 'mac' ? '⌘' : 'Ctrl'}</kbd> 的组合键仍然可用。</p>
        </div>
        <button type="button" data-dialog-initial-focus onClick={onClose} aria-label="关闭快捷键帮助" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-strong)]"><X size={17}/></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-5">
        <div className="grid gap-5 sm:grid-cols-2">
          {groupNames.map(group => <section key={group} className="min-w-0">
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--text-muted)]">{group}</h3>
            <ul className="m-0 list-none p-0">
              {shortcutDefinitions.filter(definition => definition.group === group).map(definition => <ShortcutRow key={definition.id} definition={definition} actionable={isActionable(definition)} platform={resolvedPlatform}/>)}
            </ul>
          </section>)}
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-3 sm:px-5">
        <p className="m-0 min-w-0 flex-1 text-[11px] leading-4 text-[var(--text-muted)]">{unavailableCount > 0 ? `其中 ${unavailableCount} 项在当前界面不可用，已逐条标注原因。` : '以上快捷键在当前界面均可直接使用。'}</p>
        <button type="button" onClick={onClose} className="h-10 shrink-0 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-default)] px-3.5 text-[12px] font-medium text-[var(--text-secondary)] shadow-[var(--shadow-card)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-strong)]">关闭</button>
      </footer>
    </section>
  </div>;
}
