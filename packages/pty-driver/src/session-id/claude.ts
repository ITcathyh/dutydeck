/**
 * Claude Code native session-id lookup.
 *
 * Claude writes one JSONL per session at
 *   <claudeDataDir>/projects/<projectKey>/<cliSessionId>.jsonl
 * and every entry carries a `sessionId` field, so the CLI's session id is
 * recoverable from either the filename or the file body.
 *
 * dockmux normally pins this id itself (`claude --session-id <uuid>`), so the
 * happy path needs no scan at all — the resolver first checks whether the
 * expected file exists and returns immediately. The scan only matters when
 * Claude declined the pinned id (a collision with an existing session makes
 * the CLI generate its own) or when the session was adopted rather than
 * spawned by us.
 *
 * The scan matches on the injected marker inside the first user prompt, NOT
 * on recency: several dockmux sessions can share a cwd, and picking the
 * newest jsonl among them would resume a sibling's conversation.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { claudeProjectDir } from '../cli-paths.js';
import { byMtimeDesc, parseJsonlObjects, readHead, walkFiles } from './fs-scan.js';
import { isUsableMarker } from './marker.js';
import type { SessionIdLookup, SessionIdLookupContext } from './types.js';

/** Head window per candidate transcript. The marker rides the FIRST user
 *  prompt, so a small head window is enough and keeps a long conversation
 *  from being read in full. */
const HEAD_BYTES = 256 * 1024;
/** Newest-first cap on candidates scanned in one project dir. */
const MAX_CANDIDATES = 40;

/** Strip the `ses_` prefix dockmux uses; Claude's own ids are bare UUIDs. */
function bareId(sessionId: string): string {
  return sessionId.replace(/^ses_/, '');
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

export const claudeSessionIdLookup: SessionIdLookup = {
  adapterId: 'claude-code',

  resolve({ sessionId, cwd }: SessionIdLookupContext): string | undefined {
    const projectDir = claudeProjectDir(cwd);

    // Fast path: dockmux pinned the id via --session-id and Claude accepted it.
    const pinned = bareId(sessionId);
    if (pinned && existsSync(join(projectDir, `${pinned}.jsonl`))) return pinned;

    if (!isUsableMarker(sessionId)) return undefined;

    // Scan path: find the transcript whose first user prompt carries our
    // marker. Newest first only bounds the work — the marker decides.
    const candidates = walkFiles(projectDir, {
      maxDepth: 0,
      accept: name => name.endsWith('.jsonl'),
    }).sort(byMtimeDesc).slice(0, MAX_CANDIDATES);

    for (const candidate of candidates) {
      const entries = parseJsonlObjects(readHead(candidate.path, HEAD_BYTES));
      for (const entry of entries) {
        if (entry?.isSidechain === true) continue;
        if (!entryMentions(entry, sessionId)) continue;
        // Prefer the id the CLI recorded in the entry; fall back to the
        // filename stem (Claude names the file after its session id).
        const fromEntry = entrySessionId(entry);
        if (fromEntry) return fromEntry;
        const stem = candidate.path.replace(/^.*\//, '').replace(/\.jsonl$/, '');
        return stem.length > 0 ? stem : undefined;
      }
    }
    return undefined;
  },
};
