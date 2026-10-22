import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseJsonlObjects, readHead, walkFiles } from '../session-id/fs-scan.js';

// Model catalogs made a real 0.207.1 first metadata record 353,510 bytes.
// The bound keeps per-poll probes of malformed rollouts cheap.
const METADATA_HEAD_BYTES = 1024 * 1024;
// A rollout keeps its identity once its metadata is complete, so polls skip rereads.
const verified = new Map<string, string>();

function hasThreadMetadata(path: string, threadId: string): boolean {
  let identity: string;
  try { const st = statSync(path); identity = `${st.dev}:${st.ino}:${threadId}`; } catch { return false; }
  if (verified.get(path) === identity) return true;
  const meta = parseJsonlObjects(readHead(path, METADATA_HEAD_BYTES)).find(entry => entry?.type === 'session_meta');
  if ((meta?.payload?.id ?? meta?.payload?.session_id) !== threadId) return false;
  if (verified.size >= 1000) verified.clear();
  verified.set(path, identity);
  return true;
}

/** Thread id precedes the optional first-turn suffix; the final UUID alone
 * identifies a turn in resumed TraeX files. Metadata must agree with it. */
export function traexSegments(root: string, threadId: string): string[] {
  return walkFiles(root, { maxDepth: 3, accept: name => {
    if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) return false;
    const suffix = name.slice('rollout-'.length);
    return suffix.endsWith(`-${threadId}.jsonl`) || suffix.includes(`-${threadId}_`);
  } })
    .filter(candidate => hasThreadMetadata(candidate.path, threadId))
    .map(candidate => candidate.path)
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

export function nextTraexSegment(root: string, threadId: string, current?: string): string | undefined {
  const segments = traexSegments(root, threadId);
  if (!current) return segments.at(-1);
  const index = segments.indexOf(current);
  return index < 0 ? undefined : segments[index + 1] ?? current;
}
