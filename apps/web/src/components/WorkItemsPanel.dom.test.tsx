import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkItem, WorkTemplate } from '@dutydeck/shared';
import { WorkItemsPanel } from './WorkItemsPanel';
import { api, type Agent, type Session } from '../api';

const time = '2026-09-12T00:00:00Z';
const session: Session = { id: 's1', agentId: 'a', cwd: '/project', state: 'completed', runId: 'r', createdAt: time, updatedAt: time };
const agents: Agent[] = ['a', 'b', 'c'].map(id => ({ id, name: `Agent ${id}`, protocol: 'acp', permissionMode: 'ask' }));
const item = (patch: Partial<WorkItem> = {}): WorkItem => ({
  id: 'w1', parentSessionId: 's1', title: '调查目标', goal: '比较三种实现', revision: 7, status: 'waiting',
  plan: { title: '调查流程', steps: [
    { id: 'research', title: '独立分析', kind: 'agent', agentId: 'a', instruction: '检查来源', dependsOn: [], workspaceMode: 'worktree' },
    { id: 'review', title: '负责人意见', kind: 'wait', instruction: '是否补充材料？', dependsOn: ['research'] },
    { id: 'summary', title: '形成报告', kind: 'agent', agentId: 'b', instruction: '汇总材料', dependsOn: ['review'] }
  ], outputStepId: 'summary' },
  steps: [
    { id: 'research', status: 'completed', attempts: [{ id: 'attempt-1', number: 1, sessionId: 'child1', status: 'completed', output: { text: '来源分析产物', digest: 'sha-a' }, createdAt: time, updatedAt: time }] },
    { id: 'review', status: 'waiting', attempts: [] }, { id: 'summary', status: 'pending', attempts: [] }
  ], delivery: { status: 'pending', attempts: 0 }, createdAt: time, updatedAt: time, ...patch
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(initial = session) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const select = vi.fn();
  const ui = (current: Session) => <QueryClientProvider client={qc}><WorkItemsPanel session={current} agents={agents} onSelectSession={select}/></QueryClientProvider>;
  const view = render(ui(initial));
  return { ...view, select, rerenderSession: (current: Session) => view.rerender(ui(current)), open: async () => { await userEvent.click(screen.getByRole('button', { name: '目标、步骤与成果' })); } };
}

function requestsMock(initialItem = item(), templates: WorkTemplate[] = []) {
  const requests: Array<{ url: string; method: string; body?: any }> = [];
  let current = initialItem;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const request = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    if (request.method === 'GET') return response({ items: [current], templates });
    current = { ...current, revision: current.revision + 1, status: 'running' };
    return response(current);
  });
  return requests;
}

