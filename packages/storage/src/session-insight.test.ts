import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  canonicalExecutionJson,
  createContinuousMetric,
  createCountMetric,
  SESSION_INSIGHT_LIMITS,
  type FileMetrics,
  type HostEvidenceSnapshot,
  type RepositoryBundle,
  type RuntimeControlClaim,
  type SessionInsightEventItem,
  type SessionInsightSnapshotRecord,
  type TranscriptSourceObservation
} from '@dutydeck/shared';
import { createRepositories } from './index.js';

const opened: Array<{ repos: RepositoryBundle; claim?: RuntimeControlClaim }> = [];
afterEach(() => {
  for (const { repos, claim } of opened.splice(0)) {
    try { claim?.release(); } catch { /* claim may already be released in revocation tests */ }
    repos.close();
  }
});

const fence = { sessionId: 'session', runId: 'run' };
const hash = (v: unknown): string => createHash('sha256').update(canonicalExecutionJson(v)).digest('hex');
const sha = (v: string): string => createHash('sha256').update(v).digest('hex');

function metrics(overrides: Partial<FileMetrics> = {}): FileMetrics {
  const count = (value = 0) => createCountMetric({ value, quality: 'exact', status: 'available' });
  const cont = (value: number | null = 0) =>
    createContinuousMetric({ value, quality: 'exact', status: 'available' });
  return {
    inputUncached: count(),
    cacheRead: count(),
    cacheWrite: count(),
    output: count(),
    reasoningOutput: count(),
    totalTracked: count(),
    rawInput: count(),
    rawOutput: count(),
    rawTotal: count(),
    peakContext: count(),
    contextWindow: count(null),
    elapsedDurationMs: cont(),
    activeDurationMs: cont(),
    idleDurationMs: cont(),
    pairedToolDurationMs: cont(),
    userTurns: count(),
    assistantTurns: count(),
    toolCalls: count(),
    toolFailures: count(),
    toolSuccesses: count(),
    toolUnknowns: count(),
    toolFailureRate: cont(null),
    compactionCount: count(),
    subagentCount: count(),
    ...overrides
  };
}

function hostEvidence(capturedAt = '2026-10-03T00:00:00.000Z'): HostEvidenceSnapshot {
  return {
    capturedAt,
    taskGoals: [],
    omittedGoalsCount: 0,
    steeringRelations: [],
    omittedSteeringCount: 0,
    verificationSnapshot: [],
    omittedVerificationsCount: 0,
    modelConfigs: [],
    omittedModelConfigsCount: 0,
    digest: sha(`evidence-${capturedAt}`)
  };
}

interface SetupOptions {
  sessionId?: string;
  runId?: string;
}

function setup(options: SetupOptions = {}): {
  repos: RepositoryBundle;
  claim: RuntimeControlClaim;
  sessionId: string;
  runId: string;
} {
  const sessionId = options.sessionId ?? fence.sessionId;
  const runId = options.runId ?? fence.runId;
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const claim = repos.control.attachRuntime('controller');
  opened.push({ repos, claim });
  const x = repos.execution.bind(claim);
  const at = '2026-10-03T00:00:00.000Z';
  x.createSession({ id: sessionId, runId, agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
  return { repos, claim, sessionId, runId };
}

/** 建立一个 created 的 lifecycle driver 资源（代表真实 PTY/驱动）。 */
function createLifecycleDriver(
  repos: RepositoryBundle,
  claim: RuntimeControlClaim,
  sessionId: string,
  runId: string,
  driverInstanceId: string
): void {
  const x = repos.execution.bind(claim);
  const f = { sessionId, runId };
  x.beforeControlledOperation(f, { resourceId: `lifecycle-${driverInstanceId}`, driverInstanceId });
  x.creationFinished(f, `lifecycle-${driverInstanceId}`, 1, 'created');
}

/**
 * Reproduce the exact LocalDriverLedger.begin/ready shape for the default PTY driver:
 * an un-scoped operation parent plus a local_only child carrying the identity.
 * context.driverInstanceId for a local-only driver is the CHILD resourceId.
 */
function createLocalOnlyDriver(
  repos: RepositoryBundle,
  claim: RuntimeControlClaim,
  sessionId: string,
  runId: string,
  resourceId: string,
  identityId = `identity-${resourceId}`
): { operationId: string; resourceId: string; identityId: string } {
  const x = repos.execution.bind(claim);
  const f = { sessionId, runId };
  const operationId = `operation-parent-${resourceId}`;
  x.beforeCreate(f, { resourceId: operationId, kind: 'operation' });
  x.beforeCreate(f, { resourceId, parentResourceId: operationId, kind: 'local_only' });
  // identify(): identity lands on the child.
  x.spawned(f, resourceId, 1, { identityId, kind: 'local_only', locator: { owner: 'runtime-adapter' } });
  // ready(): finish child then parent, and append a live observation.
  const child = x.creationFinished(f, resourceId, 2, 'created');
  x.creationFinished(f, operationId, 1, 'created');
  x.observed(f, resourceId, child.revision, {
    observationId: `obs-live-${resourceId}`,
    identityId,
    state: 'live',
    evidenceRef: 'original-driver-start-finished',
    observedAt: '2026-10-03T00:00:00.000Z'
  });
  return { operationId, resourceId, identityId };
}

function observation(
  sessionId: string,
  activeRunId: string,
  driverInstanceId: string,
  overrides: Partial<TranscriptSourceObservation> = {}
): TranscriptSourceObservation {
  return {
    observationId: `obs-${hash([sessionId, activeRunId, driverInstanceId, overrides.sourceKey ?? 'main', overrides.verifiedPath ?? '/data/home/x.jsonl'])}`,
    sessionId,
    activeRunId,
    driverInstanceId,
    client: 'codex',
    launchKind: 'created',
    proofKind: 'launch_observed',
    capturedAt: '2026-10-03T00:00:00.000Z',
    dataRoot: '/data/home/.codex',
    cwd: '/tmp',
    nativeSessionId: 'native-session',
    verifiedPath: '/data/home/.codex/sessions/x.jsonl',
    identityProof: 'pty-spawn-env',
    sourceSessionKey: 'ssk',
    streamIdentity: { kind: 'main', nativeAgentId: null },
    sourceKey: 'source-key',
    ...overrides
  };
}

let snapshotCounter = 0;
function snapshotRecord(
  sessionId: string,
  cacheKey: string,
  overrides: Partial<SessionInsightSnapshotRecord> = {}
): SessionInsightSnapshotRecord {
  snapshotCounter += 1;
  const snapshotId = overrides.snapshotId ?? `snapshot-${snapshotCounter}`;
  const createdAt = overrides.createdAt ?? '2026-10-03T00:05:00.000Z';
  return {
    snapshotId,
    sessionId,
    cacheKey,
    versions: {
      schemaVersion: 1,
      engineVersion: 'engine-1',
      parserVersion: 'parser-1',
      metricVersion: 'metric-1',
      redactionVersion: 'redaction-1'
    },
    summary: {
      schemaVersion: 1,
      sessionId,
      snapshotId,
      createdAt,
      primarySourceKey: 'source-key',
      models: ['gpt-test'],
      isMultiModel: false,
      aggregateMetrics: metrics(),
      qualityOverview: 'recorded',
      sources: [
        {
          sourceKey: 'source-key',
          client: 'codex',
          streamIdentity: { kind: 'main', nativeAgentId: null },
          sha256: sha('file'),
          status: 'ok',
          scopeRole: 'primary',
          metrics: metrics(),
          models: ['gpt-test'],
          coverage: {
            rawLines: 10,
            parsedLines: 10,
            ignoredLines: 0,
            errorLines: 0,
            timeRange: { start: '2026-10-03T00:00:00.000Z', end: '2026-10-03T00:01:00.000Z' },
            missingTimestampCount: 0,
            disorderedTimestampCount: 0,
            retainedTraceCount: 1,
            omittedTraceCount: 0,
            omittedTraceByCategory: {},
            tokenSamplesAvailable: 1,
            tokenSamplesMissing: 0,
            subagentDiscovery: 'none',
            inheritedHistory: 'none'
          },
          relationship: { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] },
          aggregation: { eligibility: 'eligible', reasonCodes: [] },
          keyEvidenceEventIds: { failures: [], slowCalls: [], highTokenDeltas: [] }
        }
      ],
      keyEvidenceEventIds: { failures: [], slowCalls: [], highTokenDeltas: [] },
      pulseBuckets: []
    },
    manifest: {
      snapshotId,
      sessionId,
      createdAt,
      bindingRevision: 0,
      hostEvidenceDigest: sha('evidence-2026-10-03T00:00:00.000Z'),
      sources: [
        {
          sourceKey: 'source-key',
          client: 'codex',
          matchStatus: 'matched',
          expectedStream: { kind: 'main', nativeAgentId: null },
          sha256: sha('file'),
          capturedAt: '2026-10-03T00:00:00.000Z',
          readBytes: 100,
          analyzedBytes: 100,
          trailingBytes: 0,
          fingerprint: 'dev:1:inode:1',
          relationship: { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] },
          aggregation: { eligibility: 'eligible', reasonCodes: [] },
          status: 'ok'
        }
      ],
      versions: {
        schemaVersion: 1,
        engineVersion: 'engine-1',
        parserVersion: 'parser-1',
        metricVersion: 'metric-1',
        redactionVersion: 'redaction-1'
      }
    },
    hostEvidence: hostEvidence(),
    payloadBytes: 0,
    createdAt,
    ...overrides
  };
}

