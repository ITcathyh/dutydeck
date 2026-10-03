import { z } from 'zod';
import { sha256HexSchema } from './bot-configuration.js';

// ============================================================================
// 1. 统一 Limits 常量 (第 5.3 节)
// ============================================================================

export const SESSION_INSIGHT_LIMITS = {
  maxRunningJobsPerInstance: 1,
  maxQueuedJobsPerInstance: 16,
  maxSnapshotsPerJob: 32,
  maxDiscoveredCandidates: 10000,
  maxTotalSnapshotBytes: 128 * 1024 * 1024, // 128 MiB
  maxLineBytes: 4 * 1024 * 1024,             // 4 MiB
  maxTraceEventsPerJob: 20000,
  maxPulseBucketsPerFile: 1000,
  maxExcerptLengthBytes: 4 * 1024,            // 4 KiB
  maxStdoutBytes: 32 * 1024 * 1024,          // 32 MiB
  maxStderrBytes: 64 * 1024,                 // 64 KiB
  maxHostEvidenceBytes: 512 * 1024,          // 512 KiB
  maxPersistedPayloadBytes: 40 * 1024 * 1024, // 40 MiB
  maxReportEvidenceCount: 100,
  maxReportOutputBytes: 16 * 1024 * 1024,    // 16 MiB
  jobTimeoutMs: 60 * 1000,                   // 60 s
  jobGracePeriodMs: 2 * 1000,                // 2 s
  maxRetainedSnapshotsPerSession: 2,         // current + 最近 1 份旧快照
  maxInstanceDerivedPayloadBytes: 512 * 1024 * 1024, // 512 MiB
  maxEventsPerPageDefault: 100,
  maxEventsPerPageMax: 200,
  maxSummaryRowsPerPageDefault: 50,
  maxSummaryRowsPerPageMax: 100,
  maxWarningSamplesPerCode: 100
} as const;

// ============================================================================
// 2. 统一错误码 (第 7.1 节)
// ============================================================================

export const SESSION_INSIGHT_ERROR_CODES = [
  'INSIGHT_FORBIDDEN',
  'INSIGHT_NOT_FOUND',
  'INSIGHT_QUEUE_FULL',
  'INSIGHT_SNAPSHOT_GONE',
  'INSIGHT_VERSION_MISMATCH',
  'INSIGHT_INPUT_LIMIT',
  'INSIGHT_SOURCE_CONFLICT',
  'INSIGHT_SOURCE_CHANGED',
  'INSIGHT_BUDGET_EXCEEDED',
  'INSIGHT_REPORT_LIMIT'
] as const;
export type SessionInsightErrorCode = (typeof SESSION_INSIGHT_ERROR_CODES)[number];

// ============================================================================
// 3. 基础枚举与严格标量助手
// ============================================================================

export const insightClients = ['codex', 'claude', 'traex'] as const;
export type InsightClient = (typeof insightClients)[number];

export const insightQualityLevels = [
  'exact',
  'derived',
  'estimated',
  'inferred',
  'observed',
  'heuristic',
  'unknown',
  'unavailable'
] as const;
export type Quality = (typeof insightQualityLevels)[number];

export const insightMetricStatuses = ['available', 'partial', 'conflict', 'unavailable'] as const;
export type MetricStatus = (typeof insightMetricStatuses)[number];

export const launchKinds = ['created', 'attached'] as const;
export type LaunchKind = (typeof launchKinds)[number];

export const proofKinds = ['launch_observed', 'historical_verified', 'inferred'] as const;
export type ProofKind = (typeof proofKinds)[number];

export const streamKinds = ['main', 'subagent'] as const;
export type StreamKind = (typeof streamKinds)[number];

export const sourceMatchStatuses = ['matched', 'missing', 'ambiguous', 'unsupported'] as const;
export type SourceMatchStatus = (typeof sourceMatchStatuses)[number];

export const refreshStates = [
  'idle',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
] as const;
export type RefreshState = (typeof refreshStates)[number];

export const insightAvailabilityLevels = ['none', 'partial', 'complete'] as const;
export type InsightAvailability = (typeof insightAvailabilityLevels)[number];

export const insightFreshnessLevels = ['current', 'stale', 'unknown'] as const;
export type InsightFreshness = (typeof insightFreshnessLevels)[number];

export const traceKinds = [
  'user_message',
  'agent_message',
  'tool_call',
  'tool_result',
  'tool_summary',
  'reasoning',
  'context_compacted',
  'token_sample',
  'subagent_start',
  'subagent_stop',
  'mutation_append',
  'mutation_replace',
  'mutation_rollback',
  'system'
] as const;
export type TraceKind = (typeof traceKinds)[number];

// 严格安全整数与哈希
export const zSafeIntNonNegative = z
  .number()
  .int()
  .nonnegative()
  .refine(n => Number.isSafeInteger(n), { message: 'Must be a non-negative safe integer' });

export const zSafeIntPositive = z
  .number()
  .int()
  .positive()
  .refine(n => Number.isSafeInteger(n), { message: 'Must be a positive safe integer' });

