import { Fragment } from 'react';
import { Keyboard, X } from 'lucide-react';
import { Button, Dialog, IconButton, Kbd } from './primitives';
import { detectPlatform, formatShortcutKeys, shortcutDefinitions, shortcutGroups, type ShortcutDefinition, type ShortcutPlatform } from '../useKeyboardShortcuts';

// 快捷键帮助面板。它是快捷键的唯一「说明书」，因此不允许比实际能力说得更多：
// available 里为 false 的条目必须带出「当前不可用」文本，而不是只靠灰度暗示。
//
// Escape 无条件关闭（契约 §8.1 点名）：这个面板没有「进行中的写操作」可丢，
// 它是纯只读的说明书，拦住 Escape 只会让人退不出去。焦点陷阱、portal、层级
// 全部由 Dialog 原语提供，这里不再自己监听 keydown——两份实现会互相抢焦点。

export type ShortcutHelpSheetProps = {
  open: boolean;
  onClose(): void;
  /** 快捷键 id -> 此刻是否真的可触发。整表缺省视为全部可用；给了表但缺某个 id 视为该项未接线。 */
  available?: Record<string, boolean>;
  /** 仅测试注入；缺省按 navigator 探测。 */
  platform?: ShortcutPlatform;
};

/** 渲染一条规范写法；空格分隔的和弦用「然后」表达按下顺序，避免被误读成同时按。 */
function KeyCombo({ keys, platform }: { keys: string; platform: ShortcutPlatform }) {
  const steps = keys.trim().split(/\s+/).filter(Boolean);
  return <span className="flex flex-wrap items-center justify-end gap-1">
    {steps.map((step, stepIndex) => <Fragment key={`${step}-${stepIndex}`}>
      {stepIndex > 0 && <span className="text-caption text-subtle">然后</span>}
      {formatShortcutKeys(step, platform).map((part, partIndex) => <Kbd key={`${part}-${partIndex}`}>{part}</Kbd>)}
    </Fragment>)}
  </span>;
}

function ShortcutRow({ definition, actionable, platform }: { definition: ShortcutDefinition; actionable: boolean; platform: ShortcutPlatform }) {
  return <li className="flex min-h-10 items-center gap-3 rounded-md px-2 py-1.5 odd:bg-muted">
    <span className="min-w-0 flex-1">
      <span className={`block text-body ${actionable ? 'text-primary' : 'text-subtle'}`}>{definition.label}</span>
      {!actionable && <span className="mt-0.5 block text-caption text-subtle">当前不可用{definition.scope === 'session' ? '：先打开一个任务' : ''}</span>}
    </span>
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      <KeyCombo keys={definition.keys} platform={platform}/>
      {definition.aliasKeys && <><span className="text-caption text-subtle">或</span><KeyCombo keys={definition.aliasKeys} platform={platform}/></>}
    </span>
  </li>;
}

export function ShortcutHelpSheet({ open, onClose, available, platform }: ShortcutHelpSheetProps) {
  const resolvedPlatform = platform ?? detectPlatform();
  const isActionable = (definition: ShortcutDefinition) => available ? available[definition.id] === true : true;
  // 分组顺序固定，注册表新增的未知分组追加在后面，不会被静默丢弃。
  const groupNames = [...shortcutGroups.filter(group => shortcutDefinitions.some(definition => definition.group === group)), ...[...new Set(shortcutDefinitions.map(definition => definition.group))].filter(group => !(shortcutGroups as readonly string[]).includes(group))];
  const unavailableCount = shortcutDefinitions.filter(definition => !isActionable(definition)).length;

  return <Dialog open={open} onClose={onClose} label="键盘快捷键帮助" size="md">
    <Dialog.Header>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-action-soft text-action"><Keyboard size={18} strokeWidth={1.8}/></span>
      <div className="min-w-0 flex-1">
        <h2 className="text-title font-semibold tracking-[-.01em] text-primary">键盘快捷键</h2>
        <p className="mt-1 text-caption text-subtle">在输入框内打字时，单键快捷键不生效；带 <Kbd>{resolvedPlatform === 'mac' ? '⌘' : 'Ctrl'}</Kbd> 的组合键仍然可用。</p>
      </div>
      <IconButton label="关闭快捷键帮助" onClick={onClose}><X size={17}/></IconButton>
    </Dialog.Header>
    <Dialog.Body className="overflow-x-hidden">
      <div className="grid gap-5 sm:grid-cols-2">
        {groupNames.map(group => <section key={group} className="min-w-0">
          <h3 className="mb-1.5 text-meta font-semibold uppercase tracking-[.12em] text-subtle">{group}</h3>
          <ul className="m-0 list-none p-0">
            {shortcutDefinitions.filter(definition => definition.group === group).map(definition => <ShortcutRow key={definition.id} definition={definition} actionable={isActionable(definition)} platform={resolvedPlatform}/>)}
          </ul>
        </section>)}
      </div>
    </Dialog.Body>
    <Dialog.Footer className="flex-wrap justify-start">
      <p className="m-0 min-w-0 flex-1 text-caption text-subtle">{unavailableCount > 0 ? `其中 ${unavailableCount} 项在当前界面不可用，已逐条标注原因。` : '以上快捷键在当前界面均可直接使用。'}</p>
      <Button onClick={onClose}>关闭</Button>
    </Dialog.Footer>
  </Dialog>;
}
