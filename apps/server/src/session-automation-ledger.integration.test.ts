import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, type AttemptResultV1, type Session } from '@dutydeck/shared';
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
  condition: { kind: 'always' as const }
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'automation-ledger-integration-'));
  const database = join(directory, 'state.db');
  const sentLog = join(directory, 'sent.jsonl');
  let repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  const deliveries: Array<{ sessionId: string; result: AttemptResultV1; occurrenceId: string; sourceId: string }> = [];
  const nativeAgent = agentConfigSchema.parse({
    id: 'native', name: 'Native fixture', protocol: 'jsonl', command: process.execPath,
    args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')],
    cwd: directory, env: { turn_agent_submission_log: sentLog },
    permissionMode: 'ask', timeout: 15, capabilities: { pause: false, resume: true }
  });
  const clock = { value: new Date('2026-09-12T00:00:30.000Z') };
  let service!: SessionAutomationService; let runtime!: DutydeckRuntime;
  const makeRuntime = (targetRepos = repos) => new DutydeckRuntime(targetRepos, {
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
    probe: () => ({ available: true, protocol: 'jsonl', pause: false, resume: true }),
    authorizeExecution: async () => {},
    prepareTaskPrompt: async (_s, prompt) => ({ agentPrompt: prompt }),
    authorizeTask: (_session, task, phase) => service.authorizeTask(task, phase)
  });
  const makeService = (targetRepos = repos, targetRuntime = runtime) => new SessionAutomationService({
    repositories: targetRepos,
    runtime: targetRuntime,
    authorize: async () => true,
    clock: () => new Date(clock.value),
    deliver: async (sessionId, result, occurrenceId, sourceId) => { deliveries.push({ sessionId, result, occurrenceId, sourceId }); }
  });
  runtime = makeRuntime(); service = makeService();
  await runtime.initialize([nativeAgent]);
  const parent: Session = await runtime.start({ agentId: 'native', cwd: directory, source: 'lark', sourceId: 'cli_app:oc_owner:root', permissionMode: 'ask' });
  cleanup.push(async () => { await service.close(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    get repos() { return repos; },
    get runtime() { return runtime; },
    get service() { return service; },
    parent, deliveries, sentLog,
    setClock: (d: Date) => { clock.value = d; },
    async enableSchedule() {
      const created = await service.createSchedule(parent.id, scheduleInput, 'ou_owner');
      await service.updateSchedule(parent.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
      clock.value = new Date('2026-09-12T00:01:30.000Z');
      return created;
    },
    async closeAndReopen() {
      await service.close();
      await runtime.shutdown();
      repos.close();
      repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
      runtime = makeRuntime(repos);
      service = makeService(repos, runtime);
      await runtime.initialize([nativeAgent]);
    },
    async tickUntil(check: () => Promise<boolean>) {
      for (let i = 0; i < 300; i++) {
        await service.tick();
        await new Promise(r => setTimeout(r, 15));
        if (await check()) return;
      }
      throw new Error('tick condition did not converge');
    }
  };
}

describe('SessionAutomation ledger integration with real SQLite and local JSONL driver', () => {
  it('dispatches one schedule task, freezes the number=1 attempt result and delivers it once', async () => {
    const f = await fixture();
    await f.enableSchedule();
    await f.tickUntil(async () => f.deliveries.length === 1);

    const delivery = f.deliveries[0]!;
    expect(delivery.sessionId).toBe(f.parent.id);
    expect(delivery.result).toMatchObject({ version: 1, outcome: 'completed' });
    expect(delivery.result.output.text).toContain('scheduled automation prompt');
    expect(delivery.result.output.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(delivery.result.throughSequence).toBeGreaterThan(0);
    expect(JSON.stringify(delivery)).not.toContain('sourcePayload');
    const sent = (await readFile(f.sentLog, 'utf8')).trim().split('\n');
    expect(sent).toHaveLength(1);
    const listed = await f.service.listBySession(f.parent.id);
    const occurrence = listed.occurrences[0]!;
    expect(occurrence).toMatchObject({ runStatus: 'completed', resultBoundary: 'verified' });
    expect(JSON.stringify(occurrence)).not.toContain('admission');
    expect(JSON.stringify(occurrence)).not.toContain('sourcePayload');
  });

  it('completes the same admission after a lost dispatch response and SQLite reopen without re-sending', async () => {
    const f = await fixture();
    await f.enableSchedule();
    let dispatchReturned = false;
    const realDispatch = f.runtime.dispatch.bind(f.runtime);
    vi.spyOn(f.runtime, 'dispatch').mockImplementationOnce(async (...args: Parameters<typeof f.runtime.dispatch>) => {
      await realDispatch(...args);
      dispatchReturned = true;
      throw new Error('response lost: network partition before source status write');
    });
    await f.service.tick().catch(() => {});
    expect(dispatchReturned).toBe(true);

    await f.closeAndReopen();
    await f.tickUntil(async () => f.deliveries.length === 1);

    const sent = (await readFile(f.sentLog, 'utf8')).trim().split('\n');
    expect(sent).toHaveLength(1);
    expect(f.deliveries).toHaveLength(1);
    const tasks = await f.repos.tasks.listBySession(f.parent.id);
    expect(tasks).toHaveLength(1);
    expect(f.deliveries[0]!.result.taskId).toBe(tasks[0]!.id);
  });

  it('treats a terminal completed source as settled so the next business trigger is not blocked and produces second occurrence', async () => {
    const f = await fixture();
    await f.enableSchedule();
    await f.tickUntil(async () => f.deliveries.length === 1);
    const listedFirst = await f.service.listBySession(f.parent.id);
    expect(listedFirst.occurrences).toHaveLength(1);
    expect(listedFirst.occurrences[0]!.runStatus).toBe('completed');

    // 推进时钟至下一个触发点，产生第二条 occurrence 和 Task
    f.setClock(new Date('2026-09-12T00:02:30.000Z'));
    await f.tickUntil(async () => f.deliveries.length === 2);
    const listedSecond = await f.service.listBySession(f.parent.id);
    expect(listedSecond.occurrences).toHaveLength(2);
    expect(listedSecond.occurrences[1]!.runStatus).toBe('completed');
    const tasks = await f.repos.tasks.listBySession(f.parent.id);
    expect(tasks).toHaveLength(2);
    expect(f.deliveries[1]!.result.taskId).toBe(tasks[1]!.id);
  });

  it('keeps the delivered result idempotent: stable key, frozen digest, no duplicate delivery', async () => {
    const f = await fixture();
    await f.enableSchedule();
    await f.tickUntil(async () => f.deliveries.length === 1);
    const result = f.deliveries[0]!.result;
    await f.service.tick();
    const listed = await f.service.listBySession(f.parent.id);
    const stored = listed.occurrences[0] as unknown as { result: AttemptResultV1; delivery: { status: string; attempts: number } };
    expect(stored.result).toEqual(result);
    expect(stored.delivery.status).toBe('delivered');
    expect(f.deliveries).toHaveLength(1);
  });
});
