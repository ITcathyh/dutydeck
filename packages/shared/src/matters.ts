import { z } from 'zod';
import { taskReportAttentionText, type TaskReport } from './task-report.js';

export const matterSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), status: z.enum(['open', 'done', 'cancelled']),
  createdAt: z.string(), updatedAt: z.string(),
  originAppId: z.string().optional(), originChatId: z.string().optional(), originMessageId: z.string().optional()
}).strict();
export type Matter = z.infer<typeof matterSchema>;
export const matterLinkKinds = ['session', 'task', 'schedule', 'origin_message', 'reply_target'] as const;
export const matterRelations = ['origin', 'handoff', 'fork', 'resume', 'retry', 'agent_switch', 'schedule_run', 'created_in'] as const;
export type MatterRelation = typeof matterRelations[number];
export const matterLinkSchema = z.object({
  matterId: z.string().min(1), kind: z.enum(matterLinkKinds), refId: z.string().min(1),
  relation: z.enum(matterRelations), createdAt: z.string()
}).strict();
export type MatterLink = z.infer<typeof matterLinkSchema>;
export interface MatterRepository {
  get(id: string): Matter | undefined;
  find(kind: MatterLink['kind'], refId: string): Matter | undefined;
  links(id: string): MatterLink[];
  ensureSession(input: { sessionId: string; title: string; sourceSessionId?: string; relation?: MatterRelation; originAppId?: string; originChatId?: string; originMessageId?: string }): Matter;
  link(input: Omit<MatterLink, 'createdAt'>): void;
}
export interface MatterSummary { id: string; title: string; status: Matter['status']; sessionIds: string[]; supersededSessionIds?: string[]; /** relation=fork 的会话；没有分身时缺省。 */ forkSessionIds?: string[] }

export interface MatterSessionInput {
  sourceSessionId?: string; relation?: MatterRelation; title?: string;
  originAppId?: string; originChatId?: string; originMessageId?: string;
}
export interface MatterTracking {
  accepted(session: import('./index.js').Session, task: import('./index.js').TaskRecord): Promise<void>;
  session(sessionId: string, input: MatterSessionInput): Promise<void>;
  summary(sessionId: string): MatterSummary | undefined;
}

export function matterStatusForSessions(sessions: Array<{ state: string; archivedAt?: string; taskReport?: TaskReport }>): Matter['status'] {
  if (sessions.some(session => taskReportAttentionText(session.taskReport))) return 'open';
  if (sessions.length && sessions.every(session => session.state === 'completed')) return 'done';
  if (sessions.length && sessions.every(session => session.state === 'stopped')) return 'cancelled';
  return 'open';
}

/** 只降低已明确交接/重试承接的历史来源；结果未知仍需人处理。 */
export function isSupersededMatterSession(session: { id: string; state: string }, supersededSessionIds: string[] = [], taskStatus?: string, taskReport?: TaskReport): boolean {
  return supersededSessionIds.includes(session.id) && ['stopped', 'failed', 'interrupted', 'cancelled'].includes(session.state)
    && !['reconcile_required', 'legacy_unresolved'].includes(taskStatus ?? '') && !taskReportAttentionText(taskReport);
}
