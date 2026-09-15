import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { canonicalExecutionJson, type LegacyRetirementCandidate, type LegacyRetirementReceipt, type ResourceCreatorIdentity } from '@dutydeck/shared';
import { dutydeckPtySessionName } from '@dutydeck/pty-driver';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';

export interface LegacyRetirementVerificationOptions {
  hostname: string;
  uid: number;
  tmuxSocket?: string;
  acpxDirectory?: string;
}

export type LegacyRetirementVerification =
  | { status: 'ready'; receipt: LegacyRetirementReceipt }
  | { status: 'blocked'; sessionId: string; code: string; detail?: string };

type CommandFailure = Error & { code?: string; status?: number; signal?: string; stderr?: Buffer | string };
type VerificationState = { tmux?: { path: string; dev: bigint; ino: bigint; mayBeGone: boolean } };
const TMUX_BINARY = '/usr/bin/tmux';

const digest = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const blocked = (sessionId: string, code: string, detail?: string): LegacyRetirementVerification => ({
  status: 'blocked', sessionId, code, ...(detail ? { detail } : {})
});

function processIsGone(identity: ResourceCreatorIdentity): boolean {
  const observation = observeProcess(identity);
  if (observation === 'unknown') throw new Error('LEGACY_RETIREMENT_PROCESS_STATE_UNKNOWN');
  return observation === 'dead';
}

function tmuxEnv() {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_TMPDIR;
  return env;
}

function tmux(socketPath: string, args: string[]): string {
  return execFileSync(TMUX_BINARY, ['-S', socketPath, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_000, env: tmuxEnv()
  });
}

function tmuxFailure(error: unknown): { status?: number; code?: string; stderr: string; signal?: string } {
  const failure = error as CommandFailure;
  return {
    ...(typeof failure.status === 'number' ? { status: failure.status } : {}),
    ...(failure.code ? { code: failure.code } : {}),
    ...(failure.signal ? { signal: failure.signal } : {}),
    stderr: String(failure.stderr ?? '').trim()
  };
}

function validateScope(options: LegacyRetirementVerificationOptions): string | undefined {
  if (options.hostname !== hostname()) return 'LEGACY_RETIREMENT_HOST_MISMATCH';
  if (!Number.isSafeInteger(options.uid) || options.uid < 0 || process.getuid?.() !== options.uid) return 'LEGACY_RETIREMENT_UID_MISMATCH';
  try { childProcessIdentity(process.pid); } catch { return 'LEGACY_RETIREMENT_PROCESS_IDENTITY_UNAVAILABLE'; }
  return undefined;
}

function validateLocalPath(path: string, uid: number, kind: 'directory' | 'socket'): string | undefined {
  if (!isAbsolute(path)) return 'LEGACY_RETIREMENT_PATH_NOT_ABSOLUTE';
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) return 'LEGACY_RETIREMENT_PATH_SYMLINK';
    const stat = statSync(path);
    if (realpathSync(path) !== path) return 'LEGACY_RETIREMENT_PATH_NOT_CANONICAL';
    if (stat.uid !== uid) return 'LEGACY_RETIREMENT_PATH_OWNER_MISMATCH';
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isSocket()) return 'LEGACY_RETIREMENT_PATH_TYPE_MISMATCH';
    if (kind === 'directory' && (stat.mode & 0o022) !== 0) return 'LEGACY_RETIREMENT_PATH_PERMISSIONS_UNSAFE';
  } catch (error) {
    return 'LEGACY_RETIREMENT_PATH_UNAVAILABLE';
  }
  return undefined;
}

function listTmuxSessions(socketPath: string): Array<{ name: string; id: string }> {
  const output = tmux(socketPath, ['list-sessions', '-F', '#{session_name}\t#{session_id}']);
  return output.split('\n').filter(Boolean).map(line => {
    const [name, id] = line.split('\t');
    if (!name || !id || !/^\$\d+$/.test(id)) throw new Error('LEGACY_TMUX_SESSION_METADATA_INVALID');
    return { name, id };
  });
}

