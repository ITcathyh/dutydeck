// 群里的场景包：哪些包对这个机器人生效、来源消息命中哪个包、群里开关的说法、/status 的行。
// 包作者写的正则一律经宿主的正则执行器跑（一个包一次调用，超时或出错只让这个包弃权），provider 经截止时间封装调用。

import { isDecisionGate, resolveScenarioParams, scenarioBindingStatus, scenarioRecordOf, scenarioSourceBots, type CollaborationDecision, type CollaborationDuty, type ScenarioBinding, type ScenarioMessage, type ScenarioPack } from '@dutydeck/shared';
import { ScenarioRegistry, type RegisteredScenarioPack } from '../plugins/scenario-registry.js';
import { scenarioRegexRunner, type ScenarioRegexJob, type ScenarioRegexRunner } from '../plugins/scenario-regex.js';
import { stripMentionPlaceholders } from './participation-rules.js';
import { keywordsMatch } from './scenario-fingerprint.js';
import { scenarioSummary } from './scenario-template.js';

export type ScenarioMatch = { matched: false } | { matched: true; dedupeKey?: string } | { matched: true; abstained: string };
export type ScenarioPhrase = { entry: RegisteredScenarioPack; kind: 'enable'; captures: Record<string, string[]> } | { entry: RegisteredScenarioPack; kind: 'disable' };

