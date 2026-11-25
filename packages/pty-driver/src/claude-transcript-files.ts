import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { byMtimeDesc, nativeTranscriptObjects, parseJsonlObjects, readHead, walkFiles } from './session-id/fs-scan.js';
import { userEntryMentionsMarker } from './transcript/claude-content.js';

export function claudePinnedTranscriptPaths(projectDirs: readonly string[], pinned: string): string[] {
  return pinned ? projectDirs.map(dir => join(dir, `${pinned}.jsonl`)).filter(path => existsSync(path)) : [];
}

/** Newest first bounds the fallback scan. The marker, not recency, proves ownership. */
export function claudeMarkerCandidates(projectDirs: readonly string[]) {
  return projectDirs.flatMap(dir => walkFiles(dir, { maxDepth: 0, accept: name => name.endsWith('.jsonl') }))
    .sort(byMtimeDesc)
    .slice(0, 40);
}

/** For an unpinned lookup the marker is in the first user prompt. A pinned fork
 * can carry the marker after inherited history, so its proof searches the whole file. */
export function findClaudeMarkerEntry(path: string, marker: string, scan: 'head' | 'whole'): Record<string, unknown> | undefined {
  const entries = scan === 'whole' ? nativeTranscriptObjects(path) : parseJsonlObjects(readHead(path, 256 * 1024));
  for (const entry of entries) if (userEntryMentionsMarker(entry, marker)) return entry;
}
