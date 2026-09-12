import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VerificationSummary } from './VerificationSummary';
import type { Session } from '../api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const session: Session = { id: 's1', agentId: 'a', cwd: '/project', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
function mount(records: unknown[], options: { unavailable?: boolean; failure?: boolean; loading?: boolean } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (options.loading) return new Promise<Response>(() => {});
    const isEvidence = String(url).endsWith('/verifications');
    const body = isEvidence ? records : { verification: options.unavailable ? 'unavailable' : 'available' };
    return new Response(JSON.stringify(body), { status: isEvidence && options.failure ? 503 : 200, headers: { 'content-type': 'application/json' } });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenEvidence = vi.fn();
  render(<QueryClientProvider client={qc}><VerificationSummary session={session} onOpenEvidence={onOpenEvidence}/></QueryClientProvider>);
  return { onOpenEvidence, qc };
}

describe('verification beside task results', () => {
  it('keeps a completed Agent task separate from failed command evidence and opens details', async () => {
    const { onOpenEvidence } = mount([{ id: 'v', status: 'failed', stale: false }]);
    await screen.findByText('验证失败');
    expect(screen.queryByText('验证通过')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '查看验证证据' }));
    expect(onOpenEvidence).toHaveBeenCalledOnce();
  });
  it.each([
    ['passed', 'code_changed', '验证通过 · 代码已变化'],
    ['passed', 'current_fingerprint_unavailable', '验证通过 · 无法确认当前版本'],
    ['passed', 'record_fingerprint_missing', '验证通过 · 无法确认当前版本'],
    ['passed', undefined, '验证通过 · 无法确认当前版本'],
    ['unverified', 'changed_during_run', '验证结论未确认 · 验证期间代码已变化'],
    ['running', 'record_fingerprint_missing', '验证中'],
    ['timed_out', undefined, '验证超时'],
    ['interrupted', undefined, '验证中断']
  ])('renders %s / %s with an evidence-backed label', async (status, staleReason, label) => {
    mount([{ id: 'v', status, stale: status === 'passed' || Boolean(staleReason), staleReason }]);
    await screen.findByText(label);
  });
  it('shows no record only after successful reads', async () => {
    mount([]);
    await screen.findByText('尚未验证');
  });
  it('shows platform unavailability independently of existing evidence', async () => {
    mount([{ id: 'v', status: 'passed', stale: false }], { unavailable: true });
    await screen.findByText('验证通过');
    expect(screen.getByText('平台验证当前不可用，以上为已有记录。')).toBeTruthy();
  });
  it('shows unavailable without manufacturing an unverified result', async () => {
    mount([], { unavailable: true });
    await screen.findByText('平台验证不可用');
    expect(screen.queryByText('尚未验证')).toBeNull();
  });
  it('does not report no verification while loading or when the request fails', async () => {
    mount([], { loading: true });
    expect(screen.getByText('正在读取验证状态')).toBeTruthy();
    expect(screen.queryByText('尚未验证')).toBeNull();
    cleanup(); vi.restoreAllMocks();
    mount([], { failure: true });
    await screen.findByText('验证状态读取失败');
    expect(screen.queryByText('尚未验证')).toBeNull();
  });
});
