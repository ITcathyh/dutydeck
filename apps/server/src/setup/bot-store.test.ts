import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { readLarkConfig } from '../lark/config.js';
import { readBot, saveBot } from './bot-store.js';

/** 真实 SQLite，但只在临时目录里；HOME、daemon 记录都不碰。 */
const dirs: string[] = [];
function tempDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-bot-store-'));
  dirs.push(dir);
  return join(dir, '.dutydeck', 'dutydeck.db');
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function stored(database: string, appId: string) {
  const repositories = createRepositories(database);
  try { return await readLarkConfig(repositories.config, appId); } finally { repositories.close(); }
}

const known = [{ id: 'claude' }, { id: 'codex' }];

describe('setup 的机器人配置落点', () => {
  it('新建机器人：App Secret、默认 Agent、工作目录写进 lark.bots，权限模式为只读自动放行', async () => {
    const database = tempDatabase();
    const result = await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', workspace: '/work/project', knownAgents: known });
    expect(result).toEqual({ existed: false, changed: true, hasSecret: true, defaultAgentId: 'claude', listening: false });
    const bot = await stored(database, 'cli_a');
    expect(bot).toMatchObject({ appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', workspace: '/work/project', permissionMode: 'approve-reads', listening: false });
  });

  it('新建机器人的权限模式：Agent 支持飞书审批时为 ask，不支持时退回只读自动放行（不替用户开完全信任）', async () => {
    const agents = [
      { id: 'acp', protocol: 'acp' as const },
      { id: 'claude-pty', protocol: 'pty-cli' as const, adapterId: 'claude-code' },
      { id: 'other-pty', protocol: 'pty-cli' as const, adapterId: 'codex' }
    ];
    for (const [agentId, mode] of [['acp', 'ask'], ['claude-pty', 'ask'], ['other-pty', 'approve-reads']] as const) {
      const database = tempDatabase();
      await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: agentId, knownAgents: agents });
      expect((await stored(database, 'cli_a'))?.permissionMode).toBe(mode);
    }
  });

  it('重复保存同样的内容是空操作，不增加 revision', async () => {
    const database = tempDatabase();
    const input = { database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', workspace: '/work/project', knownAgents: known };
    await saveBot(input);
    const before = await stored(database, 'cli_a');
    const again = await saveBot(input);
    expect(again.changed).toBe(false);
    expect((await stored(database, 'cli_a'))!.revision).toBe(before!.revision);
  });

  it('只换默认 Agent：保留已有 Secret 与工作目录', async () => {
    const database = tempDatabase();
    await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', workspace: '/work/project', knownAgents: known });
    const result = await saveBot({ database, appId: 'cli_a', defaultAgentId: 'codex', workspace: '/somewhere/else', knownAgents: known });
    expect(result).toMatchObject({ existed: true, changed: true, defaultAgentId: 'codex' });
    expect(await stored(database, 'cli_a')).toMatchObject({ appSecret: 'secret-a', defaultAgentId: 'codex', workspace: '/work/project' });
  });

  it('--listen 只在需要时打开监听', async () => {
    const database = tempDatabase();
    await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', listen: true, knownAgents: known });
    expect((await stored(database, 'cli_a'))!.listening).toBe(true);
  });

  it('默认 Agent 不在已检测列表里时拒绝', async () => {
    const database = tempDatabase();
    await expect(saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'ghost', knownAgents: known })).rejects.toThrow(/Unknown default Agent: ghost/);
    expect(await stored(database, 'cli_a')).toBeUndefined();
  });

  it('没有 Secret 就不新建机器人', async () => {
    const database = tempDatabase();
    await expect(saveBot({ database, appId: 'cli_a', defaultAgentId: 'claude', knownAgents: known })).rejects.toThrow(/App Secret/);
  });

  it('readBot：库不存在时返回 undefined 且不创建库；存在时返回已保存的状态', async () => {
    const database = tempDatabase();
    expect(await readBot(database, 'cli_a')).toBeUndefined();
    expect(existsSync(database)).toBe(false);
    await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', knownAgents: known });
    expect(await readBot(database, 'cli_a')).toEqual({ appSecret: 'secret-a', defaultAgentId: 'claude', listening: false });
    expect(await readBot(database, 'cli_other')).toBeUndefined();
  });
});
