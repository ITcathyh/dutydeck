import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import {
  isLarkMemoryId,
  LarkMemoryError,
  larkMemoryKey,
  larkMemoryLimits,
  larkMemoryStateKey,
  LarkMemoryStore,
  larkMemoryToolsPrompt,
  normalizeLarkMemoryTopic,
  renderLarkMemoryList,
  type LarkMemoryEntry,
  type LarkMemoryState
} from './memory.js';

const scope = { appId: 'cli_bot', chatId: 'oc_group' };

const store = (options: { now?: () => Date; ids?: string[]; onChange?: (scope: any) => unknown } = {}) => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const ids = [...(options.ids ?? [])];
  let counter = 0;
  const memory = new LarkMemoryStore(repos.config, {
    now: options.now,
    newId: () => ids.shift() ?? `mem_${(counter++).toString(16).padStart(8, '0')}`,
    onChange: options.onChange
  });
  return { repos, memory };
};

describe('normalizeLarkMemoryTopic', () => {
  it('defaults to general for empty inputs', () => {
    expect(normalizeLarkMemoryTopic(undefined)).toBe('general');
    expect(normalizeLarkMemoryTopic(null)).toBe('general');
    expect(normalizeLarkMemoryTopic('')).toBe('general');
    expect(normalizeLarkMemoryTopic('   ')).toBe('general');
  });

  it('corrects casing, spaces, illegal characters and leading hyphens', () => {
    expect(normalizeLarkMemoryTopic('GENERAL')).toBe('general');
    expect(normalizeLarkMemoryTopic('my topic')).toBe('my-topic');
    expect(normalizeLarkMemoryTopic('  --leading-hyphens  ')).toBe('leading-hyphens');
    expect(normalizeLarkMemoryTopic('__leading_under')).toBe('leading_under');
    expect(normalizeLarkMemoryTopic('hello!world@123')).toBe('hello-world-123');
    expect(normalizeLarkMemoryTopic('a'.repeat(40))).toBe('a'.repeat(32));
  });

  it('rejects completely invalid inputs and non-strings', () => {
    expect(() => normalizeLarkMemoryTopic(123)).toThrow(LarkMemoryError);
    expect(() => normalizeLarkMemoryTopic({})).toThrow(LarkMemoryError);
    expect(() => normalizeLarkMemoryTopic('---')).toThrow(LarkMemoryError);
    expect(() => normalizeLarkMemoryTopic('___')).toThrow(LarkMemoryError);
    expect(() => normalizeLarkMemoryTopic('中文主题')).toThrow(LarkMemoryError);
  });
});

