import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCountMetric,
  createContinuousMetric,
  type AnalyzeFilesResult,
  type FileAnalysisResult,
  type FileMetrics,
  type Metric,
  type RefreshState,
  type TaskRequestV1,
  type TraceEvent
} from '@dutydeck/shared';
import {
  buildSessionInsightSummary,
  buildSessionInsightSummaryResponse,
  deriveSessionUsage,
  filterSummaryCandidates,
  InsightSummaryBuildError,
  InsightSummaryCursorError,
  resolveCandidateWorkspace,
  type InsightUsageGroup,
  type SummaryCandidate,
  type SummarySnapshotRef
} from './session-insight-summary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');

const golden = JSON.parse(readFileSync(
  resolve(repoRoot, 'tests/fixtures/session-insight/golden/analyze-result.golden.json'), 'utf8'
)) as AnalyzeFilesResult;

const SHA_A = '4eca389acf9738934ae7fdc35a2ef4dfc34dcad94e90530fad96b2ad906006e3';
const SHA_B = '5eca389acf9738934ae7fdc35a2ef4dfc34dcad94e90530fad96b2ad906006e4';

// ---------------------------------------------------------------------------
// 构造助手
// ---------------------------------------------------------------------------

function metricValue(value: number | null, continuous = false): Metric {
  if (continuous) {
    return createContinuousMetric({
      value, quality: value === null ? 'unknown' : 'observed',
      status: value === null ? 'unavailable' : 'available',
      reasonCodes: value === null ? ['TEST_UNKNOWN'] : []
    });
  }
  return createCountMetric({
    value, quality: value === null ? 'unknown' : 'exact',
    status: value === null ? 'unavailable' : 'available',
    reasonCodes: value === null ? ['TEST_UNKNOWN'] : []
  });
}

const CONTINUOUS_KEYS = new Set<keyof FileMetrics>([
  'elapsedDurationMs', 'activeDurationMs', 'idleDurationMs', 'pairedToolDurationMs', 'toolFailureRate'
]);

function metricsWith(values: Partial<Record<keyof FileMetrics, number | null>>): FileMetrics {
  const result = structuredClone(golden.files[0]!.metrics) as FileMetrics;
  for (const [key, value] of Object.entries(values)) {
    (result as Record<string, Metric>)[key] = metricValue(value, CONTINUOUS_KEYS.has(key as keyof FileMetrics));
  }
  return result;
}

function fileResult(overrides: {
  sourceKey: string;
  sha256?: string;
  status?: FileAnalysisResult['status'];
  errorCode?: string | null;
  streamIdentity?: FileAnalysisResult['streamIdentity'];
  relationship?: FileAnalysisResult['relationship'];
  aggregation?: FileAnalysisResult['aggregation'];
  models?: string[];
  metrics?: FileMetrics;
  trace?: TraceEvent[];
}): FileAnalysisResult {
  const base = structuredClone(golden.files[0]!) as FileAnalysisResult;
  return {
    ...base,
    sourceKey: overrides.sourceKey,
    sha256: overrides.sha256 ?? SHA_A,
    status: overrides.status ?? 'ok',
    errorCode: overrides.errorCode ?? (overrides.status === 'error' ? 'ENGINE_BAD_FILE' : null),
    streamIdentity: overrides.streamIdentity ?? { kind: 'main', nativeAgentId: null },
    relationship: overrides.relationship ?? { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] },
    aggregation: overrides.aggregation ?? { eligibility: 'eligible', reasonCodes: [] },
    models: overrides.models ?? ['gpt-primary'],
    metrics: overrides.metrics ?? golden.files[0]!.metrics,
    trace: overrides.trace ?? base.trace
  };
}

function analyzeResult(files: FileAnalysisResult[], metricVersion = 'v1'): AnalyzeFilesResult {
  return { ...golden, requestId: '11111111-1111-4111-8111-111111111111', files, metricVersion };
}

function traceEvent(eventId: string, kind: TraceEvent['kind'], extra: Partial<TraceEvent> = {}): TraceEvent {
  return {
    eventId, sourceKey: 'src', nativeSessionId: 'native-1', nativeRunId: null,
    lineNumber: 1, byteOffset: 0, subeventIndex: 0, nativeEventId: eventId,
    timestamp: '2026-10-03T10:05:00Z', timeQuality: 'observed', kind,
    callId: null, parentCallId: null, toolName: null, resultStatus: null,
    durationMs: null, tokens: null, rawUsage: null,
    inputExcerpt: null, outputExcerpt: null, errorExcerpt: null,
    evidenceRefs: [], hostEventRef: null, isSnapshotLocalId: false, ...extra
  };
}

function buildSnapshot(
  sessionId: string,
  result: AnalyzeFilesResult,
  primarySourceKey: string,
  extra: Partial<SummarySnapshotRef> = {}
): SummarySnapshotRef {
  const summary = buildSessionInsightSummary({
    sessionId, snapshotId: `snap-${sessionId}`, createdAt: '2026-10-03T10:10:00Z',
    primarySourceKey, result
  });
  return {
    snapshotId: `snap-${sessionId}`, availability: 'complete', freshness: 'current',
    metricVersion: result.metricVersion, summary, ...extra
  };
}

