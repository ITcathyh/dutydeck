import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { writeRunnerInput } from '../runner-input.js';

/**
 * Mira（Mira Web API）适配器 —— runner 类：云端编排 + 远端 sandbox，没有本地
 * 二进制，全部经由一个 Node runner 走 HTTP。
 *
 * ⚠️ dockmux 未移植 botmux 的 runner 脚本：**agent 的 command 必须指向对应的
 * mira runner**（botmux 侧是 `node dist/mira-runner.js`），本适配器只产出 runner
 * 的参数，不解析任何 bin 路径。
 *
 * 续接靠持久化的 Mira 会话 id（`--mira-session-id`）在 runner 内部完成，没有等价
 * 的用户可见 CLI 命令，故不实现 buildResumeCommand。runner 自己注入上下文，也就
 * 不实现 injectSessionContext。
 */

/** value 为 undefined 或空串就跳过（对齐 botmux 的 pushOpt 语义）。 */
function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createMiraAdapter(): CliAdapter {
  return {
    id: 'mira',
    // buildArgs 能接 --mira-session-id，故 resume 能力位为真。
    capabilities: { resume: true },

    buildArgs({ sessionId, resume, resumeSessionId, locale }: AdapterSessionContext): string[] {
      // sessionId / miraSessionId 都是不透明 key，原样传。
      const args = ['--session-id', sessionId];
      if (resume && resumeSessionId) args.push('--mira-session-id', resumeSessionId);
      pushOpt(args, '--locale', locale);
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 分块 + 节流 stdin 注入：单次 send-keys 发整条大消息会被丢弃并卡死会话。
      await writeRunnerInput(backend, '::dockmux-mira:', prompt);
    },

    // ⚠️ 入参必须是 Mira 自己铸的会话 id（`--mira-session-id` 的唯一形态）。
    // driver 的 resume() 目前只传 dockmux sessionId，直到它能回传 CLI-native id
    // 之前，这条路径拼出来的 argv 恢复不到正确会话（botmux 因此直接返回 null）。
    buildResumeCommand(sessionId: string): string[] {
      return ['--mira-session-id', sessionId];
    },

    readyPattern: /›/,
  };
}
