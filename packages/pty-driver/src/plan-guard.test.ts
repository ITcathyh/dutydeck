import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import type { AgentConfig, NormalizedDriverEvent, PermissionMode } from '@dutydeck/shared';
import { PtyBackend, type SessionBackend } from '@dutydeck/session-backends';
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

const gitPrefix = 'env GIT_ALLOW_PROTOCOL= git --no-pager --no-optional-locks -c core.fsmonitor=false -c log.showSignature=false -c format.pretty=medium';
const safeGit = (command: string) => command.replace(/^git /, gitPrefix + ' ');

const readOnly = [
  'ls -la', 'cat README.md', 'head -n 40 src/a.ts | nl', 'rg -n "plan" apps/server/src', 'grep -rn foo . 2>/dev/null',
  'find . -name "*.ts" -type f', 'git log --no-ext-diff --no-textconv --oneline -5', 'git -C repo status --short', 'git diff --no-ext-diff --no-textconv HEAD~1 -- a.ts', 'git branch -a',
  'git branch --list "feat/*"', 'git tag -l', 'git config --get user.name', 'git stash list --no-ext-diff --no-textconv', 'git worktree list',
  "sed -n '1,80p' src/index.ts", 'sed -n 10p a.txt', 'wc -l a b && echo done', 'cat a.txt > /dev/null 2>&1', 'jq .name package.json',
  'sort < input.txt | uniq -c', 'cd packages && ls', 'echo "a > b; rm -rf /"', 'tree -L 2', 'ls &>/dev/null', 'ls a || echo missing',
  'echo x >&2', 'echo x 2>&1 | head', 'ls src/*.ts', 'cat < src/a.ts', "grep -n 'a$' f", "sed -n '$p' f", "rg foo src --glob '*.ts'",
  "git log --no-ext-diff --no-textconv --format='%h %s' -3", 'git log --no-ext-diff --no-textconv --oneline', 'git branch --contains', 'stat -c %s a', 'date +%F',
  'git show --no-ext-diff --no-textconv HEAD:file.txt', 'git blame --no-textconv file.txt', 'git cat-file -p HEAD:file.txt',
  'git diff --no-ext-diff --no-textconv -- --textconv', 'git remote get-url origin',
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
  'git diff -- file.txt', 'git show --textconv HEAD:file.txt', 'git cat-file --filters HEAD:file.txt',
  'git diff --no-ext-diff --no-textconv --textconv', 'git diff --no-ext-diff --no-textconv --textc',
  'git diff --no-ext-diff --no-textconv --ext-diff', 'git diff --no-ext-diff --no-textconv --ext-d',
  'git diff -- --no-ext-diff --no-textconv', 'git diff --no-textconv', 'git diff --no-ext-diff',
  'git blame file.txt', 'git cat-file --filt HEAD:file.txt', 'git remote show origin',
  'git log --no-ext-diff --no-textconv --show-signature', 'git log --no-ext-diff --no-textconv --format=%G?',
  'git log --no-ext-diff --no-textconv --pretty=custom', 'git for-each-ref --format=%(signature:grade)', 'git for-each-ref --format=%(*signature:grade)',
  'git diff --no-ext-diff --no-textconv && git diff -- file.txt',
  'git branch --list --del x', 'git tag -l --del v1', 'date -s 2020-01-01', 'rg --hostname-bin=x foo', 'rg --pre-g=x foo', 'ls >&1x', 'echo x >&-x',
];

