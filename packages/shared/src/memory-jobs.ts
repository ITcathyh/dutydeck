import type { JsonValue, TaskRequestV1 } from './task-execution.js';
import type { StartSessionInput } from './index.js';

export interface MemoryJobScope { appId: string; pool: string }
export interface MemoryJobVersion { key: string; value?: string }
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
  /** Checks and writes all config records and the application receipt in one transaction. */
  apply(input: { job: MemoryJob; claimToken: string; versions: MemoryJobVersion[]; writes: Array<{ key: string; value: string }>; consumedTaskIds: string[]; result: JsonValue; appliedAt: string }): Promise<MemoryJob>;
}