function traceEvent(ordinal: number, overrides: Partial<SessionInsightEventItem> = {}): SessionInsightEventItem {
  return {
    eventId: `event-${ordinal}`,
    sourceKey: 'source-key',
    nativeSessionId: 'native-session',
    lineNumber: ordinal + 1,
    byteOffset: ordinal * 10,
    subeventIndex: 0,
    timestamp: '2026-10-03T00:00:00.000Z',
    timeQuality: 'exact',
    kind: 'tool_call',
    toolName: ordinal % 2 === 0 ? 'shell' : 'read',
    resultStatus: ordinal % 3 === 0 ? 'failure' : 'success',
    evidenceRefs: [],
    isSnapshotLocalId: false,
    snapshotId: '',
    ordinal,
    ...overrides
  };
}

describe('session insight live source binding', () => {
  it('appends a launch_observed source inside the runtime claim and bumps binding revision once', () => {
    const { repos, claim, sessionId, runId } = setup();
    createLifecycleDriver(repos, claim, sessionId, runId, 'driver-1');
    const writer = repos.insight.bindSources(claim);
    const obs = observation(sessionId, runId, 'driver-1');
    writer.appendObserved(obs);
    expect(repos.insight.listSources(sessionId)).toHaveLength(1);
    expect(repos.insight.getState(sessionId).bindingRevision).toBe(1);

    // Re-append identical payload: idempotent, no revision bump.
    writer.appendObserved(obs);
    expect(repos.insight.listSources(sessionId)).toHaveLength(1);
    expect(repos.insight.getState(sessionId).bindingRevision).toBe(1);
  });

  it('rejects the same observation id with a different immutable payload', () => {
    const { repos, claim, sessionId, runId } = setup();
    createLifecycleDriver(repos, claim, sessionId, runId, 'driver-1');
    const writer = repos.insight.bindSources(claim);
    const obs = observation(sessionId, runId, 'driver-1');
    writer.appendObserved(obs);
    const conflicting = { ...obs, verifiedPath: '/data/home/.codex/sessions/changed.jsonl' };
    expect(() => writer.appendObserved(conflicting)).toThrow(/IMMUTABLE|CONFLICT/i);
  });

  it('rejects a revoked (released) claim so a stale callback cannot write', () => {
    const { repos, claim, sessionId, runId } = setup();
    createLifecycleDriver(repos, claim, sessionId, runId, 'driver-1');
    const writer = repos.insight.bindSources(claim);
    claim.release();
    expect(() => writer.appendObserved(observation(sessionId, runId, 'driver-1'))).toThrow(
      'DATABASE_RUNTIME_CLAIM_REVOKED'
    );
    // Remove the auto afterEach release for this already-released claim.
    const entry = opened.find(item => item.claim === claim);
    if (entry) delete entry.claim;
  });

  it('rejects an observation from a previous run after the session moved on', () => {
    const { repos, claim, sessionId } = setup();
    const x = repos.execution.bind(claim);
    createLifecycleDriver(repos, claim, sessionId, 'run', 'driver-1');
    // Session advances to a new run; native selection follows it.
    x.replaceSessionRun({ sessionId, runId: 'run' }, 'run-2', []);
    const writer = repos.insight.bindSources(claim);
    expect(() => writer.appendObserved(observation(sessionId, 'run', 'driver-1'))).toThrow(
      expect.objectContaining({ code: 'INSIGHT_STALE_RUN' })
    );
  });

  it('rejects a driver instance with no resource owned by the session', () => {
    const { repos, claim, sessionId, runId } = setup();
    createLifecycleDriver(repos, claim, sessionId, runId, 'driver-1');
    const writer = repos.insight.bindSources(claim);
    expect(() => writer.appendObserved(observation(sessionId, runId, 'unknown-driver'))).toThrow(
      expect.objectContaining({ code: 'RESOURCE_IDENTITY_CONFLICT' })
    );
  });

  it('rejects a resource owned by a different session', () => {
    const first = setup({ sessionId: 'session-a' });
    createLifecycleDriver(first.repos, first.claim, 'session-a', 'run', 'driver-a');
    // A second session exists but driver-a's lifecycle resource belongs to session-a only.
    const x = first.repos.execution.bind(first.claim);
    const at = '2026-10-03T00:01:00.000Z';
    x.createSession({ id: 'session-b', runId: 'run', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
    const writer = first.repos.insight.bindSources(first.claim);
    expect(() => writer.appendObserved(observation('session-b', 'run', 'driver-a'))).toThrow(
      expect.objectContaining({ code: 'RESOURCE_IDENTITY_CONFLICT' })
    );
  });

  it('validates the ACP live native reference against the current selection while allowing an old originRunId', () => {
    const { repos, claim, sessionId, runId } = setup();
    const x = repos.execution.bind(claim);
    const f = { sessionId, runId };
    const root = x.beforeControlledOperation(f, { resourceId: 'factory', driverInstanceId: 'driver-1' });
    const expected = {
      nativeCreationId: 'native-create',
      sessionKey: 'key',
      agent: 'fixture',
      command: ['node', 'fixture.mjs'],
      cwd: '/tmp',
      executionDomain: 'local' as const
    };
    const row = x.reserveNativeContext(f, { resourceId: 'native', parentResourceId: root.resourceId, expected });
    const selected = x.confirmNativeContext(f, row.resourceId, row.revision, {
      ...expected,
      acpxRecordId: 'key',
      backendSessionId: 'original',
      defaults: { model: 'A' }
    });
    x.creationFinished(f, root.resourceId, root.revision, 'created');

    const writer = repos.insight.bindSources(claim);
    // Matching current selection (originRunId === run here) is accepted.
    expect(() =>
      writer.appendObserved(observation(sessionId, runId, 'driver-1', { nativeContextRef: selected.context }))
    ).not.toThrow();

    // A forged identityId is rejected even though resourceId matches.
    expect(() =>
      writer.appendObserved(
        observation(sessionId, runId, 'driver-1', {
          observationId: 'obs-forged',
          nativeContextRef: { ...selected.context, identityId: 'forged-identity' }
        })
      )
    ).toThrow(expect.objectContaining({ code: 'NATIVE_CONTEXT_SELECTION_CONFLICT' }));

    // After the run advances, the same resource still has originRunId='run' (older than active run):
    // originRunId may be old as long as it equals the selection context.
    x.replaceSessionRun(f, 'run-2', []);
    const view = repos.execution.getNativeContext(sessionId)!;
    expect(view.selection.context.originRunId).toBe('run');
    expect(() =>
      writer.appendObserved(
        observation(sessionId, 'run-2', 'driver-1', {
          observationId: 'obs-next-run',
          nativeContextRef: view.selection.context
        })
      )
    ).not.toThrow();
  });

  it('does not bump binding revision for a repeated observation with identical source identity', () => {
    const { repos, claim, sessionId, runId } = setup();
    createLifecycleDriver(repos, claim, sessionId, runId, 'driver-1');
    const writer = repos.insight.bindSources(claim);
    writer.appendObserved(observation(sessionId, runId, 'driver-1'));
    expect(repos.insight.getState(sessionId).bindingRevision).toBe(1);
    // A second observation of the same sourceKey with same identity but a new id/capturedAt: no new revision.
    writer.appendObserved(
      observation(sessionId, runId, 'driver-1', {
        observationId: 'obs-later',
        capturedAt: '2026-10-03T00:02:00.000Z'
      })
    );
    expect(repos.insight.getState(sessionId).bindingRevision).toBe(1);
    // Material change (different verified path) bumps the revision.
    writer.appendObserved(
      observation(sessionId, runId, 'driver-1', {
        observationId: 'obs-changed',
        capturedAt: '2026-10-03T00:03:00.000Z',
        verifiedPath: '/data/home/.codex/sessions/other.jsonl'
      })
    );
    expect(repos.insight.getState(sessionId).bindingRevision).toBe(2);
  });

  it('accepts a launch observation from a real local_only PTY driver (child resourceId, identity, operation parent)', () => {
    const { repos, claim, sessionId, runId } = setup();
    // Default PTY shape: operation parent + local_only child; context.driverInstanceId === child id.
    const local = createLocalOnlyDriver(repos, claim, sessionId, runId, 'local-resource-1');
    const writer = repos.insight.bindSources(claim);
    expect(() =>
      writer.appendObserved(observation(sessionId, runId, local.resourceId, { observationId: 'local-obs-1' }))
    ).not.toThrow();
    expect(repos.insight.listSources(sessionId).map(s => s.driverInstanceId)).toEqual(['local-resource-1']);
  });

  it('accepts a controlled ACP restore driver on the new run with the old originRunId (real strict-context-restore chain)', () => {
    const { repos, claim, sessionId } = setup();
    const x = repos.execution.bind(claim);
    const f1 = { sessionId, runId: 'run' };

    // --- Initial run: lifecycle driver + confirmed native context (exactly like ControlledDriverResources). ---
    const root = x.beforeControlledOperation(f1, { resourceId: 'factory', driverInstanceId: 'driver-1' });
    const expected = {
      nativeCreationId: 'native-create',
      sessionKey: 'key',
      agent: 'fixture',
      command: ['node', 'fixture.mjs'],
      cwd: '/tmp',
      executionDomain: 'local' as const
    };
    const reserved = x.reserveNativeContext(f1, { resourceId: 'native', parentResourceId: root.resourceId, expected });
    const identity = { ...expected, acpxRecordId: 'key', backendSessionId: 'original', defaults: { model: 'A' } };
    x.confirmNativeContext(f1, reserved.resourceId, reserved.revision, identity);
    x.creationFinished(f1, root.resourceId, root.revision, 'created');

    // --- restart: replaceSessionRun advances selection.runId to run-2, context.originRunId stays 'run'. ---
    x.replaceSessionRun(f1, 'run-2', []);
    const beforeRestore = repos.execution.getNativeContext(sessionId)!;
    expect(beforeRestore.selection.runId).toBe('run-2');
    expect(beforeRestore.selection.context.originRunId).toBe('run');

    const f2 = { sessionId, runId: 'run-2' };
    // New controlled driver builds a strict-context-restore operation bound to the current selection.
    const restoreOp = x.beforeControlledOperation(f2, {
      resourceId: 'restore-op',
      driverInstanceId: 'driver-2',
      scope: {
        kind: 'strict-context-restore' as const,
        context: beforeRestore.selection.context,
        selectionRevision: beforeRestore.selection.revision,
        repairConfiguration: false
      }
    });
    x.confirmNativeContextRestore(f2, {
      operationId: restoreOp.resourceId,
      context: beforeRestore.selection.context,
      expectedRevision: beforeRestore.resource.revision,
      selectionRevision: beforeRestore.selection.revision,
      proofId: 'proof-restore',
      identity
    });
    x.creationFinished(f2, restoreOp.resourceId, restoreOp.revision, 'created');

    // The stored restore row is the new-run anchor with the new driver and bound context.
    const restoreAnchor = repos.execution.getResources(sessionId)
      .find(r => r.kind === 'operation' && r.operationScope?.kind === 'strict-context-restore' && r.stage === 'created')!;
    expect(restoreAnchor).toBeTruthy();
    expect(restoreAnchor.runId).toBe('run-2');
    expect(restoreAnchor.driverInstanceId).toBe('driver-2');

    const writer = repos.insight.bindSources(claim);
    // New restore driver on the new run, ref = current selection (originRunId old): must persist.
    expect(() =>
      writer.appendObserved(
        observation(sessionId, 'run-2', 'driver-2', {
          observationId: 'restore-obs',
          nativeContextRef: beforeRestore.selection.context
        })
      )
    ).not.toThrow();
    expect(repos.insight.listSources(sessionId).some(s => s.observationId === 'restore-obs')).toBe(true);

    // The previous lifecycle driver (driver-1) must NOT be accepted once the restore anchor is newest.
    expect(() =>
      writer.appendObserved(
        observation(sessionId, 'run-2', 'driver-1', {
          observationId: 'old-lifecycle-after-restore',
          nativeContextRef: beforeRestore.selection.context
        })
      )
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_IDENTITY_CONFLICT' }));
  });

  it('rejects a restore driver bound to a stale selection (wrong context) without accepting an arbitrary operation', () => {
    const { repos, claim, sessionId } = setup();
    const x = repos.execution.bind(claim);
    const f1 = { sessionId, runId: 'run' };
    const root = x.beforeControlledOperation(f1, { resourceId: 'factory', driverInstanceId: 'driver-1' });
    const expected = {
      nativeCreationId: 'native-create', sessionKey: 'key', agent: 'fixture',
      command: ['node', 'fixture.mjs'], cwd: '/tmp', executionDomain: 'local' as const
    };
    const reserved = x.reserveNativeContext(f1, { resourceId: 'native', parentResourceId: root.resourceId, expected });
    const identity = { ...expected, acpxRecordId: 'key', backendSessionId: 'original', defaults: {} };
    x.confirmNativeContext(f1, reserved.resourceId, reserved.revision, identity);
    x.creationFinished(f1, root.resourceId, root.revision, 'created');
    x.replaceSessionRun(f1, 'run-2', []);
    const current = repos.execution.getNativeContext(sessionId)!;
    const f2 = { sessionId, runId: 'run-2' };
    const restoreOp = x.beforeControlledOperation(f2, {
      resourceId: 'restore-op', driverInstanceId: 'driver-2',
      scope: {
        kind: 'strict-context-restore' as const,
        context: current.selection.context,
        selectionRevision: current.selection.revision,
        repairConfiguration: false
      }
    });
    x.confirmNativeContextRestore(f2, {
      operationId: restoreOp.resourceId, context: current.selection.context,
      expectedRevision: current.resource.revision, selectionRevision: current.selection.revision,
      proofId: 'proof-restore', identity
    });
    x.creationFinished(f2, restoreOp.resourceId, restoreOp.revision, 'created');

    const writer = repos.insight.bindSources(claim);
    // Driver id/run are right but the observation carries a native ref that is not the current selection.
    expect(() =>
      writer.appendObserved(
        observation(sessionId, 'run-2', 'driver-2', {
          observationId: 'restore-bad-selection',
          nativeContextRef: { resourceId: 'native', identityId: 'forged-identity', originRunId: 'run' }
        })
      )
    ).toThrow(expect.objectContaining({ code: 'NATIVE_CONTEXT_SELECTION_CONFLICT' }));
    expect(repos.insight.listSources(sessionId).some(s => s.observationId === 'restore-bad-selection')).toBe(false);
  });

  it('rejects the previous restore driver after a newer restore driver takes over on a later run', () => {
    const { repos, claim, sessionId } = setup();
    const x = repos.execution.bind(claim);
    const expected = {
      nativeCreationId: 'native-create', sessionKey: 'key', agent: 'fixture',
      command: ['node', 'fixture.mjs'], cwd: '/tmp', executionDomain: 'local' as const
    };
    const identity = { ...expected, acpxRecordId: 'key', backendSessionId: 'original', defaults: {} };
    const restoreToRun = (fromRun: string, toRun: string, driverInstanceId: string, opId: string) => {
      const fFrom = { sessionId, runId: fromRun };
      if (fromRun === 'run') {
        const root = x.beforeControlledOperation(fFrom, { resourceId: 'factory', driverInstanceId: 'driver-init' });
        const reserved = x.reserveNativeContext(fFrom, { resourceId: 'native', parentResourceId: root.resourceId, expected });
        x.confirmNativeContext(fFrom, reserved.resourceId, reserved.revision, identity);
        x.creationFinished(fFrom, root.resourceId, root.revision, 'created');
      }
      x.replaceSessionRun(fFrom, toRun, []);
      const view = repos.execution.getNativeContext(sessionId)!;
      const fTo = { sessionId, runId: toRun };
      const op = x.beforeControlledOperation(fTo, {
        resourceId: opId, driverInstanceId,
        scope: {
          kind: 'strict-context-restore' as const,
          context: view.selection.context,
          selectionRevision: view.selection.revision,
          repairConfiguration: false
        }
      });
      x.confirmNativeContextRestore(fTo, {
        operationId: op.resourceId, context: view.selection.context,
        expectedRevision: view.resource.revision, selectionRevision: view.selection.revision,
        proofId: `proof-${opId}`, identity
      });
      x.creationFinished(fTo, op.resourceId, op.revision, 'created');
      return repos.execution.getNativeContext(sessionId)!.selection.context;
    };

    const context1 = restoreToRun('run', 'run-2', 'restore-driver-a', 'restore-op-a');
    restoreToRun('run-2', 'run-3', 'restore-driver-b', 'restore-op-b');

    const writer = repos.insight.bindSources(claim);
    // Newest restore driver on run-3 is accepted.
    expect(() =>
      writer.appendObserved(observation(sessionId, 'run-3', 'restore-driver-b', { observationId: 'obs-b', nativeContextRef: context1 }))
    ).not.toThrow();
    // The previous run's restore driver is stale and rejected.
    expect(() =>
      writer.appendObserved(observation(sessionId, 'run-3', 'restore-driver-a', { observationId: 'obs-a-stale', nativeContextRef: context1 }))
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_IDENTITY_CONFLICT' }));
  });

  it('rejects a local_only observation whose driverInstanceId is the parent operation instead of the child', () => {
    const { repos, claim, sessionId, runId } = setup();
    const local = createLocalOnlyDriver(repos, claim, sessionId, runId, 'local-resource-2');
    const writer = repos.insight.bindSources(claim);
    // Only the child resourceId is the driver context id; the operation parent id must not be accepted.
    expect(() =>
      writer.appendObserved(observation(sessionId, runId, local.operationId, { observationId: 'local-obs-parent' }))
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_IDENTITY_CONFLICT' }));
  });

  it('rejects an old local_only driver callback after a new local_only driver starts in the same run', () => {
    const { repos, claim, sessionId, runId } = setup();
    const first = createLocalOnlyDriver(repos, claim, sessionId, runId, 'local-old');
    const second = createLocalOnlyDriver(repos, claim, sessionId, runId, 'local-new');
    const writer = repos.insight.bindSources(claim);
    expect(() =>
      writer.appendObserved(observation(sessionId, runId, second.resourceId, { observationId: 'new-ok' }))
    ).not.toThrow();
    expect(() =>
      writer.appendObserved(observation(sessionId, runId, first.resourceId, { observationId: 'old-rejected' }))
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_IDENTITY_CONFLICT' }));
  });

  it('rejects a local_only child without a verified identity', () => {
    // The normal ledger forbids a created physical resource without identity, so simulate the
    // legacy/corrupt shape directly: the anchor query must not treat it as a valid driver.
    const directory = mkdtempSync(join(tmpdir(), 'session-insight-no-identity-'));
    const filename = join(directory, 'state.sqlite');
    const repos = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' });
    const claim = repos.control.attachRuntime('controller');
    const at = '2026-10-03T00:00:00.000Z';
    repos.execution.bind(claim).createSession({ id: 'session', runId: 'run', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
    claim.release();
    repos.close();

    const raw = new Database(filename);
    raw.pragma('foreign_keys = ON');
    const parent = {
      resourceId: 'op-no-identity', sessionId: 'session', runId: 'run', kind: 'operation',
      revision: 1, controller: { accessId: 'a', instanceId: 'i', generation: 1 },
      stage: 'created', observations: [], createdAt: at
    };
    const child = {
      resourceId: 'child-no-identity', parentResourceId: 'op-no-identity', sessionId: 'session', runId: 'run',
      kind: 'local_only', revision: 1,
      controller: { accessId: 'a', instanceId: 'i', generation: 1 },
      stage: 'created', observations: [], createdAt: at
    };
    raw.prepare('INSERT INTO driver_resources(id,session_id,run_id,revision,json) VALUES (?,?,?,1,?)')
      .run('op-no-identity', 'session', 'run', JSON.stringify(parent));
    raw.prepare('INSERT INTO driver_resources(id,session_id,run_id,revision,json) VALUES (?,?,?,1,?)')
      .run('child-no-identity', 'session', 'run', JSON.stringify(child));
    raw.close();

    const reopened = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' });
    const claim2 = reopened.control.attachRuntime('controller2');
    const writer = reopened.insight.bindSources(claim2);
    expect(() =>
      writer.appendObserved(observation('session', 'run', 'child-no-identity', { observationId: 'no-identity-obs' }))
    ).toThrow(expect.objectContaining({ code: 'RESOURCE_IDENTITY_CONFLICT' }));
    claim2.release();
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('session insight historical proof', () => {
  it('rejects an old driver callback after a replacement driver takes over the same run', () => {
    const { repos, claim, sessionId, runId } = setup();
    createLifecycleDriver(repos, claim, sessionId, runId, 'driver-1');
    const writer = repos.insight.bindSources(claim);
    expect(() => writer.appendObserved(observation(sessionId, runId, 'driver-1'))).not.toThrow();

    // Same run, a new lifecycle driver resource replaces driver-1.
    createLifecycleDriver(repos, claim, sessionId, runId, 'driver-2');
    expect(() => writer.appendObserved(observation(sessionId, runId, 'driver-1', { observationId: 'obs-old-driver' }))).toThrow(
      expect.objectContaining({ code: 'RESOURCE_IDENTITY_CONFLICT' })
    );
    expect(() => writer.appendObserved(observation(sessionId, runId, 'driver-2', { observationId: 'obs-new-driver' }))).not.toThrow();
  });

  it('appends historical_verified proof without a claim and never as launch_observed', () => {
    const { repos, sessionId } = setup();
    const proof = observation(sessionId, 'old-run', 'historical-driver', {
      observationId: 'hist-1',
      proofKind: 'historical_verified',
      launchKind: 'attached',
      capturedAt: '2026-09-01T00:00:00.000Z'
    });
    repos.insight.appendHistoricalProof(proof);
    expect(repos.insight.listSources(sessionId).map(s => s.proofKind)).toEqual(['historical_verified']);

    // Must not impersonate a launch through the historical path.
    expect(() =>
      repos.insight.appendHistoricalProof({ ...proof, observationId: 'hist-2', proofKind: 'launch_observed' })
    ).toThrow(expect.objectContaining({ code: 'INSIGHT_INVALID_PROOF' }));
  });
});

function startRefresh(
  repos: RepositoryBundle,
  sessionId: string,
  requestId: string,
  processRunId = 'process-1'
): { bindingRevision: number } {
  const queued = repos.insight.beginRefresh(sessionId, requestId, processRunId);
  expect(queued.state).toBe('queued');
  expect(repos.insight.markRunning(sessionId, requestId, processRunId)).toBe(true);
  return { bindingRevision: queued.bindingRevision };
}

describe('session insight refresh lifecycle and atomic publish', () => {
  it('merges an in-flight refresh instead of creating a second queued request', () => {
    const { repos, sessionId } = setup();
    const first = repos.insight.beginRefresh(sessionId, 'req-1');
    expect(first.merged).toBe(false);
    const second = repos.insight.beginRefresh(sessionId, 'req-2');
    expect(second.merged).toBe(true);
    expect(second.requestId).toBe('req-1');
  });

  it('rejects the 17th queued session refresh with a queue full 429', () => {
    const { repos, claim } = setup({ sessionId: 's0' });
    const x = repos.execution.bind(claim);
    const at = '2026-10-03T00:00:00.000Z';
    for (let i = 1; i <= SESSION_INSIGHT_LIMITS.maxQueuedJobsPerInstance; i += 1) {
      const id = `sq${i}`;
      x.createSession({ id, runId: `r${i}`, agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
      expect(repos.insight.beginRefresh(id, `req-${id}`).merged).toBe(false);
    }
    x.createSession({ id: 's-overflow', runId: 'rx', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
    expect(() => repos.insight.beginRefresh('s-overflow', 'req-overflow')).toThrow(
      expect.objectContaining({ code: 'INSIGHT_QUEUE_FULL', statusCode: 429 })
    );
  });

  it('marks running only from queued and blocks stale request publish', () => {
    const { repos, sessionId } = setup();
    repos.insight.beginRefresh(sessionId, 'req-1');
    expect(repos.insight.markRunning(sessionId, 'req-other')).toBe(false);
    expect(repos.insight.markRunning(sessionId, 'req-1')).toBe(true);
    // A second queued request while req-1 runs is merged and cannot publish.
    repos.insight.beginRefresh(sessionId, 'req-2');
    const snap = snapshotRecord(sessionId, sha('stale-request'));
    expect(() =>
      repos.insight.publish({ sessionId, requestId: 'req-other', expectedBindingRevision: 0, snapshot: snap, events: [] })
    ).toThrow(expect.objectContaining({ code: 'INSIGHT_REQUEST_CONFLICT' }));
  });

  it('publishes snapshot and events atomically and never writes execution or usage ledgers', async () => {
    const { repos, sessionId } = setup();
    startRefresh(repos, sessionId, 'req-1');
    const snap = snapshotRecord(sessionId, sha('content-1'));
    const events = [traceEvent(0), traceEvent(1), traceEvent(2)];
    repos.insight.publish({ sessionId, requestId: 'req-1', expectedBindingRevision: 0, snapshot: snap, events });

    const state = repos.insight.getState(sessionId);
    expect(state.state).toBe('succeeded');
    expect(state.currentSnapshotId).toBe(snap.snapshotId);

    const stored = repos.insight.getSnapshot(sessionId);
    expect(stored?.snapshotId).toBe(snap.snapshotId);
    const page = repos.insight.listEvents({ snapshotId: snap.snapshotId, limit: 100 });
    expect(page.items).toHaveLength(3);
    expect(page.totalMatching).toBe(3);
    expect(page.nextCursor).toBeNull();

    // The derived cache created no tasks and no usage ledger rows for the session.
    expect(await repos.tasks.listBySession(sessionId)).toHaveLength(0);
    expect((await repos.usage.totals({ sessionId })).entries).toBe(0);
  });

  it('rolls back the whole publish when inserting an event midway fails, leaving no readable snapshot', () => {
    const { repos, sessionId } = setup();
    startRefresh(repos, sessionId, 'req-1');
    const snap = snapshotRecord(sessionId, sha('content-rollback'));
    const good = traceEvent(0);
    const duplicateId = { ...traceEvent(1), eventId: good.eventId };
    expect(() =>
      repos.insight.publish({ sessionId, requestId: 'req-1', expectedBindingRevision: 0, snapshot: snap, events: [good, duplicateId] })
    ).toThrow();
    // No half snapshot readable; request stays running so the failure is explicit.
    expect(repos.insight.getSnapshot(sessionId, snap.snapshotId)).toBeUndefined();
    expect(repos.insight.getState(sessionId).state).toBe('running');
  });

  it('fails the request on changed binding revision and keeps the previous snapshot pointer', () => {
    const { repos, claim, sessionId, runId } = setup();
    createLifecycleDriver(repos, claim, sessionId, runId, 'driver-1');
    const writer = repos.insight.bindSources(claim);

    // First successful publish at revision 1.
    startRefresh(repos, sessionId, 'req-1');
    writer.appendObserved(observation(sessionId, runId, 'driver-1', { observationId: 'obs-1' }));
    const v1 = snapshotRecord(sessionId, sha('v1'), { snapshotId: 'snap-v1' });
    v1.manifest.bindingRevision = 1;
    repos.insight.publish({ sessionId, requestId: 'req-1', expectedBindingRevision: 1, snapshot: v1, events: [] });
    expect(repos.insight.getState(sessionId).currentSnapshotId).toBe('snap-v1');

    // New analysis fixes revision 1, but a material source change bumps to 2.
    startRefresh(repos, sessionId, 'req-2');
    writer.appendObserved(
      observation(sessionId, runId, 'driver-1', {
        observationId: 'obs-2',
        capturedAt: '2026-10-03T00:10:00.000Z',
        verifiedPath: '/data/home/.codex/sessions/new.jsonl'
      })
    );
    const v2 = snapshotRecord(sessionId, sha('v2'), { snapshotId: 'snap-v2' });
    v2.manifest.bindingRevision = 1;
    expect(() =>
      repos.insight.publish({ sessionId, requestId: 'req-2', expectedBindingRevision: 1, snapshot: v2, events: [] })
    ).toThrow(expect.objectContaining({ code: 'INSIGHT_SOURCE_BINDING_CHANGED' }));
    const state = repos.insight.getState(sessionId);
    expect(state.state).toBe('failed');
    expect(state.errorCode).toBe('source_binding_changed');
    expect(state.currentSnapshotId).toBe('snap-v1');
    expect(repos.insight.getSnapshot(sessionId, 'snap-v2')).toBeUndefined();
  });

  it('cancels a queued/running request idempotently without moving the current snapshot', () => {
    const { repos, sessionId } = setup();
    // Publish one snapshot so there is a current pointer to preserve.
    startRefresh(repos, sessionId, 'req-0');
    const prior = snapshotRecord(sessionId, sha('cancel-v0'), { snapshotId: 'snap-cancel-0' });
    repos.insight.publish({ sessionId, requestId: 'req-0', expectedBindingRevision: 0, snapshot: prior, events: [] });

    startRefresh(repos, sessionId, 'req-1');
    expect(repos.insight.cancel(sessionId, 'req-1')).toBe(true);
    expect(repos.insight.cancel(sessionId, 'req-1')).toBe(false);
    const state = repos.insight.getState(sessionId);
    expect(state.state).toBe('cancelled');
    // Failure/cancel keeps the previous readable snapshot.
    expect(state.currentSnapshotId).toBe('snap-cancel-0');
    // cancel then retry is allowed.
    startRefresh(repos, sessionId, 'req-2');
    expect(repos.insight.getState(sessionId).state).toBe('running');
  });

  it('reuses an existing complete snapshot for an identical cache key and preserves snapshotId/createdAt', () => {
    const { repos, sessionId } = setup();
    startRefresh(repos, sessionId, 'req-1');
    const original = snapshotRecord(sessionId, sha('same-input'), {
      snapshotId: 'snap-cache',
      createdAt: '2026-10-03T00:00:00.000Z'
    });
    repos.insight.publish({ sessionId, requestId: 'req-1', expectedBindingRevision: 0, snapshot: original, events: [] });

    startRefresh(repos, sessionId, 'req-2');
    const hit = repos.insight.resolveCacheHit(sessionId, 'req-2', sha('same-input'), 0);
    expect(hit.outcome).toBe('hit');
    if (hit.outcome === 'hit') expect(hit.snapshotId).toBe('snap-cache');
    const state = repos.insight.getState(sessionId);
    expect(state.state).toBe('succeeded');
    expect(state.currentSnapshotId).toBe('snap-cache');
    expect(repos.insight.findSnapshotByCacheKey(sessionId, sha('same-input'))?.createdAt).toBe('2026-10-03T00:00:00.000Z');
    // publish with the same cache key also reuses rather than inserting a duplicate row.
    startRefresh(repos, sessionId, 'req-3');
    const duplicate = snapshotRecord(sessionId, sha('same-input'), { snapshotId: 'snap-different-id' });
    repos.insight.publish({ sessionId, requestId: 'req-3', expectedBindingRevision: 0, snapshot: duplicate, events: [] });
    expect(repos.insight.getState(sessionId).currentSnapshotId).toBe('snap-cache');
  });
});

describe('session insight event pagination', () => {
  it('binds the cursor to snapshot and filter and never mixes snapshots', () => {
    const { repos, sessionId } = setup();
    startRefresh(repos, sessionId, 'req-1');
    const snap = snapshotRecord(sessionId, sha('events'));
    const events = Array.from({ length: 5 }, (_, index) => traceEvent(index));
    repos.insight.publish({ sessionId, requestId: 'req-1', expectedBindingRevision: 0, snapshot: snap, events });

    const first = repos.insight.listEvents({ snapshotId: snap.snapshotId, limit: 2 });
    expect(first.items.map(e => e.ordinal)).toEqual([0, 1]);
    expect(first.nextCursor).toBeTruthy();
    const second = repos.insight.listEvents({ snapshotId: snap.snapshotId, limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map(e => e.ordinal)).toEqual([2, 3]);

    // A cursor is invalid under a different filter.
    expect(() =>
      repos.insight.listEvents({ snapshotId: snap.snapshotId, limit: 2, cursor: first.nextCursor ?? undefined, kind: 'tool_result' })
    ).toThrow(expect.objectContaining({ code: 'INSIGHT_INVALID_CURSOR' }));

    // Filtered paging only returns matching rows.
    const failures = repos.insight.listEvents({ snapshotId: snap.snapshotId, limit: 10, result: 'failure' });
    expect(failures.items.every(e => e.resultStatus === 'failure')).toBe(true);
    expect(failures.items.map(e => e.ordinal)).toEqual([0, 3]);
  });
});

describe('session insight retention, eviction and restart', () => {
  it('keeps current plus one old snapshot per session and tombstones further old snapshots (410)', () => {
    const { repos, sessionId } = setup();
    const publishOne = (requestId: string, snapshotId: string, key: string) => {
      startRefresh(repos, sessionId, requestId);
      const snap = snapshotRecord(sessionId, sha(key), { snapshotId });
      repos.insight.publish({ sessionId, requestId, expectedBindingRevision: 0, snapshot: snap, events: [] });
    };
    publishOne('req-1', 'snap-1', 'k1');
    publishOne('req-2', 'snap-2', 'k2');
    publishOne('req-3', 'snap-3', 'k3');
    // Current = snap-3; only one old snapshot retained; snap-1 evicted.
    expect(repos.insight.getState(sessionId).currentSnapshotId).toBe('snap-3');
    expect(repos.insight.getSnapshot(sessionId, 'snap-2')?.snapshotId).toBe('snap-2');
    expect(repos.insight.isSnapshotTombstoned(sessionId, 'snap-1')).toBe(true);
    expect(() => repos.insight.getSnapshot(sessionId, 'snap-1')).toThrow(
      expect.objectContaining({ code: 'INSIGHT_SNAPSHOT_GONE', statusCode: 410 })
    );
  });

  it('marks queued/running jobs from a previous process run as interrupted on startup', () => {
    const { repos, sessionId } = setup();
    repos.insight.beginRefresh(sessionId, 'req-old', 'old-process');
    repos.insight.markRunning(sessionId, 'req-old', 'old-process');
    const changed = repos.insight.markInterrupted('current-process');
    expect(changed).toBe(1);
    expect(repos.insight.getState(sessionId).state).toBe('interrupted');
    // The current process's own job is not interrupted.
    repos.insight.beginRefresh(sessionId, 'req-new', 'current-process');
    repos.insight.markRunning(sessionId, 'req-new', 'current-process');
    expect(repos.insight.markInterrupted('current-process')).toBe(0);
    expect(repos.insight.getState(sessionId).state).toBe('running');
  });
});

describe('session insight catalog rows', () => {
  it('lists every session including unanalysed ones with persisted snapshot projection', () => {
    const { repos, claim } = setup({ sessionId: 's1' });
    const x = repos.execution.bind(claim);
    const at = '2026-10-03T00:00:00.000Z';
    x.createSession({ id: 's2', runId: 'r2', agentId: 'agent-b', cwd: '/var/work', state: 'idle', createdAt: '2026-10-03T01:00:00.000Z', updatedAt: '2026-10-03T01:00:00.000Z' });
    x.createSession({ id: 's3', runId: 'r3', agentId: 'agent-c', cwd: '/var/archived', state: 'idle', createdAt: at, updatedAt: at, archivedAt: '2026-10-03T02:00:00.000Z' });
    startRefresh(repos, 's1', 'req-1');
    const snap = snapshotRecord('s1', sha('catalog'), { snapshotId: 'snap-catalog' });
    repos.insight.publish({ sessionId: 's1', requestId: 'req-1', expectedBindingRevision: 0, snapshot: snap, events: [] });

    const all = repos.insight.listSummaryRows({ limit: 50, includeArchived: true });
    expect(all.totalMatching).toBe(3);
    expect(all.rows.map(r => r.sessionId).sort()).toEqual(['s1', 's2', 's3']);
    const analysed = all.rows.find(r => r.sessionId === 's1')!;
    expect(analysed.refreshState).toBe('succeeded');
    expect(analysed.currentSnapshotId).toBe('snap-catalog');
    expect(analysed.snapshot?.summary.snapshotId).toBe('snap-catalog');
    const unanalysed = all.rows.find(r => r.sessionId === 's2')!;
    expect(unanalysed.refreshState).toBe('idle');
    expect(unanalysed.snapshot).toBeUndefined();

    // Default excludes archived; agent filter and time window apply to Session fields only.
    const active = repos.insight.listSummaryRows({ limit: 50 });
    expect(active.rows.map(r => r.sessionId).sort()).toEqual(['s1', 's2']);
    const onlyB = repos.insight.listSummaryRows({ agentId: 'agent-b' });
    expect(onlyB.rows.map(r => r.sessionId)).toEqual(['s2']);
    const windowed = repos.insight.listSummaryRows({
      from: '2026-10-03T00:30:00.000Z',
      to: '2026-10-03T01:30:00.000Z',
      includeArchived: true
    });
    expect(windowed.rows.map(r => r.sessionId)).toEqual(['s2']);
  });

  it('paginates catalog rows with a stable createdAt/sessionId cursor', () => {
    const { repos, claim } = setup({ sessionId: 'p1' });
    const x = repos.execution.bind(claim);
    const at = '2026-10-03T00:00:00.000Z';
    for (const id of ['p2', 'p3']) {
      x.createSession({ id, runId: `${id}-run`, agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
    }
    const page1 = repos.insight.listSummaryRows({ limit: 2, includeArchived: true });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = repos.insight.listSummaryRows({ limit: 2, cursor: page1.nextCursor ?? undefined, includeArchived: true });
    expect(page2.rows.map(r => r.sessionId)).toEqual(['p3']);
    expect(page2.nextCursor).toBeNull();
  });

  it('projects workspaceSourceCwd from the runtime_workspace config without falling back to cwd', () => {
    const directory = mkdtempSync(join(tmpdir(), 'session-insight-workspace-'));
    const filename = join(directory, 'state.sqlite');
    const repos = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' });
    const claim = repos.control.attachRuntime('controller');
    const at = '2026-10-03T00:00:00.000Z';
    const x = repos.execution.bind(claim);
    x.createSession({ id: 'ws', runId: 'r', agentId: 'fixture', cwd: '/repo/.git/wt/abc', state: 'idle', createdAt: at, updatedAt: at });
    x.createSession({ id: 'plain', runId: 'r2', agentId: 'fixture', cwd: '/repo', state: 'idle', createdAt: at, updatedAt: at });
    claim.release();
    repos.close();

    const writer = new Database(filename);
    writer.prepare("INSERT INTO configs(key,value) VALUES (?,?)").run(
      'runtime_workspace:ws',
      JSON.stringify({ schemaVersion: 1, revision: 1, sessionId: 'ws', mode: 'worktree', sourceCwd: '/repo', cwd: '/repo/.git/wt/abc', state: 'ready' })
    );
    writer.close();

    const reopened = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' });
    const rows = reopened.insight.listSummaryRows({ includeArchived: true });
    const ws = rows.rows.find(r => r.sessionId === 'ws')!;
    expect(ws.cwd).toBe('/repo/.git/wt/abc');
    expect(ws.workspaceSourceCwd).toBe('/repo');
    const plain = rows.rows.find(r => r.sessionId === 'plain')!;
    expect(plain.workspaceSourceCwd).toBeNull();
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects malformed catalog cursors and binds a cursor to its filters', () => {
    const { repos, claim } = setup({ sessionId: 'q1' });
    const x = repos.execution.bind(claim);
    const at = '2026-10-03T00:00:00.000Z';
    x.createSession({ id: 'q2', runId: 'r2', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });

    const encode = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    const filterAll = JSON.stringify([true, null, null, null, null]);

    // Malformed shapes must be 400, never 500.
    expect(() => repos.insight.listSummaryRows({ cursor: 'not-base64!!!' })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_CURSOR', statusCode: 400 })
    );
    expect(() => repos.insight.listSummaryRows({ cursor: encode([1, 2]) })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_CURSOR', statusCode: 400 })
    );
    expect(() => repos.insight.listSummaryRows({ cursor: encode({ createdAt: 'bad-date', sessionId: 'q1', filterKey: filterAll }) })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_CURSOR', statusCode: 400 })
    );
    expect(() => repos.insight.listSummaryRows({ cursor: encode({ createdAt: at, sessionId: '', filterKey: filterAll }) })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_CURSOR', statusCode: 400 })
    );

    // A valid cursor for includeArchived=true must not be accepted under default (archived excluded) filters.
    const page1 = repos.insight.listSummaryRows({ limit: 1, includeArchived: true });
    expect(page1.nextCursor).toBeTruthy();
    expect(() => repos.insight.listSummaryRows({ limit: 1, cursor: page1.nextCursor ?? undefined })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_CURSOR', statusCode: 400 })
    );
    // Same filters continues paging; total stays constant across pages.
    const page2 = repos.insight.listSummaryRows({ limit: 1, cursor: page1.nextCursor ?? undefined, includeArchived: true });
    expect(page2.totalMatching).toBe(2);
    expect(page1.totalMatching).toBe(2);
  });

  it('rejects invalid internal pagination limits', () => {
    const { repos } = setup({ sessionId: 'l1' });
    expect(() => repos.insight.listSummaryRows({ limit: 0 })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_PAGINATION', statusCode: 400 })
    );
    expect(() => repos.insight.listSummaryRows({ limit: -1 })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_PAGINATION', statusCode: 400 })
    );
    expect(() => repos.insight.listSummaryRows({ limit: 1.5 })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_PAGINATION', statusCode: 400 })
    );
    expect(() => repos.insight.listSummaryRows({ limit: SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageMax + 1 })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_PAGINATION', statusCode: 400 })
    );
  });
});

describe('session insight foreign keys and global payload pruning', () => {
  it('cascades sources, snapshots, events and refresh state when the session is deleted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'session-insight-fk-'));
    const filename = join(directory, 'state.sqlite');
    const repos = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' });
    const claim = repos.control.attachRuntime('controller');
    const at = '2026-10-03T00:00:00.000Z';
    repos.execution.bind(claim).createSession({ id: 'session', runId: 'run', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
    // Historical proof needs no driver resource row, so the only child rows are the derived cache.
    repos.insight.appendHistoricalProof(
      observation('session', 'run', 'driver-1', { observationId: 'hist-cascade', proofKind: 'historical_verified', launchKind: 'attached' })
    );
    const queued = repos.insight.beginRefresh('session', 'req-1');
    repos.insight.markRunning('session', 'req-1');
    const snap = snapshotRecord('session', sha('cascade'), { snapshotId: 'snap-cascade' });
    repos.insight.publish({ sessionId: 'session', requestId: 'req-1', expectedBindingRevision: queued.bindingRevision, snapshot: snap, events: [traceEvent(0)] });
    claim.release();
    repos.close();

    // Delete the authoritative session through a fresh FK-enabled connection.
    const raw = new Database(filename);
    raw.pragma('foreign_keys = ON');
    raw.prepare("DELETE FROM sessions WHERE id = 'session'").run();

    const counts = (table: string): number =>
      (raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    expect(counts('insight_sources')).toBe(0);
    expect(counts('insight_snapshots')).toBe(0);
    expect(counts('insight_events')).toBe(0);
    expect(counts('insight_refresh')).toBe(0);
    raw.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('evicts oldest non-current first, then other sessions currents to enforce the hard budget', () => {
    const { repos, claim } = setup({ sessionId: 'g1' });
    const x = repos.execution.bind(claim);
    const at = '2026-10-03T00:00:00.000Z';
    x.createSession({ id: 'g2', runId: 'r2', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });

    const publish = (sid: string, requestId: string, snapshotId: string, createdAt: string) => {
      const queued = repos.insight.beginRefresh(sid, requestId);
      repos.insight.markRunning(sid, requestId);
      const snap = snapshotRecord(sid, sha(snapshotId), { snapshotId, createdAt });
      repos.insight.publish({ sessionId: sid, requestId, expectedBindingRevision: queued.bindingRevision, snapshot: snap, events: [] });
    };
    publish('g1', 'r-a', 'g1-old', '2026-10-03T00:01:00.000Z');
    publish('g2', 'r-b', 'g2-current', '2026-10-03T00:02:00.000Z');
    publish('g1', 'r-c', 'g1-current', '2026-10-03T00:03:00.000Z');

    // Budget equals exactly the newest snapshot's size: the per-session stage drops the non-current
    // g1-old, then the global stage must evict the older other-session current (g2) until total fits,
    // atomically clearing g2's pointer (410 afterwards) while keeping the newest g1 current.
    const budget = repos.insight.getSnapshot('g1', 'g1-current')!.payloadBytes;
    const result = repos.insight.prune(budget);
    expect(result.totalPayloadBytes).toBeLessThanOrEqual(budget);
    expect(repos.insight.isSnapshotTombstoned('g1', 'g1-old')).toBe(true);
    expect(repos.insight.getSnapshot('g1', 'g1-current')?.snapshotId).toBe('g1-current');
    expect(repos.insight.isSnapshotTombstoned('g2', 'g2-current')).toBe(true);
    expect(() => repos.insight.getSnapshot('g2', 'g2-current')).toThrow(
      expect.objectContaining({ code: 'INSIGHT_SNAPSHOT_GONE', statusCode: 410 })
    );
    expect(repos.insight.getState('g2').currentSnapshotId).toBeNull();
  });

  it('keeps total payload at or under budget even when every session has only its current snapshot', () => {
    const { repos, claim } = setup({ sessionId: 'c1' });
    const x = repos.execution.bind(claim);
    const base = '2026-10-03T00:00:00.000Z';
    for (const id of ['c2', 'c3']) {
      x.createSession({ id, runId: `run-${id}`, agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: base, updatedAt: base });
    }
    const publish = (sid: string, createdAt: string) => {
      const req = `req-${sid}`;
      const queued = repos.insight.beginRefresh(sid, req);
      repos.insight.markRunning(sid, req);
      const snap = snapshotRecord(sid, sha(`only-${sid}`), { snapshotId: `only-${sid}`, createdAt });
      repos.insight.publish({ sessionId: sid, requestId: req, expectedBindingRevision: queued.bindingRevision, snapshot: snap, events: [] });
    };
    publish('c1', '2026-10-03T00:01:00.000Z');
    publish('c2', '2026-10-03T00:02:00.000Z');
    publish('c3', '2026-10-03T00:03:00.000Z');

    // No session has an old snapshot. A budget equal to only the newest snapshot still forces the
    // hard ceiling: the two oldest currents (c1, c2) are evicted with pointers cleared, rather than
    // claiming three "all current" snapshots are untouchable.
    const budget = repos.insight.getSnapshot('c3', 'only-c3')!.payloadBytes;
    const result = repos.insight.prune(budget);
    expect(result.totalPayloadBytes).toBeLessThanOrEqual(budget);
    expect(repos.insight.isSnapshotTombstoned('c1', 'only-c1')).toBe(true);
    expect(repos.insight.isSnapshotTombstoned('c2', 'only-c2')).toBe(true);
    expect(repos.insight.getSnapshot('c3', 'only-c3')?.snapshotId).toBe('only-c3');
    expect(repos.insight.getState('c1').currentSnapshotId).toBeNull();
    expect(repos.insight.getState('c2').currentSnapshotId).toBeNull();
  });
});

describe('session insight synchronous read transaction', () => {
  it('runs a read-only work function and returns its result for freezing host evidence', () => {
    const { repos, sessionId } = setup();
    const state = repos.insight.getState(sessionId);
    const result = repos.insight.readTransaction(() => ({
      state: repos.insight.getState(sessionId),
      capturedAt: '2026-10-03T00:00:00.000Z'
    }));
    expect(result.state.sessionId).toBe(sessionId);
    expect(result.capturedAt).toBe('2026-10-03T00:00:00.000Z');
    expect(state.state).toBe('idle');
  });
});

describe('session insight cache-hit revision CAS and cursor robustness', () => {
  it('resolveCacheHit fails with binding_changed when the source revision advanced', () => {
    const { repos, claim, sessionId, runId } = setup();
    createLifecycleDriver(repos, claim, sessionId, runId, 'driver-1');
    const writer = repos.insight.bindSources(claim);
    startRefresh(repos, sessionId, 'req-1');
    writer.appendObserved(observation(sessionId, runId, 'driver-1', { observationId: 'obs-hit-1' }));
    const v1 = snapshotRecord(sessionId, sha('hit-v1'), { snapshotId: 'hit-v1' });
    v1.manifest.bindingRevision = 1;
    repos.insight.publish({ sessionId, requestId: 'req-1', expectedBindingRevision: 1, snapshot: v1, events: [] });

    startRefresh(repos, sessionId, 'req-2');
    // Material source change bumps revision to 2 while the job fixed revision 1.
    writer.appendObserved(
      observation(sessionId, runId, 'driver-1', {
        observationId: 'obs-hit-2',
        capturedAt: '2026-10-03T00:20:00.000Z',
        verifiedPath: '/data/home/.codex/sessions/changed-hit.jsonl'
      })
    );
    const result = repos.insight.resolveCacheHit(sessionId, 'req-2', sha('hit-v1'), 1);
    expect(result.outcome).toBe('binding_changed');
    const state = repos.insight.getState(sessionId);
    expect(state.state).toBe('failed');
    expect(state.errorCode).toBe('source_binding_changed');
    expect(state.currentSnapshotId).toBe('hit-v1');
  });

  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

  it.each([
    ['not base64 json', 'not-base64!!!'],
    ['bound to another snapshot', null],
    ['negative ordinal', -1],
    ['non-integer ordinal', 1.5],
    ['string ordinal', 'x'],
    ['array instead of object', [1, 2, 3]],
    ['missing ordinal', undefined]
  ] as const)('rejects a malformed cursor (%s) with a 400, never a 500', (_label, corrupt) => {
    const { repos, sessionId } = setup();
    startRefresh(repos, sessionId, 'req-1');
    const snap = snapshotRecord(sessionId, sha('cursor-hard'));
    repos.insight.publish({ sessionId, requestId: 'req-1', expectedBindingRevision: 0, snapshot: snap, events: [traceEvent(0)] });
    // filter key for an unfiltered page is [null,null,null].
    const filter = [null, null, null];
    let cursor: string;
    if (corrupt === null) {
      cursor = encode({ snapshotId: 'other-snapshot', ordinal: 0, filter });
    } else if (corrupt === undefined) {
      cursor = encode({ snapshotId: snap.snapshotId, filter });
    } else if (Array.isArray(corrupt)) {
      cursor = encode(corrupt);
    } else {
      cursor = encode({ snapshotId: snap.snapshotId, ordinal: corrupt, filter });
    }
    if (_label === 'not base64 json') cursor = corrupt as unknown as string;
    expect(() => repos.insight.listEvents({ snapshotId: snap.snapshotId, limit: 10, cursor })).toThrow(
      expect.objectContaining({ code: 'INSIGHT_INVALID_CURSOR', statusCode: 400 })
    );
  });

  it('does not emit a next cursor on the last full page and keeps totalMatching across the whole filter', () => {
    const { repos, sessionId } = setup();
    startRefresh(repos, sessionId, 'req-1');
    const snap = snapshotRecord(sessionId, sha('cursor-last-page'));
    repos.insight.publish({
      sessionId, requestId: 'req-1', expectedBindingRevision: 0, snapshot: snap,
      events: [traceEvent(0), traceEvent(1)]
    });
    // Exactly a full final page (2 of 2): no next cursor.
    const page = repos.insight.listEvents({ snapshotId: snap.snapshotId, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(page.totalMatching).toBe(2);
  });
});

describe('session insight synchronous host evidence raw reader', () => {
  it('freezes authoritative task/verification/steering/usage rows in one synchronous read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'session-insight-evidence-'));
    const filename = join(directory, 'state.sqlite');
    const repos = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' });
    const claim = repos.control.attachRuntime('controller');
    const at = '2026-10-03T00:00:00.000Z';
    repos.execution.bind(claim).createSession({ id: 'session', runId: 'run', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });

    // Seed authoritative rows through a second committed connection on the same file:
    // a task, a verification config record, a steering operation and a usage ledger entry.
    const writer = new Database(filename);
    writer.pragma('foreign_keys = ON');
    writer.prepare(
      "INSERT INTO tasks(id, session_id, prompt, status, created_at, updated_at, revision, digest_version) VALUES ('task-1','session','do work','completed','2026-10-03T00:00:00.000Z','2026-10-03T00:05:00.000Z',1,'legacy_unverifiable')"
    ).run();
    writer.prepare("INSERT INTO configs(key, value) VALUES (?, ?)").run(
      'runtime_verification:session:verification_1',
      JSON.stringify({ id: 'verification_1', status: 'passed', stale: false })
    );
    writer.prepare(
      "INSERT INTO task_steering_operations(id, session_id, run_id, task_id, state, revision, json) VALUES ('st-1','session','run','task-1','delivered',1,'{}')"
    ).run();
    writer.prepare(
      `INSERT INTO usage_ledger(id, recorded_at, session_id, task_id, attempt_id, category, origin, agent_id, provider, cost_estimated, data_status, input_tokens, output_tokens, cost_usd)
       VALUES ('u-1','2026-10-03T00:05:00.000Z','session','task-1','attempt-1','explicit','agent','fixture','unknown',1,'reported',10,20,0.003)`
    ).run();
    writer.close();

    const raw = repos.insight.readHostEvidenceRaw('session');
    expect(raw.session).toMatchObject({ id: 'session', runId: 'run', agentId: 'fixture', source: null });
    expect(raw.tasks).toHaveLength(1);
    expect(raw.tasks[0]!.id).toBe('task-1');
    expect(raw.tasks[0]!.acceptedRequest).toBeNull();
    expect(raw.tasks[0]!.currentAttempt).toBeNull();
    expect(raw.verificationRecords).toEqual([
      { key: 'runtime_verification:session:verification_1', value: { id: 'verification_1', status: 'passed', stale: false } }
    ]);
    expect(raw.steeringOperations).toMatchObject([
      { id: 'st-1', taskId: 'task-1', state: 'delivered', revision: 1, payload: {} }
    ]);
    expect(raw.usageEntries).toHaveLength(1);
    expect(raw.usageEntries[0]!).toMatchObject({ id: 'u-1', session_id: 'session', cost_usd: 0.003 });
    expect(raw.nativeSelection).toBeNull();
    expect(Number.isFinite(new Date(raw.capturedAt).getTime())).toBe(true);

    claim.release();
    repos.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('scopes verification records by exact session id without underscore/percent wildcard leakage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'session-insight-prefix-'));
    const filename = join(directory, 'state.sqlite');
    const repos = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' });
    const claim = repos.control.attachRuntime('controller');
    const at = '2026-10-03T00:00:00.000Z';
    const x = repos.execution.bind(claim);
    // 'a_b' and 'axb' would collide under a LIKE 'a_b%' pattern (underscore = any char).
    x.createSession({ id: 'a_b', runId: 'r1', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
    x.createSession({ id: 'axb', runId: 'r2', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
    claim.release();
    repos.close();

    const writer = new Database(filename);
    writer.prepare("INSERT INTO configs(key, value) VALUES (?, ?)").run('runtime_verification:a_b:v1', JSON.stringify({ id: 'v1' }));
    writer.prepare("INSERT INTO configs(key, value) VALUES (?, ?)").run('runtime_verification:axb:v2', JSON.stringify({ id: 'v2' }));
    writer.close();

    const reopened = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' });
    const ab = reopened.insight.readHostEvidenceRaw('a_b');
    expect(ab.verificationRecords.map(r => r.key)).toEqual(['runtime_verification:a_b:v1']);
    const axb = reopened.insight.readHostEvidenceRaw('axb');
    expect(axb.verificationRecords.map(r => r.key)).toEqual(['runtime_verification:axb:v2']);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('session insight single running job per instance', () => {
  it('does not promote a second queued session to running while another is running', () => {
    const { repos, claim } = setup({ sessionId: 'busy' });
    const x = repos.execution.bind(claim);
    const at = '2026-10-03T00:00:00.000Z';
    x.createSession({ id: 'waiting', runId: 'rw', agentId: 'fixture', cwd: '/tmp', state: 'idle', createdAt: at, updatedAt: at });
    repos.insight.beginRefresh('busy', 'req-busy');
    expect(repos.insight.markRunning('busy', 'req-busy')).toBe(true);

    repos.insight.beginRefresh('waiting', 'req-wait');
    // Cannot become running while 'busy' runs; it stays queued for the scheduler to pick up later.
    expect(repos.insight.markRunning('waiting', 'req-wait')).toBe(false);
    expect(repos.insight.getState('waiting').state).toBe('queued');

    // Once the busy job finishes, the waiting job can be promoted.
    const snap = snapshotRecord('busy', sha('busy'));
    repos.insight.publish({ sessionId: 'busy', requestId: 'req-busy', expectedBindingRevision: 0, snapshot: snap, events: [] });
    expect(repos.insight.markRunning('waiting', 'req-wait')).toBe(true);
    expect(repos.insight.getState('waiting').state).toBe('running');
  });
});
