import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  createContinuousMetric,
  createCountMetric,
  type FileMetrics,
  type HostEvidenceSnapshot,
  type SessionInsightDetailsResponse,
  type SessionInsightCompareResponse,
  type SessionInsightEventsResponse,
  type SessionInsightSummary,
  type SessionInsightManifest
} from '@dutydeck/shared';
import { buildApp } from './app.js';
import {
  registerSessionInsightRoutes,
  type SessionInsightApi,
  type SessionInsightRouteOptions
} from './session-insight-routes.js';
import { isSharedInstanceRead } from './instance-proxy.js';

// ----------------------------------------------------------------------------
// 最小合法冻结契约 fixture（仅用于通过输出 schema 校验，非真实引擎结果）
// ----------------------------------------------------------------------------

const SHA = '4eca389acf9738934ae7fdc35a2ef4dfc34dcad94e90530fad96b2ad906006e3';
const DATE = '2026-10-03T10:00:00.000Z';

function metrics(): FileMetrics {
  const m = { value: 0, quality: 'exact' as const, status: 'available' as const };
  const c = () => createCountMetric(m);
  const t = () => createContinuousMetric(m);
  return {
    inputUncached: c(), cacheRead: c(), cacheWrite: c(), output: c(),
    reasoningOutput: createCountMetric({ value: null, quality: 'unknown', status: 'unavailable' }),
    totalTracked: c(), rawInput: c(), rawOutput: c(),
    rawTotal: createCountMetric({ value: null, quality: 'unknown', status: 'unavailable' }),
    peakContext: c(),
    contextWindow: createCountMetric({ value: null, quality: 'unknown', status: 'unavailable' }),
    elapsedDurationMs: t(), activeDurationMs: t(), idleDurationMs: t(), pairedToolDurationMs: t(),
    userTurns: c(), assistantTurns: c(), toolCalls: c(), toolFailures: c(), toolSuccesses: c(),
    toolUnknowns: c(), toolFailureRate: t(), compactionCount: c(), subagentCount: c()
  };
}

const coverage = () => ({
  rawLines: 1, parsedLines: 1, ignoredLines: 0, errorLines: 0,
  timeRange: { start: DATE, end: DATE },
  missingTimestampCount: 0, disorderedTimestampCount: 0,
  retainedTraceCount: 1, omittedTraceCount: 0, omittedTraceByCategory: {},
  tokenSamplesAvailable: 1, tokenSamplesMissing: 0,
  subagentDiscovery: 'none' as const, inheritedHistory: 'none' as const
});

function makeSummary(sessionId: string, snapshotId: string): SessionInsightSummary {
  return {
    schemaVersion: 1, sessionId, snapshotId, createdAt: DATE,
    primarySourceKey: 'src_main', models: ['model-a'], isMultiModel: false,
    aggregateMetrics: metrics(), qualityOverview: 'recorded',
    sources: [{
      sourceKey: 'src_main', client: 'claude', streamIdentity: { kind: 'main', nativeAgentId: null },
      sha256: SHA, status: 'ok', scopeRole: 'primary', metrics: metrics(), models: ['model-a'],
      coverage: coverage(),
      relationship: { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] },
      aggregation: { eligibility: 'eligible', reasonCodes: [] },
      keyEvidenceEventIds: { failures: [], slowCalls: [], highTokenDeltas: [] }
    }],
    keyEvidenceEventIds: { failures: [], slowCalls: [], highTokenDeltas: [] },
    pulseBuckets: []
  };
}

function makeManifest(sessionId: string, snapshotId: string): SessionInsightManifest {
  return {
    snapshotId, sessionId, createdAt: DATE, bindingRevision: 0,
    hostEvidenceDigest: SHA, sources: [],
    versions: { schemaVersion: 1, engineVersion: 'eng-1', parserVersion: 'par-1', metricVersion: 'met-1', redactionVersion: 'red-1' }
  };
}

function makeHostEvidence(capturedAt = DATE): HostEvidenceSnapshot {
  return { capturedAt, digest: SHA };
}

function makeDetails(sessionId: string, snapshotId = 'snap_1'): SessionInsightDetailsResponse {
  return {
    status: {
      sessionId, refreshState: 'succeeded', availability: 'complete', freshness: 'current',
      currentSnapshotId: snapshotId, lastCheckedAt: DATE
    },
    summary: makeSummary(sessionId, snapshotId),
    manifest: makeManifest(sessionId, snapshotId),
    hostEvidence: makeHostEvidence()
  };
}

const makeEvents = (snapshotId: string): SessionInsightEventsResponse => ({
  snapshotId,
  items: [{
    eventId: 'evt_1', sourceKey: 'src_main', nativeSessionId: 'native_1',
    lineNumber: 1, byteOffset: 0, subeventIndex: 0, timestamp: DATE,
    timeQuality: 'exact', kind: 'user_message', snapshotId, ordinal: 0
  }],
  nextCursor: null, totalMatching: 1
});

const makeSummaryResponse = () => ({
  candidateSessions: 0, withSnapshot: 0, withoutSnapshot: 0, partialSnapshots: 0,
  failedRefreshes: 0, staleSnapshots: 0, freshnessUnknown: 0,
  groups: [], sessions: [], nextCursor: null
});

