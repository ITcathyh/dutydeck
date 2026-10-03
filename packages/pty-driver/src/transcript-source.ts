/**
 * PTY-side transcript source observations for Session Insight (design §3.1).
 *
 * PtyCliDriver freezes non-secret metadata about WHERE the bridged CLI writes
 * its native transcript, at the only boundary that proves it: the real
 * backend.spawn/respawn call, from the exact final env handed to the child.
 * The runtime (T3c) subscribes via AgentDriver.subscribeTranscriptSource,
 * adds session/run/driver-instance ids and hashed source keys, and owns
 * persistence; the driver never writes AgentEvent/DB itself.
 *
 * Guarantees:
 *  - The data root is frozen at the spawn boundary from the final child env
 *    (never the daemon's process.env, never at constructor/attach/resume),
 *    and never changes afterwards even if the daemon env moves.
 *  - Only codex/claude/traex log clients are described, identified by the
 *    ADAPTER id (the on-disk client/dialect), never by model provider.
 *  - A native session id is appended only after CONTENT verification: the
 *    per-session marker injected into prompt #1 must be read out of the file.
 *    A pinned filename, a rollout UUID, or newest mtime is not identity.
 *  - Emissions are immutable frozen objects. Late subscribers replay the full
 *    history; unsubscribed listeners never fire again; a throwing listener
 *    cannot affect driver execution.
 *  - tmux/Herdr reattach emits nothing here: a new driver's env says nothing
 *    about an old process. Such resources are recovered by the resolver.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, opendirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DriverTranscriptSourceObservation,
  InsightClient,
  StreamIdentity,
} from '@dutydeck/shared';
import { pinnedSessionUuid } from '@dutydeck/cli-adapters';
import {
  claudeDataDir,
  claudeProjectDir,
  codexHistoryPath,
  codexHome,
  codexSessionsRoot,
  realCwd,
  traeHistoryPath,
  traeHome,
  traeSessionsRoot,
  type CliPathEnv,
} from './cli-paths.js';
import { parseJsonlObjects, readHead, readTail } from './session-id/fs-scan.js';
import { buildSessionMarker, isUsableMarker } from './session-id/marker.js';
import { codexInputText } from './transcript/input-receipt.js';

/** Adapter id → Session Insight log client. Adapter ids identify the on-disk
 *  CLIENT (transcript dialect + data root); a model provider is never a
 *  client. `seed`/`relay` are Claude forks with Claude's layout. Unknown
 *  adapters (grok/opencode/gemini/…) intentionally emit nothing. */
export function transcriptClientForAdapter(adapterId: string): InsightClient | undefined {
  switch (adapterId) {
    case 'codex':
      return 'codex';
    case 'claude-code':
    case 'seed':
    case 'relay':
      return 'claude';
    case 'traex':
      return 'traex';
    default:
      return undefined;
  }
}

export interface TranscriptSourceBinding {
  client: InsightClient;
  /** Approved data root, frozen from the child's final env. */
  dataRoot: string;
}

/**
 * Freeze the client's data root from the EXACT env the child process received.
 * Only path-bearing env names are consulted via cli-paths; the binding carries
 * no env copy and no secrets. Returns undefined for unsupported adapters.
 */
export function freezeTranscriptSource(
  adapterId: string,
  env: CliPathEnv,
): TranscriptSourceBinding | undefined {
  const client = transcriptClientForAdapter(adapterId);
  if (!client) return undefined;
  const dataRoot = client === 'codex' ? codexHome(env)
    : client === 'traex' ? traeHome(env)
      : claudeDataDir(env);
  return { client, dataRoot };
}

export interface VerifiedTranscriptIdentity {
  nativeSessionId: string;
  verifiedPath: string;
  /** `pty-marker-v1:<sha256(marker␀nativeId␀path)>`. The resolver reads the
   *  file content itself before trusting any binding; this only records what
   *  the driver actually matched. */
  identityProof: string;
  streamIdentity: StreamIdentity;
}

function markerIdentityProof(marker: string, nativeSessionId: string, verifiedPath: string): string {
  return `pty-marker-v1:${createHash('sha256')
    .update(marker).update('\0').update(nativeSessionId).update('\0').update(verifiedPath)
    .digest('hex')}`;
}

