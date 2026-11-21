import { collaborationParticipationModes, LEGACY_MENTION_POLICY } from './collaboration.js';
import { riskControlModes } from './configuration-primitives.js';
import { groupReplyModes, mentionPolicies } from './group-policy.js';
import type { StoredLarkConfig } from './lark-config.js';

/** Defaults describe stored settings. A sparse field may have a different display default. */
type Field = {
  kind: 'boolean' | 'integer' | 'string' | 'enum';
  default: boolean | number | string | undefined;
  unit?: 'ms' | 'hours';
  clearable?: 'null' | 'empty';
  values?: readonly string[];
  min?: number;
  max?: number;
  legacyOptional?: true;
  displayDefault?: string | number;
  requiresStringInput?: true;
  contextual?: true;
};
const on = { kind: 'boolean', default: true } as const;
const off = { kind: 'boolean', default: false } as const;
const text = { kind: 'string', default: undefined, clearable: 'empty' } as const;
const strictText = { ...text, requiresStringInput: true } as const;
const count = { kind: 'integer', default: undefined, clearable: 'null', min: 1 } as const;

// CLI help displays these in declaration order. Plain strings only describe CLI syntax:
// domain validation and serialization for these complex or specialized inputs stay on the server.
type ManualKind = 'json' | 'list' | 'users' | 'string';
type CliOnlyKey = 'allowedUserNames' | 'allowedBotNames' | 'highRiskAllowedUserNames';
const settings = {
  cardLinks: 'json',
  eventHandlers: 'json',
  cardActionForwarding: 'json',
  welcomeEnabled: { ...on, legacyOptional: true },
  workspace: strictText,
  workspaceAliases: 'json',
  webBaseUrl: { ...text, contextual: true },
  webMobileReachable: { ...on, default: undefined, contextual: true },
  displayName: text,
  brand: { kind: 'enum', values: ['feishu', 'lark'], default: undefined },
  defaultAgentId: { kind: 'string', default: undefined, contextual: true },
  fallbackAgentId: { ...text, contextual: true },
  fallbackModel: { ...text, contextual: true },
  defaultAgentWeights: 'json',
  defaultModel: strictText,
  defaultReasoningEffort: strictText,
  permissionMode: { kind: 'enum', values: ['ask', 'approve-reads', 'full-trust'], default: 'approve-reads', contextual: true },
  fullTrustConfirmed: off,
  roleTitle: text,
  roleScope: text,
  preInjectPrompt: { ...strictText, default: '' },
  verificationCommand: strictText,
  listening: off,
  mentionPolicy: { kind: 'enum', values: mentionPolicies, default: LEGACY_MENTION_POLICY, contextual: true },
  defaultGroupParticipation: { kind: 'enum', values: collaborationParticipationModes, default: 'off' },
  reactionTriggerEmoji: { ...text, contextual: true },
  p2pMode: { kind: 'enum', values: ['chat', 'thread'], default: undefined, displayDefault: 'chat' },
  groupReplyMode: { kind: 'enum', values: groupReplyModes, default: undefined, clearable: 'null' },
  idleCompactEnabled: on,
  idleCompactHours: { kind: 'integer', default: 24, min: 1, max: Number.MAX_SAFE_INTEGER, unit: 'hours' },
  groupToolsEnabled: off,
  groupToolsAllowSend: { ...off, contextual: true },
  memoryEnabled: { ...off, legacyOptional: true, contextual: true },
  memoryAutoExtract: { ...on, legacyOptional: true },
  groupMemoryScope: { kind: 'enum', values: ['shared', 'per-group'], default: 'shared', legacyOptional: true },
  claudeAutoMemory: { kind: 'enum', values: ['inherit', 'off'], default: undefined, displayDefault: 'inherit', legacyOptional: true },
  memoryAgentId: strictText,
  memoryModel: strictText,
  busyTriage: off,
  botLoopGuard: { ...off, legacyOptional: true },
  decisionAgentId: strictText,
  decisionModel: strictText,
  responseAgentId: strictText,
  responseModel: strictText,
  replyPolishEnabled: off,
  replyPolishAgentId: text,
  replyPolishModel: { ...text, contextual: true },
  replyPolishTimeoutMs: { ...count, unit: 'ms', max: 2_147_483_647, displayDefault: 60_000 },
  executionMode: { kind: 'enum', values: ['single', 'layered'], default: undefined, displayDefault: 'single', legacyOptional: true },
  leaderAgentId: strictText,
  workerAgentIds: 'list',
  leaderSkill: { ...text, max: 300 },
  structuredAskCards: { ...on, legacyOptional: true },
  groupCardMention: { ...on, legacyOptional: true },
  pushIntervalMs: { kind: 'integer', default: 1_000, unit: 'ms', min: 500, max: 20_000 },
  traceLimit: { ...count, default: 50 },
  hideTraceOnComplete: on,
  compactTrace: { ...on, legacyOptional: true },
  showAgentName: { ...off, legacyOptional: true },
  completionReactionOnly: { ...off, legacyOptional: true },
  silentProgress: { ...off, legacyOptional: true },
  adhdMode: { ...off, legacyOptional: true },
  urgentEnabled: { ...off, legacyOptional: true },
  urgentThresholdMs: { ...count, unit: 'ms', min: 60_000 },
  urgentMaxPerHourPerChat: count,
  notifyMentionAction: { ...on, legacyOptional: true },
  notifyMentionDone: { ...on, legacyOptional: true },
  notifyQuietHours: { ...text, contextual: true },
  pinLongTasks: { ...off, legacyOptional: true },
  pinAfterMs: { ...count, unit: 'ms', min: 1_000 },
  allowedUsers: 'users',
  allowedUserNames: 'list',
  allowedEmails: 'list',
  allowedBots: 'users',
  allowedBotNames: 'list',
  peerBotsAllowed: on,
  highRiskAllowedUsers: 'users',
  highRiskAllowedUserNames: 'list',
  highRiskAllowedEmails: 'list',
  highRiskPattern: 'string',
  riskControlMode: { kind: 'enum', values: riskControlModes, default: 'off', contextual: true },
} as const satisfies { [K in keyof StoredLarkConfig]?: (Field & { default: StoredLarkConfig[K] | undefined }) | ManualKind } & Record<CliOnlyKey, ManualKind>;

