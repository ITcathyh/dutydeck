import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicPullRequest } from '@dutydeck/shared';
import { PullRequestPanel } from './PullRequestPanel';
import type { Session } from '../api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const session: Session = { id: 's1', agentId: 'a', cwd: '/project', state: 'idle', runId: 'r', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' };
const proposal: PublicPullRequest = {
  id: 'pr_1', sessionId: 's1', provider: 'github', providerName: 'GitHub', repository: 'acme/app', status: 'proposed', title: 'Fix login',
  bodySummary: '本 PR 由 DutyDeck 根据会话的改动生成。', branch: 'dutydeck/fix-login-0a1b2c3d', target: 'main', baseSha: 'a'.repeat(40),
  files: [{ path: 'src/login.ts', change: 'modified', additions: 3, deletions: 1 }],
  excluded: [{ path: 'notes.txt', reason: 'not_session' }, { path: 'README.md', reason: 'changed_after' }],
  commits: [{ sha: 'b'.repeat(40), subject: 'wip: local commit' }],
  ciRounds: 0, reviewRounds: 0, expiresAt: '2026-10-13T00:30:00Z', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z'
};

function mount(list: { available: boolean; hint?: string; items: PublicPullRequest[] }, state: Session['state'] = 'idle') {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    requests.push({ url: String(url), method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    const path = String(url);
    const body = method === 'GET' ? list
      : path.endsWith('/confirm') ? { message: '已确认，正在推送分支并开 PR，完成后会通知。', pullRequest: { ...proposal, status: 'pushing' } }
      : path.endsWith('/cancel') ? { pullRequest: { ...proposal, status: 'cancelled' } }
      : path.endsWith('/force-push') ? { message: '已确认，仍然推送这一轮的改动，推送前的其余核对照做，完成后会通知。' }
      : { pullRequest: proposal };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><PullRequestPanel session={{ ...session, state }}/></QueryClientProvider>);
  return requests;
}
const writes = (requests: Array<{ method: string; url: string; body?: string }>) => requests.filter(item => item.method === 'POST').map(item => [item.url, item.body]);

describe('开 PR 面板', () => {
  it('填链接点「跟进」认领已有的 PR，不弹确认框；认领的记录标为已有 PR', async () => {
    const requests = mount({ available: true, items: [{ ...proposal, id: 'pr_9', status: 'open', claimed: true, title: 'Login fix', branch: 'feature/login' }] });
    const user = userEvent.setup();
    expect(await screen.findByText('跟进中 · 已有 PR · Login fix')).toBeTruthy();
    expect((screen.getByRole('button', { name: '跟进' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('跟进已有的 PR'), 'https://github.com/acme/app/pull/12');
    await user.click(screen.getByRole('button', { name: '跟进' }));
    await waitFor(() => expect(writes(requests)).toEqual([['/api/sessions/s1/pull-requests/follow', JSON.stringify({ pullRequest: 'https://github.com/acme/app/pull/12' })]]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('点「开 PR」只生成确认清单；确认框列出文件、不包含的文件、分支、标题和正文摘要，点确认才发推送请求', async () => {
    const requests = mount({ available: true, items: [] });
    const user = userEvent.setup({ delay: null });
    await user.type(await screen.findByLabelText('PR 标题（可选）'), 'Fix login');
    await user.click(screen.getByRole('button', { name: '开 PR' }));
    const dialog = await screen.findByRole('alertdialog', { name: '确认推送并开 PR' });
    expect(writes(requests)).toEqual([['/api/sessions/s1/pull-requests', JSON.stringify({ title: 'Fix login' })]]);
    expect(within(dialog).getByText('dutydeck/fix-login-0a1b2c3d（新建）')).toBeTruthy();
    expect(within(dialog).getByText('main')).toBeTruthy();
    expect(within(dialog).getByText('Fix login')).toBeTruthy();
    expect(within(dialog).getByRole('list', { name: '将提交的文件' }).textContent).toBe('src/login.ts +3 −1');
    expect(within(dialog).getByText('将提交的文件（1 个，+3 −1）')).toBeTruthy();
    expect([...within(dialog).getByRole('list', { name: '不包含的文件' }).querySelectorAll('li')].map(item => item.textContent)).toEqual(['notes.txt：不是本会话改的', 'README.md：本会话改过，之后又被改动，无法确认']);
    expect(within(dialog).getByText('bbbbbbbb wip: local commit')).toBeTruthy();
    expect(within(dialog).getByText('本 PR 由 DutyDeck 根据会话的改动生成。')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: '确认推送并开 PR' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes(requests)).toEqual([
      ['/api/sessions/s1/pull-requests', JSON.stringify({ title: 'Fix login' })],
      ['/api/sessions/s1/pull-requests/pr_1/confirm', undefined]
    ]);
    expect(screen.getByRole('status').textContent).toBe('已确认，正在推送分支并开 PR，完成后会通知。');
  });

  it('取消确认框只发取消请求，不推送', async () => {
    const requests = mount({ available: true, items: [] });
    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByRole('button', { name: '开 PR' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes(requests)).toEqual([['/api/sessions/s1/pull-requests', '{}'], ['/api/sessions/s1/pull-requests/pr_1/cancel', undefined]]);
  });

  it('没装支持开 PR 的插件时不显示按钮，给出安装提示', async () => {
    mount({ available: false, hint: '没有安装支持开 PR 的 CI 插件。安装方法：dutydeck plugin install <插件目录> --yes', items: [] });
    expect(await screen.findByText(/dutydeck plugin install/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '开 PR' })).toBeNull();
  });

  it('列出已有的 PR：链接、跟进轮次和停止跟进；飞书发起的待确认清单可以在这里确认', async () => {
    const opened: PublicPullRequest = { ...proposal, id: 'pr_2', status: 'open', ciRounds: 1, reviewRounds: 2, pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7', label: 'PR #7' } };
    const requests = mount({ available: true, items: [opened, proposal] });
    const user = userEvent.setup({ delay: null });
    const link = await screen.findByRole('link', { name: 'PR #7' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/app/pull/7');
    expect(screen.getByText('已自动修 CI 1 轮、处理评审意见 2 轮')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '停止跟进' }));
    await waitFor(() => expect(writes(requests)).toEqual([['/api/sessions/s1/pull-requests/pr_2/cancel', undefined]]));
    await user.click(screen.getByRole('button', { name: '查看并确认' }));
    expect(await screen.findByRole('alertdialog', { name: '确认推送并开 PR' })).toBeTruthy();
  });

  it('推送前验证中、验证未通过等人处理都显示出来，原因可见，可以停止跟进', async () => {
    const verifying: PublicPullRequest = { ...proposal, id: 'pr_3', status: 'verifying', title: 'Verifying' };
    const attention: PublicPullRequest = { ...proposal, id: 'pr_4', status: 'needs_attention', title: 'Needs human', reason: 'CI 修复第 1 轮推送前验证没有通过（`pnpm test`，失败，退出码 1）。' };
    mount({ available: true, items: [verifying, attention] });
    expect(await screen.findByText('推送前验证中 · Verifying')).toBeTruthy();
    expect(screen.getByText('验证未通过，等人处理 · Needs human')).toBeTruthy();
    expect(screen.getByText(/推送前验证没有通过/).className).toContain('text-warning');
    expect(screen.getAllByRole('button', { name: '停止跟进' })).toHaveLength(2);
  });

  it('验证未通过等人处理时可以点「仍然推送」，只对这条记录发请求；验证中不显示这个按钮', async () => {
    const verifying: PublicPullRequest = { ...proposal, id: 'pr_3', status: 'verifying', title: 'Verifying' };
    const attention: PublicPullRequest = { ...proposal, id: 'pr_4', status: 'needs_attention', title: 'Needs human' };
    const requests = mount({ available: true, items: [verifying, attention] });
    const user = userEvent.setup({ delay: null });
    await screen.findByText('推送前验证中 · Verifying');
    expect(screen.getAllByRole('button', { name: '仍然推送' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '仍然推送' }));
    await waitFor(() => expect(writes(requests)).toEqual([['/api/sessions/s1/pull-requests/pr_4/force-push', undefined]]));
    expect((await screen.findByRole('status')).textContent).toContain('仍然推送这一轮的改动');
  });

  it('会话结束后只读：不显示「仍然推送」', async () => {
    mount({ available: true, items: [{ ...proposal, id: 'pr_4', status: 'needs_attention', title: 'Needs human' }] }, 'stopped');
    expect(await screen.findByText('验证未通过，等人处理 · Needs human')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '仍然推送' })).toBeNull();
  });

  it('会话结束后只读：不显示开 PR 和确认入口', async () => {
    mount({ available: true, items: [proposal] }, 'stopped');
    await screen.findByText('等待确认 · Fix login');
    expect(screen.queryByRole('button', { name: '开 PR' })).toBeNull();
    expect(screen.queryByRole('button', { name: '查看并确认' })).toBeNull();
  });
});