export const insightSha256HexSchema = sha256HexSchema;

const utf8ByteLength = (str: string): number => new TextEncoder().encode(str).length;

export const utf8ExcerptSchema = z
  .string()
  .refine(str => utf8ByteLength(str) <= SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes, {
    message: `Excerpt exceeds byte limit of ${SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes} UTF-8 bytes`
  });

// ============================================================================
// 4. Metric 契约 (第 4.2 节)
// ============================================================================

/**
 * 计数/Token 类指标：必须为非负 Safe Integer 或 null。null 与 0 严格不同。
 */
export const countMetricSchema = z
  .object({
    value: zSafeIntNonNegative.nullable(),
    quality: z.enum(insightQualityLevels),
    status: z.enum(insightMetricStatuses),
    evidenceCount: zSafeIntNonNegative,
    missingCount: zSafeIntNonNegative,
    reasonCodes: z.array(z.string()).default([])
  })
  .strict();
export type CountMetric = z.infer<typeof countMetricSchema>;

/**
 * 耗时/比率类指标：必须为有限非负数或 null。
 */
export const continuousMetricSchema = z
  .object({
    value: z
      .number()
      .nonnegative()
      .refine(n => Number.isFinite(n), { message: 'Must be a finite non-negative number' })
      .nullable(),
    quality: z.enum(insightQualityLevels),
    status: z.enum(insightMetricStatuses),
    evidenceCount: zSafeIntNonNegative,
    missingCount: zSafeIntNonNegative,
    reasonCodes: z.array(z.string()).default([])
  })
  .strict();
export type ContinuousMetric = z.infer<typeof continuousMetricSchema>;

export const metricSchema = z
  .object({
    value: z
      .number()
      .nullable()
      .refine(v => v === null || (Number.isFinite(v) && v >= 0), {
        message: 'Metric value must be null or finite non-negative number'
      }),
    quality: z.enum(insightQualityLevels),
    status: z.enum(insightMetricStatuses),
    evidenceCount: zSafeIntNonNegative,
    missingCount: zSafeIntNonNegative,
    reasonCodes: z.array(z.string()).default([])
  })
  .strict();
export type Metric = CountMetric | ContinuousMetric;

export function createCountMetric(params: {
  value: number | null;
  quality: Quality;
  status: MetricStatus;
  evidenceCount?: number;
  missingCount?: number;
  reasonCodes?: string[];
}): CountMetric {
  return countMetricSchema.parse({
    value: params.value,
    quality: params.quality,
    status: params.status,
    evidenceCount: params.evidenceCount ?? (params.value !== null ? 1 : 0),
    missingCount: params.missingCount ?? (params.value === null ? 1 : 0),
    reasonCodes: params.reasonCodes ?? []
  });
}

export function createContinuousMetric(params: {
  value: number | null;
  quality: Quality;
  status: MetricStatus;
  evidenceCount?: number;
  missingCount?: number;
  reasonCodes?: string[];
}): ContinuousMetric {
  return continuousMetricSchema.parse({
    value: params.value,
    quality: params.quality,
    status: params.status,
    evidenceCount: params.evidenceCount ?? (params.value !== null ? 1 : 0),
    missingCount: params.missingCount ?? (params.value === null ? 1 : 0),
    reasonCodes: params.reasonCodes ?? []
  });
}

// ============================================================================
// 5. Trace, Pulse & Coverage (第 4.1 & 4.3 节)
// ============================================================================

export const traceEventTokensSchema = z
  .object({
    inputUncached: zSafeIntNonNegative.nullable().optional(),
    cacheRead: zSafeIntNonNegative.nullable().optional(),
    cacheWrite: zSafeIntNonNegative.nullable().optional(),
    output: zSafeIntNonNegative.nullable().optional(),
    reasoning: zSafeIntNonNegative.nullable().optional(),
    total: zSafeIntNonNegative.nullable().optional()
  })
  .strict();
export type TraceEventTokens = z.infer<typeof traceEventTokensSchema>;

export const rawTokenUsageSchema = z
  .object({
    dialect: z.enum(['codex_total_last', 'claude_message_snapshot', 'traex_mutation_token', 'unknown']),
    totalTokens: zSafeIntNonNegative.nullable().optional(),
    inputTokens: zSafeIntNonNegative.nullable().optional(),
    cachedInputTokens: zSafeIntNonNegative.nullable().optional(),
    cacheCreationInputTokens: zSafeIntNonNegative.nullable().optional(),
    outputTokens: zSafeIntNonNegative.nullable().optional(),
    reasoningOutputTokens: zSafeIntNonNegative.nullable().optional(),
    observedDelta: zSafeIntNonNegative.nullable().optional(),
    baselineStatus: z.enum(['zero_confirmed', 'unknown_baseline', 'epoch_reset', 'contradictory']).optional()
  })
  .strict();
export type RawTokenUsage = z.infer<typeof rawTokenUsageSchema>;

