import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Agent, type Session, type Task } from '../api';
import { NewSessionModal } from './NewSessionModal';

const agent: Agent = { id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' };
const session: Session = { id: 's1', agentId: 'codex', state: 'idle', cwd: '/repo', runId: 'r1', createdAt: '', updatedAt: '' };
const task: Task = { id: 't1', sessionId: 's1', prompt: '修复登录超时', status: 'queued', createdAt: '', updatedAt: '' };

afterEach(() => vi.restoreAllMocks());

describe('NewSessionModal create → dispatch', () => {
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
    expect(create).toHaveBeenCalledWith({ agentId: 'codex', permissionMode: 'full-trust' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('s1', '修复登录超时', 'queue');
  });

  it('PTY 只暴露真实支持的权限姿态，并说明交互确认发生在终端', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    const ptyAgent: Agent = { id: 'claude', name: 'Claude CLI', protocol: 'pty-cli', permissionMode: 'ask' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><NewSessionModal open onClose={() => {}} onCreated={() => {}} agents={[ptyAgent]}/></QueryClientProvider>);
    expect(screen.getByText(/权限确认在终端中完成/)).toBeTruthy();
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
    expect((await screen.findByRole('alert')).textContent).toContain('再次提交只会重试派发');
    await user.click(screen.getByRole('button', { name: '重试派发' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(session, task));
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
