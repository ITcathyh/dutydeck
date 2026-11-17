import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntimeStore } from 'acpx/runtime';
import { parseProcStat, procStatExited } from '@dutydeck/shared';
import { AcpxAdapter } from './index.js';
import { scanProcesses } from './agent-process-tree.js';
import '../../../tests/support/short-acpx-reply-drain.js';

const ACP_LAUNCHER_CLEANUP_UNKNOWN = 'ACP_LAUNCHER_CLEANUP_UNKNOWN';

interface ProcessIdentity { pid: number; start: string; pgid: number }
const fixture = resolve('tests/fixtures/acp-launcher-contract-agent.mjs');

afterEach(() => { vi.unstubAllEnvs(); });

function agentConfig(cwd: string, mode: string, exitCode?: number) {
  return {
    id: `launcher-contract-${mode}`, name: 'Launcher contract fixture', command: process.execPath, args: [fixture], protocol: 'acp' as const,
    cwd, env: { lifecycle_directory: cwd, fixture_mode: mode, ...(exitCode === undefined ? {} : { fixture_exit_code: String(exitCode) }), VENDOR_FIXTURE: 'synthetic' },
    permissionMode: 'full-trust' as const, timeout: 20, capabilities: { pause: false, resume: true }, builtin: false,
  };
}

async function calls(cwd: string) {
  if (!existsSync(join(cwd, 'calls.jsonl'))) return [];
  return (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function observeLauncherExit(adapter: AcpxAdapter) {
  const child = [...(adapter as any).agentChildren.keys()][0];
  expect(child).toBeDefined();
  const observation: { code?: number | null; signal?: NodeJS.Signals | null } = {};
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => { observation.code = code; observation.signal = signal; });
  return observation;
}

function currentIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    return { pid, start: stat.start, pgid: stat.pgid };
  } catch { return undefined; }
}

function identityAlive(identity: ProcessIdentity) {
  const current = currentIdentity(identity.pid);
  if (!current || current.start !== identity.start || current.pgid !== identity.pgid) return false;
  try { return !procStatExited(parseProcStat(readFileSync(`/proc/${identity.pid}/stat`, 'utf8'))); }
  catch { return false; }
}

