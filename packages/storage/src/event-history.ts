import type Database from 'better-sqlite3';
import { cachedStatement } from './database-control.js';
import { extractEventArtifactReferences, isTerminalTaskStatus, type HistoryOutline, type HistoryOutlineQuery, type HistoryTurnPlace, type HistoryTurnSummary } from '@dutydeck/shared';

export const HISTORY_PROMPT_LIMIT = 1024;
export const HISTORY_OUTPUT_LIMIT = 4096;
export const HISTORY_ACTIVITY_LIMIT = 240;
/** Characters of the prompt kept in a turn's place; enough for a jump-to-turn label. Migration 49 indexes this exact prefix. */
export const HISTORY_PLACE_PROMPT_LIMIT = 40;
type Turn = { first: number; last: number; timestamp: string; attemptId: string | null;
  toolCount: number; endedAt: string | null; artifactCandidate: number | null; promptText: string | null; promptTruncated: number | null; outputText: string | null; outputTruncated: number | null; spans: string | null };

const readHighWaterMark = (sqlite: Database.Database, sessionId: string) =>
  (cachedStatement(sqlite, 'SELECT COALESCE(MAX(sequence),0) AS value FROM events WHERE session_id=?').get(sessionId) as { value: number }).value;

/**
 * SQLite projects bounded fields; neither raw nor tool input/output blobs enter JS.
 * Without `tail` every completed turn is summarized. With `tail` only the newest turns are,
 * and `places` lists every completed turn so the rest can be read by range later.
 */
export function readHistoryOutline(sqlite: Database.Database, sessionId: string, query: HistoryOutlineQuery = {}): HistoryOutline {
  return sqlite.transaction(() => {
    const highWaterMark = readHighWaterMark(sqlite, sessionId);
    const { places, statuses } = completedPlaces(sqlite, sessionId, highWaterMark, highWaterMark);
    const selected = query.tail !== undefined ? places.slice(Math.max(0, places.length - query.tail)) : places;
    const commandCatalog = readCommandCatalog(sqlite, sessionId);
    return { turns: selected.length ? projectTurns(sqlite, sessionId, selected, statuses) : [], highWaterMark, liveAfter: places.at(-1)?.[2] ?? 0,
      ...(query.tail !== undefined ? { places } : {}),
      ...(commandCatalog ? { commandCatalog } : {}) };
  })();
}

/** Summaries of the completed turns lying inside `from..through`; reads nothing after the range. */
export function readHistoryTurns(sqlite: Database.Database, sessionId: string, from: number, through: number): HistoryTurnSummary[] {
  return sqlite.transaction(() => {
    const highWaterMark = readHighWaterMark(sqlite, sessionId);
    const { places, statuses } = completedPlaces(sqlite, sessionId, highWaterMark, Math.min(through, highWaterMark));
    const selected = places.filter(place => place[1] >= from && place[2] <= through);
    return selected.length ? projectTurns(sqlite, sessionId, selected, statuses) : [];
  })();
}

/**
 * The user prompts, read from the `events_user_text` index (migration 49) instead of parsing
 * every event. The expressions must match the index's text exactly, or SQLite parses each row.
 */
const USER_TEXT = `FROM events INDEXED BY events_user_text WHERE session_id=? AND type='text' AND json_valid(data) AND json_extract(data,'$.role')='user'`;
const OWNER = `COALESCE(task_id,json_extract(data,'$.taskId'))`;
const BOUNDARY = `json_type(data,'$.steering') IS NULL`;

/**
 * Turn boundaries are the non-steering user prompts; events before the first one join
 * the first turn. Only prompts are read, from an index, so this stays cheap on long sessions.
 * Returns the completed prefix, which ends before the first unresolved turn, and the task statuses that decided it.
 */
