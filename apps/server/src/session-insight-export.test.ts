import { describe, expect, it } from 'vitest';
import {
  SESSION_INSIGHT_LIMITS,
  type HostEvidenceSnapshot,
  type SessionInsightEventItem,
  type SessionInsightSnapshotRecord
} from '@dutydeck/shared';

import {
  exportSessionInsightReport,
  type SessionInsightExportSideInput,
  type SessionInsightReport
} from './session-insight-export.js';
import { SessionInsightReportError } from './session-insight-compare.js';
import { buildSnapshot, makeEvent, makeMetrics, makeSourceSummary } from './session-insight-fixtures.test-helpers.js';

function side(
  snapshot: SessionInsightSnapshotRecord,
  events: readonly SessionInsightEventItem[] = []
): SessionInsightExportSideInput {
  return {
    snapshot,
    events: events.map(event => ({ ...event, snapshotId: snapshot.snapshotId }))
  };
}

function snapshotWithKeyEvidence(
  overrides: Parameters<typeof buildSnapshot>[0] & {
    failures?: string[];
    slowCalls?: string[];
    highTokenDeltas?: string[];
  } = {}
): SessionInsightSnapshotRecord {
  const { failures, slowCalls, highTokenDeltas, ...rest } = overrides;
  return buildSnapshot({
    ...rest,
    keyEvidence: {
      failures: failures ?? [],
      slowCalls: slowCalls ?? [],
      highTokenDeltas: highTokenDeltas ?? []
    }
  });
}

const XSS_PAYLOAD = '<img src=x onerror="window.__canaryXss=1"><script>window.__canaryXss=1</script>';
const MD_INJECTION = '# 注入标题\n| a | b |\n| --- | --- |\n[链接](javascript:alert(1))';
const UNSAFE_URL = 'javascript:alert(document.cookie)';
const DATA_URL = 'data:text/html,<script>alert(1)</script>';
const CANARY_SECRET = 'CANARY-SECRET-token-1234567890';

