import { basename } from 'node:path';
import { parseJsonlObjects, readHead, walkFiles } from '../session-id/fs-scan.js';

/** Thread id precedes the optional first-turn suffix; the final UUID alone
 * identifies a turn in resumed TraeX files. Metadata must agree with it. */
export function traexSegments(root: string, threadId: string): string[] {
  return walkFiles(root, { maxDepth: 3, accept: name => name.startsWith('rollout-') && name.endsWith('.jsonl') })
    .filter(candidate => {
      const suffix = basename(candidate.path).slice('rollout-'.length);
      if (!suffix.endsWith(`-${threadId}.jsonl`) && !suffix.includes(`-${threadId}_`)) return false;
      const meta = parseJsonlObjects(readHead(candidate.path, 256 * 1024)).find(entry => entry?.type === 'session_meta');
      return (meta?.payload?.id ?? meta?.payload?.session_id) === threadId;
    })
    .map(candidate => candidate.path)
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

export function nextTraexSegment(root: string, threadId: string, current?: string): string | undefined {
  const segments = traexSegments(root, threadId);
  if (!current) return segments.at(-1);
  const index = segments.indexOf(current);
  return index < 0 ? undefined : segments[index + 1] ?? current;
}
