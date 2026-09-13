import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { buildDutydeckRoutingBlock } from '../shared-hints.js';

/**
 * Claude Code 家族共用实现（claude-code / seed / relay）。
 *
 * Seed 与 Relay 是 Claude Code 的 fork（Relay 是 Seed 的当前发行名）：flag、
 * slash 命令、落盘会话布局逐字同构，只有二进制名、鉴权和数据根不同——而数据根
 * 定位、鉴权路径、transcript 桥都是 botmux 的基建，精简契约里不存在。所以三者
 * 在 dutydeck 侧真正的差异只剩 `id`，其余「命令行参数 + 输入时序 + idle pattern」
 * 完全一致，收敛到这里，避免三份逐字复制各自漂移。
 */

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const STARTUP_POLL_MS = 100;
const STARTUP_TIMEOUT_MS = 30_000;
const TRUST_KEY_RETRY_MS = 1_000;

/** Claude 家族完成标记：`✳ Worked for 12s` 等耗时行。 */
export const CLAUDE_FAMILY_COMPLETION_RE =
  /[✳✻]\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed|Baked|Brewed) for \d+[smh]/;

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/** 单次 send-keys 的最大 UTF-8 字节数：整行一次发会触发 Claude 家族的
 *  paste-burst 检测，所以每行都按小 chunk 分块键入。 */
export const CLAUDE_INPUT_CHUNK_BYTES = 96;

/** 按 UTF-8 字节预算切分，不切断 Unicode 码位。 */
export function chunkTextByUtf8Bytes(text: string, maxBytes: number = CLAUDE_INPUT_CHUNK_BYTES): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError('maxBytes must be an integer >= 4');
  }
  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (chunk && chunkBytes + charBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += charBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** 已接收过首次写入的后端。首次写入落在 Ink 启动渲染期，需要更长的 settle
 *  和节流；按 identity 跟踪，同一后端跨适配器实例共享 warmup 状态。 */
const firstWriteSeen = new WeakSet<PtyLike>();

/** Claude 家族的输入时序：分块键入 + soft-newline，最后一个 Enter 才提交。 */
export async function writeClaudeFamilyInput(backend: PtyLike, prompt: string): Promise<void> {
  const isFirstWrite = !firstWriteSeen.has(backend);
  if (isFirstWrite) {
    firstWriteSeen.add(backend);
    // 首次写入落在 Ink 启动渲染期，先等队列稳定。
    await delay(200);
  }
  const throttleMs = isFirstWrite ? 80 : 30;
  const tick = () => delay(throttleMs);

  if (backend.sendText && backend.sendSpecialKeys) {
    // tmux：逐行、按字节分块键入；换行用 '\' + Enter（Claude 家族的
    // soft-newline，内容留在输入框不提交），最后一个 Enter 才是提交。
    const lines = prompt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line && line.length > 0) {
        for (const chunk of chunkTextByUtf8Bytes(line)) {
          backend.sendText(chunk);
          await tick();
        }
      }
      if (i < lines.length - 1) {
        backend.sendText('\\');
        await tick();
        backend.sendSpecialKeys('Enter');
        await tick();
      }
    }
  } else {
    // 裸 PTY：bracketed paste 标记自己包，多行内容不会被拆成多次提交。
    backend.write(BRACKETED_PASTE_START + prompt + BRACKETED_PASTE_END);
  }
  await delay(500);
  if (backend.sendSpecialKeys) backend.sendSpecialKeys('Enter');
  else backend.write('\r');
}

/** full-trust 姿态：同时跳过工具权限确认与危险模式提示。 */
export function pushClaudeFamilyBypassArgs(args: string[], permissionMode: AdapterSessionContext['permissionMode']): void {
  if (permissionMode !== 'full-trust') return;
  args.push('--dangerously-skip-permissions');
  args.push(
    '--settings',
    JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      permissions: { defaultMode: 'bypassPermissions' },
    }),
  );
}

function isComposerScreen(screen: string): boolean {
  const lines = screen.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  return lines.filter(line => line === '❯').length === 1
    && lines.some(line => /Claude Code v\d/.test(line))
    && !lines.some(line => /^(Accessing workspace:|Quick safety check:|Security guide|Enter to confirm)/.test(line))
    && !lines.some(line => /^(?:❯\s*)?(?:No, exit|Yes, I trust this folder)$/.test(line));
}

