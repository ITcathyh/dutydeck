import { RUN_SUMMARY_ENDPOINT, type RunSummary, type Task } from './api';
export { RUN_SUMMARY_ENDPOINT };

export function summaryFromTasks(sessionId: string, tasks: Task[] | undefined): RunSummary | undefined {
  let task: Task | undefined;
  let latest: Task | undefined;
  let queuedCount = 0;
  for (const item of tasks ?? []) {
    if (!item.prompt.trim() || item.status === 'cancelled') continue;
    if (!task || item.createdAt.localeCompare(task.createdAt) < 0) task = item;
    if (!latest || (item.updatedAt || item.createdAt).localeCompare(latest.updatedAt || latest.createdAt) > 0) latest = item;
    if (item.status === 'queued') queuedCount++;
  }
  if (!task) return;
  return { sessionId, taskId: task.id, prompt: task.prompt.trim(), status: task.status, queuedCount, updatedAt: latest?.updatedAt || latest?.createdAt || task.updatedAt || task.createdAt };
}

export const fallbackRunTitle = (source?: string) => source === 'lark' ? '来自飞书的任务' : '尚未获取任务目标';

export function sessionDisplayName(
  session?: { name?: string } | null,
  prompt?: string | null,
  fallback = ''
): string {
  const customName = session?.name?.trim();
  if (customName) return customName;
  const taskPrompt = prompt?.trim();
  if (taskPrompt) return taskPrompt;
  return fallback;
}
