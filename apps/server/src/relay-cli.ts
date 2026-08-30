import { RelayCliError, RelayHttpClient, relayAskExitCodes, type RelayClientOptions } from '@dockmux/relay';

export interface RelaySessionCliOptions {
  timeout?: string;
  json?: boolean;
}

/** 会话 id 由服务端从 token 反解；CLI 只需把 token 带上，路径里的 id 用占位符。 */
const sessionPath = (suffix: string) => `/sessions/self/${suffix}`;

/**
 * `dockmux session send` —— 非阻塞推送。
 * 成功后 stdout 打印一行 JSON（与其它 dockmux 子命令一致）。
 */
export async function runSessionSend(text: string, options: RelayClientOptions = {}) {
  const client = new RelayHttpClient(options);
  return client.post(sessionPath('send'), { text });
}

export interface RelayAskResult {
  status: string;
  answer?: string;
  askId?: string;
  reason?: string;
}

/**
 * `dockmux session ask` —— 阻塞提问。
 *
 * 返回值交给 cli.ts 决定 stdout / 退出码：答案走 stdout 裸文本（便于
 * `answer=$(dockmux session ask "...")`），提示信息走 stderr。
 */
export async function runSessionAsk(
  question: string,
  cliOptions: RelaySessionCliOptions = {},
  options: RelayClientOptions = {}
): Promise<RelayAskResult> {
  let timeoutMs: number | undefined;
  if (cliOptions.timeout !== undefined) {
    const seconds = Number(cliOptions.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new RelayCliError('--timeout 必须是正整数秒。', relayAskExitCodes.usage, 'RELAY_INVALID_TIMEOUT');
    }
    timeoutMs = Math.round(seconds * 1000);
  }
  const client = new RelayHttpClient(options);
  const payload = await client.post(sessionPath('ask'), {
    question,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  return payload as unknown as RelayAskResult;
}

/** 把 ask 结果映射成退出码 + 要打印的内容 */
export function askOutput(result: RelayAskResult, json = false) {
  if (json) {
    return { stdout: `${JSON.stringify(result)}\n`, stderr: '', exitCode: exitCodeFor(result) };
  }
  if (result.status === 'answered') {
    return { stdout: `${result.answer ?? ''}\n`, stderr: '', exitCode: relayAskExitCodes.answered };
  }
  if (result.status === 'expired') {
    return { stdout: '', stderr: '提问超时，用户未在期限内回答。\n', exitCode: relayAskExitCodes.timeout };
  }
  return {
    stdout: '',
    stderr: `${result.reason ?? '提问已取消'}。\n`,
    exitCode: relayAskExitCodes.unavailable
  };
}

function exitCodeFor(result: RelayAskResult) {
  if (result.status === 'answered') return relayAskExitCodes.answered;
  if (result.status === 'expired') return relayAskExitCodes.timeout;
  return relayAskExitCodes.unavailable;
}
