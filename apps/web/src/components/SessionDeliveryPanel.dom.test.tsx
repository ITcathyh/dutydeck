import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionDeliveryPanel } from './SessionDeliveryPanel';
import type { Session, Task } from '../api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const session: Session = { id: 's1', agentId: 'a', cwd: '/project/worktree', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };

function mount(state = session.state, options: {
  archivedAt?: string;
  missingFingerprint?: boolean;
  evidenceFailure?: boolean;
  workspace?: any;
  cleanupPreview?: any;
  cleanupHandler?: (init?: RequestInit) => any;
  sessionOverrides?: Partial<Session>;
  presentation?: 'dialog' | 'inspector';
  tasks?: Task[];
  turnDiffs?: unknown[];
} = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    requests.push({ url: String(url), init });
    const strUrl = String(url);
    const body = strUrl.endsWith('/capabilities') ? { structuredApproval: 'available', terminal: 'unavailable', verification: 'available', localFileDelivery: 'available' }
      : strUrl.endsWith('/workspace/cleanup') ? (init?.method === 'POST' ? (options.cleanupHandler?.(init) ?? { ok: true, sessionId: 's1', path: '/project/worktree', cleanedAt: '2026-09-14T00:00:00Z' }) : (options.cleanupPreview ?? { sessionId: 's1', path: '/project/worktree', branch: 'dutydeck/session/s1', canClean: true, blockers: [], fingerprint: 'fp_test_123' }))
      : strUrl.endsWith('/workspace') ? (options.workspace ?? { cwd: session.cwd, mode: 'worktree', state: 'ready', branch: 'dutydeck/session/s1' })
      : strUrl.endsWith('/automation') ? { schedules: [], subscriptions: [], occurrences: [] }
      : strUrl.endsWith('/diffs') ? (options.turnDiffs ?? [])
      : strUrl.endsWith('/pull-requests') ? { available: false, hint: '没有安装支持开 PR 的 CI 插件。', items: [] }
      : strUrl.endsWith('/automation/ci-providers') ? { providers: [{ id: 'test-ci', displayName: 'Test CI', polling: true, webhook: false }] }
      : strUrl.endsWith('/verifications') ? init?.method === 'POST' ? { id: 'v2', status: 'passed' } : [{ id: 'v1', command: 'pnpm test', status: 'passed', stale: true, staleReason: options.missingFingerprint ? 'current_fingerprint_unavailable' : 'code_changed', exitCode: 0, beforeFingerprint: 'code-version-1', afterFingerprint: 'code-version-1', taskId: 't1', output: 'old evidence', startedAt: session.createdAt, completedAt: '2026-09-12T00:00:03Z' }]
      : { subscription: { id: 'ci1', status: 'waiting', provider: 'test-ci' } };
    return new Response(JSON.stringify(body), { status: options.evidenceFailure && strUrl.endsWith('/verifications') ? 503 : 200, headers: { 'content-type': 'application/json' } });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><SessionDeliveryPanel session={{ ...session, state, ...(options.archivedAt ? { archivedAt: options.archivedAt } : {}), ...options.sessionOverrides }} tasks={options.tasks ?? []} onClose={() => {}} presentation={options.presentation}/></QueryClientProvider>);
  return requests;
}

