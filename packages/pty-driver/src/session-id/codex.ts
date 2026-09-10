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
import { byMtimeDesc, parseJsonlObjects, readHead, readTail, walkFiles } from './fs-scan.js';
import { isUsableMarker } from './marker.js';
import type { SessionIdLookup, SessionIdLookupContext } from './types.js';

/** history.jsonl grows without bound; recent sessions are at the end, so a
 *  bounded tail keeps the lookup O(window) rather than O(file). */
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
/** Head window per rollout candidate: session_meta plus the first prompt. */
const ROLLOUT_HEAD_BYTES = 256 * 1024;
/** Directory depth of the YYYY/MM/DD rollout tree below `sessions/`. */
const SESSION_SCAN_MAX_DEPTH = 3;
/** Newest-first cap on rollout candidates examined. */
const MAX_ROLLOUT_CANDIDATES = 60;

/** The UUID tail of a `rollout-<ts>-<uuid>.jsonl` filename. The timestamp has
 *  its own dashes, so the id is anchored on the UUID shape, not on position. */
const ROLLOUT_ID_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Scan the tail of a Codex-dialect history.jsonl for the newest submit whose
 *  text carries the marker, and return that line's `session_id`. */
export function findSessionIdInHistory(historyPath: string, marker: string): string | undefined {
  const text = readTail(historyPath, HISTORY_TAIL_BYTES);
  if (!text) return undefined;
  const lines = text.split('\n');
  // Last match wins: the newest submit naming this dutydeck session belongs to
  // the CLI session that is still alive.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(marker)) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (typeof parsed?.text !== 'string' || !parsed.text.includes(marker)) continue;
    if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      return parsed.session_id;
    }
  }
  return undefined;
}

/** Text of a rollout `response_item` user message, joined across blocks. */
function rolloutUserText(entry: any): string {
  const p = entry?.payload;
  if (!p || p.type !== 'message' || p.role !== 'user') return '';
  if (typeof p.content === 'string') return p.content;
  if (!Array.isArray(p.content)) return '';
  const parts: string[] = [];
  for (const block of p.content) {
    if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * Scan the rollout tree for the session whose head carries the marker.
 * `cwd` gates the match: session_meta records the working directory, and a
 * rollout from a different project can never be this dutydeck session.
 */
export function findSessionIdInRollouts(
  sessionsRoot: string,
  marker: string,
  cwd: string,
  env?: CliPathEnv,
): string | undefined {
  const wanted = realCwd(cwd, env);
  const candidates = walkFiles(sessionsRoot, {
    maxDepth: SESSION_SCAN_MAX_DEPTH,
    accept: name => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  }).sort(byMtimeDesc).slice(0, MAX_ROLLOUT_CANDIDATES);

  for (const candidate of candidates) {
    const entries = parseJsonlObjects(readHead(candidate.path, ROLLOUT_HEAD_BYTES));
    let metaSessionId: string | undefined;
    let cwdOk: boolean | undefined;
    let marked = false;
    for (const entry of entries) {
      if (entry?.type === 'session_meta') {
        const p = entry.payload;
        if (typeof p?.session_id === 'string' && p.session_id.length > 0) metaSessionId = p.session_id;
        if (typeof p?.cwd === 'string' && p.cwd.length > 0) cwdOk = realCwd(p.cwd, env) === wanted;
        continue;
      }
      if (entry?.type === 'response_item' && rolloutUserText(entry).includes(marker)) {
        marked = true;
        break;
      }
    }
    // A rollout that records a DIFFERENT cwd is provably not ours. A rollout
    // with no recorded cwd is accepted on the marker alone (the marker is
    // already per-session unique).
    if (!marked || cwdOk === false) continue;
    if (metaSessionId) return metaSessionId;
    const fromName = ROLLOUT_ID_RE.exec(candidate.path);
    if (fromName?.[1]) return fromName[1];
  }
  return undefined;
}

function codexFamilyResolve(
  historyPath: string,
  sessionsRoot: string,
  { sessionId, cwd, env }: SessionIdLookupContext,
): string | undefined {
  if (!isUsableMarker(sessionId)) return undefined;
  // history.jsonl first: it is written at submit time, so it is populated
  // before the rollout has any user content to match on.
  return findSessionIdInHistory(historyPath, sessionId)
    ?? findSessionIdInRollouts(sessionsRoot, sessionId, cwd, env);
}

export const codexSessionIdLookup: SessionIdLookup = {
  adapterIds: ['codex'],
  // Roots are resolved per call against the CHILD's env: `agent.env` may set
  // CODEX_HOME per session, so a root captured once would be wrong.
  resolve: ctx => codexFamilyResolve(codexHistoryPath(ctx.env), codexSessionsRoot(ctx.env), ctx),
};

export const traexSessionIdLookup: SessionIdLookup = {
  adapterIds: ['traex'],
  resolve: ctx => codexFamilyResolve(traeHistoryPath(ctx.env), traeSessionsRoot(ctx.env), ctx),
};
