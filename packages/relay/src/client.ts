import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { relayAskExitCodes } from './cli-contract.js';
import { relayTokenEnvKey, relayUrlEnvKey } from './capability.js';

/** CLI 侧错误：携带要用的退出码，由 cli.ts 顶层统一 exit */
export class RelayCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'RelayCliError';
  }
}

export interface RelayClientOptions {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof globalThis.fetch;
}

interface RelayErrorBody { code?: string; message?: string }

/** 未指定等待上限的请求（send/report/permission 等短请求）沿用旧的 300 秒。 */
const defaultRequestTimeoutMs = 300_000;

/**
 * 默认传输走 node:http 而不是全局 fetch：Node 内置 fetch 最多等 300 秒响应头，
 * `session ask --timeout 600` 这类长轮询会在第 300 秒被客户端掐断。
 * 这里只按调用方给的 signal 截止。
 */
const nodeHttpFetch = ((input: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
  const url = new URL(input);
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: init.method, headers: init.headers as Record<string, string>, signal: init.signal ?? undefined
  }, response => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', () => {
      const status = response.statusCode ?? 502;
      resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status }));
    });
  });
  request.on('error', reject);
  request.end(init.body as string | undefined);
})) as typeof globalThis.fetch;

/**
 * 子进程 → 服务端的 HTTP 客户端。
 *
 * 与 `AgentGroupToolHttpClient` 同形（Bearer + 结构化错误解包），但两点不同：
 *  - baseUrl / token 取自 relay 的 env 键，且**任何来源的会话**都会被注入
 *  - 错误映射到 relay 的退出码契约（2 用法 / 3 不可用 / 124 超时）
 */
export class RelayHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: RelayClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = (env[relayUrlEnvKey] ?? env.DUTYDECK_RELAY_URL)?.trim().replace(/\/$/, '') ?? '';
    this.token = (env[relayTokenEnvKey] ?? env.DUTYDECK_RELAY_TOKEN)?.trim() ?? '';
    this.fetcher = options.fetcher ?? nodeHttpFetch;
    if (!this.baseUrl || !this.token) {
      throw new RelayCliError(
        '回传命令只能在 Dutydeck 会话内的 Agent 进程中调用；当前进程没有会话凭证。',
        relayAskExitCodes.usage,
        'RELAY_CONTEXT_REQUIRED'
      );
    }
  }

  /** `timeoutMs` 是本次请求最多等多久；长轮询要比服务端的等待期限多留余量。 */
  async post(path: string, body: unknown, timeoutMs = defaultRequestTimeoutMs): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new RelayCliError(
        `无法连接 Dutydeck 回传服务：${error instanceof Error ? error.message : String(error)}`,
        relayAskExitCodes.unavailable,
        'RELAY_UNAVAILABLE'
      );
    }
    const payload = await response.json().catch(() => ({})) as { error?: RelayErrorBody } & Record<string, unknown>;
    if (!response.ok) {
      const code = payload.error?.code ?? 'RELAY_REQUEST_FAILED';
      const message = payload.error?.message ?? `Dutydeck 回传服务返回 HTTP ${response.status}`;
      // 400/413 是调用方用法问题；401/404/409/5xx 是通道不可用
      const exitCode = response.status === 400 || response.status === 413
        ? relayAskExitCodes.usage
        : relayAskExitCodes.unavailable;
      throw new RelayCliError(message, exitCode, code);
    }
    return payload;
  }
}
