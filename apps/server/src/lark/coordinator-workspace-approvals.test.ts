import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkInteraction } from './workflow-interactions.js';

const bot = (patch: Partial<StoredLarkConfig> = {}) => ({ appId: 'cli_rules', appSecret: 'fake-secret', listening: true, allowedUsers: [], allowedEmails: [], allowedBots: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], ...patch });
const record = { appId: 'cli_rules', sessionId: 'ses_one', taskId: 'task_one', turn: 1, event: { chatId: 'oc_group', chatType: 'group', messageId: 'om_1', senderOpenId: 'ou_alice' } } as unknown as LarkInteraction;

/** 谁能建工作区审批规则：托管群按群策略要求所有者或管理员；非托管 Bot 只认非空访问白名单。 */
describe('coordinator authorizeWorkspaceRule', () => {
  const coordinator = async (config: Record<string, unknown>, managed?: (actor: string) => boolean) => {
    const repos = createRepositories(':memory:');
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    const authorize = vi.fn(async (_appId: string, _chatId: string, actor: string, action: string) => managed ? { allowed: managed(actor), action } : undefined);
    const service = { getUserEmails: vi.fn(async () => [] as string[]) };
    const instance = new LarkMessageCoordinator({} as any, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, Math.random, 'ou_bot', undefined, repos.channelMappings,
      async () => 'group', undefined, { authorize, highRiskOpenIds: async () => [] } as any, { store: repos.config });
    return { check: (actor: string) => (instance as any).authorizeWorkspaceRule(record, actor) as Promise<boolean>, authorize, close: () => { instance.stop(); repos.close(); } };
  };

  it('uses the managed group owner/admin decision for grant.create', async () => {
    const h = await coordinator(bot(), actor => actor === 'ou_alice');
    try {
      expect(await h.check('ou_alice')).toBe(true);
      expect(await h.check('ou_bob')).toBe(false);
      expect(h.authorize).toHaveBeenCalledWith('cli_rules', 'oc_group', 'ou_alice', 'grant.create', 'ses_one');
    } finally { h.close(); }
  });

  it('on an unmanaged bot allows only members of a non-empty access whitelist', async () => {
    const open = await coordinator(bot());
    try { expect(await open.check('ou_alice')).toBe(false); } finally { open.close(); }
    const listed = await coordinator(bot({ allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }] }));
    try {
      expect(await listed.check('ou_alice')).toBe(true);
      expect(await listed.check('ou_bob')).toBe(false);
    } finally { listed.close(); }
    const stopped = await coordinator(bot({ listening: false, allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }] }));
    try { expect(await stopped.check('ou_alice')).toBe(false); } finally { stopped.close(); }
  });
});
