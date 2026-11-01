import { describe, expect, it } from 'vitest';
import { taskReportCardElements } from './task-report-card.js';
import { boundLarkCardElements, buildLarkCard } from './service.js';

describe('reported result first line', () => {
  it.each(['waiting', 'blocked'] as const)('keeps %s before the rendered output and action row', status => {
    const report = { schemaVersion: 1 as const, taskId: 't', sessionId: 's', status, question: '今天发布吗？', summary: '缺少账号', reportedAt: '2026-11-01T00:00:00.000Z' };
    const reportElements = taskReportCardElements(report);
    const output = { tag: 'markdown', element_id: 'final_output', content: '完整最终结论' };
    for (const state of ['completed', 'failed'] as const) {
      const card = buildLarkCard({ state, cardKind: 'result', taskId: 't', elements: [reportElements[0]!, output] });
      expect(card.body.elements[0]).toMatchObject(reportElements[0]!);
    }
    const oversized = [...reportElements, output, ...Array.from({ length: 1000 }, () => ({ tag: 'markdown', content: '说明'.repeat(100) }))];
    expect(boundLarkCardElements(oversized)[0]).toMatchObject(reportElements[0]!);
    expect(buildLarkCard({ state: 'completed', cardKind: 'result', elements: oversized }).body.elements[0]).toMatchObject(reportElements[0]!);
    expect(taskReportCardElements({ ...report, clearedAt: report.reportedAt })).toEqual([]);
    expect(taskReportCardElements({ ...report, status: 'dropped' })).toEqual([]);
  });
});
