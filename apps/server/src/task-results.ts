import { createHash } from 'node:crypto';
import { RuntimeError, attemptResultV1Schema, type AgentEvent, type AttemptResultV1, type ExecutionRepository, type TaskAttempt } from '@dutydeck/shared';

export const TASK_RESULT_OUTPUT_BYTES = 512 * 1024;
const EVENT_PAGE_LIMIT = 200;

export type PendingAttemptResult = { status: 'pending' };
export type BlockedAttemptResult = { status: 'blocked'; reason: 'reconcile_required' | 'legacy_output_unresolved' | 'admission_conflict' };
export type SettledAttemptResult = { status: 'settled'; result: AttemptResultV1 };
export type AttemptResultRead = PendingAttemptResult | BlockedAttemptResult | SettledAttemptResult;

export interface AttemptResultRepositories {
  execution: Pick<ExecutionRepository, 'getTaskExecution' | 'getAttemptEvents'>;
}

function fail(code: string, message: string): never { throw new RuntimeError(code, message, 409); }

/**
 * 唯一固定 Attempt 结果读取：只认 number=1 Attempt 与其权威结算事件，
 * 不看 Task.status 或 Session 高水位。同步读取，越界/坏记录/超限/摘要冲突抛 RuntimeError。
 */
export function readAttemptResult(repositories: AttemptResultRepositories, sessionId: string, taskId: string, attemptId: string): AttemptResultRead {
  const execution = repositories.execution;
  const projection = execution.getTaskExecution(taskId);
  if (!projection) return { status: 'blocked', reason: 'admission_conflict' };
  if (projection.task.sessionId !== sessionId) fail('TASK_RESULT_SCOPE_CONFLICT', `Task ${taskId} does not belong to session ${sessionId}`);
  const attempt = projection.attempts.find(item => item.attemptId === attemptId);
  if (!attempt) fail('TASK_RESULT_ATTEMPT_MISSING', `Attempt ${attemptId} is not recorded for task ${taskId}`);
  if (attempt.taskId !== taskId || attempt.sessionId !== sessionId) fail('TASK_RESULT_SCOPE_CONFLICT', 'Attempt identity does not match the fixed task and session');
  if (attempt.number !== 1) fail('TASK_RESULT_ATTEMPT_CONFLICT', 'Only the number=1 attempt is a valid source result');

  if (attempt.state === 'preparing' || attempt.state === 'active' || attempt.state === 'suspended') return { status: 'pending' };
  if (attempt.state === 'reconcile_required') return { status: 'blocked', reason: 'reconcile_required' };
  if (attempt.state === 'legacy_unresolved') return { status: 'blocked', reason: 'legacy_output_unresolved' };

  if (!attempt.settlementId || !attempt.outcome || attempt.outcome === 'unknown') return { status: 'blocked', reason: 'reconcile_required' };

  const throughSequence = findSettlementBoundary(execution, attempt);
  if (throughSequence === undefined) return { status: 'blocked', reason: 'legacy_output_unresolved' };

  const output = collectOutput(execution, attempt, throughSequence);
  const settlement = attempt.settlement;
  if (settlement?.kind === 'driver_result' && settlement.outputDigest !== output.digest) {
    fail('TASK_RESULT_DIGEST_CONFLICT', `Generated output digest ${output.digest} does not match settlement ${settlement.outputDigest}`);
  }
  const result = attemptResultV1Schema.parse({
    version: 1, taskId, attemptId, settlementId: attempt.settlementId, throughSequence, outcome: attempt.outcome, output
  });
  return { status: 'settled', result };
}

function owned(event: AgentEvent, attempt: TaskAttempt, cursor: { sequence: number }) {
  if (event.sequence <= cursor.sequence || event.sessionId !== attempt.sessionId || event.taskId !== attempt.taskId || event.attemptId !== attempt.attemptId) {
    fail('TASK_RESULT_EVENT_ORDER', `Event ${event.sequence} breaks the strictly ordered attempt ownership boundary`);
  }
  cursor.sequence = event.sequence;
}

