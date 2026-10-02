import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { runCommand } from './command.js';
import { OutputHandoff } from './output-handoff.js';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { SessionBackend, SpawnOptions } from './types.js';
import type { PhysicalProcessIdentity, ProcessProbe } from './owned-tmux.js';

type Pane = { pane_id: string; terminal_id: string };
interface State {
  launch_id: string; owner: string; name: string; socket: string; dev: string; ino: string;
  server: PhysicalProcessIdentity; pane: Pane | null; launching?: boolean; close_intent?: boolean; root: PhysicalProcessIdentity;
  process_session?: number; process_cgroup: string; identities: PhysicalProcessIdentity[]; closed?: boolean; first_prompt_sent?: string; turn_id?: string;
}
export interface HerdrBackendOptions {
  binary: string; stateFile: string; ownerId: string; processProbe: ProcessProbe;
  env?: NodeJS.ProcessEnv;
}

export function herdrControlEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^HERDR_/i.test(key)));
}

/** A dedicated named server and an argv-launched primary pane. Never uses default or focused targets. */
export class HerdrBackend implements SessionBackend {
  readonly kind = 'herdr' as const;
  readonly ownerId: string;
  initialScreen?: { data: string; cols: number; rows: number };
  private state?: State;
  private stream?: ChildProcessWithoutNullStreams;
  private readonly output = new OutputHandoff();
  private inputGeneration = 0;
  private readonly pendingInput = new Set<() => void>();
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly environment: NodeJS.ProcessEnv;
  private lifecycle = 0;
  private creation?: Promise<void>;
  private attachReject?: (error: Error) => void;
  private disconnectCallbacks: Array<(error: Error) => void> = [];
  private captures: PhysicalProcessIdentity[] = [];
  private executionTimer?: NodeJS.Timeout;
  private naturalExit?: Promise<boolean>;
  private size = { cols: 120, rows: 30 };

