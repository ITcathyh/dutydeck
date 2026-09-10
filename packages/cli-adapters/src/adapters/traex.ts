import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';
import { isDutydeckSessionId, usableResumeId } from '../resume-id.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * TRAE CLI（traex / traecli）适配器：Codex 家族，共享 bracketed-paste 输入
 * 协议、`--dangerously-bypass-approvals-and-sandbox` / `--no-alt-screen` flag、
 * `resume <uuid>` 子命令和 `›` prompt 标记。数据在 ~/.trae（TRAE_HOME 可配）。
 */

// 下面的 busy 标记全部从 traex 二进制的 TUI 字符串表提取、跨 9 个本地版本
// 验证过（0.201.1-alpha.5 … 0.201.2-alpha.2）：
//  - spinner 帧：连续字符串 "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
//  - spinner 标签集 1（思考/工作轮换）与集 2（审批/排队）
// traex 从 Codex fork 时删掉了 "esc to interrupt" 页脚提示，所以 Codex 的
// 双锚点 pattern 在这里不成立。
const TRAEX_SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

const TRAEX_SPINNER_LABELS = [
  // 集 1 — 思考/工作轮换（编译进二进制的 spinner 字符串表）。
  'Thinking longer…',
  'Deep in thought…',
  'Almost there…',
  'Running command…',
  'Command in flight…',
  'Chugging along…',
  'Finishing up…',
  'Executing…',
  'Hang tight…',
  'Waiting for response…',
  'Any second now…',
  'Poking the model…',
  'On its way…',
  "Shh, it's thinking…",
  'Thinking…',
  'Reasoning through it…',
  'Mulling it over…',
  'Pondering…',
  'Working it out…',
  'Piecing it together…',
  // 集 2 — 审批/工作/排队。
  'Reviewing approval request',
  'Working…',
  'Working on it…',
  'Queued for capacity',
] as const;

/** 行锚定的独立排队提示串，active busy pattern 与 pre-idle 静态 latch 共用。 */
const TRAEX_QUEUE_STATIC_ARMS = [
  'Queued for capacity',
  "Too many requests right now\\. You're in the queue",
];

const TRAEX_ACTIVE_BUSY_PATTERN = new RegExp(
  [
    `[${TRAEX_SPINNER_FRAMES}][ \\t]?(?:${TRAEX_SPINNER_LABELS.join('|')})`,
    ...TRAEX_QUEUE_STATIC_ARMS.map(arm => `(?:^|[\\n\\r])[ \\t]*${arm}`),
  ].join('|'),
  'i',
);

/**
 * 排队屏的 pre-idle static-busy latch：排队屏可以静态渲染（无动画 spinner、
 * 无新 PTY 字节），busyPattern 的视口探测在这类后端上不可靠，所以用原始
 * PTY 流里的排队证据 latch 住 busy，直到带 composer 证据的新 chunk 重绘。
 */
const TRAEX_STATIC_BUSY_PATTERN = new RegExp(
  [
    `[${TRAEX_SPINNER_FRAMES}][ \\t]?Queued for capacity`,
    ...TRAEX_QUEUE_STATIC_ARMS.map(arm => `(?:^|[\\n\\r])[ \\t]*${arm}`),
  ].join('|'),
  'i',
);

export function createTraexAdapter(): CliAdapter {
  return {
    id: 'traex',
    capabilities: { resume: true },

    buildArgs({ resume, resumeSessionId, cwd, model, reasoningEffort, permissionMode }: AdapterSessionContext): string[] {
      const args: string[] = ['--no-alt-screen'];
      if (permissionMode === 'full-trust') {
        args.unshift('--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust');
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (reasoningEffort) {
        args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
      }
      if (cwd) {
        args.push('-C', cwd);
      }
      // 只做精确 id 续接；无 resumeSessionId 时新起会话（botmux 的 history
      // 反查已随 transcript 机制一起丢弃）。
      const usable = usableResumeId(resumeSessionId);
      if (resume && usable) {
        return ['resume', ...args, usable];
      }
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      // 与 Codex 相同的 bracketed-paste 策略：多行消息不能被内嵌 \n 拆成多个 turn。
      if (backend.pasteText) {
        backend.pasteText(prompt);
      } else {
        backend.write('\x1b[200~' + prompt + '\x1b[201~');
      }
      await delay(200);
      if (backend.sendSpecialKeys) backend.sendSpecialKeys('Enter');
      else backend.write('\r');
    },

    /** 与 codex 同源：自己铸 rollout id。收到 dutydeck 的 `ses_<uuid>` 说明反查
     *  失败，`resume <未知id>` 起不来 → 返回 null，driver 改起新会话。 */
    buildResumeCommand(sessionId: string): string[] | null {
      if (isDutydeckSessionId(sessionId)) return null;
      return ['resume', sessionId];
    },

    busyPattern: TRAEX_ACTIVE_BUSY_PATTERN,
    idleToBusyPattern: TRAEX_ACTIVE_BUSY_PATTERN,
    staticBusyPattern: TRAEX_STATIC_BUSY_PATTERN,
    // 只认真实 composer 证据（行首 ›/❯，排除带序号的选择器行）来清 latch：
    // 宽 readyPattern 也匹配排队屏自带的 `\d+% left` 状态栏，会误清。
    staticBusyClearPattern: /(?:^|[\n\r])\s*[›❯](?!\s*\d+\.)/,
    // traex 同时出现过 Codex 风格 `›` 和 Claude 风格 `❯`；启动公告/选择器屏
    // 也用 `❯ 1.` 当菜单光标，排除带序号的行。
    readyPattern: /(?:^|[\n\r])\s*[›❯](?!\s*\d+\.)|\d+% left/,
  };
}