function killOwnedGroup(identity: ProcessIdentity) {
  if (identity.pid <= 1 || identity.pgid <= 1 || !identityAlive(identity)) return;
  try { process.kill(-identity.pgid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

async function stopAndRemove(adapter: AcpxAdapter, cwd: string, owned: ProcessIdentity[] = []) {
  try { await adapter.stop(); } finally {
    for (const identity of owned) killOwnedGroup(identity);
    await rm(cwd, { recursive: true, force: true });
  }
}

function failedTurn(error: Error, gate?: Promise<void>) {
  return {
    result: Promise.resolve({ status: 'failed', error: { message: error.message } }),
    events: { async *[Symbol.asyncIterator]() { if (gate) await gate; throw error; } },
    cancel: vi.fn(async () => undefined),
  };
}

async function injectCleanupUnknown(adapter: AcpxAdapter, cwd: string) {
  const identity = currentIdentity(process.pid);
  expect(identity).toBeDefined();
  const reports = join(cwd, '.dutydeck', 'launchers');
  await mkdir(reports, { recursive: true });
  await writeFile(join(reports, `${identity!.pid}.${identity!.start}`), 'dutydeck_cleanup_unknown {"sourcesClosed":true,"destinationFlushed":true,"groupExited":false}\n');
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: process.pid, spawnargs: (adapter as any).launch.command, exitCode: 120, signalCode: null });
  (adapter as any).observeProcess({ phase: 'spawned', kind: 'agent', child });
}

function discardInjectedTrees(adapter: AcpxAdapter) {
  for (const tree of (adapter as any).unconfirmedTrees) tree.discardReport();
  (adapter as any).unconfirmedTrees.clear();
}

async function stubCleanupProbe(cwd: string) {
  const probe = join(cwd, 'group-probe.mjs');
  await writeFile(probe, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    if (process.argv[1]?.endsWith('/env-launcher.mjs')) {
      const original = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid < 0 && (signal === 0 || signal === 'SIGKILL')) throw Object.assign(new Error('synthetic group proof failure'), { code: 'EPERM' });
        return original(pid, signal);
      };
    }
    if (process.argv[1]?.endsWith('/acp-launcher-contract-agent.mjs') && process.env.fixture_exit_gate === '1') {
      const originalExit = process.exit.bind(process);
      process.exit = code => {
        writeFileSync(join(${JSON.stringify(cwd)}, 'agent-exit-ready'), '1');
        while (!existsSync(join(${JSON.stringify(cwd)}, 'release-agent-exit'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        originalExit(code);
      };
    }
  `);
  vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(probe).href}`);
}

it.skipIf(process.platform !== 'linux')('delivers the complete ACP tail after a 6.5 second destination pause and preserves exit 7', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-acpx-slow-reader-'));
  const sessionKey = 'launcher-slow-reader-persistent';
  const events: any[] = [];
  const adapter = new AcpxAdapter(agentConfig(cwd, 'slow-reader'), { sessionKey, onEvent: event => events.push(event) });
  let writer: ProcessIdentity | undefined;
  try {
    await adapter.start();
    const launcherExit = observeLauncherExit(adapter);
    const sending = adapter.send('pause the destination');
    void sending.catch(() => {});
    await expect.poll(async () => (await calls(cwd)).some(call => call.method === 'prompt-ready')).toBe(true);
    await writeFile(join(cwd, 'start-writer'), '1');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_500);
    await expect(sending).rejects.toThrow(/disconnected/);
    expect(launcherExit).toMatchObject({ code: 7, signal: null });
    expect((await calls(cwd)).some(call => call.method === 'writer-finished')).toBe(true);
    const text = events.filter(event => event.type === 'text').map(event => event.data.text);
    expect(text).toHaveLength(192);
    expect(text[0]).toBe(`message-0-${'x'.repeat(1000)}`);
    expect(text.at(-1)).toBe(`message-191-${'x'.repeat(1000)}`);
    expect(events.some(event => event.data?.code === ACP_LAUNCHER_CLEANUP_UNKNOWN)).toBe(false);
    const record = await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load(sessionKey);
    expect(record?.name).toBe(sessionKey);
    writer = (await calls(cwd)).find(call => call.method === 'writer');
    expect((adapter as any).unconfirmedTrees.size).toBe(0);
    await stopAndRemove(adapter, cwd, writer ? [writer] : []);
  } catch (error) {
    writer ??= (await calls(cwd)).find(call => call.method === 'writer');
    await stopAndRemove(adapter, cwd, writer ? [writer] : []);
    throw error;
  }
}, 30_000);

