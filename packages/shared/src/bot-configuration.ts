import { z } from 'zod';
import {
  channelBotBrands,
  permissionModes,
  validateHighRiskPattern,
  type ChannelBotBrand,
  type PermissionMode
} from './configuration-primitives.js';
import type { SecretRefKind, SecretRefMetadata } from './index.js';
export type { SecretRefKind, SecretRefMetadata };
import {
  groupBindingStates,
  groupReplyModes,
  groupToolOverrideModes,
  inheritPresentationOverride,
  mentionPolicies,
  operateScopes,
  policyActions,
  presentationOverrideSchema,
  presentationSettingsSchema,
  roleAssignmentSchema,
  type PolicyAction,
  type RoleAssignment
} from './group-policy.js';
export { roleAssignmentSchema, presentationOverrideSchema, inheritPresentationOverride, type RoleAssignment };

export type GroupBindingState = (typeof groupBindingStates)[number];
export type GroupReplyMode = (typeof groupReplyModes)[number];
export type GroupToolOverrideMode = (typeof groupToolOverrideModes)[number];
export type MentionPolicy = (typeof mentionPolicies)[number];
export type OperateScope = (typeof operateScopes)[number];

export const timestampSchema = z.string().datetime();
export const opaquePrincipalIdSchema = z.string().regex(/^principal_[A-Za-z0-9_-]+$/, 'Principal IDs must be opaque principal_* identifiers');
export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Digest must be a lowercase SHA-256 64-hex string');

// ============================================================================
// 1. 身份选择器（IdentitySelector）严格判别联合
// ============================================================================

export const principalIdSelectorSchema = z.object({
  kind: z.literal('principal_id'),
  principalId: opaquePrincipalIdSchema
}).strict();
export type PrincipalIdSelector = z.infer<typeof principalIdSelectorSchema>;

export const openIdSelectorSchema = z.object({
  kind: z.literal('open_id'),
  externalAppId: z.string().min(1),
  openId: z.string().min(1)
}).strict();
export type OpenIdSelector = z.infer<typeof openIdSelectorSchema>;

export const emailSelectorSchema = z.object({
  kind: z.literal('email'),
  email: z.string().trim().email()
}).strict();
export type EmailSelector = z.infer<typeof emailSelectorSchema>;

export const mobileSelectorSchema = z.object({
  kind: z.literal('mobile'),
  mobile: z.string().trim().min(1)
}).strict();
export type MobileSelector = z.infer<typeof mobileSelectorSchema>;

export const unionIdSelectorSchema = z.object({
  kind: z.literal('union_id'),
  externalAppId: z.string().min(1),
  unionId: z.string().min(1)
}).strict();
export type UnionIdSelector = z.infer<typeof unionIdSelectorSchema>;

export const identitySelectorSchema = z.discriminatedUnion('kind', [
  principalIdSelectorSchema,
  openIdSelectorSchema,
  emailSelectorSchema,
  mobileSelectorSchema,
  unionIdSelectorSchema
]);
export type IdentitySelector = z.infer<typeof identitySelectorSchema>;

export function areIdentitySelectorsEqual(a: IdentitySelector, b: IdentitySelector): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'principal_id':
      return a.principalId === (b as PrincipalIdSelector).principalId;
    case 'open_id':
      return a.externalAppId === (b as OpenIdSelector).externalAppId && a.openId === (b as OpenIdSelector).openId;
    case 'email':
      return a.email.trim().toLowerCase() === (b as EmailSelector).email.trim().toLowerCase();
    case 'mobile':
      return a.mobile.trim() === (b as MobileSelector).mobile.trim();
    case 'union_id':
      return a.externalAppId === (b as UnionIdSelector).externalAppId && a.unionId === (b as UnionIdSelector).unionId;
  }
}

export function normalizeIdentitySelector(selector: IdentitySelector): IdentitySelector {
  switch (selector.kind) {
    case 'principal_id':
      return { kind: 'principal_id', principalId: selector.principalId };
    case 'open_id':
      return { kind: 'open_id', externalAppId: selector.externalAppId, openId: selector.openId };
    case 'email':
      return { kind: 'email', email: selector.email.trim().toLowerCase() };
    case 'mobile':
      return { kind: 'mobile', mobile: selector.mobile.trim() };
    case 'union_id':
      return { kind: 'union_id', externalAppId: selector.externalAppId, unionId: selector.unionId };
  }
}

// ============================================================================
// 2. 人类与 Bot 权限规则（AccessRules, BotAccessRules, EntryRules, OwnRunRule）
// ============================================================================

export const accessRulesSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('owner_only') }).strict(),
  z.object({
    mode: z.literal('allowlist'),
    selectors: z.array(identitySelectorSchema).min(1, 'Human allowlist must be non-empty')
  }).strict(),
  z.object({ mode: z.literal('open') }).strict()
]);
export type AccessRules = z.infer<typeof accessRulesSchema>;

export const botAccessRulesSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('open') }).strict(),
  z.object({
    mode: z.literal('allowlist'),
    selectors: z.array(identitySelectorSchema), // Can be empty to express deny-all (peerEnabled=false) or peer-only (peerEnabled=true)
    peerEnabled: z.boolean()
  }).strict()
]);
export type BotAccessRules = z.infer<typeof botAccessRulesSchema>;

export function entryRulesSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    p2p: itemSchema,
    managedGroup: itemSchema,
    newGroup: itemSchema
  }).strict();
}
export type EntryRules<T> = { p2p: T; managedGroup: T; newGroup: T };

export const highRiskRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('entry_authorized') }).strict(),
  z.object({
    mode: z.literal('allowlist'),
    selectors: z.array(identitySelectorSchema).min(1, 'High-risk allowlist must be non-empty')
  }).strict()
]);
export type HighRiskRule = z.infer<typeof highRiskRuleSchema>;

