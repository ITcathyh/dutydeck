import safeRegex from 'safe-regex2';
import { z } from 'zod';
import { pluginSkillRefSchema, type PluginBindingContext } from './plugin-bindings.js';

/**
 * 场景包格式：插件清单 `scenarios` 目录下的每个 `<id>.json` 是一个包。
 * 这里只做不执行任何代码的静态校验（格式、参数指针、direct 强制契约、模板变量、正则标志与语法、上限）；
 * 正则由宿主隔离执行，provider 在信任确认之后才解析，见 apps/server/src/plugins/。
 */

export const scenarioPackIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const scenarioProviderIdPattern = /^[a-z][a-z0-9_-]*$/;
const paramNamePattern = /^[a-z][A-Za-z0-9]*$/;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

/** 核心上限：包里写得更大时静态校验拒绝；运行时取值再按这里封顶。 */
export const SCENARIO_LIMITS = {
  dedupeWindowHours: { default: 6, min: 1, max: 168 },
  perHour: { default: 3, min: 1, max: 30 },
  phraseMaxLength: 60,
  triggerInputChars: 4_000,
  regexSourceChars: 1_000,
  regexTimeoutMs: 200,
  guidanceChars: 2_000,
  matchTimeoutMs: 500,
  correlationTimeoutMs: 1_000,
  context: { timeoutMs: { default: 5_000, max: 15_000 }, maxChars: { default: 6_000, max: 16_000 }, decisionChars: { default: 2_000, max: 4_000 }, itemChars: 4_000 }
} as const;

/** 包作者写的正则只允许这些标志；需要取全部匹配时由宿主在隔离线程里加 g。 */
export const scenarioRegexFlags = ['i', 'm', 's', 'u'] as const;

/** 宿主生成的模板变量名；参数不能和它们重名。 */
const hostVariables = ['source', 'date', 'headline', 'url', 'summary', 'time', 'reason', 'snippet', 'requesterId'] as const;

export const scenarioOutcomes = ['started', 'filtered', 'duplicate', 'rate_limited', 'not_responder', 'no_requester', 'window_incomplete', 'abstained'] as const;
export type ScenarioOutcome = (typeof scenarioOutcomes)[number];

const text = (max: number) => z.string().min(1).max(max);
const providerId = z.string().max(64).regex(scenarioProviderIdPattern, '只能用小写字母、数字、- 和 _，以字母开头');
const paramRef = z.string().regex(paramNamePattern, '参数名必须是小写字母开头的 camelCase');

function checkRegex(value: { source: string; flags?: string }, context: z.RefinementCtx) {
  const flags = value.flags ?? '';
  const bad = [...flags].filter(flag => !(scenarioRegexFlags as readonly string[]).includes(flag));
  if (bad.length) { context.addIssue({ code: 'custom', path: ['flags'], message: `不支持标志 ${bad.join('')}：只允许 i、m、s、u（g、y 由宿主控制）` }); return; }
  if (new Set(flags).size !== flags.length) { context.addIssue({ code: 'custom', path: ['flags'], message: '标志重复' }); return; }
  // 只编译不执行。
  try { new RegExp(value.source, flags); }
  catch (error) { context.addIssue({ code: 'custom', path: ['source'], message: `正则语法错误：${error instanceof Error ? error.message : String(error)}` }); }
}

const regexShape = { source: z.string().min(1).max(SCENARIO_LIMITS.regexSourceChars), flags: z.string().max(4).optional() };
export const scenarioRegexSchema = z.object(regexShape).strict().superRefine(checkRegex);
export type ScenarioRegex = z.infer<typeof scenarioRegexSchema>;
const captureSchema = z.object({ ...regexShape, all: z.boolean().optional(), transform: z.literal('upper').optional() }).strict().superRefine(checkRegex);