it.skipIf(process.platform !== 'linux')('retains cleanup-unknown reports for real adapter adoption and later process-tree termination', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-acpx-cleanup-unknown-'));
  await stubCleanupProbe(cwd);
  const sessionKey = 'launcher-cleanup-unknown-persistent';
  const events: any[] = [];
  const config = agentConfig(cwd, 'cleanup-unknown');
  const adapter = new AcpxAdapter({ ...config, env: { ...config.env, fixture_exit_gate: '1' } }, { sessionKey, onEvent: event => events.push(event) });
  let survivor: ProcessIdentity | undefined;
  try {
    await adapter.start();
    const launcherExit = observeLauncherExit(adapter);
    const sending = adapter.send('make group cleanup unprovable');
    void sending.catch(() => {});
    await expect.poll(async () => (await calls(cwd)).some(call => call.method === 'cleanup-ready')).toBe(true);
    await writeFile(join(cwd, 'start-cleanup'), '1');
    await expect.poll(() => existsSync(join(cwd, 'agent-exit-ready'))).toBe(true);
    survivor = (await calls(cwd)).find(call => call.method === 'survivor');
    expect(identityAlive(survivor!)).toBe(true);
    // Keep the original leader alive while the real tree records this survivor.
    // That PID/start/PGID observation, not the numeric group alone, proves
    // continuity after the leader exits and the launcher report arrives late.
    const sampledTree = [...(adapter as any).agentChildren.values()][0];
    expect(sampledTree.refresh(scanProcesses())).toBe(true);
    await writeFile(join(cwd, 'release-agent-exit'), '1');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_500);
    await expect(sending).rejects.toMatchObject({ code: ACP_LAUNCHER_CLEANUP_UNKNOWN });
    expect(launcherExit).toMatchObject({ code: 120, signal: null });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', data: expect.objectContaining({ code: ACP_LAUNCHER_CLEANUP_UNKNOWN }) }));
    await expect.poll(() => (adapter as any).unconfirmedTrees.size).toBe(1);
    const reports = readdirSync(join(cwd, '.dutydeck', 'launchers'));
    expect(reports).toHaveLength(1);
    expect(readFileSync(join(cwd, '.dutydeck', 'launchers', reports[0]!), 'utf8')).toContain('dutydeck_cleanup_unknown');
    const tree = [...(adapter as any).unconfirmedTrees][0];
    expect(tree).toBe(sampledTree);
    expect(tree.exited(scanProcesses())).toBe(false);
    const record = await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load(sessionKey);
    expect(record?.name).toBe(sessionKey);

    // This is the same adapter path used by bounded stop and stuck-turn cleanup.
    (adapter as any).endAgentProcesses();
    await expect.poll(() => identityAlive(survivor!)).toBe(false);
    await adapter.stop();
    await expect.poll(() => adapter.isStopped()).toBe(true);
    expect(readdirSync(join(cwd, '.dutydeck', 'launchers'))).toEqual([]);
    await rm(cwd, { recursive: true, force: true });
  } catch (error) {
    await writeFile(join(cwd, 'release-agent-exit'), '1').catch(() => {});
    await stopAndRemove(adapter, cwd, survivor ? [survivor] : []);
    throw error;
  }
}, 30_000);

it.skipIf(process.platform !== 'linux')('keeps an unsampled cleanup-unknown survivor unconfirmed instead of signalling its numeric group', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-acpx-cleanup-unsampled-'));
  await stubCleanupProbe(cwd);
  const adapter = new AcpxAdapter(agentConfig(cwd, 'cleanup-unknown'), { sessionKey: 'launcher-cleanup-unsampled', onEvent() {} });
  let survivor: ProcessIdentity | undefined;
  try {
    await adapter.start();
    const sending = adapter.send('make group cleanup unprovable');
    void sending.catch(() => {});
    await expect.poll(async () => (await calls(cwd)).some(call => call.method === 'cleanup-ready')).toBe(true);
    await writeFile(join(cwd, 'start-cleanup'), '1');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_500);
    survivor = (await calls(cwd)).find(call => call.method === 'survivor');
    expect(identityAlive(survivor!)).toBe(true);
    await expect(sending).rejects.toMatchObject({ code: ACP_LAUNCHER_CLEANUP_UNKNOWN });
    await expect.poll(() => (adapter as any).unconfirmedTrees.size).toBe(1);
    const tree = [...(adapter as any).unconfirmedTrees][0];
    expect(tree.exited(scanProcesses())).toBeUndefined();
    expect(adapter.stopUnverifiable()).toBe(true);

    // Cover both the immediate SIGTERM and the delayed SIGKILL pass. With no
    // recorded original member, neither may target the surviving numeric PGID.
    (adapter as any).endAgentProcesses();
    await new Promise(resolve => setTimeout(resolve, 3_100));
    expect(identityAlive(survivor!)).toBe(true);
    expect(tree.exited(scanProcesses())).toBeUndefined();

    // The fixture owns this exact PID/start. Clean it directly, then the same
    // tree can prove the original group empty and release its launcher report.
    killOwnedGroup(survivor!);
    await expect.poll(() => identityAlive(survivor!)).toBe(false);
    await expect.poll(() => tree.exited(scanProcesses())).toBe(true);
    await adapter.stop();
    await expect.poll(() => adapter.isStopped()).toBe(true);
    expect(readdirSync(join(cwd, '.dutydeck', 'launchers'))).toEqual([]);
    await rm(cwd, { recursive: true, force: true });
  } catch (error) {
    await stopAndRemove(adapter, cwd, survivor ? [survivor] : []);
    throw error;
  }
}, 30_000);