function makeCompare(): SessionInsightCompareResponse {
  return {
    left: makeSummary('ses_a', 'snap_a'), right: makeSummary('ses_b', 'snap_b'),
    leftManifest: makeManifest('ses_a', 'snap_a'), rightManifest: makeManifest('ses_b', 'snap_b'),
    leftHostEvidence: makeHostEvidence(), rightHostEvidence: makeHostEvidence(),
    comparable: true, metricDiffs: {}
  };
}

const UUID = '12345678-1234-1234-1234-123456789012';

// 记录每个方法被调用时的完整入参；默认返回合法契约对象。
function makeService(overrides: Partial<Record<keyof SessionInsightApi, unknown>> = {}) {
  const base: SessionInsightApi = {
    details: vi.fn(async (sessionId: string, snapshotId?: string) => makeDetails(sessionId, snapshotId ?? 'snap_1')),
    refresh: vi.fn(async () => ({ requestId: UUID, state: 'queued', cacheHit: false })),
    cancel: vi.fn(async () => ({ success: true, state: 'cancelled' })),
    events: vi.fn(async (_s: string, query: { snapshotId: string }) => makeEvents(query.snapshotId)),
    summary: vi.fn(async () => makeSummaryResponse()),
    compare: vi.fn(async () => makeCompare()),
    exportReport: vi.fn(async (request: { format: 'markdown' | 'html'; snapshotId?: string }) => ({
      body: '# report',
      contentType: request.format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
      filename: `session-insight-${request.snapshotId ?? 'snap_1'}-2026-10-03.${request.format === 'html' ? 'html' : 'md'}`
    }))
  };
  return Object.assign(base, overrides) as SessionInsightApi & Record<keyof SessionInsightApi, ReturnType<typeof vi.fn>>;
}

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function startInsightApp(options?: SessionInsightRouteOptions): Promise<FastifyInstance> {
  app = Fastify();
  registerSessionInsightRoutes(app, options);
  await app.ready();
  return app;
}

const ROUTES_WITHOUT_BODY: Array<{ method: 'GET' | 'DELETE'; url: string }> = [
  { method: 'GET', url: '/api/sessions/ses_1/insight' },
  { method: 'DELETE', url: `/api/sessions/ses_1/insight/refresh/${UUID}` },
  { method: 'GET', url: '/api/sessions/ses_1/insight/events?snapshotId=snap_1' },
  { method: 'GET', url: '/api/insights/summary' }
];
const ROUTES_WITH_BODY: Array<{ method: 'POST'; url: string; payload: unknown }> = [
  { method: 'POST', url: '/api/sessions/ses_1/insight/refresh', payload: {} },
  { method: 'POST', url: '/api/insights/compare', payload: { left: { sessionId: 'ses_a', snapshotId: 'snap_a' }, right: { sessionId: 'ses_b', snapshotId: 'snap_b' } } },
  { method: 'POST', url: '/api/insights/export', payload: { kind: 'session', sessionId: 'ses_a', snapshotId: 'snap_a', format: 'markdown' } }
];

// ----------------------------------------------------------------------------
// 鉴权：fail-closed、先于一切、异常安全
// ----------------------------------------------------------------------------

