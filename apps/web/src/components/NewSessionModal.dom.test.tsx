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
    expect(create).toHaveBeenCalledWith({ agentId: 'codex', permissionMode: 'ask' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('s1', '修复登录超时', 'queue');
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
