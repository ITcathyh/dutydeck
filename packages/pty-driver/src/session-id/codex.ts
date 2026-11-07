/**
 * Codex-family native session-id lookup (codex + traex).
 *
 * Both CLIs mint their own UUID and never accept one from the caller, so
 * `codex resume <dutydeckSessionId>` was always wrong. Two on-disk sources
 * bridge the gap:
 *
 *  1. `<home>/history.jsonl` — the global submit log. One
 *     `{session_id, ts, text}` line per user submit across every session, so
 *     the line whose `text` carries our marker names the owning session.
 *     Written at submit time, which makes it the earliest available evidence.
 *
 *  2. `<home>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl` — the
 *     per-session rollout. Its head holds a `session_meta` record with
 *     `session_id` + `cwd`, and the first user `response_item` holds the
 *     prompt text. Used when history.jsonl is absent, disabled, or trimmed.
 *
 * history.jsonl is scanned from the END (recent sessions live at the tail)
 * and the LAST marker hit wins: a session resumed several times appends a
 * fresh line each time, and the newest line names the session that is
 * actually still alive. Only a native session's FIRST submit counts: the
 * marker rides on the first prompt, so the same marker pasted into a later
 * message of another session (a quoted log, a copied prompt) cannot claim it.
 *
 * The rollout fallback additionally requires the recorded `cwd` to match, so
 * a marker that somehow leaked into another project's transcript cannot
 * hijack the lookup.
 *
 * TRAE is a Codex fork with the identical rollout/history dialect, nested one
 * level deeper (`<traeHome>/cli/...`). Only the roots differ.
 */
import { statSync } from 'node:fs';
import {
  codexHistoryPath,
  codexSessionsRoot,
  realCwd,
  traeHistoryPath,
  traeSessionsRoot,
  type CliPathEnv,
} from '../cli-paths.js';
import { byMtimeDesc, readTail, nativeTranscriptObjects, walkFiles } from './fs-scan.js';
import { buildSessionMarker, isUsableMarker } from './marker.js';
import type { SessionIdLookup, SessionIdLookupContext } from './types.js';
import { codexInputText, traexInputText } from '../transcript/input-receipt.js';

/** history.jsonl grows without bound; recent sessions are at the end, so a
 *  bounded tail keeps the lookup O(window) rather than O(file). */
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
/** Directory depth of the YYYY/MM/DD rollout tree below `sessions/`. */
const SESSION_SCAN_MAX_DEPTH = 3;
/** Newest-first cap on rollout candidates examined. */
const MAX_ROLLOUT_CANDIDATES = 60;
/** A live tailer asks for its native id on every poll, and per history line
 *  while a receipt is armed. While the id is unresolved it scans at most every
 *  250 ms for this long after start or a new input, then at 1 s doubling to
 *  30 s; a changed history.jsonl is reread at once. A CLI that never takes its
 *  first prompt must not cost a scan per poll. */
const LOCATOR_FAST_MS = 10_000;
const LOCATOR_FAST_GAP_MS = 250;
const LOCATOR_FIRST_INTERVAL_MS = 1_000;
const LOCATOR_MAX_INTERVAL_MS = 30_000;

interface FileStamp { mtimeMs: number; size: number }
/** One rollout's marker hits; without `id` it cannot own the session. */
interface RolloutScan { id?: string; marked: boolean[] }
/** Per-file results, each valid while its file's mtime and size are unchanged. */
interface ScanCache {
  history?: FileStamp & { matches: Array<string | undefined> };
  rollouts: Map<string, FileStamp & { scan: RolloutScan }>;
}
function fileStamp(path: string): FileStamp | undefined {
  try { const st = statSync(path); return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : undefined; } catch { return undefined; }
}
const sameStamp = (a: FileStamp | undefined, b: FileStamp | undefined): boolean => a?.mtimeMs === b?.mtimeMs && a?.size === b?.size;

/** The UUID tail of a `rollout-<ts>-<uuid>.jsonl` filename. The timestamp has
 *  its own dashes, so the id is anchored on the UUID shape, not on position. */
const ROLLOUT_ID_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface Marker { text: string; exactText: boolean }
const matchesMarker = (text: string, marker: Marker): boolean => marker.exactText ? text.trim() === marker.text : text.includes(marker.text);

/** A fork appends its own prompt after inherited user records. The final
 * complete envelope supersedes inherited markers; ordinary follow-ups do not. */
export function lastCodexSessionMarker(text: string): { text: string; sessionId: string } | undefined {
  let last: { text: string; sessionId: string } | undefined;
  for (const match of text.matchAll(/<dutydeck_session_id>([^<>\r\n]+)<\/dutydeck_session_id>|\[dutydeck-session:([^\]\r\n]+)\]/g)) {
    const sessionId = (match[1] ?? match[2])!;
    if (isUsableMarker(sessionId) && (last?.sessionId !== sessionId || match[1])) last = { text: match[0], sessionId };
  }
  return last;
}

