import type { CreateWorkItemInput, ReviseWorkPlanInput, WorkItem, WorkItemRequest, WorkRevisionPreview, WorkTemplate } from '@dutydeck/shared';
import { json, send } from './client';

export const workItemRequests = {
  workItemRequests: (sessionId: string, id: string) => json<WorkItemRequest[]>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/requests`, { cache: 'no-store' }),
  respondWorkItemRequest: (sessionId: string, id: string, input: { stepId: string; taskId: string; requestId: string; kind: 'permission' | 'question'; answer: string }) => send<unknown>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/respond`, input),
  workItems: (sessionId: string) => json<{ items: WorkItem[]; templates: WorkTemplate[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items`, { cache: 'no-store' }),
  workItem: (sessionId: string, id: string) => json<WorkItem>(`/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}`, { cache: 'no-store' }),
  createWorkItem: (sessionId: string, input: CreateWorkItemInput) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items`, input),
  cancelWorkItem: (sessionId: string, id: string, expectedRevision: number) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/cancel`, { expectedRevision }),
  retryWorkStep: (sessionId: string, id: string, stepId: string, expectedRevision: number) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/retry`, { stepId, expectedRevision }),
  answerWorkStep: (sessionId: string, id: string, stepId: string, answer: string, expectedRevision: number) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/answer`, { stepId, answer, expectedRevision }),
  previewWorkRevision: (sessionId: string, id: string, input: Omit<ReviseWorkPlanInput, 'reason'>) => send<WorkRevisionPreview>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/revise/preview`, input),
  reviseWorkItem: (sessionId: string, id: string, input: ReviseWorkPlanInput) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/revise`, input),
  confirmWorkItem: (sessionId: string, id: string, expectedRevision: number, revisionDigest?: string) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/confirm`, { expectedRevision, ...(revisionDigest ? { revisionDigest } : {}) }),
  discardWorkRevision: (sessionId: string, id: string, expectedRevision: number, revisionDigest?: string) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/revision/discard`, { expectedRevision, ...(revisionDigest ? { revisionDigest } : {}) }),
  saveWorkTemplate: (sessionId: string, id: string, name: string) => send<WorkTemplate>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-items/${encodeURIComponent(id)}/template`, { name }),
  runWorkTemplate: (sessionId: string, id: string, input: { version: number; goal: string; idempotencyKey: string }) => send<WorkItem>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/work-templates/${encodeURIComponent(id)}/run`, input),
};
