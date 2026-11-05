import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, RuntimeError, writeTaskReport, type Session } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { MattersService } from './matters.js';
import { SessionAutomationService } from './session-automation.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const scheduleInput = {
  name: 'Daily rebase',
  prompt: 'rebase agent-context',
  trigger: { kind: 'interval' as const, everySeconds: 60, anchorAt: '2026-09-12T00:00:00.000Z' },
  timezone: 'UTC',
  dstPolicy: { gap: 'skip' as const, overlap: 'first' as const },
  condition: { kind: 'always' as const },
  mode: 'session' as const
};

/** 真实 SQLite + Runtime + 本地 JSONL Agent（输出 echo:<收到的完整 prompt>）；回报与日志用桩记录。 */
async function fixture(origin: 'lark' | 'web' = 'lark') {
  const directory = await mkdtemp(join(tmpdir(), 'automation-problems-'));
  const sentLog = join(directory, 'sent.jsonl');
  const gate = join(directory, 'gate');
  await mkdir(gate);
  await writeFile(join(gate, 'release'), '1');
  const repos = createRepositories(join(directory, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const agent = agentConfigSchema.parse({
    id: 'native', name: 'Native fixture', protocol: 'jsonl', command: process.execPath,
    args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')],
    cwd: directory, env: { turn_agent_submission_log: sentLog, turn_agent_gate_dir: gate },
    permissionMode: 'ask', timeout: 15, capabilities: { pause: false, resume: true }
  });
  const clock = { value: new Date('2026-09-12T00:00:30.000Z') };
  /** 下一轮计划任务提交前写入的收尾报告（模拟 Agent 调 session report）。 */
  const report: { value?: { status: 'blocked'; summary: string } | { status: 'waiting'; question: string } } = {};
  let service!: SessionAutomationService;
  const runtime = new DutydeckRuntime(repos, {
    matterTracking: new MattersService(repos),
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
    probe: () => ({ available: true, protocol: 'jsonl', pause: false, resume: true }),
    authorizeExecution: async (id, actorId) => { await service.authorizeExecutionSession(id, actorId); },
    prepareTaskPrompt: async (_s, prompt) => ({ agentPrompt: prompt }),
    // 与 service.ts 相同：计划结果的衔接说明拼在本轮 prompt 前面。
    sessionPrompt: async (session, prompt) => { const extra = await service.resultContext?.(session); return extra ? `${extra}\n\n${prompt}` : prompt; },
    authorizeTask: async (_session, task, phase) => {
      await service.authorizeTask(task, phase);
      if (phase === 'submit' && report.value && task.prompt === scheduleInput.prompt) {
        await writeTaskReport(repos.config, { schemaVersion: 1, taskId: task.id, sessionId: task.sessionId, ...report.value, reportedAt: new Date().toISOString() });
      }
    }
  });
  const deliver = vi.fn(async (_sessionId: string, _result: unknown, occurrenceId: string) => ({ messageId: `om_result_${occurrenceId.slice(-6)}` }));
  const onScheduleProblem = vi.fn(async (_schedule: unknown, notice: { occurrenceId: string; text: string; messageId?: string }) => ({ messageId: notice.messageId ?? 'om_notice' }));
  const onScheduleDisabled = vi.fn(async () => {});
  const warn = vi.fn();
  service = new SessionAutomationService({ repositories: repos, runtime, authorize: async () => true, clock: () => new Date(clock.value),
    deliver, onScheduleProblem, onScheduleDisabled, log: { warn } });
  await runtime.initialize([agent]);
  const owner = origin === 'lark' ? 'ou_owner' : 'installation_owner';
  const parent: Session = await runtime.start({ agentId: 'native', cwd: directory, ...(origin === 'lark' ? { source: 'lark', sourceId: 'cli_app:oc_owner:root' } : {}), permissionMode: 'ask' });
  cleanup.push(async () => { await service.close(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const sent = async () => existsSync(sentLog) ? (await readFile(sentLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string) : [];
  const occurrences = async () => (await repos.config.list('session_automation/occurrence/')).map(row => JSON.parse(row.value))
    .sort((a, b) => a.scheduledForUtc.localeCompare(b.scheduledForUtc) || a.createdAt.localeCompare(b.createdAt));
  const schedule = async (id: string) => JSON.parse((await repos.config.get(`session_automation/schedule/${id}`))!);
  /** legacy：去掉 mode 字段，等同 10-26 之前建的计划（线上的 Open Lark、每日 rebase 都是这样）。 */
  const enabled = async (legacy = false) => {
    const created = await service.createSchedule(parent.id, scheduleInput, owner);
    if (legacy) {
      const key = `session_automation/schedule/${created.id}`;
      const { mode: _mode, ...record } = JSON.parse((await repos.config.get(key))!);
      await repos.config.set(key, JSON.stringify(record));
    }
    await service.updateSchedule(parent.id, created.id, { expectedRevision: created.revision, enabled: true }, owner);
    return created;
  };
  /** 推到第 minute 分 30 秒并等这一分钟的触发结束（不再是 pending/accepted）。 */
  const runMinute = async (minute: number, count: number) => {
    clock.value = new Date(`2026-09-12T00:0${minute}:30.000Z`);
    await vi.waitFor(async () => {
      await service.tick();
      const all = await occurrences();
      expect(all.length).toBeGreaterThanOrEqual(count);
      expect(all.every(item => !['pending', 'accepted'].includes(item.runStatus))).toBe(true);
    }, { timeout: 10_000, interval: 20 });
    await service.tick();
  };
  return { repos, runtime, service, parent, owner, report, deliver, onScheduleProblem, onScheduleDisabled, warn, sent, occurrences, schedule, enabled, runMinute,
    setClock: (date: Date) => { clock.value = date; } };
}

const revoke = (runtime: DutydeckRuntime, sessionId: string) => (runtime as unknown as { lifecycle(id: string): { revoke(): void } }).lifecycle(sessionId).revoke();

describe('schedule trigger errors', () => {
  it('11-03: an existing thread loop whose source session lock was revoked still runs, in a fresh session, and reports to the thread', async () => {
    const f = await fixture();
    const created = await f.enabled(true);
    // 11-03 的现场：空闲回收没收干净，来源会话仍是 idle，但会话锁已撤销，派给它的任何任务都会报 OPERATION_REVOKED。
    revoke(f.runtime, f.parent.id);
    await expect(f.runtime.dispatch(f.parent.id, 'probe', 'queue', undefined, undefined, f.owner)).rejects.toMatchObject({ code: 'OPERATION_REVOKED' });
    expect((await f.runtime.getSession(f.parent.id))?.state).toBe('idle');
    await f.runMinute(1, 1);
    const [occurrence] = await f.occurrences();
    expect(occurrence).toMatchObject({ runStatus: 'completed', sessionId: f.parent.id });
    expect(occurrence.executionSessionId).toMatch(/^ses_schedule_[a-f0-9]{64}$/);
    expect((await f.schedule(created.id)).mode).toBe('fresh');
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledWith(f.parent.id, expect.anything(), occurrence.id, created.id, expect.anything()));
    expect(await f.sent()).toEqual([scheduleInput.prompt]);
  }, 30_000);

  it('retries a session-unavailable trigger once in a fresh session and logs the schedule, trigger and code', async () => {
    const f = await fixture();
    const created = await f.enabled();
    revoke(f.runtime, f.parent.id);
    await f.runMinute(1, 2);
    const [original, retry] = await f.occurrences();
    expect(original).toMatchObject({ runStatus: 'error', error: 'The session operation was revoked' });
    expect(retry).toMatchObject({ id: expect.stringMatching(/^occ_retry_/), runStatus: 'completed', scheduledForUtc: original.scheduledForUtc });
    expect(retry.executionSessionId).toMatch(/^ses_schedule_/);
    expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: created.id, occurrenceId: original.id, code: 'OPERATION_REVOKED' }), expect.any(String));
    expect(f.onScheduleProblem).not.toHaveBeenCalled();
    expect((await f.schedule(created.id)).enabled).toBe(true);
    expect(await f.sent()).toEqual([scheduleInput.prompt]);
  }, 30_000);

  it('runs only the retry in a fresh session and returns an explicit session-mode loop to its source session next time', async () => {
    const f = await fixture();
    const created = await f.enabled();
    vi.spyOn(f.runtime, 'dispatchRequest').mockRejectedValueOnce(new RuntimeError('SESSION_STOPPING', 'Session is stopping', 409));
    await f.runMinute(1, 2);
    const [, retry] = await f.occurrences();
    expect(retry).toMatchObject({ id: expect.stringMatching(/^occ_retry_/), runStatus: 'completed' });
    expect(retry.executionSessionId).toMatch(/^ses_schedule_/);
    await f.runMinute(2, 3);
    const next = (await f.occurrences())[2];
    expect(next).toMatchObject({ runStatus: 'completed', sessionId: f.parent.id });
    expect(next.executionSessionId).toBeUndefined();
    expect(await f.schedule(created.id)).toMatchObject({ mode: 'session', enabled: true });
    expect((await f.schedule(created.id)).executionSessionId).toBeUndefined();
    expect((await f.runtime.getSession(retry.executionSessionId))?.archivedAt).toEqual(expect.any(String));
  }, 30_000);

  it('retries only once: when the fresh retry is also unavailable it says so in the thread instead of looping', async () => {
    const f = await fixture();
    const created = await f.enabled();
    vi.spyOn(f.runtime, 'dispatchRequest').mockRejectedValue(new RuntimeError('OPERATION_REVOKED', 'The session operation was revoked', 409));
    await f.runMinute(1, 2);
    await vi.waitFor(async () => { await f.service.tick(); expect(f.onScheduleProblem).toHaveBeenCalledOnce(); });
    const all = await f.occurrences();
    expect(all.map(item => item.runStatus)).toEqual(['error', 'error']);
    expect(all[1].id).toMatch(/^occ_retry_/);
    expect(f.onScheduleProblem.mock.calls[0]![1]).toMatchObject({ occurrenceId: all[1].id, text: '定时计划『Daily rebase』这次没跑起来：执行会话被锁住了。下次 2026/9/12 00:02:00 再跑。' });
    await f.service.tick();
    expect(await f.occurrences()).toHaveLength(2);
    expect((await f.schedule(created.id)).enabled).toBe(true);
  }, 30_000);

  it('tells the thread what went wrong and when it runs next, edits that message on repeats, and pauses after three', async () => {
    const f = await fixture();
    const created = await f.enabled();
    vi.spyOn(f.runtime, 'dispatchRequest').mockRejectedValue(new RuntimeError('USAGE_CAP_REACHED', '本月用量已达上限', 429));
    await f.runMinute(1, 1);
    await vi.waitFor(async () => { await f.service.tick(); expect(f.onScheduleProblem).toHaveBeenCalledTimes(1); });
    expect(f.onScheduleProblem.mock.calls[0]![1]).toEqual({ occurrenceId: (await f.occurrences())[0].id, text: '定时计划『Daily rebase』这次没跑起来：本月用量已达上限。下次 2026/9/12 00:02:00 再跑。' });
    expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: created.id, code: 'USAGE_CAP_REACHED' }), expect.any(String));
    await f.runMinute(2, 2);
    await vi.waitFor(async () => { await f.service.tick(); expect(f.onScheduleProblem).toHaveBeenCalledTimes(2); });
    expect(f.onScheduleProblem.mock.calls[1]![1]).toMatchObject({ messageId: 'om_notice', text: '定时计划『Daily rebase』已连续 2 次没做成：本月用量已达上限。下次 2026/9/12 00:03:00 再跑。' });
    await f.runMinute(3, 3);
    await vi.waitFor(async () => { await f.service.tick(); expect(f.onScheduleProblem).toHaveBeenCalledTimes(3); });
    expect(f.onScheduleProblem.mock.calls[2]![1]).toMatchObject({ messageId: 'om_notice', text: '定时计划『Daily rebase』已连续 3 次没做成：本月用量已达上限。' });
    expect(await f.schedule(created.id)).toMatchObject({ enabled: false, disabledReason: '连续 3 次没做成（本月用量已达上限）' });
    await vi.waitFor(async () => { await f.service.tick(); expect(f.onScheduleDisabled).toHaveBeenCalledOnce(); });
    // 恢复（用户说一声，Agent 代办 schedule enable）后重新计数。
    const current = await f.service.getScheduleDefinition(f.parent.id, created.id, f.owner);
    await f.service.updateSchedule(f.parent.id, created.id, { expectedRevision: current.revision, enabled: true }, f.owner);
    await f.runMinute(4, 4);
    await vi.waitFor(async () => { await f.service.tick(); expect(f.onScheduleProblem).toHaveBeenCalledTimes(4); });
    expect(f.onScheduleProblem.mock.calls[3]![1].text).toContain('这次没跑起来');
    expect((await f.schedule(created.id)).enabled).toBe(true);
  }, 40_000);
});

