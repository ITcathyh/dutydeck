import type {
  AutomationRunDetail,
  AutomationSchedulePage,
  CiSubscription,
  CreateSessionScheduleInput,
  PublicCiProvider,
  PublicPullRequest,
  PublicSessionScheduleOccurrence,
  PullRequestAvailability,
  SessionAutomationList,
  SessionSchedule,
  SubscribeCiInput,
  UpdateSessionScheduleInput
} from '@dutydeck/shared';
import { ApiError, json, send } from './client';

export const automationRequests = {
  automationSchedules: async (params: URLSearchParams, instance?: string | null) => {
    const page = await json<AutomationSchedulePage>(`/api/automation/schedules?${params}`, undefined, instance);
    if (!Array.isArray(page.items) || !page.counts || typeof page.total !== 'number') throw new ApiError('此实例不支持当前计划总览，请升级后重试', 'AUTOMATION_OVERVIEW_UNSUPPORTED', 404);
    return page;
  },
  automationHistory: (sessionId: string, scheduleId: string, offset = 0, limit = 20) => json<{ occurrences: PublicSessionScheduleOccurrence[]; total: number; offset: number; limit: number }>(`/api/sessions/${encodeURIComponent(sessionId)}/automation/schedules/${encodeURIComponent(scheduleId)}/history?offset=${offset}&limit=${limit}`),
  automationRun: (sessionId: string, scheduleId: string, occurrenceId: string) => json<AutomationRunDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/automation/schedules/${encodeURIComponent(scheduleId)}/runs/${encodeURIComponent(occurrenceId)}`),
  automation: (id: string) => json<SessionAutomationList>(`/api/sessions/${id}/automation`),
  createSchedule: (id: string, input: CreateSessionScheduleInput) => send<{ schedule: SessionSchedule }>('POST', `/api/sessions/${id}/automation/schedules`, input),
  updateSchedule: (id: string, scheduleId: string, input: UpdateSessionScheduleInput) => send<{ schedule: SessionSchedule }>('PATCH', `/api/sessions/${id}/automation/schedules/${scheduleId}`, input),
  runSchedule: (id: string, scheduleId: string, input: { expectedRevision: number; idempotencyKey: string }) => send<{ occurrence: PublicSessionScheduleOccurrence }>('POST', `/api/sessions/${id}/automation/schedules/${scheduleId}/run`, input),
  deleteSchedule: (id: string, scheduleId: string, expectedRevision: number) => send<{ schedule: SessionSchedule }>('DELETE', `/api/sessions/${id}/automation/schedules/${scheduleId}`, { expectedRevision }),
  subscribeCi: (id: string, input: SubscribeCiInput) => send<{ subscription: CiSubscription }>('POST', `/api/sessions/${id}/automation/ci`, input),
  ciProviders: (id: string) => json<{ providers: PublicCiProvider[] }>(`/api/sessions/${id}/automation/ci-providers`),
  cancelCi: (id: string, subscriptionId: string, expectedRevision: number) => send<{ subscription: CiSubscription }>('POST', `/api/sessions/${id}/automation/ci/${subscriptionId}/cancel`, { expectedRevision }),
  pullRequests: (id: string) => json<PullRequestAvailability & { items: PublicPullRequest[] }>(`/api/sessions/${id}/pull-requests`),
  preparePullRequest: (id: string, input: { title?: string }) => send<{ pullRequest: PublicPullRequest }>('POST', `/api/sessions/${id}/pull-requests`, input),
  followPullRequest: (id: string, pullRequest: string) => send<{ pullRequest: PublicPullRequest }>('POST', `/api/sessions/${id}/pull-requests/follow`, { pullRequest }),
  confirmPullRequest: (id: string, pullRequestId: string) => json<{ message: string; pullRequest: PublicPullRequest }>(`/api/sessions/${id}/pull-requests/${pullRequestId}/confirm`, { method: 'POST' }),
  forcePushPullRequest: (id: string, pullRequestId: string) => json<{ message: string }>(`/api/sessions/${id}/pull-requests/${pullRequestId}/force-push`, { method: 'POST' }),
  cancelPullRequest: (id: string, pullRequestId: string) => json<{ pullRequest: PublicPullRequest }>(`/api/sessions/${id}/pull-requests/${pullRequestId}/cancel`, { method: 'POST' }),
};
