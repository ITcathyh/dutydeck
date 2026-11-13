import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { childEnvironment } from '@dutydeck/shared/child-environment';
import { createCliUi, type CliUiTarget } from '../cli-ui.js';
import { DOCTOR_CONFIG_KEYS, TERMINAL_BACKEND_CONFIG_KEY, checkTerminalBackend, planTerminalBackend } from './checks.js';
import { runDoctor } from './doctor.js';
import { defaultTerminalBackendProbe } from './terminal-backend.js';
import type { DoctorConfig, DoctorDependencies, DoctorReport, TerminalBackendProbeResult } from './types.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  // 这里只清假 tmux 的目录。真实 tmux 若清理失败，其 socket 根必须由同一私有 socket 确认退出后才能删。
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function target(): CliUiTarget {
  return { write() {}, isTTY: false };
}

const ptyAgent: DoctorConfig['agents'][number] = { id: 'pty', name: 'PTY', command: 'pty', protocol: 'pty-cli' };
const acpAgent: DoctorConfig['agents'][number] = { id: 'acp', name: 'ACP', command: 'acp', protocol: 'acp' };
const baseConfig: DoctorConfig = {
  host: '127.0.0.1',
  port: 4310,
  authEnabled: true,
  databaseUrl: '/tmp/dutydeck-terminal-doctor/.dutydeck/dutydeck.db',
  agents: [ptyAgent]
};
const probeOk = (): TerminalBackendProbeResult => ({ status: 'ok', version: 'tmux 3.4' });

function dependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    ui: createCliUi({ stdout: target(), stderr: target(), color: false, env: {} }),
    env: { PATH: '/test/bin' },
    nodeVersion: 'v22.12.0',
    platform: 'linux',
    username: 'tester',
    getuid: () => 1000,
    processUid: () => 1000,
    config: baseConfig,
    daemonStatus: () => ({ running: true, pid: 4242, ready: true, address: 'http://127.0.0.1:4310', authEnabled: true }),
    daemonRecord: () => ({ pid: 4242, ready: true, host: '127.0.0.1', port: 4310, authEnabled: true, database: baseConfig.databaseUrl }),
    databaseProbe: () => ({ exists: true, appliedVersion: 14, values: {} }),
    expectedSchemaVersion: 14,
    agentProbe: async () => ({ status: 'ok', version: 'agent 1.0' }),
    terminalBackendProbe: async () => probeOk(),
    portProbe: async () => 'occupied',
    exists: () => true,
    access: async () => undefined,
    stat: async () => ({ mode: 0o40700 }),
    autostartStatus: async () => ({ state: { platform: 'linux', supported: true, enabled: true, lingerEnabled: true } }),
    pluginChecks: async () => [],
    ...overrides
  };
}

function check(report: DoctorReport, id: string) {
  return report.checks.find(item => item.id === id);
}

