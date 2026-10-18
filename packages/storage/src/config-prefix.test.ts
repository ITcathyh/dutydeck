import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from './index.js';
import type { RepositoryBundle } from '@dutydeck/shared';

const opened: Array<RepositoryBundle | Database.Database> = [];
afterEach(() => { vi.restoreAllMocks(); for (const item of opened.splice(0)) item.close(); });

it('preserves SQLite prefix semantics and binary order at Unicode and NUL boundaries', async () => {
  const repos = createRepositories(':memory:'); opened.push(repos);
  const reference = new Database(':memory:'); opened.push(reference);
  reference.exec('CREATE TABLE configs(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const keys = ['', 'A', 'a', 'aa', 'a%', 'a_', 'a%tail', 'a_tail', 'ab', 'a\0', 'a\0tail', '\0', '\0tail',
    '中文', '中文后', '中午', '😀', '😀尾', '😁', '\ud7ff', '\ud7ff尾', '\ue000', '\uffff', '\uffff😀',
    '\u{10000}', '\u{10ffff}', '\u{10ffff}尾', '\u{10ffff}\u{10ffff}', '\u{10ffff}\u{10ffff}尾', 'a\u{10ffff}', 'a\u{10ffff}尾', '\ufffd'];
  for (const [index, key] of keys.entries()) {
    await repos.config.set(key, String(index));
    reference.prepare('INSERT INTO configs VALUES (?,?)').run(key, String(index));
  }
  for (const prefix of [...keys, 'missing', 'a\0suffix', '\ud800', '\udfff']) {
    expect(await repos.config.list(prefix), JSON.stringify(prefix)).toEqual(reference.prepare('SELECT key, value FROM configs WHERE substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, prefix));
  }
  expect((await repos.config.list('a%')).map(row => row.key)).toEqual(['a%', 'a%tail']);
  expect((await repos.config.list('😀')).map(row => row.key)).toEqual(['😀', '😀尾']);
});

it('seeks a small prefix without evaluating unrelated config namespaces', async () => {
  const repos = createRepositories(':memory:'); opened.push(repos);
  for (let index = 0; index < 10_000; index++) await repos.config.set(`unrelated.${index}`, 'history');
  for (const key of ['relay.ask.1', 'relay.ask.2', 'relay.ask.3']) await repos.config.set(key, 'ask');
  const prepare = Database.prototype.prepare;
  let visits = 0;
  let plan: unknown[] = [];
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql);
    if (/SELECT key, value FROM configs/.test(sql)) {
      // Count the actual residual predicate evaluations, not elapsed time.
      this.function('substr', (key: string, start: number, length: number) => {
        visits++;
        return Array.from(key.split('\0')[0]).slice(start - 1, start - 1 + length).join('');
      });
      const all = statement.all.bind(statement);
      vi.spyOn(statement, 'all').mockImplementation((...params: unknown[]) => {
        plan = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...params);
        return all(...params);
      });
    }
    return statement;
  });
  expect((await repos.config.list('relay.ask.')).map(row => row.key)).toEqual(['relay.ask.1', 'relay.ask.2', 'relay.ask.3']);
  expect({ plan, visits }).toMatchObject({ plan: [expect.objectContaining({ detail: expect.stringMatching(/SEARCH configs USING INDEX .*key>\? AND key<\?/) })], visits: 3 });
});
