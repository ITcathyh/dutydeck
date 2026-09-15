import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  RuntimeError,
  canonicalExecutionJson,
  botSnapshotSchema,
  channelBotV2Schema,
  channelBotPolicyV2Schema,
  groupBindingV2Schema,
  roleAssignmentSchema,
  fullTrustConfirmationSchema,
  botSecretRefMetadataSchema,
  botConfigurationVersionMetadataSchema,
  botConfigurationVersionSchema,
  botConfigChangeSchema,
  listBotsOptionsSchema,
  listVersionsOptionsSchema,
  type BotSnapshot,
  type ChannelBotV2,
  type ChannelBotPolicyV2,
  type GroupBindingV2,
  type RoleAssignment,
  type FullTrustConfirmation,
  type SecretRefMetadata,
  type BotConfigurationVersionMetadata,
  type BotConfigurationVersion,
  type BotConfigChange,
  type ListBotsOptionsInput,
  type ListVersionsOptionsInput,
  type ConfigurationAuthority
} from '@dutydeck/shared';

export function canonicalSnapshotJson(snapshot: BotSnapshot): string {
  return canonicalExecutionJson(snapshot);
}

export function computeSnapshotDigest(snapshot: BotSnapshot): string {
  return createHash('sha256').update(canonicalExecutionJson(snapshot)).digest('hex');
}

export interface ConfigurationReader {
  authority(): ConfigurationAuthority;
  listBots(options?: ListBotsOptionsInput): ChannelBotV2[];
  listVersions(botId: string, options?: ListVersionsOptionsInput): BotConfigurationVersionMetadata[];
  readVersion(botId: string, versionId: string): BotConfigurationVersion | undefined;
  read(botId: string): BotSnapshot | undefined;
  readByApp(appId: string): BotSnapshot | undefined;
  listChanges(afterSequence: number, limit: number): BotConfigChange[];
}

interface ChannelBotRow {
  id: string;
  schema_version: number;
  revision: number;
  authorization_revision: number | null;
  connection_generation: number | null;
  channel: string;
  external_app_id: string;
  display_name: string;
  platform_display_name: string | null;
  brand: string;
  credential_ref: string | null;
  state: string;
  desired_listener_state: string;
  full_trust_confirmed: number;
  created_at: string;
  updated_at: string;
}

interface ChannelBotPolicyRow {
  id: string;
  schema_version: number;
  revision: number;
  channel_bot_id: string;
  defaults_json: string;
  routing_defaults_json: string;
  access_policy_json: string;
  execution_json: string | null;
  presentation_json: string | null;
  group_tools_policy_json: string;
  created_at: string;
  updated_at: string;
}

interface GroupBindingRow {
  id: string;
  schema_version: number;
  revision: number;
  channel_bot_id: string;
  external_chat_id: string;
  state: string;
  access_profile: string | null;
  oncall: number;
  agent_override_json: string;
  workspace_override_json: string;
  model_override_json: string;
  reasoning_override_json: string;
  role_policy_override_json: string;
  routing_override_json: string;
  access_override_json: string;
  group_tools_override_json: string;
  presentation_override_json: string;
  review_reasons_json: string;
  created_at: string;
  updated_at: string;
}