describe('terminal.backend 配置判定与分级', () => {
  it('PTY Agent 需要 tmux；读取设置键并注入独立超时与环境', async () => {
    const terminalBackendProbe = vi.fn(async () => probeOk());
    let readKeys: readonly string[] = [];
    const report = await runDoctor({ json: true }, dependencies({
      terminalBackendProbe,
      terminalBackendProbeTimeoutMs: 2345,
      databaseProbe: (_path, keys) => {
        readKeys = keys;
        return { exists: true, appliedVersion: 14, values: {} };
      }
    }));
    expect(readKeys).toContain(TERMINAL_BACKEND_CONFIG_KEY);
    expect(DOCTOR_CONFIG_KEYS).toContain(TERMINAL_BACKEND_CONFIG_KEY);
    expect(terminalBackendProbe).toHaveBeenCalledWith(2345, { PATH: '/test/bin' });
    expect(check(report, 'terminal.backend')).toMatchObject({ level: 'ok', detail: expect.stringContaining('tmux 3.4') });
  });

  it('非空且全部为 ACP 时只提示，不执行 probe，也不致命', async () => {
    const terminalBackendProbe = vi.fn(async () => probeOk());
    const report = await runDoctor({ json: true }, dependencies({
      config: { ...baseConfig, agents: [acpAgent, { ...acpAgent, id: 'acpx', protocol: 'acpx' }] },
      terminalBackendProbe
    }));
    expect(terminalBackendProbe).not.toHaveBeenCalled();
    expect(check(report, 'terminal.backend')).toMatchObject({ level: 'info', detail: expect.stringContaining('未执行') });
  });

  it('混合 ACP 与 PTY 时，只要有一个 PTY 就需要终端后端', () => {
    expect(planTerminalBackend({ agents: [acpAgent, ptyAgent], database: { exists: true } })).toEqual({ action: 'probe', backend: 'tmux' });
  });

  it('空 Agent 保守检查默认 tmux，缺失时可 fail', async () => {
    const terminalBackendProbe = vi.fn(async (): Promise<TerminalBackendProbeResult> => ({ status: 'not_found' }));
    const report = await runDoctor({ json: true }, dependencies({
      config: { ...baseConfig, agents: [] },
      terminalBackendProbe
    }));
    expect(terminalBackendProbe).toHaveBeenCalledOnce();
    expect(check(report, 'terminal.backend')).toMatchObject({ level: 'fail', remedy: expect.stringMatching(/安装.*PATH|PATH.*安装/) });
  });

  it('无库与缺键默认 tmux；herdr 明确跳过且不执行 tmux smoke', async () => {
    const noDatabaseProbe = vi.fn(async () => probeOk());
    const noDatabase = await runDoctor({ json: true }, dependencies({
      databaseProbe: () => ({ exists: false }),
      terminalBackendProbe: noDatabaseProbe
    }));
    expect(noDatabaseProbe).toHaveBeenCalledOnce();
    expect(check(noDatabase, 'terminal.backend')?.level).toBe('ok');

    const herdrProbe = vi.fn(async () => probeOk());
    const herdr = await runDoctor({ json: true }, dependencies({
      databaseProbe: () => ({ exists: true, appliedVersion: 14, values: { [TERMINAL_BACKEND_CONFIG_KEY]: 'herdr' } }),
      terminalBackendProbe: herdrProbe
    }));
    expect(herdrProbe).not.toHaveBeenCalled();
    expect(check(herdr, 'terminal.backend')).toMatchObject({ level: 'skip', detail: expect.stringContaining('herdr') });
  });

  it('配置解析失败与数据库读失败都 skip，不猜配置也不执行 probe', async () => {
    const brokenConfig = dependencies({ terminalBackendProbe: vi.fn(async () => probeOk()) });
    Object.defineProperty(brokenConfig, 'config', { get() { throw new Error('broken config'); } });
    const configFailure = await runDoctor({ json: true }, brokenConfig);
    expect(brokenConfig.terminalBackendProbe).not.toHaveBeenCalled();
    expect(check(configFailure, 'terminal.backend')?.level).toBe('skip');

    const terminalBackendProbe = vi.fn(async () => probeOk());
    const databaseFailure = await runDoctor({ json: true }, dependencies({
      databaseProbe: () => ({ exists: true, error: 'SQLITE_CORRUPT' }),
      terminalBackendProbe
    }));
    expect(terminalBackendProbe).not.toHaveBeenCalled();
    expect(check(databaseFailure, 'terminal.backend')).toMatchObject({ level: 'skip', detail: expect.stringContaining('数据库') });
  });

  it('版本/create/verify 失败为 fail，probe 超时为 warn', () => {
    const plan = { action: 'probe', backend: 'tmux' } as const;
    for (const stage of ['version', 'create', 'verify'] as const) {
      expect(checkTerminalBackend(plan, { status: 'failed', stage, detail: `${stage} broken` })).toMatchObject({ level: 'fail', detail: expect.stringContaining(`${stage} broken`) });
    }
    expect(checkTerminalBackend(plan, { status: 'timeout', stage: 'create', detail: '超过 1000ms' })).toMatchObject({ level: 'warn', remedy: expect.any(String) });
  });

  it('清理失败或超时不能报 ok；原始失败不会被清理问题降级', () => {
    const plan = { action: 'probe', backend: 'tmux' } as const;
    for (const cleanup of [{ status: 'failed', detail: 'still running' }, { status: 'timeout', detail: 'cleanup timed out' }] as const) {
      const cleaned = checkTerminalBackend(plan, { ...probeOk(), cleanup, tempDir: '/tmp/private-socket-root' });
      expect(cleaned.level).toBe('warn');
      expect(cleaned.detail).toContain('/tmp/private-socket-root');
      expect(cleaned.remedy).toContain('私有');
      expect(checkTerminalBackend(plan, { status: 'failed', stage: 'create', detail: 'create failed', cleanup }).level).toBe('fail');
    }
  });

  it('未知后端设置不猜成 tmux', () => {
    expect(planTerminalBackend({
      agents: [ptyAgent],
      database: { exists: true },
      backend: 'unknown'
    })).toEqual({ action: 'skip', reason: 'config' });
  });
});

