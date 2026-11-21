import { confirm } from './workflow-buttons.js';
import { exportTrace } from './result-buttons.js';
import { repair } from './access-buttons.js';
import { scheduleToggle } from './automation-buttons.js';
import type { CallbackHandler } from './button-context.js';

// A callback can carry several keys. Keep the original precedence, including legacy cards.
const callbacks: ReadonlyArray<[string, 'present' | 'string' | 'download', CallbackHandler]> = [
  ['dutydeck_confirm', 'present', confirm],
  ['dutydeck_export_trace', 'download', exportTrace],
  ['dutydeck_repair', 'present', repair],
  ['dutydeck_schedule_enable', 'string', scheduleToggle],
  ['dutydeck_schedule_disable', 'string', scheduleToggle],
];

export function resolveCallback(workflow: Record<string, unknown>) {
  return callbacks.find(([key, match]) => match === 'present' ? key in workflow
    : match === 'download' ? workflow[key] === 'download' : typeof workflow[key] === 'string');
}
