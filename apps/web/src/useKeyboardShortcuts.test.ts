import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHORD_TIMEOUT_MS,
  detectPlatform,
  formatShortcutKeys,
  isChordKeys,
  isEditableTarget,
  matchesShortcut,
  shortcutAvailability,
  shortcutDefinitions,
  useKeyboardShortcuts,
  workbenchViewShortcutIds,
  type ShortcutHandlers,
  type UseKeyboardShortcutsOptions
} from './useKeyboardShortcuts';

// 这些用例盯的是「快捷键抢走用户输入」和「面板宣称的能力与实际不符」两类回归。
// 中文输入法（isComposing）、可编辑目标、多余修饰键三条是本产品最容易被破坏的边界。

type HookProps = { handlers: ShortcutHandlers; options?: UseKeyboardShortcutsOptions };

const renderShortcuts = (initialProps: HookProps) => renderHook(({ handlers, options }: HookProps) => useKeyboardShortcuts(handlers, options), { initialProps });

/** 直接派发 keydown，绕开 userEvent 对 target 的推断，精确控制修饰键与 isComposing。 */
function press(key: string, init: KeyboardEventInit & { target?: Element } = {}) {
  const { target, ...rest } = init;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...rest });
  act(() => { (target ?? document.body).dispatchEvent(event); });
  return event;
}

/** 挂到 document.body 上的可编辑控件，用完即销毁；不挂载则 closest 查不到祖先。 */
function mountEditable(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host.firstElementChild!;
}

afterEach(() => { document.body.innerHTML = ''; });

const macOptions: UseKeyboardShortcutsOptions = { platform: 'mac' };
const pcOptions: UseKeyboardShortcutsOptions = { platform: 'other' };
const sessionMac: UseKeyboardShortcutsOptions = { platform: 'mac', sessionOpen: true };

describe('formatShortcutKeys', () => {
  it('Mod 在 macOS 显示 ⌘、在其它平台显示 Ctrl', () => {
    expect(formatShortcutKeys('Mod+K', 'mac')).toEqual(['⌘', 'K']);
    expect(formatShortcutKeys('Mod+K', 'other')).toEqual(['Ctrl', 'K']);
  });

  it('保留符号键原样，字母统一大写', () => {
    expect(formatShortcutKeys('?', 'mac')).toEqual(['?']);
    expect(formatShortcutKeys('Mod+/', 'other')).toEqual(['Ctrl', '/']);
    expect(formatShortcutKeys('n', 'other')).toEqual(['N']);
  });

  it('和弦拆成按下顺序的多个片段', () => {
    expect(formatShortcutKeys('g t', 'mac')).toEqual(['G', 'T']);
  });

  it('Shift 与具名键有各自平台化的展示', () => {
    expect(formatShortcutKeys('Shift+R', 'mac')).toEqual(['⇧', 'R']);
    expect(formatShortcutKeys('Shift+R', 'other')).toEqual(['Shift', 'R']);
    expect(formatShortcutKeys('Escape', 'other')).toEqual(['Esc']);
  });
});

