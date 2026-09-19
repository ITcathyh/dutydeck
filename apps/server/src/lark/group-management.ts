import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RuntimeError, canonicalExecutionJson, createGroupBindingInputSchema, createRoleAssignmentInputSchema, evaluatePolicyAction, installationOwnerTaskActor,
  groupBindingSchema, remoteChatFactValidity, resolveGroupEffectiveConfig, updateRoleAssignmentInputSchema,
  type ChannelBotGroupPolicy, type EffectiveGroupConfig, type GroupBinding, type PolicyAction,
  type PolicyDecision, type PresentationSettings, type RepositoryBundle, type RoleAssignment, type Session, type ToolRiskPolicy
} from '@dutydeck/shared';
import { defaultLarkTraceLimit, larkExecutionConfirmed, readLarkConfig, readLarkConfigs, type StoredLarkConfig } from './config.js';
import { createLarkCardService, LarkServiceError, type LarkCardService, type LarkChat } from './service.js';
import type { LarkMessageEvent } from './listener.js';
import { larkSourceId } from './session-resolver.js';
import { discoverAgentModels } from '../agent-models.js';

export interface ManagedGroupBot {
  appId: string; channelBotId?: string; binding?: GroupBinding; effective?: EffectiveGroupConfig;
  roles: RoleAssignment[]; membership: 'member' | 'not_member' | 'inaccessible' | 'unknown';
  validity: string; checkedAt?: string; applied: boolean; error?: string;
}
export interface ManagedGroup { key: string; chatId: string; name: string; bots: ManagedGroupBot[] }
interface LiveOwner { channelBotId: string; credentialRefId: string; fingerprint: string; activeGroups: string[] }
interface RunContext { activeOpenId?: string; appId: string; chatId: string; bindingId: string; principalId: string; openId: string; sourceId: string; revision: number; agentId: string; cwd: string; model?: string; reasoningEffort?: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ownerKey = (appId: string) => `lark.live-owner.${appId}`;
const runKey = (sessionId: string) => `lark.run-context.${sessionId}`;
const principalId = (appId: string, openId: string) => `principal_${hash(`${appId}\0${openId}`)}`;
const fingerprint = (config: StoredLarkConfig) => hash(`${config.brand ?? 'feishu'}\0${config.appId}\0${config.appSecret}`);
const parse = <T>(value: string | undefined): T | undefined => value ? JSON.parse(value) as T : undefined;
const deny = (action: PolicyAction, reason: string): PolicyDecision => ({ allowed: false, action, code: 'LARK_GROUP_POLICY_DENIED', reason, source: 'explicit_deny' });
const buildRunContext = (session: Session, config: StoredLarkConfig, event: Pick<LarkMessageEvent, 'chatId' | 'chatType' | 'senderOpenId'>, scopeId: string): RunContext | undefined => {
  if (!config.managedGroup || !event.senderOpenId) return undefined;
  return {
    appId: config.appId, chatId: event.chatId, bindingId: config.managedGroup.bindingId, principalId: principalId(config.appId, event.senderOpenId), openId: event.senderOpenId,
    sourceId: larkSourceId(config, event.chatId, event.chatType, scopeId), revision: config.managedGroup.revision, agentId: session.agentId, cwd: session.cwd, model: session.model, reasoningEffort: session.reasoningEffort
  };
};
const patchSchema = groupBindingSchema.pick({ agentOverride: true, workspaceOverride: true, modelOverride: true, reasoningOverride: true, routingOverride: true, accessOverride: true, groupToolsOverride: true, presentationOverride: true, oncall: true, state: true }).partial();
/** Bot 级呈现默认；群级 presentationOverride 逐字段覆盖它。 */
const presentationDefaults = (config: StoredLarkConfig): PresentationSettings => ({
  structuredAskCards: config.structuredAskCards !== false,
  groupCardMention: config.groupCardMention === true,
  pushIntervalMs: config.pushIntervalMs,
  traceLimit: config.traceLimit ?? defaultLarkTraceLimit,
  hideTraceOnComplete: config.hideTraceOnComplete,
  completionReactionOnly: config.completionReactionOnly === true,
  silentProgress: config.silentProgress === true
});
const roleCreateSchema = z.object({ kind: z.literal('create'), principalId: z.string(), role: z.enum(['can_talk', 'can_operate']), operateScope: z.enum(['none', 'own_runs', 'group_runs']), actionGates: z.object({ terminalWrite: z.boolean(), highRisk: z.boolean(), groupToolsSend: z.boolean() }) }).strict();
const roleUpdateSchema = z.object({ kind: z.literal('update'), id: z.string(), expectedRevision: z.number().int().positive(), patch: z.object({ state: z.enum(['active', 'revoked']).optional(), operateScope: z.enum(['none', 'own_runs', 'group_runs']).optional(), actionGates: z.object({ terminalWrite: z.boolean(), highRisk: z.boolean(), groupToolsSend: z.boolean() }).optional() }).strict() }).strict();
const saveSchema = z.object({ expectedRevision: z.number().int().nonnegative(), patch: patchSchema, roleChanges: z.array(z.discriminatedUnion('kind', [roleCreateSchema, roleUpdateSchema])).max(200).optional() }).strict();

export class LarkGroupManager {
  private readonly synchronizing = new Map<string, Promise<{ groups: ManagedGroup[] }>>();
  constructor(readonly repos: RepositoryBundle, private readonly options: {
    client?: (config: StoredLarkConfig) => LarkCardService;
    now?: () => Date;
    onPolicyChanged?: () => Promise<void>;
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof globalThis.fetch;
  } = {}) {}