interface RoleAssignmentRow {
  id: string;
  schema_version: number;
  revision: number;
  channel_bot_id: string;
  group_binding_id: string | null;
  scope_key: string;
  principal_id: string;
  role: string;
  operate_scope: string;
  action_gates_json: string;
  state: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FullTrustConfirmationRow {
  id: string;
  channel_bot_id: string;
  bot_revision: number;
  scope_digest: string;
  scope_json: string;
  source: string;
  confirmed_by_json: string | null;
  confirmed_at: string | null;
  legacy_source_digest: string | null;
  recorded_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

interface SecretRefRow {
  id: string;
  schema_version: number;
  revision: number;
  kind: string;
  provider: string;
  reference_key: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  version_id: string;
  bot_id: string;
  revision: number;
  change_sequence: number;
  change_kind: string;
  operation_id: string;
  created_at: string;
  snapshot_digest: string;
  snapshot_json: string;
}

interface ChangeRow {
  sequence: number;
  bot_id: string;
  change_kind: string;
  revision: number;
  authorization_revision: number;
  connection_generation: number;
  timestamp: string;
}

function fail(code: string, detail: string, statusCode = 500): never {
  throw new RuntimeError(code, `${code}: ${detail}`, statusCode);
}

function isPositiveSafeInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 1;
}

function assertPositiveSafeInteger(val: unknown, fieldName: string, entityId: string): asserts val is number {
  if (!isPositiveSafeInteger(val)) {
    fail('CONFIGURATION_CORRUPTED_RECORD', `${fieldName} on ${entityId} must be a positive safe integer, got ${String(val)}`, 500);
  }
}

function assertSnapshotVersionsSafe(snapshot: BotSnapshot): void {
  assertPositiveSafeInteger(snapshot.bot.revision, 'bot.revision', snapshot.bot.id);
  assertPositiveSafeInteger(snapshot.bot.authorizationRevision, 'bot.authorizationRevision', snapshot.bot.id);
  assertPositiveSafeInteger(snapshot.bot.connectionGeneration, 'bot.connectionGeneration', snapshot.bot.id);
  assertPositiveSafeInteger(snapshot.policy.revision, 'policy.revision', snapshot.policy.id);
  for (const binding of snapshot.bindings) {
    assertPositiveSafeInteger(binding.revision, 'binding.revision', binding.id);
  }
  for (const role of snapshot.roles) {
    assertPositiveSafeInteger(role.revision, 'role.revision', role.id);
  }
  if (snapshot.credential) {
    assertPositiveSafeInteger(snapshot.credential.revision, 'credential.revision', snapshot.credential.id);
  }
  for (const confirmation of snapshot.confirmations) {
    assertPositiveSafeInteger(confirmation.botRevision, 'confirmation.botRevision', confirmation.id);
  }
}

function parseJsonSafe<T>(jsonStr: string, fieldName: string, entityId: string): T {
  try {
    return JSON.parse(jsonStr) as T;
  } catch (error) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `Failed to parse JSON for ${fieldName} on entity ${entityId}: ${(error as Error).message}`,
      500
    );
  }
}

function decodeBotRow(row: ChannelBotRow): ChannelBotV2 {
  if (row.schema_version !== 2) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `ChannelBot ${row.id} has schema_version ${row.schema_version}, expected 2`,
      500
    );
  }
  assertPositiveSafeInteger(row.revision, 'revision', row.id);
  assertPositiveSafeInteger(row.authorization_revision, 'authorization_revision', row.id);
  assertPositiveSafeInteger(row.connection_generation, 'connection_generation', row.id);

  const parseResult = channelBotV2Schema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    revision: row.revision,
    authorizationRevision: row.authorization_revision,
    connectionGeneration: row.connection_generation,
    channel: row.channel,
    externalAppId: row.external_app_id,
    displayName: row.display_name,
    platformDisplayName: row.platform_display_name,
    brand: row.brand,
    credentialRef: row.credential_ref,
    state: row.state,
    desiredListenerState: row.desired_listener_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  if (!parseResult.success) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `Invalid ChannelBotV2 record ${row.id}: ${parseResult.error.message}`,
      500
    );
  }
  return parseResult.data;
}

