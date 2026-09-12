import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { authorizeWorkItemInteraction } from './work-item-policy.js';
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
