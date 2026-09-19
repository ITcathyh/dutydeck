import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  RuntimeError,
  canonicalExecutionJson,
  botSnapshotSchema,
  createBotV2Schema,
  botChangeRefSchema,
  botConfigPatchV2Schema,
  botRelatedMutationSchema,
  groupBindingV2Schema,
  roleAssignmentSchema,
  channelBotPolicyDefaultsV2Schema,
  channelBotPolicyRoutingDefaultsV2Schema,
  botAccessPolicySchema,
  channelBotPolicyExecutionV2Schema,
  channelBotPolicyPresentationV2Schema,
  channelBotPolicyGroupToolsV2Schema,
  type BotSnapshot,
  type CreateBotV2,
  type BotChangeRef,
  type BotConfigPatchV2,
  type BotRelatedMutation,
  type ConfigurationRepository,
  type GroupBindingV2,
  type RoleAssignment,
  type DesiredListenerStateV2,
  type ChannelBotStateV2
} from '@dutydeck/shared';
import {
  runConfigurationCommand,
  nextConfigurationRevision,
  type ConfigurationCommand
} from './configuration-transaction.js';

export type ConfigurationCommands = Pick<
  ConfigurationRepository,
  'create' | 'update' | 'mutateRelated' | 'setReceiving' | 'setEnabled' | 'delete'
>;

function fail(code: string, message: string, status = 409): never {
  throw new RuntimeError(code, `${code}: ${message}`, status);
}

function invalidateBotFacts(db: Database.Database, botId: string, now: string, errorCode: string): void {
  const chatFacts = db.prepare('SELECT id, revision FROM remote_chat_facts WHERE channel_bot_id = ? AND invalidated_at IS NULL').all(botId) as Array<{ id: string; revision: number }>;
  for (const fact of chatFacts) {
    const nextRev = nextConfigurationRevision(fact.revision);
    db.prepare(`
      UPDATE remote_chat_facts
      SET revision = ?, expires_at = ?, invalidated_at = ?, error_code = ?, updated_at = ?
      WHERE id = ?
    `).run(nextRev, now, now, errorCode, now, fact.id);
  }

  const idFacts = db.prepare('SELECT id, revision FROM remote_identity_facts WHERE channel_bot_id = ?').all(botId) as Array<{ id: string; revision: number }>;
  for (const fact of idFacts) {
    const nextRev = nextConfigurationRevision(fact.revision);
    db.prepare(`
      UPDATE remote_identity_facts
      SET revision = ?, expires_at = CASE WHEN checked_at > ? THEN checked_at ELSE ? END, error_code = ?, updated_at = ?
      WHERE id = ?
    `).run(nextRev, now, now, errorCode, now, fact.id);
  }
}

