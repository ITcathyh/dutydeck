/**
 * Grok Build native session-id lookup.
 *
 * dockmux pins Grok's session id at spawn (`grok --session-id <uuid>`), so the
 * happy path is a directory-existence check, not a scan. Grok organises
 * sessions per working directory:
 *
 *   $GROK_HOME/sessions/<bucket>/<cliSessionId>/updates.jsonl
 *   $GROK_HOME/sessions/<bucket>/prompt_history.jsonl
 *
 * where `<bucket>` is `encodeURIComponent(cwd)` — or a slug+hash name with a
 * `.cwd` marker file when the encoded name would exceed 255 bytes.
 *
 * When the pinned id was refused (an existing session directory makes Grok
 * mint its own), the bucket's `prompt_history.jsonl` is the bridge: one
 * `{timestamp, session_id, prompt, is_bash}` line per submit, written at
 * submit time. The bucket is already cwd-scoped, and the marker inside
 * `prompt` is per-session unique, so a hit is unambiguous. Scanning runs
 * back-to-front so the newest submit naming this dockmux session wins.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { grokPromptHistoryPath, resolveGrokCwdBucketDir } from '../cli-paths.js';
import { readTail } from './fs-scan.js';
import { isUsableMarker } from './marker.js';
import type { SessionIdLookup, SessionIdLookupContext } from './types.js';

/** prompt_history.jsonl is per-cwd and small; a generous tail still bounds a
 *  pathological repo where every prompt is huge. */
const PROMPT_HISTORY_TAIL_BYTES = 4 * 1024 * 1024;

/** Scan a bucket's prompt_history.jsonl for the newest submit whose `prompt`
 *  carries the marker, and return that line's `session_id`. */
export function findGrokSessionIdInPromptHistory(
  promptHistoryPath: string,
  marker: string,
): string | undefined {
  const text = readTail(promptHistoryPath, PROMPT_HISTORY_TAIL_BYTES);
  if (!text) return undefined;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(marker)) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (typeof parsed?.prompt !== 'string' || !parsed.prompt.includes(marker)) continue;
    if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      return parsed.session_id;
    }
  }
  return undefined;
}

export const grokSessionIdLookup: SessionIdLookup = {
  adapterId: 'grok',

  resolve({ sessionId, cwd }: SessionIdLookupContext): string | undefined {
    const bucket = resolveGrokCwdBucketDir(cwd);
    // Fast path: dockmux pinned the id via --session-id and Grok accepted it
    // (the session directory exists under this cwd's bucket).
    if (sessionId && existsSync(join(bucket, sessionId))) return sessionId;
    if (!isUsableMarker(sessionId)) return undefined;
    return findGrokSessionIdInPromptHistory(grokPromptHistoryPath(cwd), sessionId);
  },
};
