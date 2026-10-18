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
 * actually still alive.
 *
 * The rollout fallback additionally requires the recorded `cwd` to match, so
 * a marker that somehow leaked into another project's transcript cannot
 * hijack the lookup.
 *
 * TRAE is a Codex fork with the identical rollout/history dialect, nested one
 * level deeper (`<traeHome>/cli/...`). Only the roots differ.
 */
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

/** Read history once, retaining the newest hit for each marker format. */
function findSessionIdsInHistory(historyPath: string, markers: Marker[]): Array<string | undefined> {
  const matches: Array<string | undefined> = markers.map(() => undefined);
  const lines = readTail(historyPath, HISTORY_TAIL_BYTES).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!markers.some(marker => line.includes(marker.text))) continue;
    let parsed: any;
    try { parsed = JSON.parse(line.trim()); } catch { continue; }
    if (typeof parsed?.text !== 'string' || typeof parsed.session_id !== 'string' || !parsed.session_id) continue;
    markers.forEach((marker, index) => {
      if (!matches[index] && matchesMarker(parsed.text, marker)) matches[index] = parsed.session_id;
    });
    if (matches[0]) break;
  }
  return matches;
}

/** Newest submit carrying this marker. Raw legacy IDs must occupy the whole input. */
export function findSessionIdInHistory(historyPath: string, marker: string, exactText = false): string | undefined {
  return findSessionIdsInHistory(historyPath, [{ text: marker, exactText }])[0];
}

/** Scan each rollout once for every format, retaining global marker priority. */
function findSessionIdsInRollouts(
  sessionsRoot: string,
  markers: Marker[],
  cwd: string,
  env: CliPathEnv | undefined,
  inputText: (entry: any, threadId?: string) => string | undefined,
): Array<string | undefined> {
  const matches: Array<string | undefined> = markers.map(() => undefined);
  const wanted = realCwd(cwd, env);
  const candidates = walkFiles(sessionsRoot, {
    maxDepth: SESSION_SCAN_MAX_DEPTH,
    accept: name => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  }).sort(byMtimeDesc).slice(0, MAX_ROLLOUT_CANDIDATES);

  for (const candidate of candidates) {
    let metaSessionId: string | undefined;
    let sawMeta = false;
    let cwdOk: boolean | undefined;
    let inheritedMeta = false;
    const all: RolloutMarkerMatches = { marked: markers.map(() => false) };
    const threadBound: RolloutMarkerMatches = { marked: markers.map(() => false) };
    for (const entry of nativeTranscriptObjects(candidate.path)) {
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
    if (cwdOk === false) continue;
    // Without recorded metadata, retain the filename fallback on a marker match.
    const id = metaSessionId ?? ROLLOUT_ID_RE.exec(candidate.path)?.[1];
    if (!id) continue;
    // Generic user records in forks have no trustworthy own-input boundary.
    // history.jsonl is handled independently; only thread-bound receipts may
    // establish a fork's identity from the rollout itself.
    const marked = inheritedMeta ? threadBound.marked : all.marked;
    marked.forEach((hit, index) => { if (hit && !matches[index]) matches[index] = id; });
    if (matches[0]) break;
  }
  return matches;
}

/** Scan newest-first rollouts for one marker, gated by the first metadata cwd. */
export function findSessionIdInRollouts(
  sessionsRoot: string,
  marker: string,
  cwd: string,
  env?: CliPathEnv,
  inputText: (entry: any, threadId?: string) => string | undefined = codexInputText,
  exactText = false,
): string | undefined {
  return findSessionIdsInRollouts(sessionsRoot, [{ text: marker, exactText }], cwd, env, inputText)[0];
}

function codexFamilyResolve(
  historyPath: string,
  sessionsRoot: string,
  { sessionId, cwd, env, requireMarker }: SessionIdLookupContext,
  inputText: (entry: any, threadId?: string) => string | undefined = codexInputText,
): string | undefined {
  if (!isUsableMarker(sessionId)) return undefined;
  // history.jsonl first: it is written at submit time, so it is populated
  // before the rollout has any user content to match on.
  // Prefer modern identity across both sources before trying either legacy
  // envelope. A source id merely mentioned in a fork handoff is never a match.
  const markers = [buildSessionMarker(sessionId), ...(requireMarker ? [] : [`[dutydeck-session:${sessionId}]`, sessionId])]
    .map(text => ({ text, exactText: text === sessionId }));
  const history = findSessionIdsInHistory(historyPath, markers);
  if (history[0]) return history[0];
  const rollouts = findSessionIdsInRollouts(sessionsRoot, markers, cwd, env, inputText);
  for (let index = 0; index < markers.length; index++) {
    const found = history[index] ?? rollouts[index];
    if (found) return found;
  }
  return undefined;
}

export const codexSessionIdLookup: SessionIdLookup = {
  adapterIds: ['codex'],
  // Roots are resolved per call against the CHILD's env: `agent.env` may set
  // CODEX_HOME per session, so a root captured once would be wrong.
  resolve: ctx => codexFamilyResolve(codexHistoryPath(ctx.env), codexSessionsRoot(ctx.env), ctx),
};

export const traexSessionIdLookup: SessionIdLookup = {
  adapterIds: ['traex'],
  resolve: ctx => codexFamilyResolve(traeHistoryPath(ctx.env), traeSessionsRoot(ctx.env), ctx,
    (entry, threadId) => entry?.type === 'history_mutation' && !threadId ? undefined : traexInputText(entry, threadId)),
};
