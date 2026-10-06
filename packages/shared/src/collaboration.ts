import { z } from 'zod';

export const collaborationScopeSchema = z.object({
  appId: z.string().trim().min(1).max(128),
  chatId: z.string().trim().min(1).max(128)
}).strict();
export type CollaborationScope = z.infer<typeof collaborationScopeSchema>;

export const collaborationParticipationModes = ['off', 'observe', 'selective', 'eager'] as const;
export type CollaborationParticipationMode = (typeof collaborationParticipationModes)[number];

/**
 * 参与强度：群里不 @ 时机器人什么时候接话。它由唤醒方式（mentionPolicy）和群参与模式两个底层字段合成，
 * 只决定接不接话，不改变任何权限边界。
 */
export const participationLevels = ['mention', 'topic', 'selective', 'eager'] as const;
export type ParticipationLevel = (typeof participationLevels)[number];
export const participationLevelLabels: Record<ParticipationLevel, string> = { mention: '只在 @ 时', topic: '话题内免 @', selective: '按需', eager: '积极' };
export const participationLevelBehaviors: Record<ParticipationLevel, string> = {
  mention: '只处理 @ 我的消息',
  topic: '新任务要 @ 我，我接手的话题里直接回复就行',
  selective: '没 @ 我的消息先判断是不是在叫我，是才接',
  eager: '除了明显是对别人说的、表情和致谢，群里真人的消息我都接，适合单人群'
};
type LevelMentionPolicy = 'always' | 'topic' | 'never' | 'ambient';
/** 旧配置自动落到最接近的档位：never / ambient 本来就不需要 @，按「积极」说明。 */
export function participationLevelOf(mentionPolicy: LevelMentionPolicy | undefined, participation: CollaborationParticipationMode): ParticipationLevel {
  if (participation === 'eager' || participation === 'selective') return participation;
  if (mentionPolicy === 'never' || mentionPolicy === 'ambient') return 'eager';
  return mentionPolicy === 'topic' ? 'topic' : 'mention';
}
/** 档位写回的两个底层字段。 */
export function participationLevelFields(level: ParticipationLevel): { mentionPolicy: 'always' | 'topic'; participation: CollaborationParticipationMode } {
  if (level === 'mention') return { mentionPolicy: 'always', participation: 'off' };
  if (level === 'topic') return { mentionPolicy: 'topic', participation: 'off' };
  return { mentionPolicy: 'topic', participation: level };
}

export const collaborationSettingsSchema = z.object({
  scope: collaborationScopeSchema,
  revision: z.number().int().min(0).default(0),
  participation: z.enum(collaborationParticipationModes).default('off'),
  inheritParticipation: z.boolean().default(false),
  instructions: z.string().max(8000).default(''),
  notificationsPaused: z.boolean().default(false),
  maxProactivePerHour: z.number().int().min(0).max(60).default(6),
  /**
   * 每小时最多运行多少次参与判定。判定本身要花模型调用，observe 影子模式同样计入。
   * 上限取 500：统计窗口一次最多读 500 条判定，超过这个数就无法自证用量。
   */
  maxDecisionsPerHour: z.number().int().min(0).max(500).default(60),
  retentionDays: z.number().int().min(1).max(365).default(30),
  policyVersion: z.string().min(1).max(64).default('v1'),
  updatedAt: z.string().datetime()
}).strict();
export type CollaborationSettings = z.infer<typeof collaborationSettingsSchema>;

export const updateCollaborationSettingsInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  participation: z.enum(collaborationParticipationModes).optional(),
  inheritParticipation: z.boolean().optional(),
  instructions: z.string().max(8000).optional(),
  notificationsPaused: z.boolean().optional(),
  maxProactivePerHour: z.number().int().min(0).max(60).optional(),
  maxDecisionsPerHour: z.number().int().min(0).max(500).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  policyVersion: z.string().min(1).max(64).optional()
}).strict().refine(input => Object.keys(input).some(key => key !== 'expectedRevision'), {
  message: 'At least one field must be updated'
});
export type UpdateCollaborationSettingsInput = z.infer<typeof updateCollaborationSettingsInputSchema>;

/**
 * 告警初筛订阅：来源 Bot 在本群发的消息命中后不走参与判定，直接在告警话题里起一个初筛任务。
 * 每个 Bot 实例各存一份，只管自己。
 */
