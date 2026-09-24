import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { workPlanSchema, type WorkItem } from '@dutydeck/shared';
import { api, type Agent, type Session } from '../api';
import { WorkItemProgress } from './WorkItemProgress';
import { WorkItemsPanel } from './WorkItemsPanel';
import { TimelineView } from './TimelineView';

const time = '2026-09-12T00:00:00Z';
const session: Session = { id: 's1', agentId: 'a', cwd: '/project', state: 'completed', runId: 'r', createdAt: time, updatedAt: time };
const agents: Agent[] = [
  { id: 'a', name: '分析 Agent', protocol: 'acp', permissionMode: 'ask' },
  { id: 'b', name: '总结 Agent', protocol: 'acp', permissionMode: 'ask' },
];

const goal = (patch: Partial<WorkItem> = {}): WorkItem => ({
  id: 'w1', parentSessionId: 's1', title: '调查目标', goal: '检查实际证据', revision: 7, status: 'running',
  plan: {
    title: '调查流程',
    steps: [
      { id: 'research', title: '独立分析', kind: 'agent', agentId: 'a', instruction: '检查来源', dependsOn: [] },
      { id: 'review', title: '负责人意见', kind: 'wait', instruction: '是否补充材料？', dependsOn: ['research'] },
      { id: 'summary', title: '整理总结', kind: 'agent', agentId: 'b', instruction: '汇总结论', dependsOn: ['review'] },
    ],
    outputStepId: 'summary',
  },
  steps: [
    { id: 'research', status: 'running', attempts: [{ id: 'a2', number: 2, status: 'accepted', sessionId: 'child/2', createdAt: time, updatedAt: time }] },
    { id: 'review', status: 'pending', attempts: [] },
    { id: 'summary', status: 'pending', attempts: [] },
  ],
  delivery: { status: 'not_requested', attempts: 0 },
  createdAt: time,
  updatedAt: time,
  ...patch,
});

const completed = (patch: Partial<WorkItem> = {}): WorkItem => goal({
  status: 'completed',
  steps: [
    { id: 'research', status: 'completed', attempts: [{ id: 'a2', number: 2, status: 'completed', sessionId: 'child/2', createdAt: time, updatedAt: time }] },
    { id: 'review', status: 'completed', attempts: [], answer: '无需补充' },
    { id: 'summary', status: 'completed', attempts: [{ id: 'a3', number: 1, status: 'completed', sessionId: 'child/3', createdAt: time, updatedAt: time }] },
  ],
  output: { text: '最终成果正文', digest: 'sha-final', stepId: 'summary' },
  ...patch,
});

const failed = (patch: Partial<WorkItem> = {}): WorkItem => goal({
  status: 'failed',
  steps: [
    {
      id: 'research',
      status: 'failed',
      attempts: [{ id: 'a2', number: 2, status: 'failed', sessionId: 'child/2', error: '当前执行离线', createdAt: time, updatedAt: time }],
    },
    { id: 'review', status: 'pending', attempts: [] },
    { id: 'summary', status: 'pending', attempts: [] },
  ],
  ...patch,
});

const skippedGoal = (): WorkItem => ({
  id: 'w-skip',
  parentSessionId: 's1',
  title: '条件目标',
  goal: '检查跳过逻辑',
  revision: 1,
  status: 'completed',
  plan: {
    title: '条件流程',
    steps: [
      { id: 'gate', title: '前置确认', kind: 'wait', instruction: '是否补充调查？', dependsOn: [] },
      { id: 'optional', title: '补充分析', kind: 'agent', agentId: 'a', instruction: '执行补充分析', dependsOn: ['gate'], when: { stepId: 'gate', equals: 'yes' } },
      { id: 'summary', title: '整理总结', kind: 'agent', agentId: 'b', instruction: '汇总结论', dependsOn: ['gate', 'optional'] },
    ],
    outputStepId: 'summary',
  },
  steps: [
    { id: 'gate', status: 'completed', attempts: [], answer: 'no' },
    { id: 'optional', status: 'skipped', attempts: [] },
    { id: 'summary', status: 'completed', attempts: [{ id: 'a-sum', number: 1, status: 'completed', sessionId: 'child/sum', createdAt: time, updatedAt: time }] },
  ],
  output: { text: '跳过流程成果', digest: 'sha-skip', stepId: 'summary' },
  delivery: { status: 'not_requested', attempts: 0 },
  createdAt: time,
  updatedAt: time,
});

