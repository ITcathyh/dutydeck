import { describe, expect, it } from 'vitest';
import { parseScenarioTemplate, scenarioBindingStatus, scenarioDirectLimits, validateScenarioPack, type ScenarioPack } from './scenarios.js';

/** 设计稿第 3.2 节的告警包，只用来证明格式能表达它。 */
const alarm = {
  id: 'alarm', version: '1.0.0', title: '告警初筛', noun: '告警', mode: 'direct',
  description: '订阅的来源机器人发告警后，不走参与判定，直接在告警话题里以确认人的名义起一个初筛任务。',
  params: {
    sources: { type: 'bot_list', label: '来源机器人 app_id', hint: '多个用逗号分隔，只有这些机器人发的消息会初筛。', maxItems: 20, role: 'source', inferOnEnable: true, empty: '未填写' },
    levels: { type: 'string_list', label: '级别关键字', hint: '例如 P0, P1；留空表示不限级别。', maxItems: 20, maxLength: 32, default: [] },
    dedupeHours: { type: 'integer', label: '去重窗口（小时，1–168）', min: 1, max: 168, default: 6 },
    maxPerHour: { type: 'integer', label: '每小时最多初筛（1–30）', min: 1, max: 30, default: 3 }
  },
  trigger: { senderKinds: ['bot'], sourceBotsParam: 'sources', filter: { keywordsAnyParam: 'levels' } },
  execution: { intro: '收到「{source}」的告警，开始初筛。', instruction: '[告警初筛] 下面是「{source}」在群里发的告警。\n告警原文在下面的不可信材料里。' },
  dedupe: { algorithm: 'source_text_v1' },
  dedupeWindowHoursParam: 'dedupeHours',
  quota: { perHourParam: 'maxPerHour' },
  correlation: {
    provider: 'alert-key', requiredFields: ['title'], optionalFields: ['service'], scope: 'always',
    prompt: '[Dutydeck 上次同一告警规则] {date} 在这个群查过同一条告警规则，上次的结论在下面的不可信材料里。',
    cardLine: '📎 {date} 同一告警规则：{headline}{url? · [查看]({url}):}'
  },
  topicOwnership: { sourceTopics: 'neutral' },
  phrases: {
    maxLength: 40,
    disable: [{ source: '(告警|报警).{0,6}(别|不要|不用|无需|停止|停掉|取消|关掉|关闭)再?(分析|看|初筛|处理|管)|(取消|关掉|关闭|停掉|停止)(告警|报警)(订阅|初筛|分析)' }],
    enable: [{ source: '(告警|报警).{0,8}(先|帮我|帮忙|自动)(初筛|分析|看看|看一下|看下|看|处理)|(订阅|开启|打开)(告警|报警)(初筛|分析)?|(告警|报警)初筛' }],
    capture: { levels: { source: '\\b(p[0-4]|sev[0-4]|critical|fatal|major|warning|error)\\b|严重|紧急|致命', flags: 'i', all: true, transform: 'upper' } },
    examples: { enable: ['这个群的告警来了先帮我看看', '告警来了先帮我初筛，只看 P0'], disable: ['告警别再分析了', '关闭告警初筛'] }
  },
  confirm: {
    enableTitle: '开启告警初筛', disableTitle: '关闭告警初筛',
    enableSummary: '{summary}。告警来了我在告警话题里先做初筛，任务以确认人的名义发起。',
    disableSummary: '不再自动初筛本群告警（{summary}）。',
    enabledResult: '已开启告警初筛：{summary}。', disabledResult: '已关闭本群告警初筛，订阅设置保留，之后可以再打开。'
  },
  status: { summary: '来源 {sources}；级别{levels?只看 {levels}:不限}；同一条告警 {dedupeHours} 小时内只分析一次，每小时最多 {maxPerHour} 条', actedLabel: '分析' },
  reasons: { started: '告警命中订阅，已起初筛任务', filtered: '告警级别不在订阅范围内' },
  explain: { acted: '{time} 那条告警已经起了初筛任务。', skipped: '{time} 那条告警我没分析：{reason}。', note: '另外，{time} 那条告警「{snippet}」我没分析：{reason}。' },
  web: { description: '以在群里确认订阅的人（{requesterId}）的名义发起。', enableHint: '开启前先在群里 @机器人 说「告警来了先帮我看看」并点确认。' }
};

