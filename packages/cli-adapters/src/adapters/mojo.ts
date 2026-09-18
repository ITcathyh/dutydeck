import type { CliAdapter, PtyLike } from '../types.js';

/**
 * Mojo 直通壳 —— 真实工作由后端完成，本适配器不驱动任何本地 TUI。
 *
 * 不把 mojo 当交互式 TUI 驱动是实测逼出来的结论，不是偷懒：
 *   1. `--yolo` / `-r` / `-c` / `--output-format` / `--timeout` / `--idle-timeout`
 *      全都「仅 -p」（print/headless 模式）有效。不带 `-p` 传这些不会起 TUI，
 *      进程只会挂在 stdin 上等 EOF——没法像 kimi/grok 那样注入到长驻交互进程里。
 *   2. mojo 不留本地 per-session transcript：`~/.mojo` 只有 credentials/ memory/
 *      skills/，会话状态在服务端。所以 grok 那套「tail JSONL 判回合结束」的桥
 *      根本建不起来，只剩截屏解析，而长输出下截屏不可靠。
 *
 * 它反而提供了干净的 headless 控制面（`-p --background` + `mojo session
 * get|respond|confirm|cancel`，统一的单行 JSON 信封），几乎 1:1 映射到 API-backed
 * 后端模式（由外部后端把 write() 翻译成 mojo CLI 调用）。
 * dutydeck 尚无对应后端，形态如实保留。
 *
 * 以上基于 @byted/mojo 1.0.10（linux-x64）实测。
 */
export function createMojoAdapter(): CliAdapter {
  return {
    id: 'mojo',
    capabilities: {},

    buildArgs(): string[] {
      // worker 不 spawn 任何二进制，后端按回合 shell out。
      return [];
    },

    writeInput(backend: PtyLike, prompt: string): void {
      // 直通：不需要 paste-burst 规避，也不需要 bracketed paste，
      // 后端的 write() 才是真正发起 CLI 调用的地方。
      backend.write(prompt);
    },

    // 刻意不实现 injectSessionContext：共用路由块推荐 --mention-back，对「发送者
    // 在创建时就已冻结」的沙箱化远端会话是错的。mojo 目前也没有自己的替代文案
    // （不像 riff 有 DEFAULT_RIFF_SYSTEM_PROMPT），所以宁可不注入——为 mojo 单独
    // 设计路由/身份块另行跟进，不能照抄本地 CLI 的措辞。
  };
}
