import { runCommand } from './command.js';
import { descendantPids } from './descendant-pids.js';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';

export interface PhysicalProcessIdentity {
  host: string; boot: string; namespace: string; pid: number; start: string;
}
export interface ProcessProbe {
  identify(pid: number): PhysicalProcessIdentity;
  observe(identity: PhysicalProcessIdentity): 'alive' | 'dead' | 'unknown';
}
export interface OwnedTmuxScope {
  socketPath: string; sessionName: string; ownerId: string; hostname: string; uid: number;
}
export interface OwnedTmuxIdentity {
  scope: OwnedTmuxScope;
  socket: { dev: string; ino: string };
  targetId: string;
  server: PhysicalProcessIdentity;
  identities: PhysicalProcessIdentity[];
}
export interface OwnedTmuxExitProof extends OwnedTmuxIdentity { stoppedAt: string }
/** 原名称及所有者标记都未匹配到会话的证据；socket 缺失时没有 inode。 */
export interface OwnedTmuxAbsence { absent: true; scope: OwnedTmuxScope; socket?: { dev: string; ino: string }; observedAt: string }

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
/**
 * Exit wait after kill-session. A Claude pane root is the program-status relay,
 * whose worst case is SIGNAL_EXIT_GRACE_MS (5s) plus FINAL_KILL_MS (2s) when its
 * CLI ignores SIGHUP; 10s covers that with margin for the CLI's own teardown.
 */
const EXIT_PROOF_TIMEOUT_MS = 10_000;
/** Wait after each escalation signal to recorded survivors (SIGTERM, then SIGKILL). */
const ESCALATION_GRACE_MS = 2_000;
/** Pre-kill durable record rounds for descendants born while it was being written. */
const PRE_KILL_RECORD_ROUNDS = 5;
/** After the last round, unrecorded newcomers must exit within this window (a busy pane's short-lived children). */
const PRE_KILL_SETTLE_MS = 3_000;
/** Exit not yet proven: callers may re-verify the attached proof later instead of stopping again. */
function unproven(proof: OwnedTmuxExitProof): never {
  throw Object.assign(new Error('LEGACY_TMUX_EXIT_UNPROVEN'), { code: 'LEGACY_TMUX_EXIT_UNPROVEN', proof });
}
/** The PATH-resolved client TmuxBackend started the server with; another
 *  install may be missing or speak a different client/server protocol. */