function createCommand(db: Database.Database): ConfigurationCommand<CreateBotV2, BotSnapshot> {
  return {
    action: 'create',
    inputSchema: createBotV2Schema,
    resultSchema: botSnapshotSchema,
    operation: input => ({ operationId: input.operationId, actor: input.actor }),
    target: input => ({ botId: input.botId, externalAppId: input.externalAppId }),
    stablePayload(input) {
      const { expectedAppState: _cas, preparedCredential, ...rest } = input;
      const stableCred = preparedCredential ? (({ expectedRevision: _pCas, ...p }) => p)(preparedCredential) : undefined;
      return {
        ...rest,
        ...(stableCred ? { preparedCredential: stableCred } : {})
      };
    },
    access: input => ({ kind: 'owner', botIds: [input.botId] }),
    execute(input, context) {
      if (context.before.get(input.botId) !== undefined) {
        fail('CONFIGURATION_CONFLICT', `Bot ID "${input.botId}" already exists`);
      }
      const existingBot = db.prepare('SELECT id, state FROM channel_bots WHERE id = ?').get(input.botId);
      if (existingBot) {
        fail('CONFIGURATION_CONFLICT', `Bot ID "${input.botId}" already exists or tombstone exists`);
      }
      const existingApp = db.prepare("SELECT id, state FROM channel_bots WHERE channel = 'lark' AND external_app_id = ?").get(input.externalAppId);
      if (existingApp) {
        fail('CONFIGURATION_CONFLICT', `App "${input.externalAppId}" already exists or tombstone exists`);
      }

      let secretId: string | null = null;
      if (input.preparedCredential) {
        const cred = input.preparedCredential;
        secretId = cred.secretId;
        if (cred.expectedRevision === 0) {
          const existingSec = db.prepare('SELECT id FROM secret_refs WHERE id = ?').get(cred.secretId);
          if (existingSec) {
            fail('CONFIGURATION_CONFLICT', `SecretRef "${cred.secretId}" already exists for expectedRevision 0`);
          }
          db.prepare(`
            INSERT INTO secret_refs (
              id, schema_version, revision, kind, provider, reference_key, status, created_at, updated_at
            ) VALUES (?, 1, 1, 'lark_app_secret', ?, ?, 'configured', ?, ?)
          `).run(cred.secretId, cred.provider, cred.referenceKey, context.now, context.now);
        } else {
          const existingSec = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get(cred.secretId) as {
            id: string;
            schema_version: number;
            revision: number;
            kind: string;
            provider: string;
            reference_key: string;
            status: string;
          } | undefined;
          if (!existingSec) {
            fail('CONFIGURATION_NOT_FOUND', `Referenced secret "${cred.secretId}" does not exist`, 404);
          }
          if (existingSec.revision !== cred.expectedRevision) {
            fail('CONFIGURATION_REVISION_CONFLICT', `SecretRef revision mismatch: expected ${cred.expectedRevision}, got ${existingSec.revision}`);
          }
          if (
            existingSec.kind !== 'lark_app_secret' ||
            existingSec.provider !== cred.provider ||
            existingSec.reference_key !== cred.referenceKey ||
            existingSec.status !== 'configured'
          ) {
            fail('CONFIGURATION_CONFLICT', `SecretRef metadata mismatch for "${cred.secretId}"`);
          }
          const mismatchedFingerprints = db.prepare(`
            SELECT DISTINCT credential_fingerprint AS fp FROM (
              SELECT credential_fingerprint FROM remote_identity_facts
              WHERE credential_ref_id = ? AND credential_revision = ? AND credential_fingerprint IS NOT NULL
              UNION ALL
              SELECT credential_fingerprint FROM remote_chat_facts
              WHERE credential_ref_id = ? AND credential_revision = ? AND credential_fingerprint IS NOT NULL
            ) WHERE fp != ?
          `).all(cred.secretId, existingSec.revision, cred.secretId, existingSec.revision, cred.fingerprint) as Array<{ fp: string }>;
          if (mismatchedFingerprints.length > 0) {
            fail('CONFIGURATION_CONFLICT', `Credential fingerprint mismatch for "${cred.secretId}"`);
          }
        }
      }

      db.prepare(`
        INSERT INTO channel_bots (
          id, schema_version, revision, authorization_revision, connection_generation,
          channel, external_app_id, display_name, platform_display_name, brand,
          credential_ref, state, desired_listener_state, full_trust_confirmed,
          created_at, updated_at
        ) VALUES (
          ?, 2, 1, 1, 1,
          'lark', ?, ?, ?, ?,
          ?, 'staged', 'paused', 0,
          ?, ?
        )
      `).run(
        input.botId,
        input.externalAppId,
        input.bot.displayName,
        input.bot.platformDisplayName ?? null,
        input.bot.brand,
        secretId,
        context.now,
        context.now
      );

      db.prepare(`
        INSERT INTO channel_bot_policies (
          id, schema_version, revision, channel_bot_id,
          defaults_json, routing_defaults_json, access_policy_json,
          execution_json, presentation_json, group_tools_policy_json,
          created_at, updated_at
        ) VALUES (
          ?, 2, 1, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?
        )
      `).run(
        `policy_${input.botId}`,
        input.botId,
        canonicalExecutionJson(input.policy.defaults),
        canonicalExecutionJson(input.policy.routingDefaults),
        canonicalExecutionJson(input.policy.accessPolicy),
        canonicalExecutionJson(input.policy.execution),
        canonicalExecutionJson(input.policy.presentation),
        canonicalExecutionJson(input.policy.groupToolsPolicy),
        context.now,
        context.now
      );

      return context.recordChange(input.botId, { kind: 'created', authorization: true, connection: true });
    }
  };
}

const updateInputSchema = botChangeRefSchema.extend({ patch: botConfigPatchV2Schema });
type UpdateInput = z.infer<typeof updateInputSchema>;