export const alarmSubscriptionSchema = z.object({
  enabled: z.boolean(),
  /** 来源 Bot：appId 用来匹配消息发送者，name 只用于展示。 */
  sources: z.array(z.object({ appId: z.string().trim().min(1).max(128), name: z.string().trim().max(128).optional() }).strict()).max(20),
  /** 级别关键字（如 P0、critical），告警文本包含任一个才分析，不分大小写；空表示不过滤。 */
  levels: z.array(z.string().trim().min(1).max(32)).max(20),
  /** 同一条告警（指纹相同）多少小时内只分析一次。 */
  dedupeHours: z.number().int().min(1).max(168),
  maxPerHour: z.number().int().min(1).max(30),
  /** 初筛任务以谁的名义发起：在群里确认订阅的人（open_id）。没有时不起任务。 */
  requesterId: z.string().trim().min(1).max(128).optional()
}).strict();
export type AlarmSubscription = z.infer<typeof alarmSubscriptionSchema>;
export const ALARM_DEDUPE_HOURS = 6;
export const ALARM_MAX_PER_HOUR = 3;

/** 接话人：多 Bot 群里没 @ 任何 Bot 的消息只由它判定和回复。since 是生效时间，收到更早的声明时不回退。 */
export const groupResponderSchema = z.object({
  appId: z.string().trim().min(1).max(128),
  name: z.string().trim().max(128).optional(),
  since: z.string().datetime()
}).strict();
export type GroupResponder = z.infer<typeof groupResponderSchema>;

/** 本 Bot 在群里的分工：告警初筛订阅和它所知的接话人。 */
export const collaborationDutySchema = z.object({
  scope: collaborationScopeSchema,
  revision: z.number().int().min(0),
  responder: groupResponderSchema.optional(),
  alarm: alarmSubscriptionSchema.optional(),
  updatedAt: z.string().datetime()
}).strict();
export type CollaborationDuty = z.infer<typeof collaborationDutySchema>;

/** null 表示清掉，不传表示不改。 */
export const updateCollaborationDutyInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  responder: groupResponderSchema.nullable().optional(),
  alarm: alarmSubscriptionSchema.nullable().optional()
}).strict().refine(input => input.responder !== undefined || input.alarm !== undefined, {
  message: 'At least one field must be updated'
});
export type UpdateCollaborationDutyInput = z.infer<typeof updateCollaborationDutyInputSchema>;

export const senderKinds = ['human', 'bot', 'system'] as const;
export type SenderKind = (typeof senderKinds)[number];

export const observationOrigins = ['live', 'history', 'external'] as const;
export type ObservationOrigin = (typeof observationOrigins)[number];

export const collaborationObservationSchema = z.object({
  id: z.string().min(1).max(128),
  scope: collaborationScopeSchema,
  sequence: z.number().int().min(1),
  source: z.string().min(1).max(64),
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  senderId: z.string().max(128).optional(),
  senderKind: z.enum(senderKinds),
  threadId: z.string().max(128).optional(),
  messageId: z.string().max(128).optional(),
  text: z.string().max(16000),
  refs: z.array(z.string().max(256)).max(100).default([]),
  origin: z.enum(observationOrigins),
  missing: z.array(z.string().max(256)).max(100).default([]),
  revision: z.number().int().min(1)
}).strict();
export type CollaborationObservation = z.infer<typeof collaborationObservationSchema>;

export const observeCollaborationInputSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  scope: collaborationScopeSchema,
  source: z.string().min(1).max(64),
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  senderId: z.string().max(128).optional(),
  senderKind: z.enum(senderKinds),
  threadId: z.string().max(128).optional(),
  messageId: z.string().max(128).optional(),
  text: z.string().max(16000),
  refs: z.array(z.string().max(256)).max(100).default([]),
  origin: z.enum(observationOrigins),
  missing: z.array(z.string().max(256)).max(100).default([])
}).strict();
export type ObserveCollaborationInput = z.infer<typeof observeCollaborationInputSchema>;

export const listObservationsOptionsSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  afterSequence: z.number().int().min(0).optional(),
  threadId: z.string().max(128).optional()
}).strict();
export type ListObservationsOptions = z.infer<typeof listObservationsOptionsSchema>;

