// direct 模式的场景包：来源机器人发来的消息命中后不调判定模型，按去重和每小时上限决定起不起任务，
// 结论都记一条场景记录（「为什么没回」能查到），起任务时以群里确认过的人的身份走 @ 机器人的同一条派发路径。
//
// decideDirect 是纯函数，实时和回放共用；runDirectScenario 是执行器：先记录再派发，开话题，交给 dispatcher 收养。
// 强制契约（场景包设计 2.1）：来源限定、排除自身、确认人、去重、每小时上限、只在接话人上运行，包里省略配置只会得到默认值。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DECIDER_META_KEY, SCENARIO_RECORD, RuntimeError, scenarioBindingStatus, scenarioDirectLimits, scenarioPolicyVersion, scenarioRecordOf, scenarioSourceBots, wrapUntrusted,
  type CollaborationDecision, type CollaborationDeciderMeta, type CollaborationRepository, type CollaborationScope, type ListedItems, type ParticipationLevel, type PromptPart,
  type ScenarioBinding, type ScenarioOutcome, type ScenarioPack, type ScenarioRecordSnapshot } from '@dutydeck/shared';
import type { RegisteredScenarioPack } from '../plugins/scenario-registry.js';
import type { StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkCardService } from './service.js';
import { keywordsMatch, sourceTextFingerprint } from './scenario-fingerprint.js';
import { renderScenarioTemplate, sanitizeDisplayName, templateText } from './scenario-template.js';

const HOUR_MS = 3_600_000;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 场景记录 id 和开话题第一句的幂等键。格式与升级前的记录一致，旧记录照样能按 id 查到。 */
export const directRecordId = (packId: string, scope: CollaborationScope, messageId: string) => `decision_${packId}_${digest([scope, messageId])}`.slice(0, 128);
export const directIntroKey = (packId: string, scope: CollaborationScope, messageId: string) => `${packId}_${digest([scope, messageId])}`.slice(0, 50);

/**
 * 收养字段：内部 dispatcher 派来的 direct 场景请求。instruction 是已渲染的指令，恢复和执行都不再读当前加载的包。
 * legacyInstruction 是旧版本入站记录里的初筛约定（见 scenario-legacy.ts），prompt 沿用旧的拼接方式。
 */
export type LarkScenarioAdoption =
  | { mode: 'direct'; packId: string; version: string; digest: string; instruction: string; sourceAppId: string; recordId: string }
  | { mode: 'direct'; packId: string; legacyInstruction: string };

/** 入站记录里读回的收养字段要符合这个形状，否则按没有场景处理。 */
export const larkScenarioAdoptionSchema = z.union([
  z.object({ mode: z.literal('direct'), packId: z.string().min(1), version: z.string().min(1), digest: z.string().min(1), instruction: z.string().min(1), sourceAppId: z.string().min(1), recordId: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('direct'), packId: z.string().min(1), legacyInstruction: z.string().min(1) }).strict()
]);

/** decideDirect 的窗口：本包去重窗口内起了任务的场景记录、查询有没有被截断、读到的最旧一条的时间。 */
export interface DirectWindow { records: readonly CollaborationDecision[]; truncated: boolean; oldestReadAt?: string }
/** 从 listScenarioRecords 的结果取窗口，转成显式对象（不依赖数组上的不可枚举属性）。 */
export function directWindow(listed: ListedItems<CollaborationDecision>): DirectWindow {
  return { records: [...listed], truncated: listed.truncated === true, ...(listed.length ? { oldestReadAt: listed.at(-1)!.createdAt } : {}) };
}

export interface DirectDecisionInput {
  pack: ScenarioPack;
  binding: ScenarioBinding;
  /** 本机器人。 */
  self: { appId: string; openId?: string };
  /** 发送者：appId 是解析出的 app_id，openId 是实时事件里的 open_id。 */
  sender: { appId?: string; openId?: string };
  text: string;
  /** 本群接话人的 app_id，没有指定就不填。 */
  responderAppId?: string;
  window: DirectWindow;
  /** provider 返回的去重键；没有时用 source_text_v1。 */
  dedupeKey?: string;
  now: number;
}
export type DirectDecision =
  | { matched: false; reason: 'self' | 'not_source' }
  | { matched: true; outcome: ScenarioOutcome; dedupeKey: string; sourceAppId: string };

const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * 一条来源消息的结论。顺序：排除自身 → 来源 → filtered → not_responder → window_incomplete → duplicate → rate_limited → no_requester → started。
 * 去重和额度只统计同包、action 为 act 且没有失败的记录；时间边界含端点（>=）。窗口被截断且最旧一条还在去重窗口内时没读全，跳过不起任务。
 */