interface FakeCall {
  args: string[];
  env: Record<string, string | undefined>;
}

function fakeTmux(mode: string): { bin: string; log: string } {
  const root = temporaryDirectory('dd-terminal-fake-');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'calls.jsonl');
  const script = join(bin, 'tmux');
  writeFileSync(script, `#!${process.execPath}\n`
    + "const { appendFileSync } = require('node:fs');\n"
    + 'const args = process.argv.slice(2);\n'
    + "appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify({ args, env: { PATH: process.env.PATH, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, TMUX_TMPDIR: process.env.TMUX_TMPDIR, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DUTYDECK_DATABASE_URL: process.env.DUTYDECK_DATABASE_URL } }) + '\\n');\n"
    + "if (args[0] !== '-S' || !args[1]) process.exit(97);\n"
    + 'const command = args[2];\n'
    + `const mode = ${JSON.stringify(mode)};\n`
    + "if (command === '-V') { console.log('tmux fake 9.9'); process.exit(0); }\n"
    + "if (command === 'new-session' && mode === 'create-fail') { console.error('cannot create'); process.exit(1); }\n"
    + "if (command === 'new-session' && mode === 'create-hang') { setTimeout(() => process.exit(0), 10000); return; }\n"
    + "if (command === 'has-session' && mode === 'verify-fail') { console.error('wrong session'); process.exit(1); }\n"
    + "if (command === 'kill-server' && mode === 'cleanup-fail') { console.error('cannot stop'); process.exit(1); }\n"
    + "if (command === 'kill-server' && mode === 'cleanup-hang') { setTimeout(() => process.exit(0), 10000); return; }\n"
    + 'process.exit(0);\n', { mode: 0o755 });
  return { bin, log };
}

async function runFake(mode: string, timeoutMs = 1000) {
  const { bin, log } = fakeTmux(mode);
  const result = await defaultTerminalBackendProbe(timeoutMs, {
    PATH: bin,
    FAKE_TMUX_LOG: log,
    TMUX: 'inherited-default-socket',
    TMUX_PANE: '%42',
    TMUX_TMPDIR: '/inherited/tmp',
    HOME: '/inherited/home',
    TMPDIR: '/inherited/tmp',
    DUTYDECK_DATABASE_URL: 'must-not-cross-the-boundary'
  });
  // 只有假 tmux 才把保留目录交给测试 finally 清理；它不可能连接真实 server。
  if (result.tempDir) temporaryDirectories.push(result.tempDir);
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeCall) : [];
  return { result, calls };
}