export const bootstrapStatuses = ['pending', 'running', 'complete', 'partial', 'failed'] as const;
export type BootstrapStatus = (typeof bootstrapStatuses)[number];

export const collaborationBootstrapSchema = z.object({
  scope: collaborationScopeSchema,
  status: z.enum(bootstrapStatuses),
  cursor: z.string().max(512).optional(),
  lastEventAt: z.string().datetime().optional(),
  missing: z.array(z.string().max(256)).max(100).default([]),
  updatedAt: z.string().datetime()
}).strict();
export type CollaborationBootstrap = z.infer<typeof collaborationBootstrapSchema>;

export const followupStepStatuses = ['open', 'done'] as const;
export type FollowupStepStatus = (typeof followupStepStatuses)[number];

export const collaborationFollowupStepSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(500),
  status: z.enum(followupStepStatuses)
}).strict();
export type CollaborationFollowupStep = z.infer<typeof collaborationFollowupStepSchema>;

export const followupStatuses = ['open', 'completed', 'cancelled'] as const;
export type FollowupStatus = (typeof followupStatuses)[number];

export const collaborationProvenances = ['observed', 'inferred', 'confirmed'] as const;
export type CollaborationProvenance = (typeof collaborationProvenances)[number];

export const MAX_FOLLOWUP_FIELDS = 50;
/** Persisted bounded JSON (decision inputSnapshot, action payload) hard ceiling. */
export const MAX_JSON_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB

class InvalidJsonPayloadError extends Error {}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Recursively checks that `node` has a faithful JSON representation.
 * JSON.stringify's replacer runs AFTER toJSON(), so it cannot see Date/Map/etc.;
 * walk the tree explicitly instead.
 * - finite numbers / strings / booleans / null are accepted
 * - NaN/Infinity, functions, symbols, bigints rejected
 * - non-plain objects (Date, Map, RegExp, class instances, ...) rejected
 * - `undefined` object property is allowed (JSON omits it); `undefined` array element is rejected
 * - circular references rejected via the seen set
 */
function assertFiniteJson(node: unknown, seen: WeakSet<object>, inArray: boolean): void {
  if (node === null) return;
  const kind = typeof node;
  if (kind === 'string' || kind === 'boolean') return;
  if (kind === 'number') {
    if (!Number.isFinite(node as number)) throw new InvalidJsonPayloadError();
    return;
  }
  if (kind === 'bigint' || kind === 'function' || kind === 'symbol') {
    throw new InvalidJsonPayloadError();
  }
  if (kind === 'undefined') {
    if (inArray) throw new InvalidJsonPayloadError();
    return;
  }
  if (kind !== 'object') throw new InvalidJsonPayloadError();

  const value = node as object;
  if (seen.has(value)) throw new InvalidJsonPayloadError();

  if (Array.isArray(value)) {
    seen.add(value);
    for (const element of value) assertFiniteJson(element, seen, true);
    seen.delete(value);
    return;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new InvalidJsonPayloadError();
  seen.add(value);
  for (const key of Object.keys(value)) {
    assertFiniteJson((value as Record<string, unknown>)[key], seen, false);
  }
  seen.delete(value);
}

/**
 * Validates that `value` is finite, representable JSON within `maxBytes`.
 * Plain objects/arrays/primitives only; see assertFiniteJson for rejection rules.
 */
export function validateJsonPayload(value: unknown, maxBytes: number = MAX_JSON_PAYLOAD_BYTES): boolean {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return false;
  }
  try {
    assertFiniteJson(value, new WeakSet<object>(), false);
  } catch {
    return false;
  }
  try {
    const str = JSON.stringify(value);
    if (typeof str !== 'string') return false;
    return utf8ByteLength(str) <= maxBytes;
  } catch {
    return false;
  }
}

export const followupFieldsSchema = z
  .record(z.string().max(128), z.string().max(2000))
  .default({})
  .refine(val => Object.keys(val).length <= MAX_FOLLOWUP_FIELDS, {
    message: 'Fields must contain at most 50 entries'
  });