const MARKER_HEAD_BYTES = 256 * 1024;
const MAX_MARKER_CANDIDATES = 40;
/** Hostile-tree guard; mirrors session-id/fs-scan's entry budget. */
const MAX_ENUMERATED_ENTRIES = 20_000;

/** A bounded file enumeration that REPORTS truncation. The shared walkFiles
 *  silently returns when its entry cap is hit, which a uniqueness claim cannot
 *  tolerate; this variant stops once it has one match past the candidate
 *  budget (or hits the entry budget) and flags `truncated` so callers never
 *  call the remainder exhaustive. Only plain files are returned
 *  (Dirent.isFile — symlinks are not followed). */
function enumerateCandidates(
  root: string,
  maxDepth: number,
  accept: (name: string) => boolean,
): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  let truncated = false;
  let visited = 0;
  let rootStat;
  try {
    if (!existsSync(root)) return { paths, truncated };
    rootStat = statSync(root);
  } catch {
    return { paths, truncated };
  }
  if (!rootStat.isDirectory()) return { paths, truncated };
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  outer: while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let directory: ReturnType<typeof opendirSync>;
    try {
      directory = opendirSync(dir);
    } catch {
      continue;
    }
    try {
      let entry: import('node:fs').Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        if (++visited > MAX_ENUMERATED_ENTRIES) { truncated = true; break outer; }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        } else if (entry.isFile() && accept(entry.name)) {
          paths.push(full);
          if (paths.length > MAX_MARKER_CANDIDATES) { truncated = true; break outer; }
        }
      }
    } finally {
      try { directory.closeSync(); } catch { /* already closed */ }
    }
  }
  return { paths, truncated };
}

/**
 * Confirm that a file exists, is a regular file, and its realpath resides
 * strictly inside the approved root (no symlink traversal out of the root).
 */
