import { taskReportAttentionText, type TaskReport } from '@dutydeck/shared';
import { escapeCardInline } from './card-elements.js';
import { redactTraceText } from './secret-redaction.js';

export function taskReportCardElements(report?: TaskReport) {
  const text = taskReportAttentionText(report);
  return text ? [{ tag: 'markdown', element_id: 'task_report', content: escapeCardInline(redactTraceText(text).replace(/\s+/gu, ' ')) }] : [];
}
