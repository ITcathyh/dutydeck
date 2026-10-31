import type Database from 'better-sqlite3';
import type { HistoryRetentionResult } from '@dutydeck/shared';

/**
 * 历史数据保留：只动已结束任务的数据，未结、"结果未知"、旧版待退役会话的数据一律不碰。
 * Web 要求同一会话的事件序号连续，终端帧只清空内容、保留行；其余表按批删除。
 */

/**
 * 终端整屏快照（driver 每 200ms 一帧，`screen: true`）每轮只留最近这么多帧的内容。
 * 帧至少间隔 200ms，50 帧覆盖最后 10 秒以上的屏幕变化，够卡片和 Web 拼出收尾时的滚屏；
 * 单帧实测不超过 2KB，每轮正文最多约 100KB。
 */
export const TERMINAL_SCREENS_TO_KEEP = 50;
/** 终端逐帧、会话状态快照和工具调用镜像保留 30 天：一个月内的排障和回看不受影响；更早的每轮只留最后一屏。 */
export const HISTORY_RETENTION_DAYS = 30;
/** 群策略、群绑定、群事实、角色的修订记录每个实体只留最近 20 条；没有读方，只做排障参考。 */
export const ENTITY_VERSIONS_TO_KEEP = 20;
/** 清空内容后的终端帧：保留行与序号，读方按空屏处理。 */
export const COMPACTED_TERMINAL_SCREEN = '{"text":"","screen":true,"compacted":true}';

/** 每个写事务最多处理的行数；批与批之间让出事件循环，不长时间占写锁。 */
const BATCH = 500;
/** 扫描事件表时每次读的 rowid 跨度。 */
const SCAN = 5_000;
const DAY_MS = 86_400_000;
const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));

const isScreen = (data: string) => `CASE WHEN json_valid(${data}) THEN json_extract(${data},'$.screen') END = 1`;

/** 新帧写入后清空本轮倒数第 TERMINAL_SCREENS_TO_KEEP+1 帧；每帧只移出一帧，与写入同一事务。 */
export function compactTerminalScreens(db: Database.Database, attemptId: string): void {
  const evicted = db.prepare(`SELECT id, data FROM events WHERE attempt_id=? AND type='raw_terminal' AND ${isScreen('data')}
    ORDER BY sequence DESC LIMIT 1 OFFSET ?`).get(attemptId, TERMINAL_SCREENS_TO_KEEP) as { id: string; data: string } | undefined;
  if (evicted && evicted.data !== COMPACTED_TERMINAL_SCREEN) db.prepare('UPDATE events SET data=? WHERE id=?').run(COMPACTED_TERMINAL_SCREEN, evicted.id);
}

// 已结束：attempt 已结算，任务不在待核对，结算结果也不是"结果未知"。
const settledAttempt = (attemptId: string) => `EXISTS (SELECT 1 FROM task_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=${attemptId}
  AND a.state='settled' AND t.status<>'reconcile_required'
  AND COALESCE(json_extract(a.json,'$.outcome'),'')<>'unknown' AND COALESCE(json_extract(a.json,'$.settlement.outcome'),'')<>'unknown')`;
// 会话没有任何未结 attempt，也不是旧版待退役会话（退役核对会对整份会话记录做摘要）。
const quietSession = (sessionId: string) => `NOT EXISTS (SELECT 1 FROM task_attempts a WHERE a.session_id=${sessionId} AND a.state<>'settled')
  AND NOT EXISTS (SELECT 1 FROM driver_resources r WHERE r.session_id=${sessionId} AND r.id LIKE 'legacy_resource_%')`;
const legacySession = (sessionId: string) => `EXISTS (SELECT 1 FROM driver_resources r WHERE r.session_id=${sessionId} AND r.id LIKE 'legacy_resource_%')`;