export const traceEventSchema = z
  .object({
    eventId: z.string().min(1),
    sourceKey: z.string().min(1),
    nativeSessionId: z.string().min(1),
    nativeRunId: z.string().nullable().optional(),
    lineNumber: zSafeIntPositive,
    byteOffset: zSafeIntNonNegative,
    subeventIndex: zSafeIntNonNegative,
    nativeEventId: z.string().nullable().optional(),
    timestamp: z.string().nullable(),
    timeQuality: z.enum(insightQualityLevels),
    kind: z.enum(traceKinds),
    callId: z.string().nullable().optional(),
    parentCallId: z.string().nullable().optional(),
    toolName: z.string().nullable().optional(),
    resultStatus: z.enum(['success', 'failure', 'unknown']).nullable().optional(),
    durationMs: continuousMetricSchema.nullable().optional(), // 必须带质量与缺失语义
    tokens: traceEventTokensSchema.nullable().optional(),
    rawUsage: rawTokenUsageSchema.nullable().optional(),
    inputExcerpt: utf8ExcerptSchema.nullable().optional(),
    outputExcerpt: utf8ExcerptSchema.nullable().optional(),
    errorExcerpt: utf8ExcerptSchema.nullable().optional(),
    evidenceRefs: z.array(z.string()).default([]),
    hostEventRef: z
      .object({
        sessionId: z.string().min(1),
        eventId: z.string().min(1)
      })
      .strict()
      .nullable()
      .optional(),
    isSnapshotLocalId: z.boolean().default(false)
  })
  .strict();
export type TraceEvent = z.infer<typeof traceEventSchema>;

export const pulseBucketSchema = z
  .object({
    startAt: z.string(),
    endAt: z.string(),
    tokens: z
      .object({
        inputUncached: countMetricSchema,
        cacheRead: countMetricSchema,
        cacheWrite: countMetricSchema,
        output: countMetricSchema,
        reasoning: countMetricSchema,
        total: countMetricSchema
      })
      .strict(),
    sampleCount: zSafeIntNonNegative,
    missingCount: zSafeIntNonNegative
  })
  .strict();
export type PulseBucket = z.infer<typeof pulseBucketSchema>;

export const analysisCoverageSchema = z
  .object({
    rawLines: zSafeIntNonNegative,
    parsedLines: zSafeIntNonNegative,
    ignoredLines: zSafeIntNonNegative,
    errorLines: zSafeIntNonNegative,
    timeRange: z
      .object({
        start: z.string().nullable(),
        end: z.string().nullable()
      })
      .strict(),
    missingTimestampCount: zSafeIntNonNegative,
    disorderedTimestampCount: zSafeIntNonNegative,
    retainedTraceCount: zSafeIntNonNegative,
    omittedTraceCount: zSafeIntNonNegative,
    omittedTraceByCategory: z.record(zSafeIntNonNegative).default({}),
    tokenSamplesAvailable: zSafeIntNonNegative,
    tokenSamplesMissing: zSafeIntNonNegative,
    subagentDiscovery: z.enum(['none', 'complete', 'partial', 'unknown']),
    inheritedHistory: z.enum(['none', 'detected', 'unsupported', 'unknown'])
  })
  .strict();
export type AnalysisCoverage = z.infer<typeof analysisCoverageSchema>;

export const fileRelationshipSchema = z
  .object({
    kind: z.enum(['none', 'child', 'fork', 'unknown']),
    parentNativeSessionId: z.string().nullable(),
    parentNativeAgentId: z.string().nullable(),
    evidenceRefs: z.array(z.string()).default([])
  })
  .strict();
export type FileRelationship = z.infer<typeof fileRelationshipSchema>;

export const fileAggregationSchema = z
  .object({
    eligibility: z.enum(['eligible', 'excluded']),
    reasonCodes: z.array(z.string()).default([])
  })
  .strict();
export type FileAggregation = z.infer<typeof fileAggregationSchema>;

export const fileMetricsSchema = z
  .object({
    inputUncached: countMetricSchema,
    cacheRead: countMetricSchema,
    cacheWrite: countMetricSchema,
    output: countMetricSchema,
    reasoningOutput: countMetricSchema,
    totalTracked: countMetricSchema,
    rawInput: countMetricSchema,
    rawOutput: countMetricSchema,
    rawTotal: countMetricSchema,
    peakContext: countMetricSchema,
    contextWindow: countMetricSchema,
    elapsedDurationMs: continuousMetricSchema,
    activeDurationMs: continuousMetricSchema,
    idleDurationMs: continuousMetricSchema,
    pairedToolDurationMs: continuousMetricSchema,
    userTurns: countMetricSchema,
    assistantTurns: countMetricSchema,
    toolCalls: countMetricSchema,
    toolFailures: countMetricSchema,
    toolSuccesses: countMetricSchema,
    toolUnknowns: countMetricSchema,
    toolFailureRate: continuousMetricSchema,
    compactionCount: countMetricSchema,
    subagentCount: countMetricSchema
  })
  .strict();
export type FileMetrics = z.infer<typeof fileMetricsSchema>;

// ============================================================================
// 6. Go 进程协议与引擎 DTO (第 4.1 节)
// ============================================================================

