import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { RuntimeError } from '@dutydeck/shared';
import type { DatabaseControl, RepositoryOpenOptions, RuntimeControlClaim } from '@dutydeck/shared';
import { needsMigration } from './migrations.js';
import { currentProcessIdentity, observeProcess, type ProcessIdentity } from './process-identity.js';

const PROTOCOL_VERSION = 1;
interface State { version: number; protocol: number; phase: string; maintenance: string | null; runtime: string | null; instance: string | null; generation: number; entity: string }
interface Access { id: string; identity: string }
function fail(code: string): never { throw new RuntimeError(code.split(':')[0]!, code, 409); }
export function canonicalDatabase(filename: string): string {
  const canonical = realpathSync(filename);
  const stat = statSync(canonical);
  if (!stat.isFile() || stat.nlink !== 1) fail('DATABASE_UNSAFE_FILE: database must be a regular file without hard links');
  return canonical;
}
export interface OpenControl extends DatabaseControl {
  needsRecovery(): boolean;
  beginUpgrade(): void;
  finishUpgrade(): void;
  validateClaim(db: Database.Database, claim: RuntimeControlClaim): { accessId: string; instanceId: string; generation: number };
  creationSource(db: Database.Database, claim: RuntimeControlClaim): { databaseEntity: string; creator: ProcessIdentity } | undefined;
  assertMaintenance(db: Database.Database): void;
  assertClosable(): void;
  close(): void;
}

