import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { createTranscriptSourceKeys } from '@dutydeck/runtime';
import type { InsightClient, RepositoryBundle } from '@dutydeck/shared';
import { SessionInsightResolver } from './session-insight-resolver.js';
import { SessionInsightService } from './session-insight-service.js';

const at = '2026-10-03T03:00:00.000Z';
const stream = { kind: 'main' as const, nativeAgentId: null };
const roots: string[] = [];
const services: SessionInsightService[] = [];
const repositories: RepositoryBundle[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const release of releases.splice(0)) release();
  for (const repos of repositories.splice(0)) repos.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// Real resolver, immutable file capture, default analyzer subprocess and SQLite publication.
async function harness(client: InsightClient = 'codex', sessionCwd?: string) {
  const root = await mkdtemp(join(tmpdir(), 'insight-integration-'));
  roots.push(root);
  const nativeRoot = join(root, 'native');
  const cwd = sessionCwd ?? join(root, 'workspace');
  const logDir = join(nativeRoot, ...(client === 'traex' ? ['cli'] : []), 'sessions', '2026', '10', '03');
  await mkdir(logDir, { recursive: true });
  if (!sessionCwd) await mkdir(cwd, { recursive: true });
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  repositories.push(repos);
  const claim = repos.control.attachRuntime('insight-integration');
  releases.push(() => claim.release());
  const execution = repos.execution.bind(claim);
  await repos.agents.save({ id: client, name: client, command: client, args: [], protocol: 'pty-cli', env: {}, permissionMode: 'ask', timeout: 600 });
  const resolver = new SessionInsightResolver({ repositories: repos, configuredRoots: [{ client, path: nativeRoot }], instanceId: 'integration', createTranscriptSourceKeys });
  const diagnostics: unknown[] = [];
  const service = new SessionInsightService({
    insightRepository: repos.insight, resolver, dataDir: join(root, 'analysis'), processRunId: 'integration',
    hostEvidence: {
      readHostEvidenceRaw: id => repos.insight.readHostEvidenceRaw(id),
      getSessionExecutions: id => repos.execution.getSessionExecutions(id),
      getAcceptedTask: id => repos.execution.getAcceptedTask(id),
      readTransaction: work => repos.insight.readTransaction(work)
    },
    log: event => diagnostics.push(event)
  });
  services.push(service);
  await service.initialize();
  return {
    repos, service, resolver,
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
    async refresh(sessionId: string) {
      await service.refresh(sessionId);
      const deadline = Date.now() + 20_000;
      while (['queued', 'running'].includes(repos.insight.getState(sessionId).state)) {
        if (Date.now() > deadline) throw new Error(`refresh timed out: ${JSON.stringify(diagnostics)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(repos.insight.getState(sessionId).state, JSON.stringify({ diagnostics, state: repos.insight.getState(sessionId) })).toBe('succeeded');
      return service.details(sessionId);
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
    const h = await harness(client);
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
});
