import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkInteraction } from './workflow-interactions.js';

const bot = (patch: Partial<StoredLarkConfig> = {}) => ({ appId: 'cli_rules', appSecret: 'fake-secret', listening: true, allowedUsers: [], allowedEmails: [], allowedBots: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], ...patch });
const record = { appId: 'cli_rules', sessionId: 'ses_one', taskId: 'task_one', turn: 1, event: { chatId: 'oc_group', chatType: 'group', messageId: 'om_1', senderOpenId: 'ou_alice' } } as unknown as LarkInteraction;

/** 谁能建工作区审批规则：接入群管理的 Bot 只认机器人级管理员；非托管 Bot 只认非空访问白名单。 */
describe('coordinator authorizeWorkspaceRule', () => {
  const coordinator = async (config: Record<string, unknown>, managed?: { botAdmin: (actor: string) => boolean; groupAdmin?: (actor: string) => boolean }) => {
    const repos = createRepositories(':memory:');
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    const authorize = vi.fn(async (_appId: string, _chatId: string, actor: string, action: string) => managed ? { allowed: managed.groupAdmin?.(actor) ?? false, action } : undefined);
    const botAdmin = vi.fn(async (_appId: string, actor: string) => managed ? managed.botAdmin(actor) : undefined);
    const service = { getUserEmails: vi.fn(async () => [] as string[]) };
    const instance = new LarkMessageCoordinator({} as any, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, Math.random, 'ou_bot', undefined, repos.channelMappings,
      async () => 'group', undefined, { authorize, botAdmin, highRiskOpenIds: async () => [] } as any, { store: repos.config });
    return { check: (actor: string) => (instance as any).authorizeWorkspaceRule(record, actor) as Promise<boolean>, authorize, botAdmin, close: () => { instance.stop(); repos.close(); } };
  };

  it('on a managed bot accepts only bot-level admins, never group-level admins (finding 6)', async () => {
    const h = await coordinator(bot(), { botAdmin: actor => actor === 'ou_alice', groupAdmin: actor => actor === 'ou_carol' });
    try {
      expect(await h.check('ou_alice')).toBe(true);
      // 只在卡片所在群是管理员的人不能建对整个机器人生效的规则。
      expect(await h.check('ou_carol')).toBe(false);
      expect(await h.check('ou_bob')).toBe(false);
      expect(h.botAdmin).toHaveBeenCalledWith('cli_rules', 'ou_carol');
      expect(h.authorize).not.toHaveBeenCalled();
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

/** 自动批准的来源单独写进事件：工作区规则不复用「本会话允许」的标志（finding 32）。 */
describe('coordinator auto-approval annotations', () => {
  it('records which mechanism approved the request without sharing the session-allow flag', () => {
    const repos = createRepositories(':memory:');
    const instance = new LarkMessageCoordinator({} as any, {} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, Math.random, 'ou_bot', undefined, repos.channelMappings,
      async () => 'group', undefined, undefined, { store: repos.config });
    try {
      const task = { sessionId: 'ses_one', events: [] as any[], config: bot(), event: record.event };
      const options = (instance as any).workflowObserveOptions(task);
      options.onAutoApproved('perm_rule', { by: 'workspace_rule', rule: 'pnpm test' });
      options.onAutoApproved('perm_session', { by: 'session_allow' });
      expect(task.events.map(event => [event.id, event.data])).toEqual([
        ['auto_approved_perm_rule', { id: 'perm_rule', autoApprovedBy: 'workspace_rule', workspaceRule: 'pnpm test' }],
        ['auto_approved_perm_session', { id: 'perm_session', autoApprovedBy: 'session_allow', sessionAllowed: true }]
      ]);
    } finally { instance.stop(); repos.close(); }
  });
});
