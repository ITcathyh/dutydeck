import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  RuntimeError,
  channelBotGroupPolicySchema,
  createChannelBotGroupPolicyInputSchema,
  createGroupBindingInputSchema,
  createRemoteChatFactInputSchema,
  createRoleAssignmentInputSchema,
  groupBindingSchema,
  invalidateRemoteFactInputSchema,
  remoteChatFactValidity,
  remoteChatFactSchema,
  remoteIdentityFactSchema,
  roleAssignmentSchema,
  upsertRemoteChatFactInputSchema,
  upsertRemoteIdentityFactInputSchema,
  updateChannelBotGroupPolicyInputSchema,
  updateGroupBindingInputSchema,
  updateRemoteChatFactInputSchema,
  updateRoleAssignmentInputSchema,
  type ChannelBotGroupPolicy,
  type ChannelBotGroupPolicyRepository,
  type CreateChannelBotGroupPolicyInput,
  type CreateGroupBindingInput,
  type CreateRemoteChatFactInput,
  type CreateRoleAssignmentInput,
  type GroupBinding,
  type GroupBindingRepository,
  type GroupPolicyRepository,
  type GroupPolicyTransactionContext,
  type InvalidateRemoteFactInput,
  type RemoteChatFact,
  type RemoteChatFactRepository,
  type RemoteFactRepository,
  type RemoteIdentityFact,
  type RemoteIdentityFactRepository,
  type RoleAssignment,
  type RoleAssignmentRepository,
  type UpdateChannelBotGroupPolicyInput,
  type UpdateGroupBindingInput,
  type UpdateRemoteChatFactInput,
  type UpdateRoleAssignmentInput,
  type UpsertRemoteChatFactInput,
  type UpsertRemoteIdentityFactInput
} from '@dutydeck/shared';

type Wp1aEntity = ChannelBotGroupPolicy | GroupBinding | RemoteChatFact | RoleAssignment;
type Wp1aEntityKind = 'channel_bot_policy' | 'group_binding' | 'remote_chat_fact' | 'role_assignment';
type EntityKind = Wp1aEntityKind | 'remote_identity_fact';

interface ChannelBotPolicyRow {
  id: string; schema_version: number; revision: number; channel_bot_id: string;
  defaults_json: string; routing_defaults_json: string; access_policy_json: string; group_tools_policy_json: string;
  created_at: string; updated_at: string;
}
interface GroupBindingRow {
  id: string; schema_version: number; revision: number; channel_bot_id: string; external_chat_id: string;
  state: string; oncall: number; agent_override_json: string; workspace_override_json: string; model_override_json: string;
  reasoning_override_json: string; role_policy_override_json: string; routing_override_json: string; access_override_json: string;
  group_tools_override_json: string; presentation_override_json: string; review_reasons_json: string; created_at: string; updated_at: string;
}
interface RemoteChatFactRow {
  id: string; schema_version: number; revision: number; channel_bot_id: string; external_chat_id: string;
  membership_state: string; chat_type: string; display_name: string | null; observed_at: string; last_success_at: string | null;
  error_code: string | null; credential_ref_id: string | null; credential_revision: number | null;
  credential_fingerprint: string | null; identity_fact_id: string | null; identity_revision: number | null;
  expires_at: string; invalidated_at: string | null; created_at: string; updated_at: string;
}
interface RemoteIdentityFactRow {
  id: string; schema_version: number; revision: number; channel_bot_id: string; credential_ref_id: string;
  credential_revision: number; credential_fingerprint: string; app_fingerprint: string; bot_identity_ref: string;
  tenant_ref: string | null; app_id_match: number; checked_at: string; expires_at: string; error_code: string | null;
  created_at: string; updated_at: string;
}
interface RoleAssignmentRow {
  id: string; schema_version: number; revision: number; channel_bot_id: string; group_binding_id: string | null;
  principal_id: string; role: string; operate_scope: string; action_gates_json: string; state: string; expires_at: string | null;
  created_at: string; updated_at: string;
}