function trustSelection(screen: string, cwd: string | undefined): 'No, exit' | 'Yes, I trust this folder' | undefined {
  if (!cwd) return undefined;
  const lines = screen.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  const workspaceIndexes = lines.reduce<number[]>((indexes, line, index) => {
    if (line === 'Accessing workspace:') indexes.push(index);
    return indexes;
  }, []);
  if (workspaceIndexes.length !== 1) return undefined;
  const workspaceIndex = workspaceIndexes[0]!;
  const prefix = lines.slice(0, workspaceIndex);
  // capture-pane retains the top separator; the local xterm viewport removes
  // box drawing, leaving no prefix. Neither path may contain other content.
  if (!((prefix.length === 0) || (prefix.length === 1 && /^─+$/.test(prefix[0]!))) || lines[workspaceIndex + 1] !== cwd) return undefined;
  const guideIndex = lines.indexOf('Security guide');
  if (guideIndex < workspaceIndex + 3 || lines.lastIndexOf('Security guide') !== guideIndex) return undefined;
  const explanation = lines.slice(workspaceIndex + 2, guideIndex).join(' ');
  if (explanation !== 'Quick safety check: Is this a project you created or one you trust? '
    + "(Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first. "
    + "Claude Code'll be able to read, edit, and execute files here."
    || lines[guideIndex + 3] !== 'Enter to confirm · Esc to cancel'
    || guideIndex + 4 !== lines.length) return undefined;
  const choices = lines.slice(guideIndex + 1, guideIndex + 3).map(line => ({
    label: line.replace(/^❯\s*/, ''), selected: line.startsWith('❯'),
  }));
  if (choices[0]!.label !== 'No, exit' || choices[1]!.label !== 'Yes, I trust this folder'
    || choices.filter(choice => choice.selected).length !== 1) return undefined;
  return choices.find(choice => choice.selected)!.label as 'No, exit' | 'Yes, I trust this folder';
}
/**
 * Claude 2.1.267 may ask whether a newly-entered cwd is trusted even when
 * bypass permissions is supplied. This is deliberately narrow: only the
 * observed workspace-trust dialog for this exact cwd is accepted, and only
 * full-trust is allowed to choose its affirmative option.
 */
export async function prepareClaudeFamilyInput(backend: PtyLike, ctx: AdapterSessionContext): Promise<void> {
  if (!backend.readScreen) {
    throw new Error('Claude startup confirmation requires a terminal screen reader');
  }

  const startedAt = Date.now();
  let lastDownAt = -Infinity;
  let lastEnterAt = -Infinity;
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    const screen = backend.readScreen();
    const selection = trustSelection(screen, ctx.cwd);
    const trustScreen = selection !== undefined;

    if (trustScreen && ctx.permissionMode !== 'full-trust') {
      throw new Error('Claude 正在确认此目录是否可信，请通过终端确认目录后再发送任务。');
    }

    // The page can redraw while we poll. Never carry the authority granted
    // by an earlier render into a different or partially-rendered dialog.
    if (!trustScreen) {
      if (isComposerScreen(screen)) return;
      await delay(STARTUP_POLL_MS);
      continue;
    }

    // Ink can discard a key while its first frame is still settling. Retry
    // only the exact current trust selection, at a bounded cadence and only
    // until this page disappears; do not reuse a historical selection.
    const now = Date.now();
    if (selection === 'No, exit' && now - lastDownAt >= TRUST_KEY_RETRY_MS) {
      lastDownAt = now;
      if (backend.sendSpecialKeys) backend.sendSpecialKeys('Down');
      else backend.write('\x1b[B');
    } else if (selection === 'Yes, I trust this folder' && now - lastEnterAt >= TRUST_KEY_RETRY_MS) {
      lastEnterAt = now;
      if (backend.sendSpecialKeys) backend.sendSpecialKeys('Enter');
      else backend.write('\r');
    }
    await delay(STARTUP_POLL_MS);
  }
  throw new Error('Claude 启动尚未就绪，请打开终端处理启动确认后再发送任务。');
}

/** 建一个 Claude 家族适配器；三者只有 id 不同。 */
export function createClaudeFamilyAdapter(id: string): CliAdapter {
  return {
    id,
    capabilities: { resume: true },

    buildArgs({ sessionId, resume, resumeSessionId, model, permissionMode }: AdapterSessionContext): string[] {
      // dutydeck sessionId 形如 "ses_<uuid>"，--session-id/--resume 只接受裸 UUID。
      const uuid = sessionId.replace(/^ses_/, '');
      const args: string[] = [];
      if (resume) {
        // resumeSessionId 可能是 CLI 自己铸的裸 UUID，也可能是 driver 反查失败后
        // 退回来的 dutydeck `ses_<uuid>`——后者必须同样剥前缀，否则 argv 变成
        // `--resume ses_<uuid>`，claude 认不出这个 id。缺省回退到本会话 uuid。
        args.push('--resume', (resumeSessionId ?? uuid).replace(/^ses_/, ''));
      } else {
        args.push('--session-id', uuid);
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      pushClaudeFamilyBypassArgs(args, permissionMode);
      // PlanMode 的审批 TUI 在 IM 场景无法驱动，直接禁掉。
      args.push('--disallowed-tools', 'EnterPlanMode,ExitPlanMode');
      return args;
    },

    // 会话上下文（路由块）由 driver 拼到首轮 prompt 前（契约统一走 prompt
    // 前缀，不再走 botmux 的 --append-system-prompt）。
    injectSessionContext(ctx: AdapterSessionContext): string {
      return buildDutydeckRoutingBlock(ctx.locale, ctx.env);
    },

    writeInput: writeClaudeFamilyInput,

    prepareInput: id === 'claude-code' ? prepareClaudeFamilyInput : undefined,

    buildResumeCommand(sessionId: string): string[] {
      return ['--resume', sessionId.replace(/^ses_/, '')];
    },

    completionPattern: CLAUDE_FAMILY_COMPLETION_RE,
    screenBusyPattern: /\besc to interrupt\b/i,
    screenActivityPattern: /^\s*[*·✢✳✶✻✽]\s+\p{L}[\p{L} '-]*(?:…|\.{3})(?:[ \t].*)?$/u,
    readyPattern: /❯/,
  };
}