export function decideDirect(input: DirectDecisionInput): DirectDecision {
  const { pack, binding, self, sender, window, now } = input;
  if (sender.appId === self.appId || Boolean(sender.openId) && sender.openId === self.openId) return { matched: false, reason: 'self' };
  if (!sender.appId || !scenarioSourceBots(pack, binding).some(source => source.appId === sender.appId)) return { matched: false, reason: 'not_source' };
  const dedupeKey = input.dedupeKey ?? sourceTextFingerprint(sender.appId, input.text);
  const limits = scenarioDirectLimits(pack, binding.params);
  const dedupeMs = limits.dedupeWindowHours * HOUR_MS;
  const keywords = pack.trigger.filter ? stringList(binding.params[pack.trigger.filter.keywordsAnyParam]) : [];
  const counted = window.records.filter(item => scenarioRecordOf(item)?.packId === pack.id && item.action === 'act' && item.status !== 'failed');
  const within = (item: CollaborationDecision, ms: number) => Date.parse(item.createdAt) >= now - ms;
  const outcome: ScenarioOutcome = !keywordsMatch(keywords, input.text) ? 'filtered'
    : input.responderAppId && input.responderAppId !== self.appId ? 'not_responder'
    : window.truncated && (!window.oldestReadAt || Date.parse(window.oldestReadAt) >= now - dedupeMs) ? 'window_incomplete'
    : counted.some(item => scenarioRecordOf(item)?.dedupeKey === dedupeKey && within(item, dedupeMs)) ? 'duplicate'
    : counted.filter(item => within(item, HOUR_MS)).length >= limits.perHour ? 'rate_limited'
    : !binding.requesterId ? 'no_requester' : 'started';
  return { matched: true, outcome, dedupeKey, sourceAppId: sender.appId };
}

/** 包没写结果文案时核心的说法。 */
const defaultReasons: Record<ScenarioOutcome, string> = {
  started: '命中订阅，已起任务',
  filtered: '不在订阅的关键字范围内',
  duplicate: '同一条消息在去重窗口内已经处理过',
  rate_limited: '本小时处理条数已到上限',
  not_responder: '本群接话人是别的机器人，由它处理',
  no_requester: '订阅缺少确认人，任务没法发起；请在群里重新说一次开启',
  window_incomplete: '最近的处理记录没读全，没法确认是不是重复，这条先跳过',
  abstained: '匹配规则执行出错，这条跳过'
};
export const directReason = (pack: Pick<ScenarioPack, 'reasons'> | undefined, outcome: ScenarioOutcome) => pack?.reasons?.[outcome] ?? defaultReasons[outcome];

/** 执行 prompt 的请求部分：指令是用户请求，原文作为不可信材料跟在后面；旧版本入站记录沿用旧拼接。 */
export function directScenarioPrompt(adoption: LarkScenarioAdoption, text: string): string {
  if ('legacyInstruction' in adoption) return `${adoption.legacyInstruction}\n${text}`;
  return `${adoption.instruction}\n\n${wrapUntrusted(`scenario:${adoption.packId}:${adoption.sourceAppId}`, text)}`;
}

/** 把材料里的用户请求拆成「指令」（user_request）和「原文」（reference，不可信材料）两部分；拼回去与原文一致。 */
export function splitDirectScenarioRequest(parts: PromptPart[], adoption: LarkScenarioAdoption | undefined): PromptPart[] {
  const [request, ...rest] = parts;
  if (!adoption || 'legacyInstruction' in adoption || request?.kind !== 'user_request') return parts;
  const head = `${adoption.instruction}\n\n`;
  if (!request.content.startsWith(head)) return parts;
  const body = request.content.slice(head.length);
  return [
    { ...request, content: adoption.instruction, suffix: '\n\n' },
    { kind: 'reference', sourceId: `scenario:${adoption.packId}:${adoption.sourceAppId}`, trustScope: `untrusted:scenario:${adoption.packId}`, content: body,
      ...(request.suffix ? { suffix: request.suffix } : {}) },
    ...rest
  ];
}

export interface DirectRunDeps {
  repository: CollaborationRepository;
  now(): Date;
  dispatch?: (event: LarkMessageEvent, config: StoredLarkConfig) => Promise<void>;
  service: Pick<LarkCardService, 'replyText'> & Partial<Pick<LarkCardService, 'getMessage'>>;
  level(): Promise<ParticipationLevel>;
  log?: { warn(details: unknown, message: string): void };
}
export interface DirectRunInput {
  entry: RegisteredScenarioPack;
  scope: CollaborationScope;
  event: LarkMessageEvent;
  config: StoredLarkConfig;
  self: { appId: string; openId?: string };
  sender: { appId: string; openId?: string };
  text: string;
  dedupeKey?: string;
  /** 包的正则或 provider 出错、超时：这条消息这个包弃权，记一条 abstained。 */
  abstained?: string;
}

/**
 * 一条来源消息：读当前绑定和接话人，按 decideDirect 的结论记一条场景记录（先记后派：同一去重键的下一条在派发期间到达也能看到它），
 * started 时开话题并派发。调用方按群串行调用：去重和每小时上限是跨 await 的读-改-写。
 */
