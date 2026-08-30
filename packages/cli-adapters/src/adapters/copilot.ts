import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * GitHub Copilot CLI（npm `@github/copilot`）适配器。
 *
 * Ink 交互式 agent，会话完全由 CLI 自己管——dockmux 的 sessionId 没法钉成
 * Copilot 的会话 id，所以永远新起会话，恢复只认精确的 `--resume <id>`。
 */
export function createCopilotAdapter(): CliAdapter {
  return {
    id: 'copilot',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId, model }: AdapterSessionContext): string[] {
      // --allow-all-tools 把 Copilot 放到与 cursor --force / claude-code
      // --dangerously-skip-permissions 同级的「不逐工具审批」姿态。没有它，
      // 每次 shell/编辑都会弹回 TUI 等确认，而 IM 用户看不到终端。
      // dockmux MVP 无人值守，恒定加上。
      const args: string[] = ['--allow-all-tools'];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (resume && resumeSessionId) {
        args.push('--resume', resumeSessionId);
      }
      // 无精确 id 时新起干净会话，绝不 `--continue`（= `--resume=-1`）：它续接
      // 全局最近一个会话，而同一 Copilot config home 被本 bot 的所有会话共享，
      // 会把兄弟会话的上下文串进来（话题群的上下文漏进私聊）。丢本会话上下文
      // 是两害相权取其轻。
      //
      // 已知回退：Copilot 没有任何 cliSessionId 捕获机制（无 bridge、无
      // observation、无输出捕获），「缺 id」是常态而非边角——每次重启都会
      // 新起会话。要恢复精确 resume，需要先补 session id 捕获。
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // Copilot 的 Ink TUI 行为同 Gemini/OpenCode：TextInput 组件有异步启动期，
      // 该窗口内的写入可能被静默丢弃；输入框渲染完成后 sendText + Enter 可靠。
      // 没有 cursor 那种 bracketed-paste 折叠，所以走最简单的 write+Enter。
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

    // 无显式完成标记、Ink 输入框提示符太通用匹配不可靠 —— 纯 quiescence 判定。
  };
}
