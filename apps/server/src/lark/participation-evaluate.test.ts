// 实时判定和回放共用 evaluateParticipation：顺序、闸门、作废，以及同一输入给出同样的规则结论；回放报告三类样本数。
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createCollaborationSchema } from '../../../../packages/storage/src/collaboration-migration.js';
import { createCollaborationRepository } from '../../../../packages/storage/src/collaboration.js';
import { allowEagerParticipation } from '../../../../packages/storage/src/migrations.js';
import { deciderMetaOf, type CollaborationObservation, type CollaborationSnapshot } from '@dutydeck/shared';
import { CollaborationEvaluation } from '../collaboration-evaluation.js';
import { LarkGroupParticipation } from './group-participation.js';
import { evaluateParticipation, replayRound, type ParticipationRuleRound } from './participation-evaluate.js';
import type { RuleFacts } from './participation-rules.js';
import type { LarkMessageEvent } from './listener.js';
import type { StoredLarkConfig } from './config.js';
import type { ParticipationResult } from './readonly-decider.js';

const scope = { appId: 'cli_test', chatId: 'oc_test' };
const at = '2026-10-15T03:00:00.000Z';
const observation = (id: string, text: string, patch: Partial<CollaborationObservation> = {}): CollaborationObservation => ({ id, scope, sequence: 1, source: 'lark.message', eventId: id,
  occurredAt: at, receivedAt: at, senderId: 'ou_a', senderKind: 'human', messageId: id, text, refs: [], origin: 'live', missing: [], revision: 1, ...patch });
const none = { names: [], hasActiveMandates: false };
const round = (text: string, facts: Partial<RuleFacts> = {}, owned = none): ParticipationRuleRound => ({ trigger: observation('obs_1', text), owned, facts: { level: 'selective', ...facts } });

/** 实时：早期规则 → 闸门 → 补读 → 晚期规则 → 模型；补读只补事实，不改触发消息。 */
async function live(early: ParticipationRuleRound, late: ParticipationRuleRound, gated = false) {
  const steps: string[] = [];
  const outcome = await evaluateParticipation({ botNames: ['Bot'], early,
    gate: async () => { steps.push('gate'); return gated; },
    enrich: async () => { steps.push('enrich'); return { ...late, context: 'snapshot' }; },
    model: async (_round, context) => { steps.push(`model:${context}`); return 'model'; } });
  return { outcome, steps };
}
/** 回放：只有规则和模型，规则用记录里补全后的事实。 */
const replay = (input: ParticipationRuleRound) => evaluateParticipation({ botNames: ['Bot'], early: input, model: async () => 'model' });

describe('evaluateParticipation', () => {
  it.each<[string, ParticipationRuleRound, ParticipationRuleRound, 'early' | 'late' | 'model', string | undefined]>([
    ['早期规则：叫了我的名字', round('Bot 帮我看下'), round('Bot 帮我看下'), 'early', 'calls_name'],
    ['早期规则：多机器人群没指定接话人', round('今天发布了吗', { humans: 3, bots: 2 }), round('今天发布了吗', { humans: 3, bots: 2 }), 'early', 'no_responder'],
    ['晚期规则：我刚说过话，你紧接着又说了', round('那第二步呢', { humans: 3, bots: 1 }),
      round('那第二步呢', { humans: 3, bots: 1, lastSelfAgoMs: 60_000, humanBetween: false, partner: true }), 'late', 'follow_up'],
    ['晚期规则：提到我负责的事项', round('周报整理到哪了'), round('周报整理到哪了', {}, { names: ['周报整理'], hasActiveMandates: false }), 'late', 'owned_item'],
    ['规则拿不准，交给模型', round('这个报错怎么处理', { humans: 3, bots: 1 }), round('这个报错怎么处理', { humans: 3, bots: 1 }), 'model', undefined]
  ])('%s：实时和回放给出同样结论', async (_name, early, late, stage, rule) => {
    const { outcome, steps } = await live(early, late);
    const replayed = await replay(late);
    if (stage === 'model') {
      expect(outcome).toEqual({ kind: 'model', value: 'model' });
      expect(steps).toEqual(['gate', 'enrich', 'model:snapshot']);
      expect(replayed).toEqual({ kind: 'model', value: 'model' });
      return;
    }
    expect(outcome).toMatchObject({ kind: 'rule', stage, verdict: { rule } });
    expect(steps).toEqual(stage === 'early' ? [] : ['gate', 'enrich']);
    expect(replayed).toMatchObject({ kind: 'rule', verdict: { rule } });
    expect(outcome.kind === 'rule' && replayed.kind === 'rule' && outcome.verdict).toEqual(replayed.kind === 'rule' && replayed.verdict);
  });

  it('闸门挡下：不补读、不调模型', async () => {
    const { outcome, steps } = await live(round('这个报错怎么处理'), round('这个报错怎么处理'), true);
    expect(outcome).toEqual({ kind: 'stopped' });
    expect(steps).toEqual(['gate']);
  });

  it('补读发现判定已作废：不跑晚期规则、不调模型', async () => {
    const model = vi.fn(async () => 'model');
    const outcome = await evaluateParticipation({ botNames: ['Bot'], early: round('这个报错怎么处理'), gate: async () => false, enrich: async () => undefined, model });
    expect(outcome).toEqual({ kind: 'stopped' });
    expect(model).not.toHaveBeenCalled();
  });

  it('回放的旧记录找不到触发消息：跳过规则，直接交给模型', async () => {
    const snapshot = { observations: [observation('obs_1', 'Bot 帮我看下')], mandates: [], followups: [] } as unknown as CollaborationSnapshot;
    expect(replayRound(snapshot, { kind: 'model', trigger: { id: 'obs_gone' } }, 'selective')).toBeUndefined();
    expect(replayRound(snapshot, { kind: 'rule', trigger: { id: 'obs_1' }, facts: { humans: 3 } }, 'selective')).toMatchObject({ trigger: { id: 'obs_1' }, facts: { level: 'selective', humans: 3 } });
    const model = vi.fn(async () => 'model');
    expect(await evaluateParticipation({ botNames: ['Bot'], model })).toEqual({ kind: 'model', value: 'model' });
    expect(model).toHaveBeenCalledWith(undefined, undefined);
  });
});

