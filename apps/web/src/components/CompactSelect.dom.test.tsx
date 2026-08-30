import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentSelect, CompactSelect } from './CompactSelect';
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
