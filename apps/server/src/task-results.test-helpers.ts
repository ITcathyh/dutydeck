import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ExecutionRepository } from '@dutydeck/shared';

export const sampleOutput = 'original task output';

/** Both samples have the same settled turn. Historical ledgers may lack its completed event. */
export function settlementSample(execution: ExecutionRepository, path: string, taskId: string, historical: boolean) {
  const first = execution.getTaskExecutionState(taskId)!.attempts.find(attempt => attempt.number === 1)!;
  const boundary = execution.getAttemptEvents(first.attemptId).find(event => event.type === 'completed')!;
  if (historical) {
    const db = new Database(path);
    try { db.prepare('DELETE FROM events WHERE id=?').run(boundary.id); }
    finally { db.close(); }
  }
  return { version: 1, taskId, attemptId: first.attemptId, settlementId: first.settlementId, outcome: 'completed',
    throughSequence: boundary.sequence, output: { text: sampleOutput, digest: createHash('sha256').update(sampleOutput).digest('hex') } };
}
