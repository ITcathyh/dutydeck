import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Agent, RunSummary, Session } from '../api';
import { CommandPalette, type CommandAction } from './CommandPalette';

// CommandPalette 是完全受控的展示组件：open / 关闭 与 Cmd-K 由 App 持有。
// 用例盯住三类最容易回归的契约：键盘漫游（跳过禁用项、Home/End、Enter）、
// 任务行的决策信息（文本状态 + 工作区 + Agent + 相对时间），以及「输入后不截断」。

const agents: Agent[] = [
  { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' },
  { id: 'claude-code', name: 'Claude Code', protocol: 'pty-cli', permissionMode: 'ask' }
];
const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  agentId: 'codex',
  state: 'idle',
  cwd: '/repo/dockmux',
  runId: `run-${id}`,
  createdAt: '2026-08-20T00:00:00Z',
  updatedAt: '2026-08-20T00:00:00Z',
  ...overrides
});
const summary = (sessionId: string, prompt: string, queuedCount = 0): RunSummary => ({ sessionId, taskId: `task-${sessionId}`, prompt, status: 'running', queuedCount, updatedAt: '2026-08-20T00:00:00Z' });
const action = (overrides: Partial<CommandAction> = {}): CommandAction => ({ id: 'create', label: '创建任务', hint: '写下目标后立即开始执行', group: '操作', run: () => {}, ...overrides });
const baseProps = { open: true, onClose: () => {}, sessions: [] as Session[], summaries: {} as Record<string, RunSummary>, agents, actions: [] as CommandAction[], onSelectSession: () => {} };
const input = () => screen.getByRole('combobox', { name: '搜索任务与命令' });
const selected = () => screen.getAllByRole('option').find(option => option.getAttribute('aria-selected') === 'true');

describe('CommandPalette 开合与筛选', () => {
  it('open=false 时返回 null，不渲染任何 dialog', () => {
    const { container } = render(<CommandPalette {...baseProps} open={false} actions={[action()]}/>);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开后是 aria-modal 对话框，输入框自动获得焦点', async () => {
    render(<CommandPalette {...baseProps} actions={[action()]}/>);
    const dialog = screen.getByRole('dialog', { name: '搜索任务与命令' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it('关闭后焦点回到打开它的触发器（复用 useDialogFocus）', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>搜索</button><CommandPalette {...baseProps} open={open} onClose={() => setOpen(false)} actions={[action()]}/></>;
    }
    render(<Harness/>);
    const trigger = screen.getByRole('button', { name: '搜索' });
    await user.click(trigger);
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('输入关键词同时筛选任务与命令，中文按子串命中', async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...baseProps} sessions={[session('1'), session('2', { cwd: '/repo/api' })]} summaries={{ '1': summary('1', '修复登录超时'), '2': summary('2', '升级依赖') }} actions={[action(), action({ id: 'lark', label: '绑定飞书 Bot', group: '导航' })]}/>);
    await user.type(input(), '登录');
    expect(screen.getByRole('option', { name: /修复登录超时/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /升级依赖/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /创建任务/ })).toBeNull();
  });

  it('命令可用 keywords 命中，即便 label 里没有该词', async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...baseProps} actions={[action({ keywords: 'new run 新建运行' })]}/>);
    await user.type(input(), '新建');
    expect(screen.getByRole('option', { name: /创建任务/ })).toBeTruthy();
  });

  it('空查询时展示命令，并把最近任务放在有明确标题的分组里', () => {
    render(<CommandPalette {...baseProps} sessions={[session('1'), session('2')]} summaries={{ '1': summary('1', '修复登录超时'), '2': summary('2', '升级依赖') }} actions={[action()]}/>);
    const group = screen.getByRole('group', { name: /最近更新的任务/ });
    expect(within(group).getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('option', { name: /创建任务/ })).toBeTruthy();
    expect(screen.getByText(/按更新时间取前 2 个未归档任务/)).toBeTruthy();
  });

  it('空查询的最近任务分组排除已归档任务，避免把只读历史混进默认预览', () => {
    render(<CommandPalette {...baseProps} sessions={[session('1'), session('2', { archivedAt: '2026-08-29T00:00:00Z' })]} summaries={{ '1': summary('1', '修复登录超时'), '2': summary('2', '历史归档任务') }}/>);
    expect(screen.queryByRole('option', { name: /历史归档任务/ })).toBeNull();
  });

  it('没有匹配时给出可执行的下一步文案，而不是含糊的动词', async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...baseProps} sessions={[session('1')]} summaries={{ '1': summary('1', '修复登录超时') }} actions={[action()]}/>);
    await user.type(input(), '不存在的关键词');
    expect(screen.getByText('没有匹配的任务或命令。换个关键词，或按 Esc 关闭。')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('结果条数写在 aria-live=polite 的状态区域里', async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...baseProps} sessions={[session('1'), session('2', { cwd: '/repo/api' })]} summaries={{ '1': summary('1', 'dockmux 优化'), '2': summary('2', 'api 优化') }} actions={[action()]}/>);
    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('1 个命令，2 个最近任务');
    await user.type(input(), '优化');
    expect(live.textContent).toBe('找到 2 个任务、0 个命令');
  });
});

