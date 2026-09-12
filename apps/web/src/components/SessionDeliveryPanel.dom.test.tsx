import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionDeliveryPanel } from './SessionDeliveryPanel';
import type { Session } from '../api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const session: Session = { id: 's1', agentId: 'a', cwd: '/project/worktree', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };

function mount(state = session.state, options: { missingFingerprint?: boolean; evidenceFailure?: boolean } = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    requests.push({ url: String(url), init });
    const body = String(url).endsWith('/capabilities') ? { structuredApproval: 'available', terminal: 'unavailable', verification: 'available', localFileDelivery: 'available' }
      : String(url).endsWith('/workspace') ? { cwd: session.cwd, mode: 'worktree', state: 'ready', branch: 'dutydeck/session/s1' }
      : String(url).endsWith('/automation') ? { schedules: [], subscriptions: [], occurrences: [] }
      : String(url).endsWith('/verifications') ? init?.method === 'POST' ? { id: 'v2', status: 'passed' } : [{ id: 'v1', command: 'pnpm test', status: 'passed', stale: true, staleReason: options.missingFingerprint ? 'current_fingerprint_unavailable' : 'code_changed', exitCode: 0, output: 'old evidence', startedAt: session.createdAt }]
      : { subscription: { id: 'ci1', status: 'waiting' } };
    return new Response(JSON.stringify(body), { status: options.evidenceFailure && String(url).endsWith('/verifications') ? 503 : 200, headers: { 'content-type': 'application/json' } });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><SessionDeliveryPanel session={{ ...session, state }} tasks={[]} onClose={() => {}}/></QueryClientProvider>);
  return requests;
}

describe('work item delivery panel', () => {
  it('shows stale evidence separately from task completion and sends explicit verification and CI requests', async () => {
    const requests = mount();
    const user = userEvent.setup();
    await screen.findByText('验证通过 · 代码已变化');
    await user.type(screen.getByLabelText('验证命令'), 'pnpm test');
    await user.click(screen.getByRole('button', { name: '执行验证' }));
    await waitFor(() => expect(requests.some(item => item.url === '/api/sessions/s1/verifications' && item.init?.body === JSON.stringify({ command: 'pnpm test' }))).toBe(true));
    await user.click(screen.getByText('等待 GitHub Actions 完成'));
    await user.type(screen.getByLabelText('工作流（可选）'), 'ci.yml');
    await user.click(screen.getByRole('button', { name: '开始等待' }));
    await waitFor(() => expect(requests.some(item => item.url === '/api/sessions/s1/automation/ci' && item.init?.body === JSON.stringify({ workflow: 'ci.yml', ttlSeconds: 86400 }))).toBe(true));
    expect(screen.getByText('已开始等待当前提交的 GitHub Actions；续作开始前可取消等待。')).toBeTruthy();
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
});
