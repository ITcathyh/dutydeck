import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { Session, TaskRequestV1 } from '@dutydeck/shared';
import { classifyUsage, cumulativeDelta, defaultUsagePricing, estimateCostUsd, measureUsage, parseUsagePricing, UsageLedger, type UsageLedgerOptions } from './usage-ledger.js';

const at = '2026-09-25T00:00:00.000Z';
const session = (id: string, source: string | undefined, sourceId?: string, agentId = 'claude'): Session => ({ id, agentId, state: 'idle', cwd: '/tmp', source, sourceId, runId: `run_${id}`, createdAt: at, updatedAt: at } as Session);
const request = (patch: Partial<TaskRequestV1>): TaskRequestV1 => ({ version: 1, namespace: 'runtime', key: 'request_1', sessionId: 'ses', actor: { kind: 'unspecified' }, prompt: 'p', mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: {}, ...patch });
const group = session('ses_group', 'lark', 'cli_a:oc_1:group:thread:om_root');

function harness(options: Partial<UsageLedgerOptions> & { requests?: Record<string, TaskRequestV1>; now?: () => Date } = {}) {
  const repos = createRepositories(':memory:');
  const requests = options.requests ?? {};
  const notify = vi.fn(async () => {});
  const ledger = new UsageLedger({
    repositories: { usage: repos.usage, sessions: repos.sessions, agents: repos.agents, execution: { getAcceptedTask: (id: string) => requests[id] ? { request: requests[id] } : undefined } as any },
    notify, now: () => new Date('2026-09-25T08:00:00'), ...options
  });
  return { repos, ledger, notify };
}

describe('usage measurement', () => {
  it('diffs cumulative cost against the previous reading and restarts from a smaller reading', () => {
    expect(cumulativeDelta(undefined, 0.25)).toBe(0.25);
    expect(cumulativeDelta(0.25, 0.75)).toBe(0.5);
    expect(cumulativeDelta(0.75, 0.75)).toBe(0);
    expect(cumulativeDelta(0.75, 0.1)).toBe(0.1);
  });

  it('counts per-turn tokens once and prefers the reported cost over an estimate', () => {
    const reading = { usageRef: 'req_1', breakdown: { inputTokens: 1000, outputTokens: 100, cachedReadTokens: 400, cachedWriteTokens: 50 }, cost: { amount: 0.75, currency: 'USD' } };
    expect(measureUsage({ reading, freshTokens: true, baselineCostUsd: 0.25, pricing: defaultUsagePricing })).toEqual({
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50, usageRef: 'req_1', costUsd: 0.5, costEstimated: false, dataStatus: 'reported', cumulativeCostUsd: 0.75
    });
    // 同一个 usageRef 再次出现：token 不再计入，成本照常求差。
    expect(measureUsage({ reading, freshTokens: false, baselineCostUsd: 0.75, pricing: defaultUsagePricing })).toEqual({ costUsd: 0, costEstimated: false, dataStatus: 'reported', cumulativeCostUsd: 0.75 });
  });

  it('estimates codex turns from tokens with the price table and marks them as estimates', () => {
    // 适配器报的 inputTokens 已扣掉缓存命中，缓存单列：这是 100 万输入（其中 60 万命中缓存）+ 10 万输出。
    const tokens = { inputTokens: 400_000, outputTokens: 100_000, cacheReadTokens: 600_000 };
    // gpt-5 前缀：40 万非缓存 × 1.25 + 60 万缓存 × 0.125 + 10 万输出 × 10，单位百万 token。
    expect(estimateCostUsd(defaultUsagePricing, 'gpt-5-codex', tokens)).toBeCloseTo(0.5 + 0.075 + 1);
    expect(estimateCostUsd(defaultUsagePricing, 'gpt-5-mini', tokens)).toBeCloseTo(0.1 + 0.015 + 0.2);
    expect(estimateCostUsd(defaultUsagePricing, undefined, tokens)).toBeCloseTo(0.5 + 0.075 + 1);
    const measured = measureUsage({ reading: { usageRef: 'req_2', breakdown: { inputTokens: 400_000, outputTokens: 100_000, cachedReadTokens: 600_000 } }, freshTokens: true, model: 'gpt-5-codex', pricing: defaultUsagePricing });
    expect(measured).toMatchObject({ costEstimated: true, dataStatus: 'estimated', inputTokens: 400_000, cacheReadTokens: 600_000 });
    expect(measured.costUsd).toBeCloseTo(1.575);
    expect(measureUsage({ freshTokens: false, pricing: defaultUsagePricing })).toEqual({ costEstimated: false, dataStatus: 'unavailable' });
    const custom = parseUsagePricing(JSON.stringify({ default: { inputPerMTok: 1, cachedInputPerMTok: 1, outputPerMTok: 1 }, models: [] }));
    expect(estimateCostUsd(custom, 'gpt-5', { inputTokens: 1_000_000 })).toBe(1);
    expect(() => parseUsagePricing('{"default":{}}')).toThrow();
  });
});