export const scenarioParamSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('integer'), label: text(64), hint: text(200).optional(), min: z.number().int(), max: z.number().int(), default: z.number().int() }).strict(),
  z.object({ type: z.literal('string_list'), label: text(64), hint: text(200).optional(), maxItems: z.number().int().min(1).max(100), maxLength: z.number().int().min(1).max(256), default: z.array(z.string()), empty: text(32).optional() }).strict(),
  z.object({ type: z.literal('bot_list'), label: text(64), hint: text(200).optional(), maxItems: z.number().int().min(1).max(100), role: z.literal('source'), inferOnEnable: z.boolean().optional(), empty: text(32).optional() }).strict()
]).superRefine((param, context) => {
  if (param.type === 'integer') {
    if (param.min > param.max) context.addIssue({ code: 'custom', path: ['min'], message: 'min 不能大于 max' });
    else if (param.default < param.min || param.default > param.max) context.addIssue({ code: 'custom', path: ['default'], message: `默认值要在 ${param.min}–${param.max} 之间` });
  }
  if (param.type === 'string_list') {
    if (param.default.length > param.maxItems) context.addIssue({ code: 'custom', path: ['default'], message: `默认值最多 ${param.maxItems} 项` });
    param.default.forEach((item, index) => { if (!item || item.length > param.maxLength) context.addIssue({ code: 'custom', path: ['default', index], message: `每项 1–${param.maxLength} 个字符` }); });
  }
});
export type ScenarioParam = z.infer<typeof scenarioParamSchema>;

const outcomeReasons = z.object(Object.fromEntries(scenarioOutcomes.map(outcome => [outcome, text(200).optional()])) as Record<ScenarioOutcome, z.ZodOptional<z.ZodString>>).strict();

const scenarioPackObject = z.object({
  // 最多 32 字符：确认单种类 confirm.scenario:<id> 不超过 64，开话题第一句的幂等键截到 50 后还留得下摘要。
  id: z.string().max(32).regex(scenarioPackIdPattern, '必须是 kebab-case，例如 team-faq'),
  version: z.string().regex(versionPattern, '必须是 x.y.z 形式的版本号'),
  title: text(64),
  noun: text(16),
  description: text(1_000),
  mode: z.enum(['direct', 'model']),
  params: z.record(paramRef, scenarioParamSchema),
  trigger: z.object({
    senderKinds: z.union([z.tuple([z.literal('bot')]), z.tuple([z.literal('human')])]),
    sourceBotsParam: paramRef.optional(),
    messageTypes: z.array(z.string().min(1).max(32)).min(1).max(20).optional(),
    match: z.object({ textAnyParam: paramRef.optional(), pattern: scenarioRegexSchema.optional(), provider: providerId.optional() }).strict().optional(),
    filter: z.object({ keywordsAnyParam: paramRef }).strict().optional()
  }).strict(),
  decision: z.object({ guidance: text(SCENARIO_LIMITS.guidanceChars) }).strict().optional(),
  skills: z.array(pluginSkillRefSchema).max(16).optional(),
  execution: z.object({ instruction: text(4_000), intro: text(500).optional() }).strict(),
  dedupe: z.union([z.object({ algorithm: z.literal('source_text_v1') }).strict(), z.object({ provider: providerId }).strict()]).optional(),
  dedupeWindowHoursParam: paramRef.optional(),
  quota: z.object({ perHourParam: paramRef }).strict().optional(),
  correlation: z.object({
    provider: providerId,
    requiredFields: z.array(text(64)).min(1).max(10),
    optionalFields: z.array(text(64)).max(10).optional(),
    scope: z.enum(['always', 'enabled']),
    prompt: text(2_000),
    cardLine: text(300)
  }).strict().optional(),
  context: z.object({
    provider: providerId,
    timeoutMs: z.number().int().min(100).max(SCENARIO_LIMITS.context.timeoutMs.max).optional(),
    maxChars: z.number().int().min(1).max(SCENARIO_LIMITS.context.maxChars.max).optional(),
    decisionChars: z.number().int().min(1).max(SCENARIO_LIMITS.context.decisionChars.max).optional()
  }).strict().optional(),
  topicOwnership: z.object({ sourceTopics: z.literal('neutral') }).strict().optional(),
  phrases: z.object({
    maxLength: z.number().int().min(1).max(SCENARIO_LIMITS.phraseMaxLength),
    enable: z.array(scenarioRegexSchema).min(1).max(20),
    disable: z.array(scenarioRegexSchema).min(1).max(20),
    capture: z.record(paramRef, captureSchema).optional(),
    examples: z.object({ enable: z.array(text(SCENARIO_LIMITS.phraseMaxLength)).min(1).max(20), disable: z.array(text(SCENARIO_LIMITS.phraseMaxLength)).min(1).max(20) }).strict()
  }).strict().optional(),
  confirm: z.object({ enableTitle: text(64), disableTitle: text(64), enableSummary: text(1_000), disableSummary: text(1_000), enabledResult: text(1_000), disabledResult: text(500) }).strict(),
  status: z.object({ summary: text(1_000), actedLabel: text(16) }).strict(),
  reasons: outcomeReasons.optional(),
  explain: z.object({ acted: text(500), skipped: text(500), note: text(500) }).strict().optional(),
  web: z.object({ description: text(1_000), enableHint: text(500).optional() }).strict().optional()
}).strict();