export const engineVersionInfoSchema = z
  .object({
    schemaVersion: z.literal(1),
    engineVersion: z.string().min(1),
    parserVersion: z.string().min(1),
    metricVersion: z.string().min(1)
  })
  .strict();
export type EngineVersionInfo = z.infer<typeof engineVersionInfoSchema>;

export const mainStreamIdentitySchema = z
  .object({
    kind: z.literal('main'),
    nativeAgentId: z.null()
  })
  .strict();

export const subagentStreamIdentitySchema = z
  .object({
    kind: z.literal('subagent'),
    nativeAgentId: z.string().min(1)
  })
  .strict();

export const streamIdentitySchema = z.discriminatedUnion('kind', [
  mainStreamIdentitySchema,
  subagentStreamIdentitySchema
]);
export type StreamIdentity = z.infer<typeof streamIdentitySchema>;

export const analyzeFileInputSchema = z
  .object({
    sourceKey: z.string().min(1),
    client: z.enum(insightClients),
    path: z.string().min(1),
    sha256: sha256HexSchema,
    bytes: zSafeIntNonNegative,
    expectedNativeSessionId: z.string().min(1), // 必须非空
    expectedStream: streamIdentitySchema
  })
  .strict();
export type AnalyzeFileInput = z.infer<typeof analyzeFileInputSchema>;

export const engineLimitsSchema = z
  .object({
    maxLineBytes: z
      .number()
      .int()
      .min(1024)
      .max(SESSION_INSIGHT_LIMITS.maxLineBytes)
      .default(SESSION_INSIGHT_LIMITS.maxLineBytes),
    maxTraceEvents: z
      .number()
      .int()
      .min(1)
      .max(SESSION_INSIGHT_LIMITS.maxTraceEventsPerJob)
      .default(SESSION_INSIGHT_LIMITS.maxTraceEventsPerJob)
  })
  .strict();
export type EngineLimits = z.infer<typeof engineLimitsSchema>;

export const analyzeFilesRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    files: z.array(analyzeFileInputSchema).min(1).max(SESSION_INSIGHT_LIMITS.maxSnapshotsPerJob),
    limits: engineLimitsSchema
  })
  .strict();
export type AnalyzeFilesRequest = z.infer<typeof analyzeFilesRequestSchema>;

export const warningEntrySchema = z
  .object({
    code: z.string().min(1),
    count: zSafeIntPositive,
    samples: z
      .array(utf8ExcerptSchema)
      .max(SESSION_INSIGHT_LIMITS.maxWarningSamplesPerCode)
  })
  .strict();
export type WarningEntry = z.infer<typeof warningEntrySchema>;

export const fileAnalysisResultSchema = z
  .object({
    sourceKey: z.string().min(1),
    client: z.enum(insightClients),
    sha256: sha256HexSchema,
    nativeSessionId: z.string().min(1).nullable(),
    streamIdentity: streamIdentitySchema,
    nativeRunId: z.string().nullable().optional(),
    parentNativeSessionId: z.string().nullable().optional(),
    status: z.enum(['ok', 'partial', 'error']),
    errorCode: z.string().min(1).nullable().optional(),
    metrics: fileMetricsSchema,
    models: z.array(z.string()),
    trace: z.array(traceEventSchema).max(SESSION_INSIGHT_LIMITS.maxTraceEventsPerJob),
    pulseBuckets: z.array(pulseBucketSchema).max(SESSION_INSIGHT_LIMITS.maxPulseBucketsPerFile),
    coverage: analysisCoverageSchema,
    relationship: fileRelationshipSchema,
    aggregation: fileAggregationSchema
  })
  .strict()
  .superRefine((file, ctx) => {
    if (file.status !== 'error') {
      if (!file.nativeSessionId || file.nativeSessionId.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nativeSessionId'],
          message: 'nativeSessionId must be non-empty when status is not error'
        });
      }
    } else {
      if (!file.errorCode || file.errorCode.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['errorCode'],
          message: 'errorCode must be non-empty when status is error'
        });
      }
    }
  });
export type FileAnalysisResult = z.infer<typeof fileAnalysisResultSchema>;

export const analyzeFilesResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    engineVersion: z.string().min(1),
    parserVersion: z.string().min(1),
    metricVersion: z.string().min(1),
    files: z
      .array(fileAnalysisResultSchema)
      .min(1)
      .max(SESSION_INSIGHT_LIMITS.maxSnapshotsPerJob),
    warnings: z.array(warningEntrySchema)
  })
  .strict()
  .refine(
    result =>
      result.warnings.reduce((sum, w) => sum + w.samples.length, 0) <=
      SESSION_INSIGHT_LIMITS.maxWarningSamplesPerCode,
    {
      message: `Total warning samples across all codes cannot exceed ${SESSION_INSIGHT_LIMITS.maxWarningSamplesPerCode}`
    }
  )
  .refine(
    result =>
      result.files.reduce((sum, file) => sum + file.trace.length, 0) <=
        SESSION_INSIGHT_LIMITS.maxTraceEventsPerJob &&
      result.files.reduce((sum, file) => sum + file.pulseBuckets.length, 0) <=
        SESSION_INSIGHT_LIMITS.maxSnapshotsPerJob * SESSION_INSIGHT_LIMITS.maxPulseBucketsPerFile,
    { message: 'Shared trace/pulse budget exceeded across request files' }
  );