function exactSession(socketPath: string, targetName: string, knownGone = false): { status: 'missing' } | { status: 'owned_candidate'; targetId: string } | { status: 'blocked'; code: string; detail?: string } {
  try {
    tmux(socketPath, ['has-session', '-t', `=${targetName}`]);
  } catch (error) {
    const failure = tmuxFailure(error);
    if (failure.status === 1 && !failure.signal
      && (failure.stderr === `can't find session: ${targetName}` || failure.stderr.startsWith('no server running on '))) return { status: 'missing' };
    if (knownGone && failure.status === 1 && !failure.signal && failure.stderr.startsWith(`error connecting to ${socketPath} `)) return { status: 'missing' };
    return { status: 'blocked', code: 'LEGACY_TMUX_PROBE_UNKNOWN', ...(failure.code || failure.stderr ? { detail: failure.code ?? failure.stderr } : {}) };
  }
  try {
    const matches = listTmuxSessions(socketPath).filter(item => item.name === targetName);
    if (matches.length !== 1) return { status: 'blocked', code: 'LEGACY_TMUX_TARGET_AMBIGUOUS' };
    return { status: 'owned_candidate', targetId: matches[0]!.id };
  } catch (error) {
    return { status: 'blocked', code: 'LEGACY_TMUX_METADATA_UNKNOWN', detail: error instanceof Error ? error.message : String(error) };
  }
}

function tmuxOwner(socketPath: string, targetId: string): string {
  return tmux(socketPath, ['show-options', '-v', '-t', targetId, '@dutydeck_owner_id']).trim();
}

function panePids(socketPath: string, targetId: string): number[] {
  const output = tmux(socketPath, ['list-panes', '-s', '-t', targetId, '-F', '#{pane_pid}']);
  return output.split('\n').filter(Boolean).map(value => Number(value)).filter(pid => Number.isSafeInteger(pid) && pid > 0);
}

function descendantPids(roots: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync('/proc', { encoding: 'utf8' }).filter(name => /^\d+$/.test(name)).map(Number)) {
    try {
      const raw = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      const parent = Number(fields[1]);
      if (Number.isSafeInteger(parent) && parent > 0) (children.get(parent) ?? children.set(parent, []).get(parent)!).push(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const found = new Set<number>();
  const pending = [...roots];
  while (pending.length) {
    const pid = pending.pop()!;
    if (found.has(pid)) continue;
    found.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return [...found].sort((a, b) => a - b);
}

function bindTmuxSocket(path: string, uid: number, state: VerificationState): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isSocket()) return 'LEGACY_RETIREMENT_PATH_TYPE_MISMATCH';
    if (Number(stat.uid) !== uid) return 'LEGACY_RETIREMENT_PATH_OWNER_MISMATCH';
    if (realpathSync(path) !== path) return 'LEGACY_RETIREMENT_PATH_NOT_CANONICAL';
    if (!state.tmux) state.tmux = { path, dev: stat.dev, ino: stat.ino, mayBeGone: false };
    else if (state.tmux.path !== path || state.tmux.dev !== stat.dev || state.tmux.ino !== stat.ino) return 'LEGACY_TMUX_SOCKET_CHANGED';
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && state.tmux?.path === path && state.tmux.mayBeGone) return undefined;
    return 'LEGACY_RETIREMENT_PATH_UNAVAILABLE';
  }
}