export type ScenarioPack = z.infer<typeof scenarioPackObject>;
/** 模板：`{name}` 替换；`{name?有值:为空}` 二选一，只支持一层，分支里只能再用 `{name}`。字面 `{`、`}` 不允许出现。 */
export type ScenarioTemplate = string;

export class ScenarioTemplateError extends Error {
  constructor(message: string) { super(message); this.name = 'ScenarioTemplateError'; }
}

/** 解析模板，返回用到的变量名；语法不对时抛 ScenarioTemplateError。 */
export function parseScenarioTemplate(template: string): string[] {
  const variables = new Set<string>();
  let index = 0;
  const readName = () => {
    const match = /^[A-Za-z][A-Za-z0-9_]*/.exec(template.slice(index));
    if (!match) throw new ScenarioTemplateError(`第 ${index + 1} 个字符：{ 后面要跟变量名；字面的 { } 不能出现在模板里`);
    index += match[0].length;
    variables.add(match[0]);
    return match[0];
  };
  const readBranch = (end: ':' | '}') => {
    while (index < template.length) {
      const char = template[index]!;
      if (char === end) { index += 1; return; }
      if (char === '}') throw new ScenarioTemplateError(`第 ${index + 1} 个字符：条件缺少 :`);
      if (char === '{') {
        index += 1;
        readName();
        if (template[index] !== '}') throw new ScenarioTemplateError(`第 ${index + 1} 个字符：条件分支里只能用 {变量}，条件只支持一层`);
      }
      index += 1;
    }
    throw new ScenarioTemplateError('条件没有闭合');
  };
  while (index < template.length) {
    const char = template[index]!;
    if (char === '}') throw new ScenarioTemplateError(`第 ${index + 1} 个字符：多余的 }`);
    index += 1;
    if (char !== '{') continue;
    const name = readName();
    if (template[index] === '}') { index += 1; continue; }
    if (template[index] !== '?') throw new ScenarioTemplateError(`第 ${index + 1} 个字符：{${name} 后面只能是 } 或 ?`);
    index += 1;
    readBranch(':');
    readBranch('}');
  }
  return [...variables];
}

/** 每个模板位置允许的变量。消息正文和模型输出不在任何进入 prompt 的位置上。 */
function templateFields(pack: ScenarioPack): Array<{ path: Array<string | number>; value: string | undefined; allowed: readonly string[] }> {
  const params = Object.keys(pack.params);
  const direct = pack.mode === 'direct';
  return [
    { path: ['execution', 'instruction'], value: pack.execution.instruction, allowed: direct ? ['source'] : [] },
    { path: ['execution', 'intro'], value: pack.execution.intro, allowed: ['source'] },
    { path: ['correlation', 'prompt'], value: pack.correlation?.prompt, allowed: ['date'] },
    { path: ['correlation', 'cardLine'], value: pack.correlation?.cardLine, allowed: ['date', 'headline', 'url'] },
    ...(['enableSummary', 'disableSummary', 'enabledResult'] as const).map(key => ({ path: ['confirm', key], value: pack.confirm[key], allowed: ['summary', ...params] })),
    { path: ['status', 'summary'], value: pack.status.summary, allowed: params },
    ...(['acted', 'skipped', 'note'] as const).map(key => ({ path: ['explain', key], value: pack.explain?.[key], allowed: ['time', 'reason', 'snippet'] })),
    { path: ['web', 'description'], value: pack.web?.description, allowed: ['requesterId', ...params] }
  ];
}

