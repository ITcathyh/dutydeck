// 提取与整理管线的确定性部分：JSON 代码块解析、两个门禁的逐条规则、批量写入的原子性。
// 这里不起 runtime，也不跑 Agent——管线与运行时的接线由 memory-pipeline.integration.test.ts 覆盖。
import { describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import {
  gateConsolidationActions,
  gateExtractionFacts,
  indexOverBudgetViolation,
  larkMemoryPipelineRules,
  parseLastJsonBlock
} from './memory-pipeline.js';
import { LarkMemoryError, larkMemoryLimits, LarkMemoryStore, type LarkMemoryEntry } from './memory.js';

const scope = { appId: 'cli_bot', chatId: 'oc_group' };

const entry = (patch: Partial<LarkMemoryEntry> & { id: string }): LarkMemoryEntry => ({
  content: `内容 ${patch.id}`,
  source: 'extraction',
  topic: 'general',
  createdAt: '2026-09-17T10:00:00.000Z',
  ...patch
});

const fact = (patch: Record<string, unknown> = {}) => ({ content: '项目统一用 pnpm', topic: 'conventions', kind: 'convention', evidence: 'task_1', ...patch });

describe('parseLastJsonBlock', () => {
  it('取最后一个 json 代码块', () => {
    const text = '先想一下\n```json\n{"facts":[1]}\n```\n改主意了\n```json\n{"facts":[2]}\n```\n结束';
    expect(parseLastJsonBlock(text)).toEqual({ facts: [2] });
  });

  it('没有代码块、JSON 非法、顶层不是对象时都抛 MEMORY_AGENT_OUTPUT_INVALID', () => {
    for (const text of ['完全没有代码块', '```json\n{不是 JSON}\n```', '```json\n[1,2,3]\n```', '```json\n"文本"\n```']) {
      expect(() => parseLastJsonBlock(text)).toThrow(LarkMemoryError);
      try { parseLastJsonBlock(text); } catch (error) {
        expect((error as LarkMemoryError).code).toBe('MEMORY_AGENT_OUTPUT_INVALID');
      }
    }
  });
});

describe('gateExtractionFacts', () => {
  const gate = (facts: unknown[], existing: LarkMemoryEntry[] = [], evidenceTaskIds = ['task_1', 'task_2']) =>
    gateExtractionFacts({ facts, evidenceTaskIds }, existing);

  it('接受合法条目并归一化主题', () => {
    const result = gate([fact({ topic: 'Team Conventions' })]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([{ content: '项目统一用 pnpm', topic: 'team-conventions', evidence: 'task_1' }]);
  });

  it('内容为空或超过单条上限时拒绝', () => {
    const result = gate([fact({ content: '   ' }), fact({ content: '内容'.repeat(larkMemoryLimits.entryChars) }), fact({ content: '内容'.repeat(larkMemoryLimits.entryChars / 2) })]);
    expect(result.rejected).toHaveLength(2);
    expect(result.accepted).toHaveLength(1);
  });

  it('主题不是合法 slug 时拒绝', () => {
    const result = gate([fact({ topic: '---' }), fact({ topic: 123 })]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(2);
  });

  it('写入后主题总数不得超过上限', () => {
    const existing = Array.from({ length: larkMemoryLimits.topics }, (_, index) => entry({ id: `mem_t${index}`, topic: `topic${index}`, content: `旧内容 ${index}` }));
    const result = gate([fact({ topic: 'brand-new' }), fact({ content: '复用已有主题', topic: 'topic0' })], existing);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain(String(larkMemoryLimits.topics));
    expect(result.accepted).toEqual([{ content: '复用已有主题', topic: 'topic0', evidence: 'task_1' }]);
  });

  it('evidence 必须是本次输入里的 taskId', () => {
    const result = gate([fact({ evidence: 'task_9' }), fact({ evidence: 42 }), fact({ evidence: 'task_2' })]);
    expect(result.rejected).toHaveLength(2);
    expect(result.accepted).toHaveLength(1);
  });

  it('与已有条目归一化后重复时拒绝，本批内重复也只留一条', () => {
    const existing = [entry({ id: 'mem_a', content: '项目统一用 pnpm' })];
    expect(gate([fact()], existing).accepted).toEqual([]);
    const batch = gate([fact({ content: '团队每天站会' }), fact({ content: ' 团队每天 站会 ' })]);
    expect(batch.accepted).toHaveLength(1);
    expect(batch.rejected).toHaveLength(1);
  });

  it('凭据赋值与 40 位以上连续 base64/hex 都拒绝', () => {
    const result = gate([
      fact({ content: 'api_key = sk-live-1234' }),
      fact({ content: `部署令牌 ${'a1b2c3d4e5'.repeat(5)}` }),
      fact({ content: '短哈希 a1b2c3d4' })
    ]);
    expect(result.rejected).toHaveLength(2);
    expect(result.accepted).toHaveLength(1);
  });

  it('单次最多接受 10 条', () => {
    const facts = Array.from({ length: 13 }, (_, index) => fact({ content: `事实 ${index}` }));
    const result = gate(facts);
    expect(result.accepted).toHaveLength(larkMemoryPipelineRules.factsPerExtraction);
    expect(result.rejected).toHaveLength(13 - larkMemoryPipelineRules.factsPerExtraction);
  });

  it('有效总数达到 200 时不再接受', () => {
    const existing = Array.from({ length: larkMemoryLimits.liveEntries }, (_, index) => entry({ id: `mem_f${index}`, content: `旧内容 ${index}` }));
    const result = gate([fact()], existing);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]!.reason).toContain(String(larkMemoryLimits.liveEntries));
  });
});

describe('gateConsolidationActions', () => {
  const base = [
    entry({ id: 'mem_a1', content: '后端用 Go', topic: 'stack' }),
    entry({ id: 'mem_a2', content: '后端服务是 Go 写的', topic: 'stack' }),
    entry({ id: 'mem_u1', content: '这个群回复统一用中文', source: 'user', topic: 'general' })
  ];
  const gate = (actions: unknown[], existing = base) => gateConsolidationActions({ actions, sessionId: 'ses_mem' }, existing);

  it('merge 通过后 plan 是先 add 再 remove/retopic', () => {
    const result = gate([
      { op: 'merge', ids: ['mem_a1', 'mem_a2'], content: '后端服务用 Go', topic: 'stack' },
      { op: 'retopic', id: 'mem_u1', topic: 'language' }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual([
      { op: 'add', input: { content: '后端服务用 Go', topic: 'stack', source: 'consolidation', supersedes: ['mem_a1', 'mem_a2'], sessionId: 'ses_mem' } },
      { op: 'retopic', id: 'mem_u1', topic: 'language' }
    ]);
  });

  it('noop 与空动作表都算通过，计划为空', () => {
    expect(gate([{ op: 'noop' }])).toEqual({ ok: true, plan: [] });
    expect(gate([])).toEqual({ ok: true, plan: [] });
  });

  it('引用不存在的 id 或同一 id 出现两次都算违规', () => {
    expect(gate([{ op: 'retire', id: 'mem_zzz' }])).toMatchObject({ ok: false });
    const duplicated = gate([{ op: 'retire', id: 'mem_a1' }, { op: 'retopic', id: 'mem_a1', topic: 'stack' }]);
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) return;
    expect(duplicated.violations.some(item => item.includes('重复出现'))).toBe(true);
  });

  it('同一个 merge 里重复或非字符串的 id 都算违规', () => {
    expect(gate([{ op: 'merge', ids: ['mem_a1', 'mem_a1'], content: '重复的编号', topic: 'stack' }])).toMatchObject({ ok: false });
    expect(gate([{ op: 'merge', ids: ['mem_a1', 'mem_a2', 123], content: '混进了数字', topic: 'stack' }])).toMatchObject({ ok: false });
  });

  it('merge 少于 2 个 id 时违规', () => {
    const result = gate([{ op: 'merge', ids: ['mem_a1'], content: '只有一条', topic: 'stack' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some(item => item.includes('至少需要 2 个'))).toBe(true);
  });

  it('用户原话不能 merge 或 update，但可以 retire 与 retopic', () => {
    expect(gate([{ op: 'merge', ids: ['mem_u1', 'mem_a1'], content: '合并用户原话', topic: 'general' }])).toMatchObject({ ok: false });
    expect(gate([{ op: 'update', id: 'mem_u1', content: '改写用户原话', topic: 'general' }])).toMatchObject({ ok: false });
    expect(gate([{ op: 'retire', id: 'mem_u1' }])).toMatchObject({ ok: true });
    expect(gate([{ op: 'retopic', id: 'mem_u1', topic: 'language' }])).toMatchObject({ ok: true });
  });

  it('新内容为空、超长或含凭据时违规', () => {
    expect(gate([{ op: 'update', id: 'mem_a1', content: '   ', topic: 'stack' }])).toMatchObject({ ok: false });
    expect(gate([{ op: 'update', id: 'mem_a1', content: '内容'.repeat(larkMemoryLimits.entryChars), topic: 'stack' }])).toMatchObject({ ok: false });
    expect(gate([{ op: 'update', id: 'mem_a1', content: 'token: abcdefgh', topic: 'stack' }])).toMatchObject({ ok: false });
  });

  it('整理后主题数、每主题条数与总数都不得超限', () => {
    const many = Array.from({ length: larkMemoryLimits.topics }, (_, index) => entry({ id: `mem_t${index}`, topic: `topic${index}`, content: `内容 ${index}` }));
    const overTopics = gateConsolidationActions({ actions: [{ op: 'retopic', id: 'mem_t0', topic: 'brand-new' }] }, [...many, entry({ id: 'mem_extra', topic: 'topic0', content: '另一条' })]);
    expect(overTopics.ok).toBe(false);
    if (!overTopics.ok) expect(overTopics.violations.some(item => item.includes('主题数'))).toBe(true);

    const perTopic = Array.from({ length: larkMemoryLimits.entriesPerTopic + 1 }, (_, index) => entry({ id: `mem_p${index}`, topic: index === 0 ? 'other' : 'crowded', content: `内容 ${index}` }));
    const overPerTopic = gateConsolidationActions({ actions: [{ op: 'retopic', id: 'mem_p0', topic: 'crowded' }] }, perTopic);
    expect(overPerTopic.ok).toBe(false);
    if (!overPerTopic.ok) expect(overPerTopic.violations.some(item => item.includes('超过上限'))).toBe(true);

    const full = Array.from({ length: larkMemoryLimits.liveEntries + 1 }, (_, index) => entry({ id: `mem_l${index}`, content: `内容 ${index}` }));
    const overTotal = gateConsolidationActions({ actions: [{ op: 'noop' }] }, full);
    expect(overTotal.ok).toBe(false);
    if (!overTotal.ok) expect(overTotal.violations.some(item => item.includes(`超过上限 ${larkMemoryLimits.liveEntries}`))).toBe(true);
  });

  it('整理后索引仍超预算时违规并带 INDEX_OVER_BUDGET 标记', () => {
    const bulky = Array.from({ length: 40 }, (_, index) => entry({ id: `mem_b${index}`, topic: `topic${index % 10}`, content: `这是一条很长的记忆内容用来把索引撑到预算之外 ${index} ${'填充'.repeat(30)}` }));
    const result = gateConsolidationActions({ actions: [{ op: 'noop' }] }, bulky);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some(item => item.includes(indexOverBudgetViolation))).toBe(true);
  });
});

describe('LarkMemoryStore.applyBatch', () => {
  const build = () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    let counter = 0;
    const store = new LarkMemoryStore(repos.config, { newId: () => `mem_${(counter++).toString(16).padStart(8, '0')}` });
    return { repos, store };
  };

  it('一次写入里顺序执行 add / remove / retopic', async () => {
    const { repos, store } = build();
    const first = await store.add(scope, { content: '后端用 Go', source: 'extraction', topic: 'stack' });
    const second = await store.add(scope, { content: '前端用 React', source: 'extraction', topic: 'stack' });
    const third = await store.add(scope, { content: '每天站会', source: 'user', topic: 'general' });

    const result = await store.applyBatch(scope, [
      { op: 'add', input: { content: '技术栈是 Go + React', source: 'consolidation', topic: 'stack', supersedes: [first.id, second.id] } },
      { op: 'retopic', id: third.id, topic: 'rituals' }
    ]);
    expect(result).toMatchObject({ removed: 0, retopiced: 1 });
    expect(result.added).toHaveLength(1);

    const live = await store.list(scope);
    expect(live.map(item => item.content)).toEqual(['每天站会', '技术栈是 Go + React']);
    expect(live.find(item => item.content === '每天站会')!.topic).toBe('rituals');
    repos.close();
  });

  it('中途失败时整批不写入', async () => {
    const { repos, store } = build();
    const existing = await store.add(scope, { content: '后端用 Go', source: 'extraction', topic: 'stack' });
    const before = await store.listAll(scope);

    await expect(store.applyBatch(scope, [
      { op: 'add', input: { content: '一条新的记忆', source: 'consolidation', topic: 'stack' } },
      { op: 'remove', id: 'mem_missing', deletedBy: 'consolidation' },
      { op: 'retopic', id: existing.id, topic: 'other' }
    ])).rejects.toThrow(LarkMemoryError);

    expect(await store.listAll(scope)).toEqual(before);
    repos.close();
  });
});