describe('usage classification', () => {
  it('maps task origins to the four source categories', () => {
    const lark = request({ key: 'lark:cli_a:om_1:1', actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } });
    expect(classifyUsage(group, lark, false)).toEqual({ category: 'explicit', origin: 'lark_group' });
    expect(classifyUsage(session('p', 'lark', 'cli_a:oc_p:p2p'), lark, false)).toEqual({ category: 'explicit', origin: 'lark_p2p' });
    expect(classifyUsage(group, request({ actor: { kind: 'installation_owner', id: 'installation_owner' } }), false)).toEqual({ category: 'explicit', origin: 'web' });
    expect(classifyUsage(session('w', undefined), request({}), false)).toEqual({ category: 'explicit', origin: 'web' });
    expect(classifyUsage(group, lark, true)).toEqual({ category: 'proactive', origin: 'participation' });
    expect(classifyUsage(group, request({ namespace: 'schedule' }), false)).toEqual({ category: 'scheduled', origin: 'schedule' });
    expect(classifyUsage(session('m', 'lark', 'cli_a:oc_1:group:collaboration:mandate_1'), request({ namespace: 'schedule' }), false)).toEqual({ category: 'scheduled', origin: 'mandate' });
    expect(classifyUsage(group, request({ namespace: 'automation' }), false)).toEqual({ category: 'scheduled', origin: 'ci' });
    expect(classifyUsage(session('d', 'lark-decision', 'cli_a:oc_1'), request({}), false)).toEqual({ category: 'background', origin: 'decision' });
    expect(classifyUsage(session('r', 'lark-response', 'cli_a:oc_1'), request({}), false)).toEqual({ category: 'background', origin: 'response' });
    expect(classifyUsage(session('mem', 'lark-memory', 'cli_a:groups:memory'), request({}), false)).toEqual({ category: 'background', origin: 'memory' });
  });
});

