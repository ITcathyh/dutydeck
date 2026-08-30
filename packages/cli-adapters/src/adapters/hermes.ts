import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createHermesAdapter(): CliAdapter {
  return {
    id: 'hermes',
    capabilities: { resume: true },

    buildArgs({ sessionId, resume, resumeSessionId, permissionMode }: AdapterSessionContext): string[] {
      const args: string[] = [];
      // Hermes 的会话存在 ~/.hermes/state.db（不是 cwd 作用域的 JSONL）；
      // `--pass-session-id` 让它接受我们传的 id，所以无 resumeSessionId 时回退
      // 到 dockmux 自己的 sessionId 就是精确续接。
      if (resume) args.push('--resume', resumeSessionId ?? sessionId);
      if (permissionMode === 'full-trust') args.push('--yolo', '--accept-hooks');
      args.push('--pass-session-id');
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
      return ['--resume', sessionId];
    },

    // Hermes TUI 的 prompt_symbol 就是 `❯`（skin_engine.py）。没有它，唯一的
    // 就绪信号只剩静默检测：Hermes 在 API 调用期渲染 ⟪▲ 之类的字符不断喂新字节，
    // 每次都把静默计时器重新武装，冷启动/并发会话要 2-3 分钟才被判为 ready，
    // 而真实 composer 大约 3.6s 就已经完整渲染出来。
    // 这个列表要保持窄：Hermes 只用 ❯，且没有 codex 那种会误命中的启动选择器。
    readyPattern: /❯/,
  };
}
