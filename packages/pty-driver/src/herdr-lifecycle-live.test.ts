import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@dutydeck/shared';
import type { CliAdapter } from '@dutydeck/cli-adapters';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { HerdrBackend, herdrControlEnvironment } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'dd-herdr-lifecycle-')), name = `dutydeck-${randomBytes(16).toString('hex')}`;
  const binary = execFileSync('/bin/sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim();
  const options = { binary, stateFile: join(cwd, 'identity.json'), ownerId: 'dutydeck:lifecycle', processProbe: { identify: childProcessIdentity, observe: observeProcess } };
  const backend = new HerdrBackend(name, options), exit = vi.fn(), events = vi.fn();
  const agent: AgentConfig = { id: 'fixture', name: 'fixture', protocol: 'pty-cli', command: '/bin/sh', args: ['-c', 'exec /bin/sh'], cwd, env: {}, permissionMode: 'full-trust', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
  const adapter: CliAdapter = { id: 'fixture', capabilities: {}, buildResumeCommand: () => [], buildArgs: () => [], injectSessionContext: () => '', writeInput: async (backend, prompt) => (await backend.write(prompt + '\n')) };
  const driver = new PtyCliDriver({ backend, sessionId: 'ses_lifecycle', agent, adapter, onExit: exit, onEvent: events });
  const cleanup = async () => {
    (await backend.detach());
    for (const action of ['stop', 'delete']) { try { execFileSync(binary, ['session', action, name, '--json'], { env: herdrControlEnvironment(process.env), stdio: 'pipe' }); } catch {} }
    rmSync(cwd, { recursive: true, force: true }); vi.restoreAllMocks();
  };
  return { cwd, name, options, backend, driver, agent, adapter, exit, events, cleanup };
}
describe.skipIf(process.env.DUTYDECK_TEST_HERDR !== 'true')('Herdr lifecycle races on real named servers', () => {
  it('settles cancelled readiness and never detaches a newer controller from an old rejection', async () => {
    const f = fixture();
    try {
      await f.driver.start(); const pid = f.backend.getPid(); (await f.backend.detach());
      const wrapper = join(f.cwd, 'slow-herdr.sh');
      writeFileSync(wrapper, `#!/bin/sh\nif [ "$3" = terminal ]; then sleep 0.6; fi\nexec '${f.options.binary}' "$@"\n`, { mode: 0o700 });
      const backend = new HerdrBackend(f.name, { ...f.options, binary: wrapper });
      const cancelled = backend.attach({ cols: 120, rows: 30 }).catch(error => error);
      await delay(40); (await backend.detach());
      const latest = backend.attach({ cols: 120, rows: 30 });
      await expect(cancelled).resolves.toMatchObject({ message: 'Herdr terminal attachment cancelled' });
      await latest;
      expect(backend.getPid()).toBe(pid); expect((await backend.write("printf 'NEW_%s\\n' CONTROLLER\n"))).toBe(true);
      await backend.stopOwnedIdentity(); expect((await backend.isStopped())).toBe(true);
    } finally { await f.cleanup(); }
  });
  it.each(['workspace.create', 'layout.apply'])('stops async startup at %s without wiring or leaving physical execution alive', async boundary => {
    const f = fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const internal = f.backend as any, request = internal.request.bind(internal);
    vi.spyOn(internal, 'request').mockImplementation(async (method: string, params: unknown, path: string) => {
      const result = await request(method, params, path);
      if (method === boundary) { entered(); await gate; }
      return result;
    });
    try {
      const starting = f.driver.start().catch(error => error); await reached;
      const stopping = f.driver.stop(); release();
      expect(await starting).toBeInstanceOf(Error); await stopping;
      expect(await f.driver.isStopped()).toBe(true);
      expect(f.events).not.toHaveBeenCalled(); expect(f.exit).not.toHaveBeenCalled();
      await expect(f.driver.send('must not revive')).rejects.toThrow('after stop');
    } finally { release(); await f.cleanup(); }
  });
  it('does not launch a replacement when stop cancels async native respawn', async () => {
    const f = fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    try {
      await f.driver.start(); await f.backend.stopOwnedIdentity();
      const stop = f.backend.stopOwnedIdentity.bind(f.backend);
      vi.spyOn(f.backend, 'stopOwnedIdentity').mockImplementationOnce(async () => { const proof = await stop(); entered(); await gate; return proof; });
      const resuming = f.driver.resume().catch(error => error); await reached;
      await f.driver.stop(); release();
      expect(await resuming).toMatchObject({ message: 'PTY respawn cancelled by lifecycle change' });
      expect(await f.driver.isStopped()).toBe(true);
      expect((await f.backend.isStopped())).toBe(true);
    } finally { release(); await f.cleanup(); }
  });
  it('cancels terminal viewing during readiness and never reports success after stop', async () => {
    const f = fixture();
    try {
      await f.driver.start(); const pid = f.backend.getPid(); (await f.backend.detach());
      const wrapper = join(f.cwd, 'slow-herdr.sh');
      writeFileSync(wrapper, `#!/bin/sh\nif [ "$3" = terminal ]; then sleep 0.6; fi\nexec '${f.options.binary}' "$@"\n`, { mode: 0o700 });
      const backend = new HerdrBackend(f.name, { ...f.options, binary: wrapper });
      const viewEvents = vi.fn();
      const viewing = new PtyCliDriver({ backend, sessionId: 'ses_view', agent: f.agent, adapter: f.adapter, onExit: f.exit, onEvent: viewEvents });
      const attaching = Promise.resolve(viewing.attachTerminal()).catch(error => error);
      await delay(40); await viewing.stop();
      expect(await attaching).toBeInstanceOf(Error);
      expect(viewing.isDetachedForShutdown()).toBe(false);
      expect(await viewing.isStopped()).toBe(false);
      expect(f.backend.getPid()).toBe(pid);
      expect(viewEvents).not.toHaveBeenCalled();
      await backend.stopOwnedIdentity();
    } finally { await f.cleanup(); }
  });
  it('preserves unresolved work on capture disconnect and still permits explicit physical stop', async () => {
    const f = fixture();
    try {
      await f.driver.start(); const pid = f.backend.getPid();
      const sending = f.driver.send('sleep 20').catch(error => error);
      await expect.poll(() => JSON.parse(readFileSync(f.options.stateFile, 'utf8')).first_prompt_sent).toBe('true');
      (f.backend as any).stream.kill('SIGKILL');
      expect(await sending).toMatchObject({ name: 'DriverRecoveryError' });
      expect(f.exit).not.toHaveBeenCalled();
      expect(f.backend.getPid()).toBe(pid);
      expect(await f.driver.isStopped()).toBe(false);
      await f.driver.stop();
      expect(await f.driver.isStopped()).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('proves natural primary exit and retains descendant and unknown-observation blockers', async () => {
    const f = fixture();
    try {
      await f.driver.start(); const pid = f.backend.getPid()!, root = childProcessIdentity(pid);
      (await f.backend.write('exit\n'));
      await expect.poll(() => observeProcess(root)).toBe('dead');
      await expect.poll(() => f.exit.mock.calls.length).toBe(1);
      expect(f.exit).toHaveBeenCalledWith(null);
      await f.driver.stop();
      await expect.poll(() => f.driver.isStopped()).toBe(true);
      const capture = await new HerdrBackend(f.name, f.options).captureOwnedIdentity();
      const retired = new HerdrBackend(f.name, f.options);
      expect((await retired.verifyOwnedIdentity(capture))).toBe(true);
      expect(await retired.stopOwnedIdentity(capture)).toBeTruthy();
      const unknown = new HerdrBackend(f.name, { ...f.options, processProbe: { identify: childProcessIdentity, observe: () => 'unknown' } });
      expect((await unknown.verifyOwnedIdentity(capture))).toBe(false);
      const state = JSON.parse(readFileSync(f.options.stateFile, 'utf8'));
      state.identities.push(childProcessIdentity(process.pid));
      writeFileSync(f.options.stateFile, JSON.stringify(state));
      expect(await new HerdrBackend(f.name, f.options).verifyOwnedIdentity(state)).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('keeps natural exit pending across terminal closure until an unknown census becomes provable', async () => {
    const f = fixture();
    try {
      await f.driver.start(); const root = childProcessIdentity(f.backend.getPid()!);
      const internal = f.backend as any, owned = internal.ownedProcesses.bind(internal);
      let allowProof = false;
      vi.spyOn(internal, 'ownedProcesses').mockImplementation(() => {
        if (observeProcess(root) === 'dead' && !allowProof) throw new Error('HERDR_OWNERSHIP_CENSUS_UNKNOWN temporary fixture');
        return owned();
      });
      (await f.backend.write('exit\n'));
      await expect.poll(() => observeProcess(root)).toBe('dead');
      await expect.poll(() => internal.stream === undefined).toBe(true);
      expect(f.events.mock.calls.some(([event]) => event.type === 'status' && event.data.state === 'terminal_disconnected')).toBe(false);
      expect(f.exit).not.toHaveBeenCalled(); expect(await f.driver.isStopped()).toBe(false);
      allowProof = true;
      await expect.poll(() => f.exit.mock.calls.length).toBe(1);
      expect(f.exit).toHaveBeenCalledWith(null);
      await expect.poll(() => f.driver.isStopped()).toBe(true);
      await delay(600); expect(f.exit).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });
  it('cancels pending natural exit observation on detach and leaves a replacement generation untouched', async () => {
    const f = fixture(); let replacement: HerdrBackend | undefined;
    try {
      await f.driver.start(); const root = childProcessIdentity(f.backend.getPid()!);
      const internal = f.backend as any, owned = internal.ownedProcesses.bind(internal);
      let allowProof = false;
      vi.spyOn(internal, 'ownedProcesses').mockImplementation(() => {
        if (observeProcess(root) === 'dead' && !allowProof) throw new Error('HERDR_OWNERSHIP_CENSUS_UNKNOWN temporary fixture');
        return owned();
      });
      (await f.backend.write('exit\n')); await expect.poll(() => observeProcess(root)).toBe('dead');
      await expect.poll(() => internal.stream === undefined).toBe(true);
      expect(internal.executionTimer).toBeTruthy(); (await f.backend.detach());
      expect(internal.executionTimer).toBeUndefined(); allowProof = true;
      replacement = f.backend.fork();
      await replacement.spawn('/bin/sh', ['-c', 'exec /bin/sh'], { cwd: f.cwd, cols: 120, rows: 30, env: { PATH: process.env.PATH } });
      const next = childProcessIdentity(replacement.getPid()!), nextExit = vi.fn(); replacement.onExit(nextExit);
      await delay(700);
      expect(f.exit).not.toHaveBeenCalled(); expect(nextExit).not.toHaveBeenCalled(); expect(observeProcess(next)).toBe('alive');
      await replacement.stopOwnedIdentity(); expect((await replacement.isStopped())).toBe(true);
    } finally { (await replacement?.detach()); await f.cleanup(); }
  });
  it('keeps a real reparented descendant unresolved after natural primary exit until that descendant dies', async () => {
    const f = fixture();
    let child: ReturnType<typeof childProcessIdentity> | undefined;
    try {
      await f.driver.start(); const root = childProcessIdentity(f.backend.getPid()!);
      (await f.backend.write("setsid --wait /bin/sh -c 'echo $$ > child.pid; trap \"\" HUP TERM; exec sleep 4' &\n"));
      await expect.poll(() => { try { return Number(readFileSync(join(f.cwd, 'child.pid'), 'utf8').trim()); } catch { return 0; } }).toBeGreaterThan(0);
      child = childProcessIdentity(Number(readFileSync(join(f.cwd, 'child.pid'), 'utf8').trim()));
      await expect.poll(() => JSON.parse(readFileSync(f.options.stateFile, 'utf8')).identities.some((item: { pid: number }) => item.pid === child!.pid)).toBe(true);
      (await f.backend.write('exit\n'));
      await expect.poll(() => observeProcess(root)).toBe('dead');
      expect(observeProcess(child)).toBe('alive');
      const original = new HerdrBackend(f.name, f.options), snapshot = (await original.captureOwnedIdentity());
      expect((await original.verifyOwnedIdentity(snapshot))).toBe(false);
      expect(f.exit).not.toHaveBeenCalled();
      await expect.poll(() => observeProcess(child!), { timeout: 6000 }).toBe('dead');
      await original.stopOwnedIdentity((await original.captureOwnedIdentity()));
      expect((await original.isStopped())).toBe(true);
    } finally {
      if (child && observeProcess(child) === 'alive') process.kill(child.pid, 'SIGKILL');
      await f.cleanup();
    }
  });
  it('censuses uncaptured setsid owners without polling, stops only this launch and preserves workers and older markers', async () => {
    const f = fixture();
    let oldGeneration: ReturnType<typeof spawn> | undefined;
    try {
      await f.driver.start(); const root = childProcessIdentity(f.backend.getPid()!);
      // The regression must work with no periodic sampling at all.
      clearInterval((f.backend as any).executionTimer); (f.backend as any).executionTimer = undefined;
      const before = JSON.parse(readFileSync(f.options.stateFile, 'utf8')), originalLaunch = before.launch_id;
      expect(readFileSync(`/proc/${root.pid}/environ`, 'utf8').split('\0')).toContain(`dutydeck_terminal_launch_id=${originalLaunch}`);
      const internal = f.backend as any;
      const workspace = await internal.request('workspace.create', { cwd: f.cwd, label: 'independent worker', focus: false });
      const layout = await internal.request('layout.apply', { tab_id: workspace.tab.tab_id, focus: false, root: { type: 'pane', cwd: f.cwd, command: ['/bin/sh', '-c', 'exec sleep 30'], env: { PATH: process.env.PATH } } });
      const info = JSON.parse(execFileSync(f.options.binary, ['--session', f.name, 'pane', 'process-info', '--pane', layout.layout.root.pane_id], { env: herdrControlEnvironment(process.env), encoding: 'utf8' })).result.process_info;
      const worker = childProcessIdentity(info.shell_pid);
      expect(readFileSync(`/proc/${worker.pid}/environ`, 'utf8')).not.toContain(`dutydeck_terminal_launch_id=${originalLaunch}`);
      (await f.backend.write(`setsid /bin/sh -c 'trap "" HUP; echo $$ > child.pid; exec sleep 30' </dev/null >/dev/null 2>&1 &\n`));
      await expect.poll(() => { try { return Number(readFileSync(join(f.cwd, 'child.pid'), 'utf8').trim()); } catch { return 0; } }).toBeGreaterThan(0);
      const escaped = childProcessIdentity(Number(readFileSync(join(f.cwd, 'child.pid'), 'utf8').trim()));
      expect(JSON.parse(readFileSync(f.options.stateFile, 'utf8')).identities.some((item: { pid: number }) => item.pid === escaped.pid)).toBe(false);
      (await f.backend.write('exit\n')); await expect.poll(() => observeProcess(root)).toBe('dead');
      const retired = new HerdrBackend(f.name, f.options), receipt = (await retired.captureOwnedIdentity());
      expect((receipt as { identities: Array<{ pid: number }> }).identities.some(item => item.pid === escaped.pid)).toBe(true);
      expect(observeProcess(escaped)).toBe('alive'); expect((await retired.verifyOwnedIdentity(receipt))).toBe(false);
      expect(f.exit).not.toHaveBeenCalled(); expect(await f.driver.isStopped()).toBe(false);
      await retired.stopOwnedIdentity(receipt);
      expect(observeProcess(escaped)).toBe('dead'); expect((await retired.isStopped())).toBe(true);
      expect(observeProcess(worker)).toBe('alive');
      const current = retired.fork(); await current.spawn('/bin/sh', ['-c', 'exec /bin/sh'], { cwd: f.cwd, cols: 120, rows: 30, env: { PATH: process.env.PATH } });
      const next = JSON.parse(readFileSync(f.options.stateFile, 'utf8'));
      expect(next.launch_id).not.toBe(originalLaunch);
      expect((await current.verifyOwnedIdentity(receipt))).toBe(false);
      oldGeneration = spawn('/bin/sh', ['-c', 'exec sleep 30'], { env: { ...process.env, dutydeck_terminal_launch_id: originalLaunch }, stdio: 'ignore' });
      const oldIdentity = childProcessIdentity(oldGeneration.pid!);
      (await current.write('exit\n'));
      await expect.poll(async () => (await current.isStopped())).toBe(true);
      const nextProof = (await current.captureOwnedIdentity());
      expect((await current.verifyOwnedIdentity(nextProof))).toBe(true);
      expect((await current.verifyOwnedIdentity({ ...(nextProof as object), launch_id: originalLaunch }))).toBe(false);
      const census = vi.spyOn(current as any, 'ownedProcesses').mockImplementation(() => { throw new Error('HERDR_OWNERSHIP_CENSUS_UNKNOWN'); });
      expect((await current.verifyOwnedIdentity(nextProof))).toBe(false); census.mockRestore();
      expect(observeProcess(oldIdentity)).toBe('alive'); expect(observeProcess(worker)).toBe('alive');
      (await current.detach());
    } finally { oldGeneration?.kill('SIGKILL'); await f.cleanup(); }
  });
  it('verifies durable pre-close identity after a lost close acknowledgement and rejects unknown process observations', async () => {
    const f = fixture();
    try {
      await f.driver.start(); const snapshot = (await f.backend.captureOwnedIdentity());
      const internal = f.backend as any, call = internal.cli.bind(internal);
      vi.spyOn(internal, 'cli').mockImplementation(async (args: string[]) => {
        const result = await call(args);
        if (args[0] === 'pane' && args[1] === 'close') throw new Error('simulated lost close response');
        return result;
      });
      await expect(f.backend.kill()).rejects.toThrow('simulated lost close response');
      (await f.backend.detach());
      const stored = JSON.parse(readFileSync(f.options.stateFile, 'utf8'));
      expect(stored.close_intent).toBe(true); expect(stored.closed).not.toBe(true);
      const recovered = new HerdrBackend(f.name, f.options);
      await expect.poll(async () => (await recovered.verifyOwnedIdentity(snapshot))).toBe(true);
      await recovered.stopOwnedIdentity(snapshot);
      expect((await recovered.isStopped())).toBe(true);
      const unknown = new HerdrBackend(f.name, { ...f.options, processProbe: { identify: childProcessIdentity, observe: () => 'unknown' } });
      expect((await unknown.verifyOwnedIdentity(snapshot))).toBe(false);
    } finally { await f.cleanup(); }
  });
});
