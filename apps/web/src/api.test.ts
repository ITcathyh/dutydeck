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

  it('managementGroups 请求 /api/lark/management/groups', async () => {
    const data = { groups: [] };
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => data }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.managementGroups()).resolves.toEqual(data);
    expect(fetcher).toHaveBeenCalledWith('/api/lark/management/groups', { credentials: 'same-origin', cache: 'no-store' });
  });

  it('syncGroups 发起 POST 请求并携带空 body', async () => {
    const data = { groups: [] };
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => data }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.syncGroups('cli_test_app')).resolves.toEqual(data);
    expect(fetcher).toHaveBeenCalledWith('/api/lark/bots/cli_test_app/sync-groups', {
      credentials: 'same-origin',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
  });

  it('updateGroupBotBinding 发送 expectedRevision、patch 与 roleChanges', async () => {
    const updated = { appId: 'cli_test_app', applied: true, validity: 'valid', roles: [] };
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => updated }));
    vi.stubGlobal('fetch', fetcher);
    const body = {
      expectedRevision: 2,
      patch: { oncall: true },
      roleChanges: [{ kind: 'create' as const, principalId: 'principal_1', role: 'can_talk' as const, operateScope: 'none' as const, actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false } }]
    };
    await expect(api.updateGroupBotBinding('cli_test_app', 'oc_chat_1', body)).resolves.toEqual(updated);
    expect(fetcher).toHaveBeenCalledWith('/api/lark/bots/cli_test_app/groups/oc_chat_1', {
      credentials: 'same-origin',
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  });

  it('systemDirectories 请求 /api/system/directories 带 path 查询参数', async () => {
    const data = { path: '/home', roots: ['/home'], host: 'localhost', entries: [] };
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => data }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.systemDirectories('/home/project')).resolves.toEqual(data);
    expect(fetcher).toHaveBeenCalledWith('/api/system/directories?path=%2Fhome%2Fproject', { credentials: 'same-origin', cache: 'no-store' });
  });
});
