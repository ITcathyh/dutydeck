import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly environment: NodeJS.ProcessEnv;
  private lifecycle = 0;
  private creation?: Promise<void>;
  private attachReject?: (error: Error) => void;
  private disconnectCallbacks: Array<(error: Error) => void> = [];
  private captures: PhysicalProcessIdentity[] = [];
  private executionTimer?: NodeJS.Timeout;
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
  private cli(args: string[]): string {
    try {
      return execFileSync(this.options.binary, ['--session', this.sessionName, ...args], {
        env: this.environment, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Herdr request failed; no backend fallback: ${String((error as { stderr?: Buffer }).stderr ?? (error as Error).message)}`);
    }
  }
  private persist(): void {
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
  private checked(requireLaunched = true): State {
    const state = this.state;
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
    const panes: Pane[] = JSON.parse(this.cli(['pane', 'list'])).result.panes;
    if (!panes.some(pane => pane.pane_id === state.pane!.pane_id && pane.terminal_id === state.pane!.terminal_id)) throw new Error('HERDR_PANE_IDENTITY_CHANGED');
    const info = JSON.parse(this.cli(['pane', 'process-info', '--pane', state.pane!.pane_id])).result.process_info;
    if (info.shell_pid !== state.root.pid || this.options.processProbe.observe(state.root) !== 'alive') throw new Error('HERDR_PROCESS_IDENTITY_CHANGED');
    return state;
  }
  private request<T>(method: string, params: unknown, path = this.checked().socket): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let buffer = '';
      socket.setTimeout(5000, () => socket.destroy(new Error('Herdr API timeout')));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify({ id: 'dutydeck', method, params }) + '\n'));
      socket.on('data', chunk => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        socket.end();
        try {
          const response = JSON.parse(buffer.split('\n')[0]!);
          if (response.error) reject(new Error(`Herdr ${response.error.code}: ${response.error.message}`));
          else resolve(response.result);
        } catch (error) { reject(error); }
      });
      socket.on('end', () => { if (!buffer.includes('\n')) reject(new Error('Herdr API closed without a response')); });
    });
  }
  async cancelPending(): Promise<void> {
    this.lifecycle++;
    this.detach();
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
    if (previous && !this.isStopped()) throw new Error('Existing Herdr identity requires reattach; refusing duplicate launch');
    if (process.platform !== 'linux') throw new Error('Herdr primary backend currently requires Linux process identity probes');
    const version = execFileSync(this.options.binary, ['--version'], { encoding: 'utf8', env: this.environment }).trim();
    if (!/^herdr 0\.(?:9|[1-9]\d)\./.test(version)) throw new Error('Herdr >= 0.9 is required for terminal session streams');
    const listing = JSON.parse(this.cli(['session', 'list', '--json'])).sessions;
    const existing = listing.find((item: { name: string }) => item.name === this.sessionName);
    if (existing && !previous) throw new Error('Unclaimed Herdr session exists; refusing adoption or replacement');
    // A durable reservation makes an interrupted launch fail closed on retry.
    mkdirSync(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.options.stateFile, JSON.stringify({ owner: this.ownerId, name: this.sessionName }), { mode: 0o600, flag: previous ? 'w' : 'wx' });
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
        const sessions = JSON.parse(this.cli(['session', 'list', '--json'])).sessions;
        entry = sessions.find((item: { name: string; default: boolean; running: boolean }) => item.name === this.sessionName && !item.default && item.running);
        if (!entry) {
          if (Date.now() >= deadline || server.exitCode !== null) throw new Error('Herdr dedicated server did not become ready');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
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
    const panes: Pane[] = JSON.parse(this.cli(['pane', 'list'])).result.panes;
    const pane = panes.find(item => item.pane_id === layout.layout.root.pane_id);
    if (!pane) throw new Error('Herdr did not return the launched primary pane');
    const info = JSON.parse(this.cli(['pane', 'process-info', '--pane', pane.pane_id])).result.process_info;
    const root = this.options.processProbe.identify(info.shell_pid);
    this.state = { launch_id: launchId, owner: this.ownerId, name: this.sessionName, socket: path, ...stat, server: serverIdentity, pane, root, process_session: Number(readFileSync(`/proc/${root.pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[3]), process_cgroup: readFileSync(`/proc/${root.pid}/cgroup`, 'utf8'), identities: [root] };
    this.persist();
    check();
    await this.attach(opts);
    check();
  }
  async attach(opts: { cols: number; rows: number }): Promise<void> {
    const state = this.checked();
    this.detach();

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
      const timer = setTimeout(() => { fail(new Error('Herdr terminal stream did not become ready')); if (this.stream === child) this.detach(); }, 5000);
      this.attachReject = fail;
      const lines = createInterface({ input: child.stdout });
      child.once('error', fail);
      child.once('exit', code => {
        if (this.stream !== child) { fail(new Error('Herdr terminal attachment cancelled')); return; }
        if (this.finishNaturalExit()) { fail(new Error('Primary process exited')); return; }
        const error = new Error(`Herdr terminal stream disconnected (${code}): ${stderr}; original pane preserved`);
        fail(error);
        // Transport failure is not process exit. Keep physical ownership and make the turn unresolved.
        if (this.initialScreen) this.observeClosedStream(child, error);
      });
      lines.on('line', line => {
        if (this.stream !== child) return;
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'terminal.frame') {
            const data = Buffer.from(frame.bytes, 'base64').toString('utf8');
            this.size = { cols: frame.width, rows: frame.height };
            if (!this.initialScreen) {
              this.initialScreen = { data, ...this.size };
              clearTimeout(timer); this.attachReject = undefined;
              this.executionTimer = setInterval(() => {
                if (this.stream !== child) return;
                if (this.finishNaturalExit()) return;
                try { this.state!.identities = (this.captureOwnedIdentity() as State).identities; this.persist(); } catch { /* Unknown observations never prove exit. */ }
              }, 500); this.executionTimer.unref();
              resolve();
            } else for (const callback of this.dataCallbacks) callback(data);
          } else if (frame.type === 'terminal.closed') {
            if (this.finishNaturalExit()) { fail(new Error('Primary process exited')); return; }
            const error = new Error(`Herdr terminal stream closed: ${frame.reason ?? 'unknown'}; execution exit is unverified`);
            fail(error);
            if (this.initialScreen) this.observeClosedStream(child, error);
            else if (this.stream === child) this.detach();
          }
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    }).catch(error => { if (this.stream === child) this.detach(); throw error; });
  }
  private observeClosedStream(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.stream !== child) return;
    const state = this.state, generation = this.lifecycle;
    const disconnect = () => {
      const callbacks = [...this.disconnectCallbacks]; this.detach();
      for (const callback of callbacks) callback(error);
    };
    this.stream = undefined; child.stdin.end(); child.kill();
    this.dataCallbacks = [];
    if (this.executionTimer) clearInterval(this.executionTimer);
    this.executionTimer = undefined;
    if (!state || this.options.processProbe.observe(state.root) === 'alive') { disconnect(); return; }
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (this.executionTimer !== timer) return;
      if (this.state !== state || this.lifecycle !== generation) {
        clearInterval(timer); this.executionTimer = undefined; return;
      }
      if (this.finishNaturalExit()) return;
      if (this.options.processProbe.observe(state.root) === 'alive' || Date.now() >= deadline) disconnect();
    }, 500);
    this.executionTimer = timer; timer.unref();
  }
  private requestSync(method: string, params: unknown, path: string): void {
    // stdin carries arbitrary input without CLI option parsing, argv limits, or shell interpolation.
    execFileSync(process.execPath, ['--input-type=module', '-e', String.raw`
      import { readFileSync } from 'node:fs';
      import { createConnection } from 'node:net';
      const { path, method, params } = JSON.parse(readFileSync(0, 'utf8'));
      const socket = createConnection(path);
      socket.setTimeout(4000, () => socket.destroy(new Error('Herdr API timeout')));
      let buffer = '';
      socket.on('connect', () => socket.write(JSON.stringify({ id: 'dutydeck-input', method, params }) + '\n'));
      socket.on('data', chunk => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const response = JSON.parse(buffer.split('\n')[0]);
        socket.destroy();
        if (response.error) { process.stderr.write(response.error.code + ': ' + response.error.message); process.exitCode = 1; }
      });
      socket.on('error', error => { process.stderr.write(error.message); process.exitCode = 1; });
      socket.on('end', () => { if (!buffer.includes('\n')) process.exitCode = 1; });
    `], { input: JSON.stringify({ path, method, params }), env: this.environment, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  assertOwnedIdentity(raw: unknown): void { this.validateIdentity(raw); this.checked(); }
  getDutydeckMetadata(key: 'first_prompt_sent' | 'turn_id'): string | undefined { this.checked(); return this.state![key]; }
  setDutydeckMetadata(key: 'first_prompt_sent' | 'turn_id', value: string): void { this.checked(); this.state![key] = value; this.persist(); }
  write(data: string): boolean {
    const state = this.checked();
    if (!this.stream?.stdin.writable) throw new Error('Herdr terminal controller is disconnected; original pane preserved');
    // The synchronous API response confirms the input reached this exact pane.
    this.requestSync('pane.send_text', { pane_id: state.pane!.pane_id, text: data }, state.socket);
    return true;
  }
  interrupt(): void { const state = this.checked(); this.cli(['pane', 'send-keys', state.pane!.pane_id, 'ctrl+c']); }
  resize(cols: number, rows: number): void {
    this.checked();
    if (!this.stream?.stdin.writable) throw new Error('Herdr terminal controller is detached');
    this.stream.stdin.write(JSON.stringify({ type: 'terminal.resize', cols, rows }) + '\n');
  }
  captureCurrentScreen(): string { const state = this.checked(); return this.cli(['pane', 'read', state.pane!.pane_id, '--source', 'visible', '--ansi']); }
  getPaneSize(): { cols: number; rows: number } { return this.size; }
  getPid(): number | null { return this.checked().root.pid; }
  onData(cb: (data: string) => void): void { this.dataCallbacks.push(cb); }
  onDisconnect(cb: (error: Error) => void): void { this.disconnectCallbacks.push(cb); }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCallbacks.push(cb); }
  detach(): void {
    if (this.executionTimer) clearInterval(this.executionTimer);
    this.executionTimer = undefined;
    this.attachReject?.(new Error('Herdr terminal attachment cancelled'));
    this.attachReject = undefined;
    if (this.state?.root && !this.state.close_intent) {
      try {
        const snapshot = this.captureOwnedIdentity() as State;
        this.state.identities = snapshot.identities;
        this.persist();
      } catch { /* Never treat a failed capture as proof that execution is gone. */ }
    }
    const child = this.stream;
    this.stream = undefined;
    if (child) { child.stdin.end(); child.kill(); }
    this.dataCallbacks = []; this.exitCallbacks = []; this.disconnectCallbacks = [];
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
  private descendants(): PhysicalProcessIdentity[] {
    const state = this.checked(false);
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
  private finishNaturalExit(): boolean {
    try {
      const snapshot = this.exitedSnapshot();
      this.state!.identities = snapshot.identities; this.persist();
      if (!this.verifyOwnedIdentity(snapshot)) return false;
      const callbacks = [...this.exitCallbacks]; this.detach();
      for (const callback of callbacks) callback(null, null);
      return true;
    } catch { return false; }
  }
  captureOwnedIdentity(): unknown {
    try {
      this.checked(false);
      const state = structuredClone(this.state!);
      state.identities = [...new Map([...state.identities, ...this.descendants(), ...this.ownedProcesses()].map(item => [JSON.stringify(item), item])).values()];
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
  verifyOwnedIdentity(raw: unknown): boolean {
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
        const panes: Pane[] = JSON.parse(this.cli(['pane', 'list'])).result.panes;
        return snapshot.launching ? false : !panes.some(pane => pane.terminal_id === snapshot.pane!.terminal_id);
      } catch { return this.options.processProbe.observe(snapshot.server) === 'dead'; }
    } catch { return false; }
  }
  async stopOwnedIdentity(raw: unknown = this.state, beforeKill?: (snapshot: unknown) => Promise<void>): Promise<unknown> {
    this.validateIdentity(raw);
    const deadline = Date.now() + 5000;
    const census = async <T>(read: () => T): Promise<T> => {
      for (;;) {
        try { return read(); } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('HERDR_OWNERSHIP_CENSUS_UNKNOWN') || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    };
    const snapshot = await census(() => this.captureOwnedIdentity() as State);
    if (this.verifyOwnedIdentity(snapshot)) {
      this.state!.identities = snapshot.identities; this.persist(); this.detach();
    } else {
      await beforeKill?.(snapshot);
      await census(() => {
        const current = this.captureOwnedIdentity() as State;
        if (current.identities.some(item => !snapshot.identities.some(prior => isDeepStrictEqual(prior, item)))) throw new Error('HERDR_PROCESS_SET_CHANGED');
        this.state!.identities = snapshot.identities;
        this.state!.close_intent = true; this.persist();
        if (this.options.processProbe.observe(this.state!.root) === 'alive') this.kill(snapshot.identities);
        else {
          this.boundServer(this.state!);
          if (this.options.processProbe.observe(this.state!.root) !== 'dead') throw new Error('HERDR_EXIT_UNPROVEN');
          if (this.options.processProbe.observe(this.state!.server) === 'alive') {
            const panes: Pane[] = JSON.parse(this.cli(['pane', 'list'])).result.panes;
            if (panes.some(pane => pane.pane_id === this.state!.pane?.pane_id && pane.terminal_id === this.state!.pane?.terminal_id)) this.cli(['pane', 'close', this.state!.pane!.pane_id]);
          }
          this.detach();
        }
      });
      // Snapshot holders authorize exactly these immutable processes, including marked setsid children.
      for (const identity of snapshot.identities) {
        const observation = this.options.processProbe.observe(identity);
        if (observation === 'unknown') throw new Error('HERDR_EXIT_UNPROVEN');
        if (observation === 'alive') { try { process.kill(identity.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
      }
    }
    let stopped = this.isStopped();
    while (!stopped && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25)); stopped = this.isStopped();
    }
    if (!stopped) throw new Error('HERDR_EXIT_UNPROVEN');
    return structuredClone(this.state);
  }
  kill(expected?: PhysicalProcessIdentity[]): void {
    if (this.isStopped()) return;
    const state = this.checked(false);
    const identities = [...this.descendants(), ...this.ownedProcesses()];
    const second = [...this.descendants(), ...this.ownedProcesses()];
    const key = (item: PhysicalProcessIdentity) => JSON.stringify(item);
    if (second.some(item => !identities.some(prior => key(item) === key(prior)))) throw new Error('HERDR_PROCESS_SET_CHANGED');
    if (expected && second.some(item => !expected.some(prior => isDeepStrictEqual(prior, item)))) throw new Error('HERDR_PROCESS_SET_CHANGED');
    state.identities = [...new Map([...state.identities, ...identities].map(item => [key(item), item])).values()];
    state.close_intent = true;
    this.persist();
    this.checked(false);
    if (state.launching) this.cli(['session', 'stop', this.sessionName, '--json']);
    else this.cli(['pane', 'close', state.pane!.pane_id]);
    state.closed = true;
    this.persist();
    this.detach();
    // Preserve any independently created worker panes in this dedicated server.
    if (!state.launching && JSON.parse(this.cli(['pane', 'list'])).result.panes.length === 0
      && this.options.processProbe.observe(state.server) === 'alive') this.cli(['session', 'stop', this.sessionName, '--json']);
  }
  isStopped(): boolean {
    return !!this.state && this.verifyOwnedIdentity(this.state)
      && this.captures.every(identity => this.options.processProbe.observe(identity) === 'dead');
  }
}
