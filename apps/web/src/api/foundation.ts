import type {
  ArchivedHammerIntegration,
  ChannelBotGroupPolicy,
  CreateGroupBindingInput,
  EffectiveGroupConfig,
  GroupBinding,
  PublicChannelBotFoundation,
  RemoteChatFact,
  ScheduleBlocker,
  ScheduleGeneration,
  SchedulePreview,
  ScheduleTrigger,
  ScheduleWatermark,
  SecretRefMetadata,
  UpdateChannelBotInput,
  UpdateGroupBindingInput,
  UpdateScheduleDefinitionInput
} from '@dutydeck/shared';
import { json, send } from './client';

export type FoundationCapability = { schemaVersion: 1; repositoriesWired: boolean; permissionEvaluatorWired: boolean; secretInspectorWired: boolean; runtimeWired: false; writesEnabled: boolean; readiness: 'repository_unwired' | 'permission_unwired' | 'secret_inspector_unwired' | 'offline_management_ready'; blockers: Array<{ code: string; message: string; action: string }> };
export type PublicSecretRef = SecretRefMetadata & { availability: 'available' | 'missing' | 'unreadable' | 'unchecked' };
export type GroupMatrixCell = {
  externalChatId: string;
  remoteFact?: RemoteChatFact;
  desiredPolicy?: GroupBinding;
  effectiveSummary?: EffectiveGroupConfig;
  permissionSummary: { talkSource: string; canTalkAssignments: number; canOperateAssignments: number; adminAssignments: number; independentGates: { terminalWrite: boolean; highRisk: boolean; groupToolsSend: boolean } };
  severity: 'healthy' | 'info' | 'needs_review' | 'blocked' | 'degraded';
  blockers: Array<{ code: string; action: string }>;
  primaryAction: { id: string; label: string };
};
export type GroupMatrix = { capabilities: FoundationCapability; bots: Array<{ bot: PublicChannelBotFoundation; policy?: ChannelBotGroupPolicy; cells: GroupMatrixCell[] }> };
export type ScheduleCapability = { schemaVersion: 1; repositoriesWired: boolean; permissionEvaluatorWired: boolean; writesEnabled: boolean; executorWired: false; uiEntryReady: boolean; readiness: 'repository_unwired' | 'permission_unwired' | 'offline_management_ready'; blockers: Array<{ code: string; message: string; action: string }> };
export type PublicScheduleDefinition = {
  schemaVersion: 1; id: string; revision: number; channelBotId: string; groupBindingId?: string; name: string; description?: string;
  trigger: ScheduleTrigger; timezone: string; dstPolicy: { gap: 'skip' | 'shift_forward'; overlap: 'first' | 'second' };
  delivery: { mode: 'chat' | 'thread'; continuation: 'same_thread' | 'new_topic' | 'chat_root'; destinationConfigured: boolean; threadRootConfigured: boolean };
  workspaceConfigured: boolean; payloadConfigured: boolean; identityConfigured: boolean; secretRefConfigured: boolean;
  sourceOwnership: 'dutydeck' | 'botmux'; sourceEnabled: boolean; state: 'staged' | 'disabled'; desiredExecutorState: 'disabled'; currentGeneration: number;
  createdAt: string; updatedAt: string;
};
export type ScheduleDetail = { definition: PublicScheduleDefinition; readiness: { executionEligible: false; nextOccurrence?: SchedulePreview; blockers: ScheduleBlocker[] }; currentGeneration?: ScheduleGeneration; watermark?: ScheduleWatermark };
export type ScheduleList = { capabilities: ScheduleCapability; schedules: ScheduleDetail[] };

export const foundationApi = {
  capabilities: () => json<FoundationCapability>('/api/foundation/capabilities', { cache: 'no-store' }),
  secretRefs: () => json<{ secretRefs: PublicSecretRef[] }>('/api/foundation/secret-refs', { cache: 'no-store' }),
  groupMatrix: () => json<GroupMatrix>('/api/foundation/group-matrix', { cache: 'no-store' }),
  createChannelBot: (input: { id: string; externalAppId: string; displayName: string; brand: 'feishu' | 'lark' }) => send<PublicChannelBotFoundation>('POST', '/api/foundation/channel-bots', input),
  updateChannelBot: (id: string, input: UpdateChannelBotInput) => send<PublicChannelBotFoundation>('PATCH', `/api/foundation/channel-bots/${encodeURIComponent(id)}`, input),
  createGroupBinding: (input: CreateGroupBindingInput) => send<GroupBinding>('POST', '/api/foundation/group-bindings', input),
  updateGroupBinding: (id: string, input: UpdateGroupBindingInput) => send<GroupBinding>('PATCH', `/api/foundation/group-bindings/${encodeURIComponent(id)}`, input)
};

export const scheduleApi = {
  capabilities: () => json<ScheduleCapability>('/api/foundation/schedules/capabilities', { cache: 'no-store' }),
  list: () => json<ScheduleList>('/api/foundation/schedules', { cache: 'no-store' }),
  preview: (id: string, after?: string) => json<{ scheduleId: string; preview?: SchedulePreview; executionEligible: false; blockers: ScheduleBlocker[] }>(`/api/foundation/schedules/${encodeURIComponent(id)}/preview${after ? `?after=${encodeURIComponent(after)}` : ''}`, { cache: 'no-store' }),
  update: (id: string, input: UpdateScheduleDefinitionInput) => send<ScheduleDetail>('PATCH', `/api/foundation/schedules/${encodeURIComponent(id)}`, input),
  archivedIntegrations: (channelBotId: string) => json<{ integrations: ArchivedHammerIntegration[] }>(`/api/foundation/schedules/archived-integrations?channelBotId=${encodeURIComponent(channelBotId)}`, { cache: 'no-store' })
};