export type AnalyzeFilesResult = z.infer<typeof analyzeFilesResultSchema>;

// ============================================================================
// 7. 私有来源观察与解析模型 (第 3.1 & 3.3 节)
// ============================================================================

export const transcriptSourceObservationSchema = z
  .object({
    observationId: z.string().min(1),
    sessionId: z.string().min(1),
    activeRunId: z.string().min(1),
    driverInstanceId: z.string().min(1),
    client: z.enum(insightClients),
    launchKind: z.enum(launchKinds),
    proofKind: z.enum(proofKinds),
    capturedAt: z.string().datetime(),
    dataRoot: z.string().min(1),
    cwd: z.string().nullable().optional(),
    nativeContextRef: z.unknown().optional(),
    nativeSessionId: z.string().nullable().optional(),
    verifiedPath: z.string().nullable().optional(),
    identityProof: z.string().nullable().optional(),
    sourceSessionKey: z.string().nullable().optional(),
    streamIdentity: streamIdentitySchema.optional(),
    sourceKey: z.string().nullable().optional()
  })
  .strict();
export type TranscriptSourceObservation = z.infer<typeof transcriptSourceObservationSchema>;

export const resolvedSourceSchema = z
  .object({
    sourceKey: z.string().min(1),
    client: z.enum(insightClients),
    status: z.enum(sourceMatchStatuses),
    expectedNativeSessionId: z.string().min(1),
    expectedStream: streamIdentitySchema,
    proofKind: z.enum(proofKinds),
    verifiedPath: z.string().nullable().optional(),
    discoveryLimited: z.boolean().default(false),
    reason: z.string().optional()
  })
  .strict();
export type ResolvedSource = z.infer<typeof resolvedSourceSchema>;

// ============================================================================
// 8. 存储快照与宿主证据 DTO (第 5.1 节)
// ============================================================================

export const hostEvidenceSnapshotSchema = z
  .object({
    capturedAt: z.string().datetime(),
    taskGoals: z
      .array(
        z
          .object({
            taskId: z.string().min(1),
            attemptId: z.string().min(1).nullable().optional(),
            goal: utf8ExcerptSchema,
            status: z.string()
          })
          .strict()
      )
      .default([]),
    omittedGoalsCount: zSafeIntNonNegative.default(0),
    steeringRelations: z
      .array(
        z
          .object({
            steeringTaskId: z.string().min(1),
            targetTaskId: z.string().min(1),
            targetAttemptId: z.string().min(1).nullable().optional(),
            completed: z.boolean()
          })
          .strict()
      )
      .default([]),
    omittedSteeringCount: zSafeIntNonNegative.default(0),
    verificationSnapshot: z
      .array(
        z
          .object({
            taskId: z.string().min(1),
            attemptId: z.string().min(1).nullable().optional(),
            passed: z.boolean(),
            stale: z.boolean(),
            summary: z.string().optional()
          })
          .strict()
      )
      .default([]),
    omittedVerificationsCount: zSafeIntNonNegative.default(0),
    modelConfigs: z
      .array(
        z
          .object({
            taskId: z.string().min(1),
            attemptId: z.string().min(1).nullable().optional(),
            configuredModel: z.string().min(1),
            provider: z.string().optional()
          })
          .strict()
      )
      .default([]),
    omittedModelConfigsCount: zSafeIntNonNegative.default(0),
    usageLedgerProjection: z
      .object({
        recordedAtRange: z
          .object({
            start: z.string().nullable(),
            end: z.string().nullable()
          })
          .strict(),
        totalCostEstimate: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
        hasUnpricedUsage: z.boolean().default(false)
      })
      .strict()
      .optional(),
    digest: sha256HexSchema
  })
  .strict();
export type HostEvidenceSnapshot = z.infer<typeof hostEvidenceSnapshotSchema>;

export const sessionInsightSourceSummarySchema = z
  .object({
    sourceKey: z.string().min(1),
    client: z.enum(insightClients),
    streamIdentity: streamIdentitySchema,
    sha256: sha256HexSchema,
    status: z.enum(['ok', 'partial', 'error']),
    scopeRole: z.enum(['primary', 'subagent', 'excluded']),
    metrics: fileMetricsSchema,
    models: z.array(z.string()),
    coverage: analysisCoverageSchema,
    relationship: fileRelationshipSchema,
    aggregation: fileAggregationSchema,
    keyEvidenceEventIds: z
      .object({
        failures: z.array(z.string()),
        slowCalls: z.array(z.string()),
        highTokenDeltas: z.array(z.string())
      })
      .strict()
  })
  .strict();
export type SessionInsightSourceSummary = z.infer<typeof sessionInsightSourceSummarySchema>;

