import { installationOwnerTaskActor, type RepositoryBundle, type ToolRiskPolicy } from '@dutydeck/shared';
import type { LarkGroupManager } from './lark/group-management.js';
import { defaultHighRiskPattern, readLarkConfig } from './lark/config.js';
import { createLarkCardService } from './lark/service.js';

/** Resolve the captured actor without replacing the parent conversation's current actor. */
export async function workItemRiskPolicy(repos: RepositoryBundle, groups: LarkGroupManager, parentSessionId: string, actorId: string, fallback?: ToolRiskPolicy, env: NodeJS.ProcessEnv = process.env, fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<ToolRiskPolicy | undefined> {
  const parent = await repos.sessions.get(parentSessionId);
  if (parent?.source !== 'lark') return fallback;
  const [appId, chatId, chatType] = parent.sourceId?.split(':') ?? [];
  let config = appId ? await readLarkConfig(repos.config, appId) : null;
  if (!config || !chatId) return { enabled: true, authorized: false, pattern: '.*', reason: '原机器人配置已失效' };
  if (chatType === 'group') config = await groups.resolved(config, chatId);
  if (config.riskControlMode !== 'enforced') return fallback;
  const owner = actorId === installationOwnerTaskActor;
  let authorized = owner || !config.highRiskAllowedUsers.length && !config.highRiskAllowedEmails.length || config.highRiskAllowedUsers.some(user => user.openId === actorId);
  if (!authorized && !config.highRiskAllowedUsers.length && config.highRiskAllowedEmails.length) {
    try { authorized = (await createLarkCardService(env, fetcher, config).getUserEmails(actorId)).some(email => config.highRiskAllowedEmails.includes(email)); }
    catch { authorized = false; }
  }
  if (chatType === 'group') {
    const decision = await groups.authorize(appId!, chatId, owner ? undefined : actorId, 'high_risk.execute', parentSessionId, { installationOwner: owner, taskRequesterOpenId: actorId });
    if (decision && !decision.allowed) authorized = false;
  }
  return { enabled: true, authorized, pattern: config.highRiskPattern || defaultHighRiskPattern, reason: '目标发起人没有此高风险操作权限' };
}

/** Recheck the approving human, even if the original native request is still pending. */
export async function authorizeWorkItemInteraction(repos: RepositoryBundle, groups: LarkGroupManager, parentSessionId: string, actorId: string, action: 'high_risk.execute' | 'terminal.write' | 'terminal.read', env: NodeJS.ProcessEnv = process.env, fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<boolean> {
  const parent = await repos.sessions.get(parentSessionId);
  if (!parent) return false;
  if (parent.source !== 'lark') return actorId === installationOwnerTaskActor;
  const [appId, chatId, chatType] = parent.sourceId?.split(':') ?? [];
  if (!appId || !chatId) return false;
  const owner = actorId === installationOwnerTaskActor;
  if (chatType === 'group') {
    for (const required of new Set(action === 'terminal.read' ? [action] : [action, 'high_risk.execute'] as const)) {
      const decision = await groups.authorize(appId, chatId, owner ? undefined : actorId, required, parentSessionId, { installationOwner: owner, taskRequesterOpenId: actorId });
      if (decision && !decision.allowed) return false;
    }
  }
  if (action === 'terminal.read') return true;
  const policy = await workItemRiskPolicy(repos, groups, parentSessionId, actorId, undefined, env, fetcher);
  return !policy?.enabled || policy.authorized;
}
