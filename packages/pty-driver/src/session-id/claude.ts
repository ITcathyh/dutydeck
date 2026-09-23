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
import { claudeProjectDir } from '../cli-paths.js';
import { byMtimeDesc, parseJsonlObjects, readHead, walkFiles } from './fs-scan.js';
import { buildSessionMarker, isUsableMarker } from './marker.js';
import type { SessionIdLookup, SessionIdLookupContext } from './types.js';

/** Head window per candidate transcript. The marker rides the FIRST user
 *  prompt, so a small head window is enough and keeps a long conversation
 *  from being read in full. */
const HEAD_BYTES = 256 * 1024;
/** Newest-first cap on candidates scanned in one project dir. */
const MAX_CANDIDATES = 40;

/** The UUID dutydeck pinned via --session-id; Claude's own ids are bare UUIDs. */
function bareId(sessionId: string): string {
  return pinnedSessionUuid(sessionId);
}

/** Does an entry's text content mention the marker? Handles both the string
 *  and the content-block array form of `message.content`. */
function entryMentions(entry: any, needle: string): boolean {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.includes(needle);
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string'
      && block.text.includes(needle)) return true;
  }
  return false;
}

/** The CLI session id recorded inside a transcript entry, if any. */
function entrySessionId(entry: any): string | undefined {
  const id = entry?.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function markedSession(path: string, sessionId: string, requireMarker: boolean): string | undefined {
  for (const entry of parseJsonlObjects(readHead(path, HEAD_BYTES))) {
    if (entry?.isSidechain === true) continue;
    if (requireMarker && (entry?.type !== 'user' || entry?.message?.role !== 'user')) continue;
    if (!entryMentions(entry, requireMarker ? buildSessionMarker(sessionId) : sessionId)) continue;
    return entrySessionId(entry) ?? (path.replace(/^.*\//, '').replace(/\.jsonl$/, '') || undefined);
  }
  return undefined;
}

/** A pinned native id may not be reused for a fresh launch, even when its marker is unreadable. */
export function hasPinnedClaudeSession(adapterId: string, { sessionId, cwd, env }: SessionIdLookupContext): boolean {
  if (!claudeSessionIdLookup.adapterIds.includes(adapterId)) return false;
  try { lstatSync(join(claudeProjectDir(cwd, env), `${bareId(sessionId)}.jsonl`)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

export const claudeSessionIdLookup: SessionIdLookup = {
  // Claude Code plus its two forks: same per-project JSONL layout, same
  // `sessionId`-per-entry field, same filename-is-the-session-id rule. Only
  // the root differs, and that arrives with `ctx.env` (the fork's own
  // CLAUDE_CONFIG_DIR must be set through `agent.env`).
  adapterIds: ['claude-code', 'seed', 'relay'],

  resolve({ sessionId, cwd, env, requireMarker }: SessionIdLookupContext): string | undefined {
    const projectDir = claudeProjectDir(cwd, env);

    // Fast path: dutydeck pinned the id via --session-id and Claude accepted it.
    const pinned = bareId(sessionId);
    const pinnedPath = join(projectDir, `${pinned}.jsonl`);
    if (pinned && existsSync(pinnedPath)) {
      if (!requireMarker) return pinned;
      // Do not let unrelated newer files push the exact pinned transcript out
      // of the bounded scan. A conflicting pinned file must not be adopted.
      return isUsableMarker(sessionId) ? markedSession(pinnedPath, sessionId, true) : undefined;
    }

    if (!isUsableMarker(sessionId)) return undefined;

    // Scan path: find the transcript whose first user prompt carries our
    // marker. Newest first only bounds the work — the marker decides.
    const candidates = walkFiles(projectDir, {
      maxDepth: 0,
      accept: name => name.endsWith('.jsonl'),
    }).sort(byMtimeDesc).slice(0, MAX_CANDIDATES);

    for (const candidate of candidates) {
      const found = markedSession(candidate.path, sessionId, !!requireMarker);
      if (found) return found;
    }
    return undefined;
  },
};