function updateCommand(db: Database.Database): ConfigurationCommand<UpdateInput, BotSnapshot> {
  return {
    action: 'update',
    inputSchema: updateInputSchema,
    resultSchema: botSnapshotSchema,
    operation: input => ({ operationId: input.operationId, actor: input.actor }),
    target: input => ({ botId: input.botId }),
    stablePayload: ({ expectedRevision: _cas, ...p }) => p,
    access: input => ({ kind: 'bot', botId: input.botId }),
    execute(input, context) {
      const original = context.before.get(input.botId)!;
      if (original.bot.state === 'deleted') {
        fail('CONFIGURATION_CONFLICT', `Cannot update deleted Bot "${input.botId}"`);
      }
      if (original.bot.revision !== input.expectedRevision) {
        fail('CONFIGURATION_REVISION_CONFLICT', `Bot revision mismatch: expected ${input.expectedRevision}, got ${original.bot.revision}`);
      }

      const nextDisplayName = input.patch.displayName !== undefined ? input.patch.displayName : original.bot.displayName;
      const nextPlatformDisplayName = input.patch.platformDisplayName !== undefined ? input.patch.platformDisplayName : original.bot.platformDisplayName;
      const nextAppId = input.patch.externalAppId !== undefined ? input.patch.externalAppId : original.bot.externalAppId;
      const nextBrand = input.patch.brand !== undefined ? input.patch.brand : original.bot.brand;

      if (nextAppId !== original.bot.externalAppId) {
        const existing = db.prepare("SELECT id FROM channel_bots WHERE channel = 'lark' AND external_app_id = ? AND id != ?").get(nextAppId, input.botId);
        if (existing) {
          fail('CONFIGURATION_CONFLICT', `externalAppId "${nextAppId}" already in use by another Bot`);
        }
      }

      const displayNameChanged = nextDisplayName !== original.bot.displayName;
      const platformDisplayNameChanged = nextPlatformDisplayName !== original.bot.platformDisplayName;
      const appIdChanged = nextAppId !== original.bot.externalAppId;
      const brandChanged = nextBrand !== original.bot.brand;

      if (!displayNameChanged && !platformDisplayNameChanged && !appIdChanged && !brandChanged) {
        return original;
      }

      if (appIdChanged || brandChanged) {
        invalidateBotFacts(db, input.botId, context.now, 'REMOTE_APP_ID_CHANGED');
        db.prepare(`
          UPDATE channel_bots
          SET display_name = ?, platform_display_name = ?, external_app_id = ?, brand = ?, updated_at = ?
          WHERE id = ?
        `).run(nextDisplayName, nextPlatformDisplayName, nextAppId, nextBrand, context.now, input.botId);
        return context.recordChange(input.botId, { kind: 'updated', authorization: true, connection: true });
      } else {
        db.prepare(`
          UPDATE channel_bots
          SET display_name = ?, platform_display_name = ?, updated_at = ?
          WHERE id = ?
        `).run(nextDisplayName, nextPlatformDisplayName, context.now, input.botId);
        return context.recordChange(input.botId, { kind: 'updated', authorization: false, connection: false });
      }
    }
  };
}

const mutateRelatedInputSchema = botChangeRefSchema.extend({ change: botRelatedMutationSchema });
type MutateRelatedInput = z.infer<typeof mutateRelatedInputSchema>;