export const ownRunRuleSchema = z.object({
  id: z.string().min(1),
  groups: z.object({
    profile: z.enum(['managed_group', 'new_group']),
    bindingIds: z.union([z.literal('all_verified'), z.array(z.string().min(1))])
  }).strict(),
  subjects: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('all_chat_members') }).strict(),
    z.object({
      mode: z.literal('allowlist'),
      selectors: z.array(identitySelectorSchema).min(1, 'Subjects allowlist must be non-empty')
    }).strict(),
    z.object({
      mode: z.literal('bots'),
      access: botAccessRulesSchema
    }).strict()
  ]),
  expiresAt: timestampSchema.optional(),
  actionGates: z.object({
    terminalWrite: z.literal(false),
    highRisk: z.literal(false),
    groupToolsSend: z.boolean()
  }).strict()
}).strict();
export type OwnRunRule = z.infer<typeof ownRunRuleSchema>;

export const p2pOperateRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({
    mode: z.literal('own_runs'),
    humans: accessRulesSchema,
    bots: botAccessRulesSchema
  }).strict()
]);
export type P2pOperateRule = z.infer<typeof p2pOperateRuleSchema>;

export const botAccessPolicySchema = z.object({
  humanTalk: entryRulesSchema(accessRulesSchema),
  botTalk: entryRulesSchema(botAccessRulesSchema),
  defaultOperate: z.object({
    rules: z.array(ownRunRuleSchema)
  }).strict(),
  p2pOperate: p2pOperateRuleSchema
}).strict();
export type BotAccessPolicy = z.infer<typeof botAccessPolicySchema>;

export function createDefaultBotAccessPolicy(): BotAccessPolicy {
  return {
    humanTalk: {
      p2p: { mode: 'owner_only' },
      managedGroup: { mode: 'owner_only' },
      newGroup: { mode: 'owner_only' }
    },
    botTalk: {
      p2p: { mode: 'allowlist', selectors: [], peerEnabled: false },
      managedGroup: { mode: 'allowlist', selectors: [], peerEnabled: false },
      newGroup: { mode: 'allowlist', selectors: [], peerEnabled: false }
    },
    defaultOperate: { rules: [] },
    p2pOperate: { mode: 'none' }
  };
}

// ============================================================================
// 3. V2 核心模型：ChannelBotV2, ChannelBotPolicyV2, GroupBindingV2
// ============================================================================

export const channelBotStatesV2 = ['staged', 'enabled', 'disabled', 'deleted'] as const;
export type ChannelBotStateV2 = (typeof channelBotStatesV2)[number];

export const desiredListenerStatesV2 = ['receiving', 'paused'] as const;
export type DesiredListenerStateV2 = (typeof desiredListenerStatesV2)[number];

export const channelBotV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  authorizationRevision: z.number().int().positive(),
  connectionGeneration: z.number().int().positive(),
  channel: z.literal('lark'),
  externalAppId: z.string().min(1),
  displayName: z.string().min(1),
  platformDisplayName: z.string().min(1).nullable().optional(),
  brand: z.enum(channelBotBrands),
  credentialRef: z.string().min(1).nullable().optional(),
  state: z.enum(channelBotStatesV2),
  desiredListenerState: z.enum(desiredListenerStatesV2),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();
export type ChannelBotV2 = z.infer<typeof channelBotV2Schema>;

export const p2pModes = ['chat', 'thread'] as const;
export type P2pMode = (typeof p2pModes)[number];

export const groupReplyModesV2 = [...groupReplyModes, 'runtime_default'] as const;
export type GroupReplyModeV2 = (typeof groupReplyModesV2)[number];

export const riskControlModes = ['off', 'guidance', 'enforced'] as const;
export type RiskControlMode = (typeof riskControlModes)[number];

export const channelBotPolicyDefaultsV2Schema = z.object({
  agentDefinitionId: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  rolePolicyRef: z.string().min(1).optional()
}).strict();
export type ChannelBotPolicyDefaultsV2 = z.infer<typeof channelBotPolicyDefaultsV2Schema>;

export const channelBotPolicyRoutingDefaultsV2Schema = z.object({
  p2pMode: z.enum(p2pModes),
  groupReplyMode: z.enum(groupReplyModesV2),
  mentionPolicy: z.enum(mentionPolicies)
}).strict();
export type ChannelBotPolicyRoutingDefaultsV2 = z.infer<typeof channelBotPolicyRoutingDefaultsV2Schema>;

export const highRiskPatternSchema = z.string().superRefine((val, ctx) => {
  const res = validateHighRiskPattern(val);
  if (!res.valid) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.error });
  }
});

export const channelBotPolicyExecutionV2Schema = z.object({
  permissionMode: z.enum(permissionModes),
  preInjectPrompt: z.string().nullable().optional(),
  highRiskAccess: entryRulesSchema(highRiskRuleSchema),
  riskControlMode: z.enum(riskControlModes),
  highRiskPattern: highRiskPatternSchema
}).strict();
export type ChannelBotPolicyExecutionV2 = z.infer<typeof channelBotPolicyExecutionV2Schema>;

/** Bot 级呈现设置；群级 presentationOverride 逐字段覆盖它（见 group-policy.ts）。 */
export const channelBotPolicyPresentationV2Schema = presentationSettingsSchema;
export type ChannelBotPolicyPresentationV2 = z.infer<typeof channelBotPolicyPresentationV2Schema>;

export const channelBotPolicyGroupToolsBaseSchema = z.object({
  readCeiling: z.boolean(),
  discoverCeiling: z.boolean(),
  sendCeiling: z.boolean(),
  readDefault: z.boolean(),
  discoverDefault: z.boolean(),
  sendDefault: z.boolean()
}).strict();

