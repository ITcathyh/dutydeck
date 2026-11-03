import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { LarkCardService } from './lark/service.js';
import { createAutomationIntegration } from './automation-integration.js';

const opened: Array<{ close(): void }> = [];
afterEach(() => { while (opened.length) opened.pop()!.close(); });

async function fixture() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); opened.push(repos);
  const at = new Date().toISOString();
  const session = { id: 's1', agentId: 'a', source: 'lark', sourceId: 'cli_a:oc_chat:group:thread:om_root', cwd: process.cwd(), state: 'idle', runId: 'r', createdAt: at, updatedAt: at };
  await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_a', appSecret: 'secret', listening: true, fullTrustConfirmed: true, allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [] }]));
  await repos.config.set('automation.delivery-target.sch_rebase', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_original', replyInThread: true }));
  const client = {
    reply: vi.fn<(...args: Parameters<LarkCardService['reply']>) => ReturnType<LarkCardService['reply']>>(async () => ({ messageId: 'om_new' })),
    update: vi.fn<(...args: Parameters<LarkCardService['update']>) => ReturnType<LarkCardService['update']>>(async input => ({ messageId: input.messageId }))
  };
  const warn = vi.fn();
  const integration = createAutomationIntegration(repos, { getSession: vi.fn(async () => session) } as any, { authorize: vi.fn(async () => undefined) } as any, { client: () => client as any, log: { warn } });
  return { ...integration, client, warn, session };
}

const schedule: any = { id: 'sch_rebase', sessionId: 's1', name: '每日 rebase', timezone: 'Asia/Shanghai', actorId: 'ou_alice' };

it('posts one short line in the original topic, then edits that message, and replies again only when the edit fails', async () => {
  const f = await fixture();
  expect(await f.onScheduleProblem(schedule, { occurrenceId: 'occ_1', text: '定时计划『每日 rebase』这次没跑起来：执行会话被锁住了。下次 2026/11/4 00:00:00 再跑。' })).toEqual({ messageId: 'om_new' });
  expect(f.client.reply).toHaveBeenCalledOnce();
  expect(f.client.reply.mock.calls[0]![0]).toMatchObject({ messageId: 'om_original', replyInThread: true, taskName: '每日 rebase' });
  expect(JSON.stringify(f.client.reply.mock.calls[0]![0].elements)).toContain('这次没跑起来：执行会话被锁住了');

  expect(await f.onScheduleProblem(schedule, { occurrenceId: 'occ_2', messageId: 'om_new', text: '定时计划『每日 rebase』已连续 2 次没做成：执行会话被锁住了。' })).toEqual({ messageId: 'om_new' });
  expect(f.client.update).toHaveBeenCalledOnce();
  expect(f.client.update.mock.calls[0]![0]).toMatchObject({ messageId: 'om_new' });
  expect(JSON.stringify(f.client.update.mock.calls[0]![0].elements)).toContain('已连续 2 次没做成');
  expect(f.client.reply).toHaveBeenCalledOnce();

  f.client.update.mockRejectedValueOnce(new Error('message can not be updated'));
  f.client.reply.mockResolvedValueOnce({ messageId: 'om_again' });
  expect(await f.onScheduleProblem(schedule, { occurrenceId: 'occ_3', messageId: 'om_new', text: '定时计划『每日 rebase』已连续 3 次没做成：执行会话被锁住了。' })).toEqual({ messageId: 'om_again' });
  expect(f.client.reply).toHaveBeenCalledTimes(2);
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: 'sch_rebase', messageId: 'om_new' }), expect.any(String));

  f.session.source = 'web';
  expect(await f.onScheduleProblem(schedule, { occurrenceId: 'occ_4', text: 'x' })).toBe('not_requested');
});