function mutateRelatedCommand(db: Database.Database): ConfigurationCommand<MutateRelatedInput, BotSnapshot> {
  return {
    action: 'mutateRelated',
    inputSchema: mutateRelatedInputSchema,
    resultSchema: botSnapshotSchema,
    operation: input => ({ operationId: input.operationId, actor: input.actor }),
    target: input => ({ botId: input.botId }),
    stablePayload(input) {
      const { expectedRevision: _botCas, change, ...rest } = input;
      const stablePolicy = change.policy ? { patch: change.policy.patch } : undefined;
      const stableBindings = change.bindings?.map(b => {
        const { expectedRevision: _bCas, ...bRest } = b;
        return bRest;
      });
      const stableRoles = change.roles?.map(r => {
        const { expectedRevision: _rCas, ...rRest } = r;
        return rRest;
      });
      return {
        ...rest,
        change: {
          ...(stablePolicy ? { policy: stablePolicy } : {}),
          ...(stableBindings ? { bindings: stableBindings } : {}),
          ...(stableRoles ? { roles: stableRoles } : {})
        }
      };
    },
    access(input) {
      if (input.change.bindings && input.change.bindings.length > 0) {
        const bindingIds = input.change.bindings.map(b => b.id);
        if (new Set(bindingIds).size !== bindingIds.length) {
          fail('CONFIGURATION_DUPLICATE_TARGET', 'Duplicate binding ID in batch');
        }
        for (const b of input.change.bindings) {
          if (b.channelBotId !== input.botId) {
            fail('CONFIGURATION_INVALID_TARGET', `Binding channelBotId "${b.channelBotId}" does not match Bot ID "${input.botId}"`);
          }
        }
      }

      if (input.change.roles && input.change.roles.length > 0) {
        const roleIds = input.change.roles.map(r => r.id);
        if (new Set(roleIds).size !== roleIds.length) {
          fail('CONFIGURATION_DUPLICATE_TARGET', 'Duplicate role ID in batch');
        }
        for (const r of input.change.roles) {
          if (r.channelBotId !== input.botId) {
            fail('CONFIGURATION_INVALID_TARGET', `Role channelBotId "${r.channelBotId}" does not match Bot ID "${input.botId}"`);
          }
        }
      }

      let requiresAppAdmin = false;
      if (input.change.policy !== undefined) {
        requiresAppAdmin = true;
      }
      if (input.change.bindings?.some(b => b.kind === 'create')) {
        requiresAppAdmin = true;
      }
      if (input.change.roles?.some(r => r.kind === 'create' && r.role.groupBindingId === undefined)) {
        requiresAppAdmin = true;
      }

      const targetGroupIds = new Set<string>();

      if (input.change.bindings) {
        for (const b of input.change.bindings) {
          if (b.kind === 'update') {
            const bRow = db.prepare('SELECT channel_bot_id FROM group_bindings WHERE id = ?').get(b.id) as { channel_bot_id: string } | undefined;
            if (!bRow || bRow.channel_bot_id !== input.botId) {
              fail('CONFIGURATION_INVALID_TARGET', `Binding "${b.id}" does not exist or belongs to another Bot`);
            }
            targetGroupIds.add(b.id);
          }
        }
      }

      if (input.change.roles) {
        for (const r of input.change.roles) {
          if (r.kind === 'create') {
            if (r.role.groupBindingId !== undefined) {
              const bRow = db.prepare('SELECT channel_bot_id FROM group_bindings WHERE id = ?').get(r.role.groupBindingId) as { channel_bot_id: string } | undefined;
              const createdInBatch = input.change.bindings?.some(b => b.kind === 'create' && b.id === r.role.groupBindingId);
              if (!bRow && !createdInBatch) {
                fail('CONFIGURATION_INVALID_TARGET', `Referenced groupBindingId "${r.role.groupBindingId}" does not exist`);
              }
              if (bRow && bRow.channel_bot_id !== input.botId) {
                fail('CONFIGURATION_INVALID_TARGET', `Referenced groupBindingId "${r.role.groupBindingId}" belongs to another Bot`);
              }
              targetGroupIds.add(r.role.groupBindingId);
            }
          } else {
            const roleRow = db.prepare('SELECT channel_bot_id, group_binding_id FROM role_assignments WHERE id = ?').get(r.id) as { channel_bot_id: string; group_binding_id: string | null } | undefined;
            if (!roleRow || roleRow.channel_bot_id !== input.botId) {
              fail('CONFIGURATION_INVALID_TARGET', `Role "${r.id}" does not exist or belongs to another Bot`);
            }
            if (roleRow.group_binding_id === null) {
              requiresAppAdmin = true;
            } else {
              targetGroupIds.add(roleRow.group_binding_id);
            }
          }
        }
      }

      if (requiresAppAdmin || targetGroupIds.size === 0) {
        return { kind: 'bot', botId: input.botId };
      }

      return {
        kind: 'bot',
        botId: input.botId,
        bindingIds: Array.from(targetGroupIds)
      };
    },
    execute(input, context) {
      const original = context.before.get(input.botId)!;
      if (original.bot.state === 'deleted') {
        fail('CONFIGURATION_CONFLICT', `Cannot mutate related entities on deleted Bot "${input.botId}"`);
      }
      if (original.bot.revision !== input.expectedRevision) {
        fail('CONFIGURATION_REVISION_CONFLICT', `Bot revision mismatch: expected ${input.expectedRevision}, got ${original.bot.revision}`);
      }

      if (input.change.policy) {
        if (original.policy.revision !== input.change.policy.expectedRevision) {
          fail('CONFIGURATION_REVISION_CONFLICT', `Policy revision mismatch: expected ${input.change.policy.expectedRevision}, got ${original.policy.revision}`);
        }
      }

      if (input.change.bindings) {
        for (const b of input.change.bindings) {
          if (b.kind === 'create') {
            if (original.bindings.some(e => e.id === b.id)) {
              fail('CONFIGURATION_CONFLICT', `Binding ID "${b.id}" already exists`);
            }
            if (original.bindings.some(e => e.externalChatId === b.binding.externalChatId)) {
              fail('CONFIGURATION_CONFLICT', `Binding with externalChatId "${b.binding.externalChatId}" already exists for this Bot`);
            }
          } else {
            const existing = original.bindings.find(e => e.id === b.id);
            if (!existing) {
              fail('CONFIGURATION_NOT_FOUND', `Binding "${b.id}" not found for update`, 404);
            }
            if (existing.revision !== b.expectedRevision) {
              fail('CONFIGURATION_REVISION_CONFLICT', `Binding revision mismatch for "${b.id}": expected ${b.expectedRevision}, got ${existing.revision}`);
            }
          }
        }
      }

      if (input.change.roles) {
        for (const r of input.change.roles) {
          if (r.kind === 'create') {
            if (original.roles.some(e => e.id === r.id)) {
              fail('CONFIGURATION_CONFLICT', `Role ID "${r.id}" already exists`);
            }
            if (r.role.groupBindingId !== undefined) {
              const bExists = original.bindings.some(b => b.id === r.role.groupBindingId) ||
                (input.change.bindings?.some(b => b.kind === 'create' && b.id === r.role.groupBindingId));
              if (!bExists) {
                fail('CONFIGURATION_INVALID_TARGET', `Role references non-existent groupBindingId "${r.role.groupBindingId}"`);
              }
            }
            const targetScope = r.role.groupBindingId;
            if (original.roles.some(e => (e.groupBindingId ?? undefined) === targetScope && e.principalId === r.role.principalId && e.role === r.role.role)) {
              fail('CONFIGURATION_CONFLICT', `Role natural key collision for principal "${r.role.principalId}" and role "${r.role.role}"`);
            }
          } else {
            const existing = original.roles.find(e => e.id === r.id);
            if (!existing) {
              fail('CONFIGURATION_NOT_FOUND', `Role "${r.id}" not found for update`, 404);
            }
            if (existing.revision !== r.expectedRevision) {
              fail('CONFIGURATION_REVISION_CONFLICT', `Role revision mismatch for "${r.id}": expected ${r.expectedRevision}, got ${existing.revision}`);
            }
          }
        }
      }

      let policyExecutionChanged = false;
      let policyPresentationChanged = false;
      let bindingChanged = false;
      let roleChanged = false;

      if (input.change.policy) {
        const patch = input.change.policy.patch;
        const defaults = { ...original.policy.defaults };
        if (patch.defaults) {
          for (const key of ['agentDefinitionId', 'workspace', 'model', 'reasoningEffort', 'rolePolicyRef'] as const) {
            if (patch.defaults[key] === null) {
              delete defaults[key];
            } else if (typeof patch.defaults[key] === 'string') {
              defaults[key] = patch.defaults[key];
            }
          }
        }
        const parsedDefaults = channelBotPolicyDefaultsV2Schema.parse(defaults);

        const routingDefaults = channelBotPolicyRoutingDefaultsV2Schema.parse({
          ...original.policy.routingDefaults,
          ...(patch.routingDefaults ?? {})
        });

        const accessPolicy = patch.accessPolicy !== undefined
          ? botAccessPolicySchema.parse(patch.accessPolicy)
          : original.policy.accessPolicy;

        const execution = channelBotPolicyExecutionV2Schema.parse({
          ...original.policy.execution,
          ...(patch.execution ?? {})
        });

        const presentation = channelBotPolicyPresentationV2Schema.parse({
          ...original.policy.presentation,
          ...(patch.presentation ?? {})
        });

        const groupToolsPolicy = channelBotPolicyGroupToolsV2Schema.parse({
          ...original.policy.groupToolsPolicy,
          ...(patch.groupToolsPolicy ?? {})
        });

        if (canonicalExecutionJson(parsedDefaults) !== canonicalExecutionJson(original.policy.defaults)) policyExecutionChanged = true;
        if (canonicalExecutionJson(routingDefaults) !== canonicalExecutionJson(original.policy.routingDefaults)) policyExecutionChanged = true;
        if (canonicalExecutionJson(accessPolicy) !== canonicalExecutionJson(original.policy.accessPolicy)) policyExecutionChanged = true;
        if (canonicalExecutionJson(execution) !== canonicalExecutionJson(original.policy.execution)) policyExecutionChanged = true;
        if (canonicalExecutionJson(groupToolsPolicy) !== canonicalExecutionJson(original.policy.groupToolsPolicy)) policyExecutionChanged = true;
        if (canonicalExecutionJson(presentation) !== canonicalExecutionJson(original.policy.presentation)) policyPresentationChanged = true;

        if (policyExecutionChanged || policyPresentationChanged) {
          const nextPolicyRev = nextConfigurationRevision(original.policy.revision);
          db.prepare(`
            UPDATE channel_bot_policies
            SET revision = ?, defaults_json = ?, routing_defaults_json = ?, access_policy_json = ?,
                execution_json = ?, presentation_json = ?, group_tools_policy_json = ?, updated_at = ?
            WHERE id = ?
          `).run(
            nextPolicyRev,
            canonicalExecutionJson(parsedDefaults),
            canonicalExecutionJson(routingDefaults),
            canonicalExecutionJson(accessPolicy),
            canonicalExecutionJson(execution),
            canonicalExecutionJson(presentation),
            canonicalExecutionJson(groupToolsPolicy),
            context.now,
            original.policy.id
          );
        }
      }

      if (input.change.bindings) {
        for (const b of input.change.bindings) {
          if (b.kind === 'create') {
            const newBinding = groupBindingV2Schema.parse({
              schemaVersion: 2,
              id: b.id,
              revision: 1,
              channelBotId: input.botId,
              externalChatId: b.binding.externalChatId,
              state: 'staged',
              accessProfile: b.binding.accessProfile,
              oncall: b.binding.oncall,
              agentOverride: b.binding.agentOverride,
              workspaceOverride: b.binding.workspaceOverride,
              modelOverride: b.binding.modelOverride,
              reasoningOverride: b.binding.reasoningOverride,
              rolePolicyOverride: b.binding.rolePolicyOverride,
              routingOverride: b.binding.routingOverride,
              accessOverride: b.binding.accessOverride,
              groupToolsOverride: b.binding.groupToolsOverride,
              presentationOverride: b.binding.presentationOverride,
              reviewReasons: b.binding.reviewReasons,
              createdAt: context.now,
              updatedAt: context.now
            });
            db.prepare(`
              INSERT INTO group_bindings (
                id, schema_version, revision, channel_bot_id, external_chat_id,
                state, access_profile, oncall, agent_override_json, workspace_override_json,
                model_override_json, reasoning_override_json, role_policy_override_json,
                routing_override_json, access_override_json, group_tools_override_json,
                presentation_override_json, review_reasons_json, created_at, updated_at
              ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?
              )
            `).run(
              newBinding.id, newBinding.schemaVersion, newBinding.revision, newBinding.channelBotId, newBinding.externalChatId,
              newBinding.state, newBinding.accessProfile, newBinding.oncall ? 1 : 0,
              canonicalExecutionJson(newBinding.agentOverride), canonicalExecutionJson(newBinding.workspaceOverride),
              canonicalExecutionJson(newBinding.modelOverride), canonicalExecutionJson(newBinding.reasoningOverride),
              canonicalExecutionJson(newBinding.rolePolicyOverride), canonicalExecutionJson(newBinding.routingOverride),
              canonicalExecutionJson(newBinding.accessOverride), canonicalExecutionJson(newBinding.groupToolsOverride),
              canonicalExecutionJson(newBinding.presentationOverride), canonicalExecutionJson(newBinding.reviewReasons),
              newBinding.createdAt, newBinding.updatedAt
            );
            bindingChanged = true;
          } else {
            const existing = original.bindings.find(e => e.id === b.id)!;
            const candidate = {
              ...existing,
              state: b.patch.state !== undefined ? b.patch.state : existing.state,
              accessProfile: b.patch.accessProfile !== undefined ? b.patch.accessProfile : existing.accessProfile,
              oncall: b.patch.oncall !== undefined ? b.patch.oncall : existing.oncall,
              agentOverride: b.patch.agentOverride !== undefined ? b.patch.agentOverride : existing.agentOverride,
              workspaceOverride: b.patch.workspaceOverride !== undefined ? b.patch.workspaceOverride : existing.workspaceOverride,
              modelOverride: b.patch.modelOverride !== undefined ? b.patch.modelOverride : existing.modelOverride,
              reasoningOverride: b.patch.reasoningOverride !== undefined ? b.patch.reasoningOverride : existing.reasoningOverride,
              rolePolicyOverride: b.patch.rolePolicyOverride !== undefined ? b.patch.rolePolicyOverride : existing.rolePolicyOverride,
              routingOverride: b.patch.routingOverride !== undefined ? b.patch.routingOverride : existing.routingOverride,
              accessOverride: b.patch.accessOverride !== undefined ? b.patch.accessOverride : existing.accessOverride,
              groupToolsOverride: b.patch.groupToolsOverride !== undefined ? b.patch.groupToolsOverride : existing.groupToolsOverride,
              presentationOverride: b.patch.presentationOverride !== undefined ? b.patch.presentationOverride : existing.presentationOverride,
              reviewReasons: b.patch.reviewReasons !== undefined ? b.patch.reviewReasons : existing.reviewReasons
            };
            if (canonicalExecutionJson(candidate) !== canonicalExecutionJson(existing)) {
              const nextRev = nextConfigurationRevision(existing.revision);
              const updated = groupBindingV2Schema.parse({
                ...candidate,
                revision: nextRev,
                updatedAt: context.now
              });
              db.prepare(`
                UPDATE group_bindings
                SET revision = ?, state = ?, access_profile = ?, oncall = ?,
                    agent_override_json = ?, workspace_override_json = ?, model_override_json = ?,
                    reasoning_override_json = ?, role_policy_override_json = ?, routing_override_json = ?,
                    access_override_json = ?, group_tools_override_json = ?, presentation_override_json = ?,
                    review_reasons_json = ?, updated_at = ?
                WHERE id = ?
              `).run(
                updated.revision, updated.state, updated.accessProfile, updated.oncall ? 1 : 0,
                canonicalExecutionJson(updated.agentOverride), canonicalExecutionJson(updated.workspaceOverride),
                canonicalExecutionJson(updated.modelOverride), canonicalExecutionJson(updated.reasoningOverride),
                canonicalExecutionJson(updated.rolePolicyOverride), canonicalExecutionJson(updated.routingOverride),
                canonicalExecutionJson(updated.accessOverride), canonicalExecutionJson(updated.groupToolsOverride),
                canonicalExecutionJson(updated.presentationOverride), canonicalExecutionJson(updated.reviewReasons),
                updated.updatedAt, updated.id
              );
              bindingChanged = true;
            }
          }
        }
      }

      if (input.change.roles) {
        for (const r of input.change.roles) {
          if (r.kind === 'create') {
            const candidateNewRole: Record<string, unknown> = {
              schemaVersion: 1,
              id: r.id,
              revision: 1,
              channelBotId: input.botId,
              principalId: r.role.principalId,
              role: r.role.role,
              operateScope: r.role.operateScope,
              actionGates: r.role.actionGates,
              state: 'active',
              createdAt: context.now,
              updatedAt: context.now
            };
            if (r.role.groupBindingId !== undefined) {
              candidateNewRole.groupBindingId = r.role.groupBindingId;
            }
            if (r.role.expiresAt !== undefined) {
              candidateNewRole.expiresAt = r.role.expiresAt;
            }
            const newRole = roleAssignmentSchema.parse(candidateNewRole);
            const scopeKey = newRole.groupBindingId ?? 'bot';
            db.prepare(`
              INSERT INTO role_assignments (
                id, schema_version, revision, channel_bot_id, group_binding_id,
                scope_key, principal_id, role, operate_scope, action_gates_json,
                state, expires_at, created_at, updated_at
              ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?
              )
            `).run(
              newRole.id, newRole.schemaVersion, newRole.revision, newRole.channelBotId,
              newRole.groupBindingId ?? null, scopeKey, newRole.principalId,
              newRole.role, newRole.operateScope, canonicalExecutionJson(newRole.actionGates),
              newRole.state, newRole.expiresAt ?? null, newRole.createdAt, newRole.updatedAt
            );
            roleChanged = true;
          } else {
            const existing = original.roles.find(e => e.id === r.id)!;
            const candidateRole: Record<string, unknown> = {
              ...existing
            };
            if (r.patch.operateScope !== undefined) candidateRole.operateScope = r.patch.operateScope;
            if (r.patch.actionGates !== undefined) candidateRole.actionGates = r.patch.actionGates;
            if (r.patch.state !== undefined) candidateRole.state = r.patch.state;
            if (r.patch.expiresAt !== undefined) {
              if (r.patch.expiresAt === null) {
                delete candidateRole.expiresAt;
              } else {
                candidateRole.expiresAt = r.patch.expiresAt;
              }
            }
            if (canonicalExecutionJson(candidateRole) !== canonicalExecutionJson(existing)) {
              const nextRev = nextConfigurationRevision(existing.revision);
              const updated = roleAssignmentSchema.parse({
                ...candidateRole,
                revision: nextRev,
                updatedAt: context.now
              });
              db.prepare(`
                UPDATE role_assignments
                SET revision = ?, operate_scope = ?, action_gates_json = ?, state = ?, expires_at = ?, updated_at = ?
                WHERE id = ?
              `).run(
                updated.revision, updated.operateScope, canonicalExecutionJson(updated.actionGates),
                updated.state, updated.expiresAt ?? null, updated.updatedAt, updated.id
              );
              roleChanged = true;
            }
          }
        }
      }

      const hasAuthChange = policyExecutionChanged || bindingChanged || roleChanged;
      const hasPresChange = policyPresentationChanged;

      if (!hasAuthChange && !hasPresChange) {
        return original;
      }

      if (hasAuthChange) {
        return context.recordChange(input.botId, { kind: 'related_mutated', authorization: true, connection: false });
      } else {
        return context.recordChange(input.botId, { kind: 'related_mutated', authorization: false, connection: false });
      }
    }
  };
}