export const channelBotPolicyGroupToolsV2Schema = channelBotPolicyGroupToolsBaseSchema.superRefine((value, context) => {
  for (const tool of ['read', 'discover', 'send'] as const) {
    if (value[`${tool}Default`] && !value[`${tool}Ceiling`]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`${tool}Default`],
        message: `${tool} default cannot exceed its ceiling`
      });
    }
  }
});
export type ChannelBotPolicyGroupToolsV2 = z.infer<typeof channelBotPolicyGroupToolsV2Schema>;

export const channelBotPolicyV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  channelBotId: z.string().min(1),
  defaults: channelBotPolicyDefaultsV2Schema,
  routingDefaults: channelBotPolicyRoutingDefaultsV2Schema,
  accessPolicy: botAccessPolicySchema,
  execution: channelBotPolicyExecutionV2Schema,
  presentation: channelBotPolicyPresentationV2Schema,
  groupToolsPolicy: channelBotPolicyGroupToolsV2Schema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();
export type ChannelBotPolicyV2 = z.infer<typeof channelBotPolicyV2Schema>;

export const groupBindingStatesV2 = ['staged', 'enabled', 'disabled', 'needs_review', 'archived'] as const;
export type GroupBindingStateV2 = (typeof groupBindingStatesV2)[number];

export const groupAccessProfiles = ['managed_group', 'new_group'] as const;
export type GroupAccessProfile = (typeof groupAccessProfiles)[number];

export const inheritStringOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('set'), value: z.string().min(1) }).strict()
]);

export const clearableStringOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('set'), value: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('clear') }).strict()
]);

export const groupReplyOverrideSchemaV2 = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('set'), value: z.enum(groupReplyModesV2) }).strict()
]);

export const mentionOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('set'), value: z.enum(mentionPolicies) }).strict()
]);

export const routingOverrideSchemaV2 = z.object({
  groupReplyMode: groupReplyOverrideSchemaV2,
  mentionPolicy: mentionOverrideSchema
}).strict();

export const accessOverrideSchemaV2 = z.object({
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

export const groupToolsOverrideSchemaV2 = z.object({
  read: z.enum(groupToolOverrideModes),
  discover: z.enum(groupToolOverrideModes),
  send: z.enum(groupToolOverrideModes)
}).strict();

export const groupBindingV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  channelBotId: z.string().min(1),
  externalChatId: z.string().min(1),
  state: z.enum(groupBindingStatesV2),
  accessProfile: z.enum(groupAccessProfiles),
  oncall: z.boolean(),
  agentOverride: inheritStringOverrideSchema,
  workspaceOverride: inheritStringOverrideSchema,
  modelOverride: clearableStringOverrideSchema,
  reasoningOverride: clearableStringOverrideSchema,
  rolePolicyOverride: clearableStringOverrideSchema,
  routingOverride: routingOverrideSchemaV2,
  accessOverride: accessOverrideSchemaV2,
  groupToolsOverride: groupToolsOverrideSchemaV2,
  presentationOverride: presentationOverrideSchema,
  reviewReasons: z.array(z.string().regex(/^[a-z0-9_]+$/)),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();
export type GroupBindingV2 = z.infer<typeof groupBindingV2Schema>;

// ============================================================================
// 4. FullTrust 确认范围与证据结构
// ============================================================================

export const fullTrustScopeEntrySchema = z.object({
  entry: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('p2p') }).strict(),
    z.object({
      kind: z.literal('group'),
      profile: z.enum(['managed_group', 'new_group']),
      bindingIds: z.union([z.literal('all_verified'), z.array(z.string().min(1))])
    }).strict()
  ]),
  subject: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('human'), rule: accessRulesSchema }).strict(),
    z.object({ kind: z.literal('bot'), rule: botAccessRulesSchema }).strict()
  ]),
  actions: z.array(z.enum(policyActions)),
  operateScope: z.enum(operateScopes),
  executionDigest: sha256HexSchema,
  directoryIdentityDigest: sha256HexSchema,
  gates: z.object({
    terminalWrite: z.boolean(),
    highRisk: z.boolean(),
    groupToolsSend: z.boolean()
  }).strict(),
  expiresAt: timestampSchema.optional()
}).strict();
export type FullTrustScopeEntry = z.infer<typeof fullTrustScopeEntrySchema>;

export const fullTrustScopeV1Schema = z.object({
  version: z.literal(1),
  channelBotId: z.string().min(1),
  externalAppId: z.string().min(1),
  brand: z.enum(channelBotBrands),
  entries: z.array(fullTrustScopeEntrySchema)
}).strict();
export type FullTrustScopeV1 = z.infer<typeof fullTrustScopeV1Schema>;

export const configurationDependencySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent_config'),
    id: z.string().min(1),
    digest: sha256HexSchema
  }).strict(),
  z.object({
    kind: z.enum(['channel_bot_policy', 'group_binding']),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    digest: sha256HexSchema
  }).strict()
]);
export type ConfigurationDependency = z.infer<typeof configurationDependencySchema>;

export const executionScopeEvidenceSchema = z.object({
  agentDefinitionId: z.string().min(1),
  agentDefinitionDigest: sha256HexSchema,
  directoryIdentityDigest: sha256HexSchema,
  executionDigest: sha256HexSchema,
  directory: z.object({
    requestedPath: z.string().min(1),
    source: z.enum(['policy', 'binding', 'agent', 'process_cwd']),
    sourceId: z.string().min(1).optional(),
    absolutePath: z.string().min(1)
  }).strict(),
  configurationDependencies: z.array(configurationDependencySchema)
}).strict();
export type ExecutionScopeEvidence = z.infer<typeof executionScopeEvidenceSchema>;

// ============================================================================
// 5. 管理角色与同步事务操作 Payload Schema
// ============================================================================

export const managementActorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('installation_owner'),
    principalId: z.literal('principal_installation_owner')
  }).strict(),
  z.object({
    kind: z.literal('principal'),
    principalId: opaquePrincipalIdSchema,
    channelBotId: z.string().min(1)
  }).strict()
]);
export type ManagementActor = z.infer<typeof managementActorSchema>;

