import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  SESSION_INSIGHT_LIMITS,
  SESSION_INSIGHT_ERROR_CODES,
  insightClients,
  insightQualityLevels,
  insightMetricStatuses,
  launchKinds,
  proofKinds,
  streamKinds,
  sourceMatchStatuses,
  refreshStates,
  insightAvailabilityLevels,
  insightFreshnessLevels,
  traceKinds,
  countMetricSchema,
  continuousMetricSchema,
  createCountMetric,
  createContinuousMetric,
  streamIdentitySchema,
  traceEventSchema,
  pulseBucketSchema,
  analysisCoverageSchema,
  fileMetricsSchema,
  fileRelationshipSchema,
  fileAggregationSchema,
  fileAnalysisResultSchema,
  analyzeFileInputSchema,
  analyzeFilesRequestSchema,
  analyzeFilesResultSchema,
  engineVersionInfoSchema,
  transcriptSourceObservationSchema,
  resolvedSourceSchema,
  hostEvidenceSnapshotSchema,
  sessionInsightSummarySchema,
  sessionInsightManifestSchema,
  sessionInsightEventItemSchema,
  sessionInsightSnapshotRecordSchema,
  sessionInsightRefreshRecordSchema,
  sessionInsightStatusSchema,
  sessionInsightDetailsResponseSchema,
  sessionInsightRefreshRequestSchema,
  sessionInsightRefreshResponseSchema,
  sessionInsightCancelResponseSchema,
  sessionInsightEventsQuerySchema,
  sessionInsightEventsResponseSchema,
  sessionInsightSummaryQuerySchema,
  summaryGroupRowSchema,
  metricCoverageEntrySchema,
  sessionInsightSummaryResponseSchema,
  sessionInsightCompareRequestSchema,
  sessionInsightCompareResponseSchema,
  sessionInsightExportRequestSchema,
  calculateMetricComparison
} from './session-insight.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');

