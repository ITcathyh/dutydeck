export interface CiWebhookPendingEvent {
  eventKey: string;
  providerId: string;
  payloadJson: string;
  receivedAt: number;
  targets: string[];
}

/** CI event admission and task bindings. Pending admissions survive the deduplication TTL. */
export interface CiWebhookRepository {
  acceptEvent(input: { eventKey: string; providerId: string; payloadJson: string; targets: string[]; now: number; expiresAt: number }): 'accepted' | 'duplicate' | 'conflict';
  listPendingEvents(): CiWebhookPendingEvent[];
  commitTarget(input: { eventKey: string; subscriptionId: string; configKey: string; expectedConfig: string | undefined; nextConfig?: string; state: 'admitted' | 'skipped' }): boolean;
  /** 清理已过期且无待接纳目标的记录，再占用 event-id。 */
  claimEvent(eventKey: string, now: number, expiresAt: number): boolean;
  /** 只释放纯去重记录，不删除已持久接纳的事件。 */
  releaseEvent(eventKey: string, expiresAt: number): void;
  bindTask(taskId: string, subscriptionId: string, createdAt: number): void;
  taskSubscription(taskId: string): string | undefined;
  listTaskBindings(): Array<{ taskId: string; subscriptionId: string; createdAt: number }>;
  unbindTask(taskId: string): void;
}
