import { afterEach, expect, it } from 'vitest';
import { createRepositories } from './index.js';
import type { MemoryJob, RepositoryBundle } from '@dutydeck/shared';
const open: RepositoryBundle[] = [];
afterEach(() => { for (const repos of open.splice(0)) repos.close(); });
const scope = { appId: 'app', pool: 'groups' };
const stateKey = 'lark.memory.state.app.groups';
const entriesKey = 'lark.memory.app.groups';
async function harness() {
  const repos = createRepositories(':memory:'); open.push(repos);
  await repos.config.set(stateKey, JSON.stringify({ v: 1, running: { token: 'claim' }, pendingTurns: [{ taskId: 'old' }, { taskId: 'new' }] }));
  const job: MemoryJob = { id: 'memory_' + 'a'.repeat(64), scope, revision: 0, claimToken: 'claim', kind: 'extraction', mode: 'compatible', input: { turns: [{ taskId: 'old' }] }, inputDigest: 'b'.repeat(64), versions: [{ key: entriesKey }, { key: 'lark.memory.ignore.app.groups' }, { key: 'lark.bots' }, { key: 'lark.credentials' }], sessionId: 'ses_memory_' + 'a'.repeat(64), sessionInput: { agentId: 'agent', source: 'lark-memory', sourceId: 'app:groups:memory' }, requests: [], state: 'prepared', createdAt: '2026-10-03T00:00:00Z' };
  await repos.memoryJobs.create(job);
  const input = { job, claimToken: 'claim', versions: [...job.versions, { key: stateKey, value: await repos.config.get(stateKey) }], writes: [{ key: entriesKey, value: '{"v":1,"entries":[]}' }, { key: stateKey, value: '{"v":1,"appliedJobId":"'+job.id+'","pendingTurns":[{"taskId":"new"}]}' }], consumedTaskIds: ['old'], result: { added: [] }, appliedAt: job.createdAt };
  return { repos, job, input };
}
it('commits memory, pending consumption and a replayable noop receipt together', async () => {
  const { repos, job, input } = await harness();
  const applied = await repos.memoryJobs.apply(input);
  expect(applied.receipt?.consumedTaskIds).toEqual(['old']);
  expect(JSON.parse((await repos.config.get(stateKey))!).pendingTurns).toEqual([{ taskId: 'new' }]);
  await repos.config.set(entriesKey, 'changed-after-commit');
  expect((await repos.memoryJobs.apply(input)).receipt).toEqual(applied.receipt);
  expect(await repos.config.get(entriesKey)).toBe('changed-after-commit');
  await repos.memoryJobs.update({ ...applied, state: 'settled' }, applied.revision);
  expect(await repos.memoryJobs.findUnsettled(scope)).toBeUndefined();
  expect(await repos.memoryJobs.hasClaim(scope,'claim')).toBe(true);
  expect(await repos.memoryJobs.hasClaim(scope,'unrelated-legacy-token')).toBe(false);
  expect((await repos.memoryJobs.listScope(scope))[0].id).toBe(job.id);
});
it.each(['claim', 'memory', 'ignore', 'config'])('rolls back all writes on changed %s', async kind => {
  const { repos, input, job } = await harness();
  if (kind === 'claim') await repos.config.set(stateKey, '{"running":{"token":"other"}}');
  if (kind === 'memory') await repos.config.set(entriesKey, 'new');
  if (kind === 'ignore') await repos.config.set('lark.memory.ignore.app.groups', 'new');
  if (kind === 'config') await repos.config.set('lark.bots', 'new');
  await expect(repos.memoryJobs.apply(input)).rejects.toMatchObject({ code: 'MEMORY_CONCURRENT_CHANGE' });
  expect((await repos.memoryJobs.get(scope, job.id))?.receipt).toBeUndefined();
  if (kind !== 'memory') expect(await repos.config.get(entriesKey)).toBeUndefined();
});
it('rejects missing guards, foreign config writes and unfrozen consumption', async () => {
  const { repos, input } = await harness();
  await expect(repos.memoryJobs.apply({ ...input, versions: [] })).rejects.toMatchObject({ code: 'MEMORY_JOB_CONFLICT' });
  await expect(repos.memoryJobs.apply({ ...input, writes: [{ key: 'lark.memory.other.groups', value: 'bad' }] })).rejects.toMatchObject({ code: 'MEMORY_SCOPE_INVALID' });
  await expect(repos.memoryJobs.apply({ ...input, consumedTaskIds: ['new'] })).rejects.toMatchObject({ code: 'MEMORY_JOB_CONFLICT' });
  expect(await repos.config.get('lark.memory.other.groups')).toBeUndefined();
});
it('enforces immutable inputs and process bot boundaries', async () => {
  const { repos, job } = await harness();
  await expect(repos.memoryJobs.update({ ...job, input: {} }, 0)).rejects.toMatchObject({ code: 'MEMORY_JOB_CONFLICT' });
  await repos.config.set('lark.bots', '[{"appId":"assigned"}]');
  await repos.config.set('dutydeck.bot_process', '{"version":1,"appId":"assigned"}');
  await expect(repos.memoryJobs.listScope(scope)).rejects.toMatchObject({ code: 'BOT_PROCESS_SCOPE' });
  await expect(repos.memoryJobs.create({ ...job, id: 'memory_' + 'c'.repeat(64) })).rejects.toMatchObject({ code: 'BOT_PROCESS_SCOPE' });
});
it('checks committed consumption inside the enqueue transaction, even with an earlier unconsumed read', async () => {
  const { repos,input } = await harness();
  expect(await repos.memoryJobs.isConsumed(scope,'old')).toBe(false);
  const oldState = await repos.config.get(stateKey);
  await repos.memoryJobs.apply(input);
  const committed = await repos.config.get(stateKey);
  expect(await repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'old',expectedState:oldState,state:'{"v":1,"pendingTurns":[{"taskId":"old"}]}' })).toBe('consumed');
  expect(await repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'old',expectedState:committed,state:'{"v":1,"pendingTurns":[{"taskId":"old"}]}' })).toBe('consumed');
  expect(await repos.config.get(stateKey)).toBe(committed);
});
it('preserves concurrent pending state and enforces the bot scope for atomic enqueue', async () => {
  const { repos } = await harness();
  const state = await repos.config.get(stateKey);
  expect(await repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'later',expectedState:'stale',state:'{"v":1,"pendingTurns":[{"taskId":"later"}]}' })).toBe('conflict');
  expect(await repos.config.get(stateKey)).toBe(state);
  const next = JSON.stringify({ ...JSON.parse(state!),pendingTurns:[{ taskId:'old' },{ taskId:'new' },{ taskId:'later' }] });
  expect(await repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'later',expectedState:state,state:next })).toBe('enqueued');
  expect(await repos.config.get(stateKey)).toBe(next);
  await repos.config.set('lark.bots','[{"appId":"assigned"}]');
  await repos.config.set('dutydeck.bot_process','{"version":1,"appId":"assigned"}');
  await expect(repos.memoryJobs.enqueuePendingTurn({ scope,taskId:'blocked',expectedState:next,state:'{}' })).rejects.toMatchObject({ code:'BOT_PROCESS_SCOPE' });
});

it('persists a receipt recovery claim before settling and rejects a stale recovery owner', async () => {
  const { repos,input } = await harness();
  const applied = await repos.memoryJobs.apply(input);
  await repos.config.set(stateKey,'{"v":1,"running":{"token":"recovery"}}');
  await expect(repos.memoryJobs.update({ ...applied,claimToken:'stale' },applied.revision)).rejects.toMatchObject({ code:'MEMORY_CLAIM_LOST' });
  const recovered = await repos.memoryJobs.update({ ...applied,claimToken:'recovery' },applied.revision);
  expect(recovered).toMatchObject({ state:'applied',claimToken:'recovery',receipt:applied.receipt });
  expect((await repos.memoryJobs.get(scope,applied.id))?.claimToken).toBe('recovery');
  await repos.memoryJobs.update({ ...recovered,state:'settled' },recovered.revision);
  expect(await repos.memoryJobs.hasClaim(scope,'recovery')).toBe(true);
  expect(await repos.memoryJobs.hasClaim(scope,'claim')).toBe(false);
});