export const collaborationFollowupSchema = z.object({
  id: z.string().min(1).max(128),
  scope: collaborationScopeSchema,
  revision: z.number().int().min(1),
  goal: z.string().trim().min(1).max(2000),
  status: z.enum(followupStatuses),
  progress: z.string().max(8000).default(''),
  steps: z.array(collaborationFollowupStepSchema).max(50).default([]),
  ownerId: z.string().max(128).optional(),
  dueAt: z.string().datetime().optional(),
  result: z.string().max(8000).optional(),
  sourceRefs: z.array(z.string().max(256)).max(100).default([]),
  taskIds: z.array(z.string().max(128)).max(100).default([]),
  externalRefs: z.array(z.string().max(256)).max(100).default([]),
  fields: followupFieldsSchema,
  createdBy: z.string().min(1).max(128),
  updatedBy: z.string().min(1).max(128),
  provenance: z.enum(collaborationProvenances),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type CollaborationFollowup = z.infer<typeof collaborationFollowupSchema>;

export const createFollowupInputSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  scope: collaborationScopeSchema,
  goal: z.string().trim().min(1).max(2000),
  status: z.enum(followupStatuses).default('open'),
  progress: z.string().max(8000).default(''),
  steps: z.array(collaborationFollowupStepSchema).max(50).default([]),
  ownerId: z.string().max(128).optional(),
  dueAt: z.string().datetime().optional(),
  result: z.string().max(8000).optional(),
  sourceRefs: z.array(z.string().max(256)).max(100).default([]),
  taskIds: z.array(z.string().max(128)).max(100).default([]),
  externalRefs: z.array(z.string().max(256)).max(100).default([]),
  fields: followupFieldsSchema,
  createdBy: z.string().min(1).max(128),
  updatedBy: z.string().min(1).max(128).optional(),
  provenance: z.enum(collaborationProvenances).default('observed')
}).strict();
export type CreateFollowupInput = z.infer<typeof createFollowupInputSchema>;

export const updateFollowupInputSchema = z.object({
  expectedRevision: z.number().int().min(1),
  goal: z.string().trim().min(1).max(2000).optional(),
  status: z.enum(followupStatuses).optional(),
  progress: z.string().max(8000).optional(),
  steps: z.array(collaborationFollowupStepSchema).max(50).optional(),
  ownerId: z.string().max(128).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  result: z.string().max(8000).nullable().optional(),
  sourceRefs: z.array(z.string().max(256)).max(100).optional(),
  taskIds: z.array(z.string().max(128)).max(100).optional(),
  externalRefs: z.array(z.string().max(256)).max(100).optional(),
  fields: z
    .record(z.string().max(128), z.string().max(2000))
    .refine(val => Object.keys(val).length <= MAX_FOLLOWUP_FIELDS, {
      message: 'Fields must contain at most 50 entries'
    })
    .optional(),
  provenance: z.enum(collaborationProvenances).optional()
}).strict().refine(input => Object.keys(input).some(key => key !== 'expectedRevision'), {
  message: 'At least one field must be updated'
});
export type UpdateFollowupInput = z.infer<typeof updateFollowupInputSchema>;

export const mandateStatuses = ['active', 'paused', 'cancelled', 'completed'] as const;
export type MandateStatus = (typeof mandateStatuses)[number];

export const mandateModes = ['notify', 'agent'] as const;
export type MandateMode = (typeof mandateModes)[number];

export const mandateConditions = ['always', 'followup_open', 'no_progress'] as const;
export type MandateCondition = (typeof mandateConditions)[number];

export const catchupPolicies = ['skip', 'coalesce'] as const;
export type CatchupPolicy = (typeof catchupPolicies)[number];

export const collaborationMandateSchema = z.object({
  id: z.string().min(1).max(128),
  scope: collaborationScopeSchema,
  revision: z.number().int().min(1),
  goal: z.string().trim().min(1).max(2000),
  status: z.enum(mandateStatuses),
  requesterId: z.string().min(1).max(128),
  sourceRefs: z.array(z.string().max(256)).max(100).default([]),
  followupId: z.string().max(128).optional(),
  scheduleDefinitionId: z.string().min(1).max(128),
  mode: z.enum(mandateModes),
  prompt: z.string().max(8000),
  condition: z.enum(mandateConditions),
  deliveryPaused: z.boolean().default(false),
  catchupPolicy: z.enum(catchupPolicies),
  lastProgressRevision: z.number().int().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type CollaborationMandate = z.infer<typeof collaborationMandateSchema>;

export const createMandateInputSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  scope: collaborationScopeSchema,
  goal: z.string().trim().min(1).max(2000),
  status: z.enum(mandateStatuses).default('active'),
  requesterId: z.string().min(1).max(128),
  sourceRefs: z.array(z.string().max(256)).max(100).default([]),
  followupId: z.string().max(128).optional(),
  scheduleDefinitionId: z.string().min(1).max(128),
  mode: z.enum(mandateModes),
  prompt: z.string().max(8000),
  condition: z.enum(mandateConditions).default('always'),
  deliveryPaused: z.boolean().default(false),
  catchupPolicy: z.enum(catchupPolicies).default('skip'),
  lastProgressRevision: z.number().int().min(1).optional()
}).strict();
export type CreateMandateInput = z.infer<typeof createMandateInputSchema>;

