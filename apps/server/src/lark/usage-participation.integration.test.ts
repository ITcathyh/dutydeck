import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { Session, TaskRequestV1 } from '@dutydeck/shared';
import { UsageLedger } from '../usage-ledger.js';
import { LarkGroupParticipation } from './group-participation.js';
import type { StoredLarkConfig } from './config.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scope = { appId: 'cli_budget', chatId: 'oc_budget' };
const at = '2026-09-27T00:00:00Z';

async function fixture(limit: number) {
  const repos = createRepositories(':memory:'); cleanup.push(() => repos.close());
  const ledger = new UsageLedger({ repositories: repos, backgroundLimits: { bots: { [scope.appId]: limit } }, now: () => new Date(at) });
  await repos.collaboration.updateSettings(scope, { expectedRevision: 0, participation: 'selective' }, 'owner');
  const config = { appId: scope.appId, appSecret: 'fake', listening: true, memoryEnabled: true, permissionMode: 'ask' } as StoredLarkConfig;
  const readMemory = vi.fn(async () => 'memory'), readTeamContext = vi.fn(), readGroupDescription = vi.fn(async () => 'description');
  const listChatMessages = vi.fn(async () => ({ items: [], hasMore: false }));
  const decide = vi.fn(), respond = vi.fn();
  const automaticRefusal = vi.spyOn(ledger, 'automaticRefusal');
  const participation = new LarkGroupParticipation({ repository: repos.collaboration, decider: { decide, respond },
    authorize: async () => true, readConfig: async () => config, readMemory, readTeamContext, readGroupDescription,
    serviceFor: () => ({ listChatMessages }) as any, debounceMs: 10000,
    usageRefusal: async target => await ledger.refusal(target.appId, target.chatId) ?? await ledger.automaticRefusal(target.appId) });
  cleanup.push(() => participation.close());
  const snapshots = vi.spyOn(repos.collaboration, 'snapshot');
  const trigger = async () => {
    await participation.handle({ messageId: 'om_1', chatId: scope.chatId, chatType: 'group', senderOpenId: 'ou_user', senderType: 'user',
      messageType: 'text', content: '{"text":"请总结工作"}', createTime: String(Date.parse(at)), mentions: [] }, config, { explicit: false });
    await participation.flush(scope);
    for (const read of [readMemory, readTeamContext, readGroupDescription, listChatMessages, snapshots, decide, respond]) expect(read).not.toHaveBeenCalled();
    return (await repos.collaboration.listDecisions(scope))[0]!;
  };
  return { repos, ledger, automaticRefusal, trigger };
}

describe('automatic allowance before participation material reads', () => {
  it.each([0, 1])('refuses a real persisted allowance of %i without reading expensive material or consuming again', async limit => {
    const f = await fixture(limit);
    if (limit) {
      const session = { id: 'ses_background', agentId: 'mock', state: 'idle', cwd: '/tmp', source: 'lark-decision', sourceId: `${scope.appId}:${scope.chatId}`, runId: 'run', createdAt: at, updatedAt: at } as Session;
      const request: TaskRequestV1 = { version: 1, namespace: 'runtime', key: 'first', sessionId: session.id, actor: { kind: 'unspecified' }, prompt: 'first', mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: {} };
      await f.ledger.admit(session, request);
    }
    const before = await f.repos.usage.backgroundTaskCounts('2026-09');
    expect(await f.trigger()).toMatchObject({ status: 'suppressed', reason: expect.stringContaining(`已达 ${limit} 次上限`), inputSnapshot: { gate: 'usage_cap' } });
    expect(f.automaticRefusal).toHaveBeenCalledExactlyOnceWith(scope.appId);
    expect(await f.repos.usage.backgroundTaskCounts('2026-09')).toEqual(before);
  });

  it('keeps the dollar cap reason first when both caps are exhausted', async () => {
    const f = await fixture(0);
    await f.ledger.setCap({ scope: 'group', ...scope, monthlyCostUsd: 1 });
    await f.repos.usage.append({ id: 'usage_prior', recordedAt: at, ...scope, sessionId: 'ses_prior', taskId: 'task_prior', attemptId: 'attempt_prior',
      category: 'explicit', origin: 'lark_group', agentId: 'mock', costUsd: 1, costEstimated: false, dataStatus: 'reported' });
    expect(await f.trigger()).toMatchObject({ status: 'suppressed', reason: expect.stringContaining('本群本月成本已达上限') });
    expect(f.automaticRefusal).not.toHaveBeenCalled();
  });
});