  private now() { return this.options.now?.() ?? new Date(); }
  private client(config: StoredLarkConfig) { return this.options.client?.(config) ?? createLarkCardService(this.options.env ?? process.env, this.options.fetcher ?? globalThis.fetch, config); }
  private async config(appId: string) {
    const config = await readLarkConfig(this.repos.config, appId);
    if (!config) throw new RuntimeError('LARK_BOT_NOT_FOUND', '此机器人已被删除。', 404);
    return config;
  }
  async isLiveManagedBot(channelBotId: string) {
    for (const config of await readLarkConfigs(this.repos.config)) if ((await this.owner(config.appId))?.channelBotId === channelBotId) return true;
    return false;
  }
  async owner(appId: string) { return parse<LiveOwner>(await this.repos.config.get(ownerKey(appId))); }

  private async ensureOwner(config: StoredLarkConfig) {
    let owner = await this.owner(config.appId);
    if (!owner) {
      const existing = (await this.repos.channelBots.list()).find(bot => bot.externalAppId === config.appId);
      if (existing) throw new RuntimeError('LARK_IMPORTED_BOT_CONFLICT', '此 App 已有迁移草稿，请先处理草稿冲突；同步不会激活导入配置。', 409);
      const id = hash(config.appId).slice(0, 24);
      owner = { channelBotId: `live_lark_${id}`, credentialRefId: `live_lark_secret_${id}`, fingerprint: fingerprint(config), activeGroups: [] };
      const inserted = await this.repos.config.compareAndSet?.(ownerKey(config.appId), undefined, JSON.stringify(owner));
      if (inserted === false) owner = (await this.owner(config.appId))!;
      else if (inserted === undefined) await this.repos.config.set(ownerKey(config.appId), JSON.stringify(owner));
    }
    if (!await this.repos.secretRefs.get(owner.credentialRefId)) {
      await this.repos.secretRefs.create({ id: owner.credentialRefId, kind: 'lark_app_secret', provider: 'live_lark_config', referenceKey: config.appId, status: 'configured' });
    }
    if (!await this.repos.channelBots.get(owner.channelBotId)) {
      await this.repos.channelBots.create({ id: owner.channelBotId, channel: 'lark', externalAppId: config.appId, displayName: config.name ?? config.appId, brand: config.brand ?? 'feishu', credentialRef: owner.credentialRefId, state: 'staged' });
    }
    return owner;
  }

  private policy(config: StoredLarkConfig, channelBotId: string): ChannelBotGroupPolicy {
    const now = this.now().toISOString();
    return {
      id: `live_policy_${channelBotId}`, schemaVersion: 1, revision: config.revision ?? 1, channelBotId,
      defaults: { agentDefinitionId: config.defaultAgentId, workspace: config.workspace, model: config.defaultModel, reasoningEffort: config.defaultReasoningEffort },
      routingDefaults: { groupReplyMode: config.groupReplyMode ?? 'chat-topic', mentionPolicy: config.mentionPolicy ?? 'always' },
      accessPolicy: config.allowedUsers.length ? { mode: 'allowlist', principalIds: config.allowedUsers.map(user => principalId(config.appId, user.openId)) }
        : { mode: config.allowedEmails.length ? 'owner_only' : 'open', principalIds: [] },
      groupToolsPolicy: { readCeiling: config.groupToolsEnabled, discoverCeiling: config.groupToolsEnabled, sendCeiling: config.groupToolsEnabled && config.groupToolsAllowSend, readDefault: config.groupToolsEnabled, discoverDefault: config.groupToolsEnabled, sendDefault: config.groupToolsEnabled && config.groupToolsAllowSend },
      createdAt: now, updatedAt: now
    };
  }

  private async detail(config: StoredLarkConfig, owner: LiveOwner, chatId: string): Promise<ManagedGroupBot> {
    const [binding, fact, identity, roles, bot] = await Promise.all([
      this.repos.groupBindings.getByNaturalKey(owner.channelBotId, chatId), this.repos.remoteChatFacts.getByNaturalKey(owner.channelBotId, chatId),
      this.repos.remoteIdentityFacts.getByChannelBot(owner.channelBotId), this.repos.roleAssignments.listByChannelBot(owner.channelBotId, 500), this.repos.channelBots.get(owner.channelBotId)
    ]);
    const validity = owner.fingerprint !== fingerprint(config) ? 'credential_mismatch' : fact ? remoteChatFactValidity(fact, identity, this.now()) : 'unknown';
    const effective = binding ? resolveGroupEffectiveConfig(this.policy(config, owner.channelBotId), binding, presentationDefaults(config)) : undefined;
    if (effective && binding?.routingOverride.groupReplyMode.mode === 'inherit' && !config.groupReplyMode) effective.routing.groupReplyMode = { value: undefined, source: 'unconfigured' };
    const enabled = Boolean(binding && binding.state === 'staged' && owner.activeGroups.includes(binding.id) && bot?.state !== 'disabled');
    const applied = enabled && validity === 'valid' && fact?.membershipState === 'member' && larkExecutionConfirmed(config);
    return { appId: config.appId, channelBotId: owner.channelBotId, binding, effective,
      roles: roles.filter(role => role.groupBindingId === binding?.id), membership: fact?.membershipState ?? 'unknown', validity, checkedAt: fact?.observedAt, applied,
      ...(!applied && binding ? { error: validity !== 'valid' ? '群身份或凭据校验已失效，请重新同步群聊。' : '群配置已停用或 Bot 尚未确认运行权限。' } : {}) };
  }

