import type Database from 'better-sqlite3';

const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();
/** Reuses one prepared statement per connection and SQL text for checks run inside every write. */
export function cachedStatement(db: Database.Database, sql: string): Database.Statement {
  let byText = statements.get(db);
  if (!byText) statements.set(db, byText = new Map());
  let statement = byText.get(sql);
  if (!statement) byText.set(sql, statement = db.prepare(sql));
  return statement;
}