/** 只放字面文字的位置：出现 `{变量}` 写法就拒绝，免得作者以为会被替换。 */
function literalFields(pack: ScenarioPack): Array<{ path: Array<string | number>; value: string | undefined }> {
  return [
    { path: ['title'], value: pack.title }, { path: ['noun'], value: pack.noun }, { path: ['description'], value: pack.description },
    { path: ['decision', 'guidance'], value: pack.decision?.guidance },
    { path: ['confirm', 'enableTitle'], value: pack.confirm.enableTitle }, { path: ['confirm', 'disableTitle'], value: pack.confirm.disableTitle },
    { path: ['confirm', 'disabledResult'], value: pack.confirm.disabledResult }, { path: ['status', 'actedLabel'], value: pack.status.actedLabel },
    { path: ['web', 'enableHint'], value: pack.web?.enableHint },
    ...Object.entries(pack.reasons ?? {}).map(([key, value]) => ({ path: ['reasons', key], value })),
    ...Object.entries(pack.params).flatMap(([name, param]) => [
      { path: ['params', name, 'label'], value: param.label }, { path: ['params', name, 'hint'], value: param.hint },
      { path: ['params', name, 'empty'], value: param.type === 'integer' ? undefined : param.empty }
    ])
  ];
}

export const scenarioPackSchema = scenarioPackObject.superRefine((pack, context) => {
  const issue = (path: Array<string | number>, message: string) => context.addIssue({ code: 'custom', path, message });
  const direct = pack.mode === 'direct';
  const forbid = (present: unknown, path: Array<string | number>, message: string) => { if (present !== undefined) issue(path, message); };

  if (pack.trigger.senderKinds[0] !== (direct ? 'bot' : 'human')) issue(['trigger', 'senderKinds'], direct ? 'direct 模式只能由机器人消息触发：["bot"]' : 'model 模式只能由真人消息触发：["human"]');

  for (const name of Object.keys(pack.params)) if ((hostVariables as readonly string[]).includes(name)) issue(['params', name], `参数名 ${name} 和宿主变量重名`);
  const pointer = (path: Array<string | number>, name: string | undefined, type: ScenarioParam['type'], range?: { min: number; max: number }) => {
    if (name === undefined) return;
    const param = pack.params[name];
    if (!param) { issue(path, `参数 ${name} 没有在 params 里声明`); return; }
    if (param.type !== type) { issue(path, `参数 ${name} 应当是 ${type} 类型`); return; }
    if (range && param.type === 'integer' && (param.min < range.min || param.max > range.max)) issue(path, `参数 ${name} 的取值范围要在 ${range.min}–${range.max} 之内`);
  };
  pointer(['trigger', 'sourceBotsParam'], pack.trigger.sourceBotsParam, 'bot_list');
  pointer(['trigger', 'match', 'textAnyParam'], pack.trigger.match?.textAnyParam, 'string_list');
  pointer(['trigger', 'filter', 'keywordsAnyParam'], pack.trigger.filter?.keywordsAnyParam, 'string_list');
  pointer(['dedupeWindowHoursParam'], pack.dedupeWindowHoursParam, 'integer', SCENARIO_LIMITS.dedupeWindowHours);
  pointer(['quota', 'perHourParam'], pack.quota?.perHourParam, 'integer', SCENARIO_LIMITS.perHour);
  for (const name of Object.keys(pack.phrases?.capture ?? {})) if (!pack.params[name]) issue(['phrases', 'capture', name], `参数 ${name} 没有在 params 里声明`);

  if (direct) {
    // direct 强制契约（来源、去重、额度在这里静态检查；排除自身、确认人、只在接话人上运行由运行时强制）。
    if (!pack.trigger.sourceBotsParam) issue(['trigger', 'sourceBotsParam'], 'direct 模式必须声明来源机器人参数（bot_list，role: source）');
    if (!pack.dedupe) issue(['dedupe'], 'direct 模式必须声明去重方式');
    if (!pack.dedupeWindowHoursParam) issue(['dedupeWindowHoursParam'], 'direct 模式必须声明去重窗口参数（integer）');
    if (!pack.quota) issue(['quota'], 'direct 模式必须声明每小时上限参数（integer）');
    // 确认人只能由群里的开关短语弹出的确认卡写入，Web 和 CLI 都要求已有确认人；没有短语的 direct 包永远开不了。
    if (!pack.phrases) issue(['phrases'], 'direct 模式必须声明开关短语（phrases.enable 和 phrases.disable）：确认人只能在群里说开关短语、点确认卡写入');
    forbid(pack.decision, ['decision'], 'decision 只用于 model 模式');
    forbid(pack.context, ['context'], 'context 只用于 model 模式');
  } else {
    if (!pack.decision) issue(['decision'], 'model 模式必须写 decision.guidance');
    forbid(pack.trigger.sourceBotsParam, ['trigger', 'sourceBotsParam'], 'sourceBotsParam 只用于 direct 模式');
    forbid(pack.trigger.filter, ['trigger', 'filter'], 'trigger.filter 只用于 direct 模式；model 模式用 trigger.match 选消息');
    forbid(pack.execution.intro, ['execution', 'intro'], 'execution.intro 只用于 direct 模式');
    forbid(pack.dedupe, ['dedupe'], 'dedupe 只用于 direct 模式');
    forbid(pack.dedupeWindowHoursParam, ['dedupeWindowHoursParam'], 'dedupeWindowHoursParam 只用于 direct 模式');
    forbid(pack.quota, ['quota'], 'quota 只用于 direct 模式');
    forbid(pack.topicOwnership, ['topicOwnership'], 'topicOwnership 只用于 direct 模式');
  }

  for (const field of templateFields(pack)) {
    if (field.value === undefined) continue;
    try {
      const unknown = parseScenarioTemplate(field.value).filter(name => !field.allowed.includes(name));
      if (unknown.length) issue(field.path, `这里不能用变量 ${unknown.map(name => `{${name}}`).join('、')}；${field.allowed.length ? `可用 ${field.allowed.map(name => `{${name}}`).join('、')}` : '只能写字面文字'}`);
    } catch (error) { issue(field.path, error instanceof Error ? error.message : String(error)); }
  }
  for (const field of literalFields(pack)) {
    if (field.value !== undefined && /\{[A-Za-z][A-Za-z0-9_]*[}?]/.test(field.value)) issue(field.path, '这里是字面文字，不做变量替换，不能写 {变量}');
  }
  if (pack.phrases) for (const [kind, examples] of Object.entries(pack.phrases.examples)) examples.forEach((example, index) => {
    if (example.length > pack.phrases!.maxLength) issue(['phrases', 'examples', kind, index], `超过 maxLength（${pack.phrases!.maxLength}）`);
  });
});

