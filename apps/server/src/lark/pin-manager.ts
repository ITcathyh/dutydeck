import type { ConfigRepository } from '@dutydeck/shared';
import type { LarkCardService } from './service.js';

export interface LarkPinManagerLog {
  warn?: (details: unknown, msg?: string) => void;
  info?: (details: unknown, msg?: string) => void;
  error?: (details: unknown, msg?: string) => void;
}

export interface LarkPinRecord {
  messageId: string;
  appId?: string;
  taskId?: string;
  chatId?: string;
  pinnedAt: string;
  unpinnedAt?: string;
  status: 'pinned' | 'unpinned';
}

export interface LarkPinManagerOptions {
  store?: ConfigRepository;
  log?: LarkPinManagerLog;
}

const pinPrefix = (appId?: string) => appId ? `lark.pin.${appId}.` : 'lark.pin.';
const pinKey = (appId: string, messageId: string) => `lark.pin.${appId}.${messageId}`;

/**
 * 飞书卡片置顶管理器。
 * 用于长任务开始/执行期间置顶进度卡片，任务完成或异常结束时取消置顶。
 * 支持通过 ConfigRepository 将置顶状态持久化（与 interaction 记录同一套存储）：
 * 服务重启后，对账收敛可扫描持久化记录并取消属于已结束/异常退出任务的僵尸置顶。
 * 兜底策略：所有置顶/取消置顶操作失败均捕获并记录日志，绝不抛出异常，绝不影响主任务执行。
 */
export class LarkPinManager {
  private readonly pinnedCards = new Set<string>();
  private readonly service: Pick<LarkCardService, 'pin' | 'unpin'>;
  private readonly store?: ConfigRepository;
  private readonly log?: LarkPinManagerLog;

  constructor(
    service: Pick<LarkCardService, 'pin' | 'unpin'>,
    optionsOrLog?: LarkPinManagerOptions | LarkPinManagerLog,
    store?: ConfigRepository
  ) {
    this.service = service;
    if (optionsOrLog && ('warn' in optionsOrLog || 'info' in optionsOrLog || 'error' in optionsOrLog)) {
      this.log = optionsOrLog as LarkPinManagerLog;
      this.store = store;
    } else {
      const opts = optionsOrLog as LarkPinManagerOptions | undefined;
      this.log = opts?.log;
      this.store = opts?.store ?? store;
    }
  }

  /**
   * 置顶卡片。
   * 幂等：已置顶的消息不会重复调用飞书 API。
   * 持久化：若提供 store，将置顶记录写入持久化存储。
   * 失败安全：失败返回 false，不抛异常。
   */
  async pin(
    messageId: string,
    metadata?: { appId?: string; taskId?: string; chatId?: string }
  ): Promise<boolean> {
    const id = messageId?.trim();
    if (!id) return false;
    if (this.pinnedCards.has(id)) return true;

    try {
      await this.service.pin(id);
      this.pinnedCards.add(id);

      if (this.store) {
        const appId = metadata?.appId || 'default';
        const key = pinKey(appId, id);
        const record: LarkPinRecord = {
          messageId: id,
          appId,
          taskId: metadata?.taskId,
          chatId: metadata?.chatId,
          pinnedAt: new Date().toISOString(),
          status: 'pinned'
        };
        try {
          await this.store.set(key, JSON.stringify(record));
        } catch (storageError) {
          this.log?.warn?.({ error: storageError, messageId: id }, '持久化置顶记录失败');
        }
      }

      return true;
    } catch (error) {
      this.log?.warn?.({ error, messageId: id }, '飞书长任务卡片置顶失败，不影响主任务执行');
      return false;
    }
  }