export const updateMandateInputSchema = z.object({
  expectedRevision: z.number().int().min(1),
  goal: z.string().trim().min(1).max(2000).optional(),
  status: z.enum(mandateStatuses).optional(),
  followupId: z.string().max(128).nullable().optional(),
  scheduleDefinitionId: z.string().min(1).max(128).optional(),
  mode: z.enum(mandateModes).optional(),
  prompt: z.string().max(8000).optional(),
  condition: z.enum(mandateConditions).optional(),
  deliveryPaused: z.boolean().optional(),
  catchupPolicy: z.enum(catchupPolicies).optional(),
  lastProgressRevision: z.number().int().min(1).nullable().optional(),
  sourceRefs: z.array(z.string().max(256)).max(100).optional()
}).strict().refine(input => Object.keys(input).some(key => key !== 'expectedRevision'), {
  message: 'At least one field must be updated'
});
export type UpdateMandateInput = z.infer<typeof updateMandateInputSchema>;

export const decisionActions = ['silent', 'reply', 'act'] as const;
export type DecisionAction = (typeof decisionActions)[number];

export const decisionStatuses = ['candidate', 'suppressed', 'sent', 'failed'] as const;
export type DecisionStatus = (typeof decisionStatuses)[number];

/** 标记「判定还没发生就被闸门挡下」的记录。这类记录不代表一次模型调用。 */
export const DECISION_BUDGET_GATE = 'decision_budget';
/** 判定用量统计窗口一次读多少条；与 listDecisions 的服务端硬上限一致，便于识别窗口读不全。 */
export const DECISION_WINDOW_LIMIT = 500;
/** 标记「一次由机器人触发的回合」。计入机器人预算，不是一次模型判定。 */
export const BOT_TURN_RECORD = 'bot_turn';
/** 标记「机器人回合被 loop guard 挡下」。既不是判定，也不消耗机器人预算。 */
export const BOT_LOOP_GATE = 'bot_loop_gate';
/** 每群每小时允许的机器人触发回合数。默认比人类判定预算严得多：机器人之间不会自己停。 */
export const BOT_TURN_LIMIT_PER_HOUR = 6;
/** 同一话题内连续「机器人往返」的轮数上限；中间出现人类触发的回合即归零。 */
export const BOT_LOOP_DEPTH_LIMIT = 3;
/** 标记「月度成本上限已用满，未判定」。没有调用模型，不计入判定预算。 */
export const USAGE_CAP_GATE = 'usage_cap';
/** 标记「告警订阅对一条来源 Bot 消息的处理」：起了初筛任务或因级别、重复、上限跳过。不调模型，不是参与判定。 */
export const ALARM_TRIAGE_RECORD = 'alarm_triage';

/** 不代表一次模型判定的记录标记，统计判定用量时必须全部排除。 */
const nonDecisionGates = new Set<string>([DECISION_BUDGET_GATE, BOT_TURN_RECORD, BOT_LOOP_GATE, USAGE_CAP_GATE, ALARM_TRIAGE_RECORD]);
const gateOf = (item: Pick<CollaborationDecision, 'inputSnapshot'>) => String((item.inputSnapshot as { gate?: unknown }).gate ?? '');
/** 判定记录是否是闸门留痕（预算、成本上限、机器人回合、告警订阅），不是参与判定对某条人类消息的判断。 */
export const isDecisionGate = (item: Pick<CollaborationDecision, 'inputSnapshot'>): boolean => nonDecisionGates.has(gateOf(item));
export const isAlarmRecord = (item: Pick<CollaborationDecision, 'inputSnapshot'>): boolean => gateOf(item) === ALARM_TRIAGE_RECORD;

