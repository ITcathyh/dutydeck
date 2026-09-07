import { z } from 'zod';

const timestampSchema = z.string().datetime();
const opaquePrincipalIdSchema = z.string().regex(/^principal_[A-Za-z0-9_-]+$/, 'Principal IDs must be opaque principal_* identifiers');
const irreversibleFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Fingerprint must be a lowercase SHA-256 digest');
const opaqueRemoteBotRefSchema = z.string().regex(/^remote_bot_[a-f0-9]{24,64}$/, 'Bot identity references must be opaque remote_bot_* identifiers');
const opaqueRemoteTenantRefSchema = z.string().regex(/^remote_tenant_[a-f0-9]{24,64}$/, 'Tenant references must be opaque remote_tenant_* identifiers');
const remoteFactErrorCodeSchema = z.string().regex(/^[A-Z0-9_]+$/);
export const REMOTE_FACT_EXPIRED_AT = '1970-01-01T00:00:00.000Z';

export const groupReplyModes = ['chat', 'shared', 'new-topic', 'chat-topic'] as const;
export const mentionPolicies = ['always', 'topic', 'never', 'ambient'] as const;
export const groupBindingStates = ['staged', 'disabled', 'needs_review', 'archived'] as const;
export const groupToolOverrideModes = ['inherit', 'allow', 'deny'] as const;
export const roleKinds = ['can_talk', 'can_operate', 'admin'] as const;
export const operateScopes = ['none', 'own_runs', 'group_runs', 'bot_runs'] as const;

const inheritStringOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('set'), value: z.string().min(1) }).strict()
]);
const clearableStringOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('set'), value: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('clear') }).strict()
]);
const groupReplyOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('set'), value: z.enum(groupReplyModes) }).strict()
]);
const mentionOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('set'), value: z.enum(mentionPolicies) }).strict()
]);

export const routingOverrideSchema = z.object({
  groupReplyMode: groupReplyOverrideSchema,
  mentionPolicy: mentionOverrideSchema
}).strict();

export const accessOverrideSchema = z.object({
  mode: z.enum(['inherit', 'owner_only', 'allowlist', 'all_chat_members', 'disabled']),
  principalIds: z.array(opaquePrincipalIdSchema).default([])
}).strict().superRefine((value, context) => {
  if (value.mode !== 'allowlist' && value.principalIds.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['principalIds'], message: 'principalIds are only valid in allowlist mode' });
  }
  if (value.mode === 'allowlist' && value.principalIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['principalIds'], message: 'allowlist mode requires at least one principal' });
  }
});

export const groupToolsOverrideSchema = z.object({
  read: z.enum(groupToolOverrideModes),
  discover: z.enum(groupToolOverrideModes),
  send: z.enum(groupToolOverrideModes)
}).strict();

export const groupBindingSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  channelBotId: z.string().min(1),
  externalChatId: z.string().min(1),
  state: z.enum(groupBindingStates),
  oncall: z.boolean(),
  agentOverride: inheritStringOverrideSchema,
  workspaceOverride: inheritStringOverrideSchema,
  modelOverride: clearableStringOverrideSchema,
  reasoningOverride: clearableStringOverrideSchema,
  rolePolicyOverride: clearableStringOverrideSchema,
  routingOverride: routingOverrideSchema,
  accessOverride: accessOverrideSchema,
  groupToolsOverride: groupToolsOverrideSchema,
  presentationOverride: z.object({ mode: z.literal('inherit') }).strict(),
  reviewReasons: z.array(z.string().regex(/^[a-z0-9_]+$/)),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();
export type GroupBinding = z.infer<typeof groupBindingSchema>;

export const createGroupBindingInputSchema = z.object({
  id: z.string().min(1),
  channelBotId: z.string().min(1),
  externalChatId: z.string().min(1),
  oncall: z.boolean().default(false),
  agentOverride: inheritStringOverrideSchema.default({ mode: 'inherit' }),
  workspaceOverride: inheritStringOverrideSchema.default({ mode: 'inherit' }),
  modelOverride: clearableStringOverrideSchema.default({ mode: 'inherit' }),
  reasoningOverride: clearableStringOverrideSchema.default({ mode: 'inherit' }),
  rolePolicyOverride: clearableStringOverrideSchema.default({ mode: 'inherit' }),
  routingOverride: routingOverrideSchema.default({ groupReplyMode: { mode: 'inherit' }, mentionPolicy: { mode: 'inherit' } }),
  accessOverride: accessOverrideSchema.default({ mode: 'inherit', principalIds: [] }),
  groupToolsOverride: groupToolsOverrideSchema.default({ read: 'inherit', discover: 'inherit', send: 'inherit' }),
  reviewReasons: z.array(z.string().regex(/^[a-z0-9_]+$/)).default([])
}).strict();
export type CreateGroupBindingInput = z.input<typeof createGroupBindingInputSchema>;

