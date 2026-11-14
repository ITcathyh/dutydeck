import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { HerdrBackend } from './herdr-backend.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn };
});

const io = vi.hoisted(() => ({ state: '', diskReads: 0, writes: 0, procLists: 0, procStats: 0 }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs,
    existsSync: (path: unknown) => path === '/fixture/sampling.json' || fs.existsSync(path as string),
    readdirSync: (path: unknown, ...args: any[]) => { if (path === '/proc') { io.procLists++; return ['100', '101']; } return (fs.readdirSync as any)(path, ...args); },
    mkdirSync: (...args: any[]) => { if (args[0] !== '/fixture') return (fs.mkdirSync as any)(...args); },
    renameSync: (from: string, to: string) => { if (to !== '/fixture/sampling.json') fs.renameSync(from, to); },
    writeFileSync: (...args: any[]) => { if (String(args[0]).startsWith('/fixture/sampling.json')) { io.writes++; io.state = args[1]; } else (fs.writeFileSync as any)(...args); },
    readFileSync: (...args: any[]) => {
      const path = String(args[0]);
      if (path === '/fixture/sampling.json') { io.diskReads++; return io.state; }
      if (/^\/proc\/10[01]\//.test(path)) {
        if (path.endsWith('/stat')) { io.procStats++; const fields = Array(20).fill('0'); fields[0] = 'R'; fields[1] = path.includes('/101/') ? '100' : '1'; fields[19] = '50'; return `100 (fixture) ${fields.join(' ')}`; }
        if (path.endsWith('/status')) return `Uid: ${process.getuid!()} ${process.getuid!()} ${process.getuid!()} ${process.getuid!()}\n`;
        if (path.endsWith('/environ')) return `dutydeck_terminal_launch_id=${'a'.repeat(64)}\0`;
      }
      return (fs.readFileSync as any)(...args);
    },
  };
});
afterEach(() => { vi.useRealTimers(); spawn.mockReset(); vi.restoreAllMocks(); });
function controller() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
}
function frame(target: ReturnType<typeof controller>, data: string) {
  target.stdout.write(JSON.stringify({ type: 'terminal.frame', bytes: Buffer.from(data).toString('base64'), width: 80, height: 24 }) + '\n');
}
async function attach(backend: HerdrBackend, target: ReturnType<typeof controller>, initial = 'READY') {
  spawn.mockReturnValueOnce(target);
  const calls = spawn.mock.calls.length;
  const ready = backend.attach({ cols: 80, rows: 24 });
  await vi.waitFor(() => expect(spawn.mock.calls.length).toBeGreaterThan(calls));
  frame(target, initial); await ready;
}
function fixture() {
  const identity = { host: 'fixture', boot: 'fixture', namespace: 'fixture', pid: 100, start: '50' };
  const name = `dutydeck-${'a'.repeat(32)}`;
  const state = { launch_id: 'a'.repeat(64), owner: 'fixture', name, server: identity, root: identity, socket: '/fixture/socket', dev: '1', ino: '1', pane: { pane_id: 'pane', terminal_id: 'terminal' }, identities: [identity] };
  Object.assign(io, { state: JSON.stringify(state), diskReads: 0, writes: 0, procLists: 0, procStats: 0 });
  const observe = vi.fn(() => 'alive' as const);
  const backend = new HerdrBackend(name, { binary: 'unused', stateFile: '/fixture/sampling.json', ownerId: 'fixture', processProbe: { identify: pid => ({ ...identity, pid }), observe } });
  const socket = vi.spyOn(backend as any, 'socketStat').mockReturnValue({ dev: '1', ino: '1' });
  const cli = vi.spyOn(backend as any, 'cli').mockImplementation(async (args: any) => JSON.stringify({ result: args[1] === 'list' ? { panes: [state.pane] } : { process_info: { shell_pid: 100 } } }));
  return { backend, state: (backend as any).state, cli, socket, observe };
}