export interface ScenarioPackIssue { field?: string; message: string }

/** 包里所有正则的位置，供 safe-regex2 提示和宿主隔离执行使用。 */
export function scenarioPackRegexes(pack: ScenarioPack): Array<{ field: string; regex: ScenarioRegex }> {
  return [
    ...(pack.trigger.match?.pattern ? [{ field: 'trigger.match.pattern', regex: pack.trigger.match.pattern }] : []),
    ...(pack.phrases?.enable ?? []).map((regex, index) => ({ field: `phrases.enable.${index}`, regex })),
    ...(pack.phrases?.disable ?? []).map((regex, index) => ({ field: `phrases.disable.${index}`, regex })),
    ...Object.entries(pack.phrases?.capture ?? {}).map(([name, regex]) => ({ field: `phrases.capture.${name}`, regex: { source: regex.source, ...(regex.flags ? { flags: regex.flags } : {}) } }))
  ];
}

/** 包引用的 provider 和要用到的方法：去重键由 match 返回。 */
export function scenarioProviderRefs(pack: ScenarioPack): Array<{ field: string; id: string; method: 'match' | 'context' | 'correlationKey' }> {
  return [
    ...(pack.trigger.match?.provider ? [{ field: 'trigger.match.provider', id: pack.trigger.match.provider, method: 'match' as const }] : []),
    ...(pack.dedupe && 'provider' in pack.dedupe ? [{ field: 'dedupe.provider', id: pack.dedupe.provider, method: 'match' as const }] : []),
    ...(pack.correlation ? [{ field: 'correlation.provider', id: pack.correlation.provider, method: 'correlationKey' as const }] : []),
    ...(pack.context ? [{ field: 'context.provider', id: pack.context.provider, method: 'context' as const }] : [])
  ];
}

/**
 * 静态校验一个包。issues 不为空时这个包不能加载；warnings 只是提示：
 * safe-regex2 会放过 `/a+a$/` 这类二次增长的写法，不能作为安全依据，安全靠宿主的隔离执行和超时。
 */
