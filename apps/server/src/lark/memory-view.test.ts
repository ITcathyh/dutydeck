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