type Settings = typeof settings;
export type BotSettingKey = { [K in keyof Settings]: Settings[K] extends Field ? K : never }[keyof Settings];
type IndependentKey = { [K in BotSettingKey]: Settings[K] extends { contextual: true } ? never : K }[BotSettingKey];
const entries = Object.entries(settings);
const scalarEntries = entries.filter(([, field]) => typeof field === 'object');
export const botSettingDescriptors = Object.fromEntries(scalarEntries) as Pick<Settings, BotSettingKey>;
// Contextual settings need another field, a domain parser or legacy flags to resolve their value.
export const independentBotSettingFields = Object.fromEntries(
  scalarEntries.filter(([, field]) => typeof field === 'object' && !('contextual' in field))
) as Pick<Settings, IndependentKey>;

export type LegacyOptionalBotSetting = {
  [K in BotSettingKey]: (typeof botSettingDescriptors)[K] extends { legacyOptional: true } ? K : never
}[BotSettingKey];

export type ScalarSettingCliKind = Exclude<Field['kind'], 'enum'> | 'integer|null' | readonly string[];
export const botSettingCliFields = Object.fromEntries(entries.map(([key, field]) => {
  if (typeof field === 'string') return [key, field];
  if (key === 'groupReplyMode') return [key, [...groupReplyModes, 'auto']];
  if (field.kind === 'enum') return [key, field.values];
  if (field.kind === 'integer' && 'clearable' in field) return [key, 'integer|null'];
  return [key, field.kind];
})) as Record<keyof Settings, ScalarSettingCliKind | ManualKind>;
