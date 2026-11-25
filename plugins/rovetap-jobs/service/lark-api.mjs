// Minimal Lark/Feishu OpenAPI client used to VERIFY source material and to send
// thread receipts. Dependency-free fetch so the packaged plugin needs no install.
//
// It implements the same endpoints Dutydeck itself uses:
//   POST /open-apis/auth/v3/tenant_access_token/internal/
//   GET  /open-apis/im/v1/messages/:id           (items incl. merge_forward children)
//   GET  /open-apis/im/v1/messages                (container thread|chat history)
//   POST /open-apis/im/v1/messages/:id/reply     (durable uuid idempotency)
//
// `baseUrl` is configurable so isolated e2e can point at a fake Lark server.

import { addAbortListener } from 'node:events';

export class LarkApiError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'LarkApiError';
    this.kind = kind;
    Object.assign(this, details);
  }
}

// Authoritative Feishu classifications, kept in sync with
// apps/server/src/lark/api-gate.ts (the plugin cannot import the TS gate).
// 230020 消息频控、99991400 网关频控/后端抖动：按瞬时频控退避重试。
const RATE_LIMIT_CODES = new Set([230020, 99991400]);
// 230049：同一 UUID 的消息正在发送；原请求可能已成功，只能按未知结果原样重发。
const MESSAGE_SENDING_CODE = 230049;
const TOKEN_INVALID_CODES = new Set([99991663, 99991661, 99991668]);
const NOT_FOUND_CODES = new Set([230002, 230001]);
// 回复接口明确表示锚点不可再回复（已撤回/话题不存在/不可见/类型不支持/
// 230072 合并消息等具体锚点不支持话题回复、230111 消息即将自毁）。只有这类
// 确定性拒绝才允许把回执在同话题内改向到原 /job 消息。
export const REPLY_TARGET_UNAVAILABLE_CODES = new Set([230011, 230019, 230050, 230054, 230072, 230111]);
// 230071 applies to the entire chat and cannot be resolved with another anchor.
const THREAD_UNSUPPORTED_CODE = 230071;
const SEND_DEADLINE_REASON = '飞书回执已超过首次发送起 1 小时的绝对期限，截止后不再发送';