/** 设计稿第 3.3 节的答疑包（model 模式）。 */
const teamFaq = {
  id: 'team-faq', version: '0.1.0', title: '团队答疑', noun: '答疑', mode: 'model',
  description: '群里有人问到指定服务或流程时，按 runbook 判断要不要接，接了按 runbook 回答。',
  params: {
    topics: { type: 'string_list', label: '关键字（服务名、流程名）', maxItems: 50, maxLength: 64, default: [] },
    docs: { type: 'string_list', label: 'runbook 文件（相对插件配置的目录）', maxItems: 20, maxLength: 200, default: [] }
  },
  trigger: { senderKinds: ['human'], messageTypes: ['text', 'post'], match: { textAnyParam: 'topics' } },
  decision: { guidance: '本群启用了团队答疑。能直接按 runbook 回答的用 reply；要查系统的用 act；其余 silent。' },
  execution: { instruction: '[团队答疑] 回答时以下面的 runbook 摘录为准，标明出处。' },
  context: { provider: 'runbook', timeoutMs: 3000, maxChars: 6000, decisionChars: 2000 },
  confirm: { enableTitle: '开启团队答疑', disableTitle: '关闭团队答疑', enableSummary: '关键字 {topics}；runbook {docs}。', disableSummary: '不再按 runbook 接答疑（关键字 {topics}）。', enabledResult: '已开启团队答疑：关键字 {topics}。', disabledResult: '已关闭本群团队答疑。' },
  phrases: { maxLength: 30, enable: [{ source: '(开启|打开)(团队)?答疑' }], disable: [{ source: '(关闭|关掉|停止)(团队)?答疑' }], examples: { enable: ['开启团队答疑'], disable: ['关闭答疑'] } },
  status: { summary: '关键字 {topics?{topics}:未填写}；runbook {docs?{docs}:未填写}', actedLabel: '回答' }
};

const clone = <T>(value: T): T => structuredClone(value);
const fieldsOf = (raw: unknown) => validateScenarioPack(raw).issues.map(issue => issue.field);
const issueFor = (raw: unknown, field: string) => validateScenarioPack(raw).issues.find(issue => issue.field === field)?.message;

