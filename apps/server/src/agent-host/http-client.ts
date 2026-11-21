import { sleep } from '../daemon/time.js';
import { retryWhileRefused } from '@dutydeck/relay';
import { getTool, toolPath, toolRequest, type Endpoint, type Options } from './tool-table.js';

export interface GroupToolErrorBody {
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

export interface GroupToolClientOptions {
  turn?: string;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class AgentGroupToolHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly turn?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GroupToolClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (env.dutydeck_group_tools_url ?? env.DUTYDECK_GROUP_TOOLS_URL)?.trim().replace(/\/$/, '') ?? '';
    this.token = (env.dutydeck_group_tools_token ?? env.DUTYDECK_GROUP_TOOLS_TOKEN)?.trim() ?? '';
    this.turn = options.turn;
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.sleep = options.sleep ?? sleep;
    if (!this.baseUrl || !this.token) {
      throw new AgentGroupToolCliError({
        code: 'GROUP_TOOL_CONTEXT_REQUIRED',
        message: '群协作工具只能由 Dutydeck 飞书群会话内的 Agent 调用；当前进程没有会话 capability。'
      });
    }
  }

  async callLegacy(name: string, args: unknown[] = [], options: Options = {}, search?: string) {
    const tool = getTool(name);
    const request = await toolRequest(tool, args, options, search, tool.legacyBody ?? tool.body);
    const body = tool.bodyTurn?.(options) ? { ...request.body, turn: options.turn } : request.body;
    return this.request(request.path, { method: request.method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  call(endpoint: Endpoint, args: unknown[] = [], init: RequestInit = {}) {
    return this.request(toolPath(endpoint, args), { ...init, method: endpoint.method });
  }

  async request(path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.token}`);
      if (this.turn && !headers.has('x-dutydeck-work-turn')) headers.set('x-dutydeck-work-turn', this.turn);
      if (init.body !== undefined) headers.set('content-type', 'application/json; charset=utf-8');
      response = await retryWhileRefused(() => this.fetcher(`${this.baseUrl}${path}`, { ...init, headers }), { sleep: this.sleep });
    } catch (error) {
      throw new AgentGroupToolCliError({
        code: 'GROUP_TOOL_UNAVAILABLE',
        message: `无法连接 Dutydeck 群协作服务：${error instanceof Error ? error.message : String(error)}`
      });
    }
    const payload = await response.json().catch(() => ({})) as { error?: GroupToolErrorBody } & Record<string, unknown>;
    if (!response.ok) {
      throw new AgentGroupToolCliError(payload.error ?? {
        code: 'GROUP_TOOL_REQUEST_FAILED',
        message: `Dutydeck 群协作服务返回 HTTP ${response.status}`
      }, response.status);
    }
    return payload;
  }
}
