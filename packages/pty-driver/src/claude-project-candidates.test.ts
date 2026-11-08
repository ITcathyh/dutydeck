// Long working directories: Claude Code (>= 2.1.224) truncates the project key
// past 200 units and appends a hash, while sessions written before that (and
// `claude --resume` of them, verified on 2.1.318) stay under the untruncated
// key. Every reader must consider both dirs and choose by the session file.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedSessionUuid } from '@dutydeck/cli-adapters';
import type { DriverTranscriptSourceObservation } from '@dutydeck/shared';
import { CLAUDE_PROCESS_PROOF, claudeResumeFromObservation } from './claude-native-session.js';
import { claudeProjectDirCandidates } from './cli-paths.js';
import { claudeSessionIdLookup, hasPinnedClaudeSession } from './session-id/claude.js';
import { buildSessionMarker } from './session-id/marker.js';
import { resolveClaudeTranscriptPath } from './transcript/claude.js';
import { verifyLaunchedTranscript } from './transcript-source.js';

const sessionId = 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const pinned = pinnedSessionUuid(sessionId);
const otherId = '99999999-9999-4999-8999-999999999999';
type Layout = 'legacy' | 'current' | 'both';

let base: string, cwd: string, root: string, env: { CLAUDE_CONFIG_DIR: string }, current: string, legacy: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dd-claude-long-')));
  // Encoded length 201..255: past the truncation point, yet the legacy key
  // still fits one directory name (NAME_MAX) so legacy sessions can exist.
  cwd = join(base, 'w', 'x'.repeat(100), 'y'.repeat(225 - base.length - 104));
  mkdirSync(cwd, { recursive: true });
  root = join(base, 'claude'); env = { CLAUDE_CONFIG_DIR: root };
  [current, legacy] = claudeProjectDirCandidates(cwd, env) as [string, string];
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const record = (nativeId: string, content: string) => JSON.stringify({ type: 'user', sessionId: nativeId, cwd, uuid: nativeId + '-u', message: { role: 'user', content } }) + '\n';
function write(dir: string, nativeId: string, content = buildSessionMarker(sessionId) + ' hello'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${nativeId}.jsonl`);
  writeFileSync(path, record(nativeId, content));
  return path;
}
const dirsOf = (layout: Layout) => layout === 'both' ? [current, legacy] : [layout === 'current' ? current : legacy];
function observation(nativeId: string, verifiedPath: string): DriverTranscriptSourceObservation {
  const stat = lstatSync(verifiedPath);
  const proof = CLAUDE_PROCESS_PROOF + createHash('sha256').update(JSON.stringify([nativeId, verifiedPath, root, cwd, stat.dev, stat.ino])).digest('hex');
  return { observationId: 'obs', client: 'claude', launchKind: 'created', proofKind: 'launch_observed', capturedAt: new Date().toISOString(),
    dataRoot: root, cwd, nativeSessionId: nativeId, verifiedPath, identityProof: proof };
}

describe('Claude long cwd candidates', () => {
  it('really is a long cwd with two distinct candidate dirs', () => {
    expect(cwd.length).toBeGreaterThan(200);
    expect(legacy.length - root.length).toBeLessThan(255 + '/projects/'.length);
    expect(current).not.toBe(legacy);
  });

  describe.each<Layout>(['legacy', 'current', 'both'])('session file under %s', layout => {
    it('session-id lookup and pinned-session guard', () => {
      const paths = dirsOf(layout).map(dir => write(dir, pinned));
      expect(hasPinnedClaudeSession('claude-code', { sessionId, cwd, env })).toBe(true);
      expect(claudeSessionIdLookup.resolve({ sessionId, cwd, env, requireMarker: false })).toBe(pinned);
      // Two proven copies cannot be told apart without a durable verifiedPath.
      expect(claudeSessionIdLookup.resolve({ sessionId, cwd, env, requireMarker: true })).toBe(layout === 'both' ? undefined : pinned);
      // A pinned file whose content belongs to someone else is not adopted.
      for (const path of paths) writeFileSync(path, record(pinned, 'unrelated'));
      expect(claudeSessionIdLookup.resolve({ sessionId, cwd, env, requireMarker: true })).toBeUndefined();
    });

    it('transcript path: pinned file in one dir is followed, in both is not guessed', () => {
      const paths = dirsOf(layout).map(dir => write(dir, pinned));
      expect(resolveClaudeTranscriptPath(cwd, env, sessionId)).toBe(layout === 'both' ? undefined : paths[0]);
    });

    it('launch verification proves exactly one file and rejects duplicates', async () => {
      const paths = dirsOf(layout).map(dir => write(dir, pinned));
      const verified = await verifyLaunchedTranscript('claude', root, { sessionId, cwd });
      if (layout === 'both') expect(verified).toBeUndefined();
      else expect(verified).toMatchObject({ nativeSessionId: pinned, verifiedPath: paths[0] });
    });

    it('marker scan finds an unpinned native id, and conflicting ids stay ambiguous', async () => {
      const [first] = dirsOf(layout);
      const found = write(first!, otherId);
      expect(claudeSessionIdLookup.resolve({ sessionId, cwd, env })).toBe(otherId);
      expect(resolveClaudeTranscriptPath(cwd, env, sessionId)).toBe(found);
      expect(await verifyLaunchedTranscript('claude', root, { sessionId, cwd })).toMatchObject({ nativeSessionId: otherId, verifiedPath: found });
      // A second native id carrying the same marker in the other dir is a conflict.
      const conflictId = '88888888-8888-4888-8888-888888888888';
      write(first === current ? legacy : current, conflictId);
      expect(await verifyLaunchedTranscript('claude', root, { sessionId, cwd })).toBeUndefined();
    });

    it('no target session: nothing is found in either dir', async () => {
      for (const dir of dirsOf(layout)) write(dir, otherId, 'unrelated conversation');
      expect(hasPinnedClaudeSession('claude-code', { sessionId, cwd, env })).toBe(false);
      expect(claudeSessionIdLookup.resolve({ sessionId, cwd, env, requireMarker: true })).toBeUndefined();
      expect(resolveClaudeTranscriptPath(cwd, env, sessionId)).toBeUndefined();
      expect(await verifyLaunchedTranscript('claude', root, { sessionId, cwd })).toBeUndefined();
    });

    it('cold resume accepts the observation whose verifiedPath is a candidate', () => {
      const paths = dirsOf(layout).map(dir => write(dir, otherId));
      for (const path of paths) expect(claudeResumeFromObservation(observation(otherId, path), cwd, env)).toBe(otherId);
      // Proof bound to one candidate does not transfer to the other.
      if (layout === 'both') expect(claudeResumeFromObservation({ ...observation(otherId, paths[0]!), verifiedPath: paths[1]! }, cwd, env)).toBeUndefined();
      const outside = write(join(root, 'projects', 'elsewhere'), otherId);
      expect(claudeResumeFromObservation(observation(otherId, outside), cwd, env)).toBeUndefined();
    });
  });

  it('marker scan across dirs keeps newest-first order', () => {
    const older = write(legacy, otherId), newer = write(current, '77777777-7777-4777-8777-777777777777');
    utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(resolveClaudeTranscriptPath(cwd, env, sessionId)).toBe(newer);
    expect(resolveClaudeTranscriptPath(cwd, env)).toBe(newer);
  });
});
