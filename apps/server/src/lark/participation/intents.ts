import { participationLevelLabels, resolveScenarioParams, scenarioTriggerSources, type CollaborationScope, type ParticipationLevel, type ScenarioBotRef } from '@dutydeck/shared';
import { jsonSha256 as digest } from '../../hash.js';
import { larkMessageAnchor } from '../message-anchor.js';
import type { StoredLarkConfig } from '../config.js';
import type { LarkMessageEvent } from '../listener.js';
import type { LarkChatMessage } from '../service.js';
import { botNameTokens, compactText, participationIntentOf } from '../participation-rules.js';
import { responderClaimText, responderIntentOf } from '../group-responder.js';
import type { LarkScenarios, ScenarioPhrase } from '../group-scenarios.js';
import { renderScenarioTemplate } from '../scenario-template.js';
import { formatParticipationBehavior } from '../role-format.js';
import type { LarkConfirmCards } from '../confirm-cards.js';
import { previewUnavailable, scenarioHistoryFailure } from '../scenario-preview.js';
import { activeModes, confirmValues, type ParticipationScenarioAdmin } from './scenario-admin.js';
import { LEVEL_CONFIRM_KIND, RESPONDER_CONFIRM_KIND, scenarioConfirmKind } from './confirmations.js';
import type { GroupParticipationOptions } from './engine.js';

type BotMember = { name: string; appId?: string; openId?: string };
/** complete 为 false：读失败、没权限或被安全策略截断，没有人数；名单是截断前读到的或上次读全的，可能缺机器人。 */
export type Members = { complete: true; humans: number; botList: BotMember[] } | { complete: false; botList: BotMember[] };
/** 会接话的机器人：群里的机器人去掉本群场景包绑定的来源机器人，它们只发通知，不算多机器人群里的另一个。 */
export const talkingBots = (members: Members, sources: ReadonlySet<string>) => members.botList.filter(item => !item.appId || !sources.has(item.appId));
/** 当不了接话人的档（只在 @ 时、话题内免 @）怎么跟人说。 */
const deafLevelText = (level: ParticipationLevel) => level === 'mention' ? '我现在只在 @ 时回复' : `我现在是「${participationLevelLabels[level]}」，不接没 @ 的消息`;
export const botName = (config: StoredLarkConfig) => config.name ?? config.displayName ?? config.appId;

interface IntentContext {
  scenarios: LarkScenarios;
  scenarioAdmin: ParticipationScenarioAdmin;
  confirmations: LarkConfirmCards;
  level(scope: CollaborationScope): Promise<ParticipationLevel>;
  memberCounts(config: StoredLarkConfig, chatId: string): Promise<Members | undefined>;
  explainSilence(scope: CollaborationScope, senderId: string, anchors: string[]): Promise<string>;
}

export class ParticipationIntents {
  constructor(private readonly options: GroupParticipationOptions, private readonly context: IntentContext) {}

