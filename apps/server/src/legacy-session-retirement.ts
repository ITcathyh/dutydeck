import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { canonicalExecutionJson, type LegacyRetirementCandidate, type LegacyRetirementReceipt } from '@dutydeck/shared';
import { captureOwnedTmuxIdentity, dutydeckPtySessionName, stopOwnedTmux, type OwnedTmuxExitProof } from '@dutydeck/pty-driver';
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

type VerificationState = { tmux?: { path: string; dev: bigint; ino: bigint }; exitProof?: OwnedTmuxExitProof };

const digest = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const blocked = (sessionId: string, code: string, detail?: string): LegacyRetirementVerification => ({
  status: 'blocked', sessionId, code, ...(detail ? { detail } : {})
});

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

function bindTmuxSocket(path: string, uid: number, state: VerificationState): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isSocket()) return 'LEGACY_RETIREMENT_PATH_TYPE_MISMATCH';
    if (Number(stat.uid) !== uid) return 'LEGACY_RETIREMENT_PATH_OWNER_MISMATCH';
    if (realpathSync(path) !== path) return 'LEGACY_RETIREMENT_PATH_NOT_CANONICAL';
    if (!state.tmux) state.tmux = { path, dev: stat.dev, ino: stat.ino };
    else if (state.tmux.path !== path || state.tmux.dev !== stat.dev || state.tmux.ino !== stat.ino) return 'LEGACY_TMUX_SOCKET_CHANGED';
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && state.tmux?.path === path && state.exitProof) return undefined;
    return 'LEGACY_RETIREMENT_PATH_UNAVAILABLE';
  }
}

async function verifyPty(candidate: LegacyRetirementCandidate, options: LegacyRetirementVerificationOptions, state: VerificationState): Promise<LegacyRetirementVerification> {
  if (!options.tmuxSocket) return blocked(candidate.sessionId, 'LEGACY_TMUX_SOCKET_REQUIRED');
  const pathError = !state.tmux ? validateLocalPath(options.tmuxSocket, options.uid, 'socket') : undefined;
  if (pathError) return blocked(candidate.sessionId, pathError);
  // Batch verification pins the first socket even when the first target is absent.
  // Physical ownership, stopping and exit evidence belong to the shared helper.
  const bindError = bindTmuxSocket(options.tmuxSocket, options.uid, state);
  if (bindError) return blocked(candidate.sessionId, bindError);
  const targetName = dutydeckPtySessionName(candidate.sessionId);
  const expectedOwner = `dutydeck:${candidate.sessionId}`;
  const probe = { identify: childProcessIdentity, observe: observeProcess };
  try {
    const identity = captureOwnedTmuxIdentity({ socketPath: options.tmuxSocket, sessionName: targetName,
      ownerId: expectedOwner, hostname: options.hostname, uid: options.uid }, probe, state.exitProof);
    if (!identity) return readyReceipt(candidate, options, {
      kind: 'pty_tmux_absent', socketPath: options.tmuxSocket, targetName, owner: expectedOwner,
      outcome: 'already_missing', paneProcesses: []
    });
    const proof = await stopOwnedTmux(identity, probe);
    state.exitProof = proof;
    return readyReceipt(candidate, options, {
      kind: 'pty_tmux_absent', socketPath: options.tmuxSocket, targetName, owner: expectedOwner,
      outcome: 'stopped_owned', targetId: proof.targetId, paneProcesses: proof.identities
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return blocked(candidate.sessionId, typeof code === 'string' && code.startsWith('LEGACY_') ? code : 'LEGACY_TMUX_STOP_FAILED',
      error instanceof Error ? error.message : String(error));
  }
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
