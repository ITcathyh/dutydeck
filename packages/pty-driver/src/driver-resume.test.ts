/**
 * Driver-level tests for the M2 resume work:
 *   - the session marker is injected into the FIRST prompt only
 *   - resume() resolves the CLI's own session id before building the command
 *   - resume() degrades to the dockmux session id when the lookup finds nothing
 *   - tmux reattach survives a "daemon restart" (a fresh driver over a live
 *     tmux session) and keeps streaming
 *
 * The tmux block uses /bin/sh as the fake CLI — the point is the driver's
 * detach → probe → attach → rewire path, not a real agent.
 *
 * Run: npx vitest run packages/pty-driver/src/driver-resume.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, NormalizedDriverEvent } from '@dockmux/shared';
import type { CliAdapter, PtyLike } from '@dockmux/cli-adapters';
import { PtyBackend, TmuxBackend, isTmuxAvailable } from '@dockmux/session-backends';
import { PtyCliDriver } from './driver.js';
import { buildSessionMarker } from './session-id/index.js';

/** Poll an assertion until it passes or times out. Generous by default: the
 *  tmux spawn → pipe-pane → tail -F chain sees multi-second jitter under the
 *  full concurrent suite, and the first tmux test pays server cold-start. */
async function waitForAssert<T>(fn: () => T, timeoutMs = 30_000, intervalMs = 100): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (Date.now() - start > timeoutMs) throw lastError;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 30_000, intervalMs = 100): Promise<void> {
  return waitForAssert(() => {
    if (!predicate()) throw new Error('not yet');
  }, timeoutMs, intervalMs) as Promise<void>;
}

const SESSION_ID = 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let tempRoots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dockmux-drv-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(() => {
  tempRoots = [];
});

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'mock-agent',
    name: 'Mock Agent',
    command: process.execPath,
    args: [],
    protocol: 'pty-cli',
    env: {},
    permissionMode: 'full-trust',
    timeout: 600,
    capabilities: { pause: false, resume: true },
    builtin: false,
    ...overrides,
  } as AgentConfig;
}

/** A fake CLI process: prints a ready marker, echoes each stdin line, then
 *  prints a completion marker. Enough for the idle detector to close a turn. */
const MOCK_CLI_SOURCE = `
process.stdout.write('MOCK READY\\n');
let buf = '';
process.stdin.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    process.stdout.write('ECHO:' + line + '\\nMOCK DONE\\n');
  }
});
`;

/** Records everything the driver asked of the adapter. */
interface RecordingAdapter extends CliAdapter {
  readonly prompts: string[];
  readonly resumeIds: string[];
}

function recordingAdapter(opts: {
  id: string;
  fixturePath: string;
  withResume?: boolean;
}): RecordingAdapter {
  const prompts: string[] = [];
  const resumeIds: string[] = [];
  const adapter: RecordingAdapter = {
    id: opts.id,
    capabilities: { resume: opts.withResume !== false },
    prompts,
    resumeIds,
    // resume 走的是 buildArgs 的 resume 分支（driver 需要完整 argv，
    // 不能只拿 buildResumeCommand 的续接片段），反查到的 id 在这里落账。
    buildArgs: ctx => {
      if (ctx.resume && ctx.resumeSessionId !== undefined) resumeIds.push(ctx.resumeSessionId);
      return [opts.fixturePath];
    },
    writeInput: (backend: PtyLike, prompt: string) => {
      prompts.push(prompt);
      backend.write(prompt.replace(/\n/g, ' ') + '\n');
    },
    completionPattern: /MOCK DONE/,
  };
  if (opts.withResume !== false) {
    // 保留：它是 resume 能力的声明位（driver.resume 据此决定走不走这条路径）。
    adapter.buildResumeCommand = (sessionId: string) => ['--resume', sessionId];
  }
  return adapter;
}

// ─── marker injection ──────────────────────────────────────────────────────

