import { describe, expect, it } from 'vitest';
import {
  accessRulesSchema,
  areIdentitySelectorsEqual,
  bindingMutationV2Schema,
  botAccessPolicySchema,
  botAccessRulesSchema,
  botChangeRefSchema,
  botConfigPatchV2Schema,
  botConfigurationVersionMetadataSchema,
  botConfigurationVersionSchema,
  botRelatedMutationSchema,
  botSnapshotSchema,
  channelBotPolicyPatchV2Schema,
  channelBotPolicyPresentationV2Schema,
  channelBotPolicyV2Schema,
  channelBotV2Schema,
  createBotV2Schema,
  createDefaultBotAccessPolicy,
  createUnboundSecretInputSchema,
  executionScopeEvidenceSchema,
  fullTrustConfirmationSchema,
  fullTrustScopeV1Schema,
  groupBindingV2Schema,
  highRiskRuleSchema,
  identitySelectorSchema,
  inheritPresentationOverride,
  legacyConversionInputSchema,
  listBotsOptionsSchema,
  listVersionsOptionsSchema,
  managementActorSchema,
  normalizeIdentitySelector,
  ownRunRuleSchema,
  p2pOperateRuleSchema,
  preparedBotConversionSchema,
  preparedBotRestoreSchema,
  preparedCredentialRefSchema,
  removeUnboundSecretInputSchema,
  roleAssignmentSchema,
  roleMutationV2Schema,
  rotateUnboundSecretInputSchema,
  sharedSecretChangeRefSchema,
  type BotConfigurationVersion,
  type BotConfigurationVersionMetadata,
  type BotSnapshot,
  type ChannelBotPolicyV2,
  type ChannelBotV2,
  type ExecutionScopeEvidence,
  type FullTrustScopeV1,
  type GroupBindingV2,
  type IdentitySelector,
  type ListBotsOptions,
  type ListBotsOptionsInput,
  type ListVersionsOptions,
  type ListVersionsOptionsInput,
  type PreparedBotConversion,
  type RoleAssignment
} from './bot-configuration.js';
import {
  channelBotFoundationSchema,
  channelBotGroupPolicySchema,
  groupBindingSchema
} from './index.js';
import { normalizeFullTrustScope } from './bot-configuration-scope.js';