export const updateGroupBindingInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  state: z.enum(groupBindingStates).optional(),
  oncall: z.boolean().optional(),
  agentOverride: inheritStringOverrideSchema.optional(),
  workspaceOverride: inheritStringOverrideSchema.optional(),
  modelOverride: clearableStringOverrideSchema.optional(),
  reasoningOverride: clearableStringOverrideSchema.optional(),
  rolePolicyOverride: clearableStringOverrideSchema.optional(),
  routingOverride: routingOverrideSchema.optional(),
  accessOverride: accessOverrideSchema.optional(),
  groupToolsOverride: groupToolsOverrideSchema.optional(),
  reviewReasons: z.array(z.string().regex(/^[a-z0-9_]+$/)).optional()
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });
export type UpdateGroupBindingInput = z.infer<typeof updateGroupBindingInputSchema>;

export const channelBotGroupPolicySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  channelBotId: z.string().min(1),
  defaults: z.object({
    agentDefinitionId: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
    rolePolicyRef: z.string().min(1).optional()
  }).strict(),
  routingDefaults: z.object({ groupReplyMode: z.enum(groupReplyModes), mentionPolicy: z.enum(mentionPolicies) }).strict(),
  accessPolicy: z.object({
    mode: z.enum(['owner_only', 'allowlist', 'open']),
    principalIds: z.array(opaquePrincipalIdSchema)
  }).strict().superRefine((value, context) => {
    if (value.mode !== 'allowlist' && value.principalIds.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['principalIds'], message: 'principalIds are only valid in allowlist mode' });
    if (value.mode === 'allowlist' && value.principalIds.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['principalIds'], message: 'allowlist mode requires at least one principal' });
  }),
  groupToolsPolicy: z.object({
    readCeiling: z.boolean(),
    discoverCeiling: z.boolean(),
    sendCeiling: z.boolean(),
    readDefault: z.boolean(),
    discoverDefault: z.boolean(),
    sendDefault: z.boolean()
  }).strict().superRefine((value, context) => {
    for (const tool of ['read', 'discover', 'send'] as const) {
      if (value[`${tool}Default`] && !value[`${tool}Ceiling`]) context.addIssue({ code: z.ZodIssueCode.custom, path: [`${tool}Default`], message: `${tool} default cannot exceed its ceiling` });
    }
  }),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();
export type ChannelBotGroupPolicy = z.infer<typeof channelBotGroupPolicySchema>;

export const safeChannelBotGroupPolicyDefaults = {
  defaults: {},
  routingDefaults: { groupReplyMode: 'chat', mentionPolicy: 'always' },
  accessPolicy: { mode: 'owner_only', principalIds: [] },
  groupToolsPolicy: { readCeiling: false, discoverCeiling: false, sendCeiling: false, readDefault: false, discoverDefault: false, sendDefault: false }
} as const;

export const createChannelBotGroupPolicyInputSchema = channelBotGroupPolicySchema.pick({
  id: true,
  channelBotId: true,
  defaults: true,
  routingDefaults: true,
  accessPolicy: true,
  groupToolsPolicy: true
}).strict();
export type CreateChannelBotGroupPolicyInput = z.infer<typeof createChannelBotGroupPolicyInputSchema>;

export const updateChannelBotGroupPolicyInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  defaults: channelBotGroupPolicySchema.shape.defaults.optional(),
  routingDefaults: channelBotGroupPolicySchema.shape.routingDefaults.optional(),
  accessPolicy: channelBotGroupPolicySchema.shape.accessPolicy.optional(),
  groupToolsPolicy: channelBotGroupPolicySchema.shape.groupToolsPolicy.optional()
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });
export type UpdateChannelBotGroupPolicyInput = z.infer<typeof updateChannelBotGroupPolicyInputSchema>;

const remoteChatFactObjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  channelBotId: z.string().min(1),
  externalChatId: z.string().min(1),
  membershipState: z.enum(['member', 'not_member', 'inaccessible', 'unknown']),
  chatType: z.enum(['group', 'topic_group', 'unknown']),
  displayName: z.string().min(1).optional(),
  observedAt: timestampSchema,
  lastSuccessAt: timestampSchema.optional(),
  errorCode: remoteFactErrorCodeSchema.optional(),
  credentialRefId: z.string().min(1).optional(),
  credentialRevision: z.number().int().positive().optional(),
  credentialFingerprint: irreversibleFingerprintSchema.optional(),
  identityFactId: z.string().min(1).optional(),
  identityRevision: z.number().int().positive().optional(),
  expiresAt: timestampSchema,
  invalidatedAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();
