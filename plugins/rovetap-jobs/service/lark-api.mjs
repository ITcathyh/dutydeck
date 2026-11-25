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

export class LarkApiError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'LarkApiError';
    this.kind = kind; // auth | not_found | forbidden | bad_request | server | network
    Object.assign(this, details);
  }
}

export class LarkApiClient {
  constructor(config, fetcher = globalThis.fetch) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.fetch = fetcher;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenFlight = null;
  }

  async tenantToken(signal) {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (!this.tokenFlight) {
      this.tokenFlight = this.#fetchToken(signal).finally(() => { this.tokenFlight = null; });
    }
    return this.tokenFlight;
  }

  async #fetchToken(externalSignal) {
    if (!this.appSecret) throw new LarkApiError('auth', '缺少 lark.appSecret/appSecretFile，无法读取飞书材料');
    const payload = await this.request('/open-apis/auth/v3/tenant_access_token/internal/', {
      method: 'POST', token: false, body: { app_id: this.appId, app_secret: this.appSecret }, externalSignal,
    });
    const token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!token) throw new LarkApiError('auth', '飞书未返回 tenant_access_token');
    this.token = token;
    const expire = Number(payload.expire ?? payload.data?.expire ?? 7200);
    this.tokenExpiresAt = Date.now() + Math.max(60, expire - 60) * 1000;
    return token;
  }

  /** Core JSON request. `token:false` skips the bearer dance. */
  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort(options.externalSignal?.reason);
    options.externalSignal?.addEventListener?.('abort', onAbort, { once: true });
    let response;
    try {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (options.token !== false) headers.Authorization = `Bearer ${await this.tenantToken(options.externalSignal)}`;
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      options.externalSignal?.removeEventListener?.('abort', onAbort);
      throw new LarkApiError('network', `飞书请求失败：${error?.name === 'AbortError' ? 'timeout' : 'network'}`);
    }
    clearTimeout(timer);
    options.externalSignal?.removeEventListener?.('abort', onAbort);

    let payload = null;
    const raw = await response.text();
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = null; }
    }
    if (!response.ok) {
      const kind = response.status === 401 || response.status === 403 ? 'forbidden'
        : response.status === 404 ? 'not_found'
        : response.status >= 500 ? 'server' : 'bad_request';
      throw new LarkApiError(kind, `飞书 HTTP ${response.status}`, { httpStatus: response.status, payload });
    }
    // Lark business code: 0 success; token errors imply a refresh is needed once.
    if (payload && typeof payload.code === 'number' && payload.code !== 0) {
      if (payload.code === 99991663 || payload.code === 99991661 || payload.code === 99991668) {
        this.token = null;
        throw new LarkApiError('auth', `飞书 token 失效 (${payload.code})`, { larkCode: payload.code });
      }
      const kind = [230002, 230020, 230001].includes(payload.code) ? 'not_found'
        : payload.code === 99991672 ? 'forbidden' : 'bad_request';
      throw new LarkApiError(kind, `飞书业务错误 ${payload.code}: ${payload.msg ?? ''}`, { larkCode: payload.code });
    }
    return payload ?? {};
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
  async replyText({ replyToMessageId, text, uuid, inThread = true }) {
    try {
      const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
        method: 'POST',
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
      if (error instanceof LarkApiError && (error.kind === 'network' || error.kind === 'server' || error.kind === 'auth')) {
        return { outcome: 'unknown', reason: `${error.kind}:${error.message}` };
      }
      return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) };
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
    sender: m.sender ?? null,
    content: typeof bodyContent === 'string' ? bodyContent
      : typeof m.content === 'string' ? m.content
      : (m.content && typeof m.content === 'object' ? JSON.stringify(m.content) : ''),
    raw: m,
  };
}
