/**
 * Claude Code native session-id lookup.
 *
 * Claude writes one JSONL per session at
 *   <claudeDataDir>/projects/<projectKey>/<cliSessionId>.jsonl
 * and every entry carries a `sessionId` field, so the CLI's session id is
 * recoverable from either the filename or the file body.
 *
 * dutydeck normally pins this id itself (`claude --session-id <uuid>`), so the
 * happy path needs no scan at all — the resolver first checks whether the
 * expected file exists and returns immediately. The scan only matters when
 * Claude declined the pinned id (a collision with an existing session makes
 * the CLI generate its own) or when the session was adopted rather than
 * spawned by us.
 *
 * The scan matches on the injected marker inside the first user prompt, NOT
 * on recency: several dutydeck sessions can share a cwd, and picking the
 * newest jsonl among them would resume a sibling's conversation.
 */
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { claudeFamilyCliAdapterIds, isClaudeFamilyCli } from '@dutydeck/shared';
import { claudeProjectDirCandidates } from '../cli-paths.js';
import { byMtimeDesc, parseJsonlObjects, readHead, nativeTranscriptObjects, walkFiles } from './fs-scan.js';
import { buildSessionMarker, isUsableMarker } from './marker.js';
import { userEntryMentionsMarker } from '../transcript/claude-content.js';
import type { SessionIdLookup, SessionIdLookupContext } from './types.js';

/** Head window per candidate transcript. The marker rides the FIRST user
 *  prompt, so a small head window is enough and keeps a long conversation
 *  from being read in full. */
const HEAD_BYTES = 256 * 1024;
/** Newest-first cap on candidates scanned across a cwd's project dirs. */
const MAX_CANDIDATES = 40;

/** The UUID dutydeck pinned via --session-id; Claude's own ids are bare UUIDs. */
function bareId(sessionId: string): string {
  return pinnedSessionUuid(sessionId);
}

/** The CLI session id recorded inside a transcript entry, if any. */
function entrySessionId(entry: any): string | undefined {
  const id = entry?.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function markedSession(path: string, sessionId: string, exactPinned = false): string | undefined {
  const records = exactPinned ? nativeTranscriptObjects(path) : parseJsonlObjects(readHead(path, HEAD_BYTES));
  for (const entry of records) {
    if (!userEntryMentionsMarker(entry, buildSessionMarker(sessionId))) continue;
    return entrySessionId(entry) ?? (path.replace(/^.*\//, '').replace(/\.jsonl$/, '') || undefined);
  }
  return undefined;
}

/** A pinned native id may not be reused for a fresh launch, even when its marker
 *  is unreadable. A name the filesystem cannot hold (ENAMETOOLONG: an
 *  untruncated legacy key) cannot hold a session either. */
export function hasPinnedClaudeSession(adapterId: string, { sessionId, cwd, env }: SessionIdLookupContext): boolean {
  if (!isClaudeFamilyCli(adapterId)) return false;
  return claudeProjectDirCandidates(cwd, env).some(dir => {
    try { lstatSync(join(dir, `${bareId(sessionId)}.jsonl`)); return true; }
    catch (error) { return !['ENOENT', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? ''); }
  });
}

export const claudeSessionIdLookup: SessionIdLookup = {
  // Claude Code plus its two forks: same per-project JSONL layout, same
  // `sessionId`-per-entry field, same filename-is-the-session-id rule. Only
  // the root differs, and that arrives with `ctx.env` (the fork's own
  // CLAUDE_CONFIG_DIR must be set through `agent.env`).
  adapterIds: claudeFamilyCliAdapterIds,

  resolve({ sessionId, cwd, env, requireMarker }: SessionIdLookupContext): string | undefined {
    // A long cwd has two candidate project dirs (current truncated key and
    // the legacy untruncated one); both are searched, the content decides.
    const projectDirs = claudeProjectDirCandidates(cwd, env);

    // Fast path: dutydeck pinned the id via --session-id and Claude accepted it.
    const pinned = bareId(sessionId);
    const pinnedPaths = pinned ? projectDirs.map(dir => join(dir, `${pinned}.jsonl`)).filter(path => existsSync(path)) : [];
    if (pinnedPaths.length > 0) {
      if (!requireMarker) return pinned;
      // Do not let unrelated newer files push the exact pinned transcript out
      // of the bounded scan. A conflicting pinned file must not be adopted,
      // and two proven copies cannot be told apart here.
      if (!isUsableMarker(sessionId)) return undefined;
      const proven = pinnedPaths.flatMap(path => markedSession(path, sessionId, true) ?? []);
      return proven.length === 1 ? proven[0] : undefined;
    }

    if (!isUsableMarker(sessionId)) return undefined;

    // Scan path: find the transcript whose first user prompt carries our
    // marker. Newest first only bounds the work — the marker decides.
    const candidates = projectDirs.flatMap(dir => walkFiles(dir, {
      maxDepth: 0,
      accept: name => name.endsWith('.jsonl'),
    })).sort(byMtimeDesc).slice(0, MAX_CANDIDATES);

    for (const candidate of candidates) {
      const found = markedSession(candidate.path, sessionId);
      if (found) return found;
    }
    return undefined;
  },
};
