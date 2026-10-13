import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import type { AgentConfig, NormalizedDriverEvent, PermissionMode } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { ClaudeSettings } from './claude-settings.js';
import { PtyCliDriver } from './driver.js';
import { planGuardAllowsBash, planGuardBashReason, planGuardScript, planGuardToolReason } from './plan-guard.js';

const directories: string[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'dutydeck-plan-guard-')); directories.push(path); return path; };

const readOnly = [
  'ls -la', 'cat README.md', 'head -n 40 src/a.ts | nl', 'rg -n "plan" apps/server/src', 'grep -rn foo . 2>/dev/null',
  'find . -name "*.ts" -type f', 'git log --oneline -5', 'git -C repo status --short', 'git diff HEAD~1 -- a.ts', 'git branch -a',
  'git branch --list "feat/*"', 'git tag -l', 'git config --get user.name', 'git stash list', 'git worktree list',
  "sed -n '1,80p' src/index.ts", 'sed -n 10p a.txt', 'wc -l a b && echo done', 'cat a.txt > /dev/null 2>&1', 'jq .name package.json',
  'sort < input.txt | uniq -c', 'cd packages && ls', 'echo "a > b; rm -rf /"', 'tree -L 2', 'ls &>/dev/null', 'ls a || echo missing',
  'echo x >&2', 'echo x 2>&1 | head', 'ls src/*.ts', 'cat < src/a.ts', "grep -n 'a$' f", "sed -n '$p' f", "rg foo src --glob '*.ts'",
  "git log --format='%h %s' -3", 'git log --oneline', 'git branch --contains', 'stat -c %s a', 'date +%F',
];
const writes = [
  'touch a.txt', 'rm -rf build', 'echo hi > a.txt', 'echo hi >> a.txt', 'cat a 2> err.log', 'ls &> out.txt', 'cat <<EOF > a\nx\nEOF',
  'echo $(touch a)', 'echo `touch a`', 'diff <(ls) b', 'sleep 1 &', 'FOO=1 ls', '/bin/rm a', './build.sh', 'node -e "1"', 'pnpm test',
  'python3 a.py', 'find . -delete', 'find . -exec rm {} \;', 'sed -i s/a/b/ f', "sed -n 'w out' f", "sed -ni '1p' f", "sed -n -e '1p' f",
  'sort -o out in', 'sort -uo out in', 'uniq in out', 'tree -o out.txt', 'tree -R -H . ', 'rg --pre ./x foo', 'git commit -m x',
  'git checkout main', 'git branch -D x', 'git branch new', 'git tag v1', 'git tag -d v1', 'git -c core.pager=x log', 'git diff --output=x',
  'git config user.name x', 'git stash', 'git remote add o u', 'env FOO=1 ls', 'xargs rm < list', 'ls | xargs rm', '{ ls; }', '(touch a)',
  'echo "unterminated', '', 'cat a; touch b', 'ls && touch b', 'ls || touch b', 'ls\ntouch b',
  // 审查找到的绕过（bash / zsh 实跑都能写文件或执行命令）。
  'echo x | uniq - out.txt', 'echo x >&2out.txt', "printf -v x '\\x24(touch f)'; echo ${x@P}", "printf -v x '\\x24(touch f)'; echo ${(e)x}",
  'cat =(touch f)', "ls *(e:'touch f':)",
  // 同类：展开、注释、下标求值、只有重定向的命令、通配符变选项、长选项缩写、描述符复制后跟文件名。
  "echo '$(touch f)'", 'echo $HOME', 'echo "$HOME"', 'echo ${HOME}', "echo $'a'", "test -v 'a[$(touch f)]'", 'test -f a', '[ -f a ]', "stat -A 'a[$(touch f)]' f",
  "ls #'\ntouch b #'", 'cat <*(e:touch:)', "cat <'a b'", '< a.txt', 'ls; < a.txt', 'ls {a,b}', 'rg foo *', 'find * -name x', 'sed -n 1p *',
  'uniq src/in*', 'uniq -- a b', 'sort --out=x in', 'sort --co=sh in', 'sort -to out in', 'git diff --outp=x', 'git grep -nOvi x',
  'git branch --list --del x', 'git tag -l --del v1', 'date -s 2020-01-01', 'rg --hostname-bin=x foo', 'rg --pre-g=x foo', 'ls >&1x', 'echo x >&-x',
];

