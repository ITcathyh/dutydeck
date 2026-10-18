import { describe, expect, it } from 'vitest';
import { detectQuestion, matchCall, scoreCase } from '../../scripts/nl-control-eval-score.mjs';

const call = (operation, options = {}, args = []) => ({ kind: 'call', operation, options, args });
const read = (operation) => ({ kind: 'call', operation, options: {}, args: [], risk: 'read' });

describe('nl-control-eval scoreCase', () => {
  it('command: 执行了期望的只读子命令算对', () => {
    expect(scoreCase({ kind: 'command', operation: 'status' }, [call('status')], '').verdict).toBe('correct');
  });

  it('command: 参数全部满足才算对，少 handoff 算错', () => {
    const expected = { kind: 'command', operation: 'session.new', params: { agent: 'codex', handoff: { truthy: true } } };
    expect(scoreCase(expected, [call('session.new', { agent: 'codex', handoff: true })], '').verdict).toBe('correct');
    expect(scoreCase(expected, [call('session.new', { agent: 'codex' })], '').verdict).toBe('wrong');
    expect(scoreCase(expected, [call('agents')], '').verdict).toBe('wrong');
  });

  it('command: 多条调用里有一条满足即算对，其余算错', () => {
    const expected = { kind: 'command', operation: 'memory.search', args: [{ contains: '测试' }] };
    const calls = [call('memory.list'), call('memory.search', {}, ['测试命令'])];
    expect(scoreCase(expected, calls, '').verdict).toBe('correct');
  });

  it('command: 该执行没执行是漏做；反问了用户是反问', () => {
    const expected = { kind: 'command', operation: 'retry' };
    expect(scoreCase(expected, [], '已重试').verdict).toBe('miss');
    expect(scoreCase(expected, [], '要我重试吗？').verdict).toBe('ask');
  });

  it('command: 位置参数数字相等（commander 会转 number）', () => {
    const expected = { kind: 'command', operation: 'queue.cancel', args: [2] };
    expect(scoreCase(expected, [call('queue.cancel', {}, [2])], '').verdict).toBe('correct');
    expect(scoreCase(expected, [call('queue.cancel', {}, [1])], '').verdict).toBe('wrong');
  });

  it('none: 不执行算对，执行了任何控制操作算错', () => {
    const expected = { kind: 'none' };
    expect(scoreCase(expected, [], '明天记得开会').verdict).toBe('correct');
    expect(scoreCase(expected, [call('schedule.create', { cron: '0 9 * * *' })], '').verdict).toBe('wrong');
  });

  it('none + answerContains: 不执行但要引导用户点中断', () => {
    const expected = { kind: 'none', answerContains: ['停', '中断'] };
    expect(scoreCase(expected, [], '请点进度卡上的「中断」，或直接说停').verdict).toBe('correct');
    expect(scoreCase(expected, [], '好的，已经处理好了').verdict).toBe('wrong');
  });

  it('ask: 反问算对，执行算错，沉默算漏做', () => {
    const expected = { kind: 'ask' };
    expect(scoreCase(expected, [], '明天几点提醒你？').verdict).toBe('correct');
    expect(scoreCase(expected, [call('schedule.create')], '').verdict).toBe('wrong');
    expect(scoreCase(expected, [], '好的').verdict).toBe('miss');
  });

  it('none/ask: 只读查询、--dry-run 预览和被拒的命令不算执行', () => {
    const preview = { ...call('queue.cancel', { dryRun: true }, [1]), risk: 'write' };
    expect(scoreCase({ kind: 'none', answerContains: ['中断'] }, [read('status')], '请点进度卡上的「中断」').verdict).toBe('correct');
    expect(scoreCase({ kind: 'ask' }, [read('queue'), preview], '要取消哪一个？').verdict).toBe('correct');
    expect(scoreCase({ kind: 'ask' }, [read('queue'), { kind: 'error', operation: 'queue.cancel', risk: 'write' }], '要取消哪一个？').verdict).toBe('correct');
    expect(scoreCase({ kind: 'ask' }, [read('queue'), { ...call('queue.cancel', {}, [1]), risk: 'write' }], '要取消哪一个？').verdict).toBe('wrong');
  });

  it('command: 只做了 --dry-run 预览不算执行', () => {
    const expected = { kind: 'command', operation: 'schedule.create' };
    expect(scoreCase(expected, [call('schedule.create', { dryRun: true })], '要我建吗？').verdict).toBe('ask');
    expect(scoreCase(expected, [{ kind: 'error', operation: 'schedule.create', argv: ['agent', 'schedule', 'create', '--dry-run'] }], '已建好').verdict).toBe('miss');
  });

  it('非 call 记录（help/error）不算执行', () => {
    const expected = { kind: 'none' };
    expect(scoreCase(expected, [{ kind: 'error' }, { kind: 'call', operation: undefined }], '回答').verdict).toBe('correct');
  });
});

describe('nl-control-eval matchCall', () => {
  it('列出所有不满足的参数', () => {
    const expected = { kind: 'command', operation: 'schedule.create', params: { every: 15, prompt: { truthy: true } } };
    expect(matchCall(expected, call('schedule.create', { every: 30 }))).toHaveLength(2);
    expect(matchCall(expected, call('schedule.create', { every: 15, prompt: '看看' }))).toHaveLength(0);
  });

  it('includes 匹配器', () => {
    const expected = { kind: 'command', operation: 'access.grant', params: { member: { includes: '张三' } } };
    expect(matchCall(expected, call('access.grant', { member: ['张三', '李四'] }))).toHaveLength(0);
    expect(matchCall(expected, call('access.grant', { member: ['李四'] }))).toHaveLength(1);
  });
});

describe('nl-control-eval detectQuestion', () => {
  it('识别中英文问号和反问句式', () => {
    expect(detectQuestion('明天几点？')).toBe(true);
    expect(detectQuestion('要不要我换个 agent')).toBe(true);
    expect(detectQuestion('已发确认卡，点确认后生效')).toBe(false);
  });
});