describe('LarkMemoryStore', () => {
  it('saves with default topic, lists in insertion order and isolates chats and bots', async () => {
    const { repos, memory } = store();
    const first = await memory.add(scope, { content: '回复统一用中文', source: 'user', createdBy: 'ou_alice', messageId: 'om_1' });
    const second = await memory.add(scope, { content: '项目用 pnpm', source: 'agent', topic: 'conventions', sessionId: 'ses_1', createdBy: 'ou_alice' });
    expect(isLarkMemoryId(first.id)).toBe(true);
    expect(first.topic).toBe('general');
    expect(second.topic).toBe('conventions');
    expect(await memory.list(scope)).toEqual([first, second]);
    expect(await memory.list({ appId: 'cli_bot', chatId: 'oc_other' })).toEqual([]);
    expect(await memory.list({ appId: 'cli_other', chatId: 'oc_group' })).toEqual([]);
    repos.close();
  });

  it('handles supersedes chain and rejects invalid supersede targets', async () => {
    const onChange = vi.fn();
    const { repos, memory } = store({ onChange });
    const a = await memory.add(scope, { content: '约定A', source: 'agent', topic: 'conventions' });
    const b = await memory.add(scope, { content: '约定B', source: 'agent', topic: 'conventions' });

    await expect(memory.add(scope, {
      content: '合并约定',
      source: 'consolidation',
      supersedes: [a.id, 'mem_nonexist']
    })).rejects.toMatchObject({ code: 'MEMORY_SUPERSEDE_TARGET_INVALID', statusCode: 400 });

    const c = await memory.add(scope, {
      content: '合并约定AB',
      source: 'consolidation',
      supersedes: [a.id, b.id]
    });
    expect(c.supersedes).toEqual([a.id, b.id]);

    const live = await memory.list(scope);
    expect(live).toEqual([c]);

    const all = await memory.listAll(scope);
    expect(all).toHaveLength(3);
    const updatedA = all.find(e => e.id === a.id)!;
    const updatedB = all.find(e => e.id === b.id)!;
    expect(updatedA.supersededBy).toBe(c.id);
    expect(updatedA.deletedAt).toBeDefined();
    expect(updatedA.deletedBy).toBe('consolidation');
    expect(updatedB.supersededBy).toBe(c.id);

    // 已被替换的条目再次替换会抛出无效错误
    await expect(memory.add(scope, { content: '再次合并', source: 'consolidation', supersedes: [a.id] }))
      .rejects.toMatchObject({ code: 'MEMORY_SUPERSEDE_TARGET_INVALID' });

    expect(onChange).toHaveBeenCalled();
    repos.close();
  });

  it('retopics entries and triggers onChange', async () => {
    const onChange = vi.fn();
    const { repos, memory } = store({ onChange });
    const entry = await memory.add(scope, { content: '测试约定', source: 'user' });
    expect(entry.topic).toBe('general');

    const updated = await memory.retopic(scope, entry.id, 'testing');
    expect(updated).toMatchObject({ id: entry.id, topic: 'testing' });
    expect((await memory.list(scope))[0]?.topic).toBe('testing');

    expect(await memory.retopic(scope, 'mem_deadbeef', 'new-topic')).toBeUndefined();
    repos.close();
  });

  it('searches entries with case-insensitivity, topic filtering and limit clamping', async () => {
    const { repos, memory } = store();
    await memory.add(scope, { content: 'Frontend uses React', source: 'agent', topic: 'frontend' });
    await memory.add(scope, { content: 'Backend uses Node', source: 'agent', topic: 'backend' });
    await memory.add(scope, { content: 'React native for mobile', source: 'agent', topic: 'mobile' });

    await expect(memory.search(scope, { query: '   ' })).rejects.toMatchObject({ code: 'MEMORY_QUERY_REQUIRED' });

    const allReact = await memory.search(scope, { query: 'react' });
    expect(allReact).toHaveLength(2);
    expect(allReact.map(e => e.topic)).toEqual(['mobile', 'frontend']); // 降序

    const frontendReact = await memory.search(scope, { query: 'react', topic: 'frontend' });
    expect(frontendReact).toHaveLength(1);
    expect(frontendReact[0]!.content).toBe('Frontend uses React');

    const clamped = await memory.search(scope, { query: 'uses', limit: 1 });
    expect(clamped).toHaveLength(1);

    repos.close();
  });

  it('groups entries by topic in appearance order, with entries sorted by createdAt ascending', async () => {
    let time = 0;
    const { repos, memory } = store({ now: () => new Date(Date.UTC(2026, 8, 17, 0, 0, time++)) });
    await memory.add(scope, { content: 'A1', source: 'agent', topic: 'topic-a' });
    await memory.add(scope, { content: 'B1', source: 'agent', topic: 'topic-b' });
    await memory.add(scope, { content: 'A2', source: 'agent', topic: 'topic-a' });

    const map = await memory.byTopic(scope);
    expect([...map.keys()]).toEqual(['topic-a', 'topic-b']);
    expect(map.get('topic-a')!.map(e => e.content)).toEqual(['A1', 'A2']);
    expect(map.get('topic-b')!.map(e => e.content)).toEqual(['B1']);
    repos.close();
  });

  it('reads legacy records without topic as general without mutating storage', async () => {
    const { repos, memory } = store();
    const rawLegacy = JSON.stringify({
      v: 1,
      entries: [
        { id: 'mem_00000001', content: '旧记忆没有 topic', source: 'user', createdAt: '2026-09-17T00:00:00.000Z' }
      ]
    });
    await repos.config.set(larkMemoryKey(scope), rawLegacy);

    const live = await memory.list(scope);
    expect(live).toHaveLength(1);
    expect(live[0]!.topic).toBe('general');

    // 不改写存储
    expect(await repos.config.get(larkMemoryKey(scope))).toBe(rawLegacy);
    repos.close();
  });

  it('manages state with defaults, CAS merges and field deletions', async () => {
    const { repos, memory } = store();
    const initial = await memory.getState(scope);
    expect(initial).toEqual({ v: 1, turnsSinceExtraction: 0, turnsSinceConsolidation: 0 });

    const updated = await memory.updateState(scope, {
      turnsSinceExtraction: 3,
      indexOverBudget: true,
      lastExtractionAt: '2026-09-17T10:00:00.000Z'
    });
    expect(updated).toMatchObject({
      v: 1,
      turnsSinceExtraction: 3,
      turnsSinceConsolidation: 0,
      indexOverBudget: true,
      lastExtractionAt: '2026-09-17T10:00:00.000Z'
    });

    const deleted = await memory.updateState(scope, {
      indexOverBudget: undefined
    });
    expect(deleted.indexOverBudget).toBeUndefined();
    expect(deleted.turnsSinceExtraction).toBe(3);

    const storedRaw = await repos.config.get(larkMemoryStateKey(scope));
    expect(JSON.parse(storedRaw!).indexOverBudget).toBeUndefined();
    repos.close();
  });

  it('tombstones removed entries and prunes oldest tombstones', async () => {
    let tick = 0;
    const { repos, memory } = store({ now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)) });
    const created: LarkMemoryEntry[] = [];
    for (let index = 0; index < larkMemoryLimits.liveEntries; index++) {
      created.push(await memory.add(scope, { content: `事实 ${index}`, source: 'agent' }));
    }
    await expect(memory.add(scope, { content: '再来一条', source: 'user' })).rejects.toMatchObject({ code: 'MEMORY_LIMIT_REACHED', statusCode: 409 });

    for (const entry of created.slice(0, larkMemoryLimits.tombstones + 5)) {
      await memory.remove(scope, entry.id);
    }
    const all = await memory.listAll(scope);
    const tombstones = all.filter(entry => entry.deletedAt);
    expect(tombstones).toHaveLength(larkMemoryLimits.tombstones);
    expect(tombstones.map(e => e.id)).not.toContain(created[0]!.id);
    expect(tombstones.map(e => e.id)).toContain(created[larkMemoryLimits.tombstones + 4]!.id);
    repos.close();
  });
});

