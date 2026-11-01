import { describe, expect, it } from 'vitest';
import { clearTaskReport, readSessionTaskReport, readSessionTaskReportReference, readTaskReport, taskReportAttentionText, taskReportInputSchema, taskReportSchema, writeTaskReport, type TaskReport } from './task-report.js';

const report: TaskReport = { schemaVersion: 1, taskId: 't1', sessionId: 's1', status: 'waiting', question: '今天发布吗？', reportedAt: '2026-11-01T00:00:00.000Z' };
const store = () => {
  const rows = new Map<string, string>();
  return { rows, get: async (key: string) => rows.get(key), set: async (key: string, value: string) => { rows.set(key, value); } };
};
describe('task reports', () => {
  it('requires one question for waiting, a reason for blocked, strict keys and schema version', () => {
    for (const input of [{ status: 'waiting' }, { status: 'waiting', question: ' ' }, { status: 'blocked' }, { status: 'other' }, { status: 'ready', taskId: 'other' }]) expect(taskReportInputSchema.safeParse(input).success).toBe(false);
    expect(taskReportSchema.safeParse({ ...report, schemaVersion: 2 }).success).toBe(false);
    expect(taskReportSchema.safeParse({ ...report, extra: true }).success).toBe(false);
    for (const status of ['ready', 'dropped']) expect(taskReportInputSchema.safeParse({ status }).success).toBe(true);
  });
  it('persists, overwrites, validates identity and clears without losing the report', async () => {
    const kv = store();
    await writeTaskReport(kv, report);
    expect(await readTaskReport(kv, 't1')).toEqual(report);
    await writeTaskReport(kv, { ...report, status: 'blocked', summary: '缺少测试账号' });
    expect(taskReportAttentionText(await readTaskReport(kv, 't1'))).toBe('受阻：缺少测试账号');
    await clearTaskReport(kv, 't1', report.reportedAt);
    expect((await readTaskReport(kv, 't1'))?.clearedAt).toBe(report.reportedAt);
    expect(taskReportAttentionText(await readTaskReport(kv, 't1'))).toBeUndefined();
    kv.rows.set('task_report/t2', JSON.stringify(report));
    expect(await readTaskReport(kv, 't2')).toBeUndefined();
    kv.rows.set('task_report/t1', '{');
    expect(await readTaskReport(kv, 't1')).toBeUndefined();
  });
  it('only projects the newest round in the same session, including same-millisecond turns', async () => {
    const kv = store();
    await writeTaskReport(kv, report);
    const tasks = [{ id: 't1', createdAt: report.reportedAt }];
    expect(await readSessionTaskReport(kv, 's1', tasks)).toEqual(report);
    expect(await readSessionTaskReport(kv, 's2', tasks)).toBeUndefined();
    expect(await readSessionTaskReport(kv, 's1', [...tasks, { id: 't2', createdAt: report.reportedAt }])).toBeUndefined();
    await clearTaskReport(kv, 't1');
    expect(await readSessionTaskReport(kv, 's1', tasks)).toBeUndefined();
  });
  it('a concurrent clear cannot overwrite a newer report', async () => {
    const kv = store(); await writeTaskReport(kv, report);
    let compared = false;
    await clearTaskReport({ ...kv, compareAndSet: async (_key, expected, _value) => {
      compared = true; expect(expected).toBe(JSON.stringify(report));
      await writeTaskReport(kv, { ...report, status: 'ready' }); return false;
    } }, 't1');
    expect(compared).toBe(true); expect((await readTaskReport(kv, 't1'))?.status).toBe('ready');
  });
});


it('writes report and its strict session reference in one atomic batch', async () => {
  const kv = store(); const batches: unknown[] = [];
  await writeTaskReport({ ...kv, compareAndSetBatch: async (checks, writes) => {
    batches.push({ checks, writes });
    for (const { key, value } of writes) kv.rows.set(key, value);
    return true;
  } }, report);
  expect(batches).toEqual([{ checks: [], writes: [
    { key: 'task_report/t1', value: JSON.stringify(report) },
    { key: 'task_report/session/s1', value: JSON.stringify({ schemaVersion: 1, sessionId: 's1', taskId: 't1' }) }
  ] }]);
  expect(await readSessionTaskReportReference(kv, 's1')).toBe('t1');
  for (const invalid of [
    { schemaVersion: 2, sessionId: 's1', taskId: 't1' },
    { schemaVersion: 1, sessionId: 'other', taskId: 't1' },
    { schemaVersion: 1, sessionId: 's1', taskId: 't1', extra: true }
  ]) {
    kv.rows.set('task_report/session/s1', JSON.stringify(invalid));
    expect(await readSessionTaskReportReference(kv, 's1')).toBeUndefined();
  }
});