/** 定位同 attemptId+settlementId 的权威 completed 事件；缺边界是历史未决，不是错误。 */
function findSettlementBoundary(execution: AttemptResultRepositories['execution'], attempt: TaskAttempt): number | undefined {
  const cursor = { sequence: 0 };
  for (;;) {
    const page = execution.getAttemptEvents(attempt.attemptId, { afterSequence: cursor.sequence, direction: 'forward', limit: EVENT_PAGE_LIMIT });
    for (const event of page) {
      owned(event, attempt, cursor);
      if (event.type === 'completed') {
        if (event.settlementId !== attempt.settlementId) fail('TASK_RESULT_BOUNDARY_CONFLICT', `Completion event belongs to settlement ${event.settlementId ?? ''}, expected ${attempt.settlementId}`);
        const outcome = (event.data as { outcome?: unknown }).outcome;
        if (outcome !== attempt.outcome) fail('TASK_RESULT_BOUNDARY_CONFLICT', 'Completion event outcome does not match the settled attempt');
        return event.sequence;
      }
    }
    if (page.length < EVENT_PAGE_LIMIT) return undefined;
  }
}

function collectOutput(execution: AttemptResultRepositories['execution'], attempt: TaskAttempt, throughSequence: number): { text: string; digest: string } {
  const chunks: string[] = [];
  let bytes = 0;
  let afterSequence = 0;
  let pendingHighSurrogate = '';
  const cursor = { sequence: 0 };
  for (;;) {
    const page = execution.getAttemptEvents(attempt.attemptId, { afterSequence, beforeSequence: throughSequence + 1, direction: 'forward', limit: EVENT_PAGE_LIMIT });
    for (const event of page) {
      owned(event, attempt, cursor);
      if (event.sequence > throughSequence) fail('TASK_RESULT_EVENT_ORDER', 'Event page crossed the settlement boundary');
      if (event.type === 'text') {
        const data = event.data as { role?: unknown; text?: unknown };
        if (data.role !== 'user' && typeof data.text === 'string') {
          chunks.push(data.text);
          let textToMeasure = pendingHighSurrogate + data.text;
          pendingHighSurrogate = '';
          if (textToMeasure.length > 0) {
            const lastCode = textToMeasure.charCodeAt(textToMeasure.length - 1);
            if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
              pendingHighSurrogate = textToMeasure.slice(-1);
              textToMeasure = textToMeasure.slice(0, -1);
            }
          }
          if (textToMeasure.length > 0) {
            bytes += Buffer.byteLength(textToMeasure, 'utf8');
            if (bytes > TASK_RESULT_OUTPUT_BYTES) fail('TASK_RESULT_OUTPUT_TOO_LARGE', `Generated result exceeds ${TASK_RESULT_OUTPUT_BYTES} bytes`);
          }
        }
      }
      afterSequence = event.sequence;
    }
    if (page.length < EVENT_PAGE_LIMIT) break;
  }
  if (cursor.sequence < throughSequence) fail('TASK_RESULT_BOUNDARY_CONFLICT', 'Settlement boundary is missing from the attempt event pages');
  if (pendingHighSurrogate.length > 0) {
    bytes += Buffer.byteLength(pendingHighSurrogate, 'utf8');
    if (bytes > TASK_RESULT_OUTPUT_BYTES) fail('TASK_RESULT_OUTPUT_TOO_LARGE', `Generated result exceeds ${TASK_RESULT_OUTPUT_BYTES} bytes`);
  }
  const text = chunks.join('');
  const finalBytes = Buffer.byteLength(text, 'utf8');
  if (finalBytes > TASK_RESULT_OUTPUT_BYTES) {
    fail('TASK_RESULT_OUTPUT_TOO_LARGE', `Generated result exceeds ${TASK_RESULT_OUTPUT_BYTES} bytes`);
  }
  return { text, digest: createHash('sha256').update(text, 'utf8').digest('hex') };
}
