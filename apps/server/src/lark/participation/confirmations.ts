import { RuntimeError, participationLevelLabels, participationLevels, type CollaborationScope, type ParticipationLevel } from '@dutydeck/shared';
import type { StoredLarkConfig } from '../config.js';
import type { LarkMessageEvent } from '../listener.js';
import type { LarkScenarios } from '../group-scenarios.js';
import { legacyConfirmAliases } from '../scenario-legacy.js';
import { formatParticipationBehavior } from '../role-format.js';
import { LarkConfirmCards, type LarkConfirmRecord } from '../confirm-cards.js';
import { activeModes, type ParticipationScenarioAdmin } from './scenario-admin.js';
import type { GroupParticipationOptions, ParticipationDispatcher } from './engine.js';

export const LEVEL_CONFIRM_KIND = 'participation_level';
export const ACT_CONFIRM_KIND = 'participation_act';
/** 场景包开关的确认卡种类：scenario:<包 id>。 */
export const scenarioConfirmKind = (packId: string) => `scenario:${packId}`;
export const RESPONDER_CONFIRM_KIND = 'group_responder';

interface ConfirmationContext {
  scenarios: LarkScenarios;
  scenarioAdmin: ParticipationScenarioAdmin;
  dispatchers: ReadonlyMap<string, ParticipationDispatcher>;
  dispatchAuthorizers: ReadonlyMap<string, (scope: CollaborationScope, actor: string) => Promise<boolean>>;
  isClosed(): boolean;
  level(scope: CollaborationScope): Promise<ParticipationLevel>;
  levelResponder(record: LarkConfirmRecord, level: ParticipationLevel, operator: string): Promise<string>;
  claimResponder(scope: CollaborationScope, config: StoredLarkConfig, actorId: string, replyTo?: LarkConfirmRecord['replyTo']): Promise<boolean>;
}

export function createParticipationConfirmations(options: GroupParticipationOptions, context: ConfirmationContext): LarkConfirmCards {
  const cards = new LarkConfirmCards({ repository: options.repository, readConfig: options.readConfig, now: options.now, log: options.log,
    serviceFor: config => {
      const service = options.serviceFor(config);
      if (!service.reply || !service.update) throw new RuntimeError('LARK_CARD_UNAVAILABLE', '当前连接不能发送卡片', 503);
      return { reply: service.reply.bind(service), update: service.update.bind(service) };
    } });
  cards.register(ACT_CONFIRM_KIND, {
    authorize: async (record, actor) => await context.dispatchAuthorizers.get(record.scope.appId)?.(record.scope, actor)
      ? true : '你没有此群的任务创建权限。',
    apply: async (record, actor) => {
      const dispatch = context.dispatchers.get(record.scope.appId);
      const config = await options.readConfig(record.scope.appId, record.scope.chatId);
      if (context.isClosed() || !dispatch || !config?.listening) throw new RuntimeError('LARK_CONFIG_NOT_FOUND', '机器人已停用，没有执行。', 409);
      // Recheck after claiming the card; permissions may have changed while it was pending.
      if (!await context.dispatchAuthorizers.get(record.scope.appId)?.(record.scope, actor)) throw new RuntimeError('FORBIDDEN', '你没有此群的任务创建权限。', 403);
      const event = JSON.parse(String(record.payload.event)) as LarkMessageEvent;
      await dispatch({ ...event, senderOpenId: actor, senderType: 'user', authorization: {
        ...event.authorization!, strength: 'explicit', via: 'participation_confirmed'
      } }, config);
      return '已确认，按你的身份处理，结果会发在原消息下。';
    }
  });
  cards.register(LEVEL_CONFIRM_KIND, {
    authorize: async (record, operator) => await options.canOperate?.(record.scope, operator, record.requesterId)
      ? true : '只有发起人本人、本群的操作员或管理员能确认。',
    apply: async (record, operator) => {
      const level = participationLevels.find(item => item === record.payload.level);
      if (!level || !options.applyLevel) throw new RuntimeError('COLLABORATION_LEVEL_UNAVAILABLE', '这个群暂时不能在群里改参与强度，请在 Dutydeck Web 的群设置里调整。', 409);
      await options.applyLevel(record.scope, level, operator);
      const config = await options.readConfig(record.scope.appId, record.scope.chatId).catch(() => undefined);
      return `本群已改成「${participationLevelLabels[level]}」：${formatParticipationBehavior(level, config)}。${await context.levelResponder(record, level, operator)}`;
    }
  });
  const operate = async (record: { scope: CollaborationScope; requesterId: string }, operator: string) => await options.canOperate?.(record.scope, operator, record.requesterId)
    ? true as const : '只有发起人本人、本群的操作员或管理员能确认。';
  for (const { pack } of context.scenarios.registry.list()) {
    cards.register(scenarioConfirmKind(pack.id), { authorize: operate, apply: (record, operator) => context.scenarioAdmin.applyScenarioConfirm(pack.id, record, operator) });
  }
  // 升级前发出的确认卡：作为对应包确认卡的别名，payload 是旧格式。
  for (const alias of legacyConfirmAliases.filter(item => context.scenarios.registry.has(item.packId))) {
    cards.register(alias.kind, { authorize: operate, apply: (record, operator) => context.scenarioAdmin.applyScenarioConfirm(alias.packId, record, operator, alias.params) });
  }
  cards.register(RESPONDER_CONFIRM_KIND, {
    authorize: operate,
    apply: async (record, operator) => {
      const config = await options.readConfig(record.scope.appId, record.scope.chatId);
      if (!config) throw new RuntimeError('LARK_CONFIG_NOT_FOUND', '机器人配置已不可用。', 409);
      // 卡上说了先调到按需：接话人要收得到没 @ 的消息。调档失败就整张卡不生效，不留下收不到消息的接话人。
      const raise = record.payload.level === 'selective' && !activeModes.has(await context.level(record.scope));
      if (raise) {
        if (!options.applyLevel) throw new RuntimeError('COLLABORATION_LEVEL_UNAVAILABLE', '这个群暂时不能在群里改参与强度，请在 Dutydeck Web 的群设置里调整。', 409);
        await options.applyLevel(record.scope, 'selective', operator);
      }
      const announced = await context.claimResponder(record.scope, config, operator, record.replyTo);
      const scopeText = config.roleScope?.trim();
      const takeover = scopeText
        ? '本群没 @ 机器人的消息改由我按负责范围判断是否接，明确叫我照常处理。'
        : '本群没 @ 机器人的消息改由我接。';
      const selectiveNote = raise ? `本群已改成「按需」：${formatParticipationBehavior('selective', config)}。` : '';
      return `${selectiveNote}${takeover}${announced ? '已在群里发了声明，其他 Dutydeck 机器人收到后只接 @ 和自己接手的话题。' : '群里的声明没发出去，其他机器人可能还不知道；请稍后 @我 再说一次「你负责接话」，我会重发声明。'}`;
    }
  });
  return cards;
}
