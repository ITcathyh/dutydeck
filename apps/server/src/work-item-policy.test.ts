import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { authorizeWorkItemAgent, authorizeWorkItemInteraction, capturedRiskPolicy, workItemRiskPolicy } from './work-item-policy.js';
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

describe('work item risk policy capped by the policy captured at dispatch', () => {
  it('keeps a bot-started goal unauthorized under enforced risk control with empty high-risk lists; people and risk-off are unchanged', async () => {
    const store = createRepositories(':memory:');
    try {
      const config = { appId: 'cli_work', appSecret: 'fixture', riskControlMode: 'enforced', highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger' };
      await store.sessions.save({ id: 'parent', agentId: 'alpha', source: 'lark', sourceId: 'cli_work:oc_group:group', state: 'idle', cwd: '/tmp', runId: 'run', createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z' });
      await store.config.set(larkBotsConfigKey, JSON.stringify([config]));
      const groups = { authorize: vi.fn(async () => undefined), resolved: async (value: unknown) => value } as unknown as LarkGroupManager;
      const bot = { enabled: true, authorized: false, pattern: 'danger', reason: '机器人发起的任务没有高危授权' };
      // 现场重算对谁都放行（名单为空），发起时记下的未授权是上限。
      expect(await workItemRiskPolicy(store, groups, 'parent', 'ou_peer_bot')).toMatchObject({ enabled: true, authorized: true });
      expect(await workItemRiskPolicy(store, groups, 'parent', 'ou_peer_bot', undefined, process.env, fetch, bot)).toEqual({ enabled: true, authorized: false, pattern: 'danger', reason: '机器人发起的任务没有高危授权' });
      expect(await workItemRiskPolicy(store, groups, 'parent', 'ou_alice', undefined, process.env, fetch, { ...bot, authorized: true })).toMatchObject({ enabled: true, authorized: true });
      // 只收紧：发起时有授权，现场不在名单里照样不授权。
      await store.config.set(larkBotsConfigKey, JSON.stringify([{ ...config, highRiskAllowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] }]));
      expect(await workItemRiskPolicy(store, groups, 'parent', 'ou_alice', undefined, process.env, fetch, { ...bot, authorized: true })).toMatchObject({ authorized: false });
      // 风控现在没开：照旧返回 fallback，不受发起时策略影响。
      await store.config.set(larkBotsConfigKey, JSON.stringify([{ ...config, riskControlMode: 'off' }]));
      expect(await workItemRiskPolicy(store, groups, 'parent', 'ou_peer_bot', undefined, process.env, fetch, bot)).toBeUndefined();
    } finally { store.close(); }
  });

  it('reads the captured policy from the accepted parent task', () => {
    const policy = { enabled: true, authorized: false, pattern: 'danger' };
    const execution = { getAcceptedTask: vi.fn((id: string) => id === 'task_parent' ? { task: { executionContext: { riskPolicy: policy } } } : undefined) };
    expect(capturedRiskPolicy({ execution } as never, 'task_parent')).toEqual(policy);
    expect(capturedRiskPolicy({ execution } as never, 'task_other')).toBeUndefined();
    expect(capturedRiskPolicy({ execution } as never)).toBeUndefined();
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