function isSafeApprovedFile(filePath: string, approvedRoot: string): boolean {
  try {
    const lstat = lstatSync(filePath);
    if (!lstat.isFile() && !lstat.isSymbolicLink()) return false;
    const realTarget = realpathSync(filePath);
    const targetStat = statSync(realTarget);
    if (!targetStat.isFile()) return false;
    const realRoot = realpathSync(approvedRoot);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + '/')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** True when a Claude entry carries the marker in its user-visible text. */
function entryMentionsMarker(entry: any, marker: string): boolean {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some((block: any) =>
    block && typeof block === 'object' && typeof block.text === 'string' && block.text.includes(marker));
}

/** A Claude head record that carries our marker AND a native id. */
interface ClaudeMarkerHit {
  path: string;
  nativeSessionId: string;
}

/**
 * Content-verified Claude transcript.
 *
 * Every qualifying file must contain a NON-sidechain user record that carries
 * our prompt marker together with a native `sessionId`. A pinned
 * `<uuid>.jsonl` filename or newest mtime is not evidence. When candidate files
 * exceed budget (MAX_MARKER_CANDIDATES), any truncation risks manufacturing a
 * false unique match (see t3a-limit-ambiguity-probe), so we conservatively return
 * undefined and leave discovery to the resolver.
 * Multiple distinct native IDs or multiple physical files matching the same ID
 * are also rejected as ambiguous.
 */
function verifyClaude(
  dataRoot: string,
  sessionId: string,
  cwd: string,
): VerifiedTranscriptIdentity | undefined {
  if (!isUsableMarker(sessionId)) return undefined;
  const marker = buildSessionMarker(sessionId);
  // Pin every lookup to the FROZEN root: an env var pointing straight at it
  // makes later daemon HOME/CLAUDE_CONFIG_DIR changes unable to move us.
  const env: CliPathEnv = { CLAUDE_CONFIG_DIR: dataRoot };
  const projectDir = claudeProjectDir(cwd, env);

  // 1) Enumerate candidates with truncation reported. Never treat a truncated
  // set as exhaustive: an unvisited 41st file could carry a conflicting id.
  const enumeration = enumerateCandidates(projectDir, 0, name => name.endsWith('.jsonl'));
  if (enumeration.truncated) return undefined;

  const candidatePaths = enumeration.paths;
  const pinned = pinnedSessionUuid(sessionId);
  if (pinned) {
    const direct = join(projectDir, `${pinned}.jsonl`);
    if (existsSync(direct) && !candidatePaths.includes(direct)) {
      candidatePaths.push(direct);
      if (candidatePaths.length > MAX_MARKER_CANDIDATES) return undefined;
    }
  }

  // Distinct content-verified (file, nativeId) hits.
  const hits: ClaudeMarkerHit[] = [];
  for (const path of candidatePaths) {
    if (!isSafeApprovedFile(path, dataRoot)) continue;

    const idsInFile = new Set<string>();
    let markerWithoutId = false;
    for (const entry of parseJsonlObjects(readHead(path, MARKER_HEAD_BYTES))) {
      if (entry?.isSidechain === true) continue;
      if (entry?.type !== 'user' || entry?.message?.role !== 'user') continue;
      if (!entryMentionsMarker(entry, marker)) continue;
      const id = typeof entry?.sessionId === 'string' && entry.sessionId.length > 0 ? entry.sessionId : undefined;
      if (id) idsInFile.add(id);
      else markerWithoutId = true;
    }
    if (idsInFile.size > 1) return undefined; // conflicting ids in one file
    if (idsInFile.size === 1) {
      hits.push({ path: realpathSync(path), nativeSessionId: [...idsInFile][0]! });
    } else if (markerWithoutId) {
      return undefined; // marker present but unattributable
    }
  }

  const distinctIds = new Set(hits.map(hit => hit.nativeSessionId));
  if (distinctIds.size !== 1) return undefined; // 0 = not found, >1 = ambiguous

  // Multiple physical files matching the same ID is path-ambiguous.
  const distinctPaths = new Set(hits.map(hit => hit.path));
  if (distinctPaths.size !== 1) return undefined;

  const hit = hits[0]!;
  return {
    nativeSessionId: hit.nativeSessionId,
    verifiedPath: hit.path,
    identityProof: markerIdentityProof(marker, hit.nativeSessionId, hit.path),
    streamIdentity: { kind: 'main', nativeAgentId: null },
  };
}

const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;

/** Read every marker-bearing session id from history.jsonl (NOT last-wins). */
function codexHistoryMarkerIds(historyPath: string, marker: string): Set<string> {
  const ids = new Set<string>();
  for (const line of readTail(historyPath, HISTORY_TAIL_BYTES).split('\n')) {
    if (!line.includes(marker)) continue;
    let parsed: any;
    try { parsed = JSON.parse(line.trim()); } catch { continue; }
    if (typeof parsed?.text === 'string' && parsed.text.includes(marker)
      && typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      ids.add(parsed.session_id);
    }
  }
  return ids;
}

/**
 * Content-verified Codex-dialect rollout (codex and traex share the layout;
 *  only the root nesting differs).
 *
 * Identity requires CONTENT evidence that all converges on ONE native id:
 * marker-bearing lines in history.jsonl plus `session_meta` of rollouts whose
 * head user content carries the marker.
 *
 * Strict conservative rules:
 *  - If history.jsonl exceeds HISTORY_TAIL_BYTES, earlier records were truncated
 *    so marker-only evidence cannot be proven unique.
 *  - If rollout candidates exceed MAX_MARKER_CANDIDATES, refuse truncation.
 *  - If multiple physical rollouts match the same native ID, reject as path-ambiguous.
 *  - Pinned/symlinked paths outside dataRoot are rejected before read.
 */
function verifyCodexFamily(
  client: InsightClient,
  dataRoot: string,
  sessionId: string,
  cwd: string,
): VerifiedTranscriptIdentity | undefined {
  if (!isUsableMarker(sessionId)) return undefined;
  const marker = buildSessionMarker(sessionId);
  const env: CliPathEnv = client === 'codex' ? { CODEX_HOME: dataRoot } : { TRAE_HOME: dataRoot };
  const historyPath = client === 'codex' ? codexHistoryPath(env) : traeHistoryPath(env);
  const sessionsRoot = client === 'codex' ? codexSessionsRoot(env) : traeSessionsRoot(env);
  const wanted = realCwd(cwd, env);

  // 1) Marker evidence from history.jsonl. The tail window is bounded, so a
  // file larger than the window makes history-only evidence INCOMPLETE: an
  // older conflicting marker may sit above the window. Such history can still
  // corroborate, but it cannot by itself prove uniqueness.
  let historyComplete = true;
  try {
    const st = statSync(historyPath);
    if (st.isFile() && st.size > HISTORY_TAIL_BYTES) historyComplete = false;
  } catch { /* no history file → nothing incomplete */ }
  const historyIds = codexHistoryMarkerIds(historyPath, marker);

  // 2) Bounded rollout enumeration WITH truncation reporting. A self-attributing
  // rollout proves its OWN id, but uniqueness still needs an exhaustive set: an
  // unvisited extra rollout could carry the same marker under another id.
  const enumeration = enumerateCandidates(
    sessionsRoot, 3, name => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  );
  if (enumeration.truncated) return undefined;
  const candidates = enumeration.paths.map(path => ({ path }));

  // Rollouts whose OWN head user content carries the marker are self-attributing:
  // marker + session_meta(id,cwd) in one file independently proves this CLI id,
  // regardless of whether history.jsonl was fully readable.
  const contentIds = new Set<string>();
  for (const candidate of candidates) {
    if (!isSafeApprovedFile(candidate.path, dataRoot)) continue;
    let metaId: string | undefined;
    let cwdOk: boolean | undefined;
    let markerInContent = false;
    for (const entry of parseJsonlObjects(readHead(candidate.path, MARKER_HEAD_BYTES))) {
      if (entry?.type === 'session_meta') {
        const id = entry.payload?.id ?? entry.payload?.session_id;
        if (typeof id === 'string' && id.length > 0) metaId = id;
        if (typeof entry.payload?.cwd === 'string' && entry.payload.cwd.length > 0) {
          cwdOk = realCwd(entry.payload.cwd, env) === wanted;
        }
      } else if (!markerInContent && codexInputText(entry)?.includes(marker)) {
        markerInContent = true;
      }
    }
    // Marker in content requires a self-consistent meta; a marker with no/mismatched id is a conflict.
    if (markerInContent && (!metaId || cwdOk === false)) return undefined;
    if (markerInContent && metaId) contentIds.add(metaId);
  }

  // 3) Converge the evidence.
  //  - Complete history is full-scope; its ids count as uniqueness evidence.
  //  - Self-attributing rollout content always counts.
  //  - Truncated history-only evidence is never enough on its own.
  if (contentIds.size > 1) return undefined; // contradictory self-attributing files
  const strongId = contentIds.size === 1 ? [...contentIds][0]! : undefined;
  if (strongId !== undefined) {
    // Visible (even truncated) history must not contradict the strong id.
    for (const historyId of historyIds) {
      if (historyId !== strongId) return undefined;
    }
  } else if (historyComplete) {
    if (historyIds.size !== 1) return undefined; // 0 = not found, >1 = ambiguous
  } else {
    return undefined; // only an incomplete history tail → cannot prove unique
  }
  const nativeSessionId = strongId ?? [...historyIds][0]!;

  // 4) Enumerate EVERY rollout whose session_meta names this native id,
  // including cwd-mismatching ones: silently skipping a conflicting file would
  // let the survivor look unique. Multiple physical files for one id, or a
  // single one whose recorded cwd contradicts ours, is not verifiable here.
  const idMatches: Array<{ path: string; cwdOk: boolean }> = [];
  for (const candidate of candidates) {
    if (!isSafeApprovedFile(candidate.path, dataRoot)) continue;
    for (const entry of parseJsonlObjects(readHead(candidate.path, MARKER_HEAD_BYTES))) {
      if (entry?.type !== 'session_meta') continue;
      const id = entry.payload?.id ?? entry.payload?.session_id;
      if (id === nativeSessionId) {
        const cwdOk = !(typeof entry.payload?.cwd === 'string' && entry.payload.cwd.length > 0)
          || realCwd(entry.payload.cwd, env) === wanted;
        idMatches.push({ path: realpathSync(candidate.path), cwdOk });
      }
      break;
    }
  }

  if (idMatches.length !== 1) return undefined; // 0 = no file, >1 = path-ambiguous
  const match = idMatches[0]!;
  if (!match.cwdOk) return undefined;

  return {
    nativeSessionId,
    verifiedPath: match.path,
    identityProof: markerIdentityProof(marker, nativeSessionId, match.path),
    streamIdentity: { kind: 'main', nativeAgentId: null },
  };
}

/**
 * Verify the native transcript identity of a LAUNCHED source using only
 * content evidence. `dataRoot` is the root frozen at launch; verification is
 * pinned to it, so a later HOME/override change cannot rebind the launch.
 */
export function verifyLaunchedTranscript(
  client: InsightClient,
  dataRoot: string,
  ctx: { sessionId: string; cwd: string },
): VerifiedTranscriptIdentity | undefined {
  try {
    if (client === 'claude') return verifyClaude(dataRoot, ctx.sessionId, ctx.cwd);
    return verifyCodexFamily(client, dataRoot, ctx.sessionId, ctx.cwd);
  } catch {
    // Hostile/unreadable files are "not verified", never a driver failure.
    return undefined;
  }
}

export interface PendingLaunch {
  observationId: string;
  client: InsightClient;
  dataRoot: string;
  cwd: string;
  verified: boolean;
}

/**
 * Holds the immutable observation stream of one PtyCliDriver. One driver
 * bridges one client; every real spawn/respawn appends a launch observation,
 * and the first content-verified identity of the CURRENT launch appends a
 * follow-up. Reattaches append nothing.
 */
export class TranscriptSourceTracker {
  private readonly observations: DriverTranscriptSourceObservation[] = [];
  private readonly listeners = new Set<(o: DriverTranscriptSourceObservation) => void>();
  private current: PendingLaunch | undefined;

  subscribe(listener: (o: DriverTranscriptSourceObservation) => void): () => void {
    this.listeners.add(listener);
    // Replay everything the driver already observed, in emission order. The
    // frozen objects can be shared safely — they never mutate.
    for (const observation of this.observations) this.deliver(listener, observation);
    return () => { this.listeners.delete(listener); };
  }

  /** Launch observations still awaiting native identity (at most the latest
   *  spawn per driver — a respawn supersedes an unverified earlier launch). */
  pendingLaunches(): ReadonlyArray<Readonly<PendingLaunch>> {
    return this.current && !this.current.verified ? [this.current] : [];
  }

  /** A real backend.spawn/respawn created a CLI process with this binding. */
  recordLaunch(binding: TranscriptSourceBinding, cwd: string): DriverTranscriptSourceObservation {
    this.current = {
      observationId: randomUUID(),
      client: binding.client,
      dataRoot: binding.dataRoot,
      cwd,
      verified: false,
    };
    return this.publish({
      observationId: this.current.observationId,
      client: binding.client,
      launchKind: 'created',
      proofKind: 'launch_observed',
      capturedAt: new Date().toISOString(),
      dataRoot: binding.dataRoot,
      cwd,
      nativeSessionId: null,
      verifiedPath: null,
      identityProof: null,
    });
  }

  /** Append content-verified native identity for the current launch. */
  recordIdentity(
    launchObservationId: string,
    verified: VerifiedTranscriptIdentity,
  ): DriverTranscriptSourceObservation | undefined {
    const launch = this.current;
    if (!launch || launch.verified || launch.observationId !== launchObservationId) return undefined;
    launch.verified = true;
    return this.publish({
      observationId: randomUUID(),
      client: launch.client,
      launchKind: 'created',
      proofKind: 'launch_observed',
      capturedAt: new Date().toISOString(),
      dataRoot: launch.dataRoot,
      cwd: launch.cwd,
      nativeSessionId: verified.nativeSessionId,
      verifiedPath: verified.verifiedPath,
      identityProof: verified.identityProof,
      streamIdentity: verified.streamIdentity,
    });
  }

  private publish(
    observation: DriverTranscriptSourceObservation,
  ): DriverTranscriptSourceObservation {
    if (observation.streamIdentity) Object.freeze(observation.streamIdentity);
    Object.freeze(observation);
    this.observations.push(observation);
    for (const listener of [...this.listeners]) this.deliver(listener, observation);
    return observation;
  }

  private deliver(
    listener: (o: DriverTranscriptSourceObservation) => void,
    observation: DriverTranscriptSourceObservation,
  ): void {
    // A diagnostic listener must never break driver execution.
    try { listener(observation); } catch { /* isolate */ }
  }
}
