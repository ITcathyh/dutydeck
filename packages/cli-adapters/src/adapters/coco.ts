import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * CoCo（TRAE CLI 的 CoCo 形态）适配器。二进制与 traex 同源，但 TUI 是 Claude
 * Code 那一支的 fork（Ink），所以输入协议跟 Codex 家族的 traex 不同，反而更接近
 * claude-code。
 */
export function createCocoAdapter(): CliAdapter {
  return {
    id: 'coco',
    capabilities: { resume: true },

    buildArgs({ sessionId, resume, resumeSessionId, model }: AdapterSessionContext): string[] {
      // CoCo 的会话目录是 `<cache>/coco/sessions/<uuid>/`，只认裸 UUID；
      // dockmux sessionId 形如 "ses_<uuid>"，前缀必须剥掉。
      const uuid = sessionId.replace(/^ses_/, '');
      const args: string[] = [];
      if (resume) {
        // CoCo 的会话 id 在 fresh spawn 时就被 --session-id 钉成 dockmux 的 UUID，
        // 所以无 resumeSessionId 时回退到自己的 id 就是精确续接。driver 反查失败
        // 时退回来的是带前缀的 `ses_<uuid>`，这里同样要剥掉。
        args.push('--resume', (resumeSessionId ?? uuid).replace(/^ses_/, ''));
      } else {
        args.push('--session-id', uuid);
      }
      // dockmux MVP 无人值守：bypass 权限确认（botmux !disableCliBypass 分支）。
      args.push('--yolo');
      if (model && model.trim()) {
        // 模型覆盖必须走嵌套 key：`--config model=…` 直接 exit 1，
        // `--config model.name=…` 才能正常启动。
        args.push('--config', `model.name=${model.trim()}`);
      }
      // PlanMode 的审批 TUI 在 IM 场景无法驱动，直接禁掉（对齐 claude-code）。
      args.push('--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode');
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 必须走 bracketed paste（tmux 侧是 `load-buffer` + `paste-buffer -d -p`）。
      // 用 send-keys 逐行键入 + `\` 软换行（claude-code 的路子）在 Trae CLI 上
      // 会被判成"一直没结束的 paste burst"：最后那个 Enter 被当成软换行吞掉，
      // 消息永远停在输入框里，无提交也无报错。显式的 START/END 标记让内嵌 \n
      // 保持为内容，随后的 Enter 才是明确的提交。
      if (backend.pasteText) {
        backend.pasteText(prompt);
      } else {
        backend.write('\x1b[200~' + prompt + '\x1b[201~');
      }
      // 含图片路径时 CoCo 要先做本地文件解析，提交前多给点时间。
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(prompt);
      await delay(hasImagePath ? 800 : 500);
      if (backend.sendSpecialKeys) backend.sendSpecialKeys('Enter');
      else backend.write('\r');
    },

    buildResumeCommand(sessionId: string): string[] {
      return ['--resume', sessionId.replace(/^ses_/, '')];
    },

    // `⏵⏵` 只在 --yolo 下渲染；被接管（用户手起）的 CoCo 进程通常没这个 flag，
    // 状态栏只剩模型徽标 `⬡ <model>`。两个都要认，否则 adopt 形态永远不判 idle。
    readyPattern: /⏵⏵|⬡/,
  };
}
