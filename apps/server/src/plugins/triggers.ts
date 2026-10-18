import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { wrapUntrusted, type PluginTrigger } from '@dutydeck/shared';

/** 触发器请求体上限，路由层与服务层同一个值。 */
export const TRIGGER_BODY_LIMIT = 1024 * 1024;
const DEDUPE_TTL_MS = 24 * 60 * 60_000;

export interface TriggerRequest {
  plugin: string;
  triggerId: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}
export interface TriggerResponse { statusCode: number; body: Record<string, unknown> }

export type ScopedPluginTrigger = PluginTrigger & { scope: string };

export interface TriggerDispatch {
  scope: string;
  plugin: string;
  triggerId: string;
  target: PluginTrigger['target'];
  prompt: string;
  /** 派发键：同一次去重占位内稳定；去重过期后再来的同一事件得到新键，不会撞上旧任务的幂等记录。 */
  key: string;
}

export interface TriggerServiceOptions {
  lookup(plugin: string, triggerId: string): ScopedPluginTrigger | undefined;
  token(plugin: string, triggerId: string): string | undefined;
  deliver(request: TriggerDispatch): Promise<{ sessionId: string; taskId: string }>;
  dedupe?: TriggerDedupe;
  /** 任务是否已结束。取消排队任务、停止会话不触发结算通知，名额靠它回收。 */
  isSettled?(taskId: string): boolean;
  now?: () => number;
}

/** 去重占位：TTL 内同一个键只放行一次；派发失败时撤销，让发送方重试。 */
export interface TriggerDedupe {
  claim(key: string, now: number, expiresAt: number): boolean;
  release(key: string, expiresAt: number): void;
}

export class MemoryTriggerDedupe implements TriggerDedupe {
  private readonly keys = new Map<string, number>();
  claim(key: string, now: number, expiresAt: number) {
    for (const [stored, expiry] of this.keys) if (expiry <= now) this.keys.delete(stored);
    if (this.keys.has(key)) return false;
    this.keys.set(key, expiresAt);
    return true;
  }
  release(key: string, expiresAt: number) { if (this.keys.get(key) === expiresAt) this.keys.delete(key); }
}

/** 先各自取摘要再比较，长度也不会通过耗时泄露。 */
export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}