export const managementOperationSchema = z.object({
  operationId: z.string().min(1),
  actor: managementActorSchema
}).strict();
export type ManagementOperation = z.infer<typeof managementOperationSchema>;

export const botChangeRefSchema = managementOperationSchema.extend({
  botId: z.string().min(1),
  expectedRevision: z.number().int().positive().safe()
}).strict();
export type BotChangeRef = z.infer<typeof botChangeRefSchema>;

export const preparedCredentialRefSchema = z.object({
  secretId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative().safe(),
  provider: z.string().min(1),
  referenceKey: z.string().min(1),
  fingerprint: sha256HexSchema
}).strict();
export type PreparedCredentialRef = z.infer<typeof preparedCredentialRefSchema>;

export const createChannelBotV2FieldsSchema = z.object({
  displayName: z.string().min(1),
  brand: z.enum(channelBotBrands),
  platformDisplayName: z.string().min(1).nullable().optional(),
  state: z.literal('staged').default('staged'),
  desiredListenerState: z.literal('paused').default('paused')
}).strict();
export type CreateChannelBotV2Fields = z.infer<typeof createChannelBotV2FieldsSchema>;

export const createChannelBotPolicyV2FieldsSchema = z.object({
  defaults: channelBotPolicyDefaultsV2Schema,
  routingDefaults: channelBotPolicyRoutingDefaultsV2Schema,
  accessPolicy: botAccessPolicySchema,
  execution: channelBotPolicyExecutionV2Schema,
  presentation: channelBotPolicyPresentationV2Schema,
  groupToolsPolicy: channelBotPolicyGroupToolsV2Schema
}).strict();
export type CreateChannelBotPolicyV2Fields = z.infer<typeof createChannelBotPolicyV2FieldsSchema>;

export const createBotV2Schema = managementOperationSchema.extend({
  botId: z.string().min(1),
  externalAppId: z.string().min(1),
  expectedAppState: z.literal('absent'),
  bot: createChannelBotV2FieldsSchema,
  policy: createChannelBotPolicyV2FieldsSchema,
  preparedCredential: preparedCredentialRefSchema.optional()
}).strict();
export type CreateBotV2 = z.infer<typeof createBotV2Schema>;

export const botConfigPatchV2Schema = z.object({
  displayName: z.string().min(1).optional(),
  platformDisplayName: z.string().min(1).nullable().optional(),
  externalAppId: z.string().min(1).optional(),
  brand: z.enum(channelBotBrands).optional()
}).strict().refine(val => Object.keys(val).length > 0, { message: 'At least one field must be updated' });
export type BotConfigPatchV2 = z.infer<typeof botConfigPatchV2Schema>;

export const channelBotPolicyDefaultsPatchV2Schema = z.object({
  agentDefinitionId: z.string().min(1).nullable().optional(),
  workspace: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  reasoningEffort: z.string().min(1).nullable().optional(),
  rolePolicyRef: z.string().min(1).nullable().optional()
}).strict();
export type ChannelBotPolicyDefaultsPatchV2 = z.infer<typeof channelBotPolicyDefaultsPatchV2Schema>;

export const channelBotPolicyPatchV2Schema = z.object({
  defaults: channelBotPolicyDefaultsPatchV2Schema.optional(),
  routingDefaults: channelBotPolicyRoutingDefaultsV2Schema.partial().optional(),
  accessPolicy: botAccessPolicySchema.optional(),
  execution: channelBotPolicyExecutionV2Schema.partial().optional(),
  presentation: channelBotPolicyPresentationV2Schema.partial().optional(),
  groupToolsPolicy: channelBotPolicyGroupToolsBaseSchema.partial().optional()
}).strict().refine(val => Object.keys(val).length > 0, { message: 'At least one field must be updated' });
export type ChannelBotPolicyPatchV2 = z.infer<typeof channelBotPolicyPatchV2Schema>;

export const createGroupBindingV2FieldsSchema = z.object({
  externalChatId: z.string().min(1),
  accessProfile: z.enum(groupAccessProfiles),
  oncall: z.boolean().default(false),
  agentOverride: inheritStringOverrideSchema.default({ mode: 'inherit' }),
  workspaceOverride: inheritStringOverrideSchema.default({ mode: 'inherit' }),
  modelOverride: clearableStringOverrideSchema.default({ mode: 'inherit' }),
  reasoningOverride: clearableStringOverrideSchema.default({ mode: 'inherit' }),
  rolePolicyOverride: clearableStringOverrideSchema.default({ mode: 'inherit' }),
  routingOverride: routingOverrideSchemaV2.default({
    groupReplyMode: { mode: 'inherit' },
    mentionPolicy: { mode: 'inherit' }
  }),
  accessOverride: accessOverrideSchemaV2.default({ mode: 'inherit', principalIds: [] }),
  groupToolsOverride: groupToolsOverrideSchemaV2.default({ read: 'inherit', discover: 'inherit', send: 'inherit' }),
  presentationOverride: presentationOverrideSchema.default(inheritPresentationOverride),
  reviewReasons: z.array(z.string().regex(/^[a-z0-9_]+$/)).default([])
}).strict();
export type CreateGroupBindingV2Fields = z.infer<typeof createGroupBindingV2FieldsSchema>;

export const groupBindingPatchV2Schema = z.object({
  state: z.enum(groupBindingStatesV2).optional(),
  accessProfile: z.enum(groupAccessProfiles).optional(),
  oncall: z.boolean().optional(),
  agentOverride: inheritStringOverrideSchema.optional(),
  workspaceOverride: inheritStringOverrideSchema.optional(),
  modelOverride: clearableStringOverrideSchema.optional(),
  reasoningOverride: clearableStringOverrideSchema.optional(),
  rolePolicyOverride: clearableStringOverrideSchema.optional(),
  routingOverride: routingOverrideSchemaV2.optional(),
  accessOverride: accessOverrideSchemaV2.optional(),
  groupToolsOverride: groupToolsOverrideSchemaV2.optional(),
  presentationOverride: presentationOverrideSchema.optional(),
  reviewReasons: z.array(z.string().regex(/^[a-z0-9_]+$/)).optional()
}).strict().refine(val => Object.keys(val).length > 0, { message: 'At least one field must be updated' });
export type GroupBindingPatchV2 = z.infer<typeof groupBindingPatchV2Schema>;