function completedPlaces(sqlite: Database.Database, sessionId: string, highWaterMark: number, through: number): { places: HistoryTurnPlace[]; statuses: Map<string, string> } {
  if (!highWaterMark) return { places: [], statuses: new Map() };
  // Whether a turn is in the completed prefix depends only on the turns before it, so
  // turns ending after `through` need not be read; the last one read may extend past it.
  // Rows stay arrays: long sessions have tens of thousands of prompts.
  const users = cachedStatement(sqlite, `SELECT sequence,id,${OWNER},${BOUNDARY},
      substr(json_extract(data,'$.text'),1,${HISTORY_PLACE_PROMPT_LIMIT}) ${USER_TEXT} AND sequence<=? ORDER BY sequence`)
    .raw().all(sessionId, through) as Array<[sequence: number, id: string, owner: string | null, boundary: number, piece: string | null]>;
  // Turn k starts at the k-th boundary; the first turn also takes everything before it.
  const heads: number[] = [];
  users.forEach((user, index) => { if (user[3]) heads.push(index); });
  const after = through < highWaterMark ? cachedStatement(sqlite, `SELECT sequence ${USER_TEXT} AND ${BOUNDARY} AND sequence>? ORDER BY sequence LIMIT 1`)
    .pluck().get(sessionId, through) as number | undefined : undefined;
  const end = after === undefined ? highWaterMark : after - 1;
  // A turn ends at the last stored event before the next prompt. Sequences are usually
  // contiguous, so that is the next prompt's predecessor; pruned holes need the real list.
  const span = cachedStatement(sqlite, 'SELECT MIN(sequence) AS start,COUNT(*) AS count FROM events WHERE session_id=? AND sequence<=?').get(sessionId, end) as { start: number; count: number };
  if (!span.count) return { places: [], statuses: new Map() };
  const sequences = span.count === end - span.start + 1 ? undefined
    : cachedStatement(sqlite, 'SELECT sequence FROM events WHERE session_id=? AND sequence<=? ORDER BY sequence').pluck().all(sessionId, end) as number[];
  const lastBefore = (next: number) => sequences ? sequences[lowerBound(sequences, next) - 1]! : next - 1;
  const statuses = new Map((cachedStatement(sqlite, 'SELECT id,status FROM tasks WHERE session_id=?').all(sessionId) as Array<{ id: string; status: string }>).map(task => [task.id, task.status]));
  const firstOwner = cachedStatement(sqlite, `SELECT task_id FROM events WHERE session_id=? AND sequence BETWEEN ? AND ?
    AND type IN ('text','thinking','tool_call','tool_result') AND task_id IS NOT NULL ORDER BY sequence LIMIT 1`).pluck();
  const completed = cachedStatement(sqlite, `SELECT 1 FROM events WHERE session_id=? AND sequence BETWEEN ? AND ? AND type='completed' LIMIT 1`).pluck();
  // Preparation may settle before Runtime records a user prompt. Its terminal
  // evidence cannot belong to the preceding prompted turn (or a later prompt).
  // Only evidence up to `end` can cut a turn read here. The covering index (migration 47)
  // filters by type without reading every event row.
  const unprompted = cachedStatement(sqlite, `
    WITH prompts AS (SELECT ${OWNER} AS taskId,attempt_id AS attemptId,MIN(sequence) AS first ${USER_TEXT} AND ${BOUNDARY} AND sequence<=? GROUP BY 1,2)
    SELECT MIN(e.sequence) AS first FROM events e INDEXED BY events_session_seq_type LEFT JOIN prompts p ON p.taskId=e.task_id AND p.first<=e.sequence
      AND (e.attempt_id IS NULL OR p.attemptId IS NULL OR p.attemptId=e.attempt_id)
    WHERE e.session_id=? AND e.sequence<=? AND e.type IN ('error','completed')
      AND ((e.task_id IS NOT NULL AND p.first IS NULL) OR (e.task_id IS NULL AND e.type='error'))
  `).pluck().get(sessionId, end, sessionId, end) as number | null;
  const places: HistoryTurnPlace[] = [];
  for (let turn = 0; turn < Math.max(1, heads.length); turn++) {
    const head = heads[turn] === undefined ? undefined : users[heads[turn]!]!, nextHead = heads[turn + 1];
    const first = turn ? head![0] : span.start;
    const last = lastBefore(nextHead === undefined ? end + 1 : users[nextHead]![0]);
    // Keep the entire affected boundary and its suffix canonical, including any
    // earlier completed turn sharing that boundary with a preparation failure.
    if (unprompted !== null && last >= unprompted) break;
    const taskId = head?.[2] ?? (firstOwner.get(sessionId, first, last) as string | undefined) ?? null;
    const status = (taskId !== null ? statuses.get(taskId) : undefined) ?? null;
    // Once an unresolved turn starts, keep its whole suffix canonical. A later
    // user prompt cannot turn an unknown execution into a completed one.
    if (!isTerminalTaskStatus(status) && !(status == null && completed.get(sessionId, first, last))) break;
    // The label joins the turn's user messages, steering included, up to the limit.
    let prompt = '';
    for (let index = turn ? heads[turn]! : 0; index < (nextHead ?? users.length) && prompt.length < HISTORY_PLACE_PROMPT_LIMIT; index++) prompt += users[index]![4] ?? '';
    places.push([head ? head[1] : cachedStatement(sqlite, 'SELECT id FROM events WHERE session_id=? AND sequence=?').pluck().get(sessionId, first) as string,
      first, last, taskId, prompt.slice(0, HISTORY_PLACE_PROMPT_LIMIT)]);
  }
  return { places, statuses };
}

