// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError, type DockEvent, type Session, type Task } from '../api';
import { SharedSessionPage } from './SharedSessionPage';

vi.mock('../useSessionStream', () => ({ useSessionStream: () => 'open' }));

const session: Session = { id: 'ses_1', agentId: 'codex', model: 'gpt-5', state: 'waiting_permission', cwd: '/repo', runId: 'run-1', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:05Z' };
const tasks: Task[] = [{ id: 'task-1', sessionId: 'ses_1', prompt: '修复登录页', status: 'running', createdAt: '2026-09-25T00:00:01Z', updatedAt: '2026-09-25T00:00:01Z' }];
const events: DockEvent[] = [
  { id: 'e1', sequence: 1, type: 'text', timestamp: '2026-09-25T00:00:02Z', data: { role: 'assistant', text: '已定位到登录表单' } },
  { id: 'e2', sequence: 2, type: 'permission_request', timestamp: '2026-09-25T00:00:03Z', data: { id: 'permission-1', title: '写入配置文件', status: 'pending' } }
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SharedSessionPage sessionId="ses_1"/></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SharedSessionPage', () => {
  it('只读显示单个任务的标题、状态和执行记录，没有输入框、导航和审批按钮', async () => {
    const sessionRead = vi.spyOn(api, 'session').mockResolvedValue(session);
    vi.spyOn(api, 'events').mockResolvedValue(events);
    vi.spyOn(api, 'tasks').mockResolvedValue(tasks);
    const sessions = vi.spyOn(api, 'sessions');
    renderPage();
    expect(await screen.findByText('已定位到登录表单')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '修复登录页' })).toBeTruthy();
    expect(screen.getByText('gpt-5 · 只读查看')).toBeTruthy();
    expect(screen.getByText('写入配置文件')).toBeTruthy();
    expect(screen.getByText('等待当前操作者处理')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /允许本次|拒绝/ })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(sessionRead).toHaveBeenCalledWith('ses_1');
    expect(sessions).not.toHaveBeenCalled();
  });

  it('分享 token 不对或任务不存在时只提示链接失效，不给工作台入口', async () => {
    vi.spyOn(api, 'session').mockRejectedValue(new ApiError('Authentication required', 'UNAUTHORIZED', 401));
    const eventsRead = vi.spyOn(api, 'events');
    renderPage();
    expect(await screen.findByText('链接无效或已失效')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(eventsRead).not.toHaveBeenCalled();
  });
});