function taskRequest(overrides: Partial<TaskRequestV1> = {}): TaskRequestV1 {
  return {
    version: 1, namespace: 'runtime', key: 'lark:app:msg:1', sessionId: 's1',
    actor: { kind: 'channel', id: 'u1', appId: 'app' }, prompt: 'p', mode: 'queue',
    skills: [], options: {}, sources: [], sourcePayload: null, ...overrides
  };
}

let seq = 0;
function candidate(over: Partial<SummaryCandidate> & { sessionId: string }): SummaryCandidate {
  seq += 1;
  const hour = Math.floor(seq / 60);
  const minute = seq % 60;
  return {
    agentId: 'agent-1',
    cwd: '/repo',
    createdAt: `2026-10-03T${String(10 + hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
    refreshState: 'idle' as RefreshState,
    ...over
  };
}

const standardMetrics = () => metricsWith({
  inputUncached: 100, output: 10, totalTracked: 110, rawInput: 100, rawOutput: 10,
  elapsedDurationMs: 1000, activeDurationMs: 800, idleDurationMs: 200,
  pairedToolDurationMs: 300, userTurns: 2, assistantTurns: 2,
  toolCalls: 4, toolFailures: 1, toolSuccesses: 3, toolUnknowns: 0,
  toolFailureRate: 0.25, peakContext: 200, reasoningOutput: 0, cacheRead: 0, cacheWrite: 0
});

function standardSnapshot(sessionId: string, overrides: {
  sourceKey?: string; sha256?: string; models?: string[]; metrics?: FileMetrics;
  relationship?: FileAnalysisResult['relationship']; aggregation?: FileAnalysisResult['aggregation'];
  metricVersion?: string;
} = {}): SummarySnapshotRef {
  const sourceKey = overrides.sourceKey ?? `native-${sessionId}`;
  const file = fileResult({
    sourceKey, sha256: overrides.sha256 ?? SHA_A, models: overrides.models ?? ['gpt-x'],
    metrics: overrides.metrics ?? standardMetrics(),
    relationship: overrides.relationship, aggregation: overrides.aggregation
  });
  return buildSnapshot(sessionId, analyzeResult([file], overrides.metricVersion ?? 'v1'), sourceKey, {
    metricVersion: overrides.metricVersion ?? 'v1'
  });
}

// ---------------------------------------------------------------------------
// 单会话 primary 投影
// ---------------------------------------------------------------------------

describe('buildSessionInsightSummary — primary projection (design 6.1/6.2)', () => {
  it('aggregateMetrics only covers primary; subagent observations are never added', () => {
    const primary = fileResult({ sourceKey: 'main', metrics: standardMetrics() });
    const subagentMetrics = metricsWith({
      inputUncached: 5000, output: 5000, toolCalls: 99,
      toolFailures: 10, toolSuccesses: 89, toolFailureRate: 10 / 99
    });
    const subagent = fileResult({
      sourceKey: 'sub', streamIdentity: { kind: 'subagent', nativeAgentId: 'agent-child' },
      relationship: { kind: 'child', parentNativeSessionId: 'native-1', parentNativeAgentId: null, evidenceRefs: ['ev'] },
      metrics: subagentMetrics
    });
    const summary = buildSessionInsightSummary({
      sessionId: 's1', snapshotId: 'snap1', createdAt: '2026-10-03T10:10:00Z',
      primarySourceKey: 'main', result: analyzeResult([primary, subagent])
    });
    expect(summary.aggregateMetrics.inputUncached.value).toBe(100);
    expect(summary.aggregateMetrics.toolCalls.value).toBe(4);
    expect(summary.sources.map(s => [s.sourceKey, s.scopeRole])).toEqual([
      ['main', 'primary'], ['sub', 'subagent']
    ]);
    expect(summary.models).toEqual(['gpt-primary']); // 不取 subagent 模型
  });

  it('uses native model multiset of primary only and flags multi-model', () => {
    const primary = fileResult({ sourceKey: 'main', models: ['m1', 'm2'] });
    const subagent = fileResult({
      sourceKey: 'sub', models: ['m3'],
      streamIdentity: { kind: 'subagent', nativeAgentId: 'child' }
    });
    const summary = buildSessionInsightSummary({
      sessionId: 's1', snapshotId: 'snap1', createdAt: '2026-10-03T10:10:00Z',
      primarySourceKey: 'main', result: analyzeResult([primary, subagent])
    });
    expect(summary.models).toEqual(['m1', 'm2']);
    expect(summary.isMultiModel).toBe(true);
  });

  it('keeps fork/unknown primary as primary observation but preserves exclusion evidence', () => {
    const primary = fileResult({
      sourceKey: 'forked-main',
      relationship: { kind: 'fork', parentNativeSessionId: 'parent', parentNativeAgentId: null, evidenceRefs: ['fork-ref'] },
      aggregation: { eligibility: 'excluded', reasonCodes: ['FORK_INHERITANCE'] }
    });
    const summary = buildSessionInsightSummary({
      sessionId: 's1', snapshotId: 'snap1', createdAt: '2026-10-03T10:10:00Z',
      primarySourceKey: 'forked-main', result: analyzeResult([primary])
    });
    expect(summary.sources[0]!.scopeRole).toBe('primary');
    expect(summary.sources[0]!.aggregation.eligibility).toBe('excluded');
    expect(summary.sources[0]!.relationship.kind).toBe('fork');
  });

  it('error files become excluded with no readable unverified metrics, models or evidence', () => {
    const primary = fileResult({ sourceKey: 'main' });
    const bad = fileResult({
      sourceKey: 'broken', status: 'error', errorCode: 'ENGINE_PARSE_FAILED',
      metrics: metricsWith({ inputUncached: 999 }), models: ['fake-model'],
      trace: [traceEvent('fake', 'tool_call', { resultStatus: 'failure' })]
    });
    const summary = buildSessionInsightSummary({
      sessionId: 's1', snapshotId: 'snap1', createdAt: '2026-10-03T10:10:00Z',
      primarySourceKey: 'main', result: analyzeResult([primary, bad])
    });
    const broken = summary.sources.find(s => s.sourceKey === 'broken')!;
    expect(broken.scopeRole).toBe('excluded');
    expect(broken.models).toEqual([]);
    expect(broken.metrics.inputUncached.value).toBeNull();
    expect(broken.keyEvidenceEventIds.failures).toEqual([]);
  });

  it('throws when primary source is missing or is an error file (host-only handled by T4c)', () => {
    const primary = fileResult({ sourceKey: 'main' });
    expect(() => buildSessionInsightSummary({
      sessionId: 's1', snapshotId: 'snap1', createdAt: '2026-10-03T10:10:00Z',
      primarySourceKey: 'absent', result: analyzeResult([primary])
    })).toThrow(InsightSummaryBuildError);

    const errorPrimary = fileResult({ sourceKey: 'main', status: 'error' });
    expect(() => buildSessionInsightSummary({
      sessionId: 's1', snapshotId: 'snap1', createdAt: '2026-10-03T10:10:00Z',
      primarySourceKey: 'main', result: analyzeResult([errorPrimary])
    })).toThrow(/unverified/i);
  });

  it('key evidence ids come solely from real retained trace', () => {
    const slow = traceEvent('slow-1', 'tool_result', {
      callId: 'c1', resultStatus: 'success',
      durationMs: createContinuousMetric({ value: 9000, quality: 'observed', status: 'available' })
    });
    const fail = traceEvent('fail-1', 'tool_result', { callId: 'c2', resultStatus: 'failure' });
    const tokens = traceEvent('tok-1', 'agent_message', {
      tokens: { inputUncached: 5000, output: 100 }
    });
    const primary = fileResult({ sourceKey: 'main', trace: [slow, fail, tokens] });
    const summary = buildSessionInsightSummary({
      sessionId: 's1', snapshotId: 'snap1', createdAt: '2026-10-03T10:10:00Z',
      primarySourceKey: 'main', result: analyzeResult([primary])
    });
    expect(summary.keyEvidenceEventIds.failures).toEqual(['fail-1']);
    expect(summary.keyEvidenceEventIds.slowCalls).toEqual(['slow-1']);
    expect(summary.keyEvidenceEventIds.highTokenDeltas).toEqual(['tok-1']);
    expect(Object.isFrozen(summary)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 用途 / 工作区推导
// ---------------------------------------------------------------------------

describe('deriveSessionUsage (design 6.1)', () => {
  it('uses real TaskRequest namespace and verified proactive flag; mixed on multiple categories', () => {
    const larkSession = { source: 'lark', sourceId: 'cli_app:chat:group' };
    expect(deriveSessionUsage({ ...larkSession, tasks: [{ request: taskRequest(), proactive: false }] })).toBe('explicit');
    expect(deriveSessionUsage({
      ...larkSession, tasks: [{ request: taskRequest(), proactive: true }]
    })).toBe('proactive');
    expect(deriveSessionUsage({
      ...larkSession, tasks: [{ request: taskRequest({ namespace: 'schedule' }) }]
    })).toBe('scheduled');
    expect(deriveSessionUsage({
      ...larkSession,
      tasks: [
        { request: taskRequest(), proactive: false },
        { request: taskRequest({ namespace: 'schedule' }) }
      ]
    })).toBe('mixed');
    // web 安装所有者发起的任务不依赖 proactive 证据。
    expect(deriveSessionUsage({
      tasks: [{ request: taskRequest({ actor: { kind: 'installation_owner', id: 'installation_owner' } }) }]
    })).toBe('explicit');
  });

  it('missing proactive evidence is unknown, never inferred from prompt or cost', () => {
    const usage = deriveSessionUsage({
      source: 'lark', sourceId: 'cli_app:chat:group',
      tasks: [{ request: taskRequest() /* proactive omitted */ }]
    });
    expect(usage).toBe('unknown');
    expect(deriveSessionUsage({ source: 'lark-memory', sourceId: 'x:groups:x' })).toBe('background');
    expect(deriveSessionUsage({ source: undefined, tasks: [] })).toBe('unknown');
  });

  it('worktree session groups by workspaceSourceCwd so same repo is never split', () => {
    const repoSession = { sessionId: 'a', cwd: '/data/repo' };
    const worktreeSession = { sessionId: 'b', cwd: '/data/repo/.worktrees/task-1', workspaceSourceCwd: '/data/repo' };
    expect(resolveCandidateWorkspace(worktreeSession)).toBe(resolveCandidateWorkspace(repoSession));
    expect(resolveCandidateWorkspace({ sessionId: 'c', cwd: '/data/other' })).not.toBe('/data/repo');
  });
});

// ---------------------------------------------------------------------------
// 跨会话汇总
// ---------------------------------------------------------------------------

describe('buildSessionInsightSummaryResponse — cohorts (design 6.1/6.2)', () => {
  function build(cands: SummaryCandidate[], opts: {
    filter?: Parameters<typeof buildSessionInsightSummaryResponse>[0]['filter'];
    groupBy?: 'workspace' | 'agent' | 'model' | 'usage';
    limit?: number; cursor?: string;
  } = {}) {
    return buildSessionInsightSummaryResponse({
      candidates: cands, filter: opts.filter, groupBy: opts.groupBy,
      limit: opts.limit ?? 50, cursor: opts.cursor
    });
  }

  it('cold/hot candidate denominator identical; with + without = candidate only', () => {
    const rows = [
      candidate({ sessionId: 'analyzed', snapshot: standardSnapshot('analyzed') }),
      candidate({ sessionId: 'pending' })
    ];
    for (const _cold of [0, 1]) {
      const response = build(rows);
      expect(response.candidateSessions).toBe(2);
      expect(response.withSnapshot).toBe(1);
      expect(response.withoutSnapshot).toBe(1);
      expect(response.withSnapshot + response.withoutSnapshot).toBe(response.candidateSessions);
      // partial/failed/stale 是可重叠维度，不与 with/without 相加。
      const overlapSum = response.partialSnapshots + response.failedRefreshes
        + response.staleSnapshots + response.freshnessUnknown;
      expect(overlapSum).toBeGreaterThanOrEqual(0);
    }
  });

  it('groups and counts cover full filtered directory when sessions are paginated', () => {
    const rows = [
      candidate({ sessionId: 's1', snapshot: standardSnapshot('s1'), cwd: '/a' }),
      candidate({ sessionId: 's2', snapshot: standardSnapshot('s2'), cwd: '/a' }),
      candidate({ sessionId: 's3', snapshot: standardSnapshot('s3'), cwd: '/a' })
    ];
    const page1 = build(rows, { limit: 2 });
    expect(page1.sessions).toHaveLength(2);
    expect(page1.candidateSessions).toBe(3);
    const group = page1.groups[0]!;
    expect(group.candidateSessions).toBe(3);
    expect(group.aggregateMetrics!.inputUncached.value).toBe(300); // 100 × 3，全量非分页
    expect(page1.nextCursor).toBeTruthy();

    const page2 = build(rows, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.sessions.map(s => s.sessionId)).toEqual(['s3']);
    expect(page2.groups[0]!.candidateSessions).toBe(3);
    expect(page2.nextCursor).toBeNull();
  });

  it('input order does not change stable attribution (createdAt/sessionId ordering)', () => {
    const rows = [
      candidate({ sessionId: 's1', createdAt: '2026-10-03T10:00:00Z' }),
      candidate({ sessionId: 's2', createdAt: '2026-10-03T09:00:00Z' }),
      candidate({ sessionId: 's3', createdAt: '2026-10-03T11:00:00Z' })
    ];
    const first = build(rows);
    const second = build([...rows].reverse());
    expect(first).toEqual(second);
    expect(first.sessions.map(s => s.sessionId)).toEqual(['s2', 's1', 's3']);
  });

  it('same sourceKey + same hash across sessions/workspaces counts once; other rows sharedSource', () => {
    const rows = [
      candidate({
        sessionId: 'owner', cwd: '/repo-a', createdAt: '2026-10-03T09:00:00Z',
        snapshot: standardSnapshot('owner', { sourceKey: 'shared-native', sha256: SHA_A })
      }),
      candidate({
        sessionId: 'copy', cwd: '/repo-b', createdAt: '2026-10-03T11:00:00Z',
        snapshot: standardSnapshot('copy', { sourceKey: 'shared-native', sha256: SHA_A })
      })
    ];
    const response = build(rows, { groupBy: 'agent' });
    const group = response.groups[0]!;
    expect(group.candidateSessions).toBe(2);
    expect(group.aggregateMetrics!.inputUncached.value).toBe(100); // 不是 200
    const ownerRow = response.sessions.find(s => s.sessionId === 'owner')!;
    const copyRow = response.sessions.find(s => s.sessionId === 'copy')!;
    expect(ownerRow.isSharedSource).toBe(false);
    expect(copyRow.isSharedSource).toBe(true);
    expect(ownerRow.attributionNote).toContain('1 other session');
    expect(copyRow.metrics!.inputUncached.value).toBe(100); // 单源观察保留
  });

  it('same sourceKey different hash excludes every occurrence as snapshot_version_conflict', () => {
    const rows = [
      candidate({
        sessionId: 's1', createdAt: '2026-10-03T09:00:00Z',
        snapshot: standardSnapshot('s1', { sourceKey: 'native-x', sha256: SHA_A })
      }),
      candidate({
        sessionId: 's2', createdAt: '2026-10-03T10:00:00Z',
        snapshot: standardSnapshot('s2', { sourceKey: 'native-x', sha256: SHA_B })
      })
    ];
    const response = build(rows, { groupBy: 'agent' });
    expect(response.groups[0]!.aggregateMetrics).toBeNull();
    const coverage = response.groups[0]!.metricCoverage.inputUncached!;
    expect(coverage.includedCount).toBe(0);
    expect(coverage.excludedReasons.snapshot_version_conflict).toBe(2);
    for (const row of response.sessions) {
      expect(row.metricAttributions.inputUncached!.reason).toBe('snapshot_version_conflict');
    }
  });

  it('fork/inheritance-unknown sources are excluded from totals but stay single-source observations', () => {
    const eligible = standardSnapshot('clean', { sourceKey: 'native-clean' });
    const forked = standardSnapshot('forked', {
      sourceKey: 'native-fork',
      relationship: { kind: 'fork', parentNativeSessionId: 'p', parentNativeAgentId: null, evidenceRefs: [] },
      aggregation: { eligibility: 'excluded', reasonCodes: ['FORK_INHERITANCE'] }
    });
    const rows = [
      candidate({ sessionId: 'clean', snapshot: eligible }),
      candidate({ sessionId: 'forked', snapshot: forked })
    ];
    const response = build(rows, { groupBy: 'agent' });
    expect(response.groups[0]!.aggregateMetrics!.inputUncached.value).toBe(100);
    const forkedRow = response.sessions.find(s => s.sessionId === 'forked')!;
    expect(forkedRow.metrics!.inputUncached.value).toBe(100); // 观察保留
    expect(forkedRow.metricAttributions.inputUncached!.included).toBe(false);
    expect(forkedRow.metricAttributions.inputUncached!.reason).toMatch(/fork|excluded/);
  });

  it('unknown metric is never zero-filled and each metric has independent coverage', () => {
    const full = standardSnapshot('full', { sourceKey: 'native-full' });
    const sparse = standardSnapshot('sparse', {
      sourceKey: 'native-sparse',
      metrics: metricsWith({
        inputUncached: null, output: 10, elapsedDurationMs: null,
        toolFailures: 1, toolSuccesses: 1
      })
    });
    const response = build([
      candidate({ sessionId: 'full', snapshot: full }),
      candidate({ sessionId: 'sparse', snapshot: sparse })
    ], { groupBy: 'agent' });
    const group = response.groups[0]!;
    // 未知源不按 0：合计只含已知源（100），但必须降为 partial 并给出覆盖差异。
    expect(group.aggregateMetrics!.inputUncached.value).toBe(100);
    expect(group.aggregateMetrics!.inputUncached.status).toBe('partial');
    expect(group.aggregateMetrics!.output.status).toBe('available');
    expect(group.aggregateMetrics!.output.value).toBe(20);
    const inputCov = group.metricCoverage.inputUncached!;
    expect(inputCov.includedCount).toBe(1);
    expect(inputCov.excludedCount).toBe(1);
    expect(inputCov.excludedReasons.metric_unavailable).toBe(1);
    expect(group.metricCoverage.output!.includedCount).toBe(2);
    const elapsedCov = group.metricCoverage.elapsedDurationMs!;
    expect(elapsedCov.includedCount).toBe(1); // 单源有值仍保留
    expect(elapsedCov.excludedReasons.metric_unavailable).toBe(1);
  });

  it('failure rate recomputes on known denominator only; zero determinable calls is null', () => {
    const a = standardSnapshot('a', {
      sourceKey: 'native-a',
      metrics: metricsWith({ toolFailures: 1, toolSuccesses: 3, toolCalls: 4 })
    });
    const unknown = standardSnapshot('b', {
      sourceKey: 'native-b',
      metrics: metricsWith({ toolFailures: null, toolSuccesses: null, toolCalls: 4 })
    });
    const response = build([
      candidate({ sessionId: 'a', snapshot: a }),
      candidate({ sessionId: 'b', snapshot: unknown })
    ], { groupBy: 'agent' });
    const rate = response.groups[0]!.aggregateMetrics!.toolFailureRate;
    expect(rate.value).toBeCloseTo(0.25, 10);
    expect(rate.quality).toBe('derived');
    const coverage = response.groups[0]!.metricCoverage.toolFailureRate!;
    expect(coverage.includedCount).toBe(1);
    expect(coverage.excludedReasons.metric_unavailable).toBe(1);

    const noCalls = standardSnapshot('c', {
      sourceKey: 'native-c',
      metrics: metricsWith({ toolFailures: 0, toolSuccesses: 0, toolCalls: 2 })
    });
    const none = build([candidate({ sessionId: 'c', snapshot: noCalls })], { groupBy: 'agent' });
    expect(none.groups[0]!.aggregateMetrics!.toolFailureRate.value).toBeNull();
  });

  it('native elapsed durations are never summed; paired tool durations are independent and summed', () => {
    const rows = [
      candidate({ sessionId: 'a', snapshot: standardSnapshot('a', { sourceKey: 'native-a' }) }),
      candidate({ sessionId: 'b', snapshot: standardSnapshot('b', { sourceKey: 'native-b' }) })
    ];
    const response = build(rows, { groupBy: 'agent' });
    const group = response.groups[0]!;
    expect(group.aggregateMetrics!.elapsedDurationMs.value).toBeNull();
    expect(group.metricCoverage.elapsedDurationMs!.excludedReasons.duration_not_addable).toBe(2);
    expect(group.aggregateMetrics!.pairedToolDurationMs.value).toBe(600);
  });

  it('paired tool duration sums legal finite floating points (1.5 + 2.25 = 3.75) without overflow', () => {
    const a = standardSnapshot('a', {
      sourceKey: 'native-a',
      metrics: metricsWith({ pairedToolDurationMs: 1.5 })
    });
    const b = standardSnapshot('b', {
      sourceKey: 'native-b',
      metrics: metricsWith({ pairedToolDurationMs: 2.25 })
    });
    const response = build([
      candidate({ sessionId: 'a', snapshot: a }),
      candidate({ sessionId: 'b', snapshot: b })
    ], { groupBy: 'agent' });
    const group = response.groups[0]!;
    const paired = group.aggregateMetrics!.pairedToolDurationMs;
    expect(paired.value).toBe(3.75);
    expect(paired.status).toBe('available');
    expect(paired.reasonCodes).not.toContain('AGGREGATE_OVERFLOW');
    expect(Number.isInteger(paired.evidenceCount)).toBe(true);
    expect(paired.evidenceCount).toBe(2);
    expect(paired.missingCount).toBe(0);
    expect(group.metricCoverage.pairedToolDurationMs!.includedCount).toBe(2);
    expect(group.metricCoverage.pairedToolDurationMs!.excludedCount).toBe(0);
  });

  it('paired tool duration flags overflow only on non-finite values', () => {
    const huge = Number.MAX_VALUE;
    const a = standardSnapshot('a', {
      sourceKey: 'native-a',
      metrics: metricsWith({ pairedToolDurationMs: huge })
    });
    const b = standardSnapshot('b', {
      sourceKey: 'native-b',
      metrics: metricsWith({ pairedToolDurationMs: huge })
    });
    const response = build([
      candidate({ sessionId: 'a', snapshot: a }),
      candidate({ sessionId: 'b', snapshot: b })
    ], { groupBy: 'agent' });
    const group = response.groups[0]!;
    const paired = group.aggregateMetrics!.pairedToolDurationMs;
    expect(paired.value).toBeNull();
    expect(paired.reasonCodes).toContain('AGGREGATE_OVERFLOW');
    expect(group.metricCoverage.pairedToolDurationMs!.excludedReasons.aggregate_overflow).toBe(2);
  });

  it('model grouping: single model, multi_model, and unanalyzed unknown', () => {
    const rows = [
      candidate({ sessionId: 's1', snapshot: standardSnapshot('s1', { models: ['gpt-x'] }) }),
      candidate({ sessionId: 's2', snapshot: standardSnapshot('s2', { models: ['gpt-x', 'gpt-y'] }) }),
      candidate({ sessionId: 's3' })
    ];
    const response = build(rows, { groupBy: 'model' });
    const keys = response.groups.map(g => g.groupKey).sort();
    expect(keys).toEqual(['gpt-x', 'multi_model', 'unknown']);
    expect(response.sessions.find(s => s.sessionId === 's3')!.models).toEqual([]);
  });

  it('mixed metric versions are never silently combined', () => {
    const rows = [
      candidate({ sessionId: 'a', snapshot: standardSnapshot('a', { sourceKey: 'native-a', metricVersion: 'v1' }) }),
      candidate({ sessionId: 'b', snapshot: standardSnapshot('b', { sourceKey: 'native-b', metricVersion: 'v2' }) })
    ];
    const response = build(rows, { groupBy: 'agent' });
    expect(response.groups[0]!.aggregateMetrics).toBeNull();
    const coverage = response.groups[0]!.metricCoverage.inputUncached!;
    expect(coverage.excludedReasons.metric_version_conflict).toBe(2);
  });

  it('safe counts never overflow to Infinity or lose precision', () => {
    const huge = () => metricsWith({ inputUncached: Number.MAX_SAFE_INTEGER });
    const rows = [
      candidate({ sessionId: 'a', snapshot: standardSnapshot('a', { sourceKey: 'native-a', metrics: huge() }) }),
      candidate({ sessionId: 'b', snapshot: standardSnapshot('b', { sourceKey: 'native-b', metrics: huge() }) })
    ];
    const response = build(rows, { groupBy: 'agent' });
    const metric = response.groups[0]!.aggregateMetrics!.inputUncached;
    expect(metric.value).toBeNull();
    expect(metric.reasonCodes).toContain('AGGREGATE_OVERFLOW');
    expect(response.groups[0]!.metricCoverage.inputUncached!.excludedReasons.aggregate_overflow).toBe(2);
  });

  it('rows without snapshot have null metrics, never fabricated zero metrics', () => {
    const response = build([candidate({ sessionId: 'empty' })], { groupBy: 'agent' });
    const row = response.sessions[0]!;
    expect(row.metrics).toBeNull();
    expect(row.availability).toBe('none');
    expect(response.groups[0]!.aggregateMetrics).toBeNull();
    expect(response.groups[0]!.metricCoverage.inputUncached!.excludedReasons.not_analyzed).toBe(1);
  });

  it('time window is [from,to) on Session.createdAt; archived defaults excluded', () => {
    const rows = [
      candidate({ sessionId: 'live', createdAt: '2026-10-03T10:00:00Z' }),
      candidate({ sessionId: 'archived', createdAt: '2026-10-03T10:30:00Z', archivedAt: '2026-10-03T12:00:00Z' }),
      candidate({ sessionId: 'boundary', createdAt: '2026-10-03T11:00:00Z' })
    ];
    const windowed = build(rows, {
      filter: { from: '2026-10-03T10:00:00Z', to: '2026-10-03T11:00:00Z' }
    });
    expect(windowed.sessions.map(s => s.sessionId)).toEqual(['live']);
    expect(windowed.candidateSessions).toBe(1);

    const included = build(rows, { filter: { includeArchived: true } });
    expect(included.candidateSessions).toBe(3);
  });

  it('workspace/agent/usage filters derive from directory and task metadata, not cache', () => {
    const rows = [
      candidate({
        sessionId: 'repo1', cwd: '/repo-a', agentId: 'agent-a',
        tasks: [{ request: taskRequest({ namespace: 'schedule' }) }]
      }),
      candidate({ sessionId: 'repo2', cwd: '/repo-b', agentId: 'agent-b' })
    ];
    const byWorkspace = filterSummaryCandidates(rows, { workspace: '/repo-a' });
    expect(byWorkspace.map(c => c.sessionId)).toEqual(['repo1']);
    const byAgent = filterSummaryCandidates(rows, { agentId: 'agent-b' });
    expect(byAgent.map(c => c.sessionId)).toEqual(['repo2']);
    const byUsage = build(rows, { filter: { usage: 'scheduled' } });
    expect(byUsage.candidateSessions).toBe(1);
  });

  it('bad cursors (garbage base64, NaN time, wrong filter signature) throw a fixed error, never 500', () => {
    const rows = [candidate({ sessionId: 's1' })];
    const expectBad = (cursor: string) => expect(() => build(rows, { cursor })).toThrow(InsightSummaryCursorError);
    expectBad('not-base64!!!');
    expectBad(Buffer.from(JSON.stringify({ t: 'not-a-date', id: 's1', f: 'x' })).toString('base64url'));
    const good = build(rows, { filter: { agentId: 'agent-1' }, limit: 1 });
    if (good.nextCursor) {
      // 同一 cursor 换过滤条件必须拒绝（绑定过滤条件）。
      expect(() => build(rows, { filter: { agentId: 'agent-2' }, limit: 1, cursor: good.nextCursor }))
        .toThrow(InsightSummaryCursorError);
    }
  });

  it('usage row groups use mixed category and real lark namespace requests', () => {
    const rows = [
      candidate({
        sessionId: 'mixed', source: 'lark', sourceId: 'cli_app:chat:group',
        tasks: [
          { request: taskRequest(), proactive: false },
          { request: taskRequest({ namespace: 'automation' }) }
        ]
      })
    ];
    const response = build(rows, { groupBy: 'usage' });
    expect(response.groups.map(g => g.groupKey)).toEqual(['mixed']);
    expect(response.sessions[0]!.usage).toBe('mixed' as InsightUsageGroup);
  });

  it('shared-source owner is the earliest row regardless of input order', () => {
    const older = candidate({
      sessionId: 'earlier', createdAt: '2026-10-03T08:00:00Z', cwd: '/repo-a',
      snapshot: standardSnapshot('earlier', { sourceKey: 'shared-native', sha256: SHA_A })
    });
    const newer = candidate({
      sessionId: 'later', createdAt: '2026-10-03T12:00:00Z', cwd: '/repo-b',
      snapshot: standardSnapshot('later', { sourceKey: 'shared-native', sha256: SHA_A })
    });
    for (const rows of [[older, newer], [newer, older]]) {
      const response = build(rows, { groupBy: 'agent' });
      const earlierRow = response.sessions.find(s => s.sessionId === 'earlier')!;
      const laterRow = response.sessions.find(s => s.sessionId === 'later')!;
      expect(earlierRow.isSharedSource).toBe(false);
      expect(laterRow.isSharedSource).toBe(true);
      expect(response.groups[0]!.aggregateMetrics!.inputUncached.value).toBe(100);
    }
  });

  it('reasoning output is a subset bucket and never added on top of output', () => {
    const rows = [
      candidate({
        sessionId: 'a',
        snapshot: standardSnapshot('a', { sourceKey: 'native-a', metrics: metricsWith({ output: 10, reasoningOutput: 4 }) })
      }),
      candidate({
        sessionId: 'b',
        snapshot: standardSnapshot('b', { sourceKey: 'native-b', metrics: metricsWith({ output: 20, reasoningOutput: 7 }) })
      })
    ];
    const group = build(rows, { groupBy: 'agent' }).groups[0]!;
    expect(group.aggregateMetrics!.output.value).toBe(30);
    expect(group.aggregateMetrics!.reasoningOutput.value).toBe(11);
  });

  it('peak context is a max observation never a sum; context window incompatible across sources is unknown', () => {
    const a = standardSnapshot('a', {
      sourceKey: 'native-a',
      metrics: metricsWith({ peakContext: 150, contextWindow: 200_000, inputUncached: 10 })
    });
    const b = standardSnapshot('b', {
      sourceKey: 'native-b',
      metrics: metricsWith({ peakContext: 300, contextWindow: 200_000, inputUncached: 20 })
    });
    const c = standardSnapshot('c', {
      sourceKey: 'native-c',
      metrics: metricsWith({ peakContext: 250, contextWindow: 1_000_000, inputUncached: 30 })
    });
    const sameWindow = build([
      candidate({ sessionId: 'a', snapshot: a }),
      candidate({ sessionId: 'b', snapshot: b })
    ], { groupBy: 'agent' }).groups[0]!;
    expect(sameWindow.aggregateMetrics!.peakContext.value).toBe(300);
    expect(sameWindow.aggregateMetrics!.contextWindow.value).toBe(200_000);
    expect(sameWindow.metricCoverage.peakContext!.includedCount).toBe(2);

    const mixedWindow = build([
      candidate({ sessionId: 'a', snapshot: standardSnapshot('a', {
        sourceKey: 'native-a', metrics: metricsWith({ contextWindow: 200_000, output: 10 }) }) }),
      candidate({ sessionId: 'c', snapshot: standardSnapshot('c', {
        sourceKey: 'native-c', metrics: metricsWith({ contextWindow: 1_000_000, output: 10 }) }) })
    ], { groupBy: 'agent' }).groups[0]!;
    expect(mixedWindow.aggregateMetrics!.contextWindow.value).toBeNull();
    expect(mixedWindow.aggregateMetrics!.contextWindow.reasonCodes).toContain('CONTEXT_WINDOW_INCOMPATIBLE');
    expect(mixedWindow.metricCoverage.contextWindow!.excludedReasons.context_window_incompatible).toBe(2);
    // 容量不可比不连累同组其它指标。
    expect(mixedWindow.aggregateMetrics!.output.value).toBe(20);
  });

  it('peak/context coverage stays independent when one source lacks the value', () => {
    const rows = [
      candidate({
        sessionId: 'with-peak',
        snapshot: standardSnapshot('with-peak', { sourceKey: 'native-a', metrics: metricsWith({ peakContext: 150 }) })
      }),
      candidate({
        sessionId: 'no-peak',
        snapshot: standardSnapshot('no-peak', { sourceKey: 'native-b', metrics: metricsWith({ peakContext: null }) })
      })
    ];
    const group = build(rows, { groupBy: 'agent' }).groups[0]!;
    expect(group.aggregateMetrics!.peakContext.value).toBe(150);
    expect(group.metricCoverage.peakContext!.includedCount).toBe(1);
    expect(group.metricCoverage.peakContext!.excludedCount).toBe(1);
  });

  it('reports partial/stale/failed coverage and preserves lastCheckedAt without statting files', () => {
    const rows = [
      candidate({
        sessionId: 'stale-partial', refreshState: 'failed', errorCode: 'ENGINE_ERROR',
        lastCheckedAt: '2026-10-03T10:20:00Z',
        snapshot: { ...standardSnapshot('stale-partial'), availability: 'partial', freshness: 'stale' }
      }),
      candidate({ sessionId: 'fresh', refreshState: 'succeeded', lastCheckedAt: '2026-10-03T10:21:00Z' })
    ];
    const response = build(rows, { groupBy: 'agent' });
    expect(response.partialSnapshots).toBe(1);
    expect(response.staleSnapshots).toBe(1);
    expect(response.failedRefreshes).toBe(1);
    const row = response.sessions.find(s => s.sessionId === 'stale-partial')!;
    expect(row.lastCheckedAt).toBe('2026-10-03T10:20:00Z');
    expect(row.freshness).toBe('stale');
    expect(row.errorCode).toBe('ENGINE_ERROR');
  });
});