describe('agent-reported outcomes', () => {
  it('records a blocked report as not done, edits the first result card on repeats, and pauses after three', async () => {
    const f = await fixture();
    const created = await f.enabled(true);
    f.report.value = { status: 'blocked', summary: 'rebase 冲突 3 个文件。' };
    await f.runMinute(1, 1);
    const [first] = await f.occurrences();
    expect(first).toMatchObject({ runStatus: 'failed', error: '受阻：rebase 冲突 3 个文件。' });
    // 执行账本不变：任务本身照旧是完成。
    expect(f.repos.execution.getTaskExecution(first.taskId)?.task.status).toBe('completed');
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    expect(f.onScheduleProblem).not.toHaveBeenCalled();
    await f.runMinute(2, 2);
    await vi.waitFor(async () => { await f.service.tick(); expect(f.onScheduleProblem).toHaveBeenCalledOnce(); });
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.onScheduleProblem.mock.calls[0]![1]).toMatchObject({ messageId: `om_result_${first.id.slice(-6)}`,
      text: '定时计划『Daily rebase』已连续 2 次没做成：受阻：rebase 冲突 3 个文件。下次 2026/9/12 00:03:00 再跑。' });
    expect((await f.occurrences())[1].delivery.status).toBe('not_requested');
    await f.runMinute(3, 3);
    await vi.waitFor(async () => { await f.service.tick(); expect(f.onScheduleProblem).toHaveBeenCalledTimes(2); });
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(await f.schedule(created.id)).toMatchObject({ enabled: false, disabledReason: '连续 3 次没做成（受阻：rebase 冲突 3 个文件）' });
  }, 40_000);

  it('starts over when the reason changes or a run succeeds', async () => {
    const f = await fixture();
    await f.enabled();
    f.report.value = { status: 'blocked', summary: 'rebase 冲突' };
    await f.runMinute(1, 1);
    f.report.value = { status: 'waiting', question: '选 merge 还是停用？' };
    await f.runMinute(2, 2);
    f.report.value = undefined;
    await f.runMinute(3, 3);
    f.report.value = { status: 'waiting', question: '选 merge 还是停用？' };
    await f.runMinute(4, 4);
    expect((await f.occurrences()).map(item => item.runStatus)).toEqual(['failed', 'failed', 'completed', 'failed']);
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledTimes(4));
    await f.service.tick();
    expect(f.onScheduleProblem).not.toHaveBeenCalled();
  }, 40_000);
});

