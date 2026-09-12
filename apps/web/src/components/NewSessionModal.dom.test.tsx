import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Agent, type Session, type Task } from '../api';
import { NewSessionModal } from './NewSessionModal';

const agent: Agent = { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' };
const session: Session = { id: 's1', agentId: 'codex', state: 'idle', cwd: '/repo', runId: 'r1', createdAt: '', updatedAt: '' };
const task: Task = { id: 't1', sessionId: 's1', prompt: '修复登录超时', status: 'queued', createdAt: '', updatedAt: '' };

afterEach(() => vi.restoreAllMocks());

describe('NewSessionModal create → dispatch', () => {
  it('支持用 Escape 取消创建', async () => {
    const onClose = vi.fn();
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><NewSessionModal open onClose={onClose} onCreated={() => {}} agents={[agent]}/></QueryClientProvider>);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('必须填写目标，并在创建 Session 后立即派发首个任务', async () => {
    const user = userEvent.setup(); const onCreated = vi.fn();
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const create = vi.spyOn(api, 'create').mockResolvedValue(session);
    const send = vi.spyOn(api, 'send').mockResolvedValue({ accepted: true, task });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><NewSessionModal open onClose={() => {}} onCreated={onCreated} agents={[agent]}/></QueryClientProvider>);
    const submit = screen.getByRole('button', { name: '创建并执行' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText('任务目标'), '修复登录超时');
    await user.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(session, task));
    expect(create).toHaveBeenCalledWith({ agentId: 'codex', permissionMode: 'ask', workspaceMode: 'worktree' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('s1', '修复登录超时', 'queue');
  });

  it.each(['codex', 'claude-code'])('submits the Agent selected by its source card: %s', async initialAgentId => {
    const agents = [agent, { ...agent, id: 'claude-code', name: 'Claude Code' }];
    const created = { ...session, agentId: initialAgentId };
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const create = vi.spyOn(api, 'create').mockResolvedValue(created);
    vi.spyOn(api, 'send').mockResolvedValue({ accepted: true, task });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><NewSessionModal open initialAgentId={initialAgentId} agents={agents} onClose={() => {}} onCreated={() => {}}/></QueryClientProvider>);
    expect(screen.getByRole('button', { name: initialAgentId === 'codex' ? /Codex/ : /Claude Code/ })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('任务目标'), '修复登录超时');
    await userEvent.click(screen.getByRole('button', { name: '创建并执行' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ agentId: initialAgentId, permissionMode: 'ask', workspaceMode: 'worktree' }));
  });

  it('PTY 只暴露真实支持的权限姿态，并说明交互确认发生在终端', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const ptyAgent: Agent = { id: 'claude', name: 'Claude CLI', protocol: 'pty-cli', permissionMode: 'ask' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><NewSessionModal open onClose={() => {}} onCreated={() => {}} agents={[ptyAgent]}/></QueryClientProvider>);
    expect(screen.getByText(/操作确认在终端中完成/)).toBeTruthy();
    await user.click(screen.getByText('交互确认'));
    expect(screen.queryByText('自动读取')).toBeNull();
    expect(screen.queryByText('全部拒绝')).toBeNull();
    expect(screen.getByText('完全信任')).toBeTruthy();
  });

  it('旧 PTY transport 无法兑现权限语义时禁止创建', async () => {
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const legacyPty: Agent = { id: 'legacy', name: 'Legacy PTY', protocol: 'pty', permissionMode: 'ask' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><NewSessionModal open onClose={() => {}} onCreated={() => {}} agents={[legacyPty]}/></QueryClientProvider>);
    expect((await screen.findByRole('alert')).textContent).toMatch(/无法提供可靠的权限控制/);
    expect((screen.getByRole('button', { name: '创建并执行' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('派发失败后重试复用已创建 Session，避免重复创建', async () => {
    const user = userEvent.setup(); const onCreated = vi.fn();
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const create = vi.spyOn(api, 'create').mockResolvedValue(session);
    const send = vi.spyOn(api, 'send').mockRejectedValueOnce(new Error('网络断开')).mockResolvedValueOnce({ accepted: true, task });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><NewSessionModal open onClose={() => {}} onCreated={onCreated} agents={[agent]}/></QueryClientProvider>);
    await user.type(screen.getByLabelText('任务目标'), '修复登录超时');
    await user.click(screen.getByRole('button', { name: '创建并执行' }));
    expect((await screen.findByRole('alert')).textContent).toContain('不会重复创建任务');
    await user.click(screen.getByRole('button', { name: '重试发送' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(session, task));
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('没有 Agent 时不会发送无效创建请求，并引导到添加方法', async () => {
    const onOpenAgentSetup = vi.fn();
    const create = vi.spyOn(api, 'create');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><NewSessionModal open onClose={() => {}} onOpenAgentSetup={onOpenAgentSetup} onCreated={() => {}} agents={[]}/></QueryClientProvider>);
    expect(screen.getByRole('dialog', { name: '需要先准备 Agent' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '查看添加方法' }));
    expect(onOpenAgentSetup).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('完全信任必须显式确认后才能创建', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const trusted: Agent = { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><NewSessionModal open onClose={() => {}} onCreated={() => {}} agents={[trusted]}/></QueryClientProvider>);
    await user.type(screen.getByLabelText('任务目标'), '执行高权限任务');
    const submit = screen.getByRole('button', { name: '创建并执行' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /确认允许 Agent 直接操作/ }));
    expect(submit.disabled).toBe(false);
  });
});

describe('NewSessionModal 弹层外壳（契约 §7 / §8.1）', () => {
  const renderModal = (props: Partial<Parameters<typeof NewSessionModal>[0]> = {}) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={client}><NewSessionModal open onClose={() => {}} onCreated={() => {}} agents={[agent]} {...props}/></QueryClientProvider>);
  };

  it('portal 到 document.body，不留在调用方的组件树里', async () => {
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const { container } = renderModal();
    const dialog = await screen.findByRole('dialog', { name: '创建新任务' });
    // 就地渲染时弹层会继承祖先的 transform / overflow / stacking context，
    // 那是 5 档手工 z-index 的根因；portal 之后 container 里应当什么都不剩。
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.contains(dialog)).toBe(true);
  });

  /*
    契约 §8.1 的事故形状：用户填了一半目标、点开 Agent 选择器、按 Escape 想收起下拉，
    结果整张表单连同已填内容一起消失。Escape 必须只关最上面那一层。
  */
  it('下拉展开时 Escape 只收下拉，表单与已填内容都还在；再按一次才关弹层', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    renderModal({ onClose });

    await user.type(screen.getByLabelText('任务目标'), '修复登录超时');
    await user.click(screen.getByRole('button', { name: /Codex/ }));
    expect(screen.getByRole('listbox')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: '创建新任务' })).toBeTruthy();
    expect((screen.getByLabelText('任务目标') as HTMLTextAreaElement).value).toBe('修复登录超时');
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('提交进行中时 Escape 不关闭弹层，避免把已发出的写操作丢在半路', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    vi.spyOn(api, 'create').mockResolvedValue(session);
    vi.spyOn(api, 'send').mockReturnValue(new Promise(() => {}));
    const { baseElement } = renderModal({ onClose });

    await user.type(screen.getByLabelText('任务目标'), '修复登录超时');
    await user.click(screen.getByRole('button', { name: '创建并执行' }));
    // Session 已建好、目标还挂在网络上：这一刻按 Escape 最容易把写操作丢在半路。
    // （提交按钮此时已改口播「重试发送」，所以按 type 定位而不是按名字。）
    const submit = baseElement.querySelector('button[type="submit"]') as HTMLButtonElement;
    await waitFor(() => expect(submit.getAttribute('aria-busy')).toBe('true'));

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '创建新任务' })).toBeTruthy();
  });
});
