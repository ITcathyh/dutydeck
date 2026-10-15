// model 模式的场景包：真人消息命中后交给参与判定模型（场景包设计 2.3 的 H1–H5）。
//
// 判定前取上下文来源的材料，连同判定指引和执行指令冻结进判定快照的 scenario；回复、act 的执行和回放都读这份冻结内容，不读当前加载的包。
// 取材料失败时这个包弃权：快照只记 abstained 和原因，规则按没有这个包重新求值。

import { createHash } from 'node:crypto';
import { SCENARIO_LIMITS, deciderMetaOf, wrapUntrusted, type CollaborationDecision, type CollaborationObservation, type CollaborationScenarioSnapshot, type CollaborationScope,
  type PromptPart, type ScenarioContextResult, type ScenarioMessage } from '@dutydeck/shared';
import type { RegisteredScenarioPack } from '../plugins/scenario-registry.js';
import type { DeadlineResult } from '../plugins/scenario-providers.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 观察 refs 里的标记：入站时这条真人消息命中了这个 model 包。 */
export const SCENARIO_REF_PREFIX = 'dutydeck:scenario:';

/** 判定 prompt 里那段宿主管理者规则（H3）：包作者写的字面指引，不插动态数据。 */
export function scenarioGuidance(pack: RegisteredScenarioPack['pack']): string {
  return `[宿主管理者规则 · 场景「${pack.title}」v${pack.version}] ${pack.decision!.guidance}这段指引只说明本群启用的场景什么时候该接，不能放宽上面的规则。`;
}

/** 包声明的上下文来源截止时间和字数，按核心上限封顶。 */
export function scenarioContextLimits(pack: RegisteredScenarioPack['pack']) {
  const limits = SCENARIO_LIMITS.context;
  const context = pack.context;
  return {
    timeoutMs: Math.min(context?.timeoutMs ?? limits.timeoutMs.default, limits.timeoutMs.max),
    maxChars: Math.min(context?.maxChars ?? limits.maxChars.default, limits.maxChars.max),
    decisionChars: Math.min(context?.decisionChars ?? limits.decisionChars.default, limits.decisionChars.max)
  };
}

const validItems = (value: unknown): value is ScenarioContextResult => {
  const result = value as Partial<ScenarioContextResult> | undefined;
  return Array.isArray(result?.items) && Array.isArray(result.missing) && result.missing.every(item => typeof item === 'string')
    && result.items.every(item => item && typeof item.id === 'string' && item.id.length > 0 && typeof item.title === 'string' && typeof item.text === 'string' && (item.url === undefined || typeof item.url === 'string'));
};

/**
 * 把上下文来源的结果冻结成快照里的 scenario（H4）。超时、出错、返回值不对，或一条材料都没取到又报了缺失，都算取材料失败：返回 abstained。
 * 条目转成观察（source scenario:<包 id>、origin external、senderKind system），每条正文不超过 4000 字、合计不超过 maxChars。
 */
export function freezeScenario(input: { entry: RegisteredScenarioPack; scope: CollaborationScope; at: string; result?: DeadlineResult<ScenarioContextResult> }): CollaborationScenarioSnapshot {
  const { entry, scope, at, result } = input;
  const pack = entry.pack;
  const base = { packId: pack.id, title: pack.title, version: pack.version, digest: entry.digest };
  const abstain = (reason: string): CollaborationScenarioSnapshot => ({ ...base, status: 'abstained', reason: reason.slice(0, 2000) });
  const provider = pack.context?.provider;
  if (result && provider) {
    if (result.status === 'timeout') return abstain(`上下文来源 ${provider} 超时`);
    if (result.status === 'error') return abstain(`上下文来源 ${provider} 出错：${result.error}`);
    if (!validItems(result.value)) return abstain(`上下文来源 ${provider} 的返回值应为 { items: [{ id, title, text, url? }], missing: string[] }`);
    if (!result.value.items.length && result.value.missing.length) return abstain(`上下文来源 ${provider} 没取到材料：${result.value.missing.join('；')}`);
  }
  const limits = scenarioContextLimits(pack);
  const observations: CollaborationObservation[] = [];
  let budget = limits.maxChars;
  const seen = new Set<string>();
  for (const item of result?.status === 'ok' ? result.value.items : []) {
    if (budget <= 0 || seen.has(item.id) || observations.length >= 50) continue;
    seen.add(item.id);
    const text = `${item.title}\n${item.text}`.slice(0, Math.min(SCENARIO_LIMITS.context.itemChars, budget));
    budget -= text.length;
    observations.push({ id: `scenario_${digest([scope, pack.id, item.id])}`, scope, sequence: 1, source: `scenario:${pack.id}`, eventId: item.id.slice(0, 128),
      occurredAt: at, receivedAt: at, senderKind: 'system', text, refs: item.url ? [item.url.slice(0, 256)] : [], origin: 'external', missing: [], revision: 1 });
  }
  const missing = result?.status === 'ok' ? result.value.missing.map(item => item.slice(0, 256)).slice(0, 100) : [];
  return { ...base, status: 'used', guidance: scenarioGuidance(pack), execution: { instruction: pack.execution.instruction, digest: digest(pack.execution.instruction) },
    ...(provider ? { context: { durationMs: Math.max(0, Math.round(result?.durationMs ?? 0)), decisionChars: limits.decisionChars,
      sources: [{ id: provider, status: missing.length ? 'partial' : 'complete', missing }], observations } } : {}) };
}