describe('work item delivery panel', () => {
  it('lists the turns that changed files, newest first, each linking to its diff page', async () => {
    mount('idle', { tasks: [{ id: 'task_1', sessionId: 's1', prompt: '修登录页', status: 'completed', createdAt: session.createdAt, updatedAt: session.createdAt },
      { id: 'task_2', sessionId: 's1', prompt: '加测试', status: 'completed', createdAt: session.createdAt, updatedAt: session.createdAt }] as Task[],
      turnDiffs: [{ taskId: 'task_1', summary: { files: 2, additions: 10, deletions: 3 } }, { taskId: 'task_2', summary: { files: 1, additions: 4, deletions: 0 } }] });
    const links = await screen.findAllByRole('link', { name: /查看改动/ });
    expect(links.map(link => [link.getAttribute('href'), link.textContent])).toEqual([
      ['/diff/s1/task_2', '加测试改动 1 个文件 +4 −0 · 查看改动'],
      ['/diff/s1/task_1', '修登录页改动 2 个文件 +10 −3 · 查看改动']
    ]);
  });

  it('shows stale evidence separately from task completion and sends explicit verification and CI requests', async () => {
    const requests = mount();
    const user = userEvent.setup();
    await screen.findByText('验证通过 · 代码已变化');
    await user.click(screen.getByText('验证通过 · 代码已变化'));
    expect(screen.getByText('版本：code-version-1')).toBeTruthy();
    expect(screen.getByText(/关联轮次：t1 · 用时 3.0 秒/)).toBeTruthy();
    expect(screen.getByText(/退出码 0/)).toBeTruthy();
    await user.type(screen.getByLabelText('验证命令'), 'pnpm test');
    await user.click(screen.getByRole('button', { name: '执行验证' }));
    await waitFor(() => expect(requests.some(item => item.url === '/api/sessions/s1/verifications' && item.init?.body === JSON.stringify({ command: 'pnpm test' }))).toBe(true));
    await user.click(screen.getByText('任务自动化', { selector: 'summary' }));
    await user.click(screen.getByText('等待 CI 完成'));
    await user.type(screen.getByLabelText('工作流（可选）'), 'ci.yml');
    await user.click(screen.getByRole('button', { name: '开始等待' }));
    await waitFor(() => expect(requests.some(item => item.url === '/api/sessions/s1/automation/ci' && item.init?.body === JSON.stringify({ workflow: 'ci.yml', ttlSeconds: 86400 }))).toBe(true));
    expect(screen.getByText('已开始等待当前提交的 Test CI；续作开始前可取消等待。')).toBeTruthy();
  });

  it('describes unreadable fingerprints without claiming code changed', async () => {
    mount('completed', { missingFingerprint: true });
    await screen.findByText('验证通过 · 无法确认当前版本');
    expect(screen.queryByText('验证通过 · 代码已变化')).toBeNull();
  });

  it('does not claim there are no records after a failed evidence read', async () => {
    mount('completed', { evidenceFailure: true });
    await screen.findByRole('alert');
    expect(screen.queryByText('尚无平台执行的验证记录。')).toBeNull();
  });

  it('keeps verification disabled while the Agent is working', async () => {
    mount('thinking');
    await screen.findByText('验证通过 · 代码已变化');
    expect((screen.getByLabelText('验证命令') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '执行验证' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('本会话正在执行，结束后可启动验证。')).toBeTruthy();
  });

  it('shows cleanup entry for archived worktree session and completes cleanup workflow', async () => {
    let cleaned = false;
    const requests = mount('completed', {
      archivedAt: '2026-09-13T00:00:00Z',
      cleanupHandler: () => {
        cleaned = true;
        return { ok: true, sessionId: 's1', path: '/project/worktree', cleanedAt: '2026-09-14T00:00:00Z' };
      },
      cleanupPreview: {
        sessionId: 's1',
        path: '/project/worktree',
        branch: 'dutydeck/session/s1',
        canClean: true,
        blockers: [],
        fingerprint: 'fp_test_123'
      }
    });
    // 拦截后续 workspace 查询
    const origFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (cleaned && String(url).endsWith('/workspace')) {
        return new Response(JSON.stringify({ cwd: session.cwd, mode: 'worktree', state: 'cleaned', branch: 'dutydeck/session/s1', cleanedAt: '2026-09-14T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return origFetch(url, init);
    });

    const user = userEvent.setup();
    await user.click(screen.getByText('执行环境与用量'));
    const checkBtn = await screen.findByRole('button', { name: '检查可否清理' });
    await user.click(checkBtn);

    await screen.findByText('将删除目录：');
    expect(screen.getAllByText('/project/worktree').length).toBeGreaterThan(1);
    expect(screen.getByText('工作目录状态干净，无未提交改动或新增未推送提交，可安全清理。')).toBeTruthy();

    const confirmBtn = screen.getByRole('button', { name: '确认清理工作目录' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(requests.some(r => r.url.endsWith('/workspace/cleanup') && r.init?.method === 'POST' && r.init?.body === JSON.stringify({ fingerprint: 'fp_test_123' }))).toBe(true);
    });
    await screen.findByText(/工作目录已清理，任务历史仍可读/);
  });

  it('displays blockers when workspace cannot be safely cleaned', async () => {
    mount('completed', {
      archivedAt: '2026-09-13T00:00:00Z',
      cleanupPreview: {
        sessionId: 's1',
        path: '/project/worktree',
        branch: 'dutydeck/session/s1',
        canClean: false,
        blockers: [
          { code: 'DIRTY_TRACKED', message: '存在未提交的代码改动', details: ['modified.ts'] },
          { code: 'UNPUSHED_COMMITS', message: '存在未保存到基线或本地远端分支的新增提交', details: ['feat: work in progress'] }
        ],
        fingerprint: 'fp_dirty_456'
      }
    });
    const user = userEvent.setup();

    await user.click(screen.getByText('执行环境与用量'));
    await user.click(await screen.findByRole('button', { name: '检查可否清理' }));
    await screen.findByText('当前无法清理工作目录：');
    expect(screen.getByText('存在未提交的代码改动')).toBeTruthy();
    expect(screen.getByText('modified.ts')).toBeTruthy();
    expect(screen.getByText('存在未保存到基线或本地远端分支的新增提交')).toBeTruthy();
    expect(screen.getByText('feat: work in progress')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认清理工作目录' })).toBeNull();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeTruthy();
  });

  it('displays already cleaned banner if workspace was already cleaned', async () => {
    mount('completed', {
      archivedAt: '2026-09-13T00:00:00Z',
      workspace: { cwd: session.cwd, mode: 'worktree', state: 'cleaned', branch: 'dutydeck/session/s1', cleanedAt: '2026-09-14T00:00:00Z' }
    });

    await screen.findByText(/工作目录已清理，任务历史仍可读/);
    expect(screen.queryByRole('button', { name: '检查可否清理' })).toBeNull();
  });

  it('所属任务优先展示 session.name，无 name 时使用任务原始 prompt，且不改写任务对象自身', async () => {
    const rawTask: Task = { id: 't1', sessionId: 's1', prompt: '原始交付指令', status: 'completed', createdAt: '', updatedAt: '' };
    mount('completed', {
      sessionOverrides: { name: '自定义交付任务' },
      tasks: [rawTask]
    });
    expect(await screen.findByText(/所属任务：自定义交付任务/)).toBeTruthy();
    // 确保真实任务 prompt 未被修改
    expect(rawTask.prompt).toBe('原始交付指令');
  });

  it('未命名会话回退到任务 prompt，任务缺失时使用 agent 和 cwd fallback', async () => {
    const rawTask: Task = { id: 't1', sessionId: 's1', prompt: '原始交付指令', status: 'completed', createdAt: '', updatedAt: '' };
    mount('completed', {
      tasks: [rawTask]
    });
    expect(await screen.findByText(/所属任务：原始交付指令/)).toBeTruthy();

    cleanup();
    mount('completed', { tasks: [] });
    expect(await screen.findByText(/所属任务：a · \/project\/worktree/)).toBeTruthy();
  });
});

it('嵌入结果检视不渲染第二个 Dialog，环境默认折叠', async () => {
  mount('completed', { presentation: 'inspector' });
  await screen.findByText('验证通过 · 代码已变化');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('执行环境与用量').closest('details')?.open).toBe(false);
  expect(screen.getByRole('region', { name: '任务结果' }).textContent).toContain('执行完成与验证通过分别记录');
});