it('samples the process table and CLI once per capture and durably retains a newly seen child', async () => {
  const { backend, state, cli } = fixture();
  const snapshot = await backend.captureOwnedIdentity() as any;
  expect(cli).toHaveBeenCalledTimes(2); expect(io.procLists).toBe(1); expect(io.procStats).toBe(2);
  expect(snapshot.identities.map((item: any) => item.pid)).toEqual([100, 101]);
  state.identities = snapshot.identities; (backend as any).persist();
  expect(io.writes).toBe(1); expect(JSON.parse(io.state).identities).toEqual(snapshot.identities);
  (backend as any).persist(); expect(io.writes).toBe(1);
});

it('skips only a complete unchanged state and still checks disk launch_id on every persist', () => {
  const { backend, state } = fixture(); io.diskReads = 0;
  (backend as any).persist(); expect(io.writes).toBe(0); expect(io.diskReads).toBe(1);
  for (const [key, value] of [['turn_id', 'turn'], ['first_prompt_sent', '1'], ['close_intent', true], ['closed', true]] as const) {
    state[key] = value; (backend as any).persist(); expect(JSON.parse(io.state)[key]).toBe(value);
  }
  expect(io.writes).toBe(4); expect(io.diskReads).toBe(5);
  io.state = JSON.stringify({ ...state, launch_id: 'b'.repeat(64) });
  expect(() => (backend as any).persist()).toThrow('HERDR_STATE_GENERATION_CHANGED');
  expect(io.writes).toBe(4); expect(io.diskReads).toBe(6);
});

it.each([0, 1])('rejects a lifecycle replacement across CLI await %s', async index => {
  const { backend, cli } = fixture(); const original = cli.getMockImplementation()!;
  cli.mockImplementation(async (...args: any[]) => { const result = await (original as any)(...args); if (cli.mock.calls.length === index + 1) (backend as any).lifecycle++; return result; });
  await expect(backend.captureOwnedIdentity()).rejects.toThrow('HERDR_LIFECYCLE_CHANGED'); expect(io.procLists).toBe(0);
});

it('rechecks the socket and lifecycle after checked resolves before reading processes', async () => {
  const { backend, socket } = fixture(); socket.mockReturnValueOnce({ dev: '1', ino: '1' }).mockReturnValue({ dev: '1', ino: '2' });
  await expect(backend.captureOwnedIdentity()).rejects.toThrow('HERDR_SERVER_IDENTITY_CHANGED'); expect(io.procLists).toBe(0);
  socket.mockReturnValue({ dev: '1', ino: '1' });
  const checked = (backend as any).checked.bind(backend);
  vi.spyOn(backend as any, 'checked').mockImplementation(async () => { const state = await checked(false); (backend as any).lifecycle++; return state; });
  await expect(backend.captureOwnedIdentity()).rejects.toThrow('HERDR_LIFECYCLE_CHANGED'); expect(io.procLists).toBe(0);
});

it('keeps the two kill censuses fresh and rejects a process appearing between them', async () => {
  const { backend, state } = fixture();
  vi.spyOn(backend, 'isStopped').mockResolvedValue(false);
  const descendants = vi.spyOn(backend as any, 'descendants').mockResolvedValueOnce([state.root]).mockResolvedValueOnce([state.root, { ...state.root, pid: 102 }]);
  const owned = vi.spyOn(backend as any, 'ownedProcesses').mockReturnValue([]);
  await expect(backend.kill()).rejects.toThrow('HERDR_PROCESS_SET_CHANGED');
  expect(descendants).toHaveBeenCalledTimes(2); expect(owned.mock.calls).toEqual([[], []]); expect(io.writes).toBe(0);
});

it('rejects a PID reused after the shared stat sample instead of retaining its replacement identity', async () => {
  const { backend } = fixture();
  const probe = (backend as any).options.processProbe;
  const original = probe.identify;
  probe.identify = (pid: number) => ({ ...original(pid), start: pid === 101 ? '60' : '50' });
  await expect(backend.captureOwnedIdentity()).rejects.toThrow('HERDR_PROCESS_IDENTITY_CHANGED');
  expect(io.writes).toBe(0);
});

