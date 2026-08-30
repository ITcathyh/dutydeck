import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** mtr 原生会话 id 形态：`ses_` + 纯字母数字。dockmux 的 `ses_<uuid>` 带连字符，
 *  **不满足**这个形态，必须归一后再传。 */
const MTR_SESSION_ID_RE = /^ses_[0-9A-Za-z]+$/;

/** mtr（与 opencode 同族）的 id 尾段长度：26 个字符。 */
const MTR_SESSION_ID_BODY_LEN = 26;

/**
 * 由 dockmux sessionId 确定性推导 mtr 会话 id：去掉 `ses_` 前缀与 uuid 连字符，
 * 取前 26 位十六进制凑成 `ses_<26>`（botmux 用 sha256+base62 生成同样长度的 id，
 * 这里改用 uuid 自身的熵——同样确定性，且 hex 是任何可能字符集的子集）。
 *
 * 确定性是关键：fresh spawn 用 `--set-session` 把这个 id 钉下去，之后 resume
 * 重算一遍就能精确命中同一会话，不必额外持久化 CLI 侧 id。
 */
export function mtrSessionIdFor(sessionId: string): string {
  const body = sessionId.replace(/^ses_/, '').replace(/[^0-9A-Za-z]/g, '');
  return `ses_${(body || 'dockmux').slice(0, MTR_SESSION_ID_BODY_LEN)}`;
}

function nativeSessionId(sessionId: string, cliSessionId?: string): string {
  return cliSessionId && MTR_SESSION_ID_RE.test(cliSessionId)
    ? cliSessionId
    : mtrSessionIdFor(sessionId);
}

export function createMtrAdapter(): CliAdapter {
  return {
    id: 'mtr',
    capabilities: { resume: true, initialPromptViaArgs: true },

    buildArgs({ sessionId, resume, resumeSessionId, initialPrompt }: AdapterSessionContext): string[] {
      const mtrSessionId = nativeSessionId(sessionId, resumeSessionId);
      const args = resume
        ? ['--session', mtrSessionId]
        : ['--set-session', mtrSessionId];
      // 首轮 prompt 走 --prompt：mtr 与 opencode 同族，TUI 启动期的 stdin 写入可能丢失。
      if (initialPrompt) {
        args.push('--prompt', initialPrompt);
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      if (backend.sendText && backend.sendSpecialKeys) {
        backend.sendText(prompt);
        await delay(200);
        backend.sendSpecialKeys('Enter');
      } else {
        backend.write(prompt);
        await delay(1000);
        backend.write('\r');
      }
    },

    buildResumeCommand(sessionId: string): string[] {
      return ['--session', nativeSessionId(sessionId)];
    },
  };
}
