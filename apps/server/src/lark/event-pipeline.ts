import { cardActionMatchesHandler, cardActionRoute, forwardCardAction, isBuiltinCardAction, parseCardActionForwarding, parseCardActionValue, type CardActionForwarding } from './card-action-forwarding.js';
import { LarkServiceError } from './service.js';

export const larkEventTypes = ['card.action.trigger', 'im.message.receive_v1'] as const;
export type LarkEventType = typeof larkEventTypes[number];
export interface LarkEventHandler {
  id: string;
  eventTypes: LarkEventType[];
  url: string;
  token: string;
  owner?: string;
  legacyActions?: string[];
}
export type LarkEventToast = { type: 'success' | 'info' | 'warning' | 'error'; content: string };
export type LarkEventDecision = { decision: 'continue' | 'stop'; toast?: LarkEventToast };

export function parseLarkEventHandlers(value: unknown, current: LarkEventHandler[] = []): LarkEventHandler[] | undefined {
  if (value === undefined || value === null) return undefined;
  const invalid = (message: string) => new LarkServiceError('INVALID_LARK_CONFIG', `eventHandlers ${message}`, 400);
  if (!Array.isArray(value)) throw invalid('必须为处理器数组或 null。');
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('处理器必须为对象。');
    const input = entry as Record<string, unknown>;
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(input.id) || ids.has(input.id)) throw invalid('id 必须唯一，且为 1–64 位字母、数字、点、下划线或连字符。');
    ids.add(input.id);
    if (!Array.isArray(input.eventTypes) || !input.eventTypes.length || input.eventTypes.some(type => !larkEventTypes.includes(type as LarkEventType))) throw invalid('eventTypes 只允许 card.action.trigger 和 im.message.receive_v1。');
    if (input.owner !== undefined && (typeof input.owner !== 'string' || !input.owner.trim())) throw invalid('owner 必须为非空字符串。');
    if (input.eventTypes.includes('im.message.receive_v1') && (input.owner !== undefined || input.legacyActions !== undefined)) throw invalid('消息处理器不能配置卡片 owner 或 legacyActions。');
    const previous = current.find(handler => handler.id === input.id);
    if (input.token === undefined && previous && input.url !== previous.url) {
      let sameUrl = false;
      try { sameUrl = new URL(String(input.url)).toString() === previous.url; } catch {}
      if (!sameUrl) throw invalid('修改 URL 时必须显式提供 token。');
    }
    const destination = parseCardActionForwarding({ owner: input.owner ?? input.id, url: input.url,
      token: input.token === undefined ? previous?.token : input.token, legacyActions: input.legacyActions })!;
    return { id: input.id, eventTypes: [...new Set(input.eventTypes)] as LarkEventType[], url: destination.url, token: destination.token,
      ...(input.owner !== undefined ? { owner: destination.owner } : {}),
      ...(destination.legacyActions !== undefined ? { legacyActions: destination.legacyActions } : {}) };
  });
}

export function validateLarkEventConfiguration(config: { eventHandlers?: LarkEventHandler[]; cardActionForwarding?: CardActionForwarding }) {
  if (config.eventHandlers?.length && config.cardActionForwarding) throw new LarkServiceError('INVALID_LARK_CONFIG', 'eventHandlers 与 cardActionForwarding 不能同时启用；迁移时请同时提交 cardActionForwarding:null。', 400);
}

const validToast = (toast: unknown): toast is LarkEventToast => {
  if (!toast || typeof toast !== 'object' || Array.isArray(toast)) return false;
  const value = toast as Record<string, unknown>;
  return typeof value.type === 'string' && ['success', 'info', 'warning', 'error'].includes(value.type) && typeof value.content === 'string' && Boolean(value.content.trim());
};

