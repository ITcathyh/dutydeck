import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secretGuardHookCommand, secretGuardToolMatcher } from '@dutydeck/shared/secret-guard';
import { claudePlanGuardMatcher, createClaudeFamilyAdapter, prepareClaudeFamilyInput } from './claude-family.js';
import type { PtyLike } from '../types.js';

// The observed pane's last four nonempty lines are verbatim; history above is anonymized.
const resumedComposer = readFileSync(new URL('../fixtures/claude-resume-ready/screen.txt', import.meta.url), 'utf8');
// Real 2.1.287 smoke startup screen; only the isolated workspace is anonymized.
// Readiness means input can be written, independently of provider login.
const placeholderComposer = readFileSync(new URL('../fixtures/claude-placeholder-ready/screen.txt', import.meta.url), 'utf8');
// 2.1.303 resumed pane with a two-line user statusLine; history/model/workspace anonymized.
const statuslineComposer = readFileSync(new URL('../fixtures/claude-statusline-ready/screen.txt', import.meta.url), 'utf8');
// Claude 2.1.316 startup dialogs that wait for a person (capture-pane, 120x30). external-imports is the
// stuck background memory job's pane; only its home directory is anonymized.
const blockingDialogs = ['external-imports', 'mcp-server', 'mcp-servers', 'bypass-permissions']
  .map(name => [name, readFileSync(new URL(`../fixtures/claude-blocking-dialogs/${name}.txt`, import.meta.url), 'utf8')] as const);
const cwd = '/workspace/trusted-project';
const trustScreen = (selected: 'No, exit' | 'Yes, I trust this folder', path = cwd) => [
  '─'.repeat(120), 'Accessing workspace:', '', path, '',
  'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  "project, or work from your team). If not, take a moment to review what's in this folder first.",
  '', "Claude Code'll be able to read, edit, and execute files here.", '', 'Security guide', '',
  selected === 'No, exit' ? '❯ No, exit' : '  No, exit',
  selected === 'Yes, I trust this folder' ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder',
  'Enter to confirm · Esc to cancel',
].join('\n');
// Claude 2.1.318 at 120 columns hard-wraps a long cwd under "Accessing workspace:" with no separator
// (observed with a 177-character memory-job directory); the shape below follows that capture.
const longCwd = `/data/.dutydeck/memory/groups/oc_0123456789abcdef0123456789abcdef/workspace-${'x'.repeat(100)}/memory-job-2026-11-06/round-${'y'.repeat(80)}`;
const wrapPath = (path: string, width: number) => path.match(new RegExp(`.{1,${width}}`, 'g'))!.join('\n');
const wrappedTrustScreen = (selected: 'No, exit' | 'Yes, I trust this folder', path = longCwd) =>
  trustScreen(selected, wrapPath(path, 118));