describe('one thread, clean context per run', () => {
  it('the first fresh run of a converted loop gets the result of its last run in the source session', async () => {
    const f = await fixture();
    const created = await f.enabled();
    await f.runMinute(1, 1);
    // 部署前的旧记录没有 mode 字段：去掉后下一次触发改为新会话。
    const key = `session_automation/schedule/${created.id}`;
    const { mode: _mode, ...record } = JSON.parse((await f.repos.config.get(key))!);
    await f.repos.config.set(key, JSON.stringify(record));
    await f.runMinute(2, 2);
    const [first, second] = await f.occurrences();
    expect(first.executionSessionId ?? first.sessionId).toBe(f.parent.id);
    expect(second.executionSessionId).toMatch(/^ses_schedule_/);
    expect((await f.sent())[1]).toMatch(/^上一次运行（2026\/9\/12 00:01:00，完成）的结果摘要/);
  }, 30_000);

  it('keeps an old loop in its source session once the user explicitly sets session mode', async () => {
    const f = await fixture();
    const created = await f.enabled(true);
    expect((await f.schedule(created.id)).mode).toBeUndefined();
    const current = await f.service.getScheduleDefinition(f.parent.id, created.id, f.owner);
    await f.service.updateSchedule(f.parent.id, created.id, { expectedRevision: current.revision, mode: 'session' }, f.owner);
    expect((await f.schedule(created.id)).mode).toBe('session');
    await f.runMinute(1, 1);
    const [occurrence] = await f.occurrences();
    expect(occurrence.runStatus).toBe('completed');
    expect(occurrence.executionSessionId ?? occurrence.sessionId).toBe(f.parent.id);
    expect((await f.schedule(created.id)).mode).toBe('session');
  }, 30_000);

  it('records an explicit session mode when the Agent re-requests an old loop by name', async () => {
    const f = await fixture();
    const created = await f.service.createSchedule(f.parent.id, scheduleInput, f.owner);
    const key = `session_automation/schedule/${created.id}`;
    const { mode: _mode, ...record } = JSON.parse((await f.repos.config.get(key))!);
    await f.repos.config.set(key, JSON.stringify(record));
    // 停用的同名旧计划由代建请求兼容更新；明确要 session 时要记下来，否则启用后会被当成旧计划改成新会话。
    await f.service.requestSchedule(f.parent.id, { ...scheduleInput, mode: 'session' }, f.owner, { key: 'same-name-session' });
    expect((await f.schedule(created.id)).mode).toBe('session');
  }, 30_000);

  it('keeps a loop that explicitly chose session mode in its source session', async () => {
    const f = await fixture();
    const created = await f.enabled();
    await f.runMinute(1, 1);
    const [occurrence] = await f.occurrences();
    expect(occurrence.executionSessionId ?? occurrence.sessionId).toBe(f.parent.id);
    expect((await f.schedule(created.id)).mode).toBe('session');
  }, 30_000);

  it('existing loops start each run from a clean context with only the previous result, and a follow-up in the thread gets the latest result', async () => {
    const f = await fixture();
    await f.enabled(true);
    await f.runMinute(1, 1);
    await f.runMinute(2, 2);
    const [first, second] = await f.occurrences();
    expect(first.executionSessionId).not.toBe(second.executionSessionId);
    const prompts = await f.sent();
    expect(prompts[0]).toBe(scheduleInput.prompt);
    expect(prompts[1]).toMatch(/^上一次运行（2026\/9\/12 00:01:00，完成）的结果摘要，只作参考，这次照计划重新做：\necho:rebase agent-context\n\nrebase agent-context$/);
    // 用户在原话题跟进：原会话没有跑过这两次，但接手时带上最近一次的结果；之后的追问不再重复。
    const follow = await f.runtime.dispatch(f.parent.id, 'what failed?', 'queue', undefined, undefined, f.owner);
    await vi.waitFor(() => expect(f.repos.execution.getTaskExecution(follow.id)?.task.status).toBe('completed'), { timeout: 10_000, interval: 20 });
    const again = await f.runtime.dispatch(f.parent.id, 'and then?', 'queue', undefined, undefined, f.owner);
    await vi.waitFor(() => expect(f.repos.execution.getTaskExecution(again.id)?.task.status).toBe('completed'), { timeout: 10_000, interval: 20 });
    const [, , followPrompt, againPrompt] = await f.sent();
    expect(followPrompt).toContain('本话题的定时计划『Daily rebase』最近一次（2026/9/12 00:02:00）在单独的会话里运行，完成，结果如下');
    expect(followPrompt).toContain(second.result.output.text.slice(-200));
    expect(followPrompt.endsWith('\n\nwhat failed?')).toBe(true);
    expect(againPrompt).toBe('and then?');
  }, 40_000);
});
