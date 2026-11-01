import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { backfillBotPromptVersions, deleteLarkConfig, readLarkConfig, saveLarkConfig } from './config.js';
import { clearPendingPromptUsage, unrecordedPromptUsages, freezePromptUsage, pendingPromptUsageKey, botPromptUsageSchema, botPromptVersionSchema, promptHistory, promptHash, promptLineDiff, promptUsageSnapshot, recordPromptUsage } from './prompt-versions.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); });
function repos(path = ':memory:') {
  const value = createRepositories(path);
  cleanups.push(() => value.close());
  return value;
}
const seed = (store: ReturnType<typeof createRepositories>, text = '旧提示词') => store.config.set('lark.bots', JSON.stringify([
  { appId: 'app', appSecret: 'synthetic', preInjectPrompt: text, revision: 1 }
]));
it('backfills nonempty prompts once, preserves the baseline on first edit, and skips unchanged text', async () => {
  const r = repos(); await seed(r);
  await backfillBotPromptVersions(r.config); await backfillBotPromptVersions(r.config);
  expect(await promptHistory(r.config, 'app')).toMatchObject([{ version: 1, text: '旧提示词', source: 'backfill' }]);
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', preInjectPrompt: '新提示词' }, { source: 'web' });
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', preInjectPrompt: '新提示词' }, { source: 'cli' });
  expect(await promptHistory(r.config, 'app')).toMatchObject([
    { version: 1, text: '旧提示词', source: 'backfill' }, { version: 2, text: '新提示词', source: 'web', sha256: promptHash('新提示词') }
  ]);
  const second = repos(); await seed(second);
  await saveLarkConfig(second.config, undefined, { originalAppId: 'app', preInjectPrompt: 'new' });
  expect((await promptHistory(second.config, 'app')).map(v => v.source)).toEqual(['backfill', 'agent']);
});
it('versions clearing text but does not backfill an empty prompt', async () => {
  const r = repos(); await seed(r, '');
  await backfillBotPromptVersions(r.config);
  expect(await promptHistory(r.config, 'app')).toEqual([]);
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', preInjectPrompt: 'first' });
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', preInjectPrompt: '' });
  expect((await promptHistory(r.config, 'app')).map(v => v.text)).toEqual(['first', '']);
});
it('rollback appends even when selecting the current version and only versions the target bot', async () => {
  const r = repos(); await seed(r);
  await saveLarkConfig(r.config, undefined, { appId: 'other', appSecret: 'synthetic', preInjectPrompt: 'other' });
  await backfillBotPromptVersions(r.config);
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', preInjectPrompt: '旧提示词' }, { source: 'rollback', rollbackFrom: 1 });
  expect(await promptHistory(r.config, 'app')).toMatchObject([{ version: 1 }, { version: 2, source: 'rollback', rollbackFrom: 1 }]);
  expect(await promptHistory(r.config, 'other')).toHaveLength(1);
});
it('rejects stale edits without writing any version', async () => {
  const r = repos(); await seed(r); await backfillBotPromptVersions(r.config);
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', expectedRevision: 1, preInjectPrompt: 'winner' });
  await expect(saveLarkConfig(r.config, undefined, { originalAppId: 'app', expectedRevision: 1, preInjectPrompt: 'loser' })).rejects.toMatchObject({ code: 'LARK_CONFIG_REVISION_CONFLICT' });
  expect((await readLarkConfig(r.config, 'app'))?.preInjectPrompt).toBe('winner');
  expect((await promptHistory(r.config, 'app')).map(v => v.text)).toEqual(['旧提示词', 'winner']);
});
it('uses a single atomic CAS across two repository connections, leaving no orphan versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-versions-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const a = repos(join(dir, 'db')), b = repos(join(dir, 'db')); await seed(a);
  const results = await Promise.allSettled([a, b].map((r, index) => saveLarkConfig(r.config, undefined, {
    originalAppId: 'app', expectedRevision: 1, preInjectPrompt: String(index)
  })));
  expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(await promptHistory(a.config, 'app')).toHaveLength(2);
  expect((await promptHistory(a.config, 'app')).at(-1)?.text).toBe((await readLarkConfig(a.config, 'app'))?.preInjectPrompt);
  expect(await a.config.compareAndSetBatch!([{ key: 'lark.bots', expected: 'stale' }], [{ key: 'bot_prompt_version/orphan/1', value: '{}' }])).toBe(false);
  expect(await a.config.get('bot_prompt_version/orphan/1')).toBeUndefined();
});
it('freezes the used config and group revision and never overwrites a replayed usage', async () => {
  const r = repos(); await seed(r); await backfillBotPromptVersions(r.config);
  const snapshot = await promptUsageSnapshot(r.config, { taskId: 'task', appId: 'app', text: '旧提示词', configRevision: 1, groupInstructionsRevision: 7 });
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', preInjectPrompt: 'new' });
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', preInjectPrompt: '旧提示词' });
  expect(await promptUsageSnapshot(r.config, { taskId: 'task', appId: 'app', text: '旧提示词', configRevision: 1 })).toMatchObject({ botPromptVersion: 1 });
  await recordPromptUsage(r.config, snapshot);
  await recordPromptUsage(r.config, { ...snapshot, botPromptVersion: 3 });
  expect(JSON.parse((await r.config.get('bot_prompt_version/usage/task'))!)).toEqual({
    schemaVersion: 1, taskId: 'task', appId: 'app', botPromptVersion: 1, groupInstructionsRevision: 7
  });
});
it('provides line additions, deletions, unchanged lines and unchanged text', () => {
  expect(promptLineDiff('same\nold\nend', 'same\nnew\nend')).toBe('--- 原版本\n+++ 新版本\n same\n-old\n+new\n end');
  expect(promptLineDiff('', 'x')).toContain('+x');
  expect(promptLineDiff('x', '')).toContain('-x');
  expect(promptLineDiff('same', 'same')).toBe('无变化');
});
it('strictly validates stored versions and usage', () => {
  expect(botPromptVersionSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  expect(botPromptUsageSchema.safeParse({ schemaVersion: 1, appId: 'app', taskId: 'task', botPromptVersion: 1, extra: true }).success).toBe(false);
});

it('backfill preserves original config bytes, including invalid entries and malformed data', async () => {
  for (const raw of ['broken json', '{"not":"an array"}', '[{"appId":"app","appSecret":"synthetic","preInjectPrompt":"old","unknown":"preserve"},{}]']) {
    const r = repos(); await r.config.set('lark.bots', raw);
    await backfillBotPromptVersions(r.config);
    expect(await r.config.get('lark.bots')).toBe(raw);
  }
  const legacy = repos();
  const raw = JSON.stringify({ appId: 'app', appSecret: 'synthetic', preInjectPrompt: 'legacy' });
  await legacy.config.set('lark.credentials', raw);
  await backfillBotPromptVersions(legacy.config);
  expect(await legacy.config.get('lark.bots')).toBeUndefined();
  expect(await legacy.config.get('lark.credentials')).toBe(raw);
  expect(await promptHistory(legacy.config, 'app')).toMatchObject([{ version: 1, text: 'legacy' }]);
});
it('recovers usage from the frozen pre-dispatch record without reading current prompts', async () => {
  const r = repos(); await seed(r); await backfillBotPromptVersions(r.config);
  const candidate = await promptUsageSnapshot(r.config, { taskId: 'card', appId: 'app', text: '旧提示词', groupInstructionsRevision: 3 });
  const key = pendingPromptUsageKey('app', 'message', 1);
  await freezePromptUsage(r.config, key, candidate);
  // Model a crash after runtime acceptance and before writing task usage.
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', preInjectPrompt: 'new' });
  await expect(freezePromptUsage(r.config, key, { ...candidate, botPromptVersion: 2 })).rejects.toMatchObject({ code: 'PROMPT_USAGE_CONFLICT' });
  const recovered = await freezePromptUsage(r.config, key);
  expect(recovered).toEqual({ usage: candidate, created: false });
  await recordPromptUsage(r.config, { ...recovered!.usage, taskId: 'runtime-task' });
  expect(JSON.parse((await r.config.get('bot_prompt_version/usage/runtime-task'))!)).toMatchObject({ botPromptVersion: 1, groupInstructionsRevision: 3 });
  expect(await freezePromptUsage(r.config, pendingPromptUsageKey('app', 'legacy-message', 1))).toBeUndefined();
});

it('preserves history and resolves the new revision when the same app is removed and added again', async () => {
  const r = repos(); await seed(r); await backfillBotPromptVersions(r.config);
  await saveLarkConfig(r.config, undefined, { originalAppId: 'app', preInjectPrompt: 'latest' });
  await deleteLarkConfig(r.config, 'app');
  const [bot] = await saveLarkConfig(r.config, undefined, { appId: 'app', appSecret: 'synthetic', preInjectPrompt: 'latest' }, { source: 'web' });
  expect(bot?.revision).toBe(1);
  expect(await promptHistory(r.config, 'app')).toHaveLength(3);
  expect(await promptUsageSnapshot(r.config, { taskId: 'task', appId: 'app', text: 'latest', configRevision: bot?.revision })).toMatchObject({ botPromptVersion: 3 });
});

it('keeps an unversioned nonempty prompt unknown rather than reporting empty version zero', async () => {
  const r = repos(); await seed(r);
  const snapshot = await promptUsageSnapshot(r.config, { taskId: 'unknown', appId: 'app', text: '未经过版本保存的提示词' });
  expect(snapshot.botPromptVersion).toBeUndefined();
  await recordPromptUsage(r.config, snapshot);
  const stored = JSON.parse((await r.config.get('bot_prompt_version/usage/unknown'))!);
  expect(stored).not.toHaveProperty('botPromptVersion');
  expect(await unrecordedPromptUsages(r.config, 'app')).toEqual([{ taskId: 'unknown', label: '未记录版本' }]);
  const empty = await promptUsageSnapshot(r.config, { taskId: 'empty', appId: 'app', text: '' });
  expect(empty.botPromptVersion).toBe(0);
  await recordPromptUsage(r.config, empty);
  expect(await unrecordedPromptUsages(r.config, 'app')).toHaveLength(1);
});
it('cleans a matching pending snapshot and safely skips a later resume when it is absent', async () => {
  const r = repos();
  const snapshot = { schemaVersion: 1 as const, taskId: 'card', appId: 'app', botPromptVersion: 2 };
  const key = pendingPromptUsageKey('app', 'message', 1);
  expect(await freezePromptUsage(r.config, key, snapshot)).toEqual({ usage: snapshot, created: true });
  await recordPromptUsage(r.config, { ...snapshot, taskId: 'runtime-task' });
  await clearPendingPromptUsage(r.config, key, snapshot);
  expect(await r.config.get(key)).toBeUndefined();
  expect(await freezePromptUsage(r.config, key)).toBeUndefined();
  expect(JSON.parse((await r.config.get('bot_prompt_version/usage/runtime-task'))!)).toMatchObject({ botPromptVersion: 2 });
  // 不可删除另一份准备快照，也不可删除正式使用记录。
  await freezePromptUsage(r.config, key, { ...snapshot, botPromptVersion: 3 });
  await clearPendingPromptUsage(r.config, key, snapshot);
  expect(await r.config.get(key)).toBeDefined();
});
