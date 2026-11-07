import type { JsonValue, TaskRequestV1 } from './task-execution.js';
import type { StartSessionInput } from './index.js';

export interface MemoryJobScope { appId: string; pool: string }
/**
 * A config record the job depends on. Persisted jobs carry only `digest` (sha256 of the stored value, `absent`
 * when missing) so credential records never land in job rows; `value` is for transient checks and legacy rows.
 */
export interface MemoryJobVersion { key: string; value?: string; digest?: string }
export interface MemoryJob {
  id: string;
  scope: MemoryJobScope;
  kind: 'extraction' | 'consolidation';
  revision: number;
  claimToken: string;
  mode: 'isolated' | 'compatible';
  compatibilityReason?: string;
  inputDigest: string;
  input: JsonValue;
  versions: MemoryJobVersion[];
  sessionId: string;
  sessionInput: StartSessionInput;
  requests: TaskRequestV1[];
  state: 'prepared' | 'running' | 'applied' | 'settled' | 'failed';
  receipt?: { appliedJobId: string; consumedTaskIds: string[]; result: JsonValue; appliedAt: string };
  error?: string;
  /** Consecutive retryable failures of this frozen job; recovery holds are never counted. */
  failures?: number;
  createdAt: string;
}
export interface MemoryJobRepository {
  /** Receipt check and pool state CAS share one transaction with memory application. */
  enqueuePendingTurn(input: { scope: MemoryJobScope; taskId: string; expectedState?: string; state: string }): Promise<'enqueued' | 'consumed' | 'conflict'>;
  hasClaim(scope: MemoryJobScope, token?: string): Promise<boolean>;
  isConsumed(scope: MemoryJobScope, taskId: string): Promise<boolean>;
  listUnsettled(appId: string): Promise<MemoryJob[]>;
  listScope(scope: MemoryJobScope): Promise<MemoryJob[]>;
  get(scope: MemoryJobScope, id: string): Promise<MemoryJob | undefined>;
  findUnsettled(scope: MemoryJobScope): Promise<MemoryJob | undefined>;
  create(job: MemoryJob): Promise<void>;
  update(job: MemoryJob, expectedRevision: number): Promise<MemoryJob>;
  /** Deletes all but the newest `keep` finished jobs per pool and kind, and strips prompts and conversation from those kept. */
  pruneFinished(appId: string, keep: number): Promise<number>;
  /** Checks and writes all config records and the application receipt in one transaction. */
  apply(input: { job: MemoryJob; claimToken: string; versions: MemoryJobVersion[]; writes: Array<{ key: string; value: string }>; consumedTaskIds: string[]; result: JsonValue; appliedAt: string }): Promise<MemoryJob>;
}