export const remoteChatFactSchema = remoteChatFactObjectSchema.superRefine((value, context) => {
  const bindings = [value.credentialRefId, value.credentialRevision, value.credentialFingerprint, value.identityFactId, value.identityRevision];
  if (bindings.some(item => item !== undefined) && bindings.some(item => item === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialRefId'], message: 'Credential and identity bindings must be complete or absent' });
  }
});
export type RemoteChatFact = z.infer<typeof remoteChatFactSchema>;

export const createRemoteChatFactInputSchema = remoteChatFactObjectSchema.pick({
  id: true,
  channelBotId: true,
  externalChatId: true,
  membershipState: true,
  chatType: true,
  displayName: true,
  observedAt: true,
  lastSuccessAt: true,
  errorCode: true
}).extend({ expiresAt: timestampSchema.default(REMOTE_FACT_EXPIRED_AT) }).strict();
export type CreateRemoteChatFactInput = z.input<typeof createRemoteChatFactInputSchema>;

export const updateRemoteChatFactInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  membershipState: remoteChatFactObjectSchema.shape.membershipState.optional(),
  chatType: remoteChatFactObjectSchema.shape.chatType.optional(),
  displayName: z.string().min(1).nullable().optional(),
  observedAt: timestampSchema.optional(),
  lastSuccessAt: timestampSchema.nullable().optional(),
  errorCode: remoteFactErrorCodeSchema.nullable().optional(),
  expiresAt: timestampSchema.optional(),
  invalidatedAt: timestampSchema.nullable().optional()
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });
export type UpdateRemoteChatFactInput = z.infer<typeof updateRemoteChatFactInputSchema>;

const remoteIdentityFactObjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  channelBotId: z.string().min(1),
  credentialRefId: z.string().min(1),
  credentialRevision: z.number().int().positive(),
  credentialFingerprint: irreversibleFingerprintSchema,
  appFingerprint: irreversibleFingerprintSchema,
  botIdentityRef: opaqueRemoteBotRefSchema,
  tenantRef: opaqueRemoteTenantRefSchema.optional(),
  appIdMatch: z.boolean(),
  checkedAt: timestampSchema,
  expiresAt: timestampSchema,
  errorCode: remoteFactErrorCodeSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();
export const remoteIdentityFactSchema = remoteIdentityFactObjectSchema.superRefine((value, context) => {
  if (Date.parse(value.expiresAt) < Date.parse(value.checkedAt)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'Identity fact expiry cannot precede its check time' });
  if (!value.appIdMatch && !value.errorCode) context.addIssue({ code: z.ZodIssueCode.custom, path: ['errorCode'], message: 'App mismatch requires an error code' });
});
export type RemoteIdentityFact = z.infer<typeof remoteIdentityFactSchema>;

export const upsertRemoteIdentityFactInputSchema = remoteIdentityFactObjectSchema.pick({
  id: true, channelBotId: true, credentialRefId: true, credentialRevision: true, credentialFingerprint: true,
  appFingerprint: true, botIdentityRef: true, tenantRef: true, appIdMatch: true, checkedAt: true, expiresAt: true, errorCode: true
}).extend({ expectedRevision: z.number().int().nonnegative() }).strict();
export type UpsertRemoteIdentityFactInput = z.infer<typeof upsertRemoteIdentityFactInputSchema>;

export const upsertRemoteChatFactInputSchema = remoteChatFactObjectSchema.pick({
  id: true, channelBotId: true, externalChatId: true, membershipState: true, chatType: true, displayName: true,
  observedAt: true, lastSuccessAt: true, errorCode: true, credentialRefId: true, credentialRevision: true,
  credentialFingerprint: true, identityFactId: true, identityRevision: true, expiresAt: true
}).extend({
  expectedRevision: z.number().int().nonnegative(),
  credentialRefId: z.string().min(1),
  credentialRevision: z.number().int().positive(),
  credentialFingerprint: irreversibleFingerprintSchema,
  identityFactId: z.string().min(1),
  identityRevision: z.number().int().positive(),
  expiresAt: timestampSchema
}).strict();
export type UpsertRemoteChatFactInput = z.infer<typeof upsertRemoteChatFactInputSchema>;

export const invalidateRemoteFactInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  invalidatedAt: timestampSchema,
  errorCode: remoteFactErrorCodeSchema
}).strict();
export type InvalidateRemoteFactInput = z.infer<typeof invalidateRemoteFactInputSchema>;

export const publicRemoteIdentityFactSchema = remoteIdentityFactObjectSchema.pick({
  schemaVersion: true, id: true, revision: true, channelBotId: true, botIdentityRef: true, tenantRef: true,
  appIdMatch: true, checkedAt: true, expiresAt: true, errorCode: true, createdAt: true, updatedAt: true
}).extend({ validity: z.enum(['valid', 'expired', 'app_mismatch', 'error']) }).strict();
export type PublicRemoteIdentityFact = z.infer<typeof publicRemoteIdentityFactSchema>;

