import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { canonicalExecutionJson, type AcceptedTaskInput, type EventType, type RepositoryBundle, type RuntimeControlClaim, type TaskAttempt, type TaskRequestV1 } from '@dutydeck/shared';
import { larkAttemptActivity, larkLastActivityAt, larkLastActivityFrom, larkReplayUnsafeReason, larkToolEvents } from './turn-redispatch.js';

/**
 * 重投判定按 attempt 索引只读事件数、事件时间（getAttemptActivity）和工具事件（getAttemptToolEvents），
 * 与原来「读整段会话 → 按 attempt 过滤 → larkReplayUnsafeReason / larkLastActivityAt」逐项比对。
 */

const opened: Array<{ repos: RepositoryBundle; claim: RuntimeControlClaim; dir: string }> = [];
afterEach(() => {
  for (const item of opened.splice(0)) { item.claim.release(); item.repos.close(); rmSync(item.dir, { recursive: true, force: true }); }
});
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const input = (): AcceptedTaskInput => { const content = { version: 2 as const, executionOptions: { permissionMode: 'ask' as const }, prompt: 'hello', executionContext: { agentPrompt: 'hello' }, contentSources: [] }; return { ...content, digest: hash(content) }; };
const request = (sessionId: string, key: string): TaskRequestV1 => ({ version: 1, namespace: 'runtime', key, sessionId, actor: { kind: 'unspecified' }, prompt: 'hello', mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: null });
const af = (a: TaskAttempt) => ({ sessionId: a.sessionId, runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, expectedRevision: a.revision });

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-replay-evidence-'));
  const repos = createRepositories(join(dir, 'state.sqlite'));
  repos.execution.upgradeLegacy();
  const claim = repos.control.attachRuntime('replay-evidence-test');
  opened.push({ repos, claim, dir });
  const x = repos.execution.bind(claim);
  const session = (id: string) => x.createSession({ id, runId: 'r', agentId: 'a', cwd: '/tmp', state: 'idle', protocol: 'acp', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  let current: TaskAttempt | undefined;
  /** 开始下一轮（先结束上一轮），返回这一轮的 attempt。 */
  const attempt = (sessionId: string, key: string) => {
    if (current) {
      const sent = x.markSubmitted(af(current), { submissionId: `send-${current.taskId}`, kind: 'provider_accepted', provider: 'fixture', receiptRef: `remote:${current.taskId}`, digest: hash(current.taskId) }).attempt!;
      x.settleAttempt(af(sent), `done-${current.taskId}`, { kind: 'driver_result', submissionId: `send-${current.taskId}`, outcome: 'completed', outputDigest: hash('done'), stopReason: 'end_turn', complete: true });
    }
    const fence = { sessionId, runId: 'r' };
    x.acceptTask(fence, request(sessionId, key), input(), 'back');
    const claimed = x.claimNext(fence)!.attempt!;
    current = x.markSubmissionPending(af(claimed), { submissionId: `send-${claimed.taskId}`, inputDigest: hash('final'), resourceRefs: [], authorizationRefs: ['policy:1'] }).attempt!;
    return current;
  };
  let serial = 0;
  const append = (a: TaskAttempt, type: EventType, data: unknown, timestamp?: string) =>
    x.appendEvent(af(current!.attemptId === a.attemptId ? current! : a), { id: `event-${++serial}`, type, data, ...(timestamp !== undefined ? { timestamp } : {}) });
  return { repos, session, attempt, append };
}

/** 原实现：整段会话读出来按 attempt 过滤。 */
async function before(repos: RepositoryBundle, sessionId: string, attemptId: string, startedAt: string) {
  const own = (await repos.events.list(sessionId)).filter(event => event.attemptId === attemptId);
  return { hasEvents: own.length > 0, unsafe: larkReplayUnsafeReason(own), lastActivity: larkLastActivityAt(own, startedAt), evidence: { ...larkAttemptActivity(own), toolEvents: larkToolEvents(own) } };
}
function after(repos: RepositoryBundle, sessionId: string, attemptId: string, startedAt: string) {
  const evidence = { ...repos.execution.getAttemptActivity(sessionId, attemptId), toolEvents: repos.execution.getAttemptToolEvents(sessionId, attemptId) };
  return { hasEvents: evidence.eventCount > 0, unsafe: larkReplayUnsafeReason(evidence.toolEvents), lastActivity: larkLastActivityFrom(evidence.activityTimestamps, startedAt), evidence };
}
// 两条读取路径对空列的解码不同（整段读取带 raw: null、settlementId: null，按 attempt 读不带），判定只看下面这些字段。
const comparable = (result: Awaited<ReturnType<typeof before>>) => ({ ...result, evidence: { ...result.evidence,
  toolEvents: result.evidence.toolEvents.map(({ id, sessionId, sequence, type, timestamp, data, taskId, attemptId }) => ({ id, sessionId, sequence, type, timestamp, data, taskId, attemptId })) } });
async function expectSame(repos: RepositoryBundle, sessionId: string, attempt: TaskAttempt) {
  const old = await before(repos, sessionId, attempt.attemptId, attempt.createdAt);
  expect(comparable(after(repos, sessionId, attempt.attemptId, attempt.createdAt))).toEqual(comparable(old));
  return old;
}

/** 可复现的伪随机数（mulberry32）。 */
function random(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const pick = <T,>(next: () => number, values: readonly T[]) => values[Math.floor(next() * values.length)]!;

describe('attempt replay evidence matches reading the whole session', () => {
  it('keeps each attempt of a multi-turn session separate', async () => {
    const h = ledger();
    h.session('s');
    const pushed = h.attempt('s', 'one');
    h.append(pushed, 'text', { text: 'working' }, '2026-10-02T01:00:00.000Z');
    h.append(pushed, 'tool_call', { id: 'c1', name: 'Bash', status: 'running', input: {} }, '2026-10-02T01:01:00.000Z');
    h.append(pushed, 'tool_result', { id: 'c1', name: 'tool', input: { command: 'git push origin main' } }, '2026-10-02T01:02:00.000Z');
    h.append(pushed, 'task', { task: { id: pushed.taskId, status: 'running' } }, '2026-10-02T09:00:00.000Z');
    const reads = h.attempt('s', 'two');
    h.append(reads, 'tool_call', { id: 'c2', name: 'Read', input: { file_path: '/work/notes.md' } }, '2026-10-03T01:00:00.000Z');
    h.append(reads, 'status', { state: 'thinking' }, '2026-10-03T08:00:00.000Z');
    const empty = h.attempt('s', 'three');

    // 账本自己也会给每一轮记几条事件（时间为写入时刻），所以这里只核对判定，不核对具体时间。
    expect(await expectSame(h.repos, 's', pushed)).toMatchObject({ hasEvents: true, unsafe: '执行过 git push' });
    expect(await expectSame(h.repos, 's', reads)).toMatchObject({ hasEvents: true, unsafe: undefined });
    expect(await expectSame(h.repos, 's', empty)).toMatchObject({ unsafe: undefined });
  });

  it('agrees on a single attempt with thousands of mixed, out-of-order events', async () => {
    const h = ledger();
    h.session('s');
    const one = h.attempt('s', 'big');
    const next = random(7);
    const types = ['text', 'tool_call', 'tool_result', 'task', 'status', 'raw_terminal', 'thinking'] as const satisfies readonly EventType[];
    const names = ['Read', 'Grep', 'Bash', 'tool', 'Edit', 'SendMessage', '', 'mcp__fixture__write'];
    const commands = ['ls -la', 'cat README.md', 'git status', 'pnpm test', 'git push origin main', 'curl -X POST https://example.invalid'];
    for (let index = 0; index < 3_000; index++) {
      const type = pick(next, types);
      // 时间不按序号递增：最后活动时间取最大的时间，不是最后一条的时间。
      const timestamp = new Date(Date.parse('2026-10-05T00:00:00.000Z') + Math.floor(next() * 86_400_000)).toISOString();
      const data = type === 'tool_call' || type === 'tool_result'
        ? { ...(next() < 0.8 ? { id: `call-${Math.floor(next() * 400)}` } : {}), name: pick(next, names), ...(next() < 0.5 ? { input: next() < 0.6 ? { command: pick(next, commands) } : { file_path: '/work/a.txt' } } : {}) }
        : type === 'task' ? { task: { id: one.taskId, status: 'running' } } : { text: `event ${index}` };
      h.append(one, type, data, timestamp);
    }
    const result = await expectSame(h.repos, 's', one);
    expect(result.evidence.eventCount).toBeGreaterThanOrEqual(3_000);
    expect(result.evidence.toolEvents.length).toBeGreaterThan(500);
  }, 60_000);

  it('agrees on many randomized attempts, including ones without tool calls or with only task events', async () => {
    const h = ledger();
    h.session('s');
    const next = random(42);
    const attempts: TaskAttempt[] = [];
    for (let turn = 0; turn < 30; turn++) {
      const a = h.attempt('s', `turn-${turn}`);
      attempts.push(a);
      const shape = turn % 3; // 0：混合；1：没有工具调用；2：只有 task/status
      const count = Math.floor(next() * 40);
      for (let index = 0; index < count; index++) {
        const type = shape === 2 ? pick(next, ['task', 'status'] as const) : shape === 1 ? pick(next, ['text', 'thinking', 'status'] as const) : pick(next, ['text', 'tool_call', 'tool_result', 'task'] as const);
        const data = type === 'tool_call' || type === 'tool_result'
          ? { id: `t${turn}-${Math.floor(next() * 5)}`, name: pick(next, ['Read', 'Bash', 'tool']), ...(next() < 0.5 ? { input: { command: pick(next, ['ls', 'git push', 'rm -rf build']) } } : {}) }
          : { text: `turn ${turn} event ${index}` };
        h.append(a, type, data, new Date(Date.parse('2026-10-06T00:00:00.000Z') + Math.floor(next() * 3_600_000)).toISOString());
      }
    }
    const results = [];
    for (const a of attempts) results.push(await expectSame(h.repos, 's', a));
    // 数据要真的覆盖两种判定，比对才有意义。
    expect(results.some(result => result.unsafe)).toBe(true);
    expect(results.some(result => result.hasEvents && !result.unsafe)).toBe(true);
  }, 60_000);
});
