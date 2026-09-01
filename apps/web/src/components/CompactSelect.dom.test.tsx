import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentSelect, CompactSelect } from './CompactSelect';
import { Dialog, Field } from './primitives';
import type { Agent } from '../api';

// CompactSelect 是自绘下拉（不是原生 <select>），开合状态、外点关闭、
// 空列表禁用这三件事全靠自己实现，因此每一条都可能悄悄回归。

const options = [
  { value: 'a', label: '选项 A' },
  { value: 'b', label: '选项 B', meta: 'model-b' }
];
const baseProps = { options, value: 'a', placeholder: '选择', disabledText: '不可用', onChange: () => {} };
const trigger = () => screen.getByRole('button', { expanded: false }) ?? screen.getByRole('button');

describe('CompactSelect 开合与选择', () => {
  it('默认收起：aria-expanded=false 且没有 listbox', () => {
    render(<CompactSelect {...baseProps}/>);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('点击展开 listbox，再点收起', async () => {
    const user = userEvent.setup();
    render(<CompactSelect {...baseProps}/>);
    await user.click(screen.getByRole('button', { name: /选项 A/ }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: /选项 A/ }).getAttribute('aria-expanded')).toBe('true');
    await user.click(screen.getByRole('button', { name: /选项 A/ }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('选中项标记 aria-selected，其它项为 false', async () => {
    const user = userEvent.setup();
    render(<CompactSelect {...baseProps} value="b"/>);
    await user.click(screen.getByRole('button', { name: /选项 B/ }));
    const items = screen.getAllByRole('option');
    expect(items.find(item => item.textContent?.includes('选项 B'))?.getAttribute('aria-selected')).toBe('true');
    expect(items.find(item => item.textContent?.includes('选项 A'))?.getAttribute('aria-selected')).toBe('false');
  });

  it('点选某项 → 回调 value 并自动收起面板', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CompactSelect {...baseProps} onChange={onChange}/>);
    await user.click(screen.getByRole('button', { name: /选项 A/ }));
    await user.click(within(screen.getByRole('listbox')).getByText('选项 B'));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('点击组件外部关闭面板（pointerdown 监听器生效）', async () => {
    const user = userEvent.setup();
    render(<><div data-testid="outside">外部</div><CompactSelect {...baseProps}/></>);
    await user.click(screen.getByRole('button', { name: /选项 A/ }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    await user.click(screen.getByTestId('outside'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('supports Arrow/Home/End navigation and Enter selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CompactSelect {...baseProps} onChange={onChange}/>);
    const button = screen.getByRole('button', { name: /选项 A/ });
    button.focus();
    await user.keyboard('{ArrowDown}');
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('option', { name: /选项 A/ })));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /选项 B/ }));
    await user.keyboard('{Home}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('Escape closes only the listbox and restores its trigger', async () => {
    const user = userEvent.setup();
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><CompactSelect {...baseProps}/></div>);
    const button = screen.getByRole('button', { name: /选项 A/ });
    await user.click(button);
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('option', { name: /选项 A/ })));
    parentKeyDown.mockClear();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(parentKeyDown).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
  });
});

/*
  契约 §8.1 的核心场景：模态里套浮层，一次 Escape 只关最上面一层。

  这里守的是一个真实事故形状——用户在弹层里填了一半表单、点开某个下拉、按 Escape
  想收起下拉，结果整张表单连同已填内容一起消失。CompactSelect 为此同时挂了
  stopPropagation（挡 React 合成事件冒泡）和 useEscapeKey（在 document 的 LIFO 栈里占位），
  两条路径覆盖的情形不同，下面两条用例分别守着。
*/
describe('CompactSelect 嵌在 Dialog 里的 Escape 语义（契约 §8.1）', () => {
  function Harness() {
    const [dialogOpen, setDialogOpen] = useState(true);
    return <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} label="外层弹层">
      <input aria-label="填了一半的输入框"/>
      <CompactSelect {...baseProps}/>
    </Dialog>;
  }

  it('焦点在选项上时：Escape 只收 listbox，Dialog 不关；再按一次才关 Dialog', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    await user.click(screen.getByRole('button', { name: /选项 A/ }));
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('option', { name: /选项 A/ })));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // stopPropagation 覆盖不到的那个洞：listbox 开着，但焦点已经挪到弹层里别处。
  // 这时没有任何合成事件经过 CompactSelect，Escape 直接打到 document——
  // 只有 useEscapeKey 的 LIFO 栈能保住这张表单。
  it('焦点已挪到弹层内别处时：Escape 仍然先收 listbox，不丢表单', async () => {
    const user = userEvent.setup();
    render(<Harness/>);
    await user.click(screen.getByRole('button', { name: /选项 A/ }));
    expect(screen.getByRole('listbox')).toBeTruthy();

    screen.getByLabelText('填了一半的输入框').focus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('CompactSelect 与 Field 的无障碍关联', () => {
  it('套在 Field 里时触发器 aria-describedby 指向 hint 文本', () => {
    render(<Field label="操作权限" hint="遇到受控操作时询问"><CompactSelect {...baseProps}/></Field>);
    const describedBy = screen.getByRole('button', { name: /选项 A/ }).getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe('遇到受控操作时询问');
  });
});

describe('CompactSelect 空态与禁用', () => {
  it('无选项 → 展示 disabledText 且按钮 disabled，点击不展开', async () => {
    const user = userEvent.setup();
    render(<CompactSelect {...baseProps} options={[]}/>);
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('不可用');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('value 不在 options 中 → 展示 placeholder 而非空白', () => {
    render(<CompactSelect {...baseProps} value="不存在"/>);
    expect(screen.getByRole('button').textContent).toContain('选择');
  });

  it('disabled=true 时即便有选项也不能展开', async () => {
    const user = userEvent.setup();
    render(<CompactSelect {...baseProps} disabled/>);
    await user.click(screen.getByRole('button'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('选中项有 meta 时在触发按钮上一并展示（模型 id 这类副标题）', () => {
    render(<CompactSelect {...baseProps} value="b"/>);
    expect(screen.getByRole('button').textContent).toContain('model-b');
  });
});

describe('AgentSelect', () => {
  const agents: Agent[] = [
    { id: 'codex', name: 'Codex', version: '1.2.3', protocol: 'acp', permissionMode: 'full-trust' },
    { id: 'claude-code', name: 'Claude Code', protocol: 'pty', permissionMode: 'full-trust' }
  ];

  it('用 agent.name 做标签、version 做 meta', async () => {
    const user = userEvent.setup();
    render(<AgentSelect agents={agents} value="codex" onChange={() => {}}/>);
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('Codex');
    expect(button.textContent).toContain('1.2.3');
    await user.click(button);
    expect(within(screen.getByRole('listbox')).getByText('Claude Code')).toBeTruthy();
  });

  it('选择 agent 回调其 id（不是 name）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AgentSelect agents={agents} value="codex" onChange={onChange}/>);
    await user.click(screen.getByRole('button'));
    await user.click(within(screen.getByRole('listbox')).getByText('Claude Code'));
    expect(onChange).toHaveBeenCalledWith('claude-code');
  });

  it('未扫描到 agent → 「未扫描到可用 Agent」', () => {
    render(<AgentSelect agents={[]} value="" onChange={() => {}}/>);
    expect(screen.getByRole('button').textContent).toContain('未扫描到可用 Agent');
  });
});
