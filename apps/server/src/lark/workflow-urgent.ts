import type { LarkCardService } from './service.js';
import type { LarkInteraction } from './workflow-interactions.js';

export interface LarkUrgentManagerLog {
  warn?: (details: unknown, msg?: string) => void;
  info?: (details: unknown, msg?: string) => void;
  error?: (details: unknown, msg?: string) => void;
}

export interface LarkUrgentManagerOptions {
  service: Pick<LarkCardService, 'urgentApp'>;
  /** 卡片发出后无人处理的加急超时阈值（毫秒），默认 10 分钟 (600,000ms) */
  thresholdMs?: number;
  /** 每个群每小时最多加急次数，默认 3 次 */
  maxPerHourPerChat?: number;
  log?: LarkUrgentManagerLog;
  /** 持久化回调（用于记录 interaction.urgentAt） */
  onUrged?: (record: LarkInteraction, urgentAt: string) => Promise<void> | void;
}

export interface LarkUrgentCheckResult {
  checked: number;
  urged: string[];
  skippedRateLimited: string[];
  skippedNotEligible: string[];
  failed: Array<{ id: string; error: unknown }>;
}

export class LarkUrgentManager {
  private readonly service: Pick<LarkCardService, 'urgentApp'>;
  private readonly thresholdMs: number;
  private readonly maxPerHourPerChat: number;
  private readonly log?: LarkUrgentManagerLog;
  private readonly onUrged?: (record: LarkInteraction, urgentAt: string) => Promise<void> | void;

  /** 群聊每小时加急时间戳（滑动窗口 1 小时）: chatId -> timestamp[] */
  private readonly chatUrgentHistory = new Map<string, number[]>();
  /** 内存去重标记，防止单会话单卡片重复加急 */
  private readonly urgedIds = new Set<string>();

  constructor(options: LarkUrgentManagerOptions) {
    this.service = options.service;
    this.thresholdMs = Math.max(1_000, options.thresholdMs ?? 10 * 60 * 1000);
    this.maxPerHourPerChat = Math.max(1, options.maxPerHourPerChat ?? 3);
    this.log = options.log;
    this.onUrged = options.onUrged;
  }

  /**
   * 检查加急资格并执行加急。
   * 遵循保守原则：
   * 1. 仅限 pending 状态的 ask / permission 卡片；
   * 2. 卡片发出后超过 thresholdMs 仍无人处理；
   * 3. 每条卡片最多加急 1 次；
   * 4. 每个群每小时最多加急 maxPerHourPerChat 次，超限跳过并记录警告；
   * 5. 仅加急卡片对应的目标提问对象（senderOpenId / targetUserId），绝不加急群里所有人；
   * 6. 异常捕获兜底，失败不影响主任务，不向外抛出。
   */
  async checkAndUrge(interactions: LarkInteraction[], currentTime?: number): Promise<LarkUrgentCheckResult> {
    const now = currentTime ?? Date.now();
    const oneHourAgo = now - 3600_000;
    const result: LarkUrgentCheckResult = {
      checked: interactions.length,
      urged: [],
      skippedRateLimited: [],
      skippedNotEligible: [],
      failed: []
    };

    // 1. 清理已有内存历史中超过 1 小时的记录
    for (const [chatId, history] of this.chatUrgentHistory.entries()) {
      this.chatUrgentHistory.set(chatId, history.filter(t => t > oneHourAgo && t <= now));
    }

    // 2. 从传入的 interactions 中按 chatId 重建最近 1 小时的加急窗口（防止服务重启后频率限制清零）
    for (const record of interactions) {
      if (record.urgentAt) {
        if (!this.urgedIds.has(record.id)) {
          this.urgedIds.add(record.id);
          const t = new Date(record.urgentAt).getTime();
          if (Number.isFinite(t) && t > oneHourAgo && t <= now) {
            const chatId = record.event?.chatId || 'default_chat';
            const history = this.chatUrgentHistory.get(chatId) ?? [];
            history.push(t);
            this.chatUrgentHistory.set(chatId, history);
          }
        }
      }
    }

    for (const record of interactions) {
      // 1. 仅限 pending 状态的 ask 或 permission 卡片，且必须已有 cardId
      if (record.state !== 'pending' || (record.kind !== 'ask' && record.kind !== 'permission') || !record.cardId) {
        result.skippedNotEligible.push(record.id);
        continue;
      }

      // 2. 每条卡片最多加急一次（内存与持久化标记双重判断）
      if (record.urgentAt || this.urgedIds.has(record.id)) {
        result.skippedNotEligible.push(record.id);
        continue;
      }

      // 3. 超时阈值判定（卡片创建时间距今是否超过阈值）。
      // 时间戳不可解析时按「跳过」处理：证明不了这张卡已经超时，就不能发强提醒横幅。
      const cardTime = new Date(record.cardCreatedAt ?? record.updatedAt).getTime();
      if (!Number.isFinite(cardTime) || now - cardTime < this.thresholdMs) {
        result.skippedNotEligible.push(record.id);
        continue;
      }

      // 4. 目标人确定：提问针对谁就加急谁，不加急全群
      const targetUserId = record.targetUserId?.trim() || record.event?.senderOpenId?.trim();
      if (!targetUserId) {
        this.log?.warn?.({ interactionId: record.id }, '卡片缺少目标用户 openId，跳过加急');
        result.skippedNotEligible.push(record.id);
        continue;
      }

      // 5. 单群每小时加急频率限制
      const chatId = record.event?.chatId || 'default_chat';
      const history = (this.chatUrgentHistory.get(chatId) ?? []).filter(t => t > oneHourAgo && t <= now);
      this.chatUrgentHistory.set(chatId, history);

      if (history.length >= this.maxPerHourPerChat) {
        this.log?.warn?.(
          { chatId, interactionId: record.id, count: history.length, limit: this.maxPerHourPerChat },
          '当前群每小时加急次数已达上限，跳过加急'
        );
        result.skippedRateLimited.push(record.id);
        continue;
      }

      // 6. 执行出站应用内加急（失败兜底，绝不抛出）
      try {
        await this.service.urgentApp({
          messageId: record.cardId,
          userIdList: [targetUserId],
          userIdType: 'open_id'
        });

        // 记录频率与去重状态
        history.push(now);
        this.urgedIds.add(record.id);
        const urgentAtIso = new Date(now).toISOString();
        record.urgentAt = urgentAtIso;

        if (this.onUrged) {
          try {
            await this.onUrged(record, urgentAtIso);
          } catch (err) {
            this.log?.warn?.({ err, interactionId: record.id }, '记录加急持久化状态失败');
          }
        }

        result.urged.push(record.id);
      } catch (error) {
        this.log?.warn?.(
          { error, interactionId: record.id, cardId: record.cardId, targetUserId },
          '飞书卡片应用内加急失败，不影响主任务'
        );
        result.failed.push({ id: record.id, error });
      }
    }

    return result;
  }
}