  async groups(): Promise<{ groups: ManagedGroup[] }> {
    const groups = new Map<string, ManagedGroup>();
    for (const config of await readLarkConfigs(this.repos.config)) {
      const owner = await this.owner(config.appId);
      if (!owner) continue;
      const identity = await this.repos.remoteIdentityFacts.getByChannelBot(owner.channelBotId);
      const facts = await this.repos.remoteChatFacts.listByChannelBot(owner.channelBotId, 500);
      const bindings = await this.repos.groupBindings.listByChannelBot(owner.channelBotId, 500);
      for (const chatId of new Set([...facts.map(fact => fact.externalChatId), ...bindings.map(binding => binding.externalChatId)])) {
        const fact = facts.find(item => item.externalChatId === chatId);
        const key = `${config.brand ?? 'feishu'}:${identity?.tenantRef ?? config.appId}:${chatId}`;
        const group = groups.get(key) ?? { key, chatId, name: fact?.displayName ?? chatId, bots: [] };
        group.bots.push(await this.detail(config, owner, chatId));
        groups.set(key, group);
      }
    }
    return { groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async sync(appId: string) {
    const existing = this.synchronizing.get(appId);
    if (existing) return existing;
    const pending = this.syncOnce(appId);
    this.synchronizing.set(appId, pending);
    try { return await pending; } finally { if (this.synchronizing.get(appId) === pending) this.synchronizing.delete(appId); }
  }
  private async syncOnce(appId: string) {
    const config = await this.config(appId);
    const owner = await this.ensureOwner(config);
    const client = this.client(config);
    const [botInfo, application] = await Promise.all([client.getBotInfo(), client.checkApplicationIdentity(appId)]);
    if (!application.verified || !botInfo.openId) throw new RuntimeError('LARK_IDENTITY_UNVERIFIED', '无法确认此 Bot 的应用身份，请检查凭据和应用权限。', 409);
    if (application.reportedAppId && application.reportedAppId !== appId) throw new RuntimeError('LARK_APP_ID_MISMATCH', '凭据对应的应用与当前 Bot 不一致。', 409);
    const chats: LarkChat[] = [];
    let pageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.listChats(pageToken);
      chats.push(...page.items);
      if (!page.hasMore) break;
      if (!page.pageToken || seen.has(page.pageToken)) throw new RuntimeError('LARK_PAGINATION_INCOMPLETE', '群列表分页不完整，请重新同步。', 502);
      pageToken = page.pageToken; seen.add(pageToken);
    } while (true);
    const current = await this.config(appId);
    if (fingerprint(current) !== fingerprint(config)) throw new RuntimeError('LARK_CREDENTIAL_CHANGED', '同步期间凭据已变更，请重试。', 409);
    let secret = (await this.repos.secretRefs.get(owner.credentialRefId))!;
    if (owner.fingerprint !== fingerprint(config)) secret = await this.repos.secretRefs.update(secret.id, { expectedRevision: secret.revision, status: 'configured' });
    const at = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + 60 * 60_000).toISOString();
    await this.repos.groupPolicy.transact(tx => {
      const liveConfig = parse<StoredLarkConfig[]>(tx.config.get('lark.bots'))?.find(bot => bot.appId === appId);
      if (!liveConfig || fingerprint(liveConfig) !== fingerprint(config)) throw new RuntimeError('LARK_CREDENTIAL_CHANGED', '同步期间凭据已变更，请重试。', 409);
      const live = parse<LiveOwner>(tx.config.get(ownerKey(appId)))!;
      live.fingerprint = fingerprint(config);
      tx.config.set(ownerKey(appId), JSON.stringify(live));
      const before = tx.remoteIdentityFacts.getByChannelBot(owner.channelBotId);
      const identity = tx.remoteIdentityFacts.upsert({ id: before?.id ?? `live_identity_${hash(appId)}`, expectedRevision: before?.revision ?? 0, channelBotId: owner.channelBotId,
        credentialRefId: secret.id, credentialRevision: secret.revision, credentialFingerprint: fingerprint(config), appFingerprint: hash(appId),
        botIdentityRef: `remote_bot_${hash(botInfo.openId)}`, ...(application.tenantKey ? { tenantRef: `remote_tenant_${hash(application.tenantKey)}` } : {}), appIdMatch: true, checkedAt: at, expiresAt });
      for (const chat of chats) {
        const beforeChat = tx.remoteChatFacts.getByNaturalKey(owner.channelBotId, chat.chatId);
        const fact = tx.remoteChatFacts.upsert({ id: beforeChat?.id ?? `live_chat_${hash(`${appId}\0${chat.chatId}`)}`, expectedRevision: beforeChat?.revision ?? 0, channelBotId: owner.channelBotId, externalChatId: chat.chatId,
          membershipState: 'member', chatType: chat.chatMode === 'topic' ? 'topic_group' : 'group', observedAt: at, lastSuccessAt: at,
          credentialRefId: secret.id, credentialRevision: secret.revision, credentialFingerprint: fingerprint(config), identityFactId: identity.id, identityRevision: identity.revision, expiresAt });
        tx.remoteChatFacts.update(fact.id, { expectedRevision: fact.revision, displayName: chat.name });
      }
    });
    return this.groups();
  }

