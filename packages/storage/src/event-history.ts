import type Database from 'better-sqlite3';
import { extractEventArtifactReferences, type HistoryOutline, type HistoryTurnSummary } from '@dutydeck/shared';

export const HISTORY_PROMPT_LIMIT = 1024;
export const HISTORY_OUTPUT_LIMIT = 4096;
type Boundary = { first: number; last: number; id: string; timestamp: string; taskId: string | null; attemptId: string | null; status: string | null; ended: number };

/** SQLite projects bounded fields; neither raw nor tool input/output blobs enter JS. */
export function readHistoryOutline(sqlite: Database.Database, sessionId: string): HistoryOutline {
  return sqlite.transaction(() => projectHistoryOutline(sqlite, sessionId))();
}

function projectHistoryOutline(sqlite: Database.Database, sessionId: string): HistoryOutline {
  const highWaterMark = (sqlite.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM events WHERE session_id=?').get(sessionId) as { value: number }).value;
  const boundaries = sqlite.prepare(`
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
  const text = sqlite.prepare(`
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
  const lastActivity = sqlite.prepare(`SELECT COALESCE(MAX(sequence),?) AS sequence FROM events
    WHERE session_id=? AND sequence BETWEEN ? AND ? AND
      (type IN ('tool_call','tool_result','thinking') OR (type='text' AND json_valid(data) AND json_extract(data,'$.role')='user'))`);
  const parts = sqlite.prepare(`
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
  const unprompted = sqlite.prepare(`
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
  const turns: HistoryTurnSummary[] = [];
  let liveAfter = 0;
  for (const range of boundaries) {
    // Keep the entire affected boundary and its suffix canonical, including any
    // earlier completed turn sharing that boundary with a preparation failure.
    if (unprompted.first !== null && range.last >= unprompted.first) break;
    // Once an unresolved turn starts, keep its whole suffix canonical. A later
    // user prompt cannot turn an unknown execution into a completed one.
    const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(range.status ?? '');
    if (!terminal && !(range.status == null && range.ended)) break;
    const prompt = text.get(sessionId, range.first, range.last, 'user', HISTORY_PROMPT_LIMIT, HISTORY_PROMPT_LIMIT, sessionId, HISTORY_PROMPT_LIMIT + 1) as { text: string; truncated: number };
    const after = (lastActivity.get(range.first - 1, sessionId, range.first, range.last) as { sequence: number }).sequence;
    const output = text.get(sessionId, after + 1, range.last, 'assistant', HISTORY_OUTPUT_LIMIT, HISTORY_OUTPUT_LIMIT, sessionId, HISTORY_OUTPUT_LIMIT + 1) as { text: string; truncated: number };
    const toolCount = (sqlite.prepare(`SELECT COUNT(DISTINCT COALESCE(json_extract(data,'$.id'),id)) AS count FROM events
      WHERE session_id=? AND sequence BETWEEN ? AND ? AND type IN ('tool_call','tool_result') AND json_valid(data)`).get(sessionId, range.first, range.last) as { count: number }).count;
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
    turns.push({ id: range.id, ...(range.taskId ? { taskId: range.taskId } : {}), ...(range.attemptId ? { attemptId: range.attemptId } : {}),
      firstSequence: range.first, lastSequence: range.last, timestamp: range.timestamp, status: range.status ?? 'unverified',
      prompt: { text: prompt.text, truncated: Boolean(prompt.truncated) }, output: { text: output.text, truncated: Boolean(output.truncated) }, toolCount, artifactReferences: artifacts, artifactReferencesTruncated: references.length > 128 });
    liveAfter = range.last;
  }
  const commandEvent = sqlite.prepare(`SELECT id,sequence,json_array_length(data,'$.availableCommands') AS count FROM events
    WHERE session_id=? AND type='status' AND CASE WHEN json_valid(data) THEN json_extract(data,'$.state') END='commands'
      AND CASE WHEN json_valid(data) THEN json_type(data,'$.availableCommands') END='array' ORDER BY sequence DESC LIMIT 1`).get(sessionId) as { id: string; sequence: number; count: number } | undefined;
  let commandCatalog: HistoryOutline['commandCatalog'];
  if (commandEvent) {
    const rows = sqlite.prepare(`SELECT json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.name') AS name,
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
