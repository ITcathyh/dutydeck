// 没命中 model 场景包时，判定和回复 prompt 与 P5 之前（4ec2650）逐字相同：快照文件是在 4ec2650 的代码上生成的，之后不再更新。
// 场景包只在快照带 scenario 时才往 prompt 里加内容。

import { describe, expect, it } from 'vitest';
import type { CollaborationObservation, CollaborationSnapshot } from '@dutydeck/shared';
import { decisionInput, participationPrompt, participationResponsePrompt } from './readonly-decider.js';

const scope = { appId: 'cli_baseline', chatId: 'oc_baseline' };
const stamp = (minute: number) => new Date(Date.parse('2026-10-15T01:00:00.000Z') + minute * 60_000).toISOString();
const observation = (index: number, patch: Partial<CollaborationObservation> = {}): CollaborationObservation => ({ id: `obs_${index}`, scope, sequence: index, source: 'lark.message',
  eventId: `om_${index}`, occurredAt: stamp(index), receivedAt: stamp(index), senderId: index % 3 === 0 ? 'ou_self' : `ou_${index % 2 ? 'a' : 'b'}`,
  senderKind: index % 3 === 0 ? 'bot' : 'human', messageId: `om_${index}`, text: `第 ${index} 条消息：${'订单服务 5xx 怎么排查'.repeat(index % 4 + 1)}`,
  refs: [`om_${index}`, 'dutydeck:self:ou_self_open'], origin: 'live', missing: [], revision: 1, ...patch });
const base = (): CollaborationSnapshot => ({ scope, contextRevision: 30,
  settings: { scope, revision: 3, participation: 'selective', instructions: '回答简短，先给结论', notificationsPaused: false, maxProactivePerHour: 6, retentionDays: 30, policyVersion: 'v2', updatedAt: stamp(0) },
  observations: [observation(0, { source: 'lark.description', eventId: 'desc', senderKind: 'system', text: '群说明：订单服务值班群', refs: [], messageId: undefined, senderId: undefined }),
    ...Array.from({ length: 28 }, (_, index) => observation(index + 1))], followups: [], mandates: [] });
const followup = { id: 'f1', scope, revision: 2, goal: '跟进容量评估', status: 'open', progress: '已收集一半', steps: [{ id: 's1', label: '收集', status: 'open' }], sourceRefs: [], externalRefs: [], taskIds: [], fields: {}, createdAt: stamp(0), updatedAt: stamp(1) };
const team = { query: '我的待办', searchedAt: stamp(2), sources: [{ scope: { ...scope, chatId: 'oc_other' }, name: '项目群', status: 'complete' as const, missing: [] }],
  observations: [observation(40, { id: 'team_1', scope: { ...scope, chatId: 'oc_other' } })] };

describe('判定和回复 prompt：没有场景包时与 4ec2650 逐字相同', () => {
  const trigger = 'obs_28';
  const variants: Array<[string, () => string]> = [
    ['plain', () => participationPrompt(decisionInput(base(), trigger), trigger, 'Dock', { humans: 3, bots: 1 })],
    ['scope', () => participationPrompt(decisionInput(base(), trigger), trigger, 'Dock', { humans: 3, bots: 2, responder: 'self' }, { roleTitle: '值班', roleScope: '订单服务的报错和告警' })],
    ['title-only', () => participationPrompt(decisionInput(base(), trigger), trigger, 'Dock', undefined, { roleTitle: '值班' })],
    ['responder', () => participationPrompt(decisionInput(base(), trigger), trigger, 'Dock', { humans: 3, bots: 2, responder: 'self' })],
    ['followups-team', () => participationPrompt(decisionInput({ ...base(), followups: [followup], teamContext: team } as unknown as CollaborationSnapshot, trigger), trigger, 'Dock')],
    ['no-trigger', () => participationPrompt(decisionInput(base()), undefined, undefined)],
    ['response', () => participationResponsePrompt(decisionInput(base(), trigger), { action: 'reply', reason: '有依据', evidenceIds: [trigger], updates: [] }, trigger)],
    ['response-role-team', () => participationResponsePrompt(decisionInput({ ...base(), teamContext: team }, trigger), { action: 'reply', reason: '有依据', evidenceIds: [trigger, 'team_1'], updates: [] }, trigger, { roleTitle: '值班', roleScope: '订单服务' })]
  ];
  it.each(variants)('%s', (_name, build) => {
    expect(build()).toMatchSnapshot();
  });
});
