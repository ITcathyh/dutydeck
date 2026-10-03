import {
  createContinuousMetric,
  createCountMetric,
  sessionInsightEventItemSchema,
  sessionInsightSnapshotRecordSchema,
  type AnalysisCoverage,
  type FileAggregation,
  type FileMetrics,
  type FileRelationship,
  type HostEvidenceSnapshot,
  type SessionInsightEventItem,
  type SessionInsightManifest,
  type SessionInsightSnapshotRecord,
  type SessionInsightSummary,
  type SessionInsightSourceSummary,
  type StreamIdentity
} from '@dutydeck/shared';

/**
 * T4b 测试专用 fixture builder：所有快照都经冻结的共享 Zod schema 构造，
 * 保证测试只面对真实契约形状，不手造绕过类型的 DTO（报告超限用例除外，
 * 那里刻意绕过运行时长度限制，会在调用处显式 as unknown）。
 */

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq.toString().padStart(3, '0')}`;
}

export function testSha(value: string): string {
  // 确定性的合法 64 位小写十六进制；测试值无需真实哈希，但要满足冻结 sha256 schema。
  let acc = 0;
  for (let i = 0; i < value.length; i += 1) acc = (acc * 31 + value.charCodeAt(i)) >>> 0;
  const hex = acc.toString(16).padStart(8, '0');
  return hex.repeat(8).slice(0, 64);
}

export function makeCoverage(overrides: Partial<AnalysisCoverage> = {}): AnalysisCoverage {
  return {
    rawLines: 120,
    parsedLines: 110,
    ignoredLines: 4,
    errorLines: 6,
    timeRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-01T01:00:00.000Z' },
    missingTimestampCount: 0,
    disorderedTimestampCount: 0,
    retainedTraceCount: 50,
    omittedTraceCount: 0,
    omittedTraceByCategory: {},
    tokenSamplesAvailable: 30,
    tokenSamplesMissing: 2,
    subagentDiscovery: 'complete',
    inheritedHistory: 'none',
    ...overrides
  };
}

export const noRelationship: FileRelationship = {
  kind: 'none',
  parentNativeSessionId: null,
  parentNativeAgentId: null,
  evidenceRefs: []
};

export const eligibleAggregation: FileAggregation = {
  eligibility: 'eligible',
  reasonCodes: []
};

export function makeMetrics(overrides: Partial<FileMetrics> = {}): FileMetrics {
  const count = (value: number | null, status: 'available' | 'partial' | 'conflict' | 'unavailable' = 'available') =>
    createCountMetric({ value, quality: 'exact', status });
  const continuous = (
    value: number | null,
    status: 'available' | 'partial' | 'conflict' | 'unavailable' = 'available'
  ) => createContinuousMetric({ value, quality: 'exact', status });
  return {
    inputUncached: count(1000),
    cacheRead: count(2000),
    cacheWrite: count(300),
    output: count(500),
    reasoningOutput: count(100),
    totalTracked: count(3800),
    rawInput: count(3300),
    rawOutput: count(500),
    rawTotal: count(3800),
    peakContext: count(9000),
    contextWindow: count(200000),
    elapsedDurationMs: continuous(3_600_000),
    activeDurationMs: continuous(1_800_000),
    idleDurationMs: continuous(1_800_000),
    pairedToolDurationMs: continuous(900_000),
    userTurns: count(10),
    assistantTurns: count(12),
    toolCalls: count(40),
    toolFailures: count(2),
    toolSuccesses: count(36),
    toolUnknowns: count(2),
    toolFailureRate: continuous(0.0526),
    compactionCount: count(0),
    subagentCount: count(0),
    ...overrides
  };
}

export function makeSourceSummary(
  overrides: Partial<SessionInsightSourceSummary> = {}
): SessionInsightSourceSummary {
  const sourceKey = overrides.sourceKey ?? 'source-main-001';
  return {
    sourceKey,
    client: 'claude',
    streamIdentity: { kind: 'main', nativeAgentId: null },
    sha256: DIGEST_A,
    status: 'ok',
    scopeRole: 'primary',
    metrics: makeMetrics(),
    models: ['model-a'],
    coverage: makeCoverage(),
    relationship: noRelationship,
    aggregation: eligibleAggregation,
    keyEvidenceEventIds: { failures: [], slowCalls: [], highTokenDeltas: [] },
    ...overrides
  };
}

export interface SnapshotOverrides {
  snapshotId?: string;
  sessionId?: string;
  createdAt?: string;
  scopeVersion?: string;
  metricVersion?: string;
  engineVersion?: string;
  parserVersion?: string;
  redactionVersion?: string;
  schemaVersion?: number;
  models?: string[];
  isMultiModel?: boolean;
  metrics?: FileMetrics;
  sources?: SessionInsightSourceSummary[];
  keyEvidence?: SessionInsightSummary['keyEvidenceEventIds'];
  hostEvidence?: HostEvidenceSnapshot;
  digest?: string;
  primarySourceKey?: string;
}

export function buildSnapshot(overrides: SnapshotOverrides = {}): SessionInsightSnapshotRecord {
  const snapshotId = overrides.snapshotId ?? nextId('snap');
  const sessionId = overrides.sessionId ?? 'session-001';
  const createdAt = overrides.createdAt ?? '2026-09-02T08:30:00.000Z';
  const scopeVersion = overrides.scopeVersion ?? 'primary_verified_v1';
  const metricVersion = overrides.metricVersion ?? 'metric-v1';
  const digest = overrides.digest ?? DIGEST_A;
  const sources = overrides.sources ?? [makeSourceSummary()];
  const primarySourceKey = overrides.primarySourceKey ?? sources[0]!.sourceKey;
  const models = overrides.models ?? ['model-a'];

  const summary: SessionInsightSummary = {
    schemaVersion: 1,
    sessionId,
    snapshotId,
    createdAt,
    scopeVersion,
    primarySourceKey,
    models,
    isMultiModel: overrides.isMultiModel ?? models.length > 1,
    aggregateMetrics: overrides.metrics ?? makeMetrics(),
    qualityOverview: 'recorded',
    sources,
    keyEvidenceEventIds:
      overrides.keyEvidence ?? { failures: [], slowCalls: [], highTokenDeltas: [] },
    pulseBuckets: []
  };

  const manifest: SessionInsightManifest = {
    snapshotId,
    sessionId,
    createdAt,
    bindingRevision: 3,
    scopeVersion,
    hostEvidenceDigest: digest,
    sources: sources.map(source => ({
      sourceKey: source.sourceKey,
      client: source.client,
      matchStatus: 'matched',
      expectedStream: source.streamIdentity as StreamIdentity,
      sha256: source.sha256,
      capturedAt: createdAt,
      readBytes: 1024,
      analyzedBytes: 1000,
      trailingBytes: 24,
      fingerprint: null,
      relationship: source.relationship,
      aggregation: source.aggregation,
      status: source.status
    })),
    versions: {
      schemaVersion: overrides.schemaVersion ?? 1,
      engineVersion: overrides.engineVersion ?? 'engine-v1',
      parserVersion: overrides.parserVersion ?? 'parser-v1',
      metricVersion,
      redactionVersion: overrides.redactionVersion ?? 'redaction-v1'
    }
  };

  const hostEvidence: HostEvidenceSnapshot =
    overrides.hostEvidence ??
    ({
      capturedAt: createdAt,
      taskGoals: [],
      omittedGoalsCount: 0,
      steeringRelations: [],
      omittedSteeringCount: 0,
      verificationSnapshot: [],
      omittedVerificationsCount: 0,
      modelConfigs: [],
      omittedModelConfigsCount: 0,
      digest
    } satisfies HostEvidenceSnapshot);

  // 所有 fixture 都过冻结的共享 Zod schema，契约任何变动都会在测试期暴露。
  return sessionInsightSnapshotRecordSchema.parse({
    snapshotId,
    sessionId,
    cacheKey: testSha(`cache-${snapshotId}`),
    versions: manifest.versions,
    summary,
    manifest,
    hostEvidence,
    payloadBytes: 4096,
    createdAt
  });
}

let eventSeq = 0;

export interface EventOverrides {
  eventId?: string;
  snapshotId?: string;
  ordinal?: number;
  kind?: SessionInsightEventItem['kind'];
  toolName?: string | null;
  resultStatus?: 'success' | 'failure' | 'unknown' | null;
  timestamp?: string | null;
  durationMs?: FileMetrics['elapsedDurationMs'] | null;
  tokens?: SessionInsightEventItem['tokens'];
  inputExcerpt?: string | null;
  outputExcerpt?: string | null;
  errorExcerpt?: string | null;
  sourceKey?: string;
}

export function makeEvent(overrides: EventOverrides = {}): SessionInsightEventItem {
  eventSeq += 1;
  return sessionInsightEventItemSchema.parse({
    eventId: overrides.eventId ?? `evt-${eventSeq.toString().padStart(4, '0')}`,
    sourceKey: overrides.sourceKey ?? 'source-main-001',
    nativeSessionId: 'native-session-001',
    lineNumber: eventSeq,
    byteOffset: eventSeq * 100,
    subeventIndex: 0,
    timestamp: overrides.timestamp ?? '2026-09-01T00:10:00.000Z',
    timeQuality: 'exact',
    kind: overrides.kind ?? 'tool_call',
    toolName: overrides.toolName === undefined ? 'Bash' : overrides.toolName,
    resultStatus: overrides.resultStatus === undefined ? 'success' : overrides.resultStatus,
    durationMs:
      overrides.durationMs === undefined
        ? createContinuousMetric({ value: 1200, quality: 'exact', status: 'available' })
        : overrides.durationMs,
    tokens:
      overrides.tokens === undefined
        ? { total: 100, inputUncached: 80, output: 20 }
        : overrides.tokens,
    inputExcerpt: overrides.inputExcerpt === undefined ? null : overrides.inputExcerpt,
    outputExcerpt: overrides.outputExcerpt === undefined ? null : overrides.outputExcerpt,
    errorExcerpt: overrides.errorExcerpt === undefined ? null : overrides.errorExcerpt,
    evidenceRefs: [],
    snapshotId: overrides.snapshotId ?? 'SHOULD-BE-FILLED-BY-CALLER',
    ordinal: overrides.ordinal ?? eventSeq,
    isSnapshotLocalId: false
  });
}
