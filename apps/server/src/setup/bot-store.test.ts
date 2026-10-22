import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { readLarkConfig, saveLarkConfig } from '../lark/config.js';
import { detectAgents } from './detect.js';
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

const known = [{ id: 'claude', protocol: 'acp' as const }, { id: 'codex', protocol: 'acp' as const }];

describe('setup 的机器人配置落点', () => {
  it('新建机器人：App Secret、默认 Agent、工作目录写进 lark.bots，权限模式为逐项审批', async () => {
    const database = tempDatabase();
    const result = await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', workspace: '/work/project', knownAgents: known });
    expect(result).toEqual({ existed: false, changed: true, hasSecret: true, defaultAgentId: 'claude', listening: false });
    const bot = await stored(database, 'cli_a');
    expect(bot).toMatchObject({ appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', workspace: '/work/project', permissionMode: 'ask', listening: false });
  });

  it('新建机器人的权限模式：ACP 与支持审批的终端 Agent 均为 ask', async () => {
    const agents = [
      { id: 'acp', protocol: 'acp' as const },
      { id: 'claude-pty', protocol: 'pty-cli' as const, adapterId: 'claude-code' }
    ];
    for (const agentId of ['acp', 'claude-pty']) {
      const database = tempDatabase();
      await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: agentId, knownAgents: agents });
      expect((await stored(database, 'cli_a'))?.permissionMode).toBe('ask');
    }
  });

  it('探测到的 Claude 终端适配器能力可直接用于首次保存', async () => {
    const database = tempDatabase();
    const agents = detectAgents({ scan: () => [{ id: 'claude', name: 'Claude Code', command: 'claude', args: [], protocol: 'pty-cli', adapterId: 'claude-code', env: {}, permissionMode: 'ask', timeout: 600, capabilities: { pause: false, resume: true } }] });
    await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', knownAgents: agents });
    expect(await stored(database, 'cli_a')).toMatchObject({ defaultAgentId: 'claude', permissionMode: 'ask' });
  });

  it('不支持审批的新建机器人明确失败并给出修法，不写入不可运行的配置', async () => {
    const database = tempDatabase();
    await expect(saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'codex-cli', listen: true, knownAgents: [{ id: 'codex-cli', protocol: 'pty-cli', adapterId: 'codex' }] }))
      .rejects.toMatchObject({ code: 'LARK_APPROVAL_UNSUPPORTED', next: 'dutydeck setup --lark-app-id cli_a --agent <id>', message: expect.stringContaining('请选择支持审批的 Agent') });
    expect(await stored(database, 'cli_a')).toBeUndefined();
  });

  it('没有默认 Agent 时仍可保存凭据，保留 ask 且不替用户选 Agent', async () => {
    const database = tempDatabase();
    await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', knownAgents: [] });
    const bot = await stored(database, 'cli_a');
    expect(bot).toMatchObject({ permissionMode: 'ask', listening: false });
    expect(bot?.defaultAgentId).toBeUndefined();
  });

  it.each(['ask', 'approve-reads'] as const)('%s 机器人拒绝不支持审批的默认 Agent，保留全部原状态', async permissionMode => {
    const database = tempDatabase();
    await saveBot({ database, appId: 'cli_a', appSecret: 'secret-a', defaultAgentId: 'claude', workspace: '/work/project', knownAgents: known });
    const repositories = createRepositories(database);
    try {
      const current = await readLarkConfig(repositories.config, 'cli_a');
      await saveLarkConfig(repositories.config, undefined, { originalAppId: 'cli_a', expectedRevision: current!.revision, permissionMode });
    } finally { repositories.close(); }
    const before = await stored(database, 'cli_a');
    await expect(saveBot({ database, appId: 'cli_a', appSecret: 'secret-new', defaultAgentId: 'codex-cli', listen: true, workspace: '/another/project', knownAgents: [...known, { id: 'codex-cli', protocol: 'pty-cli', adapterId: 'codex' }] }))
      .rejects.toMatchObject({ code: 'LARK_APPROVAL_UNSUPPORTED' });
    expect(await stored(database, 'cli_a')).toEqual(before);
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