describe('scenario pack format', () => {
  it('accepts the designed alarm (direct) and team-faq (model) packs', () => {
    expect(validateScenarioPack(alarm)).toMatchObject({ issues: [], pack: { id: 'alarm', mode: 'direct' } });
    expect(validateScenarioPack(teamFaq)).toMatchObject({ issues: [], pack: { id: 'team-faq', mode: 'model' } });
  });

  it('keeps mode and sender kinds consistent', () => {
    expect(fieldsOf({ ...clone(alarm), trigger: { ...alarm.trigger, senderKinds: ['human'] } })).toContain('trigger.senderKinds');
    expect(fieldsOf({ ...clone(teamFaq), trigger: { ...teamFaq.trigger, senderKinds: ['bot'] } })).toContain('trigger.senderKinds');
    expect(fieldsOf({ ...clone(alarm), trigger: { ...alarm.trigger, senderKinds: ['bot', 'human'] } })).toContain('trigger.senderKinds');
  });

  it('enforces the direct contract: source bots, dedupe, window and quota are required', () => {
    const missing = clone(alarm) as Record<string, unknown> & { trigger: Record<string, unknown> };
    delete missing.trigger.sourceBotsParam;
    delete missing.dedupe;
    delete missing.dedupeWindowHoursParam;
    delete missing.quota;
    expect(fieldsOf(missing)).toEqual(expect.arrayContaining(['trigger.sourceBotsParam', 'dedupe', 'dedupeWindowHoursParam', 'quota']));
    expect(fieldsOf({ ...clone(alarm), decision: { guidance: 'x' }, context: { provider: 'p' } })).toEqual(expect.arrayContaining(['decision', 'context']));
  });

  it('model packs need guidance and cannot use direct-only fields', () => {
    const { decision: _decision, ...noGuidance } = clone(teamFaq);
    expect(fieldsOf(noGuidance)).toContain('decision');
    expect(fieldsOf({ ...clone(teamFaq), quota: { perHourParam: 'topics' }, topicOwnership: { sourceTopics: 'neutral' } })).toEqual(expect.arrayContaining(['quota', 'topicOwnership']));
  });

  it('checks the type and range of every parameter pointer', () => {
    expect(issueFor({ ...clone(alarm), trigger: { ...alarm.trigger, sourceBotsParam: 'levels' } }, 'trigger.sourceBotsParam')).toContain('bot_list');
    expect(issueFor({ ...clone(alarm), quota: { perHourParam: 'missing' } }, 'quota.perHourParam')).toContain('没有在 params 里声明');
    expect(issueFor({ ...clone(alarm), trigger: { ...alarm.trigger, filter: { keywordsAnyParam: 'dedupeHours' } } }, 'trigger.filter.keywordsAnyParam')).toContain('string_list');
    const wide = clone(alarm);
    wide.params.dedupeHours.max = 200;
    wide.params.maxPerHour = { ...wide.params.maxPerHour, max: 50 };
    expect(fieldsOf(wide)).toEqual(expect.arrayContaining(['dedupeWindowHoursParam', 'quota.perHourParam']));
    expect(fieldsOf({ ...clone(alarm), params: { ...alarm.params, source: { type: 'integer', label: 'x', min: 1, max: 2, default: 1 } } })).toContain('params.source');
    expect(fieldsOf({ ...clone(alarm), params: { ...alarm.params, maxPerHour: { ...alarm.params.maxPerHour, default: 99 } } })).toContain('params.maxPerHour.default');
  });

  it('caps sizes and timeouts', () => {
    expect(fieldsOf({ ...clone(alarm), phrases: { ...alarm.phrases, maxLength: 61 } })).toContain('phrases.maxLength');
    expect(fieldsOf({ ...clone(teamFaq), context: { provider: 'runbook', timeoutMs: 20_000, maxChars: 20_000, decisionChars: 5_000 } })).toEqual(expect.arrayContaining(['context.timeoutMs', 'context.maxChars', 'context.decisionChars']));
    expect(fieldsOf({ ...clone(teamFaq), decision: { guidance: 'x'.repeat(2_001) } })).toContain('decision.guidance');
    expect(fieldsOf({ ...clone(alarm), phrases: { ...alarm.phrases, examples: { enable: ['告警初筛'.repeat(11)], disable: alarm.phrases.examples.disable } } })).toContain('phrases.examples.enable.0');
  });

  it('caps pack ids at 32 characters so confirm.scenario:<id> fits the 64-character action kind', () => {
    const id = `a${'-b'.repeat(15)}c`;
    expect(id).toHaveLength(32);
    expect(validateScenarioPack({ ...clone(alarm), id }).issues).toEqual([]);
    expect(issueFor({ ...clone(alarm), id: `${id}d` }, 'id')).toBeDefined();
    expect(`confirm.scenario:${id}`.length).toBeLessThanOrEqual(64);
  });

  it('allows only the variables of each template position; literal fields take no variables', () => {
    expect(issueFor({ ...clone(alarm), execution: { ...alarm.execution, instruction: '告警原文：{text}' } }, 'execution.instruction')).toContain('{text}');
    expect(fieldsOf({ ...clone(teamFaq), execution: { instruction: '来源 {source}' } })).toContain('execution.instruction');
    expect(issueFor({ ...clone(alarm), correlation: { ...alarm.correlation, prompt: '上次结论：{headline}' } }, 'correlation.prompt')).toContain('{date}');
    expect(fieldsOf({ ...clone(alarm), status: { ...alarm.status, summary: '{levels?{levels?a:b}:c}' } })).toContain('status.summary');
    expect(fieldsOf({ ...clone(alarm), confirm: { ...alarm.confirm, enabledResult: '已开启 }' } })).toContain('confirm.enabledResult');
    expect(issueFor({ ...clone(teamFaq), decision: { guidance: '关键字是 {topics}' } }, 'decision.guidance')).toContain('字面文字');
    expect(fieldsOf({ ...clone(alarm), reasons: { duplicate: '{time} 重复' } })).toContain('reasons.duplicate');
  });

  it('parses templates with one level of conditionals', () => {
    expect(parseScenarioTemplate('📎 {date} 同一告警规则：{headline}{url? · [查看]({url}):}')).toEqual(['date', 'headline', 'url']);
    expect(parseScenarioTemplate('纯文字')).toEqual([]);
    expect(() => parseScenarioTemplate('{a?b')).toThrow('没有闭合');
    expect(() => parseScenarioTemplate('{ a }')).toThrow('变量名');
    expect(() => parseScenarioTemplate('{a?x}')).toThrow('缺少 :');
  });

  it('rejects g and y flags and bad syntax, and only warns on what safe-regex2 flags', () => {
    expect(issueFor({ ...clone(alarm), phrases: { ...alarm.phrases, enable: [{ source: '告警', flags: 'g' }] } }, 'phrases.enable.0.flags')).toContain('g');
    expect(fieldsOf({ ...clone(alarm), phrases: { ...alarm.phrases, disable: [{ source: '关闭', flags: 'iy' }] } })).toContain('phrases.disable.0.flags');
    expect(issueFor({ ...clone(alarm), phrases: { ...alarm.phrases, enable: [{ source: '(告警' }] } }, 'phrases.enable.0.source')).toContain('语法');
    const risky = validateScenarioPack({ ...clone(alarm), phrases: { ...alarm.phrases, enable: [{ source: '(告警+)+$' }, ...alarm.phrases.enable] } });
    expect(risky.issues).toEqual([]);
    expect(risky.warnings).toEqual([expect.objectContaining({ field: 'phrases.enable.0' })]);
  });
});