const header = (headers: TriggerRequest['headers'], name: string) => {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

export function verifyTriggerAuth(auth: PluginTrigger['auth'], secret: string, request: Pick<TriggerRequest, 'rawBody' | 'headers'>): boolean {
  const presented = header(request.headers, auth.header)?.trim();
  if (!presented) return false;
  if (auth.type === 'token') return constantTimeEqual(presented.replace(/^Bearer\s+/i, ''), secret);
  const expected = createHmac('sha256', secret).update(request.rawBody).digest('hex');
  return constantTimeEqual(presented.replace(/^sha256=/i, '').toLowerCase(), expected);
}

const lookupPath = (root: unknown, path: string[]): unknown => {
  let value = root;
  for (const segment of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
};

const stringify = (value: unknown) => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/**
 * `{{payload.a.b}}`、`{{payload}}`、`{{headers.x-name}}` 取值。prompt 里的每个取值都包进不可信数据块；
 * dedupeKey 只用原值算摘要。其余 `{{…}}` 原样保留。
 */
export function renderTriggerTemplate(template: string, data: { payload: unknown; headers: TriggerRequest['headers'] }, wrap?: (text: string) => string): string {
  return template.replace(/\{\{\s*(payload|headers)((?:\.[^\s.}]+)*)\s*\}\}/g, (_match, root: string, rest: string) => {
    const path = rest ? rest.slice(1).split('.') : [];
    const value = root === 'payload' ? lookupPath(data.payload, path) : path.length === 1 ? header(data.headers, path[0]!) : undefined;
    const text = stringify(value);
    return wrap ? wrap(text) : text;
  });
}

/**
 * 插件触发器入口：鉴权 → 解析 → 去重 → 并发上限 → 渲染 prompt → 交给注入式投递。
 * 每个触发器独立令牌；令牌或签名错误一律 401，不区分原因。
 */
export class PluginTriggerService {
  private readonly inFlight = new Map<string, Set<string>>();
  private readonly dedupe: TriggerDedupe;
  constructor(private readonly options: TriggerServiceOptions) { this.dedupe = options.dedupe ?? new MemoryTriggerDedupe(); }

  async receive(request: TriggerRequest): Promise<TriggerResponse> {
    const trigger = this.options.lookup(request.plugin, request.triggerId);
    if (!trigger) return { statusCode: 404, body: { error: { code: 'PLUGIN_TRIGGER_NOT_FOUND', message: '没有这个触发器，或插件未启用' } } };
    if (request.rawBody.length > TRIGGER_BODY_LIMIT) return { statusCode: 413, body: { error: { code: 'PLUGIN_TRIGGER_BODY_TOO_LARGE', message: `请求体超过 ${TRIGGER_BODY_LIMIT} 字节` } } };
    const secret = this.options.token(request.plugin, request.triggerId);
    if (!secret || !verifyTriggerAuth(trigger.auth, secret, request)) {
      return { statusCode: 401, body: { error: { code: 'PLUGIN_TRIGGER_UNAUTHORIZED', message: '触发器令牌或签名无效' } } };
    }
    let payload: unknown;
    try { payload = JSON.parse(request.rawBody.toString('utf8')); }
    catch { return { statusCode: 400, body: { error: { code: 'PLUGIN_TRIGGER_INVALID_JSON', message: '请求体必须是 JSON' } } }; }

    const id = `${request.plugin}/${request.triggerId}`;
    // 模板取不到令牌、签名和 cookie。
    const hidden = new Set([trigger.auth.header.toLowerCase(), 'authorization', 'cookie']);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !hidden.has(name.toLowerCase())));
    const rawKey = trigger.dedupeKey ? renderTriggerTemplate(trigger.dedupeKey, { payload, headers }) : '';
    const digest = createHash('sha256').update(rawKey.trim() ? `key\n${rawKey}` : `body\n${request.rawBody.toString('base64')}`).digest('hex');
    const dedupeKey = `plugin-trigger:${id}:${digest}`;
    const now = this.options.now?.() ?? Date.now();
    const expiresAt = now + DEDUPE_TTL_MS;
    if (!this.dedupe.claim(dedupeKey, now, expiresAt)) return { statusCode: 200, body: { accepted: false, duplicate: true } };

    const running = this.inFlight.get(id) ?? new Set<string>();
    for (const entry of running) if (!entry.startsWith('pending:') && this.options.isSettled?.(entry)) running.delete(entry);
    if (running.size >= trigger.maxConcurrent) {
      this.dedupe.release(dedupeKey, expiresAt);
      return { statusCode: 429, body: { error: { code: 'PLUGIN_TRIGGER_BUSY', message: `已有 ${running.size} 个任务在执行，达到 maxConcurrent 上限` } } };
    }
    const source = `plugin:${request.plugin}/trigger:${request.triggerId}`;
    const prompt = renderTriggerTemplate(trigger.prompt, { payload, headers }, text => wrapUntrusted(source, text));
    // 投递要等，先占名额，并发请求不会一起越过上限；拿到任务 id 后换成它。
    const placeholder = `pending:${dedupeKey}`;
    running.add(placeholder);
    this.inFlight.set(id, running);
    try {
      const accepted = await this.options.deliver({ scope: trigger.scope, plugin: request.plugin, triggerId: request.triggerId, target: trigger.target, prompt, key: `${id}:${digest.slice(0, 32)}:${expiresAt}` });
      running.add(accepted.taskId);
      this.release(id, placeholder);
      return { statusCode: 202, body: { accepted: true, sessionId: accepted.sessionId, taskId: accepted.taskId } };
    } catch (error) {
      this.release(id, placeholder);
      this.dedupe.release(dedupeKey, expiresAt);
      return { statusCode: 502, body: { error: { code: 'PLUGIN_TRIGGER_DELIVERY_FAILED', message: error instanceof Error ? error.message : String(error) } } };
    }
  }

  /** 任务结算后释放并发名额。 */
  settled(taskId: string): void {
    for (const id of this.inFlight.keys()) this.release(id, taskId);
  }

  private release(id: string, entry: string) {
    const tasks = this.inFlight.get(id);
    if (tasks?.delete(entry) && !tasks.size) this.inFlight.delete(id);
  }

  inFlightCount(plugin: string, triggerId: string): number { return this.inFlight.get(`${plugin}/${triggerId}`)?.size ?? 0; }
}
