import { afterEach, expect, it } from 'vitest';
import { createRepositories } from './index.js';
const opened: ReturnType<typeof createRepositories>[] = [];
afterEach(() => { for (const repo of opened.splice(0)) repo.close(); });
async function bound(appId: string | null) {
  const repos = createRepositories(':memory:'); opened.push(repos);
  await repos.config.set('lark.bots', JSON.stringify(appId === null ? [] : [{ appId }]));
  await repos.config.set('dutydeck.bot_process', JSON.stringify({ version: 1, appId })); return repos;
}
it('rejects adding, replacing, removing or duplicating assigned bots through set and CAS', async () => {
  const repos = await bound('cli_a');
  for (const bots of [[], [{ appId: 'cli_b' }], [{ appId: 'cli_a' }, { appId: 'cli_b' }], [{ appId: 'cli_a' }, { appId: 'cli_a' }]]) {
    await expect(repos.config.set('lark.bots', JSON.stringify(bots))).rejects.toThrow('BOT_PROCESS_SCOPE');
    await expect(repos.config.compareAndSet!('lark.bots', await repos.config.get('lark.bots'), JSON.stringify(bots))).rejects.toThrow('BOT_PROCESS_SCOPE');
  }
  await expect(repos.config.set('dutydeck.bot_process', JSON.stringify({ version: 1, appId: 'cli_b' }))).rejects.toThrow('immutable');
  await expect(repos.config.set('lark.credentials', JSON.stringify({ appId: 'cli_b' }))).rejects.toThrow('BOT_PROCESS_SCOPE');
  await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_a', listening: false }]));
});
it('rejects bot creation in Web partitions and keeps unpartitioned config compatible', async () => {
  const web = await bound(null);
  await expect(web.config.set('lark.bots', '[{"appId":"cli_a"}]')).rejects.toThrow('BOT_PROCESS_SCOPE');
  const legacy = createRepositories(':memory:'); opened.push(legacy);
  await legacy.config.set('lark.bots', '[{"appId":"cli_a"},{"appId":"cli_b"}]');
});
it('guards structured bot creation and app binding edits', async () => {
  const repos = await bound('cli_a');
  await expect(repos.channelBots.create({ id: 'b', channel: 'lark', externalAppId: 'cli_b', displayName: 'B', brand: 'feishu', state: 'staged' })).rejects.toThrow('BOT_PROCESS_SCOPE');
  const bot = await repos.channelBots.create({ id: 'a', channel: 'lark', externalAppId: 'cli_a', displayName: 'A', brand: 'feishu', state: 'staged' });
  await expect(repos.channelBots.update(bot.id, { expectedRevision: bot.revision, externalAppId: 'cli_b' })).rejects.toThrow('BOT_PROCESS_SCOPE');
});
