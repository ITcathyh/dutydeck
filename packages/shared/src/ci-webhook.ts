/**
 * CI webhook 的短期记录：event-id 去重和修复任务绑定。
 * 过期或任务结束后物理删除，行数只随在途事件和任务变化，不随历史累积。
 */
export interface CiWebhookRepository {
  /** 先删掉已过期的去重记录，再占用 event-id；TTL 内已被占用时返回 false。 */
  claimEvent(eventKey: string, now: number, expiresAt: number): boolean;
  /** 处理失败时只删自己这次的占用，让发送方重试。 */
  releaseEvent(eventKey: string, expiresAt: number): void;
  bindTask(taskId: string, subscriptionId: string, createdAt: number): void;
  taskSubscription(taskId: string): string | undefined;
  listTaskBindings(): Array<{ taskId: string; subscriptionId: string; createdAt: number }>;
  unbindTask(taskId: string): void;
}
