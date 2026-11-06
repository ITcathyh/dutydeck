import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VerificationSummary } from './VerificationSummary';
import { IDLE_VERIFICATION_POLL_MS, RUNNING_VERIFICATION_POLL_MS, useVerifications } from './useVerifications';
import type { Session } from '../api';

const session: Session = { id: 's1', agentId: 'a', cwd: '/project', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
let records: unknown[] = [];
let reads = 0;

beforeEach(() => {
  // Only the clock is fake; response bodies still resolve on real microtasks and immediates.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  reads = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const isEvidence = String(url).endsWith('/verifications');
    if (isEvidence) reads++;
    return new Response(JSON.stringify(isEvidence ? records : { verification: 'available' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setVisibility('visible');
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** A refetch result reaches the component a few scheduler ticks after the request. */
const settle = async () => { for (let tick = 0; tick < 5; tick++) await advance(10); };
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}
function Probe({ active }: { active?: boolean }) {
  const query = useVerifications(session.id, { active });
  return <p>{query.data ? 'loaded' : 'loading'}</p>;
}

describe('verification polling', () => {
  it('reads every 60 seconds without a running verification and shows a code change within that window', async () => {
    records = [{ id: 'v', status: 'passed', stale: false }];
    render(<QueryClientProvider client={client()}><VerificationSummary session={session} onOpenEvidence={() => {}}/></QueryClientProvider>);
    await advance(0);
    expect(screen.getByText('验证通过')).toBeTruthy();
    expect(reads).toBe(1);

    records = [{ id: 'v', status: 'passed', stale: true, staleReason: 'code_changed' }];
    await advance(IDLE_VERIFICATION_POLL_MS - 1_000);
    expect(reads).toBe(1);
    expect(screen.getByText('验证通过')).toBeTruthy();
    await advance(1_000);
    expect(reads).toBe(2);
    await settle();
    expect(screen.getByText('验证通过 · 代码已变化')).toBeTruthy();
  });

  it('follows a running verification every 5 seconds and slows down once it settles', async () => {
    records = [{ id: 'v', status: 'running', stale: false }];
    render(<QueryClientProvider client={client()}><VerificationSummary session={session} onOpenEvidence={() => {}}/></QueryClientProvider>);
    await advance(0);
    expect(screen.getByText('验证中')).toBeTruthy();
    await advance(RUNNING_VERIFICATION_POLL_MS);
    expect(reads).toBe(2);
    records = [{ id: 'v', status: 'passed', stale: false }];
    await advance(RUNNING_VERIFICATION_POLL_MS);
    expect(reads).toBe(3);
    await settle();
    expect(screen.getByText('验证通过')).toBeTruthy();
    await advance(IDLE_VERIFICATION_POLL_MS - 1_000 - 50);
    expect(reads).toBe(3);
    await advance(1_000);
    expect(reads).toBe(4);
  });

  it('polls every 5 seconds while this page has a verification request in flight', async () => {
    records = [];
    const qc = client();
    const view = render(<QueryClientProvider client={qc}><Probe active/></QueryClientProvider>);
    await advance(0);
    await advance(RUNNING_VERIFICATION_POLL_MS);
    expect(reads).toBe(2);
    view.rerender(<QueryClientProvider client={qc}><Probe active={false}/></QueryClientProvider>);
    await advance(RUNNING_VERIFICATION_POLL_MS * 2);
    expect(reads).toBe(2);
  });

  it('reads once immediately when the window regains focus or the page becomes visible, not while hidden', async () => {
    records = [{ id: 'v', status: 'passed', stale: false }];
    render(<QueryClientProvider client={client()}><VerificationSummary session={session} onOpenEvidence={() => {}}/></QueryClientProvider>);
    await advance(0);
    expect(reads).toBe(1);

    records = [{ id: 'v', status: 'passed', stale: true, staleReason: 'code_changed' }];
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await advance(0);
    expect(reads).toBe(2);
    expect(screen.getByText('验证通过 · 代码已变化')).toBeTruthy();

    // Focus and visibility arriving together trigger one read.
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await advance(0);
    expect(reads).toBe(3);

    setVisibility('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await advance(0);
    expect(reads).toBe(3);
    setVisibility('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await advance(0);
    expect(reads).toBe(4);
  });
});
