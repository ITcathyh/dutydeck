import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function tmux(path: string, args: string[]): string {
  const env = { ...process.env, LC_ALL: 'C' };
  delete (env as NodeJS.ProcessEnv).TMUX;
  delete (env as NodeJS.ProcessEnv).TMUX_TMPDIR;
  return execFileSync('/usr/bin/tmux', ['-S', path, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_000, env,
  }).trim();
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
function target(scope: OwnedTmuxScope): string | undefined {
  try { tmux(scope.socketPath, ['has-session', '-t', `=${scope.sessionName}`]); }
  catch (error) {
    const e = error as { status?: number; signal?: string; stderr?: Buffer };
    const stderr = String(e.stderr ?? '').trim();
    if (e.status === 1 && !e.signal && (stderr === `can't find session: ${scope.sessionName}` || stderr === `no server running on ${scope.socketPath}`)) return undefined;
    fail('LEGACY_TMUX_PROBE_UNKNOWN');
  }
  const matches = tmux(scope.socketPath, ['list-sessions', '-F', '#{session_name}|#{session_id}'])
    .split('\n').map(line => line.split('|')).filter(([name]) => name === scope.sessionName);
  if (matches.length !== 1 || !/^\$\d+$/.test(matches[0]![1]!)) fail('LEGACY_TMUX_TARGET_AMBIGUOUS');
  return matches[0]![1]!;
}
function ownerCheck(scope: OwnedTmuxScope, id: string): void {
  if (tmux(scope.socketPath, ['show-options', '-v', '-t', id, '@dutydeck_owner_id']) !== scope.ownerId) fail('LEGACY_TMUX_OWNER_MISMATCH');
}
function processes(scope: OwnedTmuxScope, id: string, probe: ProcessProbe): PhysicalProcessIdentity[] {
  const roots = tmux(scope.socketPath, ['list-panes', '-s', '-t', id, '-F', '#{pane_pid}']).split('\n').map(Number);
  if (!roots.length || roots.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) fail('LEGACY_TMUX_PROCESS_IDENTITY_UNAVAILABLE');
  const children = new Map<number, number[]>();
  for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const raw = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const parent = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const pids = new Set<number>();
  const pending = [...roots];
  while (pending.length) {
    const pid = pending.pop()!;
    if (pids.has(pid)) continue;
    pids.add(pid); pending.push(...(children.get(pid) ?? []));
  }
  return [...pids].sort((a, b) => a - b).map(pid => probe.identify(pid));
}
const key = (identity: PhysicalProcessIdentity) => JSON.stringify([identity.host, identity.boot, identity.namespace, identity.pid, identity.start]);
function alive(identity: PhysicalProcessIdentity, probe: ProcessProbe): void {
  if (probe.observe(identity) !== 'alive') fail('LEGACY_TMUX_PROCESS_STATE_CHANGED');
}

/** Only call with a server-derived scope. Missing initially is not an exit proof. */
export function captureOwnedTmuxIdentity(scope: OwnedTmuxScope, probe: ProcessProbe, previousProof?: OwnedTmuxExitProof): OwnedTmuxIdentity | undefined {
  scopeCheck(scope, probe);
  if (previousProof) {
    if (scope.socketPath !== previousProof.scope.socketPath || scope.uid !== previousProof.scope.uid || scope.hostname !== previousProof.scope.hostname
      || !verifyOwnedTmuxExit(previousProof, probe)) fail('LEGACY_TMUX_SOCKET_CHANGED');
    if (!socketCheck(scope, previousProof.socket, true)) return undefined;
  } else socketCheck(scope);
  const stat = statSync(scope.socketPath, { bigint: true });
  const socket = { dev: String(stat.dev), ino: String(stat.ino) };
  const id = target(scope);
  if (!id) return undefined;
  ownerCheck(scope, id);
  const server = probe.identify(Number(tmux(scope.socketPath, ['display-message', '-p', '-t', id, '#{pid}'])));
  const identities = processes(scope, id, probe);
  socketCheck(scope, socket);
  alive(server, probe);
  if (target(scope) !== id) fail('LEGACY_TMUX_TARGET_CHANGED');
  ownerCheck(scope, id);
  return { scope: { ...scope }, socket, targetId: id, server, identities };
}

/** Stop the captured exact target, refuse changed ownership/namespace, and wait for physical exit. */
export async function stopOwnedTmux(identity: OwnedTmuxIdentity, probe: ProcessProbe, beforeKill?: (captured: OwnedTmuxIdentity) => Promise<void>): Promise<OwnedTmuxExitProof> {
  const alreadyGone = { ...identity, stoppedAt: new Date().toISOString() };
  if (verifyOwnedTmuxExit(alreadyGone, probe)) return alreadyGone;
  const { scope, socket, targetId, server } = identity;
  scopeCheck(scope, probe);
  socketCheck(scope, socket);
  alive(server, probe);
  const current = target(scope);
  if (!current) {
    const proof = { ...identity, stoppedAt: new Date().toISOString() };
    if (verifyOwnedTmuxExit(proof, probe)) return proof;
    fail('LEGACY_TMUX_EXIT_UNPROVEN');
  }
  if (current !== targetId) fail('LEGACY_TMUX_TARGET_CHANGED');
  ownerCheck(scope, targetId);
  const all = new Map(identity.identities.map(item => [key(item), item]));
  // Include descendants born since capture; require a stable immediate second scan.
  const first = processes(scope, targetId, probe);
  for (const item of first) all.set(key(item), item);
  const second = processes(scope, targetId, probe);
  for (const item of second) {
    if (!first.some(prior => key(prior) === key(item))) fail('LEGACY_TMUX_PROCESS_SET_CHANGED');
    all.set(key(item), item);
  }
  for (const item of all.values()) if (probe.observe(item) === 'unknown') fail('LEGACY_TMUX_EXIT_UNKNOWN');
  const captured = { ...identity, identities: [...all.values()] };
  await beforeKill?.(structuredClone(captured));
  socketCheck(scope, socket);
  alive(server, probe);
  if (target(scope) !== targetId) fail('LEGACY_TMUX_TARGET_CHANGED');
  ownerCheck(scope, targetId);
  for (const item of processes(scope, targetId, probe)) {
    if (!all.has(key(item))) fail('LEGACY_TMUX_PROCESS_SET_CHANGED');
  }
  socketCheck(scope, socket);
  alive(server, probe);
  // Format condition and kill are executed in one server command queue, with no shell.
  const condition = `#{&&:#{==:#{pid},${server.pid}},#{&&:#{==:#{session_name},${scope.sessionName}},#{==:#{@dutydeck_owner_id},${scope.ownerId}}}}`;
  tmux(scope.socketPath, ['if-shell', '-F', '-t', targetId, condition, `kill-session -t ${targetId}`, '']);
  const proof: OwnedTmuxExitProof = { ...identity, identities: [...all.values()], stoppedAt: new Date().toISOString() };
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (verifyOwnedTmuxExit(proof, probe)) return proof;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  fail('LEGACY_TMUX_EXIT_UNPROVEN');
}

/** Recheck before releasing a runtime resource; a cached successful stop is insufficient. */
export function verifyOwnedTmuxExit(proof: OwnedTmuxExitProof, probe: ProcessProbe): boolean {
  try {
    scopeCheck(proof.scope, probe);
    if (!proof.identities.length || !proof.identities.every(item => probe.observe(item) === 'dead')) return false;
    if (!socketCheck(proof.scope, proof.socket, true)) return probe.observe(proof.server) === 'dead';
    // An existing bound socket may have become stale after its server exited.
    return target(proof.scope) === undefined;
  } catch { return false; }
}
