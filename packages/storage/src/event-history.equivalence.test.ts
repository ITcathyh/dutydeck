import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, it } from 'vitest';
import { extractEventArtifactReferences, isTerminalTaskStatus, type HistoryOutline, type HistoryTurnSummary } from '@dutydeck/shared';
import { createRepositories } from './index.js';
import { cachedStatement } from './database-control.js';
import { runMigrations } from './migrations.js';
import { HISTORY_ACTIVITY_LIMIT, HISTORY_OUTPUT_LIMIT, HISTORY_PROMPT_LIMIT, readHistoryOutline, readHistoryTurns } from './event-history.js';

// The outline is read from the user-prompt index, a tail plus places, and ranges. Every
// shape must equal what the schema-46 projection below returned for the same events.
type Boundary = { first: number; last: number; id: string; timestamp: string; taskId: string | null; attemptId: string | null; status: string | null; ended: number };

/** Schema-46 projection, frozen as the oracle: every turn summarized by one scan per field. */
function legacyHistoryOutline(sqlite: Database.Database, sessionId: string): HistoryOutline {
  return sqlite.transaction(() => projectHistoryOutline(sqlite, sessionId))();
}

function projectHistoryOutline(sqlite: Database.Database, sessionId: string): HistoryOutline {
  const highWaterMark = (cachedStatement(sqlite, 'SELECT COALESCE(MAX(sequence),0) AS value FROM events WHERE session_id=?').get(sessionId) as { value: number }).value;
  const boundaries = cachedStatement(sqlite, `
    WITH marked AS (
      SELECT id,sequence,timestamp,task_id,attempt_id,type,
        COALESCE(task_id,CASE WHEN json_valid(data) THEN json_extract(data,'$.taskId') END) AS owner,
        CASE WHEN type='text' AND json_valid(data) AND json_extract(data,'$.role')='user'
          AND json_type(data,'$.steering') IS NULL THEN 1 ELSE 0 END AS boundary
      FROM events WHERE session_id=?
    ), grouped AS (
      SELECT *,MAX(1,SUM(boundary) OVER (ORDER BY sequence)) AS turn FROM marked
    ), ranges AS (
      SELECT turn,MIN(sequence) AS first,MAX(sequence) AS last,MIN(timestamp) AS timestamp,
        MAX(type='completed') AS ended FROM grouped GROUP BY turn
    ), owned AS (
      SELECT r.*,
        COALESCE((SELECT owner FROM grouped g WHERE g.turn=r.turn AND boundary=1 ORDER BY sequence LIMIT 1),
          (SELECT task_id FROM grouped g WHERE g.turn=r.turn AND type IN ('text','thinking','tool_call','tool_result') AND task_id IS NOT NULL ORDER BY sequence LIMIT 1)) AS taskId,
        (SELECT attempt_id FROM grouped g WHERE g.turn=r.turn AND type!='task' AND attempt_id IS NOT NULL ORDER BY sequence LIMIT 1) AS attemptId,
        COALESCE((SELECT id FROM grouped g WHERE g.turn=r.turn AND boundary=1 ORDER BY sequence LIMIT 1),
          (SELECT id FROM grouped g WHERE g.turn=r.turn ORDER BY sequence LIMIT 1)) AS id
      FROM ranges r
    )
    SELECT r.*,t.status FROM owned r LEFT JOIN tasks t ON t.id=r.taskId AND t.session_id=? ORDER BY r.first
  `).all(sessionId, sessionId) as Boundary[];
  const text = cachedStatement(sqlite, `
    WITH pieces AS (
      SELECT sequence,length(json_extract(data,'$.text')) AS size
      FROM events WHERE session_id=? AND sequence BETWEEN ? AND ? AND type='text' AND json_valid(data)
        AND COALESCE(json_extract(data,'$.role'),'assistant')=?
    ), budgeted AS (
      SELECT *,COALESCE(SUM(size) OVER (ORDER BY sequence ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS used,
        SUM(size) OVER () AS total FROM pieces
    )
    SELECT COALESCE(group_concat(piece,''),'') AS text,COALESCE(MAX(total),0)>? AS truncated
      FROM (SELECT substr(json_extract(e.data,'$.text'),1,MAX(0,?-b.used)) AS piece,b.total
        FROM budgeted b JOIN events e ON e.session_id=? AND e.sequence=b.sequence WHERE b.used<? ORDER BY b.sequence)
  `);
  const lastActivity = cachedStatement(sqlite, `SELECT COALESCE(MAX(sequence),?) AS sequence FROM events
    WHERE session_id=? AND sequence BETWEEN ? AND ? AND
      (type IN ('tool_call','tool_result','thinking') OR (type='text' AND json_valid(data) AND json_extract(data,'$.role')='user'))`);
  const parts = cachedStatement(sqlite, `
    SELECT e.id,e.sequence,e.type,e.task_id AS taskId,e.attempt_id AS attemptId,
      json_extract(e.data,'$.role') AS role,json_extract(e.data,'$.status') AS status,
      json_extract(e.data,'$.output.status') AS deliveryStatus,
      substr(json_extract(e.data,'$.output.deliveryId'),1,2048) AS deliveryId,
      json_extract(e.data,'$.output.fileCount') AS fileCount,
      p.key AS partIndex,json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.type') AS partType,
      substr(COALESCE(json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.uri'),json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.resource.uri')),1,2048) AS uri,
      substr(json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.name'),1,2048) AS name,
      substr(COALESCE(json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.mimeType'),json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.resource.mimeType')),1,2048) AS mimeType
    FROM events e LEFT JOIN json_each(CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.parts') END) p
    WHERE e.session_id=? AND e.sequence BETWEEN ? AND ? AND json_valid(e.data)
      AND ((e.type='tool_result' AND json_extract(e.data,'$.status')='completed') OR
        (e.type='text' AND COALESCE(json_extract(e.data,'$.role'),'assistant')!='user'))
      AND ((p.type='object' AND CAST(p.key AS INTEGER)<64 AND json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.type') IN ('image','resource','resource_link')) OR (e.type='tool_result' AND json_extract(e.data,'$.output.status')='delivered'))
    ORDER BY e.sequence,CAST(p.key AS INTEGER) LIMIT 129
  `);
  // Preparation may settle before Runtime records a user prompt. Its terminal
  // evidence cannot belong to the preceding prompted turn (or a later prompt).
  const unprompted = cachedStatement(sqlite, `
    WITH prompts AS (
      SELECT COALESCE(task_id,json_extract(data,'$.taskId')) AS taskId,attempt_id AS attemptId,MIN(sequence) AS first
      FROM events WHERE session_id=? AND type='text' AND json_valid(data) AND json_extract(data,'$.role')='user'
        AND json_type(data,'$.steering') IS NULL GROUP BY 1,2
    )
    SELECT MIN(e.sequence) AS first FROM events e LEFT JOIN prompts p ON p.taskId=e.task_id AND p.first<=e.sequence
      AND (e.attempt_id IS NULL OR p.attemptId IS NULL OR p.attemptId=e.attempt_id)
    WHERE e.session_id=? AND e.type IN ('error','completed')
      AND ((e.task_id IS NOT NULL AND p.first IS NULL) OR (e.task_id IS NULL AND e.type='error'))
  `).get(sessionId, sessionId) as { first: number | null };
  // Adapters that batch-write events carry the original call times in the payload; prefer them over write times.
  const toolSpans = cachedStatement(sqlite, `SELECT COALESCE(MIN(json_extract(data,'$.startedAt')),MIN(timestamp)) AS started,COALESCE(MAX(json_extract(data,'$.completedAt')),MAX(timestamp)) AS ended FROM events
    WHERE session_id=? AND sequence BETWEEN ? AND ? AND type IN ('tool_call','tool_result') AND json_valid(data)
    GROUP BY COALESCE(json_extract(data,'$.id'),id) ORDER BY started`);
  // The turn ends at its completion receipt; terminal repaints and status pings can trail it by minutes.
  const turnEnd = cachedStatement(sqlite, `SELECT COALESCE(MAX(CASE WHEN type='completed' THEN timestamp END),MAX(CASE WHEN type NOT IN ('raw_terminal','status') THEN timestamp END)) AS value
    FROM events WHERE session_id=? AND sequence BETWEEN ? AND ?`);
  const toolCalls = cachedStatement(sqlite, `SELECT COUNT(DISTINCT COALESCE(json_extract(data,'$.id'),id)) AS count FROM events
    WHERE session_id=? AND sequence BETWEEN ? AND ? AND type IN ('tool_call','tool_result') AND json_valid(data)`);
  const turns: HistoryTurnSummary[] = [];
  let liveAfter = 0;
  for (const range of boundaries) {
    // Keep the entire affected boundary and its suffix canonical, including any
    // earlier completed turn sharing that boundary with a preparation failure.
    if (unprompted.first !== null && range.last >= unprompted.first) break;
    // Once an unresolved turn starts, keep its whole suffix canonical. A later
    // user prompt cannot turn an unknown execution into a completed one.
    const terminal = isTerminalTaskStatus(range.status);
    if (!terminal && !(range.status == null && range.ended)) break;
    const prompt = text.get(sessionId, range.first, range.last, 'user', HISTORY_PROMPT_LIMIT, HISTORY_PROMPT_LIMIT, sessionId, HISTORY_PROMPT_LIMIT + 1) as { text: string; truncated: number };
    const after = (lastActivity.get(range.first - 1, sessionId, range.first, range.last) as { sequence: number }).sequence;
    const output = text.get(sessionId, after + 1, range.last, 'assistant', HISTORY_OUTPUT_LIMIT, HISTORY_OUTPUT_LIMIT, sessionId, HISTORY_OUTPUT_LIMIT + 1) as { text: string; truncated: number };
    const toolCount = (toolCalls.get(sessionId, range.first, range.last) as { count: number }).count;
    const artifacts: HistoryTurnSummary['artifactReferences'] = [];
    const seen = new Set<string>();
    const references = parts.all(sessionId, range.first, range.last) as Array<any>;
    for (const row of references.slice(0, 128)) {
      const part = row.partType === 'resource' ? { type: 'resource', resource: { uri: row.uri, mimeType: row.mimeType } }
        : row.partType === 'image' ? { type: 'image', data: '', uri: row.uri, mimeType: row.mimeType ?? '' }
        : row.partType === 'resource_link' ? { type: 'resource_link', uri: row.uri, name: row.name, mimeType: row.mimeType } : undefined;
      const refs = extractEventArtifactReferences({ ...row, data: { role: row.role, status: row.status,
        output: { status: row.deliveryStatus, deliveryId: row.deliveryId, fileCount: row.fileCount }, parts: part ? [part] : [] } });
      for (const ref of refs) {
        const partIndex = ref.partIndex < 0 ? -1 : Number(row.partIndex);
        const revision = `event:${row.id}:${row.sequence}:${partIndex < 0 ? 'receipt' : partIndex}`;
        if (!seen.has(revision)) { seen.add(revision); artifacts.push({ ...ref, partIndex, revision }); }
      }
    }
    const activity = turnActivity(range.timestamp, (turnEnd.get(sessionId, range.first, range.last) as { value: string | null }).value,
      toolSpans.all(sessionId, range.first, range.last) as Array<{ started: string; ended: string }>);
    turns.push({ id: range.id, ...(range.taskId ? { taskId: range.taskId } : {}), ...(range.attemptId ? { attemptId: range.attemptId } : {}),
      firstSequence: range.first, lastSequence: range.last, timestamp: range.timestamp, status: range.status ?? 'unverified',
      prompt: { text: prompt.text, truncated: Boolean(prompt.truncated) }, output: { text: output.text, truncated: Boolean(output.truncated) }, toolCount, artifactReferences: artifacts, artifactReferencesTruncated: references.length > 128,
      ...(activity ? { activity } : {}) });
    liveAfter = range.last;
  }
  const commandEvent = cachedStatement(sqlite, `SELECT id,sequence,json_array_length(data,'$.availableCommands') AS count FROM events
    WHERE session_id=? AND type='status' AND CASE WHEN json_valid(data) THEN json_extract(data,'$.state') END='commands'
      AND CASE WHEN json_valid(data) THEN json_type(data,'$.availableCommands') END='array' ORDER BY sequence DESC LIMIT 1`).get(sessionId) as { id: string; sequence: number; count: number } | undefined;
  let commandCatalog: HistoryOutline['commandCatalog'];
  if (commandEvent) {
    const rows = cachedStatement(sqlite, `SELECT json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.name') AS name,
      CASE WHEN json_type(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.description')='text' THEN substr(json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.description'),1,1024) ELSE '' END AS description,
      length(json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.description'))>1024 AS shortened
      FROM events e,json_each(json_extract(e.data,'$.availableCommands')) j
      WHERE e.id=? AND j.type='object' AND CAST(j.key AS INTEGER)<128
        AND json_type(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.name')='text' AND length(json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.name'))<=128
      ORDER BY CAST(j.key AS INTEGER) LIMIT 128`).all(commandEvent.id) as Array<{ name: string; description: string; shortened: number }>;
    commandCatalog = { sequence: commandEvent.sequence, commands: rows.map(row => ({ name: row.name.replace(/^\//, ''), description: row.description })),
      truncated: commandEvent.count > 128 || rows.length < Math.min(128, commandEvent.count) || rows.some(row => Boolean(row.shortened)) };
  }
  return { turns, highWaterMark, liveAfter, ...(commandCatalog ? { commandCatalog } : {}) };
}

/** Each tool id spans its earliest to latest event. Long turns keep the longest call of each bucket, so spikes survive sampling. */
function turnActivity(start: string, end: string | null, spans: Array<{ started: string; ended: string }>): HistoryTurnSummary['activity'] {
  const origin = Date.parse(start);
  if (!end || !Number.isFinite(origin) || !Number.isFinite(Date.parse(end))) return;
  const tools = spans.flatMap(span => {
    const started = Date.parse(span.started), ended = Date.parse(span.ended);
    return Number.isFinite(started) && Number.isFinite(ended) ? [[Math.max(0, started - origin), Math.max(0, ended - started)] as [number, number]] : [];
  });
  if (tools.length <= HISTORY_ACTIVITY_LIMIT) return { endedAt: end, tools };
  return { endedAt: end, tools: Array.from({ length: HISTORY_ACTIVITY_LIMIT }, (_, index) =>
    tools.slice(Math.floor(index * tools.length / HISTORY_ACTIVITY_LIMIT), Math.floor((index + 1) * tools.length / HISTORY_ACTIVITY_LIMIT))
      .reduce((longest, tool) => tool[1] > longest[1] ? tool : longest)) };
}
let seed = 1;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]!;
// Tools that start at the same instant have no defined order in either projection.
const sortedTools = (outline: { turns: HistoryTurnSummary[] }) => { for (const turn of outline.turns) turn.activity?.tools.sort((a, b) => a[0] - b[0] || a[1] - b[1]); return outline; };
const directories: string[] = [];
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

/** Random prompts, steering, roles, tools, receipts, malformed rows, task states and pruned holes. */
async function seedRandomSession(file: string, round: number) {
  const repos = createRepositories(file);
  const tasks = ['ta', 'tb', 'tc', 'td', 'te'];
  // Odd rounds settle every task, so long completed prefixes and ranges inside them occur too.
  for (const id of tasks) await repos.tasks.save({ id, sessionId: 's', prompt: 'p', status: round % 2 ? pick(['completed', 'failed', 'cancelled', 'interrupted']) : pick(['completed', 'completed', 'completed', 'failed', 'cancelled', 'interrupted', 'running', 'queued', 'reconcile_required']), createdAt: '', updatedAt: '' } as any);
  repos.close();
  const db = new Database(file);
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
  const directory = mkdtempSync(join(tmpdir(), 'history-equivalence-')); directories.push(directory);
  let turns = 0;
  for (let round = 0; round < 200; round++) {
    seed = round + 7;
    const db = await seedRandomSession(join(directory, `${round}.db`), round);
    try {
      const expected = sortedTools(legacyHistoryOutline(db, 's'));
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

it('indexes existing prompts on upgrade without rewriting events, and reads the outline through that index', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-index-migration-')); directories.push(directory);
  const path = join(directory, 'state.db');
  const repos = createRepositories(path);
  await repos.tasks.save({ id: 't1', sessionId: 's', prompt: 'p', status: 'completed', createdAt: '', updatedAt: '' } as any);
  await repos.tasks.save({ id: 't2', sessionId: 's', prompt: 'p', status: 'running', createdAt: '', updatedAt: '' } as any);
  repos.close();
  const db = new Database(path);
  try {
    db.exec('DROP INDEX events_user_text; DELETE FROM schema_migrations WHERE version=47');
    const insert = db.prepare('INSERT INTO events (id,session_id,task_id,sequence,type,timestamp,data) VALUES (?,?,?,?,?,?,?)');
    insert.run('p1', 's', null, 1, 'text', '1', JSON.stringify({ role: 'user', text: 'first prompt', taskId: 't1' }));
    insert.run('a1', 's', 't1', 2, 'text', '2', JSON.stringify({ role: 'assistant', text: 'answer' }));
    insert.run('s1', 's', 't1', 3, 'text', '3', JSON.stringify({ role: 'user', text: 'steer', steering: true }));
    insert.run('bad', 's', 't1', 4, 'text', '4', '{broken');
    insert.run('p2', 's', 't1', 6, 'text', '6', JSON.stringify({ role: 'user', text: 'second prompt' }));
    insert.run('p3', 's', 't2', 7, 'text', '7', JSON.stringify({ role: 'user', text: 'still running' }));
    const before = db.prepare('SELECT * FROM events ORDER BY sequence').all();
    // Reads name the index, so an unmigrated database cannot silently fall back to parsing every event.
    expect(() => readHistoryOutline(db, 's')).toThrow(/no such index: events_user_text/);
    runMigrations(db);
    expect(db.prepare('SELECT * FROM events ORDER BY sequence').all()).toEqual(before);
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version=47').get()).toEqual({ version: 47 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // Only parseable user messages enter the index.
    expect(db.prepare(`SELECT id FROM events INDEXED BY events_user_text WHERE session_id='s' AND type='text' AND json_valid(data) AND json_extract(data,'$.role')='user' ORDER BY sequence`).pluck().all()).toEqual(['p1', 's1', 'p2', 'p3']);
    const expected = legacyHistoryOutline(db, 's');
    expect(expected.turns.map(turn => [turn.id, turn.firstSequence, turn.lastSequence])).toEqual([['p1', 1, 4], ['p2', 6, 6]]);
    expect(readHistoryOutline(db, 's')).toEqual(expected);
    expect(readHistoryOutline(db, 's', { tail: 1 })).toEqual({ ...expected, turns: expected.turns.slice(1), places: [['p1', 1, 4, 't1', 'first promptsteer'], ['p2', 6, 6, 't1', 'second prompt']] });
  } finally { db.close(); }
  // Opening the upgraded file again neither re-runs nor fails the migration.
  for (let open = 0; open < 2; open++) {
    const reopened = createRepositories(path);
    try { expect((await reopened.events.listHistoryOutline!('s')).turns.map(turn => turn.id)).toEqual(['p1', 'p2']); } finally { reopened.close(); }
  }
});
