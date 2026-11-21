import type {
  BotPromptVersion,
  GroupBinding,
  LarkAppCreationJob,
  LarkHookDraft,
  LarkHookStatus,
  ManagedGroup,
  ManagedGroupBot,
  PublicLarkConfig,
  PublicLarkConfigCollection,
  SaveLarkConfigInput
} from '@dutydeck/shared';
import { json, send } from './client';

/**
 * 旧服务端可能不返回的字段：读取方按各自默认处理（记忆、自动提取、精简过程卡、问答卡、群内 @ 与提醒两档缺省开启，
 * 其余开关缺省关闭；群记忆范围按 shared、执行方式按 single）。
 */
type LarkBotConfigLegacyOptional = 'welcomeEnabled' | 'revision' | 'memoryEnabled' | 'memoryAutoExtract' | 'groupMemoryScope' | 'claudeAutoMemory' | 'botLoopGuard'
  | 'executionMode' | 'workerAgentIds' | 'structuredAskCards' | 'groupCardMention' | 'completionReactionOnly' | 'silentProgress' | 'adhdMode'
  | 'urgentEnabled' | 'notifyMentionAction' | 'notifyMentionDone' | 'pinLongTasks' | 'compactTrace' | 'showAgentName';
export type LarkBotConfig = Omit<PublicLarkConfig, LarkBotConfigLegacyOptional> & Partial<Pick<PublicLarkConfig, LarkBotConfigLegacyOptional>>;
export type LarkConfig = Omit<PublicLarkConfigCollection, 'bots'> & { bots: LarkBotConfig[] };
/** 保存请求体；成员按姓名提交，由服务端解析为 open_id。 */
export type SaveLarkConfigBody = SaveLarkConfigInput & { stage: 'lark' | 'agent'; allowedUserNames?: string[]; highRiskAllowedUserNames?: string[] };

export type RoleChange =
  | {
      kind: 'create';
      principalId: string;
      role: 'can_talk' | 'can_operate' | 'admin';
      operateScope: 'none' | 'own_runs' | 'group_runs' | 'bot_runs';
      actionGates: { terminalWrite: boolean; highRisk: boolean; groupToolsSend: boolean };
    }
  | {
      kind: 'update';
      id: string;
      expectedRevision: number;
      patch: {
        state?: 'active' | 'revoked';
        operateScope?: 'none' | 'own_runs' | 'group_runs' | 'bot_runs';
        actionGates?: { terminalWrite: boolean; highRisk: boolean; groupToolsSend: boolean };
      };
    };

export type GroupMember = {
  principalId: string;
  openId: string;
  name: string;
};

export type GroupMembersResult = {
  members: GroupMember[];
  pageToken?: string;
  hasMore?: boolean;
};

export type LarkOpenPlatformSetupJob = {
  id: string;
  appId: string;
  status: 'preparing' | 'waiting_for_scan' | 'configuring' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  qrDataUrl?: string;
  scanConfirmed?: boolean;
  accountName?: string;
  tenantName?: string;
  result?: { status: 'ready'; scopeCount: number; eventCount: number; callbackCount: number; versionId: string; skippedScopes?: string[] };
  slashCommands?: 'configured' | 'skipped_scope' | 'skipped_credentials' | 'failed';
  error?: string;
};

export type BotPromptHistory = { revision: number; unrecordedUsages?: Array<{ taskId: string; label: '未记录版本' }>; versions: Array<Omit<BotPromptVersion, 'text'> & { characters: number; current: boolean }> };

