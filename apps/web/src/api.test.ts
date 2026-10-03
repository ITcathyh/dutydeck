import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, eventsUrl, insightApi, setShareToken, withShareToken, type Session } from './api';
import { setInstance } from './instance';

afterEach(() => vi.unstubAllGlobals());

describe('web api adapter', () => {
  it('构造 backward / forward 有界事件窗口 URL', () => {
    expect(eventsUrl('s1', { before: 200, limit: 50, direction: 'backward' })).toBe('/api/sessions/s1/events?before=200&limit=50&direction=backward');
    expect(eventsUrl('s1', { after: 200, limit: 50, direction: 'forward' })).toBe('/api/sessions/s1/events?after=200&limit=50&direction=forward');
  });

  it('分享页的请求都在查询串里带分享 token；没设置时 URL 不变', async () => {
    expect(withShareToken('/api/sessions/s1')).toBe('/api/sessions/s1');
    setShareToken('tok_1');
    try {
      expect(withShareToken('/api/sessions/s1/stream')).toBe('/api/sessions/s1/stream?share=tok_1');
      expect(withShareToken('/api/sessions/s1/events?before=2')).toBe('/api/sessions/s1/events?before=2&share=tok_1');
      const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'a/b' }) }));
      vi.stubGlobal('fetch', fetcher);
      await api.session('a/b');
      expect(fetcher).toHaveBeenCalledWith('/api/sessions/a%2Fb?share=tok_1', { credentials: 'same-origin' });
    } finally {
      setShareToken(undefined);
    }
    expect(withShareToken('/api/sessions/s1')).toBe('/api/sessions/s1');
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

  it('setSessionName 使用 PATCH /api/sessions/:id/name 提交名称或 null', async () => {
    const sessionWithName: Session = { id: 's/1', agentId: 'codex', state: 'idle', cwd: '/repo', runId: 'r1', name: '自定义任务名', createdAt: '', updatedAt: '' };
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => sessionWithName }));
    vi.stubGlobal('fetch', fetcher);

    await expect(api.setSessionName('s/1', '自定义任务名')).resolves.toEqual(sessionWithName);
    expect(fetcher).toHaveBeenCalledWith('/api/sessions/s%2F1/name', {
      credentials: 'same-origin',
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '自定义任务名' })
    });

    await expect(api.setSessionName('s/1', null)).resolves.toEqual(sessionWithName);
    expect(fetcher).toHaveBeenCalledWith('/api/sessions/s%2F1/name', {
      credentials: 'same-origin',
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: null })
    });
  });
});

