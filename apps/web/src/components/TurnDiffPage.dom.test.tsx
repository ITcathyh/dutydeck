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

afterEach(() => { sessionStorage.clear(); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('TurnDiffPage', () => {
  it('按文件折叠显示这一轮的改动，二进制、超大和超出上限的文件只显示占位，并提示截断', async () => {
    vi.spyOn(api, 'turnDiff').mockResolvedValue(diff);
    renderPage();
    expect(await screen.findByRole('heading', { name: '把 b 改成 20' })).toBeTruthy();
    expect(screen.getByText(/改动 4 个文件/).textContent).toBe('改动 4 个文件 +3 −1 · 分享审阅');
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

  it('锁文件和生成物折叠显示统计与折叠原因，不提示截断；点展开才按需读正文，展开后的行不能评论', async () => {
    vi.spyOn(api, 'turnDiff').mockResolvedValue({
      ...diff, truncated: false, summary: { files: 3, additions: 30_002, deletions: 1 }, files: [
        diff.files[0]!,
        { path: 'package-lock.json', status: 'modified', additions: 30_000, deletions: 0, placeholder: 'folded_lockfile', hunks: [] },
        { path: 'gen/api.ts', status: 'added', additions: 1, deletions: 0, placeholder: 'folded_generated', hunks: [] }
      ]
    });
    const turnDiffFile = vi.spyOn(api, 'turnDiffFile').mockResolvedValue({
      path: 'gen/api.ts', status: 'added', additions: 1, deletions: 0, hunks: [{ header: '@@ -0,0 +1 @@', lines: [{ kind: 'add', newLine: 1, text: 'export const generated = 1;' }] }]
    });
    renderPage();
    expect(await screen.findByText('已折叠：锁文件，只显示增删行数。')).toBeTruthy();
    expect(screen.getByText(/已折叠：生成物/)).toBeTruthy();
    expect(screen.getByText('+30000')).toBeTruthy();
    expect([...document.querySelectorAll('details')].map(file => file.open)).toEqual([true, false, false]);
    expect(screen.queryByText('改动太多，只展开了前面的文件，其余文件只列出名字。')).toBeNull();
    expect(turnDiffFile).not.toHaveBeenCalled();

    const buttons = screen.getAllByRole('button', { name: '展开查看' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(await screen.findByText('export const generated = 1;')).toBeTruthy();
    expect(turnDiffFile).toHaveBeenCalledWith('ses_1', 'task_1', 'gen/api.ts');
    expect(screen.getAllByRole('button', { name: '展开查看' })).toHaveLength(1);
    expect((screen.getByRole('button', { name: '评论 gen/api.ts 第 1 行' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '评论 src/app.ts 第 2 行（改动前）' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('展开折叠文件失败时在文件下面说明原因，可以再试', async () => {
    vi.spyOn(api, 'turnDiff').mockResolvedValue({
      ...diff, truncated: false, summary: { files: 1, additions: 3, deletions: 0 },
      files: [{ path: 'package-lock.json', status: 'modified', additions: 3, deletions: 0, placeholder: 'folded_lockfile', hunks: [] }]
    });
    vi.spyOn(api, 'turnDiffFile').mockRejectedValue(new ApiError('这一轮的改动记录已经不在仓库里了', 'TURN_DIFF_EXPIRED', 410));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '展开查看' }));
    expect(await screen.findByText('展开失败：这一轮的改动记录已经不在仓库里了')).toBeTruthy();
    expect(screen.getByRole('button', { name: '展开查看' })).toBeTruthy();
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
    expect(within(screen.getByRole('contentinfo')).getByText(/提交后作为新一轮请求发回当前任务/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '提交评论' }));
    expect(await screen.findByText('评论已作为新一轮请求发回当前任务。')).toBeTruthy();
  });

  it('保存所点击行的至多三行上下文，保留增删前缀和换行', async () => {
    vi.spyOn(api, 'turnDiff').mockResolvedValue(diff);
    renderPage();
    const targets = ['第 1 行', '第 2 行（改动前）', '第 2 行', '第 3 行'];
    for (const [index, target] of targets.entries()) {
      fireEvent.click(await screen.findByRole('button', { name: `评论 src/app.ts ${target}` }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: `comment ${index}` } });
      fireEvent.click(screen.getByRole('button', { name: '添加评论' }));
    }
    const changedLine = diff.files[0]!.hunks[0]!.lines[2]!.text;
    const drafts = JSON.parse(sessionStorage.getItem('dutydeck:diff-review:@local:ses_1:task_1')!);
    expect(drafts).toEqual([
      { path: 'src/app.ts', side: 'new', line: 1, body: 'comment 0', code: ' export const a = 1;' },
      { path: 'src/app.ts', side: 'old', line: 2, body: 'comment 1', code: ' export const a = 1;\n-export const b = 2;' },
      { path: 'src/app.ts', side: 'new', line: 2, body: 'comment 2', code: ` export const a = 1;\n-export const b = 2;\n+${changedLine}` },
      { path: 'src/app.ts', side: 'new', line: 3, body: 'comment 3', code: `-export const b = 2;\n+${changedLine}\n export const c = 3;` }
    ]);
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


describe('TurnDiffPage pending comment submissions', () => {
  it.each(['added', 'edited', 'recreated', 'deleted', 'unchanged', 'failure', 'shared'] as const)('only clears successfully submitted draft versions: %s', async change => {
    let settle!: (response: Response) => void;
    const payloads: unknown[] = [];
    const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        payloads.push(JSON.parse(String(init.body)));
        return new Promise<Response>(resolve => { settle = resolve; });
      }
      return response(diff);
    }));
    renderPage(change === 'shared');
    const saveComment = async (line: number, body: string) => {
      fireEvent.click(await screen.findByRole('button', { name: `评论 src/app.ts 第 ${line} 行` }));
      fireEvent.change(screen.getByLabelText(`src/app.ts 第 ${line} 行的评论`), { target: { value: body } });
      fireEvent.click(screen.getByRole('button', { name: '添加评论' }));
    };
    await saveComment(1, 'Submitted original');
    // This second submitted object must clear even if the first is replaced.
    await saveComment(2, 'Submitted unchanged');
    fireEvent.click(screen.getByRole('button', { name: '提交评论' }));
    await waitFor(() => expect(payloads).toHaveLength(1));
    expect(screen.getByRole('button', { name: '提交评论' }).hasAttribute('disabled')).toBe(true);
    if (['added', 'failure', 'shared'].includes(change)) await saveComment(3, 'New unsent comment');
    if (change === 'edited') await saveComment(1, 'Edited unsent comment');
    if (change === 'recreated' || change === 'deleted') {
      fireEvent.click(screen.getByText('Submitted original').parentElement!.querySelector('button')!);
      if (change === 'recreated') await saveComment(1, 'Submitted original');
    }
    expect(payloads).toEqual([{ comments: [
      { path: 'src/app.ts', side: 'new', line: 1, body: 'Submitted original' },
      { path: 'src/app.ts', side: 'new', line: 2, body: 'Submitted unchanged' }
    ] }]);
    settle(change === 'failure' ? response({ error: 'Comments unavailable' }, 503) : response({ delivery: change === 'shared' ? 'lark_confirmation' : 'dispatched' }, 202));
    if (change === 'failure') {
      expect(await screen.findByText(/提交失败/)).toBeTruthy();
      expect(screen.getByText('Submitted original')).toBeTruthy();
      expect(screen.getByText('Submitted unchanged')).toBeTruthy();
      expect(screen.getByText('New unsent comment')).toBeTruthy();
      expect(screen.getByText(/3 条评论待提交/)).toBeTruthy();
    } else {
      await screen.findByText(change === 'shared' ? '评论已发到飞书话题，等有权限的人确认后交给 Agent 修改。' : '评论已作为新一轮请求发回当前任务。');
      expect(screen.queryByText('Submitted unchanged')).toBeNull();
      if (['added', 'shared'].includes(change)) expect(screen.getByText('New unsent comment')).toBeTruthy();
      if (change === 'edited') expect(screen.getByText('Edited unsent comment')).toBeTruthy();
      expect(Boolean(screen.queryByText('Submitted original'))).toBe(change === 'recreated');
      if (change === 'unchanged' || change === 'deleted') expect(screen.queryByText(/条评论待提交/)).toBeNull();
      else expect(screen.getByText(/1 条评论待提交/)).toBeTruthy();
    }
    expect(payloads).toHaveLength(1);
  });

  it('改动页按文件验收，已查看数量按快照计算并在勾选后增加', async () => {
    vi.spyOn(api, 'turnDiff').mockResolvedValue(diff);
    renderPage(false);
    expect(await screen.findByText('0 / 4 已查看')).toBeTruthy();
    const checkbox = screen.getByRole('checkbox', { name: '已查看 src/app.ts' });
    fireEvent.click(checkbox);
    expect(screen.getByText('1 / 4 已查看')).toBeTruthy();
  });
});
