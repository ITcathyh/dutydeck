import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 已接收过首次写入的后端：首次写入落在 cursor-agent TUI 启动渲染期，
 *  需要更长的 settle + 节流。按 identity 跟踪，跨适配器实例共享。 */
const cursorFirstWriteSeen = new WeakSet<PtyLike>();

export function createCursorAdapter(): CliAdapter {
  return {
    id: 'cursor',
    capabilities: { resume: true, initialPromptViaArgs: true },

    buildArgs({ resume, resumeSessionId, initialPrompt, model, permissionMode }: AdapterSessionContext): string[] {
      const base: string[] = permissionMode === 'full-trust' ? ['--trust', '--force'] : [];
      if (model && model.trim()) {
        base.push('--model', model.trim());
      }
      if (!resume) {
        if (initialPrompt) base.push(initialPrompt);
        return base;
      }
      const usable = usableResumeId(resumeSessionId);
      if (usable) {
        base.push('--resume', usable);
      }
      // 绝不 --continue：它续接全局最近 chat，会串到兄弟会话上下文
      // （同一 Cursor config home 被所有会话共享）。
      if (initialPrompt) base.push(initialPrompt);
      return base;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 逐行发送而不是整段一次写：cursor-agent 的 paste 检测会把密集到达的
      // 多行块折叠成 `[Pasted text +N lines]` 占位符，模型读不到内容。
      // 绝不用 bracketed-paste 标记（会触发折叠）。
      const useKeys = !!(backend.sendText && backend.sendSpecialKeys);
      const emitText = (s: string) => (useKeys ? backend.sendText!(s) : backend.write(s));
      const emitSoftNewline = () => {
        if (useKeys) {
          // tmux：Ctrl+J 是 cursor 原生 soft-newline。
          backend.sendSpecialKeys!('C-j');
        } else {
          // 裸 PTY：'\' + CR，cursor 把 CR 前的反斜杠当 soft-newline 吃掉，
          // 流里没有 LF 字节，免疫折叠（仅本地 TUI 渲染多个尾部反斜杠）。
          backend.write('\\');
          backend.write('\r');
        }
      };
      const emitEnter = () => (useKeys ? backend.sendSpecialKeys!('Enter') : backend.write('\r'));

      const isFirstWrite = !cursorFirstWriteSeen.has(backend);
      if (isFirstWrite) {
        cursorFirstWriteSeen.add(backend);
        await delay(200);
      }
      const throttleMs = isFirstWrite ? 80 : 30;

      const lines = prompt.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line && line.length > 0) {
          emitText(line);
          await delay(throttleMs);
        }
        if (i < lines.length - 1) {
          emitSoftNewline();
          await delay(throttleMs);
        }
      }
      await delay(200);
      emitEnter();
      // turn 运行中时第一个 Enter 只把文本停在 follow-up 面板，第二个 Enter
      // 才把它推进活动 turn；空闲时空 composer 的额外 Enter 是 no-op。
      await delay(200);
      emitEnter();
    },

    /** Cursor 的 chat id 不透明、由 CLI 自己铸，dutydeck 的 sessionId 推导不出来。
     *  收到 dutydeck 的 `ses_<uuid>` → null，driver 改起新会话。 */
    buildResumeCommand(sessionId: string): string[] | null {
      if (isDutydeckSessionId(sessionId)) return null;
      return ['--resume', sessionId];
    },

    // 真实 composer 的占位符（登录/启动屏上都没有），两种状态都要匹配：
    // 会话一旦有历史，占位符就从 "Plan, search..." 切到 "Add a follow-up"。
    readyPattern: /→\s+(?:Plan, search, build anything|Add a follow-up)/,
  };
}