/**
 * 判定来源，存在 inputSnapshot.decider 里；inputSnapshot 其余部分仍是可回放的判定输入。
 * rule 是规则层直接给出的结论（没调模型），model 是调了模型的判定，durationMs 是那次模型调用的耗时。
 * trigger 记下被判定的那条人类消息，漏接标记和「为什么没回」据此找回原消息；facts 是规则用到的外部事实（如群成员数），回放时照用。
 */
export interface CollaborationDeciderMeta {
  kind: 'rule' | 'model';
  rule?: string;
  durationMs?: number;
  trigger?: { id: string; messageId?: string; senderId?: string; threadId?: string; text?: string };
  facts?: Record<string, string | number | boolean>;
}
export const DECIDER_META_KEY = 'decider';
export function deciderMetaOf(item: Pick<CollaborationDecision, 'inputSnapshot'>): CollaborationDeciderMeta | undefined {
  const meta = (item.inputSnapshot as Record<string, unknown>)[DECIDER_META_KEY];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const kind = (meta as { kind?: unknown }).kind;
  return kind === 'rule' || kind === 'model' ? meta as CollaborationDeciderMeta : undefined;
}

/**
 * 统计窗口内真正跑过模型的判定条数。
 * 被闸门挡下的记录必须排除：否则一旦超限，后续每条消息都会再记一条，用量永远降不回来。
 * 规则层的结论没有调模型，同样不占判定预算。
 */
export function countDecisionUsage(decisions: Array<Pick<CollaborationDecision, 'createdAt' | 'inputSnapshot'>>, sinceMs: number): number {
  return decisions.filter(item => Date.parse(item.createdAt) >= sinceMs && !nonDecisionGates.has(gateOf(item)) && deciderMetaOf(item)?.kind !== 'rule').length;
}

/**
 * 纯记账行：机器人回合每放行一次写一条，只为让预算可数。
 * 它不是判定也不是闸门，没有给人读的内容，列判定历史时应当滤掉——
 * 否则活跃几小时后，判定列表里就只剩记账行，真正的判定被挤出窗口。
 */
export const isBotTurnRecord = (item: Pick<CollaborationDecision, 'inputSnapshot'>): boolean => gateOf(item) === BOT_TURN_RECORD;

/**
 * 统计窗口内由机器人触发的回合数，与人类判定用量分开计。
 * 同样排除闸门记录：被挡下的回合不是一次回合，否则超限之后预算永远降不回来。
 */
export function countBotTurnUsage(decisions: Array<Pick<CollaborationDecision, 'createdAt' | 'inputSnapshot'>>, sinceMs: number): number {
  return decisions.filter(item => Date.parse(item.createdAt) >= sinceMs && isBotTurnRecord(item)).length;
}

export const boundedJsonRecordSchema = z
  .record(z.string(), z.unknown())
  .refine(val => validateJsonPayload(val, MAX_JSON_PAYLOAD_BYTES), {
    message: 'JSON payload exceeds maximum byte limit (1MiB) or contains circular/non-JSON data'
  });

export const collaborationDecisionSchema = z.object({
  id: z.string().min(1).max(128),
  scope: collaborationScopeSchema,
  contextRevision: z.number().int().min(0),
  policyVersion: z.string().min(1).max(64),
  action: z.enum(decisionActions),
  reason: z.string().max(2000),
  evidenceIds: z.array(z.string().max(128)).max(100).default([]),
  status: z.enum(decisionStatuses),
  response: z.string().max(16000).optional(),
  inputSnapshot: boundedJsonRecordSchema,
  createdAt: z.string().datetime()
}).strict();
export type CollaborationDecision = z.infer<typeof collaborationDecisionSchema>;

export const updateDecisionInputSchema = z.object({
  status: z.enum(decisionStatuses),
  response: z.string().max(16000).nullable().optional()
}).strict();
export type UpdateDecisionInput = z.infer<typeof updateDecisionInputSchema>;