export function toPublicRemoteIdentityFact(fact: RemoteIdentityFact, now = new Date()): PublicRemoteIdentityFact {
  const validity = !fact.appIdMatch ? 'app_mismatch' : new Date(fact.expiresAt) <= now ? 'expired' : fact.errorCode ? 'error' : 'valid';
  return publicRemoteIdentityFactSchema.parse({
    schemaVersion: fact.schemaVersion, id: fact.id, revision: fact.revision, channelBotId: fact.channelBotId,
    botIdentityRef: fact.botIdentityRef, tenantRef: fact.tenantRef, appIdMatch: fact.appIdMatch,
    checkedAt: fact.checkedAt, expiresAt: fact.expiresAt, errorCode: fact.errorCode,
    createdAt: fact.createdAt, updatedAt: fact.updatedAt, validity
  });
}

export const publicRemoteChatFactSchema = remoteChatFactObjectSchema.pick({
  schemaVersion: true, id: true, revision: true, channelBotId: true, membershipState: true, chatType: true,
  observedAt: true, lastSuccessAt: true, errorCode: true, identityRevision: true, credentialRevision: true,
  expiresAt: true, invalidatedAt: true, createdAt: true, updatedAt: true
}).extend({ validity: z.enum(['valid', 'unknown', 'expired', 'invalidated', 'identity_mismatch', 'credential_mismatch', 'app_mismatch']) }).strict();
export type PublicRemoteChatFact = z.infer<typeof publicRemoteChatFactSchema>;

export function remoteChatFactValidity(fact: RemoteChatFact, identity: RemoteIdentityFact | undefined, now = new Date()): PublicRemoteChatFact['validity'] {
  if (fact.invalidatedAt) return 'invalidated';
  if (new Date(fact.expiresAt) <= now) return 'expired';
  if (!fact.credentialRefId || !fact.credentialRevision || !fact.credentialFingerprint || !fact.identityFactId || !fact.identityRevision) return 'unknown';
  if (!identity || identity.id !== fact.identityFactId || identity.revision !== fact.identityRevision || identity.channelBotId !== fact.channelBotId) return 'identity_mismatch';
  if (!identity.appIdMatch) return 'app_mismatch';
  if (identity.credentialRefId !== fact.credentialRefId || identity.credentialRevision !== fact.credentialRevision || identity.credentialFingerprint !== fact.credentialFingerprint) return 'credential_mismatch';
  if (new Date(identity.expiresAt) <= now || identity.errorCode) return 'identity_mismatch';
  return 'valid';
}

export function toPublicRemoteChatFact(fact: RemoteChatFact, identity: RemoteIdentityFact | undefined, now = new Date()): PublicRemoteChatFact {
  return publicRemoteChatFactSchema.parse({
    schemaVersion: fact.schemaVersion, id: fact.id, revision: fact.revision, channelBotId: fact.channelBotId,
    membershipState: fact.membershipState, chatType: fact.chatType, observedAt: fact.observedAt,
    lastSuccessAt: fact.lastSuccessAt, errorCode: fact.errorCode, identityRevision: fact.identityRevision,
    credentialRevision: fact.credentialRevision, expiresAt: fact.expiresAt, invalidatedAt: fact.invalidatedAt,
    createdAt: fact.createdAt, updatedAt: fact.updatedAt, validity: remoteChatFactValidity(fact, identity, now)
  });
}

const actionGatesSchema = z.object({ terminalWrite: z.boolean(), highRisk: z.boolean(), groupToolsSend: z.boolean() }).strict();

export const roleAssignmentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  channelBotId: z.string().min(1),
  groupBindingId: z.string().min(1).optional(),
  principalId: opaquePrincipalIdSchema,
  role: z.enum(roleKinds),
  operateScope: z.enum(operateScopes),
  actionGates: actionGatesSchema,
  state: z.enum(['active', 'revoked']),
  expiresAt: timestampSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict().superRefine((value, context) => {
  if (value.role !== 'can_operate' && value.operateScope !== 'none') context.addIssue({ code: z.ZodIssueCode.custom, path: ['operateScope'], message: 'Only can_operate assignments may have an operate scope' });
  if (value.role === 'can_operate' && value.operateScope === 'none') context.addIssue({ code: z.ZodIssueCode.custom, path: ['operateScope'], message: 'can_operate requires an explicit scope' });
});
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

export const createRoleAssignmentInputSchema = z.object({
  id: z.string().min(1),
  channelBotId: z.string().min(1),
  groupBindingId: z.string().min(1).optional(),
  principalId: opaquePrincipalIdSchema,
  role: z.enum(roleKinds),
  operateScope: z.enum(operateScopes),
  actionGates: actionGatesSchema.default({ terminalWrite: false, highRisk: false, groupToolsSend: false }),
  expiresAt: timestampSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.role !== 'can_operate' && value.operateScope !== 'none') context.addIssue({ code: z.ZodIssueCode.custom, path: ['operateScope'], message: 'Only can_operate assignments may have an operate scope' });
  if (value.role === 'can_operate' && value.operateScope === 'none') context.addIssue({ code: z.ZodIssueCode.custom, path: ['operateScope'], message: 'can_operate requires an explicit scope' });
});
export type CreateRoleAssignmentInput = z.input<typeof createRoleAssignmentInputSchema>;

