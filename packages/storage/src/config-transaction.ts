import type Database from 'better-sqlite3';
import { RuntimeError, type RepositoryBundle } from '@dutydeck/shared';
import { createConfigReader } from './config-reader.js';
import { assertRepositoryConfigWrite } from './config-write.js';
import { isThenable } from './foundation-errors.js';
import { cachedStatement } from './statement-cache.js';

export function createConfigTransaction(db: Database.Database): RepositoryBundle['transaction'] {
  const reader = createConfigReader(db);
  return work => db.transaction(() => {
    let active = true;
    const check = () => { if (!active) throw new Error('Config transaction has ended'); };
    try {
      const result = work({ config: {
        get(key) { check(); return reader.get(key); },
        set(key, value) {
          check();
          assertRepositoryConfigWrite(db, key, value);
          cachedStatement(db, 'INSERT INTO configs(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
        }
      } });
      if (isThenable(result)) throw new RuntimeError('FOUNDATION_ASYNC_TRANSACTION_UNSUPPORTED', 'Group policy transactions must be synchronous', 400);
      return result;
    } finally { active = false; }
  }).immediate();
}
