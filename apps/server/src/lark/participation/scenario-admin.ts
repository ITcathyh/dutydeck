import {
  RuntimeError, resolveParticipation, resolveScenarioParams, scenarioBindingStatus, scenarioMajorVersion, scenarioSourceBots,
  type CollaborationDuty, type CollaborationScope, type ScenarioBinding, type ScenarioPack, type ScenarioPreview, type ScenarioPreviewInput
} from '@dutydeck/shared';
import type { StoredLarkConfig } from '../config.js';
import type { LarkScenarios } from '../group-scenarios.js';
import { findScenarioRecall, materialEntries, type LarkScenarioRecall } from '../scenario-recall.js';
import { renderScenarioTemplate, scenarioParamValues, scenarioSummary, templateText, type TemplateValues } from '../scenario-template.js';
import type { LarkConfirmRecord } from '../confirm-cards.js';
import { previewScenario } from '../scenario-preview.js';
import type { GroupParticipationOptions } from './engine.js';

export const activeModes = new Set(['selective', 'eager']);
/** 包没写说明文案时核心的说法。 */
const jsonRecord = (value: unknown): Record<string, unknown> | undefined => {
  try { const parsed: unknown = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
};
/** 确认卡模板的变量：{summary} 和各个参数。 */
export const confirmValues = (pack: ScenarioPack, params: Readonly<Record<string, unknown>>): TemplateValues => ({ ...scenarioParamValues(pack, params), summary: templateText(scenarioSummary(pack, params)) });

export class ParticipationScenarioAdmin {
  constructor(private readonly options: GroupParticipationOptions, private readonly scenarios: LarkScenarios) {}

  /** Web 改一个场景包的绑定：参数按包默认 → 已有绑定 → 这次的值合并校验，确认人和包版本沿用已有的。 */
  webBinding(scope: CollaborationScope, config: StoredLarkConfig, id: string, value: { enabled: boolean; params?: Record<string, unknown> }, current?: ScenarioBinding): ScenarioBinding {
    const pack = this.scenarios.entries(config).find(entry => entry.pack.id === id)?.pack;
    if (!pack) throw new RuntimeError('COLLABORATION_SCENARIO_UNKNOWN', `没有可用的场景包 ${id}。`, 400);
    const { params, issues } = resolveScenarioParams(pack, current?.params, value.params);
    if (issues.length) throw new RuntimeError('COLLABORATION_SCENARIO_INVALID', `${pack.title}的设置不对：${issues.join('；')}`, 400);
    // 开启或这次改了来源时才查：升级上来的旧订阅来源里可能有本机器人，不改来源要能关掉。
    const sourcesChanged = Boolean(pack.trigger.sourceBotsParam && value.params && Object.hasOwn(value.params, pack.trigger.sourceBotsParam));
    if ((value.enabled || sourcesChanged) && scenarioSourceBots(pack, { params }).some(source => source.appId === scope.appId)) throw new RuntimeError('COLLABORATION_SCENARIO_SELF_SOURCE', `${pack.title}的来源不能是本机器人自己。`, 400);
    if (value.enabled && pack.mode === 'direct' && !current?.requesterId) {
      throw new RuntimeError('COLLABORATION_SCENARIO_REQUESTER_REQUIRED', `${pack.title}要以在群里确认过的人的名义发起。${pack.web?.enableHint ?? '请先在群里 @机器人 说开启并点确认，之后可以在这里改设置。'}`, 409);
    }
    if (value.enabled && current && scenarioMajorVersion(current.packVersion) !== scenarioMajorVersion(pack.version)) {
      throw new RuntimeError('COLLABORATION_SCENARIO_VERSION_STALE', `${pack.title}的场景包已升级到 v${pack.version}，要先在群里重新确认才能开启。`, 409);
    }
    return { enabled: value.enabled, params, ...(current?.requesterId ? { requesterId: current.requesterId } : {}), packVersion: current?.packVersion ?? pack.version };
  }
  async previewScenario(scope: CollaborationScope, id: string, input: ScenarioPreviewInput): Promise<ScenarioPreview> {
    const config = await this.options.readConfig(scope.appId, scope.chatId, true).catch(() => undefined);
    if (!config) return { status: 'unavailable', message: '暂时无法读取机器人或群配置，请检查群配置后重试。' };
    const duty = await this.options.repository.getDuty(scope);
    const entry = this.scenarios.entries(config).find(item => item.pack.id === id);
    if (!entry) throw new RuntimeError('COLLABORATION_SCENARIO_UNKNOWN', `没有可用的场景包 ${id}。`, 400);
    const { params, issues } = resolveScenarioParams(entry.pack, duty.scenarios?.[id]?.params, input.params);
    if (issues.length) throw new RuntimeError('COLLABORATION_SCENARIO_INVALID', `${entry.pack.title}的设置不对：${issues.join('；')}`, 400);
    if (scenarioSourceBots(entry.pack, { params }).some(source => source.appId === scope.appId)) throw new RuntimeError('COLLABORATION_SCENARIO_SELF_SOURCE', `${entry.pack.title}的来源不能是本机器人自己。`, 400);
    // 初次开通也可预演。确认人仅是本次推算的前提，启用仍由群里的确认卡授权。
    const binding = { enabled: true, packVersion: entry.pack.version, params, requesterId: duty.scenarios?.[id]?.requesterId ?? 'preview' };
    return this.previewDraft(scope, config, duty, { entry, binding }, input.limit);
  }

  async previewDraft(scope: CollaborationScope, config: StoredLarkConfig, duty: CollaborationDuty,
    target: Parameters<typeof previewScenario>[0]['target'], limit?: number, timeoutMs?: number): Promise<ScenarioPreview> {
    const settings = target.entry.pack.mode === 'model'
      ? await (this.options.readPreviewSettings?.(scope) ?? this.options.repository.getSettings(scope)) : undefined;
    const modelActive = Boolean(settings && activeModes.has(resolveParticipation({ mentionPolicy: config.mentionPolicy, participation: settings.participation }).level));
    const canObserve = settings && modelActive
      ? await (this.options.authorizePreviewObservation?.(scope, settings) ?? this.options.authorize(scope, undefined, 'observe')) : false;
    return previewScenario({ scenarios: this.scenarios, scope, config, duty, target, modelActive, canObserve, service: this.options.serviceFor(config), limit, timeoutMs });
  }

  /** 群设置页列出的场景包：作用域适用于本机器人的包、本群绑定和状态。 */
  async scenarioOverview(scope: CollaborationScope) {
    const config = await this.options.readConfig(scope.appId, scope.chatId).catch(() => undefined);
    const duty = await this.options.repository.getDuty(scope);
    return this.scenarios.entries({ appId: scope.appId, ...(config?.workspace ? { workspace: config.workspace } : {}) }).map(({ pack, plugin, builtin }) => {
      const binding = duty.scenarios?.[pack.id];
      const params = binding?.params ?? resolveScenarioParams(pack).params;
      // 说明里写着确认人；还没在群里确认过时不给，免得显示一对空括号。
      const webDescription = pack.web && binding?.requesterId ? renderScenarioTemplate(pack.web.description, { ...scenarioParamValues(pack, params), requesterId: templateText(binding.requesterId) }) : undefined;
      return { id: pack.id, title: pack.title, version: pack.version, description: pack.description, mode: pack.mode, params: pack.params, ...(binding ? { binding } : {}),
        requiresRequester: pack.mode === 'direct', versionStale: Boolean(binding && scenarioBindingStatus(pack, binding) === 'stale'),
        ...(webDescription ? { webDescription } : {}), ...(pack.web?.enableHint ? { enableHint: pack.web.enableHint } : {}), plugin, builtin };
    });
  }
  /** 这一轮材料关联到的上一轮（见 scenario-recall.ts）。correlation.scope 为 enabled 的包只在本群绑定开着时参与。 */
  async scenarioRecall(scope: CollaborationScope, config: StoredLarkConfig, input: Omit<Parameters<typeof findScenarioRecall>[0], 'packs' | 'chatId' | 'log'>): Promise<LarkScenarioRecall | undefined> {
    const packs = this.scenarios.entries(config).filter(entry => entry.pack.correlation);
    if (!packs.length || !materialEntries(input.materialPrompt).length) return undefined;
    const duty = packs.some(entry => entry.pack.correlation!.scope === 'enabled') ? await this.options.repository.getDuty(scope) : undefined;
    const applicable = packs.filter(({ pack }) => {
      const binding = duty?.scenarios?.[pack.id];
      return pack.correlation!.scope === 'always' || Boolean(binding && scenarioBindingStatus(pack, binding) === 'enabled');
    });
    return findScenarioRecall({ ...input, packs: applicable, chatId: scope.chatId, ...(this.options.log ? { log: this.options.log } : {}) });
  }
  /** 场景包开关确认卡点了确认。legacyParams 是升级前的确认卡的 payload 转换（见 scenario-legacy.ts）。 */
  async applyScenarioConfirm(packId: string, record: LarkConfirmRecord, operator: string, legacyParams?: (payload: LarkConfirmRecord['payload']) => Record<string, unknown> | undefined): Promise<string> {
    const pack = this.scenarios.pack(packId);
    if (!pack) throw new RuntimeError('COLLABORATION_SCENARIO_UNKNOWN', '这个场景包已经不可用。', 409);
    const repo = this.options.repository;
    const duty = await repo.getDuty(record.scope);
    const binding = duty.scenarios?.[pack.id];
    if (record.payload.enabled === false) {
      if (!binding?.enabled) return `本群本来就没开${pack.title}。`;
      await repo.updateDuty(record.scope, { expectedRevision: duty.revision, scenarios: { [pack.id]: { ...binding, enabled: false } } }, operator);
      return pack.confirm.disabledResult;
    }
    // 卡上记着发卡时的包版本；没记的（升级前的告警确认卡、早于这个字段的卡）按 1.0.0。期间包升了大版本就要在群里重新说一次。
    const cardVersion = typeof record.payload.packVersion === 'string' ? record.payload.packVersion : '1.0.0';
    if (scenarioMajorVersion(cardVersion) !== scenarioMajorVersion(pack.version)) {
      throw new RuntimeError('COLLABORATION_SCENARIO_VERSION_STALE', `${pack.title}的场景包已升级到 v${pack.version}，这张确认卡已经失效，请在群里重新说一次。`, 409);
    }
    if (pack.mode === 'direct' && duty.responder && duty.responder.appId !== record.scope.appId) {
      throw new RuntimeError('COLLABORATION_NOT_RESPONDER', `本群接话人是「${duty.responder.name ?? duty.responder.appId}」，${pack.title}只由接话人做。`, 409);
    }
    const raw = legacyParams ? legacyParams(record.payload) : jsonRecord(record.payload.params);
    const { params, issues } = resolveScenarioParams(pack, undefined, raw);
    if (!raw || issues.length) throw new RuntimeError('COLLABORATION_SCENARIO_INVALID', `确认卡上的设置已经不能用了，请在群里重新说一次。${issues.join('；')}`, 409);
    if (scenarioSourceBots(pack, { params }).some(source => source.appId === record.scope.appId)) throw new RuntimeError('COLLABORATION_SCENARIO_SELF_SOURCE', `${pack.title}的来源不能是本机器人自己。`, 409);
    // 任务以点确认的人的名义发起：他为这份绑定负责，任务也按他的权限执行。
    await repo.updateDuty(record.scope, { expectedRevision: duty.revision, scenarios: { [pack.id]: { enabled: true, params, requesterId: operator, packVersion: pack.version } } }, operator);
    return renderScenarioTemplate(pack.confirm.enabledResult, confirmValues(pack, params));
  }
}
