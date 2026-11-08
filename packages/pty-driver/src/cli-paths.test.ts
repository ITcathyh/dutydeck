import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { claudeProjectDir, claudeProjectDirCandidates, claudeProjectKey } from './cli-paths.js';
// Untyped synthetic child-process fixture; importing it does not start the fake CLI.
import { projectKey as fixtureProjectKey } from './fixtures/claude-native-session.mjs';

const a = (count: number) => 'a'.repeat(count);
const legacy = (path: string) => path.replace(/[^A-Za-z0-9-]/g, '-');

// Published vectors for Claude Code's long-key rule (also matched by a real
// Claude Code 2.1.318 run, which wrote exactly the key claudeProjectKey gives).
const vectors: Array<[string, string]> = [
  ['/' + a(199), '-' + a(199)],
  ['/' + a(200), '-' + a(199) + '-b6ymvl'],
  ['/' + a(199) + '😀', '-' + a(199) + '-86sic5'],
  // The hash lands on -2^31: Math.abs must not wrap to a negative.
  ['/' + a(203) + 'Gjox13', '-' + a(199) + '-zik0zk'],
  ['/tmp/café/😀', '-tmp-caf----'],
];

describe('claudeProjectKey', () => {
  it.each(vectors)('encodes %j', (path, key) => {
    expect(claudeProjectKey(path)).toBe(key);
  });

  it('is byte-identical to the legacy encoding up to 200 units', () => {
    for (const path of ['/', '/repo', '/data/my-repo_v2.0', '/tmp/café/😀', '/' + a(199), '/x-y/' + 'é'.repeat(195)]) {
      expect(path.replace(/[^A-Za-z0-9]/g, '-').length).toBeLessThanOrEqual(200);
      expect(claudeProjectKey(path)).toBe(legacy(path));
    }
  });

  it('matches the inline copy in the synthetic Claude fixture', () => {
    const extra = ['/repo', '/' + a(201), '/' + 'é'.repeat(300), '/w/' + '😀'.repeat(120), '/' + a(1000) + '/z'];
    for (const path of [...vectors.map(([path]) => path), ...extra]) expect(fixtureProjectKey(path)).toBe(claudeProjectKey(path));
  });
});

describe('claudeProjectDirCandidates', () => {
  const env = { CLAUDE_CONFIG_DIR: '/claude-root' };

  it('has one entry, equal to claudeProjectDir, for a short cwd', () => {
    expect(claudeProjectDirCandidates('/repo', env)).toEqual([claudeProjectDir('/repo', env)]);
    expect(claudeProjectDir('/repo', env)).toBe('/claude-root/projects/-repo');
  });

  it('lists the current key first and the untruncated legacy key second for a long cwd', () => {
    const cwd = '/' + a(250);
    const candidates = claudeProjectDirCandidates(cwd, env);
    expect(candidates).toEqual([join('/claude-root/projects', claudeProjectKey(cwd)), join('/claude-root/projects', legacy(cwd))]);
    expect(candidates[0]).toBe(claudeProjectDir(cwd, env));
    expect(candidates[0]).toMatch(/-[0-9a-z]+$/);
  });
});