export const collaborationFeedbackSchema = z.object({
  id: z.string().min(1).max(128),
  scope: collaborationScopeSchema,
  decisionId: z.string().min(1).max(128),
  actorId: z.string().min(1).max(128),
  correction: z.string().trim().min(1).max(4000),
  expectedAction: z.enum(decisionActions).optional(),
  createdAt: z.string().datetime()
}).strict();
export type CollaborationFeedback = z.infer<typeof collaborationFeedbackSchema>;

/**
 * 自动记录的纠正标签写在 correction 开头：漏接（判沉默后很快又被 @）期望回应，误插（主动回复被嫌弃）期望沉默。
 * 回放评测按标签判：漏接只要求不再沉默，不区分 reply 与 act。
 */
export const MISSED_FEEDBACK_PREFIX = '[漏接]';
export const INTRUSIVE_FEEDBACK_PREFIX = '[误插]';
export function feedbackLabelOf(feedback: Pick<CollaborationFeedback, 'correction'>): 'missed' | 'intrusive' | undefined {
  if (feedback.correction.startsWith(MISSED_FEEDBACK_PREFIX)) return 'missed';
  if (feedback.correction.startsWith(INTRUSIVE_FEEDBACK_PREFIX)) return 'intrusive';
  return undefined;
}

export const createFeedbackInputSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  scope: collaborationScopeSchema,
  decisionId: z.string().min(1).max(128),
  actorId: z.string().min(1).max(128),
  correction: z.string().trim().min(1).max(4000),
  expectedAction: z.enum(decisionActions).optional(),
  createdAt: z.string().datetime().optional()
}).strict();
export type CreateFeedbackInput = z.infer<typeof createFeedbackInputSchema>;

export const actionStatuses = ['intent', 'sending', 'succeeded', 'failed', 'unknown', 'suppressed'] as const;
export type ActionStatus = (typeof actionStatuses)[number];