describe('session insight authorization', () => {
  it('denies every route with 403 when no options are registered (default deny)', async () => {
    const fastify = await startInsightApp(undefined);
    for (const route of ROUTES_WITHOUT_BODY) {
      const response = await fastify.inject(route);
      expect(response.statusCode, route.url).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'INSIGHT_FORBIDDEN' } });
    }
    for (const route of ROUTES_WITH_BODY) {
      const response = await fastify.inject(route);
      expect(response.statusCode, route.url).toBe(403);
    }
  });

  it('denies every route when authorize is absent even with a service wired', async () => {
    const service = makeService();
    const fastify = await startInsightApp({ service });
    for (const route of [...ROUTES_WITHOUT_BODY, ...ROUTES_WITH_BODY]) {
      expect((await fastify.inject(route)).statusCode, route.url).toBe(403);
    }
    for (const method of Object.keys(service)) {
      expect((service as unknown as Record<string, ReturnType<typeof vi.fn>>)[method]!).not.toHaveBeenCalled();
    }
  });

  it('authorizes before body/schema parsing: malformed body is still 403, not 400', async () => {
    const fastify = await startInsightApp({ service: makeService() });
    const response = await fastify.inject({ method: 'POST', url: '/api/insights/export', payload: '{ broken json', headers: { 'content-type': 'application/json' } });
    expect(response.statusCode).toBe(403);
  });

  it('authorizes before param/schema parsing: bad id is 403 when denied, 400 when allowed', async () => {
    const denied = await startInsightApp({ service: makeService(), authorize: () => false });
    expect((await denied.inject({ method: 'GET', url: '/api/sessions/bad%2Fid/insight' })).statusCode).toBe(403);
    await denied.close();

    const allowed = await startInsightApp({ service: makeService(), authorize: () => true });
    app = allowed;
    expect((await allowed.inject({ method: 'GET', url: '/api/sessions/bad%2Fid/insight' })).statusCode).toBe(400);
  });

  it('treats authorize returning false or throwing as identical 403 and never reaches the service', async () => {
    for (const authorize of [() => false, () => { throw new Error('auth-down-canary'); }, async () => { throw new Error('auth-reject-canary'); }]) {
      const service = makeService();
      const fastify = await startInsightApp({ service, authorize });
      const response = await fastify.inject({ method: 'GET', url: '/api/sessions/unknown-session/insight' });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'INSIGHT_FORBIDDEN', message: 'Installation administrator authorization is required' } });
      expect(JSON.stringify(response.json())).not.toContain('canary');
      expect(service.details).not.toHaveBeenCalled();
      await fastify.close();
    }
    app = undefined;
  });

  it('returns 503 unavailable when authorize passes but no service is wired', async () => {
    const fastify = await startInsightApp({ authorize: () => true });
    for (const route of ROUTES_WITHOUT_BODY) {
      expect((await fastify.inject(route)).statusCode, route.url).toBe(503);
    }
    for (const route of ROUTES_WITH_BODY) {
      expect((await fastify.inject(route)).statusCode, route.url).toBe(503);
    }
  });

  it('invokes authorize before the service lookup on every route (call ordering)', async () => {
    const order: string[] = [];
    const service = makeService();
    const track = (name: string, fn: ReturnType<typeof vi.fn>) => fn.mockImplementation(async (...args: unknown[]) => { order.push(`service:${name}`); return (baseImpl[name] as (...a: unknown[]) => unknown)(...args); });
    const baseImpl = {
      details: service.details.getMockImplementation()!,
      refresh: service.refresh.getMockImplementation()!,
      cancel: service.cancel.getMockImplementation()!,
      events: service.events.getMockImplementation()!,
      summary: service.summary.getMockImplementation()!,
      compare: service.compare.getMockImplementation()!,
      exportReport: service.exportReport.getMockImplementation()!
    };
    track('details', service.details); track('refresh', service.refresh); track('cancel', service.cancel);
    track('events', service.events); track('summary', service.summary); track('compare', service.compare);
    track('exportReport', service.exportReport);
    const fastify = await startInsightApp({
      service,
      authorize: () => { order.push('authorize'); return true; }
    });
    for (const route of ROUTES_WITHOUT_BODY) await fastify.inject(route);
    for (const route of ROUTES_WITH_BODY) await fastify.inject(route);
    // 7 个请求各一次 authorize，且每个 service 调用紧邻其前的 authorize。
    expect(order.filter(e => e === 'authorize')).toHaveLength(7);
    for (let i = 0; i < order.length; i++) {
      if (order[i]!.startsWith('service:')) expect(order[i - 1]).toBe('authorize');
    }
  });
});

// ----------------------------------------------------------------------------
// 严格输入契约
// ----------------------------------------------------------------------------