const setReceivingInputSchema = botChangeRefSchema.extend({ receiving: z.boolean() });
type SetReceivingInput = z.infer<typeof setReceivingInputSchema>;

function setReceivingCommand(db: Database.Database): ConfigurationCommand<SetReceivingInput, BotSnapshot> {
  return {
    action: 'setReceiving',
    inputSchema: setReceivingInputSchema,
    resultSchema: botSnapshotSchema,
    operation: input => ({ operationId: input.operationId, actor: input.actor }),
    target: input => ({ botId: input.botId }),
    stablePayload: ({ expectedRevision: _cas, ...p }) => p,
    access: input => ({ kind: 'bot', botId: input.botId }),
    execute(input, context) {
      const original = context.before.get(input.botId)!;
      if (original.bot.state === 'deleted') {
        fail('CONFIGURATION_CONFLICT', `Cannot change receiving state on deleted Bot "${input.botId}"`);
      }
      if (original.bot.revision !== input.expectedRevision) {
        fail('CONFIGURATION_REVISION_CONFLICT', `Bot revision mismatch: expected ${input.expectedRevision}, got ${original.bot.revision}`);
      }

      const nextListener: DesiredListenerStateV2 = input.receiving ? 'receiving' : 'paused';
      if (original.bot.desiredListenerState === nextListener) {
        return original;
      }

      db.prepare('UPDATE channel_bots SET desired_listener_state = ?, updated_at = ? WHERE id = ?')
        .run(nextListener, context.now, input.botId);
      return context.recordChange(input.botId, { kind: 'receiving_changed', authorization: false, connection: true });
    }
  };
}