describe('PtyCliDriver session marker injection', () => {
  let fixturePath: string;

  beforeEach(() => {
    const dir = makeTempDir('marker');
    fixturePath = join(dir, 'mock-cli.mjs');
    writeFileSync(fixturePath, MOCK_CLI_SOURCE, 'utf8');
  });

  it('injects the marker into the first prompt only, ahead of the user text', async () => {
    const adapter = recordingAdapter({ id: 'mock-cli', fixturePath });
    const events: NormalizedDriverEvent[] = [];
    const driver = new PtyCliDriver({
      agent: agentConfig(),
      adapter,
      backend: new PtyBackend(),
      onEvent: e => events.push(e),
      onExit: () => {},
      sessionId: SESSION_ID,
    });

    await driver.start();
    await driver.send('first turn');
    await driver.send('second turn');

    expect(adapter.prompts).toHaveLength(2);
    const marker = buildSessionMarker(SESSION_ID);
    // Turn 1 carries the marker, and the user's text still comes last.
    expect(adapter.prompts[0]).toContain(marker);
    expect(adapter.prompts[0]!.indexOf(marker)).toBeLessThan(adapter.prompts[0]!.indexOf('first turn'));
    expect(adapter.prompts[0]!.endsWith('first turn')).toBe(true);
    // Turn 2 is the user's text verbatim — no repeated bookkeeping.
    expect(adapter.prompts[1]).toBe('second turn');

    await driver.stop();
  }, 30_000);
});

// ─── resume session-id resolution ──────────────────────────────────────────