interface RolloutMarkerMatches { sessionId?: string; marked: boolean[] }
function recordRolloutMarkers(text: string, markers: Marker[], state: RolloutMarkerMatches): void {
  const envelope = lastCodexSessionMarker(text);
  if (envelope) {
    if (state.sessionId !== envelope.sessionId) state.marked.fill(false);
    state.sessionId = envelope.sessionId;
    markers.forEach((marker, index) => { if (marker.text === envelope.text) state.marked[index] = true; });
  } else if (!state.sessionId) {
    markers.forEach((marker, index) => { if (matchesMarker(text, marker)) state.marked[index] = true; });
  }
}

/** Is line `index` the earliest submit of `nativeId` in the history window? */
function isFirstSubmit(lines: string[], index: number, nativeId: string): boolean {
  for (let i = 0; i < index; i++) {
    if (!lines[i]!.includes(nativeId)) continue;
    try { if (JSON.parse(lines[i]!.trim())?.session_id === nativeId) return false; } catch { /* partial or malformed line */ }
  }
  return true;
}

/** Read history once, retaining the newest first-submit hit for each marker format. */
function findSessionIdsInHistory(historyPath: string, markers: Marker[], cache?: ScanCache): Array<string | undefined> {
  // Stamp before reading: an append racing the read then only costs a rescan.
  const stamp = cache && fileStamp(historyPath);
  if (cache?.history && sameStamp(stamp, cache.history)) return cache.history.matches;
  const matches: Array<string | undefined> = markers.map(() => undefined);
  const lines = readTail(historyPath, HISTORY_TAIL_BYTES).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!markers.some(marker => line.includes(marker.text))) continue;
    let parsed: any;
    try { parsed = JSON.parse(line.trim()); } catch { continue; }
    if (typeof parsed?.text !== 'string' || typeof parsed.session_id !== 'string' || !parsed.session_id) continue;
    if (!isFirstSubmit(lines, i, parsed.session_id)) continue;
    markers.forEach((marker, index) => {
      if (!matches[index] && matchesMarker(parsed.text, marker)) matches[index] = parsed.session_id;
    });
    if (matches[0]) break;
  }
  if (cache) cache.history = stamp && { ...stamp, matches };
  return matches;
}

function scanRollout(
  path: string,
  markers: Marker[],
  wanted: string,
  env: CliPathEnv | undefined,
  inputText: (entry: any, threadId?: string) => string | undefined,
): RolloutScan {
  let metaSessionId: string | undefined;
  let sawMeta = false;
  let cwdOk: boolean | undefined;
  let inheritedMeta = false;
  const all: RolloutMarkerMatches = { marked: markers.map(() => false) };
  const threadBound: RolloutMarkerMatches = { marked: markers.map(() => false) };
  for (const entry of nativeTranscriptObjects(path)) {
    if (entry?.type === 'session_meta') {
      // Native forks copy parent metadata after their own identity record.
      if (sawMeta) {
        if ((entry.payload?.id ?? entry.payload?.session_id) !== metaSessionId) inheritedMeta = true;
        continue;
      }
      sawMeta = true;
      const p = entry.payload;
      // Internal agents inherit user markers but never own a Dutydeck CLI session.
      if (p?.source && typeof p.source === 'object' && 'subagent' in p.source) break;
      const id = p?.id ?? p?.session_id;
      if (typeof id === 'string' && id.length > 0) metaSessionId = id;
      if (typeof p?.cwd === 'string' && p.cwd.length > 0) cwdOk = realCwd(p.cwd, env) === wanted;
      if (cwdOk === false) break;
      continue;
    }
    const text = inputText(entry, metaSessionId);
    if (text === undefined) continue;
    recordRolloutMarkers(text, markers, all);
    // TraeX display completions explicitly name their native thread and turn.
    // Copied parent completions cannot prove ownership of this first metadata ID.
    if (entry.type === 'history_mutation' && metaSessionId) {
      const ownInput = traexInputText(entry, metaSessionId);
      if (ownInput !== undefined) recordRolloutMarkers(ownInput, markers, threadBound);
    }
    // Scan through EOF: later metadata can reveal that earlier input was inherited.
  }
  if (cwdOk === false) return { marked: [] };
  // Generic user records in forks have no trustworthy own-input boundary.
  // history.jsonl is handled independently; only thread-bound receipts may
  // establish a fork's identity from the rollout itself.
  return {
    // Without recorded metadata, retain the filename fallback on a marker match.
    id: metaSessionId ?? ROLLOUT_ID_RE.exec(path)?.[1],
    marked: inheritedMeta ? threadBound.marked : all.marked,
  };
}

