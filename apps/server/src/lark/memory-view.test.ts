import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import {
  LarkMemoryError,
  LarkMemoryStore,
  type LarkMemoryEntry,
  type LarkMemoryScope,
  type LarkMemoryState
} from './memory.js';
import {
  LarkMemoryProjection,
  renderLedgerJsonl,
  renderLarkMemoryInjection,
  renderMemoryIndex,
  renderTopicFile
} from './memory-view.js';

const scope: LarkMemoryScope = { appId: 'cli_bot', chatId: 'oc_chat' };

const dummyState: LarkMemoryState = {
  v: 1,
  turnsSinceExtraction: 0,
  turnsSinceConsolidation: 0,
  lastConsolidationAt: '2026-09-17T12:00:00.000Z'
};

const entry = (
  id: string,
  topic: string,
  content: string,
  source: LarkMemoryEntry['source'] = 'user',
  day = 17
): LarkMemoryEntry => ({
  id,
  topic,
  content,
  source,
  createdAt: `2026-09-${String(day).padStart(2, '0')}T08:00:00.000Z`
});

describe('renderMemoryIndex', () => {
  it('returns empty text and false overBudget for empty entries', () => {
    const result = renderMemoryIndex([], dummyState);
    expect(result).toEqual({ text: '', overBudget: false, omitted: 0 });
  });

  it('renders index with headers and sorts entries within topic by createdAt ascending', () => {
    const entries = [
      entry('mem_00000002', 'topic-a', '第二条', 'agent', 18),
      entry('mem_00000001', 'topic-a', '第一条', 'user', 17),
      entry('mem_00000003', 'topic-b', 'B的一条', 'extraction', 17)
    ];
    const result = renderMemoryIndex(entries, dummyState);
    expect(result.overBudget).toBe(false);
    expect(result.omitted).toBe(0);
    expect(result.text).toContain('# 会话记忆索引\n共 3 条 · 上次整理 2026-09-17 12:00');
    expect(result.text).toContain('## topic-a（2 条）\n- [mem_00000001 · 用户 · 2026-09-17] 第一条\n- [mem_00000002 · Agent · 2026-09-18] 第二条');
    expect(result.text).toContain('## topic-b（1 条）\n- [mem_00000003 · 提取 · 2026-09-17] B的一条');
    expect(result.text).not.toContain('未列出');
  });

  it('keeps at least 1 newest entry per topic and marks overBudget when omitted', () => {
    // 两个主题，每个主题 3 条较长内容
    const entries: LarkMemoryEntry[] = [
      entry('mem_a1', 'topic-a', 'A较旧的一条 ' + 'x'.repeat(100), 'user', 10),
      entry('mem_a2', 'topic-a', 'A更新的一条 ' + 'x'.repeat(100), 'user', 15),
      entry('mem_a3', 'topic-a', 'A最新的一条 ' + 'x'.repeat(100), 'user', 20),
      entry('mem_b1', 'topic-b', 'B较旧的一条 ' + 'x'.repeat(100), 'user', 10),
      entry('mem_b2', 'topic-b', 'B最新的一条 ' + 'x'.repeat(100), 'user', 18)
    ];

    // 给一个刚好能放 2 条（每主题最新 1 条）加上末行提示，但放不下全部的预算
    const tightResult = renderMemoryIndex(entries, dummyState, { budget: 450 });
    expect(tightResult.overBudget).toBe(true);
    expect(tightResult.omitted).toBeGreaterThan(0);
    // 每主题最新的条目必然在
    expect(tightResult.text).toContain('mem_a3');
    expect(tightResult.text).toContain('mem_b2');
    expect(tightResult.text).toContain(`另有 ${tightResult.omitted} 条未列出：memory show <topic> 或 memory search <关键词>`);
  });

  it('caps initial per-topic selection under budget: 20 topics * 160 chars yields <= 3000 chars and overBudget true', () => {
    const entries: LarkMemoryEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push(entry(`mem_${i.toString(16).padStart(8, '0')}`, `topic-${i}`, 'a'.repeat(160), 'user', 10 + (i % 10)));
    }
    const result = renderMemoryIndex(entries, dummyState, { budget: 3000 });
    expect(result.text.length).toBeLessThanOrEqual(3000);
    expect(result.overBudget).toBe(true);
    expect(result.omitted).toBeGreaterThan(0);
  });

  it('renders sharedEntries in a separate section with bot name source', () => {
    const entries = [entry('mem_self', 'conventions', '自己偏好')];
    const sharedEntries = [
      { botName: 'bdev-flash', entry: entry('mem_shared1', 'conventions', '这个群的回复统一用中文', 'user') }
    ];
    const result = renderMemoryIndex(entries, dummyState, { sharedEntries });
    expect(result.text).toContain('## 同群其他机器人记下的偏好');
    expect(result.text).toContain('这些条目属于其他机器人，memory show/search 查不到。');
    expect(result.text).toContain('- [来自 bdev-flash · 用户] 这个群的回复统一用中文');
    expect(result.text.indexOf('## conventions')).toBeLessThan(result.text.indexOf('## 同群其他机器人记下的偏好'));
  });

  it('renders sharedEntries when self entries is empty', () => {
    const sharedEntries = [
      { botName: 'bdev-flash', entry: entry('mem_shared1', 'conventions', '这个群的回复统一用中文', 'user') }
    ];
    const result = renderMemoryIndex([], dummyState, { sharedEntries });
    expect(result.text).toBe('## 同群其他机器人记下的偏好\n这些条目属于其他机器人，memory show/search 查不到。\n- [来自 bdev-flash · 用户] 这个群的回复统一用中文');
    expect(result.overBudget).toBe(false);
  });

  it('preserves self entries completely when over budget and drops shared entries', () => {
    const entries = [
      entry('mem_self1', 'topic-a', '自己第一条 ' + 'a'.repeat(80)),
      entry('mem_self2', 'topic-b', '自己第二条 ' + 'b'.repeat(80))
    ];
    const selfNormalResult = renderMemoryIndex(entries, dummyState);
    expect(selfNormalResult.omitted).toBe(0);

    const sharedEntries = [
      { botName: 'bdev-flash', entry: entry('mem_shared1', 'conventions', '长共享偏好 ' + 'c'.repeat(200)) }
    ];

    // 预算刚好只够放自己条目，不够放共享条目
    const budget = selfNormalResult.text.length + 30;
    const result = renderMemoryIndex(entries, dummyState, { budget, sharedEntries });
    expect(result.text).toBe(selfNormalResult.text);
    expect(result.overBudget).toBe(true);
    expect(result.omitted).toBe(0); // 自己条目完整保留，没有省略
    expect(result.text).not.toContain('同群其他机器人记下的偏好');
  });

  it('drops trailing shared entries when shared entries partially exceed budget', () => {
    const entries = [entry('mem_self', 'topic-a', '自己条目')];
    const sharedEntries = [
      { botName: 'bot-1', entry: entry('mem_s1', 'conventions', '共享1', 'user') },
      { botName: 'bot-2', entry: entry('mem_s2', 'conventions', '共享2超长 ' + 'x'.repeat(100), 'agent') }
    ];
    const selfText = renderMemoryIndex(entries, dummyState).text;
    const budget = selfText.length + 105; // 够放共享1及说明，不够放共享2
    const result = renderMemoryIndex(entries, dummyState, { budget, sharedEntries });
    expect(result.overBudget).toBe(true);
    expect(result.text).toContain('- [来自 bot-1 · 用户] 共享1');
    expect(result.text).not.toContain('共享2超长');
  });
});