describe('insightApi 会话分析', () => {
  afterEach(() => setInstance(undefined));

  it('details 带可选 snapshotId，GET 走实例路径且不触发分析', async () => {
    const data = { status: { sessionId: 's1', refreshState: 'idle', availability: 'none', freshness: 'unknown', currentSnapshotId: null }, summary: null, manifest: null, hostEvidence: null };
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => data }));
    vi.stubGlobal('fetch', fetcher);
    await expect(insightApi.details('s1')).resolves.toEqual(data);
    expect(fetcher).toHaveBeenLastCalledWith('/api/sessions/s1/insight', { credentials: 'same-origin', cache: 'no-store', signal: undefined });
    await insightApi.details('s/1', 'snap_2');
    expect(fetcher).toHaveBeenLastCalledWith('/api/sessions/s%2F1/insight?snapshotId=snap_2', { credentials: 'same-origin', cache: 'no-store', signal: undefined });
  });

  it('refresh 发空 JSON body，cancel 走 DELETE', async () => {
    const fetcher = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes('refresh/') ? { success: true, state: 'cancelled' } : { requestId: 'req_1', state: 'queued' }
    }));
    vi.stubGlobal('fetch', fetcher);
    await insightApi.refresh('s1');
    expect(fetcher).toHaveBeenCalledWith('/api/sessions/s1/insight/refresh', {
      credentials: 'same-origin', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    await insightApi.cancel('s1', 'req_1');
    expect(fetcher).toHaveBeenCalledWith('/api/sessions/s1/insight/refresh/req_1', { credentials: 'same-origin', method: 'DELETE' });
  });

  it('events 固定 snapshotId 与分页筛选参数，不跨快照混页', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ snapshotId: 'snap_1', items: [], nextCursor: null, totalMatching: 0 }) }));
    vi.stubGlobal('fetch', fetcher);
    await insightApi.events('s1', { snapshotId: 'snap_1', kind: 'tool_call', result: 'failure', cursor: 'cur_1', limit: 200 });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/sessions/s1/insight/events?snapshotId=snap_1&limit=200&cursor=cur_1&kind=tool_call&result=failure',
      { credentials: 'same-origin', cache: 'no-store', signal: undefined }
    );
    // limit 缺省为 100。
    await insightApi.events('s1', { snapshotId: 'snap_1' });
    expect(fetcher).toHaveBeenLastCalledWith('/api/sessions/s1/insight/events?snapshotId=snap_1&limit=100', { credentials: 'same-origin', cache: 'no-store', signal: undefined });
  });

  it('summary 把 cohort 过滤与分组序列化进查询串', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ candidateSessions: 0, withSnapshot: 0, withoutSnapshot: 0, partialSnapshots: 0, failedRefreshes: 0, staleSnapshots: 0, freshnessUnknown: 0, groups: [], sessions: [], nextCursor: null }) }));
    vi.stubGlobal('fetch', fetcher);
    await insightApi.summary({ workspace: 'repo', agentId: 'a1', usage: 'explicit', includeArchived: false, groupBy: 'agent', limit: 50 });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/insights/summary?workspace=repo&agentId=a1&usage=explicit&includeArchived=false&groupBy=agent&limit=50',
      { credentials: 'same-origin', cache: 'no-store', signal: undefined }
    );
  });

  it('compare 用 POST body 指定两侧 sessionId + snapshotId', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ comparable: false, incomparableReasons: [], metricDiffs: {} }) }));
    vi.stubGlobal('fetch', fetcher);
    const body = { left: { sessionId: 's1', snapshotId: 'p1' }, right: { sessionId: 's2', snapshotId: 'p2' } };
    await insightApi.compare(body);
    expect(fetcher).toHaveBeenCalledWith('/api/insights/compare', {
      credentials: 'same-origin', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: undefined
    });
  });

  it('所有分析请求在远端实例下都走 /api/instances/<id> 代理前缀', async () => {
    setInstance('tag');
    const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ [url]: true }) }));
    vi.stubGlobal('fetch', fetcher);
    await insightApi.details('s1');
    await insightApi.summary({ groupBy: 'workspace' });
    const urls = fetcher.mock.calls.map(call => call[0] as string);
    expect(urls).toContain('/api/instances/tag/sessions/s1/insight');
    expect(urls).toContain('/api/instances/tag/insights/summary?groupBy=workspace');
  });

  it('exportReport 用实例路径 POST 并按 Content-Disposition 得到 Blob 文件名', async () => {
    setInstance('tag');
    const fetcher = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'Content-Disposition': "attachment; filename=\"session-insight-s1-2026-10-03.md\"" }),
      blob: async () => new Blob(['# report'], { type: 'text/markdown' })
    }));
    vi.stubGlobal('fetch', fetcher);
    const result = await insightApi.exportReport({ kind: 'session', sessionId: 's1', snapshotId: 'p1', format: 'markdown' });
    expect(fetcher).toHaveBeenCalledWith('/api/instances/tag/insights/export', {
      credentials: 'same-origin', method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'session', sessionId: 's1', snapshotId: 'p1', format: 'markdown' })
    });
    expect(result.filename).toBe('session-insight-s1-2026-10-03.md');
    expect(result.blob.type).toBe('text/markdown');
  });

  it('exportReport 无 Content-Disposition 时用安全回退文件名', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, headers: new Headers(), blob: async () => new Blob(['<html/>'], { type: 'text/html' }) }));
    vi.stubGlobal('fetch', fetcher);
    const result = await insightApi.exportReport({
      kind: 'comparison',
      left: { sessionId: 's1', snapshotId: 'p1' },
      right: { sessionId: 's2', snapshotId: 'p2' },
      format: 'html'
    });
    expect(result.filename).toBe('session-insight-comparison.html');
  });

  it('分析请求 401 触发未授权事件，错误体解析为 ApiError', async () => {
    const listener = vi.fn();
    window.addEventListener('dutydeck:unauthorized', listener);
    const fetcher = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'INSIGHT_FORBIDDEN', message: '需要管理员权限' } }) }));
    vi.stubGlobal('fetch', fetcher);
    await expect(insightApi.details('s1')).rejects.toMatchObject({ code: 'INSIGHT_FORBIDDEN', status: 401 });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dutydeck:unauthorized', listener);
  });

  it('exportReport 失败时解析 JSON 错误，不把错误响应当文件下载', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 429,
      clone: () => ({ json: async () => ({ error: { code: 'INSIGHT_QUEUE_FULL', message: '队列已满' } }) }),
      json: async () => ({ error: { code: 'INSIGHT_QUEUE_FULL', message: '队列已满' } })
    }));
    vi.stubGlobal('fetch', fetcher);
    await expect(insightApi.exportReport({ kind: 'session', sessionId: 's1', snapshotId: 'p1', format: 'html' }))
      .rejects.toMatchObject({ code: 'INSIGHT_QUEUE_FULL', status: 429 });
  });
});
