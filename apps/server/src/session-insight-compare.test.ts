import { describe, expect, it } from 'vitest';
import {
  sessionInsightCompareResponseSchema,
  type SessionInsightSnapshotRecord
} from '@dutydeck/shared';

import {
  assertFrozenSnapshotConsistent,
  compareSessionSnapshots,
  FILE_METRIC_KEYS,
  SessionInsightReportError
} from './session-insight-compare.js';
import { buildSnapshot, makeMetrics, makeSourceSummary } from './session-insight-fixtures.test-helpers.js';

function pair(
  leftOverrides: Parameters<typeof buildSnapshot>[0] = {},
  rightOverrides: Parameters<typeof buildSnapshot>[0] = {}
): { left: SessionInsightSnapshotRecord; right: SessionInsightSnapshotRecord } {
  return {
    left: buildSnapshot({ snapshotId: 'snap-left', sessionId: 'session-left', ...leftOverrides }),
    right: buildSnapshot({ snapshotId: 'snap-right', sessionId: 'session-right', ...rightOverrides })
  };
}

describe('compareSessionSnapshots (T4b)', () => {
  it('compares every fixed FileMetrics key with deterministic ordering', () => {
    const { left, right } = pair(
      { metrics: makeMetrics({ toolCalls: { ...makeMetrics().toolCalls, value: 10 } }) },
      { metrics: makeMetrics({ toolCalls: { ...makeMetrics().toolCalls, value: 15 } }) }
    );
    const result = compareSessionSnapshots({ left, right });
    const parsed = sessionInsightCompareResponseSchema.parse(result);

    expect(Object.keys(parsed.metricDiffs)).toEqual([...FILE_METRIC_KEYS]);
    expect(parsed.comparable).toBe(true);
    expect(parsed.incomparableReasons).toEqual([]);
    const toolCalls = parsed.metricDiffs.toolCalls!;
    expect(toolCalls.comparable).toBe(true);
    expect(toolCalls.leftValue).toBe(10);
    expect(toolCalls.rightValue).toBe(15);
    expect(toolCalls.delta).toBe(5);
    expect(toolCalls.percentChange).toBe(50);
    expect(toolCalls.isBaselineZero).toBe(false);
    expect(toolCalls.reasonCodes).toEqual([]);
  });

  it('emits absolute delta with null percentChange and BASELINE_ZERO when left value is 0', () => {
    const { left, right } = pair(
      { metrics: makeMetrics({ toolFailures: { value: 0, quality: 'exact', status: 'available', evidenceCount: 1, missingCount: 0, reasonCodes: [] } }) },
      { metrics: makeMetrics({ toolFailures: { value: 4, quality: 'exact', status: 'available', evidenceCount: 1, missingCount: 0, reasonCodes: [] } }) }
    );
    const result = compareSessionSnapshots({ left, right });
    const diff = result.metricDiffs.toolFailures!;
    expect(diff.comparable).toBe(true);
    expect(diff.delta).toBe(4);
    expect(diff.percentChange).toBeNull();
    expect(diff.isBaselineZero).toBe(true);
    expect(diff.reasonCodes).toEqual(['BASELINE_ZERO']);
  });

  it('does not compute deltas for null, conflict, partial or unavailable metrics', () => {
    const blocked = (status: 'conflict' | 'partial' | 'unavailable') => ({
      value: null as number | null,
      quality: 'unknown' as const,
      status,
      evidenceCount: 0,
      missingCount: 1,
      reasonCodes: ['BLOCKED']
    });
    const { left, right } = pair(
      { metrics: makeMetrics({ compactionCount: blocked('conflict') }) },
      { metrics: makeMetrics({ compactionCount: blocked('partial') }) }
    );
    const result = compareSessionSnapshots({ left, right });
    const diff = result.metricDiffs.compactionCount!;
    expect(diff.comparable).toBe(false);
    expect(diff.delta).toBeNull();
    expect(diff.percentChange).toBeNull();
    expect(diff.leftValue).toBeNull();
    expect(diff.rightValue).toBeNull();
    expect(diff.reasonCodes).toContain('LEFT_CONFLICT');
    expect(diff.reasonCodes).toContain('RIGHT_PARTIAL');
  });

  it('treats null value with available status as incomparable rather than a zero delta', () => {
    const { left, right } = pair(
      { metrics: makeMetrics({ subagentCount: { value: null, quality: 'unknown', status: 'available', evidenceCount: 0, missingCount: 1, reasonCodes: [] } }) },
      { metrics: makeMetrics({ subagentCount: { value: 3, quality: 'exact', status: 'available', evidenceCount: 1, missingCount: 0, reasonCodes: [] } }) }
    );
    const diff = compareSessionSnapshots({ left, right }).metricDiffs.subagentCount!;
    expect(diff.comparable).toBe(false);
    expect(diff.delta).toBeNull();
    expect(diff.reasonCodes).toEqual(['NULL_METRIC_VALUE']);
  });

  it('marks the whole response incomparable when metricVersion differs and blocks every numeric delta', () => {
    const { left, right } = pair({ metricVersion: 'metric-v1' }, { metricVersion: 'metric-v2' });
    const result = compareSessionSnapshots({ left, right });
    expect(result.comparable).toBe(false);
    expect(result.incomparableReasons).toEqual(['METRIC_VERSION_MISMATCH']);
    for (const key of FILE_METRIC_KEYS) {
      const diff = result.metricDiffs[key]!;
      expect(diff.comparable).toBe(false);
      expect(diff.delta).toBeNull();
      expect(diff.percentChange).toBeNull();
      expect(diff.reasonCodes).toEqual(['METRIC_VERSION_MISMATCH']);
    }
  });

  it('marks the whole response incomparable when scopeVersion (range rules) differs', () => {
    const { left, right } = pair(
      { scopeVersion: 'primary_verified_v1' },
      { scopeVersion: 'primary_verified_v2' }
    );
    const result = compareSessionSnapshots({ left, right });
    expect(result.comparable).toBe(false);
    expect(result.incomparableReasons).toEqual(['SCOPE_VERSION_MISMATCH']);
    expect(result.metricDiffs.toolCalls!.reasonCodes).toEqual(['SCOPE_VERSION_MISMATCH']);
  });

  it('still echoes both fixed summaries, manifests and host evidence when incomparable', () => {
    const { left, right } = pair({ metricVersion: 'metric-v1' }, { metricVersion: 'metric-v9' });
    const result = compareSessionSnapshots({ left, right });
    expect(result.left.snapshotId).toBe('snap-left');
    expect(result.right.snapshotId).toBe('snap-right');
    expect(result.leftManifest.snapshotId).toBe('snap-left');
    expect(result.rightManifest.snapshotId).toBe('snap-right');
    expect(result.leftHostEvidence.digest).toBe(left.hostEvidence.digest);
    expect(result.rightHostEvidence.digest).toBe(right.hostEvidence.digest);
  });

  it('supports multi-model snapshots without attributing differences to models', () => {
    const { left, right } = pair(
      { models: ['model-a', 'model-b'], isMultiModel: true },
      { models: ['model-a', 'model-b'], isMultiModel: true }
    );
    const result = compareSessionSnapshots({ left, right });
    expect(result.left.isMultiModel).toBe(true);
    expect(result.right.models).toEqual(['model-a', 'model-b']);
    // 模型列表不参与 metricDiffs，对比不产出任何模型归因字段。
    expect(result.metricDiffs).not.toHaveProperty('models');
  });

  it('produces deterministic output for the same frozen inputs', () => {
    const { left, right } = pair();
    const first = compareSessionSnapshots({ left, right });
    const second = compareSessionSnapshots({ left, right });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('rejects a snapshot whose summary snapshotId disagrees with the record', () => {
    const { left, right } = pair();
    const tampered = structuredClone(left);
    tampered.summary.snapshotId = 'snap-forged';
    expect(() => assertFrozenSnapshotConsistent(tampered)).toThrow(SessionInsightReportError);
    expect(() => compareSessionSnapshots({ left: tampered, right })).toThrow(
      /Inconsistent frozen snapshot/
    );
    try {
      compareSessionSnapshots({ left: tampered, right });
      expect.unreachable('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionInsightReportError);
      expect((error as SessionInsightReportError).code).toBe('INSIGHT_INPUT_LIMIT');
    }
  });

  it('rejects a snapshot whose manifest sessionId disagrees with the record', () => {
    const { left, right } = pair();
    const tampered = structuredClone(left);
    tampered.manifest.sessionId = 'session-forged';
    expect(() => compareSessionSnapshots({ left: tampered, right })).toThrow(SessionInsightReportError);
  });

  it('rejects a snapshot whose host evidence digest disagrees with the manifest', () => {
    const { left, right } = pair();
    const tampered = structuredClone(left);
    tampered.hostEvidence.digest = 'f'.repeat(64);
    expect(() => compareSessionSnapshots({ left: tampered, right })).toThrow(SessionInsightReportError);
  });

  it('rejects a snapshot whose primary source key is absent from sources', () => {
    const { left, right } = pair();
    const tampered = structuredClone(left);
    tampered.summary.primarySourceKey = 'source-missing';
    expect(() => assertFrozenSnapshotConsistent(tampered)).toThrow(SessionInsightReportError);
  });

  it('rejects a snapshot whose scope version differs between summary and manifest', () => {
    const { left, right } = pair();
    const tampered = structuredClone(left);
    tampered.manifest.scopeVersion = 'primary_verified_v9';
    expect(() => compareSessionSnapshots({ left: tampered, right })).toThrow(SessionInsightReportError);
  });

  it('accepts two distinct sessions that each have internally consistent references', () => {
    const { left, right } = pair(
      { sources: [makeSourceSummary({ sourceKey: 'source-left' })], primarySourceKey: 'source-left' },
      { sources: [makeSourceSummary({ sourceKey: 'source-right' })], primarySourceKey: 'source-right' }
    );
    expect(() => compareSessionSnapshots({ left, right })).not.toThrow();
  });
});
