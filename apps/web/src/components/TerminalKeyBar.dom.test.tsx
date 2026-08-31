import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalKeyBar } from './TerminalKeyBar';

// 手机键盘没有 Esc / Ctrl / Tab / 方向键，这条快捷键条是移动端唯一的控制序列入口。
// 用例盯三件事：发出去的字节对不对、触控目标够不够大、折叠与停靠边有没有记住。
// xterm.js 在 jsdom 里跑不起来，所以键条被拆成纯展示组件单独测，TerminalView 不进 jsdom。

const toolbar = () => screen.getByRole('toolbar', { name: '终端快捷键' });

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

describe('TerminalKeyBar 控制序列', () => {
  it.each([
    ['发送 Esc 退出当前模式', '\x1b'],
    ['发送 Tab 补全', '\t'],
    ['发送 Ctrl-C 中断当前命令', '\x03'],
    ['发送 Ctrl-D 结束输入', '\x04'],
    ['方向键上，翻出上一条历史命令', '\x1b[A'],
    ['方向键下，翻到下一条历史命令', '\x1b[B'],
    ['方向键左，光标左移', '\x1b[D'],
    ['方向键右，光标右移', '\x1b[C'],
    ['发送回车执行', '\r']
  ])('%s → 写入 PTY 的字节精确匹配', async (label, data) => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(<TerminalKeyBar onKey={onKey}/>);
    await user.click(screen.getByRole('button', { name: label }));
    expect(onKey).toHaveBeenCalledWith(data);
  });

  it('Ctrl-C / Ctrl-D 是一键直达，不需要先点粘滞修饰键', () => {
    render(<TerminalKeyBar onKey={vi.fn()}/>);
    expect(screen.getByRole('button', { name: '发送 Ctrl-C 中断当前命令' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送 Ctrl-D 结束输入' })).toBeTruthy();
  });

  it.each([
    ['发送 Ctrl-Z 把当前命令转到后台', '\x1a'],
    ['发送 Ctrl-L 清屏', '\x0c'],
    ['发送 Ctrl-R 反向搜索历史命令', '\x12'],
    ['发送 Home 跳到行首', '\x1b[H'],
    ['发送 End 跳到行尾', '\x1b[F'],
    ['发送 PgUp 向上翻页', '\x1b[5~'],
    ['发送 PgDn 向下翻页', '\x1b[6~']
  ])('次级行 %s → 字节精确匹配', async (label, data) => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(<TerminalKeyBar onKey={onKey}/>);
    expect(screen.queryByRole('button', { name: label })).toBeNull();
    await user.click(screen.getByRole('button', { name: /展开更多按键/ }));
    await user.click(screen.getByRole('button', { name: label }));
    expect(onKey).toHaveBeenCalledWith(data);
  });

  it('按下时 preventDefault，焦点留在终端里（软键盘不收起）', () => {
    render(<TerminalKeyBar onKey={vi.fn()}/>);
    const key = screen.getByRole('button', { name: '发送 Ctrl-C 中断当前命令' });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    key.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });
});

describe('TerminalKeyBar 触控目标与无障碍', () => {
  it('每颗按键都是 44px 起的真实 button，带简体中文 aria-label', () => {
    render(<TerminalKeyBar onKey={vi.fn()}/>);
    const keys = screen.getAllByRole('button');
    expect(keys.length).toBeGreaterThanOrEqual(9);
    for (const key of keys) {
      expect(key.tagName).toBe('BUTTON');
      expect(key.getAttribute('type')).toBe('button');
      // min-h-11 / min-w-11 = 2.75rem = 44px，高频移动操作的触控下限
      expect(key.className).toContain('min-h-11');
      expect(key.className).toContain('min-w-11');
      expect((key.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    }
  });

  it('整条键条是带名字的 toolbar 区域', () => {
    render(<TerminalKeyBar onKey={vi.fn()}/>);
    expect(toolbar()).toBeTruthy();
  });

  it('安全区内边距避开 iPhone home 指示条', () => {
    const { container } = render(<TerminalKeyBar onKey={vi.fn()}/>);
    expect(container.firstElementChild!.className).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]');
  });
});

describe('TerminalKeyBar 折叠与停靠', () => {
  it('折叠按钮带 aria-expanded，收起后按键消失、只留展开入口', async () => {
    const user = userEvent.setup();
    render(<TerminalKeyBar onKey={vi.fn()}/>);
    const toggle = screen.getByRole('button', { name: '收起终端快捷键条' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.click(toggle);
    expect(screen.queryByRole('button', { name: '发送 Ctrl-C 中断当前命令' })).toBeNull();
    const expand = screen.getByRole('button', { name: '展开终端快捷键条' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    await user.click(expand);
    expect(screen.getByRole('button', { name: '发送 Ctrl-C 中断当前命令' })).toBeTruthy();
  });

  it('折叠状态写入 localStorage，重新挂载后保持收起', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TerminalKeyBar onKey={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: '收起终端快捷键条' }));
    expect(window.localStorage.getItem('dockmux.terminal_key_bar.collapsed.v1')).toBe('1');
    unmount();
    render(<TerminalKeyBar onKey={vi.fn()}/>);
    expect(screen.getByRole('button', { name: '展开终端快捷键条' })).toBeTruthy();
  });

  it('默认停靠右侧，点「移到左侧」后换边并持久化', async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<TerminalKeyBar onKey={vi.fn()}/>);
    expect(container.firstElementChild!.className).toContain('right-0');
    await user.click(screen.getByRole('button', { name: '把快捷键条移到左侧' }));
    expect(container.firstElementChild!.className).toContain('left-0');
    expect(window.localStorage.getItem('dockmux.terminal_key_bar.side.v1')).toBe('left');
    unmount();
    const second = render(<TerminalKeyBar onKey={vi.fn()}/>);
    expect(second.container.firstElementChild!.className).toContain('left-0');
    expect(screen.getByRole('button', { name: '把快捷键条移到右侧' })).toBeTruthy();
  });

  it('localStorage 抛异常（隐私模式）时仍能渲染并操作，不冒泡异常', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('私密浏览禁止访问'); });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('私密浏览禁止访问'); });
    const onKey = vi.fn();
    render(<TerminalKeyBar onKey={onKey}/>);
    // 读不到偏好就按默认值来：展开 + 靠右
    await user.click(screen.getByRole('button', { name: '把快捷键条移到左侧' }));
    await user.click(screen.getByRole('button', { name: '发送 Ctrl-C 中断当前命令' }));
    expect(onKey).toHaveBeenCalledWith('\x03');
  });
});

describe('TerminalKeyBar 选择模式', () => {
  it('提供选择开关：默认关（拖动滚动），点开后 aria-pressed 置位', async () => {
    const user = userEvent.setup();
    const onSelectModeChange = vi.fn();
    const { rerender } = render(<TerminalKeyBar onKey={vi.fn()} selectMode={false} onSelectModeChange={onSelectModeChange}/>);
    const toggle = screen.getByRole('button', { name: '进入选择模式，拖动可选中文字复制' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(onSelectModeChange).toHaveBeenCalledWith(true);
    rerender(<TerminalKeyBar onKey={vi.fn()} selectMode onSelectModeChange={onSelectModeChange}/>);
    expect(screen.getByRole('button', { name: '退出选择模式，恢复拖动滚动' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('不传 onSelectModeChange 时不渲染选择开关', () => {
    render(<TerminalKeyBar onKey={vi.fn()}/>);
    expect(screen.queryByRole('button', { name: /选择模式/ })).toBeNull();
  });
});
