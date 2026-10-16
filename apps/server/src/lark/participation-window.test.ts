// 判定预算、机器人回合预算、主动发言额度按存储层的截断标记判断窗口是否读全，不按「条数 == 500」推断：
// 存储上限改小时，同样拦截。
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createCollaborationSchema } from '../../../../packages/storage/src/collaboration-migration.js';
import { createCollaborationRepository } from '../../../../packages/storage/src/collaboration.js';
import { addCollaborationScenarios, allowEagerParticipation } from '../../../../packages/storage/src/migrations.js';
import { DECIDER_META_KEY, markTruncated, type CollaborationRepository } from '@dutydeck/shared';
import { LarkGroupParticipation } from './group-participation.js';
import type { LarkMessageEvent } from './listener.js';
import type { StoredLarkConfig } from './config.js';
import type { ParticipationResult } from './readonly-decider.js';

const scope = { appId: 'cli_test', chatId: 'oc_test' };
const config: StoredLarkConfig = { appId: scope.appId, appSecret: 'test', listening: true, defaultAgentId: 'mock', workspace: '/tmp', fullTrustConfirmed: true,
  permissionMode: 'ask', preInjectPrompt: '', memoryEnabled: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' };
const message = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({ messageId: id, chatId: scope.chatId, chatType: 'group', messageType: 'text',
  content: JSON.stringify({ text }), createTime: String(Date.now()), senderOpenId: 'ou_a', senderType: 'user', mentions: [], ...patch });

/** 模拟把存储上限改成 cap：多出来的记录读不到，结果带截断标记。 */
const capped = (repository: CollaborationRepository, cap: number): CollaborationRepository => ({ ...repository,
  listDecisions: async (target, limit) => { const items = await repository.listDecisions(target, limit); return markTruncated(items.slice(0, cap), items.length > cap || items.truncated === true); },
  listActions: async (target, limit) => { const items = await repository.listActions(target, limit); return markTruncated(items.slice(0, cap), items.length > cap || items.truncated === true); } });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function harness(cap?: number) {
  const db = new Database(':memory:'); createCollaborationSchema(db); allowEagerParticipation(db); addCollaborationScenarios(db);
  const stored = createCollaborationRepository(db);
  await stored.updateSettings(scope, { expectedRevision: 0, participation: 'selective' }, 'owner');
  const repository = cap === undefined ? stored : capped(stored, cap);
  const service = { listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })), replyText: vi.fn(async () => ({ messageId: 'om_sent' })), sendText: vi.fn(async () => ({ messageId: 'om_sent' })),
    listOwnReactions: vi.fn(async () => []), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}) };
  const decide = vi.fn(async (_config: StoredLarkConfig, _snapshot: unknown, triggerId?: string): Promise<ParticipationResult> => ({ action: 'reply', reason: '在问我', evidenceIds: [triggerId!], updates: [] }));
  const participation = new LarkGroupParticipation({ repository, decider: { decide, respond: vi.fn(async () => '回复') }, authorize: async () => true, readConfig: async () => config,
    serviceFor: () => service as any, listScopes: async () => [scope], readGroupDescription: async () => '研发群', debounceMs: 10_000 });
  cleanups.push(async () => { await participation.close(); db.close(); });
  const ask = async (id: string) => { await participation.handle(message(id, '这个报错怎么处理'), config, { explicit: false, botOpenId: 'ou_bot' }); await participation.flush(scope); };
  return { stored, participation, service, decide, ask };
}
const now = () => new Date().toISOString();

describe('统计窗口按截断标记判断是否读全', () => {
  it('判定预算：窗口被截断且都在本小时内，按超限挡下，不调模型', async () => {
    for (const cap of [undefined, 2]) {
      const h = await harness(cap);
      for (let index = 0; index < 3; index++) {
        await h.stored.recordDecision({ id: `decision_model_${index}`, scope, contextRevision: 100 + index, policyVersion: 'v1', action: 'silent', reason: 'r', evidenceIds: [], status: 'candidate',
          inputSnapshot: { [DECIDER_META_KEY]: { kind: 'model' } }, createdAt: now() });
      }
      await h.ask('om_1');
      if (cap === undefined) { expect(h.decide).toHaveBeenCalledOnce(); continue; }
      expect(h.decide).not.toHaveBeenCalled();
      expect((await h.stored.listDecisions(scope)).find(item => item.reason.startsWith('判定预算窗口不完整'))).toBeDefined();
    }
  });

  it('主动发言额度：动作窗口被截断且都在本小时内，模型判了 reply 也不发', async () => {
    for (const cap of [undefined, 2]) {
      const h = await harness(cap);
      for (let index = 0; index < 3; index++) {
        await h.stored.beginAction({ id: `reply_${index}`, scope, kind: 'participation.ack', requesterId: 'owner', inputDigest: `reply_${index}` });
      }
      await h.ask('om_1');
      expect(h.decide).toHaveBeenCalledOnce();
      expect(h.service.replyText).toHaveBeenCalledTimes(cap === undefined ? 1 : 0);
    }
  });
});
