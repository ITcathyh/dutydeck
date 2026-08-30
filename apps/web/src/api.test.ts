import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, eventsUrl, type Session } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('web api adapter', () => {
  it('构造 backward / forward 有界事件窗口 URL', () => {
    expect(eventsUrl('s1', { before: 200, limit: 50, direction: 'backward' })).toBe('/api/sessions/s1/events?before=200&limit=50&direction=backward');
    expect(eventsUrl('s1', { after: 200, limit: 50, direction: 'forward' })).toBe('/api/sessions/s1/events?after=200&limit=50&direction=forward');
  });

  it('restart 调用现有 Session 恢复路由', async () => {
    const session: Session = { id: 's1', agentId: 'codex', state: 'starting', cwd: '/repo', runId: 'r1', createdAt: '', updatedAt: '' };
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => session }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.restart('s1')).resolves.toEqual(session);
    expect(fetcher).toHaveBeenCalledWith('/api/sessions/s1/restart', { credentials: 'same-origin', method: 'POST' });
  });
});
