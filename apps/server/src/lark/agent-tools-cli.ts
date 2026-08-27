import type { AgentGroupCliOptions } from '../cli-program.js';

interface GroupToolErrorBody {
  code: string;
  message: string;
  instruction?: string;
  authorizationUrl?: string;
  requiredScopes?: string[];
  [key: string]: unknown;
}

export class AgentGroupToolCliError extends Error {
  constructor(public readonly error: GroupToolErrorBody, public readonly statusCode?: number) {
    super(error.message);
    this.name = 'AgentGroupToolCliError';
  }
}

interface GroupToolClientOptions {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
}

class AgentGroupToolHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: GroupToolClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (env.dockmux_group_tools_url ?? env.DOCKMUX_GROUP_TOOLS_URL)?.trim().replace(/\/$/, '') ?? '';
    this.token = (env.dockmux_group_tools_token ?? env.DOCKMUX_GROUP_TOOLS_TOKEN)?.trim() ?? '';
    this.fetcher = options.fetcher ?? globalThis.fetch;
    if (!this.baseUrl || !this.token) {
      throw new AgentGroupToolCliError({
        code: 'GROUP_TOOL_CONTEXT_REQUIRED',
        message: '群协作工具只能由 Dockmux 飞书群会话内的 Agent 调用；当前进程没有会话 capability。'
      });
    }
  }

  async request(path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.token}`);
      if (init.body !== undefined) headers.set('content-type', 'application/json; charset=utf-8');
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers
      });
    } catch (error) {
      throw new AgentGroupToolCliError({
        code: 'GROUP_TOOL_UNAVAILABLE',
        message: `无法连接 Dockmux 群协作服务：${error instanceof Error ? error.message : String(error)}`
      });
    }
    const payload = await response.json().catch(() => ({})) as { error?: GroupToolErrorBody } & Record<string, unknown>;
    if (!response.ok) {
      throw new AgentGroupToolCliError(payload.error ?? {
        code: 'GROUP_TOOL_REQUEST_FAILED',
        message: `Dockmux 群协作服务返回 HTTP ${response.status}`
      }, response.status);
    }
    return payload;
  }
}

const queryPath = (path: string, options: AgentGroupCliOptions) => {
  const query = new URLSearchParams();
  if (options.after) query.set('after', options.after);
  if (options.limit) query.set('limit', options.limit);
  if (options.timeoutMs) query.set('timeoutMs', options.timeoutMs);
  return query.size ? `${path}?${query}` : path;
};

export function runGroupSelf(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/self');
}

export function runGroupPeers(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/peers');
}

export function runGroupMembers(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/members');
}

export function runGroupBots(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/bots');
}

export function runGroupMessages(cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request(queryPath('/messages', cliOptions));
}

export function runGroupMessage(messageId: string, options: GroupToolClientOptions = {}) {
  const query = new URLSearchParams({ messageId });
  return new AgentGroupToolHttpClient(options).request(`/message?${query}`);
}

export function runGroupWait(cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request(queryPath('/wait', cliOptions));
}

export function runGroupSend(content: string, cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).request('/send', {
    method: 'POST',
    body: JSON.stringify({
      content,
      ...(cliOptions.to ? { to: cliOptions.to } : {}),
      ...(cliOptions.replyTo ? { replyTo: cliOptions.replyTo } : {}),
      ...(cliOptions.inThread ? { inThread: true } : {}),
      ...(cliOptions.idempotencyKey ? { idempotencyKey: cliOptions.idempotencyKey } : {})
    })
  });
}
