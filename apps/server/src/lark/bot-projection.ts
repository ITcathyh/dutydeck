import { resolveParticipation, type BotProjectionTransaction, type CreateChannelBotGroupPolicyInput, type StoredLarkConfig } from '@dutydeck/shared';
import { sha256Hex as hash } from '../hash.js';

export interface LiveOwner { channelBotId: string; credentialRefId: string; fingerprint: string; activeGroups: string[] }
export const ownerKey = (appId: string) => `lark.live-owner.${appId}`;
export const principalId = (appId: string, openId: string) => `principal_${hash(`${appId}\0${openId}`)}`;

export function botPolicyFields(config: StoredLarkConfig): Omit<CreateChannelBotGroupPolicyInput, 'id' | 'channelBotId'> {
  return {
    defaults: { agentDefinitionId: config.defaultAgentId, workspace: config.workspace, model: config.defaultModel, reasoningEffort: config.defaultReasoningEffort },
    routingDefaults: { groupReplyMode: config.groupReplyMode ?? 'chat-topic', mentionPolicy: resolveParticipation({ mentionPolicy: config.mentionPolicy }).mentionPolicy },
    accessPolicy: config.allowedUsers.length ? { mode: 'allowlist', principalIds: config.allowedUsers.map(user => principalId(config.appId, user.openId)) }
      : { mode: config.allowedEmails.length ? 'owner_only' : 'open', principalIds: [] },
    groupToolsPolicy: { readCeiling: config.groupToolsEnabled, discoverCeiling: config.groupToolsEnabled, sendCeiling: config.groupToolsEnabled && config.groupToolsAllowSend, readDefault: config.groupToolsEnabled, discoverDefault: config.groupToolsEnabled, sendDefault: config.groupToolsEnabled && config.groupToolsAllowSend }
  };
}

export function refreshBotProjection(tx: BotProjectionTransaction, config: StoredLarkConfig) {
  const raw = tx.config.get(ownerKey(config.appId));
  if (!raw) return;
  const owner = JSON.parse(raw) as LiveOwner;
  const bot = tx.channelBots.get(owner.channelBotId);
  if (!bot || bot.externalAppId !== config.appId) return;
  const displayName = config.name ?? config.appId;
  const brand = config.brand ?? 'feishu';
  if (displayName !== bot.displayName || brand !== bot.brand) {
    tx.channelBots.update(bot.id, { expectedRevision: bot.revision, displayName, brand });
  }
  const fields = botPolicyFields(config);
  const current = tx.channelBotPolicies.getByChannelBot(bot.id);
  if (!current) tx.channelBotPolicies.create({ id: `live_policy_${bot.id}`, channelBotId: bot.id, ...fields });
  else if ((Object.keys(fields) as Array<keyof typeof fields>).some(key => JSON.stringify(current[key]) !== JSON.stringify(fields[key]))) {
    tx.channelBotPolicies.update(current.id, { expectedRevision: current.revision, ...fields });
  }
}
