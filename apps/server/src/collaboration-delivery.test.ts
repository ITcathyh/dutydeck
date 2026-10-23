import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { RepositoryBundle } from '@dutydeck/shared';
import { CollaborationService } from './collaboration-service.js';
import { createRepositories, scheduleWriterLeaseKey } from '@dutydeck/storage';
import { CollaborationDelivery } from './collaboration-delivery.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0)) await close(); });
async function reminder(repos: RepositoryBundle, id: string, scope = { appId: 'app', chatId: 'chat' }) {
  if (!await repos.channelBots.get('bot')) {
    await repos.secretRefs.create({ id: 'secret', kind: 'generic', provider: 'keychain', referenceKey: 'test', status: 'configured' });
    await repos.channelBots.create({ id: 'bot', channel: 'lark', externalAppId: scope.appId, displayName: 'Bot', brand: 'feishu', credentialRef: 'secret', state: 'staged' });
  }
  const service = new CollaborationService({ repositories: repos, authorize: async () => true,
    resolveScheduleScope: async () => ({ channelBotId: 'bot', identityRef: 'identity', secretRef: 'secret' }) });
  const { mandate, schedule } = await service.createMandate(scope, 'owner', { id, goal: id, mode: 'notify', prompt: id,
    trigger: { kind: 'interval', everySeconds: 60, anchorAt: new Date().toISOString() }, timezone: 'UTC' });
  const { occurrence } = await repos.scheduleOccurrences.recordPlanned(schedule.id, new Date().toISOString(), undefined, schedule.currentGeneration);
  const leaseKey = scheduleWriterLeaseKey('bot');
  const lease = await repos.scheduleLeases.getByKey(leaseKey) ?? await repos.scheduleLeases.acquire({ id: 'lease', leaseKey, expectedRevision: 0, expectedGeneration: 0,
    holderId: 'writer', holderIdentityRef: 'identity', secretRef: 'secret', scheduleSetHash: 'a'.repeat(64), now: new Date().toISOString(), ttlMs: 60_000 });
  const fence = { leaseKey, holderId: 'writer', fenceToken: lease.fenceToken, now: new Date().toISOString(), occurrenceId: occurrence.id };
  const { action } = await repos.collaboration.beginAction({ scope, id: `collaboration_delivery_${occurrence.idempotencyKey}`, kind: 'schedule_delivery', mandateId: mandate.id,
    mandateRevision: mandate.revision, scheduleGeneration: schedule.currentGeneration, requesterId: 'owner', inputDigest: id, payload: {} }, fence);
  return { action, fence };
}
it.each(['sending', 'unknown', 'succeeded'] as const)('counts a same-millisecond %s delivery regardless of id ordering', async status => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T08:00:00.000Z'));
  const repos = createRepositories(':memory:'), repository = repos.collaboration;
  cleanups.push(async () => { repos.close(); });
  const scope = { appId: 'app', chatId: 'chat' };
  await repository.updateSettings(scope, { expectedRevision: 0, maxProactivePerHour: 1 }, 'owner');
  let first = (await repository.beginAction({ scope, id: 'zzzz', kind: 'participation.reply', requesterId: 'owner', inputDigest: 'z', payload: {} })).action;
  first = await repository.updateAction(scope, first.id, { expectedRevision: first.revision, status: 'sending' });
  if (status !== 'sending') first = await repository.updateAction(scope, first.id, { expectedRevision: first.revision, status });
  const { action: next } = await reminder(repos, 'a');
  expect(next.id < first.id).toBe(true);
  expect(next.createdAt).toBe(first.createdAt);
  const send = vi.fn(async () => 'receipt');
  await expect(new CollaborationDelivery(repository).run(scope, next.id, send)).rejects.toMatchObject({ code: 'COLLABORATION_DELIVERY_SUPPRESSED' });
  expect(send).not.toHaveBeenCalled();
});