describe('WorkItemsPanel', () => {
  it('shows loading and fetch errors, and requires a successful refresh before actions', async () => {
    const pending = deferred<Response>();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => pending.promise).mockResolvedValue(response({ items: [], templates: [] }));
    const view = mount(); await view.open();
    expect(screen.getByText('读取工作项目标')).toBeTruthy();
    await act(async () => pending.resolve(response({ error: { message: '暂无访问权限' } }, 403)));
    expect(await screen.findByText(/目标读取失败：暂无访问权限/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始目标', hidden: true }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByText(/当前会话还没有工作项目标/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shows dependency, actual attempts, final output and child execution navigation', async () => {
    requestsMock(item({ status: 'completed', output: { text: '最终研究报告', digest: 'sha-final', stepId: 'summary' }, delivery: { status: 'error', attempts: 2, error: '飞书暂不可用' } }));
    const view = mount(); await view.open();
    expect(await screen.findByText('最终研究报告')).toBeTruthy();
    expect(screen.getByText('依赖：独立分析')).toBeTruthy();
    expect(screen.getByText(/独立工作目录（基于 \/project/)).toBeTruthy();
    expect(screen.getByText('成果通知：飞书暂不可用')).toBeTruthy();
    await userEvent.click(screen.getByText('第 1 次尝试 · 已完成'));
    expect(screen.getByText('来源分析产物')).toBeTruthy();
    const link = screen.getByRole('link', { name: '查看此尝试的执行记录' });
    expect(link.getAttribute('href')).toBe('/sessions/child1');
    await userEvent.click(link);
    expect(view.select).toHaveBeenCalledWith('child1');
  });

  it('answers the exact wait and revision, disabling all stale actions while pending', async () => {
    const pending = deferred<Response>();
    let current = item();
    const calls: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (!init?.method) return response({ items: [current], templates: [] });
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return pending.promise;
    });
    const view = mount(); await view.open();
    const answer = await screen.findByLabelText('回答：负责人意见');
    await userEvent.type(answer, '补充成本分析');
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(calls).toEqual([{ url: '/api/sessions/s1/work-items/w1/answer', body: { stepId: 'review', answer: '补充成本分析', expectedRevision: 7 } }]);
    expect(screen.getByRole('button', { name: '提交回答' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '取消目标' }).hasAttribute('disabled')).toBe(true);
    expect((answer as HTMLTextAreaElement).disabled).toBe(true);
    current = item({ revision: 8, status: 'running', steps: item().steps.map(step => step.id === 'review' ? { ...step, status: 'completed', answer: '补充成本分析' } : step) });
    await act(async () => pending.resolve(response(current)));
    expect(await screen.findByText('已保存回答：补充成本分析')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull();
  });

  it('answers a waiting branch while another branch is still running', async () => {
    const current = item({ status: 'running', plan: { ...item().plan, steps: [...item().plan.steps.slice(0, 2), { id: 'parallel', title: '并行分析', kind: 'agent', agentId: 'b', instruction: '分析替代方案', dependsOn: [] }, { ...item().plan.steps[2], dependsOn: ['review', 'parallel'] }] }, steps: [...item().steps, { id: 'parallel', status: 'running', attempts: [] }] });
    const posts: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method) { posts.push({ url: String(url), body: JSON.parse(String(init.body)) }); return response(current); }
      return response(String(url).endsWith('/requests') ? [] : { items: [current], templates: [] });
    });
    const view = mount(); await view.open();
    await userEvent.type(await screen.findByLabelText('回答：负责人意见'), '继续汇总');
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    expect(posts).toEqual([{ url: '/api/sessions/s1/work-items/w1/answer', body: { stepId: 'review', answer: '继续汇总', expectedRevision: 7 } }]);
  });

  it('does not offer a failed-step retry when the goal is blocked', async () => {
    requestsMock(item({ status: 'blocked', steps: [{ id: 'research', status: 'failed', attempts: [] }] }));
    const view = mount(); await view.open();
    await screen.findByRole('heading', { name: '调查目标 · 需要处理' });
    expect(screen.queryByRole('button', { name: '重试此步骤' })).toBeNull();
  });

  it('retries only the failed step and cancels using the refreshed revision', async () => {
    const requests = requestsMock(item({ status: 'failed', steps: [{ id: 'research', status: 'failed', attempts: [{ id: 'a1', number: 1, status: 'failed', error: '执行端离线', createdAt: time, updatedAt: time }] }] }));
    const view = mount(); await view.open();
    await userEvent.click(await screen.findByRole('button', { name: '重试此步骤' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '取消目标' }).hasAttribute('disabled')).toBe(false));
    expect(requests.find(request => request.url.endsWith('/retry'))?.body).toEqual({ stepId: 'research', expectedRevision: 7 });
    await userEvent.click(screen.getByRole('button', { name: '取消目标' }));
    await waitFor(() => expect(requests.find(request => request.url.endsWith('/cancel'))?.body).toEqual({ expectedRevision: 8 }));
  });

  it('keeps a creation idempotency key across an uncertain response and builds the chosen research agents', async () => {
    const bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (!init?.method) return response({ items: [], templates: [] });
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) throw new Error('连接中断');
      return response(item({ status: 'running' }));
    });
    const view = mount(); await view.open();
    await screen.findByText(/当前会话还没有工作项目标/);
    await userEvent.click(screen.getByText('新建目标或复用模板'));
    await userEvent.type(screen.getByLabelText('本次目标'), '研究数据库方案');
    await userEvent.selectOptions(screen.getByLabelText('风险分析 Agent'), 'c');
    await userEvent.click(screen.getByRole('button', { name: '开始目标' }));
    await screen.findByText(/连接中断/);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始目标' }).hasAttribute('disabled')).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: '关闭目标详情' }));
    await view.open();
    await userEvent.click(screen.getByText('新建目标或复用模板'));
    await userEvent.type(screen.getByLabelText('本次目标'), '研究数据库方案');
    await userEvent.selectOptions(screen.getByLabelText('风险分析 Agent'), 'c');
    await userEvent.click(screen.getByRole('button', { name: '开始目标' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0].idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0].plan.steps.map((step: any) => step.agentId)).toEqual(['a', 'c', 'c']);
    expect(bodies[0].plan.steps[2].dependsOn).toEqual(['analysis_1', 'analysis_2']);
    expect(bodies[0].plan.outputStepId).toBe('summary');
  });

  it('saves a template and runs a selected version with a new goal', async () => {
    const template: WorkTemplate = { id: 't1', parentSessionId: 's1', name: '研究模板', version: 3, plan: item().plan, createdAt: time };
    const requests = requestsMock(item(), [template]);
    const view = mount(); await view.open();
    await screen.findByRole('heading', { name: '调查目标 · 等待回答' });
    await userEvent.click(screen.getByText('保存为流程模板'));
    await userEvent.clear(screen.getByLabelText('模板名称'));
    await userEvent.type(screen.getByLabelText('模板名称'), '每周调研');
    await userEvent.click(screen.getByRole('button', { name: '保存模板' }));
    await waitFor(() => expect(requests.find(request => request.url.endsWith('/template'))?.body).toEqual({ name: '每周调研' }));
    await userEvent.click(screen.getByText('新建目标或复用模板'));
    await waitFor(() => expect((screen.getByLabelText('执行流程') as HTMLSelectElement).disabled).toBe(false));
    await userEvent.selectOptions(screen.getByLabelText('执行流程'), 't1:3');
    await userEvent.type(screen.getByLabelText('本次目标'), '研究新的问题');
    await userEvent.click(screen.getByRole('button', { name: '开始目标' }));
    await waitFor(() => expect(requests.find(request => request.url.endsWith('/work-templates/t1/run'))?.body).toEqual({ version: 3, goal: '研究新的问题', idempotencyKey: expect.any(String) }));
  });

  it('never carries previous session data, draft or pending action into a newly selected session', async () => {
    const pending = deferred<Response>();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method) return pending.promise;
      return response({ items: String(url).includes('/s1/') ? [item()] : [], templates: [] });
    });
    const view = mount(); await view.open();
    await userEvent.type(await screen.findByLabelText('回答：负责人意见'), '旧会话回答');
    await userEvent.click(screen.getByRole('button', { name: '提交回答' }));
    view.rerenderSession({ ...session, id: 's2' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await view.open();
    expect(await screen.findByText(/当前会话还没有工作项目标/)).toBeTruthy();
    expect(screen.queryByText('比较三种实现')).toBeNull();
    await act(async () => pending.resolve(response(item({ status: 'running', revision: 8 }))));
    expect(screen.queryByText('回答已保存。')).toBeNull();
    expect(screen.queryByLabelText('回答：负责人意见')).toBeNull();
    expect(fetch.mock.calls.filter(([url, init]) => String(url).includes('/s2/') && init?.method)).toHaveLength(0);
  });

  it('does not offer mutations for an archived session and encodes detail URLs', async () => {
    requestsMock(item());
    const view = mount({ ...session, archivedAt: time }); await view.open();
    await screen.findByRole('heading', { name: '调查目标 · 等待回答' });
    expect(screen.getByRole('button', { name: '取消目标' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByLabelText('本次目标')).toBeNull();
    await api.workItem('session/a', 'goal/b');
    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/sessions/session%2Fa/work-items/goal%2Fb', expect.anything());
  });

  it.each([['批准此操作', 'approve'], ['拒绝此操作', 'reject']])('submits only the explicit permission choice %s and refreshes pending requests', async (label, answer) => {
    const pending = deferred<Response>();
    const running = item({ status: 'running', steps: [{ id: 'research', status: 'running', attempts: [] }] });
    let requests = [{ stepId: 'research', sessionId: 'child1', taskId: 'task1', requestId: 'req1', kind: 'permission', text: '允许读取指定材料目录？' }];
    const posts: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method) { posts.push({ url: String(url), body: JSON.parse(String(init.body)) }); return pending.promise; }
      return response(String(url).endsWith('/requests') ? requests : { items: [running], templates: [] });
    });
    const view = mount(); await view.open();
    expect(await screen.findByText('允许读取指定材料目录？')).toBeTruthy();
    expect(posts).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: label }));
    expect(posts).toEqual([{ url: '/api/sessions/s1/work-items/w1/respond', body: { stepId: 'research', taskId: 'task1', requestId: 'req1', kind: 'permission', answer } }]);
    expect(screen.getByRole('button', { name: '批准此操作' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '拒绝此操作' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '取消目标' }).hasAttribute('disabled')).toBe(true);
    requests = [];
    await act(async () => pending.resolve(response({ ok: true })));
    await waitFor(() => expect(screen.queryByRole('button', { name: '批准此操作' })).toBeNull());
  });

  it('shows native question fetch errors and sends only the typed answer for the current request', async () => {
    const running = item({ status: 'running', steps: [{ id: 'research', status: 'running', attempts: [] }] });
    const posts: any[] = [];
    let requestReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method) { posts.push({ url: String(url), body: JSON.parse(String(init.body)) }); return response({ ok: true }); }
      if (String(url).endsWith('/requests')) {
        requestReads++;
        if (requestReads === 1) return response({ error: { message: '执行记录暂不可用' } }, 503);
        return response(posts.length ? [] : [{ stepId: 'research', sessionId: 'child1', taskId: 'task1', requestId: 'question1', kind: 'question', text: '需要覆盖哪个地区？' }]);
      }
      return response({ items: [running], templates: [] });
    });
    const view = mount(); await view.open();
    expect(await screen.findByText(/执行请求读取失败：执行记录暂不可用/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '重新读取执行请求' }));
    expect(await screen.findByText('需要覆盖哪个地区？')).toBeTruthy();
    expect(posts).toHaveLength(0);
    expect(screen.getByRole('button', { name: '发送执行回答' }).hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByLabelText('执行回答：独立分析'), '中国与欧洲');
    await userEvent.click(screen.getByRole('button', { name: '发送执行回答' }));
    expect(posts).toEqual([{ url: '/api/sessions/s1/work-items/w1/respond', body: { stepId: 'research', taskId: 'task1', requestId: 'question1', kind: 'question', answer: '中国与欧洲' } }]);
    await waitFor(() => expect(screen.queryByRole('button', { name: '发送执行回答' })).toBeNull());
  });

});
