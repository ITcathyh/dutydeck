import { parseLarkCardActionValue } from './card-actions.js';
import { LarkServiceError } from './service.js';

export interface CardActionForwarding {
  owner: string;
  url: string;
  token: string;
  legacyActions?: string[];
}

/** Validate at both the save and load boundaries; never accept remote plaintext credentials. */
export function parseCardActionForwarding(value: unknown): CardActionForwarding | undefined {
  if (value === undefined || value === null) return undefined;
  const invalid = () => new LarkServiceError('INVALID_LARK_CONFIG', 'cardActionForwarding 需要 owner、URL 和 token；URL 仅允许 HTTPS 或本机 HTTP，旧动作不能包含内置按钮。', 400);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (typeof input.owner !== 'string' || !input.owner.trim() || typeof input.url !== 'string'
    || typeof input.token !== 'string' || !input.token.trim() || /[\r\n]/.test(input.token)) throw invalid();
  let url: URL;
  try { url = new URL(input.url); } catch { throw invalid(); }
  if (url.username || url.password || url.hash || !(url.protocol === 'https:'
    || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw invalid();
  const legacy = input.legacyActions;
  if (legacy !== undefined && (!Array.isArray(legacy) || legacy.some(action => typeof action !== 'string' || !action.trim()
    || action.trim().startsWith('dutydeck_') || parseLarkCardActionValue({ action, task_id: 'reserved' })))) throw invalid();
  return { owner: input.owner.trim(), url: url.toString(), token: input.token,
    ...(legacy !== undefined ? { legacyActions: [...new Set((legacy as string[]).map(action => action.trim()))] } : {}) };
}

type CardActionRoute = 'builtin' | 'forward' | 'unknown' | 'conflict';
export function cardActionRoute(value: unknown, forwarding?: CardActionForwarding): CardActionRoute {
  let parsed = value;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { return 'builtin'; } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'builtin';
  const action = parsed as Record<string, unknown>;
  const builtin = Object.keys(action).some(key => key === 'task_id' || key === 'taskId' || key.startsWith('dutydeck_') || key === 'dockmux_workflow');
  if (Object.hasOwn(action, 'owner')) {
    if (builtin) return 'conflict';
    return forwarding && action.owner === forwarding.owner ? 'forward' : 'unknown';
  }
  if (builtin) return 'builtin';
  return forwarding && typeof action.action === 'string' && forwarding.legacyActions?.includes(action.action) ? 'forward' : 'builtin';
}

/** A receipt means the receiver has persisted this exact event; never retry in the background. */
export async function forwardCardAction(config: CardActionForwarding, appId: string, event: any, fetcher: typeof globalThis.fetch) {
  const signal = AbortSignal.timeout(2_000);
  try {
    if (typeof event.event_id !== 'string' || !event.event_id) return { type: 'error', content: '卡片事件缺少 event_id，无法转发。' };
    const response = await fetcher(config.url, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, app_id: appId, event })
    });
    if (response.status !== 202 && response.status !== 200) {
      return { type: 'error', content: `卡片操作转发失败（HTTP ${response.status}），请联系接收服务管理员。` };
    }
    const receipt = await response.json();
    if (!receipt || typeof receipt !== 'object' || receipt.event_id !== event.event_id
      || !(response.status === 202 && receipt.status === 'accepted' || response.status === 200 && receipt.status === 'duplicate')) {
      return { type: 'error', content: '接收服务未返回有效回执，操作结果待确认。' };
    }
    return { type: 'success', content: receipt.status === 'accepted' ? '已受理。' : '已接收，请勿重复操作。' };
  } catch {
    return signal.aborted
      ? { type: 'warning', content: '卡片操作转发超时，结果待确认，请查询接收服务。' }
      : { type: 'error', content: '卡片操作转发失败，结果待确认，请联系接收服务管理员。' };
  }
}
