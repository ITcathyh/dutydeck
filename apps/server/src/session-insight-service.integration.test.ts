import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { createTranscriptSourceKeys } from '@dutydeck/runtime';
import { SESSION_INSIGHT_LIMITS, type InsightClient } from '@dutydeck/shared';
import { resolveSessionInsightEngine, executeEngineHandshake } from './session-insight-engine.js';
import { bundleForTest } from '../../../tests/support/bundle-for-test.js';
import { rememberSecretValues } from './platform/secret-redaction.js';
import { SessionInsightResolver } from './session-insight-resolver.js';
import { SessionInsightService } from './session-insight-service.js';

const at = '2026-10-03T03:00:00.000Z';
const stream = { kind: 'main' as const, nativeAgentId: null };
const roots: string[] = [];
const services: SessionInsightService[] = [];
const repositoryCleanups: Array<() => void> = [];
const bundleCleanups: Array<() => Promise<void>> = [];
const envRestores: Array<() => void> = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const cleanup of repositoryCleanups.splice(0)) cleanup();
  for (const cleanup of bundleCleanups.splice(0)) await cleanup();
  for (const restore of envRestores.splice(0)) restore();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// 真实引擎定位结果只读，fork 用例共享一次版本握手；每次分析仍启动真实分析器子进程。
let sharedEngine: ReturnType<typeof resolveSessionInsightEngine> | undefined;
const sharedResolveEngine = () => (sharedEngine ??= resolveSessionInsightEngine());