export async function runDirectScenario(deps: DirectRunDeps, input: DirectRunInput): Promise<void> {
  const repo = deps.repository;
  const { entry, scope, event } = input;
  const pack = entry.pack;
  const { scenarios, responder } = await repo.getDuty(scope);
  const binding = scenarios?.[pack.id];
  const id = directRecordId(pack.id, scope, event.messageId);
  // 平台重推同一条消息只处理一次。
  if (!binding || scenarioBindingStatus(pack, binding) !== 'enabled' || await repo.getDecision(scope, id)) return;
  const now = deps.now();
  // 去重和每小时上限只看本包窗口内起了任务的记录，单独查，不和群里其他判定记录抢条数。正常配额下读得全，截断时按 window_incomplete 跳过。
  const limits = scenarioDirectLimits(pack, binding.params);
  const window = directWindow(await repo.listScenarioRecords(scope, { packId: pack.id, since: new Date(now.getTime() - limits.dedupeWindowHours * HOUR_MS).toISOString(),
    limit: limits.perHour * limits.dedupeWindowHours + 1 }));
  const decided = input.abstained ? { matched: true as const, outcome: 'abstained' as const, dedupeKey: input.dedupeKey ?? sourceTextFingerprint(input.sender.appId, input.text), sourceAppId: input.sender.appId }
    : decideDirect({ pack, binding, self: input.self, sender: input.sender, text: input.text, ...(responder ? { responderAppId: responder.appId } : {}), window,
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}), now: now.getTime() });
  if (!decided.matched) return;
  const { outcome } = decided;
  const started = outcome === 'started';
  const meta: CollaborationDeciderMeta = { kind: 'rule', rule: `scenario_${outcome}`, trigger: { id: event.messageId, messageId: event.messageId, ...(event.senderOpenId ? { senderId: event.senderOpenId } : {}), text: input.text.slice(0, 200) } };
  const record: ScenarioRecordSnapshot = { packId: pack.id, version: pack.version, digest: entry.digest, outcome, dedupeKey: decided.dedupeKey, sourceAppId: decided.sourceAppId,
    window: { truncated: window.truncated, ...(window.oldestReadAt ? { oldestReadAt: window.oldestReadAt } : {}) } };
  await repo.recordDecision({ id, scope, contextRevision: 0, policyVersion: scenarioPolicyVersion(pack.id, pack.version), action: started ? 'act' : 'silent',
    reason: input.abstained ? `${directReason(pack, outcome)}：${input.abstained}`.slice(0, 2000) : directReason(pack, outcome),
    evidenceIds: [], status: started ? 'candidate' : 'suppressed', createdAt: now.toISOString(),
    inputSnapshot: { gate: SCENARIO_RECORD, scenario: record, [DECIDER_META_KEY]: meta } });
  if (!started) return;
  try {
    await startDirect(deps, input, binding, id);
    await repo.updateDecision(scope, id, { status: 'sent' });
  } catch (error) {
    deps.log?.warn({ error, scope, messageId: event.messageId, scenario: pack.id }, '场景任务没起来');
    await repo.updateDecision(scope, id, { status: 'failed' });
  }
}

/**
 * 在来源消息的话题里起任务：走和 @ 机器人同一条派发路径，以绑定的确认人身份发起，收养字段带已渲染的指令。
 * 普通群的来源消息是顶层消息，先在它下面回开话题的第一句，结果和后续追问都在这个话题里。
 */
async function startDirect(deps: DirectRunDeps, input: DirectRunInput, binding: ScenarioBinding, recordId: string) {
  const dispatch = deps.dispatch;
  if (!dispatch) throw new RuntimeError('COLLABORATION_DISPATCH_UNAVAILABLE', '机器人还没开始监听', 409);
  const { entry, event, scope } = input;
  const pack = entry.pack;
  const name = scenarioSourceBots(pack, binding).find(source => source.appId === input.sender.appId)?.name ?? input.sender.appId;
  const values = { source: templateText(sanitizeDisplayName(name)) };
  let thread = event.threadId ? { rootId: event.rootId ?? event.messageId, threadId: event.threadId } : undefined;
  if (!thread && pack.execution.intro) {
    const follow = await deps.level() === 'mention' ? '追问请 @ 我。' : '在这个话题里直接追问就行，不用 @。';
    const intro = await deps.service.replyText({ messageId: event.messageId, replyInThread: true, text: `${renderScenarioTemplate(pack.execution.intro, values)}${follow}`,
      idempotencyKey: directIntroKey(pack.id, scope, event.messageId) });
    const threadId = deps.service.getMessage ? (await deps.service.getMessage(intro.messageId).catch(() => undefined))?.threadId : undefined;
    if (threadId) thread = { rootId: event.messageId, threadId };
  }
  const scenario: LarkScenarioAdoption = { mode: 'direct', packId: pack.id, version: pack.version, digest: entry.digest,
    instruction: renderScenarioTemplate(pack.execution.instruction, values), sourceAppId: input.sender.appId, recordId };
  await dispatch({ ...event, ...thread, senderOpenId: binding.requesterId, senderType: 'user', scenario }, input.config);
}
