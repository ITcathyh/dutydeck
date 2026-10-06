import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  INSIGHT_INSTANCE_ID_CONFIG_KEY,
  canonicalizeDataRoot,
  createTranscriptSourceKeys
} from './session-insight-source.js';

describe('createTranscriptSourceKeys', () => {
  const expectedHash = (parts: unknown[]): string =>
    createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');

  it('derives sourceSessionKey/sourceKey without paths beyond dataRoot and pins main agentId to null', () => {
    const keys = createTranscriptSourceKeys('inst-1', 'codex', '/data/home/x/.codex', 'native-session')!;
    expect(keys).toBeTruthy();
    expect(keys.sourceSessionKey).toBe(
      expectedHash(['session-insight-v1', 'inst-1', 'codex', '/data/home/x/.codex', 'native-session'])
    );
    expect(keys.sourceKey).toBe(expectedHash([keys.sourceSessionKey, 'main', null]));
  });

  it('distinguishes subagent streams by nativeAgentId while sharing the session key', () => {
    const main = createTranscriptSourceKeys('inst', 'claude', '/root/.claude', 'sess')!;
    const sub = createTranscriptSourceKeys('inst', 'claude', '/root/.claude', 'sess', {
      kind: 'subagent',
      nativeAgentId: 'worker-a'
    })!;
    expect(sub.sourceSessionKey).toBe(main.sourceSessionKey);
    expect(sub.sourceKey).toBe(expectedHash([main.sourceSessionKey, 'subagent', 'worker-a']));
    expect(sub.sourceKey).not.toBe(main.sourceKey);
  });

  it('treats an absent streamIdentity as main and defaults malformed subagent to main(null)', () => {
    const implicit = createTranscriptSourceKeys('i', 'traex', '/r', 'n')!;
    const explicit = createTranscriptSourceKeys('i', 'traex', '/r', 'n', { kind: 'main', nativeAgentId: null })!;
    expect(implicit.sourceKey).toBe(explicit.sourceKey);
  });

  it('returns null until a full native identity exists, so unbound records carry no key', () => {
    expect(createTranscriptSourceKeys('i', 'codex', '/r', null)).toBeNull();
    expect(createTranscriptSourceKeys('i', 'codex', '/r', '')).toBeNull();
    expect(createTranscriptSourceKeys('i', 'codex', '/r', '   ')).toBeNull();
  });

  it('is stable across recomputation and changes with instance/root/native id', () => {
    const a = createTranscriptSourceKeys('i', 'codex', '/r', 'n')!;
    const b = createTranscriptSourceKeys('i', 'codex', '/r', 'n')!;
    expect(a).toEqual(b);
    expect(createTranscriptSourceKeys('i2', 'codex', '/r', 'n')!.sourceSessionKey).not.toBe(a.sourceSessionKey);
    expect(createTranscriptSourceKeys('i', 'codex', '/r2', 'n')!.sourceSessionKey).not.toBe(a.sourceSessionKey);
    expect(createTranscriptSourceKeys('i', 'codex', '/r', 'n2')!.sourceSessionKey).not.toBe(a.sourceSessionKey);
  });

  it('emits a 64-char hex digest only', () => {
    const keys = createTranscriptSourceKeys('i', 'claude', '/r', 'n')!;
    for (const value of Object.values(keys)) expect(value).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('canonicalizeDataRoot', () => {
  it('resolves a symlinked HOME (an existing data root) to the real path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'insight-root-'));
    try {
      const real = join(dir, 'actual-home');
      const link = join(dir, 'linked-home');
      await mkdir(join(real, '.codex'), { recursive: true });
      await symlink(real, link);
      const canonical = await canonicalizeDataRoot(join(link, '.codex'));
      expect(canonical).toBe(join(await realpath(real), '.codex'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to lexical resolve when the path does not exist', async () => {
    const canonical = await canonicalizeDataRoot('/tmp/insight-does-not-exist-xyz/sub/../root');
    expect(canonical).toBe('/tmp/insight-does-not-exist-xyz/root');
  });
});

describe('INSIGHT_INSTANCE_ID_CONFIG_KEY', () => {
  it('is the fixed snake_case configs key resolver and runtime share', () => {
    expect(INSIGHT_INSTANCE_ID_CONFIG_KEY).toBe('insight.instance_id');
  });
});
