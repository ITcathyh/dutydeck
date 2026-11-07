import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import type { HistoryTurnSummary } from '@dutydeck/shared';
import { readHistoryOutline, readHistoryTurns } from './event-history.js';
import { createRepositories } from './index.js';
import { migrations, runMigrations, withMigrationTransaction } from './migrations.js';
import { readHistoryOutline as readLegacyHistoryOutline } from '../tests/fixtures/event-history-v46.js';

// The v46 projection (tests/fixtures/event-history-v46.ts) is the behavioural reference: the outline is
// now read from the user-prompt index (migration 49) as a tail plus places, and ranges, with the
// covering index (migration 47) for per-range type filters. Every shape must equal the v46 projection.
const legacy = new URL('../tests/fixtures/event-history-v46.ts', import.meta.url);
const legacyStatement = (name: string) => {
  const match = new RegExp(`const ${name} = cachedStatement\\(sqlite, \`([\\s\\S]*?)\``).exec(readFileSync(legacy, 'utf8'));
  if (!match?.[1]) throw new Error(`statement ${name} not found`);
  return match[1];
};

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

it('matches the v46 history projection as a whole outline on random sessions', () => {
  const db = database();
  // Coverage is measured with the v46 statements, so it does not depend on how the outline is read now.
  const before = { boundaries: legacyStatement('boundaries'), unprompted: legacyStatement('unprompted'), parts: legacyStatement('parts') };
  let seed = 1;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const coverage = { multiTurn: 0, multiTerminal: 0, empty: 0, unprompted: 0, parts: 0 };
  try {
    for (let iteration = 0; iteration < 1500; iteration++) {
      const session = `s${iteration}`;
      generate(db, session, `x${iteration}`, random, iteration % 3 === 0);
      const boundaries = db.prepare(before.boundaries).all(session, session) as Array<{ first: number; last: number }>;
      for (const range of boundaries) if (db.prepare(before.parts).all(session, range.first, range.last).length) coverage.parts++;
      const outline = readHistoryOutline(db, session), reference = readLegacyHistoryOutline(db, session);
      expect(isDeepStrictEqual(outline, reference) && JSON.stringify(outline) === JSON.stringify(reference)).toBe(true);
      if (boundaries.length > 1) coverage.multiTurn++;
      if (outline.turns.length > 1) coverage.multiTerminal++;
      if (!boundaries.length) coverage.empty++;
      if ((db.prepare(before.unprompted).get(session, session) as { first: number | null }).first !== null) coverage.unprompted++;
    }
  } finally { db.close(); }
  for (const [name, value] of Object.entries(coverage)) expect(value, name).toBeGreaterThan(20);
});

let seed = 1;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]!;
// Tools that start at the same instant have no defined order in either projection.
const sortedTools = (outline: { turns: HistoryTurnSummary[] }) => { for (const turn of outline.turns) turn.activity?.tools.sort((a, b) => a[0] - b[0] || a[1] - b[1]); return outline; };
const directories: string[] = [];
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