export const updateRoleAssignmentInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  operateScope: z.enum(operateScopes).optional(),
  actionGates: actionGatesSchema.optional(),
  state: z.enum(['active', 'revoked']).optional(),
  expiresAt: timestampSchema.nullable().optional()
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });
export type UpdateRoleAssignmentInput = z.infer<typeof updateRoleAssignmentInputSchema>;

export interface ExplainedValue<T> { value: T | undefined; source: 'group_override' | 'group_clear' | 'bot_default' | 'system_default' | 'unconfigured' }
export interface EffectiveGroupConfig {
  agent: ExplainedValue<string>;
  workspace: ExplainedValue<string>;
  model: ExplainedValue<string>;
  reasoningEffort: ExplainedValue<string>;
  rolePolicyRef: ExplainedValue<string>;
  routing: {
    groupReplyMode: ExplainedValue<(typeof groupReplyModes)[number]>;
    mentionPolicy: ExplainedValue<(typeof mentionPolicies)[number]>;
  };
  access: { mode: 'owner_only' | 'allowlist' | 'all_chat_members' | 'disabled'; principalIds: string[]; source: 'group_override' | 'bot_default' };
  groupTools: Record<'read' | 'discover' | 'send', { allowed: boolean; source: 'group_override' | 'bot_default' | 'bot_ceiling'; requested: boolean }>;
  talkGrant: 'none' | 'owner_only' | 'allowlist' | 'all_chat_members' | 'oncall_chat_members';
  explanations: string[];
}

function resolveStringOverride(override: { mode: 'inherit' | 'set' | 'clear'; value?: string }, fallback?: string): ExplainedValue<string> {
  if (override.mode === 'set') return { value: override.value, source: 'group_override' };
  if (override.mode === 'clear') return { value: undefined, source: 'group_clear' };
  return fallback ? { value: fallback, source: 'bot_default' } : { value: undefined, source: 'unconfigured' };
}

export function resolveGroupEffectiveConfig(policy: ChannelBotGroupPolicy | undefined, binding: GroupBinding): EffectiveGroupConfig {
  const defaults: ChannelBotGroupPolicy['defaults'] = policy?.defaults ?? safeChannelBotGroupPolicyDefaults.defaults;
  const routingDefaults = policy?.routingDefaults ?? safeChannelBotGroupPolicyDefaults.routingDefaults;
  const accessDefault = policy?.accessPolicy ?? safeChannelBotGroupPolicyDefaults.accessPolicy;
  const toolPolicy = policy?.groupToolsPolicy ?? safeChannelBotGroupPolicyDefaults.groupToolsPolicy;
  const access = binding.accessOverride.mode === 'inherit'
    ? { mode: accessDefault.mode === 'open' ? 'all_chat_members' as const : accessDefault.mode, principalIds: [...accessDefault.principalIds], source: 'bot_default' as const }
    : { mode: binding.accessOverride.mode, principalIds: [...binding.accessOverride.principalIds], source: 'group_override' as const };
  const tool = (name: 'read' | 'discover' | 'send') => {
    const override = binding.groupToolsOverride[name];
    const requested = override === 'allow' ? true : override === 'deny' ? false : toolPolicy[`${name}Default`];
    const ceiling = toolPolicy[`${name}Ceiling`];
    return { allowed: ceiling && requested, requested, source: !ceiling && requested ? 'bot_ceiling' as const : override === 'inherit' ? 'bot_default' as const : 'group_override' as const };
  };
  const groupReplyMode = binding.routingOverride.groupReplyMode.mode === 'set'
    ? { value: binding.routingOverride.groupReplyMode.value, source: 'group_override' as const }
    : { value: routingDefaults.groupReplyMode, source: policy ? 'bot_default' as const : 'system_default' as const };
  const mentionPolicy = binding.routingOverride.mentionPolicy.mode === 'set'
    ? { value: binding.routingOverride.mentionPolicy.value, source: 'group_override' as const }
    : { value: routingDefaults.mentionPolicy, source: policy ? 'bot_default' as const : 'system_default' as const };
  const talkGrant = access.mode === 'disabled' ? 'none' : binding.oncall ? 'oncall_chat_members' : access.mode;
  return {
    agent: resolveStringOverride(binding.agentOverride, defaults.agentDefinitionId),
    workspace: resolveStringOverride(binding.workspaceOverride, defaults.workspace),
    model: resolveStringOverride(binding.modelOverride, defaults.model),
    reasoningEffort: resolveStringOverride(binding.reasoningOverride, defaults.reasoningEffort),
    rolePolicyRef: resolveStringOverride(binding.rolePolicyOverride, defaults.rolePolicyRef),
    routing: { groupReplyMode, mentionPolicy },
    access,
    groupTools: { read: tool('read'), discover: tool('discover'), send: tool('send') },
    talkGrant,
    explanations: [
      `Agent: ${binding.agentOverride.mode === 'inherit' ? '继承 Bot 默认' : '使用群级覆盖'}`,
      `回复: ${groupReplyMode.value}（${groupReplyMode.source}）`,
      `提及: ${mentionPolicy.value}（${mentionPolicy.source}）`,
      `群工具 send: ${tool('send').allowed ? '允许' : '禁用'}（${tool('send').source}）`
    ]
  };
}