function decodeChannelBotPolicy(row: ChannelBotPolicyRow): ChannelBotGroupPolicy {
  return channelBotGroupPolicySchema.parse({
    schemaVersion: row.schema_version, id: row.id, revision: row.revision, channelBotId: row.channel_bot_id,
    defaults: JSON.parse(row.defaults_json), routingDefaults: JSON.parse(row.routing_defaults_json),
    accessPolicy: JSON.parse(row.access_policy_json), groupToolsPolicy: JSON.parse(row.group_tools_policy_json),
    createdAt: row.created_at, updatedAt: row.updated_at
  });
}
function decodeGroupBinding(row: GroupBindingRow): GroupBinding {
  return groupBindingSchema.parse({
    schemaVersion: row.schema_version, id: row.id, revision: row.revision, channelBotId: row.channel_bot_id,
    externalChatId: row.external_chat_id, state: row.state, oncall: Boolean(row.oncall),
    agentOverride: JSON.parse(row.agent_override_json), workspaceOverride: JSON.parse(row.workspace_override_json),
    modelOverride: JSON.parse(row.model_override_json), reasoningOverride: JSON.parse(row.reasoning_override_json),
    rolePolicyOverride: JSON.parse(row.role_policy_override_json), routingOverride: JSON.parse(row.routing_override_json),
    accessOverride: JSON.parse(row.access_override_json), groupToolsOverride: JSON.parse(row.group_tools_override_json),
    presentationOverride: JSON.parse(row.presentation_override_json), reviewReasons: JSON.parse(row.review_reasons_json),
    createdAt: row.created_at, updatedAt: row.updated_at
  });
}
function decodeRemoteChatFact(row: RemoteChatFactRow): RemoteChatFact {
  return remoteChatFactSchema.parse({
    schemaVersion: row.schema_version, id: row.id, revision: row.revision, channelBotId: row.channel_bot_id,
    externalChatId: row.external_chat_id, membershipState: row.membership_state, chatType: row.chat_type,
    displayName: row.display_name ?? undefined, observedAt: row.observed_at, lastSuccessAt: row.last_success_at ?? undefined,
    errorCode: row.error_code ?? undefined, credentialRefId: row.credential_ref_id ?? undefined,
    credentialRevision: row.credential_revision ?? undefined, credentialFingerprint: row.credential_fingerprint ?? undefined,
    identityFactId: row.identity_fact_id ?? undefined, identityRevision: row.identity_revision ?? undefined,
    expiresAt: row.expires_at, invalidatedAt: row.invalidated_at ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at
  });
}
function decodeRemoteIdentityFact(row: RemoteIdentityFactRow): RemoteIdentityFact {
  return remoteIdentityFactSchema.parse({
    schemaVersion: row.schema_version, id: row.id, revision: row.revision, channelBotId: row.channel_bot_id,
    credentialRefId: row.credential_ref_id, credentialRevision: row.credential_revision,
    credentialFingerprint: row.credential_fingerprint, appFingerprint: row.app_fingerprint,
    botIdentityRef: row.bot_identity_ref, tenantRef: row.tenant_ref ?? undefined, appIdMatch: Boolean(row.app_id_match),
    checkedAt: row.checked_at, expiresAt: row.expires_at, errorCode: row.error_code ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at
  });
}
function decodeRoleAssignment(row: RoleAssignmentRow): RoleAssignment {
  return roleAssignmentSchema.parse({
    schemaVersion: row.schema_version, id: row.id, revision: row.revision, channelBotId: row.channel_bot_id,
    groupBindingId: row.group_binding_id ?? undefined, principalId: row.principal_id, role: row.role,
    operateScope: row.operate_scope, actionGates: JSON.parse(row.action_gates_json), state: row.state,
    expiresAt: row.expires_at ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at
  });
}

function hash(entity: Wp1aEntity): string {
  return createHash('sha256').update(JSON.stringify(entity)).digest('hex');
}
function boundedLimit(limit = 200): number {
  return Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 200));
}
function notFound(kind: EntityKind, id: string): RuntimeError {
  return new RuntimeError('FOUNDATION_NOT_FOUND', `${kind} ${id} was not found`, 404);
}
function conflict(kind: EntityKind, identity: string): RuntimeError {
  return new RuntimeError('FOUNDATION_NATURAL_KEY_CONFLICT', `${kind} already exists for ${identity}`, 409);
}
function revisionConflict(kind: EntityKind, id: string, revision: number): RuntimeError {
  return new RuntimeError('FOUNDATION_REVISION_CONFLICT', `${kind} ${id} is no longer at revision ${revision}`, 409);
}
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then?: unknown }).then === 'function';
}

export interface Wp1aRepositories {
  groupBindings: GroupBindingRepository;
  channelBotPolicies: ChannelBotGroupPolicyRepository;
  remoteChatFacts: RemoteChatFactRepository;
  remoteIdentityFacts: RemoteIdentityFactRepository;
  remoteFacts: RemoteFactRepository;
  roleAssignments: RoleAssignmentRepository;
  groupPolicy: GroupPolicyRepository;
}

