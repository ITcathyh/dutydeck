import { z } from 'zod';
import type { ConfigRepository } from '@dutydeck/shared';
import { sha256Hex } from '../hash.js';
import { LarkServiceError } from './service.js';

export const botPromptVersionSchema = z.object({
  schemaVersion: z.literal(1), appId: z.string().min(1), version: z.number().int().positive(),
  text: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), savedAt: z.string().datetime(),
  savedBy: z.string().optional(), source: z.enum(['web', 'cli', 'agent', 'backfill', 'rollback']),
  configRevision: z.number().int().positive().optional(),
  rollbackFrom: z.number().int().positive().optional()
}).strict();
export type BotPromptVersion = z.infer<typeof botPromptVersionSchema>;
export type PromptSaveOrigin = { source: BotPromptVersion['source']; appId?: string; savedBy?: string; rollbackFrom?: number };
export const botPromptUsageSchema = z.object({
  schemaVersion: z.literal(1), taskId: z.string().min(1), appId: z.string().min(1),
  botPromptVersion: z.number().int().nonnegative().optional(), groupInstructionsRevision: z.number().int().nonnegative().optional()
}).strict();
export type BotPromptUsage = z.infer<typeof botPromptUsageSchema>;
export const promptVersionKey = (appId: string, version: number) => `bot_prompt_version/${encodeURIComponent(appId)}/${version}`;
export const promptHash = (text: string) => sha256Hex(text);

export async function promptHistory(store: ConfigRepository, appId: string): Promise<BotPromptVersion[]> {
  const versions: BotPromptVersion[] = [];
  for (let version = 1; ; version++) {
    const raw = await store.get(promptVersionKey(appId, version));
    if (raw === undefined) return versions;
    const record = botPromptVersionSchema.parse(JSON.parse(raw));
    if (record.appId !== appId || record.version !== version || record.sha256 !== promptHash(record.text)) throw new Error('提示词版本记录损坏');
    versions.push(record);
  }
}
export async function promptVersion(store: ConfigRepository, appId: string, version: number) {
  if (!Number.isSafeInteger(version) || version < 1) throw new LarkServiceError('PROMPT_VERSION_INVALID', '版本号必须是正整数。', 400);
  const record = (await promptHistory(store, appId)).find(item => item.version === version);
  if (!record) throw new LarkServiceError('PROMPT_VERSION_NOT_FOUND', '没有此提示词版本。', 404);
  return record;
}
type Bot = { appId: string; preInjectPrompt?: string; revision?: number };
export async function preparePromptVersions(store: ConfigRepository, before: Bot[], after: Bot[], origin: PromptSaveOrigin) {
  const writes: Array<{ key: string; value: string }> = [];
  for (const bot of after) {
    const history = await promptHistory(store, bot.appId);
    const old = before.find(item => item.appId === bot.appId);
    const text = bot.preInjectPrompt ?? '';
    const add = (value: string, source: BotPromptVersion['source']) => {
      const record = botPromptVersionSchema.parse({ schemaVersion: 1, appId: bot.appId, version: history.length + 1,
        text: value, sha256: promptHash(value), savedAt: new Date().toISOString(), source, configRevision: source === 'backfill' ? old?.revision ?? bot.revision ?? 1 : bot.revision ?? 1,
        ...(source !== 'backfill' ? { savedBy: origin.savedBy, rollbackFrom: origin.rollbackFrom } : {}) });
      history.push(record);
      writes.push({ key: promptVersionKey(bot.appId, record.version), value: JSON.stringify(record) });
    };
    if (!history.length && old?.preInjectPrompt) add(old.preInjectPrompt, 'backfill');
    if (origin.source !== 'backfill' && (text !== (old?.preInjectPrompt ?? '') || (!old && history.length > 0) || (origin.rollbackFrom !== undefined && origin.appId === bot.appId))) add(text, origin.source);
    else if (!history.length && text) add(text, 'backfill');
  }
  return writes;
}
export async function promptUsageSnapshot(store: ConfigRepository, input: { taskId: string; appId: string; text: string; configRevision?: number; groupInstructionsRevision?: number }) {
  const versions = await promptHistory(store, input.appId);
  const version = versions.slice().reverse().find(item => item.text === input.text && (input.configRevision === undefined || (item.configRevision ?? 1) <= input.configRevision))?.version;
  // 缺省表示未记录版本；0 只用于确知未注入提示词的轮次。
  const record = botPromptUsageSchema.parse({ schemaVersion: 1, taskId: input.taskId, appId: input.appId,
    botPromptVersion: version ?? (input.text ? undefined : 0), groupInstructionsRevision: input.groupInstructionsRevision });
  return record;
}
export async function recordPromptUsage(store: ConfigRepository, input: z.infer<typeof botPromptUsageSchema>) {
  const record = botPromptUsageSchema.parse(input);
  const key = `bot_prompt_version/usage/${record.taskId}`;
  if (store.compareAndSet) {
    if (await store.compareAndSet(key, undefined, JSON.stringify(record))) return;
  } else if (await store.get(key) === undefined) {
    await store.set(key, JSON.stringify(record));
    return;
  }
  // 已有记录不可覆盖；确认它确实存在，再允许清理准备快照。
  botPromptUsageSchema.parse(JSON.parse((await store.get(key))!));
}
export function promptLineDiff(a: string, b: string): string {
  const left = a.split('\n'), right = b.split('\n');
  let start = 0, end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  if (start === left.length && start === right.length) return '无变化';
  return ['--- 原版本', '+++ 新版本', ...left.slice(0, start).map(line => ' ' + line),
    ...left.slice(start, left.length - end).map(line => '-' + line), ...right.slice(start, right.length - end).map(line => '+' + line),
    ...left.slice(left.length - end).map(line => ' ' + line)].join('\n');
}