describe('renderLarkMemoryList', () => {
  const dummyState: LarkMemoryState = {
    v: 1,
    turnsSinceExtraction: 0,
    turnsSinceConsolidation: 0,
    lastConsolidationAt: '2026-09-17T12:30:00.000Z'
  };

  const makeEntry = (id: string, topic: string, content: string, source: LarkMemoryEntry['source'] = 'user'): LarkMemoryEntry => ({
    id,
    topic,
    content,
    source,
    createdAt: '2026-09-17T08:00:00.000Z'
  });

  it('renders empty receipt when no memories exist', () => {
    const result = renderLarkMemoryList(new Map(), dummyState);
    expect(result.text).toContain('还没有保存的记忆');
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
  });

  it('paginates by topic up to 6 topics per page', () => {
    const byTopic = new Map<string, LarkMemoryEntry[]>();
    for (let i = 1; i <= 8; i++) {
      byTopic.set(`topic-${i}`, [makeEntry(`mem_${i}`, `topic-${i}`, `条目内容 ${i}`)]);
    }

    const page1 = renderLarkMemoryList(byTopic, dummyState, { page: 1, pageSize: 6 });
    expect(page1.totalPages).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.text).toContain('共 8 条记忆 · 上次整理 2026-09-17 12:30');
    expect(page1.text).toContain('**topic-1（1 条）**');
    expect(page1.text).toContain('**topic-6（1 条）**');
    expect(page1.text).not.toContain('**topic-7');
    expect(page1.text).toContain('第 1/2 页；翻页 /memory <页码>；删除 /forget <编号>；新增 /remember <内容>');

    const page2 = renderLarkMemoryList(byTopic, dummyState, { page: 2, pageSize: 6 });
    expect(page2.page).toBe(2);
    expect(page2.text).toContain('**topic-7（1 条）**');
    expect(page2.text).toContain('**topic-8（1 条）**');
    expect(page2.text).not.toContain('**topic-1');
  });

  it('limits accumulated entries per page to 30 and notes omitted entries per topic', () => {
    const byTopic = new Map<string, LarkMemoryEntry[]>();
    const entries: LarkMemoryEntry[] = [];
    for (let i = 0; i < 35; i++) {
      entries.push(makeEntry(`mem_${i.toString(16).padStart(8, '0')}`, 'general', `内容 ${i}`));
    }
    byTopic.set('general', entries);

    const result = renderLarkMemoryList(byTopic, { ...dummyState, lastConsolidationAt: undefined });
    expect(result.text).toContain('上次整理 尚未整理');
    expect(result.text).toContain('**general（35 条）**');
    expect(result.text).toContain('（该主题另有 5 条）');
  });
});

describe('larkMemoryToolsPrompt', () => {
  it('contains search, show, and write policy rules', () => {
    const prompt = larkMemoryToolsPrompt('dutydeck');
    expect(prompt).toContain('dutydeck memory list [--topic <slug>]');
    expect(prompt).toContain('dutydeck memory show <topic>');
    expect(prompt).toContain("dutydeck memory search '<关键词>' [--topic <slug>]");
    expect(prompt).toContain("dutydeck memory add '<一句话内容>' [--topic <slug>]");
    expect(prompt).toContain('dutydeck memory remove <id>');
    expect(prompt).toContain('只在用户明确要求记住/忘记时写入');
    expect(prompt).toContain('不要主动 add');
    expect(prompt).toContain('不保存凭据');
  });
});