async function verifyPty(candidate: LegacyRetirementCandidate, options: LegacyRetirementVerificationOptions, state: VerificationState): Promise<LegacyRetirementVerification> {
  if (!options.tmuxSocket) return blocked(candidate.sessionId, 'LEGACY_TMUX_SOCKET_REQUIRED');
  const pathError = !state.tmux ? validateLocalPath(options.tmuxSocket, options.uid, 'socket') : undefined;
  if (pathError) return blocked(candidate.sessionId, pathError);
  const bindError = bindTmuxSocket(options.tmuxSocket, options.uid, state);
  if (bindError) return blocked(candidate.sessionId, bindError);
  const targetName = dutydeckPtySessionName(candidate.sessionId);
  const expectedOwner = `dutydeck:${candidate.sessionId}`;
  const first = exactSession(options.tmuxSocket, targetName, state.tmux?.mayBeGone);
  if (first.status === 'blocked') return blocked(candidate.sessionId, first.code, first.detail);
  let evidence: LegacyRetirementReceipt['evidence'];
  if (first.status === 'missing') {
    evidence = { kind: 'pty_tmux_absent', socketPath: options.tmuxSocket, targetName, owner: expectedOwner, outcome: 'already_missing', paneProcesses: [] };
  } else {
    let owner: string;
    let identities: ResourceCreatorIdentity[];
    try {
      owner = tmuxOwner(options.tmuxSocket, first.targetId);
      if (owner !== expectedOwner) return blocked(candidate.sessionId, 'LEGACY_TMUX_OWNER_MISMATCH');
      const firstProcesses = descendantPids(panePids(options.tmuxSocket, first.targetId));
      const secondProcesses = descendantPids(panePids(options.tmuxSocket, first.targetId));
      identities = [...new Set([...firstProcesses, ...secondProcesses])].sort((a, b) => a - b).map(childProcessIdentity);
      if (!identities.length) return blocked(candidate.sessionId, 'LEGACY_TMUX_PROCESS_IDENTITY_UNAVAILABLE');
      const current = listTmuxSessions(options.tmuxSocket).find(item => item.id === first.targetId);
      if (current?.name !== targetName || tmuxOwner(options.tmuxSocket, first.targetId) !== expectedOwner) return blocked(candidate.sessionId, 'LEGACY_TMUX_TARGET_CHANGED');
      if (bindTmuxSocket(options.tmuxSocket, options.uid, state)) return blocked(candidate.sessionId, 'LEGACY_TMUX_SOCKET_CHANGED');
      tmux(options.tmuxSocket, ['kill-session', '-t', first.targetId]);
    } catch (error) {
      return blocked(candidate.sessionId, 'LEGACY_TMUX_STOP_FAILED', error instanceof Error ? error.message : String(error));
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        if (identities.every(processIsGone)) break;
      } catch (error) { return blocked(candidate.sessionId, 'LEGACY_TMUX_EXIT_UNKNOWN', error instanceof Error ? error.message : String(error)); }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    try {
      if (!identities.every(processIsGone)) return blocked(candidate.sessionId, 'LEGACY_TMUX_PROCESS_STILL_LIVE');
    } catch (error) { return blocked(candidate.sessionId, 'LEGACY_TMUX_EXIT_UNKNOWN', error instanceof Error ? error.message : String(error)); }
    try { statSync(options.tmuxSocket); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && state.tmux) state.tmux.mayBeGone = true; }
    const after = exactSession(options.tmuxSocket, targetName, state.tmux?.mayBeGone);
    if (after.status !== 'missing') return blocked(candidate.sessionId, after.status === 'blocked' ? after.code : 'LEGACY_TMUX_TARGET_STILL_PRESENT', after.status === 'blocked' ? after.detail : undefined);
    evidence = { kind: 'pty_tmux_absent', socketPath: options.tmuxSocket, targetName, owner: expectedOwner, outcome: 'stopped_owned', targetId: first.targetId, paneProcesses: identities };
  }
  return readyReceipt(candidate, options, evidence);
}

function readAcpMetadata(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('LEGACY_ACP_RECORD_INVALID');
  const record = parsed as Record<string, unknown>;
  return Object.fromEntries(['schema', 'acpx_record_id', 'cwd', 'pid', 'agent_started_at'].map(key => [key, record[key]]));
}

