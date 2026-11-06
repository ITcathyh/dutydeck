// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError, type DockEvent, type HistoryTurnSummary, type Session, type Task } from '../api';
import { SharedSessionPage } from './SharedSessionPage';
import { ToolCard } from './ToolCard';
import { getTimelineReadingState } from '../timeline-reading-state';

vi.mock('../useSessionStream', () => ({ useSessionStream: () => 'open' }));

const session: Session = { id: 'ses_1', agentId: 'codex', model: 'gpt-5', state: 'waiting_permission', cwd: '/repo', runId: 'run-1', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:05Z' };
const tasks: Task[] = [{ id: 'task-1', sessionId: 'ses_1', prompt: '修复登录页', status: 'running', createdAt: '2026-09-25T00:00:01Z', updatedAt: '2026-09-25T00:00:01Z' }];
const events: DockEvent[] = [
  { id: 'e1', sequence: 1, type: 'text', timestamp: '2026-09-25T00:00:02Z', data: { role: 'assistant', text: '已定位到登录表单' } },
  { id: 'e2', sequence: 2, type: 'permission_request', timestamp: '2026-09-25T00:00:03Z', data: { id: 'permission-1', title: '写入配置文件', status: 'pending' } }
];

function renderPage(sessionId = 'ses_1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><SharedSessionPage sessionId={sessionId}/></QueryClientProvider>) };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SharedSessionPage', () => {
  it('只读显示单个任务的标题、状态和执行记录，没有输入框、导航和审批按钮', async () => {
    const sessionRead = vi.spyOn(api, 'session').mockResolvedValue(session);
    vi.spyOn(api, 'events').mockResolvedValue(events);
    vi.spyOn(api, 'tasks').mockResolvedValue(tasks);
    const sessions = vi.spyOn(api, 'sessions');
    renderPage();
    await screen.findByLabelText('gpt-5 执行过程');
    fireEvent.click(screen.getByRole('button', { name: /^执行过程/ }));
    expect(await screen.findByText('已定位到登录表单')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '修复登录页' })).toBeTruthy();
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
    // 话题标题是泛称时显示「飞书话题」；宽屏侧栏、窄屏胶囊和「回到飞书话题」都跳回同一个话题。
    expect(screen.queryByText('打开来源话题')).toBeNull();
    const topicLinks = screen.getAllByRole('link', { name: /飞书话题/ });
    expect(topicLinks.length).toBe(3);
    expect(topicLinks.every(link => link.getAttribute('href')?.includes('open_thread_id=omt_source'))).toBe(true);
    expect(screen.getAllByRole('link', { name: /项目讨论/ }).every(link => link.getAttribute('href')?.includes('openChatId=oc_source'))).toBe(true);
    expect(screen.getByText('群聊')).toBeTruthy();
    expect(screen.getByText('发起人')).toBeTruthy();
    expect(screen.getByText('小李 发起')).toBeTruthy();
    expect(screen.getByText('小李')).toBeTruthy();
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
      // 窄屏不放不能点的「未记录话题」胶囊，只有侧栏说明。
      expect(screen.getAllByText('未记录话题')).toHaveLength(1);
      expect(screen.getByText('告警助手（机器人）')).toBeTruthy();
      expect(screen.getByText('告警助手（机器人） 发起')).toBeTruthy();
    } else {
      expect(screen.getAllByText('来源记录不可用')).toHaveLength(2);
      expect(screen.queryByText(/发起$/)).toBeNull();
    }
    expect(screen.queryByRole('link', { name: /话题/ })).toBeNull();
    expect(screen.getAllByRole('link', { name: /oc_source/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: '群聊' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '回到群聊' })).toBeTruthy();
  });

  it('名称读不到、只剩飞书 ID 时：眉标不写 ID，侧栏中间省略并把全文放进 title，头像用人形图标', async () => {
    const bot = 'ou_52924837a6481b6915b9433c85eac00e', chat = 'oc_71d458e4cd3ab9da8eb14f81ffbf371e';
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, sourceContext: {
      channel: 'lark', originAvailable: true,
      chat: { id: chat, name: chat, type: 'group', url: `https://applink.feishu.cn/client/chat/open?openChatId=${chat}` },
      initiator: { id: bot, name: bot, type: 'bot' }
    } });
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.spyOn(api, 'tasks').mockResolvedValue([]);
    const { container } = renderPage();
    await screen.findByLabelText('会话来源');
    expect(container.querySelector('.share-eyebrow')?.textContent).toBe('提问机器人发起');
    expect(screen.getByText('ou_5292…c00e（机器人）').closest('[title]')?.getAttribute('title')).toBe(bot);
    expect(screen.getByText('oc_71d4…371e').closest('[title]')?.getAttribute('title')).toBe(chat);
    expect(screen.getByRole('link', { name: '群聊' }).getAttribute('title')).toBe(chat);
    expect(container.querySelector('.share-avatar svg')).toBeTruthy();
    expect(document.body.textContent).not.toContain(bot);
    expect(document.body.textContent).not.toContain(chat);
  });

  it('只有 ID 的真人发起人：眉标只写「提问」', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, sourceContext: {
      channel: 'lark', originAvailable: true,
      chat: { id: 'oc_dev', name: 'dev', type: 'group', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_dev' },
      initiator: { id: 'ou_0123456789abcdef', name: 'ou_0123456789abcdef', type: 'user' }
    } });
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.spyOn(api, 'tasks').mockResolvedValue([]);
    const { container } = renderPage();
    await screen.findByLabelText('会话来源');
    expect(container.querySelector('.share-eyebrow')?.textContent).toBe('提问');
    expect(screen.getByRole('link', { name: 'dev 群' })).toBeTruthy();
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
  fireEvent.click(screen.getByRole('button', { name: /^执行过程/ }));
  await screen.findByText('已加载 1 轮摘要、0 条原始记录');
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
  expect(loader.mock.calls.slice(1).map(call => call[1]?.after)).toEqual([0, 1000]);
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

