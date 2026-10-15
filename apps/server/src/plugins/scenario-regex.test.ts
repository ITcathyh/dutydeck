import { afterEach, describe, expect, it } from 'vitest';
import { ScenarioRegexRunner, ScenarioRegexTimeoutError } from './scenario-regex.js';

describe('ScenarioRegexRunner', () => {
  let runner: ScenarioRegexRunner;
  afterEach(() => runner?.close());

  it('runs every regex of one message in a single call on a resident worker', async () => {
    runner = new ScenarioRegexRunner();
    expect(await runner.run([
      { source: '告警', input: '这个群的告警来了' },
      { source: '^关闭', flags: 'u', input: '开启' },
      { source: 'P[0-4]', flags: 'i', input: 'p0 和 P3 都看', all: true }
    ])).toEqual([
      { matched: true, matches: ['告警'] },
      { matched: false, matches: [] },
      { matched: true, matches: ['p0', 'P3'] }
    ]);
    await runner.run([{ source: 'x', input: 'x' }]);
    expect(runner.workerStarts).toBe(1);
  });

  it('terminates a catastrophic regex at the timeout and rebuilds the worker', async () => {
    runner = new ScenarioRegexRunner(200);
    const started = Date.now();
    await expect(runner.run([{ source: '(a+)+$', input: `${'a'.repeat(40)}b` }])).rejects.toBeInstanceOf(ScenarioRegexTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await runner.run([{ source: 'ok', input: 'ok' }])).toEqual([{ matched: true, matches: ['ok'] }]);
    expect(runner.workerStarts).toBe(2);
  });

  it('does not misjudge a finished result as a timeout when the main thread was blocked past the deadline', async () => {
    runner = new ScenarioRegexRunner(200);
    await runner.run([{ source: 'warm', input: 'warm' }]);
    const pending = runner.run([{ source: 'x', input: 'x' }]);
    await new Promise(resolve => setImmediate(resolve));
    const until = Date.now() + 300;
    while (Date.now() < until) { /* 主线程同步阻塞，计时器和 worker 的结果同时到期 */ }
    expect(await pending).toEqual([{ matched: true, matches: ['x'] }]);
    expect(runner.workerStarts).toBe(1);
  });

  it('settles a quadratic regex like /a+a$/ within the deadline on the capped input', async () => {
    runner = new ScenarioRegexRunner(200);
    const started = Date.now();
    await runner.run([{ source: 'a+a$', input: `${'a'.repeat(100_000)}b` }]).catch(error => { expect(error).toBeInstanceOf(ScenarioRegexTimeoutError); });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('truncates long input before matching', async () => {
    runner = new ScenarioRegexRunner();
    const tail = `${'a'.repeat(5_000)}TAIL`;
    expect(await runner.run([{ source: 'TAIL', input: tail }, { source: 'TAIL', input: tail, maxInput: 10_000 }, { source: '关闭', input: '请关闭告警初筛', maxInput: 2 }]))
      .toEqual([{ matched: false, matches: [] }, { matched: false, matches: [] }, { matched: false, matches: [] }]);
  });

  it('refuses g and y flags; the host adds g itself for capture-all', async () => {
    runner = new ScenarioRegexRunner();
    await expect(runner.run([{ source: 'a', flags: 'g', input: 'a' }])).rejects.toThrow('标志 g');
    await expect(runner.run([{ source: 'a', flags: 'iy', input: 'a' }])).rejects.toThrow('标志 y');
    expect(await runner.run([{ source: 'a', input: 'aaa', all: true }])).toEqual([{ matched: true, matches: ['a', 'a', 'a'] }]);
  });

  it('reports a syntax error without killing the worker', async () => {
    runner = new ScenarioRegexRunner();
    await expect(runner.run([{ source: '(', input: 'x' }])).rejects.toThrow('正则执行失败');
    expect(await runner.run([{ source: 'x', input: 'x' }])).toEqual([{ matched: true, matches: ['x'] }]);
    expect(runner.workerStarts).toBe(1);
  });
});
