import type { CliExtensions } from '../profile.js';
import type { CliAdapter } from '../types.js';
import { secretGuardActive } from '@dutydeck/shared/secret-guard';
import { PromptNotWrittenError } from '@dutydeck/shared';
import { ClaudeSettings } from './claude-settings.js';
import { claudeSafePrompt } from './claude-prompt.js';
import { claudeModeFooterIndex, ownedClaudeComposer, ownedClaudeCompactMenu } from './claude-family.js';
import { ClaudeNativeSessionResolver, claudeResumeFromObservation, hasPinnedSession } from './claude-native-session.js';

/** Claude 终端子进程的默认环境，Agent env 里的同名值优先。
 *  不能并进 agent.env：显式 env 非空时 ClaudeSettings 会给每个会话生成 --settings、改写启动参数。
 *  MCP task 转到后台后结果不归本轮，所以默认让它留在工具调用里。 */
const claudeChildEnvDefaults: Record<string, string> = { CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND: '1' };
/** 机器人设了 claudeAutoMemory=off 的群聊会话（服务端在 Agent env 里放小写标记）再加这一项，与上面的默认值同层：
 *  Agent env 里的同名值、用户 ~/.claude/settings.json env 里的同名值都压过它。 */
const claudeAutoMemoryOffDefaults = (env: Record<string, string>): Record<string, string> =>
  env.dutydeck_claude_auto_memory === 'off' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {};

function maintenanceStatusEvidenceLines(lines: string[]): string[] {
  const footer = claudeModeFooterIndex(lines);
  if (!/^(?:(?:⏵⏵|⏸) [a-z ]+ on\b|\? for shortcuts\b|paste again to expand\b)/.test(lines[footer] ?? '')) return lines;
  for (let statusRows = 0; statusRows <= 2; statusRows++) {
    const border = footer - statusRows - 1;
    if (border >= 2 && /^─{8,}$/.test(lines[border] ?? '') && lines[border - 2] === lines[border]
      && /^❯(?:\s|$)/.test(lines[border - 1] ?? '')) return lines.slice(0, border - 2);
  }
  return lines;
}

function statusBlocks(adapter: CliAdapter, lines: string[], interrupted: boolean): boolean {
  const { screenActivityPattern: activity, backgroundWaitPattern: background, completionPattern: completion,
    screenCancelledPattern: cancelled, screenBusyPattern: busy } = adapter;
  const evidence = maintenanceStatusEvidenceLines(lines);
  for (let index = evidence.length - 1; index >= 0; index--) {
    const line = evidence[index]!;
    if (/^✔ /.test(line)) continue;
    if (activity?.test(line) || busy?.test(line)) return true;
    if (background?.test(line)) return !interrupted;
    if (completion?.test(line) || cancelled?.test(line)) return false;
  }
  return false;
}


export const claudeInputExtensions = {
  settings: (sessionId: string) => new ClaudeSettings(sessionId),
  spawnEnv: (env: Record<string, string>) => ({ ...claudeChildEnvDefaults, ...claudeAutoMemoryOffDefaults(env), ...env }),
  cleanPrompt(text: string, original: string) {
    const cleaned = claudeSafePrompt(text);
    if (original.length && !cleaned.length) throw new PromptNotWrittenError('Claude 输入在清理不可见字符后为空；没有写入终端，也没有创建回执等待。');
    return cleaned;
  },
  strictCursor: true,
  heldInputMessage(screen: string) {
    if (/Removed \d+ invisible characters? · review and press Enter to send/.test(screen)) {
      return 'Claude 拦下了这次发送，需要在终端确认；提交结果未知，原进程已保留';
    }
  },
};

export const claudeExtensions: CliExtensions = {
  ...claudeInputExtensions,
  permissions: { secretGuardActive },
  compact: { statusBlocks, ownsComposer: ownedClaudeComposer, ownsMenu: ownedClaudeCompactMenu },
  nativeSession: {
    createResolver: (...args) => new ClaudeNativeSessionResolver(...args),
    pinned: hasPinnedSession,
    resume: claudeResumeFromObservation,
  },
};