  async members(appId: string, chatId: string, pageToken?: string) {
    const config = await this.config(appId);
    const owner = await this.owner(appId);
    if (!owner) throw new RuntimeError('LARK_GROUP_SYNC_REQUIRED', '请先同步此 Bot 的群聊。', 409);
    const page = await this.client(config).listChatMembers({ chatId, memberTypes: ['user'], pageSize: 100, pageToken });
    const members = page.items.filter(item => item.memberType === 'user').map(item => ({ openId: item.openId ?? item.memberId, name: item.name }));
    const result = [];
    for (const member of members) {
      if (!member.openId.startsWith('ou_')) continue;
      const id = principalId(appId, member.openId);
      await this.repos.config.set(`lark.principal.${id}`, JSON.stringify({ appId, ...member }));
      result.push({ ...member, principalId: id });
    }
    return { members: result, hasMore: page.hasMore, ...(page.pageToken ? { pageToken: page.pageToken } : {}) };
  }

  async save(appId: string, chatId: string, body: unknown) {
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) throw new RuntimeError('INVALID_GROUP_CONFIG', '群配置字段或版本无效。', 400);
    const input = parsed.data;
    const config = await this.config(appId);
    const owner = await this.owner(appId);
    if (!owner) throw new RuntimeError('LARK_GROUP_SYNC_REQUIRED', '请先同步此 Bot 的群聊。', 409);
    const detail = await this.detail(config, owner, chatId);
    const disabling = input.patch.accessOverride?.mode === 'disabled' || ['disabled', 'archived', 'needs_review'].includes(input.patch.state ?? '');
    // 「群身份已失效时仍允许撤销角色」的唯一逃生口：patch 必须逐字段等于现状。
    // 这里用确定性序列化而不是 JSON.stringify——后者把键序算进比较，
    // 任何一次字段重排都会让已迁移的绑定再也走不进这个分支，
    // 「群失效时撤销某人角色」会在最需要它的时候报 409。
    const revokingOnly = Boolean(detail.binding && input.roleChanges?.length && input.roleChanges.every(change => change.kind === 'update' && change.patch.state === 'revoked')
      && Object.entries(input.patch).every(([key, value]) => canonicalExecutionJson(value) === canonicalExecutionJson(detail.binding![key as keyof GroupBinding])));
    const reducingAccess = disabling || revokingOnly;
    if (!reducingAccess && (detail.validity !== 'valid' || detail.membership !== 'member')) throw new RuntimeError('LARK_GROUP_VERIFY_REQUIRED', '请先同步并确认 Bot 在此群中。', 409);
    if (!reducingAccess && !larkExecutionConfirmed(config)) throw new RuntimeError('LARK_FULL_TRUST_CONFIRMATION_REQUIRED', '请先在 Bot 接入设置中确认无人值守运行权限。', 409);
    const { state: _state, ...newOverrides } = input.patch;
    const projected = detail.binding ? { ...detail.binding, ...input.patch } : createGroupBindingInputSchema.parse({ id: `live_binding_${hash(`${appId}\0${chatId}`)}`, channelBotId: owner.channelBotId, externalChatId: chatId, ...newOverrides });
    const effective = resolveGroupEffectiveConfig(this.policy(config, owner.channelBotId), projected as GroupBinding, presentationDefaults(config));
    const executionChanged = !detail.binding || (['agentOverride', 'workspaceOverride', 'modelOverride', 'reasoningOverride'] as const).some(key => input.patch[key] !== undefined && JSON.stringify(input.patch[key]) !== JSON.stringify(detail.binding![key]));
    if (!disabling && executionChanged) {
      const agent = effective.agent.value ? await this.repos.agents.get(effective.agent.value) : undefined;
      if (!agent) throw new RuntimeError('LARK_AGENT_CONFIG_REQUIRED', '请选择可用的 Agent。', 400);
      const cwd = effective.workspace.value ?? agent.cwd;
      if (!cwd || !isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) throw new RuntimeError('LARK_WORKSPACE_INVALID', '工作目录不存在，请选择服务器上的有效目录。', 400);
      await access(cwd, constants.R_OK | constants.X_OK);
      if (agent.protocol === 'acp' && (effective.model.value || effective.reasoningEffort.value)) {
        const available = await discoverAgentModels(agent, effective.model.value);
        if (available.models.length && effective.model.value && !available.models.some(model => model.id === effective.model.value)) throw new RuntimeError('LARK_MODEL_UNAVAILABLE', '所选 Agent 不支持此模型，请重新选择或使用 Agent 默认模型。', 400);
        if (available.reasoningEfforts.length && effective.reasoningEffort.value && !available.reasoningEfforts.some(effort => effort.id === effective.reasoningEffort.value)) throw new RuntimeError('LARK_REASONING_UNAVAILABLE', '此模型不支持所选推理强度，请重新选择。', 400);
      }
    }
    if (detail.binding && detail.binding.revision !== input.expectedRevision || !detail.binding && input.expectedRevision !== 0) throw new RuntimeError('LARK_GROUP_REVISION_CONFLICT', '此群配置已被修改，请比较最新配置后再保存。', 409);
    for (const id of input.patch.accessOverride?.mode === 'allowlist' ? input.patch.accessOverride.principalIds : []) {
      const member = parse<{ appId: string }>(await this.repos.config.get(`lark.principal.${id}`));
      if (member?.appId !== appId) throw new RuntimeError('LARK_PRINCIPAL_SCOPE_MISMATCH', '成员身份不属于当前 Bot，请重新选择。', 400);
    }
    for (const change of input.roleChanges ?? []) {
      if (change.kind === 'create') {
        const member = parse<{ appId: string }>(await this.repos.config.get(`lark.principal.${change.principalId}`));
        if (member?.appId !== appId) throw new RuntimeError('LARK_PRINCIPAL_SCOPE_MISMATCH', '成员身份不属于当前 Bot，请重新选择。', 400);
      }
    }
    await this.repos.groupPolicy.transact(tx => {
      const liveConfig = parse<StoredLarkConfig[]>(tx.config.get('lark.bots'))?.find(bot => bot.appId === appId);
      if (!liveConfig || (liveConfig.revision ?? 1) !== (config.revision ?? 1)) throw new RuntimeError('LARK_CONFIG_REVISION_CONFLICT', '保存期间 Bot 默认设置已变化，请比较后重试。', 409);
      const live = parse<LiveOwner>(tx.config.get(ownerKey(appId)));
      if (!live || !reducingAccess && live.fingerprint !== fingerprint(config)) throw new RuntimeError('LARK_CREDENTIAL_CHANGED', '凭据已变化，请重新同步。', 409);
      let binding = tx.groupBindings.getByNaturalKey(owner.channelBotId, chatId);
      if ((binding?.revision ?? 0) !== input.expectedRevision) throw new RuntimeError('LARK_GROUP_REVISION_CONFLICT', '此群配置已被其他人修改。', 409);
      if (binding) binding = tx.groupBindings.update(binding.id, { expectedRevision: input.expectedRevision, ...(Object.keys(input.patch).length ? input.patch : { oncall: binding.oncall }) });
      else {
        binding = tx.groupBindings.create(createGroupBindingInputSchema.parse(projected));
        if (input.patch.state) binding = tx.groupBindings.update(binding.id, { expectedRevision: binding.revision, state: input.patch.state });
      }
      for (const change of input.roleChanges ?? []) {
        if (change.kind === 'create') {
          const id = `live_role_${hash(`${binding.id}\0${change.principalId}\0${change.role}`)}`;
          const previous = tx.roleAssignments.get(id);
          if (previous?.state === 'revoked') tx.roleAssignments.update(id, { expectedRevision: previous.revision, state: 'active', operateScope: change.operateScope, actionGates: change.actionGates });
          else tx.roleAssignments.create(createRoleAssignmentInputSchema.parse({ id, channelBotId: owner.channelBotId, groupBindingId: binding.id,
            principalId: change.principalId, role: change.role, operateScope: change.operateScope, actionGates: change.actionGates }));
        } else {
          const role = tx.roleAssignments.get(change.id);
          if (!role || role.channelBotId !== owner.channelBotId || role.groupBindingId !== binding.id || role.role === 'admin') throw new RuntimeError('LARK_ROLE_SCOPE_MISMATCH', '不能通过此群修改其他作用域的授权。', 400);
          tx.roleAssignments.update(change.id, updateRoleAssignmentInputSchema.parse({ ...change.patch, expectedRevision: change.expectedRevision }));
        }
      }
      live.activeGroups = [...new Set([...live.activeGroups, binding.id])];
      tx.config.set(ownerKey(appId), JSON.stringify(live));
    });
    await this.options.onPolicyChanged?.();
    return this.detail(await this.config(appId), (await this.owner(appId))!, chatId);
  }

