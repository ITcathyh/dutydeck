import { RuntimeError, serialByKey, type CollaborationRepository, type CollaborationScope } from '@dutydeck/shared';

/** Share one per-chat allowance between ambient replies and scheduled notifications. */
export class CollaborationDelivery {
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(private readonly repository: CollaborationRepository, private readonly now = () => new Date()) {}
  async run<T>(scope: CollaborationScope, actionId: string, send: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([scope.appId, scope.chatId]);
    return serialByKey(this.running, key, async () => {
      const cutoff = new Date(this.now().getTime() - 3_600_000).toISOString();
      const [settings, position] = await Promise.all([this.repository.getSettings(scope), this.repository.getDeliveryPosition(scope, actionId, cutoff)]);
      if (settings.notificationsPaused || position < 0 || position >= settings.maxProactivePerHour) {
        throw new RuntimeError('COLLABORATION_DELIVERY_SUPPRESSED', '群通知已暂停或本小时主动发言额度已用完。', 409);
      }
      return send();
    });
  }
}
