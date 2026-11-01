import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type Task, type TaskAuthorization } from '../api';
import { authorizationLabel, TaskAuthorizationPanel } from './TaskAuthorizationPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const tasks = [{ id: 't1', prompt: '第一轮' }, { id: 't2', prompt: '第二轮' }] as Task[];
const record: TaskAuthorization = { schemaVersion: 1, taskId: 't1', sessionId: 's1', strength: 'explicit', via: 'mention', recordedAt: '2026-11-01T00:00:00.000Z' };
describe('task authorization evidence', () => {
  it.each([
    ['mention', '被 @'], ['direct', '私聊'], ['topic_followup', '话题续接'], ['answer_reply', '回复提问']
  ] as const)('labels %s', (via, label) => expect(authorizationLabel({ ...record, via })).toBe(label));
  it('shows the latest confirmation and preserves earlier inferred evidence', async () => {
    vi.spyOn(api, 'taskAuthorizations').mockResolvedValue([
      { ...record, strength: 'inferred', via: 'scenario_direct', decisionId: 'd1' },
      { ...record, taskId: 't2', via: 'participation_confirmed', actorOpenId: 'ou_bob', decisionId: 'd2' }
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TaskAuthorizationPanel sessionId="s1" tasks={tasks}/></QueryClientProvider>);
    expect(await screen.findByText('依据：确认人 ou_bob（判断记录 d2）')).toBeTruthy();
    expect(screen.getByText('依据：推断（管理员配置的场景规则）（判断记录 d1）')).toBeTruthy();
  });
  it('never attributes an older Lark authorization to a newer Web task', async () => {
    vi.spyOn(api, 'taskAuthorizations').mockResolvedValue([record]);
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><TaskAuthorizationPanel sessionId="s1" tasks={tasks}/></QueryClientProvider>);
    expect(await screen.findByText('依据：本轮未记录。')).toBeTruthy();
    const history = screen.getByText('此前各轮依据').closest('details')!;
    expect(history.textContent).toContain('第一轮');
    expect(history.textContent).toContain('依据：被 @');
  });
  it('does not invent evidence for an older task without a record', async () => {
    vi.spyOn(api, 'taskAuthorizations').mockResolvedValue([]);
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><TaskAuthorizationPanel sessionId="s1" tasks={[]}/></QueryClientProvider>);
    await vi.waitFor(() => expect(api.taskAuthorizations).toHaveBeenCalled());
    expect(view.container.textContent).toBe('');
  });
});