beforeEach(() => {
  vi.spyOn(api, 'sessionHistory').mockResolvedValue({ turns: [], highWaterMark: 0, liveAfter: 0 });
  // 阅读状态按会话保存在模块里；每条用例都像第一次打开分享页：不跟随、停在顶部、「更早 N 轮」收起。
  const reading = getTimelineReadingState('ses_1');
  Object.assign(reading, { following: false, scrollTop: 0, anchor: undefined });
  reading.disclosures.delete('share-earlier');
});

const sourceContext = {
  channel: 'lark' as const, originAvailable: true,
  chat: { id: 'oc_dev', name: 'dev', type: 'group' as const, url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_dev' },
  topic: { id: 'omt_dev', title: '打开来源话题', url: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_dev' },
  initiator: { id: 'ou_dev', name: '黄宇航', type: 'user' as const }
};
const conclusion = [
  '有更新数据：**两者不是同一时期、同一口径。**', '', '截至今天，查到的主要结果：', '',
  '| # | 指标 | 数据 | 时间与来源 |', '|---|---|---:|---|',
  '| 1 | 抖音 DAU | **7.14 亿** | **2026 年 7 月**，[报道](https://finance.sina.com.cn/a) |',
  '| 2 | 群发消息渗透 | **6.50%** | 同一内部周报 |', '', '- **19.64%** 不等于整体渗透率'
].join('\n');
const summaryTurn = (id: string, prompt: string, output: string, timestamp: string, extra: Partial<HistoryTurnSummary> = {}): HistoryTurnSummary => ({
  id, taskId: `task-${id}`, firstSequence: 1, lastSequence: 10, timestamp, status: 'completed', prompt: { text: prompt, truncated: false }, output: { text: output, truncated: false }, toolCount: 3, artifactReferences: [], ...extra
});
const completedTask = (id: string, prompt: string, createdAt: string): Task => ({ id: `task-${id}`, sessionId: 'ses_1', prompt, status: 'completed', createdAt, updatedAt: createdAt });

describe('分享页结论呈现', () => {
  it('完成的单轮：导语放大、表格带表头标签、外链新窗口打开，没有工作台内部字样，节律条用摘要里的真实调用', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'idle', sourceContext });
    vi.spyOn(api, 'tasks').mockResolvedValue([completedTask('a', '看看抖音 DAU', '2026-11-04T06:37:00.000Z')]);
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: [summaryTurn('a', '看看抖音 DAU', conclusion, '2026-11-04T06:37:00.000Z', {
      activity: { endedAt: '2026-11-04T06:52:00.000Z', tools: [[1_000, 2_000], [60_000, 300_000], [800_000, 500]] }
    })], highWaterMark: 10, liveAfter: 10 });
    const { container } = renderPage();
    await screen.findByLabelText('gpt-5 结论');
    expect(container.querySelector('.share-lead')?.textContent).toBe('有更新数据：两者不是同一时期、同一口径。');
    expect([...container.querySelectorAll('.share-table tbody tr:first-child td')].map(cell => cell.getAttribute('data-label'))).toEqual(['#', '指标', '数据', '时间与来源']);
    const report = screen.getByRole('link', { name: '报道' });
    expect(report.getAttribute('target')).toBe('_blank');
    expect(report.className).toContain('share-ext');
    // 直方图：3 次调用落在 3 个时间桶里，其余是空桶；两端标出起止时刻。
    expect(container.querySelectorAll('.share-rhythm-bars i:not([data-empty])')).toHaveLength(3);
    expect(container.querySelectorAll('.share-rhythm-bars i[data-empty]').length).toBeGreaterThan(20);
    expect([...container.querySelectorAll('.share-rhythm-axis span')].map(label => label.textContent)).toEqual([
      new Date('2026-11-04T06:37:00.000Z'), new Date('2026-11-04T06:52:00.000Z')
    ].map(date => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`).map(clock => expect.stringContaining(clock)));
    expect(screen.getByRole('button', { name: /^执行过程/ }).textContent).toContain('3 次工具调用 · 15 分钟 · 已完成');
    // 提问和标题相同，不再在结论卡上方重复。
    expect(container.querySelector('.share-quote')).toBeNull();
    expect(screen.getByRole('heading', { name: '看看抖音 DAU' })).toBeTruthy();
    const text = document.body.textContent ?? '';
    for (const internal of ['只读查看', '可继续', '实时同步']) expect(text).not.toContain(internal);
    expect(text).not.toMatch(/事件 \d+/);
  });

  it('旧摘要没有节律数据时只显示调用次数，用时退回任务的创建到更新时间', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'idle' });
    vi.spyOn(api, 'tasks').mockResolvedValue([{ ...completedTask('a', '旧任务', '2026-11-04T06:00:00.000Z'), updatedAt: '2026-11-04T06:02:05.000Z' }]);
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: [summaryTurn('a', '旧任务', '旧结论', '2026-11-04T05:59:00.000Z')], highWaterMark: 10, liveAfter: 10 });
    const { container } = renderPage();
    await screen.findByText('旧结论');
    expect(container.querySelector('.share-rhythm')).toBeNull();
    expect(screen.getByRole('button', { name: /^执行过程/ }).textContent).toContain('3 次工具调用 · 2 分 5 秒 · 已完成');
  });

  it('多轮：更早的轮次按时间排在当前轮上方并收成一行，提问与标题不同时在结论卡上方引用', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'idle' });
    vi.spyOn(api, 'tasks').mockResolvedValue([completedTask('a', '第一问', '2026-11-04T06:00:00.000Z'), completedTask('b', '第二问', '2026-11-04T07:00:00.000Z')]);
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: [
      summaryTurn('a', '第一问', '第一轮结论', '2026-11-04T06:00:00.000Z'),
      { ...summaryTurn('b', '第二问', '第二轮结论', '2026-11-04T07:00:00.000Z'), firstSequence: 11, lastSequence: 20 }
    ], highWaterMark: 20, liveAfter: 20 });
    renderPage();
    const latest = await screen.findByText('第二轮结论');
    expect(screen.getByRole('heading', { name: '第一问' })).toBeTruthy();
    // 只有一轮更早轮次时直接显示那一行：时间、提问摘要和状态点。
    const earlier = screen.getByRole('button', { name: /第一问/ });
    expect(earlier.textContent).toContain('已完成');
    expect(earlier.getAttribute('aria-expanded')).toBe('false');
    expect(earlier.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('第二问', { selector: '.share-quote' })).toBeTruthy();
    expect(screen.queryByText('第一轮结论')).toBeNull();
    fireEvent.click(earlier);
    expect(await screen.findByText('第一轮结论')).toBeTruthy();
    expect(screen.queryByText('第一问', { selector: '.share-quote' })).toBeNull();
  });

  it('两轮及以上的更早轮次默认收成「更早 N 轮」一行，点开是紧凑行，再点一行展开结论卡', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'idle' });
    vi.spyOn(api, 'tasks').mockResolvedValue(['m1', 'm2', 'm3'].map((id, index) => completedTask(id, `第${index + 1}问`, `2026-11-04T0${6 + index}:00:00.000Z`)));
    vi.spyOn(api, 'events').mockResolvedValue([]);
    // 轮次 id 与上一条用例不同：展开状态按会话保存在阅读状态里，同名 id 会继承上一条用例的展开。
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: ['m1', 'm2', 'm3'].map((id, index) => ({
      ...summaryTurn(id, `第${index + 1}问`, `第${index + 1}轮结论`, `2026-11-04T0${6 + index}:00:00.000Z`), firstSequence: index * 10 + 1, lastSequence: index * 10 + 10
    })), highWaterMark: 30, liveAfter: 30 });
    const { container } = renderPage();
    await screen.findByText('第3轮结论');
    const local = new Date('2026-11-04T07:00:00.000Z');
    const head = screen.getByRole('button', { name: new RegExp(`更早 2 轮 · 最近 (?:\\d+ 年 )?(?:\\d+ 月 \\d+ 日 )?${String(local.getHours()).padStart(2, '0')}:00`) });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /第2问/ })).toBeNull();
    expect(container.querySelectorAll('.share-earlier')).toHaveLength(1);
    // 收起的那一行与展开后的第一轮是同一个滚动锚点，点开后这一行留在原处。
    const anchor = head.closest('[data-timeline-event]');
    expect(anchor?.getAttribute('data-timeline-event')).toBe('m1');
    fireEvent.click(head);
    expect(head.closest('[data-timeline-event]')).toBe(anchor);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.share-earlier-line')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /第2问/ }));
    expect(await screen.findByText('第2轮结论')).toBeTruthy();
    expect(screen.queryByText('第1轮结论')).toBeNull();
  });

  it('更早轮次里有的带日期、有的只有时刻：同一组的时间列按带日期的一档留宽，提问摘要起点对齐', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'idle' });
    const today = new Date(); today.setHours(0, 30, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1); yesterday.setHours(16, 11);
    const at = [yesterday, new Date(yesterday.getTime() + 8 * 60_000), today, new Date(today.getTime() + 60 * 60_000)].map(date => date.toISOString());
    const ids = ['w1', 'w2', 'w3', 'w4'];
    vi.spyOn(api, 'tasks').mockResolvedValue(ids.map((id, index) => completedTask(id, `第${index + 1}问`, at[index]!)));
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: ids.map((id, index) => ({
      ...summaryTurn(id, `第${index + 1}问`, `第${index + 1}轮结论`, at[index]!), firstSequence: index * 10 + 1, lastSequence: index * 10 + 10
    })), highWaterMark: 40, liveAfter: 40 });
    const { container } = renderPage();
    await screen.findByText('第4轮结论');
    fireEvent.click(screen.getByRole('button', { name: /更早 3 轮/ }));
    const times = [...container.querySelectorAll('.share-earlier-time')];
    expect(times.map(time => time.textContent)).toEqual([expect.stringMatching(/月 .* 日 16:11$/), expect.stringMatching(/月 .* 日 16:19$/), '00:30']);
    expect(times.map(time => time.getAttribute('data-width'))).toEqual(['day', 'day', 'day']);
  });

  it('执行中：字幕把命令缩写成等宽一行，最后一个有调用的桶发光，圆点标出此刻，横轴末端不写时刻', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'running_tool' });
    vi.spyOn(api, 'tasks').mockResolvedValue([{ ...tasks[0]!, prompt: '查数据' }]);
    vi.spyOn(api, 'events').mockResolvedValue([
      { id: 'u1', sequence: 1, type: 'text', timestamp: '2026-09-25T00:00:01Z', data: { role: 'user', text: '查数据' } },
      { id: 't1', sequence: 2, type: 'tool_call', timestamp: '2026-09-25T00:00:02Z', data: { id: 'call-1', name: 'exec_command', status: 'running', startedAt: '2026-09-25T00:00:02Z',
        input: { cmd: "'/usr/local/bin/node' '/srv/app/dist/cli.js' session send '核对口径'" } } }
    ]);
    const { container } = renderPage();
    await screen.findByLabelText('结论生成中');
    const line = container.querySelector('.share-now-line')!;
    expect(line.textContent).toBe('正在运行命令 node cli.js session send 核对口径 …');
    expect(line.getAttribute('data-command')).not.toBeNull();
    expect(line.querySelector('code')?.textContent).toBe('node cli.js session send 核对口径');
    expect(container.querySelectorAll('.share-rhythm-bars i[data-live]')).toHaveLength(1);
    expect(container.querySelector('.share-rhythm-head')).not.toBeNull();
    expect(container.querySelectorAll('.share-rhythm-axis span')).toHaveLength(1);
  });

  const longSession = () => {
    const ids = Array.from({ length: 31 }, (_, index) => `long${index}`);
    const at = (index: number) => new Date(Date.UTC(2026, 10, 3, 0, index)).toISOString();
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'idle' });
    vi.spyOn(api, 'tasks').mockResolvedValue(ids.map((id, index) => completedTask(id, `问题${index}`, at(index))));
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: ids.map((id, index) => ({
      ...summaryTurn(id, `问题${index}`, `结论${index}`, at(index)), firstSequence: index * 10 + 1, lastSequence: index * 10 + 10
    })), highWaterMark: 310, liveAfter: 310 });
  };
  const renderedTurns = (container: HTMLElement) => [...container.querySelectorAll('[data-timeline-turn]')].map(element => element.getAttribute('data-timeline-turn'));
  const spacers = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.share-main > div[aria-hidden="true"]')].map(element => element.style.height);

  it('三十轮的会话：收起时被藏起的轮次不占位，「更早 30 轮」紧挨当前结论；展开再收起也一样', async () => {
    longSession();
    const { container } = renderPage();
    await screen.findByText('结论30');
    const head = screen.getByRole('button', { name: /更早 30 轮/ });
    expect(renderedTurns(container)).toEqual(['long0', 'long30']);
    expect(spacers(container)).toEqual(['0px', '0px']);
    fireEvent.click(head);
    expect(screen.getAllByRole('button', { name: /问题\d+/ }).length).toBeGreaterThan(5);
    fireEvent.click(head);
    expect(renderedTurns(container)).toEqual(['long0', 'long30']);
    expect(spacers(container)).toEqual(['0px', '0px']);
  });

  it('「更早 N 轮」展开状态按会话保存，刷新后仍是展开的', async () => {
    longSession();
    const first = renderPage();
    await screen.findByText('结论30');
    fireEvent.click(screen.getByRole('button', { name: /更早 30 轮/ }));
    expect(sessionStorage.getItem('dutydeck:timeline-reading:v1')).toContain('share-earlier');
    first.unmount();
    renderPage();
    // 展开后列表从第一轮排起，当前结论在窗口之外；等「更早 30 轮」那一行出现即可。
    expect((await screen.findByRole('button', { name: /更早 30 轮/ })).getAttribute('aria-expanded')).toBe('true');
  });

  it('英雄区在滚动容器里：虚拟窗口按列表起点换算，滚到中段时视口里的那一轮已经渲染', async () => {
    longSession();
    getTimelineReadingState('ses_1').disclosures.set('share-earlier', true);
    const header = 1_000;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const scroller = document.querySelector<HTMLElement>('[data-timeline-scroll]');
      const top = this.matches('.share-main > div[aria-hidden="true"]:first-child') ? header - (scroller?.scrollTop ?? 0) : 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} } as DOMRect;
    });
    const { container } = renderPage();
    await screen.findByRole('button', { name: /更早 30 轮/ });
    const scroller = container.querySelector<HTMLElement>('[data-timeline-scroll]')!;
    // jsdom 没有布局：给出内容总高和视口高，免得被当成已滚到底而切到跟随最新。
    Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: header + 180 * 31 }, clientHeight: { configurable: true, value: 900 } });
    // 每轮按默认 180px 估算：滚到英雄区下方第 20 轮的位置，第 20 轮必须在渲染窗口里。
    scroller.scrollTop = header + 180 * 20;
    fireEvent.scroll(scroller);
    expect(renderedTurns(container)).toContain('long20');
  });

  it('第一次打开停在顶部；读者跟随到底后刷新，恢复跟随，新输出到来仍滚到底', async () => {
    const id = 'ses_follow';
    let height = 3_000;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('[data-timeline-scroll]') ? height : 0; });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('[data-timeline-scroll]') ? 900 : 0; });
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, id, state: 'running_tool' });
    const taskList = vi.spyOn(api, 'tasks').mockResolvedValue(tasks);
    vi.spyOn(api, 'events').mockResolvedValue(events);
    const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 50)));
    const first = renderPage(id);
    await waitFor(() => expect(first.container.querySelector('.share-turn')).toBeTruthy());
    await settle();
    const opened = first.container.querySelector<HTMLElement>('[data-timeline-scroll]')!;
    expect(opened.scrollTop).toBe(0);
    opened.scrollTop = height - 900;
    fireEvent.scroll(opened);
    first.unmount();

    const second = renderPage(id);
    await waitFor(() => expect(second.container.querySelector('.share-turn')).toBeTruthy());
    const reopened = second.container.querySelector<HTMLElement>('[data-timeline-scroll]')!;
    await waitFor(() => expect(reopened.scrollTop).toBe(3_000));
    height = 5_000;
    taskList.mockResolvedValue([...tasks, { ...tasks[0]!, id: 'task-2', prompt: '再看一下注册页', createdAt: '2026-09-25T00:00:09Z', updatedAt: '2026-09-25T00:00:09Z' }]);
    await act(() => second.client.invalidateQueries({ queryKey: ['tasks', id] }));
    await waitFor(() => expect(reopened.scrollTop).toBe(5_000));
  });

  it('只有一轮、失败、没有最终输出：实时记录和历史摘要两种来源都渲染失败卡', async () => {
    const error = 'ACP agent exited before initialize completed (exit=1, signal=null)';
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'failed', error });
    vi.spyOn(api, 'tasks').mockResolvedValue([{ ...tasks[0]!, prompt: '查数据', status: 'failed' }]);
    vi.spyOn(api, 'events').mockResolvedValue([{ id: 'u1', sequence: 1, type: 'text', timestamp: '2026-09-25T00:00:01Z', taskId: 'task-1', data: { role: 'user', text: '查数据', taskId: 'task-1' } }]);
    const live = renderPage();
    expect(await screen.findByText('执行失败，没有得到结论')).toBeTruthy();
    expect(screen.getByText(error)).toBeTruthy();
    live.unmount();
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: [{ ...summaryTurn('f1', '查数据', '', '2026-09-25T00:00:01Z'), taskId: 'task-1', status: 'failed', toolCount: 0 }], highWaterMark: 10, liveAfter: 10 });
    renderPage();
    expect(await screen.findByText('执行失败，没有得到结论')).toBeTruthy();
    expect(screen.getByText(error)).toBeTruthy();
  });

  it('记录还没读完时不显示调用次数和「待开始」，读完后再显示真实数字', async () => {
    let finish!: (events: DockEvent[]) => void;
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'idle' });
    vi.spyOn(api, 'tasks').mockResolvedValue([completedTask('a', '看看抖音 DAU', '2026-11-04T06:37:00.000Z')]);
    vi.spyOn(api, 'events').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: [summaryTurn('a', '看看抖音 DAU', conclusion, '2026-11-04T06:37:00.000Z')], highWaterMark: 10, liveAfter: 10 });
    renderPage();
    await screen.findByRole('heading', { name: '看看抖音 DAU' });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(document.body.textContent).not.toMatch(/次工具调用|待开始|未完成/);
    expect(screen.queryByLabelText('这次执行')).toBeNull();
    await act(async () => { finish([]); });
    expect(await screen.findByLabelText('这次执行')).toBeTruthy();
    expect(document.body.textContent).toContain('3 次工具调用');
  });

  it('完整记录里的工具卡标题用缩写的命令，悬停仍是原文；工作台的工具卡不变', async () => {
    const cmd = "cat '/data00/home/someone/.agents/skills/lark-im/SKILL.md'";
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'idle' });
    vi.spyOn(api, 'tasks').mockResolvedValue([{ ...tasks[0]!, prompt: '查数据', status: 'completed' }]);
    vi.spyOn(api, 'events').mockResolvedValue([
      { id: 'u1', sequence: 1, type: 'text', timestamp: '2026-09-25T00:00:01Z', taskId: 'task-1', data: { role: 'user', text: '查数据', taskId: 'task-1' } },
      { id: 't1', sequence: 2, type: 'tool_call', timestamp: '2026-09-25T00:00:02Z', taskId: 'task-1', data: { id: 'call-1', name: 'exec_command', status: 'completed', input: { cmd } } },
      { id: 'a1', sequence: 3, type: 'text', timestamp: '2026-09-25T00:00:03Z', taskId: 'task-1', data: { role: 'assistant', text: '结论在此' } }
    ]);
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^执行过程/ }));
    const group = await waitFor(() => container.querySelector<HTMLElement>('.share-record details > summary')!);
    fireEvent.click(group);
    const detail = await waitFor(() => container.querySelector<HTMLElement>(`.share-record .font-mono[title="${cmd}"]`)!);
    expect(detail.textContent).toBe('cat SKILL.md');
    cleanup();
    render(<ToolCard event={{ id: 't1', sequence: 2, type: 'tool_call', timestamp: '', data: { id: 'call-1', name: 'exec_command', status: 'completed', input: { cmd } } }}/>);
    expect(document.querySelector(`.font-mono[title="${cmd}"]`)?.textContent).toBe(cmd);
  });

  it('复制结论得到能贴回飞书的纯文本，并给出轻提示', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'idle', sourceContext });
    vi.spyOn(api, 'tasks').mockResolvedValue([completedTask('a', '看看抖音 DAU', '2026-11-04T06:37:00.000Z')]);
    vi.spyOn(api, 'events').mockResolvedValue([]);
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: [summaryTurn('a', '看看抖音 DAU', conclusion, '2026-11-04T06:37:00.000Z')], highWaterMark: 10, liveAfter: 10 });
    renderPage();
    await screen.findByLabelText('gpt-5 结论');
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '复制结论' })[0]!); });
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied.split('\n')[0]).toBe('【结论】有更新数据：两者不是同一时期、同一口径。');
    expect(copied).toContain('1. 抖音 DAU：7.14 亿（2026 年 7 月，报道（https://finance.sina.com.cn/a））');
    expect(copied).toContain('2. 群发消息渗透：6.50%（同一内部周报）');
    expect(copied.trimEnd().split('\n').at(-1)).toBe(`详情：${window.location.href}`);
    expect(await screen.findByText('结论已复制')).toBeTruthy();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('失败时把结论区换成失败详情卡，不再用顶部横幅', async () => {
    vi.spyOn(api, 'session').mockResolvedValue({ ...session, state: 'failed', error: 'Agent 进程退出（exit 1）：网络请求超时' });
    vi.spyOn(api, 'tasks').mockResolvedValue([]);
    vi.spyOn(api, 'events').mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('执行失败，没有得到结论')).toBeTruthy();
    expect(screen.getByText('Agent 进程退出（exit 1）：网络请求超时')).toBeTruthy();
    expect(screen.queryByText(/已运行/)).toBeNull();
    expect(screen.getAllByText('失败').length).toBeGreaterThan(0);
    expect(screen.queryByText('失败详情')).toBeNull();
  });
});