// Real resolver, immutable file capture, default analyzer subprocess and SQLite publication.
async function harness(client: InsightClient = 'codex', sessionCwd?: string, resolveEngine?: () => ReturnType<typeof resolveSessionInsightEngine>) {
  const root = await mkdtemp(join(tmpdir(), 'insight-integration-'));
  roots.push(root);
  const nativeRoot = join(root, 'native');
  const cwd = sessionCwd ?? join(root, 'workspace');
  const logDir = client === 'claude'
    ? join(nativeRoot, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'))
    : join(nativeRoot, ...(client === 'traex' ? ['cli'] : []), 'sessions', '2026', '10', '03');
  await mkdir(logDir, { recursive: true });
  if (!sessionCwd) await mkdir(cwd, { recursive: true });
  const databasePath = join(root, 'insight.db');
  let repos = createRepositories(databasePath, { newDatabaseAuthority: 'ledger_v1' });
  let claim = repos.control.attachRuntime('insight-integration');
  repositoryCleanups.push(() => { claim.release(); repos.close(); });
  let execution = repos.execution.bind(claim);
  await repos.agents.save({ id: client, name: client, command: client, args: [], protocol: 'pty-cli', env: {}, permissionMode: 'ask', timeout: 600 });
  const makeResolver = () => new SessionInsightResolver({ repositories: repos, configuredRoots: [{ client, path: nativeRoot }], instanceId: 'integration', createTranscriptSourceKeys });
  let resolver = makeResolver();
  const diagnostics: unknown[] = [];
  const makeService = () => {
    const service = new SessionInsightService({
      insightRepository: repos.insight, resolver, dataDir: join(root, 'analysis'), processRunId: 'integration', ...(resolveEngine ? { resolveEngine } : {}),
      hostEvidence: {
        readHostEvidenceRaw: id => repos.insight.readHostEvidenceRaw(id),
        getSessionExecutions: id => repos.execution.getSessionExecutions(id),
        getAcceptedTask: id => repos.execution.getAcceptedTask(id),
        readTransaction: work => repos.insight.readTransaction(work)
      },
      log: event => diagnostics.push(event)
    });
    services.push(service);
    return service;
  };
  let service = makeService();
  await service.initialize();
  return {
    get repos() { return repos; }, get service() { return service; }, get resolver() { return resolver; }, logDir,
    async reopen() {
      await service.close();
      claim.release();
      repos.close();
      repos = createRepositories(databasePath);
      claim = repos.control.attachRuntime('insight-integration-reopened');
      execution = repos.execution.bind(claim);
      resolver = makeResolver();
      service = makeService();
      await service.initialize();
      return service;
    },
    async add(sessionId: string, nativeId: string, body: string) {
      const path = join(logDir, `rollout-${sessionId}.jsonl`);
      await writeFile(path, body);
      const runId = `run-${sessionId}`, driverInstanceId = `driver-${sessionId}`;
      execution.createSession({ id: sessionId, runId, agentId: client, cwd, state: 'idle', createdAt: at, updatedAt: at });
      const operation = execution.beforeControlledOperation({ sessionId, runId }, { resourceId: `factory-${sessionId}`, driverInstanceId });
      execution.creationFinished({ sessionId, runId }, operation.resourceId, operation.revision, 'created');
      repos.insight.bindSources(claim).appendObserved({
        observationId: `obs-${sessionId}`, sessionId, activeRunId: runId, driverInstanceId,
        client, launchKind: 'created', proofKind: 'launch_observed', capturedAt: at,
        dataRoot: nativeRoot, cwd, nativeSessionId: nativeId, verifiedPath: path,
        identityProof: 'launch:path', ...createTranscriptSourceKeys('integration', client, nativeRoot, nativeId, stream)!, streamIdentity: stream
      });
    },
    async refresh(sessionId: string, target: SessionInsightService = service) {
      await target.refresh(sessionId);
      const deadline = Date.now() + 20_000;
      while (['queued', 'running'].includes(repos.insight.getState(sessionId).state)) {
        if (Date.now() > deadline) throw new Error(`refresh timed out: ${JSON.stringify(diagnostics)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(repos.insight.getState(sessionId).state, JSON.stringify({ diagnostics, state: repos.insight.getState(sessionId) })).toBe('succeeded');
      return target.details(sessionId);
    }
  };
}
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

describe('session insight real service pipeline regressions', () => {
  it('preserves priced SQLite evidence through current details, default analysis, publication and export', async () => {
    const h = await harness('codex', '/workspace/test-sandbox');
    const fixture = await readFile(resolve('tests/fixtures/session-insight/real-native/codex.jsonl'), 'utf8');
    await h.add('priced', '01a0ffa7-270b-72f1-be55-21dde8e42935', fixture);
    await h.repos.usage.append({ id: 'priced', recordedAt: at, sessionId: 'priced', taskId: 'task', attemptId: 'attempt', category: 'explicit', origin: 'web', agentId: 'codex', costUsd: 1.25, costEstimated: false, dataStatus: 'reported' });
    expect(h.repos.insight.readHostEvidenceRaw('priced').usageEntries[0]).toMatchObject({ recorded_at: at, cost_usd: 1.25, data_status: 'reported' });
    const expected = { recordedAtRange: { start: at, end: at }, totalCostEstimate: 1.25, currency: 'USD', hasUnpricedUsage: false };
    expect((await h.service.details('priced')).hostEvidence?.usageLedgerProjection).toEqual(expected);
    const details = await h.refresh('priced');
    expect(details.hostEvidence?.usageLedgerProjection).toEqual(expected);
    const snapshotId = details.summary!.snapshotId;
    expect(h.repos.insight.getSnapshot('priced', snapshotId)!.hostEvidence.usageLedgerProjection).toEqual(expected);
    // The unmodified real single-input fixture also passes the default subprocess boundary.
    expect(details.summary!.sources.find(source => source.scopeRole === 'primary')!.metrics.userTurns.value).toBe(1);
    for (const format of ['markdown', 'html'] as const) {
      const report = await h.service.exportReport({ kind: 'session', sessionId: 'priced', snapshotId, format });
      expect(report.body).toContain('1.25 USD');
      expect(report.body).toContain(at);
    }
    expect(await h.repos.usage.totals({ sessionId: 'priced' })).toMatchObject({ entries: 1, costUsd: 1.25, pricedEntries: 1, unpriced: 0 });
    for (const dataStatus of ['unavailable', 'unpriced'] as const) {
      await h.add(dataStatus, dataStatus, jsonl([{ timestamp: at, type: 'session_meta', payload: { id: dataStatus } }]));
      await h.repos.usage.append({ id: dataStatus, recordedAt: at, sessionId: dataStatus, taskId: dataStatus, attemptId: dataStatus, category: 'explicit', origin: 'web', agentId: 'codex', costEstimated: false, dataStatus });
      const projection = (await h.service.details(dataStatus)).hostEvidence!.usageLedgerProjection;
      expect(projection.recordedAtRange).toEqual({ start: at, end: at });
      expect(projection.hasUnpricedUsage).toBe(dataStatus === 'unpriced');
      expect(projection.totalCostEstimate ?? null).toBeNull();
    }
  }, 30_000);

  it.each([
    ['codex', { subagent: { thread_fork: { parent_thread_id: 'parent' } } }],
    ['traex', { subagent: { thread_fork: { parent_thread_id: 'parent' } } }],
    ['codex', { kind: 'fork', parent_session_id: 'parent' }]
  ] as const)('excludes supported %s fork history from cohort totals without discarding source observations: %j', async (client, source) => {
    const h = await harness(client, undefined, sharedResolveEngine);
    // Supported synthetic dialects: these assert user/tool counts, not token accounting.
    const inherited = [
      { timestamp: at, type: 'response_item', payload: { type: 'message', id: 'inherited', role: 'user', content: 'parent input' } },
      { timestamp: at, type: 'response_item', payload: { type: 'function_call', call_id: 'tool', name: 'read', arguments: '{}' } },
      { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool', output: '{"success":true}' } }
    ];
    const meta = (id: string, source: unknown) => ({ timestamp: at, type: 'session_meta', payload: { id, source } });
    await h.add('parent-session', 'parent', jsonl([meta('parent', 'cli'), ...inherited]));
    await h.add('fork-session', 'fork', jsonl([meta('fork', source), ...inherited, { timestamp: at, type: 'response_item', payload: { type: 'message', id: 'new', role: 'user', content: 'fork input' } }]));
    const resolved = await h.resolver.resolveSessionInsightSources('fork-session');
    expect(resolved.sources.find(s => s.sourceKey === resolved.primarySourceKey)!.relationship.kind).toBe('fork');
    const evidenceRefs = ['kind' in source ? 'session_meta:source' : 'session_meta:source.subagent.thread_fork'];
    expect(resolved.sources.find(s => s.sourceKey === resolved.primarySourceKey)!.relationship.evidenceRefs).toEqual(evidenceRefs);
    const parent = await h.refresh('parent-session');
    const fork = await h.refresh('fork-session');
    const primary = fork.summary!.sources.find(s => s.scopeRole === 'primary')!;
    expect(fork.manifest!.sources.find(s => s.sourceKey === primary.sourceKey)!.relationship.kind).toBe('fork');
    expect(fork.manifest!.sources.find(s => s.sourceKey === primary.sourceKey)!.relationship.evidenceRefs).toEqual(evidenceRefs);
    expect(primary.relationship).toMatchObject({ kind: 'fork', parentNativeSessionId: 'parent' });
    expect(primary.relationship.evidenceRefs).toEqual(evidenceRefs);
    expect(primary.coverage.inheritedHistory).toBe('detected');
    expect(primary.metrics.userTurns.value).toBe(2);
    expect(primary.metrics.toolCalls.value).toBe(1);
    expect(parent.summary!.sources.find(s => s.sourceKey === primary.sourceKey)!.scopeRole).toBe('excluded');
    const cohort = await h.service.summary({ groupBy: 'workspace', includeArchived: false, limit: 100 });
    expect(cohort.groups[0]).toMatchObject({ includedCount: 1, excludedCount: 1, aggregateMetrics: { userTurns: { value: 1 }, toolCalls: { value: 1 } } });
    expect(cohort.sessions.find(s => s.sessionId === 'fork-session')!.metricAttributions.userTurns!.included).toBe(false);
  }, 30_000);

  it('protects excerpt boundaries in the real child and hides legacy excerpts on every read/export path', async () => {
    const fakeSecret = 'integrationOnlyCredentialA9b8c7d6e5f4G3H2I1J0KLmnop';
    const prefix = fakeSecret.slice(0, 24);
    const previous = process.env.DUTYDECK_TEST_INSIGHT_SECRET;
    process.env.DUTYDECK_TEST_INSIGHT_SECRET = fakeSecret;
    envRestores.push(() => { if (previous === undefined) delete process.env.DUTYDECK_TEST_INSIGHT_SECRET; else process.env.DUTYDECK_TEST_INSIGHT_SECRET = previous; });
    rememberSecretValues({ DUTYDECK_TEST_INSIGHT_SECRET: fakeSecret });

    const engineRoot = await mkdtemp(join(tmpdir(), 'insight-i4-engine-'));
    roots.push(engineRoot);
    await writeFile(join(engineRoot, 'package.json'), '{"type":"module"}\n');
    const entry = join(engineRoot, 'entry.ts');
    const cliEntry = resolve('apps/server/src/session-insight-cli.ts');
    await writeFile(entry, `if (process.env.DUTYDECK_TEST_INSIGHT_SECRET) process.exit(97);\nawait import(${JSON.stringify(cliEntry)});\n`);
    const bundled = await bundleForTest('insight-i4', entry);
    bundleCleanups.push(bundled.cleanup);
    const versions = await executeEngineHandshake(bundled.path, [], 10_000);
    const engine = { status: 'available' as const, entrypoint: bundled.path, execArgv: [], versions };
    const h = await harness('claude', '/workspace/test-sandbox', async () => engine);
    const rows = (await readFile(resolve('tests/fixtures/session-insight/real-native/claude-main.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const long = 'x'.repeat(SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes - 25) + ' ' + fakeSecret;
    const inputShape = { description: '', prompt: 'Read files' };
    const inputOverhead = Buffer.byteLength(JSON.stringify(inputShape));
    rows[3].message.content[0].input = {
      description: 'x'.repeat(SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes - 25 - inputOverhead) + ' ' + fakeSecret,
      prompt: 'Read files'
    };
    rows[4].message.content[0].content = long;
    rows[4].message.content[0].is_error = true;
    rows[4].toolUseResult.status = 'failed';
    rows[5].message.content[0].text = 'Whole value: ' + fakeSecret;
    const sessionId = 'redaction-boundary';
    await h.add(sessionId, '0192e000-7a3b-7000-8000-000000000001', jsonl(rows));

    const first = await h.refresh(sessionId);
    const snapshotId = first.summary!.snapshotId;
    expect(first.manifest!.versions).toMatchObject({ parserVersion: 'ts-v3', redactionVersion: 'redaction-v2' });
    const rawPage = h.repos.insight.listEvents({ snapshotId, limit: 200 });
    expect(JSON.stringify(rawPage)).not.toContain(prefix);
    const page = await h.service.events(sessionId, { snapshotId, limit: 200 });
    expect(JSON.stringify(page)).not.toContain(prefix);
    expect(JSON.stringify(page)).not.toContain(fakeSecret);
    const failure = page.items.find(event => event.kind === 'tool_result' && event.resultStatus === 'failure')!;
    const summary = page.items.find(event => event.kind === 'tool_summary' && event.resultStatus === 'failure')!;
    const call = page.items.find(event => event.kind === 'tool_call')!;
    for (const event of [call, summary]) {
      expect(event.inputExcerpt).toBeTruthy();
      expect(event.inputExcerpt).not.toContain(prefix);
    }
    for (const event of [failure, summary]) {
      expect(event.outputExcerpt).toBeTruthy();
      expect(event.outputExcerpt).not.toContain(prefix);
    }
    expect(failure.errorExcerpt).toBeTruthy();
    expect(failure.errorExcerpt).not.toContain(prefix);
    expect(page.items.find(event => event.kind === 'agent_message' && event.outputExcerpt?.startsWith('Whole value:'))?.outputExcerpt).toBe('Whole value: [REDACTED]');
    for (const format of ['markdown', 'html'] as const) {
      expect((await h.service.exportReport({ kind: 'session', sessionId, snapshotId, format })).body).not.toContain(prefix);
      expect((await h.service.exportReport({ kind: 'comparison', left: { sessionId, snapshotId }, right: { sessionId, snapshotId }, format })).body).not.toContain(prefix);
    }
    expect((await h.refresh(sessionId)).summary!.snapshotId).toBe(snapshotId);

    const stored = h.repos.insight.getSnapshot(sessionId, snapshotId)!;
    const legacyId = 'insight_legacy_redaction';
    const legacyVersions = { ...stored.versions, parserVersion: 'ts-v2', metricVersion: 'v2', redactionVersion: 'redaction-v1' };
    const requestId = randomUUID();
    h.repos.insight.beginRefresh(sessionId, requestId, 'integration');
    h.repos.insight.markRunning(sessionId, requestId, 'integration');
    h.repos.insight.publish({
      sessionId, requestId, expectedBindingRevision: h.repos.insight.getState(sessionId).bindingRevision,
      snapshot: {
        ...stored, snapshotId: legacyId, cacheKey: createHash('sha256').update(`legacy:${stored.cacheKey}`).digest('hex'), versions: legacyVersions,
        summary: { ...stored.summary, snapshotId: legacyId }, manifest: { ...stored.manifest, snapshotId: legacyId, versions: legacyVersions }
      },
      events: rawPage.items.map(event => event.eventId === failure.eventId
        ? { ...event, snapshotId: legacyId, inputExcerpt: prefix, outputExcerpt: prefix, errorExcerpt: prefix }
        : { ...event, snapshotId: legacyId })
    });
    const reopened = await h.reopen();
    expect((await reopened.details(sessionId, legacyId)).summary!.snapshotId).toBe(legacyId);
    const legacyItems = [];
    let cursor: string | undefined;
    do {
      const legacyPage = await reopened.events(sessionId, { snapshotId: legacyId, limit: 1, ...(cursor ? { cursor } : {}) });
      expect(JSON.stringify(legacyPage)).not.toContain(prefix);
      legacyItems.push(...legacyPage.items);
      cursor = legacyPage.nextCursor ?? undefined;
    } while (cursor);
    expect(legacyItems).toHaveLength(rawPage.items.length);
    const legacyFailure = legacyItems.find(event => event.eventId === failure.eventId)!;
    expect(legacyFailure).toMatchObject({ ordinal: failure.ordinal, inputExcerpt: null, outputExcerpt: null, errorExcerpt: null });
    expect(legacyFailure.tokens).toEqual(failure.tokens);
    for (const format of ['markdown', 'html'] as const) {
      expect((await reopened.exportReport({ kind: 'session', sessionId, snapshotId: legacyId, format })).body).not.toContain(prefix);
      expect((await reopened.exportReport({ kind: 'comparison', left: { sessionId, snapshotId: legacyId }, right: { sessionId, snapshotId: legacyId }, format })).body).not.toContain(prefix);
    }
    const refreshed = await h.refresh(sessionId, reopened);
    expect(refreshed.summary!.snapshotId).not.toBe(legacyId);
    expect(refreshed.manifest!.versions.redactionVersion).toBe('redaction-v2');
  }, 40_000);

  it('marks final availability partial when the bounded Claude proof scan does not cover the main file', async () => {
    const original = await readFile(resolve('tests/fixtures/session-insight/real-native/claude-main.jsonl'), 'utf8');
    const rows = original.trim().split('\n');
    const padding = JSON.stringify({ type: 'system', isSidechain: false, cwd: '/workspace/test-sandbox', sessionId: '0192e000-7a3b-7000-8000-000000000001', timestamp: at, content: 'x'.repeat(64 * 1024) });
    for (const padded of [false, true]) {
      const h = await harness('claude', '/workspace/test-sandbox', sharedResolveEngine);
      await writeFile(join(h.logDir, 'agent-child.jsonl'), await readFile(resolve('tests/fixtures/session-insight/real-native/claude-subagent.jsonl')));
      const body = padded ? [rows[0], ...Array(70).fill(padding), ...rows.slice(1)].join('\n') + '\n' : original;
      const sessionId = `discovery-window-${padded}`;
      await h.add(sessionId, '0192e000-7a3b-7000-8000-000000000001', body);
      const resolved = await h.resolver.resolveSessionInsightSources(sessionId);
      const details = await h.refresh(sessionId);
      expect(resolved.discoveryLimited).toBe(padded);
      expect(resolved.sources.filter(source => source.expectedStream.kind === 'subagent')).toHaveLength(padded ? 0 : 1);
      expect(details.summary!.sources).toHaveLength(padded ? 1 : 2);
      expect(details.status.availability).toBe(padded ? 'partial' : 'complete');
      const primary = details.summary!.sources.find(source => source.scopeRole === 'primary')!;
      expect(primary.aggregation.reasonCodes.includes('DISCOVERY_LIMITED')).toBe(padded);
    }
  }, 40_000);
});