  /**
   * 本群当前的授权口径与绑定版本号，供聊天内 /grant、/revoke 做「读—改—写」。
   * 群还没同步或还没绑定时返回 undefined：此时聊天里没有可改的授权，命令必须如实拒绝，
   * 而不是替用户新建一份群配置。
   */
  async groupAccess(appId: string, chatId: string) {
    const config = await readLarkConfig(this.repos.config, appId);
    const owner = config ? await this.owner(appId) : undefined;
    if (!config || !owner) return undefined;
    const detail = await this.detail(config, owner, chatId);
    return detail.binding
      ? { revision: detail.binding.revision, override: detail.binding.accessOverride, effective: detail.effective!.access, oncall: detail.binding.oncall }
      : undefined;
  }

  /**
   * 把群成员 open_id 解析成策略 principal 并登记身份（{@link save} 的作用域校验要求已登记）。
   * 不是本群成员、或不是 ou_ 形态的 open_id 一律返回 undefined —— 调用方据此拒绝，
   * 绝不能把一个解析不出来的人静默写进名单。
   */
  async resolveGroupPrincipal(appId: string, chatId: string, openId: string) {
    const config = await readLarkConfig(this.repos.config, appId);
    if (!config || !openId.startsWith('ou_')) return undefined;
    if (!await this.isMember(config, chatId, openId)) return undefined;
    const id = principalId(appId, openId);
    await this.repos.config.set(`lark.principal.${id}`, JSON.stringify({ appId, openId, name: openId }));
    return id;
  }