export const policyActions = [
  'task.create', 'turn.append', 'task.view_result',
  'queue.cancel', 'queue.promote', 'queue.reorder',
  'run.interrupt', 'run.pause', 'run.resume', 'run.retry', 'run.restart',
  'terminal.read', 'terminal.write',
  'run.change_agent', 'run.change_cwd', 'run.change_model', 'run.change_backend', 'run.change_permission',
  'group_binding.update', 'channel_bot.update', 'grant.create', 'grant.revoke',
  'schedule.create', 'schedule.update', 'schedule.enable',
  'listener.enable', 'listener.disable',
  'cutover.start', 'cutover.rollback', 'cutover.finalize',
  'group_tools.read', 'group_tools.discover', 'group_tools.send',
  'high_risk.execute'
] as const;
export type PolicyAction = (typeof policyActions)[number];

export interface PolicyEvaluationInput {
  action: PolicyAction;
  now: string;
  /** Explain mode computes entitlement only; it must never be used as an execution gate. */
  mode?: 'enforce' | 'explain';
  /** Supplied only by the live Lark adapter after ownership, credentials and current group facts are verified. */
  runtimeActivation?: { source: 'live_lark'; channelBotId: string; groupBindingId: string };
  principal?: { id: string; channelBotId: string; isOwner: boolean; isChatMember: boolean };
  channelBot: { id: string; state: 'staged' | 'disabled' };
  binding?: GroupBinding;
  effectiveConfig?: EffectiveGroupConfig;
  assignments: RoleAssignment[];
  target?: { channelBotId: string; groupBindingId?: string; runOwnerPrincipalId?: string };
  sessionGroupTools?: { read: boolean; discover: boolean; send: boolean };
}
export interface PolicyDecision { allowed: boolean; action: PolicyAction; code: string; reason: string; source: 'explicit_deny' | 'owner' | 'admin' | 'role_assignment' | 'group_policy' | 'default_deny' | 'integration' }

const talkActions = new Set<PolicyAction>(['task.create', 'turn.append', 'task.view_result']);
const adminActions = new Set<PolicyAction>([
  'run.change_agent', 'run.change_cwd', 'run.change_model', 'run.change_backend', 'run.change_permission',
  'group_binding.update', 'channel_bot.update', 'grant.create', 'grant.revoke',
  'schedule.create', 'schedule.update', 'schedule.enable', 'listener.enable', 'listener.disable',
  'cutover.start', 'cutover.rollback', 'cutover.finalize'
]);
const runtimeActions = new Set<PolicyAction>(policyActions.filter(action => !adminActions.has(action) && action !== 'channel_bot.update' && action !== 'group_binding.update' && action !== 'grant.create' && action !== 'grant.revoke'));

function activeAssignments(input: PolicyEvaluationInput): RoleAssignment[] {
  if (!input.principal) return [];
  const now = Date.parse(input.now);
  return input.assignments.filter(assignment =>
    assignment.state === 'active'
    && assignment.channelBotId === input.channelBot.id
    && assignment.principalId === input.principal!.id
    && (!assignment.groupBindingId || assignment.groupBindingId === input.binding?.id)
    && (!assignment.expiresAt || Date.parse(assignment.expiresAt) > now)
  );
}

function operateScopeAllows(assignment: RoleAssignment, input: PolicyEvaluationInput): boolean {
  if (!input.principal || !input.target || input.target.channelBotId !== input.channelBot.id) return false;
  if (assignment.operateScope === 'bot_runs') return true;
  if (assignment.operateScope === 'group_runs') return Boolean(input.target.groupBindingId && input.target.groupBindingId === (assignment.groupBindingId ?? input.binding?.id));
  if (assignment.operateScope === 'own_runs') return input.target.runOwnerPrincipalId === input.principal.id;
  return false;
}

