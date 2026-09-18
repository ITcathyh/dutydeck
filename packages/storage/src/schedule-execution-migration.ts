import type Database from 'better-sqlite3';

/** Called by the outer migration transaction with foreign_keys disabled. */
export function createScheduleExecutionSchema(db: Database.Database): void {
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE name='schedule_definitions'").get() as { sql: string };
  if (definition.sql.includes("'enabled'")) return;
  if (db.pragma('foreign_keys', { simple: true }) !== 0) throw new Error('SCHEDULE_MIGRATION_REQUIRES_FOREIGN_KEYS_OFF');
  const rebuild = (name: string, transform: (sql: string) => string) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string };
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(name) as Array<{ sql: string }>;
    const columns = (db.pragma(`table_info(${name})`) as Array<{ name: string }>).map(column => `"${column.name}"`).join(',');
    db.exec(transform(row.sql).replace(new RegExp(`CREATE TABLE (?:"${name}"|${name})`), `CREATE TABLE ${name}_execution`));
    db.exec(`INSERT INTO ${name}_execution (${columns}) SELECT ${columns} FROM ${name}`);
    db.exec(`DROP TABLE ${name}`);
    db.exec(`ALTER TABLE ${name}_execution RENAME TO ${name}`);
    for (const index of indexes) db.exec(index.sql);
  };
  rebuild('schedule_definitions', sql => sql.replace("state IN ('staged', 'disabled')", "state IN ('staged', 'disabled', 'enabled')").replace("desired_executor_state = 'disabled'", "desired_executor_state IN ('disabled', 'enabled')"));
  rebuild('schedule_generations', sql => sql.replace("state = 'staged_disabled'", "state IN ('staged_disabled', 'enabled')"));
  rebuild('schedule_occurrences', sql => sql.replace("state IN ('planned', 'source_owned_pending', 'settled', 'suppressed')", "state IN ('planned', 'source_owned_pending', 'claimed', 'running', 'unknown', 'failed', 'settled', 'suppressed')"));
  db.exec('ALTER TABLE schedule_occurrences ADD COLUMN lease_key TEXT');
  db.exec('ALTER TABLE schedule_occurrences ADD COLUMN lease_fence_token INTEGER');
  db.exec('ALTER TABLE schedule_occurrences ADD COLUMN holder_id TEXT');
  db.exec('ALTER TABLE schedule_occurrences ADD COLUMN error TEXT');
}