export const pendingPromptUsageKey = (appId: string, messageId: string, turn: number) =>
  ['bot_prompt_version/pending', appId, messageId, String(turn)].map((part, index) => index ? encodeURIComponent(part) : part).join('/');
export async function freezePromptUsage(store: ConfigRepository, key: string, candidate?: z.infer<typeof botPromptUsageSchema>): Promise<{ usage: BotPromptUsage; created: boolean } | undefined> {
  const existing = await store.get(key);
  if (existing !== undefined) {
    const frozen = botPromptUsageSchema.parse(JSON.parse(existing));
    if (candidate && (frozen.appId !== candidate.appId || (frozen.botPromptVersion !== undefined && candidate.botPromptVersion !== undefined && frozen.botPromptVersion !== candidate.botPromptVersion) ||
      frozen.groupInstructionsRevision !== candidate.groupInstructionsRevision)) {
      throw new LarkServiceError('PROMPT_USAGE_CONFLICT', '准备后提示词已变化，本次未重新派发；请先核对原任务，再发起新一轮。', 409);
    }
    return { usage: frozen, created: false };
  }
  if (!candidate) return undefined;
  const value = JSON.stringify(botPromptUsageSchema.parse(candidate));
  if (store.compareAndSet) {
    if (!await store.compareAndSet(key, undefined, value)) return freezePromptUsage(store, key, candidate);
  } else await store.set(key, value);
  return { usage: candidate, created: true };
}

export async function clearPendingPromptUsage(store: ConfigRepository, key: string, snapshot: BotPromptUsage) {
  if (!store.remove) throw new Error('存储不支持清理提示词准备快照');
  await store.remove(key, JSON.stringify(botPromptUsageSchema.parse(snapshot)));
}
export async function unrecordedPromptUsages(store: ConfigRepository, appId: string) {
  const rows = await store.list?.('bot_prompt_version/usage/') ?? [];
  return rows.map(row => botPromptUsageSchema.parse(JSON.parse(row.value)))
    .filter(record => record.appId === appId && record.botPromptVersion === undefined)
    .map(record => ({ taskId: record.taskId, label: '未记录版本' as const }));
}
