import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import {
  isLarkMemoryId,
  larkGroupMemoryPool,
  LarkMemoryError,
  larkMemoryKey,
  larkMemoryLimits,
  larkMemoryScope,
  larkMemoryStateKey,
  LarkMemoryStore,
  larkMemoryToolsPrompt,
  looksLikeLarkMemoryCredential,
  normalizeLarkMemoryTopic,
  renderLarkMemoryList,
  renderLarkMemoryStatus,
  type LarkMemoryEntry,
  type LarkMemoryState,
  type LarkMemoryStatus
} from './memory.js';

const scope = { appId: 'cli_bot', chatId: 'oc_group', pool: 'oc_group' };

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

describe('looksLikeLarkMemoryCredential', () => {
  it('detects credential assignment patterns and long opaque secrets', () => {
    expect(looksLikeLarkMemoryCredential('token: abc')).toBe(true);
    expect(looksLikeLarkMemoryCredential('api_key: sk-123456')).toBe(true);
    expect(looksLikeLarkMemoryCredential('password = mysecret')).toBe(true);
    expect(looksLikeLarkMemoryCredential('bearer: token123')).toBe(true);
    expect(looksLikeLarkMemoryCredential('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(looksLikeLarkMemoryCredential('a1b2c3d4e5'.repeat(4))).toBe(true);
    expect(looksLikeLarkMemoryCredential('用 pnpm 跑测试')).toBe(false);
    expect(looksLikeLarkMemoryCredential('项目使用 React 框架')).toBe(false);
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
    expect(await memory.list({ appId: 'cli_bot', chatId: 'oc_other', pool: 'oc_other' })).toEqual([]);
    expect(await memory.list({ appId: 'cli_other', chatId: 'oc_group', pool: 'oc_group' })).toEqual([]);
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
    let time = 0;
    const { repos, memory } = store({ now: () => new Date(Date.UTC(2026, 8, 17, 0, 0, time++)) });
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

  it('rejects credential patterns on add with MEMORY_CREDENTIAL_REJECTED across all sources', async () => {
    const { repos, memory } = store();
    await expect(memory.add(scope, { content: 'token: abc', source: 'user' }))
      .rejects.toMatchObject({ code: 'MEMORY_CREDENTIAL_REJECTED', statusCode: 400 });
    await expect(memory.add(scope, { content: '0123456789abcdef0123456789abcdef01234567', source: 'agent' }))
      .rejects.toMatchObject({ code: 'MEMORY_CREDENTIAL_REJECTED', statusCode: 400 });
    await expect(memory.add(scope, { content: 'api_key=sk-12345678', source: 'extraction' }))
      .rejects.toMatchObject({ code: 'MEMORY_CREDENTIAL_REJECTED', statusCode: 400 });

    const safe = await memory.add(scope, { content: '用 pnpm 跑测试', source: 'user' });
    expect(safe.content).toBe('用 pnpm 跑测试');
    repos.close();
  });

  it('rejects 13th new topic but permits reusing existing topics when topic limit reached', async () => {
    const { repos, memory } = store();
    for (let i = 0; i < 12; i++) {
      await memory.add(scope, { content: `主题内容 ${i}`, source: 'agent', topic: `topic-${i}` });
    }

    await expect(memory.add(scope, { content: '超出主题数上限', source: 'user', topic: 'topic-12' }))
      .rejects.toMatchObject({ code: 'MEMORY_TOPIC_LIMIT_REACHED', statusCode: 409 });

    const reused = await memory.add(scope, { content: '复用旧主题', source: 'user', topic: 'topic-0' });
    expect(reused.topic).toBe('topic-0');
    repos.close();
  });

  it('applyBatch 的主题上限按批次终态判定，中间态短暂超限不算违规', async () => {
    const { repos, memory } = store();
    const last: string[] = [];
    for (let i = 0; i < 12; i++) {
      const entry = await memory.add(scope, { content: `主题内容 ${i}`, source: 'agent', topic: `topic-${i}` });
      last.push(entry.id);
    }

    // 「退掉 topic-11 的最后一条 + 新开一个主题」终态仍是 12 个主题：批次必须放行。
    const applied = await memory.applyBatch(scope, [
      { op: 'add', input: { content: '新主题的一条', source: 'consolidation', topic: 'brand-new' } },
      { op: 'remove', id: last[11]!, deletedBy: 'consolidation' }
    ]);
    expect(applied.added).toHaveLength(1);
    expect(applied.removed).toBe(1);
    const topics = new Set((await memory.list(scope)).map(entry => entry.topic));
    expect(topics.size).toBe(12);
    expect(topics.has('brand-new')).toBe(true);
    expect(topics.has('topic-11')).toBe(false);

    // 只加不退仍然超限，整批不写。
    const before = await memory.listAll(scope);
    await expect(memory.applyBatch(scope, [
      { op: 'add', input: { content: '第十三个主题', source: 'consolidation', topic: 'one-too-many' } }
    ])).rejects.toMatchObject({ code: 'MEMORY_TOPIC_LIMIT_REACHED', statusCode: 409 });
    expect(await memory.listAll(scope)).toEqual(before);
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

  it('paginates 35 entries in one topic across 2 pages with continuation header on page 2', () => {
    const byTopic = new Map<string, LarkMemoryEntry[]>();
    const entries: LarkMemoryEntry[] = [];
    for (let i = 0; i < 35; i++) {
      entries.push(makeEntry(`mem_${i.toString(16).padStart(8, '0')}`, 'general', `内容 ${i}`));
    }
    byTopic.set('general', entries);

    const page1 = renderLarkMemoryList(byTopic, { ...dummyState, lastConsolidationAt: undefined }, { page: 1 });
    expect(page1.totalPages).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.text).toContain('上次整理 尚未整理');
    expect(page1.text).toContain('**general（35 条）**');
    expect(page1.text).not.toContain('（续）');
    expect(page1.text).not.toContain('该主题另有');
    for (let i = 0; i < 30; i++) {
      expect(page1.text).toContain(entries[i]!.id);
    }
    for (let i = 30; i < 35; i++) {
      expect(page1.text).not.toContain(entries[i]!.id);
    }

    const page2 = renderLarkMemoryList(byTopic, { ...dummyState, lastConsolidationAt: undefined }, { page: 2 });
    expect(page2.totalPages).toBe(2);
    expect(page2.page).toBe(2);
    expect(page2.text).toContain('**general（续）**');
    expect(page2.text).not.toContain('该主题另有');
    for (let i = 30; i < 35; i++) {
      expect(page2.text).toContain(entries[i]!.id);
    }
    for (let i = 0; i < 30; i++) {
      expect(page2.text).not.toContain(entries[i]!.id);
    }
  });

  it('paginates 7 topics with 1 entry each across 2 pages', () => {
    const byTopic = new Map<string, LarkMemoryEntry[]>();
    for (let i = 1; i <= 7; i++) {
      byTopic.set(`topic-${i}`, [makeEntry(`mem_${i}`, `topic-${i}`, `内容 ${i}`)]);
    }

    const page1 = renderLarkMemoryList(byTopic, dummyState, { page: 1 });
    expect(page1.totalPages).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.text).toContain('**topic-1（1 条）**');
    expect(page1.text).toContain('**topic-6（1 条）**');
    expect(page1.text).not.toContain('**topic-7');

    const page2 = renderLarkMemoryList(byTopic, dummyState, { page: 2 });
    expect(page2.totalPages).toBe(2);
    expect(page2.page).toBe(2);
    expect(page2.text).toContain('**topic-7（1 条）**');
    expect(page2.text).not.toContain('**topic-1');
  });

  it('returns totalPages when page number is out of bounds', () => {
    const byTopic = new Map<string, LarkMemoryEntry[]>();
    for (let i = 1; i <= 7; i++) {
      byTopic.set(`topic-${i}`, [makeEntry(`mem_${i}`, `topic-${i}`, `内容 ${i}`)]);
    }

    const overflow = renderLarkMemoryList(byTopic, dummyState, { page: 99 });
    expect(overflow.totalPages).toBe(2);
    expect(overflow.page).toBe(2);
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
    expect(prompt).toContain('在群聊里，这是本机器人所在各群共享的记忆，来自其他群的条目（索引里标「其他群」）只是背景');
    expect(prompt).toContain('在私聊里，记忆只属于本聊天');
  });
});

describe('group memory pool', () => {
  const groupA = larkMemoryScope('cli_bot', 'oc_group_a', 'group');
  const groupB = larkMemoryScope('cli_bot', 'oc_group_b', 'group');
  const p2p = larkMemoryScope('cli_bot', 'oc_p2p', 'p2p');
  const legacyKey = (chatId: string) => `lark.memory.cli_bot.${chatId}`;
  const legacyStateKey = (chatId: string) => `lark.memory.state.cli_bot.${chatId}`;

  it('resolves every group of a bot to one pool and keeps p2p chats in their own pools', async () => {
    expect(groupA).toEqual({ appId: 'cli_bot', chatId: 'oc_group_a', pool: larkGroupMemoryPool });
    expect(p2p).toEqual({ appId: 'cli_bot', chatId: 'oc_p2p', pool: 'oc_p2p' });
    const { repos, memory } = store();
    const saved = await memory.add(groupA, { content: '发布窗口是周四下午', source: 'user', chatId: groupA.chatId });
    expect(saved.chatId).toBe('oc_group_a');
    expect(await memory.list(groupB)).toEqual([saved]);
    expect(await memory.list(p2p)).toEqual([]);
    expect(await memory.list(larkMemoryScope('cli_other', 'oc_group_a', 'group'))).toEqual([]);
    expect(await repos.config.get('lark.memory.cli_bot.groups')).toContain('发布窗口是周四下午');

    // 私聊的键保持原格式：已有的私聊记忆原样可读，也不会混进群池。
    await memory.add(p2p, { content: '私聊里只给结论', source: 'user', chatId: p2p.chatId });
    expect(await repos.config.get(legacyKey('oc_p2p'))).toContain('私聊里只给结论');
    expect(await memory.list(groupA)).toEqual([saved]);
    repos.close();
  });

  const seedLegacy = async (repos: ReturnType<typeof store>['repos']) => {
    const ledger = JSON.stringify({ v: 1, entries: [
      { id: 'mem_aaaa0001', content: '回复统一用中文', source: 'user', topic: 'general', createdAt: '2026-09-20T00:00:00.000Z', createdBy: 'ou_alice' },
      // 与池里已有的一条只差空白与大小写：迁移后留作墓碑。旧记录没有 topic，读时补 general。
      { id: 'mem_aaaa0002', content: 'deploy 用  scripts/deploy.sh', source: 'extraction', createdAt: '2026-09-20T01:00:00.000Z', taskId: 'task_old' },
      { id: 'mem_aaaa0003', content: '已经删掉的旧条目', source: 'agent', topic: 'general', createdAt: '2026-09-19T00:00:00.000Z', deletedAt: '2026-09-21T00:00:00.000Z', deletedBy: 'ou_alice' }
    ] });
    const state = JSON.stringify({
      v: 1, turnsSinceExtraction: 13, turnsSinceConsolidation: 3,
      pendingTurns: [
        { sessionId: 'ses_a', taskId: 'task_a1', completedAt: '2026-09-20T02:00:00.000Z' },
        { sessionId: 'ses_b', taskId: 'task_b1', completedAt: '2026-09-24T10:00:00.000Z' }
      ],
      lastExtractionAt: '2026-09-20T00:39:06.341Z',
      lastRun: { kind: 'consolidation', at: '2026-09-24T09:51:41.447Z', ok: false, added: 0, superseded: 0, retired: 0, retopiced: 0, rejected: 0, error: 'MEMORY_RECOVERY_REQUIRED' },
      lastFailureAt: { consolidation: '2026-09-24T09:51:41.447Z' },
      running: { kind: 'extraction', startedAt: '2026-09-24T09:00:00.000Z' }
    });
    await repos.config.set(legacyKey('oc_group_a'), ledger);
    await repos.config.set(legacyStateKey('oc_group_a'), state);
    return { ledger, state };
  };

  it('lazily merges a legacy per-group ledger and state into the pool on first access from that group', async () => {
    const { repos, memory } = store({ now: () => new Date('2026-09-25T00:00:00.000Z') });
    const existing = await memory.add(groupB, { content: 'Deploy 用 scripts/deploy.sh', source: 'user', chatId: groupB.chatId });
    await memory.updateState(groupB, { turnsSinceExtraction: 1, turnsSinceConsolidation: 5,
      pendingTurns: [{ sessionId: 'ses_b', taskId: 'task_b1', completedAt: '2026-09-24T10:00:00.000Z', chatId: 'oc_group_b' }] });
    await seedLegacy(repos);

    // 别的群访问不会搬 A 群的旧账本：只有 A 群自己访问时才知道它是群。
    expect(await memory.list(groupB)).toEqual([existing]);
    expect(await repos.config.get(legacyKey('oc_group_a'))).toContain('回复统一用中文');

    const live = await memory.list(groupA);
    expect(live.map(entry => entry.id)).toEqual(['mem_aaaa0001', existing.id]);
    expect(live[0]).toMatchObject({ content: '回复统一用中文', source: 'user', createdBy: 'ou_alice', chatId: 'oc_group_a' });
    const all = await memory.listAll(groupA);
    expect(all.find(entry => entry.id === 'mem_aaaa0002')).toMatchObject({
      topic: 'general', chatId: 'oc_group_a', supersededBy: existing.id, deletedAt: '2026-09-25T00:00:00.000Z', deletedBy: 'migration'
    });
    expect(all.find(entry => entry.id === 'mem_aaaa0003')).toMatchObject({ deletedAt: '2026-09-21T00:00:00.000Z', deletedBy: 'ou_alice', chatId: 'oc_group_a' });

    const state = await memory.getState(groupB);
    expect(state.turnsSinceExtraction).toBe(13);
    expect(state.turnsSinceConsolidation).toBe(5);
    expect(state.pendingTurns).toEqual([
      { sessionId: 'ses_a', taskId: 'task_a1', completedAt: '2026-09-20T02:00:00.000Z', chatId: 'oc_group_a' },
      { sessionId: 'ses_b', taskId: 'task_b1', completedAt: '2026-09-24T10:00:00.000Z', chatId: 'oc_group_b' }
    ]);
    expect(state.lastRun).toMatchObject({ kind: 'consolidation', ok: false, error: 'MEMORY_RECOVERY_REQUIRED' });
    expect(state.lastFailureAt).toEqual({ consolidation: '2026-09-24T09:51:41.447Z' });
    expect(state.lastExtractionAt).toBe('2026-09-20T00:39:06.341Z');
    // 旧池的单飞占位不属于群池，不能把群池锁住。
    expect(state.running).toBeUndefined();

    // 旧键改写成迁移占位：仍是 v1 形状，回滚到旧版本读到的是空记录。
    expect(JSON.parse((await repos.config.get(legacyKey('oc_group_a')))!)).toEqual({ v: 1, entries: [], migratedTo: 'groups', migratedAt: '2026-09-25T00:00:00.000Z' });
    expect(JSON.parse((await repos.config.get(legacyStateKey('oc_group_a')))!)).toMatchObject({ v: 1, turnsSinceExtraction: 0, turnsSinceConsolidation: 0, migratedTo: 'groups' });
    repos.close();
  });

  it('is idempotent across processes and when a crash left the old keys unmarked', async () => {
    const { repos, memory } = store({ now: () => new Date('2026-09-25T00:00:00.000Z') });
    const { ledger, state } = await seedLegacy(repos);
    await memory.list(groupA);
    const pool = await repos.config.get(larkMemoryKey(groupA));
    const poolState = await repos.config.get(larkMemoryStateKey(groupA));

    // 另一个进程（没有进程内缓存）再访问：旧键已是占位，什么都不改。
    await new LarkMemoryStore(repos.config).list(groupA);
    expect(await repos.config.get(larkMemoryKey(groupA))).toBe(pool);
    expect(await repos.config.get(larkMemoryStateKey(groupA))).toBe(poolState);

    // 模拟「已并入、还没写占位」时崩溃：重放不产生重复条目、不重复计数。
    await repos.config.set(legacyKey('oc_group_a'), ledger);
    await repos.config.set(legacyStateKey('oc_group_a'), state);
    const replay = new LarkMemoryStore(repos.config, { now: () => new Date('2026-09-26T00:00:00.000Z') });
    expect((await replay.listAll(groupA)).map(entry => entry.id)).toEqual(JSON.parse(pool!).entries.map((entry: LarkMemoryEntry) => entry.id));
    expect(await replay.getState(groupA)).toEqual(JSON.parse(poolState!));
    expect(JSON.parse((await repos.config.get(legacyKey('oc_group_a')))!)).toMatchObject({ migratedTo: 'groups' });
    repos.close();
  });

  it('merges exactly once under concurrent access from separate stores and concurrent pool writes', async () => {
    const { repos } = store();
    await repos.config.set(legacyKey('oc_group_a'), JSON.stringify({ v: 1, entries: Array.from({ length: 5 }, (_, index) => ({
      id: `mem_0000aa0${index}`, content: `旧事实 ${index}`, source: 'user', topic: 'general', createdAt: `2026-09-2${index}T00:00:00.000Z`
    })) }));
    await repos.config.set(legacyStateKey('oc_group_a'), JSON.stringify({ v: 1, turnsSinceExtraction: 1, turnsSinceConsolidation: 1,
      pendingTurns: [{ sessionId: 'ses_a', taskId: 'task_legacy', completedAt: '2026-09-20T00:00:00.000Z' }] }));
    // 三个互不共享进程内缓存的 store，同时从 A 群访问；B 群同时写条目与状态。
    const stores = [0, 1, 2].map(() => new LarkMemoryStore(repos.config));
    await Promise.all([
      ...stores.map(item => item.list(groupA)),
      stores[0]!.add(groupB, { content: 'B 群并发写入', source: 'user', chatId: groupB.chatId }),
      stores[1]!.mutateState(groupB, current => ({
        turnsSinceExtraction: current.turnsSinceExtraction + 1,
        pendingTurns: [...(current.pendingTurns ?? []), { sessionId: 'ses_b', taskId: 'task_b', completedAt: '2026-09-25T00:00:00.000Z', chatId: 'oc_group_b' }]
      })),
      stores[2]!.getState(groupA)
    ]);
    const reader = new LarkMemoryStore(repos.config);
    const all = await reader.listAll(groupA);
    expect(all.map(entry => entry.content).sort()).toEqual(['B 群并发写入', '旧事实 0', '旧事实 1', '旧事实 2', '旧事实 3', '旧事实 4']);
    expect(new Set(all.map(entry => entry.id)).size).toBe(all.length);
    expect((await reader.getState(groupA)).pendingTurns?.map(turn => turn.taskId).sort()).toEqual(['task_b', 'task_legacy']);
    expect(JSON.parse((await repos.config.get(legacyKey('oc_group_a')))!)).toMatchObject({ migratedTo: 'groups' });
    repos.close();
  });

  it('never migrates a p2p ledger: the p2p pool key is the chat key itself', async () => {
    const { repos, memory } = store();
    const raw = JSON.stringify({ v: 1, entries: [{ id: 'mem_bbbb0001', content: '私聊偏好', source: 'user', topic: 'general', createdAt: '2026-09-20T00:00:00.000Z' }] });
    await repos.config.set(legacyKey('oc_p2p'), raw);
    expect((await memory.list(p2p)).map(entry => entry.id)).toEqual(['mem_bbbb0001']);
    expect(await memory.list(groupA)).toEqual([]);
    expect(await repos.config.get(legacyKey('oc_p2p'))).toBe(raw);
    repos.close();
  });

  it('reports a read-only status summary per pool', async () => {
    const { repos, memory } = store();
    await memory.add(groupA, { content: '条目一', source: 'user', topic: 'one', chatId: groupA.chatId });
    await memory.add(groupA, { content: '条目二', source: 'user', topic: 'two', chatId: groupA.chatId });
    const gone = await memory.add(groupB, { content: '条目三', source: 'user', topic: 'three', chatId: groupB.chatId });
    await memory.remove(groupB, gone.id);
    const lastRun = { kind: 'extraction' as const, at: '2026-09-24T09:51:41.428Z', ok: false, added: 0, superseded: 0, retired: 0, retopiced: 0, rejected: 0, error: 'MEMORY_RECOVERY_REQUIRED' };
    const running = { kind: 'consolidation' as const, startedAt: '2026-09-25T00:00:00.000Z' };
    await memory.updateState(groupA, {
      pendingTurns: [{ sessionId: 's', taskId: 't1', completedAt: '2026-09-24T00:00:00.000Z' }, { sessionId: 's', taskId: 't2', completedAt: '2026-09-24T00:01:00.000Z' }],
      lastRun, running, lastExtractionAt: '2026-09-20T00:39:06.341Z', lastFailureAt: { extraction: lastRun.at }
    });
    expect(await memory.status(groupB)).toEqual({
      appId: 'cli_bot', pool: 'groups', shared: true, liveEntries: 2, topics: 2, pendingTurns: 2,
      running, lastRun, lastExtractionAt: '2026-09-20T00:39:06.341Z', lastFailureAt: { extraction: lastRun.at }
    });
    expect(await memory.status(p2p)).toEqual({ appId: 'cli_bot', pool: 'oc_p2p', shared: false, liveEntries: 0, topics: 0, pendingTurns: 0 });
    repos.close();
  });
});

describe('memory search relevance', () => {
  it('scores multi-keyword queries, drops misses and orders by score then recency', async () => {
    let time = 0;
    const { repos, memory } = store({ now: () => new Date(Date.UTC(2026, 8, 17, 0, 0, time++)) });
    const alarm = await memory.add(scope, { content: 'Redis 内存告警阈值是 80%', source: 'user', topic: 'ops' });
    const cluster = await memory.add(scope, { content: 'redis 集群在 A 机房', source: 'user', topic: 'ops' });
    const slowlog = await memory.add(scope, { content: 'Redis 慢查询看 Argos', source: 'user', topic: 'ops' });
    await memory.add(scope, { content: '前端用 React', source: 'user', topic: 'frontend' });

    // 整串子串匹配查不到的多词查询：按命中词长度打分，同分按时间倒序。
    expect((await memory.search(scope, { query: 'redis 内存告警' })).map(entry => entry.id)).toEqual([alarm.id, slowlog.id, cluster.id]);
    expect(await memory.search(scope, { query: '告警 内存' })).toEqual([alarm]);
    expect(await memory.search(scope, { query: 'kafka 延迟' })).toEqual([]);
    expect((await memory.search(scope, { query: 'redis', limit: 2 })).map(entry => entry.id)).toEqual([slowlog.id, cluster.id]);
    expect(await memory.search(scope, { query: 'redis 内存', topic: 'frontend' })).toEqual([]);
    repos.close();
  });
});

describe('/memory receipt for shared pools and background status', () => {
  const state: LarkMemoryState = { v: 1, turnsSinceExtraction: 0, turnsSinceConsolidation: 0 };
  const entry = (id: string, content: string, chatId?: string): LarkMemoryEntry => ({
    id, content, topic: 'general', source: 'user', createdAt: '2026-09-17T08:00:00.000Z', ...(chatId ? { chatId } : {})
  });
  const failed: LarkMemoryStatus = {
    appId: 'cli_bot', pool: 'groups', shared: true, liveEntries: 3, topics: 1, pendingTurns: 13,
    lastRun: { kind: 'consolidation', at: '2026-09-24T09:51:41.447Z', ok: false, added: 0, superseded: 0, retired: 0, retopiced: 0, rejected: 0, error: 'MEMORY_RECOVERY_REQUIRED' },
    lastExtractionAt: '2026-09-20T00:39:06.341Z'
  };

  it('marks other-group entries and appends the last run with a readable failure reason', () => {
    const byTopic = new Map([['general', [entry('mem_00000001', '本群条目', 'oc_a'), entry('mem_00000002', '别的群条目', 'oc_b'), entry('mem_00000003', '跨群合并条目')]]]);
    const { text } = renderLarkMemoryList(byTopic, state, { shared: true, currentChatId: 'oc_a', status: failed });
    expect(text).toContain('**本机器人所在各群共享，共 3 条记忆 · 上次整理 尚未整理**');
    expect(text).toContain('- `mem_00000001` · 用户 · 2026-09-17 · 本群条目');
    expect(text).toContain('- `mem_00000002` · 用户 · 2026-09-17 · 其他群 · 别的群条目');
    expect(text).toContain('- `mem_00000003` · 用户 · 2026-09-17 · 跨群合并条目');
    expect(text).toContain('- 上次运行：整理 · 2026-09-24 09:51 · 失败 `MEMORY_RECOVERY_REQUIRED`（记忆会话需要恢复）');
    expect(text).toContain('- 待提取 13 轮 · 上次提取 2026-09-20 00:39 · 上次整理 尚未整理');
    expect(text.indexOf('**后台提取与整理**')).toBeLessThan(text.indexOf('第 1/1 页'));
  });

  it('shows status on empty p2p receipts and never pastes raw error text', () => {
    const empty = renderLarkMemoryList(new Map(), state, { status: { appId: 'cli_bot', pool: 'oc_p2p', shared: false, liveEntries: 0, topics: 0, pendingTurns: 2 } });
    expect(empty.text).toContain('**本聊天还没有保存的记忆。**');
    expect(empty.text).toContain('- 上次运行：尚未运行');
    expect(empty.text).toContain('- 待提取 2 轮 · 上次提取 尚未提取 · 上次整理 尚未整理');
    expect(renderLarkMemoryList(new Map(), state, { shared: true }).text).toContain('本机器人所在各群还没有共享的记忆');

    const raw = renderLarkMemoryStatus({ ...failed, lastRun: { ...failed.lastRun!, kind: 'extraction', error: 'ENOENT: no such file /data00/private/path' } });
    expect(raw).toContain('失败，运行异常（详见服务日志）');
    expect(raw).not.toContain('/data00');
    const ok = renderLarkMemoryStatus({ ...failed, running: { kind: 'extraction', startedAt: '2026-09-25T01:02:03.000Z' },
      lastRun: { kind: 'extraction', at: '2026-09-25T01:00:00.000Z', ok: true, added: 2, superseded: 0, retired: 0, retopiced: 0, rejected: 1 } });
    expect(ok).toContain('- 上次运行：提取 · 2026-09-25 01:00 · 成功，新增 2 条，拒绝 1 条');
    expect(ok).toContain('- 正在运行：提取（开始于 2026-09-25 01:02）');
  });
});
