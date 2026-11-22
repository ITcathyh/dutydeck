import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { SessionAutomationService, type ScheduleWorkTemplates, type SessionAutomationRuntime } from './session-automation.js';

const owner = 'installation_owner';

describe.skipIf(process.platform !== 'linux')('schedule pre-check main-process exit settlement', () => {
  it('advances one occurrence after the old false-timeout shape and does not rerun a passed command during recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-precondition-exit-'));
    const repositories = createRepositories(join(directory, 'dutydeck.db'), { newDatabaseAuthority: 'ledger_v1' });
    const claim = repositories.control.attachRuntime('precondition-exit-test');
    const now = { value: new Date('2026-09-12T00:00:00.000Z') };
    let releaseFirstRun!: () => void;
    const firstRunGate = new Promise<void>(resolve => { releaseFirstRun = resolve; });
    let runCount = 0;
    const workTemplates: ScheduleWorkTemplates = {
      list: vi.fn(async () => [{ id: 'template_a', version: 2 }]),
      run: vi.fn(async (_session, _template, _version, _goal, key) => {
        if (++runCount === 1) await firstRunGate;
        return { id: `work_${key}`, status: 'running' };
      }),
      progress: vi.fn(async () => undefined)
    };
    const session: Session = {
      id: 'ses_precondition_exit', agentId: 'codex', state: 'idle', cwd: directory, runId: 'run_1',
      source: 'lark', sourceId: 'cli_app:oc_chat:group', permissionMode: 'ask',
      createdAt: now.value.toISOString(), updatedAt: now.value.toISOString()
    };
    repositories.execution.bind(claim).createSession({
      id: session.id, runId: session.runId, agentId: session.agentId, cwd: session.cwd, state: 'idle',
      source: session.source, sourceId: session.sourceId, permissionMode: session.permissionMode,
      createdAt: session.createdAt, updatedAt: session.updatedAt
    });
    const runtime: SessionAutomationRuntime = {
      getSession: async id => repositories.sessions.get(id),
      dispatchRequest: async () => { throw new Error('work-template schedules must not dispatch a session task'); }
    };
    const options = { repositories, runtime, authorize: async () => true, clock: () => new Date(now.value), workTemplates, preconditionSecondMs: 1_000 };
    const first = new SessionAutomationService(options);
    let second: SessionAutomationService | undefined;
    const settle = async (service: SessionAutomationService) => {
      const runs = service['scheduler'].preconditionRuns;
      while (runs.size) await Promise.allSettled([...runs.values()]);
    };
    try {
      const created = await first.createSchedule(session.id, {
        name: 'Background pre-check', prompt: 'Continue scheduled work',
        trigger: { kind: 'interval', everySeconds: 60, anchorAt: '2026-09-12T00:00:00.000Z' },
        timezone: 'UTC', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' },
        workTemplate: { id: 'template_a', version: 2 },
        precondition: { command: 'echo run >> runs.log; sleep 2 &', timeoutSeconds: 1 }
      }, owner);
      await first.updateSchedule(session.id, created.id, { expectedRevision: created.revision, enabled: true }, owner);
      now.value = new Date('2026-09-12T00:01:01.000Z');
      await first.tick();
      await vi.waitFor(() => expect(workTemplates.run).toHaveBeenCalledTimes(1), { timeout: 10_000, interval: 25 });

      let listed = await first.listBySession(session.id, owner);
      expect(listed.occurrences).toHaveLength(1);
      expect(listed.occurrences[0]).toMatchObject({ conditionStatus: 'passed', runStatus: 'pending' });
      expect(listed.preconditions?.[created.id]?.last).toMatchObject({ outcome: 'passed', exitCode: 0 });
      await first.tick();
      expect((await first.listBySession(session.id, owner)).occurrences).toHaveLength(1);

      second = new SessionAutomationService(options);
      now.value = new Date('2026-09-12T00:01:41.000Z');
      await second.tick();
      await settle(second);
      listed = await second.listBySession(session.id, owner);
      expect(listed.occurrences).toHaveLength(1);
      expect(listed.occurrences[0]).toMatchObject({ conditionStatus: 'passed', runStatus: 'completed' });
      expect((await readFile(join(directory, 'runs.log'), 'utf8')).trim().split('\n')).toEqual(['run']);
      const keys = vi.mocked(workTemplates.run).mock.calls.map(call => call[4]);
      expect(keys).toEqual([`schedule:${listed.occurrences[0]!.id}`, `schedule:${listed.occurrences[0]!.id}`]);
    } finally {
      releaseFirstRun();
      await settle(first);
      if (second) await settle(second);
      await first.close();
      await second?.close();
      claim.release(); repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
