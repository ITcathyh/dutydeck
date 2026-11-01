import { z } from 'zod';
import type { ConfigRepository } from './index.js';

export const taskReportPrefix = 'task_report/';
const text = z.string().trim().min(1).max(2000);
const fields = { status: z.enum(['ready', 'waiting', 'blocked', 'dropped']), question: text.optional(), summary: text.optional() };
const validReport = (value: { status: string; question?: string; summary?: string }, ctx: z.RefinementCtx) => {
  if (value.status === 'waiting' && !value.question) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['question'], message: '等人决定时必须填写一个具体问题。' });
  if (value.status === 'blocked' && !value.summary) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['summary'], message: '受阻时必须填写一句原因。' });
};
export const taskReportInputSchema = z.object(fields).strict().superRefine(validReport);
export type TaskReportInput = z.infer<typeof taskReportInputSchema>;
export const taskReportSchema = z.object({
  schemaVersion: z.literal(1), taskId: z.string().min(1), sessionId: z.string().min(1),
  ...fields, reportedAt: z.string().datetime(), clearedAt: z.string().datetime().optional()
}).strict().superRefine(validReport);
export type TaskReport = z.infer<typeof taskReportSchema>;
const sessionReportReferenceSchema = z.object({ schemaVersion: z.literal(1), sessionId: z.string().min(1), taskId: z.string().min(1) }).strict();
const sessionReportReferenceKey = (sessionId: string) => taskReportPrefix + 'session/' + encodeURIComponent(sessionId);
export async function readSessionTaskReportReference(store: Pick<ConfigRepository, 'get'>, sessionId: string): Promise<string | undefined> {
  const raw = await store.get(sessionReportReferenceKey(sessionId));
  if (!raw) return;
  try {
    const parsed = sessionReportReferenceSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.sessionId === sessionId ? parsed.data.taskId : undefined;
  } catch { return; }
}
type ReportLog = { warn(details: Record<string, unknown>, message: string): void };
export async function readTaskReportSafely(store: Pick<ConfigRepository, 'get'>, taskId: string, log?: ReportLog): Promise<TaskReport | undefined> {
  try { return await readTaskReport(store, taskId); }
  catch (error) { (log ?? console).warn({ error, taskId }, '读取收尾报告失败，继续处理'); }
}
export async function clearTaskReportSafely(store: ConfigRepository, taskId: string, log?: ReportLog): Promise<void> {
  try { await clearTaskReport(store, taskId); }
  catch (error) { (log ?? console).warn({ error, taskId }, '清理收尾报告失败，继续处理'); }
}

export async function readTaskReport(store: Pick<ConfigRepository, 'get'>, taskId: string): Promise<TaskReport | undefined> {
  const raw = await store.get(taskReportPrefix + taskId);
  if (!raw) return;
  try {
    const parsed = taskReportSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.taskId === taskId ? parsed.data : undefined;
  } catch { return; }
}
export async function writeTaskReport(store: Pick<ConfigRepository, 'set' | 'compareAndSetBatch'>, report: TaskReport): Promise<TaskReport> {
  const parsed = taskReportSchema.parse(report);
  const writes = [
    { key: taskReportPrefix + parsed.taskId, value: JSON.stringify(parsed) },
    { key: sessionReportReferenceKey(parsed.sessionId), value: JSON.stringify(sessionReportReferenceSchema.parse({ schemaVersion: 1, sessionId: parsed.sessionId, taskId: parsed.taskId })) }
  ];
  if (store.compareAndSetBatch) await store.compareAndSetBatch([], writes);
  else for (const { key, value } of writes) await store.set(key, value);
  return parsed;
}
export async function clearTaskReport(store: ConfigRepository, taskId: string, clearedAt = new Date().toISOString()): Promise<void> {
  const key = taskReportPrefix + taskId;
  const raw = await store.get(key);
  if (!raw) return;
  const report = await readTaskReport({ get: async () => raw }, taskId);
  if (!report || report.clearedAt) return;
  const value = JSON.stringify(taskReportSchema.parse({ ...report, clearedAt }));
  if (store.compareAndSet) await store.compareAndSet(key, raw, value);
  else await store.set(key, value);
}
// tasks 按接收顺序传入；同毫秒的任务保留仓储顺序。
export async function readSessionTaskReport(store: Pick<ConfigRepository, 'get'>, sessionId: string, tasks: ReadonlyArray<{ id: string; createdAt: string }>): Promise<TaskReport | undefined> {
  const latest = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!latest) return;
  const report = await readTaskReport(store, latest.id);
  return report?.sessionId === sessionId && !report.clearedAt ? report : undefined;
}
export function taskReportAttentionText(report?: TaskReport): string | undefined {
  if (!report || report.clearedAt) return;
  if (report.status === 'waiting') return '等你决定：' + report.question;
  if (report.status === 'blocked') return '受阻：' + report.summary;
}