describe('Bot Configuration V2 Schemas and Contracts', () => {
  describe('1. IdentitySelector 严格判别联合与归一化安全', () => {
    it('accepts valid principal_id selector', () => {
      const valid = { kind: 'principal_id', principalId: 'principal_alice_123' };
      const parsed = identitySelectorSchema.parse(valid);
      expect(parsed).toEqual(valid);
    });

    it('rejects invalid principal_id format', () => {
      expect(() => identitySelectorSchema.parse({ kind: 'principal_id', principalId: 'alice_without_prefix' })).toThrow();
    });

    it('accepts valid open_id selector with externalAppId domain binding', () => {
      const valid = { kind: 'open_id', externalAppId: 'cli_app_123', openId: 'ou_abc456' };
      const parsed = identitySelectorSchema.parse(valid);
      expect(parsed).toEqual(valid);
    });

    it('rejects open_id selector missing externalAppId', () => {
      expect(() => identitySelectorSchema.parse({ kind: 'open_id', openId: 'ou_abc456' })).toThrow();
    });

    it('accepts single-field email and mobile selectors and trims outer whitespace', () => {
      const email = identitySelectorSchema.parse({ kind: 'email', email: 'user@example.com' });
      expect(email.kind).toBe('email');

      const paddedEmail = identitySelectorSchema.parse({ kind: 'email', email: '  Alice@Example.COM  ' });
      expect(paddedEmail).toEqual({ kind: 'email', email: 'Alice@Example.COM' });

      const mobile = identitySelectorSchema.parse({ kind: 'mobile', mobile: '+8613800000000' });
      expect(mobile.kind).toBe('mobile');

      const paddedMobile = identitySelectorSchema.parse({ kind: 'mobile', mobile: '  +8613800000000  ' });
      expect(paddedMobile).toEqual({ kind: 'mobile', mobile: '+8613800000000' });

      // Blank-only mobile must be rejected
      expect(() => identitySelectorSchema.parse({ kind: 'mobile', mobile: ' \t\n ' })).toThrow();
    });

    it('strictly rejects forged secondary normalization fields (normalizedEmail / normalizedMobile)', () => {
      const forgedEmail = { kind: 'email', email: 'bob@example.com', normalizedEmail: 'alice@example.com' };
      expect(() => identitySelectorSchema.parse(forgedEmail)).toThrow();

      const forgedMobile = { kind: 'mobile', mobile: '+8613800000001', normalizedMobile: '+8613800000002' };
      expect(() => identitySelectorSchema.parse(forgedMobile)).toThrow();
    });

    it('accepts valid union_id selector with externalAppId', () => {
      const union = identitySelectorSchema.parse({ kind: 'union_id', externalAppId: 'cli_app_123', unionId: 'on_xyz789' });
      expect(union.kind).toBe('union_id');
    });

    it('rejects unknown selector kind and unknown extra fields (strict mode)', () => {
      expect(() => identitySelectorSchema.parse({ kind: 'slack_id', id: 'U123' })).toThrow();
      expect(() =>
        identitySelectorSchema.parse({
          kind: 'principal_id',
          principalId: 'principal_alice',
          extraField: 'not_allowed'
        })
      ).toThrow();
    });

    it('areIdentitySelectorsEqual respects canonical content and unified normalization', () => {
      const sel1: IdentitySelector = { kind: 'email', email: 'Alice@Example.com' };
      const sel2: IdentitySelector = { kind: 'email', email: 'alice@example.com' };
      const selBob: IdentitySelector = { kind: 'email', email: 'bob@example.com' };
      const sel3: IdentitySelector = { kind: 'principal_id', principalId: 'principal_alice' };

      expect(areIdentitySelectorsEqual(sel1, sel2)).toBe(true);
      expect(areIdentitySelectorsEqual(sel1, selBob)).toBe(false);
      expect(areIdentitySelectorsEqual(sel1, sel3)).toBe(false); // No unverified equivalence across kinds

      const mob1: IdentitySelector = { kind: 'mobile', mobile: ' +8613800000000 ' };
      const mob2: IdentitySelector = { kind: 'mobile', mobile: '+8613800000000' };
      expect(areIdentitySelectorsEqual(mob1, mob2)).toBe(true);
    });

    it('normalizeIdentitySelector trims and lowercases email, trims mobile without guessing country codes', () => {
      const normalizedEmail = normalizeIdentitySelector({ kind: 'email', email: '  Bob@Example.COM  ' });
      expect(normalizedEmail).toEqual({
        kind: 'email',
        email: 'bob@example.com'
      });

      const normalizedMobile = normalizeIdentitySelector({ kind: 'mobile', mobile: '  +8613800000000  ' });
      expect(normalizedMobile).toEqual({
        kind: 'mobile',
        mobile: '+8613800000000'
      });
    });

    it('preserves valid FullTrustScope across parse -> normalize -> parse roundtrip with padded inputs', () => {
      const rawScope = {
        version: 1,
        channelBotId: 'bot1',
        externalAppId: 'app1',
        brand: 'feishu',
        entries: [
          {
            entry: { kind: 'p2p' },
            subject: {
              kind: 'human',
              rule: {
                mode: 'allowlist',
                selectors: [
                  { kind: 'email', email: '  Alice@Example.COM  ' },
                  { kind: 'mobile', mobile: '  +8613800000000  ' }
                ]
              }
            },
            actions: ['task.create'],
            operateScope: 'own_runs',
            executionDigest: 'a'.repeat(64),
            directoryIdentityDigest: 'b'.repeat(64),
            gates: { terminalWrite: false, highRisk: false, groupToolsSend: false }
          }
        ]
      };

      const parsed = fullTrustScopeV1Schema.parse(rawScope);
      const normalized = normalizeFullTrustScope(parsed);
      const reparsed = fullTrustScopeV1Schema.parse(normalized);
      expect(reparsed).toBeDefined();

      // Blank mobile must be rejected at parse time
      const invalidScope = {
        ...rawScope,
        entries: [
          {
            ...rawScope.entries[0],
            subject: {
              kind: 'human',
              rule: {
                mode: 'allowlist',
                selectors: [{ kind: 'mobile', mobile: ' \t\n ' }]
              }
            }
          }
        ]
      };
      expect(() => fullTrustScopeV1Schema.parse(invalidScope)).toThrow();
    });
  });

  describe('2. 三入口权限规则（humanTalk, botTalk, highRiskAccess）', () => {
    it('human allowlist must be non-empty', () => {
      expect(() => accessRulesSchema.parse({ mode: 'allowlist', selectors: [] })).toThrow(/non-empty/);

      const valid = accessRulesSchema.parse({
        mode: 'allowlist',
        selectors: [{ kind: 'principal_id', principalId: 'principal_human1' }]
      });
      expect(valid.mode).toBe('allowlist');
    });

    it('highRisk allowlist must be non-empty', () => {
      expect(() => highRiskRuleSchema.parse({ mode: 'allowlist', selectors: [] })).toThrow(/non-empty/);
      expect(() => highRiskRuleSchema.parse({ mode: 'entry_authorized' })).not.toThrow();
    });

    it('bot allowlist can be empty to express deny-all or peer-only', () => {
      // deny-all: empty allowlist + peerEnabled: false
      const denyAll = botAccessRulesSchema.parse({ mode: 'allowlist', selectors: [], peerEnabled: false });
      expect(denyAll.mode).toBe('allowlist');
      if (denyAll.mode !== 'allowlist') throw new Error('expected deny-all allowlist rule');
      expect(denyAll.selectors).toHaveLength(0);
      expect(denyAll.peerEnabled).toBe(false);

      // peer-only: empty allowlist + peerEnabled: true
      const peerOnly = botAccessRulesSchema.parse({ mode: 'allowlist', selectors: [], peerEnabled: true });
      expect(peerOnly.mode).toBe('allowlist');
      if (peerOnly.mode !== 'allowlist') throw new Error('expected peer-only allowlist rule');
      expect(peerOnly.peerEnabled).toBe(true);
    });

    it('OwnRunRule enforces fixed actionGates (terminalWrite and highRisk must be false)', () => {
      const validRule = {
        id: 'rule_1',
        groups: { profile: 'managed_group', bindingIds: 'all_verified' },
        subjects: { mode: 'all_chat_members' },
        actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: true }
      };
      expect(() => ownRunRuleSchema.parse(validRule)).not.toThrow();

      // terminalWrite cannot be true
      expect(() =>
        ownRunRuleSchema.parse({
          ...validRule,
          actionGates: { terminalWrite: true, highRisk: false, groupToolsSend: true }
        })
      ).toThrow();

      // highRisk cannot be true
      expect(() =>
        ownRunRuleSchema.parse({
          ...validRule,
          actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: true }
        })
      ).toThrow();
    });

    it('createDefaultBotAccessPolicy creates the secure fail-closed defaults', () => {
      const policy = createDefaultBotAccessPolicy();
      const parsed = botAccessPolicySchema.parse(policy);

      expect(parsed.humanTalk.p2p.mode).toBe('owner_only');
      expect(parsed.humanTalk.managedGroup.mode).toBe('owner_only');
      expect(parsed.humanTalk.newGroup.mode).toBe('owner_only');

      expect(parsed.botTalk.p2p).toEqual({ mode: 'allowlist', selectors: [], peerEnabled: false });
      expect(parsed.botTalk.managedGroup).toEqual({ mode: 'allowlist', selectors: [], peerEnabled: false });
      expect(parsed.botTalk.newGroup).toEqual({ mode: 'allowlist', selectors: [], peerEnabled: false });

      expect(parsed.defaultOperate.rules).toEqual([]);
      expect(parsed.p2pOperate).toEqual({ mode: 'none' });
    });

    it('p2pOperate supports none or own_runs with explicit human and bot rules', () => {
      expect(() => p2pOperateRuleSchema.parse({ mode: 'none' })).not.toThrow();
      expect(() =>
        p2pOperateRuleSchema.parse({
          mode: 'own_runs',
          humans: { mode: 'owner_only' },
          bots: { mode: 'allowlist', selectors: [], peerEnabled: false }
        })
      ).not.toThrow();
    });
  });

  describe('3. ChannelBotV2, ChannelBotPolicyV2, GroupBindingV2 核心模型', () => {
    it('validates ChannelBotV2 schema with independent revisions and state transitions', () => {
      const bot: ChannelBotV2 = {
        schemaVersion: 2,
        id: 'bot_test_1',
        revision: 1,
        authorizationRevision: 1,
        connectionGeneration: 1,
        channel: 'lark',
        externalAppId: 'cli_test_app',
        displayName: 'Test Bot Remark',
        platformDisplayName: 'Lark Official App Name',
        brand: 'feishu',
        credentialRef: 'secret_ref_1',
        state: 'enabled',
        desiredListenerState: 'receiving',
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z'
      };

      const parsed = channelBotV2Schema.parse(bot);
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.state).toBe('enabled');
      expect(parsed.desiredListenerState).toBe('receiving');

      // Rejects unknown fields
      expect(() => channelBotV2Schema.parse({ ...bot, arbitraryField: true })).toThrow();
    });

    it('validates ChannelBotPolicyV2 with complete execution and presentation fields', () => {
      const policy: ChannelBotPolicyV2 = {
        schemaVersion: 2,
        id: 'policy_test_1',
        revision: 1,
        channelBotId: 'bot_test_1',
        defaults: {
          agentDefinitionId: 'agent_coder',
          workspace: '/data00/repo',
          model: 'claude-sonnet-5',
          reasoningEffort: 'medium'
        },
        routingDefaults: {
          p2pMode: 'chat',
          groupReplyMode: 'runtime_default',
          mentionPolicy: 'always'
        },
        accessPolicy: createDefaultBotAccessPolicy(),
        execution: {
          permissionMode: 'full-trust',
          preInjectPrompt: 'You are a helpful assistant',
          highRiskAccess: {
            p2p: { mode: 'entry_authorized' },
            managedGroup: { mode: 'entry_authorized' },
            newGroup: { mode: 'entry_authorized' }
          },
          riskControlMode: 'enforced',
          highRiskPattern: 'rm -rf|drop database'
        },
        presentation: {
          webBaseUrl: 'https://dutydeck.example.com',
          structuredAskCards: true,
          groupCardMention: true,
          pushIntervalMs: 1000,
          traceLimit: 50,
          hideTraceOnComplete: false,
          completionReactionOnly: false,
          silentProgress: false
        },
        groupToolsPolicy: {
          readCeiling: true,
          discoverCeiling: true,
          sendCeiling: false,
          readDefault: true,
          discoverDefault: false,
          sendDefault: false
        },
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z'
      };

      const parsed = channelBotPolicyV2Schema.parse(policy);
      expect(parsed.routingDefaults.groupReplyMode).toBe('runtime_default');
      expect(parsed.execution.riskControlMode).toBe('enforced');

      // GroupTools ceiling check
      expect(() =>
        channelBotPolicyV2Schema.parse({
          ...policy,
          groupToolsPolicy: {
            ...policy.groupToolsPolicy,
            sendCeiling: false,
            sendDefault: true // Invalid: default > ceiling
          }
        })
      ).toThrow(/ceiling/);

      // Rejects opaque JSON extension
      expect(() => channelBotPolicyV2Schema.parse({ ...policy, extraCustomJson: {} })).toThrow();
    });

    it('rejects unsafe or invalid highRiskPattern in policy execution', () => {
      const baseExecution = {
        permissionMode: 'ask' as const,
        highRiskAccess: {
          p2p: { mode: 'entry_authorized' as const },
          managedGroup: { mode: 'entry_authorized' as const },
          newGroup: { mode: 'entry_authorized' as const }
        },
        riskControlMode: 'enforced' as const
      };

      // Syntax error
      expect(() =>
        channelBotPolicyV2Schema.shape.execution.parse({
          ...baseExecution,
          highRiskPattern: '['
        })
      ).toThrow(/语法错误/);

      // Catastrophic backtracking risk
      expect(() =>
        channelBotPolicyV2Schema.shape.execution.parse({
          ...baseExecution,
          highRiskPattern: '(a+)+$'
        })
      ).toThrow(/灾难性回溯/);

      // Empty pattern
      expect(() =>
        channelBotPolicyV2Schema.shape.execution.parse({
          ...baseExecution,
          highRiskPattern: '   '
        })
      ).toThrow(/请输入高危操作/);
    });

    it('enforces presentation pushIntervalMs in 500..20000 range and traceLimit as positive integer', () => {
      const valid = {
        webBaseUrl: 'https://dutydeck.example.com',
        structuredAskCards: true,
        groupCardMention: true,
        pushIntervalMs: 500,
        traceLimit: 50,
        hideTraceOnComplete: false,
        completionReactionOnly: false,
        silentProgress: false
      };

      expect(() => channelBotPolicyPresentationV2Schema.parse(valid)).not.toThrow();

      // Lower bound 500
      expect(() => channelBotPolicyPresentationV2Schema.parse({ ...valid, pushIntervalMs: 499 })).toThrow();
      expect(() => channelBotPolicyPresentationV2Schema.parse({ ...valid, pushIntervalMs: 500 })).not.toThrow();

      // Upper bound 20000
      expect(() => channelBotPolicyPresentationV2Schema.parse({ ...valid, pushIntervalMs: 20000 })).not.toThrow();
      expect(() => channelBotPolicyPresentationV2Schema.parse({ ...valid, pushIntervalMs: 20001 })).toThrow();

      // Non-integer
      expect(() => channelBotPolicyPresentationV2Schema.parse({ ...valid, pushIntervalMs: 500.5 })).toThrow();

      // traceLimit positive
      expect(() => channelBotPolicyPresentationV2Schema.parse({ ...valid, traceLimit: 0 })).toThrow();
      expect(() => channelBotPolicyPresentationV2Schema.parse({ ...valid, traceLimit: -1 })).toThrow();
      expect(() => channelBotPolicyPresentationV2Schema.parse({ ...valid, traceLimit: 1 })).not.toThrow();
    });

    it('validates GroupBindingV2 with accessProfile and enabled state', () => {
      const binding: GroupBindingV2 = {
        schemaVersion: 2,
        id: 'binding_group_1',
        revision: 1,
        channelBotId: 'bot_test_1',
        externalChatId: 'oc_chat_123',
        state: 'enabled',
        accessProfile: 'managed_group',
        oncall: true,
        agentOverride: { mode: 'inherit' },
        workspaceOverride: { mode: 'set', value: '/custom/workspace' },
        modelOverride: { mode: 'clear' },
        reasoningOverride: { mode: 'inherit' },
        rolePolicyOverride: { mode: 'inherit' },
        routingOverride: {
          groupReplyMode: { mode: 'inherit' },
          mentionPolicy: { mode: 'set', value: 'ambient' }
        },
        accessOverride: { mode: 'inherit', principalIds: [] },
        groupToolsOverride: { read: 'inherit', discover: 'allow', send: 'deny' },
        presentationOverride: inheritPresentationOverride,
        reviewReasons: ['initial_binding'],
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z'
      };

      const parsed = groupBindingV2Schema.parse(binding);
      expect(parsed.state).toBe('enabled');
      expect(parsed.accessProfile).toBe('managed_group');
    });
  });

  describe('4. 公开配置命令与事务 Payload 严格 Schema', () => {
    it('validates ManagementActor discriminator', () => {
      expect(() =>
        managementActorSchema.parse({ kind: 'installation_owner', principalId: 'principal_installation_owner' })
      ).not.toThrow();

      expect(() =>
        managementActorSchema.parse({
          kind: 'principal',
          principalId: 'principal_admin_1',
          channelBotId: 'bot_1'
        })
      ).not.toThrow();

      expect(() =>
        managementActorSchema.parse({ kind: 'installation_owner', principalId: 'principal_someone_else' })
      ).toThrow();
    });

    it('validates BotChangeRef', () => {
      const changeRef = botChangeRefSchema.parse({
        operationId: 'op_123',
        actor: { kind: 'installation_owner', principalId: 'principal_installation_owner' },
        botId: 'bot_1',
        expectedRevision: 3
      });
      expect(changeRef.expectedRevision).toBe(3);
    });

    it('validates PreparedCredentialRef requires secretId, safe non-negative revision, and 64-hex fingerprint', () => {
      const newCred = {
        secretId: 'sec_1',
        provider: 'local_file',
        referenceKey: 'bot_1_secret',
        fingerprint: 'a'.repeat(64),
        expectedRevision: 0 // New credential creation
      };
      expect(() => preparedCredentialRefSchema.parse(newCred)).not.toThrow();

      const existingCred = {
        ...newCred,
        expectedRevision: 1 // Existing credential update
      };
      expect(() => preparedCredentialRefSchema.parse(existingCred)).not.toThrow();

      // MAX_SAFE_INTEGER allowed
      expect(() =>
        preparedCredentialRefSchema.parse({
          ...newCred,
          expectedRevision: Number.MAX_SAFE_INTEGER
        })
      ).not.toThrow();

      // Negative revision rejected
      expect(() => preparedCredentialRefSchema.parse({ ...newCred, expectedRevision: -1 })).toThrow();

      // Decimal revision rejected
      expect(() => preparedCredentialRefSchema.parse({ ...newCred, expectedRevision: 1.5 })).toThrow();

      // MAX_SAFE_INTEGER + 1 rejected (unsafe integer)
      expect(() =>
        preparedCredentialRefSchema.parse({
          ...newCred,
          expectedRevision: Number.MAX_SAFE_INTEGER + 1
        })
      ).toThrow();

      // 1e100 rejected
      expect(() =>
        preparedCredentialRefSchema.parse({
          ...newCred,
          expectedRevision: 1e100
        })
      ).toThrow();

      // Missing secretId rejected
      expect(() =>
        preparedCredentialRefSchema.parse({
          provider: 'local_file',
          referenceKey: 'bot_1_secret',
          fingerprint: 'a'.repeat(64),
          expectedRevision: 0
        })
      ).toThrow();

      // Invalid fingerprint rejected
      expect(() =>
        preparedCredentialRefSchema.parse({
          ...newCred,
          fingerprint: 'not_hex'
        })
      ).toThrow();
    });

    it('validates BotConfigPatchV2 allows externalAppId and brand rebind', () => {
      const patch = botConfigPatchV2Schema.parse({
        externalAppId: 'new_app',
        brand: 'lark'
      });
      expect(patch.externalAppId).toBe('new_app');
      expect(patch.brand).toBe('lark');

      // Empty patch rejected
      expect(() => botConfigPatchV2Schema.parse({})).toThrow();

      // Disallowed modification of ID or revision rejected (strict)
      expect(() => botConfigPatchV2Schema.parse({ id: 'bot_2', externalAppId: 'new_app' })).toThrow();
      expect(() => botConfigPatchV2Schema.parse({ revision: 5, brand: 'feishu' })).toThrow();
    });

    it('validates ChannelBotPolicyPatchV2 defaults support explicit null clear', () => {
      const patchWithNull = channelBotPolicyPatchV2Schema.parse({
        defaults: {
          model: null,
          reasoningEffort: null
        }
      });
      expect(patchWithNull.defaults?.model).toBeNull();
      expect(patchWithNull.defaults?.reasoningEffort).toBeNull();

      // Omitting fields keeps them undefined
      const patchOmit = channelBotPolicyPatchV2Schema.parse({
        defaults: {
          workspace: '/new/workspace'
        }
      });
      expect(patchOmit.defaults?.workspace).toBe('/new/workspace');
      expect(patchOmit.defaults?.model).toBeUndefined();

      // Full model does NOT allow null
      expect(() =>
        channelBotPolicyV2Schema.shape.defaults.parse({
          model: null
        })
      ).toThrow();
    });

    it('validates FullTrustConfirmation source strict union (user_action vs legacy_live)', () => {
      const scope: FullTrustScopeV1 = {
        version: 1,
        channelBotId: 'bot1',
        externalAppId: 'app1',
        brand: 'feishu',
        entries: []
      };

      // user_action requires confirmedBy and confirmedAt
      const userAction = {
        id: 'c_user',
        channelBotId: 'bot1',
        botRevision: 1,
        scopeDigest: 'a'.repeat(64),
        scope,
        source: 'user_action' as const,
        confirmedBy: { kind: 'installation_owner' as const, principalId: 'principal_installation_owner' as const },
        confirmedAt: '2026-09-14T00:00:00.000Z'
      };
      expect(() => fullTrustConfirmationSchema.parse(userAction)).not.toThrow();

      // legacy_live requires null confirmedBy/confirmedAt and valid legacySourceDigest/recordedAt
      const legacyLive = {
        id: 'c_legacy',
        channelBotId: 'bot1',
        botRevision: 1,
        scopeDigest: 'a'.repeat(64),
        scope,
        source: 'legacy_live' as const,
        confirmedBy: null,
        confirmedAt: null,
        legacySourceDigest: 'b'.repeat(64),
        recordedAt: '2026-09-14T00:00:00.000Z'
      };
      expect(() => fullTrustConfirmationSchema.parse(legacyLive)).not.toThrow();

      // Fabricating user for legacy_live rejected
      expect(() =>
        fullTrustConfirmationSchema.parse({
          ...legacyLive,
          confirmedBy: { kind: 'installation_owner', principalId: 'principal_installation_owner' }
        })
      ).toThrow();

      // Missing legacySourceDigest in legacy_live rejected
      expect(() =>
        fullTrustConfirmationSchema.parse({
          id: 'c_legacy_bad',
          channelBotId: 'bot1',
          botRevision: 1,
          scopeDigest: 'a'.repeat(64),
          scope,
          source: 'legacy_live',
          confirmedBy: null,
          confirmedAt: null,
          recordedAt: '2026-09-14T00:00:00.000Z'
        })
      ).toThrow();
    });

    it('validates CreateBotV2 strict payload', () => {
      const createPayload = {
        operationId: 'op_create_1',
        actor: { kind: 'installation_owner', principalId: 'principal_installation_owner' },
        botId: 'bot_new',
        externalAppId: 'cli_app_999',
        expectedAppState: 'absent',
        bot: {
          displayName: 'New Bot',
          brand: 'feishu',
          state: 'staged',
          desiredListenerState: 'paused'
        },
        policy: {
          defaults: {},
          routingDefaults: { p2pMode: 'chat', groupReplyMode: 'runtime_default', mentionPolicy: 'always' },
          accessPolicy: createDefaultBotAccessPolicy(),
          execution: {
            permissionMode: 'ask',
            highRiskAccess: {
              p2p: { mode: 'entry_authorized' },
              managedGroup: { mode: 'entry_authorized' },
              newGroup: { mode: 'entry_authorized' }
            },
            riskControlMode: 'off',
            highRiskPattern: 'rm -rf'
          },
          presentation: {
            structuredAskCards: true,
            groupCardMention: true,
            pushIntervalMs: 500,
            traceLimit: 50,
            hideTraceOnComplete: false,
            completionReactionOnly: false,
            silentProgress: false
          },
          groupToolsPolicy: {
            readCeiling: false,
            discoverCeiling: false,
            sendCeiling: false,
            readDefault: false,
            discoverDefault: false,
            sendDefault: false
          }
        }
      };

      const parsed = createBotV2Schema.parse(createPayload);
      expect(parsed.expectedAppState).toBe('absent');
    });

    it('validates BindingMutationV2 and RoleMutationV2 strict create/update discrimination', () => {
      const createBinding = bindingMutationV2Schema.parse({
        kind: 'create',
        id: 'bind_new',
        channelBotId: 'bot_1',
        expectedRevision: 0,
        binding: {
          externalChatId: 'oc_group_9',
          accessProfile: 'new_group'
        }
      });
      expect(createBinding.kind).toBe('create');

      const updateRole = roleMutationV2Schema.parse({
        kind: 'update',
        id: 'role_1',
        channelBotId: 'bot_1',
        expectedRevision: 2,
        patch: {
          operateScope: 'own_runs'
        }
      });
      expect(updateRole.kind).toBe('update');
    });

    it('validates SharedSecretChangeRef and PreparedBotRestore', () => {
      const validSharedSecretRef = {
        operationId: 'op_secret_rot',
        actor: { kind: 'installation_owner' as const, principalId: 'principal_installation_owner' as const },
        secretId: 'sec_1',
        expectedSecretRevision: 4,
        bots: [{ botId: 'bot_1', expectedRevision: 2 }, { botId: 'bot_2', expectedRevision: 5 }]
      };
      expect(() => sharedSecretChangeRefSchema.parse(validSharedSecretRef)).not.toThrow();

      // Regression: expectedSecretRevision and bots[].expectedRevision must be safe positive integers
      expect(() =>
        sharedSecretChangeRefSchema.parse({
          ...validSharedSecretRef,
          expectedSecretRevision: Number.MAX_SAFE_INTEGER + 1
        })
      ).toThrow();

      expect(() =>
        sharedSecretChangeRefSchema.parse({
          ...validSharedSecretRef,
          expectedSecretRevision: 1e100
        })
      ).toThrow();

      expect(() =>
        sharedSecretChangeRefSchema.parse({
          ...validSharedSecretRef,
          expectedSecretRevision: 0
        })
      ).toThrow();

      expect(() =>
        sharedSecretChangeRefSchema.parse({
          ...validSharedSecretRef,
          expectedSecretRevision: -1
        })
      ).toThrow();

      expect(() =>
        sharedSecretChangeRefSchema.parse({
          ...validSharedSecretRef,
          bots: [{ botId: 'bot_1', expectedRevision: Number.MAX_SAFE_INTEGER + 1 }]
        })
      ).toThrow();

      expect(() =>
        sharedSecretChangeRefSchema.parse({
          ...validSharedSecretRef,
          bots: [{ botId: 'bot_1', expectedRevision: 1e100 }]
        })
      ).toThrow();

      expect(() =>
        sharedSecretChangeRefSchema.parse({
          ...validSharedSecretRef,
          bots: [{ botId: 'bot_1', expectedRevision: 0 }]
        })
      ).toThrow();

      expect(() =>
        sharedSecretChangeRefSchema.parse({
          ...validSharedSecretRef,
          bots: [{ botId: 'bot_1', expectedRevision: -1 }]
        })
      ).toThrow();

      expect(() =>
        preparedBotRestoreSchema.parse({
          targetVersionDigest: '1'.repeat(64),
          sourceCollectionDigest: '2'.repeat(64)
        })
      ).not.toThrow();
    });

    it('validates LegacyConversionInput allows empty appIds and bots for clean zero-config conversion', () => {
      const emptyInput = {
        migrationId: 'mig_empty',
        source: {
          authority: 'legacy' as const,
          legacyCollectionDigest: 'a'.repeat(64),
          appIds: [], // Empty allowed!
          nativeConfigurationDigest: 'b'.repeat(64),
          mappingDigest: 'c'.repeat(64)
        },
        targetDigest: 'd'.repeat(64),
        bots: []
      };
      expect(() => legacyConversionInputSchema.parse(emptyInput)).not.toThrow();

      const populatedInput = {
        ...emptyInput,
        source: {
          ...emptyInput.source,
          appIds: ['cli_app_1']
        }
      };
      expect(() => legacyConversionInputSchema.parse(populatedInput)).not.toThrow();
    });

    it('channelBotPolicyPatchV2 rejects empty patch object', () => {
      expect(() => channelBotPolicyPatchV2Schema.parse({})).toThrow(/At least one field/);
    });
  });

  describe('5. 现有既有 V1 解码不受影响', () => {
    it('legacy V1 channelBotFoundationSchema parses existing valid rows', () => {
      const v1Bot = {
        schemaVersion: 1,
        id: 'bot_legacy',
        revision: 1,
        channel: 'lark',
        externalAppId: 'cli_legacy_app',
        displayName: 'Legacy Bot',
        brand: 'feishu',
        state: 'staged',
        desiredListenerState: 'disabled',
        fullTrustConfirmed: false,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z'
      };
      expect(() => channelBotFoundationSchema.parse(v1Bot)).not.toThrow();
    });

    it('legacy V1 channelBotGroupPolicySchema parses existing valid policies', () => {
      const v1Policy = {
        schemaVersion: 1,
        id: 'policy_legacy',
        revision: 1,
        channelBotId: 'bot_legacy',
        defaults: {},
        routingDefaults: { groupReplyMode: 'chat', mentionPolicy: 'always' },
        accessPolicy: { mode: 'owner_only', principalIds: [] },
        groupToolsPolicy: {
          readCeiling: false,
          discoverCeiling: false,
          sendCeiling: false,
          readDefault: false,
          discoverDefault: false,
          sendDefault: false
        },
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z'
      };
      expect(() => channelBotGroupPolicySchema.parse(v1Policy)).not.toThrow();
    });

    it('legacy V1 groupBindingSchema parses existing valid bindings', () => {
      const v1Binding = {
        schemaVersion: 1,
        id: 'binding_legacy',
        revision: 1,
        channelBotId: 'bot_legacy',
        externalChatId: 'oc_legacy_chat',
        state: 'staged',
        oncall: false,
        agentOverride: { mode: 'inherit' },
        workspaceOverride: { mode: 'inherit' },
        modelOverride: { mode: 'inherit' },
        reasoningOverride: { mode: 'inherit' },
        rolePolicyOverride: { mode: 'inherit' },
        routingOverride: {
          groupReplyMode: { mode: 'inherit' },
          mentionPolicy: { mode: 'inherit' }
        },
        accessOverride: { mode: 'inherit', principalIds: [] },
        groupToolsOverride: { read: 'inherit', discover: 'inherit', send: 'inherit' },
        presentationOverride: inheritPresentationOverride,
        reviewReasons: [],
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z'
      };
      expect(() => groupBindingSchema.parse(v1Binding)).not.toThrow();
    });
  });

  function makeTestBot(overrides: Partial<ChannelBotV2> = {}): ChannelBotV2 {
    return {
      schemaVersion: 2,
      id: 'bot_test_1',
      revision: 1,
      authorizationRevision: 1,
      connectionGeneration: 1,
      channel: 'lark',
      externalAppId: 'cli_test_app',
      displayName: 'Test Bot',
      platformDisplayName: 'Platform Name',
      brand: 'feishu',
      credentialRef: null,
      state: 'enabled',
      desiredListenerState: 'receiving',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      ...overrides
    };
  }

  function makeTestPolicy(overrides: Partial<ChannelBotPolicyV2> = {}): ChannelBotPolicyV2 {
    return {
      schemaVersion: 2,
      id: 'policy_test_1',
      revision: 1,
      channelBotId: 'bot_test_1',
      defaults: {
        agentDefinitionId: 'agent_1',
        workspace: '/workspace'
      },
      routingDefaults: {
        p2pMode: 'chat',
        groupReplyMode: 'runtime_default',
        mentionPolicy: 'always'
      },
      accessPolicy: createDefaultBotAccessPolicy(),
      execution: {
        permissionMode: 'ask',
        highRiskAccess: {
          p2p: { mode: 'entry_authorized' },
          managedGroup: { mode: 'entry_authorized' },
          newGroup: { mode: 'entry_authorized' }
        },
        riskControlMode: 'enforced',
        highRiskPattern: 'rm -rf'
      },
      presentation: {
        structuredAskCards: true,
        groupCardMention: true,
        pushIntervalMs: 500,
        traceLimit: 50,
        hideTraceOnComplete: false,
        completionReactionOnly: false,
        silentProgress: false
      },
      groupToolsPolicy: {
        readCeiling: false,
        discoverCeiling: false,
        sendCeiling: false,
        readDefault: false,
        discoverDefault: false,
        sendDefault: false
      },
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      ...overrides
    };
  }

  function makeTestBinding(overrides: Partial<GroupBindingV2> = {}): GroupBindingV2 {
    return {
      schemaVersion: 2,
      id: 'binding_test_1',
      revision: 1,
      channelBotId: 'bot_test_1',
      externalChatId: 'oc_chat_1',
      state: 'enabled',
      accessProfile: 'managed_group',
      oncall: false,
      agentOverride: { mode: 'inherit' },
      workspaceOverride: { mode: 'inherit' },
      modelOverride: { mode: 'inherit' },
      reasoningOverride: { mode: 'inherit' },
      rolePolicyOverride: { mode: 'inherit' },
      routingOverride: {
        groupReplyMode: { mode: 'inherit' },
        mentionPolicy: { mode: 'inherit' }
      },
      accessOverride: { mode: 'inherit', principalIds: [] },
      groupToolsOverride: { read: 'inherit', discover: 'inherit', send: 'inherit' },
      presentationOverride: inheritPresentationOverride,
      reviewReasons: [],
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      ...overrides
    };
  }

  function makeTestRole(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
    return {
      schemaVersion: 1,
      id: 'role_test_1',
      revision: 1,
      channelBotId: 'bot_test_1',
      principalId: 'principal_alice',
      role: 'can_talk',
      operateScope: 'none',
      actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false },
      state: 'active',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      ...overrides
    };
  }

  const testCredential = {
    schemaVersion: 1 as const,
    id: 'sec_ref_1',
    revision: 1,
    kind: 'lark_app_secret' as const,
    provider: 'local_file',
    referenceKey: 'bot_secret',
    status: 'configured' as const,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z'
  };

  const testLegacyConfirmation = {
    id: 'conf_legacy_1',
    channelBotId: 'bot_test_1',
    botRevision: 1,
    scopeDigest: 'a'.repeat(64),
    scope: {
      version: 1 as const,
      channelBotId: 'bot_test_1',
      externalAppId: 'cli_test_app',
      brand: 'feishu' as const,
      entries: []
    },
    source: 'legacy_live' as const,
    confirmedBy: null,
    confirmedAt: null,
    legacySourceDigest: 'b'.repeat(64),
    recordedAt: '2026-09-14T00:00:00.000Z'
  };

  const testUserConfirmation = {
    id: 'conf_user_1',
    channelBotId: 'bot_test_1',
    botRevision: 1,
    scopeDigest: 'c'.repeat(64),
    scope: {
      version: 1 as const,
      channelBotId: 'bot_test_1',
      externalAppId: 'cli_test_app',
      brand: 'feishu' as const,
      entries: []
    },
    source: 'user_action' as const,
    confirmedBy: { kind: 'installation_owner' as const, principalId: 'principal_installation_owner' as const },
    confirmedAt: '2026-09-14T00:00:00.000Z'
  };

  function makeBaseConversionTarget(botId = 'bot_conv_1', appId = 'cli_app_conv_1') {
    const bot = makeTestBot({
      id: botId,
      externalAppId: appId,
      displayName: 'Conversion Bot',
      platformDisplayName: 'Platform App',
      revision: 3,
      authorizationRevision: 2,
      connectionGeneration: 1,
      credentialRef: 'sec_conv_1',
      state: 'staged',
      desiredListenerState: 'paused'
    });
    const policy = makeTestPolicy({ id: 'policy_conv_1', channelBotId: botId });
    const preparedCredential = {
      secretId: 'sec_conv_1',
      expectedRevision: 1,
      provider: 'local_file',
      referenceKey: 'cred_key',
      fingerprint: '1'.repeat(64)
    };
    return { botId, externalAppId: appId, bot, policy, preparedCredential };
  }

  describe('6. BotSnapshot 与配置版本历史（BotConfigurationVersionMetadata / Version）', () => {
    it('botSnapshotSchema validates full snapshot with bindings, roles, bot, policy, credential, and confirmations', () => {
      const snapshot: BotSnapshot = {
        bot: makeTestBot({ credentialRef: 'sec_ref_1' }),
        policy: makeTestPolicy(),
        credential: testCredential,
        bindings: [makeTestBinding()],
        roles: [makeTestRole()],
        confirmations: [testLegacyConfirmation, testUserConfirmation]
      };

      const parsed = botSnapshotSchema.parse(snapshot);
      expect(parsed.bot.id).toBe('bot_test_1');
      expect(parsed.bindings).toHaveLength(1);
      expect(parsed.roles).toHaveLength(1);
      expect(parsed.confirmations).toHaveLength(2);
      expect(parsed.credential?.id).toBe('sec_ref_1');
    });

    it('botSnapshotSchema strictly rejects snapshots missing bindings or roles', () => {
      const invalidSnapshot = {
        bot: makeTestBot(),
        policy: makeTestPolicy(),
        confirmations: []
      };
      expect(() => botSnapshotSchema.parse(invalidSnapshot)).toThrow();
    });

    it('botSnapshotSchema strictly rejects unexpected properties', () => {
      const snapshotWithExtra = {
        bot: makeTestBot(),
        policy: makeTestPolicy(),
        bindings: [],
        roles: [],
        confirmations: [],
        extraProperty: 'not_allowed'
      };
      expect(() => botSnapshotSchema.parse(snapshotWithExtra)).toThrow();
    });

    it('botSnapshotSchema rejects mismatched owner channelBotId across entities', () => {
      expect(() =>
        botSnapshotSchema.parse({
          bot: makeTestBot({ id: 'bot_1' }),
          policy: makeTestPolicy({ channelBotId: 'bot_2' }),
          bindings: [],
          roles: [],
          confirmations: []
        })
      ).toThrow(/channelBotId must match/);

      expect(() =>
        botSnapshotSchema.parse({
          bot: makeTestBot({ id: 'bot_1' }),
          policy: makeTestPolicy({ channelBotId: 'bot_1' }),
          bindings: [makeTestBinding({ channelBotId: 'bot_2' })],
          roles: [],
          confirmations: []
        })
      ).toThrow(/channelBotId must match/);

      expect(() =>
        botSnapshotSchema.parse({
          bot: makeTestBot({ id: 'bot_1' }),
          policy: makeTestPolicy({ channelBotId: 'bot_1' }),
          bindings: [],
          roles: [makeTestRole({ channelBotId: 'bot_2' })],
          confirmations: []
        })
      ).toThrow(/channelBotId must match/);

      expect(() =>
        botSnapshotSchema.parse({
          bot: makeTestBot({ id: 'bot_1' }),
          policy: makeTestPolicy({ channelBotId: 'bot_1' }),
          bindings: [],
          roles: [],
          confirmations: [{ ...testLegacyConfirmation, channelBotId: 'bot_2' }]
        })
      ).toThrow(/channelBotId must match/);
    });

    it('botSnapshotSchema rejects duplicate IDs in bindings, roles, and confirmations', () => {
      expect(() =>
        botSnapshotSchema.parse({
          bot: makeTestBot(),
          policy: makeTestPolicy(),
          bindings: [makeTestBinding({ id: 'b_same', externalChatId: 'chat_1' }), makeTestBinding({ id: 'b_same', externalChatId: 'chat_2' })],
          roles: [],
          confirmations: []
        })
      ).toThrow(/Duplicate binding id/);

      expect(() =>
        botSnapshotSchema.parse({
          bot: makeTestBot(),
          policy: makeTestPolicy(),
          bindings: [makeTestBinding({ id: 'b_1', externalChatId: 'chat_same' }), makeTestBinding({ id: 'b_2', externalChatId: 'chat_same' })],
          roles: [],
          confirmations: []
        })
      ).toThrow(/Duplicate binding externalChatId/);

      expect(() =>
        botSnapshotSchema.parse({
          bot: makeTestBot(),
          policy: makeTestPolicy(),
          bindings: [],
          roles: [makeTestRole({ id: 'r_same', principalId: 'principal_alice' }), makeTestRole({ id: 'r_same', principalId: 'principal_bob' })],
          confirmations: []
        })
      ).toThrow(/Duplicate role id/);

      expect(() =>
        botSnapshotSchema.parse({
          bot: makeTestBot(),
          policy: makeTestPolicy(),
          bindings: [],
          roles: [],
          confirmations: [{ ...testLegacyConfirmation, id: 'conf_same' }, { ...testUserConfirmation, id: 'conf_same' }]
        })
      ).toThrow(/Duplicate confirmation id/);
    });

    it('botSnapshotSchema rejects mismatched credential.id and bot.credentialRef', () => {
      expect(() =>
        botSnapshotSchema.parse({
          bot: makeTestBot({ credentialRef: 'sec_ref_1' }),
          policy: makeTestPolicy(),
          credential: { ...testCredential, id: 'sec_ref_2' },
          bindings: [],
          roles: [],
          confirmations: []
        })
      ).toThrow(/must match bot\.credentialRef/);
    });

    it('botConfigurationVersionMetadataSchema validates all 8 fixed fields with safe integer revision/changeSequence', () => {
      const validMeta: BotConfigurationVersionMetadata = {
        versionId: 'ver_001',
        botId: 'bot_test_1',
        revision: 1,
        changeSequence: 1,
        changeKind: 'created',
        operationId: 'op_initial',
        createdAt: '2026-09-14T00:00:00.000Z',
        snapshotDigest: 'd'.repeat(64)
      };

      const parsed = botConfigurationVersionMetadataSchema.parse(validMeta);
      expect(parsed.versionId).toBe('ver_001');
      expect(parsed.revision).toBe(1);
      expect(parsed.changeSequence).toBe(1);
      expect(parsed.changeKind).toBe('created');

      expect(() =>
        botConfigurationVersionMetadataSchema.parse({
          ...validMeta,
          revision: Number.MAX_SAFE_INTEGER,
          changeSequence: Number.MAX_SAFE_INTEGER
        })
      ).not.toThrow();

      expect(() =>
        botConfigurationVersionMetadataSchema.parse({
          ...validMeta,
          revision: Number.MAX_SAFE_INTEGER + 1
        })
      ).toThrow();

      expect(() =>
        botConfigurationVersionMetadataSchema.parse({
          ...validMeta,
          changeSequence: Number.MAX_SAFE_INTEGER + 1
        })
      ).toThrow();

      expect(() => botConfigurationVersionMetadataSchema.parse({ ...validMeta, revision: 0 })).toThrow();
      expect(() => botConfigurationVersionMetadataSchema.parse({ ...validMeta, revision: -1 })).toThrow();
      expect(() => botConfigurationVersionMetadataSchema.parse({ ...validMeta, changeSequence: 0 })).toThrow();
      expect(() => botConfigurationVersionMetadataSchema.parse({ ...validMeta, revision: 1.5 })).toThrow();
      expect(() => botConfigurationVersionMetadataSchema.parse({ ...validMeta, changeKind: 'unknown_kind' })).toThrow();
      expect(() => botConfigurationVersionMetadataSchema.parse({ ...validMeta, extra: 123 })).toThrow();
    });

    it('botConfigurationVersionSchema roundtrips full snapshot with both legacy_live and user_action confirmations', () => {
      const snapshot: BotSnapshot = {
        bot: makeTestBot({ id: 'bot_v1', revision: 5, credentialRef: 'sec_ref_1' }),
        policy: makeTestPolicy({ channelBotId: 'bot_v1' }),
        credential: testCredential,
        bindings: [makeTestBinding({ channelBotId: 'bot_v1' })],
        roles: [makeTestRole({ channelBotId: 'bot_v1' })],
        confirmations: [
          {
            ...testLegacyConfirmation,
            channelBotId: 'bot_v1',
            scope: { ...testLegacyConfirmation.scope, channelBotId: 'bot_v1' }
          },
          {
            ...testUserConfirmation,
            channelBotId: 'bot_v1',
            scope: { ...testUserConfirmation.scope, channelBotId: 'bot_v1' }
          }
        ]
      };

      const version: BotConfigurationVersion = {
        versionId: 'ver_5',
        botId: 'bot_v1',
        revision: 5,
        changeSequence: 10,
        changeKind: 'related_mutated',
        operationId: 'op_mutate_5',
        createdAt: '2026-09-14T01:00:00.000Z',
        snapshotDigest: 'e'.repeat(64),
        snapshot
      };

      const parsed = botConfigurationVersionSchema.parse(version);
      expect(parsed.snapshot.confirmations[0]?.source).toBe('legacy_live');
      if (parsed.snapshot.confirmations[0]?.source === 'legacy_live') {
        expect(parsed.snapshot.confirmations[0].confirmedBy).toBeNull();
        expect(parsed.snapshot.confirmations[0].confirmedAt).toBeNull();
        expect(parsed.snapshot.confirmations[0].legacySourceDigest).toBe('b'.repeat(64));
      }

      expect(parsed.snapshot.confirmations[1]?.source).toBe('user_action');
      if (parsed.snapshot.confirmations[1]?.source === 'user_action') {
        expect(parsed.snapshot.confirmations[1].confirmedBy).toEqual({
          kind: 'installation_owner',
          principalId: 'principal_installation_owner'
        });
        expect(parsed.snapshot.confirmations[1].confirmedAt).toBe('2026-09-14T00:00:00.000Z');
      }

      const serialized = JSON.stringify(parsed);
      const reparsed = botConfigurationVersionSchema.parse(JSON.parse(serialized));
      expect(reparsed).toEqual(parsed);
    });

    it('botConfigurationVersionSchema enforces snapshot.bot.id === botId and snapshot.bot.revision === revision', () => {
      const snapshot: BotSnapshot = {
        bot: makeTestBot({ id: 'bot_v1', revision: 2 }),
        policy: makeTestPolicy({ channelBotId: 'bot_v1' }),
        bindings: [],
        roles: [],
        confirmations: []
      };

      expect(() =>
        botConfigurationVersionSchema.parse({
          versionId: 'ver_1',
          botId: 'bot_OTHER',
          revision: 2,
          changeSequence: 1,
          changeKind: 'updated',
          operationId: 'op_1',
          createdAt: '2026-09-14T00:00:00.000Z',
          snapshotDigest: 'f'.repeat(64),
          snapshot
        })
      ).toThrow(/snapshot\.bot\.id must match botId/);

      expect(() =>
        botConfigurationVersionSchema.parse({
          versionId: 'ver_1',
          botId: 'bot_v1',
          revision: 999,
          changeSequence: 1,
          changeKind: 'updated',
          operationId: 'op_1',
          createdAt: '2026-09-14T00:00:00.000Z',
          snapshotDigest: 'f'.repeat(64),
          snapshot
        })
      ).toThrow(/snapshot\.bot\.revision must match revision/);
    });
  });

  describe('7. ConfigurationRepository 同步签名与严格 Options Schema', () => {
    it('listBotsOptionsSchema defaults limit to 200 and accepts valid afterId', () => {
      const defaultParsed = listBotsOptionsSchema.parse({});
      expect(defaultParsed.limit).toBe(200);
      expect(defaultParsed.afterId).toBeUndefined();

      const customParsed = listBotsOptionsSchema.parse({ afterId: 'bot_last_id', limit: 100 });
      expect(customParsed.afterId).toBe('bot_last_id');
      expect(customParsed.limit).toBe(100);

      expect(listBotsOptionsSchema.parse({ limit: 500 }).limit).toBe(500);
    });

    it('listBotsOptionsSchema rejects invalid limit and invalid afterId (strict mode)', () => {
      expect(() => listBotsOptionsSchema.parse({ limit: 501 })).toThrow();
      expect(() => listBotsOptionsSchema.parse({ limit: 0 })).toThrow();
      expect(() => listBotsOptionsSchema.parse({ limit: -1 })).toThrow();
      expect(() => listBotsOptionsSchema.parse({ limit: 50.5 })).toThrow();
      expect(() => listBotsOptionsSchema.parse({ limit: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
      expect(() => listBotsOptionsSchema.parse({ afterId: '' })).toThrow();
      expect(() => listBotsOptionsSchema.parse({ extraField: 'bad' })).toThrow();
    });

    it('listVersionsOptionsSchema defaults limit to 50 and accepts valid beforeRevision', () => {
      const defaultParsed = listVersionsOptionsSchema.parse({});
      expect(defaultParsed.limit).toBe(50);
      expect(defaultParsed.beforeRevision).toBeUndefined();

      const customParsed = listVersionsOptionsSchema.parse({ beforeRevision: 25, limit: 30 });
      expect(customParsed.beforeRevision).toBe(25);
      expect(customParsed.limit).toBe(30);

      expect(listVersionsOptionsSchema.parse({ limit: 200 }).limit).toBe(200);
    });

    it('listVersionsOptionsSchema rejects invalid limit, invalid beforeRevision, and extra fields', () => {
      expect(() => listVersionsOptionsSchema.parse({ limit: 201 })).toThrow();
      expect(() => listVersionsOptionsSchema.parse({ limit: 0 })).toThrow();
      expect(() => listVersionsOptionsSchema.parse({ limit: -1 })).toThrow();
      expect(() => listVersionsOptionsSchema.parse({ limit: 20.5 })).toThrow();
      expect(() => listVersionsOptionsSchema.parse({ beforeRevision: 0 })).toThrow();
      expect(() => listVersionsOptionsSchema.parse({ beforeRevision: -5 })).toThrow();
      expect(() => listVersionsOptionsSchema.parse({ beforeRevision: 10.5 })).toThrow();
      expect(() => listVersionsOptionsSchema.parse({ beforeRevision: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
      expect(() => listVersionsOptionsSchema.parse({ unexpected: true })).toThrow();
    });
  });

  describe('8. PreparedBotConversion 凭据准备证明与关联一致性校验', () => {
    it('validates conversion target with credentialRef and matching preparedCredential proof', () => {
      const target = {
        ...makeBaseConversionTarget(),
        bindings: [],
        roles: [],
        confirmations: [],
        executionEvidence: []
      };

      const parsed = preparedBotConversionSchema.parse(target);
      expect(parsed.botId).toBe('bot_conv_1');
      expect(parsed.preparedCredential?.secretId).toBe('sec_conv_1');
      expect(parsed.bot.revision).toBe(3);
    });

    it('validates conversion target without credentialRef when preparedCredential is omitted', () => {
      const base = makeBaseConversionTarget();
      const target = {
        ...base,
        bot: { ...base.bot, credentialRef: null },
        preparedCredential: undefined,
        bindings: [],
        roles: [],
        confirmations: [],
        executionEvidence: []
      };

      const parsed = preparedBotConversionSchema.parse(target);
      expect(parsed.bot.credentialRef).toBeNull();
      expect(parsed.preparedCredential).toBeUndefined();
    });

    it('rejects conversion target with credentialRef when preparedCredential is missing or mismatched', () => {
      const base = makeBaseConversionTarget();

      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          preparedCredential: undefined,
          bindings: [],
          roles: [],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/requires preparedCredential proof/);

      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          preparedCredential: { ...base.preparedCredential, secretId: 'DIFFERENT_SEC_ID' },
          bindings: [],
          roles: [],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/must match bot\.credentialRef/);
    });

    it('rejects conversion target without credentialRef when preparedCredential is provided', () => {
      const base = makeBaseConversionTarget();
      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          bot: { ...base.bot, credentialRef: null },
          bindings: [],
          roles: [],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/Target without credentialRef cannot provide preparedCredential/);
    });

    it('rejects mismatched identity domain and owners in preparedBotConversion', () => {
      const base = makeBaseConversionTarget('bot_1', 'app_1');

      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          bot: { ...base.bot, id: 'bot_MISMATCH' },
          bindings: [],
          roles: [],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/bot\.id must match botId/);

      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          bot: { ...base.bot, externalAppId: 'app_MISMATCH' },
          bindings: [],
          roles: [],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/bot\.externalAppId must match externalAppId/);

      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          policy: { ...base.policy, channelBotId: 'bot_MISMATCH' },
          bindings: [],
          roles: [],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/policy\.channelBotId must match botId/);
    });

    it('rejects duplicate IDs across bindings, roles, and confirmations in preparedBotConversion', () => {
      const base = makeBaseConversionTarget('bot_1', 'app_1');

      const binding1 = makeTestBinding({ id: 'bind_dup', channelBotId: 'bot_1', externalChatId: 'chat_1' });
      const binding2 = makeTestBinding({ id: 'bind_dup', channelBotId: 'bot_1', externalChatId: 'chat_2' });

      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          bindings: [binding1, binding2],
          roles: [],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/Duplicate binding id/);

      const role1 = makeTestRole({ id: 'role_dup', channelBotId: 'bot_1', principalId: 'principal_alice' });
      const role2 = makeTestRole({ id: 'role_dup', channelBotId: 'bot_1', principalId: 'principal_bob' });

      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          bindings: [],
          roles: [role1, role2],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/Duplicate role id/);
    });
  });

  describe('9. Unbound Secret 安装者专用命令严格输入 Schema', () => {
    const validOp = {
      operationId: 'op_unbound_1',
      actor: { kind: 'installation_owner' as const, principalId: 'principal_installation_owner' as const }
    };

    const principalOp = {
      operationId: 'op_unbound_2',
      actor: { kind: 'principal' as const, principalId: 'principal_admin_1', channelBotId: 'bot_1' }
    };

    const newPreparedCred = {
      secretId: 'sec_unbound_new',
      expectedRevision: 0,
      provider: 'local_file',
      referenceKey: 'unbound_key_1',
      fingerprint: '3'.repeat(64)
    };

    const existingPreparedCred = {
      secretId: 'sec_unbound_rot',
      expectedRevision: 2,
      provider: 'local_file',
      referenceKey: 'unbound_key_2',
      fingerprint: '4'.repeat(64)
    };

    it('createUnboundSecretInputSchema accepts installation_owner and expectedRevision = 0', () => {
      const valid = {
        op: validOp,
        kind: 'lark_app_secret' as const,
        prepared: newPreparedCred
      };
      const parsed = createUnboundSecretInputSchema.parse(valid);
      expect(parsed.kind).toBe('lark_app_secret');
      expect(parsed.prepared.expectedRevision).toBe(0);
    });

    it('createUnboundSecretInputSchema rejects principal actor and expectedRevision > 0', () => {
      expect(() =>
        createUnboundSecretInputSchema.parse({
          op: principalOp,
          kind: 'lark_app_secret',
          prepared: newPreparedCred
        })
      ).toThrow(/Only installation_owner can create unbound secrets/);

      expect(() =>
        createUnboundSecretInputSchema.parse({
          op: validOp,
          kind: 'lark_app_secret',
          prepared: { ...newPreparedCred, expectedRevision: 1 }
        })
      ).toThrow(/expectedRevision to be 0/);
    });

    it('rotateUnboundSecretInputSchema accepts installation_owner and positive safe integer expectedRevision', () => {
      const valid = {
        op: validOp,
        prepared: existingPreparedCred
      };
      const parsed = rotateUnboundSecretInputSchema.parse(valid);
      expect(parsed.prepared.expectedRevision).toBe(2);

      expect(() =>
        rotateUnboundSecretInputSchema.parse({
          op: validOp,
          prepared: { ...existingPreparedCred, expectedRevision: Number.MAX_SAFE_INTEGER }
        })
      ).not.toThrow();
    });

    it('rotateUnboundSecretInputSchema rejects principal actor, expectedRevision = 0, negative, and unsafe integer', () => {
      expect(() =>
        rotateUnboundSecretInputSchema.parse({
          op: principalOp,
          prepared: existingPreparedCred
        })
      ).toThrow(/Only installation_owner can rotate unbound secrets/);

      expect(() =>
        rotateUnboundSecretInputSchema.parse({
          op: validOp,
          prepared: { ...existingPreparedCred, expectedRevision: 0 }
        })
      ).toThrow(/positive safe integer/);

      expect(() =>
        rotateUnboundSecretInputSchema.parse({
          op: validOp,
          prepared: { ...existingPreparedCred, expectedRevision: -1 }
        })
      ).toThrow();

      expect(() =>
        rotateUnboundSecretInputSchema.parse({
          op: validOp,
          prepared: { ...existingPreparedCred, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }
        })
      ).toThrow();
    });

    it('removeUnboundSecretInputSchema accepts installation_owner, secretId, and positive safe integer expectedRevision', () => {
      const valid = {
        op: validOp,
        secretId: 'sec_to_remove',
        expectedRevision: 3
      };
      const parsed = removeUnboundSecretInputSchema.parse(valid);
      expect(parsed.secretId).toBe('sec_to_remove');
      expect(parsed.expectedRevision).toBe(3);

      expect(() =>
        removeUnboundSecretInputSchema.parse({
          ...valid,
          expectedRevision: Number.MAX_SAFE_INTEGER
        })
      ).not.toThrow();
    });

    it('removeUnboundSecretInputSchema rejects principal actor, expectedRevision = 0, negative, and unsafe integer', () => {
      expect(() =>
        removeUnboundSecretInputSchema.parse({
          op: principalOp,
          secretId: 'sec_to_remove',
          expectedRevision: 1
        })
      ).toThrow(/Only installation_owner can remove unbound secrets/);

      expect(() =>
        removeUnboundSecretInputSchema.parse({
          op: validOp,
          secretId: 'sec_to_remove',
          expectedRevision: 0
        })
      ).toThrow();

      expect(() =>
        removeUnboundSecretInputSchema.parse({
          op: validOp,
          secretId: 'sec_to_remove',
          expectedRevision: -1
        })
      ).toThrow();

      expect(() =>
        removeUnboundSecretInputSchema.parse({
          op: validOp,
          secretId: 'sec_to_remove',
          expectedRevision: Number.MAX_SAFE_INTEGER + 1
        })
      ).toThrow();
    });
  });

  describe('10. LegacyConversionInput 全局切换输入防并发与一致性校验', () => {
    function makeMinimalBotTarget(botId: string, appId: string, secretId?: string, fingerprint = '1'.repeat(64)) {
      const bot = makeTestBot({
        id: botId,
        externalAppId: appId,
        displayName: `Bot ${botId}`,
        platformDisplayName: null,
        credentialRef: secretId ?? null,
        state: 'staged',
        desiredListenerState: 'paused'
      });
      const policy = makeTestPolicy({
        id: `pol_${botId}`,
        channelBotId: botId
      });
      return {
        botId,
        externalAppId: appId,
        bot,
        policy,
        bindings: [],
        roles: [],
        confirmations: [],
        preparedCredential: secretId
          ? {
              secretId,
              expectedRevision: 1,
              provider: 'local_file',
              referenceKey: 'ref_key',
              fingerprint
            }
          : undefined,
        executionEvidence: []
      };
    }

    it('rejects duplicate appIds in source.appIds', () => {
      const input = {
        migrationId: 'mig_dup_app',
        source: {
          authority: 'legacy' as const,
          legacyCollectionDigest: 'a'.repeat(64),
          appIds: ['cli_app_1', 'cli_app_1'],
          nativeConfigurationDigest: 'b'.repeat(64),
          mappingDigest: 'c'.repeat(64)
        },
        targetDigest: 'd'.repeat(64),
        bots: []
      };
      expect(() => legacyConversionInputSchema.parse(input)).toThrow(/Duplicate appId/);
    });

    it('rejects duplicate botId or duplicate externalAppId in conversion targets', () => {
      const target1 = makeMinimalBotTarget('bot_same', 'app_1');
      const target2 = makeMinimalBotTarget('bot_same', 'app_2');
      expect(() =>
        legacyConversionInputSchema.parse({
          migrationId: 'mig_dup_bot',
          source: {
            authority: 'legacy' as const,
            legacyCollectionDigest: 'a'.repeat(64),
            appIds: ['app_1', 'app_2'],
            nativeConfigurationDigest: 'b'.repeat(64),
            mappingDigest: 'c'.repeat(64)
          },
          targetDigest: 'd'.repeat(64),
          bots: [target1, target2]
        })
      ).toThrow(/Duplicate botId/);

      const target3 = makeMinimalBotTarget('bot_1', 'app_same');
      const target4 = makeMinimalBotTarget('bot_2', 'app_same');
      expect(() =>
        legacyConversionInputSchema.parse({
          migrationId: 'mig_dup_ext_app',
          source: {
            authority: 'legacy' as const,
            legacyCollectionDigest: 'a'.repeat(64),
            appIds: ['app_same'],
            nativeConfigurationDigest: 'b'.repeat(64),
            mappingDigest: 'c'.repeat(64)
          },
          targetDigest: 'd'.repeat(64),
          bots: [target3, target4]
        })
      ).toThrow(/Duplicate externalAppId/);
    });

    it('rejects target bot whose externalAppId is not in source.appIds fence', () => {
      const target = makeMinimalBotTarget('bot_1', 'app_NOT_IN_FENCE');
      expect(() =>
        legacyConversionInputSchema.parse({
          migrationId: 'mig_fence_miss',
          source: {
            authority: 'legacy' as const,
            legacyCollectionDigest: 'a'.repeat(64),
            appIds: ['app_legitimate'],
            nativeConfigurationDigest: 'b'.repeat(64),
            mappingDigest: 'c'.repeat(64)
          },
          targetDigest: 'd'.repeat(64),
          bots: [target]
        })
      ).toThrow(/is not present in source\.appIds fence/);
    });

    it('accepts multiple bots sharing same secretId with identical preparedCredential proof', () => {
      const sharedSecretId = 'sec_shared_1';
      const fp = '7'.repeat(64);
      const bot1 = makeMinimalBotTarget('bot_share_1', 'app_1', sharedSecretId, fp);
      const bot2 = makeMinimalBotTarget('bot_share_2', 'app_2', sharedSecretId, fp);

      const input = {
        migrationId: 'mig_shared_ok',
        source: {
          authority: 'legacy' as const,
          legacyCollectionDigest: 'a'.repeat(64),
          appIds: ['app_1', 'app_2'],
          nativeConfigurationDigest: 'b'.repeat(64),
          mappingDigest: 'c'.repeat(64)
        },
        targetDigest: 'd'.repeat(64),
        bots: [bot1, bot2]
      };

      const parsed = legacyConversionInputSchema.parse(input);
      expect(parsed.bots).toHaveLength(2);
    });

    it('rejects multiple bots sharing same secretId with conflicting preparedCredential proofs', () => {
      const sharedSecretId = 'sec_shared_conflict';
      const fp1 = '7'.repeat(64);
      const fp2 = '8'.repeat(64);
      const bot1 = makeMinimalBotTarget('bot_share_1', 'app_1', sharedSecretId, fp1);
      const bot2 = makeMinimalBotTarget('bot_share_2', 'app_2', sharedSecretId, fp2);

      const input = {
        migrationId: 'mig_shared_conflict',
        source: {
          authority: 'legacy' as const,
          legacyCollectionDigest: 'a'.repeat(64),
          appIds: ['app_1', 'app_2'],
          nativeConfigurationDigest: 'b'.repeat(64),
          mappingDigest: 'c'.repeat(64)
        },
        targetDigest: 'd'.repeat(64),
        bots: [bot1, bot2]
      };

      expect(() => legacyConversionInputSchema.parse(input)).toThrow(/Conflicting preparedCredential proof/);
    });
  });

  describe('11. Root Review 定点反例全覆盖与边界校验（F1–F3）', () => {
    it('F1: rejects snapshot with unsafe credential revision (> MAX_SAFE_INTEGER)', () => {
      const bot = makeTestBot({ credentialRef: 'sec_ref_1' });
      const policy = makeTestPolicy();
      const unsafeCred = { ...testCredential, revision: Number.MAX_SAFE_INTEGER + 1 };
      expect(() =>
        botSnapshotSchema.parse({
          bot,
          policy,
          credential: unsafeCred,
          bindings: [],
          roles: [],
          confirmations: []
        })
      ).toThrow();
    });

    it('F1: rejects snapshot with unsafe role revision (> MAX_SAFE_INTEGER)', () => {
      const bot = makeTestBot();
      const policy = makeTestPolicy();
      const unsafeRole = makeTestRole({ revision: Number.MAX_SAFE_INTEGER + 1 });
      expect(() =>
        botSnapshotSchema.parse({
          bot,
          policy,
          bindings: [],
          roles: [unsafeRole],
          confirmations: []
        })
      ).toThrow(/positive safe integer/);
    });

    it('F1: rejects conversion target with unsafe role revision (> MAX_SAFE_INTEGER)', () => {
      const base = makeBaseConversionTarget();
      const unsafeRole = makeTestRole({ channelBotId: base.botId, revision: Number.MAX_SAFE_INTEGER + 1 });
      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          bindings: [],
          roles: [unsafeRole],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/positive safe integer/);
    });

    it('F1: accepts snapshot and conversion target with MAX_SAFE_INTEGER revision', () => {
      const bot = makeTestBot({ credentialRef: 'sec_ref_1' });
      const policy = makeTestPolicy();
      const maxCred = { ...testCredential, revision: Number.MAX_SAFE_INTEGER };
      const maxBinding = makeTestBinding({ revision: Number.MAX_SAFE_INTEGER });
      const maxRole = makeTestRole({ revision: Number.MAX_SAFE_INTEGER, groupBindingId: maxBinding.id });
      const maxConf = { ...testUserConfirmation, botRevision: Number.MAX_SAFE_INTEGER };

      const snapshot = botSnapshotSchema.parse({
        bot,
        policy,
        credential: maxCred,
        bindings: [maxBinding],
        roles: [maxRole],
        confirmations: [maxConf]
      });
      expect(snapshot.credential?.revision).toBe(Number.MAX_SAFE_INTEGER);

      const base = makeBaseConversionTarget();
      const convBinding = makeTestBinding({ channelBotId: base.botId, revision: Number.MAX_SAFE_INTEGER });
      const convRole = makeTestRole({ channelBotId: base.botId, revision: Number.MAX_SAFE_INTEGER, groupBindingId: convBinding.id });
      const conversion = preparedBotConversionSchema.parse({
        ...base,
        bindings: [convBinding],
        roles: [convRole],
        confirmations: [],
        executionEvidence: []
      });
      expect(conversion.roles[0]?.revision).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('F2: rejects snapshot when bot has credentialRef but credential metadata is missing', () => {
      const bot = makeTestBot({ credentialRef: 'sec_ref_1' });
      const policy = makeTestPolicy();
      expect(() =>
        botSnapshotSchema.parse({
          bot,
          policy,
          bindings: [],
          roles: [],
          confirmations: []
        })
      ).toThrow(/requires credential metadata/);
    });

    it('F2: rejects snapshot when bot has credentialRef=null but credential metadata is provided', () => {
      const bot = makeTestBot({ credentialRef: null });
      const policy = makeTestPolicy();
      expect(() =>
        botSnapshotSchema.parse({
          bot,
          policy,
          credential: testCredential,
          bindings: [],
          roles: [],
          confirmations: []
        })
      ).toThrow(/cannot have credential metadata/);
    });

    it('F2: accepts snapshot when bot has credentialRef=null and credential metadata is omitted (valid draft)', () => {
      const bot = makeTestBot({ credentialRef: null, state: 'staged', desiredListenerState: 'paused' });
      const policy = makeTestPolicy();
      const snapshot = botSnapshotSchema.parse({
        bot,
        policy,
        bindings: [],
        roles: [],
        confirmations: []
      });
      expect(snapshot.bot.credentialRef).toBeNull();
      expect(snapshot.credential).toBeUndefined();
    });

    it('F3: rejects snapshot when role.groupBindingId references a non-existent binding', () => {
      const bot = makeTestBot();
      const policy = makeTestPolicy();
      const orphanRole = makeTestRole({ groupBindingId: 'binding_of_other_bot' });
      expect(() =>
        botSnapshotSchema.parse({
          bot,
          policy,
          bindings: [],
          roles: [orphanRole],
          confirmations: []
        })
      ).toThrow(/must reference a binding present in this target/);
    });

    it('F3: rejects conversion target when role.groupBindingId references a non-existent binding', () => {
      const base = makeBaseConversionTarget();
      const orphanRole = makeTestRole({ channelBotId: base.botId, groupBindingId: 'binding_of_other_bot' });
      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          bindings: [],
          roles: [orphanRole],
          confirmations: [],
          executionEvidence: []
        })
      ).toThrow(/must reference a binding present in this target/);
    });

    it('F3: accepts snapshot and conversion target when role.groupBindingId references a valid binding', () => {
      const bot = makeTestBot();
      const policy = makeTestPolicy();
      const binding = makeTestBinding({ id: 'binding_valid_1' });
      const role = makeTestRole({ groupBindingId: 'binding_valid_1' });

      const snapshot = botSnapshotSchema.parse({
        bot,
        policy,
        bindings: [binding],
        roles: [role],
        confirmations: []
      });
      expect(snapshot.roles[0]?.groupBindingId).toBe('binding_valid_1');

      const base = makeBaseConversionTarget();
      const convBinding = makeTestBinding({ id: 'binding_conv_1', channelBotId: base.botId });
      const convRole = makeTestRole({ channelBotId: base.botId, groupBindingId: 'binding_conv_1' });
      const conversion = preparedBotConversionSchema.parse({
        ...base,
        bindings: [convBinding],
        roles: [convRole],
        confirmations: [],
        executionEvidence: []
      });
      expect(conversion.roles[0]?.groupBindingId).toBe('binding_conv_1');
    });

    it('F3: accepts snapshot and conversion target with App-level roles (groupBindingId is undefined)', () => {
      const bot = makeTestBot();
      const policy = makeTestPolicy();
      const appRole = makeTestRole({ groupBindingId: undefined });

      const snapshot = botSnapshotSchema.parse({
        bot,
        policy,
        bindings: [],
        roles: [appRole],
        confirmations: []
      });
      expect(snapshot.roles[0]?.groupBindingId).toBeUndefined();

      const base = makeBaseConversionTarget();
      const convAppRole = makeTestRole({ channelBotId: base.botId, groupBindingId: undefined });
      const conversion = preparedBotConversionSchema.parse({
        ...base,
        bindings: [],
        roles: [convAppRole],
        confirmations: [],
        executionEvidence: []
      });
      expect(conversion.roles[0]?.groupBindingId).toBeUndefined();
    });
  });

  describe('12. Root Review Fix: F3 (Confirmation externalAppId) & F4 (expectedRevision safe integer)', () => {
    it('F3: botSnapshotSchema accepts confirmations with historical externalAppId differing from current bot.externalAppId', () => {
      const bot = makeTestBot({ id: 'bot_test_1', externalAppId: 'new_app_id' });
      const policy = makeTestPolicy({ channelBotId: 'bot_test_1' });
      const historicalConf = {
        ...testUserConfirmation,
        id: 'conf_historical_1',
        channelBotId: 'bot_test_1',
        scope: {
          ...testUserConfirmation.scope,
          channelBotId: 'bot_test_1',
          externalAppId: 'old_app_id'
        }
      };

      const snapshot = botSnapshotSchema.parse({
        bot,
        policy,
        bindings: [],
        roles: [],
        confirmations: [historicalConf]
      });
      expect(snapshot.bot.externalAppId).toBe('new_app_id');
      expect(snapshot.confirmations[0]?.scope.externalAppId).toBe('old_app_id');
    });

    it('F3: preparedBotConversionSchema strictly rejects confirmation whose scope.externalAppId does not match target.externalAppId', () => {
      const base = makeBaseConversionTarget('bot_1', 'target_app_1');
      const mismatchedConf = {
        ...testUserConfirmation,
        channelBotId: 'bot_1',
        scope: {
          ...testUserConfirmation.scope,
          channelBotId: 'bot_1',
          externalAppId: 'other_app_id'
        }
      };

      expect(() =>
        preparedBotConversionSchema.parse({
          ...base,
          bindings: [],
          roles: [],
          confirmations: [mismatchedConf],
          executionEvidence: []
        })
      ).toThrow(/confirmation\.scope\.externalAppId must match externalAppId/);
    });

    it('F4: botChangeRefSchema rejects non-safe expectedRevision', () => {
      expect(() =>
        botChangeRefSchema.parse({
          operationId: 'op_test',
          actor: { kind: 'installation_owner', principalId: 'principal_installation_owner' },
          botId: 'bot_1',
          expectedRevision: Number.MAX_SAFE_INTEGER + 1
        })
      ).toThrow();
    });

    it('F4: bindingMutationV2Schema (update) rejects non-safe expectedRevision', () => {
      expect(() =>
        bindingMutationV2Schema.parse({
          kind: 'update',
          id: 'b_1',
          channelBotId: 'bot_1',
          expectedRevision: Number.MAX_SAFE_INTEGER + 1,
          patch: { oncall: true }
        })
      ).toThrow();
    });

    it('F4: roleMutationV2Schema (update) rejects non-safe expectedRevision', () => {
      expect(() =>
        roleMutationV2Schema.parse({
          kind: 'update',
          id: 'r_1',
          channelBotId: 'bot_1',
          expectedRevision: Number.MAX_SAFE_INTEGER + 1,
          patch: { state: 'revoked' }
        })
      ).toThrow();
    });

    it('F4: botRelatedMutationSchema rejects non-safe expectedRevision in policy patch', () => {
      expect(() =>
        botRelatedMutationSchema.parse({
          policy: {
            expectedRevision: Number.MAX_SAFE_INTEGER + 1,
            patch: { defaults: { model: 'new-model' } }
          }
        })
      ).toThrow();
    });
  });
});
