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
  /** `true` when tracked or untracked repository content changed after this run. */
  stale: boolean;
}
