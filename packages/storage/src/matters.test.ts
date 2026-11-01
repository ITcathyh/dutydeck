import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepositories } from './index.js';

describe('matter storage and schema 44', () => {
  it('upgrades existing data, reopens idempotently and preserves foreign keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dutydeck-matters-'));
    const file = join(dir, 'state.db');
    try {
      let repos = createRepositories(file);
      await repos.config.set('kept', 'old data'); repos.close();
      const old = new Database(file);
      old.exec('DROP TABLE matter_links; DROP TABLE matters; DELETE FROM schema_migrations WHERE version=44'); old.close();
      repos = createRepositories(file);
      expect(await repos.config.get('kept')).toBe('old data');
      const first = repos.matters!.ensureSession({ sessionId: 'source', title: '😀'.repeat(65) });
      expect(Array.from(first.title)).toHaveLength(60);
      const inherited = repos.matters!.ensureSession({ sessionId: 'fork', sourceSessionId: 'source', title: 'other', relation: 'fork' });
      expect(inherited.id).toBe(first.id);
      expect(repos.matters!.ensureSession({ sessionId: 'fork', title: 'again' }).id).toBe(first.id);
      expect(repos.matters!.links(first.id)).toHaveLength(2);
      expect(() => repos.matters!.link({ matterId: 'missing', kind: 'task', refId: 't', relation: 'created_in' })).toThrow();
      const separate = repos.matters!.ensureSession({ sessionId: 'plain-new', title: 'new matter' });
      expect(() => repos.matters!.link({ matterId: separate.id, kind: 'session', refId: 'fork', relation: 'fork' })).toThrow();
      repos.close(); repos = createRepositories(file);
      expect(repos.matters!.find('session', 'fork')?.id).toBe(first.id); repos.close();
      const check = new Database(file);
      expect(check.pragma('foreign_key_check')).toEqual([]);
      expect(check.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 44 }); check.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('creates the source before a derived session first receives a task', () => {
    const repos = createRepositories(':memory:');
    try {
      const derived = repos.matters!.ensureSession({ sessionId: 'derived', sourceSessionId: 'source', relation: 'handoff', title: 'first task' });
      expect(repos.matters!.find('session', 'source')?.id).toBe(derived.id);
      expect(repos.matters!.links(derived.id)).toEqual(expect.arrayContaining([expect.objectContaining({ refId: 'derived', relation: 'handoff' })]));
    } finally { repos.close(); }
  });
});
