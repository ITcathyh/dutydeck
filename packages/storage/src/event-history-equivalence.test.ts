import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import { readHistoryOutline } from './event-history.js';
import { runMigrations } from './migrations.js';
import { readHistoryOutline as readLegacyHistoryOutline } from '../tests/fixtures/event-history-v46.js';

// The v46 projection is the behavioural reference for the index-only rewrite (migration 47).
const statement = (file: URL, name: string) => {
  const match = new RegExp(`const ${name} = cachedStatement\\(sqlite, \`([\\s\\S]*?)\``).exec(readFileSync(file, 'utf8'));
  if (!match?.[1]) throw new Error(`statement ${name} not found`);
  return match[1];
};
const current = new URL('./event-history.ts', import.meta.url), legacy = new URL('../tests/fixtures/event-history-v46.ts', import.meta.url);
const sql = (file: URL) => ({ boundaries: statement(file, 'boundaries'), unprompted: statement(file, 'unprompted'), parts: statement(file, 'parts') });

function database() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function generate(db: Database.Database, session: string, other: string, random: () => number, settled: boolean) {
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const tasks = ['t1', 't2', 't3'].filter(() => random() < 0.8).map(id => `${session}-${id}`);
  const statuses = settled ? ['completed', 'failed', 'cancelled'] : ['completed', 'failed', 'cancelled', 'running', 'reconcile_required', 'queued', null];
  for (const id of tasks) {
    const status = pick(statuses);
    if (status) db.prepare("INSERT INTO tasks (id,session_id,prompt,status,created_at,updated_at) VALUES (?,?,'p',?,'','')").run(id, settled || random() < 0.9 ? session : other, status);
  }
  const insert = db.prepare('INSERT INTO events (id,session_id,sequence,type,timestamp,data,task_id,attempt_id) VALUES (?,?,?,?,?,?,?,?)');
  const shape = random();
  const count = shape < 0.05 ? 0 : Math.floor(random() * 40);
  const types = shape < 0.1 ? ['raw_terminal', 'status', 'tool_call', 'completed', 'error', 'task'] // never prompted
    : ['raw_terminal', 'raw_terminal', 'status', 'text', 'text', 'tool_call', 'tool_result', 'thinking', 'completed', 'completed', ...(settled ? [] : ['error']), 'task'];
  let sequence = Math.floor(random() * 3);
  for (let index = 0; index < count; index++) {
    sequence += random() < 0.15 ? 2 + Math.floor(random() * 3) : 1;
    const type = pick(types);
    let data: unknown;
    if (type === 'text') data = { role: pick(['user', 'user', 'assistant', undefined]), text: 'p'.repeat(Math.floor(random() * 1500)), ...(random() < 0.2 ? { steering: true } : {}),
      ...(random() < 0.3 && tasks.length ? { taskId: pick(tasks) } : {}), ...(random() < 0.2 ? { parts: [{ type: 'image', uri: `u${index}`, mimeType: 'image/png' }] } : {}) };
    else if (type === 'tool_call' || type === 'tool_result') data = { id: pick(['c1', 'c2', 'c3', undefined]), status: pick(['completed', 'failed']),
      ...(random() < 0.3 ? { startedAt: new Date(1e12 + random() * 1e6).toISOString() } : {}), ...(random() < 0.3 ? { output: { status: 'delivered', deliveryId: `d${index}`, fileCount: 1 } } : {}),
      ...(random() < 0.2 ? { parts: [{ type: 'resource_link', uri: `f${index}`, name: 'n' }] } : {}) };
    else if (type === 'status') data = random() < 0.2 ? { state: 'commands', availableCommands: [{ name: '/x', description: 'd' }] } : { state: 'idle' };
    else data = { text: 'x' };
    const raw = random() < 0.05 ? '{bad json' : JSON.stringify(data);
    const timestamp = new Date(1e12 + (random() < 0.1 ? -1 : 1) * sequence * 1000 + Math.floor(random() * 500)).toISOString();
    // Settled sessions keep every turn terminal so that several consecutive turns reach the outline.
    const task = settled ? (tasks.length ? pick(tasks) : null) : random() < 0.6 ? pick([...tasks, `${session}-missing`]) : null;
    insert.run(`${session}-e${index}`, session, sequence, type, timestamp, raw, task, random() < 0.5 ? pick(['a1', 'a2']) : null);
    if (random() < 0.1) insert.run(`${other}-e${index}`, other, sequence, type, timestamp, raw, task, null);
  }
}

it('matches the v46 history projection row by row and as a whole outline on random sessions', () => {
  const db = database();
  const [now, before] = [sql(current), sql(legacy)];
  let seed = 1;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const coverage = { multiTurn: 0, multiTerminal: 0, empty: 0, unprompted: 0, parts: 0 };
  try {
    for (let iteration = 0; iteration < 1500; iteration++) {
      const session = `s${iteration}`;
      generate(db, session, `x${iteration}`, random, iteration % 3 === 0);
      const boundaries = db.prepare(now.boundaries).all({ s: session }) as Array<{ first: number; last: number }>;
      // The v46 rows also carried their internal turn number, which the projection never read.
      expect(boundaries).toEqual((db.prepare(before.boundaries).all(session, session) as Array<{ turn: number }>).map(({ turn: _turn, ...row }) => row));
      expect(db.prepare(now.unprompted).get(session, session)).toEqual(db.prepare(before.unprompted).get(session, session));
      for (const range of boundaries) {
        const parts = db.prepare(now.parts).all(session, range.first, range.last);
        expect(parts).toEqual(db.prepare(before.parts).all(session, range.first, range.last));
        if (parts.length) coverage.parts++;
      }
      const outline = readHistoryOutline(db, session), reference = readLegacyHistoryOutline(db, session);
      expect(isDeepStrictEqual(outline, reference) && JSON.stringify(outline) === JSON.stringify(reference)).toBe(true);
      if (boundaries.length > 1) coverage.multiTurn++;
      if (outline.turns.length > 1) coverage.multiTerminal++;
      if (!boundaries.length) coverage.empty++;
      if ((db.prepare(now.unprompted).get(session, session) as { first: number | null }).first !== null) coverage.unprompted++;
    }
  } finally { db.close(); }
  for (const [name, value] of Object.entries(coverage)) expect(value, name).toBeGreaterThan(20);
});

it('reads the history outline through the covering index without automatic indexes', () => {
  const db = database();
  const plan = (text: string, ...parameters: unknown[]) => JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...parameters));
  const { boundaries, unprompted, parts } = sql(current);
  try {
    expect(plan(boundaries, { s: 's' })).toContain('events_session_seq_type');
    expect(plan(boundaries, { s: 's' })).not.toContain('AUTOMATIC');
    expect(plan(parts, 's', 1, 2)).toContain('events_session_seq_type');
    expect(plan(unprompted, 's', 's')).toContain('events_session_seq_type');
    expect(plan(unprompted, 's', 's')).not.toContain('AUTOMATIC');
    const command = /cachedStatement\(sqlite, `(SELECT id,sequence,json_array_length[\s\S]*?)`\)/.exec(readFileSync(current, 'utf8'))![1]!;
    expect(plan(command, 's')).toContain('events_session_status');
  } finally { db.close(); }
});