describe('exportSessionInsightReport (T4b)', () => {
  describe('session reports', () => {
    it('renders a single-session Markdown report with scope, coverage, models, evidence and versions', () => {
      const snapshot = snapshotWithKeyEvidence({
        snapshotId: 'snap-md-001',
        sessionId: 'session-md',
        models: ['model-a', 'model-b'],
        failures: ['evt-fail-1'],
        hostEvidence: {
          capturedAt: '2026-09-02T08:30:00.000Z',
          taskGoals: [
            { taskId: 'task-1', attemptId: 'att-1', goal: '修复登录失败', status: 'running' }
          ],
          omittedGoalsCount: 2,
          steeringRelations: [{ steeringTaskId: 'task-2', targetTaskId: 'task-1', completed: true }],
          omittedSteeringCount: 0,
          verificationSnapshot: [
            { taskId: 'task-1', passed: false, stale: true, summary: '测试失败：断言错误' }
          ],
          omittedVerificationsCount: 1,
          modelConfigs: [{ taskId: 'task-1', configuredModel: 'model-a', provider: 'provider-x' }],
          omittedModelConfigsCount: 0,
          usageLedgerProjection: {
            recordedAtRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' },
            totalCostEstimate: 0.42,
            currency: 'USD',
            hasUnpricedUsage: true
          },
          digest: 'a'.repeat(64)
        } satisfies HostEvidenceSnapshot
      });
      const event = makeEvent({
        eventId: 'evt-fail-1',
        kind: 'tool_call',
        toolName: 'Bash',
        resultStatus: 'failure',
        errorExcerpt: 'exit code 1'
      });
      const report = exportSessionInsightReport({ kind: 'session', format: 'markdown', ...side(snapshot, [event]) });

      expect(report.contentType).toBe('text/markdown; charset=utf-8');
      expect(report.filename).toBe('session-insight-snap-md-001-2026-09-02.md');
      expect(report.content.startsWith('# 会话分析报告')).toBe(true);
      // 来源 scope / 覆盖
      expect(report.content).toContain('来源与覆盖');
      expect(report.content).toContain('原始 120 / 解析 110 / 错误 6');
      // 实际模型 / 多模型
      expect(report.content).toContain('model-a, model-b');
      expect(report.content).toContain('多模型');
      // 关键证据失败行
      expect(report.content).toContain('evt-fail-1');
      expect(report.content).toContain('exit code 1');
      expect(report.content).toContain('失败');
      // 目标 / 验证 stale
      expect(report.content).toContain('修复登录失败');
      expect(report.content).toContain('已过期');
      expect(report.content).toContain('不从日志关键词推断');
      // 费用只读投影
      expect(report.content).toContain('0.42 USD');
      expect(report.content).toContain('不重新合计费用');
      // 版本 / snapshotId / 省略
      expect(report.content).toContain('metricVersion');
      expect(report.content).toContain('metric-v1');
      expect(report.content).toContain('snap-md-001');
      expect(report.content).toContain('省略');
      expect(report.content).toContain('不内嵌完整 JSONL');
    });

    it('renders a self-contained HTML report without scripts or external resources', () => {
      const snapshot = buildSnapshot({ snapshotId: 'snap-html-001' });
      const report = exportSessionInsightReport({ kind: 'session', format: 'html', ...side(snapshot) });
      expect(report.contentType).toBe('text/html; charset=utf-8');
      expect(report.filename).toBe('session-insight-snap-html-001-2026-09-02.html');
      expect(report.content).toContain('<!DOCTYPE html>');
      expect(report.content).toContain('<meta charset="utf-8">');
      expect(report.content).not.toMatch(/<script/i);
      expect(report.content).not.toMatch(/<iframe/i);
      expect(report.content).not.toMatch(/\son\w+=/i);
      expect(report.content).not.toMatch(/<link /i);
      expect(report.content).not.toMatch(/https?:\/\//);
      expect(report.content).not.toMatch(/\bsrc\s*=/i);
    });

    it('escapes HTML XSS canary payloads in tool names, goals, verification and excerpts', () => {
      const snapshot = snapshotWithKeyEvidence({
        snapshotId: 'snap-xss-001',
        failures: ['evt-xss-1'],
        hostEvidence: {
          capturedAt: '2026-09-02T08:30:00.000Z',
          taskGoals: [{ taskId: XSS_PAYLOAD, goal: XSS_PAYLOAD, status: XSS_PAYLOAD }],
          omittedGoalsCount: 0,
          steeringRelations: [],
          omittedSteeringCount: 0,
          verificationSnapshot: [{ taskId: 'task-1', passed: true, stale: false, summary: XSS_PAYLOAD }],
          omittedVerificationsCount: 0,
          modelConfigs: [],
          omittedModelConfigsCount: 0,
          digest: 'a'.repeat(64)
        }
      });
      const event = makeEvent({
        eventId: 'evt-xss-1',
        toolName: XSS_PAYLOAD,
        resultStatus: 'failure',
        errorExcerpt: `${XSS_PAYLOAD} ${UNSAFE_URL}`,
        inputExcerpt: UNSAFE_URL
      });
      const report = exportSessionInsightReport({ kind: 'session', format: 'html', ...side(snapshot, [event]) });

      expect(report.content).not.toContain('<img');
      expect(report.content).not.toContain('<script>');
      // onerror 只能作为文本节点内容存在：标签尖括号与属性引号均已转义，
      // 不形成 onerror="..." 属性，因此脚本不执行（canary 不被触发）。
      expect(report.content).not.toContain('onerror="');
      expect(report.content).not.toContain("onerror='");
      expect(report.content).toContain('&lt;img');
      expect(report.content).toContain('&lt;script&gt;');
      expect(report.content).toContain('&quot;');
      // canary 文本存在但被转义，不形成可执行节点
      expect(report.content).toContain('window.__canaryXss=1');
      // unsafe URL 只能作为文本出现，不形成 href/src
      expect(report.content).not.toContain('href=');
      expect(report.content).toMatch(/javascript:alert\(document\.cookie\)/);
    });

    it('escapes Markdown structural injection so payload cannot form headings, tables or active links', () => {
      const snapshot = snapshotWithKeyEvidence({
        snapshotId: 'snap-md-inject',
        failures: ['evt-md-1'],
        hostEvidence: {
          capturedAt: '2026-09-02T08:30:00.000Z',
          taskGoals: [{ taskId: 'task-1', goal: `${MD_INJECTION} ${UNSAFE_URL} ${DATA_URL}`, status: 'x' }],
          omittedGoalsCount: 0,
          steeringRelations: [],
          omittedSteeringCount: 0,
          verificationSnapshot: [],
          omittedVerificationsCount: 0,
          modelConfigs: [],
          omittedModelConfigsCount: 0,
          digest: 'a'.repeat(64)
        }
      });
      const event = makeEvent({
        eventId: 'evt-md-1',
        toolName: MD_INJECTION,
        resultStatus: 'failure',
        errorExcerpt: UNSAFE_URL
      });
      const report = exportSessionInsightReport({ kind: 'session', format: 'markdown', ...side(snapshot, [event]) });
      const lines = report.content.split('\n');

      // 只有报告自身一级标题以 '# ' 开头；注入的换行已折叠，伪造标题不能成行首
      const headingLines = lines.filter(line => /^#(?!#)\s/.test(line));
      expect(headingLines).toEqual(['# 会话分析报告']);
      // javascript:/data: 不形成 markdown 活动链接语法 [text](scheme:...)
      expect(report.content).not.toMatch(/\]\(javascript:/i);
      expect(report.content).not.toMatch(/\]\(data:/i);
      // 不内嵌原始 HTML
      expect(report.content).not.toContain('<script>');
      // payload 文本经转义后仍可读
      expect(report.content).toContain('注入标题');
      // 表格结构字符被转义，伪造表格行不会新增行首管道
      const tableHeaderLines = lines.filter(line => line.startsWith('| 指标'));
      expect(tableHeaderLines.length).toBe(1);
    });

    it('rejects an event belonging to a different snapshot', () => {
      const snapshot = snapshotWithKeyEvidence({ snapshotId: 'snap-own', failures: ['evt-other-snap'] });
      const foreign = makeEvent({ eventId: 'evt-other-snap', snapshotId: 'snap-other' });
      const input = { kind: 'session' as const, format: 'markdown' as const, snapshot, events: [foreign] };
      expect(() => exportSessionInsightReport(input)).toThrow(SessionInsightReportError);
      try {
        exportSessionInsightReport(input);
        expect.unreachable('expected throw');
      } catch (error) {
        expect((error as SessionInsightReportError).code).toBe('INSIGHT_INPUT_LIMIT');
        expect((error as SessionInsightReportError).message).not.toContain('snap-other');
      }
    });

    it('rejects an internally inconsistent snapshot without echoing its fields', () => {
      const snapshot = buildSnapshot({ snapshotId: 'snap-tampered' });
      const tampered = structuredClone(snapshot);
      tampered.manifest.sessionId = '/etc/passwd';
      expect(() =>
        exportSessionInsightReport({ kind: 'session', format: 'html', ...side(tampered) })
      ).toThrow(/Inconsistent frozen snapshot/);
    });

    it('renders deterministic output for identical frozen inputs', () => {
      const snapshot = snapshotWithKeyEvidence({ snapshotId: 'snap-det', failures: ['evt-1'] });
      const event = makeEvent({ eventId: 'evt-1', resultStatus: 'failure' });
      const input = { kind: 'session' as const, format: 'html' as const, ...side(snapshot, [event]) };
      const first = exportSessionInsightReport(input);
      const second = exportSessionInsightReport(input);
      expect(first).toEqual(second);
    });

    it('shows unknown models, partial source status and null metric values without inventing data', () => {
      const snapshot = buildSnapshot({
        snapshotId: 'snap-unknown',
        models: [],
        isMultiModel: false,
        sources: [
          makeSourceSummary({
            sourceKey: 'source-partial',
            status: 'partial',
            models: []
          })
        ],
        primarySourceKey: 'source-partial',
        metrics: makeMetrics({
          peakContext: { value: null, quality: 'unknown', status: 'unavailable', evidenceCount: 0, missingCount: 1, reasonCodes: ['NO_TOKEN_SAMPLES'] }
        })
      });
      for (const format of ['markdown', 'html'] as const) {
        const report = exportSessionInsightReport({ kind: 'session', format, ...side(snapshot) });
        expect(report.content).toContain('未知');
        expect(report.content).toContain('部分');
        expect(report.content).toContain('不可用');
        // 不把未知值渲染成 0
        expect(report.content).not.toContain('上下文峰值 | 0');
      }
    });
  });

  describe('evidence selection and limits', () => {
    function eventsWithIds(ids: string[], kind: SessionInsightEventItem['resultStatus'] = 'success') {
      return ids.map((eventId, index) =>
        makeEvent({ eventId, ordinal: index + 1, resultStatus: kind })
      );
    }

    it('keeps at most 100 evidence rows per snapshot, prioritising failures, slow, high token', () => {
      const failures = Array.from({ length: 60 }, (_, i) => `fail-${i}`);
      const slow = Array.from({ length: 60 }, (_, i) => `slow-${i}`);
      const highToken = Array.from({ length: 60 }, (_, i) => `token-${i}`);
      const snapshot = snapshotWithKeyEvidence({ snapshotId: 'snap-100', failures, slowCalls: slow, highTokenDeltas: highToken });
      const events = eventsWithIds([...failures, ...slow, ...highToken], 'failure');
      const report = exportSessionInsightReport({ kind: 'session', format: 'markdown', ...side(snapshot, events) });

      expect(report.content).toContain('100 条');
      expect(report.content).toContain('失败 60 / 慢调用 40 / 高 Token 0');
      expect(report.content).toContain('80 条引用超出 100 条上限');
      // 第 100 条保留，第 101 条省略
      expect(report.content).toContain('slow-39');
      expect(report.content).not.toContain('slow-40');
      expect(report.content).not.toContain('token-0');
    });

    it('dedupes events referenced by multiple key lists and reports missing references', () => {
      const snapshot = snapshotWithKeyEvidence({
        snapshotId: 'snap-dedup',
        failures: ['shared-1'],
        slowCalls: ['shared-1', 'missing-1'],
        highTokenDeltas: ['shared-1']
      });
      const event = makeEvent({ eventId: 'shared-1', resultStatus: 'failure', ordinal: 1 });
      const report = exportSessionInsightReport({ kind: 'session', format: 'html', ...side(snapshot, [event]) });
      expect(report.content.match(/shared-1/g)?.length).toBeGreaterThan(0);
      // 只在证据表出现一次（另有计数摘要不含 id）
      const tableOccurrences = report.content.split('shared-1').length - 1;
      expect(tableOccurrences).toBe(1);
      expect(report.content).toContain('1 条引用未随快照提供');
    });

    it('fills remaining evidence slots with frozen non-key events in ordinal order', () => {
      const snapshot = snapshotWithKeyEvidence({ snapshotId: 'snap-fill', failures: ['fail-1'] });
      const events = [
        makeEvent({ eventId: 'extra-2', ordinal: 2, toolName: 'ToolB' }),
        makeEvent({ eventId: 'fail-1', ordinal: 1, resultStatus: 'failure' }),
        makeEvent({ eventId: 'extra-1', ordinal: 0, toolName: 'ToolA' })
      ];
      const report = exportSessionInsightReport({ kind: 'session', format: 'markdown', ...side(snapshot, events) });
      const idxFail = report.content.indexOf('fail-1');
      const idxExtra1 = report.content.indexOf('extra-1');
      const idxExtra2 = report.content.indexOf('extra-2');
      expect(idxFail).toBeLessThan(idxExtra1);
      expect(idxExtra1).toBeLessThan(idxExtra2);
      expect(report.content).toContain('其他 2');
    });
  });

  describe('comparison reports', () => {
    it('renders both snapshots with metric deltas and zero-baseline note', () => {
      const left = buildSnapshot({
        snapshotId: 'snap-left-cmp',
        sessionId: 'session-left',
        metrics: makeMetrics({
          toolCalls: { value: 10, quality: 'exact', status: 'available', evidenceCount: 1, missingCount: 0, reasonCodes: [] },
          toolFailures: { value: 0, quality: 'exact', status: 'available', evidenceCount: 1, missingCount: 0, reasonCodes: [] }
        })
      });
      const right = buildSnapshot({
        snapshotId: 'snap-right-cmp',
        sessionId: 'session-right',
        metrics: makeMetrics({
          toolCalls: { value: 12, quality: 'exact', status: 'available', evidenceCount: 1, missingCount: 0, reasonCodes: [] },
          toolFailures: { value: 3, quality: 'exact', status: 'available', evidenceCount: 1, missingCount: 0, reasonCodes: [] }
        })
      });
      const report = exportSessionInsightReport({
        kind: 'comparison',
        format: 'markdown',
        left: side(left),
        right: side(right)
      });
      expect(report.filename).toBe('session-insight-compare-snap-left-cmp-snap-right-cmp-2026-09-02.md');
      expect(report.content).toContain('会话分析对比报告');
      expect(report.content).toContain('snap-left-cmp');
      expect(report.content).toContain('snap-right-cmp');
      expect(report.content).toContain('+20.0%');
      expect(report.content).toContain('基线为零');
      expect(report.content).toContain('左侧：快照 snap-left-cmp');
      expect(report.content).toContain('右侧：快照 snap-right-cmp');
    });

    it('explains incomparable snapshots (metricVersion and scope) without numeric deltas', () => {
      const left = buildSnapshot({ snapshotId: 'snap-a', sessionId: 's1', metricVersion: 'metric-v1' });
      const right = buildSnapshot({ snapshotId: 'snap-b', sessionId: 's2', metricVersion: 'metric-v2', scopeVersion: 'primary_verified_v2' });
      for (const format of ['markdown', 'html'] as const) {
        const report = exportSessionInsightReport({ kind: 'comparison', format, left: side(left), right: side(right) });
        expect(report.content).toContain('不可比');
        expect(report.content).toContain('指标版本不一致');
        expect(report.content).toContain('范围口径不一致');
        expect(report.content).toContain('不把不同任务的差异归因于模型');
        expect(report.content).not.toContain('+');
      }
    });

    it('keeps evidence of each snapshot inside its own section (no cross-summary leakage)', () => {
      const leftSnap = snapshotWithKeyEvidence({ snapshotId: 'snap-left-only', sessionId: 's1', failures: ['left-only-evt'] });
      const rightSnap = snapshotWithKeyEvidence({ snapshotId: 'snap-right-only', sessionId: 's2', failures: ['right-only-evt'] });
      const leftEvents = [makeEvent({ eventId: 'left-only-evt', resultStatus: 'failure' })];
      const rightEvents = [makeEvent({ eventId: 'right-only-evt', resultStatus: 'failure' })];
      const report = exportSessionInsightReport({
        kind: 'comparison',
        format: 'html',
        left: side(leftSnap, leftEvents),
        right: side(rightSnap, rightEvents)
      });
      const leftSection = report.content.slice(
        report.content.indexOf('左侧：快照'),
        report.content.indexOf('右侧：快照')
      );
      expect(leftSection).toContain('left-only-evt');
      expect(leftSection).not.toContain('right-only-evt');
      expect(report.content.slice(report.content.indexOf('右侧：快照'))).toContain('right-only-evt');
    });

    it('supports up to 100 key events per side in a dual-snapshot report', () => {
      const leftIds = Array.from({ length: 100 }, (_, i) => `l-${i}`);
      const rightIds = Array.from({ length: 100 }, (_, i) => `r-${i}`);
      const leftSnap = snapshotWithKeyEvidence({ snapshotId: 'snap-l100', sessionId: 's1', failures: leftIds });
      const rightSnap = snapshotWithKeyEvidence({ snapshotId: 'snap-r100', sessionId: 's2', failures: rightIds });
      const report = exportSessionInsightReport({
        kind: 'comparison',
        format: 'markdown',
        left: side(leftSnap, leftIds.map((id, i) => makeEvent({ eventId: id, ordinal: i, resultStatus: 'failure' }))),
        right: side(rightSnap, rightIds.map((id, i) => makeEvent({ eventId: id, ordinal: i, resultStatus: 'failure' })))
      });
      expect(report.content).toContain('l-99');
      expect(report.content).toContain('r-99');
      expect(report.content).not.toContain('超出 100 条上限');
    });
  });

  describe('size budget, unicode and filenames', () => {
    it('counts UTF-8 bytes and throws INSIGHT_REPORT_LIMIT above 16 MiB for a dual-snapshot report', () => {
      // traceEvent.toolName 在冻结契约中是无长度上限的字符串；
      // 每侧 100 条关键证据、每条工具名约 270 KiB（90,000 个三字节 CJK 字符），
      // 双快照合并后约 54 MiB，用于验证“双快照统一按最终 UTF-8 计数”的闸门。
      const unicodeTool = '测'.repeat(90_000);
      const makeLargeSide = (snapshotId: string, prefix: string): SessionInsightExportSideInput => {
        const snapshot = snapshotWithKeyEvidence({
          snapshotId,
          sessionId: `session-${prefix}`,
          failures: Array.from({ length: 100 }, (_, i) => `${prefix}-fail-${i}`)
        });
        const events = Array.from({ length: 100 }, (_, i) =>
          makeEvent({
            eventId: `${prefix}-fail-${i}`,
            ordinal: i,
            resultStatus: 'failure',
            toolName: unicodeTool,
            errorExcerpt: '超限用例'
          })
        );
        return side(snapshot, events);
      };
      const input = {
        kind: 'comparison' as const,
        format: 'html' as const,
        left: makeLargeSide('snap-huge-l', 'l'),
        right: makeLargeSide('snap-huge-r', 'r')
      };
      try {
        exportSessionInsightReport(input);
        expect.unreachable('expected report_limit');
      } catch (error) {
        expect(error).toBeInstanceOf(SessionInsightReportError);
        expect((error as SessionInsightReportError).code).toBe('INSIGHT_REPORT_LIMIT');
        expect((error as SessionInsightReportError).message).not.toMatch(/测|snap-huge/);
      }
    });

    it('returns a complete, closed HTML document for large but within-limit reports', () => {
      const snapshot = snapshotWithKeyEvidence({
        snapshotId: 'snap-large-1',
        failures: Array.from({ length: 100 }, (_, i) => `fail-${i}`)
      });
      const events = Array.from({ length: 100 }, (_, i) =>
        makeEvent({
          eventId: `fail-${i}`,
          ordinal: i,
          resultStatus: 'failure',
          errorExcerpt: 'x'.repeat(4000),
          toolName: '终端工具'
        })
      );
      const report = exportSessionInsightReport({ kind: 'session', format: 'html', ...side(snapshot, events) });
      expect(report.content.endsWith('</body></html>')).toBe(true);
      expect(new TextEncoder().encode(report.content).length).toBeLessThanOrEqual(
        SESSION_INSIGHT_LIMITS.maxReportOutputBytes
      );
    });

    it('handles Unicode and emoji content correctly in both formats', () => {
      const snapshot = snapshotWithKeyEvidence({
        snapshotId: 'snap-unicode',
        failures: ['evt-uni'],
        hostEvidence: {
          capturedAt: '2026-09-02T08:30:00.000Z',
          taskGoals: [{ taskId: '任务-1 🚀', goal: '修复「登录」失败 — 测试 & 验证', status: '运行中 ✅' }],
          omittedGoalsCount: 0,
          steeringRelations: [],
          omittedSteeringCount: 0,
          verificationSnapshot: [],
          omittedVerificationsCount: 0,
          modelConfigs: [],
          omittedModelConfigsCount: 0,
          digest: 'a'.repeat(64)
        }
      });
      const event = makeEvent({ eventId: 'evt-uni', toolName: '终端<危险>', errorExcerpt: '错误：「文件」未找到 & 失败' });
      for (const format of ['markdown', 'html'] as const) {
        const report = exportSessionInsightReport({ kind: 'session', format, ...side(snapshot, [event]) });
        expect(report.content).toContain('任务-1');
        expect(report.content).toContain('🚀');
        // UTF-8 完整编码，可往返
        expect(new TextDecoder().decode(new TextEncoder().encode(report.content))).toBe(report.content);
      }
    });

    it('builds filenames only from safe id characters and the fixed snapshot date', () => {
      const snapshot = buildSnapshot({ snapshotId: 'snap/../evil name_2026', createdAt: '2026-09-02T08:30:00.000Z' });
      const report = exportSessionInsightReport({ kind: 'session', format: 'html', ...side(snapshot) });
      expect(report.filename).not.toContain('/');
      expect(report.filename).not.toContain('..');
      expect(report.filename).not.toContain(' ');
      expect(report.filename.endsWith('-2026-09-02.html')).toBe(true);
    });

    it('includes snapshot ids, time range, versions and omission counts in both formats', () => {
      const snapshot = snapshotWithKeyEvidence({ snapshotId: 'snap-meta' });
      for (const format of ['markdown', 'html'] as const) {
        const report: SessionInsightReport = exportSessionInsightReport({
          kind: 'session',
          format,
          ...side(snapshot)
        });
        expect(report.content).toContain('snap-meta');
        expect(report.content).toContain('2026-09-01T00:00:00.000Z');
        expect(report.content).toContain('2026-09-01T01:00:00.000Z');
        expect(report.content).toContain('engine-v1');
        expect(report.content).toContain('parser-v1');
        expect(report.content).toContain('redaction-v1');
        expect(report.content).toContain('0 条');
      }
    });
  });

  describe('redaction boundary', () => {
    it('keeps a payload canary as escaped inert text but does not claim generic redaction', () => {
      const snapshot = snapshotWithKeyEvidence({
        snapshotId: 'snap-canary',
        failures: ['evt-canary']
      });
      const event = makeEvent({
        eventId: 'evt-canary',
        resultStatus: 'failure',
        errorExcerpt: `token=${CANARY_SECRET} <b>bold</b>`
      });
      const report = exportSessionInsightReport({ kind: 'session', format: 'html', ...side(snapshot, [event]) });
      // 导出不做通用脱敏：canary 原文仍在（宿主 T4c 负责脱敏）
      expect(report.content).toContain(CANARY_SECRET);
      // 但 HTML 结构失活
      expect(report.content).not.toContain('<b>bold</b>');
      expect(report.content).toContain('&lt;b&gt;bold&lt;/b&gt;');
    });
  });
});