/** Summaries for consecutive completed places, in one pass over exactly their events; ids and owners come from the places. */
function projectTurns(sqlite: Database.Database, sessionId: string, places: HistoryTurnPlace[], statuses: Map<string, string>): HistoryTurnSummary[] {
  const from = places[0]![1], through = places.at(-1)![2];
  const rows = cachedStatement(sqlite, `
    WITH marked AS MATERIALIZED (
      SELECT id,sequence,timestamp,task_id,attempt_id,type,valid,
        CASE WHEN valid THEN json_extract(data,'$.role') END AS role,
        CASE WHEN type='text' AND valid AND json_extract(data,'$.role')='user'
          AND json_type(data,'$.steering') IS NULL THEN 1 ELSE 0 END AS boundary,
        CASE WHEN type='text' AND valid THEN substr(json_extract(data,'$.text'),1,${HISTORY_OUTPUT_LIMIT}) END AS piece,
        CASE WHEN type='text' AND valid THEN length(json_extract(data,'$.text')) END AS size,
        CASE WHEN type='text' AND valid THEN json_extract(data,'$.origin') END AS origin,
        CASE WHEN type IN ('tool_call','tool_result') AND valid THEN COALESCE(json_extract(data,'$.id'),id) END AS toolKey,
        CASE WHEN type IN ('tool_call','tool_result') AND valid THEN json_extract(data,'$.startedAt') END AS startedAt,
        CASE WHEN type IN ('tool_call','tool_result') AND valid THEN json_extract(data,'$.completedAt') END AS completedAt,
        -- Turns without a structured part or delivery receipt skip the artifact read below.
        CASE WHEN valid AND ((type='tool_result' AND json_extract(data,'$.status')='completed') OR (type='text' AND COALESCE(json_extract(data,'$.role'),'assistant')!='user'))
          AND (json_type(data,'$.parts') IS NOT NULL OR (type='tool_result' AND json_extract(data,'$.output.status')='delivered')) THEN 1 END AS artifactCandidate
      FROM (SELECT *,json_valid(data) AS valid FROM events WHERE session_id=@session AND sequence BETWEEN @from AND @through)
    ), grouped AS MATERIALIZED (
      SELECT *,MAX(1,SUM(boundary) OVER (ORDER BY sequence)) AS turn FROM marked
    ), ranges AS MATERIALIZED (
      SELECT turn,MIN(sequence) AS first,MAX(sequence) AS last,MIN(timestamp) AS timestamp,
        MIN(CASE WHEN type!='task' AND attempt_id IS NOT NULL THEN sequence END) AS attemptSequence,
        -- The final output follows the turn's last tool, thinking or user activity.
        COALESCE(MAX(CASE WHEN type IN ('tool_call','tool_result','thinking') OR (type='text' AND valid AND role='user') THEN sequence END),MIN(sequence)-1) AS outputAfter,
        COUNT(DISTINCT toolKey) AS toolCount,
        -- The turn ends at its completion receipt; terminal repaints and status pings can trail it by minutes.
        COALESCE(MAX(CASE WHEN type='completed' THEN timestamp END),MAX(CASE WHEN type NOT IN ('raw_terminal','status') THEN timestamp END)) AS endedAt,
        MAX(artifactCandidate) AS artifactCandidate
      FROM grouped GROUP BY turn
    ), pieces AS (
      SELECT g.turn,g.sequence,g.piece,g.size,COALESCE(g.role,'assistant')='assistant' AS output
      FROM grouped g JOIN ranges r ON r.turn=g.turn
      WHERE g.type='text' AND g.valid AND (COALESCE(g.role,'assistant')='user' OR (COALESCE(g.role,'assistant')='assistant' AND g.sequence>r.outputAfter))
        -- A background task's later answer is run-level and never a turn's output.
        AND COALESCE(g.origin,'') <> 'background_followup'
    ), budgeted AS (
      SELECT *,CASE WHEN output THEN ${HISTORY_OUTPUT_LIMIT} ELSE ${HISTORY_PROMPT_LIMIT} END AS budget,
        COALESCE(SUM(size) OVER (PARTITION BY turn,output ORDER BY sequence ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS used,
        SUM(size) OVER (PARTITION BY turn,output) AS total FROM pieces
    ), texts AS MATERIALIZED (
      SELECT turn,output,COALESCE(group_concat(substr(piece,1,MAX(0,budget-used)),'' ORDER BY sequence),'') AS text,COALESCE(MAX(total),0)>MAX(budget) AS truncated
      FROM budgeted WHERE used<budget GROUP BY turn,output
    ), tools AS (
      -- Adapters that batch-write events carry the original call times in the payload; prefer them over write times.
      SELECT turn,toolKey,COALESCE(MIN(startedAt),MIN(timestamp)) AS started,COALESCE(MAX(completedAt),MAX(timestamp)) AS ended
      FROM grouped WHERE toolKey IS NOT NULL GROUP BY turn,toolKey
    ), spans AS MATERIALIZED (
      SELECT turn,json_group_array(json_array(started,ended) ORDER BY started,toolKey) AS spans FROM tools GROUP BY turn
    )
    SELECT r.first,r.last,r.timestamp,r.toolCount,r.endedAt,r.artifactCandidate,a.attempt_id AS attemptId,
      p.text AS promptText,p.truncated AS promptTruncated,q.text AS outputText,q.truncated AS outputTruncated,s.spans
    FROM ranges r
      LEFT JOIN events a ON a.session_id=@session AND a.sequence=r.attemptSequence
      LEFT JOIN texts p ON p.turn=r.turn AND NOT p.output
      LEFT JOIN texts q ON q.turn=r.turn AND q.output
      LEFT JOIN spans s ON s.turn=r.turn
    ORDER BY r.first
  `).all({ session: sessionId, from, through }) as Turn[];
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
    FROM events e INDEXED BY events_session_seq_type LEFT JOIN json_each(CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.parts') END) p
    WHERE e.session_id=? AND e.sequence BETWEEN ? AND ? AND e.type IN ('tool_result','text') AND json_valid(e.data)
      AND ((e.type='tool_result' AND json_extract(e.data,'$.status')='completed') OR
        (e.type='text' AND COALESCE(json_extract(e.data,'$.role'),'assistant')!='user'))
      AND ((p.type='object' AND CAST(p.key AS INTEGER)<64 AND json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.type') IN ('image','resource','resource_link')) OR (e.type='tool_result' AND json_extract(e.data,'$.output.status')='delivered'))
    ORDER BY e.sequence,CAST(p.key AS INTEGER) LIMIT 129
  `);
  // Projection boundaries equal the places' boundaries; anything else is not a completed turn.
  const byFirst = new Map(places.map(place => [place[1], place]));
  return rows.filter(row => byFirst.has(row.first)).map(range => {
    const [id, , , taskId] = byFirst.get(range.first)!;
    const artifacts: HistoryTurnSummary['artifactReferences'] = [];
    const seen = new Set<string>();
    const references = range.artifactCandidate ? parts.all(sessionId, range.first, range.last) as Array<any> : [];
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
    const spans = range.spans ? (JSON.parse(range.spans) as Array<[string, string]>).map(([started, ended]) => ({ started, ended })) : [];
    const activity = turnActivity(range.timestamp, range.endedAt, spans);
    return { id, ...(taskId ? { taskId } : {}), ...(range.attemptId ? { attemptId: range.attemptId } : {}),
      firstSequence: range.first, lastSequence: range.last, timestamp: range.timestamp, status: (taskId ? statuses.get(taskId) : undefined) ?? 'unverified',
      prompt: { text: range.promptText ?? '', truncated: Boolean(range.promptTruncated) }, output: { text: range.outputText ?? '', truncated: Boolean(range.outputTruncated) }, toolCount: range.toolCount, artifactReferences: artifacts, artifactReferencesTruncated: references.length > 128,
      ...(activity ? { activity } : {}) };
  });
}

/** Index of the first value that is not below `value` in an ascending list. */
function lowerBound(values: number[], value: number) {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >> 1; if (values[middle]! < value) low = middle + 1; else high = middle; }
  return low;
}

function readCommandCatalog(sqlite: Database.Database, sessionId: string): HistoryOutline['commandCatalog'] {
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
  return commandCatalog;
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
