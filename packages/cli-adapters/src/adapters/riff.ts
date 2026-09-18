import type { CliAdapter, PtyLike } from '../types.js';

/**
 * Riff 直通壳 —— 真实工作由后端完成，本适配器不驱动任何本地 CLI。
 *
 * riff 跑在远端（没有本地二进制可 spawn），需由后端把 write()
 * 翻译成 riff HTTP API 调用。所以这里：无参数、无 PTY 节流、无 bracketed paste，
 * prompt 原样交给后端。dutydeck 尚无对应后端，形态如实保留。
 */
export function createRiffAdapter(): CliAdapter {
  return {
    id: 'riff',
    capabilities: {},

    buildArgs(): string[] {
      // 后端忽略 bin/args。
      return [];
    },

    writeInput(backend: PtyLike, prompt: string): void {
      // 直通：不需要 paste-burst 规避，也不需要 bracketed paste，
      // 后端的 write() 才是真正发起 API 调用的地方。
      backend.write(prompt);
    },

    // 刻意不实现 injectSessionContext：riff 的路由/身份/@ 规则由后端统一前置到
    // userPrompt（默认系统提示），共用路由块推荐
    // --mention-back，与 riff 自己的禁用规则互相矛盾，再塞一份会打架。
  };
}