const composer = [
  '▐▛███▛█   Claude Code v2.1.267',
  '▝▜██████▀  model_api/experimental_0812[1m] with xhigh effort · API Usage Billing',
  `  ▝▝ ▝▝    ${cwd}`,
  '', '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '❯\u00a0', '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

// 以下底部几行取自开发机上 Claude Code 的 tmux 画面（capture-pane 原样，历史内容省略）。
const rule = '─'.repeat(120);
const loggedOutFooter = [rule, '❯\u00a0', rule,
  `  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents${' '.repeat(30)}Not logged in · Run /login`,
  `${' '.repeat(81)}✔ Update installed · Restart to apply`].join('\n');
const idleScreens = {
  clearHint: ['✻ Churned for 17m 53s · done 2:33 PM', `${' '.repeat(80)}new task? /clear to save 156.2k tokens`, rule, '❯\u00a0', rule,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n'),
  loggedOut: ['  ⎿  Not logged in · Please run /login', '✻ Crunched for 0s · done 11:37 PM', loggedOutFooter].join('\n'),
  manual: ['✻ Worked for 13s · done Sunday 8:39 AM', rule, '❯\u00a0', rule, '  ⏸ manual mode on · ? for shortcuts · ← for agents'].join('\n'),
  auto: ['● {"actions":[{"op":"noop"}]}', '✻ Cooked for 9s · done 12:19 PM', rule, '❯\u00a0', rule, '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'].join('\n'),
};

class TrustBackend implements PtyLike {
  screen: string;
  readonly writes: string[] = [];

  constructor(screen: string) { this.screen = screen; }
  write(data: string): void { this.writes.push(data); }
  readScreen(): string { return this.screen; }
  sendSpecialKeys(...keys: string[]): void {
    this.writes.push(...keys);
    if (keys[0] === 'Down') this.screen = this.screen.includes(longCwd.slice(0, 40)) ? wrappedTrustScreen('Yes, I trust this folder') : trustScreen('Yes, I trust this folder');
    if (keys[0] === 'Enter') this.screen = composer;
  }
}

describe('Claude family startup trust confirmation', () => {
  it('accepts the recorded resumed composer with two statusLine rows before its mode footer', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(statuslineComposer);
      let ready = false;
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' }).then(() => { ready = true; });
      void preparing.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).toBe(true);
      await preparing;
      expect(backend.writes).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it('accepts a boxed native placeholder without sending startup keys', async () => {
    const backend = new TrustBackend(placeholderComposer);
    await prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
    expect(backend.writes).toEqual([]);
  });
  it('only enables screen-driven startup confirmation for Claude Code', () => {
    expect(createClaudeFamilyAdapter('claude-code').prepareInput).toBe(prepareClaudeFamilyInput);
    expect(createClaudeFamilyAdapter('seed').prepareInput).toBeUndefined();
    expect(createClaudeFamilyAdapter('relay').prepareInput).toBeUndefined();
  });

  it('full-trust changes No to Yes, confirms it, then waits for the composer', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(trustScreen('No, exit'));
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      await vi.advanceTimersByTimeAsync(300);
      expect(backend.writes).toEqual(['Down', 'Enter']);
      await preparing;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not move selection when Yes is already selected', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(trustScreen('Yes, I trust this folder'));
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      await vi.advanceTimersByTimeAsync(200);
      await preparing;
      expect(backend.writes).toEqual(['Enter']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries discarded startup keys only while the exact trust page remains selected', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(trustScreen('No, exit'));
      let downCount = 0;
      let enterCount = 0;
      backend.sendSpecialKeys = (...keys: string[]) => {
        backend.writes.push(...keys);
        if (keys[0] === 'Down' && ++downCount === 2) backend.screen = trustScreen('Yes, I trust this folder');
        if (keys[0] === 'Enter' && ++enterCount === 2) backend.screen = composer;
      };
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      await vi.advanceTimersByTimeAsync(2_200);
      await preparing;
      expect(backend.writes).toEqual(['Down', 'Down', 'Enter', 'Enter']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ask does not approve the trust dialog or submit any input', async () => {
    const backend = new TrustBackend(trustScreen('No, exit'));
    await expect(prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'ask' }))
      .rejects.toThrow('请通过终端确认目录');
    expect(backend.writes).toEqual([]);
  });

  it.each([2, 3])('ask recognizes a trust page whose cwd wraps across %i lines', async rows => {
    const width = Math.ceil(longCwd.length / rows);
    const screen = trustScreen('No, exit', wrapPath(longCwd, width));
    expect(screen.split('\n').length).toBe(trustScreen('No, exit').split('\n').length + rows - 1);
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(screen);
      let error: unknown;
      prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd: longCwd, permissionMode: 'ask' }).catch(reason => { error = reason; });
      await vi.advanceTimersByTimeAsync(200);
      expect(String(error)).toContain('Claude 正在确认此目录是否可信');
      expect(backend.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('full-trust trusts a wrapped cwd the same way as a one-line cwd', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(wrappedTrustScreen('No, exit'));
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd: longCwd, permissionMode: 'full-trust' });
      await vi.advanceTimersByTimeAsync(300);
      expect(backend.writes).toEqual(['Down', 'Enter']);
      await preparing;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['one extra character', wrappedTrustScreen('No, exit', `${longCwd}z`)],
    ['one missing character', wrappedTrustScreen('No, exit', longCwd.slice(0, -1))],
    ['a missing wrapped row', trustScreen('No, exit', wrapPath(longCwd, 118).split('\n').slice(0, -1).join('\n'))],
    ['another directory', wrappedTrustScreen('No, exit', longCwd.replace('memory-job', 'other-job'))],
    ['an unrelated row after the path', trustScreen('No, exit', `${wrapPath(longCwd, 118)}\nunrelated`)],
    ['an unrelated row inside the path', trustScreen('No, exit', wrapPath(longCwd, 118).replace('\n', '\nunrelated\n'))],
  ])('does not treat a wrapped cwd with %s as this trust page', async (_name, screen) => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(screen);
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd: longCwd, permissionMode: 'full-trust' });
      const assertion = expect(preparing).rejects.toThrow('启动尚未就绪（最后屏幕：目录信任页未能核对）');
      await vi.advanceTimersByTimeAsync(30_100);
      await assertion;
      expect(backend.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['目录信任页未能核对', trustScreen('No, exit', '/workspace/secret-other-project')],
    ['空白', ' \n\r\n\t\n'],
    ['未识别', 'Unknown setup secret-token-value\n────────\n❯\n────────'],
  ])('names the last screen as %s when startup times out, without echoing it', async (category, screen) => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(screen);
      let error: unknown;
      prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'ask' }).catch(reason => { error = reason; });
      await vi.advanceTimersByTimeAsync(30_100);
      expect(String(error)).toBe(`Error: Claude 启动尚未就绪（最后屏幕：${category}），请打开终端处理启动确认后再发送任务。`);
      expect(String(error)).not.toMatch(/secret|Unknown setup|workspace/);
      expect(backend.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['No, exit', 'Yes, I trust this folder'] as const)('names a recognized trust page whose keys never take effect (%s) as the trust page under full-trust', async selected => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(trustScreen(selected));
      backend.sendSpecialKeys = (...keys: string[]) => { backend.writes.push(...keys); };
      let error: unknown;
      prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' }).catch(reason => { error = reason; });
      await vi.advanceTimersByTimeAsync(30_100);
      expect(String(error)).toBe('Error: Claude 启动尚未就绪（最后屏幕：目录信任页未能核对），请打开终端处理启动确认后再发送任务。');
      expect(backend.writes.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['ask', undefined] as const)('accepts an already trusted composer with permission mode %s', async permissionMode => {
    const backend = new TrustBackend(composer.replace(/⏵⏵[^\n]*/g, '? for shortcuts'));
    await prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode });
    expect(backend.writes).toEqual([]);
  });

  it.each([resumedComposer, `❯ old request\nPrevious answer\n${resumedComposer}`])('accepts the captured resumed composer without a scrolled-away banner and writes no keys', async screen => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(screen);
      let ready = false;
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' }).then(() => { ready = true; });
      // Consume only in case the old predicate reaches its timeout after this assertion fails.
      void preparing.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).toBe(true);
      await preparing;
      expect(backend.writes).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('accepts a resumed composer whose footer carries right-aligned login text and a trailing update notice', async () => {
    const backend = new TrustBackend(`Previous answer\n${loggedOutFooter}`);
    await prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
    expect(backend.writes).toEqual([]);
  });

  it('requires a screen reader instead of blindly submitting', async () => {
    await expect(prepareClaudeFamilyInput({ write: () => {} }, { sessionId: 'sid', cwd, permissionMode: 'full-trust' }))
      .rejects.toThrow('screen reader');
  });

  it('does not carry a prior trust observation into a different dialog', async () => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(trustScreen('No, exit'));
      backend.sendSpecialKeys = (...keys: string[]) => {
        backend.writes.push(...keys);
        backend.screen = `${trustScreen('No, exit')}\n${trustScreen('Yes, I trust this folder', '/other-project')}`;
      };
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      const assertion = expect(preparing).rejects.toThrow('启动尚未就绪');
      await vi.advanceTimersByTimeAsync(30_100);
      await assertion;
      expect(backend.writes).toEqual(['Down']);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(blockingDialogs)('reports the recorded %s dialog at once without answering it', async (_name, screen) => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(screen);
      let error: unknown;
      prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' }).catch(reason => { error = reason; });
      await vi.advanceTimersByTimeAsync(200);
      expect(String(error)).toMatch(/^Error: Claude 启动停在“[^”]+”确认框，请在终端里选择后再发送任务。$/);
      expect(backend.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the external CLAUDE.md import dialog that stopped the memory job', async () => {
    const backend = new TrustBackend(blockingDialogs[0]![1]);
    await expect(prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'ask' }))
      .rejects.toThrow('Claude 启动停在“是否允许导入工作目录外的 CLAUDE.md”确认框，请在终端里选择后再发送任务。');
  });

  it.each([
    ['partial trust page', trustScreen('No, exit').replace('Enter to confirm · Esc to cancel', '')],
    ['unknown setup prompt', 'Unknown setup\n────────\n❯\n────────'],
    ['truncated resumed footer', resumedComposer.trimEnd().split('\n').slice(0, -1).join('\n')],
    ['unknown resumed footer', resumedComposer.replace(/⏵⏵[^\n]*/, 'Press Enter to continue')],
    ['unfinished composer', resumedComposer.replace('\n❯\n', '\n❯ unfinished input\n')],
    ['unboxed placeholder', placeholderComposer.replace(/─{120}/, 'partial')],
    ['incomplete placeholder', placeholderComposer.replace('Try "refactor <filepath>"', 'Try "refactor <filepath>')],
    ['ordinary draft', placeholderComposer.replace('Try "refactor <filepath>"', 'refactor this file')],
    ['permission menu above placeholder', `Permission required\n❯ 1. Yes\n  2. No\n${placeholderComposer}`],
    ['trust dialog above placeholder', `${trustScreen('No, exit')}\n${placeholderComposer}`],
    ['historical empty prompt alongside composer', `❯\n${resumedComposer}`],
    ['quoted historical composer followed by output', `${resumedComposer}More response text`],
    ['permission choice above stale composer', `Permission required\n❯ 1. Yes\n  2. No\n${resumedComposer}`],
    ['choice menu above stale composer', `Select an option\n❯ Continue\n${resumedComposer}`],
    ['trust dialog above stale composer', `${trustScreen('No, exit')}\n${resumedComposer}`],
  ])('does not treat a %s as ready or write any key', async (_name, screen) => {
    vi.useFakeTimers();
    try {
      const backend = new TrustBackend(screen);
      const preparing = prepareClaudeFamilyInput(backend, { sessionId: 'sid', cwd, permissionMode: 'full-trust' });
      const assertion = expect(preparing).rejects.toThrow('启动尚未就绪');
      await vi.advanceTimersByTimeAsync(30_100);
      await assertion;
      expect(backend.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Claude family idle screen', () => {
  const adapter = createClaudeFamilyAdapter('claude-code');
  it('recognizes the recorded two-line statusLine composer as idle', () => {
    expect(adapter.isIdleScreen!(statuslineComposer)).toBe(true);
  });
  it.each([
    statuslineComposer.replace('❯ ', '❯ unfinished draft'),
    statuslineComposer.replace('  Context ██░░░░░░░░ 18%', '❯ Continue'),
    statuslineComposer.replace('  Context ██░░░░░░░░ 18%', 'Enter to confirm'),
    statuslineComposer.replace('  Context ██░░░░░░░░ 18%', 'Permission required'),
    statuslineComposer.replace('  Context ██░░░░░░░░ 18%', 'Context 18%\nthird status row'),
  ])('keeps an unsubmitted draft or interactive/oversized footer non-idle: %s', screen => {
    expect(adapter.isIdleScreen!(screen)).toBe(false);
  });
  it.each(Object.entries(idleScreens))('recognizes the empty composer at the bottom (%s)', (_name, screen) => {
    expect(adapter.isIdleScreen!(`❯ old request\nPrevious answer\n${screen}`)).toBe(true);
  });
  it('accepts the startup placeholder composer', () => {
    expect(adapter.isIdleScreen!(placeholderComposer)).toBe(true);
  });
  it.each([
    ['an unsubmitted draft', idleScreens.clearHint.replace('❯\u00a0', '❯ 把参数补进单元')],
    ['a permission menu', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel'],
    ['a composer that is not at the bottom', `${idleScreens.manual}\nmore output\nline 2\nline 3\nline 4`],
    ['history only', '❯ old request\nPrevious answer'],
  ])('does not treat %s as idle', (_name, screen) => {
    expect(adapter.isIdleScreen!(screen)).toBe(false);
  });
});

describe('Claude family background job settings', () => {
  const sources = (adapter: ReturnType<typeof createClaudeFamilyAdapter>, env?: Record<string, string>) => {
    const args = adapter.buildArgs({ sessionId: 'ses_1', cwd, env });
    const index = args.indexOf('--setting-sources');
    return index < 0 ? undefined : args[index + 1];
  };
  it.each(['lark-memory', 'lark-decision', 'lark-response'])('loads only user settings for the %s job', source => {
    expect(sources(createClaudeFamilyAdapter('claude-code'), { dutydeck_session_source: source })).toBe('user');
  });
  it.each([undefined, 'lark', 'schedule', 'lark-leader'])('keeps project settings for %s sessions', source => {
    expect(sources(createClaudeFamilyAdapter('claude-code'), source ? { dutydeck_session_source: source } : undefined)).toBeUndefined();
  });
  it('does not pass the flag to Seed or Relay', () => {
    for (const id of ['seed', 'relay']) expect(sources(createClaudeFamilyAdapter(id), { dutydeck_session_source: 'lark-memory' })).toBeUndefined();
  });
});

describe('Claude family plan guard hook', () => {
  const adapter = createClaudeFamilyAdapter('claude-code');
  const settings = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]!);
  const guard = { matcher: claudePlanGuardMatcher, hooks: [{ type: 'command', command: 'guard', timeout: 30 }] };
  const relay = { dutydeck_relay_url: 'http://localhost/api/relay', dutydeck_relay_token: 't', dutydeck_relay_command: 'relay' };

  it('installs the guard without taking over permission prompts when there is no relay', () => {
    const args = adapter.buildArgs({ sessionId: 'ses_1', permissionMode: 'ask', planGuardCommand: 'guard' });
    expect(settings(args).hooks).toEqual({ PreToolUse: [guard] });
    // 原生计划模式拦不住 Bash 写操作，继续禁用；计划阶段靠守卫 hook。
    expect(args.slice(args.indexOf('--disallowed-tools'))).toEqual(['--disallowed-tools', 'EnterPlanMode,ExitPlanMode']);
  });

  it('keeps the question and permission hooks next to the guard when relayed', () => {
    const hooks = settings(adapter.buildArgs({ sessionId: 'ses_1', permissionMode: 'ask', env: relay, planGuardCommand: 'guard' })).hooks;
    expect(hooks.PreToolUse).toEqual([expect.objectContaining({ matcher: '^AskUserQuestion$' }), guard]);
    expect(hooks.PermissionRequest).toHaveLength(1);
  });

  it('puts the secret guard hook first in every permission mode once the session directory is known', () => {
    const secretGuard = { matcher: secretGuardToolMatcher, hooks: [{ type: 'command', command: secretGuardHookCommand({ policyRoot: cwd }), timeout: 10 }] };
    for (const permissionMode of ['ask', 'approve-reads', 'full-trust'] as const) {
      expect(settings(adapter.buildArgs({ sessionId: 'ses_1', permissionMode, cwd })).hooks.PreToolUse).toEqual([secretGuard]);
      expect(settings(adapter.buildArgs({ sessionId: 'ses_1', resume: true, resumeSessionId: 'ses_1', permissionMode, cwd, env: relay, planGuardCommand: 'guard' })).hooks.PreToolUse)
        .toEqual([secretGuard, expect.objectContaining({ matcher: '^AskUserQuestion$' }), guard]);
    }
    // 策略文件按会话目录定位，拿不到目录就不装，避免按 Agent 运行中的当前目录去找。
    expect(settings(adapter.buildArgs({ sessionId: 'ses_1', permissionMode: 'full-trust' })).hooks).toBeUndefined();
  });

  it('lets read-only tools skip the guard', () => {
    const matcher = new RegExp(claudePlanGuardMatcher);
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'Task', 'TodoWrite']) expect(matcher.test(tool)).toBe(false);
    for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__fs__write_file', 'ReadX', 'CronCreate']) expect(matcher.test(tool)).toBe(true);
  });
});