/** Random prompts, steering, roles, tools, receipts, malformed rows, task states and pruned holes. */
function seedRandomSession(round: number) {
  // An in-memory database per session: the projections read the same tables, without a file and repository per round.
  const db = database();
  const tasks = ['ta', 'tb', 'tc', 'td', 'te'];
  // Odd rounds settle every task, so long completed prefixes and ranges inside them occur too.
  const insertTask = db.prepare("INSERT INTO tasks (id,session_id,prompt,status,created_at,updated_at) VALUES (?,'s','p',?,'','')");
  for (const id of tasks) insertTask.run(id, round % 2 ? pick(['completed', 'failed', 'cancelled', 'interrupted']) : pick(['completed', 'completed', 'completed', 'failed', 'cancelled', 'interrupted', 'running', 'queued', 'reconcile_required']));
  const insert = db.prepare('INSERT INTO events(id,session_id,sequence,type,timestamp,data,task_id,attempt_id) VALUES(?,?,?,?,?,?,?,?)');
  let sequence = 0;
  const count = 1 + Math.floor(random() * (round % 2 ? 150 : 60));
  for (let index = 0; index < count; index++) {
    // Every fourth session is contiguous; the rest have holes like pruned terminal output.
    sequence += round % 4 && random() < 0.1 ? 2 + Math.floor(random() * 3) : 1;
    const task = random() < (round % 2 ? 0.97 : 0.8) ? pick(tasks) : null;
    const attempt = random() < 0.7 ? `at-${task ?? 'x'}-${Math.floor(random() * 2)}` : null;
    const timestamp = new Date(1_700_000_000_000 + sequence * 1000 + Math.floor(random() * 5000)).toISOString();
    const kinds = ['user', 'user', 'steer', 'assistant', 'assistant', 'norole', 'tool_call', 'tool_result', 'tool_result', 'thinking', 'status', 'raw_terminal', 'task', 'invalid'];
    const kind = pick(round % 2 ? kinds : [...kinds, 'completed', 'error']);
    const text = random() < 0.05 ? 'L'.repeat(1500 + Math.floor(random() * 4000)) : `text ${index}`;
    const dataTask = random() < 0.5 ? task ?? pick(tasks) : undefined;
    let type = 'text', data: unknown;
    switch (kind) {
      case 'user': data = { role: 'user', text, ...(dataTask ? { taskId: dataTask } : {}) }; break;
      case 'steer': data = { role: 'user', text: `steer ${index}`, steering: true }; break;
      case 'assistant': data = { role: 'assistant', text, ...(random() < 0.2 ? { parts: [{ type: pick(['image', 'resource', 'resource_link', 'text']), uri: `file:///a${index}`, name: 'n', resource: { uri: `file:///r${index}` } }] } : {}) }; break;
      case 'norole': data = { text }; break;
      case 'tool_call': type = 'tool_call'; data = { id: `tool${Math.floor(random() * 8)}`, name: 'x', ...(random() < 0.3 ? { startedAt: timestamp } : {}) }; break;
      case 'tool_result': type = 'tool_result'; data = { id: random() < 0.8 ? `tool${Math.floor(random() * 8)}` : undefined, status: pick(['completed', 'failed']), output: random() < 0.2 ? { status: 'delivered', deliveryId: `d${index}`, fileCount: 2 } : 'out', ...(random() < 0.3 ? { completedAt: timestamp } : {}), ...(random() < 0.3 ? { parts: [{ type: 'resource_link', uri: `file:///t${index}`, name: 'f' }] } : {}) }; break;
      case 'thinking': type = 'thinking'; data = { text: 'hmm' }; break;
      case 'status': type = 'status'; data = { state: 'idle' }; break;
      case 'raw_terminal': type = 'raw_terminal'; data = { screen: 1 }; break;
      case 'completed': type = 'completed'; data = {}; break;
      case 'error': type = 'error'; data = { message: 'e' }; break;
      case 'task': type = 'task'; data = { task: { id: pick(tasks) } }; break;
      case 'invalid': type = pick(['text', 'tool_result']); data = undefined; break;
    }
    insert.run(`ev${round}_${sequence}`, 's', sequence, type, timestamp, data === undefined ? '{not json' : JSON.stringify(data), task, attempt);
  }
  return db;
}