export function validateScenarioPack(raw: unknown): { pack?: ScenarioPack; issues: ScenarioPackIssue[]; warnings: ScenarioPackIssue[] } {
  const parsed = scenarioPackSchema.safeParse(raw);
  if (!parsed.success) return { issues: parsed.error.issues.map(issue => ({ ...(issue.path.length ? { field: issue.path.join('.') } : {}), message: issue.message })), warnings: [] };
  const warnings = scenarioPackRegexes(parsed.data)
    .filter(({ regex }) => !safeRegex(regex.source))
    .map(({ field }) => ({ field, message: '正则可能有灾难性回溯；运行时超过 200ms 会被终止，这条消息上这个包弃权' }));
  return { pack: parsed.data, issues: [], warnings };
}

export const scenarioMajorVersion = (version: string): number | undefined => {
  const match = versionPattern.exec(version);
  return match ? Number(match[1]) : undefined;
};

export const scenarioBindingSchema = z.object({
  enabled: z.boolean(),
  params: z.record(z.unknown()),
  /** 只能由群里的确认卡写入。 */
  requesterId: z.string().min(1).optional(),
  /** 只能由群里的确认卡写入；大版本和包不一致时绑定视为关闭。 */
  packVersion: z.string().regex(versionPattern)
}).strict();
export type ScenarioBinding = z.infer<typeof scenarioBindingSchema>;

/** bot_list 参数的一项：appId 用来匹配消息发送者，name 只用于展示。 */
export const scenarioBotRefSchema = z.object({ appId: z.string().trim().min(1).max(128), name: z.string().trim().max(128).optional() }).strict();
export type ScenarioBotRef = z.infer<typeof scenarioBotRefSchema>;

/** 一个参数的取值校验：integer 在 min–max 之间；string_list 每项 1–maxLength 字；bot_list 是 { appId, name? } 列表。 */
export function scenarioParamValueSchema(param: ScenarioParam): z.ZodTypeAny {
  if (param.type === 'integer') return z.number().int().min(param.min).max(param.max);
  if (param.type === 'string_list') return z.array(z.string().trim().min(1).max(param.maxLength)).max(param.maxItems);
  return z.array(scenarioBotRefSchema).max(param.maxItems);
}
/** 参数缺省值；bot_list 没有缺省值，为空列表。 */
export const scenarioParamDefault = (param: ScenarioParam): unknown => param.type === 'bot_list' ? [] : param.type === 'string_list' ? [...param.default] : param.default;

/**
 * 合并绑定参数：包默认值 → 已有绑定的参数 → 这次给的值，再按包的参数声明校验。
 * 这次给的值里有包没声明的参数名时报错；已有绑定里多出来的旧参数直接丢掉。
 */
export function resolveScenarioParams(pack: ScenarioPack, existing?: Readonly<Record<string, unknown>>, patch?: Readonly<Record<string, unknown>>): { params: Record<string, unknown>; issues: string[] } {
  const issues = Object.keys(patch ?? {}).filter(name => !pack.params[name]).map(name => `参数 ${name} 没有在场景包 ${pack.id} 里声明`);
  const params: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(pack.params)) {
    const value = patch && name in patch ? patch[name] : existing && name in existing ? existing[name] : scenarioParamDefault(param);
    const parsed = scenarioParamValueSchema(param).safeParse(value);
    if (parsed.success) params[name] = parsed.data;
    else issues.push(`${param.label}（${name}）：${parsed.error.issues.map(issue => `${issue.path.length ? `${issue.path.join('.')} ` : ''}${issue.message}`).join('；')}`);
  }
  return { params, issues };
}

/** 包里 role 为 source 的 bot_list 参数名（来源机器人）。 */
export const scenarioSourceParams = (pack: ScenarioPack): string[] => Object.entries(pack.params).filter(([, param]) => param.type === 'bot_list' && param.role === 'source').map(([name]) => name);
/** 绑定里所有 role 为 source 的参数列出的来源机器人（关闭的绑定也算）。只用于把它们排除出群里会接话的机器人；触发判断用 scenarioTriggerSources。 */
export function scenarioSourceBots(pack: ScenarioPack, binding: Pick<ScenarioBinding, 'params'>): ScenarioBotRef[] {
  return scenarioSourceParams(pack).flatMap(name => {
    const parsed = z.array(scenarioBotRefSchema).safeParse(binding.params[name]);
    return parsed.success ? parsed.data : [];
  });
}

