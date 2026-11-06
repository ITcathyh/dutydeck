import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { wrapUntrusted, type PluginTrigger, type WorkItem } from '@dutydeck/shared';

/** 触发器请求体上限，路由层与服务层同一个值。 */
export const TRIGGER_BODY_LIMIT = 1024 * 1024;
const DEDUPE_TTL_MS = 24 * 60 * 60_000;

export interface TriggerRequest {
  plugin: string;
  triggerId: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Versioned task API can provide a stable status URL without changing the trigger identity. */
  statusUrl?: (runId: string) => string;
  dryRun?: boolean;
}
export interface TriggerResponse { statusCode: number; body: Record<string, unknown> }
export type TriggerRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
export interface TriggerRun {
  runId: string; plugin: string; triggerId: string; sessionId?: string; taskId?: string;
  /** 启动工作项模板的运行：跟踪工作项而不是单个任务。 */
  workItemId?: string;
  status: TriggerRunStatus; error?: string; createdAt: number; updatedAt: number;
}

export type ScopedPluginTrigger = PluginTrigger & { scope: string };

export interface TriggerDispatch {
  scope: string;
  plugin: string;
  triggerId: string;
  target: PluginTrigger['target'];
  /** 与 workTemplate 二选一；workTemplate.goal 已渲染并包好不可信取值。 */
  prompt?: string;
  workTemplate?: NonNullable<PluginTrigger['workTemplate']>;
  /** 派发键：同一次去重占位内稳定；去重过期后再来的同一事件得到新键，不会撞上旧任务的幂等记录。 */
  key: string;
}

export interface TriggerServiceOptions {
  lookup(plugin: string, triggerId: string): ScopedPluginTrigger | undefined;
  token(plugin: string, triggerId: string): string | undefined;
  deliver(request: TriggerDispatch): Promise<TriggerAccepted>;
  /** Cancel a task that has not been submitted to the agent yet. */
  cancel?(sessionId: string, taskId: string): Promise<boolean>;
  /** 工作项当前状态；不存在时 undefined。 */
  workStatus?(workItemId: string): WorkItem['status'] | undefined;
  /** 取消仍在等待确认、尚未执行任何步骤的工作项。 */
  cancelWork?(sessionId: string, workItemId: string): Promise<boolean>;
  dedupe?: TriggerDedupe;
  /** 任务是否已结束。取消排队任务、停止会话不触发结算通知，名额靠它回收。 */
  isSettled?(taskId: string): boolean;
  /** Optional durable task binding used to recover status after a daemon restart. */
  runBindings?: {
    bindTask(taskId: string, subscriptionId: string, createdAt: number): void;
    listTaskBindings(): Array<{ taskId: string; subscriptionId: string; createdAt: number }>;
    unbindTask(taskId: string): void;
  };
  taskStatus?(taskId: string): TriggerRunStatus | undefined;
  now?: () => number;
}

export type TriggerAccepted = { sessionId: string; taskId: string } | { sessionId: string; workItemId: string; awaitingConfirmation: boolean };

/** 模板、模板所在会话或其交付位置不可用：配置问题，返回 422，原错误码放在 cause。 */
export class TriggerTemplateUnavailableError extends Error {
  constructor(readonly cause: string, message: string) { super(message); this.name = 'TriggerTemplateUnavailableError'; }
}

/** 工作项占用的并发名额与运行状态都按 `work:<id>` 跟踪，和任务编号分开。 */
const WORK_ENTRY = 'work:';
/** 等确认、执行中、等待人工或结果待核对的工作项占名额；结束、失败、取消后释放。 */
function workRunStatus(status: WorkItem['status'] | undefined): TriggerRunStatus {
  if (status === 'awaiting_confirmation') return 'queued';
  if (status === 'running' || status === 'waiting' || status === 'cancelling') return 'running';
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'unknown';
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
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(value) ? value[0] : value;
};

const bodyDigest = (rawBody: Buffer) => createHash('sha256').update(rawBody).digest('hex');