export const sessionInsightSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1),
    snapshotId: z.string().min(1),
    createdAt: z.string().datetime(),
    scopeVersion: z.string().min(1).default('primary_verified_v1'),
    primarySourceKey: z.string().min(1),
    models: z.array(z.string()),
    isMultiModel: z.boolean(),
    aggregateMetrics: fileMetricsSchema,
    qualityOverview: z.enum(['recorded', 'derived_or_estimated', 'unavailable']),
    sources: z.array(sessionInsightSourceSummarySchema).min(1),
    keyEvidenceEventIds: z
      .object({
        failures: z.array(z.string()),
        slowCalls: z.array(z.string()),
        highTokenDeltas: z.array(z.string())
      })
      .strict(),
    pulseBuckets: z.array(pulseBucketSchema).default([])
  })
  .strict();
export type SessionInsightSummary = z.infer<typeof sessionInsightSummarySchema>;

export const sessionInsightManifestSourceEntrySchema = z
  .object({
    sourceKey: z.string().min(1),
    client: z.enum(insightClients),
    matchStatus: z.enum(sourceMatchStatuses),
    expectedStream: streamIdentitySchema,
    sha256: sha256HexSchema.nullable(),
    capturedAt: z.string().datetime().nullable(),
    readBytes: zSafeIntNonNegative.nullable(),
    analyzedBytes: zSafeIntNonNegative.nullable(),
    trailingBytes: zSafeIntNonNegative.nullable(),
    fingerprint: z.string().nullable(),
    relationship: fileRelationshipSchema,
    aggregation: fileAggregationSchema,
    status: z.enum(['ok', 'partial', 'error', 'missing'])
  })
  .strict();
export type SessionInsightManifestSourceEntry = z.infer<
  typeof sessionInsightManifestSourceEntrySchema
>;

export const sessionInsightManifestSchema = z
  .object({
    snapshotId: z.string().min(1),
    sessionId: z.string().min(1),
    createdAt: z.string().datetime(),
    bindingRevision: zSafeIntNonNegative,
    scopeVersion: z.string().min(1).default('primary_verified_v1'),
    hostEvidenceDigest: sha256HexSchema,
    sources: z.array(sessionInsightManifestSourceEntrySchema),
    versions: z
      .object({
        schemaVersion: zSafeIntPositive,
        engineVersion: z.string().min(1),
        parserVersion: z.string().min(1),
        metricVersion: z.string().min(1),
        redactionVersion: z.string().min(1)
      })
      .strict()
  })
  .strict();
export type SessionInsightManifest = z.infer<typeof sessionInsightManifestSchema>;

export const sessionInsightEventItemSchema = traceEventSchema
  .extend({
    snapshotId: z.string().min(1),
    ordinal: zSafeIntNonNegative
  })
  .strict();
export type SessionInsightEventItem = z.infer<typeof sessionInsightEventItemSchema>;

export const sessionInsightSnapshotRecordSchema = z
  .object({
    snapshotId: z.string().min(1),
    sessionId: z.string().min(1),
    cacheKey: sha256HexSchema,
    versions: z
      .object({
        schemaVersion: zSafeIntPositive,
        engineVersion: z.string().min(1),
        parserVersion: z.string().min(1),
        metricVersion: z.string().min(1),
        redactionVersion: z.string().min(1)
      })
      .strict(),
    summary: sessionInsightSummarySchema,
    manifest: sessionInsightManifestSchema,
    hostEvidence: hostEvidenceSnapshotSchema,
    payloadBytes: zSafeIntNonNegative,
    createdAt: z.string().datetime()
  })
  .strict();
export type SessionInsightSnapshotRecord = z.infer<typeof sessionInsightSnapshotRecordSchema>;

export const sessionInsightRefreshRecordSchema = z
  .object({
    sessionId: z.string().min(1),
    requestId: z.string().nullable(),
    state: z.enum(refreshStates),
    bindingRevision: zSafeIntNonNegative,
    currentSnapshotId: z.string().nullable(),
    processRunId: z.string().nullable(),
    timestamps: z
      .object({
        queuedAt: z.string().nullable(),
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable()
      })
      .strict(),
    errorCode: z.string().nullable()
  })
  .strict();
export type SessionInsightRefreshRecord = z.infer<typeof sessionInsightRefreshRecordSchema>;

export const sessionInsightStatusSchema = z
  .object({
    sessionId: z.string().min(1),
    refreshState: z.enum(refreshStates),
    availability: z.enum(insightAvailabilityLevels),
    freshness: z.enum(insightFreshnessLevels),
    currentSnapshotId: z.string().nullable(),
    requestId: z.string().nullable().optional(),
    errorCode: z.string().nullable().optional(),
    lastCheckedAt: z.string().nullable().optional()
  })
  .strict();
export type SessionInsightStatus = z.infer<typeof sessionInsightStatusSchema>;

// ============================================================================
// 9. 公开 API Query & Response DTO (第 7.1 节)
// ============================================================================