describe('matchesShortcut', () => {
  it('mac 用 metaKey 解析 Mod，不接受 ctrlKey', () => {
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', metaKey: true }), 'Mod+K', 'mac')).toBe(true);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }), 'Mod+K', 'mac')).toBe(false);
  });

  it('非 mac 用 ctrlKey 解析 Mod，不接受 metaKey', () => {
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }), 'Mod+K', 'other')).toBe(true);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', metaKey: true }), 'Mod+K', 'other')).toBe(false);
  });

  it('多余修饰键不算命中：Mod+Shift+K 不等于 Mod+K', () => {
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', metaKey: true, shiftKey: true }), 'Mod+K', 'mac')).toBe(false);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', metaKey: true, altKey: true }), 'Mod+K', 'mac')).toBe(false);
  });

  it('输入法组字中的事件一律不命中', () => {
    const composing = new KeyboardEvent('keydown', { key: 'n' });
    Object.defineProperty(composing, 'isComposing', { value: true });
    expect(matchesShortcut(composing, 'n', 'other')).toBe(false);
  });

  it('和弦无法由单个事件命中', () => {
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'g' }), 'g t', 'other')).toBe(false);
    expect(isChordKeys('g t')).toBe(true);
    expect(isChordKeys('Mod+K')).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('识别 input / textarea / select', () => {
    for (const html of ['<input/>', '<textarea></textarea>', '<select></select>']) expect(isEditableTarget(mountEditable(html))).toBe(true);
  });

  it('识别 contenteditable 祖先，而不只是元素自身', () => {
    const host = mountEditable('<div contenteditable="true"><span>行内文字</span></div>');
    const inner = host.querySelector('span')!;
    expect(isEditableTarget(inner)).toBe(true);
    expect(isEditableTarget(host)).toBe(true);
    host.setAttribute('contenteditable', 'false');
    expect(isEditableTarget(inner)).toBe(false);
  });

  it('识别 textarea 内部与 role="textbox" 的自定义输入器', () => {
    expect(isEditableTarget(mountEditable('<div role="textbox"></div>'))).toBe(true);
    expect(isEditableTarget(mountEditable('<div role="searchbox"></div>'))).toBe(true);
  });

  it('勾选框等不吃字符的 input 不算输入态', () => {
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'file', 'range']) expect(isEditableTarget(mountEditable(`<input type="${type}"/>`))).toBe(false);
    expect(isEditableTarget(mountEditable('<input type="text"/>'))).toBe(true);
    expect(isEditableTarget(mountEditable('<input type="search"/>'))).toBe(true);
  });

  it('普通按钮、listbox 选项与非元素目标不算输入态', () => {
    expect(isEditableTarget(mountEditable('<button type="button">普通按钮</button>'))).toBe(false);
    expect(isEditableTarget(mountEditable('<button role="option">选项</button>'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });
});

describe('detectPlatform', () => {
  it('按 navigator.platform 判定 mac，其它一律 other', () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
    expect(detectPlatform()).toBe('mac');
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
    expect(detectPlatform()).toBe('other');
    if (original) Object.defineProperty(window.navigator, 'platform', original);
  });
});