export function hmacTriggerNonceHeader(auth: Extract<PluginTrigger['auth'], { type: 'hmac-sha256' }>): string {
  return auth.nonceHeader;
}

export function hmacTriggerSignaturePayload(timestamp: string, nonce: string, rawBody: Buffer): string {
  return `${timestamp}\n${nonce}\n${bodyDigest(rawBody)}`;
}

export function verifyTriggerAuth(auth: PluginTrigger['auth'], secret: string, request: Pick<TriggerRequest, 'rawBody' | 'headers'>, now = Date.now()): boolean {
  const presented = header(request.headers, auth.header)?.trim();
  if (!presented) return false;
  if (auth.type === 'token') return constantTimeEqual(presented.replace(/^Bearer\s+/i, ''), secret);
  const timestamp = header(request.headers, auth.timestampHeader)?.trim();
  const nonce = header(request.headers, auth.nonceHeader)?.trim();
  if (!timestamp || !nonce || !/^[0-9]{1,15}$/.test(timestamp) || !/^[\x21-\x7e]{8,200}$/.test(nonce)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Math.floor(now / 1000) - timestampSeconds) > auth.maxAgeSeconds) return false;
  const expected = createHmac('sha256', secret).update(hmacTriggerSignaturePayload(timestamp, nonce, request.rawBody)).digest('hex');
  return constantTimeEqual(presented.replace(/^sha256=/i, '').toLowerCase(), expected);
}

