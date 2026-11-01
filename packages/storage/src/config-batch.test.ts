import { afterEach, expect, it } from 'vitest';
import { createRepositories } from './index.js';
const stores: ReturnType<typeof createRepositories>[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); });
function setup() { const repos = createRepositories(':memory:'); stores.push(repos); return repos.config; }
it('checks every expected value before applying any writes and rejects an occupied immutable key', async () => {
  const config = setup(); await config.set('lark.bots', 'original'); await config.set('bot_prompt_version/app/1', 'immutable');
  expect(await config.compareAndSetBatch!([{ key: 'lark.bots', expected: 'original' }, { key: 'bot_prompt_version/app/1', expected: undefined }],
    [{ key: 'lark.bots', value: 'changed' }, { key: 'bot_prompt_version/app/1', value: 'overwrite' }])).toBe(false);
  expect(await config.get('lark.bots')).toBe('original');
  expect(await config.get('bot_prompt_version/app/1')).toBe('immutable');
});
it('rolls back a combined write that would bypass the bot process guard', async () => {
  const config = setup(); await config.set('lark.bots', '[]');
  await expect(config.compareAndSetBatch!([], [
    { key: 'dutydeck.bot_process', value: JSON.stringify({ version: 1, appId: null }) },
    { key: 'lark.bots', value: JSON.stringify([{ appId: 'other' }]) }
  ])).rejects.toMatchObject({ code: 'BOT_PROCESS_SCOPE' });
  expect(await config.get('dutydeck.bot_process')).toBeUndefined();
  expect(await config.get('lark.bots')).toBe('[]');
});
it('preserves the execution ledger write boundary in a batch', async () => {
  const config = setup();
  await expect(config.compareAndSetBatch!([], [
    { key: 'bot_prompt_version/app/1', value: 'orphan' }, { key: 'runtime_native_context:session', value: '{}' }
  ])).rejects.toMatchObject({ code: 'EXECUTION_WRITE_REQUIRES_LEDGER' });
  expect(await config.get('bot_prompt_version/app/1')).toBeUndefined();
});

it('only allows compare-and-delete of prompt preparations, preserving versions and usages', async () => {
  const config = setup();
  const key = 'bot_prompt_version/pending/app/message/1';
  const value = JSON.stringify({ schemaVersion: 1, taskId: 'task', appId: 'app' });
  await config.set(key, value);
  expect(await config.remove!(key, '{}')).toBe(false);
  expect(await config.get(key)).toBe(value);
  expect(await config.remove!(key, value)).toBe(true);
  expect(await config.remove!(key, value)).toBe(false);
  for (const protectedKey of ['bot_prompt_version/app/1', 'bot_prompt_version/usage/task']) {
    await config.set(protectedKey, value);
    await expect(config.remove!(protectedKey, value)).rejects.toMatchObject({ code: 'CONFIG_DELETE_NOT_SUPPORTED' });
    expect(await config.get(protectedKey)).toBe(value);
  }
});


const recoveredWatch = () => ({
  schemaVersion: 1, appId: 'cli_watch', fingerprint: 'a'.repeat(64), kind: 'result_delivery', objectId: 'message',
  title: '结果投递失败', since: '2026-11-01T01:00:00.000Z', location: 'dutydeck doctor',
  firstSeenAt: '2026-11-01T01:00:00.000Z', lastSeenAt: '2026-11-01T01:00:00.000Z', episode: 1, recoveredAt: '2026-11-01T02:00:00.000Z'
});
it('only permits strict recovered watch records and checks their key before CAS deletion', async () => {
  const config = setup(); const finding = recoveredWatch(); const key = 'watch_findings/cli_watch/' + finding.fingerprint;
  const raw = JSON.stringify(finding, null, 2);
  await config.set(key, raw);
  expect(await config.remove!(key, JSON.stringify(finding))).toBe(false);
  expect(await config.get(key)).toBe(raw);
  expect(await config.remove!(key, raw)).toBe(true);
  for (const record of [{ ...finding, recoveredAt: undefined }, { ...finding, schemaVersion: 2 },
    { ...finding, unexpected: true }, { ...finding, appId: 'cli_other' }, { ...finding, recoveredAt: 'yesterday' }, {}, '{invalid']) {
    const value = typeof record === 'string' ? record : JSON.stringify(record);
    await config.set(key, value);
    await expect(config.remove!(key, value)).rejects.toMatchObject({ code: 'CONFIG_DELETE_NOT_SUPPORTED' });
    expect(await config.get(key)).toBe(value);
  }
  const aliasKey = 'watch_findings/cli_watch/nested/notification';
  const aliasValue = JSON.stringify({ ...finding, fingerprint: 'nested/notification' });
  await config.set(aliasKey, aliasValue);
  await expect(config.remove!(aliasKey, aliasValue)).rejects.toMatchObject({ code: 'CONFIG_DELETE_NOT_SUPPORTED' });
  expect(await config.get(aliasKey)).toBe(aliasValue);
  const notification = 'watch_findings/cli_watch/notification';
  for (const value of ['{}', JSON.stringify({ ...finding, fingerprint: 'notification' })]) {
    await config.set(notification, value);
    await expect(config.remove!(notification, value)).rejects.toMatchObject({ code: 'CONFIG_DELETE_NOT_SUPPORTED' });
    expect(await config.get(notification)).toBe(value);
  }
});
it('protects recovered findings referenced by a pending notification and rejects stale values after recurrence', async () => {
  const config = setup(); const finding = recoveredWatch(); const key = 'watch_findings/cli_watch/' + finding.fingerprint;
  const raw = JSON.stringify(finding);
  await config.set(key, raw);
  const notificationKey = 'watch_findings/cli_watch/notification';
  const notification = { schemaVersion: 1, idempotencyKey: 'watch_pending', ownerId: 'ou_owner', text: '待发送通知',
    status: 'pending', members: [{ fingerprint: finding.fingerprint, episode: 1 }] };
  await config.set(notificationKey, JSON.stringify(notification));
  expect(await config.remove!(key, raw)).toBe(false);
  expect(await config.get(key)).toBe(raw);
  await config.set(notificationKey, JSON.stringify({ ...notification, status: 'completed' }));
  const reappeared = JSON.stringify({ ...finding, recoveredAt: undefined, episode: 2 });
  await config.set(key, reappeared);
  expect(await config.remove!(key, raw)).toBe(false);
  expect(await config.get(key)).toBe(reappeared);
  await config.set(key, raw);
  expect(await config.remove!(key, raw)).toBe(true);
  expect(await config.get(notificationKey)).toBe(JSON.stringify({ ...notification, status: 'completed' }));
});