it('reads the same outline, tail, places and ranges as the schema-46 projection on random sessions', async () => {
  let turns = 0;
  for (let round = 0; round < 200; round++) {
    seed = round + 7;
    const db = seedRandomSession(round);
    try {
      const expected = sortedTools(readLegacyHistoryOutline(db, 's'));
      expect(sortedTools(readHistoryOutline(db, 's'))).toEqual(expected);
      const tailSize = 1 + Math.floor(random() * 4);
      const tail = sortedTools(readHistoryOutline(db, 's', { tail: tailSize }));
      expect(tail).toEqual({ ...expected, turns: expected.turns.slice(-tailSize),
        places: expected.turns.map(turn => [turn.id, turn.firstSequence, turn.lastSequence, turn.taskId ?? null, turn.prompt.text.slice(0, 40)]) });
      if (expected.turns.length) {
        const from = Math.floor(random() * expected.turns.length), through = from + Math.floor(random() * (expected.turns.length - from));
        expect(sortedTools({ turns: readHistoryTurns(db, 's', expected.turns[from]!.firstSequence, expected.turns[through]!.lastSequence) }).turns).toEqual(expected.turns.slice(from, through + 1));
        // A range need not start or end on a turn boundary: only turns wholly inside it are returned.
        const start = expected.turns[from]!.firstSequence + 1, end = expected.turns[through]!.lastSequence + 3;
        expect(sortedTools({ turns: readHistoryTurns(db, 's', start, end) }).turns).toEqual(expected.turns.filter(turn => turn.firstSequence >= start && turn.lastSequence <= end));
      }
      turns += expected.turns.length;
    } finally { db.close(); }
    // Let the test worker report progress between sessions.
    await new Promise(resolve => setImmediate(resolve));
  }
  // The random sessions must actually produce completed turns to compare.
  expect(turns).toBeGreaterThan(1_000);
}, 300_000);

it('reads every outline statement through an index, never scanning or auto-indexing the events table', () => {
  const db = database();
  const prepare = db.prepare.bind(db), seen = new Set<string>();
  db.prepare = ((sql: string) => { seen.add(sql); return prepare(sql); }) as typeof db.prepare;
  try {
    const insert = prepare('INSERT INTO events (id,session_id,sequence,type,timestamp,data,task_id) VALUES (?,?,?,?,?,?,?)');
    insert.run('p1', 's', 1, 'text', '1', JSON.stringify({ role: 'user', text: 'one' }), 't');
    insert.run('c1', 's', 2, 'completed', '2', '{}', 't');
    insert.run('p2', 's', 4, 'text', '4', JSON.stringify({ role: 'user', text: 'two', parts: [{ type: 'image', uri: 'u' }] }), null);
    insert.run('o2', 's', 5, 'text', '5', JSON.stringify({ role: 'assistant', text: 'out', parts: [{ type: 'image', uri: 'u' }] }), null);
    insert.run('c2', 's', 6, 'completed', '6', '{}', null);
    insert.run('m', 's', 7, 'status', '7', JSON.stringify({ state: 'commands', availableCommands: [{ name: '/x' }] }), null);
    readHistoryOutline(db, 's'); readHistoryOutline(db, 's', { tail: 1 }); readHistoryTurns(db, 's', 1, 3);
    // Planning ignores parameter values, so NULL stands in for every placeholder.
    const plans = [...seen].map(sql => [sql, (prepare(`EXPLAIN QUERY PLAN ${sql.replace(/@\w+|\?/g, 'NULL')}`).all() as Array<{ detail: string }>).map(row => row.detail)] as const);
    const named = (text: string) => plans.filter(([sql]) => sql.includes(text)).flatMap(([, detail]) => detail).join('\n');
    expect(plans.length).toBeGreaterThan(5);
    for (const [sql, detail] of plans) {
      // Every events alias in these statements (events, e, b, o, a) is read by a search, not a scan.
      expect(detail.filter(line => /^SCAN (events|e|b|o|a)\b/.test(line)), sql).toEqual([]);
      expect(detail.filter(line => /^SEARCH (events|e|b|o|a) .*AUTOMATIC/.test(line)), sql).toEqual([]);
    }
    expect(named('json_extract(data,\'$.role\')=\'user\'')).toContain('events_user_text');
    expect(named('LIMIT 129')).toContain('events_session_seq_type');
    expect(named('WITH prompts AS')).toContain('events_session_seq_type');
    expect(named('availableCommands') ).toContain('events_session_status');
  } finally { db.close(); }
});

