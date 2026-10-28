// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    const details = await screen.findByLabelText('gpt-5 执行过程');
    (details as HTMLDetailsElement).open = true;
    fireEvent(details, new Event('toggle'));
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
    expect(screen.queryByLabelText('会话来源')).toBeNull();
  });

  it('显示来源话题、群聊和最初发起人，来源链接只跳回飞书', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, sourceContext: {
      channel: 'lark', originAvailable: true,
      chat: { id: 'oc_source', name: '项目讨论', type: 'group', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_source' },
      topic: { id: 'omt_source', title: '打开来源话题', url: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_source' },
      initiator: { id: 'ou_first', name: '小李', type: 'user' }
    } });
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.spyOn(api, 'tasks').mockResolvedValue(tasks);
    renderPage();
    expect(await screen.findByLabelText('会话来源')).toBeTruthy();
    expect(screen.getByText('来源话题')).toBeTruthy();
    expect(screen.getByText('来源群聊')).toBeTruthy();
    expect(screen.getByText('发起人')).toBeTruthy();
    expect(screen.getByText('小李')).toBeTruthy();
    expect(screen.getByRole('link', { name: '打开来源话题' }).getAttribute('href')).toContain('open_thread_id=omt_source');
    expect(screen.getByRole('link', { name: '项目讨论' }).getAttribute('href')).toContain('openChatId=oc_source');
    expect(screen.getAllByRole('link').every(link => link.getAttribute('target') === '_blank' && link.getAttribute('rel') === 'noreferrer')).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it.each([true, false])('没有话题或来源历史时给出明确说明，发起机器人保留身份（originAvailable=%s）', async originAvailable => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, sourceContext: {
      channel: 'lark', originAvailable,
      chat: { id: 'oc_source', name: 'oc_source', type: 'group', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_source' },
      ...(originAvailable ? { initiator: { id: 'ou_bot', name: '告警助手', type: 'bot' as const } } : {})
    } });
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.spyOn(api, 'tasks').mockResolvedValue([]);
    renderPage();
    await screen.findByLabelText('会话来源');
    if (originAvailable) {
      expect(screen.getByText('未记录话题')).toBeTruthy();
      expect(screen.getByText('告警助手（机器人）')).toBeTruthy();
    } else expect(screen.getAllByText('来源记录不可用')).toHaveLength(2);
    expect(screen.queryByRole('link', { name: '打开来源话题' })).toBeNull();
    expect(screen.getByRole('link', { name: 'oc_source' })).toBeTruthy();
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


it('loads shared summaries and reads the complete canonical range only on expansion, preserving read-only controls', async () => {
  vi.spyOn(api, 'session').mockResolvedValue(session);
  vi.spyOn(api, 'tasks').mockResolvedValue([]);
  vi.mocked(api.sessionHistory).mockResolvedValue({ turns: [{ id: 'share-0', firstSequence: 1, lastSequence: 1205, timestamp: '', status: 'completed', prompt: { text: '历史指令', truncated: false }, output: { text: '历史摘要', truncated: false }, toolCount: 0, artifactReferences: [] }], highWaterMark: 1205, liveAfter: 1205 });
  const history = Array.from({ length: 1205 }, (_, index): DockEvent => ({ id: 'share-' + index, sequence: index + 1, timestamp: '', type: 'status', data: {} }));
  const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.filter(event => event.sequence > query!.after! && (!query?.before || event.sequence < query.before)).slice(0, query!.limit));
  renderPage();
  await screen.findByText('历史摘要');
  expect(loader).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '展开完整记录' }));
  await screen.findByText('已加载 1 轮摘要、0 条原始记录');
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(8));
  expect(loader.mock.calls.slice(1).map(call => call[1]?.after)).toEqual([0, 200, 400, 600, 800, 1000, 1200]);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /允许本次|拒绝/ })).toBeNull();
});

it('retries a failed initial shared history read', async () => {
  vi.spyOn(api, 'session').mockResolvedValue(session);
  vi.spyOn(api, 'tasks').mockResolvedValue([]);
  const loader = vi.spyOn(api, 'events').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(events);
  renderPage();
  await screen.findByText(/执行记录加载失败：offline/);
  fireEvent.click(screen.getByRole('button', { name: '重试加载记录' }));
  await screen.findByText('已加载 0 轮摘要、2 条原始记录');
  expect(loader).toHaveBeenCalledTimes(2);
});

beforeEach(() => { vi.spyOn(api, 'sessionHistory').mockResolvedValue({ turns: [], highWaterMark: 0, liveAfter: 0 }); });
