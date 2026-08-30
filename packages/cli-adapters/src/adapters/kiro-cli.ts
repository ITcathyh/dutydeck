import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDockmuxSessionId, usableResumeId } from '../resume-id.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 直接信任这三个官方核心工具，而不是 --trust-all-tools。 */
const TRUSTED_CORE_TOOLS = 'read,write,shell';

/** 每个后端只在首次写入前敲一次 `/session-id`。 */
const sessionIdRequestedBackends = new WeakSet<PtyLike>();

async function requestSessionIdOnce(backend: PtyLike): Promise<void> {
  if (sessionIdRequestedBackends.has(backend)) return;
  sessionIdRequestedBackends.add(backend);
  if (backend.sendText && backend.sendSpecialKeys) {
    backend.sendText('/session-id');
    await delay(200);
    backend.sendSpecialKeys('Enter');
  } else {
    backend.write('/session-id\r');
  }
  await delay(200);
}

/**
 * Kiro CLI（`kiro-cli chat`）适配器。
 *
 * Kiro 会话 id 由 CLI 自己分配，只能通过 TUI 的 `/session-id` 斜杠命令回显——
 * 首次写入前敲一次，让 id 出现在屏幕上供 driver 捕获（botmux 靠这条把
 * cliSessionId 抓回来；dockmux 尚无捕获管道，命令仍保留，屏幕上有 id 才有
 * 后续接入的可能）。
 */
export function createKiroCliAdapter(): CliAdapter {
  return {
    id: 'kiro-cli',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId }: AdapterSessionContext): string[] {
      const args = ['chat'];
      // dockmux MVP 无人值守（botmux !disableCliBypass 分支）。避开
      // --trust-all-tools：Kiro 的终端 UI 会为该 flag 弹一道风险确认门，
      // 无人值守下过不去；改为直接信任官方文档列出的核心工具。
      args.push(`--trust-tools=${TRUSTED_CORE_TOOLS}`);
      const usable = usableResumeId(resumeSessionId);
      if (resume && usable) {
        args.push('--resume-id', usable);
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      await requestSessionIdOnce(backend);
      if (backend.sendText && backend.sendSpecialKeys) {
        // 逐行发送，行间用 Ctrl+J 软换行（内容留在输入框不提交），
        // 最后一个 Enter 才是提交。
        const lines = prompt.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line && line.length > 0) backend.sendText(line);
          if (i < lines.length - 1) {
            backend.sendSpecialKeys('C-j');
            await delay(50);
          }
        }
        await delay(200);
        backend.sendSpecialKeys('Enter');
      } else {
        backend.write(prompt.replace(/\n/g, '\x0a'));
        await delay(1000);
        backend.write('\r');
      }
    },

    /** Kiro 会话 id 由 CLI 自己分配（dockmux 尚无捕获管道），`--resume-id` 只认
     *  它自己的 id。收到 dockmux 的 `ses_<uuid>` → null，driver 改起新会话。 */
    buildResumeCommand(sessionId: string): string[] | null {
      if (isDockmuxSessionId(sessionId)) return null;
      return ['chat', '--resume-id', sessionId];
    },

    // 无显式完成标记、也没有稳定的就绪提示符 —— 纯 quiescence 判定。
  };
}
