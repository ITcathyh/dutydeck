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
import { getCliProfile, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { claudeFamilyCliAdapterIds } from '@dutydeck/shared';
import { claudeProjectDirCandidates } from '../cli-paths.js';
import { claudeMarkerCandidates, claudePinnedTranscriptPaths, findClaudeMarkerEntry } from '../claude-transcript-files.js';
import { buildSessionMarker, isUsableMarker } from './marker.js';
import type { SessionIdLookup, SessionIdLookupContext } from './types.js';

function markedSession(path: string, marker: string, scan: 'head' | 'whole'): string | undefined {
  const entry = findClaudeMarkerEntry(path, marker, scan);
  if (!entry) return undefined;
  const id = entry.sessionId;
  if (typeof id === 'string' && id.length > 0) return id;
  return (path.replace(/^.*\//, '').replace(/\.jsonl$/, '') || undefined);
}

export function hasPinnedClaudeSession(adapterId: string, context: SessionIdLookupContext): boolean {
  return getCliProfile(adapterId)?.extensions?.nativeSession?.pinned(context) ?? false;
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
    const pinned = pinnedSessionUuid(sessionId);
    const pinnedPaths = claudePinnedTranscriptPaths(projectDirs, pinned);
    if (pinnedPaths.length > 0) {
      if (!requireMarker) return pinned;
      // Do not let unrelated newer files push the exact pinned transcript out
      // of the bounded scan. A conflicting pinned file must not be adopted,
      // and two proven copies cannot be told apart here.
      if (!isUsableMarker(sessionId)) return undefined;
      const marker = buildSessionMarker(sessionId);
      const proven = pinnedPaths.flatMap(path => markedSession(path, marker, 'whole') ?? []);
      return proven.length === 1 ? proven[0] : undefined;
    }

    if (!isUsableMarker(sessionId)) return undefined;

    // Scan path: find the transcript whose first user prompt carries our
    // marker. Newest first only bounds the work — the marker decides.
    const marker = buildSessionMarker(sessionId);
    for (const { path } of claudeMarkerCandidates(projectDirs)) {
      const found = markedSession(path, marker, 'head');
      if (found) return found;
    }
    return undefined;
  },
};