export function evaluatePolicyAction(input: PolicyEvaluationInput): PolicyDecision {
  const deny = (code: string, reason: string): PolicyDecision => ({ allowed: false, action: input.action, code, reason, source: 'explicit_deny' });
  if (!input.principal) return deny('principal_unresolved', 'Principal resolution is required');
  if (input.principal.channelBotId !== input.channelBot.id || (input.target && input.target.channelBotId !== input.channelBot.id)) return deny('scope_mismatch', 'Principal and target must belong to the same ChannelBot');
  const activated = input.runtimeActivation?.source === 'live_lark'
    && input.runtimeActivation.channelBotId === input.channelBot.id
    && input.runtimeActivation.groupBindingId === input.binding?.id
    && input.channelBot.state !== 'disabled';
  if (runtimeActions.has(input.action) && input.mode !== 'explain' && !activated) return deny('channel_bot_disabled', 'The ChannelBot is disabled and has no production execution integration');
  if (input.binding && ['disabled', 'archived', 'needs_review'].includes(input.binding.state) && !adminActions.has(input.action)) return deny('group_binding_disabled', 'The GroupBinding is not eligible for runtime actions');

  const assignments = activeAssignments(input);
  const isAdmin = input.principal.isOwner || assignments.some(assignment => assignment.role === 'admin');
  const operateAssignments = assignments.filter(assignment => assignment.role === 'can_operate' && operateScopeAllows(assignment, input));
  const hasOperate = operateAssignments.length > 0;
  const hasTalkAssignment = assignments.some(assignment => assignment.role === 'can_talk');
  const access = input.effectiveConfig?.access;
  const groupTalk = Boolean(input.binding && input.principal.isChatMember && access?.mode !== 'disabled' && (
    input.binding.oncall
    || access?.mode === 'all_chat_members'
    || (access?.mode === 'allowlist' && access.principalIds.includes(input.principal.id))
  ));

  if (adminActions.has(input.action)) {
    return isAdmin
      ? { allowed: true, action: input.action, code: 'allowed_admin', reason: 'Owner/admin management authority', source: input.principal.isOwner ? 'owner' : 'admin' }
      : { allowed: false, action: input.action, code: 'admin_required', reason: 'This action requires owner/admin authority', source: 'default_deny' };
  }
  if (input.action === 'terminal.write') {
    const gate = assignments.some(assignment => assignment.actionGates.terminalWrite);
    if (!gate) return deny('terminal_write_gate_required', 'terminal.write requires its independent action gate');
    if (!isAdmin && !hasOperate) return deny('operate_scope_required', 'terminal.write requires scoped operate authority');
  }
  if (input.action === 'high_risk.execute') {
    const gate = assignments.some(assignment => assignment.actionGates.highRisk);
    if (!gate) return deny('high_risk_gate_required', 'High-risk execution requires its independent action gate');
    if (!isAdmin && !hasOperate) return deny('operate_scope_required', 'High-risk execution requires scoped operate authority');
  }
  if (input.action.startsWith('group_tools.')) {
    const tool = input.action.slice('group_tools.'.length) as 'read' | 'discover' | 'send';
    if (!input.effectiveConfig?.groupTools[tool].allowed || !input.sessionGroupTools?.[tool]) return deny('group_tools_policy_denied', `group_tools.${tool} is denied by group/session policy`);
    if (tool === 'send' && !assignments.some(assignment => assignment.actionGates.groupToolsSend)) return deny('group_tools_send_gate_required', 'group_tools.send requires its independent action gate');
  }
  if (talkActions.has(input.action)) {
    if (isAdmin || hasOperate || hasTalkAssignment || groupTalk) return { allowed: true, action: input.action, code: 'allowed_talk', reason: 'Talk authority resolved from role or group policy', source: input.principal.isOwner ? 'owner' : isAdmin ? 'admin' : groupTalk ? 'group_policy' : 'role_assignment' };
    return { allowed: false, action: input.action, code: 'talk_required', reason: 'No can_talk source matched', source: 'default_deny' };
  }
  if (isAdmin || hasOperate) return { allowed: true, action: input.action, code: 'allowed_operate', reason: 'Scoped operate/admin authority', source: input.principal.isOwner ? 'owner' : isAdmin ? 'admin' : 'role_assignment' };
  return { allowed: false, action: input.action, code: 'operate_scope_required', reason: 'No scoped can_operate assignment matched', source: 'default_deny' };
}

export type PolicyEvaluator = (input: PolicyEvaluationInput) => PolicyDecision;
export function createFailClosedPolicyEvaluator(evaluator?: PolicyEvaluator): PolicyEvaluator {
  return evaluator ?? (input => ({ allowed: false, action: input.action, code: 'permission_evaluator_unwired', reason: 'No production permission evaluator is wired', source: 'integration' }));
}