export const bindingMutationV2Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    id: z.string().min(1),
    channelBotId: z.string().min(1),
    expectedRevision: z.literal(0),
    binding: createGroupBindingV2FieldsSchema
  }).strict(),
  z.object({
    kind: z.literal('update'),
    id: z.string().min(1),
    channelBotId: z.string().min(1),
    expectedRevision: z.number().int().positive().safe(),
    patch: groupBindingPatchV2Schema
  }).strict()
]);
export type BindingMutationV2 = z.infer<typeof bindingMutationV2Schema>;

export const createRoleAssignmentV2FieldsSchema = z.object({
  groupBindingId: z.string().min(1).optional(),
  principalId: opaquePrincipalIdSchema,
  role: z.enum(['can_talk', 'can_operate', 'admin']),
  operateScope: z.enum(operateScopes),
  actionGates: z.object({
    terminalWrite: z.boolean(),
    highRisk: z.boolean(),
    groupToolsSend: z.boolean()
  }).strict().default({ terminalWrite: false, highRisk: false, groupToolsSend: false }),
  expiresAt: timestampSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.role !== 'can_operate' && value.operateScope !== 'none') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['operateScope'], message: 'Only can_operate assignments may have an operate scope' });
  }
  if (value.role === 'can_operate' && value.operateScope === 'none') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['operateScope'], message: 'can_operate requires an explicit scope' });
  }
});
export type CreateRoleAssignmentV2Fields = z.infer<typeof createRoleAssignmentV2FieldsSchema>;

export const updateRoleAssignmentPatchV2Schema = z.object({
  operateScope: z.enum(operateScopes).optional(),
  actionGates: z.object({
    terminalWrite: z.boolean(),
    highRisk: z.boolean(),
    groupToolsSend: z.boolean()
  }).strict().optional(),
  state: z.enum(['active', 'revoked']).optional(),
  expiresAt: timestampSchema.nullable().optional()
}).strict().refine(val => Object.keys(val).length > 0, { message: 'At least one field must be updated' });
export type UpdateRoleAssignmentPatchV2 = z.infer<typeof updateRoleAssignmentPatchV2Schema>;

export const roleMutationV2Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    id: z.string().min(1),
    channelBotId: z.string().min(1),
    expectedRevision: z.literal(0),
    role: createRoleAssignmentV2FieldsSchema
  }).strict(),
  z.object({
    kind: z.literal('update'),
    id: z.string().min(1),
    channelBotId: z.string().min(1),
    expectedRevision: z.number().int().positive().safe(),
    patch: updateRoleAssignmentPatchV2Schema
  }).strict()
]);
export type RoleMutationV2 = z.infer<typeof roleMutationV2Schema>;

export const botRelatedMutationSchema = z.object({
  policy: z.object({
    expectedRevision: z.number().int().positive().safe(),
    patch: channelBotPolicyPatchV2Schema
  }).strict().optional(),
  bindings: z.array(bindingMutationV2Schema).optional(),
  roles: z.array(roleMutationV2Schema).optional()
}).strict().refine(
  val => val.policy !== undefined || (val.bindings && val.bindings.length > 0) || (val.roles && val.roles.length > 0),
  { message: 'At least one related mutation (policy, bindings, or roles) must be provided' }
);
export type BotRelatedMutation = z.infer<typeof botRelatedMutationSchema>;

export const sharedSecretChangeRefSchema = managementOperationSchema.extend({
  secretId: z.string().min(1),
  expectedSecretRevision: z.number().int().positive().safe(),
  bots: z.array(z.object({
    botId: z.string().min(1),
    expectedRevision: z.number().int().positive().safe()
  }).strict()).min(1)
}).strict();
export type SharedSecretChangeRef = z.infer<typeof sharedSecretChangeRefSchema>;

export const preparedBotRestoreSchema = z.object({
  targetVersionDigest: sha256HexSchema,
  sourceCollectionDigest: sha256HexSchema,
  preparedCredential: preparedCredentialRefSchema.optional()
}).strict();
export type PreparedBotRestore = z.infer<typeof preparedBotRestoreSchema>;

const fullTrustConfirmationBase = {
  id: z.string().min(1),
  channelBotId: z.string().min(1),
  botRevision: z.number().int().positive(),
  scopeDigest: sha256HexSchema,
  scope: fullTrustScopeV1Schema,
  revokedAt: timestampSchema.optional(),
  revokedReason: z.string().min(1).optional()
};

export const userActionFullTrustConfirmationSchema = z.object({
  ...fullTrustConfirmationBase,
  source: z.literal('user_action'),
  confirmedBy: managementActorSchema,
  confirmedAt: timestampSchema
}).strict();
export type UserActionFullTrustConfirmation = z.infer<typeof userActionFullTrustConfirmationSchema>;

export const legacyLiveFullTrustConfirmationSchema = z.object({
  ...fullTrustConfirmationBase,
  source: z.literal('legacy_live'),
  confirmedBy: z.null(),
  confirmedAt: z.null(),
  legacySourceDigest: sha256HexSchema,
  recordedAt: timestampSchema
}).strict();
export type LegacyLiveFullTrustConfirmation = z.infer<typeof legacyLiveFullTrustConfirmationSchema>;

export const fullTrustConfirmationSchema = z.discriminatedUnion('source', [
  userActionFullTrustConfirmationSchema,
  legacyLiveFullTrustConfirmationSchema
]);
export type FullTrustConfirmation = z.infer<typeof fullTrustConfirmationSchema>;