describe('plan guard Bash classifier', () => {
  it.each(['git status --short', 'git diff --no-ext-diff --no-textconv',
    gitPrefix.replace('env GIT_ALLOW_PROTOCOL= ', '') + ' status',
    gitPrefix.replace('GIT_ALLOW_PROTOCOL=', 'GIT_ALLOW_PROTOCOL=fixture') + ' status',
    gitPrefix.replace('env ', 'env -i ') + ' status',
    gitPrefix.replace(' git ', ' node ') + ' status',
    gitPrefix.replace(' git ', ' PATH=/tmp git ') + ' status',
    'env GIT_ALLOW_PROTOCOL= sh -c true', 'env GIT_ALLOW_PROTOCOL= ls',
    'env GIT_ALLOW_PROTOCOL= env git status',
    gitPrefix.replace('--no-pager ', '') + ' status', gitPrefix.replace('--no-optional-locks ', '') + ' status',
    gitPrefix.replace('-c core.fsmonitor=false ', '') + ' status', gitPrefix + ' -c core.fsmonitor=./monitor status'])('requires the safe Git configuration in %j', command => {
    expect(planGuardAllowsBash(command)).toBe(false);
  });
  it.each(readOnly.map(safeGit))('allows read-only %j', command => { expect(planGuardAllowsBash(command)).toBe(true); });
  it.each(writes.map(safeGit))('rejects %j', command => { expect(planGuardAllowsBash(command)).toBe(false); });
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
    expect(run(command, { tool_name: 'Bash', tool_input: { command: safeGit('git status --short') } }).status).toBe(0);
    const edit = run(command, { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } });
    expect([edit.status, edit.stderr]).toEqual([2, planGuardToolReason]);
    expect(run(command, 'not json').status).toBe(2);

    settings.setPlanGuard(false);
    expect(run(command, touch).status).toBe(0);
  });

  it('blocks configured Git programs and keeps explicit safe reads usable', async () => {
    const cwd = temp(), marker = join(cwd, 'marker'), program = join(cwd, 'program.sh');
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith('GIT_') && entry[1] !== undefined));
    env.HOME = cwd;
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    git('init', '-q');
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(program, '#!/bin/sh\nprintf invoked >> "' + marker + '"\nprintf converted\n', { mode: 0o755 });
    writeFileSync(join(cwd, '.gitattributes'), 'file.txt diff=fixture filter=fixture\n');
    writeFileSync(join(cwd, 'file.txt'), 'before\n');
    git('add', '.gitattributes', 'file.txt'); git('commit', '-qm', 'fixture');
    git('config', 'diff.fixture.textconv', program);
    git('config', 'filter.fixture.smudge', program);
    writeFileSync(join(cwd, 'file.txt'), 'after\n');
    const hook = join(cwd, 'guard.mjs'); writeFileSync(hook, planGuardScript());
    const guarded = (command: string) => {
      const result = spawnSync(process.execPath, [hook], { cwd, env, encoding: 'utf8',
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }) });
      if (result.status === 0) {
        const execution = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8' });
        expect(execution.status, execution.stderr).toBe(0);
        return execution.stdout;
      }
      expect(result.status).toBe(2);
      return undefined;
    };
    for (const command of ['diff -- file.txt', 'show --textconv HEAD:file.txt', 'cat-file --filters HEAD:file.txt']) {
      git(...command.split(' '));
      expect(existsSync(marker)).toBe(true); rmSync(marker);
      expect(guarded('git ' + command)).toBeUndefined();
      expect(guarded(safeGit('git ' + command))).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    }
    git('config', 'diff.external', program);
    git('diff', '--no-textconv', '--', 'file.txt');
    expect(existsSync(marker)).toBe(true); rmSync(marker);
    // fsmonitor can run even when the diff conversion switches are disabled.
    git('config', 'core.fsmonitor', program);
    git('status', '--short'); expect(existsSync(marker)).toBe(true); rmSync(marker);
    git('diff', '--no-ext-diff', '--no-textconv'); expect(existsSync(marker)).toBe(true); rmSync(marker);
    expect(guarded(safeGit('git status --short'))).toContain('file.txt');
    expect(guarded(safeGit('git diff --no-ext-diff --no-textconv -- file.txt'))).toContain('-before\n+after');
    expect(guarded(safeGit('git show --no-ext-diff --no-textconv HEAD:file.txt'))).toBe('before\n');
    expect(guarded(safeGit('git cat-file -p HEAD:file.txt'))).toBe('before\n');
    expect(existsSync(marker)).toBe(false);
    // An active remote query runs a transport helper; reading its URL does not.
    const helper = join(cwd, 'git-remote-fixture');
    writeFileSync(helper, '#!/bin/sh\nprintf invoked >> "' + marker + '"\n', { mode: 0o755 });
    env.PATH = cwd + ':' + env.PATH;
    git('remote', 'add', 'origin', 'fixture::example');
    spawnSync('git', ['remote', 'show', 'origin'], { cwd, env, encoding: 'utf8' });
    expect(existsSync(marker)).toBe(true); rmSync(marker);
    expect(guarded(safeGit('git remote show origin'))).toBeUndefined();
    expect(guarded(safeGit('git remote get-url origin'))).toBe('fixture::example\n');
    expect(existsSync(marker)).toBe(false);
    // A synthetic signature is enough to exercise Git's verifier launch; no
    // real key or signing process is used.
    const commit = git('cat-file', 'commit', 'HEAD').replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n\n');
    const object = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd, env, input: commit, encoding: 'utf8' });
    expect(object.status).toBe(0); git('update-ref', 'HEAD', object.stdout.trim());
    git('config', 'gpg.program', program); git('config', 'log.showSignature', 'true');
    git('log', '-1'); expect(existsSync(marker)).toBe(true); rmSync(marker);
    expect(guarded(safeGit('git log --no-ext-diff --no-textconv -1'))).toContain('fixture');
    expect(existsSync(marker)).toBe(false);
    git('config', 'log.showSignature', 'false');
    git('log', '-1', '--format=%G?'); expect(existsSync(marker)).toBe(true); rmSync(marker);
    git('config', 'pretty.custom', '%G?'); git('config', 'format.pretty', 'custom');
    git('log', '-1'); expect(existsSync(marker)).toBe(true); rmSync(marker);
    expect(guarded(safeGit('git log --no-ext-diff --no-textconv -1'))).toContain('fixture');
    expect(existsSync(marker)).toBe(false);
    git('config', 'format.pretty', 'medium'); git('config', 'core.pager', program);
    const terminal = new PtyBackend();
    cleanups.push(() => terminal.kill());
    terminal.spawn('git', ['log', '-1'], { cwd, env: { ...env, TERM: 'xterm-256color' }, cols: 80, rows: 24 });
    await new Promise<void>(resolve => terminal.onExit(() => resolve()));
    expect(existsSync(marker)).toBe(true); rmSync(marker);
    // Run the approved safe log under the same real PTY, where Git would
    // otherwise enable its configured pager.
    const safeCommand = safeGit('git log --no-ext-diff --no-textconv -1');
    expect(guarded(safeCommand)).toContain('fixture');
    const safeTerminal = new PtyBackend();
    cleanups.push(() => safeTerminal.kill());
    safeTerminal.spawn('sh', ['-c', safeCommand], { cwd, env: { ...env, TERM: 'xterm-256color' }, cols: 80, rows: 24 });
    await new Promise<void>(resolve => safeTerminal.onExit(() => resolve()));
    expect(existsSync(marker)).toBe(false);
  });

  it('blocks implicit promisor fetches before starting a remote helper', () => {
    const cwd = temp(), marker = join(cwd, 'marker');
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith('GIT_') && entry[1] !== undefined));
    Object.assign(env, { HOME: cwd, XDG_CONFIG_HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', PATH: cwd + ':' + env.PATH });
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    writeFileSync(join(cwd, 'git-remote-fixture'), '#!/bin/sh\nprintf invoked > "' + marker + '"\n', { mode: 0o755 });
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(cwd, 'file.txt'), 'promised blob\n');
    git('add', 'file.txt'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const missing = git('rev-parse', 'HEAD:file.txt');
    git('config', 'core.repositoryformatversion', '1'); git('config', 'extensions.partialClone', 'origin');
    git('config', 'remote.origin.url', 'fixture::example'); git('config', 'remote.origin.promisor', 'true');
    const hook = join(cwd, 'guard.mjs'); writeFileSync(hook, planGuardScript());
    const command = safeGit('git cat-file -p HEAD:file.txt');
    const previous = command.replace('env GIT_ALLOW_PROTOCOL= ', '');
    const gate = (command: string) => spawnSync(process.execPath, [hook], { cwd, env, encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }) });
    const execute = (command: string) => spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8' });
    // While all objects are local, the new prefix preserves normal reads.
    for (const read of ['git status --short', 'git diff --no-ext-diff --no-textconv HEAD', 'git log --no-ext-diff --no-textconv --oneline -1']) {
      const safe = safeGit(read);
      expect(gate(safe).status).toBe(0);
      const result = execute(safe); expect(result.status, result.stderr).toBe(0);
    }
    expect(gate(command).status).toBe(0); expect(execute(command).stdout).toBe('promised blob\n');
    expect(existsSync(marker)).toBe(false);
    rmSync(join(cwd, '.git', 'objects', missing.slice(0, 2), missing.slice(2)));
    // Establish that the previous approved command really launches the helper,
    // including when the repository explicitly allows that custom protocol.
    for (const always of [false, true]) {
      if (always) git('config', 'protocol.fixture.allow', 'always');
      const old = execute(previous);
      expect(old.status).not.toBe(0); expect(existsSync(marker)).toBe(true); rmSync(marker);
      expect(gate(previous).status).toBe(2);
      expect(gate(command).status).toBe(0);
      const blocked = execute(command);
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("transport 'fixture' not allowed");
      expect(existsSync(marker)).toBe(false);
    }
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
    kind: 'pty', spawn(_command, args) { spawned.args = args; }, write() {}, interrupt() {}, resize() {}, kill() {}, onData() {}, onExit() {},
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