  constructor(readonly sessionName: string, private readonly options: HerdrBackendOptions) {
    if (!/^dutydeck-[a-f0-9]{32}$/.test(sessionName)) throw new Error('HERDR_SCOPE_INVALID');
    this.ownerId = options.ownerId;
    this.environment = herdrControlEnvironment(options.env ?? process.env);
    if (existsSync(options.stateFile)) {
      const state: State = JSON.parse(readFileSync(options.stateFile, 'utf8'));
      if (state.owner !== this.ownerId || state.name !== sessionName) throw new Error('HERDR_OWNER_MISMATCH');
      this.state = state;
    }
  }
  hasState(): boolean { return !!this.state; }
  fork(): HerdrBackend { return new HerdrBackend(this.sessionName, this.options); }
  private async cli(args: string[]): Promise<string> {
    try { return await runCommand(this.options.binary, ['--session', this.sessionName, ...args], { env: this.environment }); }
    catch (error) { throw new Error(`Herdr request failed; no backend fallback: ${String((error as { stderr?: Buffer }).stderr ?? (error as Error).message)}`); }
  }
  private persist(): void {
    // A retired controller can resume an async observation after fork() has
    // reserved a new launch in this same file. It must never overwrite it.
    const persisted: State = JSON.parse(readFileSync(this.options.stateFile, 'utf8'));
    if (persisted.launch_id !== this.state?.launch_id) throw new Error('HERDR_STATE_GENERATION_CHANGED');
    mkdirSync(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.options.stateFile);
  }
  private socketStat(path: string) {
    if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error('HERDR_SOCKET_PATH_INVALID');
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isSocket() || Number(stat.uid) !== process.getuid?.()) throw new Error('HERDR_SOCKET_OWNER_MISMATCH');
    return { dev: String(stat.dev), ino: String(stat.ino) };
  }
  private async checked(requireLaunched = true): Promise<State> {
    const state = this.state, generation = this.lifecycle;
    const check = () => { if (this.state !== state || this.lifecycle !== generation) throw new Error('HERDR_LIFECYCLE_CHANGED'); };
    if (!state?.root || !state.server) throw new Error('HERDR_LAUNCH_IDENTITY_INCOMPLETE; refusing duplicate launch');
    const stat = this.socketStat(state.socket);
    if (stat.dev !== state.dev || stat.ino !== state.ino || this.options.processProbe.observe(state.server) !== 'alive') {
      throw new Error('HERDR_SERVER_IDENTITY_CHANGED');
    }
    if (state.launching) {
      if (requireLaunched) throw new Error('HERDR_LAUNCH_IDENTITY_INCOMPLETE; refusing to attach a launch reservation');
      return state;
    }
    if (!state.pane) throw new Error('HERDR_PANE_IDENTITY_UNAVAILABLE');
    const panes: Pane[] = JSON.parse((await this.cli(['pane', 'list']))).result.panes;
    check();
    if (!panes.some(pane => pane.pane_id === state.pane!.pane_id && pane.terminal_id === state.pane!.terminal_id)) throw new Error('HERDR_PANE_IDENTITY_CHANGED');
    const info = JSON.parse((await this.cli(['pane', 'process-info', '--pane', state.pane!.pane_id]))).result.process_info;
    check();
    if (info.shell_pid !== state.root.pid || this.options.processProbe.observe(state.root) !== 'alive') throw new Error('HERDR_PROCESS_IDENTITY_CHANGED');
    return state;
  }
  private async request<T>(method: string, params: unknown, path?: string, inputGeneration?: number): Promise<T> {
    path ??= (await this.checked()).socket;
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      // Control replies are small JSON records. Bound both elapsed time and
      // bytes, even when a peer keeps sending incomplete response fragments.
      const maxResponseBytes = 1024 * 1024;
      let buffer = Buffer.allocUnsafe(4096), received = 0, settled = false;
      const finish = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingInput.delete(cancel);
        buffer = Buffer.alloc(0);
        socket.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const cancel = () => finish(new Error('Herdr input cancelled before send'));
      const timer = setTimeout(() => finish(new Error('Herdr API timeout')), 5000);
      if (inputGeneration !== undefined) {
        this.pendingInput.add(cancel);
        if (inputGeneration !== this.inputGeneration) cancel();
      }
      socket.on('error', error => finish(error));
      socket.on('end', () => finish(new Error('Herdr API closed without a response')));
      socket.on('close', () => finish(new Error('Herdr API closed without a response')));
      socket.on('connect', () => {
        if (settled) return;
        if (inputGeneration !== undefined && inputGeneration !== this.inputGeneration) { cancel(); return; }
        // Once write is attempted delivery is unknown until the bounded reply.
        this.pendingInput.delete(cancel);
        try { socket.write(JSON.stringify({ id: 'dutydeck', method, params }) + '\n'); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        const newline = chunk.indexOf(10);
        const fragment = newline < 0 ? chunk : chunk.subarray(0, newline);
        const size = received + fragment.length;
        if (size > maxResponseBytes) { finish(new Error('Herdr API response exceeds 1048576 bytes')); return; }
        if (size > buffer.length) {
          const grown = Buffer.allocUnsafe(Math.min(maxResponseBytes, Math.max(size, buffer.length * 2)));
          buffer.copy(grown, 0, 0, received); buffer = grown;
        }
        fragment.copy(buffer, received); received = size;
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.toString('utf8', 0, received));
          if (response.error) finish(new Error(`Herdr ${response.error.code}: ${response.error.message}`));
          else finish(undefined, response.result);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
    });
  }
  async cancelPending(): Promise<void> {
    this.lifecycle++;
    (await this.detach());
    await this.creation?.catch(() => {});
  }
  spawn(bin: string, args: string[], opts: SpawnOptions): Promise<void> {
    const generation = this.lifecycle;
    const creation = this.launch(bin, args, opts, generation);
    this.creation = creation;
    return creation.finally(() => { if (this.creation === creation) this.creation = undefined; });
  }
  private async launch(bin: string, args: string[], opts: SpawnOptions, generation: number): Promise<void> {
    const check = () => { if (generation !== this.lifecycle) throw new Error('Herdr launch cancelled'); };
    check();
    const previous = this.state;
    const launchId = randomBytes(32).toString('hex');
    if (previous && !(await this.isStopped())) throw new Error('Existing Herdr identity requires reattach; refusing duplicate launch');
    if (process.platform !== 'linux') throw new Error('Herdr primary backend currently requires Linux process identity probes');
    const version = (await runCommand(this.options.binary, ['--version'], { env: this.environment, timeout: 5000 })).trim();
    check();
    if (!/^herdr 0\.(?:9|[1-9]\d)\./.test(version)) throw new Error('Herdr >= 0.9 is required for terminal session streams');
    const listing = JSON.parse((await this.cli(['session', 'list', '--json']))).sessions;
    check();
    const existing = listing.find((item: { name: string }) => item.name === this.sessionName);
    if (existing && !previous) throw new Error('Unclaimed Herdr session exists; refusing adoption or replacement');
    // A durable reservation makes an interrupted launch fail closed on retry.
    mkdirSync(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.options.stateFile, JSON.stringify({ owner: this.ownerId, name: this.sessionName, launch_id: launchId }), { mode: 0o600, flag: previous ? 'w' : 'wx' });
    let path: string, serverIdentity: PhysicalProcessIdentity;
    if (existing?.running) {
      if (!previous || this.options.processProbe.observe(previous.server) !== 'alive') throw new Error('HERDR_SERVER_IDENTITY_CHANGED');
      path = realpathSync(existing.socket_path);
      const stat = this.socketStat(path);
      if (path !== previous.socket || stat.dev !== previous.dev || stat.ino !== previous.ino) throw new Error('HERDR_SERVER_IDENTITY_CHANGED');
      serverIdentity = previous.server;
    } else {
      const server = spawn(this.options.binary, ['--session', this.sessionName, 'server'], {
        cwd: opts.cwd, env: Object.fromEntries(Object.entries(this.environment).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_|dutydeck_)/i.test(key))), detached: true, stdio: 'ignore',
      });
      let launchError: Error | undefined;
      server.on('error', error => { launchError = error; });
      server.unref();
      const deadline = Date.now() + 10000;
      let entry: { socket_path: string } | undefined;
      while (!entry) {
        if (launchError) throw launchError;
        const sessions = JSON.parse((await this.cli(['session', 'list', '--json']))).sessions;
        entry = sessions.find((item: { name: string; default: boolean; running: boolean }) => item.name === this.sessionName && !item.default && item.running);
        if (!entry) {
          if (Date.now() >= deadline || server.exitCode !== null) throw new Error('Herdr dedicated server did not become ready');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      // Preserve a reservation containing the dedicated server identity before cancellation.
      path = realpathSync(entry.socket_path);
      serverIdentity = this.options.processProbe.identify(server.pid!);
    }
    const stat = this.socketStat(path);
    this.state = { launch_id: launchId, owner: this.ownerId, name: this.sessionName, socket: path, ...stat, server: serverIdentity, root: serverIdentity, pane: null, launching: true, process_cgroup: readFileSync(`/proc/${serverIdentity.pid}/cgroup`, 'utf8'), identities: [serverIdentity] };
    this.persist();
    check();
    const workspace = await this.request<{ tab: { tab_id: string } }>('workspace.create', { cwd: opts.cwd, label: 'DutyDeck primary', focus: false }, path);
    check();
    const environment = { ...herdrControlEnvironment({ ...opts.env, ...opts.injectEnv }), dutydeck_terminal_launch_id: launchId };
    const layout = await this.request<{ layout: { root: { pane_id: string } } }>('layout.apply', {
      tab_id: workspace.tab.tab_id, focus: false,
      root: { type: 'pane', cwd: opts.cwd, command: [bin, ...args], env: environment },
    }, path);
    const panes: Pane[] = JSON.parse((await this.cli(['pane', 'list']))).result.panes;
    const pane = panes.find(item => item.pane_id === layout.layout.root.pane_id);
    if (!pane) throw new Error('Herdr did not return the launched primary pane');
    const info = JSON.parse((await this.cli(['pane', 'process-info', '--pane', pane.pane_id]))).result.process_info;
    const root = this.options.processProbe.identify(info.shell_pid);
    this.state = { launch_id: launchId, owner: this.ownerId, name: this.sessionName, socket: path, ...stat, server: serverIdentity, pane, root, process_session: Number(readFileSync(`/proc/${root.pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[3]), process_cgroup: readFileSync(`/proc/${root.pid}/cgroup`, 'utf8'), identities: [root] };
    this.persist();
    check();
    await this.attach(opts);
    check();
  }
  async attach(opts: { cols: number; rows: number }, onBoundary?: () => void): Promise<void> {
    const generation = this.lifecycle;
    const check = () => { if (generation !== this.lifecycle) throw new Error('Herdr attachment cancelled'); };
    const state = await this.checked();
    check();
    await this.detach(false, Boolean(onBoundary));
    check();
    onBoundary?.();

    this.size = { cols: opts.cols, rows: opts.rows };
    this.initialScreen = undefined;
    const child = spawn(this.options.binary, ['--session', this.sessionName, 'terminal', 'session', 'control', state.pane!.terminal_id, '--cols', String(opts.cols), '--rows', String(opts.rows)], {
      env: this.environment, stdio: 'pipe',
    });
    this.stream = child;
    if (child.pid) this.captures.push(this.options.processProbe.identify(child.pid));
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { clearTimeout(timer); if (this.attachReject === fail) this.attachReject = undefined; reject(error); };
      const timer = setTimeout(async () => { fail(new Error('Herdr terminal stream did not become ready')); if (this.stream === child) (await this.detach()); }, 5000);
      this.attachReject = fail;
      const lines = createInterface({ input: child.stdout });
      child.once('error', fail);
      child.once('exit', async code => {
        if (this.stream !== child) { fail(new Error('Herdr terminal attachment cancelled')); return; }
        if ((await this.finishNaturalExit())) { fail(new Error('Primary process exited')); return; }
        const error = new Error(`Herdr terminal stream disconnected (${code}): ${stderr}; original pane preserved`);
        fail(error);
        // Transport failure is not process exit. Keep physical ownership and make the turn unresolved.
        if (this.initialScreen) void this.observeClosedStream(child, error);
      });
      lines.on('line', async line => {
        if (this.stream !== child) return;
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'terminal.frame') {
            const data = Buffer.from(frame.bytes, 'base64').toString('utf8');
            this.size = { cols: frame.width, rows: frame.height };
            if (!this.initialScreen) {
              this.initialScreen = { data, ...this.size };
              clearTimeout(timer); this.attachReject = undefined;
              let polling = false;
              this.executionTimer = setInterval(async () => {
                if (this.stream !== child || polling) return;
                polling = true;
                try {
                  if (await this.finishNaturalExit()) return;
                  const snapshot = await this.captureOwnedIdentity() as State;
                  if (this.stream !== child || this.state !== state || generation !== this.lifecycle) return;
                  this.state.identities = snapshot.identities; this.persist();
                } catch { /* Unknown observations never prove exit. */ }
                finally { polling = false; }
              }, 500); this.executionTimer.unref();
              resolve();
            } else this.output.data(data);
          } else if (frame.type === 'terminal.closed') {
            if ((await this.finishNaturalExit())) { fail(new Error('Primary process exited')); return; }
            const error = new Error(`Herdr terminal stream closed: ${frame.reason ?? 'unknown'}; execution exit is unverified`);
            fail(error);
            if (this.initialScreen) void this.observeClosedStream(child, error);
            else if (this.stream === child) (await this.detach());
          }
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    }).catch(async error => { if (this.stream === child) (await this.detach()); throw error; });
  }
  private async observeClosedStream(child: ChildProcessWithoutNullStreams, error: Error): Promise<void> {
    if (this.stream !== child) return;
    const state = this.state, generation = this.lifecycle;
    const disconnect = async () => {
      const callbacks = [...this.disconnectCallbacks]; (await this.detach());
      for (const callback of callbacks) callback(error);
    };
    this.stream = undefined; child.stdin.end(); child.kill();
    this.output.reset();
    if (this.executionTimer) clearInterval(this.executionTimer);
    this.executionTimer = undefined;
    if (!state || this.options.processProbe.observe(state.root) === 'alive') { await disconnect(); return; }
    const deadline = Date.now() + 5000;
    let polling = false;
    const timer = setInterval(async () => {
      if (this.executionTimer !== timer || polling) return;
      polling = true;
      try {
      if (this.state !== state || this.lifecycle !== generation) {
        clearInterval(timer); this.executionTimer = undefined; return;
      }
      if ((await this.finishNaturalExit())) return;
      if (this.state !== state || generation !== this.lifecycle || this.executionTimer !== timer) return;
      if (this.options.processProbe.observe(state.root) === 'alive' || Date.now() >= deadline) await disconnect();
      } finally { polling = false; }
    }, 500);
    this.executionTimer = timer; timer.unref();
  }
  async assertOwnedIdentity(raw: unknown): Promise<void> { this.validateIdentity(raw); (await this.checked()); }
  async getDutydeckMetadata(key: 'first_prompt_sent' | 'turn_id'): Promise<string | undefined> { (await this.checked()); return this.state![key]; }
  async setDutydeckMetadata(key: 'first_prompt_sent' | 'turn_id', value: string): Promise<void> { (await this.checked()); this.state![key] = value; this.persist(); }
  async write(data: string): Promise<boolean> {
    const generation = this.inputGeneration;
    const state = (await this.checked());
    if (generation !== this.inputGeneration) return false;
    if (!this.stream?.stdin.writable) throw new Error('Herdr terminal controller is disconnected; original pane preserved');
    // The API response confirms the input reached this exact pane.
    await this.request('pane.send_text', { pane_id: state.pane!.pane_id, text: data }, state.socket, generation);
    return generation === this.inputGeneration;
  }
  private cancelInput(): void {
    this.inputGeneration++;
    for (const cancel of this.pendingInput) cancel();
  }
  async interrupt(): Promise<void> { this.cancelInput(); const state = (await this.checked()); (await this.cli(['pane', 'send-keys', state.pane!.pane_id, 'ctrl+c'])); }
  async resize(cols: number, rows: number): Promise<void> {
    (await this.checked());
    if (!this.stream?.stdin.writable) throw new Error('Herdr terminal controller is detached');
    this.stream.stdin.write(JSON.stringify({ type: 'terminal.resize', cols, rows }) + '\n');
  }
  async resyncOutput(onBoundary?: () => void): Promise<string | null> {
    // A new controller's first frame is the snapshot boundary; later frames
    // remain subscribed and are queued by the driver's refresh single-flight.
    await this.attach(this.size, onBoundary ?? (() => {}));
    return this.initialScreen?.data ?? null;
  }
  async captureCurrentScreen(): Promise<string> { const state = (await this.checked()); return (await this.cli(['pane', 'read', state.pane!.pane_id, '--source', 'visible', '--ansi'])); }
  getPaneSize(): { cols: number; rows: number } { return this.size; }
  getPid(): number | null { return this.state?.root?.pid ?? null; }
  onData(cb: (data: string) => void): void { this.output.onData(cb); }
  onOutputGap(cb: (dropped: number) => void): void { this.output.onGap(cb); }
  onDisconnect(cb: (error: Error) => void): void { this.disconnectCallbacks.push(cb); }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCallbacks.push(cb); }
  async detach(invalidate = true, preserveSubscriptions = false): Promise<void> {
    this.cancelInput();
    if (invalidate) this.lifecycle++;
    if (this.executionTimer) clearInterval(this.executionTimer);
    this.executionTimer = undefined;
    this.attachReject?.(new Error('Herdr terminal attachment cancelled'));
    this.attachReject = undefined;
    if (this.state?.root && !this.state.close_intent) {
      try {
        const state = this.state;
        const snapshot = (await this.captureOwnedIdentity()) as State;
        if (this.state !== state) return;
        this.state.identities = snapshot.identities;
        this.persist();
      } catch { /* Never treat a failed capture as proof that execution is gone. */ }
    }
    const child = this.stream;
    this.stream = undefined;
    if (child) { child.stdin.end(); child.kill(); }
    this.output.reset(!preserveSubscriptions);
    if (!preserveSubscriptions) { this.exitCallbacks = []; this.disconnectCallbacks = []; }
  }
  private ownedProcesses(): PhysicalProcessIdentity[] {
    const state = this.state;
    if (!state || !/^[a-f0-9]{64}$/.test(state.launch_id)) throw new Error('HERDR_OWNERSHIP_MARKER_UNAVAILABLE');
    const marker = `dutydeck_terminal_launch_id=${state.launch_id}`;
    const identities: PhysicalProcessIdentity[] = [];
    for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      let stage = 'stat', originalStart: string | undefined;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
        originalStart = stat[19];
        if (stat[0] === 'Z' || stat[0] === 'X') continue;
        // A process born before this immutable root cannot inherit this launch's private marker.
        if (BigInt(originalStart!) < BigInt(state.root.start)) continue;
        stage = 'uid';
        const uids = readFileSync(`/proc/${entry}/status`, 'utf8').match(/^Uid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/);
        // /proc directory ownership changes when dumpability changes, even without a process UID change.
        if (!uids) throw new Error('PROCESS_UID_UNKNOWN');
        if (!uids.includes(String(process.getuid!()))) continue;
        stage = 'environ';
        if (readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(marker)) {
          stage = 'identity'; identities.push(this.options.processProbe.identify(Number(entry)));
        }
      } catch (error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === 'ENOENT' || errno === 'ESRCH') continue;
        // Exit can turn an earlier-readable environ into EACCES before /proc disappears.
        // Reobserve the same identity; only actual death/disappearance clears that uncertainty.
        let observed = 'unknown', sameLiveIdentity = false, retryErrno: string | undefined, cgroup = 'unknown', comm = 'unknown';
        try {
          const after = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
          observed = `${after[0]}:${after[19]}`;
          if (after[19] === originalStart && (after[0] === 'Z' || after[0] === 'X')) continue;
          sameLiveIdentity = after[19] === originalStart;
        } catch (second) {
          if (['ENOENT', 'ESRCH'].includes((second as NodeJS.ErrnoException).code ?? '')) continue;
        }
        if (stage === 'environ' && (errno === 'EACCES' || errno === 'EPERM')) {
          if (sameLiveIdentity) {
            try {
              // exec/exit transitions can temporarily revoke environ access. Classify actual contents once readable.
              const environment = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0');
              const after = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
              observed = `${after[0]}:${after[19]}`;
              if (after[19] !== originalStart) throw new Error('PROCESS_IDENTITY_CHANGED');
              if (after[0] === 'Z' || after[0] === 'X') continue;
              if (environment.includes(marker)) {
                stage = 'identity';
                const identity = this.options.processProbe.identify(Number(entry));
                if (identity.start !== originalStart) throw new Error('PROCESS_IDENTITY_CHANGED');
                identities.push(identity);
              }
              continue;
            } catch (retry) {
              retryErrno = (retry as NodeJS.ErrnoException).code;
              if (retryErrno === 'ENOENT' || retryErrno === 'ESRCH') continue;
            }
          }
          if (stage === 'environ') {
            try {
              // Independent SSH/logind sessions can be unreadable despite sharing our UID.
              // Readable marker owners are counted above even if they changed cgroup.
              const systemdPath = (raw: string) => raw.match(/^(?:\d+:name=systemd|0:):(.+)$/m)?.[1];
              cgroup = readFileSync(`/proc/${entry}/cgroup`, 'utf8').trim();
              const original = systemdPath(state.process_cgroup), candidate = systemdPath(cgroup);
              const login = candidate?.match(/^(\/user\.slice\/user-\d+\.slice\/)(session-\d+\.scope)(?:\/|$)/);
              const after = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
              observed = `${after[0]}:${after[19]}`;
              if (after[19] === originalStart && (after[0] === 'Z' || after[0] === 'X')) continue;
              if (after[19] === originalStart && login && original?.startsWith(login[1]!)
                && original !== login[1]! + login[2]! && !original.startsWith(login[1]! + login[2]! + '/')) continue;
            } catch { /* Unknown membership or identity remains unresolved. */ }
          }
        }
        try { comm = readFileSync(`/proc/${entry}/comm`, 'utf8').trim(); } catch { /* Diagnostic metadata only. */ }
        throw new Error(`HERDR_OWNERSHIP_CENSUS_UNKNOWN pid=${entry} stage=${stage} errno=${errno ?? 'unknown'} retry_errno=${retryErrno ?? 'unknown'} state_start=${observed} comm=${JSON.stringify(comm)} cgroup=${JSON.stringify(cgroup)}`);
      }
    }
    return identities;
  }
  private async descendants(): Promise<PhysicalProcessIdentity[]> {
    const state = (await this.checked(false));
    const children = new Map<number, number[]>();
    for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const raw = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const parent = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1]);
        children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const pids = new Set<number>(), pending = [state.root.pid];
    while (pending.length) { const pid = pending.pop()!; if (pids.has(pid)) continue; pids.add(pid); pending.push(...children.get(pid) ?? []); }
    return [...pids].map(pid => this.options.processProbe.identify(pid));
  }
  private boundServer(state: State): void {
    const observation = this.options.processProbe.observe(state.server);
    if (observation === 'unknown') throw new Error('HERDR_SERVER_IDENTITY_UNKNOWN');
    try {
      const stat = this.socketStat(state.socket);
      if (stat.dev !== state.dev || stat.ino !== state.ino) throw new Error('HERDR_SERVER_IDENTITY_CHANGED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || observation !== 'dead') throw error;
    }
  }
  private exitedSnapshot(): State {
    const state = this.state;
    if (!state?.root || state.launching || !state.pane || this.options.processProbe.observe(state.root) !== 'dead') throw new Error('HERDR_EXIT_UNPROVEN');
    this.boundServer(state);
    const captured = structuredClone(state);
    // PTY children retain the original process session even after reparenting.
    // Any such survivor prevents exit proof, in addition to all historical identities.
    if (state.process_session !== undefined) {
      for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        try {
          const fields = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ').at(-1)!.split(' ');
          if (Number(fields[3]) === state.process_session && fields[0] !== 'Z' && fields[0] !== 'X') {
            const identity = this.options.processProbe.identify(Number(entry));
            if (!captured.identities.some(item => isDeepStrictEqual(item, identity))) captured.identities.push(identity);
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    for (const identity of this.ownedProcesses()) {
      if (!captured.identities.some(item => isDeepStrictEqual(item, identity))) captured.identities.push(identity);
    }
    return captured;
  }
  private finishNaturalExit(): Promise<boolean> {
    if (this.naturalExit) return this.naturalExit;
    const finishing = this.finishNaturalExitOnce();
    this.naturalExit = finishing;
    return finishing.finally(() => { if (this.naturalExit === finishing) this.naturalExit = undefined; });
  }
  private async finishNaturalExitOnce(): Promise<boolean> {
    const state = this.state, generation = this.lifecycle;
    try {
      const snapshot = this.exitedSnapshot();
      this.state!.identities = snapshot.identities; this.persist();
      if (!(await this.verifyOwnedIdentity(snapshot)) || this.state !== state || generation !== this.lifecycle) return false;
      const callbacks = [...this.exitCallbacks]; (await this.detach());
      for (const callback of callbacks) callback(null, null);
      return true;
    } catch { return false; }
  }
  async captureOwnedIdentity(): Promise<unknown> {
    try {
      (await this.checked(false));
      const state = structuredClone(this.state!);
      state.identities = [...new Map([...state.identities, ...(await this.descendants()), ...this.ownedProcesses()].map(item => [JSON.stringify(item), item])).values()];
      return state;
    } catch (error) {
      if (this.state && this.options.processProbe.observe(this.state.root) === 'dead') return this.exitedSnapshot();
      throw error;
    }
  }
  private validateIdentity(raw: unknown): State {
    const snapshot = raw as State, state = this.state;
    if (!state || !snapshot) throw new Error('HERDR_IDENTITY_UNAVAILABLE');
    for (const key of ['launch_id', 'owner', 'name', 'socket', 'dev', 'ino', 'server', 'pane', 'root', 'process_session', 'process_cgroup'] as const) {
      if (!isDeepStrictEqual(snapshot[key], state[key])) throw new Error('HERDR_RETIREMENT_SCOPE_CONFLICT');
    }
    if (!Array.isArray(snapshot.identities) || !snapshot.identities.length) throw new Error('HERDR_EXIT_UNPROVEN');
    return snapshot;
  }
  async verifyOwnedIdentity(raw: unknown): Promise<boolean> {
    try {
      const snapshot = this.validateIdentity(raw), state = this.state!;
      // A pre-kill receipt cannot omit descendants captured durably before close.
      if (state.identities.some(item => !snapshot.identities.some(prior => isDeepStrictEqual(prior, item)))) return false;
      if (!state.close_intent) {
        const natural = this.exitedSnapshot();
        if (natural.identities.some(item => !snapshot.identities.some(prior => isDeepStrictEqual(prior, item)))) return false;
      }
      if (!this.ownedProcesses().every(identity => this.options.processProbe.observe(identity) === 'dead')) return false;
      if (!snapshot.identities.every(identity => this.options.processProbe.observe(identity) === 'dead')) return false;
      try {
        const stat = this.socketStat(snapshot.socket);
        if (stat.dev !== snapshot.dev || stat.ino !== snapshot.ino) return false;
        const panes: Pane[] = JSON.parse((await this.cli(['pane', 'list']))).result.panes;
        return snapshot.launching ? false : !panes.some(pane => pane.terminal_id === snapshot.pane!.terminal_id);
      } catch { return this.options.processProbe.observe(snapshot.server) === 'dead'; }
    } catch { return false; }
  }
  async stopOwnedIdentity(raw: unknown = this.state, beforeKill?: (snapshot: unknown) => Promise<void>): Promise<unknown> {
    this.validateIdentity(raw);
    const deadline = Date.now() + 5000;
    const census = async <T>(read: () => T | Promise<T>): Promise<T> => {
      for (;;) {
        try { return await read(); } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('HERDR_OWNERSHIP_CENSUS_UNKNOWN') || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    };
    const snapshot = await census(async () => (await this.captureOwnedIdentity()) as State);
    if ((await this.verifyOwnedIdentity(snapshot))) {
      this.state!.identities = snapshot.identities; this.persist(); (await this.detach());
    } else {
      await beforeKill?.(snapshot);
      await census(async () => {
        const current = (await this.captureOwnedIdentity()) as State;
        if (current.identities.some(item => !snapshot.identities.some(prior => isDeepStrictEqual(prior, item)))) throw new Error('HERDR_PROCESS_SET_CHANGED');
        this.state!.identities = snapshot.identities;
        this.state!.close_intent = true; this.persist();
        if (this.options.processProbe.observe(this.state!.root) === 'alive') (await this.kill(snapshot.identities));
        else {
          this.boundServer(this.state!);
          if (this.options.processProbe.observe(this.state!.root) !== 'dead') throw new Error('HERDR_EXIT_UNPROVEN');
          if (this.options.processProbe.observe(this.state!.server) === 'alive') {
            const panes: Pane[] = JSON.parse((await this.cli(['pane', 'list']))).result.panes;
            if (panes.some(pane => pane.pane_id === this.state!.pane?.pane_id && pane.terminal_id === this.state!.pane?.terminal_id)) (await this.cli(['pane', 'close', this.state!.pane!.pane_id]));
          }
          (await this.detach());
        }
      });
      // Snapshot holders authorize exactly these immutable processes, including marked setsid children.
      for (const identity of snapshot.identities) {
        const observation = this.options.processProbe.observe(identity);
        if (observation === 'unknown') throw new Error('HERDR_EXIT_UNPROVEN');
        if (observation === 'alive') { try { process.kill(identity.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
      }
    }
    let stopped = (await this.isStopped());
    while (!stopped && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25)); stopped = (await this.isStopped());
    }
    if (!stopped) throw new Error('HERDR_EXIT_UNPROVEN');
    return structuredClone(this.state);
  }
  async kill(expected?: PhysicalProcessIdentity[]): Promise<void> {
    if ((await this.isStopped())) return;
    const state = (await this.checked(false));
    const identities = [...(await this.descendants()), ...this.ownedProcesses()];
    const second = [...(await this.descendants()), ...this.ownedProcesses()];
    const key = (item: PhysicalProcessIdentity) => JSON.stringify(item);
    if (second.some(item => !identities.some(prior => key(item) === key(prior)))) throw new Error('HERDR_PROCESS_SET_CHANGED');
    if (expected && second.some(item => !expected.some(prior => isDeepStrictEqual(prior, item)))) throw new Error('HERDR_PROCESS_SET_CHANGED');
    state.identities = [...new Map([...state.identities, ...identities].map(item => [key(item), item])).values()];
    state.close_intent = true;
    this.persist();
    (await this.checked(false));
    if (state.launching) (await this.cli(['session', 'stop', this.sessionName, '--json']));
    else (await this.cli(['pane', 'close', state.pane!.pane_id]));
    state.closed = true;
    this.persist();
    (await this.detach());
    // Preserve any independently created worker panes in this dedicated server.
    if (!state.launching && JSON.parse((await this.cli(['pane', 'list']))).result.panes.length === 0
      && this.options.processProbe.observe(state.server) === 'alive') (await this.cli(['session', 'stop', this.sessionName, '--json']));
  }
  async isStopped(): Promise<boolean> {
    return !!this.state && (await this.verifyOwnedIdentity(this.state))
      && this.captures.every(identity => this.options.processProbe.observe(identity) === 'dead');
  }
}