describe('plan guard Bash classifier', () => {
  it.each(readOnly)('allows read-only %j', command => { expect(planGuardAllowsBash(command)).toBe(true); });
  it.each(writes)('rejects %j', command => { expect(planGuardAllowsBash(command)).toBe(false); });
});

describe('plan guard hook command', () => {
  const run = (command: string, input: unknown) => spawnSync('sh', ['-c', command], { input: JSON.stringify(input), encoding: 'utf8' });

  it('is a no-op while no plan is running and blocks writes once the script exists', () => {
    const settings = new ClaudeSettings('claude-code', randomUUID());
    cleanups.push(() => settings.cleanup());
    const command = settings.planGuardCommand();
    const touch = { tool_name: 'Bash', tool_input: { command: 'touch a.txt' } };
    expect(run(command, touch).status).toBe(0);

    settings.setPlanGuard(true);
    const script = readFileSync(command.match(/'([^']+plan-guard\.mjs)'/)![1]!, 'utf8');
    expect(script).toBe(planGuardScript());
    const blocked = run(command, touch);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toBe(planGuardBashReason);
    expect(run(command, { tool_name: 'Bash', tool_input: { command: 'git status --short' } }).status).toBe(0);
    const edit = run(command, { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } });
    expect([edit.status, edit.stderr]).toEqual([2, planGuardToolReason]);
    expect(run(command, 'not json').status).toBe(2);

    settings.setPlanGuard(false);
    expect(run(command, touch).status).toBe(0);
  });

  it('denies when the guard script cannot run', () => {
    const settings = new ClaudeSettings('claude-code', randomUUID());
    cleanups.push(() => settings.cleanup());
    settings.setPlanGuard(true);
    expect(run(settings.planGuardCommand('/nonexistent/node'), { tool_name: 'Bash', tool_input: { command: 'ls' } }).status).toBe(2);
  });

  it('writes the script privately and only reports a CLI as guarded when its settings carry the hook', () => {
    const cwd = temp();
    const sessionId = randomUUID();
    const settings = new ClaudeSettings('claude-code', sessionId);
    cleanups.push(() => settings.cleanup());
    settings.setPlanGuard(true);
    const script = settings.planGuardCommand().match(/'([^']+plan-guard\.mjs)'/)![1]!;
    expect(statSync(script).mode & 0o777).toBe(0o600);
    const guarded = createCliAdapter('claude-code').buildArgs({ sessionId, permissionMode: 'ask', planGuardCommand: settings.planGuardCommand() });
    expect(settings.planGuardWired(guarded, cwd)).toBe(true);
    expect(settings.planGuardWired(createCliAdapter('claude-code').buildArgs({ sessionId, permissionMode: 'ask' }), cwd)).toBe(false);
    // 接管的旧终端没有启动参数：只能看会话目录里的设置文件；没有就不能担保。
    expect(settings.planGuardWired([], cwd)).toBe(false);
  });
});