function decodePolicyRow(row: ChannelBotPolicyRow): ChannelBotPolicyV2 {
  if (row.schema_version !== 2) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `Policy ${row.id} has schema_version ${row.schema_version}, expected 2`,
      500
    );
  }
  assertPositiveSafeInteger(row.revision, 'revision', row.id);
  if (!row.execution_json || !row.presentation_json) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `Policy ${row.id} missing execution_json or presentation_json in v2`,
      500
    );
  }

  const defaults = parseJsonSafe<any>(row.defaults_json, 'defaults_json', row.id);
  const routingDefaults = parseJsonSafe<any>(row.routing_defaults_json, 'routing_defaults_json', row.id);
  const accessPolicy = parseJsonSafe<any>(row.access_policy_json, 'access_policy_json', row.id);
  const execution = parseJsonSafe<any>(row.execution_json, 'execution_json', row.id);
  const presentation = parseJsonSafe<any>(row.presentation_json, 'presentation_json', row.id);
  const groupToolsPolicy = parseJsonSafe<any>(row.group_tools_policy_json, 'group_tools_policy_json', row.id);

  const parseResult = channelBotPolicyV2Schema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    revision: row.revision,
    channelBotId: row.channel_bot_id,
    defaults,
    routingDefaults,
    accessPolicy,
    execution,
    presentation,
    groupToolsPolicy,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  if (!parseResult.success) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `Invalid ChannelBotPolicyV2 record ${row.id}: ${parseResult.error.message}`,
      500
    );
  }
  return parseResult.data;
}

function decodeBindingRow(row: GroupBindingRow): GroupBindingV2 {
  if (row.schema_version !== 2) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `GroupBinding ${row.id} has schema_version ${row.schema_version}, expected 2`,
      500
    );
  }
  assertPositiveSafeInteger(row.revision, 'revision', row.id);
  if (!row.access_profile) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `GroupBinding ${row.id} missing access_profile in v2`,
      500
    );
  }

  const agentOverride = parseJsonSafe<any>(row.agent_override_json, 'agent_override_json', row.id);
  const workspaceOverride = parseJsonSafe<any>(row.workspace_override_json, 'workspace_override_json', row.id);
  const modelOverride = parseJsonSafe<any>(row.model_override_json, 'model_override_json', row.id);
  const reasoningOverride = parseJsonSafe<any>(row.reasoning_override_json, 'reasoning_override_json', row.id);
  const rolePolicyOverride = parseJsonSafe<any>(row.role_policy_override_json, 'role_policy_override_json', row.id);
  const routingOverride = parseJsonSafe<any>(row.routing_override_json, 'routing_override_json', row.id);
  const accessOverride = parseJsonSafe<any>(row.access_override_json, 'access_override_json', row.id);
  const groupToolsOverride = parseJsonSafe<any>(row.group_tools_override_json, 'group_tools_override_json', row.id);
  const presentationOverride = parseJsonSafe<any>(row.presentation_override_json, 'presentation_override_json', row.id);
  const reviewReasons = parseJsonSafe<any>(row.review_reasons_json, 'review_reasons_json', row.id);

  const parseResult = groupBindingV2Schema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    revision: row.revision,
    channelBotId: row.channel_bot_id,
    externalChatId: row.external_chat_id,
    state: row.state,
    accessProfile: row.access_profile,
    oncall: row.oncall === 1,
    agentOverride,
    workspaceOverride,
    modelOverride,
    reasoningOverride,
    rolePolicyOverride,
    routingOverride,
    accessOverride,
    groupToolsOverride,
    presentationOverride,
    reviewReasons,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  if (!parseResult.success) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `Invalid GroupBindingV2 record ${row.id}: ${parseResult.error.message}`,
      500
    );
  }
  return parseResult.data;
}

function decodeRoleRow(row: RoleAssignmentRow): RoleAssignment {
  if (row.schema_version !== 1) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `RoleAssignment ${row.id} has unexpected schema_version ${row.schema_version}`,
      500
    );
  }
  assertPositiveSafeInteger(row.revision, 'revision', row.id);

  if (row.group_binding_id === '') {
    fail('CONFIGURATION_CORRUPTED_RECORD', `RoleAssignment ${row.id} has empty string group_binding_id`, 500);
  }
  if (row.expires_at === '') {
    fail('CONFIGURATION_CORRUPTED_RECORD', `RoleAssignment ${row.id} has empty string expires_at`, 500);
  }

  const actionGates = parseJsonSafe<any>(row.action_gates_json, 'action_gates_json', row.id);

  const candidate: Record<string, unknown> = {
    schemaVersion: row.schema_version,
    id: row.id,
    revision: row.revision,
    channelBotId: row.channel_bot_id,
    principalId: row.principal_id,
    role: row.role,
    operateScope: row.operate_scope,
    actionGates,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  if (row.group_binding_id !== null) {
    candidate.groupBindingId = row.group_binding_id;
  }
  if (row.expires_at !== null) {
    candidate.expiresAt = row.expires_at;
  }

  const parseResult = roleAssignmentSchema.safeParse(candidate);

  if (!parseResult.success) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `Invalid RoleAssignment record ${row.id}: ${parseResult.error.message}`,
      500
    );
  }
  return parseResult.data;
}