export const larkRequests = {
  larkInbox: (appId: string, since: string) => json<Array<{ messageId: string; receivedAt?: string; sender: string; snippet: string; reason?: string; detail: string; mergedInto?: string; decisionId?: string }>>(`/api/lark/inbox?${new URLSearchParams({ appId, since })}`),
  botPromptHistory: (appId: string) => json<BotPromptHistory>(`/api/lark/bots/${encodeURIComponent(appId)}/prompt-versions`),
  botPromptShow: (appId: string, version: number) => json<BotPromptVersion>(`/api/lark/bots/${encodeURIComponent(appId)}/prompt-versions/${version}`),
  botPromptDiff: (appId: string, a: number, b: number) => json<{ diff: string }>(`/api/lark/bots/${encodeURIComponent(appId)}/prompt-versions/diff?a=${a}&b=${b}`),
  botPromptRollback: (appId: string, version: number, expectedRevision: number) => send<LarkConfig>('POST', `/api/lark/bots/${encodeURIComponent(appId)}/prompt-versions/${version}/rollback`, { expectedRevision }),
  larkConfig: () => json<LarkConfig>('/api/lark/config'),
  startLarkOpenPlatformSetup: (appId: string, forceLogin = false) => send<LarkOpenPlatformSetupJob>('POST', '/api/lark/open-platform/configure', { appId, forceLogin }),
  larkOpenPlatformSetupJob: (jobId: string) => json<LarkOpenPlatformSetupJob>(`/api/lark/open-platform/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' }),
  createLarkApp: (input: { requestId: string; name: string; forceLogin?: boolean }) => send<LarkAppCreationJob>('POST', '/api/lark/apps/create', input),
  larkAppCreationJob: (jobId: string) => json<LarkAppCreationJob>(`/api/lark/apps/create/${encodeURIComponent(jobId)}`, { cache: 'no-store' }),
  cancelLarkAppCreation: (jobId: string) => json<LarkAppCreationJob>(`/api/lark/apps/create/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
  retryLarkAppCreation: (jobId: string, forceLogin = false) => send<LarkAppCreationJob>('POST', `/api/lark/apps/create/${encodeURIComponent(jobId)}/retry`, { forceLogin }),
  inspectLarkBot: (body: { appId: string; appSecret: string }) => send<{ appName: string; openId: string; avatarUrl?: string; activateStatus?: number }>('POST', '/api/lark/bot/inspect', body),
  saveLarkConfig: (body: SaveLarkConfigBody) => send<LarkConfig>('PUT', '/api/lark/config', body),
  deleteLarkConfig: (appId: string) => json<LarkConfig>(`/api/lark/config/${encodeURIComponent(appId)}`, { method: 'DELETE' }),
  managementGroups: () => json<{ groups: ManagedGroup[] }>('/api/lark/management/groups', { cache: 'no-store' }),
  syncGroups: (appId: string) => send<{ groups: ManagedGroup[]; error?: string }>('POST', `/api/lark/bots/${encodeURIComponent(appId)}/sync-groups`, {}),
  updateGroupBotBinding: (appId: string, chatId: string, body: { expectedRevision: number; patch: Partial<Pick<GroupBinding, 'agentOverride' | 'workspaceOverride' | 'modelOverride' | 'reasoningOverride' | 'routingOverride' | 'accessOverride' | 'groupToolsOverride' | 'presentationOverride' | 'oncall' | 'state'>>; roleChanges?: RoleChange[] }) => send<ManagedGroupBot>('PUT', `/api/lark/bots/${encodeURIComponent(appId)}/groups/${encodeURIComponent(chatId)}`, body),
  groupMembers: (appId: string, chatId: string, pageToken?: string) => json<GroupMembersResult>(`/api/lark/bots/${encodeURIComponent(appId)}/groups/${encodeURIComponent(chatId)}/members${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`, { cache: 'no-store' }),
  larkHookStatus: (appId: string, agentId?: string, workspace?: string) => {
    const query = new URLSearchParams({ appId });
    if (agentId) query.set('agentId', agentId);
    if (workspace !== undefined) query.set('workspace', workspace);
    return json<LarkHookStatus>(`/api/lark/hooks/status?${query.toString()}`);
  },
  installLarkHook: (appId: string, highRiskPattern: string, expectedRevision?: number, draft?: LarkHookDraft) => send<LarkHookStatus & { configRevision?: number }>('POST', '/api/lark/hooks/install', { appId, highRiskPattern, expectedRevision, ...(draft ? { draft } : {}) }),
};
