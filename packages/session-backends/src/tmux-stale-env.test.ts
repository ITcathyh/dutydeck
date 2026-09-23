import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { TmuxBackend } from './tmux-backend.js';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFileSync: vi.fn(),
    spawn: vi.fn((cmd: string, args: string[], opts: unknown) => {
      if (cmd === 'tail') {
        const fakeChild = new EventEmitter() as any;
        fakeChild.stdout = new EventEmitter();
        fakeChild.kill = vi.fn();
        fakeChild.pid = 99999;
        return fakeChild;
      }
      return original.spawn(cmd, args as any, opts as any);
    }),
  };
});

describe('TmuxBackend stale global environment scrubbing (unit)', () => {
  let backend: TmuxBackend | null = null;
  const recordedCommands: string[][] = [];

  beforeEach(() => {
    recordedCommands.length = 0;
    vi.mocked(execFileSync).mockImplementation(((file: string, args?: readonly string[], _options?: unknown) => {
      if (file === 'tmux' && args) {
        recordedCommands.push([...args]);
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
    }) as typeof execFileSync);
  });

  afterEach(() => {
    backend?.disposeCapture();
    backend = null;
    vi.clearAllMocks();
  });

  it('issues set-environment -r for variables present only in global env, and never for variables in child env', () => {
    const sessionName = 'test-session-scrub';
    backend = new TmuxBackend(sessionName);

    backend.spawn('/bin/sh', ['-c', 'echo test'], {
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

    // 现有的 session 设置与清理语义保持不变：
    // 本次传入的变量被 stage (不带 -r 和 -u)
    const stagedCalls = setEnvCalls.filter(args => !args.includes('-r') && !args.includes('-u'));
    const stagedKeys = stagedCalls.map(args => {
      const idx = args.indexOf('--');
      return idx !== -1 ? args[idx + 1] : undefined;
    });
    expect(stagedKeys).toEqual(expect.arrayContaining(['PATH', 'HOME', 'SHARED_GLOBAL_VAR', 'LOCAL_FRESH_VAR']));

    // 本次传入的变量在 respawn 后被 clearSessionEnvironment 清理 (带 -u)
    const unsetCalls = setEnvCalls.filter(args => args.includes('-u'));
    const unsetKeys = unsetCalls.map(args => {
      const idx = args.indexOf('--');
      return idx !== -1 ? args[idx + 1] : undefined;
    });
    expect(unsetKeys).toEqual(expect.arrayContaining(['PATH', 'HOME', 'SHARED_GLOBAL_VAR', 'LOCAL_FRESH_VAR']));
  });

  it('recognizes injectEnv as part of childEnvironment and does not emit -r for it', () => {
    const sessionName = 'test-session-inject-env';
    backend = new TmuxBackend(sessionName);

    backend.spawn('/bin/sh', ['-c', 'echo test'], {
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
});
