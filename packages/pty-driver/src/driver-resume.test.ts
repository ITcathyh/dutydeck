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

  function driverFor(
    adapter: CliAdapter,
    cwd: string,
    cliSessionId?: string,
    env: Record<string, string> = {},
  ): PtyCliDriver {
    return new PtyCliDriver({
      agent: agentConfig({ cwd, env }),
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
    // The lookup resolves against the env the CLI CHILD was spawned with, and
    // the driver strips CLAUDE_* from that child — so a CLAUDE_CONFIG_DIR set
    // only on the daemon names a directory the CLI provably never wrote to.
    // agent.env is the channel that actually reaches the child, and pointing
    // it at the fixture is also the only self-consistent story: this transcript
    // exists because a claude child wrote it there.
    setEnv('CLAUDE_CONFIG_DIR', configDir);
    const projectDir = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    const uuid = SESSION_ID.replace(/^ses_/, '');
    writeFileSync(join(projectDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'mode', sessionId: uuid }) + '\n', 'utf8');

    const adapter = recordingAdapter({ id: 'claude-code', fixturePath });
    const driver = driverFor(adapter, cwd, undefined, { CLAUDE_CONFIG_DIR: configDir });
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

// ─── resume 降级：适配器否决 id → 放弃 resume，改起新会话 ──────────────────

describe('PtyCliDriver resume degradation (buildResumeCommand → null)', () => {
  let fixturePath: string;

  beforeEach(() => {
    const dir = makeTempDir('degrade');
    fixturePath = join(dir, 'mock-cli.mjs');
    writeFileSync(fixturePath, MOCK_CLI_SOURCE, 'utf8');
  });

  /**
   * 一个自己铸 session id 的 CLI 的适配器：只认原生形态的 id，认不出就返回
   * null（真实世界里这是 opencode —— `-s <不存在的id>` 会立刻 exit 1）。
   *
   * ⚠️ buildArgs 故意**不做**任何 id 校验：`resume:true` 传进来什么就往 argv 里
   * 放什么。这是刻意的——只有这样，「argv 里没有那个无效 id」才唯一地证明
   * **driver 走了 fresh 分支**。若 buildArgs 自己也挡一道，那条断言对「driver
   * 尊重 null」和「driver 无视 null」会给出完全相同的结果，就成了恒绿的假测试。
   * 真实适配器两层都挡（cli-adapters 那边另有测试锁 buildArgs 侧）。
   *
   * argvLog 记下每次 spawn 的 argv 形态，供测试分辨 resume 分支 vs fresh 分支。
   */
  function mintsOwnIdAdapter(opts: { nativeIdPattern: RegExp; argvLog: string[][] }): CliAdapter {
    return {
      id: 'mints-own-id',
      capabilities: { resume: true },
      buildArgs: ctx => {
        const argv = ctx.resume && ctx.resumeSessionId
          ? [fixturePath, '--session', ctx.resumeSessionId]
          : [fixturePath];
        opts.argvLog.push(argv);
        return argv;
      },
      writeInput: (backend: PtyLike, prompt: string) => { backend.write(prompt.replace(/\n/g, ' ') + '\n'); },
      buildResumeCommand: (sessionId: string) =>
        opts.nativeIdPattern.test(sessionId) ? ['-s', sessionId] : null,
      completionPattern: /MOCK DONE/,
    };
  }

  const NATIVE_ID = /^ses_[0-9A-Za-z]+$/;   // 无连字符 —— dockmux 的 ses_<uuid> 进不来

  it('反查不到 → 适配器返回 null → 起新会话，argv 里绝不带那个无效 id', async () => {
    // 缺口 1 的核心路径。旧行为是把 dockmux sessionId 硬塞进 resume argv，
    // 对 opencode 这类 CLI 必然 exit 1；现在必须彻底不带续接定位。
    const cwd = makeTempDir('degrade-cwd');
    const argvLog: string[][] = [];
    const adapter = mintsOwnIdAdapter({ nativeIdPattern: NATIVE_ID, argvLog });
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: () => {}, onExit: () => {}, sessionId: SESSION_ID,
    });

    await driver.resume();

    expect(argvLog).toHaveLength(1);
    const argv = argvLog[0]!;
    expect(argv, 'fresh spawn 不该带任何续接定位').toEqual([fixturePath]);
    expect(argv, 'dockmux sessionId 绝不能出现在 argv 里').not.toContain(SESSION_ID);
    expect(argv).not.toContain('--session');

    await driver.stop();
  }, 30_000);

  it('降级不是静默的：发 status(resume_degraded) + 一条人读得懂的说明', async () => {
    // 降级会丢上下文，而 CLI 表面上好端端起来了——用户唯一能察觉的途径就是
    // 这条事件。少了它，症状是「agent 突然不记得刚才聊过什么」。
    const cwd = makeTempDir('degrade-cwd');
    const events: NormalizedDriverEvent[] = [];
    const adapter = mintsOwnIdAdapter({ nativeIdPattern: NATIVE_ID, argvLog: [] });
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: e => events.push(e), onExit: () => {}, sessionId: SESSION_ID,
    });

    await driver.resume();

    const degraded = events.find(e => e.type === 'status' && e.data?.state === 'resume_degraded');
    expect(degraded, `没发降级 status，实际事件：${events.map(e => e.type).join(',')}`).toBeDefined();
    expect(degraded!.data.attemptedSessionId).toBe(SESSION_ID);
    expect(degraded!.data.adapterId).toBe('mints-own-id');

    // 人读的那条：必须点明「新会话 / 上下文没带过来」，否则用户看不懂发生了什么。
    const notice = events.find(e => e.type === 'text' && /新起|新会话/.test(String(e.data?.text ?? '')));
    expect(notice, `没发人读的降级说明，实际事件：${events.map(e => e.type).join(',')}`).toBeDefined();
    expect(notice!.data.text).toContain('上下文');

    // 绝不能发 error：runtime 对轮次外的 error 会把会话打成 failed，之后 send
    // 全部 409 —— 而这里新进程明明已经好好起来了。降级不是故障。
    expect(events.filter(e => e.type === 'error'), '降级不该报 error').toEqual([]);

    await driver.stop();
  }, 30_000);

  it('降级后重新走首轮注入：新会话必须重新打会话指纹', async () => {
    // 降级起的是**全新** CLI 会话，里面没有路由块、也没有会话指纹。指纹是
    // 「dockmux 会话 ↔ CLI 原生 id」反查的唯一锚点：不重新打，下一次 resume
    // 照样反查不到，会话就永久失去恢复能力。
    const cwd = makeTempDir('degrade-cwd');
    const prompts: string[] = [];
    const adapter: CliAdapter = {
      ...mintsOwnIdAdapter({ nativeIdPattern: NATIVE_ID, argvLog: [] }),
      writeInput: (backend: PtyLike, prompt: string) => {
        prompts.push(prompt);
        backend.write(prompt.replace(/\n/g, ' ') + '\n');
      },
    };
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: () => {}, onExit: () => {}, sessionId: SESSION_ID,
    });

    await driver.resume();
    await driver.send('first turn after degrade');

    expect(prompts).toHaveLength(1);
    expect(prompts[0], '降级后的首条 prompt 必须重新带会话指纹')
      .toContain(buildSessionMarker(SESSION_ID));

    await driver.stop();
  }, 30_000);

  it('降级后 send 复用降级起的后端，不再 spawn 第二次', async () => {
    // resume 之后 driver 已经有一个接好线的活后端。降级路径若忘了置 started，
    // 接下来的 send() 会走 start() 再 spawn 一次（tmux 后端直接抛
    // "spawn() called twice"）。
    const cwd = makeTempDir('degrade-cwd');
    const argvLog: string[][] = [];
    const adapter = mintsOwnIdAdapter({ nativeIdPattern: NATIVE_ID, argvLog });
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: () => {}, onExit: () => {}, sessionId: SESSION_ID,
    });

    await driver.resume();
    await driver.send('after degrade');

    expect(argvLog, `spawn 了 ${argvLog.length} 次，降级后 send 不该再 spawn`).toHaveLength(1);

    await driver.stop();
  }, 30_000);

  it('正常路径不受影响：id 认得出就照常 resume，且不发降级事件', async () => {
    // 反向闸门。防「把降级做成了一刀切」——那样每次 resume 都白白丢上下文，
    // 而且同样不会有测试失败（fresh spawn 本身是能跑通的）。
    const cwd = makeTempDir('degrade-cwd');
    const argvLog: string[][] = [];
    const events: NormalizedDriverEvent[] = [];
    const adapter = mintsOwnIdAdapter({ nativeIdPattern: NATIVE_ID, argvLog });
    const nativeId = 'ses_7f3kQ2mBz9';
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: e => events.push(e), onExit: () => {},
      sessionId: SESSION_ID,
      cliSessionId: nativeId,      // 调用方持久化过 CLI 原生 id
    });

    await driver.resume();

    expect(argvLog).toHaveLength(1);
    expect(argvLog[0], '认得出的 id 必须照常续接').toEqual([fixturePath, '--session', nativeId]);
    expect(events.filter(e => e.type === 'status' && e.data?.state === 'resume_degraded'))
      .toEqual([]);

    await driver.stop();
  }, 30_000);

  it('正常 resume 不重发首轮注入（与降级路径相反）', async () => {
    // 续接成功时 CLI 的上下文里已经带着路由块与指纹了，重发一遍只会污染会话。
    // 这条与上面「降级要重新注入」成对，锁住两条路径的差异。
    const cwd = makeTempDir('degrade-cwd');
    const prompts: string[] = [];
    const base = mintsOwnIdAdapter({ nativeIdPattern: NATIVE_ID, argvLog: [] });
    const adapter: CliAdapter = {
      ...base,
      writeInput: (backend: PtyLike, prompt: string) => {
        prompts.push(prompt);
        backend.write(prompt.replace(/\n/g, ' ') + '\n');
      },
    };
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: () => {}, onExit: () => {},
      sessionId: SESSION_ID, cliSessionId: 'ses_7f3kQ2mBz9',
    });

    await driver.resume();
    await driver.send('after real resume');

    expect(prompts).toEqual(['after real resume']);
    expect(prompts[0]).not.toContain(buildSessionMarker(SESSION_ID));

    await driver.stop();
  }, 30_000);

  it('降级清掉缓存的 cliSessionId（它指向的已经不是当前会话了）', async () => {
    // 降级起的是全新 CLI 会话，旧 id 指向的是被放弃的那个。留着它，下一次
    // resume 会拿它当「最可靠来源」直接用，续接到一个陈旧会话上。
    const cwd = makeTempDir('degrade-cwd');
    const adapter = mintsOwnIdAdapter({ nativeIdPattern: /^NEVER-MATCHES$/, argvLog: [] });
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: () => {}, onExit: () => {},
      sessionId: SESSION_ID, cliSessionId: 'stale-native-id',
    });

    expect(driver.getCliSessionId()).toBe('stale-native-id');
    await driver.resume();
    expect(driver.getCliSessionId(), '降级后不该还留着旧的 CLI id').toBeUndefined();

    await driver.stop();
  }, 30_000);

  it('降级起的 CLI 是真的活着：能收发一轮完整对话', async () => {
    // 前面几条都在断言 argv 与事件。这条走通端到端：降级不是「什么都没做」，
    // 而是真的起了一个能用的新会话。
    const cwd = makeTempDir('degrade-cwd');
    const events: NormalizedDriverEvent[] = [];
    const adapter = mintsOwnIdAdapter({ nativeIdPattern: NATIVE_ID, argvLog: [] });
    const driver = new PtyCliDriver({
      agent: agentConfig({ cwd }), adapter, backend: new PtyBackend(),
      onEvent: e => events.push(e), onExit: () => {}, sessionId: SESSION_ID,
    });

    await driver.resume();
    await driver.send('hello after degrade');

    // send() 只在本轮 completed 后 resolve，能走到这里就说明新 CLI 在正常工作。
    expect(events.some(e => e.type === 'completed')).toBe(true);
    await waitForAssert(() => {
      const screen = events.filter(e => e.type === 'raw_terminal')
        .map(e => e.data.text as string).join('\n');
      expect(screen).toContain('hello after degrade');
    });

    await driver.stop();
  }, 40_000);
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