export const sessionInsightDetailsResponseSchema = z
  .object({
    status: sessionInsightStatusSchema,
    summary: sessionInsightSummarySchema.nullable(),
    manifest: sessionInsightManifestSchema.nullable(),
    hostEvidence: hostEvidenceSnapshotSchema.nullable(),
    hostExecutionFallback: z
      .object({
        hasExecutionRecords: z.boolean(),
        unsupportedReason: z.string().optional()
      })
      .strict()
      .optional()
  })
  .strict();
export type SessionInsightDetailsResponse = z.infer<typeof sessionInsightDetailsResponseSchema>;

export const sessionInsightRefreshRequestSchema = z.object({}).strict();
export type SessionInsightRefreshRequest = z.infer<typeof sessionInsightRefreshRequestSchema>;

export const sessionInsightRefreshResponseSchema = z
  .object({
    requestId: z.string().uuid(),
    state: z.enum(refreshStates),
    cacheHit: z.boolean().default(false),
    snapshotId: z.string().nullable().optional()
  })
  .strict();
export type SessionInsightRefreshResponse = z.infer<typeof sessionInsightRefreshResponseSchema>;

export const sessionInsightCancelResponseSchema = z
  .object({
    success: z.boolean(),
    state: z.enum(refreshStates)
  })
  .strict();
export type SessionInsightCancelResponse = z.infer<typeof sessionInsightCancelResponseSchema>;

export const sessionInsightEventsQuerySchema = z
  .object({
    snapshotId: z.string().min(1),
    cursor: z.string().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SESSION_INSIGHT_LIMITS.maxEventsPerPageMax)
      .default(SESSION_INSIGHT_LIMITS.maxEventsPerPageDefault),
    kind: z.enum(traceKinds).optional(),
    tool: z.string().optional(),
    result: z.enum(['success', 'failure', 'unknown']).optional()
  })
  .strict();
export type SessionInsightEventsQuery = z.infer<typeof sessionInsightEventsQuerySchema>;

export const sessionInsightEventsResponseSchema = z
  .object({
    snapshotId: z.string().min(1),
    items: z.array(sessionInsightEventItemSchema),
    nextCursor: z.string().nullable(),
    totalMatching: zSafeIntNonNegative
  })
  .strict();
export type SessionInsightEventsResponse = z.infer<typeof sessionInsightEventsResponseSchema>;

