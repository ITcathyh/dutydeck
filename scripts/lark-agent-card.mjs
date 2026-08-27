const statePresentation = {
  running: { icon: '🏗️', title: '正在执行', template: 'violet' },
  completed: { icon: '✅', title: '已完成', template: 'green' },
  failed: { icon: '❌', title: '执行失败', template: 'red' }
};

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const elapsedLabel = seconds => {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
};

export function buildAgentCard({
  agentName = 'Dockmux',
  state = 'running',
  taskName,
  taskId,
  elapsedSeconds = 0,
  markdown
}) {
  const presentation = statePresentation[state];
  if (!presentation) throw new Error(`Unsupported card state: ${state}`);
  if (!taskName?.trim()) throw new Error('taskName is required');
  if (!String(taskId ?? '').trim()) throw new Error('taskId is required');

  const bodyContent = markdown !== undefined ? String(markdown) : state === 'completed' ? '任务已完成。' : '';
  const actionButton = state === 'running' ? {
    tag: 'button', text: { tag: 'plain_text', content: '中断' }, type: 'danger', size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'interrupt', task_id: String(taskId).trim() } }],
    margin: '0px', element_id: 'interrupt'
  } : state === 'failed' ? {
    tag: 'button', text: { tag: 'plain_text', content: '重试' }, type: 'primary', size: 'small',
    behaviors: [{ type: 'callback', value: { action: 'retry', task_id: String(taskId).trim() } }],
    margin: '0px', element_id: 'retry'
  } : undefined;
  const columns = [
    {
      tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
      elements: [{ tag: 'markdown', content: `<font color='grey'>任务 #${String(taskId).trim()} · 已用时 ${elapsedLabel(elapsedSeconds)}</font>`, text_size: 'notation', margin: '0px' }]
    }
  ];
  if (actionButton) columns.push({ tag: 'column', width: '80px', vertical_align: 'center', elements: [actionButton] });
  const footer = {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns
  };

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `${presentation.icon} ${String(agentName).trim() || 'Dockmux'} ${presentation.title}` },
      subtitle: { tag: 'plain_text', content: taskName.trim() },
      template: presentation.template,
      padding: '12px'
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        {
          tag: 'markdown',
          content: bodyContent,
          text_align: 'left',
          text_size: 'normal_v2',
          margin: '0px'
        },
        { tag: 'hr', margin: '12px 0px 8px 0px' },
        footer
      ]
    }
  };
}

export class LarkCardClient {
  constructor({ appId, appSecret, baseUrl = 'https://open.feishu.cn' }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = undefined;
    this.tokenExpiresAt = 0;
  }

  static fromEnv() {
    return new LarkCardClient({
      appId: required('LARK_APP_ID'),
      appSecret: required('LARK_APP_SECRET'),
      baseUrl: process.env.LARK_OPEN_API_BASE_URL?.trim() || 'https://open.feishu.cn'
    });
  }

  async request(path, { method = 'POST', body, token = true } = {}) {
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (token) headers.authorization = `Bearer ${await this.tenantToken()}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 0) {
      const message = payload.msg || payload.message || `${response.status} ${response.statusText}`;
      throw new Error(`Lark OpenAPI request failed: ${message} (code: ${payload.code ?? 'HTTP_ERROR'})`);
    }
    return payload;
  }

  async tenantToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const payload = await this.request('/open-apis/auth/v3/tenant_access_token/internal/', {
      token: false,
      body: { app_id: this.appId, app_secret: this.appSecret }
    });
    this.token = payload.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expire ?? 7200) - 60) * 1000;
    return this.token;
  }

  async sendCard({ receiveIdType = 'email', receiveId, card }) {
    const payload = await this.request(`/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`, {
      body: { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) }
    });
    return { messageId: payload.data?.message_id, chatId: payload.data?.chat_id };
  }

  async replyCard(messageId, card) {
    const payload = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      body: { msg_type: 'interactive', content: JSON.stringify(card) }
    });
    return { messageId: payload.data?.message_id, chatId: payload.data?.chat_id };
  }

  async updateCard(messageId, card) {
    await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: { content: JSON.stringify(card) }
    });
  }
}

export class AgentCardTurn {
  constructor(client, {
    receiveId,
    receiveIdType = 'email',
    agentName = 'Dockmux',
    taskName,
    taskId,
    refreshIntervalMs = 5000,
    now = () => Date.now()
  }) {
    this.client = client;
    this.receiveId = receiveId;
    this.receiveIdType = receiveIdType;
    this.agentName = agentName;
    this.taskName = taskName;
    this.taskId = taskId;
    this.refreshIntervalMs = refreshIntervalMs;
    this.now = now;
    this.startedAt = now();
    this.state = 'running';
    this.markdown = undefined;
    this.dirty = true;
    this.flushing = undefined;
  }

  card() {
    return buildAgentCard({
      agentName: this.agentName,
      state: this.state,
      taskName: this.taskName,
      taskId: this.taskId,
      elapsedSeconds: (this.now() - this.startedAt) / 1000,
      markdown: this.markdown
    });
  }

  async start(markdown) {
    if (this.messageId) throw new Error('This turn already has a card');
    if (markdown !== undefined) this.markdown = String(markdown);
    const result = await this.client.sendCard({ receiveIdType: this.receiveIdType, receiveId: this.receiveId, card: this.card() });
    this.messageId = result.messageId;
    this.chatId = result.chatId;
    this.dirty = false;
    this.timer = setInterval(() => { void this.flush().catch(error => { this.lastError = error; }); }, this.refreshIntervalMs);
    this.timer.unref?.();
    return result;
  }

  setMarkdown(markdown) {
    if (this.state !== 'running') return;
    this.markdown = String(markdown ?? '');
    this.dirty = true;
  }

  async flush() {
    if (!this.messageId) return;
    if (this.flushing) {
      await this.flushing;
      if (this.dirty) return this.flush();
      return;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.flushing = this.client.updateCard(this.messageId, this.card())
      .catch(error => { this.dirty = true; throw error; })
      .finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  async complete(markdown) {
    this.state = 'completed';
    this.markdown = String(markdown ?? '');
    this.dirty = true;
    this.stopTimer();
    await this.flush();
  }

  async fail(description) {
    this.state = 'failed';
    if (description !== undefined) this.markdown = String(description);
    this.dirty = true;
    this.stopTimer();
    await this.flush();
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async close() {
    this.stopTimer();
    await this.flush();
    if (this.lastError) throw this.lastError;
  }
}
