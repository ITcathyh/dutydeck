import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import App from './App';
import { SessionDeliveryPanel } from './components/SessionDeliveryPanel';
import { SessionInsightPanel } from './components/SessionInsightPanel';
import type { Session } from './api';

const session: Session = { id: 's1', agentId: 'a', cwd: '/workspace', state: 'idle', runId: 'r1', createdAt: '', updatedAt: '' };
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient();
  onlineManager.setOnline(false);
});

afterEach(() => {
  cleanup();
  client.clear();
  onlineManager.setOnline(true);
});

it('uses foreground polling and reports read failures on both session lists', () => {
  render(<QueryClientProvider client={client}>
    <App/>
    <SessionInsightPanel sessionId={session.id} onCompareSessionChange={() => {}} onClose={() => {}}/>
  </QueryClientProvider>);
  for (const queryKey of [['sessions'], ['sessions', null]]) {
    const query = client.getQueryCache().find({ queryKey, exact: true });
    expect.soft(query?.options).toMatchObject({ retry: false, refetchInterval: 15_000, refetchIntervalInBackground: false });
  }
  expect(client.getQueryCache().find({ queryKey: ['tasks', undefined], exact: true })?.options.retry).toBe(false);
});

it('refreshes delivery usage at the session rate under its existing key', () => {
  render(<QueryClientProvider client={client}>
    <SessionDeliveryPanel session={session} tasks={[]} onClose={() => {}}/>
  </QueryClientProvider>);
  expect(client.getQueryCache().find({ queryKey: ['sessionUsage', session.id], exact: true })?.options)
    .toMatchObject({ retry: false, refetchInterval: 15_000, refetchIntervalInBackground: false });
});