describe('PtyCliDriver resume session id resolution', () => {
  let fixturePath: string;

  beforeEach(() => {
    const dir = makeTempDir('resume');
    fixturePath = join(dir, 'mock-cli.mjs');
    writeFileSync(fixturePath, MOCK_CLI_SOURCE, 'utf8');
  });

  function driverFor(adapter: CliAdapter, cwd: string, cliSessionId?: string): PtyCliDriver {
    return new PtyCliDriver({
      agent: agentConfig({ cwd }),
      adapter,
      backend: new PtyBackend(),
      onEvent: () => {},
      onExit: () => {},
      sessionId: SESSION_ID,
      cliSessionId,
    });
  }

  it('resume 用 buildArgs({resume:true}) 的完整 argv，不是 buildResumeCommand 的续接片段', async () => {
    // 真实环境踩过的坑：respawn 直接拿 buildResumeCommand() 当完整 argv，
    // 于是 claude 少了 --dangerously-skip-permissions 等无人值守必需参数，
    // 起来就撞权限确认 exit 1 → 会话被判 failed → 之后 send 全 409。
    // buildResumeCommand 只负责「续接定位」，完整启动参数在 buildArgs 里。
    //
    // respawn() 内部 new PtyBackend()，注入的后端会被丢弃，所以不能靠打补丁
    // 观察——让 fixture CLI 自己把收到的 argv 落盘。
    const cwd = makeTempDir('argv-cwd');
    const argvDump = join(cwd, 'argv.json');
    const probeCli = join(cwd, 'probe-cli.mjs');
    writeFileSync(probeCli, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(2)));
      process.stdout.write('MOCK READY\\n');
      setInterval(() => {}, 1000);
    `, 'utf8');

    const adapter: CliAdapter = {
      id: 'argv-probe',
      capabilities: { resume: true },
      // 完整 argv：续接定位 + 无人值守必需参数
      buildArgs: ctx => ctx.resume
        ? [probeCli, '--resume', ctx.resumeSessionId ?? '', '--skip-permissions']
        : [probeCli, '--skip-permissions'],
      // 只有续接定位，缺权限参数——不该被当成完整 argv 使用
      buildResumeCommand: () => ['--resume', 'ONLY-FRAGMENT'],
      writeInput: (backend: PtyLike, prompt: string) => { backend.write(prompt + '\n'); },
      completionPattern: /MOCK DONE/,
    };

    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: () => {}, onExit: () => {}, sessionId: SESSION_ID,
    });
    await driver.resume();
    const argv = await waitForAssert(() => JSON.parse(readFileSync(argvDump, 'utf8')) as string[], 20_000);
    expect(argv).toContain('--skip-permissions');
    expect(argv).not.toContain('ONLY-FRAGMENT');
    await driver.stop();
  }, 30_000);

  it('resume-without-start 也带完整环境（daemon 重启形态）', async () => {
    // driver 从没 start() 就直接 resume()：环境是在 start() 里算的，
    // 这条路径必须自己算，否则 respawn 出来的 CLI 连 PATH 都没有。
    const cwd = makeTempDir('env-cwd');
    const envDump = join(cwd, 'env.json');
    const probeCli = join(cwd, 'env-cli.mjs');
    writeFileSync(probeCli, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({
        probe: process.env.DOCKMUX_PROBE ?? null,
        hasPath: Boolean(process.env.PATH),
      }));
      process.stdout.write('MOCK READY\\n');
      setInterval(() => {}, 1000);
    `, 'utf8');

    const adapter: CliAdapter = {
      id: 'env-probe',
      capabilities: { resume: true },
      buildArgs: () => [probeCli],
      buildResumeCommand: (id: string) => ['--resume', id],
      writeInput: (backend: PtyLike, prompt: string) => { backend.write(prompt + '\n'); },
      completionPattern: /MOCK DONE/,
    };

    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd, env: { DOCKMUX_PROBE: 'from-agent-env' } }),
      adapter, backend: new PtyBackend(),
      onEvent: () => {}, onExit: () => {}, sessionId: SESSION_ID,
    });
    await driver.resume();
    const seen = await waitForAssert(
      () => JSON.parse(readFileSync(envDump, 'utf8')) as { probe: string | null; hasPath: boolean },
      20_000,
    );
    expect(seen.probe).toBe('from-agent-env');   // agent.env 生效
    expect(seen.hasPath).toBe(true);             // 基础环境在，不是空对象
    await driver.stop();
  }, 30_000);

  it('resume 不把「自己 kill 掉的旧后端」的退出上报成 agent 崩溃', async () => {
    // 真实环境踩过的坑（决定性证据是一串事件）：
    //   status idle → raw_terminal "Resume this session with: claude --resume …"
    //   → status failed "Agent exited with code 129"（SIGHUP）
    // respawn 先 kill 旧后端再起新的，旧后端那声 exit 被当成 agent 崩溃上报，
    // runtime 随即把会话打成 failed，之后 send 全部 409 —— 而新进程其实好好的。
    //
    // 不能用时间窗挡：kill() 只发信号，exit 由 node-pty 在后续 tick 才回调。
    // handleExit 按「事件来自哪个后端实例」过滤，这条测试锁的就是它。
    const cwd = makeTempDir('exit-cwd');
    const longLived = join(cwd, 'long-cli.mjs');
    writeFileSync(longLived, `
      process.stdout.write('MOCK READY\\n');
      setInterval(() => {}, 1000);
    `, 'utf8');

    const exits: Array<number | null> = [];
    const adapter: CliAdapter = {
      id: 'exit-probe',
      capabilities: { resume: true },
      buildArgs: () => [longLived],
      buildResumeCommand: (id: string) => ['--resume', id],
      writeInput: (backend: PtyLike, prompt: string) => { backend.write(prompt + '\n'); },
      completionPattern: /MOCK DONE/,
    };
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: () => {}, onExit: code => exits.push(code), sessionId: SESSION_ID,
    });

    await driver.start();
    await waitFor(() => driver.getCliSessionId() !== undefined || true, 5_000).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));   // 让首个 CLI 真正跑起来
    await driver.resume();                          // 内部 kill 旧后端 + 重 spawn
    await new Promise(r => setTimeout(r, 3000));    // 留足信号送达 + 回调的时间

    // 旧后端的退出不该冒泡成 driver 退出
    expect(exits, `不该上报退出，实际上报了 ${JSON.stringify(exits)}`).toEqual([]);

    // 而真正的退出仍然要上报：stop() 之后必须收到一次
    await driver.stop();
    await waitFor(() => exits.length > 0, 10_000);
    expect(exits.length).toBe(1);
  }, 40_000);

  it('reverse-looks-up the CLI session id from the CLI transcript', async () => {
    const cwd = makeTempDir('codex-cwd');
    const codexHome = makeTempDir('codex-home');
    setEnv('CODEX_HOME', codexHome);
    const cliSessionId = '01a02e6e-8e60-74a0-9293-3eeb2f2ba5b5';
    // codex recorded our first submit (marker included) under ITS own id.
    writeFileSync(join(codexHome, 'history.jsonl'),
      JSON.stringify({
        session_id: cliSessionId,
        ts: 1785316592,
        text: `${buildSessionMarker(SESSION_ID)}\nwork on the bug`,
      }) + '\n', 'utf8');

    const adapter = recordingAdapter({ id: 'codex', fixturePath });
    const driver = driverFor(adapter, cwd);
    await driver.start();
    await driver.resume();

    // The CLI's own id — NOT the dockmux session id.
    expect(adapter.resumeIds).toEqual([cliSessionId]);
    expect(driver.getCliSessionId()).toBe(cliSessionId);

    await driver.stop();
  }, 30_000);

  it('degrades to the dockmux session id when the lookup finds nothing, without throwing', async () => {
    const cwd = makeTempDir('codex-cwd');
    setEnv('CODEX_HOME', makeTempDir('codex-empty'));

    const adapter = recordingAdapter({ id: 'codex', fixturePath });
    const driver = driverFor(adapter, cwd);
    await driver.start();
    await expect(driver.resume()).resolves.toBeUndefined();

    expect(adapter.resumeIds).toEqual([SESSION_ID]);
    // Nothing was proven, so nothing is cached — a later resume retries.
    expect(driver.getCliSessionId()).toBeUndefined();

    await driver.stop();
  }, 30_000);

  it('prefers an injected cliSessionId over any disk lookup', async () => {
    const cwd = makeTempDir('codex-cwd');
    const codexHome = makeTempDir('codex-home');
    setEnv('CODEX_HOME', codexHome);
    writeFileSync(join(codexHome, 'history.jsonl'),
      JSON.stringify({
        session_id: 'from-disk-should-not-win',
        ts: 1,
        text: buildSessionMarker(SESSION_ID),
      }) + '\n', 'utf8');

    const adapter = recordingAdapter({ id: 'codex', fixturePath });
    const driver = driverFor(adapter, cwd, 'persisted-id');
    await driver.start();
    await driver.resume();

    expect(adapter.resumeIds).toEqual(['persisted-id']);

    await driver.stop();
  }, 30_000);

  it('caches a resolved id so a second resume does not re-scan', async () => {
    const cwd = makeTempDir('codex-cwd');
    const codexHome = makeTempDir('codex-home');
    setEnv('CODEX_HOME', codexHome);
    const cliSessionId = '01a02e6e-1111-2222-3333-444444444444';
    const historyPath = join(codexHome, 'history.jsonl');
    writeFileSync(historyPath,
      JSON.stringify({ session_id: cliSessionId, ts: 1, text: buildSessionMarker(SESSION_ID) }) + '\n', 'utf8');

    const adapter = recordingAdapter({ id: 'codex', fixturePath });
    const driver = driverFor(adapter, cwd);
    await driver.start();
    await driver.resume();
    // Delete the evidence: a cached id must survive it.
    rmSync(historyPath, { force: true });
    await driver.resume();

    expect(adapter.resumeIds).toEqual([cliSessionId, cliSessionId]);

    await driver.stop();
  }, 30_000);

  it('uses the pinned id for a CLI whose session id dockmux chose (claude)', async () => {
    const cwd = makeTempDir('claude-cwd');
    const configDir = makeTempDir('claude-cfg');
    setEnv('CLAUDE_CONFIG_DIR', configDir);
    const projectDir = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    const uuid = SESSION_ID.replace(/^ses_/, '');
    writeFileSync(join(projectDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'mode', sessionId: uuid }) + '\n', 'utf8');

    const adapter = recordingAdapter({ id: 'claude-code', fixturePath });
    const driver = driverFor(adapter, cwd);
    await driver.start();
    await driver.resume();

    expect(adapter.resumeIds).toEqual([uuid]);

    await driver.stop();
  }, 30_000);

  it('is a no-op for an adapter without buildResumeCommand', async () => {
    const cwd = makeTempDir('noresume-cwd');
    const adapter = recordingAdapter({ id: 'gemini', fixturePath, withResume: false });
    const driver = driverFor(adapter, cwd);
    await driver.start();
    await expect(driver.resume()).resolves.toBeUndefined();
    expect(adapter.resumeIds).toEqual([]);
    await driver.stop();
  }, 30_000);

  it('does not re-spawn or re-inject when send() follows a resume-without-start', async () => {
    // The daemon-restart shape: a fresh driver goes straight to resume(),
    // never calling start(). A later send() must reuse the resumed backend
    // (a second spawn is a hard error on the tmux backend) and must not
    // repeat the first-prompt injection — the CLI already has that context.
    const cwd = makeTempDir('codex-cwd');
    setEnv('CODEX_HOME', makeTempDir('codex-empty'));

    const adapter = recordingAdapter({ id: 'codex', fixturePath });
    const driver = driverFor(adapter, cwd);
    await driver.resume();
    await driver.send('after restart');

    expect(adapter.resumeIds).toEqual([SESSION_ID]);
    expect(adapter.prompts).toEqual(['after restart']);
    expect(adapter.prompts[0]).not.toContain(buildSessionMarker(SESSION_ID));

    await driver.stop();
  }, 30_000);
});

