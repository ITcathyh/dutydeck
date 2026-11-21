import type {
  CollaborationAction,
  CollaborationActivity,
  CollaborationBootstrap,
  CollaborationDecision,
  CollaborationDuty,
  CollaborationFeedback,
  CollaborationFollowup,
  CollaborationMandate,
  CollaborationParticipationMode,
  CollaborationSettings as SharedCollaborationSettings,
  CollaborationSnapshot as SharedCollaborationSnapshot,
  ScenarioBinding,
  ScenarioParam,
  ScenarioPreview,
  ScenarioPreviewInput,
  ScheduleTrigger,
  UpdateCollaborationDutyRequest,
  UpdateCollaborationSettingsRequest
} from '@dutydeck/shared';
import type { PublicScheduleDefinition } from './foundation';
import { json, send } from './client';

export type CollaborationParticipation = CollaborationParticipationMode;
// Older peer instances omit the hourly decision budget.
export type CollaborationSettings = Omit<SharedCollaborationSettings, 'maxDecisionsPerHour'> & Partial<Pick<SharedCollaborationSettings, 'maxDecisionsPerHour'>>;
export type CollaborationSnapshot = Omit<SharedCollaborationSnapshot, 'settings'> & { settings: CollaborationSettings };

/** 群设置页列出的一个场景包：参数声明、本群绑定和能否在 Web 上开启。 */
export type CollaborationScenario = {
  id: string;
  title: string;
  version: string;
  description: string;
  mode: 'direct' | 'model';
  params: Record<string, ScenarioParam>;
  binding?: ScenarioBinding;
  /** direct 包要有在群里确认过的人才能开启。 */
  requiresRequester: boolean;
  /** 绑定的大版本和包不一致，要先在群里重新确认。 */
  versionStale: boolean;
  webDescription?: string;
  enableHint?: string;
  plugin: string;
  builtin: boolean;
};

export type CollaborationMandateDetail = CollaborationMandate & {
  schedule?: PublicScheduleDefinition;
  nextDueAt?: string;
};

export type CollaborationOverview = {
  snapshot: CollaborationSnapshot;
  followups: CollaborationFollowup[];
  mandates: CollaborationMandateDetail[];
  decisions: CollaborationDecision[];
  actions: CollaborationAction[];
  activities: CollaborationActivity[];
  feedback: CollaborationFeedback[];
  /** 旧版实例不返回。 */
  duty?: CollaborationDuty;
  /** 对本 Bot 适用的场景包；旧版实例不返回。 */
  scenarios?: CollaborationScenario[];
};

export type CreateCollaborationFollowupInput = {
  id: string;
  goal: string;
  progress?: string;
  steps?: Array<{ id: string; label: string; status: 'open' | 'done' }>;
  ownerId?: string;
  dueAt?: string;
  sourceRefs?: string[];
  fields?: Record<string, string>;
};

export type UpdateCollaborationFollowupInput = {
  expectedRevision: number;
  goal?: string;
  status?: 'open' | 'completed' | 'cancelled';
  progress?: string;
  steps?: Array<{ id: string; label: string; status: 'open' | 'done' }>;
  ownerId?: string | null;
  dueAt?: string | null;
  result?: string;
  sourceRefs?: string[];
  taskIds?: string[];
  externalRefs?: string[];
  fields?: Record<string, string>;
  provenance?: 'observed' | 'inferred' | 'confirmed';
};

export type CreateCollaborationMandateInput = {
  id: string;
  goal: string;
  followupId?: string;
  mode: 'notify' | 'agent';
  prompt: string;
  condition?: 'always' | 'followup_open' | 'no_progress';
  trigger: ScheduleTrigger;
  timezone: string;
  catchupPolicy?: 'skip' | 'coalesce';
  sourceRefs?: string[];
};

export type UpdateCollaborationMandateInput = {
  expectedRevision: number;
  goal?: string;
  status?: 'active' | 'paused' | 'cancelled' | 'completed';
  prompt?: string;
  deliveryPaused?: boolean;
  trigger?: ScheduleTrigger;
  timezone?: string;
  condition?: 'always' | 'followup_open' | 'no_progress';
  catchupPolicy?: 'skip' | 'coalesce';
};

export type CreateCollaborationFeedbackInput = {
  correction: string;
  expectedAction?: 'silent' | 'reply' | 'act';
};

export type CollaborationReplayInput = {
  decisionIds: string[];
  policyVersion?: string;
};

export type CollaborationReplayResultItem = {
  decisionId: string;
  status: 'passed' | 'failed' | 'missing';
  expected?: string;
  actual?: string;
  reason?: string;
};

export type CollaborationReplayResponse = {
  results: CollaborationReplayResultItem[];
  passed: number;
  failed: number;
  missing: number;
};

export const collaborationApi = {
  getOverview: (appId: string, chatId: string) =>
    json<CollaborationOverview>(
      `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration`,
      { cache: 'no-store' }
    ),
  updateSettings: (appId: string, chatId: string, body: UpdateCollaborationSettingsRequest) =>
    send<{ settings: CollaborationSettings }>('PATCH', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/settings`, body),
  updateDuty: (appId: string, chatId: string, body: UpdateCollaborationDutyRequest) =>
    send<{ duty: CollaborationDuty; announced?: boolean }>('PATCH', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/duty`, body),
  previewScenario: (appId: string, chatId: string, id: string, body: ScenarioPreviewInput) =>
    send<ScenarioPreview>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/scenarios/${encodeURIComponent(id)}/preview`, body),
  createFollowup: (appId: string, chatId: string, body: CreateCollaborationFollowupInput) =>
    send<{ followup: CollaborationFollowup }>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/followups`, body),
  updateFollowup: (appId: string, chatId: string, id: string, body: UpdateCollaborationFollowupInput) =>
    send<{ followup: CollaborationFollowup }>('PATCH', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/followups/${encodeURIComponent(id)}`, body),
  createMandate: (appId: string, chatId: string, body: CreateCollaborationMandateInput) =>
    send<{ mandate: CollaborationMandate; schedule?: PublicScheduleDefinition }>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/mandates`, body),
  updateMandate: (appId: string, chatId: string, id: string, body: UpdateCollaborationMandateInput) =>
    send<{ mandate: CollaborationMandate; schedule?: PublicScheduleDefinition }>('PATCH', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/mandates/${encodeURIComponent(id)}`, body),
  addFeedback: (appId: string, chatId: string, decisionId: string, body: CreateCollaborationFeedbackInput) =>
    send<{ feedback: CollaborationFeedback }>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/decisions/${encodeURIComponent(decisionId)}/feedback`, body),
  replay: (appId: string, chatId: string, body: CollaborationReplayInput) =>
    send<CollaborationReplayResponse>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/replay`, body),
  bootstrap: (appId: string, chatId: string) =>
    send<{ bootstrap: CollaborationBootstrap }>('POST', `/api/lark/groups/${encodeURIComponent(appId)}/${encodeURIComponent(chatId)}/collaboration/bootstrap`, {})
};