it.each(['failed', 'suppressed'] as const)('releases a same-millisecond %s reservation while keeping intent order', async status => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T08:00:00.000Z'));
  const repos = createRepositories(':memory:'), repository = repos.collaboration;
  cleanups.push(async () => { repos.close(); });
  const scope = { appId: 'app', chatId: 'chat' };
  await repository.updateSettings(scope, { expectedRevision: 0, maxProactivePerHour: 1 }, 'owner');
  const { action, fence } = await reminder(repos, 'z');
  let first = await repository.updateAction(scope, action.id, { expectedRevision: action.revision, status: 'sending' }, fence);
  await repository.updateAction(scope, first.id, { expectedRevision: first.revision, status }, fence);
  const ordered = [(await reminder(repos, 'a')).action, (await reminder(repos, 'b')).action].sort((a, b) => a.id.localeCompare(b.id));
  const guard = new CollaborationDelivery(repository), send = vi.fn(async () => 'receipt');
  await guard.run(scope, ordered[0]!.id, send);
  await expect(guard.run(scope, ordered[1]!.id, send)).rejects.toMatchObject({ code: 'COLLABORATION_DELIVERY_SUPPRESSED' });
  expect(send).toHaveBeenCalledOnce();
});
it('preserves the hourly allowance across more than 500 unrelated actions and repository reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collaboration-budget-history-'));
  let repos = createRepositories(join(directory, 'test.db'));
  cleanups.push(async () => { repos.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = { appId: 'app', chatId: 'chat' };
  await repos.collaboration.updateSettings(scope, { expectedRevision: 0, maxProactivePerHour: 1 }, 'owner');
  const begin = (id: string, kind: string, target = scope) => repos.collaboration.beginAction({ scope: target, id, kind, requesterId: 'owner', inputDigest: id, payload: {} });
  let first = (await begin('first', 'participation.reply')).action;
  const send = vi.fn(async () => 'receipt');
  await new CollaborationDelivery(repos.collaboration).run(scope, first.id, send);
  first = await repos.collaboration.updateAction(scope, first.id, { expectedRevision: first.revision, status: 'sending' });
  await repos.collaboration.updateAction(scope, first.id, { expectedRevision: first.revision, status: 'succeeded', receipt: 'receipt' });
  for (let i = 0; i < 501; i++) await begin(`command-${i}`, 'command:update_mandate');
  await reminder(repos, 'foreign', { ...scope, chatId: 'other' });
  const { action: second } = await reminder(repos, 'second');
  repos.close(); repos = createRepositories(join(directory, 'test.db'));
  await expect(new CollaborationDelivery(repos.collaboration).run(scope, second.id, send)).rejects.toMatchObject({ code: 'COLLABORATION_DELIVERY_SUPPRESSED' });
  expect(send).toHaveBeenCalledTimes(1);
  const later = new CollaborationDelivery(repos.collaboration, () => new Date(Date.now() + 3_600_001));
  await expect(later.run(scope, second.id, send)).rejects.toMatchObject({ code: 'COLLABORATION_DELIVERY_SUPPRESSED' });
});
it('shares an hourly allowance across replies and reminders and rechecks pause after queueing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collaboration-delivery-'));
  const repos = createRepositories(join(directory, 'test.db')), repository = repos.collaboration;
  cleanups.push(async () => { repos.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = { appId: 'app', chatId: 'chat' };
  await repository.updateSettings(scope, { expectedRevision: 0, maxProactivePerHour: 1 }, 'owner');
  const begin = (id: string, kind: string) => repository.beginAction({ scope, id, kind, requesterId: 'owner', inputDigest: id, payload: {} });
  await begin('a', 'participation.reply'); const { action: second } = await reminder(repos, 'b');
  await begin('command', 'command:create_mandate');
  const guard = new CollaborationDelivery(repository), send = vi.fn(async () => 'receipt');
  const outcomes = await Promise.allSettled([guard.run(scope, 'a', send), guard.run(scope, second.id, send)]);
  expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected']); expect(send).toHaveBeenCalledTimes(1);
  await repository.updateSettings(scope, { expectedRevision: 1, maxProactivePerHour: 10 }, 'owner');
  let release!: () => void;
  const first = guard.run(scope, 'a', () => new Promise<void>(resolve => { release = resolve; }));
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const queued = guard.run(scope, second.id, send);
  const rejected = expect(queued).rejects.toMatchObject({ code: 'COLLABORATION_DELIVERY_SUPPRESSED' });
  await repository.updateSettings(scope, { expectedRevision: 2, notificationsPaused: true }, 'owner');
  release(); await first; await rejected; expect(send).toHaveBeenCalledTimes(1);
});