// ─── tmux reattach (driver level, across a "daemon restart") ───────────────

const tmuxDescribe = isTmuxAvailable() ? describe : describe.skip;

tmuxDescribe('PtyCliDriver tmux reattach', () => {
  const sessions: string[] = [];

  afterEach(() => {
    for (const name of sessions.splice(0)) {
      try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* gone */ }
    }
  });

  function tmuxName(): string {
    const name = `dockmux-drv-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    sessions.push(name);
    return name;
  }

  /** A shell as the fake CLI: `resume()` must reattach to the LIVE pane
   *  rather than respawn, so the adapter's resume command must never run. */
  function shellAdapter(resumeIds: string[]): CliAdapter {
    return {
      id: 'mock-shell',
      capabilities: { resume: true },
      buildArgs: () => [],
      writeInput: (backend: PtyLike, prompt: string) => { backend.write(prompt + '\n'); },
      buildResumeCommand: (sessionId: string) => {
        resumeIds.push(sessionId);
        return [];
      },
      completionPattern: /DRIVER-DONE/,
    };
  }

  it('reattaches to a live tmux session and keeps streaming after a driver restart', async () => {
    const name = tmuxName();
    const cwd = makeTempDir('tmux-cwd');
    const resumeIds: string[] = [];

    // ── daemon lifetime #1: spawn the CLI inside tmux ──
    const firstEvents: NormalizedDriverEvent[] = [];
    const first = new PtyCliDriver({
      agent: agentConfig({ command: '/bin/sh', cwd }),
      adapter: shellAdapter(resumeIds),
      backend: new TmuxBackend(name),
      onEvent: e => firstEvents.push(e),
      onExit: () => {},
      sessionId: SESSION_ID,
    });
    await first.start();
    await waitForAssert(() => {
      expect(firstEvents.some(e => e.type === 'raw_terminal')).toBe(true);
    });

    // Detach WITHOUT killing: this is what a daemon shutdown does.
    (first as unknown as { backend: { detach?: () => void } }).backend.detach?.();
    expect(TmuxBackend.probeSession(name)).toBe('exists');

    // ── daemon lifetime #2: a brand-new driver over the SAME tmux session ──
    const secondEvents: NormalizedDriverEvent[] = [];
    const second = new PtyCliDriver({
      agent: agentConfig({ command: '/bin/sh', cwd }),
      adapter: shellAdapter(resumeIds),
      backend: new TmuxBackend(name),
      onEvent: e => secondEvents.push(e),
      onExit: () => {},
      sessionId: SESSION_ID,
    });
    await second.resume();

    // The live pane was reattached, not respawned.
    expect(resumeIds).toEqual([]);
    expect(TmuxBackend.probeSession(name)).toBe('exists');

    // Output flows again through the rebuilt capture.
    second.createTerminalStream();
    await second.send('echo DRIVER-REATTACHED; echo DRIVER-DONE');
    await waitForAssert(() => {
      const text = secondEvents
        .filter(e => e.type === 'raw_terminal')
        .map(e => e.data.text as string)
        .join('\n');
      expect(text).toContain('DRIVER-REATTACHED');
    });

    await second.stop();
    await waitFor(() => TmuxBackend.probeSession(name) === 'missing');
  }, 60_000);

  it('falls back to a CLI-level resume when the tmux session is gone', async () => {
    const name = tmuxName();
    const cwd = makeTempDir('tmux-cwd');
    const resumeIds: string[] = [];

    const backend = new TmuxBackend(name);
    const driver = new PtyCliDriver({
      agent: agentConfig({ command: '/bin/sh', cwd }),
      adapter: shellAdapter(resumeIds),
      backend,
      onEvent: () => {},
      onExit: () => {},
      sessionId: SESSION_ID,
    });
    await driver.start();
    await waitFor(() => TmuxBackend.probeSession(name) === 'exists');

    // The session dies (machine reboot / tmux server killed).
    backend.kill();
    await waitFor(() => TmuxBackend.probeSession(name) === 'missing');

    await driver.resume();

    // No live pane to reattach → the adapter's resume path ran instead, and
    // with no transcript evidence it degraded to the dockmux session id.
    expect(resumeIds).toEqual([SESSION_ID]);
    // The respawn reused the SAME tmux session name (state stays addressable).
    await waitFor(() => TmuxBackend.probeSession(name) === 'exists');

    await driver.stop();
  }, 60_000);
});