describe('CommandPalette 键盘导航', () => {
  const keyboardProps = {
    ...baseProps,
    sessions: [session('1'), session('2', { cwd: '/repo/api' })],
    summaries: { '1': summary('1', '修复登录超时'), '2': summary('2', '升级依赖') },
    actions: [action(), action({ id: 'lark', label: '绑定飞书 Bot', group: '导航' })]
  };

  it('ArrowDown / ArrowUp 沿 DOM 顺序移动高亮，并写入 aria-activedescendant', async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...keyboardProps}/>);
    const options = screen.getAllByRole('option');
    expect(selected()).toBe(options[0]);
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0].id);
    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe(options[1]);
    expect(input().getAttribute('aria-activedescendant')).toBe(options[1].id);
    await user.keyboard('{ArrowUp}');
    expect(selected()).toBe(options[0]);
    await user.keyboard('{ArrowUp}');
    expect(selected()).toBe(options.at(-1));
  });

  it('Home / End 跳到首尾项', async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...keyboardProps}/>);
    const options = screen.getAllByRole('option');
    await user.keyboard('{End}');
    expect(selected()).toBe(options.at(-1));
    await user.keyboard('{Home}');
    expect(selected()).toBe(options[0]);
  });

  it('Enter 执行命令项并关闭面板', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette {...keyboardProps} actions={[action({ run })]} onClose={onClose}/>);
    await user.keyboard('{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter 选中任务项时回调 sessionId 并关闭面板', async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette {...keyboardProps} actions={[]} onSelectSession={onSelectSession} onClose={onClose}/>);
    await user.type(input(), '升级依赖');
    await user.keyboard('{Enter}');
    expect(onSelectSession).toHaveBeenCalledWith('2');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape 关闭面板，且不冒泡给外层', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><CommandPalette {...keyboardProps} onClose={onClose}/></div>);
    await vi.waitFor(() => expect(document.activeElement).toBe(input()));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it('禁用命令被键盘跳过、点击不触发，并展示中文不可用原因', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const blocked = action({ id: 'restart', label: '重新运行当前任务', group: '操作', disabled: true, disabledReason: '先选中一个任务，再重新运行', run });
    render(<CommandPalette {...baseProps} actions={[action(), blocked, action({ id: 'lark', label: '绑定飞书 Bot', group: '导航' })]}/>);
    const options = screen.getAllByRole('option');
    expect(screen.getByText('先选中一个任务，再重新运行')).toBeTruthy();
    expect(options[1].getAttribute('aria-disabled')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe(options[2]);
    await user.keyboard('{End}');
    expect(selected()).toBe(options[2]);
    await user.click(options[1]);
    expect(run).not.toHaveBeenCalled();
  });

  it('全部命令都禁用时不把高亮落在不可执行的行上，Enter 也不触发', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette {...baseProps} actions={[action({ disabled: true, disabledReason: '先准备一个可用 Agent，再创建任务', run })]} onClose={onClose}/>);
    expect(selected()).toBeUndefined();
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CommandPalette 任务行信息与全量性', () => {
  it('任务行给出文本状态、工作区、Agent 与相对更新时间（精确时间放在 title 上）', () => {
    render(<CommandPalette {...baseProps} sessions={[session('1', { state: 'waiting_for_permission', cwd: '/repo/api', agentId: 'claude-code', updatedAt: '2026-08-20T03:00:00Z' })]} summaries={{ '1': summary('1', '修复登录超时', 2) }}/>);
    const option = screen.getByRole('option', { name: /修复登录超时/ });
    expect(option.textContent).toContain('等待授权');
    expect(option.textContent).toContain('api');
    expect(option.textContent).toContain('Claude Code');
    expect(option.textContent).toContain('更新于');
    expect(option.textContent).toContain('待执行指令 2 条');
    expect(option.textContent).toContain('需要你授权 Agent 执行下一步操作');
    expect(within(option).getByTitle(new Date('2026-08-20T03:00:00Z').toLocaleString('zh-CN'))).toBeTruthy();
  });

  it('任务行说明命中的字段，用户不必猜为什么这条会出现', async () => {
    const user = userEvent.setup();
    render(<CommandPalette {...baseProps} sessions={[session('1', { cwd: '/repo/dockmux' })]} summaries={{ '1': summary('1', '修复登录超时') }}/>);
    await user.type(input(), 'dockmux');
    expect(screen.getByRole('option', { name: /修复登录超时/ }).textContent).toContain('命中 工作区');
    await user.clear(input());
    await user.type(input(), '登录 dockmux');
    expect(screen.getByRole('option', { name: /修复登录超时/ }).textContent).toContain('命中 任务目标、工作区');
  });

  it('输入关键词后展示全部匹配任务，不截断为最近若干条', async () => {
    const user = userEvent.setup();
    const sessions = Array.from({ length: 18 }, (_, index) => session(`s${index}`, { cwd: '/repo/dockmux' }));
    const summaries = Object.fromEntries(sessions.map((item, index) => [item.id, summary(item.id, `dockmux 任务 ${index}`)]));
    render(<CommandPalette {...baseProps} sessions={sessions} summaries={summaries}/>);
    expect(screen.getAllByRole('option')).toHaveLength(5);
    await user.type(input(), 'dockmux');
    expect(screen.getAllByRole('option')).toHaveLength(18);
    expect(screen.getByText(/全部 18 条匹配都在下面，没有截断/)).toBeTruthy();
  });

  it('点击任务行回调 sessionId；每个选项都有至少 40px 触控高度', async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();
    render(<CommandPalette {...baseProps} sessions={[session('1')]} summaries={{ '1': summary('1', '修复登录超时') }} actions={[action()]} onSelectSession={onSelectSession}/>);
    for (const option of screen.getAllByRole('option')) expect(option.className).toContain('min-h-10');
    await user.click(screen.getByRole('option', { name: /修复登录超时/ }));
    expect(onSelectSession).toHaveBeenCalledWith('1');
  });

  it('没有任务目标时用 fallback 标题，而不是空白行', () => {
    render(<CommandPalette {...baseProps} sessions={[session('1', { source: 'lark' })]}/>);
    expect(screen.getByRole('option', { name: /来自飞书的任务/ })).toBeTruthy();
  });

  it('关闭后再次打开会清空上一次的查询词', async () => {
    const user = userEvent.setup();
    const props = { ...baseProps, sessions: [session('1')], summaries: { '1': summary('1', '修复登录超时') } };
    const { rerender } = render(<CommandPalette {...props}/>);
    await user.type(input(), '登录');
    expect((input() as HTMLInputElement).value).toBe('登录');
    rerender(<CommandPalette {...props} open={false}/>);
    rerender(<CommandPalette {...props} open/>);
    expect((input() as HTMLInputElement).value).toBe('');
  });
});