it.skipIf(process.platform !== 'linux')('binds cleanup-unknown to its active turn and never to later turns', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-acpx-cleanup-turn-ownership-'));
  const sessionKey = 'launcher-cleanup-turn-ownership-persistent';
  const events: any[] = [];
  const adapter = new AcpxAdapter(agentConfig(cwd, 'turn-ownership'), { sessionKey, onEvent: event => events.push(event) });
  const runtime = (adapter as any).runtime;
  vi.spyOn(runtime, 'ensureSession').mockResolvedValue({ sessionKey });
  vi.spyOn(runtime, 'close').mockResolvedValue(undefined);
  vi.spyOn(runtime, 'getStatus').mockResolvedValue(undefined);
  let releaseA!: () => void;
  const gateA = new Promise<void>(resolve => { releaseA = resolve; });
  const turnA = failedTurn(new Error('A transport failed'), gateA);
  const realBError = new Error('B supplier rejected the request');
  const turnB = failedTurn(realBError);
  const turnC = {
    result: Promise.resolve({ status: 'completed', stopReason: 'end_turn' }),
    events: { async *[Symbol.asyncIterator]() {} },
    cancel: vi.fn(async () => undefined),
  };
  vi.spyOn(runtime, 'startTurn').mockReturnValueOnce(turnA).mockReturnValueOnce(turnB).mockReturnValueOnce(turnC);
  try {
    await adapter.start();
    const sendingA = adapter.send('A');
    void sendingA.catch(() => {});
    await expect.poll(() => (adapter as any).turn).toBe(turnA);
    await injectCleanupUnknown(adapter, cwd);
    releaseA();
    await expect(sendingA).rejects.toMatchObject({ code: ACP_LAUNCHER_CLEANUP_UNKNOWN });

    const retainedAfterA = (adapter as any).unconfirmedTrees.size;
    await injectCleanupUnknown(adapter, cwd);
    expect((adapter as any).turn).toBeUndefined();
    expect((adapter as any).unconfirmedTrees.size).toBe(retainedAfterA + 1);
    await expect(adapter.send('B')).rejects.toBe(realBError);
    await expect(adapter.send('C')).resolves.toBeUndefined();
    expect(events.filter(event => event.data?.code === ACP_LAUNCHER_CLEANUP_UNKNOWN)).toHaveLength(2);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  } finally {
    releaseA();
    discardInjectedTrees(adapter);
    await stopAndRemove(adapter, cwd);
  }
}, 20_000);

it.skipIf(process.platform !== 'linux').each([1, 120])('does not confuse an ordinary agent exit %s with cleanup-unknown', async exitCode => {
  const cwd = await mkdtemp(join(tmpdir(), `dd-acpx-normal-exit-${exitCode}-`));
  const sessionKey = `launcher-normal-exit-${exitCode}-persistent`;
  const events: any[] = [];
  const adapter = new AcpxAdapter(agentConfig(cwd, 'plain-exit', exitCode), { sessionKey, onEvent: event => events.push(event) });
  try {
    await adapter.start();
    const launcherExit = observeLauncherExit(adapter);
    await expect(adapter.send(`ordinary exit ${exitCode}`)).rejects.toThrow(/disconnected/);
    expect(launcherExit).toMatchObject({ code: exitCode, signal: null });
    expect((adapter as any).unconfirmedTrees.size).toBe(0);
    expect(events.some(event => event.data?.code === ACP_LAUNCHER_CLEANUP_UNKNOWN)).toBe(false);
    expect(readdirSync(join(cwd, '.dutydeck', 'launchers'))).toEqual([]);
    const record = await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load(sessionKey);
    expect(record?.name).toBe(sessionKey);
    await stopAndRemove(adapter, cwd);
  } catch (error) {
    await stopAndRemove(adapter, cwd);
    throw error;
  }
}, 20_000);
