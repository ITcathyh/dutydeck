import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { authorizeWorkItemAgent, authorizeWorkItemInteraction } from './work-item-policy.js';
import { larkBotsConfigKey } from './lark/config.js';
import type { LarkGroupManager } from './lark/group-management.js';

const repos = createRepositories(':memory:');
afterEach(() => { vi.restoreAllMocks(); repos.close(); });

describe('work item approval policy', () => {
  it('reads changed bot permissions and checks group high-risk permission even with risk matching disabled', async () => {
    const config = { appId: 'cli_work', appSecret: 'fixture', riskControlMode: 'enforced', highRiskAllowedUsers: [{ openId: 'ou_alice', name: 'Alice' }] };
    await repos.sessions.save({ id: 'parent', agentId: 'alpha', source: 'lark', sourceId: 'cli_work:oc_group:group', state: 'idle', cwd: '/tmp', runId: 'run', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' });
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    const authorize = vi.fn(async () => ({ allowed: true }));
    const groups = { authorize, resolved: async (value: unknown) => value } as unknown as LarkGroupManager;
    expect(await authorizeWorkItemInteraction(repos, groups, 'parent', 'ou_alice', 'high_risk.execute')).toBe(true);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...config, highRiskAllowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] }]));
    expect(await authorizeWorkItemInteraction(repos, groups, 'parent', 'ou_alice', 'high_risk.execute')).toBe(false);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...config, riskControlMode: 'off' }]));
    authorize.mockResolvedValue({ allowed: false });
    expect(await authorizeWorkItemInteraction(repos, groups, 'parent', 'ou_alice', 'terminal.write')).toBe(false);
  });
});

describe('work item agent selection', () => {
  it('lets group members use the layered roster without run.change_agent, and nothing else', async () => {
    const store = createRepositories(':memory:');
    try {
      await store.sessions.save({ id: 'parent', agentId: 'pmo', source: 'lark', sourceId: 'cli_work:oc_group:group', state: 'idle', cwd: '/tmp', runId: 'run', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z' });
      const config = { appId: 'cli_work', appSecret: 'fixture', executionMode: 'layered', leaderAgentId: 'leader', workerAgentIds: ['worker'] };
      await store.config.set(larkBotsConfigKey, JSON.stringify([config]));
      const authorize = vi.fn(async () => ({ allowed: false }));
      const talk = vi.fn(async () => true);
      const check = (agentId: string) => authorizeWorkItemAgent(store, { authorize } as unknown as LarkGroupManager, talk, 'parent', 'ou_alice', agentId);
      expect([await check('pmo'), await check('leader'), await check('worker'), await check('other')]).toEqual([true, true, true, false]);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledWith('cli_work', 'oc_group', 'ou_alice', 'run.change_agent', 'parent', { installationOwner: false });
      // 切回单 Agent 后名单不再代表授权；不能发起任务的人什么都不能用。
      await store.config.set(larkBotsConfigKey, JSON.stringify([{ ...config, executionMode: 'single' }]));
      expect(await check('leader')).toBe(false);
      talk.mockResolvedValue(false);
      expect(await check('pmo')).toBe(false);
    } finally { store.close(); }
  });
});
