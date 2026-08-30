import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, JournalCorruptionError, MemoryJournal, readJournal } from './journal.js';
import { materialize, nextAttemptId } from './state.js';
import type { StoredEvent } from './types.js';

const dirs: string[] = [];
function tempJournal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dockmux-workflow-'));
  dirs.push(dir);
  return join(dir, 'journal.ndjson');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Journal — 写入与读回', () => {
  it('按写入顺序读回，并戳上 ts', () => {
    const path = tempJournal();
    const journal = new Journal(path);
    journal.append({ type: 'runStarted', runId: 'r' });
    journal.append({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' });
    const events = journal.read();
    expect(events.map((e) => e.type)).toEqual(['runStarted', 'nodeDispatched']);
    expect(typeof events[0]!.ts).toBe('number');
  });

  it('文件不存在时返回空数组（run 还没开始）', () => {
    expect(readJournal(join(tempJournal(), 'nope'))).toEqual([]);
  });

  it('父目录不存在时自动创建', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dockmux-workflow-')), 'nested', 'deep', 'journal.ndjson');
    dirs.push(join(path, '..', '..', '..'));
    new Journal(path).append({ type: 'runStarted', runId: 'r' });
    expect(readJournal(path)).toHaveLength(1);
  });

  it('每条事件占一行 NDJSON', () => {
    const path = tempJournal();
    const journal = new Journal(path);
    journal.append({ type: 'runStarted', runId: 'r' });
    journal.append({ type: 'runSucceeded' });
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe('Journal — 崩溃恢复', () => {
  it('读：容忍最后一行写了一半（崩在 write 中途）', () => {
    const path = tempJournal();
    const journal = new Journal(path);
    journal.append({ type: 'runStarted', runId: 'r' });
    journal.append({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' });
    // 模拟崩溃：追加半条 JSON，没有换行
    appendFileSync(path, '{"ts":123,"type":"nodeSucc');

    const events = readJournal(path);
    expect(events).toHaveLength(2);
    expect(events.at(-1)!.type).toBe('nodeDispatched');
  });

  it('读：中间行损坏必须抛错，不能静默跳过', () => {
    // 少一个 nodeSucceeded 会让节点看起来永远 pending，静默跳过比崩掉危险。
    const path = tempJournal();
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: 1, type: 'runStarted', runId: 'r' }),
        '{ broken json ,,',
        JSON.stringify({ ts: 3, type: 'runSucceeded' }),
        '',
      ].join('\n'),
    );
    expect(() => readJournal(path)).toThrow(JournalCorruptionError);
  });

  it('读：坏行后面跟着换行 = 已提交的损坏，即使它是最后一行也要抛', () => {
    const path = tempJournal();
    writeFileSync(path, `${JSON.stringify({ ts: 1, type: 'runStarted', runId: 'r' })}\n{ bad ,,\n`);
    expect(() => readJournal(path)).toThrow(JournalCorruptionError);
  });

  it('写：尾巴是完整 JSON 但缺换行 → 补换行保住这条事件，新事件另起一行', () => {
    const path = tempJournal();
    const journal = new Journal(path);
    journal.append({ type: 'runStarted', runId: 'r' });
    // 崩在写 '\n' 之前：记录本身是完整的
    appendFileSync(path, JSON.stringify({ ts: 2, type: 'runSucceeded' }));

    journal.append({ type: 'runBlocked', blockedNodeId: 'a' });

    const events = journal.read();
    expect(events.map((e) => e.type)).toEqual(['runStarted', 'runSucceeded', 'runBlocked']);
    // 关键：不能把两个 JSON 粘在同一行
    expect(readFileSync(path, 'utf-8').split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('写：尾巴不完整 → 截断丢弃，新事件不会被粘在半条记录后面', () => {
    const path = tempJournal();
    const journal = new Journal(path);
    journal.append({ type: 'runStarted', runId: 'r' });
    appendFileSync(path, '{"ts":2,"type":"nodeDisp');

    journal.append({ type: 'runSucceeded' });

    const events = journal.read();
    expect(events.map((e) => e.type)).toEqual(['runStarted', 'runSucceeded']);
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    // 每一行都必须能独立解析——粘连会让这一步失败
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('崩溃后重放能重建出与崩溃前一致的状态', () => {
    const path = tempJournal();
    const journal = new Journal(path);
    journal.append({ type: 'runStarted', runId: 'r' });
    journal.append({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' });
    journal.append({ type: 'nodeSucceeded', nodeId: 'a', attemptId: 'a/attempts/001', outputs: { k: 1 } });
    const before = materialize('r', journal.read());

    // 崩溃：半条记录
    appendFileSync(path, '{"ts":9,"type":"nodeDispat');
    const after = materialize('r', readJournal(path));

    expect(after.nodes.get('a')).toEqual(before.nodes.get('a'));
    expect(after.nodes.get('a')!.status).toBe('done');
    expect(after.nodes.get('a')!.outputs).toEqual({ k: 1 });
  });

  it('续跑：修复后的 journal 上继续追加，attempt 编号不重复', () => {
    const path = tempJournal();
    const journal = new Journal(path);
    journal.append({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/001' });
    appendFileSync(path, '{"ts":5,"type":"garb');

    expect(nextAttemptId(readJournal(path), 'a')).toBe('a/attempts/002');
    journal.append({ type: 'nodeDispatched', nodeId: 'a', attemptId: 'a/attempts/002' });
    expect(nextAttemptId(journal.read(), 'a')).toBe('a/attempts/003');
  });

  it('空文件与只有换行的文件都安全', () => {
    const path = tempJournal();
    writeFileSync(path, '');
    expect(readJournal(path)).toEqual([]);
    new Journal(path).append({ type: 'runStarted', runId: 'r' });
    expect(readJournal(path)).toHaveLength(1);
  });
});

describe('MemoryJournal', () => {
  it('与 Journal 行为一致，且 read 返回拷贝', () => {
    const journal = new MemoryJournal();
    journal.append({ type: 'runStarted', runId: 'r' });
    const first = journal.read();
    first.push({ ts: 0, type: 'runSucceeded' } as StoredEvent);
    expect(journal.read()).toHaveLength(1);
  });
});