  private async runtimeDetail(config: StoredLarkConfig, owner: LiveOwner, chatId: string) {
    let detail = await this.detail(config, owner, chatId);
    if (detail.binding && detail.validity !== 'valid' && detail.binding.state === 'staged') {
      try { await this.sync(config.appId); detail = await this.detail(config, (await this.owner(config.appId))!, chatId); }
      catch { return { ...detail, applied: false, error: '无法重新验证群身份，请检查连接并同步群聊。' }; }
    }
    return detail;
  }
  async resolved(config: StoredLarkConfig, chatId: string) {
    const owner = await this.owner(config.appId);
    if (!owner) return config;
    const detail = await this.runtimeDetail(config, owner, chatId);
    if (!detail.binding) return config;
    if (!detail.applied) throw new RuntimeError('LARK_GROUP_NOT_APPLIED', detail.error ?? '群配置尚未生效。', 403);
    const effective = detail.effective!;
    const presentation = effective.presentation;
    return { ...config, defaultAgentId: effective.agent.value, workspace: effective.workspace.value, defaultModel: effective.model.value, defaultReasoningEffort: effective.reasoningEffort.value,
      groupReplyMode: effective.routing.groupReplyMode.value, mentionPolicy: effective.routing.mentionPolicy.value, groupToolsEnabled: effective.groupTools.read.allowed || effective.groupTools.discover.allowed || effective.groupTools.send.allowed,
      groupToolsAllowSend: effective.groupTools.send.allowed,
      // 呈现逐字段落到本群的运行配置上；未解析出来的项保留 Bot 级取值。
      structuredAskCards: presentation.structuredAskCards.value ?? config.structuredAskCards,
      groupCardMention: presentation.groupCardMention.value ?? config.groupCardMention,
      pushIntervalMs: presentation.pushIntervalMs.value ?? config.pushIntervalMs,
      traceLimit: presentation.traceLimit.value ?? config.traceLimit,
      hideTraceOnComplete: presentation.hideTraceOnComplete.value ?? config.hideTraceOnComplete,
      completionReactionOnly: presentation.completionReactionOnly.value ?? config.completionReactionOnly,
      silentProgress: presentation.silentProgress.value ?? config.silentProgress,
      managedGroup: { bindingId: detail.binding.id, revision: detail.binding.revision } } satisfies StoredLarkConfig;
  }

