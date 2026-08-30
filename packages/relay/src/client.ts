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
    this.baseUrl = (env[relayUrlEnvKey] ?? env.DOCKMUX_RELAY_URL)?.trim().replace(/\/$/, '') ?? '';
    this.token = (env[relayTokenEnvKey] ?? env.DOCKMUX_RELAY_TOKEN)?.trim() ?? '';
    this.fetcher = options.fetcher ?? globalThis.fetch;
    if (!this.baseUrl || !this.token) {
      throw new RelayCliError(
        '回传命令只能在 Dockmux 会话内的 Agent 进程中调用；当前进程没有会话凭证。',
        relayAskExitCodes.usage,
        'RELAY_CONTEXT_REQUIRED'
      );
    }
  }

  async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new RelayCliError(
        `无法连接 Dockmux 回传服务：${error instanceof Error ? error.message : String(error)}`,
        relayAskExitCodes.unavailable,
        'RELAY_UNAVAILABLE'
      );
    }
    const payload = await response.json().catch(() => ({})) as { error?: RelayErrorBody } & Record<string, unknown>;
    if (!response.ok) {
      const code = payload.error?.code ?? 'RELAY_REQUEST_FAILED';
      const message = payload.error?.message ?? `Dockmux 回传服务返回 HTTP ${response.status}`;
      // 400/413 是调用方用法问题；401/404/409/5xx 是通道不可用
      const exitCode = response.status === 400 || response.status === 413
        ? relayAskExitCodes.usage
        : relayAskExitCodes.unavailable;
      throw new RelayCliError(message, exitCode, code);
    }
    return payload;
  }
}