export const collaborationActionSchema = z.object({
  id: z.string().min(1).max(128),
  scope: collaborationScopeSchema,
  revision: z.number().int().min(1),
  kind: z.string().min(1).max(64),
  mandateId: z.string().max(128).optional(),
  mandateRevision: z.number().int().min(1).optional(),
  scheduleGeneration: z.number().int().min(1).optional(),
  contextRevision: z.number().int().min(0).optional(),
  followupRevision: z.number().int().min(1).optional(),
  requesterId: z.string().min(1).max(128),
  inputDigest: z.string().min(1).max(128),
  payload: boundedJsonRecordSchema,
  status: z.enum(actionStatuses),
  receipt: z.string().max(4000).optional(),
  error: z.string().max(4000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type CollaborationAction = z.infer<typeof collaborationActionSchema>;

export const beginActionInputSchema = z.object({
  id: z.string().min(1).max(128),
  scope: collaborationScopeSchema,
  kind: z.string().min(1).max(64),
  mandateId: z.string().max(128).optional(),
  mandateRevision: z.number().int().min(1).optional(),
  scheduleGeneration: z.number().int().min(1).optional(),
  contextRevision: z.number().int().min(0).optional(),
  followupRevision: z.number().int().min(1).optional(),
  requesterId: z.string().min(1).max(128),
  inputDigest: z.string().min(1).max(128),
  payload: boundedJsonRecordSchema.default({})
}).strict();
export type BeginActionInput = z.infer<typeof beginActionInputSchema>;

export const updateActionInputSchema = z.object({
  expectedRevision: z.number().int().min(1),
  status: z.enum(actionStatuses),
  receipt: z.string().max(4000).nullable().optional(),
  error: z.string().max(4000).nullable().optional()
}).strict();
export type UpdateActionInput = z.infer<typeof updateActionInputSchema>;

export const activityEntityKinds = ['followup', 'mandate', 'settings'] as const;
export type ActivityEntityKind = (typeof activityEntityKinds)[number];

export const collaborationActivitySchema = z.object({
  id: z.string().min(1).max(128),
  scope: collaborationScopeSchema,
  entityKind: z.enum(activityEntityKinds),
  entityId: z.string().min(1).max(128),
  revision: z.number().int().min(0),
  actorId: z.string().min(1).max(128),
  sourceRefs: z.array(z.string().max(256)).default([]),
  provenance: z.enum(collaborationProvenances),
  summary: z.string().max(1000),
  createdAt: z.string().datetime()
}).strict();
export type CollaborationActivity = z.infer<typeof collaborationActivitySchema>;

export const collaborationTeamContextSchema = z.object({
  query: z.string().max(2000),
  searchedAt: z.string().datetime(),
  sources: z.array(z.object({
    scope: collaborationScopeSchema,
    name: z.string().max(256),
    status: z.enum(['complete', 'partial', 'unavailable']),
    missing: z.array(z.string().max(256)).max(100)
  }).strict()),
  observations: z.array(collaborationObservationSchema)
}).strict();
export type CollaborationTeamContext = z.infer<typeof collaborationTeamContextSchema>;

export const collaborationSnapshotSchema = z.object({
  scope: collaborationScopeSchema,
  contextRevision: z.number().int().min(0),
  settings: collaborationSettingsSchema,
  observations: z.array(collaborationObservationSchema),
  followups: z.array(collaborationFollowupSchema),
  mandates: z.array(collaborationMandateSchema),
  bootstrap: collaborationBootstrapSchema.optional(),
  teamContext: collaborationTeamContextSchema.optional()
}).strict();
export type CollaborationSnapshot = z.infer<typeof collaborationSnapshotSchema>;

export interface CollaborationRepository {
  getSettings(scope: CollaborationScope): Promise<CollaborationSettings>;
  updateSettings(scope: CollaborationScope, patch: UpdateCollaborationSettingsInput, actorId: string): Promise<CollaborationSettings>;
  getDuty(scope: CollaborationScope): Promise<CollaborationDuty>;
  updateDuty(scope: CollaborationScope, patch: UpdateCollaborationDutyInput, actorId: string): Promise<CollaborationDuty>;
  observe(input: ObserveCollaborationInput): Promise<{ observation: CollaborationObservation; created: boolean; changed: boolean; contextRevision: number }>;
  listObservations(scope: CollaborationScope, options?: ListObservationsOptions): Promise<CollaborationObservation[]>;
  snapshot(scope: CollaborationScope, limit?: number): Promise<CollaborationSnapshot>;
  getBootstrap(scope: CollaborationScope): Promise<CollaborationBootstrap | undefined>;
  saveBootstrap(input: CollaborationBootstrap): Promise<CollaborationBootstrap>;
  pruneObservations(before: string, scope?: CollaborationScope): Promise<number>;
  createFollowup(input: CreateFollowupInput): Promise<CollaborationFollowup>;
  getFollowup(scope: CollaborationScope, id: string): Promise<CollaborationFollowup | undefined>;
  listFollowups(scope: CollaborationScope): Promise<CollaborationFollowup[]>;
  updateFollowup(scope: CollaborationScope, id: string, patch: UpdateFollowupInput, actorId: string): Promise<CollaborationFollowup>;
  createMandate(input: CreateMandateInput): Promise<CollaborationMandate>;
  getMandate(scope: CollaborationScope, id: string): Promise<CollaborationMandate | undefined>;
  listMandates(scope?: CollaborationScope): Promise<CollaborationMandate[]>;
  updateMandate(scope: CollaborationScope, id: string, patch: UpdateMandateInput, actorId: string): Promise<CollaborationMandate>;
  recordDecision(input: CollaborationDecision): Promise<CollaborationDecision>;
  getDecision(scope: CollaborationScope, id: string): Promise<CollaborationDecision | undefined>;
  listDecisions(scope: CollaborationScope, limit?: number): Promise<CollaborationDecision[]>;
  updateDecision(scope: CollaborationScope, id: string, patch: UpdateDecisionInput): Promise<CollaborationDecision>;
  addFeedback(input: CollaborationFeedback): Promise<CollaborationFeedback>;
  listFeedback(scope: CollaborationScope, decisionId?: string): Promise<CollaborationFeedback[]>;
  beginAction(input: BeginActionInput): Promise<{ action: CollaborationAction; created: boolean }>;
  getAction(scope: CollaborationScope, id: string): Promise<CollaborationAction | undefined>;
  listActions(scope?: CollaborationScope, limit?: number): Promise<CollaborationAction[]>;
  listPendingActions(appId: string, kind: string): Promise<CollaborationAction[]>;
  updateAction(scope: CollaborationScope, id: string, patch: UpdateActionInput): Promise<CollaborationAction>;
  listActivities(scope: CollaborationScope, limit?: number): Promise<CollaborationActivity[]>;
}