describe('Claude guard failure capability', () => {
  const directories: string[] = [];
  afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
  const temp = () => { const path = mkdtempSync(join(tmpdir(), 'claude-guard-capability-')); directories.push(path); return path; };
  const fakeClaude = (directory: string, version: string | undefined) => {
    const command = join(directory, 'claude');
    writeFileSync(command, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write(${JSON.stringify(version === undefined ? '' : `${version} (Claude Code)\n`)});\n`, { mode: 0o755 });
    chmodSync(command, 0o755);
    return command;
  };
  const runHook = (args: string[], options: { cwd: string; sessionId: string; bin: string; marker: string }) => {
    const value = args[args.indexOf('--settings') + 1]!;
    const result = spawnSync(process.execPath, [resolve(process.cwd(), 'tests/fixtures/claude-hook-runner.mjs'), '--settings', value, '--hook', 'secret-guard.mjs'], {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: `${options.bin}:${process.env.PATH ?? ''}`,
        dutydeck_session_id: options.sessionId,
        CLAUDE_HOOK_TEST_TOOL_MARKER: options.marker,
        CLAUDE_HOOK_TEST_TIMEOUT_MS: '40',
        CLAUDE_HOOK_TEST_EVENT: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `${'a'.repeat(100_000)}!` } }),
      },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    return JSON.parse(result.stdout);
  };

  it('blocks a secret-guard timeout through the generated PTY settings only when the capability is declared', async () => {
    const directory = temp();
    const cwd = join(directory, 'project');
    const bin = join(directory, 'bin');
    const sessions = join(cwd, '.dutydeck', 'security', 'sessions');
    mkdirSync(sessions, { recursive: true });
    mkdirSync(bin);
    const sessionId = 'ses_secret_timeout';
    writeFileSync(join(sessions, `${sessionId}.json`), JSON.stringify({ enabled: true, authorized: false, pattern: '(a+)+$' }));
    const command = fakeClaude(directory, '2.1.295');
    const adapter = createClaudeFamilyAdapter('claude-code');
    await adapter.prepareLaunch?.({ sessionId, command, cwd, permissionMode: 'full-trust' }, { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` } as Record<string, string>);
    const args = adapter.buildArgs({ sessionId, command, cwd, permissionMode: 'full-trust' });
    const marker = join(directory, 'tool-ran');
    const outcome = runHook(args, { cwd, sessionId, bin, marker });
    expect(outcome).toMatchObject({ timedOut: true, onFailure: 'block', blocked: true });
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps the old timeout fallback while retaining the wired secret guard on old Claude', async () => {
    const directory = temp();
    const cwd = join(directory, 'project');
    const bin = join(directory, 'bin');
    const sessions = join(cwd, '.dutydeck', 'security', 'sessions');
    mkdirSync(sessions, { recursive: true });
    mkdirSync(bin);
    const sessionId = 'ses_secret_timeout_old';
    writeFileSync(join(sessions, `${sessionId}.json`), JSON.stringify({ enabled: true, authorized: false, pattern: '(a+)+$' }));
    const command = fakeClaude(directory, '2.1.220');
    const adapter = createClaudeFamilyAdapter('claude-code');
    await adapter.prepareLaunch?.({ sessionId, command, cwd, permissionMode: 'full-trust' }, { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` } as Record<string, string>);
    const args = adapter.buildArgs({ sessionId, command, cwd, permissionMode: 'full-trust' });
    const marker = join(directory, 'tool-ran');
    const outcome = runHook(args, { cwd, sessionId, bin, marker });
    expect(outcome).toMatchObject({ timedOut: true, blocked: false });
    expect(outcome.onFailure).toBeUndefined();
    expect(existsSync(marker)).toBe(true);
  });

  it.each([
    ['2.1.220', false],
    ['2.1.295', true],
    ['2.1.323', true],
  ])('writes onFailure only for a probed supported Claude version: %s', async (version, supported) => {
    const directory = temp();
    const command = fakeClaude(directory, version);
    const adapter = createClaudeFamilyAdapter('claude-code');
    await adapter.prepareLaunch?.({ sessionId: 'ses_version', command, cwd: directory, permissionMode: 'ask' }, { ...process.env } as Record<string, string>);
    const args = adapter.buildArgs({ sessionId: 'ses_version', command, cwd, permissionMode: 'ask', planGuardCommand: 'plan-guard' });
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    for (const group of settings.hooks.PreToolUse) {
      for (const hook of group.hooks) expect(hook.onFailure === 'block').toBe(supported);
    }
  });

  it('caches the bounded capability probe for subsequent launches', async () => {
    const directory = temp();
    const count = join(directory, 'probe-count');
    const command = join(directory, 'claude');
    writeFileSync(command, `#!${process.execPath}\nif (process.argv.includes('--version')) { require('node:fs').appendFileSync(${JSON.stringify(count)}, '1'); process.stdout.write('2.1.295 (Claude Code)\\n'); }\n`, { mode: 0o755 });
    const adapter = createClaudeFamilyAdapter('claude-code');
    const context = { sessionId: 'ses_cached', command, cwd: directory, permissionMode: 'ask' as const };
    const env = { ...process.env } as Record<string, string>;
    await adapter.prepareLaunch?.(context, env);
    await adapter.prepareLaunch?.(context, env);
    expect(readFileSync(count, 'utf8')).toBe('1');
  });

  it('adds onFailure only to Dutydeck guards, not Ask or PermissionRequest hooks', async () => {
    const directory = temp();
    const command = fakeClaude(directory, '2.1.295');
    const adapter = createClaudeFamilyAdapter('claude-code');
    await adapter.prepareLaunch?.({ sessionId: 'ses_relay', command, cwd: directory, permissionMode: 'ask' }, { ...process.env } as Record<string, string>);
    const env = {
      dutydeck_session_source: 'lark', dutydeck_relay_url: 'http://localhost/api/relay',
      dutydeck_relay_token: 'fixture-token', dutydeck_relay_command: 'relay',
    };
    const args = adapter.buildArgs({ sessionId: 'ses_relay', command, cwd: directory, env, permissionMode: 'ask', planGuardCommand: 'plan-guard' });
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.hooks.PreToolUse.map((group: { matcher: string }) => group.hooks[0].onFailure)).toEqual(['block', undefined, 'block']);
    expect(settings.hooks.PermissionRequest[0].hooks[0].onFailure).toBeUndefined();
    expect(args.join(' ')).not.toContain('fixture-token');
  });

  it('does not treat an unknown fork or a failed version probe as supported', async () => {
    for (const output of ['2.1.323 (Unknown Fork)\n', 'not a version\n']) {
      const directory = temp();
      const command = join(directory, 'claude');
      writeFileSync(command, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, { mode: 0o755 });
      const adapter = createClaudeFamilyAdapter('claude-code');
      await adapter.prepareLaunch?.({ sessionId: 'ses_fork', command, cwd, permissionMode: 'ask' }, { ...process.env } as Record<string, string>);
      const args = adapter.buildArgs({ sessionId: 'ses_fork', command, cwd, permissionMode: 'ask' });
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
      expect(settings.hooks.PreToolUse[0].hooks[0].onFailure).toBeUndefined();
    }
  });
});
