import { RUN_SUMMARY_ENDPOINT, type RunSummary, type Task } from './api';
export { RUN_SUMMARY_ENDPOINT };

export function summaryFromTasks(sessionId: string, tasks: Task[] | undefined): RunSummary | undefined {
  const available = [...(tasks ?? [])].filter(item => item.prompt.trim() && item.status !== 'cancelled');
  const task = [...available].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (!task) return;
  const latest = [...available].sort((left, right) => (right.updatedAt || right.createdAt).localeCompare(left.updatedAt || left.createdAt))[0];
  return { sessionId, taskId: task.id, prompt: task.prompt.trim(), status: task.status, queuedCount: available.filter(item => item.status === 'queued').length, updatedAt: latest?.updatedAt || latest?.createdAt || task.updatedAt || task.createdAt };
}

export const fallbackRunTitle = (source?: string) => source === 'lark' ? '来自飞书的任务' : '尚未获取任务目标';
