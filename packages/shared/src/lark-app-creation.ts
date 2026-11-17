export interface LarkAppCreationJob {
  id: string;
  name: string;
  status: 'preparing' | 'waiting_for_scan' | 'creating' | 'configuring' | 'completed' | 'pending_review' | 'failed' | 'cancelled';
  appId?: string;
  /** 本次创建流程已经创建并尝试提交的版本；提交后回读失败时供人工核对。 */
  versionId?: string;
  publishAttempted?: boolean;
  botSaved?: boolean;
  qrDataUrl?: string;
  scanConfirmed?: boolean;
  accountName?: string;
  tenantName?: string;
  error?: string;
  slashCommands?: 'configured' | 'skipped_scope' | 'skipped_credentials' | 'failed';
  createdAt: string;
  updatedAt: string;
  retryable: boolean;
}