  private async isMember(config: StoredLarkConfig, chatId: string, openId: string) {
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.client(config).listChatMembers({ chatId, memberTypes: ['user', 'bot'], pageSize: 100, pageToken });
      if (page.items.some(item => (item.openId ?? item.memberId) === openId)) return true;
      if (!page.hasMore) return false;
      if (!page.pageToken || tokens.has(page.pageToken)) return false;
      pageToken = page.pageToken; tokens.add(pageToken);
    } while (true);
  }

  async authorize(appId: string, chatId: string, openId: string | undefined, action: PolicyAction, sessionId?: string, options: { memberObserved?: boolean; installationOwner?: boolean; taskRequesterOpenId?: string } = {}): Promise<PolicyDecision | undefined> {
    const config = await readLarkConfig(this.repos.config, appId);
    if (!config) return deny(action, '此 Bot 已删除。');
    const owner = await this.owner(appId);
    if (!owner) return undefined;
    const detail = await this.runtimeDetail(config, owner, chatId);
    if (!detail.binding) return undefined;
    if (options.installationOwner && action === 'task.view_result') return { allowed: true, action, code: 'allowed_owner', reason: '安装管理员可查看任务记录。', source: 'owner' };
    if (!detail.applied) return deny(action, detail.error ?? '群配置已停用。');
    if (!openId && !options.installationOwner) return deny(action, '缺少当前 App 的成员身份。');
    const id = options.installationOwner ? 'principal_installation_owner' : principalId(appId, openId!);
    const isMember = options.installationOwner || options.memberObserved || await this.isMember(config, chatId, openId!);
    if (!isMember) return deny(action, '无法确认当前账号仍在此群中。');
    if (openId) await this.repos.config.set(`lark.principal.${id}`, JSON.stringify({ appId, openId, name: openId }));
    const effective = detail.effective!;
    if (effective.access.mode === 'disabled') return deny(action, '此群已禁止发起和操作任务。');
    const run = sessionId ? parse<RunContext>(await this.repos.config.get(runKey(sessionId))) : undefined;
    if (run && (run.appId !== appId || run.chatId !== chatId || run.bindingId !== detail.binding.id)) return deny(action, '任务不属于当前 Bot 和群。');
    const now = this.now().toISOString();
    const assignments = [...detail.roles];
    // Default talk grants permit operating one's own tasks, never another member's tasks.
    const emailAllowed = config.allowedEmails.length && openId ? (await this.client(config).getUserEmails(openId)).some(email => config.allowedEmails.includes(email)) : false;
    const botDefaultAllowed = config.allowedUsers.some(user => user.openId === openId) || Boolean(emailAllowed);
    const canTalk = options.installationOwner || detail.binding.oncall || effective.access.mode === 'all_chat_members' || effective.access.mode === 'allowlist' && effective.access.principalIds.includes(id)
      || detail.binding.accessOverride.mode === 'inherit' && botDefaultAllowed || assignments.some(role => role.principalId === id && role.state === 'active' && (!role.expiresAt || role.expiresAt > now) && role.role === 'can_talk');
    if (canTalk) assignments.push({ schemaVersion: 1, id: `live_default_${id}`, revision: 1, channelBotId: owner.channelBotId, groupBindingId: detail.binding.id, principalId: id,
      role: 'can_operate', operateScope: options.installationOwner ? 'bot_runs' : 'own_runs', state: 'active', actionGates: { terminalWrite: Boolean(options.installationOwner), highRisk: Boolean(options.installationOwner), groupToolsSend: config.groupToolsAllowSend }, createdAt: now, updatedAt: now });
    return evaluatePolicyAction({ action, now, mode: 'enforce', runtimeActivation: { source: 'live_lark', channelBotId: owner.channelBotId, groupBindingId: detail.binding.id },
      channelBot: { id: owner.channelBotId, state: 'staged' }, binding: detail.binding, effectiveConfig: effective, assignments,
      principal: { id, channelBotId: owner.channelBotId, isOwner: Boolean(options.installationOwner), isChatMember: true },
      target: { channelBotId: owner.channelBotId, groupBindingId: detail.binding.id, runOwnerPrincipalId: options.taskRequesterOpenId ? principalId(appId, options.taskRequesterOpenId) : run?.principalId ?? id },
      sessionGroupTools: { read: config.groupToolsEnabled, discover: config.groupToolsEnabled, send: config.groupToolsAllowSend } });
  }

  async recordRun(session: Session, config: StoredLarkConfig, event: Pick<LarkMessageEvent, 'chatId' | 'chatType' | 'senderOpenId'>, scopeId: string) {
    if (!config.managedGroup || !event.senderOpenId) return;
    const previous = await this.repos.config.get(runKey(session.id));
    const existing = parse<RunContext>(previous);
    if (existing) {
      if (existing.appId !== config.appId || existing.chatId !== event.chatId) throw new RuntimeError('LARK_RUN_SCOPE_MISMATCH', '任务上下文不属于当前群。', 403);
      return;
    }
    const value = buildRunContext(session, config, event, scopeId);
    if (!value) return;
    if (this.repos.config.compareAndSet) await this.repos.config.compareAndSet(runKey(session.id), undefined, JSON.stringify(value));
    else await this.repos.config.set(runKey(session.id), JSON.stringify(value));
  }

  async authorizeSession(sessionId: string, action: PolicyAction, installationOwner = false) {
    const run = parse<RunContext>(await this.repos.config.get(runKey(sessionId)));
    if (run) {
      const actor = run.activeOpenId;
      const owner = installationOwner || actor === installationOwnerTaskActor;
      return this.authorize(run.appId, run.chatId, owner ? undefined : actor, action, sessionId, { installationOwner: owner, ...(actor && !owner ? { taskRequesterOpenId: actor } : {}) });
    }
    const session = await this.repos.sessions.get(sessionId);
    const [appId, chatId, chatType] = session?.sourceId?.split(':') ?? [];
    if (session?.source !== 'lark' || !appId || !chatId || chatType !== 'group') return undefined;
    return this.authorize(appId, chatId, undefined, action, sessionId, { installationOwner });
  }

  async prepareTurn(sessionId: string, actorId?: string): Promise<(() => Promise<void>) | undefined> {
    const run = parse<RunContext>(await this.repos.config.get(runKey(sessionId)));
    const owner = actorId === installationOwnerTaskActor;
    // Tasks queued before activation have no verified actor; never borrow a later task's identity.
    if (run && !actorId) throw new RuntimeError('LARK_TASK_ACTOR_REQUIRED', '此排队任务缺少可验证的发起人，请重新发送。', 403);
    const decision = run ? await this.authorize(run.appId, run.chatId, owner ? undefined : actorId, 'turn.append', sessionId, { installationOwner: owner }) : await this.authorizeSession(sessionId, 'turn.append', owner);
    if (decision && !decision.allowed) throw new RuntimeError(decision.code, decision.reason, 403);
    if (!decision) return undefined;

    let targetScope: { appId: string; chatId: string; bindingId: string } | undefined;
    const hadRun = Boolean(run);
    let candidateRun: RunContext | undefined;

    if (run) {
      targetScope = { appId: run.appId, chatId: run.chatId, bindingId: run.bindingId };
    } else if (owner) {
      const session = await this.repos.sessions.get(sessionId);
      const [appId, chatId, chatType, ...scope] = session?.sourceId?.split(':') ?? [];
      if (!session || session.source !== 'lark' || !appId || !chatId || chatType !== 'group') return undefined;
      const config = await this.resolved(await this.config(appId), chatId);
      const scopeId = scope.join(':') || chatType;
      candidateRun = buildRunContext(session, config, { chatId, chatType, senderOpenId: actorId }, scopeId);
      if (!candidateRun) return undefined;
      targetScope = { appId: candidateRun.appId, chatId: candidateRun.chatId, bindingId: candidateRun.bindingId };
    } else {
      return undefined;
    }

    return async () => {
      const current = parse<RunContext>(await this.repos.config.get(runKey(sessionId)));
      if (hadRun && !current) {
        throw new RuntimeError('LARK_RUN_SCOPE_MISMATCH', '任务上下文已被删除。', 403);
      }
      if (current) {
        if (current.appId !== targetScope.appId || current.chatId !== targetScope.chatId || current.bindingId !== targetScope.bindingId) {
          throw new RuntimeError('LARK_RUN_SCOPE_MISMATCH', '任务上下文不属于当前群。', 403);
        }
        const nextRun: RunContext = { ...current, ...(actorId ? { activeOpenId: actorId } : {}) };
        await this.repos.config.set(runKey(sessionId), JSON.stringify(nextRun));
        return;
      }
      if (candidateRun) {
        const toWrite: RunContext = { ...candidateRun, ...(actorId ? { activeOpenId: actorId } : {}) };
        if (this.repos.config.compareAndSet) {
          const inserted = await this.repos.config.compareAndSet(runKey(sessionId), undefined, JSON.stringify(toWrite));
          if (inserted === false) {
            const raced = parse<RunContext>(await this.repos.config.get(runKey(sessionId)));
            if (!raced || raced.appId !== targetScope.appId || raced.chatId !== targetScope.chatId || raced.bindingId !== targetScope.bindingId) {
              throw new RuntimeError('LARK_RUN_SCOPE_MISMATCH', '任务上下文不属于当前群。', 403);
            }
            await this.repos.config.set(runKey(sessionId), JSON.stringify({ ...raced, ...(actorId ? { activeOpenId: actorId } : {}) }));
          }
        } else {
          await this.repos.config.set(runKey(sessionId), JSON.stringify(toWrite));
        }
      }
    };
  }

  async beginTurn(sessionId: string, actorId?: string) {
    const commit = await this.prepareTurn(sessionId, actorId);
    await commit?.();
  }

  async riskPolicy(sessionId: string, fallback?: ToolRiskPolicy): Promise<ToolRiskPolicy | undefined> {
    const run = parse<RunContext>(await this.repos.config.get(runKey(sessionId)));
    if (!run) {
      const decision = await this.authorizeSession(sessionId, 'turn.append');
      return decision && !decision.allowed ? { enabled: true, authorized: false, pattern: '.*', reason: decision.reason } : fallback;
    }
    if (!run.activeOpenId) return { enabled: true, authorized: false, pattern: '.*', reason: '等待当前任务身份验证。' };
    const config = await readLarkConfig(this.repos.config, run.appId);
    const talk = await this.authorizeSession(sessionId, 'turn.append');
    if (!config || talk && !talk.allowed) return { enabled: true, authorized: false, pattern: '.*', reason: '群访问权限已撤销。' };
    if (config.riskControlMode !== 'enforced') return undefined;
    const openId = run.activeOpenId;
    const owner = openId === installationOwnerTaskActor;
    const emails = !owner && config.highRiskAllowedEmails.length ? await this.client(config).getUserEmails(openId) : [];
    const allowedByBot = owner || !config.highRiskAllowedUsers.length && !config.highRiskAllowedEmails.length
      || config.highRiskAllowedUsers.some(user => user.openId === openId) || emails.some(email => config.highRiskAllowedEmails.includes(email));
    const decision = await this.authorizeSession(sessionId, 'high_risk.execute');
    return { enabled: true, authorized: allowedByBot && decision?.allowed === true, pattern: config.highRiskPattern, reason: '当前群成员没有高风险操作授权。' };
  }

  async refreshPolicies(runtime: { listSessions(): Promise<Session[]>; setRiskPolicy(sessionId: string, policy?: ToolRiskPolicy): Promise<void> }) {
    for (const session of await runtime.listSessions()) {
      if (session.source !== 'lark' || ['stopped', 'failed'].includes(session.state)) continue;
      if (!await this.repos.config.get(runKey(session.id)) && !await this.authorizeSession(session.id, 'turn.append')) continue;
      await runtime.setRiskPolicy(session.id, await this.riskPolicy(session.id));
    }
  }

  async ownsTopic(config: StoredLarkConfig, event: LarkMessageEvent, scopeId: string) {
    if (!event.threadId || !scopeId.startsWith('thread:')) return false;
    const source = larkSourceId(config, event.chatId, event.chatType, scopeId);
    return (await this.repos.sessions.list()).some(session => session.source === 'lark' && session.sourceId === source && !session.archivedAt && !['stopped', 'failed'].includes(session.state));
  }
}