export function createRetentionRepository(db: Database.Database, ledgerAuthority: () => 'legacy' | 'ledger_v1') {
  return {
    /** signal 中止时在批与批之间停下，已提交的批次保留。 */
    async prune(options: { now?: number; signal?: AbortSignal } = {}): Promise<HistoryRetentionResult> {
      const cutoff = new Date((options.now ?? Date.now()) - HISTORY_RETENTION_DAYS * DAY_MS).toISOString();
      const stopped = () => options.signal?.aborted === true;
      const inBatches = async <T>(ids: T[], apply: (id: T) => number): Promise<number> => {
        let changed = 0;
        for (let start = 0; start < ids.length && !stopped(); start += BATCH) {
          const batch = ids.slice(start, start + BATCH);
          changed += db.transaction(() => batch.reduce((sum, id) => sum + apply(id), 0)).immediate();
          await yieldTurn();
        }
        return changed;
      };
      const pages = async <T>(page: (after: T) => T[], after: T, apply: (id: T) => number): Promise<number> => {
        let changed = 0;
        while (!stopped()) {
          const ids = page(after);
          if (!ids.length) break;
          changed += await inBatches(ids, apply);
          after = ids.at(-1)!;
        }
        return changed;
      };

      /** 超过保留期的终端帧：每轮（或会话里不属于任何轮的帧）只留最后一帧的内容。 */
      const terminalFrames = async () => {
        const candidates = db.prepare(`SELECT e.id FROM events e WHERE e.rowid>? AND e.rowid<=? AND e.type='raw_terminal' AND e.timestamp<? AND e.data<>?
          AND EXISTS (SELECT 1 FROM sessions s WHERE s.id=e.session_id AND s.protocol='pty-cli')
          AND CASE WHEN e.attempt_id IS NOT NULL
            THEN ${settledAttempt('e.attempt_id')} AND NOT ${legacySession('e.session_id')}
              AND EXISTS (SELECT 1 FROM events l WHERE l.attempt_id=e.attempt_id AND l.sequence>e.sequence AND l.type='raw_terminal')
            ELSE ${quietSession('e.session_id')}
              AND EXISTS (SELECT 1 FROM events l WHERE l.session_id=e.session_id AND l.sequence>e.sequence AND l.attempt_id IS NULL AND l.type='raw_terminal') END`);
        const hasOld = db.prepare('SELECT 1 FROM events WHERE rowid>? AND rowid<=? AND timestamp<? LIMIT 1');
        const compact = db.prepare('UPDATE events SET data=? WHERE id=?');
        const last = (db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM events').get() as { n: number }).n;
        let changed = 0;
        // rowid 大致随时间递增：扫到一整段都比保留期新就停，其余留给下一轮。
        for (let after = 0; after < last && !stopped(); after += SCAN) {
          if (!hasOld.get(after, after + SCAN, cutoff)) break;
          const ids = (candidates.all(after, after + SCAN, cutoff, COMPACTED_TERMINAL_SCREEN) as Array<{ id: string }>).map(row => row.id);
          changed += await inBatches(ids, id => compact.run(COMPACTED_TERMINAL_SCREEN, id).changes);
          await yieldTurn();
        }
        return changed;
      };

      /** 旧版本给每次会话状态变化存的完整快照（键 session_state:*）；现在已不再写，也没有读方。 */
      const sessionStateCommands = () => {
        const page = db.prepare(`SELECT c.id FROM task_execution_commands c WHERE c.id>? AND c.id<'session_state;'
          AND json_valid(c.payload) AND json_valid(c.result) AND json_extract(c.result,'$.session.updatedAt')<?
          AND CASE WHEN json_extract(c.payload,'$.attemptId') IS NOT NULL
            THEN ${settledAttempt("json_extract(c.payload,'$.attemptId')")} AND NOT ${legacySession("json_extract(c.payload,'$.sessionId')")}
            ELSE json_extract(c.payload,'$.sessionId') IS NOT NULL AND ${quietSession("json_extract(c.payload,'$.sessionId')")} END
          ORDER BY c.id LIMIT ?`);
        const remove = db.prepare('DELETE FROM task_execution_commands WHERE id=?');
        return pages(after => (page.all(after, cutoff, BATCH) as Array<{ id: string }>).map(row => row.id), 'session_state:', id => remove.run(id).changes);
      };

      /** tool_calls 是工具事件的镜像（事件本身保留），会话没有未结任务时删超过保留期的。 */
      const toolCalls = () => {
        const page = db.prepare(`SELECT c.rowid AS id FROM tool_calls c WHERE c.rowid>? AND c.updated_at<? AND ${quietSession('c.session_id')} ORDER BY c.rowid LIMIT ?`);
        const remove = db.prepare('DELETE FROM tool_calls WHERE rowid=?');
        return pages(after => (page.all(after, cutoff, BATCH) as Array<{ id: number }>).map(row => row.id), 0, id => remove.run(id).changes);
      };

      /** 每个实体按修订号只留最近 ENTITY_VERSIONS_TO_KEEP 条。 */
      const entityVersions = async () => {
        const entities = db.prepare('SELECT entity_kind AS kind, entity_id AS id FROM wp1a_entity_versions GROUP BY entity_kind, entity_id HAVING COUNT(*)>?')
          .all(ENTITY_VERSIONS_TO_KEEP) as Array<{ kind: string; id: string }>;
        const stale = db.prepare('SELECT id FROM wp1a_entity_versions WHERE entity_kind=? AND entity_id=? ORDER BY to_revision DESC, id DESC LIMIT -1 OFFSET ?');
        const remove = db.prepare('DELETE FROM wp1a_entity_versions WHERE id=?');
        let changed = 0;
        for (const entity of entities) {
          if (stopped()) break;
          changed += await inBatches((stale.all(entity.kind, entity.id, ENTITY_VERSIONS_TO_KEEP) as Array<{ id: number }>).map(row => row.id), id => remove.run(id).changes);
        }
        return changed;
      };

      const ledger = ledgerAuthority() === 'ledger_v1';
      return {
        terminalFrames: ledger ? await terminalFrames() : 0,
        sessionStateCommands: ledger ? await sessionStateCommands() : 0,
        toolCalls: ledger ? await toolCalls() : 0,
        entityVersions: await entityVersions()
      };
    }
  };
}