  /**
   * 取消置顶卡片。
   * 失败安全：失败返回 false，不抛异常。
   * 持久化：若提供 store，将置顶记录状态更新为 unpinned。
   */
  async unpin(
    messageId: string,
    context?: { appId?: string } | string
  ): Promise<boolean> {
    const id = messageId?.trim();
    if (!id) return false;

    try {
      await this.service.unpin(id);
      this.pinnedCards.delete(id);

      if (this.store) {
        const appId = typeof context === 'string' ? context : context?.appId || 'default';
        const key = pinKey(appId, id);
        try {
          const raw = await this.store.get(key);
          if (raw) {
            const record = JSON.parse(raw) as LarkPinRecord;
            record.status = 'unpinned';
            record.unpinnedAt = new Date().toISOString();
            await this.store.set(key, JSON.stringify(record));
          } else {
            const allPins = await this.store.list?.(pinPrefix()) ?? [];
            for (const item of allPins) {
              if (item.key.endsWith(`.${id}`)) {
                const record = JSON.parse(item.value) as LarkPinRecord;
                record.status = 'unpinned';
                record.unpinnedAt = new Date().toISOString();
                await this.store.set(item.key, JSON.stringify(record));
              }
            }
          }
        } catch (storageError) {
          this.log?.warn?.({ error: storageError, messageId: id }, '更新持久化取消置顶状态失败');
        }
      }

      return true;
    } catch (error) {
      this.log?.warn?.({ error, messageId: id }, '飞书长任务卡片取消置顶失败，不影响主任务执行');
      return false;
    }
  }

  /**
   * 启动收敛与心跳对账：
   * 从 store 读取持久化的置顶记录，对账已结束（非 active）的僵尸置顶卡片并执行 unpin 取消置顶。
   * 活跃任务的置顶卡片保留并在内存恢复追踪。
   */
  async reconcile(options?: {
    appId?: string;
    activeTaskIds?: Iterable<string>;
    isTaskActive?: (taskId: string | undefined, record: LarkPinRecord) => boolean | Promise<boolean>;
  }): Promise<{ unpinned: string[]; retained: string[] }> {
    const result = { unpinned: [] as string[], retained: [] as string[] };
    if (!this.store || !this.store.list) return result;

    const prefix = pinPrefix(options?.appId);
    let items: Array<{ key: string; value: string }>;
    try {
      items = await this.store.list(prefix);
    } catch (err) {
      this.log?.warn?.({ err, prefix }, '查询持久化置顶记录失败');
      return result;
    }

    const activeSet = options?.activeTaskIds ? new Set(options.activeTaskIds) : undefined;

    for (const item of items) {
      let record: LarkPinRecord;
      try {
        record = JSON.parse(item.value) as LarkPinRecord;
      } catch {
        continue;
      }

      if (record.status !== 'pinned') continue;

      let active = false;
      if (options?.isTaskActive) {
        try {
          active = await options.isTaskActive(record.taskId, record);
        } catch {
          active = false;
        }
      } else if (activeSet) {
        active = record.taskId ? activeSet.has(record.taskId) : false;
      }

      if (active) {
        this.pinnedCards.add(record.messageId);
        result.retained.push(record.messageId);
      } else {
        try {
          await this.service.unpin(record.messageId);
        } catch (err) {
          this.log?.warn?.({ err, messageId: record.messageId }, '收敛取消僵尸置顶失败');
        }
        this.pinnedCards.delete(record.messageId);
        record.status = 'unpinned';
        record.unpinnedAt = new Date().toISOString();
        try {
          await this.store.set(item.key, JSON.stringify(record));
        } catch (err) {
          this.log?.warn?.({ err, key: item.key }, '持久化更新取消置顶失败');
        }
        result.unpinned.push(record.messageId);
      }
    }

    return result;
  }

  async list(appId?: string): Promise<LarkPinRecord[]> {
    if (!this.store || !this.store.list) return [];
    try {
      const items = await this.store.list(pinPrefix(appId));
      return items.map(item => JSON.parse(item.value) as LarkPinRecord);
    } catch {
      return [];
    }
  }

  isPinned(messageId: string): boolean {
    return this.pinnedCards.has(messageId?.trim());
  }

  get pinnedCount(): number {
    return this.pinnedCards.size;
  }
}
