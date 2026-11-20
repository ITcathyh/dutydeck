import { SCENARIO_RECORD, scenarioPreviewLimits, type CollaborationDuty, type CollaborationScope,
  type ScenarioBinding, type ScenarioMessage, type ScenarioPreview, type ScenarioPreviewMessage } from '@dutydeck/shared';
import { clipCardField } from './card-elements.js';
import type { StoredLarkConfig } from './config.js';
import { observationTime } from './context-bootstrap.js';
import { withLarkContextReadTimeout } from './context-read-timeout.js';
import type { Disposition } from './disposition.js';
import type { LarkScenarios } from './group-scenarios.js';
import { responderAnnouncementOf } from './group-responder.js';
import { isLarkPermissionError, larkHistoryScopes, larkPermissionNextStep } from './history-permission.js';
import { parseLarkMessageContent } from './message-content.js';
import { stripMentionPlaceholders } from './participation-rules.js';
import { decideDirect, directReason, type DirectWindow } from './scenario-direct.js';
import { humanScenarioMessage } from './scenario-model.js';
import { redactTraceText } from './secret-redaction.js';
import { LarkServiceError, type LarkCardService, type LarkChatMessage } from './service.js';

type ScenarioEntry = { entry: ReturnType<LarkScenarios['entries']>[number]; binding: ScenarioBinding };
const result = (matched: boolean, reason: Disposition['reason'], detail: string) => ({ matched, reason, detail });
const skip = (reason: Disposition['reason'], detail: string) => result(false, reason, detail);

export const previewSenderLabels = { human: '真人', bot: '机器人', unknown: '未知发送者' } as const;

async function recentMessages(service: Pick<LarkCardService, 'listChatMessages'>, chatId: string, limit: number, signal: AbortSignal) {
  const items = new Map<string, LarkChatMessage>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  while (items.size < limit) {
    signal.throwIfAborted();
    const page = await service.listChatMessages({ chatId, order: 'desc', pageSize: Math.min(limit - items.size, 50), ...(pageToken ? { pageToken } : {}) }, signal);
    for (const item of page.items) {
      if (items.size >= limit) break;
      if ((!item.chatId || item.chatId === chatId) && !items.has(item.messageId)) items.set(item.messageId, item);
    }
    if (!page.hasMore || items.size >= limit) break;
    if (!page.pageToken || seenTokens.has(page.pageToken)) throw new Error('群历史分页未返回完整结果');
    pageToken = page.pageToken;
    seenTokens.add(pageToken);
  }
  return [...items.values()];
}

export function previewUnavailable(): ScenarioPreview {
  return { status: 'unavailable', message: '暂时无法完成预演，可以继续确认或稍后重试。' };
}

export function scenarioHistoryFailure(error: unknown): string {
  if (error instanceof LarkServiceError && isLarkPermissionError(error)) {
    return `无法读取群历史。请检查机器人是否在群内，以及飞书权限 ${larkHistoryScopes.join('、')}。${larkPermissionNextStep}`;
  }
  const detail = error instanceof LarkServiceError ? `（飞书返回 ${Number.isFinite(error.upstreamCode) ? error.upstreamCode : error.statusCode}）`
    : error instanceof Error && error.message === '读取群历史超时' ? '（请求超时）' : '';
  return `读取群历史失败${detail}。请稍后重试，并检查机器人是否在群内以及飞书权限 ${larkHistoryScopes.join('、')}。`;
}

