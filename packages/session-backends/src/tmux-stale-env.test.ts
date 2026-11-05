import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { readFile, rm } from 'node:fs/promises';
import { runCommand } from './command.js';
import { TmuxBackend } from './tmux-backend.js';

vi.mock('./command.js', () => ({ runCommand: vi.fn() }));
describe('TmuxBackend stale global environment scrubbing (unit)', () => {
  let backend: TmuxBackend | null = null;
  const recordedCommands: string[][] = [];

  beforeEach(() => {
    recordedCommands.length = 0;
    vi.mocked(runCommand).mockImplementation(async (file: string, args: string[]) => {
      if (file === 'tmux' && args) {
        let command: string[] = [];
        for (const arg of args) {
          if (arg === ';') { recordedCommands.push(command); command = []; } else command.push(arg);
        }
        recordedCommands.push(command);
        const cmd = args[0];
        if (cmd === 'display-message') {
          return '/tmp/tmux-mock-test/default\n';
        }
        if (cmd === 'show-environment' && args.includes('-g')) {
          return [
            'STALE_ROUTE=stale_123',
            'ANTHROPIC_BASE_URL=https://api.stale.example',
            'CLAUDE_CUSTOM_VAR=stale_claude',
            'SHARED_GLOBAL_VAR=existing_in_global',
            'PATH=/usr/bin:/bin',
            'HOME=/home/test',
            '-ALREADY_REMOVED_VAR',
            '',
          ].join('\n');
        }
        return '';
      }
      return '';
    });
  });

  afterEach(() => {
    backend?.disposeCapture();
    backend = null;
    vi.clearAllMocks();
  });

  it('issues set-environment -r for variables present only in global env, and never for variables in child env', async () => {
    const sessionName = 'test-session-scrub';
    backend = new TmuxBackend(sessionName);

    await backend.spawn('/bin/sh', ['-c', 'echo test'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/test',
        SHARED_GLOBAL_VAR: 'existing_in_global',
        LOCAL_FRESH_VAR: 'fresh_val',
      },
    });

    // 筛选所有 set-environment 调用
    const setEnvCalls = recordedCommands.filter(args => args[0] === 'set-environment');

    // 找出所有发了 -r 的变量调用
    const removedCalls = setEnvCalls.filter(args => args.includes('-r'));
    const removedKeys = removedCalls.map(args => {
      // 最后一个参数是 key，或者 '--' 后的参数
      const dashDashIndex = args.indexOf('--');
      return dashDashIndex !== -1 ? args[dashDashIndex + 1] : args[args.length - 1];
    });

    // 断言对「只在全局环境里的变量」发了 -r
    expect(removedKeys).toContain('STALE_ROUTE');
    expect(removedKeys).toContain('ANTHROPIC_BASE_URL');
    expect(removedKeys).toContain('CLAUDE_CUSTOM_VAR');

    // 断言对每个 -r 命令都限定在当前 session 上 (-t <session>)，决不能修改全局环境 (-g)
    for (const call of removedCalls) {
      expect(call).toContain('-t');
      expect(call[call.indexOf('-t') + 1]).toBe(sessionName);
      expect(call).not.toContain('-g');
    }

    // 断言对「本次传入的变量」没有发 -r
    expect(removedKeys).not.toContain('SHARED_GLOBAL_VAR');
    expect(removedKeys).not.toContain('LOCAL_FRESH_VAR');
    expect(removedKeys).not.toContain('PATH');
    expect(removedKeys).not.toContain('HOME');
    // 对于原本已经以 '-' 开头的被 unset 变量，也不需要重复发 -r
    expect(removedKeys).not.toContain('ALREADY_REMOVED_VAR');

    // 本次传入的变量写进私有启动脚本，不经 tmux 命令行，也就不需要 stage/-u 清理
    expect(setEnvCalls.filter(args => !args.includes('-r'))).toEqual([]);
    const scriptPath = recordedCommands.find(command => command[0] === 'respawn-pane')!.at(-1)!;
    const script = await readFile(scriptPath, 'utf8');
    for (const [key, value] of [['PATH', '/usr/bin:/bin'], ['HOME', '/home/test'], ['SHARED_GLOBAL_VAR', 'existing_in_global'], ['LOCAL_FRESH_VAR', 'fresh_val']]) {
      expect(script).toContain(`${key}='${value}'; export ${key}\n`);
    }
    await rm(scriptPath.replace(/\/launch\.sh$/, ''), { recursive: true, force: true });
  });

  it('keeps environment values such as API keys out of every tmux client argv', async () => {
    backend = new TmuxBackend('test-session-env-argv');
    await backend.spawn('/bin/sh', ['-c', 'echo test'], {
      cwd: tmpdir(), cols: 80, rows: 24,
      env: { PATH: '/usr/bin:/bin', FAKE_API_KEY: 'sk-test-123', PROMPT_COMMAND: 'history -a;' },
    });
    expect(recordedCommands.flat().some(arg => arg.includes('sk-test-123') || arg.includes('history -a'))).toBe(false);
    const scriptPath = recordedCommands.find(command => command[0] === 'respawn-pane')!.at(-1)!;
    const script = await readFile(scriptPath, 'utf8');
    expect(script).toContain("FAKE_API_KEY='sk-test-123'; export FAKE_API_KEY\n");
    expect(script).toContain("PROMPT_COMMAND='history -a;'; export PROMPT_COMMAND\n");
    await rm(scriptPath.replace(/\/launch\.sh$/, ''), { recursive: true, force: true });
  });

  it('stages names a shell cannot export through tmux, keeping a trailing semicolon', async () => {
    backend = new TmuxBackend('test-session-env-odd-name');
    await backend.spawn('/bin/sh', ['-c', 'echo test'], {
      cwd: tmpdir(), cols: 80, rows: 24,
      env: { PATH: '/usr/bin:/bin', 'BASH_FUNC_f%%': '() { true;' },
    });
    const staged = recordedCommands.filter(args => args[0] === 'set-environment' && !args.includes('-r') && !args.includes('-u'));
    expect(staged).toEqual([['set-environment', '-t', 'test-session-env-odd-name', '--', 'BASH_FUNC_f%%', '() { true\\;']]);
    expect(recordedCommands.filter(args => args[0] === 'set-environment' && args.includes('-u')))
      .toEqual([['set-environment', '-u', '-t', 'test-session-env-odd-name', '--', 'BASH_FUNC_f%%']]);
    const scriptPath = recordedCommands.find(command => command[0] === 'respawn-pane')!.at(-1)!;
    expect(await readFile(scriptPath, 'utf8')).not.toContain('BASH_FUNC');
    await rm(scriptPath.replace(/\/launch\.sh$/, ''), { recursive: true, force: true });
  });

  it('recognizes injectEnv as part of childEnvironment and does not emit -r for it', async () => {
    const sessionName = 'test-session-inject-env';
    backend = new TmuxBackend(sessionName);

    await backend.spawn('/bin/sh', ['-c', 'echo test'], {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/test',
      },
      injectEnv: {
        SHARED_GLOBAL_VAR: 'injected_val',
      },
    });

    const setEnvCalls = recordedCommands.filter(args => args[0] === 'set-environment');
    const removedCalls = setEnvCalls.filter(args => args.includes('-r'));
    const removedKeys = removedCalls.map(args => {
      const dashDashIndex = args.indexOf('--');
      return dashDashIndex !== -1 ? args[dashDashIndex + 1] : args[args.length - 1];
    });

    // SHARED_GLOBAL_VAR 来自 injectEnv，属于本次传入环境，不能被 -r 移除
    expect(removedKeys).not.toContain('SHARED_GLOBAL_VAR');
    // 全局中存在的其他陈旧变量依然要发 -r
    expect(removedKeys).toContain('STALE_ROUTE');
  });

  it('passes long launch argv through a private script instead of the tmux command message', async () => {
    backend = new TmuxBackend('test-session-private-launch');
    const args = ['--model', 'm'.repeat(20_000), '--system', "quoted 'value'"];
    await backend.spawn('/opt/provider/agent', args, {
      cwd: tmpdir(), cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' }
    });
    const respawn = recordedCommands.find(command => command[0] === 'respawn-pane');
    expect(respawn).toEqual(['respawn-pane', '-k', '-t', 'test-session-private-launch', '-c', tmpdir(), '/bin/sh', expect.any(String)]);
    expect(respawn?.join(' ')).not.toContain('m'.repeat(100));
    const scriptPath = respawn?.at(-1)!;
    const script = await readFile(scriptPath, 'utf8');
    expect(script).toContain('rm -f -- "$0"');
    expect(script).toContain("'/opt/provider/agent'");
    expect(script).toContain("'quoted '\\\''value'");
    await rm(scriptPath.replace(/\/launch\.sh$/, ''), { recursive: true, force: true });
  });
});