/** Only short CAS transactions use this connection. OS reads and migrations run outside them. */
export function openDatabaseControl(filename: string, options: RepositoryOpenOptions): OpenControl {
  const accessId = randomUUID();
  const claims = new WeakMap<RuntimeControlClaim, { accessId: string; instanceId: string; generation: number }>();
  if (filename === ':memory:') {
    let closed = false; let current: string | undefined; let generation = 0; let maintenance = false;
    return {
      accessId, needsRecovery() { return false; },
      beginUpgrade() {
        if (closed) fail('DATABASE_CLOSED');
        if (current) fail('DATABASE_RUNTIME_STILL_ATTACHED');
        if (options.upgrade === 'never') fail('DATABASE_UPGRADE_REQUIRED');
        maintenance = true;
      },
      finishUpgrade() { maintenance = false; },
      assertMaintenance() { if (closed || !maintenance || current) fail('DATABASE_MAINTENANCE_REQUIRED'); },
      validateClaim(_db, claim) {
        const binding = claims.get(claim);
        if (!binding || closed || maintenance || current !== binding.instanceId || generation !== binding.generation) fail('DATABASE_RUNTIME_CLAIM_REVOKED');
        return { ...binding };
      },
      creationSource(business, claim) { this.validateClaim(business, claim); return undefined; },
      attachRuntime(instanceId) {
        if (closed) fail('DATABASE_CLOSED');
        if (maintenance) fail('DATABASE_MAINTENANCE');
        if (current) fail('DATABASE_RUNTIME_ALREADY_ATTACHED');
        current = instanceId; const claimGeneration = ++generation;
        const assertCurrent = () => { if (closed || current !== instanceId || generation !== claimGeneration) fail('DATABASE_RUNTIME_CLAIM_REVOKED'); };
        const claim = Object.freeze({ generation: claimGeneration, assertCurrent, release() { assertCurrent(); current = undefined; } });
        claims.set(claim, { accessId, instanceId, generation: claimGeneration });
        return claim;
      },
      assertClosable() { if (current) fail('DATABASE_RUNTIME_STILL_ATTACHED'); },
      close() { this.assertClosable(); closed = true; }
    };
  }
  const identity = currentProcessIdentity(); // Never inspect /proc while holding a SQLite write transaction.
  const stat = statSync(filename);
  const entity = `${stat.dev}:${stat.ino}`;
  const db = new Database(filename);
  let closed = false;
  let registered = false;
  function state() { return db.prepare('SELECT * FROM dutydeck_control WHERE id = 1').get() as State; }
  function update(next: State) {
    db.prepare('UPDATE dutydeck_control SET version = ?, phase = ?, maintenance = ?, runtime = ?, instance = ?, generation = ? WHERE id = 1').run(next.version + 1, next.phase, next.maintenance, next.runtime, next.instance, next.generation);
  }
  function mutate<T>(work: (next: State, access: Access[]) => T): T {
    if (closed) fail('DATABASE_CLOSED');
    for (let retry = 0; retry < 50; retry++) {
      const snapshot = state();
      if (snapshot.protocol !== PROTOCOL_VERSION) fail('DATABASE_CONTROL_VERSION_UNSUPPORTED');
      if (snapshot.entity !== entity) fail('DATABASE_IDENTITY_CHANGED: offline recovery required');
      const access = db.prepare('SELECT id, identity FROM dutydeck_access').all() as Access[];
      const dead = new Set(access.filter(row => {
        try { return observeProcess(JSON.parse(row.identity) as ProcessIdentity) === 'dead'; } catch { return false; }
      }).map(row => row.id));
      const result = db.transaction(() => {
        const next = state();
        if (next.version !== snapshot.version) return { retry: true as const };
        for (const id of dead) db.prepare('DELETE FROM dutydeck_access WHERE id = ?').run(id);
        if (next.runtime && dead.has(next.runtime)) { next.runtime = null; next.instance = null; }
        if (next.maintenance && dead.has(next.maintenance)) { next.maintenance = null; next.phase = 'recovery'; }
        const value = work(next, access.filter(row => !dead.has(row.id)));
        update(next);
        return { retry: false as const, value };
      }).immediate();
      if (!result.retry) return result.value;
    }
    return fail('DATABASE_CONTROL_CONTENDED');
  }
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS dutydeck_control (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, protocol INTEGER NOT NULL, phase TEXT NOT NULL, maintenance TEXT, runtime TEXT, instance TEXT, generation INTEGER NOT NULL, entity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dutydeck_access (id TEXT PRIMARY KEY, identity TEXT NOT NULL);`);
      db.prepare("INSERT OR IGNORE INTO dutydeck_control VALUES (1, 0, ?, 'idle', NULL, NULL, NULL, 0, ?)").run(PROTOCOL_VERSION, entity);
    }).immediate();
    mutate((next, access) => {
      if (next.phase === 'maintenance') fail('DATABASE_MAINTENANCE');
      if (next.phase === 'recovery') {
        if (options.upgrade === 'never' || access.length) fail('DATABASE_MAINTENANCE_RECOVERY_REQUIRED');
        next.phase = 'maintenance'; next.maintenance = accessId;
      }
      if (needsMigration(db)) {
        if (options.upgrade === 'never') fail('DATABASE_UPGRADE_REQUIRED');
        if (access.length) fail('DATABASE_UPGRADE_BUSY');
        next.phase = 'maintenance'; next.maintenance = accessId;
      }
      if (options.mode === 'runtime') {
        if (next.runtime) fail('DATABASE_RUNTIME_BUSY');
        next.runtime = accessId;
      }
      db.prepare('INSERT INTO dutydeck_access VALUES (?, ?)').run(accessId, JSON.stringify(identity));
    });
    registered = true;
  } catch (error) { db.close(); throw error; }
  return {
    accessId,
    needsRecovery() { return state().phase !== 'idle'; },
    beginUpgrade() {
      mutate((next, access) => {
        if (next.instance) fail('DATABASE_RUNTIME_STILL_ATTACHED');
        if (options.upgrade === 'never') fail('DATABASE_UPGRADE_REQUIRED');
        if (access.some(row => row.id !== accessId)) fail('DATABASE_UPGRADE_BUSY');
        if (next.maintenance && next.maintenance !== accessId) fail('DATABASE_MAINTENANCE');
        next.phase = 'maintenance'; next.maintenance = accessId;
      });
    },
    finishUpgrade() {
      mutate(next => {
        if (next.maintenance === accessId) { next.phase = 'idle'; next.maintenance = null; }
      });
    },
    assertMaintenance(business) {
      if (closed) fail('DATABASE_CLOSED');
      const current = business.prepare('SELECT * FROM dutydeck_control WHERE id = 1').get() as State;
      if (current.protocol !== PROTOCOL_VERSION || current.entity !== entity || current.phase !== 'maintenance' || current.maintenance !== accessId || current.instance) fail('DATABASE_MAINTENANCE_REQUIRED');
      if ((business.prepare('SELECT COUNT(*) AS n FROM dutydeck_access WHERE id != ?').get(accessId) as { n: number }).n) fail('DATABASE_UPGRADE_BUSY');
    },
    validateClaim(business, claim) {
      const binding = claims.get(claim);
      if (!binding || closed) fail('DATABASE_RUNTIME_CLAIM_REVOKED');
      // Called inside the business BEGIN IMMEDIATE; no cross-connection check/write gap.
      const current = business.prepare('SELECT * FROM dutydeck_control WHERE id = 1').get() as State;
      if (current.protocol !== PROTOCOL_VERSION || current.entity !== entity || current.phase !== 'idle'
        || current.runtime !== accessId || current.instance !== binding.instanceId || current.generation !== binding.generation
        || !business.prepare('SELECT 1 FROM dutydeck_access WHERE id = ?').get(accessId)) fail('DATABASE_RUNTIME_CLAIM_REVOKED');
      return { ...binding };
    },
    creationSource(business, claim) {
      this.validateClaim(business, claim);
      return { databaseEntity: entity, creator: { ...identity } };
    },
    attachRuntime(instanceId): RuntimeControlClaim {
      const generation = mutate(next => {
        if (next.phase !== 'idle') fail('DATABASE_MAINTENANCE');
        if (next.runtime && next.runtime !== accessId) fail('DATABASE_RUNTIME_BUSY');
        if (next.instance) fail('DATABASE_RUNTIME_ALREADY_ATTACHED');
        next.runtime = accessId; next.instance = instanceId;
        return ++next.generation;
      });
      const assertCurrent = () => {
        if (closed) fail('DATABASE_CLOSED');
        const current = state();
        if (current.runtime !== accessId || current.instance !== instanceId || current.generation !== generation || current.phase !== 'idle') fail('DATABASE_RUNTIME_CLAIM_REVOKED');
      };
      const claim = Object.freeze({ generation, assertCurrent, release() {
        mutate(next => {
          if (next.runtime !== accessId || next.instance !== instanceId || next.generation !== generation) fail('DATABASE_RUNTIME_CLAIM_REVOKED');
          next.instance = null;
        });
      } });
      claims.set(claim, { accessId, instanceId, generation });
      return claim;
    },
    assertClosable() {
      if (closed) return;
      const current = state();
      if (current.runtime === accessId && current.instance) fail('DATABASE_RUNTIME_STILL_ATTACHED');
    },
    close() {
      if (closed) return;
      this.assertClosable();
      if (registered) mutate(next => {
        if (next.runtime === accessId) { next.runtime = null; next.instance = null; }
        if (next.maintenance === accessId) { next.maintenance = null; next.phase = 'recovery'; }
        db.prepare('DELETE FROM dutydeck_access WHERE id = ?').run(accessId);
      });
      db.close(); closed = true; registered = false;
    }
  };
}
