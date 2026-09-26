// 每轮任务的记忆记录：注入了哪些（派发时记下）、新记下了哪些（按条目 taskId 反查）。
import { describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { larkMemoryLimits, larkMemoryScope, LarkMemoryStore, type LarkMemoryEntry } from './memory.js';
import { renderMemoryIndex } from './memory-view.js';

const groups = larkMemoryScope('cli_bot', 'oc_group', 'group');
const state = { v: 1 as const, turnsSinceExtraction: 0, turnsSinceConsolidation: 0 };

const store = () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let counter = 0;
  return { repos, memory: new LarkMemoryStore(repos.config, { newId: () => `mem_${(counter++).toString(16).padStart(8, '0')}` }) };
};

const entry = (id: string, content: string, patch: Partial<LarkMemoryEntry> = {}): LarkMemoryEntry => ({
  id, content, source: 'extraction', topic: 'general', createdAt: '2026-09-25T00:00:00.000Z', ...patch
});

describe('renderMemoryIndex ids', () => {
  it('returns exactly the own-pool entries listed in the index, never peer entries', () => {
    const entries = [entry('mem_0000000a', '第一条'), entry('mem_0000000b', '第二条', { topic: 'conventions' })];
    const peer = [{ botName: 'Peer', entry: entry('mem_0000000c', '对端的偏好', { topic: 'conventions' }) }];
    expect(renderMemoryIndex(entries, state, { sharedEntries: peer }).ids.sort()).toEqual(['mem_0000000a', 'mem_0000000b']);
    // 超预算时被省略的那条不算注入。
    const tight = renderMemoryIndex([...entries, entry('mem_0000000d', '长'.repeat(150), { createdAt: '2026-09-24T00:00:00.000Z' })], state, { budget: 260 });
    expect(tight.omitted).toBe(1);
    expect(tight.ids.sort()).toEqual(['mem_0000000a', 'mem_0000000b']);
    expect(tight.text).not.toContain('mem_0000000d');
    expect(renderMemoryIndex([], state, { sharedEntries: peer }).ids).toEqual([]);
  });
});

describe('turn records', () => {
  it('lists what a turn used (including later deletions) and what it wrote', async () => {
    const { memory } = store();
    const used = await memory.add(groups, { content: '回复统一用中文', source: 'user', chatId: 'oc_group' });
    const gone = await memory.add(groups, { content: '发布前先跑测试', source: 'user', chatId: 'oc_group' });
    await memory.recordTurn(groups, { taskId: 'task_1', sessionId: 'ses_1', injected: [used.id, gone.id, used.id] });
    const written = await memory.add(groups, { content: '部署脚本在 scripts/deploy.sh', source: 'extraction', taskId: 'task_1', chatId: 'oc_group' });
    await memory.add(groups, { content: '别的任务记下的', source: 'extraction', taskId: 'task_2', chatId: 'oc_group' });
    await memory.remove(groups, gone.id, 'ou_alice');

    const view = await memory.turn('ses_1', 'task_1');
    expect(view).toMatchObject({ shared: true, scope: groups, record: { taskId: 'task_1', sessionId: 'ses_1', appId: 'cli_bot', chatId: 'oc_group', pool: 'groups', injected: [used.id, gone.id] } });
    expect(view!.injected.map(item => [item.id, Boolean(item.deletedAt)])).toEqual([[used.id, false], [gone.id, true]]);
    expect(view!.written.map(item => item.id)).toEqual([written.id]);
    expect(await memory.turn('ses_1', 'task_missing')).toBeUndefined();
  });

  it('keeps one row per session with only the most recent turns, so the records stop growing with the task count', async () => {
    const { repos, memory } = store();
    const limit = larkMemoryLimits.turnsPerSession;
    for (let index = 0; index < limit + 5; index++) await memory.recordTurn(groups, { taskId: `task_${index}`, sessionId: 'ses_1', injected: [] });
    await memory.recordTurn(groups, { taskId: 'task_other', sessionId: 'ses_2', injected: [] });
    // 同一轮重记替换原记录，不追加。
    await memory.recordTurn(groups, { taskId: `task_${limit + 4}`, sessionId: 'ses_1', injected: [] });
    expect((await repos.config.list!('lark.memory.turn')).map(row => row.key)).toEqual(['lark.memory.turns.ses_1', 'lark.memory.turns.ses_2']);
    expect((await memory.turns('ses_1')).map(view => view.record.taskId)).toEqual(Array.from({ length: limit }, (_, index) => `task_${limit + 4 - index}`));
    expect(await memory.turn('ses_1', 'task_4')).toBeUndefined();
    // 只在本会话那一行里找：别的会话的轮次不会串过来。
    expect(await memory.turn('ses_1', 'task_other')).toBeUndefined();
    expect((await memory.turn('ses_2', 'task_other'))?.record.sessionId).toBe('ses_2');
  });

  it('overwrites a corrupt row on the next turn instead of failing every dispatch', async () => {
    const { repos, memory } = store();
    await repos.config.set('lark.memory.turns.ses_1', 'not json');
    expect(await memory.turns('ses_1')).toEqual([]);
    await memory.recordTurn(groups, { taskId: 'task_1', sessionId: 'ses_1', injected: [] });
    expect((await memory.turns('ses_1')).map(view => view.record.taskId)).toEqual(['task_1']);
  });
});
