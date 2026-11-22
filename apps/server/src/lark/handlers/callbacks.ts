import { confirm, queuedApproval, workflowAction } from './workflow-buttons.js';
import { exportTrace } from './result-buttons.js';
import { repair } from './access-buttons.js';
import { scheduleToggle, ciFix, pullRequest, mandate, workItem } from './automation-buttons.js';
import { forget } from './memory-buttons.js';
import { helpPage, taskPage } from './navigation-buttons.js';
import type { CallbackHandler } from './button-context.js';

// A callback can carry several keys. Keep the original precedence, including legacy cards.
const callbacks: ReadonlyArray<[string, 'present' | 'string' | 'download', CallbackHandler]> = [
  ['dutydeck_confirm', 'present', confirm],
  ['dutydeck_export_trace', 'download', exportTrace],
  ['dutydeck_repair', 'present', repair],
  ['dutydeck_schedule_enable', 'string', scheduleToggle],
  ['dutydeck_schedule_disable', 'string', scheduleToggle],
  ['dutydeck_memory_forget', 'present', forget],
  ['dutydeck_help_page', 'present', helpPage],
  ['dutydeck_task_dashboard', 'present', taskPage],
  ['dutydeck_ci_fix', 'string', ciFix],
  ['dutydeck_pr', 'string', pullRequest],
  ['dutydeck_mandate', 'string', mandate],
  ['dutydeck_work_item', 'string', workItem],
  ['dutydeck_queued_task', 'string', queuedApproval],
  ['dutydeck_workflow', 'string', workflowAction],
  ['dockmux_workflow', 'string', workflowAction],
];

export function resolveCallback(workflow: Record<string, unknown>) {
  return callbacks.find(([key, match]) => match === 'present' ? key in workflow
    : match === 'download' ? workflow[key] === 'download' : typeof workflow[key] === 'string');
}
