import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { writeRunnerInput } from '../runner-input.js';

/**
 * Mir CLI（mircli）适配器 —— runner 类：不驱动 TUI，而是由一个 Node runner
 * 以非交互 Print Mode（`mircli -p`）逐轮调用本地 mircli。
 *
 * ⚠️ dutydeck 未移植 botmux 的 runner 脚本：**agent 的 command 必须指向对应的
 * mir runner**（botmux 侧是 `node dist/mir-runner.js`），本适配器只产出 runner
 * 的参数，不解析任何 bin 路径。
 *
 * 与 `mira` 适配器的区别：
 *   - `mira` → Mira Web API（云端编排 + 远端 sandbox；chat/search）。
 *   - `mir`  → 本地 mircli（在本机执行、操作工作区；需要用户的本地 MCP bridge 已连接）。
 *
 * 跨轮对话连续性由 mircli 自己按 `--session-id` 维护，runner 用同一 id 重新拉起
 * 即可续接；没有可供用户复制粘贴的 CLI resume 命令，故不实现 buildResumeCommand。
 * runner 也会自行注入本地运行时上下文，所以不实现 injectSessionContext（避免
 * dutydeck 再叠一层路由块）。
 */

/** value 为 undefined 或空串就跳过（对齐 botmux 的 pushOpt 语义）。 */
function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createMirAdapter(): CliAdapter {
  return {
    id: 'mir',
    // buildArgs 完全不看 resume：会话延续是 runner 用同一 --session-id 重新拉起
    // mircli 的副作用，适配器层面没有 resume 参数可接。
    capabilities: {},

    buildArgs({ sessionId, locale }: AdapterSessionContext): string[] {
      // sessionId 原样传：mircli 的 --session-id 只当不透明 key 用，不要求裸 UUID。
      const args = ['--session-id', sessionId];
      pushOpt(args, '--locale', locale);
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 控制帧走 runner-input 的分块 + 节流 stdin 注入（整行一次写会撑爆
      // pane pty 的输入缓冲）。
      await writeRunnerInput(backend, '::dutydeck-mir:', prompt);
    },

    // runner 在两轮之间打印 `› ` 作为就绪提示。
    readyPattern: /›/,
  };
}
