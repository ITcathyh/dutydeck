import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createSessionInsightSchema } from './session-insight-migration.js';
import { createSessionInsightRepository } from './session-insight.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function harness() {
  let sumQueries = 0;
  const db = new Database(':memory:', { verbose(sql) { if (sql.includes('SUM(payload_bytes)')) sumQueries++; } });
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY)');
  createSessionInsightSchema(db);
  const repo = createSessionInsightRepository(db, {} as Parameters<typeof createSessionInsightRepository>[1]);
  const add = (id: string, session: string, time: string, bytes: number, current = false) => {
    db.prepare('INSERT OR IGNORE INTO sessions VALUES (?)').run(session);
    db.prepare(`INSERT INTO insight_snapshots(snapshot_id,session_id,cache_key,schema_version,engine_version,parser_version,metric_version,redaction_version,summary_json,manifest_json,host_evidence_json,payload_bytes,created_at)
      VALUES (?,?,?,1,'1','1','1','1','{}','{}','{}',?,?)`).run(id, session, id.padEnd(64, 'x'), bytes, time);
    db.prepare("INSERT INTO insight_events(snapshot_id,ordinal,event_id,kind,event_json) VALUES (?,0,?,'message','{}')").run(id, `event-${id}`);
    db.prepare("INSERT OR IGNORE INTO insight_refresh(session_id,state) VALUES (?,'succeeded')").run(session);
    if (current) db.prepare('UPDATE insight_refresh SET current_snapshot_id=? WHERE session_id=?').run(id, session);
  };
  const records = () => ['insight_snapshots', 'insight_events', 'insight_refresh'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { db, repo, add, records, sums: () => sumQueries };
}

it('keeps per-session, old-cache and current eviction order, exact statistics and 410 tombstones with two SUMs', () => {
  const h = harness();
  // The older cache-hit current must survive the per-session stage even though both old caches are newer.
  h.add('a-current', 'a', '0', 10, true);
  h.add('a-drop', 'a', '1', 20);
  h.add('a-keep', 'a', '4', 30);
  h.add('b-old', 'b', '2', 40);
  h.add('b-current', 'b', '3', 50, true);
  h.add('c-current-a', 'c', '5', 60, true);
  h.add('d-current-b', 'd', '5', 70, true);
  expect(h.repo.prune(Infinity)).toEqual({ prunedSnapshotsCount: 1, freedBytes: 20, retainedSnapshotsCount: 6, totalPayloadBytes: 260 });
  expect(h.db.prepare("SELECT snapshot_id FROM insight_snapshots WHERE session_id='a' AND tombstoned=0 ORDER BY snapshot_id").pluck().all()).toEqual(['a-current', 'a-keep']);
  const sumsBeforeGlobal = h.sums();
  expect(h.repo.prune(70)).toEqual({ prunedSnapshotsCount: 5, freedBytes: 190, retainedSnapshotsCount: 1, totalPayloadBytes: 70 });
  expect(h.sums() - sumsBeforeGlobal).toBe(2);
  expect(h.db.prepare('SELECT snapshot_id FROM insight_snapshots WHERE tombstoned=0').pluck().all()).toEqual(['d-current-b']);
  expect(h.db.prepare('SELECT current_snapshot_id FROM insight_refresh ORDER BY session_id').pluck().all()).toEqual([null, null, null, 'd-current-b']);
  expect(h.db.prepare('SELECT snapshot_id FROM insight_events').pluck().all()).toEqual(['d-current-b']);
  expect(h.db.prepare('SELECT summary_json,manifest_json,host_evidence_json,payload_bytes FROM insight_snapshots WHERE tombstoned=1').all()).toEqual(Array.from({ length: 6 }, () => ({ summary_json: null, manifest_json: null, host_evidence_json: null, payload_bytes: 0 })));
  expect(() => h.repo.getSnapshot('a', 'a-current')).toThrow(expect.objectContaining({ code: 'INSIGHT_SNAPSHOT_GONE', statusCode: 410 }));
  expect(h.repo.prune(70)).toEqual({ prunedSnapshotsCount: 0, freedBytes: 0, retainedSnapshotsCount: 1, totalPayloadBytes: 70 });
});

it('rolls back every eviction, event deletion and pointer clear if a later tombstone fails', () => {
  const h = harness();
  h.add('old-cache', 'a', '0', 20);
  h.add('old-current', 'a', '1', 30, true);
  h.add('new-current', 'b', '2', 40, true);
  h.db.exec("CREATE TRIGGER abort_retention BEFORE UPDATE ON insight_snapshots WHEN NEW.snapshot_id='old-current' AND NEW.tombstoned=1 BEGIN SELECT RAISE(ABORT,'retention failure'); END");
  const before = h.records();
  expect(() => h.repo.prune(40)).toThrow('retention failure');
  expect(h.records()).toEqual(before);
  h.db.exec('DROP TRIGGER abort_retention');
  expect(h.repo.prune(40)).toEqual({ prunedSnapshotsCount: 2, freedBytes: 50, retainedSnapshotsCount: 1, totalPayloadBytes: 40 });
});

it.each([
  [0, 0, 0], [-1, 0, 0], [-Infinity, 0, 0], [19.5, 1, 10], [20, 2, 20], [Infinity, 2, 20], [NaN, 2, 20]
])('preserves existing budget comparison semantics for %s', (budget, retained, total) => {
  const h = harness();
  h.add('older', 'a', '0', 10, true);
  h.add('newer', 'b', '1', 10, true);
  expect(h.repo.prune(budget)).toEqual({ prunedSnapshotsCount: 2 - retained, freedBytes: 20 - total, retainedSnapshotsCount: retained, totalPayloadBytes: total });
});

it('handles empty databases and zero-byte snapshots without changing zero-budget behavior', () => {
  const h = harness();
  expect(h.repo.prune(0)).toEqual({ prunedSnapshotsCount: 0, freedBytes: 0, retainedSnapshotsCount: 0, totalPayloadBytes: 0 });
  h.add('zero', 'a', '0', 0, true);
  expect(h.repo.prune(0)).toEqual({ prunedSnapshotsCount: 0, freedBytes: 0, retainedSnapshotsCount: 1, totalPayloadBytes: 0 });
  expect(h.repo.prune(-1)).toEqual({ prunedSnapshotsCount: 1, freedBytes: 0, retainedSnapshotsCount: 0, totalPayloadBytes: 0 });
});
