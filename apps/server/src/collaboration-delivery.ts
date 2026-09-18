import { RuntimeError, type CollaborationRepository, type CollaborationScope } from '@dutydeck/shared';

const deliveryKinds = new Set(['participation.reply', 'schedule_delivery']);
/** Share one per-chat allowance between ambient replies and scheduled notifications. */
export class CollaborationDelivery {
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(private readonly repository: CollaborationRepository, private readonly now = () => new Date()) {}
  async run<T>(scope: CollaborationScope, actionId: string, send: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([scope.appId, scope.chatId]);
    const turn = (this.running.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const [settings, actions] = await Promise.all([this.repository.getSettings(scope), this.repository.listActions(scope, 500)]);
      const cutoff = new Date(this.now().getTime() - 3_600_000).toISOString();
      const candidates = actions.filter(action => deliveryKinds.has(action.kind) && action.createdAt >= cutoff && ['intent', 'sending', 'unknown', 'succeeded'].includes(action.status))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      const position = candidates.findIndex(action => action.id === actionId);
      if (settings.notificationsPaused || position < 0 || position >= settings.maxProactivePerHour) {
        throw new RuntimeError('COLLABORATION_DELIVERY_SUPPRESSED', '群通知已暂停或本小时主动发言额度已用完。', 409);
      }
      return send();
    });
    this.running.set(key, turn);
    try { return await turn; } finally { if (this.running.get(key) === turn) this.running.delete(key); }
  }
}
