export const verificationStatuses = ['running', 'passed', 'failed', 'timed_out', 'interrupted', 'unverified'] as const;
export type VerificationStatus = (typeof verificationStatuses)[number];

export interface VerificationCommandInput {
  command: string;
  timeoutSeconds?: number;
}

export interface VerificationRecord {
  schemaVersion: 1;
  revision: number;
  id: string;
  sessionId: string;
  taskId?: string;
  command: string;
  cwd: string;
  actorId?: string;
  status: VerificationStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  output: string;
  outputTruncated: boolean;
  beforeFingerprint?: string;
  afterFingerprint?: string;
  error?: string;
}

export interface VerificationResponse extends VerificationRecord {
  /** Conservatively true if the recorded result cannot establish the current code version. */
  stale: boolean;
  staleReason?: 'code_changed' | 'changed_during_run' | 'current_fingerprint_unavailable' | 'record_fingerprint_missing';
}