function decodeConfirmationRow(row: FullTrustConfirmationRow): FullTrustConfirmation {
  assertPositiveSafeInteger(row.bot_revision, 'FullTrustConfirmation.botRevision', row.id);

  const scope = parseJsonSafe<any>(row.scope_json, 'scope_json', row.id);

  const base: Record<string, unknown> = {
    id: row.id,
    channelBotId: row.channel_bot_id,
    botRevision: row.bot_revision,
    scopeDigest: row.scope_digest,
    scope
  };

  if (row.revoked_at !== null) {
    if (row.revoked_at === '') {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} has empty string revoked_at`, 500);
    }
    base.revokedAt = row.revoked_at;
  }
  if (row.revoked_reason !== null) {
    if (row.revoked_reason === '') {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} has empty string revoked_reason`, 500);
    }
    base.revokedReason = row.revoked_reason;
  }

  let candidate: unknown;
  if (row.source === 'user_action') {
    // user_action requires non-null non-empty confirmed_by_json and confirmed_at,
    // and strictly null legacy_source_digest and recorded_at (empty string is not null).
    if (row.confirmed_by_json === null || row.confirmed_by_json === '') {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} user_action missing confirmed_by_json`, 500);
    }
    if (row.confirmed_at === null || row.confirmed_at === '') {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} user_action missing confirmed_at`, 500);
    }
    if (row.legacy_source_digest !== null) {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} user_action has conflicting legacy_source_digest`, 500);
    }
    if (row.recorded_at !== null) {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} user_action has conflicting recorded_at`, 500);
    }

    const confirmedBy = parseJsonSafe<any>(row.confirmed_by_json, 'confirmed_by_json', row.id);
    candidate = {
      ...base,
      source: 'user_action',
      confirmedBy,
      confirmedAt: row.confirmed_at
    };
  } else if (row.source === 'legacy_live') {
    // legacy_live requires non-null non-empty legacy_source_digest and recorded_at,
    // and strictly null confirmed_by_json and confirmed_at (empty string is not null).
    if (row.legacy_source_digest === null || row.legacy_source_digest === '') {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} legacy_live missing legacy_source_digest`, 500);
    }
    if (row.recorded_at === null || row.recorded_at === '') {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} legacy_live missing recorded_at`, 500);
    }
    if (row.confirmed_by_json !== null) {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} legacy_live has conflicting confirmed_by_json`, 500);
    }
    if (row.confirmed_at !== null) {
      fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} legacy_live has conflicting confirmed_at`, 500);
    }

    candidate = {
      ...base,
      source: 'legacy_live',
      confirmedBy: null,
      confirmedAt: null,
      legacySourceDigest: row.legacy_source_digest,
      recordedAt: row.recorded_at
    };
  } else {
    fail('CONFIGURATION_CORRUPTED_RECORD', `FullTrustConfirmation ${row.id} has unknown source ${row.source}`, 500);
  }

  const parseResult = fullTrustConfirmationSchema.safeParse(candidate);
  if (!parseResult.success) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `Invalid FullTrustConfirmation record ${row.id}: ${parseResult.error.message}`,
      500
    );
  }
  return parseResult.data;
}