/** Scan each rollout once for every format, retaining global marker priority. */
function findSessionIdsInRollouts(
  sessionsRoot: string,
  markers: Marker[],
  cwd: string,
  env: CliPathEnv | undefined,
  inputText: (entry: any, threadId?: string) => string | undefined,
  cache?: ScanCache,
): Array<string | undefined> {
  const matches: Array<string | undefined> = markers.map(() => undefined);
  const wanted = realCwd(cwd, env);
  const candidates = walkFiles(sessionsRoot, {
    maxDepth: SESSION_SCAN_MAX_DEPTH,
    accept: name => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  }).sort(byMtimeDesc).slice(0, MAX_ROLLOUT_CANDIDATES);
  if (cache) {
    const current = new Set(candidates.map(candidate => candidate.path));
    for (const path of cache.rollouts.keys()) if (!current.has(path)) cache.rollouts.delete(path);
  }

  for (const candidate of candidates) {
    const cached = cache?.rollouts.get(candidate.path);
    const scan = cached && sameStamp(cached, candidate) ? cached.scan : scanRollout(candidate.path, markers, wanted, env, inputText);
    cache?.rollouts.set(candidate.path, { mtimeMs: candidate.mtimeMs, size: candidate.size, scan });
    if (!scan.id) continue;
    scan.marked.forEach((hit, index) => { if (hit && !matches[index]) matches[index] = scan.id; });
    if (matches[0]) break;
  }
  return matches;
}

interface CodexFamily {
  historyPath(env?: CliPathEnv): string;
  sessionsRoot(env?: CliPathEnv): string;
  inputText(entry: any, threadId?: string): string | undefined;
}
const CODEX: CodexFamily = { historyPath: codexHistoryPath, sessionsRoot: codexSessionsRoot, inputText: codexInputText };
const TRAEX: CodexFamily = {
  historyPath: traeHistoryPath,
  sessionsRoot: traeSessionsRoot,
  inputText: (entry, threadId) => entry?.type === 'history_mutation' && !threadId ? undefined : traexInputText(entry, threadId),
};

function codexFamilyResolve(
  family: CodexFamily,
  { sessionId, cwd, env, requireMarker }: SessionIdLookupContext,
  cache?: ScanCache,
  historyOnly = false,
): string | undefined {
  if (!isUsableMarker(sessionId)) return undefined;
  // history.jsonl first: it is written at submit time, so it is populated
  // before the rollout has any user content to match on.
  // Prefer modern identity across both sources before trying either legacy
  // envelope. A source id merely mentioned in a fork handoff is never a match.
  const markers = [buildSessionMarker(sessionId), ...(requireMarker ? [] : [`[dutydeck-session:${sessionId}]`, sessionId])]
    .map(text => ({ text, exactText: text === sessionId }));
  // Roots are resolved per call against the CHILD's env: `agent.env` may set
  // CODEX_HOME per session, so a root captured once would be wrong.
  const history = findSessionIdsInHistory(family.historyPath(env), markers, cache);
  if (history[0]) return history[0];
  // A legacy history hit may still be outranked by a modern rollout marker.
  if (historyOnly && !history.some(Boolean)) return undefined;
  const rollouts = findSessionIdsInRollouts(family.sessionsRoot(env), markers, cwd, env, family.inputText, cache);
  for (let index = 0; index < markers.length; index++) {
    const found = history[index] ?? rollouts[index];
    if (found) return found;
  }
  return undefined;
}

/** codexFamilyResolve for one live tailer, which asks on every poll. Between
 *  timed scans only a changed history.jsonl is consulted, and only a marker hit
 *  there brings the rollout scan forward, so the receipt line of the first
 *  prompt can still name its session as soon as it is read. */
export class CodexSessionIdLocator {
  private readonly family: CodexFamily;
  private readonly cache: ScanCache = { rollouts: new Map() };
  private fastUntil = 0;
  private nextScanAt = 0;
  private interval = LOCATOR_FIRST_INTERVAL_MS;

  constructor(adapterId: 'codex' | 'traex', private readonly ctx: SessionIdLookupContext) {
    this.family = adapterId === 'codex' ? CODEX : TRAEX;
    this.wake();
  }

  /** A prompt is about to be written: its history and rollout records are expected promptly. */
  wake(): void {
    this.fastUntil = Date.now() + LOCATOR_FAST_MS;
    this.nextScanAt = 0;
    this.interval = LOCATOR_FIRST_INTERVAL_MS;
  }

  resolve(): string | undefined {
    try {
      const now = Date.now();
      const due = now >= this.nextScanAt;
      if (!due && sameStamp(fileStamp(this.family.historyPath(this.ctx.env)), this.cache.history)) return undefined;
      if (due && now < this.fastUntil) this.nextScanAt = now + LOCATOR_FAST_GAP_MS;
      else if (due) {
        this.nextScanAt = now + this.interval;
        this.interval = Math.min(this.interval * 2, LOCATOR_MAX_INTERVAL_MS);
      }
      return codexFamilyResolve(this.family, this.ctx, this.cache, !due);
    } catch {
      return undefined;
    }
  }
}

export const codexSessionIdLookup: SessionIdLookup = {
  adapterIds: ['codex'],
  resolve: ctx => codexFamilyResolve(CODEX, ctx),
};

export const traexSessionIdLookup: SessionIdLookup = {
  adapterIds: ['traex'],
  resolve: ctx => codexFamilyResolve(TRAEX, ctx),
};