export const fullTrustPreviewSchema = z.object({
  botId: z.string().min(1),
  botRevision: z.number().int().positive(),
  candidateScope: fullTrustScopeV1Schema,
  scopeDigest: sha256HexSchema,
  requiresConfirmation: z.boolean(),
  activeConfirmationId: z.string().min(1).optional()
}).strict();
export type FullTrustPreview = z.infer<typeof fullTrustPreviewSchema>;

export const secretRefKindsTuple = ['lark_app_secret', 'agent_env', 'generic'] as const;
export const secretRefStatusesTuple = ['configured', 'invalid'] as const;

export const botSecretRefMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive().safe(),
  kind: z.enum(secretRefKindsTuple),
  provider: z.string().min(1),
  referenceKey: z.string().min(1),
  status: z.enum(secretRefStatusesTuple),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();

interface AssociatedEntityTarget {
  botId: string;
  externalAppId: string;
  policy: ChannelBotPolicyV2;
  bindings: GroupBindingV2[];
  roles: RoleAssignment[];
  confirmations: FullTrustConfirmation[];
}

function validateAssociatedEntities(
  target: AssociatedEntityTarget,
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[] = []
): void {
  if (target.policy.channelBotId !== target.botId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, 'policy', 'channelBotId'],
      message: 'policy.channelBotId must match botId'
    });
  }

  const bindingIds = new Set<string>();
  const bindingChatIds = new Set<string>();
  for (const [i, binding] of target.bindings.entries()) {
    if (binding.channelBotId !== target.botId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'bindings', i, 'channelBotId'],
        message: 'binding.channelBotId must match botId'
      });
    }
    if (!Number.isSafeInteger(binding.revision) || binding.revision <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'bindings', i, 'revision'],
        message: 'binding.revision must be a positive safe integer'
      });
    }
    if (bindingIds.has(binding.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'bindings', i, 'id'],
        message: `Duplicate binding id "${binding.id}"`
      });
    }
    bindingIds.add(binding.id);

    if (bindingChatIds.has(binding.externalChatId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'bindings', i, 'externalChatId'],
        message: `Duplicate binding externalChatId "${binding.externalChatId}"`
      });
    }
    bindingChatIds.add(binding.externalChatId);
  }

  const roleIds = new Set<string>();
  for (const [i, role] of target.roles.entries()) {
    if (role.channelBotId !== target.botId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'roles', i, 'channelBotId'],
        message: 'role.channelBotId must match botId'
      });
    }
    if (!Number.isSafeInteger(role.revision) || role.revision <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'roles', i, 'revision'],
        message: 'role.revision must be a positive safe integer'
      });
    }
    if (role.groupBindingId !== undefined && role.groupBindingId !== null && !bindingIds.has(role.groupBindingId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'roles', i, 'groupBindingId'],
        message: `Role groupBindingId "${role.groupBindingId}" must reference a binding present in this target`
      });
    }
    if (roleIds.has(role.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'roles', i, 'id'],
        message: `Duplicate role id "${role.id}"`
      });
    }
    roleIds.add(role.id);
  }

  const confirmationIds = new Set<string>();
  for (const [i, confirmation] of target.confirmations.entries()) {
    if (confirmation.channelBotId !== target.botId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'confirmations', i, 'channelBotId'],
        message: 'confirmation.channelBotId must match botId'
      });
    }
    if (confirmation.scope.channelBotId !== target.botId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'confirmations', i, 'scope', 'channelBotId'],
        message: 'confirmation.scope.channelBotId must match botId'
      });
    }
    if (!Number.isSafeInteger(confirmation.botRevision) || confirmation.botRevision <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'confirmations', i, 'botRevision'],
        message: 'confirmation.botRevision must be a positive safe integer'
      });
    }
    if (confirmationIds.has(confirmation.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, 'confirmations', i, 'id'],
        message: `Duplicate confirmation id "${confirmation.id}"`
      });
    }
    confirmationIds.add(confirmation.id);
  }
}

export const preparedBotConversionSchema = z.object({
  botId: z.string().min(1),
  externalAppId: z.string().min(1),
  bot: channelBotV2Schema,
  policy: channelBotPolicyV2Schema,
  bindings: z.array(groupBindingV2Schema).default([]),
  roles: z.array(roleAssignmentSchema).default([]),
  confirmations: z.array(fullTrustConfirmationSchema).default([]),
  preparedCredential: preparedCredentialRefSchema.optional(),
  executionEvidence: z.array(executionScopeEvidenceSchema).default([])
}).strict().superRefine((val, ctx) => {
  if (val.bot.id !== val.botId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bot', 'id'],
      message: 'bot.id must match botId'
    });
  }
  if (val.bot.externalAppId !== val.externalAppId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bot', 'externalAppId'],
      message: 'bot.externalAppId must match externalAppId'
    });
  }

  validateAssociatedEntities({
    botId: val.botId,
    externalAppId: val.externalAppId,
    policy: val.policy,
    bindings: val.bindings,
    roles: val.roles,
    confirmations: val.confirmations
  }, ctx);

  for (const [i, confirmation] of val.confirmations.entries()) {
    if (confirmation.scope.externalAppId !== val.externalAppId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmations', i, 'scope', 'externalAppId'],
        message: 'confirmation.scope.externalAppId must match externalAppId'
      });
    }
  }

  const hasCredentialRef = typeof val.bot.credentialRef === 'string' && val.bot.credentialRef.length > 0;
  if (hasCredentialRef) {
    if (!val.preparedCredential) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preparedCredential'],
        message: 'Target with credentialRef requires preparedCredential proof'
      });
    } else if (val.preparedCredential.secretId !== val.bot.credentialRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preparedCredential', 'secretId'],
        message: `preparedCredential.secretId "${val.preparedCredential.secretId}" must match bot.credentialRef "${val.bot.credentialRef}"`
      });
    }
  } else {
    if (val.preparedCredential !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preparedCredential'],
        message: 'Target without credentialRef cannot provide preparedCredential'
      });
    }
  }
});
export type PreparedBotConversion = z.infer<typeof preparedBotConversionSchema>;

