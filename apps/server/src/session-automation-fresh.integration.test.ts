import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, type Session, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { SessionAutomationService } from './session-automation.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const scheduleInput = {
  name: 'Every minute',
  prompt: 'scheduled automation prompt',
  trigger: { kind: 'interval' as const, everySeconds: 60, anchorAt: '2026-09-12T00:00:00.000Z' },
  timezone: 'UTC',
  dstPolicy: { gap: 'skip' as const, overlap: 'first' as const },
  condition: { kind: 'always' as const },
  mode: 'fresh' as const
};

/**
 * 真实 SQLite + Runtime + 本地 JSONL Agent；gate 目录没有 release 时 Agent 停在当前轮。
 * lark：来源是飞书群、计划身份是群成员；web：来源是 Web 任务、计划身份是安装者，与 Web 路由提交和取消用的身份一致。
 */
async function fixture(origin: 'lark' | 'web' = 'lark') {
  const directory = await mkdtemp(join(tmpdir(), 'automation-fresh-integration-'));
  const gate = join(directory, 'gate');
  const sentLog = join(directory, 'sent.jsonl');
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
  const allowed = { value: true };
  let service!: SessionAutomationService;
  const runtime = new DutydeckRuntime(repos, {
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
    probe: () => ({ available: true, protocol: 'jsonl', pause: false, resume: true }),
    // 与 service.ts 相同：计划执行会话的执行授权先交给计划服务判断。
    authorizeExecution: async (id, actorId) => { await service.authorizeExecutionSession(id, actorId); },
    prepareTaskPrompt: async (_s, prompt) => ({ agentPrompt: prompt }),
    authorizeTask: (_session, task, phase) => service.authorizeTask(task, phase)
  });
  service = new SessionAutomationService({ repositories: repos, runtime, authorize: async () => allowed.value, clock: () => new Date(clock.value) });
  await runtime.initialize([agent]);
  const owner = origin === 'lark' ? 'ou_owner' : 'installation_owner';
  const parent: Session = await runtime.start({ agentId: 'native', cwd: directory, ...(origin === 'lark' ? { source: 'lark', sourceId: 'cli_app:oc_owner:root' } : {}), permissionMode: 'ask' });
  cleanup.push(async () => { await service.close(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const sent = async () => existsSync(sentLog) ? (await readFile(sentLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string) : [];
  const occurrences = async () => (await repos.config.list('session_automation/occurrence/')).map(row => JSON.parse(row.value))
    .sort((a, b) => a.scheduledForUtc.localeCompare(b.scheduledForUtc));
  const taskStatus = (taskId: string) => repos.execution.getTaskExecution(taskId)?.task.status;

  /** 第一次触发跑完后，用户在它的会话里追加两轮：A 正在执行，B 在排队；随后第二次触发换上新会话。 */
  async function retainFirstSessionWithUserWork() {
    const created = await service.createSchedule(parent.id, scheduleInput, owner);
    await service.updateSchedule(parent.id, created.id, { expectedRevision: 1, enabled: true }, owner);
    clock.value = new Date('2026-09-12T00:01:30.000Z');
    await vi.waitFor(async () => { await service.tick(); expect((await occurrences())[0]?.runStatus).toBe('completed'); }, { timeout: 10_000, interval: 20 });
    const [first] = await occurrences();
    const firstSession = first.executionSessionId as string;
    const scheduled = repos.execution.getAcceptedTask(first.taskId)!.request!;
    const follow = (key: string, prompt: string): TaskRequestV1 => ({ ...scheduled, namespace: 'runtime', key, prompt, sources: [], sourcePayload: { agentPrompt: prompt, skills: [] } });

    await unlink(join(gate, 'release'));
    await rm(join(gate, 'entered'), { force: true });
    const running = await runtime.dispatchRequest(follow('user-a', 'user follow-up running'));
    await vi.waitFor(() => expect(existsSync(join(gate, 'entered'))).toBe(true), { timeout: 10_000, interval: 20 });
    expect(taskStatus(running.id)).toBe('running');
    const queued = await runtime.dispatchRequest(follow('user-b', 'user follow-up queued'));
    expect(queued.status).toBe('queued');

    clock.value = new Date('2026-09-12T00:02:30.000Z');
    await service.tick();
    const second = (await occurrences())[1];
    expect(second?.executionSessionId).toMatch(/^ses_schedule_[a-f0-9]{64}$/);
    expect(second.executionSessionId).not.toBe(firstSession);
    expect((await repos.sessions.get(firstSession))?.archivedAt).toBeFalsy();
    return { created, firstSession, running, queued, release: () => writeFile(join(gate, 'release'), '1') };
  }

  return { repos, runtime, allowed, owner, get service() { return service; }, parent, setClock: (date: Date) => { clock.value = date; }, sent, occurrences, taskStatus, retainFirstSessionWithUserWork };
}

describe('fresh schedule sessions kept for unfinished user work (real runtime and SQLite)', () => {
  it('runs the queued user turn in the previous session after the next occurrence switched sessions', async () => {
    const f = await fixture();
    const kept = await f.retainFirstSessionWithUserWork();
    await kept.release();
    await vi.waitFor(async () => {
      await f.service.tick();
      expect(f.taskStatus(kept.running.id)).toBe('completed');
      expect(f.taskStatus(kept.queued.id)).toBe('completed');
      expect((await f.occurrences())[1]?.runStatus).toBe('completed');
    }, { timeout: 10_000, interval: 20 });
    expect(await f.sent()).toEqual(expect.arrayContaining(['user follow-up running', 'user follow-up queued']));
    // 用户工作结算后，下一次触发照常归档这个旧会话。
    f.setClock(new Date('2026-09-12T00:03:30.000Z'));
    await f.service.tick();
    expect((await f.repos.sessions.get(kept.firstSession))?.archivedAt).toBeTruthy();
  }, 30_000);

  it('still refuses the queued user turn once the owner loses access, without touching the running turn', async () => {
    const f = await fixture();
    const kept = await f.retainFirstSessionWithUserWork();
    f.allowed.value = false;
    await kept.release();
    await vi.waitFor(() => {
      expect(f.taskStatus(kept.running.id)).toBe('completed');
      expect(['queued', 'running']).not.toContain(f.taskStatus(kept.queued.id));
    }, { timeout: 10_000, interval: 20 });
    expect(f.taskStatus(kept.queued.id)).toBe('failed');
    expect(f.repos.execution.getTaskExecution(kept.queued.id)!.attempts.map(attempt => attempt.settlement))
      .toEqual([expect.objectContaining({ kind: 'not_submitted', outcome: 'failed', reason: 'Session automation access was denied' })]);
    expect(await f.sent()).not.toContain('user follow-up queued');
  }, 30_000);

  it('still refuses the queued user turn after the schedule is deleted', async () => {
    const f = await fixture();
    const kept = await f.retainFirstSessionWithUserWork();
    const current = await f.service.getScheduleDefinition(f.parent.id, kept.created.id, f.owner);
    await f.service.deleteSchedule(f.parent.id, kept.created.id, { expectedRevision: current.revision }, f.owner);
    await kept.release();
    await vi.waitFor(() => {
      expect(f.taskStatus(kept.running.id)).toBe('completed');
      expect(['queued', 'running']).not.toContain(f.taskStatus(kept.queued.id));
    }, { timeout: 10_000, interval: 20 });
    expect(f.taskStatus(kept.queued.id)).toBe('failed');
    expect(f.repos.execution.getTaskExecution(kept.queued.id)!.attempts.map(attempt => attempt.settlement))
      .toEqual([expect.objectContaining({ kind: 'not_submitted', outcome: 'failed', reason: 'Independent schedule execution authority is unavailable' })]);
    expect(await f.sent()).not.toContain('user follow-up queued');
  }, 30_000);

  // 与 Web 路由相同的入口和身份：app.ts 以安装者身份调用 dispatch 与 cancelQueued。
  it('accepts a new Web message and cancels a queued one in the previous session while it is kept', async () => {
    const f = await fixture('web');
    const kept = await f.retainFirstSessionWithUserWork();
    const added = await f.runtime.dispatch(kept.firstSession, 'user follow-up new', 'queue', 'user follow-up new', undefined, 'installation_owner');
    expect(added.status).toBe('queued');
    expect((await f.runtime.cancelQueued(kept.firstSession, kept.queued.id, 'installation_owner')).status).toBe('cancelled');
    await kept.release();
    await vi.waitFor(async () => {
      await f.service.tick();
      expect(f.taskStatus(kept.running.id)).toBe('completed');
      expect(f.taskStatus(added.id)).toBe('completed');
      expect((await f.occurrences())[1]?.runStatus).toBe('completed');
    }, { timeout: 10_000, interval: 20 });
    expect(f.taskStatus(kept.queued.id)).toBe('cancelled');
    const sent = await f.sent();
    expect(sent).toEqual(expect.arrayContaining(['user follow-up running', 'user follow-up new']));
    expect(sent).not.toContain('user follow-up queued');
  }, 30_000);

  it('refuses new Web messages and queue control in the previous session after revocation or deletion', async () => {
    const f = await fixture('web');
    const kept = await f.retainFirstSessionWithUserWork();
    const add = () => f.runtime.dispatch(kept.firstSession, 'user follow-up new', 'queue', 'user follow-up new', undefined, 'installation_owner');
    f.allowed.value = false;
    await expect(add()).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_FORBIDDEN' });
    await expect(f.runtime.cancelQueued(kept.firstSession, kept.queued.id, 'installation_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_FORBIDDEN' });
    f.allowed.value = true;
    const current = await f.service.getScheduleDefinition(f.parent.id, kept.created.id, f.owner);
    await f.service.deleteSchedule(f.parent.id, kept.created.id, { expectedRevision: current.revision }, f.owner);
    // 删除后接单先被存储层拒绝，取消先被计划授权拒绝：两层都不再承认这个旧会话。
    await expect(add()).rejects.toMatchObject({ code: 'SCHEDULE_EXECUTION_SCOPE_INVALID' });
    await expect(f.runtime.cancelQueued(kept.firstSession, kept.queued.id, 'installation_owner')).rejects.toMatchObject({ code: 'INDEPENDENT_SCHEDULE_REVOKED' });
    expect(f.taskStatus(kept.queued.id)).toBe('queued');
    await kept.release();
    await vi.waitFor(() => expect(f.taskStatus(kept.running.id)).toBe('completed'), { timeout: 10_000, interval: 20 });
    expect(await f.sent()).not.toContain('user follow-up new');
  }, 30_000);
});