describe('defaultTerminalBackendProbe 假 tmux', () => {
  it('受控 PATH 中不存在 tmux 时返回 not_found，并清理私有目录', async () => {
    const empty = temporaryDirectory('dd-terminal-empty-path-');
    const result = await defaultTerminalBackendProbe(1000, { PATH: empty });
    expect(result.status).toBe('not_found');
    expect(result.tempDir).toBeDefined();
    expect(existsSync(result.tempDir!)).toBe(false);
  });

  it('PATH 中的 tmux 不可执行时版本检查失败', async () => {
    const root = temporaryDirectory('dd-terminal-not-executable-');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tmux'), 'not executable', { mode: 0o644 });
    const result = await defaultTerminalBackendProbe(1000, { PATH: bin });
    expect(result).toMatchObject({ status: 'failed', stage: 'version' });
    expect(existsSync(result.tempDir!)).toBe(false);
  });

  it('所有 argv 都带私有 -S，精确核验会话，清洗继承环境并正常清理', async () => {
    const { result, calls } = await runFake('success');
    expect(result).toMatchObject({ status: 'ok', version: 'tmux fake 9.9' });
    expect(result.cleanup).toBeUndefined();
    expect(result.tempDir).toBeDefined();
    expect(existsSync(result.tempDir!)).toBe(false);
    expect(calls.map(call => call.args[2])).toEqual(['-V', 'new-session', 'has-session', 'kill-server']);
    for (const call of calls) {
      expect(call.args.slice(0, 2)).toEqual(['-S', join(result.tempDir!, 's')]);
      expect(call.env.TMUX).toBeUndefined();
      expect(call.env.TMUX_PANE).toBeUndefined();
      expect(call.env.DUTYDECK_DATABASE_URL).toBeUndefined();
      expect(call.env.TMUX_TMPDIR).toBe(result.tempDir);
      expect(call.env.HOME).toBe(result.tempDir);
      expect(call.env.TMPDIR).toBe(result.tempDir);
    }
    const create = calls[1]!;
    const sessionName = create.args[create.args.indexOf('-s') + 1];
    expect(sessionName).toBeTruthy();
    expect(calls[2]!.args).toContain(`=${sessionName}`);
  });

  it('假 tmux create/verify 失败仍只对同一私有 socket 清理', async () => {
    for (const mode of ['create-fail', 'verify-fail']) {
      const { result, calls } = await runFake(mode);
      expect(result.status).toBe('failed');
      expect(result).toMatchObject({ stage: mode === 'create-fail' ? 'create' : 'verify' });
      expect(calls.at(-1)?.args.slice(0, 2)).toEqual(['-S', join(result.tempDir!, 's')]);
      expect(calls.at(-1)?.args[2]).toBe('kill-server');
      expect(existsSync(result.tempDir!)).toBe(false);
    }
  });

  it('probe 超时为有界 warn，并尝试同一私有 socket 的清理', async () => {
    const { result, calls } = await runFake('create-hang');
    expect(result).toMatchObject({ status: 'timeout', stage: 'create' });
    expect(calls.at(-1)?.args).toEqual(['-S', join(result.tempDir!, 's'), 'kill-server']);
    expect(existsSync(result.tempDir!)).toBe(false);
    expect(checkTerminalBackend({ action: 'probe', backend: 'tmux' }, result).level).toBe('warn');
  });

  it.each(['cleanup-fail', 'cleanup-hang'])('%s 时保留可能仍连接活 server 的 socket 根，且不能报 ok', async mode => {
    const { result } = await runFake(mode);
    expect(result.status).toBe(mode === 'cleanup-hang' ? 'timeout' : 'failed');
    expect(result).toMatchObject({ stage: 'cleanup' });
    expect(result.cleanup).toBeUndefined();
    expect(existsSync(result.tempDir!)).toBe(true);
    expect(checkTerminalBackend({ action: 'probe', backend: 'tmux' }, result).level).toBe('warn');
  });
});

function tmuxOnPath(): string | undefined {
  if (process.platform === 'win32') return undefined;
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'tmux');
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* 下一个 PATH 项 */ }
  }
  return undefined;
}

const realTmux = tmuxOnPath();
const itWithRealTmux = realTmux ? it : it.skip;

describe('defaultTerminalBackendProbe 真实 tmux（私有 socket）', () => {
  itWithRealTmux('创建精确会话、核验并退出，成功后删除临时目录', async () => {
    const result = await defaultTerminalBackendProbe(5000, { PATH: dirname(realTmux!) });
    try {
      expect(result).toMatchObject({ status: 'ok', version: expect.stringContaining('tmux') });
      expect(result.cleanup).toBeUndefined();
      expect(result.tempDir).toBeDefined();
      expect(existsSync(result.tempDir!)).toBe(false);
      expect(checkTerminalBackend({ action: 'probe', backend: 'tmux' }, result).level).toBe('ok');
    } finally {
      // 测试自身的兜底也只接触同一个私有 socket；未确认退出时绝不删除 socket 根。
      if (result.tempDir && existsSync(result.tempDir)) {
        const socket = join(result.tempDir, 's');
        const env = childEnvironment({ PATH: dirname(realTmux!) }, { TMUX_TMPDIR: result.tempDir, HOME: result.tempDir, TMPDIR: result.tempDir });
        try {
          await execFileAsync(realTmux!, ['-S', socket, 'kill-server'], { env, shell: false, timeout: 2000, killSignal: 'SIGKILL' });
          rmSync(result.tempDir, { recursive: true, force: true });
        } catch { /* server 状态未知：保留目录，不冒充安全清理 */ }
      }
    }
  }, 15_000);
});