const setEnabledInputSchema = botChangeRefSchema.extend({ enabled: z.boolean() });
type SetEnabledInput = z.infer<typeof setEnabledInputSchema>;

function setEnabledCommand(db: Database.Database): ConfigurationCommand<SetEnabledInput, BotSnapshot> {
  return {
    action: 'setEnabled',
    inputSchema: setEnabledInputSchema,
    resultSchema: botSnapshotSchema,
    operation: input => ({ operationId: input.operationId, actor: input.actor }),
    target: input => ({ botId: input.botId }),
    stablePayload: ({ expectedRevision: _cas, ...p }) => p,
    access: input => ({ kind: 'bot', botId: input.botId }),
    execute(input, context) {
      const original = context.before.get(input.botId)!;
      if (original.bot.state === 'deleted') {
        fail('CONFIGURATION_CONFLICT', `Cannot change enabled state on deleted Bot "${input.botId}"`);
      }
      if (original.bot.revision !== input.expectedRevision) {
        fail('CONFIGURATION_REVISION_CONFLICT', `Bot revision mismatch: expected ${input.expectedRevision}, got ${original.bot.revision}`);
      }

      const nextState: ChannelBotStateV2 = input.enabled ? 'enabled' : 'disabled';
      if (original.bot.state === nextState) {
        return original;
      }

      const nextListener: DesiredListenerStateV2 = !input.enabled ? 'paused' : original.bot.desiredListenerState;

      db.prepare('UPDATE channel_bots SET state = ?, desired_listener_state = ?, updated_at = ? WHERE id = ?')
        .run(nextState, nextListener, context.now, input.botId);
      return context.recordChange(input.botId, { kind: 'enabled_changed', authorization: true, connection: true });
    }
  };
}