describe('scenario runtime helpers', () => {
  const pack = validateScenarioPack(alarm).pack as ScenarioPack;

  it('direct limits fall back to defaults and are capped, never unlimited', () => {
    expect(scenarioDirectLimits(pack, {})).toEqual({ dedupeWindowHours: 6, perHour: 3 });
    expect(scenarioDirectLimits(pack, { dedupeHours: 1_000, maxPerHour: 1_000 })).toEqual({ dedupeWindowHours: 168, perHour: 30 });
    expect(scenarioDirectLimits(pack, { dedupeHours: 0, maxPerHour: -1 })).toEqual({ dedupeWindowHours: 1, perHour: 1 });
    expect(scenarioDirectLimits(pack, { dedupeHours: 'x', maxPerHour: 2.5 })).toEqual({ dedupeWindowHours: 6, perHour: 3 });
  });

  it('a binding is off when disabled, stale on a major version change, or when a direct pack has no sources', () => {
    const binding = { enabled: true, params: { sources: ['cli_source'] }, packVersion: '1.0.0', requesterId: 'ou_a' };
    expect(scenarioBindingStatus(pack, binding)).toBe('enabled');
    expect(scenarioBindingStatus(pack, { ...binding, packVersion: '1.4.2' })).toBe('enabled');
    expect(scenarioBindingStatus(pack, { ...binding, packVersion: '2.0.0' })).toBe('stale');
    expect(scenarioBindingStatus(pack, { ...binding, enabled: false })).toBe('disabled');
    expect(scenarioBindingStatus(pack, { ...binding, params: { sources: [] } })).toBe('disabled');
  });
});