export interface GroupBindingRepository {
  listByChannelBot(channelBotId: string, limit?: number): Promise<GroupBinding[]>;
  get(id: string): Promise<GroupBinding | undefined>;
  getByNaturalKey(channelBotId: string, externalChatId: string): Promise<GroupBinding | undefined>;
  create(input: CreateGroupBindingInput): Promise<GroupBinding>;
  update(id: string, input: UpdateGroupBindingInput): Promise<GroupBinding>;
}
export interface ChannelBotGroupPolicyRepository {
  list(limit?: number): Promise<ChannelBotGroupPolicy[]>;
  get(id: string): Promise<ChannelBotGroupPolicy | undefined>;
  getByChannelBot(channelBotId: string): Promise<ChannelBotGroupPolicy | undefined>;
  create(input: CreateChannelBotGroupPolicyInput): Promise<ChannelBotGroupPolicy>;
  update(id: string, input: UpdateChannelBotGroupPolicyInput): Promise<ChannelBotGroupPolicy>;
}
export interface RemoteChatFactRepository {
  listByChannelBot(channelBotId: string, limit?: number): Promise<RemoteChatFact[]>;
  get(id: string): Promise<RemoteChatFact | undefined>;
  getByNaturalKey(channelBotId: string, externalChatId: string): Promise<RemoteChatFact | undefined>;
  getCurrentByNaturalKey(channelBotId: string, externalChatId: string, now?: string): Promise<RemoteChatFact | undefined>;
  create(input: CreateRemoteChatFactInput): Promise<RemoteChatFact>;
  update(id: string, input: UpdateRemoteChatFactInput): Promise<RemoteChatFact>;
  upsert(input: UpsertRemoteChatFactInput): Promise<RemoteChatFact>;
  invalidate(id: string, input: InvalidateRemoteFactInput): Promise<RemoteChatFact>;
}
export interface RemoteIdentityFactRepository {
  list(limit?: number): Promise<RemoteIdentityFact[]>;
  get(id: string): Promise<RemoteIdentityFact | undefined>;
  getByChannelBot(channelBotId: string): Promise<RemoteIdentityFact | undefined>;
  getCurrentByChannelBot(channelBotId: string, now?: string): Promise<RemoteIdentityFact | undefined>;
  upsert(input: UpsertRemoteIdentityFactInput): Promise<RemoteIdentityFact>;
  invalidate(id: string, input: InvalidateRemoteFactInput): Promise<RemoteIdentityFact>;
}
export interface RoleAssignmentRepository {
  listByChannelBot(channelBotId: string, limit?: number): Promise<RoleAssignment[]>;
  get(id: string): Promise<RoleAssignment | undefined>;
  create(input: CreateRoleAssignmentInput): Promise<RoleAssignment>;
  update(id: string, input: UpdateRoleAssignmentInput): Promise<RoleAssignment>;
}

export interface GroupPolicyTransactionContext {
  config: { get(key: string): string | undefined; set(key: string, value: string): void };
  groupBindings: { get(id: string): GroupBinding | undefined; getByNaturalKey(channelBotId: string, externalChatId: string): GroupBinding | undefined; create(input: CreateGroupBindingInput): GroupBinding; update(id: string, input: UpdateGroupBindingInput): GroupBinding };
  channelBotPolicies: { get(id: string): ChannelBotGroupPolicy | undefined; getByChannelBot(channelBotId: string): ChannelBotGroupPolicy | undefined; create(input: CreateChannelBotGroupPolicyInput): ChannelBotGroupPolicy; update(id: string, input: UpdateChannelBotGroupPolicyInput): ChannelBotGroupPolicy };
  remoteChatFacts: { get(id: string): RemoteChatFact | undefined; getByNaturalKey(channelBotId: string, externalChatId: string): RemoteChatFact | undefined; getCurrentByNaturalKey(channelBotId: string, externalChatId: string, now?: string): RemoteChatFact | undefined; create(input: CreateRemoteChatFactInput): RemoteChatFact; update(id: string, input: UpdateRemoteChatFactInput): RemoteChatFact; upsert(input: UpsertRemoteChatFactInput): RemoteChatFact; invalidate(id: string, input: InvalidateRemoteFactInput): RemoteChatFact };
  remoteIdentityFacts: { get(id: string): RemoteIdentityFact | undefined; getByChannelBot(channelBotId: string): RemoteIdentityFact | undefined; getCurrentByChannelBot(channelBotId: string, now?: string): RemoteIdentityFact | undefined; upsert(input: UpsertRemoteIdentityFactInput): RemoteIdentityFact; invalidate(id: string, input: InvalidateRemoteFactInput): RemoteIdentityFact };
  roleAssignments: { get(id: string): RoleAssignment | undefined; create(input: CreateRoleAssignmentInput): RoleAssignment; update(id: string, input: UpdateRoleAssignmentInput): RoleAssignment };
}
export interface GroupPolicyRepository { transact<T>(work: (repositories: GroupPolicyTransactionContext) => T): Promise<T> }
export interface RemoteFactTransactionContext { remoteChatFacts: GroupPolicyTransactionContext['remoteChatFacts']; remoteIdentityFacts: GroupPolicyTransactionContext['remoteIdentityFacts'] }
export interface RemoteFactRepository { transact<T>(work: (repositories: RemoteFactTransactionContext) => T): Promise<T> }