  /** 改参与强度、开关场景包发确认卡；「刚才为什么没回」不调模型，直接按判定记录回答。 */
  async handleIntent(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, text: string): Promise<boolean> {
    const intent = participationIntentOf(text);
    const phrase = intent ? undefined : await this.context.scenarios.phrase(config, text);
    const sender = event.senderOpenId;
    // 只回应能在本群使唤机器人的人，与直接 @ 同一套权限；没接线时按普通消息交给 Agent。
    if (!intent && !phrase || !sender || !this.options.canOperate || !await this.options.canOperate(scope, sender, sender)) return false;
    const key = `${intent?.kind ?? phrase!.entry.pack.id}_${digest([scope, event.messageId])}`.slice(0, 50);
    if (!intent) return this.handleScenarioPhrase(scope, event, config, phrase!, sender, key);
    if (intent.kind === 'why_silent') {
      await this.replyText(config, event, await this.context.explainSilence(scope, sender, [event.parentId, event.rootId].filter((id): id is string => Boolean(id))), key);
      return true;
    }
    const label = participationLevelLabels[intent.level], behavior = formatParticipationBehavior(intent.level, config);
    if (await this.context.level(scope) === intent.level) { await this.replyText(config, event, `本群已经是「${label}」：${behavior}。`, key); return true; }
    if (!this.options.applyLevel) { await this.replyText(config, event, '这个群暂时不能在群里改参与强度，请在 Dutydeck Web 的群设置里调整。', key); return true; }
    // 接话人跟着档位走：多机器人群没有接话人时，改成按需或积极就一并认领；本 Bot 是接话人而改成不接没 @ 消息的档时一并卸任。
    const duty = await this.options.repository.getDuty(scope);
    const active = activeModes.has(intent.level);
    const members = active && !duty.responder ? await this.context.memberCounts(config, scope.chatId) : undefined;
    const claim = Boolean(members && (!members.complete || talkingBots(members, this.context.scenarios.sourceAppIds(duty)).length > 1));
    const hasScope = Boolean(config.roleScope?.trim());
    const note = claim ? `${members!.complete ? '本群有多个机器人' : '读不到完整的群成员名单，按多机器人群处理'}，确认后由我负责接没 @ 的消息，并在群里发接话人声明。`
      : active && duty.responder && duty.responder.appId !== scope.appId ? (
        hasScope
          ? `本群接话人是「${duty.responder.name ?? duty.responder.appId}」，没 @ 的消息仍由它接，但我仍按负责范围接话；要将接话人设为我，@我 说「你负责接话」（我负责的范围不变）。`
          : `本群接话人是「${duty.responder.name ?? duty.responder.appId}」，没 @ 的消息仍由它接；要改由我接，@我 说「你负责接话」。`
      )
      : !active && duty.responder?.appId === scope.appId ? '我现在是本群接话人，确认后在群里发卸任声明，没 @ 的消息不再由我接。' : '';
    const record = await this.context.confirmations.request({ kind: LEVEL_CONFIRM_KIND, scope, requesterId: sender,
      replyTo: { messageId: larkMessageAnchor(event), ...(event.threadId ? { threadId: event.threadId } : {}) },
      title: '调整参与强度', summary: `把本群改成「${label}」：${behavior}。${note}`, payload: { level: intent.level, ...(claim ? { claim: true } : {}) } });
    if (!record) await this.replyText(config, event, '确认卡没发出去，请稍后再说一次，或在 Dutydeck Web 的群设置里调整。', key);
    return true;
  }
  /**
   * 「这个群由 flash 负责接话」：群里每个 Bot 都收得到这句话，不需要 @。被点名的 Bot 发确认卡，确认后在群里声明；
   * 其他 Bot 不出声（被 @ 时回一句），等收到声明再让出。点的不是群里的机器人时当普通消息。
   */
  async handleResponderIntent(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, text: string, input: { botOpenId?: string; addressed?: boolean }): Promise<boolean> {
    const intent = responderIntentOf(text);
    const sender = event.senderOpenId;
    if (!intent || !sender || !this.options.canOperate) return false;
    const target = await this.responderTarget(config, event, intent.name, input.botOpenId);
    if (!target && (intent.name || !input.addressed) || !await this.options.canOperate(scope, sender, sender)) return false;
    const key = `responder_${digest([scope, event.messageId])}`.slice(0, 50);
    if (!target) {
      await this.replyText(config, event, '没看出要让哪个机器人接话，请 @ 它说「你负责接话」。', key);
      return true;
    }
    if (target !== 'self') {
      if (input.addressed) await this.replyText(config, event, `好的，等「${target}」在群里确认后，没 @ 的消息交给它接。`, key);
      return true;
    }
    // 接话人要收得到没 @ 的消息：当前档不接时，确认卡同时把档调到按需。
    const level = await this.context.level(scope);
    const deaf = !activeModes.has(level);
    if (deaf && !this.options.applyLevel) {
      await this.replyText(config, event, `${deafLevelText(level)}，当不了接话人；这个群暂时不能在群里改参与强度，请先在 Dutydeck Web 的群设置里把参与模式调到按需或积极，再说一次「你负责接话」。`, key);
      return true;
    }
    if (!deaf && (await this.options.repository.getDuty(scope)).responder?.appId === scope.appId) {
      // 已经是接话人：回复本身就是一条声明，之前声明没发出去或别的实例错过了，这样能补上。
      await this.replyText(config, event, responderClaimText(botName(config)), key);
      return true;
    }
    const scopeText = config.roleScope?.trim();
    const takeoverSummary = scopeText
      ? `由我（${botName(config)}）按负责范围判断接本群没 @ 机器人的消息，明确叫我照常处理。`
      : `由我（${botName(config)}）接本群没 @ 机器人的消息。`;
    const record = await this.context.confirmations.request({ kind: RESPONDER_CONFIRM_KIND, scope, requesterId: sender,
      replyTo: { messageId: larkMessageAnchor(event), ...(event.threadId ? { threadId: event.threadId } : {}) }, title: '指定接话人',
      summary: `${deaf ? `${deafLevelText(level)}，确认后调到「按需」并负责接话：` : ''}${takeoverSummary}确认后我在群里发一条声明，其他 Dutydeck 机器人收到后只接 @ 和自己接手的话题。`,
      payload: deaf ? { level: 'selective' } : {} });
    if (!record) await this.replyText(config, event, '确认卡没发出去，请稍后再说一次，或在 Dutydeck Web 的群设置里指定。', key);
    return true;
  }
  /** 接话人说法指的是谁：本机器人返回 self，群里别的机器人返回它的名字，认不出返回 undefined。 */
  private async responderTarget(config: StoredLarkConfig, event: LarkMessageEvent, name: string, botOpenId?: string): Promise<string | undefined> {
    if (!name) {
      if (botOpenId && event.mentions.some(mention => mention.openId === botOpenId)) return 'self';
      const bots = event.mentions.filter(mention => mention.mentionedType === 'bot');
      return bots.length === 1 ? bots[0]!.name : undefined;
    }
    const wanted = compactText(name);
    const named = (names: Array<string | undefined>) => botNameTokens(names).some(token => compactText(token) === wanted);
    if (named([config.name, config.displayName])) return 'self';
    return (await this.context.memberCounts(config, event.chatId))?.botList.find(item => named([item.name]))?.name;
  }
  /** 开关场景包：发确认卡，写明包的一句话说明。开启时参数按包默认 → 已有绑定 → 这句话里取出的值合并，来源按 scenarioSources 推断。 */
  private async handleScenarioPhrase(scope: CollaborationScope, event: LarkMessageEvent, config: StoredLarkConfig, phrase: ScenarioPhrase, sender: string, key: string): Promise<boolean> {
    const { pack } = phrase.entry;
    const duty = await this.options.repository.getDuty(scope);
    const binding = duty.scenarios?.[pack.id];
    const replyTo = { messageId: larkMessageAnchor(event), ...(event.threadId ? { threadId: event.threadId } : {}) };
    if (phrase.kind === 'disable') {
      if (!binding?.enabled) { await this.replyText(config, event, `本群没开${pack.title}。`, key); return true; }
      const record = await this.context.confirmations.request({ kind: scenarioConfirmKind(pack.id), scope, requesterId: sender, replyTo, title: pack.confirm.disableTitle,
        summary: renderScenarioTemplate(pack.confirm.disableSummary, confirmValues(pack, binding.params)), payload: { enabled: false } });
      if (!record) await this.replyText(config, event, '确认卡没发出去，请稍后再说一次，或在 Dutydeck Web 的群设置里关闭。', key);
      return true;
    }
    if (pack.mode === 'direct' && duty.responder && duty.responder.appId !== scope.appId) {
      await this.replyText(config, event, `本群接话人是「${duty.responder.name ?? duty.responder.appId}」，${pack.title}只由接话人做。要我来做，先 @我 说「你负责接话」。`, key);
      return true;
    }
    const patch: Record<string, unknown> = Object.fromEntries(Object.entries(phrase.captures).filter(([, values]) => values.length));
    let others: ScenarioBotRef[] = [];
    const sourceParam = pack.trigger.sourceBotsParam;
    if (sourceParam) {
      const existing = binding ? scenarioTriggerSources(pack, binding) : [];
      const param = pack.params[sourceParam];
      const inferred = param?.type === 'bot_list' && param.inferOnEnable ? await this.scenarioSources(event, config, existing) : { chosen: existing, others: [], historyFailure: undefined };
      if (!inferred.chosen.length) {
        const reason = inferred.historyFailure ? `${inferred.historyFailure}暂时无法自动确定${pack.noun}来源。`
          : `最近没看到别的机器人在本群发消息，不知道该订阅哪个${pack.noun}来源。`;
        await this.replyText(config, event, `${reason}请在${pack.noun}消息下面回复我再说一次，或在 Dutydeck Web 的群设置里填写来源。`, key);
        return true;
      }
      patch[sourceParam] = inferred.chosen;
      others = inferred.others;
    }
    const { params, issues } = resolveScenarioParams(pack, binding?.params, patch);
    if (issues.length) { await this.replyText(config, event, `${pack.title}的设置不对：${issues.join('；')}。可以在 Dutydeck Web 的群设置里填写。`, key); return true; }
    const record = await this.context.confirmations.request({ kind: scenarioConfirmKind(pack.id), scope, requesterId: sender, replyTo, title: pack.confirm.enableTitle,
      summary: `${renderScenarioTemplate(pack.confirm.enableSummary, confirmValues(pack, params))}${others.length
        ? `最近在本群发过消息的机器人还有：${others.map(item => item.name ?? item.appId).join('、')}；来源不对可以在 Dutydeck Web 的群设置里改。` : ''}`,
      preview: () => this.context.scenarioAdmin.previewDraft(scope, config, duty, { entry: phrase.entry, binding: { enabled: true, packVersion: pack.version, params, requesterId: sender } }, undefined, 3_000)
        .catch(() => previewUnavailable()),
      payload: { enabled: true, params: JSON.stringify(params), packVersion: pack.version } });
    if (!record) await this.replyText(config, event, '确认卡没发出去，请稍后再说一次，或在 Dutydeck Web 的群设置里开启。', key);
    return true;
  }
  /** 开启时的来源：回复或话题里的那条机器人消息优先；没有就沿用已有绑定；再没有就看最近 50 条消息里发过言的机器人，发得最多的排第一。 */
  private async scenarioSources(event: LarkMessageEvent, config: StoredLarkConfig, existing: ScenarioBotRef[]): Promise<{ chosen: ScenarioBotRef[]; others: ScenarioBotRef[]; historyFailure?: string }> {
    const service = this.options.serviceFor(config);
    const members = await this.context.memberCounts(config, event.chatId);
    const source = (appId: string) => { const name = members?.botList.find(item => item.appId === appId)?.name; return { appId, ...(name ? { name } : {}) }; };
    // 消息读取接口把机器人发送者报成 app_id。
    const otherBot = (message: Pick<LarkChatMessage, 'sender' | 'chatId'>) => ['app', 'bot'].includes(message.sender.type ?? '') && Boolean(message.sender.id?.startsWith('cli_'))
      && message.sender.id !== config.appId && (!message.chatId || message.chatId === event.chatId);
    for (const anchor of new Set([event.parentId, event.rootId])) {
      if (!anchor || anchor === event.messageId || !service.getMessage) continue;
      const message = await service.getMessage(anchor).catch(() => undefined);
      if (message && otherBot(message)) return { chosen: [source(message.sender.id!)], others: [] };
    }
    if (existing.length) return { chosen: existing, others: [] };
    let recent: LarkChatMessage[];
    try {
      recent = (await service.listChatMessages({ chatId: event.chatId, order: 'desc', pageSize: 50 })).items;
    } catch (error) {
      return { chosen: [], others: [], historyFailure: scenarioHistoryFailure(error) };
    }
    const counts = new Map<string, number>();
    for (const item of recent) if (!item.deleted && otherBot(item)) counts.set(item.sender.id!, (counts.get(item.sender.id!) ?? 0) + 1);
    const ranked = [...counts].sort((left, right) => right[1] - left[1]).map(([appId]) => source(appId));
    return { chosen: ranked.slice(0, 1), others: ranked.slice(1) };
  }
  private async replyText(config: StoredLarkConfig, event: LarkMessageEvent, text: string, idempotencyKey: string) {
    await this.options.serviceFor(config).replyText({ messageId: larkMessageAnchor(event), replyInThread: Boolean(event.threadId), text, idempotencyKey });
  }
}