/** External receivers own persistent deduplication; the whole chain shares one deadline. */
export async function runLarkEventPipeline(config: { appId: string; eventHandlers?: LarkEventHandler[]; cardActionForwarding?: CardActionForwarding },
  eventType: LarkEventType, event: any, fetcher: typeof globalThis.fetch,
  log: { info(details: unknown, message?: string): void }): Promise<LarkEventDecision> {
  const card = eventType === 'card.action.trigger';
  const handlers = config.eventHandlers ?? [];
  const legacy = card ? config.cardActionForwarding : undefined;
  const registered = handlers.filter(handler => handler.eventTypes.includes(eventType));
  if (!registered.length && !legacy) return { decision: 'continue' };
  const value = card ? parseCardActionValue(event.action?.value) : undefined;
  const reject = (content: string): LarkEventDecision => ({ decision: 'stop', toast: { type: 'error', content } });
  if (card && isBuiltinCardAction(value)) {
    return value && Object.hasOwn(value, 'owner') ? reject('卡片操作同时包含外部与内置标记，已拒绝。') : { decision: 'continue' };
  }
  const matching = registered.filter(handler => !card || cardActionMatchesHandler(handler, value));
  // legacy 转发与 eventHandlers 互斥（parse 边界 validateLarkEventConfiguration 已保证），两套路由不会同时存在。
  let routeLegacy = false;
  if (legacy) {
    const route = cardActionRoute(event.action?.value, legacy);
    if (route === 'unknown') return reject('未配置此卡片的接收服务。');
    if (route !== 'forward') return { decision: 'continue' };
    routeLegacy = true;
  } else if (!matching.length) {
    return card && value && Object.hasOwn(value, 'owner') ? reject('未配置此卡片的接收服务。') : { decision: 'continue' };
  }
  const deadline = new AbortController();
  const signal = deadline.signal;
  const timer = setTimeout(() => deadline.abort(), 2_000);
  let rejectDeadline!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectDeadline = () => reject(new Error('Event pipeline deadline exceeded')); });
  signal.addEventListener('abort', rejectDeadline, { once: true });
  const eventId = typeof event.event_id === 'string' ? event.event_id : undefined;
  const audit = (handlerId: string, result: string) => log.info({ eventType, handlerId, eventId, result }, '飞书外部事件处理');
  let handlerId = routeLegacy ? 'legacy-card-action' : matching[0]!.id;
  try {
    if (!eventId) throw new Error('Event is missing event_id');
    if (routeLegacy) {
      // forwardCardAction 自身兜底网络错误；仍要与 aborted 竞速，使响应头已返回但回执 body 卡住时受同一 2 秒死线约束。
      const toast = await Promise.race([forwardCardAction(legacy!, config.appId, event, fetcher, signal), aborted]);
      audit(handlerId, toast.type === 'success' ? 'stop' : 'error');
      return { decision: 'stop', toast: toast as LarkEventToast };
    }
    for (const handler of matching) {
      handlerId = handler.id;
      const receipt = await Promise.race([(async () => {
        const response = await fetcher(handler.url, { method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${handler.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 1, app_id: config.appId, handler_id: handler.id, event_type: eventType, event }) });
        if (response.status !== 200 && response.status !== 202) throw new Error('Invalid event receipt status');
        const receipt = await response.json();
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.event_id !== eventId
          || !['continue', 'stop'].includes(receipt.decision) || receipt.toast !== undefined && !validToast(receipt.toast)) throw new Error('Invalid event receipt');
        return receipt as LarkEventDecision;
      })(), aborted]);
      audit(handler.id, receipt.decision);
      if (receipt.decision === 'stop') return { decision: 'stop', ...(card && receipt.toast ? { toast: { type: receipt.toast.type, content: receipt.toast.content } } : {}) };
    }
    return { decision: 'continue' };
  } catch {
    audit(handlerId, signal.aborted ? 'timeout' : 'error');
    if (!card) throw new LarkServiceError('LARK_EVENT_HANDLER_FAILED', signal.aborted ? '外部消息处理超时，结果待确认。' : '外部消息处理失败或回执无效，结果待确认。', 502);
    return { decision: 'stop', toast: { type: signal.aborted ? 'warning' : 'error', content: !eventId ? '卡片事件缺少 event_id，无法转发。'
      : signal.aborted ? '卡片操作转发超时，结果待确认，请查询接收服务。' : '卡片操作转发失败或回执无效，结果待确认，请联系接收服务管理员。' } };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', rejectDeadline); }
}
