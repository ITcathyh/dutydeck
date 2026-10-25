/** Controlled result tools return bytes to the host, never model-visible output. */
export type { PluginResultTool } from '@dutydeck/plugin-sdk';
export interface ResultPrincipal { provider: string; tenant: string; subject: string }
export interface PluginResultReceipt { deliveryId: string; status: 'delivered' | 'pending' | 'unknown' | 'failed'; fileCount: number }
export type PluginResultStatus = 'executing' | 'execution_unknown' | 'ready' | 'sending' | 'delivered' | 'failed' | 'expired' | 'revoked' | 'delivery_unknown';
export interface PluginResultTarget { [key: string]: string | number | boolean }
export interface PluginResultDelivery {
  id: string; requester: ResultPrincipal; plugin: string; tool: string;
  sessionId: string; runId: string; taskId: string; attemptId: string; callId: string; inputDigest: string;
  target: PluginResultTarget; status: PluginResultStatus; revision: number; leaseToken: string; leaseUntil: number;
  fileCount: number; totalBytes: number; providerKey: string; messageId?: string; firstSendAt?: number;
  createdAt: number; expiresAt: number; errorCode?: string;
}
export interface PluginResultFile { id: string; name: string; byteLength: number; sha256: string }
export interface PluginResultOAuthState { stateHash: string; nonceHash: string; deliveryId: string; provider: string; tenant: string; redirectUri: string; expiresAt: number }
export interface PluginResultRepository {
  reserve(input: Omit<PluginResultDelivery, 'status' | 'revision' | 'fileCount' | 'totalBytes'>, now: number): { delivery: PluginResultDelivery; acquired: boolean };
  get(id: string): PluginResultDelivery | undefined;
  store(id: string, leaseToken: string, files: Array<PluginResultFile & { data: Uint8Array }>, now: number): void;
  fail(id: string, leaseToken: string, code: string): void;
  claim(id: string, now: number): PluginResultDelivery | undefined;
  owns(id: string, leaseToken: string, now: number): boolean;
  sent(id: string, leaseToken: string, messageId: string): void;
  retry(id: string, leaseToken: string, unknown: boolean): void;
  pending(tenant: string, now: number): PluginResultDelivery[];
  sweep(now: number): void;
  revoke(id: string): void;
  files(id: string): PluginResultFile[];
  download(id: string, fileId: string): Uint8Array | undefined;
  putOAuthState(state: PluginResultOAuthState): void;
  consumeOAuthState(stateHash: string, nonceHash: string, now: number): PluginResultOAuthState | undefined;
  putViewer(tokenHash: string, principal: ResultPrincipal, expiresAt: number): void;
  viewer(tokenHash: string, now: number): ResultPrincipal | undefined;
}
export const pluginResultLimits = Object.freeze({ files: 8, fileBytes: 10 * 1024 * 1024, callBytes: 32 * 1024 * 1024, principalBytes: 128 * 1024 * 1024, globalBytes: 1024 * 1024 * 1024, ttlMs: 24 * 60 * 60_000, executionMs: 60_000, principalConcurrent: 1, globalConcurrent: 4, sendLeaseMs: 90_000, retryMs: 60 * 60_000 });