function decodeSecretRefRow(row: SecretRefRow): SecretRefMetadata {
  if (row.schema_version !== 1) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `SecretRef ${row.id} has unexpected schema_version ${row.schema_version}`,
      500
    );
  }
  assertPositiveSafeInteger(row.revision, 'revision', row.id);

  const parseResult = botSecretRefMetadataSchema.safeParse({
    schemaVersion: row.schema_version,
    id: row.id,
    revision: row.revision,
    kind: row.kind,
    provider: row.provider,
    referenceKey: row.reference_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  if (!parseResult.success) {
    fail(
      'CONFIGURATION_CORRUPTED_RECORD',
      `Invalid SecretRefMetadata record ${row.id}: ${parseResult.error.message}`,
      500
    );
  }
  return parseResult.data;
}

export function createConfigurationReader(db: Database.Database): ConfigurationReader {
  const getAuthority = (): ConfigurationAuthority => {
    const rows = db.prepare('SELECT id, authority, migration_id, legacy_collection_digest, completed_at FROM configuration_authority').all() as Array<{
      id: number;
      authority: string;
      migration_id: string | null;
      legacy_collection_digest: string | null;
      completed_at: string | null;
    }>;

    if (rows.length === 0) {
      fail('CONFIGURATION_AUTHORITY_MISSING', 'Configuration authority row is missing', 500);
    }
    if (rows.length > 1) {
      fail('CONFIGURATION_AUTHORITY_CORRUPT', 'Configuration authority table contains multiple rows', 500);
    }
    const row = rows[0]!;
    if (row.id !== 1 || (row.authority !== 'legacy' && row.authority !== 'v2')) {
      fail('CONFIGURATION_AUTHORITY_INVALID', `Invalid configuration authority: ${JSON.stringify(row)}`, 500);
    }
    return row.authority as ConfigurationAuthority;
  };

  const assertV2Authority = (): void => {
    const auth = getAuthority();
    if (auth !== 'v2') {
      fail('CONFIGURATION_LEGACY_AUTHORITY', 'Configuration repository is currently in legacy authority mode', 409);
    }
  };

  const assembleSnapshot = (botRow: ChannelBotRow | undefined): BotSnapshot | undefined => {
    if (!botRow) return undefined;

    const bot = decodeBotRow(botRow);

    const policyRow = db.prepare('SELECT * FROM channel_bot_policies WHERE channel_bot_id = ?').get(bot.id) as ChannelBotPolicyRow | undefined;
    if (!policyRow) {
      fail('CONFIGURATION_CORRUPTED_RELATION', `ChannelBot ${bot.id} is missing policy`, 500);
    }
    const policy = decodePolicyRow(policyRow);

    let credential: SecretRefMetadata | undefined;
    if (bot.credentialRef) {
      const secretRow = db.prepare('SELECT * FROM secret_refs WHERE id = ?').get(bot.credentialRef) as SecretRefRow | undefined;
      if (!secretRow) {
        fail('CONFIGURATION_CORRUPTED_RELATION', `ChannelBot ${bot.id} references missing secret ${bot.credentialRef}`, 500);
      }
      credential = decodeSecretRefRow(secretRow);
    }

    const bindingRows = db.prepare('SELECT * FROM group_bindings WHERE channel_bot_id = ? ORDER BY id ASC').all(bot.id) as GroupBindingRow[];
    const bindings = bindingRows.map(decodeBindingRow);

    const roleRows = db.prepare('SELECT * FROM role_assignments WHERE channel_bot_id = ? ORDER BY id ASC').all(bot.id) as RoleAssignmentRow[];
    const roles = roleRows.map(decodeRoleRow);

    const confirmationRows = db.prepare(
      'SELECT * FROM full_trust_confirmations WHERE channel_bot_id = ? ORDER BY bot_revision DESC, id ASC'
    ).all(bot.id) as FullTrustConfirmationRow[];
    const confirmations = confirmationRows.map(decodeConfirmationRow);

    const snapshotCandidate = {
      bot,
      policy,
      ...(credential ? { credential } : {}),
      bindings,
      roles,
      confirmations
    };

    const parseResult = botSnapshotSchema.safeParse(snapshotCandidate);
    if (!parseResult.success) {
      fail(
        'CONFIGURATION_CORRUPTED_RECORD',
        `BotSnapshot validation failed for ${bot.id}: ${parseResult.error.message}`,
        500
      );
    }

    assertSnapshotVersionsSafe(parseResult.data);
    return parseResult.data;
  };

  return {
    authority(): ConfigurationAuthority {
      return getAuthority();
    },

    listBots(options?: ListBotsOptionsInput): ChannelBotV2[] {
      assertV2Authority();
      const parsedOptions = listBotsOptionsSchema.parse(options ?? {});
      const afterId = parsedOptions.afterId ?? null;
      const limit = parsedOptions.limit;

      const run = db.transaction((): ChannelBotV2[] => {
        const rows = db.prepare(`
          SELECT * FROM channel_bots
          WHERE (? IS NULL OR id > ?)
          ORDER BY id ASC
          LIMIT ?
        `).all(afterId, afterId, limit) as ChannelBotRow[];

        return rows.map(decodeBotRow);
      });

      return run();
    },

    read(botId: string): BotSnapshot | undefined {
      assertV2Authority();
      if (!botId || typeof botId !== 'string') {
        fail('CONFIGURATION_INVALID_INPUT', 'botId must be a non-empty string', 400);
      }

      const run = db.transaction((): BotSnapshot | undefined => {
        const botRow = db.prepare('SELECT * FROM channel_bots WHERE id = ?').get(botId) as ChannelBotRow | undefined;
        return assembleSnapshot(botRow);
      });

      return run();
    },

    readByApp(appId: string): BotSnapshot | undefined {
      assertV2Authority();
      if (!appId || typeof appId !== 'string') {
        fail('CONFIGURATION_INVALID_INPUT', 'appId must be a non-empty string', 400);
      }

      const run = db.transaction((): BotSnapshot | undefined => {
        const botRow = db.prepare("SELECT * FROM channel_bots WHERE channel = 'lark' AND external_app_id = ?").get(appId) as ChannelBotRow | undefined;
        return assembleSnapshot(botRow);
      });

      return run();
    },

    listVersions(botId: string, options?: ListVersionsOptionsInput): BotConfigurationVersionMetadata[] {
      assertV2Authority();
      if (!botId || typeof botId !== 'string') {
        fail('CONFIGURATION_INVALID_INPUT', 'botId must be a non-empty string', 400);
      }
      const parsedOptions = listVersionsOptionsSchema.parse(options ?? {});
      const beforeRevision = parsedOptions.beforeRevision ?? null;
      const limit = parsedOptions.limit;

      const run = db.transaction((): BotConfigurationVersionMetadata[] => {
        const rows = db.prepare(`
          SELECT
            v.version_id, v.bot_id, v.revision, v.change_sequence, v.change_kind, v.operation_id, v.created_at, v.snapshot_digest,
            c.bot_id AS change_bot_id, c.revision AS change_revision, c.change_kind AS change_kind_rel
          FROM configuration_versions v
          LEFT JOIN configuration_changes c ON v.change_sequence = c.sequence
          WHERE v.bot_id = ? AND (? IS NULL OR v.revision < ?)
          ORDER BY v.revision DESC
          LIMIT ?
        `).all(botId, beforeRevision, beforeRevision, limit) as Array<{
          version_id: string;
          bot_id: string;
          revision: number;
          change_sequence: number;
          change_kind: string;
          operation_id: string;
          created_at: string;
          snapshot_digest: string;
          change_bot_id: string | null;
          change_revision: number | null;
          change_kind_rel: string | null;
        }>;

        return rows.map(r => {
          if (r.change_bot_id === null) {
            fail('CONFIGURATION_CORRUPTED_RELATION', `Version ${r.version_id} references missing change sequence ${r.change_sequence}`, 500);
          }
          if (r.change_bot_id !== botId) {
            fail('CONFIGURATION_CORRUPTED_RELATION', `Version ${r.version_id} belongs to bot ${botId} but change sequence ${r.change_sequence} belongs to ${r.change_bot_id}`, 500);
          }
          if (r.change_revision !== r.revision) {
            fail('CONFIGURATION_CORRUPTED_RELATION', `Version ${r.version_id} revision ${r.revision} does not match change revision ${r.change_revision}`, 500);
          }
          if (r.change_kind_rel !== r.change_kind) {
            fail('CONFIGURATION_CORRUPTED_RELATION', `Version ${r.version_id} changeKind ${r.change_kind} does not match change changeKind ${r.change_kind_rel}`, 500);
          }

          assertPositiveSafeInteger(r.revision, 'version.revision', r.version_id);
          assertPositiveSafeInteger(r.change_sequence, 'version.changeSequence', r.version_id);

          const parseResult = botConfigurationVersionMetadataSchema.safeParse({
            versionId: r.version_id,
            botId: r.bot_id,
            revision: r.revision,
            changeSequence: r.change_sequence,
            changeKind: r.change_kind,
            operationId: r.operation_id,
            createdAt: r.created_at,
            snapshotDigest: r.snapshot_digest
          });
          if (!parseResult.success) {
            fail(
              'CONFIGURATION_CORRUPTED_RECORD',
              `Corrupted version metadata for ${r.version_id}: ${parseResult.error.message}`,
              500
            );
          }
          return parseResult.data;
        });
      });

      return run();
    },

    readVersion(botId: string, versionId: string): BotConfigurationVersion | undefined {
      assertV2Authority();
      if (!botId || typeof botId !== 'string') {
        fail('CONFIGURATION_INVALID_INPUT', 'botId must be a non-empty string', 400);
      }
      if (!versionId || typeof versionId !== 'string') {
        fail('CONFIGURATION_INVALID_INPUT', 'versionId must be a non-empty string', 400);
      }

      const run = db.transaction((): BotConfigurationVersion | undefined => {
        const row = db.prepare(`
          SELECT version_id, bot_id, revision, change_sequence, change_kind, operation_id, created_at, snapshot_digest, snapshot_json
          FROM configuration_versions
          WHERE bot_id = ? AND version_id = ?
        `).get(botId, versionId) as VersionRow | undefined;

        if (!row) return undefined;

        assertPositiveSafeInteger(row.revision, 'version.revision', row.version_id);
        assertPositiveSafeInteger(row.change_sequence, 'version.change_sequence', row.version_id);

        const changeRow = db.prepare(`
          SELECT sequence, bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp
          FROM configuration_changes
          WHERE sequence = ?
        `).get(row.change_sequence) as ChangeRow | undefined;

        if (!changeRow) {
          fail('CONFIGURATION_CORRUPTED_RELATION', `Version ${versionId} references missing change sequence ${row.change_sequence}`, 500);
        }
        if (changeRow.bot_id !== botId) {
          fail('CONFIGURATION_CORRUPTED_RELATION', `Version ${versionId} belongs to bot ${botId} but change sequence ${changeRow.sequence} belongs to ${changeRow.bot_id}`, 500);
        }
        if (changeRow.revision !== row.revision) {
          fail('CONFIGURATION_CORRUPTED_RELATION', `Version ${versionId} revision ${row.revision} does not match change revision ${changeRow.revision}`, 500);
        }
        if (changeRow.change_kind !== row.change_kind) {
          fail('CONFIGURATION_CORRUPTED_RELATION', `Version ${versionId} changeKind ${row.change_kind} does not match change changeKind ${changeRow.change_kind}`, 500);
        }

        const snapshotJson = parseJsonSafe<any>(row.snapshot_json, 'snapshot_json', row.version_id);
        const snapshotParsed = botSnapshotSchema.safeParse(snapshotJson);
        if (!snapshotParsed.success) {
          fail(
            'CONFIGURATION_CORRUPTED_RECORD',
            `Corrupted snapshot in version ${row.version_id}: ${snapshotParsed.error.message}`,
            500
          );
        }
        const snapshot = snapshotParsed.data;

        if (snapshot.bot.id !== botId || snapshot.bot.revision !== row.revision) {
          fail(
            'CONFIGURATION_CORRUPTED_RECORD',
            `Identity mismatch in snapshot version ${row.version_id}`,
            500
          );
        }

        assertSnapshotVersionsSafe(snapshot);

        if (changeRow.authorization_revision !== snapshot.bot.authorizationRevision) {
          fail(
            'CONFIGURATION_CORRUPTED_RELATION',
            `Version ${versionId} snapshot authorizationRevision ${snapshot.bot.authorizationRevision} does not match change ${changeRow.authorization_revision}`,
            500
          );
        }
        if (changeRow.connection_generation !== snapshot.bot.connectionGeneration) {
          fail(
            'CONFIGURATION_CORRUPTED_RELATION',
            `Version ${versionId} snapshot connectionGeneration ${snapshot.bot.connectionGeneration} does not match change ${changeRow.connection_generation}`,
            500
          );
        }

        const computedDigest = computeSnapshotDigest(snapshot);
        if (computedDigest !== row.snapshot_digest) {
          fail(
            'CONFIGURATION_VERSION_DIGEST_MISMATCH',
            `Snapshot digest mismatch for version ${versionId}: expected ${row.snapshot_digest}, got ${computedDigest}`,
            500
          );
        }

        const versionCandidate = {
          versionId: row.version_id,
          botId: row.bot_id,
          revision: row.revision,
          changeSequence: row.change_sequence,
          changeKind: row.change_kind,
          operationId: row.operation_id,
          createdAt: row.created_at,
          snapshotDigest: row.snapshot_digest,
          snapshot
        };

        const versionParsed = botConfigurationVersionSchema.safeParse(versionCandidate);
        if (!versionParsed.success) {
          fail(
            'CONFIGURATION_CORRUPTED_RECORD',
            `Invalid BotConfigurationVersion ${row.version_id}: ${versionParsed.error.message}`,
            500
          );
        }
        return versionParsed.data;
      });

      return run();
    },

    listChanges(afterSequence: number, limit: number): BotConfigChange[] {
      assertV2Authority();
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        fail('CONFIGURATION_INVALID_INPUT', 'afterSequence must be a non-negative safe integer', 400);
      }
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
        fail('CONFIGURATION_INVALID_INPUT', 'limit must be a positive safe integer <= 500', 400);
      }

      const run = db.transaction((): BotConfigChange[] => {
        const rows = db.prepare(`
          SELECT sequence, bot_id, change_kind, revision, authorization_revision, connection_generation, timestamp
          FROM configuration_changes
          WHERE sequence > ?
          ORDER BY sequence ASC
          LIMIT ?
        `).all(afterSequence, limit) as ChangeRow[];

        return rows.map(r => {
          assertPositiveSafeInteger(r.sequence, 'change.sequence', String(r.sequence));
          assertPositiveSafeInteger(r.revision, 'change.revision', String(r.sequence));
          assertPositiveSafeInteger(r.authorization_revision, 'change.authorizationRevision', String(r.sequence));
          assertPositiveSafeInteger(r.connection_generation, 'change.connectionGeneration', String(r.sequence));

          const parseResult = botConfigChangeSchema.safeParse({
            sequence: r.sequence,
            botId: r.bot_id,
            changeKind: r.change_kind,
            revision: r.revision,
            authorizationRevision: r.authorization_revision,
            connectionGeneration: r.connection_generation,
            timestamp: r.timestamp
          });
          if (!parseResult.success) {
            fail(
              'CONFIGURATION_CORRUPTED_RECORD',
              `Corrupted change record sequence ${r.sequence}: ${parseResult.error.message}`,
              500
            );
          }
          return parseResult.data;
        });
      });

      return run();
    }
  };
}