/** 时间戳按整秒比对、前后各放宽 maxAge 秒；nonce 记录要留到签名失效之后，否则换个 Idempotency-Key 就能重放。 */
function hmacNonceExpiresAt(auth: Extract<PluginTrigger['auth'], { type: 'hmac-sha256' }>, headers: TriggerRequest['headers'], now: number): number {
  const timestampSeconds = Number(header(headers, auth.timestampHeader)!.trim());
  return Math.max(now + auth.maxAgeSeconds * 1000, (timestampSeconds + auth.maxAgeSeconds + 1) * 1000);
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
  private readonly runs = new Map<string, TriggerRun>();
  private readonly runKeys = new Map<string, { runId: string; expiresAt: number }>();
  private readonly dedupe: TriggerDedupe;
  constructor(private readonly options: TriggerServiceOptions) {
    this.dedupe = options.dedupe ?? new MemoryTriggerDedupe();
    for (const binding of options.runBindings?.listTaskBindings() ?? []) {
      if (!binding.subscriptionId.startsWith('dutydeck-plugin-trigger:')) continue;
      if (binding.createdAt + DEDUPE_TTL_MS <= (options.now?.() ?? Date.now())) { options.runBindings?.unbindTask(binding.taskId); continue; }
      const decoded = decodeRunBinding(binding.subscriptionId);
      if (!decoded) continue;
      const status = this.entryStatus(binding.taskId) ?? 'running';
      this.runs.set(decoded.runId, { runId: decoded.runId, plugin: decoded.plugin, triggerId: decoded.triggerId, sessionId: decoded.sessionId, ...this.entryRef(binding.taskId), status, createdAt: binding.createdAt, updatedAt: binding.createdAt });
      if (this.entryHolds(binding.taskId, status)) {
        const key = `${decoded.plugin}/${decoded.triggerId}`;
        const tasks = this.inFlight.get(key) ?? new Set<string>();
        tasks.add(binding.taskId);
        this.inFlight.set(key, tasks);
      }
    }
  }

  async receive(request: TriggerRequest): Promise<TriggerResponse> {
    const trigger = this.options.lookup(request.plugin, request.triggerId);
    if (!trigger) return { statusCode: 404, body: { error: { code: 'PLUGIN_TRIGGER_NOT_FOUND', message: '没有这个触发器，或插件未启用' } } };
    if (request.rawBody.length > TRIGGER_BODY_LIMIT) return { statusCode: 413, body: { error: { code: 'PLUGIN_TRIGGER_BODY_TOO_LARGE', message: `请求体超过 ${TRIGGER_BODY_LIMIT} 字节` } } };
    const now = this.options.now?.() ?? Date.now();
    for (const binding of this.options.runBindings?.listTaskBindings() ?? []) if (binding.subscriptionId.startsWith('dutydeck-plugin-trigger:') && binding.createdAt + DEDUPE_TTL_MS <= now) this.options.runBindings?.unbindTask(binding.taskId);
    const secret = this.options.token(request.plugin, request.triggerId);
    if (!secret || !verifyTriggerAuth(trigger.auth, secret, request, now)) {
      return { statusCode: 401, body: { error: { code: 'PLUGIN_TRIGGER_UNAUTHORIZED', message: '触发器令牌或签名无效' } } };
    }
    const id = `${request.plugin}/${request.triggerId}`;
    if (trigger.auth.type === 'hmac-sha256') {
      const nonce = header(request.headers, hmacTriggerNonceHeader(trigger.auth))!.trim();
      const nonceKey = `plugin-trigger-nonce:${id}:${nonce}`;
      const nonceExpiresAt = hmacNonceExpiresAt(trigger.auth, request.headers, now);
      if (!this.dedupe.claim(nonceKey, now, nonceExpiresAt)) return { statusCode: 401, body: { error: { code: 'PLUGIN_TRIGGER_REPLAYED', message: '触发器请求已被使用' } } };
    }
    let payload: unknown;
    try { payload = JSON.parse(request.rawBody.toString('utf8')); }
    catch { return { statusCode: 400, body: { error: { code: 'PLUGIN_TRIGGER_INVALID_JSON', message: '请求体必须是 JSON' } } }; }

    // 模板取不到令牌、签名和 cookie。
    const hidden = new Set([trigger.auth.header.toLowerCase(), 'authorization', 'cookie', 'idempotency-key']);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !hidden.has(name.toLowerCase())));
    const requestIdempotencyKey = header(request.headers, 'idempotency-key')?.trim();
    if (requestIdempotencyKey && requestIdempotencyKey.length > 1_000) return { statusCode: 400, body: { error: { code: 'PLUGIN_TRIGGER_INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key 不能超过 1000 个字符' } } };
    const keyTemplate = trigger.idempotencyKey ?? trigger.dedupeKey;
    const rawKey = requestIdempotencyKey || (keyTemplate ? renderTriggerTemplate(keyTemplate, { payload, headers }) : '');
    const digest = createHash('sha256').update(rawKey.trim() ? `key\n${rawKey}` : `body\n${request.rawBody.toString('base64')}`).digest('hex');
    const dedupeKey = `plugin-trigger:${id}:${digest}`;
    const expiresAt = now + DEDUPE_TTL_MS;
    for (const [key, value] of this.runKeys) if (value.expiresAt <= now) {
      this.runKeys.delete(key);
      const run = this.runs.get(value.runId);
      if (run && !['queued', 'running'].includes(run.status)) this.runs.delete(value.runId);
    }
    const existingRun = this.runKeys.get(dedupeKey);
    if (!this.dedupe.claim(dedupeKey, now, expiresAt)) {
      const persisted = this.findDurableRunByDigest(request.plugin, request.triggerId, digest);
      const runId = existingRun?.runId ?? persisted?.runId ?? `tr_${digest.slice(0, 32)}`;
      return { statusCode: 200, body: { accepted: false, duplicate: true, runId } };
    }
    if (existingRun) {
      const previous = this.runs.get(existingRun.runId);
      if (previous && !['queued', 'running'].includes(previous.status)) this.runs.delete(existingRun.runId);
    }
    const runId = `tr_${randomUUID().replaceAll('-', '')}`;
    this.runKeys.set(dedupeKey, { runId, expiresAt });

    const running = this.inFlight.get(id) ?? new Set<string>();
    for (const entry of running) if (!entry.startsWith('pending:') && !this.entryHolds(entry)) running.delete(entry);
    // 工作项失败后会被移出名额，之后 Agent 才提交修订时它又回到「仍在进行」：按绑定记录重读进度，重新占回名额。
    for (const binding of this.options.runBindings?.listTaskBindings() ?? []) {
      if (!binding.taskId.startsWith(WORK_ENTRY) || running.has(binding.taskId)) continue;
      const decoded = decodeRunBinding(binding.subscriptionId);
      if (decoded && `${decoded.plugin}/${decoded.triggerId}` === id && this.entryHolds(binding.taskId)) running.add(binding.taskId);
    }
    if (running.size >= trigger.maxConcurrent) {
      this.dedupe.release(dedupeKey, expiresAt);
      return { statusCode: 429, body: { error: { code: 'PLUGIN_TRIGGER_BUSY', message: `已有 ${running.size} 个任务在执行，达到 maxConcurrent 上限` } } };
    }
    const source = `plugin:${request.plugin}/trigger:${request.triggerId}`;
    const render = (template: string) => renderTriggerTemplate(template, { payload, headers }, text => wrapUntrusted(source, text));
    const work = trigger.workTemplate ? { workTemplate: { ...trigger.workTemplate, goal: render(trigger.workTemplate.goal) } } : { prompt: render(trigger.prompt!) };
    if (request.dryRun) {
      this.runKeys.delete(dedupeKey);
      this.dedupe.release(dedupeKey, expiresAt);
      return { statusCode: 200, body: { accepted: false, dryRun: true, plugin: request.plugin, triggerId: request.triggerId } };
    }
    // 投递要等，先占名额，并发请求不会一起越过上限；拿到任务 id 后换成它。
    const placeholder = `pending:${dedupeKey}`;
    running.add(placeholder);
    this.inFlight.set(id, running);
    this.runs.set(runId, { runId, plugin: request.plugin, triggerId: request.triggerId, status: 'queued', createdAt: now, updatedAt: now });
    try {
      const accepted = await this.options.deliver({ scope: trigger.scope, plugin: request.plugin, triggerId: request.triggerId, target: trigger.target, ...work, key: `${id}:${digest.slice(0, 32)}:${expiresAt}` });
      const entry = 'taskId' in accepted ? accepted.taskId : `${WORK_ENTRY}${accepted.workItemId}`;
      const status: TriggerRunStatus = 'workItemId' in accepted && accepted.awaitingConfirmation ? 'queued' : 'running';
      running.add(entry);
      this.release(id, placeholder);
      this.runs.set(runId, { ...this.runs.get(runId)!, sessionId: accepted.sessionId, ...this.entryRef(entry), status, updatedAt: this.options.now?.() ?? Date.now() });
      try { this.options.runBindings?.bindTask(entry, encodeRunBinding({ runId, plugin: request.plugin, triggerId: request.triggerId, sessionId: accepted.sessionId, dedupeDigest: digest }), now); } catch { /* status recovery is best effort; the accepted task remains authoritative */ }
      const statusUrl = request.statusUrl?.(runId) ?? `/api/plugins/${request.plugin}/triggers/${request.triggerId}/runs/${runId}`;
      return { statusCode: 202, body: 'taskId' in accepted
        ? { accepted: true, runId, sessionId: accepted.sessionId, taskId: accepted.taskId, statusUrl }
        : { accepted: true, runId, sessionId: accepted.sessionId, workItemId: accepted.workItemId, awaitingConfirmation: accepted.awaitingConfirmation, statusUrl } };
    } catch (error) {
      this.release(id, placeholder);
      this.dedupe.release(dedupeKey, expiresAt);
      const message = error instanceof Error ? error.message : String(error);
      this.runs.set(runId, { ...this.runs.get(runId)!, status: 'failed', error: message, updatedAt: this.options.now?.() ?? Date.now() });
      if (error instanceof TriggerTemplateUnavailableError) return { statusCode: 422, body: { error: { code: 'PLUGIN_TRIGGER_TEMPLATE_UNAVAILABLE', message, cause: error.cause } } };
      return { statusCode: 502, body: { error: { code: 'PLUGIN_TRIGGER_DELIVERY_FAILED', message } } };
    }
  }

  /** 任务结算后释放并发名额。 */
  settled(taskId: string, status: Exclude<TriggerRunStatus, 'queued' | 'running'> = 'succeeded'): void {
    for (const run of this.runs.values()) if (run.taskId === taskId && (run.status === 'queued' || run.status === 'running')) this.runs.set(run.runId, { ...run, status, updatedAt: this.options.now?.() ?? Date.now() });
    for (const id of this.inFlight.keys()) this.release(id, taskId);
  }

  getRun(plugin: string, triggerId: string, runId: string): TriggerRun | undefined {
    const run = this.runs.get(runId);
    if (run && run.plugin === plugin && run.triggerId === triggerId) {
      // 工作项没有结算通知，每次查询按工作项当前状态给出；已取消的保持取消。
      if (run.workItemId) return run.status === 'cancelled' ? { ...run } : { ...run, status: this.entryStatus(`${WORK_ENTRY}${run.workItemId}`) ?? run.status };
      // 任务被外部取消、会话停止或恢复时结算都不发结算通知：按任务实时状态补结算，回写后参与过期清理并释放名额。
      if (run.taskId && (run.status === 'queued' || run.status === 'running')) {
        const live = this.options.taskStatus?.(run.taskId);
        if (live === 'succeeded' || live === 'failed' || live === 'cancelled') {
          this.settled(run.taskId, live);
          return { ...this.runs.get(runId)! };
        }
      }
      return { ...run };
    }
    const binding = this.options.runBindings?.listTaskBindings().find(item => {
      if (!item.subscriptionId.startsWith('dutydeck-plugin-trigger:')) return false;
      if (item.createdAt + DEDUPE_TTL_MS <= (this.options.now?.() ?? Date.now())) {
        this.options.runBindings?.unbindTask(item.taskId);
        return false;
      }
      const decoded = decodeRunBinding(item.subscriptionId);
      return decoded?.runId === runId && decoded.plugin === plugin && decoded.triggerId === triggerId;
    });
    if (!binding) return undefined;
    const decoded = decodeRunBinding(binding.subscriptionId);
    if (!decoded) return undefined;
    const status = this.entryStatus(binding.taskId) ?? 'unknown';
    return { runId, plugin, triggerId, sessionId: decoded.sessionId, ...this.entryRef(binding.taskId), status, createdAt: binding.createdAt, updatedAt: binding.createdAt };
  }

  async cancelRun(plugin: string, triggerId: string, runId: string): Promise<TriggerRun | undefined> {
    const run = this.getRun(plugin, triggerId, runId);
    if (!run || !['queued', 'running'].includes(run.status)) return run;
    if (run.workItemId) {
      // 工作项只在等确认、还没执行任何步骤时可取消；已开始的保持 running。
      if (this.entryStatus(`${WORK_ENTRY}${run.workItemId}`) !== 'queued' || !this.options.cancelWork || !await this.options.cancelWork(run.sessionId!, run.workItemId)) return this.getRun(plugin, triggerId, runId);
      const next = { ...run, status: 'cancelled' as const, updatedAt: this.options.now?.() ?? Date.now() };
      this.runs.set(runId, next);
      for (const id of this.inFlight.keys()) this.release(id, `${WORK_ENTRY}${run.workItemId}`);
      return next;
    }
    if (!run.taskId || !this.options.cancel) return run;
    const cancelled = await this.options.cancel(run.sessionId!, run.taskId);
    if (!cancelled) return this.getRun(plugin, triggerId, runId);
    const next = { ...run, status: 'cancelled' as const, updatedAt: this.options.now?.() ?? Date.now() };
    this.runs.set(runId, next);
    for (const id of this.inFlight.keys()) this.release(id, run.taskId);
    return next;
  }

  authorize(plugin: string, triggerId: string, headers: TriggerRequest['headers']): boolean {
    const trigger = this.options.lookup(plugin, triggerId);
    const secret = this.options.token(plugin, triggerId);
    const now = this.options.now?.() ?? Date.now();
    if (!trigger || !secret || !verifyTriggerAuth(trigger.auth, secret, { rawBody: Buffer.alloc(0), headers }, now)) return false;
    if (trigger.auth.type === 'hmac-sha256') {
      const nonce = header(headers, trigger.auth.nonceHeader)?.trim();
      if (!nonce) return false;
      const id = `${plugin}/${triggerId}`;
      return this.dedupe.claim(`plugin-trigger-nonce:${id}:${nonce}`, now, hmacNonceExpiresAt(trigger.auth, headers, now));
    }
    return true;
  }

  private entryRef(entry: string): { taskId: string } | { workItemId: string } {
    return entry.startsWith(WORK_ENTRY) ? { workItemId: entry.slice(WORK_ENTRY.length) } : { taskId: entry };
  }

  private entryStatus(entry: string): TriggerRunStatus | undefined {
    if (!entry.startsWith(WORK_ENTRY)) return this.options.taskStatus?.(entry);
    if (!this.options.workStatus) return undefined;
    return workRunStatus(this.options.workStatus(entry.slice(WORK_ENTRY.length)));
  }

  /** 是否仍占并发名额。工作项被阻塞（结果待核对）时也占着。 */
  private entryHolds(entry: string, known?: TriggerRunStatus): boolean {
    if (!entry.startsWith(WORK_ENTRY)) return known ? known === 'queued' || known === 'running' : !this.options.isSettled?.(entry);
    const status = this.options.workStatus?.(entry.slice(WORK_ENTRY.length));
    return status !== undefined && !['completed', 'failed', 'cancelled'].includes(status);
  }

  private release(id: string, entry: string) {
    const tasks = this.inFlight.get(id);
    if (tasks?.delete(entry) && !tasks.size) this.inFlight.delete(id);
  }

  inFlightCount(plugin: string, triggerId: string): number { return this.inFlight.get(`${plugin}/${triggerId}`)?.size ?? 0; }

  private findDurableRunByDigest(plugin: string, triggerId: string, digest: string): { runId: string } | undefined {
    for (const binding of this.options.runBindings?.listTaskBindings() ?? []) {
      if (!binding.subscriptionId.startsWith('dutydeck-plugin-trigger:')) continue;
      if (binding.createdAt + DEDUPE_TTL_MS <= (this.options.now?.() ?? Date.now())) { this.options.runBindings?.unbindTask(binding.taskId); continue; }
      const decoded = decodeRunBinding(binding.subscriptionId);
      if (decoded?.plugin === plugin && decoded.triggerId === triggerId && decoded.dedupeDigest === digest) return { runId: decoded.runId };
    }
    return undefined;
  }
}

function encodeRunBinding(binding: { runId: string; plugin: string; triggerId: string; sessionId: string; dedupeDigest: string }): string {
  return `dutydeck-plugin-trigger:${Buffer.from(JSON.stringify(binding), 'utf8').toString('base64url')}`;
}

function decodeRunBinding(value: string): { runId: string; plugin: string; triggerId: string; sessionId: string; dedupeDigest?: string } | undefined {
  if (!value.startsWith('dutydeck-plugin-trigger:')) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice('dutydeck-plugin-trigger:'.length), 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof parsed.runId === 'string' && typeof parsed.plugin === 'string' && typeof parsed.triggerId === 'string' && typeof parsed.sessionId === 'string'
      ? { runId: parsed.runId, plugin: parsed.plugin, triggerId: parsed.triggerId, sessionId: parsed.sessionId, ...(typeof parsed.dedupeDigest === 'string' ? { dedupeDigest: parsed.dedupeDigest } : {}) } : undefined;
  } catch { return undefined; }
}