async function tmux(path: string, args: string[]): Promise<string> {
  const env = { ...process.env, LC_ALL: 'C' };
  delete (env as NodeJS.ProcessEnv).TMUX;
  delete (env as NodeJS.ProcessEnv).TMUX_TMPDIR;
  return (await runCommand('tmux', ['-S', path, ...args], {
    timeout: 3_000, env,
  })).trim();
}
function scopeCheck(scope: OwnedTmuxScope, probe: ProcessProbe): void {
  if (scope.hostname !== hostname()) fail('LEGACY_RETIREMENT_HOST_MISMATCH');
  if (scope.uid !== process.getuid?.()) fail('LEGACY_RETIREMENT_UID_MISMATCH');
  // These values also enter a tmux format expression, never a shell command.
  if (!/^[A-Za-z0-9_-]+$/.test(scope.sessionName) || !/^[A-Za-z0-9:_-]+$/.test(scope.ownerId)) fail('LEGACY_TMUX_SCOPE_INVALID');
  const local = probe.identify(process.pid);
  if (!local.host || !local.boot || !local.namespace || !local.start) fail('LEGACY_RETIREMENT_PROCESS_IDENTITY_UNAVAILABLE');
}
function socketCheck(scope: OwnedTmuxScope, expected?: OwnedTmuxIdentity['socket'], allowMissing = false): boolean {
  if (!isAbsolute(scope.socketPath)) fail('LEGACY_RETIREMENT_PATH_NOT_ABSOLUTE');
  try {
    const stat = lstatSync(scope.socketPath, { bigint: true });
    if (stat.isSymbolicLink()) fail('LEGACY_RETIREMENT_PATH_SYMLINK');
    if (!stat.isSocket()) fail('LEGACY_RETIREMENT_PATH_TYPE_MISMATCH');
    if (Number(stat.uid) !== scope.uid) fail('LEGACY_RETIREMENT_PATH_OWNER_MISMATCH');
    if (realpathSync(scope.socketPath) !== scope.socketPath) fail('LEGACY_RETIREMENT_PATH_NOT_CANONICAL');
    if (expected && (String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino)) fail('LEGACY_TMUX_SOCKET_CHANGED');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) return false;
    if (String((error as NodeJS.ErrnoException).code).startsWith('LEGACY_')) throw error;
    fail('LEGACY_RETIREMENT_PATH_UNAVAILABLE');
  }
}
async function target(scope: OwnedTmuxScope): Promise<string | undefined> {
  try { (await tmux(scope.socketPath, ['has-session', '-t', `=${scope.sessionName}`])); }
  catch (error) {
    const e = error as { status?: number; signal?: string; stderr?: Buffer };
    const stderr = String(e.stderr ?? '').trim();
    if (e.status === 1 && !e.signal && (stderr === `can't find session: ${scope.sessionName}` || stderr === `no server running on ${scope.socketPath}`)) return undefined;
    fail('LEGACY_TMUX_PROBE_UNKNOWN');
  }
  const matches = (await tmux(scope.socketPath, ['list-sessions', '-F', '#{session_name}|#{session_id}']))
    .split('\n').map(line => line.split('|')).filter(([name]) => name === scope.sessionName);
  if (matches.length !== 1 || !/^\$\d+$/.test(matches[0]![1]!)) fail('LEGACY_TMUX_TARGET_AMBIGUOUS');
  return matches[0]![1]!;
}
async function ownerCheck(scope: OwnedTmuxScope, id: string): Promise<void> {
  if ((await tmux(scope.socketPath, ['show-options', '-v', '-t', id, '@dutydeck_owner_id'])) !== scope.ownerId) fail('LEGACY_TMUX_OWNER_MISMATCH');
}
async function processes(scope: OwnedTmuxScope, id: string, probe: ProcessProbe): Promise<PhysicalProcessIdentity[]> {
  // The descendant scan and its exit checks read /proc; elsewhere the process set cannot be proven.
  if (process.platform !== 'linux') fail('LEGACY_TMUX_PLATFORM_UNSUPPORTED');
  const roots = (await tmux(scope.socketPath, ['list-panes', '-s', '-t', id, '-F', '#{pane_pid}'])).split('\n').map(Number);
  if (!roots.length || roots.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) fail('LEGACY_TMUX_PROCESS_IDENTITY_UNAVAILABLE');
  const scanned = new Map<string, string>();
  const identities: PhysicalProcessIdentity[] = [];
  for (const pid of descendantPids(roots, scanned).sort((a, b) => a - b)) {
    // A busy pane forks short-lived children: one seen by the scan may exit
    // (or its PID be reused) before identify. That original process is gone and
    // needs no exit proof; any other identify failure stays fatal.
    let identity: PhysicalProcessIdentity;
    try { identity = probe.identify(pid); }
    catch (error) { if (exitedSinceScan(pid, scanned.get(String(pid)))) continue; throw error; }
    if (scanned.has(String(pid)) && statStart(scanned.get(String(pid))!) !== statStart(readStat(pid) ?? '')) continue;
    identities.push(identity);
  }
  return identities;
}
function readStat(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return undefined; throw error; }
}
/** Fields after the `(comm)` of /proc/<pid>/stat: [0] state, [19] start time. */
function statFields(raw: string): string[] { return raw.slice(raw.lastIndexOf(')') + 2).split(' '); }
function statStart(raw: string): string | undefined { return raw ? statFields(raw)[19] : undefined; }
function exitedSinceScan(pid: number, scannedStat: string | undefined): boolean {
  const current = readStat(pid);
  if (current === undefined) return true;
  if (scannedStat !== undefined && statStart(current) !== statStart(scannedStat)) return true;
  return statFields(current)[0] === 'Z';
}
const key = (identity: PhysicalProcessIdentity) => JSON.stringify([identity.host, identity.boot, identity.namespace, identity.pid, identity.start]);
function alive(identity: PhysicalProcessIdentity, probe: ProcessProbe): void {
  if (probe.observe(identity) !== 'alive') fail('LEGACY_TMUX_PROCESS_STATE_CHANGED');
}
async function exitedWithin(items: PhysicalProcessIdentity[], probe: ProcessProbe, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (items.every(item => probe.observe(item) === 'dead')) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Only call with a server-derived scope. Missing initially is not an exit proof. */
export async function captureOwnedTmuxIdentity(scope: OwnedTmuxScope, probe: ProcessProbe, previousProof?: OwnedTmuxExitProof): Promise<OwnedTmuxIdentity | undefined> {
  scopeCheck(scope, probe);
  if (previousProof) {
    if (scope.socketPath !== previousProof.scope.socketPath || scope.uid !== previousProof.scope.uid || scope.hostname !== previousProof.scope.hostname
      || !(await verifyOwnedTmuxExit(previousProof, probe))) fail('LEGACY_TMUX_SOCKET_CHANGED');
    if (!socketCheck(scope, previousProof.socket, true)) return undefined;
  } else socketCheck(scope);
  const stat = statSync(scope.socketPath, { bigint: true });
  const socket = { dev: String(stat.dev), ino: String(stat.ino) };
  const id = (await target(scope));
  if (!id) return undefined;
  await ownerCheck(scope, id);
  const server = probe.identify(Number((await tmux(scope.socketPath, ['display-message', '-p', '-t', id, '#{pid}']))));
  const identities = (await processes(scope, id, probe));
  socketCheck(scope, socket);
  alive(server, probe);
  if ((await target(scope)) !== id) fail('LEGACY_TMUX_TARGET_CHANGED');
  await ownerCheck(scope, id);
  return { scope: { ...scope }, socket, targetId: id, server, identities };
}

/** Stop the captured exact target, refuse changed ownership/namespace, and wait for physical exit. */
export async function stopOwnedTmux(identity: OwnedTmuxIdentity, probe: ProcessProbe, beforeKill?: (captured: OwnedTmuxIdentity) => Promise<void>): Promise<OwnedTmuxExitProof> {
  const alreadyGone = { ...identity, stoppedAt: new Date().toISOString() };
  if ((await verifyOwnedTmuxExit(alreadyGone, probe))) return alreadyGone;
  const { scope, socket, targetId, server } = identity;
  scopeCheck(scope, probe);
  socketCheck(scope, socket);
  alive(server, probe);
  const current = (await target(scope));
  if (!current) {
    const proof = { ...identity, stoppedAt: new Date().toISOString() };
    if ((await verifyOwnedTmuxExit(proof, probe))) return proof;
    return escalate(proof, probe);
  }
  if (current !== targetId) fail('LEGACY_TMUX_TARGET_CHANGED');
  await ownerCheck(scope, targetId);
  const all = new Map(identity.identities.map(item => [key(item), item]));
  // A busy pane keeps forking short-lived children, so the process set is never
  // static. Ownership rests on the target id, owner marker and server pid; every
  // descendant seen in any scan joins the exit proof instead of aborting the stop.
  const absorb = (scan: PhysicalProcessIdentity[]) => {
    const added = scan.filter(item => !all.has(key(item)));
    for (const item of added) all.set(key(item), item);
    return added;
  };
  absorb(await processes(scope, targetId, probe));
  absorb(await processes(scope, targetId, probe));
  const unknown = () => { for (const item of all.values()) if (probe.observe(item) === 'unknown') fail('LEGACY_TMUX_EXIT_UNKNOWN'); };
  unknown();
  const ownership = async () => {
    socketCheck(scope, socket);
    alive(server, probe);
    if ((await target(scope)) !== targetId) fail('LEGACY_TMUX_TARGET_CHANGED');
    await ownerCheck(scope, targetId);
  };
  // Rescan after the ownership checks right before kill: a descendant born since the earlier scans (for example a
  // `nohup … &` job that kill-session cannot end) must join the proof. With a durable pre-kill record, live
  // newcomers are recorded again for a bounded number of rounds. A busy pane forks short-lived children faster than
  // any record round, so newcomers after the last round only refuse the stop when they outlive the settle window;
  // children born during that wait are recorded once more, and a final rescan joins the in-memory proof.
  const record = () => beforeKill!(structuredClone({ ...identity, identities: [...all.values()] }));
  for (let round = 0; ; round++) {
    if (beforeKill) await record();
    await ownership();
    const added = absorb(await processes(scope, targetId, probe)).filter(item => probe.observe(item) === 'alive');
    unknown();
    if (!added.length || !beforeKill) break;
    if (round + 1 < PRE_KILL_RECORD_ROUNDS) continue;
    if (!(await exitedWithin(added, probe, PRE_KILL_SETTLE_MS))) fail('LEGACY_TMUX_PROCESS_SET_CHANGED');
    absorb(await processes(scope, targetId, probe));
    unknown();
    await record();
    await ownership();
    absorb(await processes(scope, targetId, probe));
    unknown();
    break;
  }
  socketCheck(scope, socket);
  alive(server, probe);
  // Format condition and kill are executed in one server command queue, with no shell.
  const condition = `#{&&:#{==:#{pid},${server.pid}},#{&&:#{==:#{session_name},${scope.sessionName}},#{==:#{@dutydeck_owner_id},${scope.ownerId}}}}`;
  (await tmux(scope.socketPath, ['if-shell', '-F', '-t', targetId, condition, `kill-session -t ${targetId}`, '']));
  const proof: OwnedTmuxExitProof = { ...identity, identities: [...all.values()], stoppedAt: new Date().toISOString() };
  if ((await provenWithin(proof, probe, EXIT_PROOF_TIMEOUT_MS))) return proof;
  return escalate(proof, probe);
}
/**
 * kill-session only hangs up the panes; recorded processes that ignore SIGHUP or left the pane (nohup, setsid)
 * outlive it. Signal exactly those identities, and only while the targeted session is verifiably gone: a session
 * that is still there (the guarded kill did not run) or an uncertain observation leaves the stop unproven.
 */
async function escalate(proof: OwnedTmuxExitProof, probe: ProcessProbe): Promise<OwnedTmuxExitProof> {
  const { scope, socket, targetId, server } = proof;
  const sessionGone = async () => {
    try {
      if (probe.observe(server) === 'dead') return true;
      return socketCheck(scope, socket, true) && (await target(scope)) !== targetId;
    } catch { return false; }
  };
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!(await sessionGone())) break;
    const observed = proof.identities.map(item => ({ item, state: probe.observe(item) }));
    if (observed.some(({ state }) => state === 'unknown')) break;
    const survivors = observed.filter(({ state }) => state === 'alive');
    if (!survivors.length) break;
    for (const { item } of survivors) {
      try { process.kill(item.pid, signal); } catch { /* Exited meanwhile, or not signalable: the proof decides. */ }
    }
    if ((await provenWithin(proof, probe, ESCALATION_GRACE_MS))) return proof;
  }
  unproven(proof);
}
async function provenWithin(proof: OwnedTmuxExitProof, probe: ProcessProbe, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await verifyOwnedTmuxExit(proof, probe))) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