function deleteCommand(db: Database.Database): ConfigurationCommand<BotChangeRef, BotSnapshot> {
  return {
    action: 'delete',
    inputSchema: botChangeRefSchema,
    resultSchema: botSnapshotSchema,
    operation: input => ({ operationId: input.operationId, actor: input.actor }),
    target: input => ({ botId: input.botId }),
    stablePayload: ({ expectedRevision: _cas, ...p }) => p,
    access: input => ({ kind: 'bot', botId: input.botId }),
    execute(input, context) {
      const original = context.before.get(input.botId)!;
      if (original.bot.revision !== input.expectedRevision) {
        fail('CONFIGURATION_REVISION_CONFLICT', `Bot revision mismatch: expected ${input.expectedRevision}, got ${original.bot.revision}`);
      }
      if (original.bot.state === 'deleted') {
        return original;
      }

      // Delete preserves the tombstone, credentialRef, facts and all audits; it
      // only stores the post-revocation receiving intent and bumps all versions.
      db.prepare("UPDATE channel_bots SET state = 'deleted', desired_listener_state = 'paused', updated_at = ? WHERE id = ?")
        .run(context.now, input.botId);
      return context.recordChange(input.botId, { kind: 'deleted', authorization: true, connection: true });
    }
  };
}

export function createConfigurationCommands(
  db: Database.Database
): ConfigurationCommands {
  const cCmd = createCommand(db);
  const uCmd = updateCommand(db);
  const mCmd = mutateRelatedCommand(db);
  const rCmd = setReceivingCommand(db);
  const eCmd = setEnabledCommand(db);
  const dCmd = deleteCommand(db);

  return {
    create(input: CreateBotV2): BotSnapshot {
      return runConfigurationCommand(db, input, cCmd);
    },
    update(ref: BotChangeRef, patch: BotConfigPatchV2): BotSnapshot {
      canonicalExecutionJson(ref);
      if (Object.prototype.hasOwnProperty.call(ref, 'patch')) {
        fail('CONFIGURATION_INVALID_INPUT', 'ref must not contain patch property');
      }
      return runConfigurationCommand(db, { ...ref, patch }, uCmd);
    },
    mutateRelated(ref: BotChangeRef, change: BotRelatedMutation): BotSnapshot {
      canonicalExecutionJson(ref);
      if (Object.prototype.hasOwnProperty.call(ref, 'change')) {
        fail('CONFIGURATION_INVALID_INPUT', 'ref must not contain change property');
      }
      return runConfigurationCommand(db, { ...ref, change }, mCmd);
    },
    setReceiving(ref: BotChangeRef, receiving: boolean): BotSnapshot {
      canonicalExecutionJson(ref);
      if (Object.prototype.hasOwnProperty.call(ref, 'receiving')) {
        fail('CONFIGURATION_INVALID_INPUT', 'ref must not contain receiving property');
      }
      return runConfigurationCommand(db, { ...ref, receiving }, rCmd);
    },
    setEnabled(ref: BotChangeRef, enabled: boolean): BotSnapshot {
      canonicalExecutionJson(ref);
      if (Object.prototype.hasOwnProperty.call(ref, 'enabled')) {
        fail('CONFIGURATION_INVALID_INPUT', 'ref must not contain enabled property');
      }
      return runConfigurationCommand(db, { ...ref, enabled }, eCmd);
    },
    delete(ref: BotChangeRef): BotSnapshot {
      return runConfigurationCommand(db, ref, dCmd);
    }
  };
}