export function createWp1aRepositories(sqlite: Database.Database): Wp1aRepositories {
  const selectPolicy = sqlite.prepare('SELECT * FROM channel_bot_policies WHERE id = ?');
  const selectBinding = sqlite.prepare('SELECT * FROM group_bindings WHERE id = ?');
  const selectFact = sqlite.prepare('SELECT * FROM remote_chat_facts WHERE id = ?');
  const selectIdentityFact = sqlite.prepare('SELECT * FROM remote_identity_facts WHERE id = ?');
  const selectRole = sqlite.prepare('SELECT * FROM role_assignments WHERE id = ?');
  const getPolicy = (id: string) => { const row = selectPolicy.get(id) as ChannelBotPolicyRow | undefined; return row ? decodeChannelBotPolicy(row) : undefined; };
  const getBinding = (id: string) => { const row = selectBinding.get(id) as GroupBindingRow | undefined; return row ? decodeGroupBinding(row) : undefined; };
  const getFact = (id: string) => { const row = selectFact.get(id) as RemoteChatFactRow | undefined; return row ? decodeRemoteChatFact(row) : undefined; };
  const getIdentityFact = (id: string) => { const row = selectIdentityFact.get(id) as RemoteIdentityFactRow | undefined; return row ? decodeRemoteIdentityFact(row) : undefined; };
  const getRole = (id: string) => { const row = selectRole.get(id) as RoleAssignmentRow | undefined; return row ? decodeRoleAssignment(row) : undefined; };
  const getPolicyByBot = (channelBotId: string) => { const row = sqlite.prepare('SELECT * FROM channel_bot_policies WHERE channel_bot_id = ?').get(channelBotId) as ChannelBotPolicyRow | undefined; return row ? decodeChannelBotPolicy(row) : undefined; };
  const getBindingByNaturalKey = (channelBotId: string, externalChatId: string) => { const row = sqlite.prepare('SELECT * FROM group_bindings WHERE channel_bot_id = ? AND external_chat_id = ?').get(channelBotId, externalChatId) as GroupBindingRow | undefined; return row ? decodeGroupBinding(row) : undefined; };
  const getFactByNaturalKey = (channelBotId: string, externalChatId: string) => { const row = sqlite.prepare('SELECT * FROM remote_chat_facts WHERE channel_bot_id = ? AND external_chat_id = ?').get(channelBotId, externalChatId) as RemoteChatFactRow | undefined; return row ? decodeRemoteChatFact(row) : undefined; };
  const getIdentityFactByBot = (channelBotId: string) => { const row = sqlite.prepare('SELECT * FROM remote_identity_facts WHERE channel_bot_id = ?').get(channelBotId) as RemoteIdentityFactRow | undefined; return row ? decodeRemoteIdentityFact(row) : undefined; };
  const assertBot = (id: string) => { if (!sqlite.prepare('SELECT 1 FROM channel_bots WHERE id = ?').get(id)) throw new RuntimeError('FOUNDATION_CHANNEL_BOT_NOT_FOUND', `ChannelBot ${id} was not found`, 409); };
  const assertBinding = (id: string | undefined, channelBotId: string) => {
    if (!id) return;
    const binding = getBinding(id);
    if (!binding || binding.channelBotId !== channelBotId) throw new RuntimeError('FOUNDATION_GROUP_BINDING_NOT_FOUND', `GroupBinding ${id} was not found for ChannelBot ${channelBotId}`, 409);
  };
  const recordVersion = (kind: Wp1aEntityKind, entity: Wp1aEntity, before?: Wp1aEntity) => {
    sqlite.prepare(`INSERT INTO wp1a_entity_versions (entity_kind, entity_id, from_revision, to_revision, before_json, after_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, entity.id, before?.revision ?? null, entity.revision, before ? JSON.stringify(before) : null, hash(entity), new Date().toISOString());
  };
  const assertCredentialBinding = (channelBotId: string, credentialRefId: string, credentialRevision: number): void => {
    const bot = sqlite.prepare('SELECT credential_ref FROM channel_bots WHERE id = ?').get(channelBotId) as { credential_ref: string | null } | undefined;
    if (!bot) throw new RuntimeError('FOUNDATION_CHANNEL_BOT_NOT_FOUND', `ChannelBot ${channelBotId} was not found`, 409);
    if (bot.credential_ref !== credentialRefId) throw new RuntimeError('REMOTE_IDENTITY_CREDENTIAL_REF_MISMATCH', 'Remote identity credential does not match the ChannelBot credential reference', 409);
    const secret = sqlite.prepare('SELECT revision, status, kind FROM secret_refs WHERE id = ?').get(credentialRefId) as { revision: number; status: string; kind: string } | undefined;
    if (!secret || secret.revision !== credentialRevision || secret.status !== 'configured' || secret.kind !== 'lark_app_secret') {
      throw new RuntimeError('REMOTE_IDENTITY_CREDENTIAL_VERSION_MISMATCH', 'Remote identity credential revision is missing, stale, or unavailable', 409);
    }
  };

  const createPolicy = (raw: CreateChannelBotGroupPolicyInput): ChannelBotGroupPolicy => {
    const input = createChannelBotGroupPolicyInputSchema.parse(raw);
    assertBot(input.channelBotId);
    if (getPolicy(input.id) || getPolicyByBot(input.channelBotId)) throw conflict('channel_bot_policy', input.channelBotId);
    const timestamp = new Date().toISOString();
    const entity = channelBotGroupPolicySchema.parse({ ...input, schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp });
    sqlite.prepare(`INSERT INTO channel_bot_policies (id, schema_version, revision, channel_bot_id, defaults_json, routing_defaults_json, access_policy_json, group_tools_policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entity.id, 1, 1, entity.channelBotId, JSON.stringify(entity.defaults), JSON.stringify(entity.routingDefaults), JSON.stringify(entity.accessPolicy), JSON.stringify(entity.groupToolsPolicy), timestamp, timestamp);
    recordVersion('channel_bot_policy', entity);
    return entity;
  };
  const updatePolicy = (id: string, raw: UpdateChannelBotGroupPolicyInput): ChannelBotGroupPolicy => {
    const input = updateChannelBotGroupPolicyInputSchema.parse(raw);
    const current = getPolicy(id);
    if (!current) throw notFound('channel_bot_policy', id);
    if (current.revision !== input.expectedRevision) throw revisionConflict('channel_bot_policy', id, input.expectedRevision);
    const next = channelBotGroupPolicySchema.parse({ ...current, revision: current.revision + 1, defaults: input.defaults ?? current.defaults, routingDefaults: input.routingDefaults ?? current.routingDefaults, accessPolicy: input.accessPolicy ?? current.accessPolicy, groupToolsPolicy: input.groupToolsPolicy ?? current.groupToolsPolicy, updatedAt: new Date().toISOString() });
    const result = sqlite.prepare(`UPDATE channel_bot_policies SET revision = ?, defaults_json = ?, routing_defaults_json = ?, access_policy_json = ?, group_tools_policy_json = ?, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(next.revision, JSON.stringify(next.defaults), JSON.stringify(next.routingDefaults), JSON.stringify(next.accessPolicy), JSON.stringify(next.groupToolsPolicy), next.updatedAt, id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('channel_bot_policy', id, input.expectedRevision);
    recordVersion('channel_bot_policy', next, current);
    return next;
  };

  const createBinding = (raw: CreateGroupBindingInput): GroupBinding => {
    const input = createGroupBindingInputSchema.parse(raw);
    assertBot(input.channelBotId);
    if (getBinding(input.id) || getBindingByNaturalKey(input.channelBotId, input.externalChatId)) throw conflict('group_binding', `${input.channelBotId}/${input.externalChatId}`);
    const timestamp = new Date().toISOString();
    const entity = groupBindingSchema.parse({ ...input, schemaVersion: 1, revision: 1, state: 'staged', presentationOverride: { mode: 'inherit' }, createdAt: timestamp, updatedAt: timestamp });
    sqlite.prepare(`INSERT INTO group_bindings (id, schema_version, revision, channel_bot_id, external_chat_id, state, oncall, agent_override_json, workspace_override_json, model_override_json, reasoning_override_json, role_policy_override_json, routing_override_json, access_override_json, group_tools_override_json, presentation_override_json, review_reasons_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entity.id, 1, 1, entity.channelBotId, entity.externalChatId, entity.state, entity.oncall ? 1 : 0, JSON.stringify(entity.agentOverride), JSON.stringify(entity.workspaceOverride), JSON.stringify(entity.modelOverride), JSON.stringify(entity.reasoningOverride), JSON.stringify(entity.rolePolicyOverride), JSON.stringify(entity.routingOverride), JSON.stringify(entity.accessOverride), JSON.stringify(entity.groupToolsOverride), JSON.stringify(entity.presentationOverride), JSON.stringify(entity.reviewReasons), timestamp, timestamp);
    recordVersion('group_binding', entity);
    return entity;
  };
  const updateBinding = (id: string, raw: UpdateGroupBindingInput): GroupBinding => {
    const input = updateGroupBindingInputSchema.parse(raw);
    const current = getBinding(id);
    if (!current) throw notFound('group_binding', id);
    if (current.revision !== input.expectedRevision) throw revisionConflict('group_binding', id, input.expectedRevision);
    const next = groupBindingSchema.parse({ ...current, ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'expectedRevision')), revision: current.revision + 1, updatedAt: new Date().toISOString() });
    const result = sqlite.prepare(`UPDATE group_bindings SET revision = ?, state = ?, oncall = ?, agent_override_json = ?, workspace_override_json = ?, model_override_json = ?, reasoning_override_json = ?, role_policy_override_json = ?, routing_override_json = ?, access_override_json = ?, group_tools_override_json = ?, review_reasons_json = ?, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(next.revision, next.state, next.oncall ? 1 : 0, JSON.stringify(next.agentOverride), JSON.stringify(next.workspaceOverride), JSON.stringify(next.modelOverride), JSON.stringify(next.reasoningOverride), JSON.stringify(next.rolePolicyOverride), JSON.stringify(next.routingOverride), JSON.stringify(next.accessOverride), JSON.stringify(next.groupToolsOverride), JSON.stringify(next.reviewReasons), next.updatedAt, id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('group_binding', id, input.expectedRevision);
    recordVersion('group_binding', next, current);
    return next;
  };

  const createFact = (raw: CreateRemoteChatFactInput): RemoteChatFact => {
    const input = createRemoteChatFactInputSchema.parse(raw);
    assertBot(input.channelBotId);
    if (getFact(input.id) || getFactByNaturalKey(input.channelBotId, input.externalChatId)) throw conflict('remote_chat_fact', `${input.channelBotId}/${input.externalChatId}`);
    const timestamp = new Date().toISOString();
    const entity = remoteChatFactSchema.parse({ ...input, schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp });
    sqlite.prepare(`INSERT INTO remote_chat_facts (id, schema_version, revision, channel_bot_id, external_chat_id, membership_state, chat_type, display_name, observed_at, last_success_at, error_code, credential_ref_id, credential_revision, credential_fingerprint, identity_fact_id, identity_revision, expires_at, invalidated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entity.id, 1, 1, entity.channelBotId, entity.externalChatId, entity.membershipState, entity.chatType, entity.displayName ?? null, entity.observedAt, entity.lastSuccessAt ?? null, entity.errorCode ?? null, null, null, null, null, null, entity.expiresAt, null, timestamp, timestamp);
    recordVersion('remote_chat_fact', entity);
    return entity;
  };
  const updateFact = (id: string, raw: UpdateRemoteChatFactInput): RemoteChatFact => {
    const input = updateRemoteChatFactInputSchema.parse(raw);
    const current = getFact(id);
    if (!current) throw notFound('remote_chat_fact', id);
    if (current.revision !== input.expectedRevision) throw revisionConflict('remote_chat_fact', id, input.expectedRevision);
    const next = remoteChatFactSchema.parse({ ...current, revision: current.revision + 1, membershipState: input.membershipState ?? current.membershipState, chatType: input.chatType ?? current.chatType, displayName: input.displayName === null ? undefined : input.displayName ?? current.displayName, observedAt: input.observedAt ?? current.observedAt, lastSuccessAt: input.lastSuccessAt === null ? undefined : input.lastSuccessAt ?? current.lastSuccessAt, errorCode: input.errorCode === null ? undefined : input.errorCode ?? current.errorCode, expiresAt: input.expiresAt ?? current.expiresAt, invalidatedAt: input.invalidatedAt === null ? undefined : input.invalidatedAt ?? current.invalidatedAt, updatedAt: new Date().toISOString() });
    const result = sqlite.prepare(`UPDATE remote_chat_facts SET revision = ?, membership_state = ?, chat_type = ?, display_name = ?, observed_at = ?, last_success_at = ?, error_code = ?, expires_at = ?, invalidated_at = ?, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(next.revision, next.membershipState, next.chatType, next.displayName ?? null, next.observedAt, next.lastSuccessAt ?? null, next.errorCode ?? null, next.expiresAt, next.invalidatedAt ?? null, next.updatedAt, id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('remote_chat_fact', id, input.expectedRevision);
    recordVersion('remote_chat_fact', next, current);
    return next;
  };

  const invalidateFact = (id: string, raw: InvalidateRemoteFactInput): RemoteChatFact => {
    const input = invalidateRemoteFactInputSchema.parse(raw);
    const current = getFact(id);
    if (!current) throw notFound('remote_chat_fact', id);
    if (current.revision !== input.expectedRevision) throw revisionConflict('remote_chat_fact', id, input.expectedRevision);
    const next = remoteChatFactSchema.parse({ ...current, revision: current.revision + 1, expiresAt: input.invalidatedAt, invalidatedAt: input.invalidatedAt, errorCode: input.errorCode, updatedAt: input.invalidatedAt });
    const result = sqlite.prepare('UPDATE remote_chat_facts SET revision = ?, expires_at = ?, invalidated_at = ?, error_code = ?, updated_at = ? WHERE id = ? AND revision = ?')
      .run(next.revision, next.expiresAt, next.invalidatedAt, next.errorCode, next.updatedAt, id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('remote_chat_fact', id, input.expectedRevision);
    return next;
  };

  const getCurrentFactByNaturalKey = (channelBotId: string, externalChatId: string, now = new Date().toISOString()): RemoteChatFact | undefined => {
    const fact = getFactByNaturalKey(channelBotId, externalChatId);
    if (!fact) return undefined;
    const identity = fact.identityFactId ? getIdentityFact(fact.identityFactId) : undefined;
    return remoteChatFactValidity(fact, identity, new Date(now)) === 'valid' ? fact : undefined;
  };

  const upsertFact = (raw: UpsertRemoteChatFactInput): RemoteChatFact => {
    const input = upsertRemoteChatFactInputSchema.parse(raw);
    assertCredentialBinding(input.channelBotId, input.credentialRefId, input.credentialRevision);
    const identity = getIdentityFact(input.identityFactId);
    if (!identity || identity.channelBotId !== input.channelBotId || identity.revision !== input.identityRevision) {
      throw new RuntimeError('REMOTE_IDENTITY_BINDING_MISMATCH', 'RemoteChatFact identity binding is missing or stale', 409);
    }
    if (!identity.appIdMatch || identity.errorCode || Date.parse(identity.expiresAt) <= Date.parse(input.observedAt)) {
      throw new RuntimeError('REMOTE_IDENTITY_FACT_NOT_CURRENT', 'Remote identity fact is mismatched, errored, or expired', 409);
    }
    if (identity.credentialRefId !== input.credentialRefId || identity.credentialRevision !== input.credentialRevision || identity.credentialFingerprint !== input.credentialFingerprint) {
      throw new RuntimeError('REMOTE_IDENTITY_CREDENTIAL_VERSION_MISMATCH', 'RemoteChatFact credential binding does not match the identity fact', 409);
    }
    if (Date.parse(input.expiresAt) > Date.parse(identity.expiresAt)) {
      throw new RuntimeError('REMOTE_CHAT_EXPIRY_EXCEEDS_IDENTITY', 'RemoteChatFact cannot outlive its identity fact', 409);
    }
    const current = getFactByNaturalKey(input.channelBotId, input.externalChatId);
    if (!current) {
      if (input.expectedRevision !== 0) throw revisionConflict('remote_chat_fact', input.id, input.expectedRevision);
      if (getFact(input.id)) throw conflict('remote_chat_fact', input.id);
      const { expectedRevision: _expectedRevision, ...fields } = input;
      const timestamp = new Date().toISOString();
      const entity = remoteChatFactSchema.parse({ ...fields, schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp });
      sqlite.prepare(`INSERT INTO remote_chat_facts (id, schema_version, revision, channel_bot_id, external_chat_id, membership_state, chat_type, display_name, observed_at, last_success_at, error_code, credential_ref_id, credential_revision, credential_fingerprint, identity_fact_id, identity_revision, expires_at, invalidated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
        .run(entity.id, 1, 1, entity.channelBotId, entity.externalChatId, entity.membershipState, entity.chatType, entity.displayName ?? null, entity.observedAt, entity.lastSuccessAt ?? null, entity.errorCode ?? null, entity.credentialRefId, entity.credentialRevision, entity.credentialFingerprint, entity.identityFactId, entity.identityRevision, entity.expiresAt, timestamp, timestamp);
      recordVersion('remote_chat_fact', entity);
      return entity;
    }
    if (current.id !== input.id) throw conflict('remote_chat_fact', `${input.channelBotId}/${input.externalChatId}`);
    if (current.revision !== input.expectedRevision) throw revisionConflict('remote_chat_fact', current.id, input.expectedRevision);
    const timestamp = new Date().toISOString();
    const { expectedRevision: _expectedRevision, ...fields } = input;
    const next = remoteChatFactSchema.parse({ ...current, ...fields, schemaVersion: 1, revision: current.revision + 1, invalidatedAt: undefined, createdAt: current.createdAt, updatedAt: timestamp });
    const result = sqlite.prepare(`UPDATE remote_chat_facts SET revision = ?, membership_state = ?, chat_type = ?, display_name = ?, observed_at = ?, last_success_at = ?, error_code = ?, credential_ref_id = ?, credential_revision = ?, credential_fingerprint = ?, identity_fact_id = ?, identity_revision = ?, expires_at = ?, invalidated_at = NULL, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(next.revision, next.membershipState, next.chatType, next.displayName ?? null, next.observedAt, next.lastSuccessAt ?? null, next.errorCode ?? null, next.credentialRefId, next.credentialRevision, next.credentialFingerprint, next.identityFactId, next.identityRevision, next.expiresAt, next.updatedAt, current.id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('remote_chat_fact', current.id, input.expectedRevision);
    return next;
  };

  const invalidateFactsForIdentity = (identityFactId: string, identityRevision: number, invalidatedAt: string, errorCode: string): void => {
    const rows = sqlite.prepare('SELECT * FROM remote_chat_facts WHERE identity_fact_id = ? AND identity_revision = ? AND invalidated_at IS NULL').all(identityFactId, identityRevision) as RemoteChatFactRow[];
    for (const row of rows) {
      const fact = decodeRemoteChatFact(row);
      invalidateFact(fact.id, { expectedRevision: fact.revision, invalidatedAt, errorCode });
    }
  };

  const upsertIdentityFact = (raw: UpsertRemoteIdentityFactInput): RemoteIdentityFact => {
    const input = upsertRemoteIdentityFactInputSchema.parse(raw);
    assertCredentialBinding(input.channelBotId, input.credentialRefId, input.credentialRevision);
    const current = getIdentityFactByBot(input.channelBotId);
    const timestamp = new Date().toISOString();
    if (!current) {
      if (input.expectedRevision !== 0) throw revisionConflict('remote_identity_fact', input.id, input.expectedRevision);
      if (getIdentityFact(input.id)) throw conflict('remote_identity_fact', input.id);
      const { expectedRevision: _expectedRevision, ...fields } = input;
      const entity = remoteIdentityFactSchema.parse({ ...fields, schemaVersion: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp });
      sqlite.prepare(`INSERT INTO remote_identity_facts (id, schema_version, revision, channel_bot_id, credential_ref_id, credential_revision, credential_fingerprint, app_fingerprint, bot_identity_ref, tenant_ref, app_id_match, checked_at, expires_at, error_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entity.id, 1, 1, entity.channelBotId, entity.credentialRefId, entity.credentialRevision, entity.credentialFingerprint, entity.appFingerprint, entity.botIdentityRef, entity.tenantRef ?? null, entity.appIdMatch ? 1 : 0, entity.checkedAt, entity.expiresAt, entity.errorCode ?? null, timestamp, timestamp);
      return entity;
    }
    if (current.id !== input.id) throw conflict('remote_identity_fact', input.channelBotId);
    if (current.revision !== input.expectedRevision) throw revisionConflict('remote_identity_fact', current.id, input.expectedRevision);
    const { expectedRevision: _expectedRevision, ...fields } = input;
    const next = remoteIdentityFactSchema.parse({ ...current, ...fields, revision: current.revision + 1, createdAt: current.createdAt, updatedAt: timestamp });
    const result = sqlite.prepare(`UPDATE remote_identity_facts SET revision = ?, credential_ref_id = ?, credential_revision = ?, credential_fingerprint = ?, app_fingerprint = ?, bot_identity_ref = ?, tenant_ref = ?, app_id_match = ?, checked_at = ?, expires_at = ?, error_code = ?, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(next.revision, next.credentialRefId, next.credentialRevision, next.credentialFingerprint, next.appFingerprint, next.botIdentityRef, next.tenantRef ?? null, next.appIdMatch ? 1 : 0, next.checkedAt, next.expiresAt, next.errorCode ?? null, next.updatedAt, current.id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('remote_identity_fact', current.id, input.expectedRevision);
    invalidateFactsForIdentity(current.id, current.revision, timestamp, next.appIdMatch ? 'REMOTE_IDENTITY_RECHECKED' : 'REMOTE_APP_ID_MISMATCH');
    return next;
  };

  const getCurrentIdentityFactByBot = (channelBotId: string, now = new Date().toISOString()): RemoteIdentityFact | undefined => {
    const fact = getIdentityFactByBot(channelBotId);
    return fact && fact.appIdMatch && !fact.errorCode && Date.parse(fact.expiresAt) > Date.parse(now) ? fact : undefined;
  };

  const invalidateIdentityFact = (id: string, raw: InvalidateRemoteFactInput): RemoteIdentityFact => {
    const input = invalidateRemoteFactInputSchema.parse(raw);
    const current = getIdentityFact(id);
    if (!current) throw notFound('remote_identity_fact', id);
    if (current.revision !== input.expectedRevision) throw revisionConflict('remote_identity_fact', id, input.expectedRevision);
    const next = remoteIdentityFactSchema.parse({ ...current, revision: current.revision + 1, expiresAt: input.invalidatedAt, errorCode: input.errorCode, updatedAt: input.invalidatedAt });
    const result = sqlite.prepare('UPDATE remote_identity_facts SET revision = ?, expires_at = ?, error_code = ?, updated_at = ? WHERE id = ? AND revision = ?')
      .run(next.revision, next.expiresAt, next.errorCode, next.updatedAt, id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('remote_identity_fact', id, input.expectedRevision);
    invalidateFactsForIdentity(current.id, current.revision, input.invalidatedAt, 'REMOTE_IDENTITY_INVALIDATED');
    return next;
  };

  const createRole = (raw: CreateRoleAssignmentInput): RoleAssignment => {
    const input = createRoleAssignmentInputSchema.parse(raw);
    assertBot(input.channelBotId); assertBinding(input.groupBindingId, input.channelBotId);
    if (getRole(input.id)) throw conflict('role_assignment', input.id);
    const scopeKey = input.groupBindingId ?? 'bot';
    if (sqlite.prepare('SELECT 1 FROM role_assignments WHERE channel_bot_id = ? AND scope_key = ? AND principal_id = ? AND role = ?').get(input.channelBotId, scopeKey, input.principalId, input.role)) throw conflict('role_assignment', `${input.channelBotId}/${scopeKey}/${input.principalId}/${input.role}`);
    const timestamp = new Date().toISOString();
    const entity = roleAssignmentSchema.parse({ ...input, schemaVersion: 1, revision: 1, state: 'active', createdAt: timestamp, updatedAt: timestamp });
    sqlite.prepare(`INSERT INTO role_assignments (id, schema_version, revision, channel_bot_id, group_binding_id, scope_key, principal_id, role, operate_scope, action_gates_json, state, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entity.id, 1, 1, entity.channelBotId, entity.groupBindingId ?? null, scopeKey, entity.principalId, entity.role, entity.operateScope, JSON.stringify(entity.actionGates), entity.state, entity.expiresAt ?? null, timestamp, timestamp);
    recordVersion('role_assignment', entity);
    return entity;
  };
  const updateRole = (id: string, raw: UpdateRoleAssignmentInput): RoleAssignment => {
    const input = updateRoleAssignmentInputSchema.parse(raw);
    const current = getRole(id);
    if (!current) throw notFound('role_assignment', id);
    if (current.revision !== input.expectedRevision) throw revisionConflict('role_assignment', id, input.expectedRevision);
    const next = roleAssignmentSchema.parse({ ...current, revision: current.revision + 1, operateScope: input.operateScope ?? current.operateScope, actionGates: input.actionGates ?? current.actionGates, state: input.state ?? current.state, expiresAt: input.expiresAt === null ? undefined : input.expiresAt ?? current.expiresAt, updatedAt: new Date().toISOString() });
    const result = sqlite.prepare(`UPDATE role_assignments SET revision = ?, operate_scope = ?, action_gates_json = ?, state = ?, expires_at = ?, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(next.revision, next.operateScope, JSON.stringify(next.actionGates), next.state, next.expiresAt ?? null, next.updatedAt, id, input.expectedRevision);
    if (result.changes !== 1) throw revisionConflict('role_assignment', id, input.expectedRevision);
    recordVersion('role_assignment', next, current);
    return next;
  };

  const transactionContext: GroupPolicyTransactionContext = {
    groupBindings: { get: getBinding, getByNaturalKey: getBindingByNaturalKey, create: createBinding, update: updateBinding },
    channelBotPolicies: { get: getPolicy, getByChannelBot: getPolicyByBot, create: createPolicy, update: updatePolicy },
    remoteChatFacts: { get: getFact, getByNaturalKey: getFactByNaturalKey, getCurrentByNaturalKey: getCurrentFactByNaturalKey, create: createFact, update: updateFact, upsert: upsertFact, invalidate: invalidateFact },
    remoteIdentityFacts: { get: getIdentityFact, getByChannelBot: getIdentityFactByBot, getCurrentByChannelBot: getCurrentIdentityFactByBot, upsert: upsertIdentityFact, invalidate: invalidateIdentityFact },
    roleAssignments: { get: getRole, create: createRole, update: updateRole },
    config: {
      get: key => (sqlite.prepare('SELECT value FROM configs WHERE key = ?').get(key) as { value: string } | undefined)?.value,
      set: (key, value) => { if (key.startsWith('runtime_native_context:')) throw new RuntimeError('EXECUTION_WRITE_REQUIRES_LEDGER', 'Native context selection requires a bound ledger command', 409); sqlite.prepare('INSERT INTO configs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }
    }
  };
  const transact = async <T>(work: (repositories: GroupPolicyTransactionContext) => T): Promise<T> => {
    let result!: T;
    sqlite.transaction(() => {
      const candidate = work(transactionContext);
      if (isThenable(candidate)) throw new RuntimeError('FOUNDATION_ASYNC_TRANSACTION_UNSUPPORTED', 'Group policy transactions must be synchronous', 400);
      result = candidate;
    })();
    return result;
  };

  return {
    channelBotPolicies: {
      async list(limit) { return (sqlite.prepare('SELECT * FROM channel_bot_policies ORDER BY created_at, id LIMIT ?').all(boundedLimit(limit)) as ChannelBotPolicyRow[]).map(decodeChannelBotPolicy); },
      async get(id) { return getPolicy(id); }, async getByChannelBot(id) { return getPolicyByBot(id); },
      async create(input) { return transact(repositories => repositories.channelBotPolicies.create(input)); },
      async update(id, input) { return transact(repositories => repositories.channelBotPolicies.update(id, input)); }
    },
    groupBindings: {
      async listByChannelBot(id, limit) { return (sqlite.prepare('SELECT * FROM group_bindings WHERE channel_bot_id = ? ORDER BY created_at, id LIMIT ?').all(id, boundedLimit(limit)) as GroupBindingRow[]).map(decodeGroupBinding); },
      async get(id) { return getBinding(id); }, async getByNaturalKey(botId, chatId) { return getBindingByNaturalKey(botId, chatId); },
      async create(input) { return transact(repositories => repositories.groupBindings.create(input)); },
      async update(id, input) { return transact(repositories => repositories.groupBindings.update(id, input)); }
    },
    remoteChatFacts: {
      async listByChannelBot(id, limit) { return (sqlite.prepare('SELECT * FROM remote_chat_facts WHERE channel_bot_id = ? ORDER BY observed_at DESC, id LIMIT ?').all(id, boundedLimit(limit)) as RemoteChatFactRow[]).map(decodeRemoteChatFact); },
      async get(id) { return getFact(id); }, async getByNaturalKey(botId, chatId) { return getFactByNaturalKey(botId, chatId); },
      async getCurrentByNaturalKey(botId, chatId, now) { return getCurrentFactByNaturalKey(botId, chatId, now); },
      async create(input) { return transact(repositories => repositories.remoteChatFacts.create(input)); },
      async update(id, input) { return transact(repositories => repositories.remoteChatFacts.update(id, input)); },
      async upsert(input) { return transact(repositories => repositories.remoteChatFacts.upsert(input)); },
      async invalidate(id, input) { return transact(repositories => repositories.remoteChatFacts.invalidate(id, input)); }
    },
    remoteIdentityFacts: {
      async list(limit) { return (sqlite.prepare('SELECT * FROM remote_identity_facts ORDER BY checked_at DESC, id LIMIT ?').all(boundedLimit(limit)) as RemoteIdentityFactRow[]).map(decodeRemoteIdentityFact); },
      async get(id) { return getIdentityFact(id); }, async getByChannelBot(id) { return getIdentityFactByBot(id); },
      async getCurrentByChannelBot(id, now) { return getCurrentIdentityFactByBot(id, now); },
      async upsert(input) { return transact(repositories => repositories.remoteIdentityFacts.upsert(input)); },
      async invalidate(id, input) { return transact(repositories => repositories.remoteIdentityFacts.invalidate(id, input)); }
    },
    roleAssignments: {
      async listByChannelBot(id, limit) { return (sqlite.prepare('SELECT * FROM role_assignments WHERE channel_bot_id = ? ORDER BY created_at, id LIMIT ?').all(id, boundedLimit(limit)) as RoleAssignmentRow[]).map(decodeRoleAssignment); },
      async get(id) { return getRole(id); }, async create(input) { return transact(repositories => repositories.roleAssignments.create(input)); },
      async update(id, input) { return transact(repositories => repositories.roleAssignments.update(id, input)); }
    },
    groupPolicy: { transact },
    remoteFacts: { transact: work => transact(repositories => work({ remoteChatFacts: repositories.remoteChatFacts, remoteIdentityFacts: repositories.remoteIdentityFacts })) }
  };
}
