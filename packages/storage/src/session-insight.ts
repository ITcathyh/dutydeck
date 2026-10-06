import type Database from 'better-sqlite3';
import { Buffer } from 'node:buffer';
import {
  RuntimeError,
  SESSION_INSIGHT_LIMITS,
  refreshStates,
  transcriptSourceObservationSchema,
  sessionInsightSnapshotRecordSchema,
  sessionInsightEventItemSchema,
  type HostEvidenceSnapshot,
  type RefreshState,
  type RuntimeControlClaim,
  type SessionInsightEventItem,
  type SessionInsightEventsQuery,
  type SessionInsightEventsResponse,
  type SessionInsightManifest,
  type SessionInsightRefreshRecord,
  type SessionInsightSnapshotRecord,
  type SessionInsightStatus,
  type SessionInsightSummary,
  type TranscriptSourceObservation,
  taskExecutionSchemas,
  type DriverResource,
  type SessionInsightRepository,
  type SessionInsightLiveSourcesWriter,
  type SessionInsightSummaryRawOptions,
  type SessionInsightSummaryRawResult,
  type SessionInsightSummaryRawRow,
  type SessionInsightRawTaskRow,
  type HostEvidenceRaw,
  type InsightPruneResult,
  type PublishInsightParams
} from '@dutydeck/shared';
import type { OpenControl } from './database-control.js';

interface SnapshotRow {
  snapshot_id: string;
  session_id: string;
  cache_key: string;
  schema_version: number;
  engine_version: string;
  parser_version: string;
  metric_version: string;
  redaction_version: string;
  summary_json: string | null;
  manifest_json: string | null;
  host_evidence_json: string | null;
  payload_bytes: number;
  tombstoned: number;
  created_at: string;
}

interface RefreshRow {
  session_id: string;
  request_id: string | null;
  state: RefreshState;
  binding_revision: number;
  current_snapshot_id: string | null;
  process_run_id: string | null;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_checked_at: string | null;
  error_code: string | null;
}

function fail(code: string, message: string, statusCode = 409): never {
  throw new RuntimeError(code, message, statusCode);
}