/** Recheck before releasing a runtime resource; a cached successful stop is insufficient. */
export async function verifyOwnedTmuxExit(proof: OwnedTmuxExitProof, probe: ProcessProbe): Promise<boolean> {
  try {
    scopeCheck(proof.scope, probe);
    if (!proof.identities.length) {
      // Nothing was alive in the panes when the identity was captured (the pane root had already exited):
      // exit is proven only by the original session being gone.
      const server = probe.observe(proof.server);
      if (server === 'dead') return !socketCheck(proof.scope, undefined, true) || (await target(proof.scope)) === undefined;
      if (server !== 'alive' || !socketCheck(proof.scope, proof.socket, true)) return false;
      return (await target(proof.scope)) === undefined;
    }
    if (!proof.identities.every(item => probe.observe(item) === 'dead')) return false;
    const server = probe.observe(proof.server);
    // A replacement server may reuse the path while the last old session is
    // closing. Exact old process identities prove exit without touching it.
    if (server === 'dead') return true;
    if (server !== 'alive' || !socketCheck(proof.scope, proof.socket, true)) return false;
    return (await target(proof.scope)) === undefined;
  } catch { return false; }
}

function requireUnboundSocket(path: string): void {
  if (process.platform !== 'linux') fail('LEGACY_TMUX_SOCKET_STATE_UNKNOWN');
  const [header, ...lines] = readFileSync('/proc/net/unix', 'utf8').split('\n');
  if (header?.trim().split(/\s+/).join(' ') !== 'Num RefCount Protocol Flags Type St Inode Path') fail('LEGACY_TMUX_SOCKET_STATE_UNKNOWN');
  for (const line of lines) {
    if (!line) continue;
    const match = /^[0-9a-f]+:\s+(?:[0-9a-f]+\s+){5}\d+(?:[ \t]+(.*))?$/i.exec(line);
    if (!match) fail('LEGACY_TMUX_SOCKET_STATE_UNKNOWN');
    if (match[1] === path) fail('LEGACY_TMUX_SOCKET_STILL_BOUND');
  }
}