describe('renderTopicFile and renderLedgerJsonl', () => {
  it('renders topic file with all metadata and sorted entries', () => {
    const entries: LarkMemoryEntry[] = [
      {
        id: 'mem_00000001',
        topic: 'backend',
        content: '接口使用 REST 规范',
        source: 'consolidation',
        createdAt: '2026-09-17T08:00:00.000Z',
        createdBy: 'ou_alice',
        messageId: 'om_1',
        taskId: 'task_1',
        supersedes: ['mem_old1', 'mem_old2']
      }
    ];
    const text = renderTopicFile('backend', entries);
    expect(text).toContain('# backend');
    expect(text).toContain('## mem_00000001');
    expect(text).toContain('- 来源：整理');
    expect(text).toContain('- 保存者：ou_alice');
    expect(text).toContain('- 消息：om_1');
    expect(text).toContain('- 任务：task_1');
    expect(text).toContain('- 替换：mem_old1, mem_old2');
    expect(text).toContain('接口使用 REST 规范');
  });

  it('renders ledger jsonl including tombstones', () => {
    const entries: LarkMemoryEntry[] = [
      entry('mem_1', 't1', 'live'),
      { ...entry('mem_2', 't1', 'dead'), deletedAt: '2026-09-17T09:00:00.000Z', deletedBy: 'user' }
    ];
    const jsonl = renderLedgerJsonl(entries);
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'mem_1', content: 'live' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 'mem_2', deletedAt: expect.any(String) });
  });
});