function deadlineReached(deadlineAt) {
  return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

// The token request may have been started by a material read with a different
// deadline. Bound each caller's wait without cancelling the shared request.
async function waitForToken(flight, signal) {
  let listener;
  try {
    const aborted = new Promise((_resolve, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    });
    return await Promise.race([flight, aborted]);
  } finally {
    listener?.[Symbol.dispose]();
  }
}

function sleepMs(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** Integer `Retry-After` seconds -> ms; other shapes are left to callers. */
function retryAfterHintMs(headers) {
  const value = headers?.get ? headers.get('retry-after') : headers?.['retry-after'];
  if (value !== null && value !== undefined && /^\s*\d+\s*$/.test(String(value))) {
    return Math.min(30_000, Math.max(0, Number(value) * 1000));
  }
  return undefined;
}

export class LarkApiClient {
  constructor(config, fetcher = globalThis.fetch) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 8000;
    // Bounded in-client backoff for 429 / frequency business codes. Upper layers
    // still durably retry when these attempts are exhausted.
    this.rateLimitRetries = config.rateLimitRetries ?? 2;
    this.retryBaseMs = config.retryBaseMs ?? 300;
    this.fetch = fetcher;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenFlight = null;
  }

  async tenantToken(signal, deadlineAt) {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (!this.tokenFlight) {
      this.tokenFlight = this.#fetchToken(signal, deadlineAt).finally(() => { this.tokenFlight = null; });
    }
    return this.tokenFlight;
  }

  async #fetchToken(externalSignal, deadlineAt) {
    if (!this.appSecret) throw new LarkApiError('auth', '缺少 lark.appSecret/appSecretFile，无法读取飞书材料');
    const payload = await this.request('/open-apis/auth/v3/tenant_access_token/internal/', {
      method: 'POST', token: false, body: { app_id: this.appId, app_secret: this.appSecret }, externalSignal, deadlineAt,
    });
    const token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!token) throw new LarkApiError('auth', '飞书未返回 tenant_access_token');
    this.token = token;
    const expire = Number(payload.expire ?? payload.data?.expire ?? 7200);
    this.tokenExpiresAt = Date.now() + Math.max(60, expire - 60) * 1000;
    return token;
  }

  /**
   * Core JSON request. One shared path for tenant token, material reads and
   * receipts. Rate-limit responses back off and retry in-client; an invalid
   * token forces one refresh. Transport/5xx/230049 outcomes are thrown for the
   * durable upper-layer retry/unknown machinery instead.
   */
  async request(path, options = {}) {
    let tokenRetried = false;
    let rateAttempts = 0;
    for (;;) {
      if (deadlineReached(options.deadlineAt)) throw new LarkApiError('deadline', SEND_DEADLINE_REASON);
      try {
        return await this.#attempt(path, options);
      } catch (error) {
        if (error?.tokenInvalid === true && options.token !== false && !tokenRetried) {
          tokenRetried = true;
          this.token = null;
          this.tokenExpiresAt = 0;
          continue;
        }
        if (error?.kind === 'rate_limited' && rateAttempts < this.rateLimitRetries) {
          rateAttempts += 1;
          const backoff = error.retryAfterMs
            ?? Math.min(8_000, this.retryBaseMs * 2 ** (rateAttempts - 1));
          const waitMs = options.deadlineAt === undefined
            ? backoff
            : Math.max(0, Math.min(backoff, options.deadlineAt - Date.now()));
          await sleepMs(waitMs, options.externalSignal);
          continue;
        }
        throw error;
      }
    }
  }

  /** One full attempt: the timeout covers fetch AND reading the whole body. */
  async #attempt(path, options) {
    if (deadlineReached(options.deadlineAt)) throw new LarkApiError('deadline', SEND_DEADLINE_REASON);
    const controller = new AbortController();
    let timedOut = false;
    // Armed until the body is fully consumed: response.text() can stall or fail
    // mid-stream after headers have already arrived. Clamp the per-attempt timeout
    // to the absolute delivery deadline so a near-expiry send cannot linger past it.
    const delay = options.deadlineAt === undefined
      ? this.timeoutMs
      : Math.max(1, Math.min(this.timeoutMs, options.deadlineAt - Date.now()));
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(deadlineReached(options.deadlineAt)
        ? new LarkApiError('deadline', SEND_DEADLINE_REASON)
        : new LarkApiError('network', '飞书请求失败：timeout'));
    }, delay);
    const onExternalAbort = () => controller.abort(options.externalSignal?.reason);
    options.externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
    if (options.externalSignal?.aborted) onExternalAbort();
    try {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (options.token !== false) {
        const flight = this.tenantToken(options.externalSignal, options.deadlineAt);
        headers.Authorization = `Bearer ${await waitForToken(flight, controller.signal)}`;
      }
      // Token acquisition and backoff both count against this actual send.
      if (deadlineReached(options.deadlineAt)) throw new LarkApiError('deadline', SEND_DEADLINE_REASON);
      let response;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          method: options.method ?? 'GET',
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        throw new LarkApiError('network', `飞书请求失败：${timedOut || error?.name === 'AbortError' ? 'timeout' : 'network'}`);
      }

      let raw;
      try {
        raw = await response.text();
      } catch (error) {
        // Headers arrived but the body never completed (stall / mid-stream reset):
        // the outcome is uncertain for writes, retryable for reads.
        throw new LarkApiError('network', `飞书响应正文读取失败：${timedOut || error?.name === 'AbortError' ? 'timeout' : 'network'}`);
      }

      let payload = null;
      if (raw) {
        try { payload = JSON.parse(raw); } catch { payload = null; }
      }
      const businessCode = typeof payload?.code === 'number' ? payload.code : undefined;
      if (businessCode !== undefined && businessCode !== 0) {
        throw this.#businessError(response.status, payload, businessCode, retryAfterHintMs(response.headers));
      }
      if (!response.ok) {
        throw this.#httpError(response.status, payload, retryAfterHintMs(response.headers));
      }
      return payload ?? {};
    } finally {
      clearTimeout(timer);
      options.externalSignal?.removeEventListener?.('abort', onExternalAbort);
    }
  }

  #businessError(httpStatus, payload, code, retryAfterMs) {
    const details = { httpStatus, payload, larkCode: code, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    if (TOKEN_INVALID_CODES.has(code)) {
      // Caller retries once after forcing a fresh tenant token.
      return new LarkApiError('auth', `飞书 token 失效 (${code})`, { ...details, tokenInvalid: true });
    }
    if (RATE_LIMIT_CODES.has(code)) {
      return new LarkApiError('rate_limited', `飞书频控 ${code}: ${payload.msg ?? ''}`, details);
    }
    if (code === MESSAGE_SENDING_CODE) {
      return new LarkApiError('sending', `飞书同 UUID 消息正在发送 (${code})`, details);
    }
    if (NOT_FOUND_CODES.has(code)) {
      return new LarkApiError('not_found', `飞书业务错误 ${code}: ${payload.msg ?? ''}`, details);
    }
    if (code === 99991672) {
      return new LarkApiError('forbidden', `飞书业务错误 ${code}: ${payload.msg ?? ''}`, details);
    }
    if (code === THREAD_UNSUPPORTED_CODE) {
      return new LarkApiError('bad_request', `飞书群不支持话题回复 (${code})`, details);
    }
    if (REPLY_TARGET_UNAVAILABLE_CODES.has(code)) {
      return new LarkApiError('bad_request', `飞书回复目标不可回复 (${code})`, { ...details, replyTargetUnavailable: true });
    }
    // Unrecognised business code behind a transport-y HTTP status keeps the
    // retryable/unknown classification instead of becoming a hard rejection.
    return this.#httpError(httpStatus, payload, retryAfterMs, code);
  }

  #httpError(status, payload, retryAfterMs, businessCode) {
    const details = { httpStatus: status, payload, ...(businessCode !== undefined ? { larkCode: businessCode } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    if (status === 429) return new LarkApiError('rate_limited', `飞书 HTTP 429`, details);
    if (status === 401 || status === 403) return new LarkApiError('forbidden', `飞书 HTTP ${status}`, details);
    if (status === 404) return new LarkApiError('not_found', `飞书 HTTP ${status}`, details);
    if (status >= 500) return new LarkApiError('server', `飞书 HTTP ${status}`, details);
    return new LarkApiError('bad_request', `飞书 HTTP ${status}`, details);
  }

  /** GET one message detail; for merge_forward the items include children. */
  async getMessageItems(messageId) {
    const q = 'user_id_type=open_id&card_msg_content_type=raw_card_content';
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}?${q}`);
    const rawItems = Array.isArray(payload.data?.items) ? payload.data.items
      : payload.data?.message ? [payload.data.message] : [];
    return rawItems.map(normalizeMessage);
  }

  async getMessage(messageId) {
    const items = await this.getMessageItems(messageId);
    return items[0] ?? null;
  }

  /**
   * List messages in a thread (`omt_…`) or chat (`oc_…`). Returns newest-first
   * by default; callers reverse when they need chronological order.
   */
  async listMessages({ containerIdType, containerId, pageSize = 30, pageToken } = {}) {
    const params = new URLSearchParams({
      container_id_type: containerIdType,
      container_id: containerId,
      page_size: String(Math.min(50, Math.max(1, pageSize))),
      sort_type: 'ByCreateTimeDesc',
      only_thread_root_messages: 'false',
      with_sender_name: 'true',
    });
    if (pageToken) params.set('page_token', pageToken);
    const payload = await this.request(`/open-apis/im/v1/messages?${params.toString()}`);
    const items = Array.isArray(payload.data?.items) ? payload.data.items.map(normalizeMessage) : [];
    return { items, pageToken: payload.data?.page_token ?? null, hasMore: Boolean(payload.data?.has_more) };
  }

  /**
   * Reply in the original thread. `uuid` is a durable idempotency key owned by
   * the caller and reused across retries. Returns `{messageId}` or classifies
   * uncertainty so the caller can protect the outbound record.
   */
  async replyText({ replyToMessageId, text, uuid, inThread = true, deadlineAt }) {
    try {
      const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
        method: 'POST',
        deadlineAt,
        body: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          uuid,
          ...(inThread ? { reply_in_thread: true } : {}),
        },
      });
      const messageId = payload.data?.message_id;
      if (!messageId) return { outcome: 'unknown', reason: 'missing_message_id' };
      return { outcome: 'sent', messageId };
    } catch (error) {
      // These may have reached Feishu (or were rejected only by the rate gate):
      // the worker protects the outbound record and retries the SAME uuid.
      // 'deadline' means the 1h absolute window ran out around token/backoff/POST;
      // an in-flight request might still have landed, so it stays unknown.
      const unknownKinds = new Set(['network', 'server', 'auth', 'rate_limited', 'sending', 'deadline']);
      if (error instanceof LarkApiError && unknownKinds.has(error.kind)) {
        return {
          outcome: 'unknown',
          reason: `${error.kind}:${error.message}`,
          code: error.larkCode ?? null,
          inFlight: error.kind === 'sending',
        };
      }
      return {
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        code: error?.larkCode ?? null,
        // Only a definitive platform “this anchor cannot be replied to” allows
        // the worker to redirect the receipt to the original /job message.
        replyTargetUnavailable: error?.replyTargetUnavailable === true,
      };
    }
  }
}

/** Normalize both inbound-event-ish and OpenAPI item shapes to one shape. */
export function normalizeMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const bodyContent = m.body && typeof m.body === 'object' ? m.body.content : undefined;
  return {
    messageId: m.message_id ?? m.messageId ?? null,
    chatId: m.chat_id ?? m.chatId ?? null,
    threadId: m.thread_id ?? m.threadId ?? null,
    rootId: m.root_id ?? m.rootId ?? null,
    parentId: m.parent_id ?? m.parentId ?? null,
    upperMessageId: m.upper_message_id ?? m.upperMessageId ?? null,
    messageType: m.msg_type ?? m.message_type ?? m.messageType ?? 'text',
    createTime: m.create_time ?? m.createTime ?? null,
    deleted: m.deleted === true,
    sender: m.sender ?? null,
    content: typeof bodyContent === 'string' ? bodyContent
      : typeof m.content === 'string' ? m.content
      : (m.content && typeof m.content === 'object' ? JSON.stringify(m.content) : ''),
    raw: m,
  };
}