const parallelPlan = {
  title: '并行调查流程',
  steps: [
    { id: 'research', title: '独立分析', kind: 'agent' as const, agentId: 'a', instruction: '检查来源', dependsOn: [] },
    { id: 'review', title: '负责人意见', kind: 'wait' as const, instruction: '是否补充材料？', dependsOn: [] },
    { id: 'summary', title: '整理总结', kind: 'agent' as const, agentId: 'b', instruction: '汇总结论', dependsOn: ['research', 'review'] },
  ],
  outputStepId: 'summary',
};

const records = (items: WorkItem[]) => ({ items, templates: [] });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function mount(items: WorkItem[] = [goal()], initialSession = session, eventsLoading = false) {
  const fetchItems = vi.spyOn(api, 'workItems').mockResolvedValue(records(items));
  const fetchRequests = vi.spyOn(api, 'workItemRequests').mockResolvedValue([]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const select = vi.fn();
  function View({ current }: { current: Session }) {
    const [panel, setPanel] = useState({ open: false, selectedId: '' });
    return <><WorkItemsPanel session={current} agents={agents} onSelectSession={select} control={{ ...panel, onOpenChange: open => setPanel(value => ({ ...value, open })), onSelectItem: selectedId => setPanel(value => ({ ...value, selectedId })) }}/>
      <TimelineView activeSessionId={current.id} eventsLoading={eventsLoading} onResolvePermission={() => {}} timeline={[]} timelineSections={[]} awaitingAnswer={false} hasOngoingActivity={false} latestUserIndex={-1} activeOutputLabel="Agent" renderProgress={emptyState => <WorkItemProgress session={current} agents={agents} emptyState={emptyState} onOpenItem={selectedId => setPanel({ open: true, selectedId })} onSelectSession={select}/>}/></>;
  }
  const ui = (current: Session) => <QueryClientProvider client={qc}><View key={current.id} current={current}/></QueryClientProvider>;
  const view = render(ui(initialSession));
  return { ...view, qc, select, fetchItems, fetchRequests, rerenderSession: (current: Session) => view.rerender(ui(current)), update: async (items: WorkItem[]) => { fetchItems.mockResolvedValue(records(items)); await act(async () => { qc.setQueryData(['work-items', initialSession.id], records(items)); await new Promise(resolve => setTimeout(resolve, 0)); }); } };
}

describe('WorkItemProgress', () => {
  it('hides the empty shell while preserving creation and the timeline empty state', async () => {
    mount([]); await screen.findByText('下达第一个任务');
    expect(screen.queryByRole('region', { name: '目标进度' })).toBeNull();
    expect(screen.getByRole('button', { name: '目标、步骤与成果' })).toBeTruthy();
  });
  it.each([false, true])('shows goals without events, including while eventsLoading=%s', async eventsLoading => {
    mount([goal()], session, eventsLoading);
    expect(await screen.findByRole('article', { name: '目标：调查目标' })).toBeTruthy();
    expect(screen.queryByText('下达第一个任务')).toBeNull();
  });
  it('collapses on completion, preserves manual expansion on refresh, and expands on restart or failure', async () => {
    const view = mount([goal()]); await screen.findByRole('button', { name: '收起目标：调查目标' });
    await view.update([failed()]);
    expect(screen.getByRole('button', { name: '收起目标：调查目标' }).getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: '收起目标：调查目标' }));
    expect(screen.getByRole('button', { name: '展开目标：调查目标' }).getAttribute('aria-expanded')).toBe('false');
    await view.update([{
      ...failed(),
      status: 'running',
      revision: 8,
      steps: failed().steps.map(step => (step.id === 'research' ? { ...step, status: 'pending' } : step)),
    }]);
    expect(screen.getByRole('button', { name: '收起目标：调查目标' }).getAttribute('aria-expanded')).toBe('true');
    await view.update([completed()]);
    expect(screen.getByRole('button', { name: '展开目标：调查目标' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('完成 3/3 步')).toBeTruthy();
    expect(screen.queryByRole('list', { name: '进度步骤' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '展开目标：调查目标' }));
    await view.update([{ ...completed(), revision: 9, updatedAt: '2026-09-13T00:00:00Z' }]);
    expect(screen.getByRole('list', { name: '进度步骤' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起目标：调查目标' }).getAttribute('aria-expanded')).toBe('true');
  });
  it('renders skipped steps without counting them as completed', async () => {
    mount([skippedGoal()]);
    expect(await screen.findByText('完成 2/3 步 · 跳过 1 步')).toBeTruthy();
    expect(screen.queryByRole('list', { name: '进度步骤' })).toBeNull();
  });
  it('keeps waiting and latest failure visible when collapsed and removes recovered errors', async () => {
    const failedParallel = goal({
      plan: parallelPlan,
      status: 'failed',
      steps: [
        { ...goal().steps[0], status: 'failed', attempts: [{ ...goal().steps[0].attempts[0], status: 'failed', error: '当前执行离线' }] },
        { id: 'review', status: 'waiting', attempts: [] },
        { id: 'summary', status: 'pending', attempts: [] },
      ],
    });
    const view = mount([failedParallel]);
    await userEvent.click(await screen.findByRole('button', { name: '收起目标：调查目标' }));
    expect(screen.getByText('失败：独立分析；等待回答：负责人意见')).toBeTruthy();
    expect(screen.getByText('独立分析：当前执行离线')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看详情 / 处理' })).toBeTruthy();
    await view.update([{
      ...failedParallel,
      status: 'running',
      revision: failedParallel.revision + 1,
      steps: failedParallel.steps.map(step => (step.id === 'research' ? { ...step, status: 'pending' } : step)),
    }]);
    expect(screen.queryByText('独立分析：当前执行离线')).toBeNull();
    expect(screen.getByText('当前执行离线')).toBeTruthy();
  });
  it('shows waiting step when upstream research is completed and review is waiting', async () => {
    const waitingGoal = goal({
      status: 'waiting',
      steps: [
        { id: 'research', status: 'completed', attempts: [{ id: 'a2', number: 2, status: 'completed', sessionId: 'child/2', createdAt: time, updatedAt: time }] },
        { id: 'review', status: 'waiting', attempts: [] },
        { id: 'summary', status: 'pending', attempts: [] },
      ],
    });
    mount([waitingGoal]);
    expect(await screen.findByText('等待回答：负责人意见')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看详情 / 处理' })).toBeTruthy();
  });
  it.each(['blocked', 'cancelling', 'cancelled'] as const)('retains the real %s semantics', async status => {
    const stepStatus = status === 'blocked' ? 'blocked' : 'cancelled';
    mount([goal({
      status,
      steps: [
        { id: 'research', status: stepStatus, attempts: [{ id: 'a2', number: 2, status: stepStatus, sessionId: 'child/2', createdAt: time, updatedAt: time }] },
        { id: 'review', status: 'pending', attempts: [] },
        { id: 'summary', status: 'pending', attempts: [] },
      ],
    })]);
    const article = await screen.findByRole('article');
    expect(within(article).getAllByText(status === 'blocked' ? '需要处理' : status === 'cancelling' ? '正在取消' : '已取消').length).toBeGreaterThan(0);
  });
  it('shows actual attempts and child links with normal and modified navigation', async () => {
    const view = mount(); const article = await screen.findByRole('article');
    expect(within(article).getByText('第 2 次尝试')).toBeTruthy();
    expect(within(article).getByText('分析 Agent')).toBeTruthy();
    await userEvent.click(within(article).getByText('独立分析'));
    const link = within(article).getByRole('link', { name: '查看第 2 次尝试的执行记录' });
    expect(link.getAttribute('href')).toBe('/sessions/child%2F2');
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    let prevented = true; const capture = (event: MouseEvent) => { prevented = event.defaultPrevented; event.preventDefault(); }; document.addEventListener('click', capture, { once: true }); fireEvent(link, modified); expect(prevented).toBe(false); expect(view.select).not.toHaveBeenCalled();
    await userEvent.click(link); expect(view.select).toHaveBeenCalledWith('child/2');
  });
  it('opens the exact goal and reopens it after another selection or closing the single panel', async () => {
    mount([completed(), { ...completed(), id: 'w2', title: '第二目标', goal: '第二目标正文' }]);
    const second = await screen.findByRole('article', { name: '目标：第二目标' });
    await userEvent.click(within(second).getByRole('button', { name: '查看成果' }));
    expect(await screen.findByText('第二目标正文')).toBeTruthy();
    expect((screen.getByLabelText('选择目标') as HTMLSelectElement).value).toBe('w2');
    await userEvent.selectOptions(screen.getByLabelText('选择目标'), 'w1');
    expect(await screen.findByText('检查实际证据')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '关闭目标详情' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(within(second).getByRole('button', { name: '查看详情' }));
    expect((screen.getByLabelText('选择目标') as HTMLSelectElement).value).toBe('w2'); expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
  it('refreshes shared cache every five seconds with the panel closed', async () => {
    vi.useFakeTimers(); const view = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('article')).toBeTruthy(); view.fetchItems.mockResolvedValue(records([completed()]));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(view.fetchItems).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '展开目标：调查目标' })).toBeTruthy();
    expect(view.qc.getQueryData(['work-items', 's1'])).toEqual(records([completed()])); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows authorization arriving on the same running status even while collapsed', async () => {
    const view = mount(); await userEvent.click(await screen.findByRole('button', { name: '收起目标：调查目标' }));
    await act(async () => view.qc.setQueryData(['work-item-requests', 's1', 'w1'], [{ stepId: 'research', sessionId: 'child/2', taskId: 'task2', requestId: 'request2', kind: 'permission', text: '允许读取目录？' }]));
    expect(await screen.findByText('需要操作授权 · 独立分析：允许读取目录？')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '查看详情 / 处理' }));
    expect(await screen.findByRole('button', { name: '批准此操作' })).toBeTruthy(); expect(view.fetchRequests).toHaveBeenCalledTimes(1);
  });
  it('shows request errors with retry, and failed goal refresh as stale data', async () => {
    const view = mount(); await screen.findByRole('article');
    view.fetchRequests.mockRejectedValue(new Error('请求服务断开'));
    await act(async () => { await view.qc.invalidateQueries({ queryKey: ['work-item-requests'] }); });
    expect(await screen.findByText(/执行请求读取失败：请求服务断开/)).toBeTruthy();
    view.fetchRequests.mockResolvedValue([]); await userEvent.click(screen.getByRole('button', { name: '重试读取执行请求' }));
    await waitFor(() => expect(screen.queryByText(/请求服务断开/)).toBeNull());
    view.fetchItems.mockRejectedValue(new Error('目标服务断开'));
    await act(async () => { await view.qc.invalidateQueries({ queryKey: ['work-items'] }); });
    expect(await screen.findByText(/目标读取失败：目标服务断开。下方为上次读取的数据/)).toBeTruthy(); expect(screen.getByRole('article')).toBeTruthy();
    view.fetchItems.mockResolvedValue(records([])); await userEvent.click(screen.getByRole('button', { name: '重试读取目标' }));
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
  });
  it('reports an initial read failure without claiming there are no goals', async () => {
    vi.spyOn(api, 'workItems').mockRejectedValue(new Error('首次读取失败'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><WorkItemProgress session={session} agents={agents} onOpenItem={() => {}} onSelectSession={() => {}} emptyState={<p>没有目标</p>}/></QueryClientProvider>);
    expect(await screen.findByText(/目标读取失败：首次读取失败。暂时无法确认是否有目标/)).toBeTruthy();
    expect(screen.queryByText('没有目标')).toBeNull();
    expect(screen.getByRole('button', { name: '重试读取目标' })).toBeTruthy();
  });
  it('does not represent read errors as an empty goal list', async () => {
    const view = mount([]); await screen.findByText('下达第一个任务');
    view.fetchItems.mockRejectedValue(new Error('访问失败'));
    await act(async () => { await view.qc.invalidateQueries({ queryKey: ['work-items'] }); });
    expect(await screen.findByText(/目标读取失败：访问失败/)).toBeTruthy(); expect(screen.queryByText('下达第一个任务')).toBeNull();
  });
  it('does not carry data or a dialog across sessions, and skips child queries', async () => {
    const view = mount(); await userEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    view.fetchItems.mockResolvedValue(records([])); view.rerenderSession({ ...session, id: 's2' });
    expect(screen.queryByRole('article')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull();
    await screen.findByText('下达第一个任务'); expect(view.fetchItems).toHaveBeenLastCalledWith('s2');
    const reads = view.fetchItems.mock.calls.length; view.rerenderSession({ ...session, id: 'child', source: 'work_item' });
    expect(view.fetchItems).toHaveBeenCalledTimes(reads); expect(screen.queryByRole('article')).toBeNull();
  });
  it.each([{ archivedAt: time }, { state: 'failed' as const }, { state: 'stopped' as const }])('opens read-only details for ended or archived sessions: %j', async patch => {
    mount([failed()], { ...session, ...patch });
    await userEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    expect(screen.getByRole('button', { name: '取消目标' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '重试此步骤' }).hasAttribute('disabled')).toBe(true); expect(screen.queryByLabelText('本次目标')).toBeNull();
  });
  it('validates common fixtures against workPlanSchema', () => {
    expect(workPlanSchema.safeParse(goal().plan).success).toBe(true);
    expect(workPlanSchema.safeParse(completed().plan).success).toBe(true);
    expect(workPlanSchema.safeParse(failed().plan).success).toBe(true);
    expect(workPlanSchema.safeParse(skippedGoal().plan).success).toBe(true);
    expect(workPlanSchema.safeParse(parallelPlan).success).toBe(true);
  });
});
