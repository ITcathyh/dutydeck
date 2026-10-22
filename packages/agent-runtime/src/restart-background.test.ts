import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedSessionUuid, type CliAdapter } from '@dutydeck/cli-adapters';
import { isTmuxAvailable, TmuxBackend } from '@dutydeck/session-backends';
import { childProcessIdentity, createRepositories, observeProcess } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory } from '@dutydeck/shared';
import { drainRuntime } from '../../../apps/server/src/daemon/command.js';
import { PtyCliDriver } from '../../pty-driver/src/driver.js';
import { buildSessionMarker } from '../../pty-driver/src/session-id/index.js';
import { DutydeckRuntime } from './index.js';

const tmuxDescribe = await isTmuxAvailable() ? describe : describe.skip;
tmuxDescribe('restart drain with native background work in isolated tmux', () => {
  const originalTmuxDirectory = process.env.TMUX_TMPDIR;
  let tmuxDirectory: string;
  const cleanup: Array<() => void | Promise<void>> = [];
  beforeAll(() => { tmuxDirectory = mkdtempSync(join(tmpdir(), 'dd-background-tmux-')); process.env.TMUX_TMPDIR = tmuxDirectory; });
  afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });
  afterAll(() => {
    if (originalTmuxDirectory === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = originalTmuxDirectory;
    rmSync(tmuxDirectory, { recursive: true, force: true });
  });

  async function fixture() {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-background-cli-'));
    cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
    const finish = join(cwd, 'finish'), finished = join(cwd, 'finished'), pidPath = join(cwd, 'pid');
    const prompts: string[] = [];
    let transcript = '', name = '', driver!: PtyCliDriver;
    const append = (entries: object[]) => appendFileSync(transcript, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
    const factory: DriverFactory = (agent, _protocol, onEvent, onExit, sessionId) => {
      const project = join(cwd, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-'));
      mkdirSync(project, { recursive: true });
      transcript = join(project, `${pinnedSessionUuid(sessionId)}.jsonl`);
      writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: pinnedSessionUuid(sessionId), message: { role: 'user', content: buildSessionMarker(sessionId) } }) + '\n');
      name = `dd-background-${sessionId}`;
      const adapter: CliAdapter = {
        id: 'claude-code', capabilities: {}, buildArgs: () => [], buildResumeCommand: () => [], injectSessionContext: () => '',
        writeInput(backend, prompt) {
          prompts.push(prompt);
          append([
            { type: 'user', uuid: 'input', message: { role: 'user', content: prompt } },
            { type: 'assistant', uuid: 'call', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'background-call', name: 'Bash', input: { run_in_background: true } }], stop_reason: 'tool_use' } },
            { type: 'user', uuid: 'receipt', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'background-call', content: 'Background command started' }] }, toolUseResult: { backgroundTaskId: 'background-task' } },
          ]);
          backend.write(`sh -c 'echo $$ > "${pidPath}"; while [ ! -f "${finish}" ]; do sleep 0.1; done; echo done > "${finished}"' &\n`);
        },
        completionPattern: /MAIN-DONE/,
      };
      driver = new PtyCliDriver({ agent, adapter, backend: new TmuxBackend(name, { ownerId: `dutydeck:${sessionId}` }), onEvent, onExit, sessionId,
        processProbe: { identify: childProcessIdentity, observe: observeProcess } });
      return driver;
    };
    const agent: AgentConfig = { id: 'claude-code', name: 'Fixture', command: '/bin/sh', args: ['-c', 'exec /bin/sh'], protocol: 'pty-cli', cwd,
      env: { CLAUDE_CONFIG_DIR: cwd }, permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
    const repos = createRepositories(join(cwd, 'dutydeck.db'), { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, { driverFactory: factory, probe: () => ({ available: true, protocol: 'pty-cli', pause: false, resume: true }) });
    cleanup.push(() => { if (name) { try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* gone */ } } });
    cleanup.push(async () => { await runtime.shutdown(); repos.close(); });
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });
    const task = await runtime.dispatch(session.id, 'Launch independent background work');
    await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
    return { runtime, session, task, prompts, driver, name,
      pid: Number(readFileSync(pidPath, 'utf8').trim()),
      async completeMain() {
        append([{ type: 'assistant', uuid: 'answer', message: { role: 'assistant', content: [{ type: 'text', text: 'launched' }], stop_reason: 'end_turn' } },
          { type: 'system', subtype: 'turn_duration', uuid: 'terminal' }]);
        await vi.waitFor(() => expect(driver.hasBackgroundWork()).toBe(true));
        expect(runtime.getRunningTaskCount()).toBe(1);
        execFileSync('tmux', ['send-keys', '-t', name, 'echo MAIN-DONE', 'Enter']);
        await vi.waitFor(async () => expect((await runtime.getTasks(session.id))[0]?.status).toBe('completed'));
      },
      async completeBackground() {
        writeFileSync(finish, 'done');
        await vi.waitFor(() => expect(existsSync(finished)).toBe(true));
        append([{ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>background-task</task-id>\n<tool-use-id>background-call</tool-use-id>\n<status>completed</status>\n</task-notification>' }]);
        await vi.waitFor(() => expect(driver.hasBackgroundWork()).toBe(false));
      },
    };
  }

  it('counts a session once, waits after the main turn settles, and drains without another input', async () => {
    const h = await fixture();
    expect(h.runtime.getRunningTaskCount()).toBe(1);
    await h.completeMain();
    expect(h.driver.hasBackgroundWork()).toBe(true);
    expect(() => process.kill(h.pid, 0)).not.toThrow();
    h.runtime.setQueueHeld(true);
    expect(await h.runtime.getRestartActivity()).toEqual({ runningTasks: 1, restartBlockers: 1, recoverableTasks: 0 });
    expect(await h.runtime.getRestartActivity(h.session.id)).toEqual({ runningTasks: 0, restartBlockers: 0, recoverableTasks: 0 });
    let waits = 0;
    const result = await drainRuntime({ address: 'http://127.0.0.1:4310', authEnabled: false }, {}, {
      excludeSessionId: '', info() {},
      fetch: async (_input, init) => {
        if (init?.method === 'POST') { h.runtime.setQueueHeld(JSON.parse(String(init.body)).draining); return Response.json({ draining: h.runtime.isQueueHeld() }); }
        return Response.json(await h.runtime.getRestartActivity());
      },
      sleep: async () => { waits++; await h.completeBackground(); },
    }, true);
    expect(result.ok).toBe(true);
    expect(waits).toBe(1);
    expect(h.runtime.getRunningTaskCount()).toBe(0);
    expect(h.prompts).toHaveLength(1);
    await h.runtime.shutdown();
    expect(await TmuxBackend.probeSession(h.name)).toBe('missing');
    expect(await h.driver.isStopped()).toBe(true);
  });
});