it('does no management spawn or process census while attached output is quiet, but still checks root liveness', async () => {
  const { backend, cli, observe } = fixture(), target = controller();
  try {
    await attach(backend, target, '');
    const original = backend.captureOwnedIdentity.bind(backend), samples: Promise<unknown>[] = [];
    const capture = vi.spyOn(backend, 'captureOwnedIdentity').mockImplementation(() => {
      const sample = original(); samples.push(sample); return sample;
    });
    await vi.waitFor(() => expect(samples).toHaveLength(1)); await samples[0];
    cli.mockClear(); observe.mockClear(); spawn.mockClear();
    Object.assign(io, { writes: 0, procLists: 0, procStats: 0 });
    await vi.waitFor(() => {
      frame(target, '');
      expect(capture).toHaveBeenCalledTimes(1);
      expect(cli).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
      expect(io.procLists).toBe(0); expect(io.procStats).toBe(0); expect(io.writes).toBe(0);
      expect(observe.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, { interval: 100, timeout: 5000 });
  } finally { await backend.detach(); }
});

it('samples active output at most once per timer interval and stops after the final dirty capture', async () => {
  vi.useFakeTimers();
  const { backend } = fixture(), target = controller();
  try {
    await attach(backend, target);
    const original = backend.captureOwnedIdentity.bind(backend), times: number[] = [];
    vi.spyOn(backend, 'captureOwnedIdentity').mockImplementation(() => { times.push(Date.now()); return original(); });
    for (let index = 0; index < 20; index++) { frame(target, `OUTPUT_${index}`); await vi.advanceTimersByTimeAsync(100); }
    expect(times.length).toBeGreaterThan(1);
    for (let index = 1; index < times.length; index++) expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(500);
    const count = times.length; await vi.advanceTimersByTimeAsync(1000);
    expect(times).toHaveLength(count);
  } finally { await backend.detach(); }
});

it('retains dirty when a frame arrives during capture and samples again on the next tick', async () => {
  vi.useFakeTimers();
  const { backend, state } = fixture(), target = controller();
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    await attach(backend, target);
    const capture = vi.spyOn(backend, 'captureOwnedIdentity').mockImplementationOnce(() => pending).mockResolvedValue(state);
    await vi.advanceTimersByTimeAsync(500); expect(capture).toHaveBeenCalledTimes(1);
    frame(target, 'DURING_CAPTURE'); release(state); await vi.advanceTimersByTimeAsync(0);
    expect((backend as any).identityCaptureDirty).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(2); expect((backend as any).identityCaptureDirty).toBe(false);
  } finally { release(state); await backend.detach(); }
});

it.each(['capture', 'persist'])('keeps dirty after %s failure and retries both census and persistence', async failure => {
  vi.useFakeTimers();
  const { backend, state } = fixture(), target = controller();
  try {
    await attach(backend, target);
    const snapshot = structuredClone(state);
    snapshot.identities = [...snapshot.identities, { ...state.root, pid: 102 }];
    const capture = vi.spyOn(backend, 'captureOwnedIdentity');
    const persist = vi.spyOn(backend as any, 'persist');
    if (failure === 'capture') capture.mockRejectedValueOnce(new Error('temporary capture failure')).mockResolvedValue(snapshot);
    else {
      capture.mockResolvedValue(snapshot);
      persist.mockImplementationOnce(() => { throw new Error('temporary persist failure'); });
    }
    await vi.advanceTimersByTimeAsync(500);
    expect((backend as any).identityCaptureDirty).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(2); expect((backend as any).identityCaptureDirty).toBe(false);
    if (failure === 'persist') expect(persist).toHaveBeenCalledTimes(2);
    expect(JSON.parse(io.state).identities).toEqual(snapshot.identities);
  } finally { await backend.detach(); }
});

it('does not let an old capture clear the dirty state of a replacement attachment', async () => {
  vi.useFakeTimers();
  const { backend, state } = fixture(), first = controller(), replacement = controller();
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  try {
    await attach(backend, first);
    const capture = vi.spyOn(backend, 'captureOwnedIdentity').mockImplementationOnce(() => pending).mockResolvedValue(state);
    await vi.advanceTimersByTimeAsync(500); expect(capture).toHaveBeenCalledTimes(1);
    await attach(backend, replacement); expect(capture).toHaveBeenCalledTimes(2);
    release(state); await vi.advanceTimersByTimeAsync(0);
    expect((backend as any).identityCaptureDirty).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(3); expect((backend as any).identityCaptureDirty).toBe(false);
  } finally { release(state); await backend.detach(); }
});