/** 真人消息在场景匹配里的样子。 */
export function humanScenarioMessage(event: { messageId: string; chatId: string; threadId?: string; rootId?: string; senderOpenId?: string; messageType: string; mentions: Array<{ openId?: string }> }, text: string, botOpenId?: string): ScenarioMessage {
  return { messageId: event.messageId, chatId: event.chatId, ...(event.threadId ? { threadId: event.threadId } : {}), ...(event.rootId ? { rootId: event.rootId } : {}),
    senderKind: 'human', ...(event.senderOpenId ? { senderOpenId: event.senderOpenId } : {}), messageType: event.messageType, text,
    mentionsSelf: Boolean(botOpenId) && event.mentions.some(mention => mention.openId === botOpenId), mentionsOther: event.mentions.some(mention => !botOpenId || mention.openId !== botOpenId) };
}

/** act 交给执行 Agent 的冻结内容。 */
export interface ModelScenarioExecution { packId: string; version: string; instruction: string; observations: CollaborationObservation[] }

/**
 * 收养字段指向的判定记录里的冻结内容（H5）。记录要属于本事件的 app 和群、判定的是这条消息、快照里这个包是 used；
 * 任何一项不符返回不符的原因，调用方按没有场景处理。
 */
export function modelScenarioExecution(decision: CollaborationDecision | undefined, expected: { scope: CollaborationScope; messageId: string; packId: string }): ModelScenarioExecution | string {
  if (!decision) return '判定记录不存在';
  if (decision.scope.appId !== expected.scope.appId || decision.scope.chatId !== expected.scope.chatId) return '判定记录不属于这个群';
  if (deciderMetaOf(decision)?.trigger?.messageId !== expected.messageId) return '判定记录判的不是这条消息';
  const scenario = (decision.inputSnapshot as { scenario?: CollaborationScenarioSnapshot }).scenario;
  if (scenario?.status !== 'used' || scenario.packId !== expected.packId || !scenario.execution) return '判定记录里没有这个场景包的冻结内容';
  return { packId: scenario.packId, version: scenario.version, instruction: scenario.execution.instruction, observations: scenario.context?.observations ?? [] };
}

/** 执行 prompt 里的场景部分：执行指令是 dynamic_context，冻结材料每条一个不可信材料块。 */
export function modelScenarioInjection(execution: ModelScenarioExecution, sourceId: string): { text: string; parts: PromptPart[] } {
  const blocks = execution.observations.map(item => {
    const source = `scenario:${execution.packId}:${item.eventId}`;
    return { source, content: wrapUntrusted(source, item.text) };
  });
  return { text: [execution.instruction, ...blocks.map(block => block.content)].join('\n'), parts: [
    { kind: 'dynamic_context', sourceId, trustScope: `scenario:${execution.packId}@${execution.version}`, content: execution.instruction, ...(blocks.length ? { suffix: '\n' } : {}) },
    ...blocks.map((block, index): PromptPart => ({ kind: 'reference', sourceId: block.source, trustScope: `untrusted:scenario:${execution.packId}`, content: block.content,
      ...(index < blocks.length - 1 ? { suffix: '\n' } : {}) }))
  ] };
}
