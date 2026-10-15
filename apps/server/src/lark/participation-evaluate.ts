// 群参与判定的「先规则后模型」：实时判定和回放共用这一个顺序。
//
// 实时：早期规则 → 成本上限/判定预算闸门 → 补读历史与快照 → 晚期规则 → 模型。
// 回放：只跑规则和模型，不传闸门和补读，也就不碰授权、预算和发送。
// 这里只排顺序，闸门、补读和模型调用的副作用都在调用方的回调里。

import type { CollaborationDeciderMeta, CollaborationObservation, CollaborationSnapshot, ParticipationLevel } from '@dutydeck/shared';
import { evaluateParticipationRules, ownedItems, ruleContextOf, type RuleFacts, type RuleVerdict } from './participation-rules.js';

/** 一轮规则的输入：被判定的消息、本机器人负责的事项、查到的事实。 */
export interface ParticipationRuleRound {
  trigger: CollaborationObservation;
  owned: { names: string[]; hasActiveMandates: boolean };
  facts: RuleFacts;
}

export interface ParticipationEvaluation<C, M> {
  botNames: string[];
  roleScope?: string;
  /** 早期规则的输入；回放的旧记录找不到触发消息时不传，直接交给模型。 */
  early?: ParticipationRuleRound;
  /** 实时：成本上限和判定预算闸门，返回 true 表示已挡下、不再判定。 */
  gate?(): Promise<boolean>;
  /** 实时：补读历史与快照，返回晚期规则的输入和交给模型的上下文；返回 undefined 表示这次判定作废。 */
  enrich?(): Promise<(ParticipationRuleRound & { context: C }) | undefined>;
  /** 规则拿不准时调用模型。round 是最后一轮规则的输入，context 是补读得到的上下文（回放没有）。 */
  model(round: ParticipationRuleRound | undefined, context: C | undefined): Promise<M>;
}

export type ParticipationOutcome<C, M> =
  | { kind: 'rule'; stage: 'early' | 'late'; verdict: RuleVerdict; facts: RuleFacts; context?: C }
  | { kind: 'model'; value: M }
  | { kind: 'stopped' };

export async function evaluateParticipation<C, M>(input: ParticipationEvaluation<C, M>): Promise<ParticipationOutcome<C, M>> {
  const rules = (round: ParticipationRuleRound) => evaluateParticipationRules(ruleContextOf(round.trigger, round.owned, input.botNames, round.facts, input.roleScope));
  const early = input.early && rules(input.early);
  if (early) return { kind: 'rule', stage: 'early', verdict: early, facts: input.early!.facts };
  if (await input.gate?.()) return { kind: 'stopped' };
  if (!input.enrich) return { kind: 'model', value: await input.model(input.early, undefined) };
  const enriched = await input.enrich();
  if (!enriched) return { kind: 'stopped' };
  const late = rules(enriched);
  if (late) return { kind: 'rule', stage: 'late', verdict: late, facts: enriched.facts, context: enriched.context };
  return { kind: 'model', value: await input.model(enriched, enriched.context) };
}

/** 回放的规则输入：按判定记录找回触发消息，事实用当时查到的；旧记录找不到触发消息时返回 undefined，只交给模型。 */
export function replayRound(snapshot: CollaborationSnapshot, meta: CollaborationDeciderMeta | undefined, level: ParticipationLevel): ParticipationRuleRound | undefined {
  const trigger = meta?.trigger && snapshot.observations.find(item => item.id === meta.trigger!.id);
  return trigger ? { trigger, owned: ownedItems(snapshot.mandates, snapshot.followups), facts: { level, ...meta?.facts } as RuleFacts } : undefined;
}