async function tmuxAbsence(scope: OwnedTmuxScope): Promise<{ socket?: OwnedTmuxIdentity['socket'] } | undefined> {
  if (!socketCheck(scope, undefined, true)) {
    requireUnboundSocket(scope.socketPath);
    if (socketCheck(scope, undefined, true)) fail('LEGACY_TMUX_SOCKET_CHANGED');
    return {};
  }
  const stat = statSync(scope.socketPath, { bigint: true });
  const socket = { dev: String(stat.dev), ino: String(stat.ino) };
  let sessions: string;
  try { sessions = await tmux(scope.socketPath, ['list-sessions', '-F', '#{session_name}|#{@dutydeck_owner_id}']); }
  catch (error) {
    const e = error as { status?: number; signal?: string; stderr?: Buffer };
    if (e.status !== 1 || e.signal || String(e.stderr ?? '').trim() !== `no server running on ${scope.socketPath}`) throw error;
    requireUnboundSocket(scope.socketPath);
    sessions = '';
  }
  for (const line of sessions ? sessions.split('\n') : []) {
    const separator = line.lastIndexOf('|');
    if (separator <= 0) fail('LEGACY_TMUX_PROBE_UNKNOWN');
    if (line.slice(0, separator) === scope.sessionName || line.slice(separator + 1) === scope.ownerId) return undefined;
  }
  socketCheck(scope, socket);
  return { socket };
}

/**
 * 原名称及所有者对应的会话都不存在时返回证据；socket 缺失还须核实内核没有路径绑定。
 * 只凭它不能证明原进程已退出，调用方还要证明原所有者已退出。
 */
export async function captureOwnedTmuxAbsence(scope: OwnedTmuxScope, probe: ProcessProbe): Promise<OwnedTmuxAbsence | undefined> {
  scopeCheck(scope, probe);
  const absence = await tmuxAbsence(scope);
  if (!absence) return undefined;
  return { absent: true, scope: { ...scope }, ...absence, observedAt: new Date().toISOString() };
}

/** 写账本前复查，使用与捕获相同的会话和 socket 判据。 */
export async function verifyOwnedTmuxAbsence(absence: OwnedTmuxAbsence, probe: ProcessProbe): Promise<boolean> {
  try {
    scopeCheck(absence.scope, probe);
    return (await tmuxAbsence(absence.scope)) !== undefined;
  } catch { return false; }
}