export async function previewScenario(input: {
  scenarios: LarkScenarios;
  target: ScenarioEntry;
  scope: CollaborationScope;
  duty: CollaborationDuty;
  config: StoredLarkConfig;
  service: Pick<LarkCardService, 'listChatMessages'> & Partial<Pick<LarkCardService, 'getBotOpenId'>>;
  modelActive: boolean;
  limit?: number;
  timeoutMs?: number;
}): Promise<ScenarioPreview> {
  const { scenarios, target, scope, duty, config, service } = input;
  const { pack } = target.entry;
  const limit = Math.min(scenarioPreviewLimits.max, Math.max(1, Math.floor(input.limit ?? scenarioPreviewLimits.default)));
  let history;
  try {
    history = await withLarkContextReadTimeout(signal => recentMessages(service, scope.chatId, limit, signal), '读取群历史', input.timeoutMs);
  } catch (error) {
    return { status: 'unavailable', message: scenarioHistoryFailure(error) };
  }
  const open = pack.mode === 'direct' ? scenarios.direct(config, duty) : scenarios.model(config, duty);
  const earlier = open.filter(item => item.entry.pack.id < pack.id);
  const window: DirectWindow['records'][number][] = [];
  const messages: ScenarioPreviewMessage[] = [];
  const self: { appId: string; openId?: string } = { appId: config.appId };
  try {
    await withLarkContextReadTimeout(async signal => {
      if (history.some(item => item.mentions.some(mention => mention.id && (mention.idType === 'open_id' || mention.id.startsWith('ou_'))))) {
        self.openId = await service.getBotOpenId?.().catch(() => undefined);
      }
      // 用消息时间从旧到新，在本次样本内模拟额度。结果以新消息优先展示。
      for (const item of [...history].reverse()) {
        signal.throwIfAborted();
        const at = observationTime(item.createTime, new Date(0).toISOString());
        const senderKind = ['app', 'bot'].includes(item.sender.type ?? '') ? 'bot' : item.sender.id ? 'human' : 'unknown';
        const parsed = item.deleted ? undefined : await parseLarkMessageContent(item.messageType, item.rawContent, { messageId: item.messageId }).catch(() => undefined);
        const excerpt = clipCardField(redactTraceText(stripMentionPlaceholders(parsed?.text ?? '')).replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim(), 80);
        const base = { messageId: item.messageId, at, senderKind, excerpt } as const;
        const outcome = item.deleted ? skip('context_failed', '原消息已撤回')
          : !parsed ? skip('parsing_failed', '无法读取消息正文')
          : await evaluate(item, senderKind, parsed.text, at);
        messages.push({ ...base, ...outcome });
      }
    }, '计算场景预演', input.timeoutMs);
  } catch {
    return previewUnavailable();
  }
  const matched = messages.filter(item => item.matched).length;
  return { status: 'ok', mode: pack.mode, limit, matched, skipped: messages.length - matched, messages: messages.reverse(),
    note: pack.mode === 'model' ? '是否回复由模型逐条判断，预演不调用模型。' : '去重和每小时上限按本次历史样本计算。' };

  async function evaluate(item: LarkChatMessage, kind: ScenarioPreviewMessage['senderKind'], text: string, at: string) {
    const sender = item.sender.id;
    if (kind === 'unknown') return skip('identity_failed', '无法确认发送人身份');
    const event = { ...item, chatId: scope.chatId, senderOpenId: kind === 'human' || item.sender.idType === 'open_id' ? sender : undefined,
      mentions: item.mentions.map(mention => ({ openId: mention.id === self.appId ? self.openId ?? self.appId : mention.id })) };
    const selfId = self.openId ?? self.appId;
    const message = humanScenarioMessage(event, text, selfId);
    const source = kind === 'bot' && (item.sender.idType === 'app_id' || sender?.startsWith('cli_')) ? sender : undefined;
    if (sender === self.appId || self.openId && sender === self.openId) return skip('bot_message', '机器人自己的消息不触发场景');
    if (pack.mode === 'model') {
      if (kind !== 'human') return skip('bot_message', '模型场景只看真人消息');
      if (message.mentionsSelf) return skip('not_addressed', '已 @ 本机器人，按普通请求处理');
      if (!input.modelActive) return skip('not_addressed', '模型场景只在按需或积极参与时生效');
    } else {
      if (!source) return skip(kind === 'bot' ? 'bot_message' : 'not_addressed', '不是这个场景的来源机器人');
      if (responderAnnouncementOf(text)) return skip('command_handled', '这条消息用于同步群接话人');
      Object.assign(message, { senderKind: 'bot', senderAppId: source } satisfies Partial<ScenarioMessage>);
    }

    const context = { scope, cwd: config.workspace };
    const match = await scenarios.match(target.entry, target.binding, message, context);
    if (!match.matched) return skip('not_addressed', match.detail);
    for (const other of earlier) {
      const candidate = await scenarios.match(other.entry, other.binding, message, context);
      if (candidate.matched && (pack.mode === 'direct' || !('abstained' in candidate))) {
        return skip('not_addressed', `同时命中场景「${other.entry.pack.title}」，按场景顺序由它接手`);
      }
    }
    if ('abstained' in match) return skip('participation_failed', pack.mode === 'direct' ? directReason(pack, 'abstained') : '场景规则未能完成匹配');
    if (pack.mode === 'model') return result(true, 'participation_observes', '通过场景规则，等待模型判断');
    const decision = decideDirect({ pack, binding: target.binding, self, sender: { appId: source, openId: message.senderOpenId },
      text, responderAppId: duty.responder?.appId, window: { records: window, truncated: false }, dedupeKey: match.dedupeKey, now: Date.parse(at) });
    if (!decision.matched) return skip('bot_message', '不是这个场景的来源机器人');
    if (decision.outcome === 'started') {
      window.push({ action: 'act', status: 'candidate', createdAt: at, inputSnapshot: { gate: SCENARIO_RECORD, scenario: { packId: pack.id, dedupeKey: decision.dedupeKey } } });
      return result(true, 'participation_handled', '命中场景规则');
    }
    const reason = decision.outcome === 'duplicate' ? 'participation_duplicate'
      : decision.outcome === 'rate_limited' ? 'participation_budget'
      : decision.outcome === 'no_requester' ? 'access_denied' : 'not_addressed';
    return skip(reason, directReason(pack, decision.outcome));
  }
}
