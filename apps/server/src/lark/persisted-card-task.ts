import type { PersistedLarkCardTask } from './coordinator.js';

/** 解析卡片映射的 extra；JSON 损坏时抛错。 */
export function parseCardTask(extra: string) {
  return JSON.parse(extra) as PersistedLarkCardTask;
}

/** 同 parseCardTask，extra 为空时返回 undefined。 */
export function parseOptionalCardTask(extra: string | null | undefined) {
  return extra ? parseCardTask(extra) : undefined;
}