export const sessionInsightSummaryQuerySchema = z
  .object({
    workspace: z.string().optional(),
    agentId: z.string().optional(),
    usage: z.enum(['explicit', 'proactive', 'scheduled', 'background', 'mixed', 'unknown']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    includeArchived: z
      .union([z.boolean(), z.enum(['true', 'false']).transform(v => v === 'true')])
      .default(false),
    groupBy: z.enum(['workspace', 'agent', 'model', 'usage']).default('workspace'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageMax)
      .default(SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageDefault),
    cursor: z.string().optional()
  })
  .strict()
  .refine(
    data => !data.from || !data.to || new Date(data.from).getTime() < new Date(data.to).getTime(),
    { message: 'from must be earlier than to' }
  );
export type SessionInsightSummaryQuery = z.infer<typeof sessionInsightSummaryQuerySchema>;

export const metricCoverageEntrySchema = z
  .object({
    includedCount: zSafeIntNonNegative,
    excludedCount: zSafeIntNonNegative,
    excludedReasons: z.record(zSafeIntNonNegative)
  })
  .strict();
export type MetricCoverageEntry = z.infer<typeof metricCoverageEntrySchema>;
export type MetricCoverage = Record<string, MetricCoverageEntry>;

export const summaryGroupRowSchema = z
  .object({
    groupKey: z.string(),
    candidateSessions: zSafeIntNonNegative,
    withSnapshot: zSafeIntNonNegative,
    withoutSnapshot: zSafeIntNonNegative,
    partialSnapshots: zSafeIntNonNegative,
    failedRefreshes: zSafeIntNonNegative,
    staleSnapshots: zSafeIntNonNegative,
    freshnessUnknown: zSafeIntNonNegative,
    includedCount: zSafeIntNonNegative,
    excludedCount: zSafeIntNonNegative,
    excludedReasons: z.record(zSafeIntNonNegative),
    metricCoverage: z.record(metricCoverageEntrySchema).default({}),
    aggregateMetrics: fileMetricsSchema.nullable()
  })
  .strict();
export type SummaryGroupRow = z.infer<typeof summaryGroupRowSchema>;

export const summarySessionRowSchema = z
  .object({
    sessionId: z.string().min(1),
    workspace: z.string(),
    agentId: z.string(),
    usage: z.string(),
    createdAt: z.string().datetime(),
    refreshState: z.enum(refreshStates),
    errorCode: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
    hasSnapshot: z.boolean(),
    snapshotId: z.string().nullable(),
    availability: z.enum(insightAvailabilityLevels),
    freshness: z.enum(insightFreshnessLevels),
    models: z.array(z.string()),
    metrics: fileMetricsSchema.nullable(),
    metricAttributions: z.record(
      z.object({ included: z.boolean(), reason: z.string().optional() }).strict()
    ).default({}),
    isSharedSource: z.boolean().default(false),
    attributionNote: z.string().optional()
  })
  .strict();
export type SummarySessionRow = z.infer<typeof summarySessionRowSchema>;

export const sessionInsightSummaryResponseSchema = z
  .object({
    candidateSessions: zSafeIntNonNegative,
    withSnapshot: zSafeIntNonNegative,
    withoutSnapshot: zSafeIntNonNegative,
    partialSnapshots: zSafeIntNonNegative,
    failedRefreshes: zSafeIntNonNegative,
    staleSnapshots: zSafeIntNonNegative,
    freshnessUnknown: zSafeIntNonNegative,
    groups: z.array(summaryGroupRowSchema),
    sessions: z.array(summarySessionRowSchema),
    nextCursor: z.string().nullable()
  })
  .strict();
export type SessionInsightSummaryResponse = z.infer<typeof sessionInsightSummaryResponseSchema>;

export const compareSessionRefSchema = z
  .object({
    sessionId: z.string().min(1),
    snapshotId: z.string().min(1)
  })
  .strict();
export type CompareSessionRef = z.infer<typeof compareSessionRefSchema>;

export const sessionInsightCompareRequestSchema = z
  .object({
    left: compareSessionRefSchema,
    right: compareSessionRefSchema
  })
  .strict();
export type SessionInsightCompareRequest = z.infer<typeof sessionInsightCompareRequestSchema>;

export const metricComparisonSchema = z
  .object({
    leftValue: z.number().nullable(),
    rightValue: z.number().nullable(),
    delta: z.number().nullable(),
    percentChange: z.number().nullable(),
    isBaselineZero: z.boolean().default(false),
    comparable: z.boolean(),
    reasonCodes: z.array(z.string()).default([])
  })
  .strict();
export type MetricComparison = z.infer<typeof metricComparisonSchema>;

export const sessionInsightCompareResponseSchema = z
  .object({
    left: sessionInsightSummarySchema,
    right: sessionInsightSummarySchema,
    leftManifest: sessionInsightManifestSchema,
    rightManifest: sessionInsightManifestSchema,
    leftHostEvidence: hostEvidenceSnapshotSchema,
    rightHostEvidence: hostEvidenceSnapshotSchema,
    comparable: z.boolean(),
    incomparableReasons: z.array(z.string()).default([]),
    metricDiffs: z.record(metricComparisonSchema)
  })
  .strict();
export type SessionInsightCompareResponse = z.infer<typeof sessionInsightCompareResponseSchema>;

export const sessionInsightExportRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('session'),
      sessionId: z.string().min(1),
      snapshotId: z.string().min(1),
      format: z.enum(['markdown', 'html'])
    })
    .strict(),
  z
    .object({
      kind: z.literal('comparison'),
      left: compareSessionRefSchema,
      right: compareSessionRefSchema,
      format: z.enum(['markdown', 'html'])
    })
    .strict()
]);
export type SessionInsightExportRequest = z.infer<typeof sessionInsightExportRequestSchema>;

// ============================================================================
// 10. 纯计算比较函数 (第 6.3 节)
// ============================================================================

/**
 * 计算两个 Metric 的比较差值与百分比变动（严格遵守第 6.3 节规则）
 */
export function calculateMetricComparison(
  left: Metric | null | undefined,
  right: Metric | null | undefined
): MetricComparison {
  if (!left || !right) {
    return {
      leftValue: left?.value ?? null,
      rightValue: right?.value ?? null,
      delta: null,
      percentChange: null,
      isBaselineZero: false,
      comparable: false,
      reasonCodes: ['MISSING_METRIC_SIDE']
    };
  }

  if (left.status !== 'available' || right.status !== 'available') {
    const reasons: string[] = [];
    if (left.status !== 'available') reasons.push(`LEFT_${left.status.toUpperCase()}`);
    if (right.status !== 'available') reasons.push(`RIGHT_${right.status.toUpperCase()}`);
    return {
      leftValue: left.value,
      rightValue: right.value,
      delta: null,
      percentChange: null,
      isBaselineZero: false,
      comparable: false,
      reasonCodes: reasons
    };
  }

  if (left.value === null || right.value === null) {
    return {
      leftValue: left.value,
      rightValue: right.value,
      delta: null,
      percentChange: null,
      isBaselineZero: false,
      comparable: false,
      reasonCodes: ['NULL_METRIC_VALUE']
    };
  }

  const delta = Number((right.value - left.value).toFixed(6));

  if (left.value === 0) {
    return {
      leftValue: 0,
      rightValue: right.value,
      delta,
      percentChange: null,
      isBaselineZero: true,
      comparable: true,
      reasonCodes: ['BASELINE_ZERO']
    };
  }

  const percentChange = Number((((right.value - left.value) / left.value) * 100).toFixed(2));
  return {
    leftValue: left.value,
    rightValue: right.value,
    delta,
    percentChange,
    isBaselineZero: false,
    comparable: true,
    reasonCodes: []
  };
}
