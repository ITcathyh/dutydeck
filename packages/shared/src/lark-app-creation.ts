export interface LarkAppCreationJob {
  id: string;
  name: string;
  status: 'preparing' | 'waiting_for_scan' | 'creating' | 'configuring' | 'completed' | 'pending_review' | 'failed' | 'cancelled';
  appId?: string;
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