/** 触发用的来源机器人：只取 trigger.sourceBotsParam 指定的那个参数（契约 1），包里别的 bot_list 参数不算。 */
export function scenarioTriggerSources(pack: ScenarioPack, binding: Pick<ScenarioBinding, 'params'>): ScenarioBotRef[] {
  const name = pack.trigger.sourceBotsParam;
  const parsed = name ? z.array(scenarioBotRefSchema).safeParse(binding.params[name]) : undefined;
  return parsed?.success ? parsed.data : [];
}

export type ScenarioBindingStatus = 'enabled' | 'disabled' | 'stale';

/** 绑定是否生效：关闭、大版本过期，或 direct 包的来源为空（契约 1：空列表视为没开启）。 */
export function scenarioBindingStatus(pack: ScenarioPack, binding: ScenarioBinding): ScenarioBindingStatus {
  if (!binding.enabled) return 'disabled';
  if (scenarioMajorVersion(binding.packVersion) !== scenarioMajorVersion(pack.version)) return 'stale';
  if (pack.mode === 'direct') {
    const sources = binding.params[pack.trigger.sourceBotsParam!];
    if (!Array.isArray(sources) || !sources.length) return 'disabled';
  }
  return 'enabled';
}

/** direct 包的去重窗口和每小时上限：绑定取值 → 包默认值 → 核心默认值，再按核心上下限封顶。省略配置得到默认值，不会得到不限额。 */
export function scenarioDirectLimits(pack: ScenarioPack, params: Readonly<Record<string, unknown>>): { dedupeWindowHours: number; perHour: number } {
  const read = (name: string | undefined, limits: { default: number; min: number; max: number }) => {
    const param = name ? pack.params[name] : undefined;
    const value = name ? params[name] : undefined;
    const chosen = Number.isInteger(value) ? value as number : param?.type === 'integer' ? param.default : limits.default;
    return Math.min(limits.max, Math.max(limits.min, chosen));
  };
  return { dedupeWindowHours: read(pack.dedupeWindowHoursParam, SCENARIO_LIMITS.dedupeWindowHours), perHour: read(pack.quota?.perHourParam, SCENARIO_LIMITS.perHour) };
}

/**
 * 场景记录（collaboration_decisions 里 gate 为 scenario 的记录）冻结的内容。window 是这次去重和额度查询读到的窗口：
 * 有没有被截断、读到的最旧一条的时间，回放直接用它。
 */
export interface ScenarioRecordSnapshot {
  packId: string;
  version: string;
  digest: string;
  outcome: ScenarioOutcome;
  dedupeKey?: string;
  sourceAppId?: string;
  window?: { truncated: boolean; oldestReadAt?: string };
}
export const scenarioPolicyVersion = (packId: string, version: string) => `scenario:${packId}@${version}`.slice(0, 64);

export interface ScenarioMessage {
  messageId: string; chatId: string; threadId?: string; rootId?: string;
  senderKind: 'human' | 'bot'; senderAppId?: string; senderOpenId?: string;
  messageType: string; text: string; mentionsSelf: boolean; mentionsOther: boolean;
}

export interface ScenarioMatchResult { matched: boolean; dedupeKey?: string }
export interface ScenarioContextResult { items: Array<{ id: string; title: string; text: string; url?: string }>; missing: string[] }

/**
 * 插件 providers 入口用 `api.registerScenarioProvider` 注册。宿主给每处调用设截止时间并发出 abort；
 * abort 不等于停下，迟到的结果被丢弃。同步死循环会卡住整个进程，这由安装时的信任确认承担。
 */
export interface ScenarioProvider {
  id: string;
  /** 截止 500ms。 */
  match?(input: { binding?: PluginBindingContext; message: ScenarioMessage; params: Readonly<Record<string, unknown>>; signal: AbortSignal }): ScenarioMatchResult | Promise<ScenarioMatchResult>;
  /** 截止按包声明，默认 5s、上限 15s。 */
  context?(input: { binding?: PluginBindingContext; scope: { appId: string; chatId: string }; message: ScenarioMessage; params: Readonly<Record<string, unknown>>; maxChars: number; signal: AbortSignal }): Promise<ScenarioContextResult>;
  /** 同步；整轮关联共 1s 截止。 */
  correlationKey?(input: { entries: Array<{ label: string; lines: string[] }> }): Record<string, string> | undefined;
}