describe('Session Insight V1 Specification and Contracts (T0)', () => {
  describe('Constants, Limits and Error Codes', () => {
    it('freezes unified runtime limits conforming to section 5.3', () => {
      expect(SESSION_INSIGHT_LIMITS.maxRunningJobsPerInstance).toBe(1);
      expect(SESSION_INSIGHT_LIMITS.maxQueuedJobsPerInstance).toBe(16);
      expect(SESSION_INSIGHT_LIMITS.maxSnapshotsPerJob).toBe(32);
      expect(SESSION_INSIGHT_LIMITS.maxDiscoveredCandidates).toBe(10000);
      expect(SESSION_INSIGHT_LIMITS.maxTotalSnapshotBytes).toBe(128 * 1024 * 1024);
      expect(SESSION_INSIGHT_LIMITS.maxLineBytes).toBe(4 * 1024 * 1024);
      expect(SESSION_INSIGHT_LIMITS.maxTraceEventsPerJob).toBe(20000);
      expect(SESSION_INSIGHT_LIMITS.maxPulseBucketsPerFile).toBe(1000);
      expect(SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes).toBe(4 * 1024);
      expect(SESSION_INSIGHT_LIMITS.maxStdoutBytes).toBe(32 * 1024 * 1024);
      expect(SESSION_INSIGHT_LIMITS.maxStderrBytes).toBe(64 * 1024);
      expect(SESSION_INSIGHT_LIMITS.maxHostEvidenceBytes).toBe(512 * 1024);
      expect(SESSION_INSIGHT_LIMITS.maxPersistedPayloadBytes).toBe(40 * 1024 * 1024);
      expect(SESSION_INSIGHT_LIMITS.maxReportEvidenceCount).toBe(100);
      expect(SESSION_INSIGHT_LIMITS.maxReportOutputBytes).toBe(16 * 1024 * 1024);
      expect(SESSION_INSIGHT_LIMITS.jobTimeoutMs).toBe(60 * 1000);
      expect(SESSION_INSIGHT_LIMITS.jobGracePeriodMs).toBe(2 * 1000);
      expect(SESSION_INSIGHT_LIMITS.maxRetainedSnapshotsPerSession).toBe(2);
      expect(SESSION_INSIGHT_LIMITS.maxInstanceDerivedPayloadBytes).toBe(512 * 1024 * 1024);
      expect(SESSION_INSIGHT_LIMITS.maxEventsPerPageDefault).toBe(100);
      expect(SESSION_INSIGHT_LIMITS.maxEventsPerPageMax).toBe(200);
      expect(SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageDefault).toBe(50);
      expect(SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageMax).toBe(100);
      expect(SESSION_INSIGHT_LIMITS.maxWarningSamplesPerCode).toBe(100);
    });

    it('defines all required session insight error codes conforming to section 7.1', () => {
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_FORBIDDEN');
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_NOT_FOUND');
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_QUEUE_FULL');
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_SNAPSHOT_GONE');
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_VERSION_MISMATCH');
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_INPUT_LIMIT');
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_SOURCE_CONFLICT');
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_SOURCE_CHANGED');
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_BUDGET_EXCEEDED');
      expect(SESSION_INSIGHT_ERROR_CODES).toContain('INSIGHT_REPORT_LIMIT');
    });

    it('contains all standard enumerated sets', () => {
      expect(insightClients).toEqual(['codex', 'claude', 'traex']);
      expect(insightQualityLevels).toContain('exact');
      expect(insightQualityLevels).toContain('heuristic');
      expect(insightQualityLevels).toContain('unavailable');
      expect(insightMetricStatuses).toEqual(['available', 'partial', 'conflict', 'unavailable']);
      expect(refreshStates).toContain('queued');
      expect(refreshStates).toContain('interrupted');
      expect(insightAvailabilityLevels).toEqual(['none', 'partial', 'complete']);
      expect(insightFreshnessLevels).toEqual(['current', 'stale', 'unknown']);
      expect(traceKinds).toContain('user_message');
      expect(traceKinds).toContain('agent_message');
      expect(traceKinds).toContain('tool_call');
      expect(traceKinds).toContain('context_compacted');
      expect(traceKinds).toContain('subagent_start');
    });
  });

  describe('Metric Schema & Strict Null/Zero Semantics (Section 4.2)', () => {
    it('distinguishes strictly between null and 0 values in CountMetric', () => {
      const zeroMetric = createCountMetric({
        value: 0,
        quality: 'exact',
        status: 'available',
        evidenceCount: 1,
        missingCount: 0
      });
      expect(zeroMetric.value).toBe(0);
      expect(zeroMetric.status).toBe('available');

      const nullMetric = createCountMetric({
        value: null,
        quality: 'unavailable',
        status: 'unavailable',
        evidenceCount: 0,
        missingCount: 1,
        reasonCodes: ['UNAVAILABLE']
      });
      expect(nullMetric.value).toBeNull();
      expect(nullMetric.status).toBe('unavailable');

      expect(zeroMetric.value).not.toBe(nullMetric.value);
    });

    it('enforces safe integer constraints on count metrics', () => {
      // Rejects float for countMetricSchema
      expect(() =>
        countMetricSchema.parse({
          value: 12.34,
          quality: 'exact',
          status: 'available',
          evidenceCount: 1,
          missingCount: 0,
          reasonCodes: []
        })
      ).toThrow();

      // Rejects negative value
      expect(() =>
        countMetricSchema.parse({
          value: -10,
          quality: 'exact',
          status: 'available',
          evidenceCount: 1,
          missingCount: 0,
          reasonCodes: []
        })
      ).toThrow();

      // Rejects value > MAX_SAFE_INTEGER
      expect(() =>
        countMetricSchema.parse({
          value: Number.MAX_SAFE_INTEGER + 100,
          quality: 'exact',
          status: 'available',
          evidenceCount: 1,
          missingCount: 0,
          reasonCodes: []
        })
      ).toThrow();
    });

    it('permits finite non-negative floats in continuousMetricSchema for duration/rate', () => {
      const durationMetric = createContinuousMetric({
        value: 123.456,
        quality: 'observed',
        status: 'available',
        evidenceCount: 1,
        missingCount: 0
      });
      expect(durationMetric.value).toBe(123.456);

      // Rejects infinite value
      expect(() =>
        continuousMetricSchema.parse({
          value: Infinity,
          quality: 'exact',
          status: 'available',
          evidenceCount: 1,
          missingCount: 0,
          reasonCodes: []
        })
      ).toThrow();
    });

    it('rejects unexpected additional fields due to strict schema', () => {
      expect(() =>
        countMetricSchema.parse({
          value: 100,
          quality: 'exact',
          status: 'available',
          evidenceCount: 1,
          missingCount: 0,
          reasonCodes: [],
          unexpectedExtraField: 'leak'
        })
      ).toThrow();
    });
  });

  describe('StreamIdentity and Expected Native Session Constraints (Gate 5)', () => {
    it('enforces streamIdentity: main must have null nativeAgentId, subagent must have non-empty string', () => {
      expect(
        streamIdentitySchema.parse({
          kind: 'main',
          nativeAgentId: null
        })
      ).toEqual({ kind: 'main', nativeAgentId: null });

      expect(() =>
        streamIdentitySchema.parse({
          kind: 'main',
          nativeAgentId: 'not-null'
        })
      ).toThrow();

      expect(
        streamIdentitySchema.parse({
          kind: 'subagent',
          nativeAgentId: 'worker-1'
        })
      ).toEqual({ kind: 'subagent', nativeAgentId: 'worker-1' });

      expect(() =>
        streamIdentitySchema.parse({
          kind: 'subagent',
          nativeAgentId: null
        })
      ).toThrow();

      expect(() =>
        streamIdentitySchema.parse({
          kind: 'subagent',
          nativeAgentId: ''
        })
      ).toThrow();
    });

    it('enforces expectedNativeSessionId is strictly non-empty string and sha256 is 64 hex in analyzeFileInput', () => {
      const validInput = {
        sourceKey: 'src_1',
        client: 'claude' as const,
        path: '/tmp/snapshot.jsonl',
        sha256: '4eca389acf9738934ae7fdc35a2ef4dfc34dcad94e90530fad96b2ad906006e3',
        bytes: 603,
        expectedNativeSessionId: 'session-uuid-1',
        expectedStream: { kind: 'main' as const, nativeAgentId: null }
      };
      expect(analyzeFileInputSchema.parse(validInput)).toEqual(validInput);

      // Rejects empty expectedNativeSessionId
      expect(() =>
        analyzeFileInputSchema.parse({ ...validInput, expectedNativeSessionId: '' })
      ).toThrow();

      // Rejects invalid sha256
      expect(() =>
        analyzeFileInputSchema.parse({ ...validInput, sha256: 'not-a-sha256' })
      ).toThrow();
    });

    it('enforces nativeSessionId non-empty when status is ok/partial, permits null only on error with non-empty errorCode', () => {
      const resultPath = resolve(repoRoot, 'tests/fixtures/session-insight/golden/analyze-result.golden.json');
      const golden = JSON.parse(readFileSync(resultPath, 'utf-8'));
      const sampleFile = golden.files[0];

      // ok status with valid nativeSessionId succeeds
      expect(fileAnalysisResultSchema.parse(sampleFile).nativeSessionId).toBe('claude-shared-session');

      // ok status with null nativeSessionId must throw
      expect(() =>
        fileAnalysisResultSchema.parse({
          ...sampleFile,
          nativeSessionId: null
        })
      ).toThrow(/nativeSessionId must be non-empty/);

      // partial status with null nativeSessionId must throw
      expect(() =>
        fileAnalysisResultSchema.parse({
          ...sampleFile,
          status: 'partial',
          nativeSessionId: null
        })
      ).toThrow(/nativeSessionId must be non-empty/);

      // error status with null nativeSessionId and valid errorCode succeeds
      const errorFile = fileAnalysisResultSchema.parse({
        ...sampleFile,
        status: 'error',
        nativeSessionId: null,
        errorCode: 'SOURCE_MALFORMED'
      });
      expect(errorFile.nativeSessionId).toBeNull();
      expect(errorFile.errorCode).toBe('SOURCE_MALFORMED');

      // error status without errorCode must throw
      expect(() =>
        fileAnalysisResultSchema.parse({
          ...sampleFile,
          status: 'error',
          nativeSessionId: null,
          errorCode: null
        })
      ).toThrow(/errorCode must be non-empty/);
    });

    it('enforces cross-code warning sample budget (max 100 total) and max 32 files', () => {
      const resultPath = resolve(repoRoot, 'tests/fixtures/session-insight/golden/analyze-result.golden.json');
      const baseResult = JSON.parse(readFileSync(resultPath, 'utf-8'));

      // 2 warning codes each with 60 samples -> total 120 > 100 -> must throw
      const overWarningBudget = {
        ...baseResult,
        warnings: [
          {
            code: 'WARN_A',
            count: 60,
            samples: Array.from({ length: 60 }, (_, i) => `sample-a-${i}`)
          },
          {
            code: 'WARN_B',
            count: 60,
            samples: Array.from({ length: 60 }, (_, i) => `sample-b-${i}`)
          }
        ]
      };
      expect(() => analyzeFilesResultSchema.parse(overWarningBudget)).toThrow(/Total warning samples across all codes cannot exceed 100/);

      // 2 warning codes each with 50 samples -> total 100 <= 100 -> succeeds
      const validWarningBudget = {
        ...baseResult,
        warnings: [
          {
            code: 'WARN_A',
            count: 50,
            samples: Array.from({ length: 50 }, (_, i) => `sample-a-${i}`)
          },
          {
            code: 'WARN_B',
            count: 50,
            samples: Array.from({ length: 50 }, (_, i) => `sample-b-${i}`)
          }
        ]
      };
      expect(analyzeFilesResultSchema.parse(validWarningBudget).warnings).toHaveLength(2);

      // Over 32 files must throw
      const overFilesBudget = {
        ...baseResult,
        files: Array.from({ length: 33 }, (_, i) => ({
          ...baseResult.files[0],
          sourceKey: `src_${i}`
        }))
      };
      expect(() => analyzeFilesResultSchema.parse(overFilesBudget)).toThrow();
    });
  });

  describe('TraceEvent, Duration Metric, Excerpt UTF-8 & Raw Usage (Gate 4 & 5)', () => {
    it('validates TraceEvent with Metric durationMs and rawUsage structure', () => {
      const event = {
        eventId: 'src_1:a-1:assistant:0',
        sourceKey: 'src_1',
        nativeSessionId: 'sess_1',
        lineNumber: 2,
        byteOffset: 120,
        subeventIndex: 0,
        timestamp: '2026-10-03T10:05:01Z',
        timeQuality: 'observed' as const,
        kind: 'tool_call' as const,
        callId: 'call_1',
        toolName: 'Bash',
        resultStatus: 'unknown' as const,
        durationMs: {
          value: 1250.5,
          quality: 'observed' as const,
          status: 'available' as const,
          evidenceCount: 2,
          missingCount: 0,
          reasonCodes: []
        },
        tokens: {
          inputUncached: 100,
          cacheRead: 20,
          cacheWrite: 0,
          output: 40,
          reasoning: null,
          total: 160
        },
        rawUsage: {
          dialect: 'claude_message_snapshot' as const,
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: null,
          observedDelta: 140,
          baselineStatus: 'zero_confirmed' as const
        },
        inputExcerpt: 'ls -la',
        outputExcerpt: null,
        errorExcerpt: null,
        evidenceRefs: ['call_1'],
        isSnapshotLocalId: false
      };
      const parsed = traceEventSchema.parse(event);
      expect(parsed.durationMs?.value).toBe(1250.5);
      expect(parsed.rawUsage?.dialect).toBe('claude_message_snapshot');
      expect(parsed.resultStatus).toBe('unknown');
    });

    it('enforces UTF-8 byte length limit on excerpts', () => {
      // 1366 3-byte Chinese characters = 4098 bytes > 4096 bytes limit
      const overLongUtf8 = '中'.repeat(1366);
      expect(Buffer.byteLength(overLongUtf8, 'utf8')).toBe(4098);

      expect(() =>
        traceEventSchema.parse({
          eventId: 'src_1:u-1:user:0',
          sourceKey: 'src_1',
          nativeSessionId: 'sess_1',
          lineNumber: 1,
          byteOffset: 0,
          subeventIndex: 0,
          timestamp: '2026-10-03T10:00:00Z',
          timeQuality: 'observed',
          kind: 'user_message',
          inputExcerpt: overLongUtf8
        })
      ).toThrow(/byte limit/);
    });
  });

  describe('Go CLI Protocol and Golden Contracts (Section 4.1 & Gate 9)', () => {
    it('validates engineVersionInfoSchema', () => {
      const versionInfo = {
        schemaVersion: 1,
        engineVersion: '0.1.0',
        parserVersion: 'v3',
        metricVersion: 'v1'
      };
      expect(engineVersionInfoSchema.parse(versionInfo)).toEqual(versionInfo);
    });

    it('validates analyze-request.golden.json against analyzeFilesRequestSchema', () => {
      const requestPath = resolve(repoRoot, 'tests/fixtures/session-insight/golden/analyze-request.golden.json');
      const raw = readFileSync(requestPath, 'utf-8');
      const json = JSON.parse(raw);
      const parsed = analyzeFilesRequestSchema.parse(json);

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0].client).toBe('claude');
      expect(parsed.limits.maxTraceEvents).toBe(20000);
      expect(parsed.limits.maxLineBytes).toBe(4194304);
    });

    it('validates analyze-result.golden.json matches input strictly (unknown reasoning/total/contextWindow, unknown tool result)', () => {
      const resultPath = resolve(repoRoot, 'tests/fixtures/session-insight/golden/analyze-result.golden.json');
      const raw = readFileSync(resultPath, 'utf-8');
      const json = JSON.parse(raw);
      const parsed = analyzeFilesResultSchema.parse(json);

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.engineVersion).toBe('0.1.0');
      expect(parsed.parserVersion).toBe('v3');
      expect(parsed.metricVersion).toBe('v1');
      expect(parsed.files).toHaveLength(1);

      const fileRes = parsed.files[0];
      expect(fileRes.sourceKey).toBe('src_claude_main_01');
      expect(fileRes.client).toBe('claude');
      expect(fileRes.status).toBe('ok');

      // Reasoning, rawTotal, contextWindow are null & unavailable because the input lacks evidence
      expect(fileRes.metrics.reasoningOutput.value).toBeNull();
      expect(fileRes.metrics.reasoningOutput.quality).toBe('unknown');
      expect(fileRes.metrics.rawTotal.value).toBeNull();
      expect(fileRes.metrics.rawTotal.quality).toBe('unknown');
      expect(fileRes.metrics.contextWindow.value).toBeNull();
      expect(fileRes.metrics.contextWindow.quality).toBe('unknown');

      // Tool call has no matching tool_result in input, so resultStatus is unknown
      expect(fileRes.trace[1].resultStatus).toBe('unknown');
      expect(fileRes.metrics.toolSuccesses.value).toBe(0);
      expect(fileRes.metrics.toolUnknowns.value).toBe(1);
      expect(fileRes.metrics.toolFailureRate.value).toBeNull();

      // Subagent is observed but unverified in files
      expect(fileRes.coverage.subagentDiscovery).toBe('partial');
    });

    it('accepts private paths in TranscriptSourceObservation but keeps them out of public schemas', () => {
      const observation = {
        observationId: 'obs_1',
        sessionId: 'sess_1',
        activeRunId: 'run_1',
        driverInstanceId: 'driver_1',
        client: 'claude' as const,
        launchKind: 'created' as const,
        proofKind: 'launch_observed' as const,
        capturedAt: '2026-10-03T10:00:00.000Z',
        dataRoot: '/home/user/.claude',
        cwd: '/home/user/project',
        nativeSessionId: 'uuid-1234',
        verifiedPath: '/home/user/.claude/projects/proj/main.jsonl',
        streamIdentity: { kind: 'main' as const, nativeAgentId: null }
      };
      const parsed = transcriptSourceObservationSchema.parse(observation);
      expect(parsed.dataRoot).toBe('/home/user/.claude');
      expect(parsed.verifiedPath).toBe('/home/user/.claude/projects/proj/main.jsonl');

      // resolvedSource is an internal resolver contract (never serialized into public DTOs);
      // public manifest/summary schemas reject the same private key below.
      const internalResolved = resolvedSourceSchema.parse({
        sourceKey: 'src_1',
        client: 'claude',
        status: 'matched',
        expectedNativeSessionId: 'uuid-1234',
        expectedStream: { kind: 'main', nativeAgentId: null },
        proofKind: 'historical_verified',
        verifiedPath: '/home/user/.claude/projects/proj/main.jsonl'
      });
      expect(internalResolved.status).toBe('matched');
    });

    it('enforces the shared 20,000 trace event budget across all request files', () => {
      const buildEvent = (line: number) => ({
        eventId: `evt-${line}`,
        sourceKey: 'src_1',
        nativeSessionId: 'sess_1',
        lineNumber: line,
        byteOffset: 0,
        subeventIndex: 0,
        timestamp: '2026-10-03T10:00:00Z',
        timeQuality: 'observed' as const,
        kind: 'user_message' as const,
        evidenceRefs: [],
        isSnapshotLocalId: false
      });

      const resultPath = resolve(repoRoot, 'tests/fixtures/session-insight/golden/analyze-result.golden.json');
      const validResult = JSON.parse(readFileSync(resultPath, 'utf-8'));
      expect(() => analyzeFilesResultSchema.parse(validResult)).not.toThrow();

      // Over-limit per-file trace is rejected by the array-level max
      const overPerFile = JSON.parse(readFileSync(resultPath, 'utf-8'));
      overPerFile.files[0].trace = Array.from({ length: 20001 }, (_, i) => buildEvent(i + 1));
      expect(() => analyzeFilesResultSchema.parse(overPerFile)).toThrow();

      // Two files each under the per-file max but jointly over 20,000 are rejected
      const overShared = JSON.parse(readFileSync(resultPath, 'utf-8'));
      const secondFile = JSON.parse(JSON.stringify(overShared.files[0]));
      overShared.files[0].sourceKey = 'src_a';
      overShared.files[0].trace = Array.from({ length: 15000 }, (_, i) => ({
        ...buildEvent(i + 1),
        sourceKey: 'src_a'
      }));
      secondFile.sourceKey = 'src_b';
      secondFile.trace = Array.from({ length: 15000 }, (_, i) => ({
        ...buildEvent(i + 1),
        sourceKey: 'src_b'
      }));
      overShared.files.push(secondFile);
      expect(() => analyzeFilesResultSchema.parse(overShared)).toThrow(/Shared trace\/pulse budget/i);
    });
  });

  describe('Summary & Manifest per-source structures & strict schema (Gate 3 & 7)', () => {
    it('enforces summary has scopeVersion and per-source summary items for deduplication', () => {
      const summaryData = {
        schemaVersion: 1 as const,
        sessionId: 'sess_1',
        snapshotId: 'snap_1',
        createdAt: '2026-10-03T10:00:00Z',
        scopeVersion: 'primary_verified_v1',
        primarySourceKey: 'src_main',
        models: ['claude-3-7-sonnet'],
        isMultiModel: false,
        aggregateMetrics: {
          inputUncached: createCountMetric({ value: 100, quality: 'exact', status: 'available' }),
          cacheRead: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
          cacheWrite: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
          output: createCountMetric({ value: 20, quality: 'exact', status: 'available' }),
          reasoningOutput: createCountMetric({ value: null, quality: 'unknown', status: 'unavailable' }),
          totalTracked: createCountMetric({ value: 120, quality: 'exact', status: 'available' }),
          rawInput: createCountMetric({ value: 100, quality: 'observed', status: 'available' }),
          rawOutput: createCountMetric({ value: 20, quality: 'observed', status: 'available' }),
          rawTotal: createCountMetric({ value: null, quality: 'unknown', status: 'unavailable' }),
          peakContext: createCountMetric({ value: 120, quality: 'observed', status: 'available' }),
          contextWindow: createCountMetric({ value: null, quality: 'unknown', status: 'unavailable' }),
          elapsedDurationMs: createContinuousMetric({ value: 1000, quality: 'observed', status: 'available' }),
          activeDurationMs: createContinuousMetric({ value: 1000, quality: 'observed', status: 'available' }),
          idleDurationMs: createContinuousMetric({ value: 0, quality: 'heuristic', status: 'available' }),
          pairedToolDurationMs: createContinuousMetric({ value: null, quality: 'unavailable', status: 'unavailable' }),
          userTurns: createCountMetric({ value: 1, quality: 'exact', status: 'available' }),
          assistantTurns: createCountMetric({ value: 1, quality: 'exact', status: 'available' }),
          toolCalls: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
          toolFailures: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
          toolSuccesses: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
          toolUnknowns: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
          toolFailureRate: createContinuousMetric({ value: null, quality: 'unavailable', status: 'unavailable' }),
          compactionCount: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
          subagentCount: createCountMetric({ value: 0, quality: 'exact', status: 'available' })
        },
        qualityOverview: 'recorded' as const,
        sources: [
          {
            sourceKey: 'src_main',
            client: 'claude' as const,
            streamIdentity: { kind: 'main' as const, nativeAgentId: null },
            sha256: '4eca389acf9738934ae7fdc35a2ef4dfc34dcad94e90530fad96b2ad906006e3',
            status: 'ok' as const,
            scopeRole: 'primary' as const,
            metrics: {
              inputUncached: createCountMetric({ value: 100, quality: 'exact', status: 'available' }),
              cacheRead: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
              cacheWrite: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
              output: createCountMetric({ value: 20, quality: 'exact', status: 'available' }),
              reasoningOutput: createCountMetric({ value: null, quality: 'unknown', status: 'unavailable' }),
              totalTracked: createCountMetric({ value: 120, quality: 'exact', status: 'available' }),
              rawInput: createCountMetric({ value: 100, quality: 'observed', status: 'available' }),
              rawOutput: createCountMetric({ value: 20, quality: 'observed', status: 'available' }),
              rawTotal: createCountMetric({ value: null, quality: 'unknown', status: 'unavailable' }),
              peakContext: createCountMetric({ value: 120, quality: 'observed', status: 'available' }),
              contextWindow: createCountMetric({ value: null, quality: 'unknown', status: 'unavailable' }),
              elapsedDurationMs: createContinuousMetric({ value: 1000, quality: 'observed', status: 'available' }),
              activeDurationMs: createContinuousMetric({ value: 1000, quality: 'observed', status: 'available' }),
              idleDurationMs: createContinuousMetric({ value: 0, quality: 'heuristic', status: 'available' }),
              pairedToolDurationMs: createContinuousMetric({ value: null, quality: 'unavailable', status: 'unavailable' }),
              userTurns: createCountMetric({ value: 1, quality: 'exact', status: 'available' }),
              assistantTurns: createCountMetric({ value: 1, quality: 'exact', status: 'available' }),
              toolCalls: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
              toolFailures: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
              toolSuccesses: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
              toolUnknowns: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
              toolFailureRate: createContinuousMetric({ value: null, quality: 'unavailable', status: 'unavailable' }),
              compactionCount: createCountMetric({ value: 0, quality: 'exact', status: 'available' }),
              subagentCount: createCountMetric({ value: 0, quality: 'exact', status: 'available' })
            },
            models: ['claude-3-7-sonnet'],
            coverage: {
              rawLines: 2,
              parsedLines: 2,
              ignoredLines: 0,
              errorLines: 0,
              timeRange: { start: '2026-10-03T10:00:00Z', end: '2026-10-03T10:00:01Z' },
              missingTimestampCount: 0,
              disorderedTimestampCount: 0,
              retainedTraceCount: 2,
              omittedTraceCount: 0,
              omittedTraceByCategory: {},
              tokenSamplesAvailable: 1,
              tokenSamplesMissing: 0,
              subagentDiscovery: 'none' as const,
              inheritedHistory: 'none' as const
            },
            relationship: { kind: 'none' as const, parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] },
            aggregation: { eligibility: 'eligible' as const, reasonCodes: [] },
            keyEvidenceEventIds: { failures: [], slowCalls: [], highTokenDeltas: [] }
          }
        ],
        keyEvidenceEventIds: { failures: [], slowCalls: [], highTokenDeltas: [] },
        pulseBuckets: []
      };

      const parsed = sessionInsightSummarySchema.parse(summaryData);
      expect(parsed.sources).toHaveLength(1);
      expect(parsed.sources[0].scopeRole).toBe('primary');

      // Rejects leaking private path to summary via strict schema
      expect(() =>
        sessionInsightSummarySchema.parse({ ...summaryData, path: '/home/private.jsonl' })
      ).toThrow();
    });

    it('enforces manifest includes expected sources with matchStatus, copy metadata and hostEvidenceDigest', () => {
      const manifestData = {
        snapshotId: 'snap_1',
        sessionId: 'sess_1',
        createdAt: '2026-10-03T10:00:00Z',
        bindingRevision: 1,
        scopeVersion: 'primary_verified_v1',
        hostEvidenceDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        sources: [
          {
            sourceKey: 'src_main',
            client: 'claude' as const,
            matchStatus: 'matched' as const,
            expectedStream: { kind: 'main' as const, nativeAgentId: null },
            sha256: '4eca389acf9738934ae7fdc35a2ef4dfc34dcad94e90530fad96b2ad906006e3',
            capturedAt: '2026-10-03T10:00:00Z',
            readBytes: 603,
            analyzedBytes: 603,
            trailingBytes: 0,
            fingerprint: 'fp_abc123',
            relationship: { kind: 'none' as const, parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] },
            aggregation: { eligibility: 'eligible' as const, reasonCodes: [] },
            status: 'ok' as const
          },
          {
            sourceKey: 'src_subagent',
            client: 'claude' as const,
            matchStatus: 'missing' as const,
            expectedStream: { kind: 'subagent' as const, nativeAgentId: 'worker-1' },
            sha256: null,
            capturedAt: null,
            readBytes: null,
            analyzedBytes: null,
            trailingBytes: null,
            fingerprint: null,
            relationship: { kind: 'child' as const, parentNativeSessionId: 'sess_1', parentNativeAgentId: null, evidenceRefs: [] },
            aggregation: { eligibility: 'excluded' as const, reasonCodes: ['SOURCE_FILE_MISSING'] },
            status: 'missing' as const
          }
        ],
        versions: {
          schemaVersion: 1,
          engineVersion: '0.1.0',
          parserVersion: 'v3',
          metricVersion: 'v1',
          redactionVersion: 'v1'
        }
      };

      const parsed = sessionInsightManifestSchema.parse(manifestData);
      expect(parsed.sources).toHaveLength(2);
      expect(parsed.sources[1].matchStatus).toBe('missing');
      expect(parsed.sources[1].sha256).toBeNull();

      // Rejects private path in manifest
      expect(() =>
        sessionInsightManifestSchema.parse({ ...manifestData, verifiedPath: '/etc/secret' })
      ).toThrow();
    });
  });

  describe('Public API Query & Response Schemas (Section 7.1 & Gate 7)', () => {
    it('enforces compare response contains both summaries, manifests and hostEvidence', () => {
      expect(sessionInsightCompareResponseSchema.shape.leftManifest).toBeDefined();
      expect(sessionInsightCompareResponseSchema.shape.rightManifest).toBeDefined();
      expect(sessionInsightCompareResponseSchema.shape.leftHostEvidence).toBeDefined();
      expect(sessionInsightCompareResponseSchema.shape.rightHostEvidence).toBeDefined();
    });

    it('enforces summary query rejects invalid includeArchived string and checks from < to', () => {
      // Rejects random string for includeArchived
      expect(() =>
        sessionInsightSummaryQuerySchema.parse({ includeArchived: 'invalid_boolean' })
      ).toThrow();

      // Accepts true/false string and boolean
      expect(sessionInsightSummaryQuerySchema.parse({ includeArchived: 'true' }).includeArchived).toBe(true);
      expect(sessionInsightSummaryQuerySchema.parse({ includeArchived: false }).includeArchived).toBe(false);

      // Rejects from >= to
      expect(() =>
        sessionInsightSummaryQuerySchema.parse({
          from: '2026-10-03T12:00:00Z',
          to: '2026-10-03T10:00:00Z'
        })
      ).toThrow(/earlier than to/);
    });

    it('validates summarySessionRow contains lifecycle status and per-metric attributions', () => {
      const row = {
        sessionId: 'sess_1',
        workspace: 'ws_default',
        agentId: 'agent_1',
        usage: 'explicit',
        createdAt: '2026-10-03T10:00:00Z',
        refreshState: 'succeeded' as const,
        errorCode: null,
        lastCheckedAt: '2026-10-03T10:05:00Z',
        hasSnapshot: true,
        snapshotId: 'snap_1',
        availability: 'complete' as const,
        freshness: 'current' as const,
        models: ['claude-3-7-sonnet'],
        metrics: null,
        metricAttributions: {
          totalTracked: { included: true },
          subagentTokens: { included: false, reason: 'unverified_overlap' }
        },
        isSharedSource: false
      };
      const parsed = sessionInsightSummaryResponseSchema.shape.sessions.element.parse(row);
      expect(parsed.refreshState).toBe('succeeded');
      expect(parsed.metricAttributions.subagentTokens.included).toBe(false);
    });

    it('enforces metricCoverage in summaryGroupRow: full parse, safeint/nonnegative checks, and strict unknown rejection', () => {
      const baseGroup = {
        groupKey: 'ws_demo',
        candidateSessions: 10,
        withSnapshot: 8,
        withoutSnapshot: 2,
        partialSnapshots: 1,
        failedRefreshes: 0,
        staleSnapshots: 0,
        freshnessUnknown: 0,
        includedCount: 8,
        excludedCount: 2,
        excludedReasons: { 'UNVERIFIED': 2 },
        aggregateMetrics: null
      };

      // 1. 完整 parse（含默认空对象 {} 及真实 metricCoverage 结构）
      const defaultGroup = summaryGroupRowSchema.parse(baseGroup);
      expect(defaultGroup.metricCoverage).toEqual({});

      const groupWithCoverage = summaryGroupRowSchema.parse({
        ...baseGroup,
        metricCoverage: {
          totalTracked: {
            includedCount: 8,
            excludedCount: 2,
            excludedReasons: { 'FORK_UNRESOLVED': 2 }
          },
          activeDurationMs: {
            includedCount: 7,
            excludedCount: 3,
            excludedReasons: { 'TIMESTAMP_MISSING': 3 }
          }
        }
      });
      expect(groupWithCoverage.metricCoverage.totalTracked.includedCount).toBe(8);
      expect(groupWithCoverage.metricCoverage.totalTracked.excludedReasons['FORK_UNRESOLVED']).toBe(2);

      // 2. 负数 / unsafeint 拒绝
      expect(() =>
        summaryGroupRowSchema.parse({
          ...baseGroup,
          metricCoverage: {
            totalTracked: {
              includedCount: -1,
              excludedCount: 0,
              excludedReasons: {}
            }
          }
        })
      ).toThrow();

      expect(() =>
        summaryGroupRowSchema.parse({
          ...baseGroup,
          metricCoverage: {
            totalTracked: {
              includedCount: 1,
              excludedCount: Number.MAX_SAFE_INTEGER + 10,
              excludedReasons: {}
            }
          }
        })
      ).toThrow();

      expect(() =>
        summaryGroupRowSchema.parse({
          ...baseGroup,
          metricCoverage: {
            totalTracked: {
              includedCount: 1,
              excludedCount: 0,
              excludedReasons: { 'BAD_REASON': -5 }
            }
          }
        })
      ).toThrow();

      // 3. 未知字段拒绝（strict）
      expect(() =>
        metricCoverageEntrySchema.parse({
          includedCount: 1,
          excludedCount: 0,
          excludedReasons: {},
          extraUnknownField: 'forbidden'
        })
      ).toThrow();

      expect(() =>
        summaryGroupRowSchema.parse({
          ...baseGroup,
          metricCoverage: {
            totalTracked: {
              includedCount: 1,
              excludedCount: 0,
              excludedReasons: {},
              unexpected: true
            }
          }
        })
      ).toThrow();
    });
  });

  describe('Pure Computation Helpers (Section 6.3)', () => {
    it('computes comparison delta and percentage correctly', () => {
      const left = createCountMetric({ value: 100, quality: 'exact', status: 'available' });
      const right = createCountMetric({ value: 150, quality: 'exact', status: 'available' });

      const diff = calculateMetricComparison(left, right);
      expect(diff.comparable).toBe(true);
      expect(diff.delta).toBe(50);
      expect(diff.percentChange).toBe(50);
      expect(diff.isBaselineZero).toBe(false);
    });

    it('handles zero baseline without returning infinity or false improvement', () => {
      const leftZero = createCountMetric({ value: 0, quality: 'exact', status: 'available' });
      const rightVal = createCountMetric({ value: 50, quality: 'exact', status: 'available' });

      const diff = calculateMetricComparison(leftZero, rightVal);
      expect(diff.comparable).toBe(true);
      expect(diff.delta).toBe(50);
      expect(diff.percentChange).toBeNull();
      expect(diff.isBaselineZero).toBe(true);
      expect(diff.reasonCodes).toContain('BASELINE_ZERO');
    });

    it('handles null and unavailable metrics cleanly', () => {
      const leftNull = createCountMetric({ value: null, quality: 'unavailable', status: 'unavailable' });
      const rightVal = createCountMetric({ value: 50, quality: 'exact', status: 'available' });

      const diff = calculateMetricComparison(leftNull, rightVal);
      expect(diff.comparable).toBe(false);
      expect(diff.delta).toBeNull();
      expect(diff.percentChange).toBeNull();
      expect(diff.reasonCodes).toContain('LEFT_UNAVAILABLE');
    });
  });

  describe('Fixtures Integrity, Provenance & Boundary Checks', () => {
    const expectedFixtures: Record<string, { sha256: string; client: string; type: string }> = {
      // pty-driver-dialects
      'tests/fixtures/session-insight/pty-driver-dialects/claude.jsonl': {
        sha256: '67a7d5a8ffb733f0624f200fb36587c6f5217dafccee4c51ba5d2ce298aefddd',
        client: 'claude',
        type: 'pty-dialect-projection'
      },
      'tests/fixtures/session-insight/pty-driver-dialects/codex.jsonl': {
        sha256: '6e96f8eecf40e7dba0eaf33e43f651188642e8856f2322e19240066a29b6c970',
        client: 'codex',
        type: 'pty-dialect-projection'
      },
      'tests/fixtures/session-insight/pty-driver-dialects/traex.jsonl': {
        sha256: 'c7077707483bbdd9bdbb7a9488edc8fd3127fa0833e5674d36f42bb2b531cd14',
        client: 'traex',
        type: 'pty-dialect-projection'
      },
      // upstream-sanitized
      'tests/fixtures/session-insight/upstream-sanitized/claude-main.jsonl': {
        sha256: '37e8177fe8cb9340aa0d47302ad9c86aaa850f4974e38bd7f8bb76687930c3e9',
        client: 'claude',
        type: 'upstream-sanitized'
      },
      'tests/fixtures/session-insight/upstream-sanitized/claude-subagent-worker.jsonl': {
        sha256: 'bf16dfeee5d2b12609db22dd9399c929031973cadcbd0a30c218786f52150094',
        client: 'claude',
        type: 'upstream-sanitized'
      },
      'tests/fixtures/session-insight/upstream-sanitized/codex-modern.jsonl': {
        sha256: 'f66ad0fbd34f253890804aa22bf89130c0d017eb11210e789f16c7adc4f5ded7',
        client: 'codex',
        type: 'upstream-sanitized'
      },
      'tests/fixtures/session-insight/upstream-sanitized/codex-legacy.jsonl': {
        sha256: 'd6c9e2ea4373264aa8aa8b283e30da978cfa24ac43a104dff31746b56712cace',
        client: 'codex',
        type: 'upstream-sanitized'
      },
      'tests/fixtures/session-insight/upstream-sanitized/traex-modern.jsonl': {
        sha256: 'baa60788cc6bd95819607e9d35b792f4c06e032aaaf4558e5b96736c787063a7',
        client: 'traex',
        type: 'upstream-sanitized'
      },
      'tests/fixtures/session-insight/upstream-sanitized/traex-legacy.jsonl': {
        sha256: '06f8149cb06bf458a709f34fa9da87c160afd54060e97fecac9997678664018a',
        client: 'traex',
        type: 'upstream-sanitized'
      },
      // synthetic boundaries
      'tests/fixtures/session-insight/synthetic/cumulative-100-to-150.jsonl': {
        sha256: 'cbc896a50367f7c6301b035466363b04c3a8a8f846a8e845c763c1480005a24a',
        client: 'codex',
        type: 'synthetic-boundary'
      },
      'tests/fixtures/session-insight/synthetic/reset-150-to-10-no-reset.jsonl': {
        sha256: '697aef4edcc4b3d6a10596f044a96e8b6731d622f0a8ce6a563678ff94741c29',
        client: 'codex',
        type: 'synthetic-boundary'
      },
      'tests/fixtures/session-insight/synthetic/reset-150-to-10-with-reset.jsonl': {
        sha256: 'a5bef23b03de3367a2f8e47108970672ae1d0b599c2d5022e9cf39f7418fc5e1',
        client: 'codex',
        type: 'synthetic-boundary'
      },
      'tests/fixtures/session-insight/synthetic/claude-two-messages.jsonl': {
        sha256: '1230885d2d704ae005725298cd1f500a006413b6628efd72f4fde3cfc55f6f4a',
        client: 'claude',
        type: 'synthetic-boundary'
      },
      'tests/fixtures/session-insight/synthetic/claude-same-message-dedup.jsonl': {
        sha256: 'af9c27ba1eecb3890c0dec08a6bcc5dc31e2626b31d11974832b8eb23620f47d',
        client: 'claude',
        type: 'synthetic-boundary'
      },
      'tests/fixtures/session-insight/synthetic/claude-main.jsonl': {
        sha256: '4eca389acf9738934ae7fdc35a2ef4dfc34dcad94e90530fad96b2ad906006e3',
        client: 'claude',
        type: 'synthetic-boundary'
      },
      'tests/fixtures/session-insight/synthetic/claude-subagent.jsonl': {
        sha256: '728656d756c42e57554d829fb49cf066dc947f4d56323eac07f4d31598c2de69',
        client: 'claude',
        type: 'synthetic-boundary'
      },
      'tests/fixtures/session-insight/synthetic/traex-special-tools.jsonl': {
        sha256: '27924dbd623af62b9b713f41f29adbe6a2fe4676a4524509e7677fbadd79eacd',
        client: 'traex',
        type: 'synthetic-boundary'
      }
    };

    it('verifies SHA256 checksums match README documentation for all fixtures', () => {
      for (const [relPath, meta] of Object.entries(expectedFixtures)) {
        const fullPath = resolve(repoRoot, relPath);
        const content = readFileSync(fullPath);
        const actualHash = createHash('sha256').update(content).digest('hex');
        expect(actualHash, `SHA256 mismatch for ${relPath}`).toBe(meta.sha256);
      }
    });

    it('checks synthetic cumulative 100->150 boundary properties', () => {
      const content = readFileSync(
        resolve(repoRoot, 'tests/fixtures/session-insight/synthetic/cumulative-100-to-150.jsonl'),
        'utf-8'
      );
      const lines = content.trim().split('\n').map(l => JSON.parse(l));
      expect(lines).toHaveLength(4);
      expect(lines[2].payload.info.total_token_usage.input_tokens).toBe(100);
      expect(lines[3].payload.info.total_token_usage.input_tokens).toBe(150);
    });

    it('checks synthetic reset 150->10 with explicit reset marker vs without reset marker', () => {
      const noResetContent = readFileSync(
        resolve(repoRoot, 'tests/fixtures/session-insight/synthetic/reset-150-to-10-no-reset.jsonl'),
        'utf-8'
      );
      const noResetLines = noResetContent.trim().split('\n').map(l => JSON.parse(l));
      expect(noResetLines[2].payload.info.total_token_usage.input_tokens).toBe(150);
      expect(noResetLines[3].payload.info.total_token_usage.input_tokens).toBe(10);
      expect(noResetLines.some(l => l.payload?.type === 'session_reset')).toBe(false);

      const withResetContent = readFileSync(
        resolve(repoRoot, 'tests/fixtures/session-insight/synthetic/reset-150-to-10-with-reset.jsonl'),
        'utf-8'
      );
      const withResetLines = withResetContent.trim().split('\n').map(l => JSON.parse(l));
      expect(withResetLines.some(l => l.payload?.type === 'session_reset')).toBe(true);
      expect(withResetLines[3].payload.new_epoch).toBe(2);
    });

    it('checks synthetic Claude multi-message vs same-message dedup', () => {
      const twoMsgContent = readFileSync(
        resolve(repoRoot, 'tests/fixtures/session-insight/synthetic/claude-two-messages.jsonl'),
        'utf-8'
      );
      const twoMsgLines = twoMsgContent.trim().split('\n').map(l => JSON.parse(l));
      const messageIds = twoMsgLines.filter(l => l.type === 'assistant').map(l => l.message.id);
      expect(messageIds).toEqual(['msg-1', 'msg-2']);

      const dedupContent = readFileSync(
        resolve(repoRoot, 'tests/fixtures/session-insight/synthetic/claude-same-message-dedup.jsonl'),
        'utf-8'
      );
      const dedupLines = dedupContent.trim().split('\n').map(l => JSON.parse(l));
      const dedupMessageIds = dedupLines.filter(l => l.type === 'assistant').map(l => l.message.id);
      expect(dedupMessageIds).toEqual(['msg-stream-1', 'msg-stream-1']);
    });

    it('checks synthetic TraeX special tools and mutation events', () => {
      const traexContent = readFileSync(
        resolve(repoRoot, 'tests/fixtures/session-insight/synthetic/traex-special-tools.jsonl'),
        'utf-8'
      );
      const traexLines = traexContent.trim().split('\n').map(l => JSON.parse(l));
      const toolNames = traexLines
        .filter(l => l.type === 'response_item' && l.payload?.type === 'function_call')
        .map(l => l.payload.name);
      expect(toolNames).toContain('CollabAgentToolCall');
      expect(toolNames).toContain('TerminalInteraction');

      const eventMsgTypes = traexLines.filter(l => l.type === 'event_msg').map(l => l.payload?.type);
      expect(eventMsgTypes).toContain('sub_agent_activity');

      const mutationOps = traexLines.filter(l => l.type === 'history_mutation').map(l => l.payload?.operation);
      expect(mutationOps).toContain('append');
    });
  });
});