describe('PTY driver plan phase', () => {
  const backend = (spawned: { args: string[] }): SessionBackend => ({
    kind: 'pty', spawn(_command, args) { spawned.args = args; }, write() {}, resize() {}, kill() {}, onData() {}, onExit() {},
  });
  function fixture(adapterId: string, permissionMode: PermissionMode, env: Record<string, string> = {}) {
    const cwd = temp();
    const spawned = { args: [] as string[] };
    const events: NormalizedDriverEvent[] = [];
    const agent: AgentConfig = { id: adapterId, name: adapterId, command: 'unused', args: [], protocol: 'pty-cli', cwd, env,
      permissionMode, timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
    const driver = new PtyCliDriver({ agent, adapter: createCliAdapter(adapterId), backend: backend(spawned), sessionId: `ses_${randomUUID()}`,
      onEvent: event => events.push(event), onExit() {} });
    cleanups.push(() => driver.stop());
    const settings = (driver as unknown as { claudeSettings: ClaudeSettings }).claudeSettings;
    const guardPath = settings.planGuardCommand().match(/'([^']+plan-guard\.mjs)'/)![1]!;
    return { driver, spawned, events, guardPath, internals: driver as unknown as { turnActive: boolean; started: boolean; lastArgs: string[] } };
  }
  const composed = (args: string[]) => {
    const value = args[args.indexOf('--settings') + 1]!;
    return JSON.parse(value.startsWith('{') ? value : readFileSync(value, 'utf8'));
  };

  it('starts a deny-all task with the session mode and the guard hook, and blocks writes', async () => {
    const { driver, spawned, guardPath } = fixture('claude-code', 'deny-all', { dutydeck_session_permission_mode: 'full-trust', dutydeck_session_source: 'lark' });
    expect(existsSync(guardPath)).toBe(true);
    await driver.start();
    // CLI 仍按会话本身的完全信任启动：批准后同一个终端直接执行，不用重启。
    expect(spawned.args).toContain('--dangerously-skip-permissions');
    const hooks = composed(spawned.args).hooks.PreToolUse;
    expect(hooks).toContainEqual(expect.objectContaining({ hooks: [expect.objectContaining({ command: expect.stringContaining(guardPath) })] }));
    expect(spawned.args).toContain('EnterPlanMode,ExitPlanMode');
  });

  it('rejects CLI permission prompts during the plan phase without asking anyone', async () => {
    const { driver, events, internals } = fixture('claude-code', 'deny-all');
    internals.turnActive = true;
    const handle = driver.requestPermission!({ title: 'Run', operation: { source: 'claude_permission_hook', kind: 'execute', command: 'touch a' } })!;
    expect(await handle.decision).toMatchObject({ approved: false, reason: expect.stringContaining('先出计划') });
    expect(events).toEqual([]);
  });

  it('switches between the plan phase and the session mode without restarting the CLI', async () => {
    const { driver, spawned, guardPath, events, internals } = fixture('claude-code', 'ask');
    await driver.start();
    expect(existsSync(guardPath)).toBe(false);
    expect(composed(spawned.args).hooks.PreToolUse.some((hook: { hooks: { command: string }[] }) => hook.hooks[0]!.command.includes(guardPath))).toBe(true);
    driver.setPermissionMode!('deny-all');
    expect(existsSync(guardPath)).toBe(true);
    driver.setPermissionMode!('ask');
    expect(existsSync(guardPath)).toBe(false);
    internals.turnActive = true;
    driver.requestPermission!({ title: 'Run', operation: { source: 'claude_permission_hook', kind: 'execute', command: 'touch a' } });
    expect(events).toHaveLength(1);
    expect(() => driver.setPermissionMode!('full-trust')).toThrow(expect.objectContaining({ code: 'TASK_OPTIONS_UNSUPPORTED' }));
  });

  it('refuses the plan phase on a reattached CLI that was started without the guard hook', async () => {
    const { driver, guardPath, internals } = fixture('claude-code', 'ask');
    internals.started = true; internals.lastArgs = [];
    expect(() => driver.setPermissionMode!('deny-all')).toThrow(expect.objectContaining({ code: 'PLAN_GUARD_UNAVAILABLE', statusCode: 409 }));
    expect(existsSync(guardPath)).toBe(false);
  });

  it('accepts a reattached CLI whose session settings carry the guard hook', async () => {
    const { driver, guardPath, internals } = fixture('claude-code', 'ask', { dutydeck_terminal_backend: 'tmux' });
    await driver.start();
    internals.lastArgs = [];
    driver.setPermissionMode!('deny-all');
    expect(existsSync(guardPath)).toBe(true);
  });

  it('cannot enforce the plan phase for CLIs without hooks', async () => {
    const { driver } = fixture('codex', 'deny-all');
    expect(driver.setPermissionMode).toBeUndefined();
    await expect(driver.start()).rejects.toThrow(/deny-all/);
  });

  it('clears a guard left by an earlier driver when the next task runs normally', () => {
    const sessionId = `ses_${randomUUID()}`;
    const earlier = new ClaudeSettings('claude-code', sessionId);
    earlier.setPlanGuard(true);
    const path = earlier.planGuardCommand().match(/'([^']+plan-guard\.mjs)'/)![1]!;
    cleanups.push(() => rmSync(path.replace(/\/plan-guard\.mjs$/, ''), { recursive: true, force: true }));
    writeFileSync(path, planGuardScript());
    const agent: AgentConfig = { id: 'claude-code', name: 'c', command: 'unused', args: [], protocol: 'pty-cli', cwd: temp(), env: {},
      permissionMode: 'ask', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
    const driver = new PtyCliDriver({ agent, adapter: createCliAdapter('claude-code'), backend: backend({ args: [] }), sessionId, onEvent() {}, onExit() {} });
    cleanups.push(() => driver.stop());
    expect(existsSync(path)).toBe(false);
  });
});