describe('session insight strict input schemas', () => {
  async function allowedApp(service = makeService()) {
    return startInsightApp({ service, authorize: () => true });
  }

  it('events requires snapshotId, bounds limit (default 100, max 200), cursor length and enums', async () => {
    const service = makeService();
    const fastify = await allowedApp(service);
    const get = (url: string) => fastify.inject({ method: 'GET', url });

    expect((await get('/api/sessions/ses_1/insight/events')).statusCode).toBe(400);
    expect((await get('/api/sessions/ses_1/insight/events?snapshotId=snap_1&limit=0')).statusCode).toBe(400);
    expect((await get('/api/sessions/ses_1/insight/events?snapshotId=snap_1&limit=201')).statusCode).toBe(400);
    expect((await get('/api/sessions/ses_1/insight/events?snapshotId=snap_1&limit=abc')).statusCode).toBe(400);
    expect((await get('/api/sessions/ses_1/insight/events?snapshotId=snap_1&kind=not_a_kind')).statusCode).toBe(400);
    expect((await get('/api/sessions/ses_1/insight/events?snapshotId=snap_1&result=maybe')).statusCode).toBe(400);
    expect((await get(`/api/sessions/ses_1/insight/events?snapshotId=snap_1&cursor=${'x'.repeat(513)}`)).statusCode).toBe(400);
    expect((await get('/api/sessions/ses_1/insight/events?snapshotId=snap_1&unexpected=1')).statusCode).toBe(400);

    const defaultLimit = await get('/api/sessions/ses_1/insight/events?snapshotId=snap_1');
    expect(defaultLimit.statusCode).toBe(200);
    expect(service.events).toHaveBeenLastCalledWith('ses_1', expect.objectContaining({ snapshotId: 'snap_1', limit: 100 }));
    const maxLimit = await get('/api/sessions/ses_1/insight/events?snapshotId=snap_1&limit=200&kind=tool_call&tool=Bash&result=failure');
    expect(maxLimit.statusCode).toBe(200);
    expect(service.events).toHaveBeenLastCalledWith('ses_1', {
      snapshotId: 'snap_1', limit: 200, kind: 'tool_call', tool: 'Bash', result: 'failure'
    });
  });

  it('summary bounds limit (default 50, max 100), groupBy/usage enums and from<to', async () => {
    const service = makeService();
    const fastify = await allowedApp(service);
    const get = (url: string) => fastify.inject({ method: 'GET', url });

    expect((await get('/api/insights/summary?limit=0')).statusCode).toBe(400);
    expect((await get('/api/insights/summary?limit=101')).statusCode).toBe(400);
    expect((await get('/api/insights/summary?groupBy=planet')).statusCode).toBe(400);
    expect((await get('/api/insights/summary?usage=mystery')).statusCode).toBe(400);
    expect((await get('/api/insights/summary?from=2026-10-03T10:00:00Z&to=2026-10-03T09:00:00Z')).statusCode).toBe(400);
    expect((await get('/api/insights/summary?unexpected=1')).statusCode).toBe(400);
    expect((await get(`/api/insights/summary?cursor=${'x'.repeat(513)}`)).statusCode).toBe(400);

    const ok = await get('/api/insights/summary?groupBy=agent&usage=explicit&includeArchived=true&from=2026-10-03T00:00:00Z&to=2026-10-04T00:00:00Z');
    expect(ok.statusCode).toBe(200);
    expect(service.summary).toHaveBeenLastCalledWith({
      groupBy: 'agent', usage: 'explicit', includeArchived: true,
      from: '2026-10-03T00:00:00Z', to: '2026-10-04T00:00:00Z', limit: 50
    });
  });

  it('accepts real workspace paths/groups (slash, spaces, unicode) and non-id agentId filters', async () => {
    const service = makeService();
    const fastify = await allowedApp(service);
    const workspace = '/data00/home/me/my repo/工作区';
    const agentId = 'cli_aa38d38298399be2';
    const url = `/api/insights/summary?workspace=${encodeURIComponent(workspace)}&agentId=${encodeURIComponent(agentId)}`;
    const response = await fastify.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(service.summary).toHaveBeenLastCalledWith({
      workspace, agentId, groupBy: 'workspace', includeArchived: false, limit: 50
    });

    // 控制字符（CRLF）即使编码后也拒绝，防止其进入下游查询/日志头。
    const crlf = await fastify.inject({
      method: 'GET',
      url: `/api/insights/summary?workspace=${encodeURIComponent('/data00/a\r\nb')}`
    });
    expect(crlf.statusCode).toBe(400);
  });

  it('refresh requires an empty strict object and a uuid requestId; compare/export reject unknown fields', async () => {
    const service = makeService();
    const fastify = await allowedApp(service);
    const inject = (method: 'POST' | 'DELETE', url: string, payload?: unknown) =>
      fastify.inject({ method, url, payload });

    expect((await inject('POST', '/api/sessions/ses_1/insight/refresh', { extra: 1 })).statusCode).toBe(400);
    // 缺省 body 合法（空对象）；显式 JSON null 被 strict object 拒绝。
    expect((await fastify.inject({ method: 'POST', url: '/api/sessions/ses_1/insight/refresh' })).statusCode).toBe(202);
    expect((await fastify.inject({ method: 'POST', url: '/api/sessions/ses_1/insight/refresh', payload: 'null', headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    expect((await inject('DELETE', '/api/sessions/ses_1/insight/refresh/not-a-uuid')).statusCode).toBe(400);
    expect((await inject('POST', '/api/insights/compare', { left: { sessionId: 'ses_a' } })).statusCode).toBe(400);
    expect((await inject('POST', '/api/insights/compare', { left: { sessionId: 'ses_a', snapshotId: 'snap_a' }, right: { sessionId: 'ses_b', snapshotId: 'snap_b' }, extra: 1 })).statusCode).toBe(400);
    expect((await inject('POST', '/api/insights/export', { kind: 'session', sessionId: 'ses_a', snapshotId: 'snap_a', format: 'pdf' })).statusCode).toBe(400);
    expect((await inject('POST', '/api/insights/export', { kind: 'other', sessionId: 'ses_a', snapshotId: 'snap_a', format: 'md' })).statusCode).toBe(400);
    expect((await inject('POST', '/api/insights/export', { kind: 'comparison', left: { sessionId: 'ses_a', snapshotId: 'snap_a' }, right: { sessionId: 'ses_b' }, format: 'html' })).statusCode).toBe(400);

    const okRefresh = await inject('POST', '/api/sessions/ses_1/insight/refresh', {});
    expect(okRefresh.statusCode).toBe(202);
    const okCancel = await inject('DELETE', `/api/sessions/ses_1/insight/refresh/${UUID}`);
    expect(okCancel.statusCode).toBe(200);
    expect(service.cancel).toHaveBeenLastCalledWith('ses_1', UUID);
  });

  it('rejects path-style / overlong / CRLF identifiers', async () => {
    const fastify = await allowedApp();
    // 普通非法字符必须由 schema 固定为 400。
    for (const id of ['a/b', 'a.b', 'a%0Db', 'a b', '']) {
      const url = `/api/sessions/${encodeURIComponent(id)}/insight`;
      expect((await fastify.inject({ method: 'GET', url })).statusCode, `id=${id}`).toBe(400);
    }
    // 超长路径参数会先撞 Fastify 默认 maxParamLength(100) 返回框架 404，或被 schema 400 拒绝；
    // 两种结果都是拒绝，不允许触达 service。
    const overlong = await fastify.inject({ method: 'GET', url: `/api/sessions/${'x'.repeat(129)}/insight` });
    expect([400, 404]).toContain(overlong.statusCode);
  });

  it('rejects binary or syntactically invalid JSON bodies with 400 once authorized', async () => {
    const fastify = await allowedApp();
    const broken = await fastify.inject({ method: 'POST', url: '/api/insights/compare', payload: '{oops', headers: { 'content-type': 'application/json' } });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe('INVALID_INPUT');
  });

  it('rejects unknown query parameters on details and all query-less routes without reaching the service', async () => {
    const service = makeService();
    const fastify = await allowedApp(service);

    // 1. details: 仅允许 snapshotId；未知 query（如 path=/private/canary）必须 400 且决不能调用 service
    const detailsExtra = await fastify.inject({
      method: 'GET',
      url: '/api/sessions/ses_1/insight?path=%2Fprivate%2Fcanary'
    });
    expect(detailsExtra.statusCode).toBe(400);
    expect(detailsExtra.json().error).toEqual({ code: 'INVALID_INPUT', message: 'Invalid input' });
    expect(service.details).not.toHaveBeenCalled();

    // 2. refresh: 无 query 路由，带 query 必须 400 且不触达 service
    const refreshQuery = await fastify.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/insight/refresh?query_canary=1',
      payload: {}
    });
    expect(refreshQuery.statusCode).toBe(400);
    expect(refreshQuery.json().error.code).toBe('INVALID_INPUT');
    expect(service.refresh).not.toHaveBeenCalled();

    // 3. cancel: 无 query 路由
    const cancelQuery = await fastify.inject({
      method: 'DELETE',
      url: `/api/sessions/ses_1/insight/refresh/${UUID}?query_canary=1`
    });
    expect(cancelQuery.statusCode).toBe(400);
    expect(cancelQuery.json().error.code).toBe('INVALID_INPUT');
    expect(service.cancel).not.toHaveBeenCalled();

    // 4. compare: 无 query 路由
    const compareQuery = await fastify.inject({
      method: 'POST',
      url: '/api/insights/compare?query_canary=1',
      payload: { left: { sessionId: 'ses_a', snapshotId: 'snap_a' }, right: { sessionId: 'ses_b', snapshotId: 'snap_b' } }
    });
    expect(compareQuery.statusCode).toBe(400);
    expect(compareQuery.json().error.code).toBe('INVALID_INPUT');
    expect(service.compare).not.toHaveBeenCalled();

    // 5. export: 无 query 路由
    const exportQuery = await fastify.inject({
      method: 'POST',
      url: '/api/insights/export?query_canary=1',
      payload: { kind: 'session', sessionId: 'ses_a', snapshotId: 'snap_a', format: 'markdown' }
    });
    expect(exportQuery.statusCode).toBe(400);
    expect(exportQuery.json().error.code).toBe('INVALID_INPUT');
    expect(service.exportReport).not.toHaveBeenCalled();
  });

  it('never echoes unknown keys, invalid enums, or canary values in 400 error responses', async () => {
    const service = makeService();
    const fastify = await allowedApp(service);

    // 1. body 中的未知 key / canary
    const badBody = await fastify.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/insight/refresh',
      payload: { 'token=API_INPUT_CANARY': true, secret_field: 'leak_me' }
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json()).toEqual({ error: { code: 'INVALID_INPUT', message: 'Invalid input' } });
    expect(badBody.body).not.toContain('API_INPUT_CANARY');
    expect(badBody.body).not.toContain('secret_field');
    expect(badBody.body).not.toContain('leak_me');
    expect(service.refresh).not.toHaveBeenCalled();

    // 2. query 中的未知 key / canary
    const badQuery = await fastify.inject({
      method: 'GET',
      url: '/api/sessions/ses_1/insight?SECRET_TOKEN_CANARY=xyz&path=%2Fetc%2Fshadow'
    });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.json()).toEqual({ error: { code: 'INVALID_INPUT', message: 'Invalid input' } });
    expect(badQuery.body).not.toContain('SECRET_TOKEN_CANARY');
    expect(badQuery.body).not.toContain('shadow');
    expect(service.details).not.toHaveBeenCalled();

    // 3. 非法 enum 选项不回显输入值
    const badEnum = await fastify.inject({
      method: 'GET',
      url: '/api/insights/summary?groupBy=ENUM_INJECTION_CANARY'
    });
    expect(badEnum.statusCode).toBe(400);
    expect(badEnum.json()).toEqual({ error: { code: 'INVALID_INPUT', message: 'Invalid input' } });
    expect(badEnum.body).not.toContain('ENUM_INJECTION_CANARY');
    expect(service.summary).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// 成功路径：完整入参传递、状态码、下载头、no-store
// ----------------------------------------------------------------------------

describe('session insight success paths and forwarding', () => {
  it('passes full inputs to details (with/without snapshotId) and maps cacheHit to 200/202', async () => {
    const service = makeService();
    const fastify = await startInsightApp({ service, authorize: () => true });

    const plain = await fastify.inject({ method: 'GET', url: '/api/sessions/ses_1/insight' });
    expect(plain.statusCode).toBe(200);
    expect(service.details).toHaveBeenLastCalledWith('ses_1', undefined);

    const pinned = await fastify.inject({ method: 'GET', url: '/api/sessions/ses_1/insight?snapshotId=snap_9' });
    expect(pinned.statusCode).toBe(200);
    expect(service.details).toHaveBeenLastCalledWith('ses_1', 'snap_9');

    expect((await fastify.inject({ method: 'POST', url: '/api/sessions/ses_1/insight/refresh', payload: {} })).statusCode).toBe(202);
    service.refresh.mockResolvedValueOnce({ requestId: UUID, state: 'succeeded', cacheHit: true, snapshotId: 'snap_1' });
    const hit = await fastify.inject({ method: 'POST', url: '/api/sessions/ses_1/insight/refresh', payload: {} });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toMatchObject({ cacheHit: true, snapshotId: 'snap_1' });
  });

  it('forwards both complete sides for compare and export, including comparison export', async () => {
    const service = makeService();
    const fastify = await startInsightApp({ service, authorize: () => true });

    const compare = await fastify.inject({
      method: 'POST', url: '/api/insights/compare',
      payload: { left: { sessionId: 'ses_a', snapshotId: 'snap_a' }, right: { sessionId: 'ses_b', snapshotId: 'snap_b' } }
    });
    expect(compare.statusCode).toBe(200);
    expect(service.compare).toHaveBeenLastCalledWith({
      left: { sessionId: 'ses_a', snapshotId: 'snap_a' },
      right: { sessionId: 'ses_b', snapshotId: 'snap_b' }
    });

    const comparisonExport = await fastify.inject({
      method: 'POST', url: '/api/insights/export',
      payload: { kind: 'comparison', left: { sessionId: 'ses_a', snapshotId: 'snap_a' }, right: { sessionId: 'ses_b', snapshotId: 'snap_b' }, format: 'html' }
    });
    expect(comparisonExport.statusCode).toBe(200);
    expect(service.exportReport).toHaveBeenLastCalledWith({
      kind: 'comparison',
      left: { sessionId: 'ses_a', snapshotId: 'snap_a' },
      right: { sessionId: 'ses_b', snapshotId: 'snap_b' },
      format: 'html'
    });
    expect(comparisonExport.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(comparisonExport.headers['x-content-type-options']).toBe('nosniff');
    expect(comparisonExport.headers['content-disposition']).toMatch(/^attachment; filename="[^"]+"$/);
  });

  it('serves markdown export with safe attachment headers and no-store', async () => {
    const service = makeService();
    const fastify = await startInsightApp({ service, authorize: () => true });
    const response = await fastify.inject({
      method: 'POST', url: '/api/insights/export',
      payload: { kind: 'session', sessionId: 'ses_a', snapshotId: 'snap_a', format: 'markdown' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('# report');
    expect(response.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename="session-insight-snap_a-2026-10-03.md"');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('sets no-store on both success and error responses', async () => {
    const service = makeService();
    const fastify = await startInsightApp({ service, authorize: () => true });
    expect((await fastify.inject({ method: 'GET', url: '/api/sessions/ses_1/insight' })).headers['cache-control']).toBe('no-store');
    expect((await fastify.inject({ method: 'GET', url: '/api/sessions/ses_1/insight/events' })).headers['cache-control']).toBe('no-store');
    service.details.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'INSIGHT_SNAPSHOT_GONE' }));
    const gone = await fastify.inject({ method: 'GET', url: '/api/sessions/ses_1/insight?snapshotId=old' });
    expect(gone.statusCode).toBe(410);
    expect(gone.headers['cache-control']).toBe('no-store');

    const deniedApp = await startInsightApp({ service, authorize: () => false });
    expect((await deniedApp.inject({ method: 'GET', url: '/api/sessions/ses_1/insight' })).headers['cache-control']).toBe('no-store');
  });
});

// ----------------------------------------------------------------------------
// 服务异常安全投影
// ----------------------------------------------------------------------------

describe('session insight service error mapping', () => {
  async function withError(reject: unknown) {
    const service = makeService();
    service.details.mockRejectedValueOnce(reject);
    const fastify = await startInsightApp({ service, authorize: () => true });
    return fastify.inject({ method: 'GET', url: '/api/sessions/unknown/insight' });
  }

  it.each([
    ['INSIGHT_NOT_FOUND', 404],
    ['INSIGHT_VERSION_MISMATCH', 409],
    ['INSIGHT_SNAPSHOT_GONE', 410],
    ['INSIGHT_QUEUE_FULL', 429],
    ['INSIGHT_SOURCE_CONFLICT', 409],
    ['INSIGHT_SOURCE_CHANGED', 409],
    ['INSIGHT_INPUT_LIMIT', 422],
    ['INSIGHT_BUDGET_EXCEEDED', 422],
    ['INSIGHT_REPORT_LIMIT', 413]
  ])('maps %s to fixed %i without echoing the service message', async (code, status) => {
    const response = await withError(Object.assign(new Error('/secret/path/root/.env stderr-canary body-canary'), { code }));
    expect(response.statusCode).toBe(status);
    const payload = response.json();
    expect(payload.error.code).toBe(code);
    expect(JSON.stringify(payload)).not.toMatch(/canary|\/secret\/path|\.env/);
  });

  it('maps unknown errors, raw errors and ZodError to a fixed 500 without leakage', async () => {
    const raw = await withError(new Error('/var/secret/transcript.jsonl engine stderr leaked-canary'));
    expect(raw.statusCode).toBe(500);
    expect(raw.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
    expect(raw.body).not.toMatch(/canary|transcript/);

    const noCode = await withError(Object.assign(new Error('x'), { code: 'SOME_INTERNAL_DETAIL' }));
    expect(noCode.statusCode).toBe(500);
    expect(noCode.body).not.toContain('SOME_INTERNAL_DETAIL');
  });

  it('returns 500 (not a broken download) when the report contract is violated', async () => {
    const service = makeService();
    const fastify = await startInsightApp({ service, authorize: () => true });
    const payload = { kind: 'session', sessionId: 'ses_a', snapshotId: 'snap_a', format: 'markdown' } as const;

    service.exportReport.mockResolvedValueOnce({ body: 'x', contentType: 'text/html; charset=utf-8', filename: 'session-insight-a-2026-10-03.md' });
    expect((await fastify.inject({ method: 'POST', url: '/api/insights/export', payload })).statusCode).toBe(500);

    service.exportReport.mockResolvedValueOnce({ body: 'x', contentType: 'text/markdown; charset=utf-8', filename: '../../etc/passwd.md' });
    expect((await fastify.inject({ method: 'POST', url: '/api/insights/export', payload })).statusCode).toBe(500);

    service.exportReport.mockResolvedValueOnce({ body: 'x', contentType: 'text/markdown; charset=utf-8', filename: 'a\r\nSet-Cookie: bad=1.md' });
    const injected = await fastify.inject({ method: 'POST', url: '/api/insights/export', payload });
    expect(injected.statusCode).toBe(500);
    expect(injected.headers['set-cookie']).toBeUndefined();

    service.exportReport.mockResolvedValueOnce({ body: 42 as unknown as string, contentType: 'text/markdown; charset=utf-8', filename: 'a-2026-10-03.md' });
    expect((await fastify.inject({ method: 'POST', url: '/api/insights/export', payload })).statusCode).toBe(500);
  });

  it('re-enforces the 16 MiB UTF-8 report budget at the route boundary', async () => {
    const service = makeService();
    service.exportReport.mockResolvedValueOnce({
      body: 'あ'.repeat(8 * 1024 * 1024 + 1), // >16 MiB UTF-8
      contentType: 'text/html; charset=utf-8',
      filename: 'session-insight-a-2026-10-03.html'
    });
    const fastify = await startInsightApp({ service, authorize: () => true });
    const response = await fastify.inject({
      method: 'POST', url: '/api/insights/export',
      payload: { kind: 'session', sessionId: 'ses_a', snapshotId: 'snap_a', format: 'html' }
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('INSIGHT_REPORT_LIMIT');
  });

  it('lets the service enforce snapshot ownership (404) without turning it into 500', async () => {
    const service = makeService();
    service.events.mockRejectedValueOnce(Object.assign(new Error('ownership-canary'), { code: 'INSIGHT_NOT_FOUND' }));
    const fastify = await startInsightApp({ service, authorize: () => true });
    const response = await fastify.inject({ method: 'GET', url: '/api/sessions/ses_1/insight/events?snapshotId=foreign' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('canary');
  });

  it.each([
    ['events', 'INSIGHT_INVALID_CURSOR', '/api/sessions/ses_1/insight/events?snapshotId=snap_1&cursor=abc'],
    ['summary', 'INSIGHT_SUMMARY_BAD_CURSOR', '/api/insights/summary?cursor=abc']
  ])('maps a bad/cross-snapshot %s cursor (%s) to 400, not 500', async (_which, code, url) => {
    const service = makeService();
    if (_which === 'events') service.events.mockRejectedValueOnce(Object.assign(new Error('cursor-canary'), { code }));
    else service.summary.mockRejectedValueOnce(Object.assign(new Error('cursor-canary'), { code }));
    const fastify = await startInsightApp({ service, authorize: () => true });
    const response = await fastify.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual({ code, message: 'Invalid pagination cursor' });
    expect(response.body).not.toContain('canary');
  });
});

// ----------------------------------------------------------------------------
// buildApp 接线 + 真实 auth 中间件：share token 不可取 insight；代理白名单不扩
// ----------------------------------------------------------------------------

describe('buildApp wiring and share/proxy isolation', () => {
  it('registers routes through buildApp: default deny, then service reachable with authorize', async () => {
    const service = makeService();
    const denied = await buildApp({} as never);
    expect((await denied.inject({ method: 'GET', url: '/api/sessions/ses_1/insight' })).statusCode).toBe(403);
    await denied.close();

    const wired = await buildApp({} as never, { insight: { service, authorize: () => true } });
    expect((await wired.inject({ method: 'GET', url: '/api/sessions/ses_1/insight' })).statusCode).toBe(200);
    await wired.close();
    app = undefined;
  });

  it('rejects a valid share token on insight routes through the real auth middleware', async () => {
    // 模拟 service.ts 的注入：principal 解析在带 share 的请求上不授予管理员。
    const service = makeService();
    const shareSecret = 'share-secret-value';
    const { signSessionShareToken } = await import('./auth/auth.js');
    const fastify = await buildApp({ getSession: async () => undefined } as never, {
      insight: {
        service,
        authorize: request => !Object.prototype.hasOwnProperty.call(request.query ?? {}, 'share')
      },
      auth: {
        mode: 'token', localOnly: false,
        getToken: async () => 'admin-token',
        getShareSecret: async () => shareSecret
      }
    });
    const token = signSessionShareToken(shareSecret, 'ses_1');
    // 普通 session 读路径白名单放行 share；insight 路径不在白名单 → 认证层 401。
    const allowedShareRoute = await fastify.inject({ method: 'GET', url: `/api/sessions/ses_1?share=${token}` });
    expect([200, 404]).toContain(allowedShareRoute.statusCode); // 过了认证（资源本身可能 404）
    for (const url of [
      `/api/sessions/ses_1/insight?share=${token}`,
      `/api/sessions/ses_1/insight/events?snapshotId=snap_1&share=${token}`,
      `/api/insights/summary?share=${token}`
    ]) {
      const response = await fastify.inject({ method: 'GET', url });
      expect(response.status, url).not.toBe(200);
      expect([401, 403]).toContain(response.statusCode);
    }
    expect(service.details).not.toHaveBeenCalled();
    expect(service.events).not.toHaveBeenCalled();
    await fastify.close();
    app = undefined;
  });

  it('does not widen the instance-proxy share whitelist for insight paths', async () => {
    const peers = [{ id: 'tag', name: 'Tag', url: 'http://127.0.0.1:9' }];
    const share = (url: string) => isSharedInstanceRead({ method: 'GET', url }, peers);
    expect(share('/api/instances/tag/sessions/ses_1/events?share=t')).toBe(true);
    expect(share('/api/instances/tag/sessions/ses_1/insight?share=t')).toBe(false);
    expect(share('/api/instances/tag/sessions/ses_1/insight/events?snapshotId=s&share=t')).toBe(false);
    expect(share('/api/instances/tag/insights/summary?share=t')).toBe(false);
    // 非 GET 的分析写操作永不进入 share 白名单。
    expect(isSharedInstanceRead({ method: 'POST', url: '/api/instances/tag/sessions/ses_1/insight/refresh?share=t' }, peers)).toBe(false);
  });

  // 真实 registerAuthMiddleware（非 mock authorize）+ 真实 insight 路由组合：
  // 生产里 parent auth 的 onRequest 早于 insight scope，auth 提前 send 时
  // scope 的 onRequest 会被跳过；no-store 必须在 onSend 阶段仍覆盖 7 个入口，
  // 包括 401（未登录 / share）与成功响应。
  it('sets no-store on all 7 endpoints across auth rejection (unauthenticated/share) and admin success', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerAuthMiddleware, signSessionShareToken } = await import('./auth/auth.js');
    const { registerSessionInsightRoutes: registerReal } = await import('./session-insight-routes.js');

    const shareSecret = 'real-share-secret';
    const adminToken = 'real-admin-token';
    const seven: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string; payload?: unknown }> = [
      { method: 'GET', url: '/api/sessions/ses_1/insight' },
      { method: 'POST', url: '/api/sessions/ses_1/insight/refresh', payload: {} },
      { method: 'DELETE', url: `/api/sessions/ses_1/insight/refresh/${UUID}` },
      { method: 'GET', url: '/api/sessions/ses_1/insight/events?snapshotId=snap_1' },
      { method: 'GET', url: '/api/insights/summary' },
      { method: 'POST', url: '/api/insights/compare', payload: { left: { sessionId: 'ses_a', snapshotId: 'snap_a' }, right: { sessionId: 'ses_b', snapshotId: 'snap_b' } } },
      { method: 'POST', url: '/api/insights/export', payload: { kind: 'session', sessionId: 'ses_a', snapshotId: 'snap_a', format: 'markdown' } }
    ];

    const fastify = Fastify();
    registerAuthMiddleware(fastify, {
      mode: 'token', localOnly: false,
      getToken: async () => adminToken,
      getShareSecret: async () => shareSecret
    });
    const service = makeService();
    registerReal(fastify, {
      service,
      // 镜像 service.ts 注入的 Boolean(await resolveInstallationPrincipal(request))：
      // 只有携带真实管理员凭据的请求才为 true；未登录/share 为 false。
      authorize: request => request.headers.authorization === `Bearer ${adminToken}`
    });
    await fastify.ready();

    // 1. 未登录：认证层 401，且 no-store 必须存在（t7c Security2 回归点）。
    for (const spec of seven) {
      const response = await fastify.inject(spec);
      expect(response.statusCode, `${spec.url} unauthenticated`).toBe(401);
      expect(response.headers['cache-control'], `${spec.url} unauthenticated no-store`).toBe('no-store');
    }

    // 2. 有效 share token：insight 路径不在分享白名单，认证层 401，且 no-store 存在。
    const shareToken = signSessionShareToken(shareSecret, 'ses_1');
    for (const spec of seven) {
      const separator = spec.url.includes('?') ? '&' : '?';
      const response = await fastify.inject({ ...spec, url: `${spec.url}${separator}share=${shareToken}` });
      expect(response.statusCode, `${spec.url} share`).toBe(401);
      expect(response.headers['cache-control'], `${spec.url} share no-store`).toBe('no-store');
    }

    // 3. 管理员：通过认证与 authorize，业务成功，且 no-store 存在。
    for (const spec of seven) {
      const response = await fastify.inject({ ...spec, headers: { authorization: `Bearer ${adminToken}` } });
      expect(response.statusCode, `${spec.url} admin`).toBeLessThan(300);
      expect(response.headers['cache-control'], `${spec.url} admin no-store`).toBe('no-store');
    }

    await fastify.close();
    app = undefined;
  });
});