it.each([46, 47])('upgrades a schema-%i database with history: events stay byte-for-byte and the outline reads through both indexes', async from => {
  const directory = mkdtempSync(join(tmpdir(), `history-index-v${from}-`)); directories.push(directory);
  const path = join(directory, 'state.db');
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    withMigrationTransaction(db, () => { for (const migration of migrations.filter(item => item.version <= from)) { migration.up(db); db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(migration.version, '2026-11-06'); } });
    db.prepare("INSERT INTO sessions (id,agent_id,state,cwd,run_id,created_at,updated_at) VALUES ('s','agent','idle','/work','run','','')").run();
    db.prepare("INSERT INTO tasks (id,session_id,prompt,status,created_at,updated_at) VALUES ('t1','s','p','completed','',''),('t2','s','p','running','','')").run();
    db.prepare('INSERT INTO configs VALUES (?,?)').run('lark.inbox.cli_app.om_1', JSON.stringify({ appId: 'cli_app', event: { messageId: 'om_1', senderType: 'bot', content: '{}' }, state: 'ignored', receivedAt: '2026-11-05T00:00:00.000Z' }));
    const insert = db.prepare('INSERT INTO events (id,session_id,task_id,sequence,type,timestamp,data) VALUES (?,?,?,?,?,?,?)');
    insert.run('p1', 's', null, 1, 'text', '1', JSON.stringify({ role: 'user', text: 'first prompt', taskId: 't1' }));
    insert.run('a1', 's', 't1', 2, 'text', '2', JSON.stringify({ role: 'assistant', text: 'answer' }));
    insert.run('s1', 's', 't1', 3, 'text', '3', JSON.stringify({ role: 'user', text: 'steer', steering: true }));
    insert.run('bad', 's', 't1', 4, 'text', '4', '{broken');
    insert.run('p2', 's', 't1', 6, 'text', '6', JSON.stringify({ role: 'user', text: 'second prompt' }));
    insert.run('p3', 's', 't2', 7, 'text', '7', JSON.stringify({ role: 'user', text: 'still running' }));
    const before = { events: db.prepare('SELECT * FROM events ORDER BY sequence').all(), configs: db.prepare('SELECT * FROM configs ORDER BY key').all() };
    const indexes = () => db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('events','configs') ORDER BY name").pluck().all() as string[];
    expect(indexes().includes('events_session_seq_type')).toBe(from >= 47);
    expect(indexes()).not.toContain('events_user_text');
    // Reads name their indexes, so an unmigrated database cannot silently fall back to parsing every event.
    expect(() => readHistoryOutline(db, 's')).toThrow(from >= 47 ? /no such index: events_user_text/ : /no such index/);
    runMigrations(db);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all()).toEqual(migrations.map(migration => migration.version));
    expect(db.prepare('SELECT * FROM events ORDER BY sequence').all()).toEqual(before.events);
    expect(db.prepare('SELECT * FROM configs ORDER BY key').all()).toEqual(before.configs);
    expect(indexes()).toEqual(expect.arrayContaining(['events_session_seq_type', 'events_user_text', 'config_lark_inbox_state', 'config_lark_inbox_ignored']));
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    // Only parseable user messages enter the prompt index.
    expect(db.prepare(`SELECT id FROM events INDEXED BY events_user_text WHERE session_id='s' AND type='text' AND json_valid(data) AND json_extract(data,'$.role')='user' ORDER BY sequence`).pluck().all()).toEqual(['p1', 's1', 'p2', 'p3']);
    const expected = readLegacyHistoryOutline(db, 's');
    expect(expected.turns.map(turn => [turn.id, turn.firstSequence, turn.lastSequence])).toEqual([['p1', 1, 4], ['p2', 6, 6]]);
    expect(readHistoryOutline(db, 's')).toEqual(expected);
    expect(readHistoryOutline(db, 's', { tail: 1 })).toEqual({ ...expected, turns: expected.turns.slice(1), places: [['p1', 1, 4, 't1', 'first promptsteer'], ['p2', 6, 6, 't1', 'second prompt']] });
  } finally { db.close(); }
  // Opening the upgraded file again neither re-runs nor fails a migration.
  for (let open = 0; open < 2; open++) {
    const reopened = createRepositories(path);
    try { expect((await reopened.events.listHistoryOutline!('s')).turns.map(turn => turn.id)).toEqual(['p1', 'p2']); } finally { reopened.close(); }
  }
});