/** 判定快照里冻结的场景（model 包）。 */
const snapshotScenario = (item: CollaborationDecision) => (item.inputSnapshot as { scenario?: { packId?: unknown; status?: unknown } }).scenario;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export class LarkScenarios {
  constructor(readonly registry: ScenarioRegistry = new ScenarioRegistry(), private readonly regex: Pick<ScenarioRegexRunner, 'run'> = scenarioRegexRunner(),
    private readonly log?: { warn(details: unknown, message: string): void }) {}

  /** 插件作用域适用于这个机器人的包，不看群绑定。 */
  entries(config: { appId: string; workspace?: string }): RegisteredScenarioPack[] {
    return this.registry.forScope({ botAppId: config.appId, ...(config.workspace ? { cwd: config.workspace } : {}) });
  }

  /** 本群各个包绑定里的来源机器人（关闭的绑定也算）。这些机器人只发通知，不算群里会接话的机器人。 */
  sourceAppIds(duty: Pick<CollaborationDuty, 'scenarios'>): Set<string> {
    return new Set(Object.entries(duty.scenarios ?? {}).flatMap(([id, binding]) => {
      const entry = this.registry.get(id);
      return entry ? scenarioSourceBots(entry.pack, binding).map(source => source.appId) : [];
    }));
  }

  /**
   * 来源开的话题不算来源机器人的话题的包（topicOwnership.sourceTopics 为 neutral）在本群绑定里的来源机器人，关闭的绑定也算。
   * 这些机器人开的话题不记「别人的话题」，改看话题里有没有别的机器人接过。
   */
  neutralSourceAppIds(duty: Pick<CollaborationDuty, 'scenarios'>): Set<string> {
    return new Set(Object.entries(duty.scenarios ?? {}).flatMap(([id, binding]) => {
      const entry = this.registry.get(id);
      return entry?.pack.topicOwnership?.sourceTopics === 'neutral' ? scenarioSourceBots(entry.pack, binding).map(source => source.appId) : [];
    }));
  }

  /** 本群开着的 direct 包（开启、大版本一致、来源不为空）。 */
  direct(config: { appId: string; workspace?: string }, duty: Pick<CollaborationDuty, 'scenarios'>): Array<{ entry: RegisteredScenarioPack; binding: ScenarioBinding }> {
    return this.open(config, duty, 'direct');
  }

  /** 本群开着的 model 包（开启、大版本一致），按包 id 排序：一条消息命中多个时取第一个。 */
  model(config: { appId: string; workspace?: string }, duty: Pick<CollaborationDuty, 'scenarios'>): Array<{ entry: RegisteredScenarioPack; binding: ScenarioBinding }> {
    return this.open(config, duty, 'model').sort((a, b) => a.entry.pack.id < b.entry.pack.id ? -1 : a.entry.pack.id > b.entry.pack.id ? 1 : 0);
  }

  /**
   * 返回的绑定参数已按当前包的参数 schema 解析（和保存时同一个 resolveScenarioParams）：同一大版本内包新增的参数取包默认值。
   * 存储的值在当前包下不合法时这个包按没开处理，记诊断。
   */
  private open(config: { appId: string; workspace?: string }, duty: Pick<CollaborationDuty, 'scenarios'>, mode: ScenarioPack['mode']) {
    return this.entries(config).filter(entry => entry.pack.mode === mode).flatMap(entry => {
      const binding = duty.scenarios?.[entry.pack.id];
      if (!binding || scenarioBindingStatus(entry.pack, binding) !== 'enabled') return [];
      const { params, issues } = resolveScenarioParams(entry.pack, binding.params);
      if (issues.length) {
        this.log?.warn({ scenario: entry.pack.id, issues }, '场景包绑定里的参数在当前版本的包下不合法，按没开处理');
        return [];
      }
      return [{ entry, binding: { ...binding, params } }];
    });
  }

  /**
   * 来源消息过不过这个包的匹配：消息类型 → 文字包含任一参数值（空列表不匹配）→ 正则 → provider，任一步不过就不匹配，不留记录。
   * 正则或 provider 出错、超时时返回 abstained。包声明了去重 provider 时，取它 match 返回的 dedupeKey。
   */
  async match(entry: RegisteredScenarioPack, binding: ScenarioBinding, message: ScenarioMessage, context?: { scope: { appId: string; chatId: string }; cwd?: string }): Promise<ScenarioMatch> {
    const { pack } = entry;
    const { messageTypes, match } = pack.trigger;
    if (messageTypes && !messageTypes.includes(message.messageType)) return { matched: false };
    if (match?.textAnyParam) {
      const values = stringList(binding.params[match.textAnyParam]);
      if (!values.length || !keywordsMatch(values, message.text)) return { matched: false };
    }
    if (match?.pattern) {
      try {
        const [result] = await this.regex.run([{ source: match.pattern.source, ...(match.pattern.flags ? { flags: match.pattern.flags } : {}), input: message.text }]);
        if (!result?.matched) return { matched: false };
      } catch (error) {
        this.log?.warn({ scenario: pack.id, error: errorText(error) }, '场景包匹配正则出错，这条消息弃权');
        return { matched: true, abstained: `匹配正则出错：${errorText(error)}` };
      }
    }
    let dedupeKey: string | undefined;
    for (const id of new Set([match?.provider, pack.dedupe && 'provider' in pack.dedupe ? pack.dedupe.provider : undefined])) {
      if (!id) continue;
      const result = await entry.providers.get(id)!.match({ message, params: binding.params, ...context });
      if (result.status !== 'ok') return { matched: true, abstained: result.status === 'timeout' ? `provider ${id} 超时` : `provider ${id} 出错：${result.error}` };
      if (id === match?.provider && !result.value.matched) return { matched: false };
      if (pack.dedupe && 'provider' in pack.dedupe && id === pack.dedupe.provider) dedupeKey = result.value.dedupeKey;
    }
    return { matched: true, ...(dedupeKey ? { dedupeKey } : {}) };
  }

  /**
   * 在叫机器人的短消息里开关某个包的说法：去掉 @ 后不超过包的 maxLength。关闭的说法优先；开启时按 capture 取出参数值（取全部匹配、转大写、去重）。
   * 每个包一次正则调用，出错的包跳过；按注册顺序取第一个命中的包。
   */
  async phrase(config: { appId: string; workspace?: string }, text: string): Promise<ScenarioPhrase | undefined> {
    const plain = stripMentionPlaceholders(text);
    if (!plain) return undefined;
    for (const entry of this.entries(config)) {
      const phrases = entry.pack.phrases;
      if (!phrases || plain.length > phrases.maxLength) continue;
      const captures = Object.entries(phrases.capture ?? {});
      const job = (regex: { source: string; flags?: string }, all?: boolean): ScenarioRegexJob => ({ source: regex.source, ...(regex.flags ? { flags: regex.flags } : {}), input: plain, maxInput: phrases.maxLength, ...(all ? { all } : {}) });
      let results;
      try {
        results = await this.regex.run([...phrases.disable.map(regex => job(regex)), ...phrases.enable.map(regex => job(regex)), ...captures.map(([, capture]) => job(capture, capture.all))]);
      } catch (error) {
        this.log?.warn({ scenario: entry.pack.id, error: errorText(error) }, '场景包短语正则出错，已跳过这个包');
        continue;
      }
      const disable = results.slice(0, phrases.disable.length), enable = results.slice(phrases.disable.length, phrases.disable.length + phrases.enable.length);
      if (disable.some(result => result.matched)) return { entry, kind: 'disable' };
      if (!enable.some(result => result.matched)) continue;
      const captured = results.slice(phrases.disable.length + phrases.enable.length);
      return { entry, kind: 'enable', captures: Object.fromEntries(captures.map(([name, capture], index) => {
        const values = (captured[index]?.matches ?? []).map(value => capture.transform === 'upper' ? value.toUpperCase() : value);
        return [name, [...new Set(values)]];
      })) };
    }
    return undefined;
  }

  /**
   * /status 里每个有绑定的包一行。today 是今天的判定记录（含场景记录）。
   * direct 包数场景记录：起了任务的算「<actedLabel>」，其余算跳过。model 包数快照里用到这个包的判定：
   * reply 或 act 且已发出的算「<actedLabel>」，silent 或被挡下、失败的算跳过；取材料失败的单独数，没有就不显示。
   */
  statusLines(config: { appId: string; workspace?: string }, duty: Pick<CollaborationDuty, 'scenarios'>, today: readonly CollaborationDecision[]): string[] {
    return this.entries(config).flatMap(({ pack }) => {
      const binding = duty.scenarios?.[pack.id];
      if (!binding) return [];
      if (!binding.enabled) return [`**${pack.title}**：已关闭`];
      if (scenarioBindingStatus(pack, binding) === 'stale') return [`**${pack.title}**：场景包升级到 v${pack.version}，需要在群里重新确认`];
      const head = `**${pack.title}**：${scenarioSummary(pack, resolveScenarioParams(pack, binding.params).params)}；今天${pack.status.actedLabel}`;
      if (pack.mode === 'model') {
        const decisions = today.filter(item => !isDecisionGate(item));
        const used = decisions.filter(item => snapshotScenario(item)?.status === 'used' && snapshotScenario(item)?.packId === pack.id);
        const acted = used.filter(item => item.action !== 'silent' && item.status === 'sent').length;
        const skipped = used.filter(item => item.action === 'silent' || ['suppressed', 'failed'].includes(item.status)).length;
        const abstained = decisions.filter(item => snapshotScenario(item)?.status === 'abstained' && snapshotScenario(item)?.packId === pack.id).length;
        return [`${head} ${acted} 条，跳过 ${skipped} 条${abstained ? `，取材料失败 ${abstained} 条` : ''}`];
      }
      const records = today.filter(item => scenarioRecordOf(item)?.packId === pack.id);
      const acted = records.filter(item => item.action === 'act').length;
      return [`${head} ${acted} 条，跳过 ${records.length - acted} 条`];
    });
  }

  pack(id: string): ScenarioPack | undefined { return this.registry.get(id)?.pack; }
}