describe('usage ledger', () => {
  it('records attribution, diffs claude cost across turns and ignores the completion after a reading', async () => {
    const requests = { task_1: request({ key: 'lark:cli_a:om_1:1', actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } }), task_2: request({ key: 'lark:cli_a:om_2:1', actor: { kind: 'channel', id: 'ou_2', appId: 'cli_a' } }) };
    const h = harness({ requests });
    await h.repos.sessions.save(group);
    await h.ledger.record(group, { taskId: 'task_1', attemptId: 'a1' }, { state: 'turn_usage', usageRef: 'r1', breakdown: { inputTokens: 10, outputTokens: 2 }, cost: { amount: 0.25, currency: 'USD' } });
    await h.ledger.record(group, { taskId: 'task_1', attemptId: 'a1' });
    await h.ledger.record(group, { taskId: 'task_2', attemptId: 'a2' }, { state: 'turn_usage', usageRef: 'r2', breakdown: { inputTokens: 5 }, cost: { amount: 0.75, currency: 'USD' } });
    expect(await h.repos.usage.totals({ sessionId: group.id })).toMatchObject({ entries: 2, costUsd: 0.75, inputTokens: 15, outputTokens: 2 });
    expect((await h.repos.usage.summarize('actorId', {})).map(row => [row.actorId, row.costUsd])).toEqual([['ou_2', 0.5], ['ou_1', 0.25]]);
    expect(await h.repos.usage.summarize('chatId', {})).toMatchObject([{ appId: 'cli_a', chatId: 'oc_1', entries: 2 }]);
    h.repos.close();
  });

  it('records a no-data entry for drivers without readings', async () => {
    const pty = session('ses_pty', 'lark', 'cli_a:oc_1:group:chat:oc_1', 'claude-pty');
    const h = harness({ requests: { task_1: request({ actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } }) } });
    await h.repos.sessions.save(pty);
    await h.ledger.record(pty, { taskId: 'task_1', attemptId: 'a1' });
    expect(await h.repos.usage.totals({ sessionId: pty.id })).toMatchObject({ entries: 1, costUsd: 0, unavailable: 1 });
    h.repos.close();
  });

  it('attributes a work-item step to its root task and inherits the root category', async () => {
    const step = session('ses_work_1', 'work_item', 'work_1:step_1:1', 'codex');
    const requests = { root_task: request({ key: 'lark:cli_a:om_9:1', actor: { kind: 'channel', id: 'ou_9', appId: 'cli_a' } }), step_task: request({ namespace: 'work_item', key: 'work_1:step_1:1', actor: { kind: 'channel', id: 'ou_9', appId: 'cli_a' } }) };
    const h = harness({ requests, parentOf: async () => ({ parentSessionId: group.id, parentTaskId: 'root_task' }), isProactive: async (_app, _chat, messageId) => messageId === 'om_9' });
    await h.repos.sessions.save(group);
    await h.repos.sessions.save(step);
    await h.repos.agents.save({ id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'acp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false, model: 'gpt-5-codex' } as any);
    await h.ledger.record(step, { taskId: 'step_task', attemptId: 's1' }, { state: 'turn_usage', usageRef: 'r1', breakdown: { inputTokens: 1_000_000 } });
    const [row] = await h.repos.usage.summarize('category', { rootSessionId: group.id });
    expect(row).toMatchObject({ category: 'proactive', entries: 1 });
    expect(row!.estimatedCostUsd).toBeCloseTo(1.25);
    expect(await h.ledger.sessionUsage(group.id)).toMatchObject({ own: { entries: 0 }, subSteps: { entries: 1 } });
    h.repos.close();
  });

  it('rejects new tasks once a group or bot cap is used up, but never sub-steps', async () => {
    const h = harness({ requests: { t: request({ actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } }) } });
    await h.repos.sessions.save(group);
    const lark = request({ key: 'lark:cli_a:om_1:1', actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } });
    await h.ledger.setCap({ scope: 'group', appId: 'cli_a', chatId: 'oc_1', monthlyCostUsd: 1 });
    await h.ledger.setCap({ scope: 'bot', appId: 'cli_a', monthlyCostUsd: 5 });
    await expect(h.ledger.admit(group, lark)).resolves.toBeUndefined();
    await h.ledger.record(group, { taskId: 't', attemptId: 'a1' }, { usageRef: 'r1', cost: { amount: 1 } });
    await expect(h.ledger.admit(group, lark)).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED', message: expect.stringContaining('本群本月成本已达上限 $1.00（已用 $1.00）') });
    // 别的群只受 Bot 上限约束。
    const other = session('ses_other', 'lark', 'cli_a:oc_2:group:chat:oc_2');
    await expect(h.ledger.admit(other, lark)).resolves.toBeUndefined();
    await h.repos.sessions.save(other);
    await h.ledger.record(other, { taskId: 't', attemptId: 'a2' }, { usageRef: 'r2', cost: { amount: 4 } });
    await expect(h.ledger.admit(other, lark)).rejects.toMatchObject({ message: expect.stringContaining('本机器人本月成本已达上限 $5.00') });
    await expect(h.ledger.admit(session('ses_work', 'work_item', 'w:s:1'), request({ namespace: 'work_item', actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } }))).resolves.toBeUndefined();
    // 下个月重新计算。
    const nextMonth = new UsageLedger({ repositories: { usage: h.repos.usage, sessions: h.repos.sessions, agents: h.repos.agents, execution: {} as any }, now: () => new Date('2026-10-01T08:00:00') });
    await expect(nextMonth.admit(group, lark)).resolves.toBeUndefined();
    h.repos.close();
  });

  it('reminds once at 75% and once at 95%, and retries a reminder whose delivery failed', async () => {
    const h = harness({ requests: { t: request({ actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } }) } });
    await h.repos.sessions.save(group);
    await h.ledger.setCap({ scope: 'group', appId: 'cli_a', chatId: 'oc_1', monthlyCostUsd: 10 });
    const spend = async (attemptId: string, cumulative: number) => {
      await h.ledger.record(group, { taskId: 't', attemptId }, { usageRef: attemptId, cost: { amount: cumulative } });
      await new Promise(resolve => setImmediate(resolve));
    };
    await spend('a1', 5);
    expect(h.notify).not.toHaveBeenCalled();
    h.notify.mockRejectedValueOnce(new Error('lark down'));
    await spend('a2', 8);
    expect(h.notify).toHaveBeenCalledTimes(1);
    await spend('a3', 8.1);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls[1]).toEqual([{ appId: 'cli_a', chatId: 'oc_1' }, expect.stringContaining('本群本月成本已用 $8.10，达到月度上限 $10.00 的 81%'), expect.stringMatching(/^usage_alert_/)]);
    await spend('a4', 9);
    expect(h.notify).toHaveBeenCalledTimes(2);
    await spend('a5', 9.6);
    await spend('a6', 12);
    expect(h.notify).toHaveBeenCalledTimes(3);
    expect(h.notify.mock.calls[2]![1]).toContain('96%');
    h.repos.close();
  });

  it('sends one reminder when a single turn jumps past both thresholds of a bot cap, into the chat where it happened', async () => {
    const h = harness({ requests: { t: request({ actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } }) } });
    await h.repos.sessions.save(group);
    await h.ledger.setCap({ scope: 'bot', appId: 'cli_a', monthlyCostUsd: 1 });
    await h.ledger.record(group, { taskId: 't', attemptId: 'a1' }, { usageRef: 'a1', cost: { amount: 0.99 } });
    await new Promise(resolve => setImmediate(resolve));
    await h.ledger.record(group, { taskId: 't', attemptId: 'a2' }, { usageRef: 'a2', cost: { amount: 1.2 } });
    await new Promise(resolve => setImmediate(resolve));
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]!.slice(0, 2)).toEqual([{ appId: 'cli_a', chatId: 'oc_1' }, expect.stringContaining('本机器人本月成本已用 $0.99')]);
    h.repos.close();
  });

  it('sends one used-up notice per cap and month on the first refusal, into the refused chat for a bot cap', async () => {
    const h = harness();
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const lark = request({ key: 'lark:cli_a:om_1:1', actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } });
    await h.repos.sessions.save(group);
    await h.ledger.setCap({ scope: 'group', appId: 'cli_a', chatId: 'oc_1', monthlyCostUsd: 1 });
    await h.ledger.record(group, { taskId: 't', attemptId: 'a1' }, { usageRef: 'a1', cost: { amount: 1.2 } });
    await settle();
    h.notify.mockClear();
    // 发送失败会释放认领，下一次拒绝重发；发出之后同月不再发，判定前的检查也不再发。
    h.notify.mockRejectedValueOnce(new Error('lark down'));
    await expect(h.ledger.admit(group, lark)).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    await settle();
    await expect(h.ledger.admit(group, lark)).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    expect(await h.ledger.refusal('cli_a', 'oc_1')).toContain('本群本月成本已达上限');
    await settle();
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls[1]).toEqual([{ appId: 'cli_a', chatId: 'oc_1' },
      '用量提醒：本群本月成本已达上限 $1.00（已用 $1.20），新任务不再执行，正在执行的任务不受影响。安装管理员可在 Dutydeck Web 的「用量与成本」里调高上限，否则下月 1 日起重新计算。', expect.stringMatching(/^usage_alert_/)]);

    // Bot 上限发到被拒的群；群记忆池不是群，被拒时不占用这一次通知。
    await h.ledger.setCap({ scope: 'bot', appId: 'cli_a', monthlyCostUsd: 1 });
    await expect(h.ledger.admit(session('ses_mem', 'lark-memory', 'cli_a:groups:memory'), request({ actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } }))).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    const other = session('ses_other', 'lark', 'cli_a:oc_2:group:chat:oc_2');
    await expect(h.ledger.admit(other, lark)).rejects.toMatchObject({ message: expect.stringContaining('本机器人本月成本已达上限 $1.00（已用 $1.20）') });
    await expect(h.ledger.admit(other, lark)).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    await settle();
    expect(h.notify).toHaveBeenCalledTimes(3);
    expect(h.notify.mock.calls[2]!.slice(0, 2)).toEqual([{ appId: 'cli_a', chatId: 'oc_2' }, expect.stringMatching(/^用量提醒：本机器人本月成本已达上限/)]);

    // 下个月重新计算，再用满时再发一次。
    const october = new UsageLedger({ repositories: { usage: h.repos.usage, sessions: h.repos.sessions, agents: h.repos.agents, execution: { getAcceptedTask: () => undefined } as any },
      notify: h.notify, now: () => new Date('2026-10-02T08:00:00') });
    await october.record(group, { taskId: 't', attemptId: 'a2' }, { usageRef: 'a2', cost: { amount: 2.4 } });
    await settle();
    h.notify.mockClear();
    await expect(october.admit(group, lark)).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    await expect(october.admit(group, lark)).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    await settle();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![1]).toContain('用量提醒：本群本月成本已达上限 $1.00（已用 $1.20）');
    h.repos.close();
  });

  it('tells the chat each time a scheduled run is refused after the used-up notice', async () => {
    const h = harness();
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const actor = { kind: 'channel' as const, id: 'ou_1', appId: 'cli_a' };
    await h.repos.sessions.save(group);
    await h.ledger.setCap({ scope: 'group', appId: 'cli_a', chatId: 'oc_1', monthlyCostUsd: 1 });
    await h.ledger.record(group, { taskId: 't', attemptId: 'a1' }, { usageRef: 'a1', cost: { amount: 1 } });
    await settle();
    h.notify.mockClear();
    const run = (key: string) => request({ namespace: 'schedule', key, actor });
    await expect(h.ledger.admit(group, run('session-automation:schedule:occ_1'))).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    await settle();
    await expect(h.ledger.admit(group, run('session-automation:schedule:occ_2'))).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    await expect(h.ledger.admit(group, request({ namespace: 'automation', key: 'session-automation:ci:ci_1', actor }))).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    // 显式请求的说明在话题里的失败卡片上，不再另发。
    await expect(h.ledger.admit(group, request({ key: 'lark:cli_a:om_2:1', actor }))).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    await settle();
    expect(h.notify.mock.calls.map(call => call[1].split('：')[0])).toEqual(['用量提醒', '定时任务本次未执行', '定时任务本次未执行']);
    expect(h.notify.mock.calls[1]).toEqual([{ appId: 'cli_a', chatId: 'oc_1' }, expect.stringContaining('定时任务本次未执行：本群本月成本已达上限 $1.00（已用 $1.00）'), expect.stringMatching(/^usage_blocked_/)]);
    // 同一次运行重试时幂等键不变，飞书按键去重。
    await expect(h.ledger.admit(group, run('session-automation:schedule:occ_2'))).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    await settle();
    expect(h.notify.mock.calls[3]![2]).toBe(h.notify.mock.calls[1]![2]);
    expect(h.notify.mock.calls[2]![2]).not.toBe(h.notify.mock.calls[1]![2]);
    h.repos.close();
  });

  it('describes the current bot and group month usage for /status', async () => {
    const h = harness({ requests: { t: request({ actor: { kind: 'channel', id: 'ou_1', appId: 'cli_a' } }) } });
    await h.repos.sessions.save(group);
    await h.ledger.setCap({ scope: 'group', appId: 'cli_a', chatId: 'oc_1', monthlyCostUsd: 4 });
    await h.ledger.record(group, { taskId: 't', attemptId: 'a1' }, { usageRef: 'a1', cost: { amount: 1 } });
    expect(await h.ledger.describe('cli_a', 'oc_1')).toBe('**本月用量**：本群 $1.00（上限 $4.00，已用 25%） · 本机器人 $1.00（未设上限）');
    expect(await h.ledger.describe('cli_a')).toBe('**本月用量**：本机器人 $1.00（未设上限）');
    h.repos.close();
  });
});