export const legacyConversionInputSchema = z.object({
  migrationId: z.string().min(1),
  source: z.object({
    authority: z.literal('legacy'),
    legacyCollectionDigest: sha256HexSchema,
    appIds: z.array(z.string().min(1)),
    nativeConfigurationDigest: sha256HexSchema,
    mappingDigest: sha256HexSchema
  }).strict(),
  targetDigest: sha256HexSchema,
  bots: z.array(preparedBotConversionSchema)
}).strict().superRefine((val, ctx) => {
  const seenAppIds = new Set<string>();
  for (let i = 0; i < val.source.appIds.length; i++) {
    const appId = val.source.appIds[i];
    if (!appId) continue;
    if (seenAppIds.has(appId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'appIds', i],
        message: `Duplicate appId "${appId}" in source.appIds`
      });
    }
    seenAppIds.add(appId);
  }

  const seenBotIds = new Set<string>();
  const seenBotAppIds = new Set<string>();
  for (let i = 0; i < val.bots.length; i++) {
    const botConv = val.bots[i];
    if (!botConv) continue;
    if (seenBotIds.has(botConv.botId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bots', i, 'botId'],
        message: `Duplicate botId "${botConv.botId}" in conversion targets`
      });
    }
    seenBotIds.add(botConv.botId);

    if (seenBotAppIds.has(botConv.externalAppId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bots', i, 'externalAppId'],
        message: `Duplicate externalAppId "${botConv.externalAppId}" in conversion targets`
      });
    }
    seenBotAppIds.add(botConv.externalAppId);

    if (!seenAppIds.has(botConv.externalAppId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bots', i, 'externalAppId'],
        message: `Bot externalAppId "${botConv.externalAppId}" is not present in source.appIds fence`
      });
    }
  }

  const preparedSecrets = new Map<string, PreparedCredentialRef>();
  for (let i = 0; i < val.bots.length; i++) {
    const botConv = val.bots[i];
    if (!botConv || !botConv.preparedCredential) continue;
    const cred = botConv.preparedCredential;
    const existing = preparedSecrets.get(cred.secretId);
    if (!existing) {
      preparedSecrets.set(cred.secretId, cred);
    } else {
      if (
        existing.expectedRevision !== cred.expectedRevision ||
        existing.provider !== cred.provider ||
        existing.referenceKey !== cred.referenceKey ||
        existing.fingerprint !== cred.fingerprint
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bots', i, 'preparedCredential'],
          message: `Conflicting preparedCredential proof for secretId "${cred.secretId}" across multiple bots`
        });
      }
    }
  }
});
export type LegacyConversionInput = z.infer<typeof legacyConversionInputSchema>;

export const botConfigChangeKinds = [
  'created',
  'updated',
  'deleted',
  'restored',
  'receiving_changed',
  'enabled_changed',
  'related_mutated',
  'secret_rotated',
  'full_trust_confirmed',
  'full_trust_revoked',
  'legacy_converted'
] as const;
export type BotConfigChangeKind = (typeof botConfigChangeKinds)[number];

export const botConfigChangeSchema = z.object({
  sequence: z.number().int().positive(),
  botId: z.string().min(1),
  changeKind: z.enum(botConfigChangeKinds),
  revision: z.number().int().positive(),
  authorizationRevision: z.number().int().positive(),
  connectionGeneration: z.number().int().positive(),
  timestamp: timestampSchema
}).strict();
export type BotConfigChange = z.infer<typeof botConfigChangeSchema>;

export const migrationResultSchema = z.object({
  success: z.boolean(),
  migrationId: z.string().min(1),
  convertedBotIds: z.array(z.string().min(1)),
  completedAt: timestampSchema
}).strict();
export type MigrationResult = z.infer<typeof migrationResultSchema>;

export const botSnapshotSchema = z.object({
  bot: channelBotV2Schema,
  policy: channelBotPolicyV2Schema,
  credential: botSecretRefMetadataSchema.optional(),
  bindings: z.array(groupBindingV2Schema),
  roles: z.array(roleAssignmentSchema),
  confirmations: z.array(fullTrustConfirmationSchema)
}).strict().superRefine((val, ctx) => {
  validateAssociatedEntities({
    botId: val.bot.id,
    externalAppId: val.bot.externalAppId,
    policy: val.policy,
    bindings: val.bindings,
    roles: val.roles,
    confirmations: val.confirmations
  }, ctx);

  const hasCredentialRef = typeof val.bot.credentialRef === 'string' && val.bot.credentialRef.length > 0;
  if (hasCredentialRef) {
    if (!val.credential) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credential'],
        message: 'Bot with credentialRef requires credential metadata in snapshot'
      });
    } else if (val.credential.id !== val.bot.credentialRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credential', 'id'],
        message: `credential.id "${val.credential.id}" must match bot.credentialRef "${val.bot.credentialRef}"`
      });
    }
  } else {
    if (val.credential !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credential'],
        message: 'Bot without credentialRef cannot have credential metadata in snapshot'
      });
    }
  }
});
export type BotSnapshot = z.infer<typeof botSnapshotSchema>;

export const botConfigurationVersionMetadataSchema = z.object({
  versionId: z.string().min(1),
  botId: z.string().min(1),
  revision: z.number().int().positive().safe(),
  changeSequence: z.number().int().positive().safe(),
  changeKind: z.enum(botConfigChangeKinds),
  operationId: z.string().min(1),
  createdAt: timestampSchema,
  snapshotDigest: sha256HexSchema
}).strict();
export type BotConfigurationVersionMetadata = z.infer<typeof botConfigurationVersionMetadataSchema>;