function verifyAcp(candidate: LegacyRetirementCandidate, options: LegacyRetirementVerificationOptions): LegacyRetirementVerification {
  if (!options.acpxDirectory) return blocked(candidate.sessionId, 'LEGACY_ACP_DIRECTORY_REQUIRED');
  const pathError = validateLocalPath(options.acpxDirectory, options.uid, 'directory');
  if (pathError) return blocked(candidate.sessionId, pathError);
  let base: string;
  let recordPath: string;
  try {
    base = realpathSync(options.acpxDirectory);
    const sessionsDirectory = join(base, 'sessions');
    const sessionsLink = lstatSync(sessionsDirectory);
    const sessionsStat = statSync(sessionsDirectory);
    if (sessionsLink.isSymbolicLink() || !sessionsStat.isDirectory() || sessionsStat.uid !== options.uid || (sessionsStat.mode & 0o022) !== 0) {
      return blocked(candidate.sessionId, 'LEGACY_ACP_RECORD_UNTRUSTED');
    }
    const requestedRecord = join(sessionsDirectory, `${encodeURIComponent(candidate.sessionId)}.json`);
    const recordLink = lstatSync(requestedRecord);
    recordPath = realpathSync(requestedRecord);
    if (relative(base, recordPath).startsWith('..')) return blocked(candidate.sessionId, 'LEGACY_ACP_RECORD_OUTSIDE_DIRECTORY');
    const recordStat = statSync(recordPath);
    if (recordLink.isSymbolicLink() || !recordStat.isFile() || recordStat.nlink !== 1 || recordStat.uid !== options.uid || (recordStat.mode & 0o022) !== 0) return blocked(candidate.sessionId, 'LEGACY_ACP_RECORD_UNTRUSTED');
  } catch { return blocked(candidate.sessionId, 'LEGACY_ACP_RECORD_MISSING'); }
  let metadata: Record<string, unknown>;
  try { metadata = readAcpMetadata(recordPath); }
  catch { return blocked(candidate.sessionId, 'LEGACY_ACP_RECORD_INVALID'); }
  if (metadata.schema !== 'acpx.session.v1' || metadata.acpx_record_id !== candidate.sessionId || metadata.cwd !== candidate.cwd) {
    return blocked(candidate.sessionId, 'LEGACY_ACP_RECORD_IDENTITY_MISMATCH');
  }
  const pidMax = Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim());
  const startedAt = typeof metadata.agent_started_at === 'string' ? Date.parse(metadata.agent_started_at) : Number.NaN;
  if (!Number.isSafeInteger(metadata.pid) || Number(metadata.pid) <= 0 || Number(metadata.pid) > pidMax
    || !Number.isFinite(startedAt) || new Date(startedAt).toISOString() !== metadata.agent_started_at) {
    return blocked(candidate.sessionId, 'LEGACY_ACP_PROCESS_METADATA_INCOMPLETE');
  }
  const pid = Number(metadata.pid);
  try {
    childProcessIdentity(pid);
    return blocked(candidate.sessionId, 'LEGACY_ACP_RECORDED_PROCESS_LIVE');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return blocked(candidate.sessionId, 'LEGACY_ACP_PROCESS_STATE_UNKNOWN');
  }
  return readyReceipt(candidate, options, {
    kind: 'acp_recorded_agent_pid_absent', recordPath, acpxRecordId: candidate.sessionId,
    pid, agentStartedAt: metadata.agent_started_at as string
  });
}

function readyReceipt(candidate: LegacyRetirementCandidate, options: LegacyRetirementVerificationOptions, evidence: LegacyRetirementReceipt['evidence']): LegacyRetirementVerification {
  const verifiedAt = new Date().toISOString();
  const content = {
    version: 1 as const, sessionId: candidate.sessionId, runId: candidate.runId,
    databaseEntity: candidate.databaseEntity, snapshotDigest: candidate.snapshotDigest,
    protocol: candidate.protocol as 'pty-cli' | 'acp', verifiedAt, archivedAt: candidate.archivedAt ?? verifiedAt,
    verifier: { hostname: options.hostname, uid: options.uid, process: childProcessIdentity(process.pid) }, evidence
  };
  return { status: 'ready', receipt: { ...content, receiptId: `legacy_retirement_${digest(content)}` } };
}

async function verify(candidate: LegacyRetirementCandidate, options: LegacyRetirementVerificationOptions, state: VerificationState): Promise<LegacyRetirementVerification> {
  const scopeError = validateScope(options);
  if (scopeError) return blocked(candidate.sessionId, scopeError);
  if (candidate.receipt) return { status: 'ready', receipt: candidate.receipt };
  if (candidate.blockers.length) return blocked(candidate.sessionId, 'LEGACY_RETIREMENT_DATABASE_BLOCKED', candidate.blockers.map(item => item.code).join(','));
  if (candidate.protocol === 'pty-cli') return verifyPty(candidate, options, state);
  if (candidate.protocol === 'acp') return verifyAcp(candidate, options);
  return blocked(candidate.sessionId, 'LEGACY_RETIREMENT_PROTOCOL_UNSUPPORTED', candidate.protocol ?? 'missing');
}

export function createLegacyRetirementVerifier(options: LegacyRetirementVerificationOptions) {
  const state: VerificationState = {};
  return (candidate: LegacyRetirementCandidate) => verify(candidate, options, state);
}

export async function verifyLegacyRetirementCandidate(candidate: LegacyRetirementCandidate, options: LegacyRetirementVerificationOptions): Promise<LegacyRetirementVerification> {
  return createLegacyRetirementVerifier(options)(candidate);
}
