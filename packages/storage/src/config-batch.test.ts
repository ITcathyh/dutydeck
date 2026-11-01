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