export const botConfigurationVersionSchema = botConfigurationVersionMetadataSchema.extend({
  snapshot: botSnapshotSchema
}).strict().superRefine((val, ctx) => {
  if (val.snapshot.bot.id !== val.botId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['snapshot', 'bot', 'id'],
      message: 'snapshot.bot.id must match botId'
    });
  }
  if (val.snapshot.bot.revision !== val.revision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['snapshot', 'bot', 'revision'],
      message: 'snapshot.bot.revision must match revision'
    });
  }
});
export type BotConfigurationVersion = z.infer<typeof botConfigurationVersionSchema>;

export const listBotsOptionsSchema = z.object({
  afterId: z.string().min(1).optional(),
  limit: z.number().int().positive().safe().max(500).default(200)
}).strict();
export type ListBotsOptions = z.infer<typeof listBotsOptionsSchema>;
export type ListBotsOptionsInput = z.input<typeof listBotsOptionsSchema>;

export const listVersionsOptionsSchema = z.object({
  beforeRevision: z.number().int().positive().safe().optional(),
  limit: z.number().int().positive().safe().max(200).default(50)
}).strict();
export type ListVersionsOptions = z.infer<typeof listVersionsOptionsSchema>;
export type ListVersionsOptionsInput = z.input<typeof listVersionsOptionsSchema>;

export const configurationAuthorities = ['legacy', 'v2'] as const;
export type ConfigurationAuthority = (typeof configurationAuthorities)[number];
export const configurationAuthoritySchema = z.enum(configurationAuthorities);

export const createUnboundSecretInputSchema = z.object({
  op: managementOperationSchema,
  kind: z.enum(secretRefKindsTuple),
  prepared: preparedCredentialRefSchema
}).strict().superRefine((val, ctx) => {
  if (val.op.actor.kind !== 'installation_owner' || val.op.actor.principalId !== 'principal_installation_owner') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['op', 'actor'],
      message: 'Only installation_owner can create unbound secrets'
    });
  }
  if (val.prepared.expectedRevision !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prepared', 'expectedRevision'],
      message: 'createUnboundSecret requires prepared.expectedRevision to be 0'
    });
  }
});
export type CreateUnboundSecretInput = z.infer<typeof createUnboundSecretInputSchema>;

export const rotateUnboundSecretInputSchema = z.object({
  op: managementOperationSchema,
  prepared: preparedCredentialRefSchema
}).strict().superRefine((val, ctx) => {
  if (val.op.actor.kind !== 'installation_owner' || val.op.actor.principalId !== 'principal_installation_owner') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['op', 'actor'],
      message: 'Only installation_owner can rotate unbound secrets'
    });
  }
  if (val.prepared.expectedRevision <= 0 || !Number.isSafeInteger(val.prepared.expectedRevision)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prepared', 'expectedRevision'],
      message: 'rotateUnboundSecret requires positive safe integer prepared.expectedRevision'
    });
  }
});
export type RotateUnboundSecretInput = z.infer<typeof rotateUnboundSecretInputSchema>;

export const removeUnboundSecretInputSchema = z.object({
  op: managementOperationSchema,
  secretId: z.string().min(1),
  expectedRevision: z.number().int().positive().safe()
}).strict().superRefine((val, ctx) => {
  if (val.op.actor.kind !== 'installation_owner' || val.op.actor.principalId !== 'principal_installation_owner') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['op', 'actor'],
      message: 'Only installation_owner can remove unbound secrets'
    });
  }
});
export type RemoveUnboundSecretInput = z.infer<typeof removeUnboundSecretInputSchema>;

export interface ConfigurationRepository {
  authority(): ConfigurationAuthority;
  listBots(options?: ListBotsOptionsInput): ChannelBotV2[];
  listVersions(botId: string, options?: ListVersionsOptionsInput): BotConfigurationVersionMetadata[];
  readVersion(botId: string, versionId: string): BotConfigurationVersion | undefined;
  read(botId: string): BotSnapshot | undefined;
  readByApp(appId: string): BotSnapshot | undefined;
  listChanges(afterSequence: number, limit: number): BotConfigChange[];
  create(input: CreateBotV2): BotSnapshot;
  update(ref: BotChangeRef, patch: BotConfigPatchV2): BotSnapshot;
  mutateRelated(ref: BotChangeRef, change: BotRelatedMutation): BotSnapshot;
  setReceiving(ref: BotChangeRef, receiving: boolean): BotSnapshot;
  setEnabled(ref: BotChangeRef, enabled: boolean): BotSnapshot;
  delete(ref: BotChangeRef): BotSnapshot;
  restoreDeleted(ref: BotChangeRef, prepared: PreparedBotRestore): BotSnapshot;
  restoreVersion(ref: BotChangeRef, versionId: string, prepared: PreparedBotRestore): BotSnapshot;
  prepareFullTrust(botId: string, evidence: ExecutionScopeEvidence[]): FullTrustPreview;
  confirmFullTrust(ref: BotChangeRef, scopeDigest: string, evidence: ExecutionScopeEvidence[]): BotSnapshot;
  revokeConfirmation(ref: BotChangeRef, confirmationId: string): BotSnapshot;
  bindPreparedCredential(ref: BotChangeRef, prepared: PreparedCredentialRef): BotSnapshot;
  rotateSharedSecret(ref: SharedSecretChangeRef, prepared: PreparedCredentialRef): BotSnapshot[];
  createUnboundSecret(op: ManagementOperation, kind: SecretRefKind, prepared: PreparedCredentialRef): SecretRefMetadata;
  rotateUnboundSecret(op: ManagementOperation, prepared: PreparedCredentialRef): SecretRefMetadata;
  removeUnboundSecret(op: ManagementOperation, secretId: string, expectedRevision: number): SecretRefMetadata;
  commitLegacyConversion(op: ManagementOperation, prepared: LegacyConversionInput): MigrationResult;
}