const config: StoredLarkConfig = { appId: scope.appId, appSecret: 'test', name: 'Bot', listening: true, defaultAgentId: 'mock', workspace: '/tmp', fullTrustConfirmed: true,
  permissionMode: 'ask', preInjectPrompt: '', memoryEnabled: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' };
const message = (id: string, text: string): LarkMessageEvent => ({ messageId: id, chatId: scope.chatId, chatType: 'group', messageType: 'text',
  content: JSON.stringify({ text }), createTime: String(Date.parse(at)), senderOpenId: 'ou_a', senderType: 'user', mentions: [] });
const members = (humans: number, bots: number) => vi.fn(async () => ({ items: [
  ...Array.from({ length: humans }, (_, i) => ({ memberId: `ou_${i}`, memberType: 'user' as const, name: `用户${i}` })),
  ...Array.from({ length: bots }, (_, i) => ({ memberId: `cli_${i}`, memberType: 'bot' as const, name: i ? `机器人${i}` : 'Bot', appId: i ? `cli_${i}` : scope.appId }))], hasMore: false, securityLimited: false }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

describe('实时判定的记录交给回放', () => {
  it('规则结论回放一致；回放报告总样本、有效样本和缺失样本，跳过的不算通过', async () => {
    const db = new Database(':memory:'); createCollaborationSchema(db); allowEagerParticipation(db);
    const repository = createCollaborationRepository(db);
    await repository.updateSettings(scope, { expectedRevision: 0, participation: 'selective' }, 'owner');
    const service = { listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })), listChatMembers: members(3, 1), replyText: vi.fn(async () => ({ messageId: 'om_sent' })),
      sendText: vi.fn(async () => ({ messageId: 'om_sent' })), listOwnReactions: vi.fn(async () => []), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}) };
    const decide = vi.fn(async (): Promise<ParticipationResult> => ({ action: 'silent', reason: '不是在叫我', evidenceIds: [], updates: [] }));
    const participation = new LarkGroupParticipation({ repository, decider: { decide, respond: vi.fn(async () => '回复') }, authorize: async () => true, readConfig: async () => config,
      serviceFor: () => service as any, listScopes: async () => [scope], canOperate: async () => true, readGroupDescription: async () => '研发群', debounceMs: 10_000, now: () => new Date(at) });
    participation.setDispatcher(scope.appId, vi.fn(async () => {}));
    cleanups.push(async () => { await participation.close(); db.close(); });
    await repository.createFollowup({ id: 'follow_1', scope, goal: '周报整理', progress: '', steps: [], sourceRefs: [], fields: {}, status: 'open', taskIds: [], externalRefs: [], createdBy: 'ou_a', updatedBy: 'ou_a', provenance: 'confirmed' });
    for (const [id, text] of [['om_name', 'Bot 帮我看下'], ['om_item', '周报整理到哪了']] as const) {
      await participation.handle(message(id, text), config, { explicit: false, botOpenId: 'ou_bot' });
      await participation.flush(scope);
    }
    const decisions = await repository.listDecisions(scope);
    const byMessage = (messageId: string) => decisions.find(item => deciderMetaOf(item)?.trigger?.messageId === messageId)!;
    expect(deciderMetaOf(byMessage('om_name'))).toMatchObject({ kind: 'rule', rule: 'calls_name' });
    expect(deciderMetaOf(byMessage('om_item'))).toMatchObject({ kind: 'rule', rule: 'owned_item' });
    expect(decide).not.toHaveBeenCalled();

    // 一条材料缺失的记录：观察里有 missing，回放必须跳过。
    const incomplete = byMessage('om_item');
    const snapshot = incomplete.inputSnapshot as unknown as CollaborationSnapshot;
    await repository.recordDecision({ ...incomplete, id: 'decision_incomplete', inputSnapshot: { ...incomplete.inputSnapshot,
      observations: snapshot.observations.map(item => ({ ...item, missing: ['resource_binary_not_loaded'] })) } });

    // 回放与 collaboration-integration 的接线相同：replayRound + evaluateParticipation，不传闸门和补读。
    const model = vi.fn(async () => ({ action: 'silent' as const, reason: '模型', evidenceIds: [] }));
    const evaluation = new CollaborationEvaluation({ repository, evaluate: async (replayed, _version, meta) => {
      const early = replayRound(replayed, meta, 'selective');
      const outcome = await evaluateParticipation({ botNames: ['Bot'], ...(early ? { early } : {}), model });
      if (outcome.kind === 'rule') return { action: outcome.verdict.action === 'addressed' ? 'act' : 'silent', reason: outcome.verdict.reason, evidenceIds: [early!.trigger.id] };
      if (outcome.kind === 'model') return outcome.value;
      throw new Error('回放不会中止');
    } });
    const result = await evaluation.replay(scope, { decisionIds: [byMessage('om_name').id, byMessage('om_item').id, 'decision_incomplete', 'decision_gone'] });
    expect(result).toMatchObject({ total: 4, valid: 2, passed: 2, failed: 0, missing: 2 });
    expect(result.results.map(item => item.status)).toEqual(['passed', 'passed', 'missing', 'missing']);
    expect(model).not.toHaveBeenCalled();
  });
});