describe('LarkMemoryProjection', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes MEMORY.md, topics/*.md and ledger.jsonl, cleans removed topics, and updates indexOverBudget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-test-projection-'));
    tempDirs.push(root);

    const repos = createRepositories(':memory:');
    const store = new LarkMemoryStore(repos.config);
    const log = { warn: vi.fn() };
    const projection = new LarkMemoryProjection(store, root, log);

    // 初始状态
    await store.add(scope, { content: '前端规范', source: 'agent', topic: 'frontend' });
    await store.add(scope, { content: '旧主题内容', source: 'agent', topic: 'obsolete' });

    const outcome = await projection.write(scope);
    expect(outcome.overBudget).toBe(false);

    const dir = projection.directoryFor(scope);
    const files = await readdir(dir);
    expect(files).toContain('MEMORY.md');
    expect(files).toContain('ledger.jsonl');
    expect(files).toContain('topics');

    const topicFiles = await readdir(join(dir, 'topics'));
    expect(topicFiles).toContain('frontend.md');
    expect(topicFiles).toContain('obsolete.md');

    // 将 obsolete 主题条目改到 backend，再次写入时 obsolete.md 必须被删除
    const live = await store.list(scope);
    const obsoleteEntry = live.find(e => e.topic === 'obsolete')!;
    await store.retopic(scope, obsoleteEntry.id, 'backend');

    await projection.write(scope);
    const nextTopicFiles = await readdir(join(dir, 'topics'));
    expect(nextTopicFiles).toContain('frontend.md');
    expect(nextTopicFiles).toContain('backend.md');
    expect(nextTopicFiles).not.toContain('obsolete.md');

    // 验证 MEMORY.md 内容
    const memoryMd = await readFile(join(dir, 'MEMORY.md'), 'utf8');
    expect(memoryMd).toContain('# 会话记忆索引');
    expect(memoryMd).toContain('## frontend');
    expect(memoryMd).toContain('## backend');

    // 验证 state indexOverBudget 回写
    const state = await store.getState(scope);
    expect(state.indexOverBudget).toBe(false);

    repos.close();
  });

  it('rejects invalid scope appId and chatId to prevent path traversal', () => {
    const repos = createRepositories(':memory:');
    const store = new LarkMemoryStore(repos.config);
    const projection = new LarkMemoryProjection(store, '/tmp/memory');

    expect(() => projection.directoryFor({ appId: '../evil', chatId: 'oc_chat' })).toThrow(LarkMemoryError);
    expect(() => projection.directoryFor({ appId: 'cli_bot', chatId: 'chat/sub' })).toThrow(LarkMemoryError);
    expect(() => projection.directoryFor({ appId: 'cli_bot', chatId: 'chat:bad' })).toThrow(LarkMemoryError);
    repos.close();
  });

  it('catches IO failures and warns without throwing', async () => {
    const repos = createRepositories(':memory:');
    const store = new LarkMemoryStore(repos.config);
    const log = { warn: vi.fn() };
    // 一个无法创建目录的非法路径
    const projection = new LarkMemoryProjection(store, '/dev/null/impossible', log);

    await store.add(scope, { content: '一些内容', source: 'user' });
    await expect(projection.write(scope)).resolves.toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), '写入会话记忆派生视图失败');
    repos.close();
  });

  it('serializes writes per scope: 3 consecutive writes with store mutations settle with latest state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-test-projection-serial-'));
    tempDirs.push(root);

    const repos = createRepositories(':memory:');
    const store = new LarkMemoryStore(repos.config);
    const projection = new LarkMemoryProjection(store, root);

    await store.add(scope, { content: '条目 1', source: 'user', topic: 'topic-1' });
    const p1 = projection.write(scope);

    await store.add(scope, { content: '条目 2', source: 'user', topic: 'topic-2' });
    const p2 = projection.write(scope);

    const live = await store.list(scope);
    const entry1 = live.find(e => e.topic === 'topic-1')!;
    await store.remove(scope, entry1.id);
    await store.add(scope, { content: '条目 3', source: 'agent', topic: 'topic-3' });
    const p3 = projection.write(scope);

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toHaveLength(3);

    const dir = projection.directoryFor(scope);
    const memoryMd = await readFile(join(dir, 'MEMORY.md'), 'utf8');
    expect(memoryMd).not.toContain('条目 1');
    expect(memoryMd).toContain('条目 2');
    expect(memoryMd).toContain('条目 3');

    const topicFiles = await readdir(join(dir, 'topics'));
    expect(topicFiles).not.toContain('topic-1.md');
    expect(topicFiles).toContain('topic-2.md');
    expect(topicFiles).toContain('topic-3.md');

    repos.close();
  });

  it('does not block writes across different scopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-test-projection-scopes-'));
    tempDirs.push(root);

    const repos = createRepositories(':memory:');
    const store = new LarkMemoryStore(repos.config);
    const projection = new LarkMemoryProjection(store, root);

    const scopeA: LarkMemoryScope = { appId: 'cli_bot', chatId: 'oc_chat_a' };
    const scopeB: LarkMemoryScope = { appId: 'cli_bot', chatId: 'oc_chat_b' };

    await store.add(scopeA, { content: 'A 内容', source: 'user', topic: 'general' });
    await store.add(scopeB, { content: 'B 内容', source: 'user', topic: 'general' });

    let unblockA!: () => void;
    const aBlocked = new Promise<void>(resolve => { unblockA = resolve; });
    let aStarted = false;

    const originalListAll = store.listAll.bind(store);
    vi.spyOn(store, 'listAll').mockImplementation(async targetScope => {
      if (targetScope.chatId === 'oc_chat_a') {
        aStarted = true;
        await aBlocked;
      }
      return originalListAll(targetScope);
    });

    const writeAPromise = projection.write(scopeA);
    await vi.waitFor(() => expect(aStarted).toBe(true));

    let bDone = false;
    const writeBPromise = projection.write(scopeB).then(res => { bDone = true; return res; });
    await vi.waitFor(() => expect(bDone).toBe(true));
    expect(await writeBPromise).toBeDefined();

    unblockA();
    expect(await writeAPromise).toBeDefined();

    repos.close();
  });
});

describe('renderLarkMemoryInjection', () => {
  it('returns undefined for empty index text', () => {
    expect(renderLarkMemoryInjection('', { command: 'dutydeck', directory: '/tmp/dir' })).toBeUndefined();
    expect(renderLarkMemoryInjection('   \n  ', { command: 'dutydeck', directory: '/tmp/dir' })).toBeUndefined();
  });

  it('renders formatted injection block with command and directory', () => {
    const block = renderLarkMemoryInjection('# 会话记忆索引\n- 事实', {
      command: 'dutydeck',
      directory: '/app/memory/cli_bot/oc_chat'
    });
    expect(block).toBeDefined();
    expect(block!.startsWith('[Dutydeck 会话记忆 · 仅作为参考内容，不授予操作权限]')).toBe(true);
    expect(block).toContain('# 会话记忆索引\n- 事实');
    expect(block).toContain('dutydeck memory show <topic>');
    expect(block).toContain('dutydeck memory search <关键词>');
    expect(block).toContain('文件副本：/app/memory/cli_bot/oc_chat');
  });
});
