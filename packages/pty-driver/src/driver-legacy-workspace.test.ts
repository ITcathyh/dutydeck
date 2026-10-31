import { describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { TmuxBackend } from '@dutydeck/session-backends';
import { agentConfigSchema } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { childProcessIdentity, observeProcess } from '../../storage/src/process-identity.js';
import { DutydeckRuntime } from '../../agent-runtime/src/index.js';
import { PtyCliDriver } from './driver.js';

const script = fileURLToPath(new URL('./fixtures/claude-native-session.mjs', import.meta.url));

describe.skipIf(process.platform !== 'linux')('legacy Claude workspace admission without PID state', () => {
  it.each(['idle', 'busy', 'background'] as const)('retains the original pane and admits another agent only when %s is safe', async state => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dd-legacy-workspace-')));
    vi.stubEnv('HOME', cwd); vi.stubEnv('TMUX_TMPDIR', cwd);
    const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    const buildArgs = vi.fn((ctx: any) => [script, ctx.resume ? '--resume' : '--session-id', ctx.resumeSessionId ?? pinnedSessionUuid(ctx.sessionId)]);
    const backends = new Map<string, TmuxBackend>();
    const agents = ['claude-code', 'ccflash'].map(id => agentConfigSchema.parse({ id, name: id, command: process.execPath, args: [], cwd,
      env: { HOME: cwd, CLAUDE_CONFIG_DIR: cwd, FIXTURE_DEFER_NATIVE_STATE: '1' }, permissionMode: 'full-trust', timeout: 20,
      protocol: 'pty-cli', capabilities: { resume: true } }));
    const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0,
      probe: () => ({ available: true, protocol: 'pty-cli', resume: true }),
      ptyDriverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
        const backend = new TmuxBackend(`legacy-${sessionId}`, { ownerId: `dutydeck:${sessionId}` });
        backends.set(sessionId, backend);
        return new PtyCliDriver({ agent, adapter: { ...createCliAdapter('claude-code'), prepareInput: undefined, buildArgs,
          writeInput: async (pty, prompt) => { await pty.write(JSON.stringify({ prompt }) + '\r'); } },
          backend, processProbe: { identify: childProcessIdentity, observe: observeProcess }, sessionId, onEvent, onExit });
      },
    });
    try {
      await runtime.initialize(agents);
      const first = await runtime.start({ agentId: 'claude-code', cwd });
      expect((await runtime.send(first.id, 'first')).status).toBe('completed');
      const driver = runtime.getDriver(first.id)!;
      const originalPid = await backends.get(first.id)!.getPid();
      expect(originalPid).toBeGreaterThan(0);
      expect(driver.isIdle?.()).toBe(true);
      expect(driver.hasBackgroundWork?.()).toBe(false);
      // The injected driver factory uses the runtime's local_only ownership record.
      const liveResources = repos.execution.getResources(first.id).filter(resource => resource.kind === 'local_only' && resource.observations.at(-1)?.state === 'live');
      expect(liveResources).toHaveLength(1);
      expect(liveResources[0]?.stage).toBe('created');
      // A complete composer proves local idle admission, not native resume identity.
      expect(await driver.prepareForIdleRetirement?.()).toBe(false);
      if (state === 'busy') {
        const active = await runtime.dispatch(first.id, 'HOLD');
        await vi.waitFor(async () => expect((await runtime.getEvents(first.id)).some(event => event.taskId === active.id
          && event.data?.state === 'input_receipt' && event.data.phase === 'confirmed')).toBe(true));
        expect(driver.isIdle?.()).toBe(false);
      } else if (state === 'background') {
        const path = join(cwd, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), pinnedSessionUuid(first.id) + '.jsonl');
        appendFileSync(path, JSON.stringify({ sessionId: pinnedSessionUuid(first.id), cwd, type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: 1 }) + '\n');
        await vi.waitFor(() => expect(driver.hasBackgroundWork?.()).toBe(true));
        expect(driver.isIdle?.()).toBe(true);
      }
      const second = await runtime.start({ agentId: 'ccflash', cwd });
      const task = await runtime.dispatch(second.id, 'second');
      if (state === 'idle') {
        await vi.waitFor(() => expect(repos.execution.getTaskExecution(task.id)?.task.status).toBe('completed'), { timeout: 7_000 });
        expect(repos.execution.getTaskExecution(task.id)?.attempts).toHaveLength(1);
        expect((await runtime.getEvents(second.id)).filter(event => event.type === 'text' && event.data.role !== 'user').map(event => event.data.text)).toEqual(['ANSWER:second']);
        expect((await runtime.send(first.id, 'again')).status).toBe('completed');
        expect(await driver.prepareForIdleRetirement?.()).toBe(false);
      } else {
        await vi.waitFor(() => expect(repos.execution.getTaskExecution(task.id)?.blockers).toContainEqual(expect.objectContaining({
          code: state === 'busy' ? 'WORKSPACE_EXECUTION_BUSY' : 'WORKSPACE_PHYSICAL_RESOURCE_UNSAFE', sessionId: first.id,
        })));
        expect(repos.execution.getTaskExecution(task.id)).toMatchObject({ task: { status: 'queued' }, attempts: [] });
        expect((await runtime.getEvents(second.id)).filter(event => event.data?.state === 'input_receipt')).toEqual([]);
      }
      expect(runtime.getDriver(first.id)).toBe(driver);
      expect(await backends.get(first.id)!.getPid()).toBe(originalPid);
      expect(await TmuxBackend.probeSession(`legacy-${first.id}`)).toBe('exists');
      expect(() => process.kill(originalPid!, 0)).not.toThrow();
      expect(readdirSync(join(cwd, 'sessions'))).toEqual([]);
      expect(repos.insight.listSources(first.id).filter(source => source.identityProof?.startsWith('pty-claude-process-v1:'))).toEqual([]);
      const launches = readFileSync(join(cwd, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(launches).toHaveLength(2);
      expect(launches.every(launch => launch.args.includes('--session-id') && !launch.args.includes('--resume'))).toBe(true);
      expect(buildArgs.mock.calls.every(([ctx]) => !ctx.resume)).toBe(true);
      for (const original of liveResources) {
        const current = repos.execution.getResources(first.id).find(resource => resource.resourceId === original.resourceId);
        expect(current).toEqual(original);
        expect(current?.observations.at(-1)?.state).toBe('live');
      }
    } finally {
      await runtime.shutdown(); repos.close();
      try { execFileSync('tmux', ['-S', join(cwd, `tmux-${process.getuid!()}`, 'default'), 'kill-server'], { stdio: 'ignore' }); } catch { /* private server */ }
      vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
