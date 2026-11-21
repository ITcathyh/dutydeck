import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { turnDecisionKey, TurnRecoveryDecisions } from './recovery-decision.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function harness() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  cleanups.push(() => repos.close());
  const log = { warn: vi.fn() };
  const decisions = new TurnRecoveryDecisions(repos.config, repos.channelMappings, log);
  const row = { id: 'row', externalId: 'msg', sessionId: 'session', channel: 'lark-card:app', createdAt: new Date().toISOString() };
  const record = { app_id: 'app', chat_id: 'chat', prompt: 'text', task_name: 'task', state: 'interrupted', started_at: 1, turn: 1, runtime_task_id: 'task' };
  await repos.channelMappings.save({ ...row, extra: JSON.stringify(record) });
  const read = async () => JSON.parse((await repos.channelMappings.get(row.channel, row.externalId))!.extra!);
  return { decisions, repos, log, read, row, record };
}

it.each(['redispatch', 'relaunch', 'continue', 'settled'] as const)('reads historical %s decisions and atomically mirrors an update', async kind => {
  const { decisions, repos, read, log } = await harness();
  const key = turnDecisionKey(kind, 'app', 'msg', 1);
  const legacy = ['lark', kind, 'app.msg.1'].join('.');
  const before = JSON.stringify({ phase: 'held', code: 'fixture' });
  await repos.config.set(legacy, before);
  expect(await decisions.get(key)).toBe(before);
  const after = JSON.stringify({ phase: 'done', code: 'fixture' });
  expect(await decisions.compareAndSet(key, before, after)).toBe(true);
  expect(await repos.config.get(legacy)).toBe(after);
  expect((await read()).recovery).toMatchObject({ kind, decided_at: expect.any(Number), basis: 'fixture', values: { [kind]: JSON.parse(after) } });
  await repos.config.set(legacy, before);
  expect(await decisions.get(key)).toBe(after);
  expect(await decisions.get(key)).toBe(after);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(await decisions.compareAndSet(key, before, after)).toBe(false);
});

it('allows one concurrent claimant and fences a late write after the mapping advances', async () => {
  const { decisions, repos, read, row, record } = await harness();
  const kinds = ['redispatch', 'relaunch'] as const;
  const keys = kinds.map(kind => turnDecisionKey(kind, 'app', 'msg', 1));
  const claim = JSON.stringify({ phase: 'claimed', sessionId: 'session', runtimeTaskId: 'task' });
  const won = await Promise.all(keys.map(key => decisions.compareAndSet(key, undefined, claim)));
  expect(won.filter(Boolean)).toHaveLength(1);
  const winner = keys[won.indexOf(true)]!;
  expect((await read()).recovery.kind).toBe(winner.kind);
  expect(await repos.config.list!('lark.')).toHaveLength(1);
  await repos.channelMappings.save({ ...row, extra: JSON.stringify({ ...record, turn: 2 }) });
  expect(await decisions.compareAndSet(winner, claim, JSON.stringify({ phase: 'moved' }))).toBe(false);
  expect(await decisions.get(winner)).toBe(claim);
  expect(await read()).not.toHaveProperty('recovery');
});

it('protects a settlement awaiting its ledger receipt from a competing replay or relaunch', async () => {
  const { decisions, repos } = await harness();
  const settlement = turnDecisionKey('settled', 'app', 'msg', 1);
  expect(await decisions.compareAndSet(settlement, undefined, '{"code":"DRIVER_INPUT_UNCONFIRMED"}')).toBe(true);
  for (const kind of ['redispatch', 'relaunch'] as const) {
    expect(await decisions.compareAndSet(turnDecisionKey(kind, 'app', 'msg', 1), undefined, '{"phase":"claimed"}')).toBe(false);
  }
  expect(await repos.config.list!('lark.')).toHaveLength(1);
});