export async function registerLarkGroupManagementRoutes(app: FastifyInstance, manager?: LarkGroupManager) {
  const requireManager = () => { if (!manager) throw new RuntimeError('LARK_GROUP_MANAGEMENT_UNAVAILABLE', '群管理尚未接入当前服务。', 503); return manager; };
  app.get('/api/lark/management/groups', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); return requireManager().groups(); });
  app.post<{ Params: { appId: string } }>('/api/lark/bots/:appId/sync-groups', async request => requireManager().sync(request.params.appId));
  app.get<{ Params: { appId: string; chatId: string }; Querystring: { pageToken?: string } }>('/api/lark/bots/:appId/groups/:chatId/members', async request => requireManager().members(request.params.appId, request.params.chatId, request.query.pageToken));
  app.put<{ Params: { appId: string; chatId: string } }>('/api/lark/bots/:appId/groups/:chatId', async (request, reply) => {
    try { return await requireManager().save(request.params.appId, request.params.chatId, request.body); }
    catch (error) {
      if ((error instanceof RuntimeError || error instanceof LarkServiceError) && error.statusCode === 409) {
        const groups = await requireManager().groups();
        const current = groups.groups.find(group => group.chatId === request.params.chatId && group.bots.some(bot => bot.appId === request.params.appId))?.bots.find(bot => bot.appId === request.params.appId);
        return reply.code(409).send({ error: { code: error.code, message: error.message }, current });
      }
      throw error;
    }
  });
}