describe('shortcutDefinitions 注册表', () => {
  it('id 与展示用 keys 均无重复，避免一次按键触发两个动作', () => {
    const ids = shortcutDefinitions.map(definition => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    const allKeys = shortcutDefinitions.flatMap(definition => [definition.keys, ...(definition.aliasKeys ? [definition.aliasKeys] : [])]);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it('每条都有中文标签、合法分组与作用域', () => {
    for (const definition of shortcutDefinitions) {
      expect(/[一-龥]/.test(definition.label)).toBe(true);
      expect(['导航', '任务', '视图', '帮助']).toContain(definition.group);
      expect(['global', 'session']).toContain(definition.scope);
    }
  });

  it('不注册浏览器无法可靠拦截的组合（Mod+N / Mod+T / Mod+W / Mod+Q）', () => {
    const reserved = ['mod+n', 'mod+t', 'mod+w', 'mod+q'];
    for (const definition of shortcutDefinitions) {
      expect(reserved).not.toContain(definition.keys.toLowerCase());
      if (definition.aliasKeys) expect(reserved).not.toContain(definition.aliasKeys.toLowerCase());
    }
  });

  it('七个工作台视图各自映射到一条已注册的快捷键', () => {
    const ids = new Set(shortcutDefinitions.map(definition => definition.id));
    for (const shortcutId of Object.values(workbenchViewShortcutIds)) expect(ids.has(shortcutId)).toBe(true);
  });
});

describe('shortcutAvailability', () => {
  it('没有 handler 的快捷键不可用', () => {
    const availability = shortcutAvailability({ 'create-task': () => {} });
    expect(availability['create-task']).toBe(true);
    expect(availability['command-palette']).toBe(false);
  });

  it('session 作用域在未打开运行时不可用，打开后可用', () => {
    const handlers = { 'toggle-raw-log': () => {} };
    expect(shortcutAvailability(handlers, { sessionOpen: false })['toggle-raw-log']).toBe(false);
    expect(shortcutAvailability(handlers, { sessionOpen: true })['toggle-raw-log']).toBe(true);
  });

  it('enabled: false 时全部不可用，面板不会宣称能用', () => {
    const availability = shortcutAvailability({ 'create-task': () => {} }, { enabled: false });
    expect(Object.values(availability).every(value => value === false)).toBe(true);
  });

  it('覆盖注册表全部条目，帮助面板不会漏读某个 id', () => {
    const availability = shortcutAvailability({});
    expect(Object.keys(availability).sort()).toEqual(shortcutDefinitions.map(definition => definition.id).sort());
  });
});

describe('useKeyboardShortcuts', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('Mod+K 在 mac 用 ⌘ 触发命令面板，Ctrl+K 不触发', () => {
    const palette = vi.fn();
    renderShortcuts({ handlers: { 'command-palette': palette }, options: macOptions });
    press('k', { metaKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
    press('k', { ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it('Mod+K 在非 mac 用 Ctrl 触发，⌘ 不触发', () => {
    const palette = vi.fn();
    renderShortcuts({ handlers: { 'command-palette': palette }, options: pcOptions });
    press('k', { ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
    press('k', { metaKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it('命中时 preventDefault，未命中时把按键原样交还浏览器', () => {
    renderShortcuts({ handlers: { 'command-palette': () => {} }, options: macOptions });
    expect(press('k', { metaKey: true }).defaultPrevented).toBe(true);
    // 未注册 handler 的 Mod+B 属于惰性快捷键，不能吞掉浏览器默认行为
    expect(press('b', { metaKey: true }).defaultPrevented).toBe(false);
    expect(press('z').defaultPrevented).toBe(false);
  });

  it('多余修饰键不触发：Mod+Shift+K 不命中 Mod+K', () => {
    const palette = vi.fn();
    renderShortcuts({ handlers: { 'command-palette': palette }, options: macOptions });
    press('k', { metaKey: true, shiftKey: true });
    press('k', { metaKey: true, altKey: true });
    expect(palette).not.toHaveBeenCalled();
  });

  it('在 textarea 内单键完全沉默，Mod 组合键照常触发', () => {
    const create = vi.fn();
    const palette = vi.fn();
    renderShortcuts({ handlers: { 'create-task': create, 'command-palette': palette }, options: macOptions });
    const textarea = mountEditable('<textarea aria-label="指令输入"></textarea>');
    press('n', { target: textarea });
    expect(create).not.toHaveBeenCalled();
    press('k', { metaKey: true, target: textarea });
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it('在 contenteditable 的子节点上单键同样沉默', () => {
    const create = vi.fn();
    renderShortcuts({ handlers: { 'create-task': create }, options: macOptions });
    const inner = mountEditable('<div contenteditable="true"><span>行内文字</span></div>').querySelector('span')!;
    press('n', { target: inner });
    expect(create).not.toHaveBeenCalled();
    press('n');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('搜索框内 / 不再抢焦点，输入的斜杠留给用户', () => {
    const focusSearch = vi.fn();
    renderShortcuts({ handlers: { 'focus-search': focusSearch }, options: macOptions });
    press('/', { target: mountEditable('<input type="search" aria-label="搜索"/>') });
    expect(focusSearch).not.toHaveBeenCalled();
    press('/');
    expect(focusSearch).toHaveBeenCalledTimes(1);
  });

  it('中文输入法组字期间不触发任何快捷键（isComposing 与 keyCode 229）', () => {
    const create = vi.fn();
    renderShortcuts({ handlers: { 'create-task': create }, options: macOptions });
    const composing = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    act(() => { document.body.dispatchEvent(composing); });
    expect(create).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);
    press('n', { keyCode: 229 });
    press('Process');
    expect(create).not.toHaveBeenCalled();
    press('n');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('组字期间的按键不会污染和弦缓冲', () => {
    const goTaskCenter = vi.fn();
    renderShortcuts({ handlers: { 'go-task-center': goTaskCenter }, options: macOptions });
    press('g');
    press('t', { keyCode: 229 });
    expect(goTaskCenter).not.toHaveBeenCalled();
    // 前缀仍在缓冲里，真实的 t 落下时才完成和弦
    press('t');
    expect(goTaskCenter).toHaveBeenCalledTimes(1);
  });

  it('scope: session 的快捷键在未打开运行时惰性，打开后生效', () => {
    const toggleRaw = vi.fn();
    const { rerender } = renderShortcuts({ handlers: { 'toggle-raw-log': toggleRaw }, options: { platform: 'mac', sessionOpen: false } });
    expect(press('l').defaultPrevented).toBe(false);
    expect(toggleRaw).not.toHaveBeenCalled();
    rerender({ handlers: { 'toggle-raw-log': toggleRaw }, options: sessionMac });
    press('l');
    expect(toggleRaw).toHaveBeenCalledTimes(1);
  });

  it('when() 为假时快捷键惰性，为真时恢复', () => {
    const archive = vi.fn();
    let allowed = false;
    const definition = shortcutDefinitions.find(item => item.id === 'archive-run')!;
    definition.when = () => allowed;
    try {
      renderShortcuts({ handlers: { 'archive-run': archive }, options: sessionMac });
      press('e');
      expect(archive).not.toHaveBeenCalled();
      allowed = true;
      press('e');
      expect(archive).toHaveBeenCalledTimes(1);
    } finally { delete definition.when; }
  });

  it('enabled: false 时整套快捷键停用，恢复 true 后重新生效', () => {
    const create = vi.fn();
    const palette = vi.fn();
    const { rerender } = renderShortcuts({ handlers: { 'create-task': create, 'command-palette': palette }, options: { platform: 'mac', enabled: false } });
    press('n');
    press('k', { metaKey: true });
    expect(create).not.toHaveBeenCalled();
    expect(palette).not.toHaveBeenCalled();
    rerender({ handlers: { 'create-task': create, 'command-palette': palette }, options: { platform: 'mac', enabled: true } });
    press('n');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('enabled 转 false 会清空未完成的和弦缓冲', () => {
    const goTaskCenter = vi.fn();
    const { rerender } = renderShortcuts({ handlers: { 'go-task-center': goTaskCenter }, options: macOptions });
    press('g');
    rerender({ handlers: { 'go-task-center': goTaskCenter }, options: { platform: 'mac', enabled: false } });
    rerender({ handlers: { 'go-task-center': goTaskCenter }, options: macOptions });
    press('t');
    expect(goTaskCenter).not.toHaveBeenCalled();
  });

  it('卸载后不再响应按键，监听器已移除', () => {
    const create = vi.fn();
    const { unmount } = renderShortcuts({ handlers: { 'create-task': create }, options: macOptions });
    press('n');
    expect(create).toHaveBeenCalledTimes(1);
    unmount();
    expect(press('n').defaultPrevented).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('handler 换成新函数后调用的是新函数，不留旧闭包', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderShortcuts({ handlers: { 'create-task': first }, options: macOptions });
    press('n');
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ handlers: { 'create-task': second }, options: macOptions });
    press('n');
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('handler 从缺失变为提供后立即可用，无需重挂监听', () => {
    const goSettings = vi.fn();
    const { rerender } = renderShortcuts({ handlers: {}, options: macOptions });
    press('g');
    press('s');
    expect(goSettings).not.toHaveBeenCalled();
    rerender({ handlers: { 'go-settings': goSettings }, options: macOptions });
    press('g');
    press('s');
    expect(goSettings).toHaveBeenCalledTimes(1);
  });

  it('g t / g s 和弦按序触发，前缀本身不吞浏览器默认行为', () => {
    const goTaskCenter = vi.fn();
    const goSettings = vi.fn();
    renderShortcuts({ handlers: { 'go-task-center': goTaskCenter, 'go-settings': goSettings }, options: macOptions });
    expect(press('g').defaultPrevented).toBe(false);
    expect(press('t').defaultPrevented).toBe(true);
    expect(goTaskCenter).toHaveBeenCalledTimes(1);
    press('g');
    press('s');
    expect(goSettings).toHaveBeenCalledTimes(1);
  });

  it('和弦超时后前缀作废，第二个键按单键规则重新解释', () => {
    const goTaskCenter = vi.fn();
    const toggleTab = vi.fn();
    renderShortcuts({ handlers: { 'go-task-center': goTaskCenter, 'toggle-detail-tab': toggleTab }, options: sessionMac });
    press('g');
    act(() => { vi.advanceTimersByTime(CHORD_TIMEOUT_MS + 10); });
    press('t');
    expect(goTaskCenter).not.toHaveBeenCalled();
    expect(toggleTab).toHaveBeenCalledTimes(1);
  });

  it('和弦生效期间 t 归和弦，不误触发终端切换', () => {
    const goTaskCenter = vi.fn();
    const toggleTab = vi.fn();
    renderShortcuts({ handlers: { 'go-task-center': goTaskCenter, 'toggle-detail-tab': toggleTab }, options: sessionMac });
    press('g');
    press('t');
    expect(goTaskCenter).toHaveBeenCalledTimes(1);
    expect(toggleTab).not.toHaveBeenCalled();
  });

  it('g 之后按下未定义的键，前缀静默作废且不误触其它单键', () => {
    const goTaskCenter = vi.fn();
    const archive = vi.fn();
    renderShortcuts({ handlers: { 'go-task-center': goTaskCenter, 'archive-run': archive }, options: sessionMac });
    press('g');
    expect(press('e').defaultPrevented).toBe(false);
    expect(archive).not.toHaveBeenCalled();
    expect(goTaskCenter).not.toHaveBeenCalled();
    // 前缀已作废，再单独按 e 应当正常归档
    press('e');
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('没有任何可用和弦时 g 不建立前缀，g s 不会延迟触发', () => {
    const goSettings = vi.fn();
    renderShortcuts({ handlers: {}, options: macOptions });
    press('g');
    press('s');
    expect(goSettings).not.toHaveBeenCalled();
  });

  it('输入框内不建立和弦前缀，g t 留给用户打字', () => {
    const goTaskCenter = vi.fn();
    renderShortcuts({ handlers: { 'go-task-center': goTaskCenter }, options: macOptions });
    const textarea = mountEditable('<textarea aria-label="指令输入"></textarea>');
    press('g', { target: textarea });
    press('t', { target: textarea });
    expect(goTaskCenter).not.toHaveBeenCalled();
  });

  it('? 与 Mod+/ 都能打开帮助面板', () => {
    const toggleHelp = vi.fn();
    renderShortcuts({ handlers: { 'toggle-help': toggleHelp }, options: macOptions });
    press('?', { shiftKey: true });
    expect(toggleHelp).toHaveBeenCalledTimes(1);
    press('/', { metaKey: true });
    expect(toggleHelp).toHaveBeenCalledTimes(2);
  });

  it('Shift+R 重启运行，单独的 r 不触发', () => {
    const restart = vi.fn();
    renderShortcuts({ handlers: { 'restart-run': restart }, options: sessionMac });
    press('r');
    expect(restart).not.toHaveBeenCalled();
    press('R', { shiftKey: true });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('数字键 1–7 切换七个工作台视图', () => {
    const calls: string[] = [];
    const handlers = Object.fromEntries(Object.entries(workbenchViewShortcutIds).map(([view, id]) => [id, () => calls.push(view)]));
    renderShortcuts({ handlers, options: macOptions });
    for (const key of ['1', '2', '3', '4', '5', '6', '7']) press(key);
    expect(calls).toEqual(['all', 'active', 'queued', 'attention', 'failed', 'completed', 'archived']);
  });

  it('不接管 Escape：全局层不吞掉浮层自己的关闭键', () => {
    renderShortcuts({ handlers: Object.fromEntries(shortcutDefinitions.map(definition => [definition.id, () => {}])), options: sessionMac });
    expect(press('Escape').defaultPrevented).toBe(false);
  });

  it('未注入 platform 时按 navigator 探测，仍只认一种 Mod', () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
    const palette = vi.fn();
    renderShortcuts({ handlers: { 'command-palette': palette } });
    press('k', { ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
    press('k', { metaKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
    if (original) Object.defineProperty(window.navigator, 'platform', original);
  });
});
