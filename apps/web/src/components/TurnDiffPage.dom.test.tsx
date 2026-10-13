// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError, type TurnDiff } from '../api';
import { turnDiffFromLocation } from '../app-route';
import { TurnDiffPage } from './TurnDiffPage';

const diff: TurnDiff = {
  sessionId: 'ses_1', taskId: 'task_1', title: '把 b 改成 20', access: 'shared', truncated: true,
  summary: { files: 4, additions: 3, deletions: 1 },
  files: [
    { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, hunks: [{ header: '@@ -1,3 +1,3 @@', lines: [
      { kind: 'context', oldLine: 1, newLine: 1, text: 'export const a = 1;' },
      { kind: 'del', oldLine: 2, text: 'export const b = 2;' },
      { kind: 'add', newLine: 2, text: `export const b = 20; // ${'很长的一行'.repeat(40)}` },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'export const c = 3;' }
    ] }] },
    { path: 'assets/logo.png', status: 'added', additions: 0, deletions: 0, placeholder: 'binary', hunks: [] },
    { path: 'data/huge.json', status: 'modified', additions: 2, deletions: 0, placeholder: 'too_large', hunks: [] },
    { path: 'z-later.ts', status: 'added', additions: 0, deletions: 0, placeholder: 'omitted', hunks: [] }
  ]
};

function renderPage(shared = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TurnDiffPage sessionId="ses_1" taskId="task_1" shared={shared}/></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TurnDiffPage', () => {
  it('按文件折叠显示这一轮的改动，二进制、超大和超出上限的文件只显示占位，并提示截断', async () => {
    vi.spyOn(api, 'turnDiff').mockResolvedValue(diff);
    renderPage();
    expect(await screen.findByRole('heading', { name: '把 b 改成 20' })).toBeTruthy();
    expect(screen.getByText(/改动 4 个文件/).textContent).toBe('改动 4 个文件 +3 −1 · 只读查看');
    expect(screen.getByText('改动太多，只展开了前面的文件，其余文件只列出名字。')).toBeTruthy();
    expect(screen.getByText('二进制文件，不显示内容。')).toBeTruthy();
    expect(screen.getByText('这个文件的改动太大，页面上不显示。')).toBeTruthy();
    expect(screen.getByText('超出页面显示上限，没有展开。')).toBeTruthy();
    const files = document.querySelectorAll('details');
    expect([...files].map(file => file.open)).toEqual([true, false, false, false]);
    // 窄屏不横向撑破：长行折行显示，不出现横向滚动。
    const longLine = screen.getByText(/export const b = 20;/);
    expect(longLine.className).toContain('whitespace-pre-wrap');
    expect(longLine.className).toContain('break-all');
    expect(document.querySelector('.overflow-x-auto, .whitespace-pre:not(.whitespace-pre-wrap)')).toBeNull();
    expect(screen.getByRole('button', { name: '评论 src/app.ts 第 2 行（改动前）' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '回到任务' })).toBeNull();
  });

  it('可以在几行上各写一条评论，一起提交；分享链接提交后说明要等飞书里确认', async () => {
    vi.spyOn(api, 'turnDiff').mockResolvedValue(diff);
    const submit = vi.spyOn(api, 'submitTurnDiffComments').mockResolvedValue({ delivery: 'lark_confirmation' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '评论 src/app.ts 第 2 行' }));
    fireEvent.change(screen.getByLabelText('src/app.ts 第 2 行的评论'), { target: { value: '  b 为什么是 20？  ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }));
    fireEvent.click(screen.getByRole('button', { name: '评论 src/app.ts 第 2 行（改动前）' }));
    fireEvent.change(screen.getByLabelText('src/app.ts 第 2 行的评论'), { target: { value: '旧值写进 changelog' } });
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }));
    expect(screen.getByText('b 为什么是 20？')).toBeTruthy();
    const footer = screen.getByText(/条评论待提交/);
    expect(footer.textContent).toBe('2 条评论待提交 · 提交后在飞书话题里发确认卡，有权限的人确认后才交给 Agent');
    fireEvent.click(screen.getByRole('button', { name: '提交评论' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('ses_1', 'task_1', [
      { path: 'src/app.ts', side: 'new', line: 2, body: 'b 为什么是 20？' },
      { path: 'src/app.ts', side: 'old', line: 2, body: '旧值写进 changelog' }
    ]));
    expect(await screen.findByText('评论已发到飞书话题，等有权限的人确认后交给 Agent 修改。')).toBeTruthy();
    expect(screen.queryByText(/条评论待提交/)).toBeNull();
  });

  it('登录用户提交后说明已发给 Agent，并能回到任务', async () => {
    vi.spyOn(api, 'turnDiff').mockResolvedValue({ ...diff, access: 'owner' });
    vi.spyOn(api, 'submitTurnDiffComments').mockResolvedValue({ delivery: 'dispatched' });
    renderPage(false);
    expect(await screen.findByRole('link', { name: '回到任务' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '评论 src/app.ts 第 3 行' }));
    fireEvent.change(screen.getByLabelText('src/app.ts 第 3 行的评论'), { target: { value: '加个测试' } });
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }));
    expect(within(screen.getByRole('contentinfo')).getByText(/提交后作为新一轮请求发给 Agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '提交评论' }));
    expect(await screen.findByText('评论已作为新一轮请求发给 Agent。')).toBeTruthy();
  });

  it('链接无效或过期时只给提示', async () => {
    vi.spyOn(api, 'turnDiff').mockRejectedValue(new ApiError('Authentication required', 'UNAUTHORIZED', 401));
    renderPage();
    expect(await screen.findByText('链接无效或已失效')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    vi.spyOn(api, 'turnDiff').mockRejectedValue(new ApiError('gone', 'TURN_DIFF_EXPIRED', 410));
    renderPage();
    expect(await screen.findByText('改动记录已过期')).toBeTruthy();
  });

  it('从地址解析出会话、任务和片段里的 token', () => {
    expect(turnDiffFromLocation('/diff/ses_1/task_1', '#lx2a.abc_-')).toEqual({ sessionId: 'ses_1', taskId: 'task_1', token: 'lx2a.abc_-' });
    expect(turnDiffFromLocation('/instances/tag/diff/ses_1/task_1', '')).toEqual({ sessionId: 'ses_1', taskId: 'task_1' });
    expect(turnDiffFromLocation('/diff/ses_1/task_1', '#bad token')).toEqual({ sessionId: 'ses_1', taskId: 'task_1', token: '' });
    expect(turnDiffFromLocation('/diff/ses_1', '')).toBeUndefined();
    expect(turnDiffFromLocation('/share/ses_1', '#x')).toBeUndefined();
  });
});