/** 决定 bindingRevision 的来源身份字段；capturedAt / observationId 重复上报不构成实质变化。 */
function sourceFingerprint(observation: TranscriptSourceObservation): string {
  return JSON.stringify([
    observation.sourceKey,
    observation.client,
    observation.launchKind,
    observation.proofKind,
    observation.dataRoot,
    observation.cwd ?? null,
    observation.nativeSessionId ?? null,
    observation.verifiedPath ?? null,
    observation.identityProof ?? null,
    observation.sourceSessionKey ?? null,
    observation.streamIdentity ?? null,
    observation.nativeContextRef ?? null
  ]);
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createSessionInsightRepository(
  db: Database.Database,
  control: OpenControl
): SessionInsightRepository {
  const nowIso = (): string => new Date().toISOString();

  const getSessionRunId = db.transaction((sessionId: string): string => {
    const row = db.prepare('SELECT run_id FROM sessions WHERE id = ?').get(sessionId) as
      | { run_id: string }
      | undefined;
    if (!row) fail('INSIGHT_NOT_FOUND', `Session ${sessionId} does not exist`, 404);
    return row.run_id;
  });

  /** 确保每 session 一行 idle 刷新记录，返回当前行。 */
  const ensureRefreshRow = (sessionId: string): RefreshRow =>
    db.transaction((sid: string): RefreshRow => {
      const existing = db.prepare('SELECT * FROM insight_refresh WHERE session_id = ?').get(sid) as
        | RefreshRow
        | undefined;
      if (existing) return existing;
      db.prepare(
        `INSERT INTO insight_refresh
           (session_id, request_id, state, binding_revision, current_snapshot_id, process_run_id,
            queued_at, started_at, finished_at, last_checked_at, error_code)
         VALUES (?, NULL, 'idle', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run(sid);
      return db.prepare('SELECT * FROM insight_refresh WHERE session_id = ?').get(sid) as RefreshRow;
    })(sessionId);

  const readResourceRow = (resourceId: string): DriverResource | undefined => {
    const row = db.prepare('SELECT json FROM driver_resources WHERE id = ?').get(resourceId) as
      | { json: string }
      | undefined;
    return row ? (taskExecutionSchemas.resource.parse(JSON.parse(row.json)) as DriverResource) : undefined;
  };

  /**
   * live 来源校验：session 当前 activeRun、driver 资源准确归属和 identity；
   * ACP live 引用须匹配当前 native selection，originRunId 允许早于 activeRunId。
   * 必须在已经 BEGIN IMMEDIATE 且通过 validateClaim 的事务内调用。
   */
  const validateLiveObservation = (observation: TranscriptSourceObservation): void => {
    // live writer 接受运行时直接观察（launch_observed）与弱推断（inferred），
    // 但历史核验结论只能走 appendHistoricalProof，不能借 live claim 写入。
    if (observation.proofKind === 'historical_verified') {
      fail('INSIGHT_INVALID_PROOF', 'Live source writer cannot record historical_verified proof');
    }
    // 该观察必须来自 session 的当前 run；旧 run 的迟到回调不能再写 live 观察。
    if (getSessionRunId(observation.sessionId) !== observation.activeRunId) {
      fail('INSIGHT_STALE_RUN', 'Observation run is no longer the active run for this session');
    }

    // driver 身份锚点有三种真实形状（与 agent-runtime LocalDriverLedger / ControlledDriverResources 对齐）：
    //  - controlled lifecycle：lifecycle operation 行（id 是独立 operation id），其 json.driverInstanceId
    //    才是 context.driverInstanceId；reattach 复用旧资源时 runId 可早于当前 run；
    //  - controlled restore：ACP restart/resume 复用既有 native context 时，ControlledDriverResources 在
    //    新 run 建一条 kind='operation' + operationScope.kind='strict-context-restore' 的 created 行，
    //    driverInstanceId 是新 driver，operationScope.context 是当前 selection（originRunId 保留旧 run）；
    //  - local-only（PTY 默认）：一个 kind='local_only' 子资源，其行 id 即 context.driverInstanceId，
    //    identity 在子资源上，父是一个无 operationScope 的 created operation。
    // 先取该 session 最新（最大 rowid）有效锚点，再比对其 driver 标识是否为上报 driver：
    // 同 run / 新 run 换了新 driver（含 restore）后，最新锚点不再属于旧 driver，旧 driver 迟到回调据此被拒。
    const latest = db
      .prepare(
        `SELECT id, json FROM driver_resources
         WHERE session_id = ?
           AND json_extract(json, '$.stage') = 'created'
           AND (
             (json_extract(json, '$.kind') = 'operation'
               AND json_extract(json, '$.operationScope.kind') IN ('lifecycle', 'strict-context-restore'))
             OR (json_extract(json, '$.kind') = 'local_only'
               AND json_extract(json, '$.identity.identityId') IS NOT NULL)
           )
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(observation.sessionId) as { id: string; json: string } | undefined;
    if (!latest) {
      fail('RESOURCE_IDENTITY_CONFLICT', 'Session has no current created driver resource');
    }
    const anchorResource = taskExecutionSchemas.resource.parse(JSON.parse(latest.json)) as DriverResource;
    const anchorDriverId =
      anchorResource.kind === 'local_only' ? latest.id : (anchorResource.driverInstanceId ?? undefined);
    if (!anchorDriverId || anchorDriverId !== observation.driverInstanceId) {
      fail('RESOURCE_IDENTITY_CONFLICT', 'Observation comes from a driver instance replaced by a newer driver');
    }
    if (anchorResource.sessionId !== observation.sessionId) {
      fail('RESOURCE_IDENTITY_CONFLICT', 'Observation driver resource is not owned by this session');
    }
    const anchorScopeKind = anchorResource.operationScope?.kind;
    if (anchorResource.kind === 'local_only') {
      // local-only 子资源必须属于当前 run，且有已核验 identity 与 created 的 operation 父资源。
      if (anchorResource.runId !== observation.activeRunId) {
        fail('INSIGHT_STALE_RUN', 'Local-only driver resource belongs to a previous run');
      }
      if (!anchorResource.identity?.identityId) {
        fail('RESOURCE_IDENTITY_CONFLICT', 'Local-only driver resource has no verified identity');
      }
      const parentId = anchorResource.parentResourceId;
      if (!parentId) {
        fail('RESOURCE_IDENTITY_CONFLICT', 'Local-only driver resource has no lifecycle operation parent');
      }
      const parent = readResourceRow(parentId);
      if (
        !parent ||
        parent.kind !== 'operation' ||
        parent.sessionId !== observation.sessionId ||
        parent.stage !== 'created'
      ) {
        fail('RESOURCE_IDENTITY_CONFLICT', 'Local-only driver parent operation is missing or not created');
      }
    } else if (anchorScopeKind === 'strict-context-restore') {
      // controlled restore operation 是新 run 上的当前 driver：runId 必须等于当前 active run，
      // 且其 operationScope.context 必须就是当前 native selection——以此精确绑定，不接受任意 operation。
      if (anchorResource.runId !== observation.activeRunId) {
        fail('INSIGHT_STALE_RUN', 'Restore driver resource belongs to a previous run');
      }
      const scopeContext = anchorResource.operationScope?.context as
        | { resourceId: string; identityId: string; originRunId: string }
        | undefined;
      if (!scopeContext) {
        fail('RESOURCE_IDENTITY_CONFLICT', 'Restore driver resource has no bound native context');
      }
      const restoreSelectionRow = db
        .prepare('SELECT value FROM configs WHERE key = ?')
        .get(`runtime_native_context:${observation.sessionId}`) as { value: string } | undefined;
      if (!restoreSelectionRow) {
        fail('NATIVE_CONTEXT_SELECTION_CONFLICT', 'No current native selection for restored driver');
      }
      const restoreSelection = taskExecutionSchemas.nativeSelectionSchema.parse(
        JSON.parse(restoreSelectionRow.value)
      ) as { context: { resourceId: string; identityId: string; originRunId: string } };
      if (
        scopeContext.resourceId !== restoreSelection.context.resourceId ||
        scopeContext.identityId !== restoreSelection.context.identityId ||
        scopeContext.originRunId !== restoreSelection.context.originRunId
      ) {
        fail('NATIVE_CONTEXT_SELECTION_CONFLICT', 'Restore driver is not bound to the current native selection');
      }
    }
    // controlled lifecycle operation 在 reattach 时复用旧资源，其 runId 允许早于当前 run，
    // 当前 run 有效性已由 sessions.run_id 与 native selection 检查保证。

    const ref = observation.nativeContextRef as
      | { resourceId: string; identityId: string; originRunId: string }
      | undefined;
    if (ref) {
      // ACP live 引用须匹配当前 native selection（resourceId + identityId）；originRunId 可旧。
      const selectionRow = db
        .prepare('SELECT value FROM configs WHERE key = ?')
        .get(`runtime_native_context:${observation.sessionId}`) as { value: string } | undefined;
      if (!selectionRow) {
        fail('NATIVE_CONTEXT_SELECTION_CONFLICT', 'No current native selection for this session');
      }
      const selection = taskExecutionSchemas.nativeSelectionSchema.parse(JSON.parse(selectionRow.value)) as {
        runId: string;
        context: { resourceId: string; identityId: string; originRunId: string };
      };
      // selection.runId 跟随当前 run（replaceSessionRun 会更新它），必须等于本次观察的 activeRunId。
      if (selection.runId !== observation.activeRunId) {
        fail('NATIVE_CONTEXT_SELECTION_CONFLICT', 'Current native selection belongs to a different run');
      }
      if (
        ref.resourceId !== selection.context.resourceId ||
        ref.identityId !== selection.context.identityId ||
        ref.originRunId !== selection.context.originRunId
      ) {
        fail('NATIVE_CONTEXT_SELECTION_CONFLICT', 'Observation native reference does not match current selection');
      }
      const native = readResourceRow(ref.resourceId);
      if (
        !native ||
        native.sessionId !== observation.sessionId ||
        native.runId !== ref.originRunId ||
        native.purpose !== 'acp_native_context' ||
        native.stage !== 'created' ||
        native.identity?.identityId !== ref.identityId
      ) {
        fail('NATIVE_CONTEXT_IDENTITY_CONFLICT', 'Observation native resource ownership or identity is invalid');
      }
      // 注：observation.nativeSessionId 与权威 NativeContextIdentity.locator（acpxRecordId/
      // backendSessionId/agentSessionId）的客户端专属映射属于 T3 resolver 的身份核验职责；
      // storage 不猜测 backendSessionId 是否等于 CLI 原生日志 session id。
    }
  };

  /**
   * 不可变追加一条来源观察。幂等 / 冲突 / bindingRevision 规则见设计 3.2。
   * live 参数为 true 时必须已通过 claim 校验并完成 live 资源核验。
   */
  const insertObservation = (observation: TranscriptSourceObservation, live: boolean): void => {
    const parsed = transcriptSourceObservationSchema.parse(observation);
    // 历史核验结论不能借 live claim 写入；历史路径也不能冒充 launch_observed。
    // inferred 是两条路径都可能产生的弱证据，二者都允许。
    if (live && parsed.proofKind === 'historical_verified') {
      fail('INSIGHT_INVALID_PROOF', 'Live source writer cannot record historical_verified proof');
    }
    if (!live && parsed.proofKind === 'launch_observed') {
      fail('INSIGHT_INVALID_PROOF', 'Historical proof must not impersonate launch_observed');
    }
    // 历史证据也必须属于已知 session（外键约束之外给出确定错误）。
    getSessionRunId(parsed.sessionId);

    const payloadJson = JSON.stringify(parsed);
    const existing = db
      .prepare('SELECT private_payload_json FROM insight_sources WHERE observation_id = ?')
      .get(parsed.observationId) as { private_payload_json: string } | undefined;
    if (existing) {
      if (existing.private_payload_json !== payloadJson) {
        fail('INSIGHT_OBSERVATION_CONFLICT', 'Observation with same id but different immutable payload already exists');
      }
      return; // 同 ID 同 payload 幂等。
    }

    db.prepare(
      `INSERT INTO insight_sources
         (observation_id, session_id, run_id, driver_instance_id, source_key, proof_kind, private_payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      parsed.observationId,
      parsed.sessionId,
      parsed.activeRunId,
      parsed.driverInstanceId,
      parsed.sourceKey ?? null,
      parsed.proofKind,
      payloadJson,
      parsed.capturedAt
    );

    // 只有绑定了 sourceKey 的来源才参与 bindingRevision；未绑定记录不能进解析请求。
    if (parsed.sourceKey) {
      const fingerprint = sourceFingerprint(parsed);
      const previous = db
        .prepare(
          `SELECT private_payload_json FROM insight_sources
           WHERE session_id = ? AND source_key = ? AND observation_id != ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(parsed.sessionId, parsed.sourceKey, parsed.observationId) as
        | { private_payload_json: string }
        | undefined;
      const previousFingerprint = previous
        ? sourceFingerprint(
            transcriptSourceObservationSchema.parse(JSON.parse(previous.private_payload_json))
          )
        : null;
      if (previousFingerprint !== fingerprint) {
        const row = ensureRefreshRow(parsed.sessionId);
        db.prepare('UPDATE insight_refresh SET binding_revision = binding_revision + 1 WHERE session_id = ?').run(
          row.session_id
        );
      }
    }
  };

  const appendObservedImmediate = db.transaction((observation: TranscriptSourceObservation, claim: RuntimeControlClaim) => {
    // 同步 BEGIN IMMEDIATE 内先校验 claim，再校验 activeRun / 资源归属 / identity。
    control.validateClaim(db, claim);
    validateLiveObservation(observation);
    insertObservation(observation, true);
  });
  const appendObservedRun = (observation: TranscriptSourceObservation, claim: RuntimeControlClaim): void => {
    appendObservedImmediate.immediate(observation, claim);
  };

  const decodeSnapshot = (row: SnapshotRow): SessionInsightSnapshotRecord => {
    if (row.tombstoned || !row.summary_json || !row.manifest_json || !row.host_evidence_json) {
      fail('INSIGHT_SNAPSHOT_GONE', `Snapshot ${row.snapshot_id} has been evicted`, 410);
    }
    return sessionInsightSnapshotRecordSchema.parse({
      snapshotId: row.snapshot_id,
      sessionId: row.session_id,
      cacheKey: row.cache_key,
      versions: {
        schemaVersion: row.schema_version,
        engineVersion: row.engine_version,
        parserVersion: row.parser_version,
        metricVersion: row.metric_version,
        redactionVersion: row.redaction_version
      },
      summary: JSON.parse(row.summary_json),
      manifest: JSON.parse(row.manifest_json),
      hostEvidence: JSON.parse(row.host_evidence_json),
      payloadBytes: row.payload_bytes,
      createdAt: row.created_at
    });
  };

  const selectActiveSnapshot = db.prepare(
    'SELECT * FROM insight_snapshots WHERE snapshot_id = ? AND tombstoned = 0'
  );

  /** 发布事务内的保留策略：每 session 当前 + 最近 1 份旧快照，再按 512MiB 全局淘汰最旧缓存。 */
  const enforceRetention = (maxPayloadBytes: number): { pruned: number; freed: number; retained: number; total: number } => {
    let pruned = 0;
    let freed = 0;
    const tombstone = (snapshotId: string): void => {
      const row = db
        .prepare('SELECT payload_bytes FROM insight_snapshots WHERE snapshot_id = ? AND tombstoned = 0')
        .get(snapshotId) as { payload_bytes: number } | undefined;
      if (!row) return;
      // 与指针清空原子完成；事件随快照淘汰物理删除。
      db.prepare('DELETE FROM insight_events WHERE snapshot_id = ?').run(snapshotId);
      db.prepare(
        `UPDATE insight_snapshots
           SET summary_json = NULL, manifest_json = NULL, host_evidence_json = NULL,
               payload_bytes = 0, tombstoned = 1
         WHERE snapshot_id = ?`
      ).run(snapshotId);
      db.prepare('UPDATE insight_refresh SET current_snapshot_id = NULL WHERE current_snapshot_id = ?').run(
        snapshotId
      );
      pruned += 1;
      freed += row.payload_bytes;
    };

    // 第一阶段：每 session 保留当前指针快照 + 最近 1 份旧快照。当前指针无条件保留：
    // cache hit 复用时指针可能指向 createdAt 较早的快照，不能仅按时间排名。
    const perSessionCandidates = db
      .prepare(
        `SELECT s.snapshot_id
           FROM insight_snapshots s
           JOIN (
             SELECT snapshot_id, session_id, created_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_id ORDER BY created_at DESC, snapshot_id DESC
                    ) AS position
             FROM insight_snapshots
             WHERE tombstoned = 0
               AND snapshot_id NOT IN (
                 SELECT current_snapshot_id FROM insight_refresh WHERE current_snapshot_id IS NOT NULL
               )
           ) ranked ON ranked.snapshot_id = s.snapshot_id
          WHERE s.tombstoned = 0 AND ranked.position > ?`
      )
      .all(SESSION_INSIGHT_LIMITS.maxRetainedSnapshotsPerSession - 1) as Array<{ snapshot_id: string }>;
    for (const candidate of perSessionCandidates) tombstone(candidate.snapshot_id);

    // 第二阶段：全局逻辑 payload 上限。先淘汰非当前指针的最久发布缓存；
    // 若仅各 session 的 current 总和仍超预算，则继续按最久发布淘汰其它 session 的 current——
    // 与清空该 session 指针原子完成，被淘汰的固定 snapshot 请求随后得到 410。
    // 预算是硬上限，不能因为“都是当前”就放任总量超限。
    const totalNow = (): number =>
      (db
        .prepare('SELECT COALESCE(SUM(payload_bytes), 0) AS total FROM insight_snapshots WHERE tombstoned = 0')
        .get() as { total: number }).total;

    const evictOldest = (excludeCurrent: boolean): void => {
      const rows = db
        .prepare(
          `SELECT snapshot_id FROM insight_snapshots
            WHERE tombstoned = 0
              ${excludeCurrent
                ? `AND snapshot_id NOT IN (
                     SELECT current_snapshot_id FROM insight_refresh WHERE current_snapshot_id IS NOT NULL
                   )`
                : ''}
            ORDER BY created_at ASC, snapshot_id ASC`
        )
        .all() as Array<{ snapshot_id: string }>;
      for (const candidate of rows) {
        if (totalNow() <= maxPayloadBytes) break;
        tombstone(candidate.snapshot_id);
      }
    };

    if (totalNow() > maxPayloadBytes) {
      evictOldest(true); // 先清非 current
      if (totalNow() > maxPayloadBytes) evictOldest(false); // 仍超限则连最旧 current 一起淘汰
    }

    const after = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS total
           FROM insight_snapshots WHERE tombstoned = 0`
      )
      .get() as { count: number; total: number };
    return { pruned, freed, retained: after.count, total: after.total };
  };

  const publishImmediate = db.transaction((params: PublishInsightParams): 'published' | 'binding_changed' => {
    const { sessionId, requestId, expectedBindingRevision, snapshot, events } = params;
    const record = ensureRefreshRow(sessionId);
    if (record.request_id !== requestId || record.state !== 'running') {
      fail('INSIGHT_REQUEST_CONFLICT', 'Only the current running request can publish a snapshot');
    }
    if (record.binding_revision !== expectedBindingRevision) {
      // 来源修订变化：本次置 failed(source_binding_changed)，旧 current_snapshot_id 保留，
      // 不提交混合结果。失败状态随本事务提交，由外层在提交后抛错。
      db.prepare(
        `UPDATE insight_refresh
           SET state = 'failed', error_code = 'source_binding_changed', finished_at = ?
         WHERE session_id = ? AND request_id = ? AND state = 'running'`
      ).run(nowIso(), sessionId, requestId);
      return 'binding_changed';
    }

    const validatedSnapshot = sessionInsightSnapshotRecordSchema.parse(snapshot);
    if (validatedSnapshot.sessionId !== sessionId) {
      fail('INSIGHT_INVALID_PAYLOAD', 'Snapshot session does not match the refresh session');
    }
    const storedEvents: SessionInsightEventItem[] = events.map((event, index) =>
      sessionInsightEventItemSchema.parse({ ...event, snapshotId: validatedSnapshot.snapshotId, ordinal: index })
    );

    const summaryJson = JSON.stringify(validatedSnapshot.summary);
    const manifestJson = JSON.stringify(validatedSnapshot.manifest);
    const hostEvidenceJson = JSON.stringify(validatedSnapshot.hostEvidence);
    if (Buffer.byteLength(hostEvidenceJson, 'utf8') > SESSION_INSIGHT_LIMITS.maxHostEvidenceBytes) {
      fail('INSIGHT_HOST_EVIDENCE_LIMIT', 'Host evidence exceeds 512 KiB persisted limit', 413);
    }
    const eventsBytes = storedEvents.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
    const payloadBytes =
      Buffer.byteLength(summaryJson, 'utf8') +
      Buffer.byteLength(manifestJson, 'utf8') +
      Buffer.byteLength(hostEvidenceJson, 'utf8') +
      eventsBytes;
    if (payloadBytes > SESSION_INSIGHT_LIMITS.maxPersistedPayloadBytes) {
      fail('INSIGHT_PAYLOAD_LIMIT', `Snapshot payload ${payloadBytes} exceeds ${SESSION_INSIGHT_LIMITS.maxPersistedPayloadBytes} bytes`, 413);
    }

    const finishedAt = nowIso();
    // 重复 cache key 复用既有完整快照，保留原 snapshotId / createdAt，只更新指针与最后检查时间。
    const existing = db
      .prepare('SELECT snapshot_id FROM insight_snapshots WHERE session_id = ? AND cache_key = ? AND tombstoned = 0')
      .get(sessionId, validatedSnapshot.cacheKey) as { snapshot_id: string } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE insight_refresh
           SET state = 'succeeded', current_snapshot_id = ?, error_code = NULL,
               finished_at = ?, last_checked_at = ?
         WHERE session_id = ?`
      ).run(existing.snapshot_id, finishedAt, finishedAt, sessionId);
      // 指针移动会改变本 session “当前 + 1 旧”的保留集合，复用路径同样执行保留策略。
      enforceRetention(SESSION_INSIGHT_LIMITS.maxInstanceDerivedPayloadBytes);
      return 'published' as const;
    }

    db.prepare(
      `INSERT INTO insight_snapshots
         (snapshot_id, session_id, cache_key, schema_version, engine_version, parser_version,
          metric_version, redaction_version, summary_json, manifest_json, host_evidence_json,
          payload_bytes, tombstoned, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      validatedSnapshot.snapshotId,
      sessionId,
      validatedSnapshot.cacheKey,
      validatedSnapshot.versions.schemaVersion,
      validatedSnapshot.versions.engineVersion,
      validatedSnapshot.versions.parserVersion,
      validatedSnapshot.versions.metricVersion,
      validatedSnapshot.versions.redactionVersion,
      summaryJson,
      manifestJson,
      hostEvidenceJson,
      payloadBytes,
      validatedSnapshot.createdAt
    );
    // 事件与快照在同一事务内插入：中途抛错整体回滚，不留下可读半快照。
    const insertEvent = db.prepare(
      `INSERT INTO insight_events
         (snapshot_id, ordinal, event_id, kind, tool_name, result_status, event_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    storedEvents.forEach((event) => {
      insertEvent.run(
        validatedSnapshot.snapshotId,
        event.ordinal,
        event.eventId,
        event.kind,
        event.toolName ?? null,
        event.resultStatus ?? null,
        JSON.stringify(event)
      );
    });

    db.prepare(
      `UPDATE insight_refresh
         SET state = 'succeeded', current_snapshot_id = ?, error_code = NULL,
             finished_at = ?, last_checked_at = ?
       WHERE session_id = ?`
    ).run(validatedSnapshot.snapshotId, finishedAt, finishedAt, sessionId);

    enforceRetention(SESSION_INSIGHT_LIMITS.maxInstanceDerivedPayloadBytes);
    return 'published' as const;
  });

  /**
   * 同步读取一个 session 的任务原始行（含 ledger_v1 已核验请求与当前 attempt 原始 JSON）。
   * 供 catalog 投影与 readHostEvidenceRaw 复用；必须在调用方事务/短读事务内执行。
   */
  const loadRawTaskRows = (sessionId: string): SessionInsightRawTaskRow[] => {
    const taskRows = db
      .prepare(
        `SELECT id, prompt, status, created_at, execution_context, current_attempt_id
           FROM tasks WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(sessionId) as Array<{
      id: string;
      prompt: string;
      status: string;
      created_at: string;
      execution_context: string | null;
      current_attempt_id: string | null;
    }>;
    const selectRequest = db.prepare('SELECT request_json FROM task_requests WHERE task_id = ?');
    const selectAttempt = db.prepare('SELECT json FROM task_attempts WHERE id = ?');
    return taskRows.map(task => ({
      id: task.id,
      prompt: task.prompt,
      status: task.status,
      createdAt: task.created_at,
      ...(task.execution_context ? { executionContext: JSON.parse(task.execution_context) } : {}),
      acceptedRequest: (() => {
        const requestRow = selectRequest.get(task.id) as { request_json: string | null } | undefined;
        return requestRow?.request_json ? JSON.parse(requestRow.request_json) : null;
      })(),
      currentAttempt: (() => {
        if (!task.current_attempt_id) return null;
        const attemptRow = selectAttempt.get(task.current_attempt_id) as { json: string } | undefined;
        return attemptRow ? JSON.parse(attemptRow.json) : null;
      })()
    }));
  };

  const toRefreshRecord = (row: RefreshRow): SessionInsightRefreshRecord => ({    sessionId: row.session_id,
    requestId: row.request_id,
    state: row.state,
    bindingRevision: row.binding_revision,
    currentSnapshotId: row.current_snapshot_id,
    processRunId: row.process_run_id,
    timestamps: { queuedAt: row.queued_at, startedAt: row.started_at, finishedAt: row.finished_at },
    errorCode: row.error_code
  });

  const availabilityFromManifest = (manifest: SessionInsightManifest): SessionInsightStatus['availability'] => {
    const complete = manifest.sources.every(
      source => source.matchStatus === 'matched' && source.status === 'ok'
    );
    return complete ? 'complete' : 'partial';
  };

  return {
    bindSources(claim: RuntimeControlClaim): SessionInsightLiveSourcesWriter {
      return {
        appendObserved(observation: TranscriptSourceObservation): void {
          appendObservedRun(observation, claim);
        }
      };
    },

    appendHistoricalProof(proof: TranscriptSourceObservation): void {
      db.transaction(() => insertObservation(proof, false)).immediate();
    },

    listSources(sessionId: string): TranscriptSourceObservation[] {
      const rows = db
        .prepare(
          'SELECT private_payload_json FROM insight_sources WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
        )
        .all(sessionId) as Array<{ private_payload_json: string }>;
      return rows.map(row => transcriptSourceObservationSchema.parse(JSON.parse(row.private_payload_json)));
    },

    getState(sessionId: string): SessionInsightRefreshRecord {
      const row = db.prepare('SELECT * FROM insight_refresh WHERE session_id = ?').get(sessionId) as
        | RefreshRow
        | undefined;
      if (row) return toRefreshRecord(row);
      return {
        sessionId,
        requestId: null,
        state: 'idle',
        bindingRevision: 0,
        currentSnapshotId: null,
        processRunId: null,
        timestamps: { queuedAt: null, startedAt: null, finishedAt: null },
        errorCode: null
      };
    },

    getStatus(sessionId: string): SessionInsightStatus {
      getSessionRunId(sessionId);
      const row = db.prepare('SELECT * FROM insight_refresh WHERE session_id = ?').get(sessionId) as
        | RefreshRow
        | undefined;
      const state = row?.state ?? 'idle';
      let availability: SessionInsightStatus['availability'] = 'none';
      if (row?.current_snapshot_id) {
        const snapshotRow = selectActiveSnapshot.get(row.current_snapshot_id) as SnapshotRow | undefined;
        if (snapshotRow && snapshotRow.manifest_json) {
          const manifest = JSON.parse(snapshotRow.manifest_json) as SessionInsightManifest;
          availability = availabilityFromManifest(manifest);
        }
      }
      return {
        sessionId,
        refreshState: refreshStates.includes(state) ? state : 'idle',
        availability,
        // storage 不复核文件内容，不宣称字节级新鲜；显式轻量检查由 T4 完成。
        freshness: 'unknown',
        currentSnapshotId: row?.current_snapshot_id ?? null,
        requestId: row?.request_id ?? null,
        errorCode: row?.error_code ?? null,
        lastCheckedAt: row?.last_checked_at ?? null
      };
    },

    beginRefresh(sessionId: string, requestId: string, processRunId?: string) {
      return db.transaction((): { requestId: string; state: RefreshState; bindingRevision: number; merged: boolean } => {
        getSessionRunId(sessionId);
        const existing = ensureRefreshRow(sessionId);
        if (existing.request_id && (existing.state === 'queued' || existing.state === 'running')) {
          return {
            requestId: existing.request_id,
            state: existing.state,
            bindingRevision: existing.binding_revision,
            merged: true
          };
        }
        const queuedCount = db
          .prepare("SELECT COUNT(*) AS c FROM insight_refresh WHERE state = 'queued'")
          .get() as { c: number };
        if (queuedCount.c >= SESSION_INSIGHT_LIMITS.maxQueuedJobsPerInstance) {
          fail('INSIGHT_QUEUE_FULL', 'Session insight refresh queue is full', 429);
        }
        const queuedAt = nowIso();
        db.prepare(
          `UPDATE insight_refresh
             SET request_id = ?, state = 'queued', process_run_id = ?,
                 queued_at = ?, started_at = NULL, finished_at = NULL, error_code = NULL
           WHERE session_id = ?`
        ).run(requestId, processRunId ?? null, queuedAt, sessionId);
        return { requestId, state: 'queued', bindingRevision: existing.binding_revision, merged: false };
      }).immediate();
    },

    markRunning(sessionId: string, requestId: string, processRunId?: string): boolean {
      return db.transaction((): boolean => {
        // 全实例至多 1 个 running 作业（5.3）。已有其他 session 在 running 时本次不晋级，
        // 作业保持 queued，由调度器稍后重新领取；同 session 的行不受自身影响。
        const result = db
          .prepare(
            `UPDATE insight_refresh
                SET state = 'running', started_at = ?, process_run_id = COALESCE(?, process_run_id)
              WHERE session_id = ? AND request_id = ? AND state = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM insight_refresh
                    WHERE state = 'running' AND session_id != ?
                )`
          )
          .run(nowIso(), processRunId ?? null, sessionId, requestId, sessionId);
        return result.changes === 1;
      }).immediate();
    },

    publish(params: PublishInsightParams): void {
      const result = publishImmediate.immediate(params);
      if (result === 'binding_changed') {
        // failed(source_binding_changed) 状态已随事务提交；此处再抛出供调用方中止作业。
        fail('INSIGHT_SOURCE_BINDING_CHANGED', 'Source binding revision changed during analysis');
      }
    },

    resolveCacheHit(sessionId: string, requestId: string, cacheKey: string, expectedBindingRevision: number) {
      return db.transaction(():
        | { outcome: 'hit'; snapshotId: string }
        | { outcome: 'miss' }
        | { outcome: 'binding_changed' } => {
        const row = ensureRefreshRow(sessionId);
        if (row.request_id !== requestId || row.state !== 'running') return { outcome: 'miss' };
        // Binding revision is authoritative even on a cache hit: a source change during analysis
        // must fail the request rather than silently reusing an older snapshot.
        if (row.binding_revision !== expectedBindingRevision) {
          db.prepare(
            `UPDATE insight_refresh
               SET state = 'failed', error_code = 'source_binding_changed', finished_at = ?
             WHERE session_id = ? AND request_id = ? AND state = 'running'`
          ).run(nowIso(), sessionId, requestId);
          return { outcome: 'binding_changed' };
        }
        const existing = db
          .prepare('SELECT snapshot_id FROM insight_snapshots WHERE session_id = ? AND cache_key = ? AND tombstoned = 0')
          .get(sessionId, cacheKey) as { snapshot_id: string } | undefined;
        if (!existing) return { outcome: 'miss' };
        const checkedAt = nowIso();
        db.prepare(
          `UPDATE insight_refresh
             SET state = 'succeeded', current_snapshot_id = ?, error_code = NULL,
                 finished_at = ?, last_checked_at = ?
           WHERE session_id = ? AND request_id = ? AND state = 'running'`
        ).run(existing.snapshot_id, checkedAt, checkedAt, sessionId, requestId);
        enforceRetention(SESSION_INSIGHT_LIMITS.maxInstanceDerivedPayloadBytes);
        return { outcome: 'hit', snapshotId: existing.snapshot_id };
      }).immediate();
    },

    fail(sessionId: string, requestId: string, errorCode: string): boolean {
      return db.transaction((): boolean => {
        const result = db
          .prepare(
            `UPDATE insight_refresh
                SET state = 'failed', error_code = ?, finished_at = ?
              WHERE session_id = ? AND request_id = ? AND state IN ('queued', 'running')`
          )
          .run(errorCode, nowIso(), sessionId, requestId);
        // current_snapshot_id 不在 SET 中：失败保留上一份可读快照。
        return result.changes === 1;
      }).immediate();
    },

    cancel(sessionId: string, requestId: string): boolean {
      return db.transaction((): boolean => {
        const result = db
          .prepare(
            `UPDATE insight_refresh
                SET state = 'cancelled', finished_at = ?
              WHERE session_id = ? AND request_id = ? AND state IN ('queued', 'running')`
          )
          .run(nowIso(), sessionId, requestId);
        return result.changes === 1;
      }).immediate();
    },

    getSnapshot(sessionId: string, snapshotId?: string): SessionInsightSnapshotRecord | undefined {
      const row = db.transaction((): SnapshotRow | undefined => {
        if (snapshotId) {
          // Include tombstoned rows so a fixed, evicted snapshot can return 410 Gone
          // instead of looking like it never existed.
          return db
            .prepare('SELECT * FROM insight_snapshots WHERE snapshot_id = ?')
            .get(snapshotId) as SnapshotRow | undefined;
        }
        const refresh = db.prepare('SELECT current_snapshot_id FROM insight_refresh WHERE session_id = ?').get(sessionId) as
          | { current_snapshot_id: string | null }
          | undefined;
        if (!refresh?.current_snapshot_id) return undefined;
        return db
          .prepare('SELECT * FROM insight_snapshots WHERE snapshot_id = ?')
          .get(refresh.current_snapshot_id) as SnapshotRow | undefined;
      })();
      if (!row || row.session_id !== sessionId) return undefined;
      return decodeSnapshot(row);
    },

    isSnapshotTombstoned(sessionId: string, snapshotId: string): boolean {
      const row = db
        .prepare('SELECT tombstoned FROM insight_snapshots WHERE snapshot_id = ? AND session_id = ?')
        .get(snapshotId, sessionId) as { tombstoned: number } | undefined;
      return row?.tombstoned === 1;
    },

    findSnapshotByCacheKey(sessionId: string, cacheKey: string): SessionInsightSnapshotRecord | undefined {
      const row = db
        .prepare(
          'SELECT * FROM insight_snapshots WHERE session_id = ? AND cache_key = ? AND tombstoned = 0'
        )
        .get(sessionId, cacheKey) as SnapshotRow | undefined;
      return row ? decodeSnapshot(row) : undefined;
    },

    listEvents(query: SessionInsightEventsQuery): SessionInsightEventsResponse {
      return db.transaction((): SessionInsightEventsResponse => {
        // 固定快照必须存在且未被淘汰，不跨快照混页。
        const snapshotRow = db
          .prepare('SELECT snapshot_id FROM insight_snapshots WHERE snapshot_id = ? AND tombstoned = 0')
          .get(query.snapshotId) as { snapshot_id: string } | undefined;
        if (!snapshotRow) {
          fail('INSIGHT_SNAPSHOT_GONE', `Snapshot ${query.snapshotId} does not exist or has been evicted`, 410);
        }

        const filterKey = JSON.stringify([
          query.kind ?? null,
          query.tool ?? null,
          query.result ?? null
        ]);
        let ordinal = -1;
        if (query.cursor) {
          // 严格游标结构：snapshotId 绑定、filter 绑定、ordinal 必须是非负安全整数。
          let cursor: unknown;
          try {
            cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
          } catch {
            fail('INSIGHT_INVALID_CURSOR', 'Cursor is not valid base64 JSON', 400);
          }
          if (
            !cursor ||
            typeof cursor !== 'object' ||
            Array.isArray(cursor) ||
            (cursor as Record<string, unknown>).snapshotId !== query.snapshotId ||
            (cursor as Record<string, unknown>).filter !== filterKey ||
            typeof (cursor as Record<string, unknown>).ordinal !== 'number' ||
            !Number.isSafeInteger((cursor as { ordinal: number }).ordinal) ||
            (cursor as { ordinal: number }).ordinal < 0
          ) {
            fail('INSIGHT_INVALID_CURSOR', 'Cursor is not valid for this snapshot and filter', 400);
          }
          ordinal = (cursor as { ordinal: number }).ordinal;
        }

        // 业务 filter（不含游标），用于 totalMatching 全量计数。
        const filterConditions = ['snapshot_id = ?'];
        const filterParams: unknown[] = [query.snapshotId];
        if (query.kind) {
          filterConditions.push('kind = ?');
          filterParams.push(query.kind);
        }
        if (query.tool) {
          filterConditions.push('tool_name = ?');
          filterParams.push(query.tool);
        }
        if (query.result) {
          filterConditions.push('result_status = ?');
          filterParams.push(query.result);
        }
        // 分页只在 filter 之上追加 ordinal 游标。
        const pageConditions = [...filterConditions, 'ordinal > ?'];
        const pageParams = [...filterParams, ordinal];
        const filterWhere = filterConditions.join(' AND ');
        const pageWhere = pageConditions.join(' AND ');

        const totalRow = db
          .prepare(`SELECT COUNT(*) AS c FROM insight_events WHERE ${filterWhere}`)
          .get(...filterParams) as { c: number };

        // 取 limit+1 判断是否还有下一页，避免在恰好取满一页时多吐一个无效 cursor。
        const rows = db
          .prepare(
            `SELECT event_json, ordinal FROM insight_events WHERE ${pageWhere}
             ORDER BY ordinal ASC LIMIT ?`
          )
          .all(...pageParams, query.limit + 1) as Array<{ event_json: string; ordinal: number }>;
        const hasMore = rows.length > query.limit;
        const page = hasMore ? rows.slice(0, query.limit) : rows;
        const items = page.map(row => sessionInsightEventItemSchema.parse(JSON.parse(row.event_json)));
        let nextCursor: string | null = null;
        if (hasMore && page.length > 0) {
          nextCursor = encodeCursor({
            snapshotId: query.snapshotId,
            ordinal: page[page.length - 1]!.ordinal,
            filter: filterKey
          });
        }
        return { snapshotId: query.snapshotId, items, nextCursor, totalMatching: totalRow.c };
      })();
    },

    listSummaryRows(options: SessionInsightSummaryRawOptions = {}): SessionInsightSummaryRawResult {
      return db.transaction((): SessionInsightSummaryRawResult => {
        // 内部 limit 也做严格边界校验，供 T4c 用内部分页读全 catalog。
        const limit = options.limit ?? SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageDefault;
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageMax) {
          fail('INSIGHT_INVALID_PAGINATION', `limit must be an integer in [1, ${SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageMax}]`, 400);
        }

        const conditions: string[] = [];
        const params: unknown[] = [];
        if (!options.includeArchived) {
          conditions.push('s.archived_at IS NULL');
        }
        if (options.agentId) {
          conditions.push('s.agent_id = ?');
          params.push(options.agentId);
        }
        if (options.sessionId) {
          conditions.push('s.id = ?');
          params.push(options.sessionId);
        }
        if (options.from) {
          conditions.push('s.created_at >= ?');
          params.push(options.from);
        }
        if (options.to) {
          conditions.push('s.created_at < ?');
          params.push(options.to);
        }
        // cursor 绑定本次 filter，防止换筛选条件后复用游标跨集合翻页。
        const filterKey = JSON.stringify([
          options.includeArchived ?? false,
          options.agentId ?? null,
          options.sessionId ?? null,
          options.from ?? null,
          options.to ?? null
        ]);

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM sessions s ${where}`).get(...params) as {
          c: number;
        };

        let cursorCreatedAt: string | null = null;
        let cursorSessionId: string | null = null;
        if (options.cursor) {
          let cursor: unknown;
          try {
            cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
          } catch {
            fail('INSIGHT_INVALID_CURSOR', 'Catalog cursor is not valid base64 JSON', 400);
          }
          const c = cursor as Record<string, unknown> | null;
          if (
            !c || typeof c !== 'object' || Array.isArray(c) ||
            typeof c.createdAt !== 'string' || !Number.isFinite(Date.parse(c.createdAt)) ||
            typeof c.sessionId !== 'string' || c.sessionId.length === 0 ||
            c.filterKey !== filterKey
          ) {
            fail('INSIGHT_INVALID_CURSOR', 'Catalog cursor is malformed or not bound to these filters', 400);
          }
          cursorCreatedAt = c.createdAt as string;
          cursorSessionId = c.sessionId as string;
        }
        const pageConditions = [...conditions];
        const pageParams = [...params];
        if (cursorCreatedAt !== null && cursorSessionId !== null) {
          pageConditions.push('(s.created_at > ? OR (s.created_at = ? AND s.id > ?))');
          pageParams.push(cursorCreatedAt, cursorCreatedAt, cursorSessionId);
        }
        const pageWhere = pageConditions.length ? `WHERE ${pageConditions.join(' AND ')}` : '';
        const sessionRows = db
          .prepare(
            `SELECT s.id AS session_id, s.agent_id AS agent_id, s.cwd AS cwd,
                    s.model AS model, s.source AS source, s.source_id AS source_id,
                    s.archived_at AS archived_at, s.created_at AS created_at, s.updated_at AS updated_at,
                    r.request_id AS request_id, r.state AS state, r.error_code AS error_code,
                    COALESCE(r.binding_revision, 0) AS binding_revision,
                    r.current_snapshot_id AS current_snapshot_id, r.last_checked_at AS last_checked_at,
                    r.queued_at AS queued_at, r.started_at AS started_at, r.finished_at AS finished_at,
                    w.value AS workspace_json
             FROM sessions s
             LEFT JOIN insight_refresh r ON r.session_id = s.id
             LEFT JOIN configs w ON w.key = 'runtime_workspace:' || s.id
             ${pageWhere}
             ORDER BY s.created_at ASC, s.id ASC
             LIMIT ?`
          )
          .all(...pageParams, limit + 1) as Array<{
          session_id: string;
          agent_id: string;
          cwd: string;
          model: string | null;
          source: string | null;
          source_id: string | null;
          archived_at: string | null;
          created_at: string;
          updated_at: string;
          request_id: string | null;
          state: RefreshState | null;
          error_code: string | null;
          binding_revision: number;
          current_snapshot_id: string | null;
          last_checked_at: string | null;
          queued_at: string | null;
          started_at: string | null;
          finished_at: string | null;
          workspace_json: string | null;
        }>;

        const hasMore = sessionRows.length > limit;
        const page = hasMore ? sessionRows.slice(0, limit) : sessionRows;

        const selectSnapshot = db.prepare('SELECT * FROM insight_snapshots WHERE snapshot_id = ? AND tombstoned = 0');

        const rows: SessionInsightSummaryRawRow[] = page.map(row => {
          let snapshot: SessionInsightSummaryRawRow['snapshot'];
          if (row.current_snapshot_id) {
            const snapshotRow = selectSnapshot.get(row.current_snapshot_id) as SnapshotRow | undefined;
            if (snapshotRow && snapshotRow.summary_json && snapshotRow.manifest_json && snapshotRow.host_evidence_json) {
              snapshot = {
                snapshotId: snapshotRow.snapshot_id,
                cacheKey: snapshotRow.cache_key,
                payloadBytes: snapshotRow.payload_bytes,
                createdAt: snapshotRow.created_at,
                summary: JSON.parse(snapshotRow.summary_json) as SessionInsightSummary,
                manifest: JSON.parse(snapshotRow.manifest_json) as SessionInsightManifest,
                hostEvidence: JSON.parse(snapshotRow.host_evidence_json) as HostEvidenceSnapshot
              };
            }
          }
          return {
            sessionId: row.session_id,
            agentId: row.agent_id,
            cwd: row.cwd,
            // runtime 从 runtime_workspace:<sid> 记录派生 workspaceSourceCwd；仅回传已 parse 的
            // sourceCwd 字符串事实，无法解析时为 null（由 runtime 权威，storage 不猜列、不回退 cwd）。
            workspaceSourceCwd: (() => {
              if (!row.workspace_json) return null;
              try {
                const record = JSON.parse(row.workspace_json) as { sourceCwd?: unknown };
                return typeof record.sourceCwd === 'string' && record.sourceCwd.length > 0
                  ? record.sourceCwd
                  : null;
              } catch {
                return null;
              }
            })(),
            model: row.model,
            source: row.source,
            sourceId: row.source_id,
            archivedAt: row.archived_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            refreshState: row.state ?? 'idle',
            requestId: row.request_id,
            errorCode: row.error_code,
            bindingRevision: row.binding_revision,
            currentSnapshotId: row.current_snapshot_id,
            lastCheckedAt: row.last_checked_at,
            timestamps: {
              queuedAt: row.queued_at,
              startedAt: row.started_at,
              finishedAt: row.finished_at
            },
            ...(snapshot ? { snapshot } : {}),
            tasks: loadRawTaskRows(row.session_id)
          };
        });

        let nextCursor: string | null = null;
        if (hasMore && page.length > 0) {
          const last = page[page.length - 1]!;
          nextCursor = encodeCursor({ createdAt: last.created_at, sessionId: last.session_id, filterKey });
        }
        return { rows, totalMatching: totalRow.c, nextCursor };
      })();
    },

    prune(maxPayloadBytes = SESSION_INSIGHT_LIMITS.maxInstanceDerivedPayloadBytes): InsightPruneResult {
      return db.transaction((): InsightPruneResult => {
        const result = enforceRetention(maxPayloadBytes);
        return {
          prunedSnapshotsCount: result.pruned,
          freedBytes: result.freed,
          retainedSnapshotsCount: result.retained,
          totalPayloadBytes: result.total
        };
      }).immediate();
    },

    markInterrupted(currentProcessRunId?: string): number {
      return db.transaction((): number => {
        // 中断所有非当前进程的 queued/running，包括上一进程入队后未及领取（process_run_id 为空）的行。
        const result = db
          .prepare(
            `UPDATE insight_refresh
                SET state = 'interrupted', finished_at = ?
              WHERE state IN ('queued', 'running')
                AND (process_run_id IS NULL OR process_run_id != ?)`
          )
          .run(nowIso(), currentProcessRunId ?? null);
        return result.changes;
      }).immediate();
    },

    readTransaction<T>(work: () => T): T {
      return db.transaction(work)();
    },

    readHostEvidenceRaw(sessionId: string): HostEvidenceRaw {
      return db.transaction((): HostEvidenceRaw => {
        const session = db
          .prepare(
            `SELECT id, run_id, agent_id, model, source, source_id, cwd
               FROM sessions WHERE id = ?`
          )
          .get(sessionId) as
          | {
              id: string;
              run_id: string;
              agent_id: string;
              model: string | null;
              source: string | null;
              source_id: string | null;
              cwd: string;
            }
          | undefined;
        if (!session) fail('INSIGHT_NOT_FOUND', `Session ${sessionId} does not exist`, 404);

        // 核验记录存于 configs，键前缀 runtime_verification:<sessionId>:。用闭区间范围而非 LIKE，
        // 避免 sessionId 中的 _ / % 被当成通配符而串到别的 session（同 task-execution 前缀方案）。
        const verificationPrefix = `runtime_verification:${sessionId}:`;
        const verificationUpper = `runtime_verification:${sessionId};`; // ':'(0x3A) 的下一个字符
        const verificationRows = db
          .prepare('SELECT key, value FROM configs WHERE key >= ? AND key < ? ORDER BY key')
          .all(verificationPrefix, verificationUpper) as Array<{ key: string; value: string }>;
        const verificationRecords = verificationRows.map(row => ({
          key: row.key,
          value: (() => {
            try {
              return JSON.parse(row.value);
            } catch {
              return row.value;
            }
          })()
        }));

        const steeringRows = db
          .prepare(
            `SELECT id, task_id, run_id, state, revision, json
               FROM task_steering_operations WHERE session_id = ? ORDER BY rowid`
          )
          .all(sessionId) as Array<{
          id: string;
          task_id: string;
          run_id: string;
          state: string;
          revision: number;
          json: string;
        }>;
        const steeringOperations = steeringRows.map(row => ({
          id: row.id,
          taskId: row.task_id,
          runId: row.run_id,
          state: row.state,
          revision: row.revision,
          payload: JSON.parse(row.json)
        }));

        // 费用只读投影：原样返回本 session 的费用行，不汇总、不回填。
        const usageEntries = db
          .prepare('SELECT * FROM usage_ledger WHERE session_id = ? ORDER BY recorded_at, rowid')
          .all(sessionId) as Array<Record<string, unknown>>;

        const nativeSelectionRow = db
          .prepare('SELECT value FROM configs WHERE key = ?')
          .get(`runtime_native_context:${sessionId}`) as { value: string } | undefined;
        const nativeSelection = nativeSelectionRow ? JSON.parse(nativeSelectionRow.value) : null;

        return {
          capturedAt: nowIso(),
          session: {
            id: session.id,
            runId: session.run_id,
            agentId: session.agent_id,
            model: session.model,
            source: session.source,
            sourceId: session.source_id,
            cwd: session.cwd
          },
          tasks: loadRawTaskRows(sessionId),
          verificationRecords,
          steeringOperations,
          usageEntries,
          nativeSelection
        };
      })();
    }
  };
}
