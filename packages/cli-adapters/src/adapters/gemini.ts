import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { submitPrompt } from './input-settle.js';

export function createGeminiAdapter(): CliAdapter {
  return {
    id: 'gemini',
    capabilities: { initialPromptViaArgs: true },

    buildArgs({ initialPrompt, model, permissionMode }: AdapterSessionContext): string[] {
      // Gemini CLI 自己管会话（--resume 只吃 "latest"/索引/UUID，不吃外部
      // 会话 id），永远新起会话。
      const args: string[] = permissionMode === 'full-trust' ? ['--yolo'] : [];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      // 首轮 prompt 走 -i：Gemini Ink TUI 启动期（auth / 模型加载 / 扩展）
      // 的 stdin 写入会静默丢失，-i 在会话内部注入、TUI 就绪后才处理。
      if (initialPrompt) {
        args.push('-i', initialPrompt);
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      await submitPrompt(backend, prompt);
    },
  };
}
