/**
 * `dutydeck setup` 编排器测试。
 *
 * 全部依赖都从 SetupDependencies 注入：不碰网络、不碰真实 .env、不写临时目录之外
 * 的任何东西。真实目录只用 mkdtemp 建、afterEach 删。
 */
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { migrations } from '../../../../packages/storage/src/migrations.js';
import { createCliUi, symbolFor } from '../cli-ui.js';
import type { DetectedAgent } from './detect.js';
import { saveBot as saveRealBot, type ExistingBot, type SaveBotInput, type SaveBotResult } from './bot-store.js';
import { readLarkConfig } from '../lark/config.js';
import { readExistingConfig, type WriteEnvResult } from './env-file.js';
import type { LarkBindOptions, LarkBindResult } from './lark-bind.js';
import { offerLarkSetupSmoke } from './lark-smoke.js';
import type { TerminalBackendProbe } from '../doctor/types.js';
import { PromptAbortedError, PromptUnavailableError, type AskOptions, type Prompter } from './prompts.js';
import { runSetup, type SetupDependencies } from './setup.js';

const tempDirs: string[] = [];
const originalIsTTY = process.stdin.isTTY;

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-setup-'));
  tempDirs.push(dir);
  return dir;
}

function createSchemaV1Database(path: string, options: { configs?: boolean; terminalBackend?: string } = {}): void {
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    migrations.find(migration => migration.version === 1)!.up(db);
    if (options.configs === false) db.exec('DROP TABLE configs');
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run('2026-01-01T00:00:00.000Z');
    if (options.terminalBackend !== undefined) {
      db.prepare('INSERT INTO configs (key, value) VALUES (?, ?)').run('dutydeck.terminal_backend', options.terminalBackend);
    }
  } finally { db.close(); }
}

function expectOnlySchemaV1(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('dutydeck_control', 'dutydeck_access')").all()).toEqual([]);
  } finally { db.close(); }
}

function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
}

afterEach(async () => {
  setIsTTY(originalIsTTY);
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** 可注入的输出目标；测试直接断言累积的纯文本。 */
function fakeStream() {
  let text = '';
  return { write(chunk: string) { text += chunk; }, read: () => text };
}

const AGENT: DetectedAgent = {
  id: 'claude', name: 'Claude Code', command: 'claude', version: '1.2.3', protocol: 'acp', builtin: true
};

/** 任何提问都是失败：--json / 非交互路径绝不该走到这里。 */
function strictPrompter(): Prompter {
  return {
    interactive: false,
    async ask<T>(): Promise<T> { throw new Error('prompter.ask must not be called'); },
    async choose<T>(): Promise<T> { throw new Error('prompter.choose must not be called'); },
    async confirm(): Promise<boolean> { throw new Error('prompter.confirm must not be called'); },
    async secret(): Promise<string> { throw new Error('prompter.secret must not be called'); },
    close() {}
  };
}

/** 足以让 renderLarkBindResult 完整走一遍的分步结果。 */
const LARK_STEPS: LarkBindResult['steps'] = [
  { key: 'scopes', label: '机器人所需权限已齐备', level: 'ok', detail: '本次无需改动' },
  { key: 'bot', label: '已启用机器人能力', level: 'done' },
  { key: 'publish', label: '已提交发布', level: 'done', detail: '仅为提交成功' }
];

function larkResult(overrides: Partial<LarkBindResult> & { outcome: LarkBindResult['outcome'] }): LarkBindResult {
  return {
    appId: 'cli_ok',
    steps: LARK_STEPS,
    account: { userName: '测试用户', tenantName: '测试企业' },
    sessionSource: 'cache',
    warnings: [],
    next: `飞书应用 cli_ok 已配置完成`,
    ...overrides
  };
}

interface HarnessOptions {
  cwd: string;
  existing?: Record<string, string>;
  agents?: DetectedAgent[];
  /** 注入的 writeEnv 汇报的落盘结果。 */
  changed?: boolean;
  prompter?: Prompter;
  bind?: (options: LarkBindOptions) => Promise<LarkBindResult>;
  /** 已保存的机器人（readBot 的返回）；缺省为库里没有这个机器人。 */
  storedBot?: ExistingBot;
  readSecretFd?: (fd: string) => Promise<string>;
  smoke?: typeof offerLarkSetupSmoke;
  terminalBackendProbe?: TerminalBackendProbe;
  readTerminalBackend?: () => Promise<'tmux' | 'herdr'>;
}

function harness(options: HarnessOptions) {
  // interactive 取自 process.stdin.isTTY；固定成 false，测试才不会随运行环境漂移。
  setIsTTY(false);
  const out = fakeStream();
  const err = fakeStream();
  const ui = createCliUi({ stdout: out, stderr: err, color: false, tty: false });
  const existing = new Map(Object.entries(options.existing ?? {}));
  const changed = options.changed ?? true;
  const writeEnv = vi.fn((path: string, updates: Record<string, string | undefined>): WriteEnvResult => ({
    path,
    changed,
    changedKeys: changed ? Object.keys(updates).filter(key => updates[key] !== undefined) : [],
    created: false
  }));
  const bind = vi.fn(options.bind ?? (async (): Promise<LarkBindResult> => {
    throw new Error('bind must not be called');
  }));
  const detect = vi.fn((): DetectedAgent[] => options.agents ?? [AGENT]);
  const readExisting = vi.fn((): Map<string, string> => new Map(existing));
  const prompter = options.prompter ?? strictPrompter();
  // 数据库层必须注入：默认实现会按 HOME 下的 last-daemon-dir 去打开真实 daemon 的库。
  const readBot = vi.fn(async (): Promise<ExistingBot | undefined> => options.storedBot);
  const saveBot = vi.fn(async (input: SaveBotInput): Promise<SaveBotResult> => ({
    existed: options.storedBot !== undefined,
    changed: true,
    hasSecret: Boolean(input.appSecret ?? options.storedBot?.appSecret),
    ...((input.defaultAgentId ?? options.storedBot?.defaultAgentId) ? { defaultAgentId: input.defaultAgentId ?? options.storedBot?.defaultAgentId } : {}),
    listening: input.listen === true || options.storedBot?.listening === true
  }));
  const smoke = vi.fn(options.smoke ?? (async () => ({ status: 'skipped' as const, message: '已跳过飞书收发验证，未发送任何消息。' })));
  const terminalBackendProbe = vi.fn(options.terminalBackendProbe ?? (async () => ({ status: 'ok' as const })));
  const readTerminalBackend = vi.fn(options.readTerminalBackend ?? (async () => 'tmux' as const));
  const deps: SetupDependencies = {
    ui, prompter, cwd: options.cwd, env: {}, detect, bind, writeEnv, readExisting,
    readBot, saveBot, smoke, terminalBackendProbe, readTerminalBackend, database: join(options.cwd, 'fixture.db'),
    ...(options.readSecretFd ? { readSecretFd: options.readSecretFd } : {})
  };
  return { out, err, deps, writeEnv, bind, detect, readExisting, readBot, saveBot, smoke, terminalBackendProbe, readTerminalBackend };
}

/** writeEnv 收到的 updates（第 n 次调用）。 */
function updatesOf(writeEnv: ReturnType<typeof harness>['writeEnv'], index = 0): Record<string, string | undefined> {
  const call = writeEnv.mock.calls[index];
  expect(call).toBeDefined();
  return call![1];
}

describe('runSetup', () => {
  it('writes the whole plan exactly once in a non-interactive full run', async () => {
    const dir = await makeTempDir();
    const { deps, writeEnv } = harness({ cwd: dir });

    const result = await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('setup');
    expect(result.changed).toBe(true);
    expect(result.changedKeys).toContain('DUTYDECK_DEFAULT_CWD');
    expect(result.defaultCwd).toBe(dir);
    expect(result.port).toBe('4310');
    expect(result.envFile).toBe(join(dir, '.env'));
    expect(result.next).toBe('dutydeck start');
    // 关键契约：绝不逐步增量写盘，只有全部校验通过后的那一次原子写入。
    expect(writeEnv).toHaveBeenCalledTimes(1);
    expect(writeEnv).toHaveBeenCalledWith(join(dir, '.env'), expect.objectContaining({ DUTYDECK_DEFAULT_CWD: dir }));
  });

  it('reports no change on an idempotent re-run and distinguishes initial from update mode', async () => {
    const dir = await makeTempDir();
    const existing = { DUTYDECK_DEFAULT_CWD: dir, DUTYDECK_PORT: '4310' };
    const update = harness({ cwd: dir, existing, changed: false });

    const rerun = await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, update.deps);

    expect(rerun.ok).toBe(true);
    expect(rerun.changed).toBe(false);
    expect(rerun.changedKeys).toEqual([]);
    expect(rerun.mode).toBe('update');
    expect(rerun.next).toContain('无需改动');
    // 值都没变，连一个 update 键都不该攒出来。
    expect(updatesOf(update.writeEnv)).toEqual({});

    const initial = harness({ cwd: dir, existing: {} });
    const first = await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, initial.deps);
    expect(first.mode).toBe('initial');
  });

  it('never prompts under --json and emits exactly one machine-readable line', async () => {
    const dir = await makeTempDir();
    const { deps, out, err } = harness({ cwd: dir });

    const result = await runSetup({ json: true, cwd: dir, port: '4310', skipLark: true, yes: true }, deps);

    expect(result.ok).toBe(true);
    const stdout = out.read();
    expect(stdout.endsWith('\n')).toBe(true);
    const lines = stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toHaveProperty('ok');
    expect(parsed).toHaveProperty('next');
    expect(parsed.action).toBe('setup');
    // jq 可直接消费：无颜色、无人类装饰。
    expect(stdout).not.toContain('\x1b[');
    expect(err.read()).toBe('');
  });

  it('masks secrets in --json output', async () => {
    const dir = await makeTempDir();
    const secret = 'sEcRet-do-NOT-leak-9f3a';
    const { deps, out } = harness({
      cwd: dir,
      existing: { DUTYDECK_DEFAULT_CWD: dir, DUTYDECK_PORT: '4310', LARK_APP_SECRET: secret }
    });

    await runSetup({ json: true, cwd: dir, port: '4310', skipLark: true, yes: true }, deps);

    const stdout = out.read();
    expect(stdout).not.toContain(secret);
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  });

  it('重跑时只回显向导管理的非机密项：.env 里嵌套的 Agent 令牌和旧版凭据在文本与 --json 输出里都不出现', async () => {
    const dir = await makeTempDir();
    const envFile = join(dir, '.env');
    const secrets = [
      'synthetic-lark-secret-0001', 'synthetic-legacy-github-0002', 'synthetic-legacy-webhook-0003',
      'synthetic-nested-agent-token-0004', 'synthetic-api-key-0005'
    ];
    writeFileSync(envFile, [
      `DUTYDECK_DEFAULT_CWD=${dir}`,
      'DUTYDECK_PORT=4310',
      'LARK_APP_ID=cli_synthetic',
      `LARK_APP_SECRET=${secrets[0]}`,
      `GITHUB_TOKEN=${secrets[1]}`,
      `DUTYDECK_CODEBASE_WEBHOOK_SECRET=${secrets[2]}`,
      `DUTYDECK_AGENTS_JSON='${JSON.stringify([{ id: 'proxy', command: 'claude', env: { ANTHROPIC_AUTH_TOKEN: secrets[3] } }])}'`,
      `ANTHROPIC_API_KEY=${secrets[4]}`
    ].join('\n') + '\n', { mode: 0o600 });

    for (const json of [false, true]) {
      const { deps, out, err } = harness({ cwd: dir });
      const result = await runSetup({ json, skipLark: true, yes: true, envFile }, { ...deps, readExisting: readExistingConfig });
      expect(result).toMatchObject({ ok: true, mode: 'update' });
      const printed = out.read() + err.read();
      for (const secret of secrets) expect(printed).not.toContain(secret);
      if (json) continue;
      // 其余键只列键名；向导管理的非机密项照常显示，飞书 Secret 仍按末 4 位打码。
      expect(printed).toMatch(/GITHUB_TOKEN +\(内容不回显\)/);
      expect(printed).toMatch(/DUTYDECK_AGENTS_JSON +\(内容不回显\)/);
      expect(printed).toMatch(/LARK_APP_ID +cli_synthetic/);
      expect(printed).toMatch(/DUTYDECK_PORT +4310/);
      expect(printed).toMatch(/LARK_APP_SECRET +\*\*\*\*0001/);
    }
  });

  it('fails in non-interactive mode naming the flag that would unblock it', async () => {
    const dir = await makeTempDir();
    const prompter: Prompter = {
      interactive: false,
      async ask<T>(options: AskOptions<T>): Promise<T> {
        throw new PromptUnavailableError(options.question, options.remedyFlag);
      },
      async choose<T>(): Promise<T> { throw new Error('prompter.choose must not be called'); },
      async confirm(): Promise<boolean> { return false; },
      async secret(): Promise<string> { throw new Error('prompter.secret must not be called'); },
      close() {}
    };
    const { deps, writeEnv, out } = harness({ cwd: dir, existing: {}, prompter });

    const result = await runSetup({ skipLark: true }, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SETUP_INPUT_REQUIRED');
    expect(result.next).toContain('--cwd');
    expect(out.read()).toContain('--cwd');
    expect(writeEnv).not.toHaveBeenCalled();
  });

  it('writes nothing when --cwd does not exist', async () => {
    const dir = await makeTempDir();
    const missing = join(dir, 'no-such-directory');
    const { deps, writeEnv } = harness({ cwd: dir });

    const result = await runSetup({ cwd: missing, port: '4310', skipLark: true, yes: true }, deps);

    expect(result.ok).toBe(false);
    // 「要么写完整，要么什么都不写」——这里一次写入都不能发生。
    expect(writeEnv).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.changedKeys).toEqual([]);
    expect(result.error?.message).toContain(missing);
  });

  it('rejects an invalid --port in Chinese without writing anything', async () => {
    const dir = await makeTempDir();
    const { deps, writeEnv, out } = harness({ cwd: dir });

    const result = await runSetup({ cwd: dir, port: '99999', skipLark: true, yes: true }, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('端口');
    expect(result.error?.message).toContain('1-65535');
    expect(result.error?.message).toMatch(/[一-龥]/);
    expect(out.read()).toContain('端口');
    expect(writeEnv).not.toHaveBeenCalled();
  });

  it('surfaces a failed Lark bind next command verbatim', async () => {
    const dir = await makeTempDir();
    const failed: LarkBindResult = {
      outcome: 'failed',
      appId: 'cli_x',
      steps: [],
      warnings: [],
      next: 'dutydeck setup --lark-app-id cli_x --force-login',
      error: { code: 'X', message: 'boom' }
    };
    const { deps, writeEnv, bind, out } = harness({ cwd: dir, bind: async () => failed });

    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_x', yes: true }, deps);

    expect(bind).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    // 算好的续跑命令绝不能被泛泛的建议替换。
    expect(result.next).toBe('dutydeck setup --lark-app-id cli_x --force-login');
    expect(out.read()).toContain('dutydeck setup --lark-app-id cli_x --force-login');
    expect(result.error).toEqual({ code: 'X', message: 'boom' });
    expect(result.lark).toBe(failed);
    // 前三步是纯本地且已校验，飞书失败不该丢掉它们；但绝不能记下没绑成功的 app id。
    expect(writeEnv).toHaveBeenCalledTimes(1);
    expect(updatesOf(writeEnv)).not.toHaveProperty('LARK_APP_ID');
  });

  it('emits exactly one JSON failure with the saved local changes when Lark binding returns failed', async () => {
    const dir = await makeTempDir();
    const failed: LarkBindResult = {
      outcome: 'failed', appId: 'cli_x', steps: [], warnings: [],
      next: 'dutydeck setup --lark-app-id cli_x --force-login',
      error: { code: 'fixture_failure', message: 'fixture failed' }
    };
    const { deps, out, err, writeEnv } = harness({ cwd: dir, bind: async () => failed });

    const result = await runSetup({ json: true, cwd: dir, port: '14310', larkAppId: 'cli_x', yes: true }, deps);

    expect(result).toMatchObject({ ok: false, changed: true, error: failed.error, next: failed.next });
    expect(result.changedKeys).toEqual(expect.arrayContaining(['DUTYDECK_DEFAULT_CWD', 'DUTYDECK_PORT']));
    expect(result.changedKeys).not.toContain('LARK_APP_ID');
    expect(out.read().trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(out.read())).toEqual(result);
    expect(err.read()).toBe('');
    expect(writeEnv).toHaveBeenCalledTimes(1);
  });

  it('records LARK_APP_ID after a successful bind and warns about the missing secret', async () => {
    const dir = await makeTempDir();
    const ready = larkResult({ outcome: 'ready', appId: 'cli_ok', warnings: ['请到管理台确认版本状态'] });
    const { deps, writeEnv, bind } = harness({ cwd: dir, existing: {}, bind: async () => ready });

    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls[0]![0]).toMatchObject({ appId: 'cli_ok', assumeYes: true, json: false });
    expect(writeEnv).toHaveBeenCalledTimes(1);
    expect(updatesOf(writeEnv)).toMatchObject({ LARK_APP_ID: 'cli_ok' });
    expect(result.warnings.some(warning => warning.includes('LARK_APP_SECRET'))).toBe(true);
    expect(result.warnings).toContain('请到管理台确认版本状态');
  });

  it('passes a saved Secret to slash sync only when it belongs to the selected App ID', async () => {
    const dir = await makeTempDir();
    const secret = 'private-matching-secret';
    const ready = larkResult({ outcome: 'ready', appId: 'cli_ok' });
    const matching = harness({ cwd: dir, existing: { LARK_APP_ID: 'cli_ok', LARK_APP_SECRET: secret }, bind: async () => ready });
    await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', yes: true }, matching.deps);
    expect(matching.bind.mock.calls[0]![0].appSecret).toBe(secret);

    const other = harness({ cwd: dir, existing: { LARK_APP_ID: 'cli_other', LARK_APP_SECRET: secret }, bind: async () => ready });
    await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', yes: true }, other.deps);
    expect(other.bind.mock.calls[0]![0]).not.toHaveProperty('appSecret');
  });

  it('never calls bind under --skip-lark and tells the user how to bind later', async () => {
    const dir = await makeTempDir();
    const { deps, bind, out, writeEnv } = harness({ cwd: dir });

    const result = await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(bind).not.toHaveBeenCalled();
    expect(result.lark).toBeUndefined();
    expect(out.read()).toContain('dutydeck setup --lark-app-id cli_xxx');
    expect(updatesOf(writeEnv)).not.toHaveProperty('LARK_APP_ID');
  });

  it('warns but succeeds when no agent CLI is detected', async () => {
    const dir = await makeTempDir();
    const { deps, out } = harness({ cwd: dir, agents: [] });

    const result = await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(result.agents).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(warning => warning.includes('Agent CLI'))).toBe(true);
    expect(out.read()).toContain('未检测到任何已安装的 Agent CLI');
  });

  it('keeps results on stdout and progress on stderr', async () => {
    const dir = await makeTempDir();
    const { deps, out, err } = harness({
      cwd: dir,
      bind: async (options: LarkBindOptions) => {
        // bind 内部的进度与提示必须落在 stderr，否则 `dutydeck setup | head -1` 失去意义。
        options.ui.progress('正在配置飞书应用 cli_ok');
        options.ui.notice('请用飞书 App 扫码');
        return larkResult({ outcome: 'ready', appId: 'cli_ok' });
      }
    });

    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', yes: true }, deps);

    expect(result.ok).toBe(true);
    const stdout = out.read();
    const stderr = err.read();
    expect(stdout).toContain('配置结果');
    expect(stdout).toContain('接下来做什么');
    expect(stdout).toContain('dutydeck start');
    expect(stderr).toContain('正在配置飞书应用 cli_ok');
    expect(stderr).toContain('请用飞书 App 扫码');
    expect(stdout).not.toContain('正在配置飞书应用');
    expect(stdout).not.toContain('请用飞书 App 扫码');
    // pending 符号只由 progress（stderr）使用。
    expect(stdout).not.toContain(symbolFor('pending'));
  });

  it('warns when a reused .env working directory no longer exists', async () => {
    // 沿用旧值是唯一不过 validateWorkingDirectory 的路径：目录可能在写入后被删了。
    const dir = await makeTempDir();
    const stale = join(dir, 'deleted-since');
    const { deps, out } = harness({ cwd: dir, existing: { DUTYDECK_DEFAULT_CWD: stale, DUTYDECK_PORT: '4310' } });

    const result = await runSetup({ port: '4310', skipLark: true, yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(result.defaultCwd).toBe(stale);
    expect(result.warnings.some(warning => warning.includes(stale))).toBe(true);
    expect(out.read()).toContain(symbolFor('warn'));
    expect(out.read()).toContain('dutydeck setup --cwd');
  });

  it('reports the stale-directory warning in --json too, where no human output exists', async () => {
    // 警告的计算不能挂在渲染模式上：机器调用方看不到人类输出，最需要这条结构化警告。
    const dir = await makeTempDir();
    const stale = join(dir, 'deleted-since');
    const { deps, out } = harness({ cwd: dir, existing: { DUTYDECK_DEFAULT_CWD: stale, DUTYDECK_PORT: '4310' } });

    const result = await runSetup({ port: '4310', skipLark: true, yes: true, json: true }, deps);

    expect(result.warnings.some(warning => warning.includes(stale))).toBe(true);
    const parsed = JSON.parse(out.read().trim()) as { warnings: string[] };
    expect(parsed.warnings.some(warning => warning.includes(stale))).toBe(true);
  });

  it('does not warn when the reused working directory still exists', async () => {
    const dir = await makeTempDir();
    const { deps } = harness({ cwd: dir, existing: { DUTYDECK_DEFAULT_CWD: dir, DUTYDECK_PORT: '4310' } });

    const result = await runSetup({ port: '4310', skipLark: true, yes: true }, deps);

    expect(result.warnings.some(warning => warning.includes('已不存在'))).toBe(false);
  });

  it('adds one tmux warning for a terminal Agent without blocking the configuration write', async () => {
    const dir = await makeTempDir();
    const terminal = { ...AGENT, protocol: 'pty-cli' as const, adapterId: 'claude-code' };
    const { deps, writeEnv, terminalBackendProbe, out } = harness({
      cwd: dir, agents: [terminal], terminalBackendProbe: async () => ({ status: 'not_found' })
    });
    const result = await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, deps);
    expect(result.ok).toBe(true);
    expect(writeEnv).toHaveBeenCalledOnce();
    expect(terminalBackendProbe).toHaveBeenCalledOnce();
    expect(result.warnings.filter(warning => warning.includes('terminal.backend'))).toHaveLength(1);
    expect(result.warnings.join('\n')).toContain('PATH');
    expect(out.read().match(/terminal\.backend/g)).toHaveLength(1);
  });

  it('shows one successful terminal.backend line with the version and private socket result', async () => {
    const dir = await makeTempDir();
    const terminal = { ...AGENT, protocol: 'pty-cli' as const, adapterId: 'claude-code' };
    const { deps, out } = harness({
      cwd: dir, agents: [terminal], terminalBackendProbe: async () => ({ status: 'ok', version: 'tmux 3.4' })
    });
    const result = await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, deps);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter(warning => warning.includes('terminal.backend'))).toHaveLength(0);
    expect(out.read().match(/terminal\.backend/g)).toHaveLength(1);
    expect(out.read()).toContain('tmux 3.4');
    expect(out.read()).toContain('私有 socket 可用');
  });

  it('does not run the tmux probe for ACP-only or Herdr setups', async () => {
    const dir = await makeTempDir();
    const acp = harness({ cwd: dir, agents: [AGENT] });
    expect((await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, acp.deps)).ok).toBe(true);
    expect(acp.terminalBackendProbe).not.toHaveBeenCalled();

    const terminal = { ...AGENT, protocol: 'pty-cli' as const, adapterId: 'claude-code' };
    const herdr = harness({ cwd: dir, agents: [terminal], readTerminalBackend: async () => 'herdr' });
    expect((await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, herdr.deps)).ok).toBe(true);
    expect(herdr.terminalBackendProbe).not.toHaveBeenCalled();
  });

  it.each(['invalid-cwd', 'cancel'] as const)('keeps a real schema v1 database untouched when setup later fails (%s)', async scenario => {
    const dir = await makeTempDir();
    const terminal = { ...AGENT, protocol: 'pty-cli' as const, adapterId: 'claude-code' };
    const prompter: Prompter | undefined = scenario === 'cancel' ? {
      ...strictPrompter(), interactive: true,
      async ask<T>(): Promise<T> { throw new PromptAbortedError(); }
    } : undefined;
    const { deps, writeEnv, terminalBackendProbe } = harness({ cwd: dir, agents: [terminal], ...(prompter ? { prompter } : {}) });
    createSchemaV1Database(deps.database!);
    expectOnlySchemaV1(deps.database!);
    delete deps.readTerminalBackend;
    if (scenario === 'cancel') setIsTTY(true);

    const result = await runSetup({
      cwd: scenario === 'invalid-cwd' ? join(dir, 'missing') : undefined,
      port: '4310', skipLark: true, yes: scenario === 'invalid-cwd'
    }, deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(scenario === 'cancel' ? 'SETUP_ABORTED' : 'SETUP_FAILED');
    expect(terminalBackendProbe).toHaveBeenCalledOnce();
    expect(writeEnv).toHaveBeenCalledTimes(0);
    expectOnlySchemaV1(deps.database!);
  });

  it('uses the tmux default without creating configs in a legacy schema that lacks the table', async () => {
    const dir = await makeTempDir();
    const terminal = { ...AGENT, protocol: 'pty-cli' as const, adapterId: 'claude-code' };
    const { deps, terminalBackendProbe } = harness({ cwd: dir, agents: [terminal] });
    createSchemaV1Database(deps.database!, { configs: false });
    delete deps.readTerminalBackend;

    const result = await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(terminalBackendProbe).toHaveBeenCalledOnce();
    expectOnlySchemaV1(deps.database!);
  });

  it.each([
    { stored: 'herdr', warning: false },
    { stored: 'invalid-backend', warning: true }
  ])('validates a real persisted terminal backend without migrating schema v1 (%s)', async ({ stored, warning }) => {
    const dir = await makeTempDir();
    const terminal = { ...AGENT, protocol: 'pty-cli' as const, adapterId: 'claude-code' };
    const { deps, terminalBackendProbe } = harness({ cwd: dir, agents: [terminal] });
    createSchemaV1Database(deps.database!, { terminalBackend: stored });
    delete deps.readTerminalBackend;

    const result = await runSetup({ cwd: dir, port: '4310', skipLark: true, yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(terminalBackendProbe).not.toHaveBeenCalled();
    expect(result.warnings.some(item => item.includes('终端后端设置读取失败'))).toBe(warning);
    expectOnlySchemaV1(deps.database!);
  });
});

describe('runSetup —— 默认 Agent 与 App Secret', () => {
  const CODEX: DetectedAgent = { id: 'codex', name: 'Codex', command: 'codex', version: '0.9.0', protocol: 'acp', builtin: true };
  const SECRET = 'real-app-secret-must-never-leak';
  const ready = () => larkResult({ outcome: 'ready', appId: 'cli_ok' });

  it.each([AGENT, { ...AGENT, protocol: 'pty-cli' as const, adapterId: 'claude-code' }])('真实保存支持审批的 $protocol Agent，未指定 --agent 时仍选首个探测结果', async agent => {
    const dir = await makeTempDir();
    const { deps } = harness({ cwd: dir, agents: [agent, CODEX], bind: async () => ready(), readSecretFd: async () => SECRET });
    const result = await runSetup({ cwd: dir, larkAppId: 'cli_ok', larkAppSecretFd: '0', yes: true }, { ...deps, saveBot: saveRealBot });
    expect(result.ok).toBe(true);
    expect(result.defaultAgentId).toBe(agent.id);
    const repositories = createRepositories(deps.database!);
    try {
      expect(await readLarkConfig(repositories.config, 'cli_ok')).toMatchObject({ defaultAgentId: agent.id, permissionMode: 'ask' });
    } finally { repositories.close(); }
  });

  it.each([false, true])('真实保存拒绝不支持审批的新建机器人，给出可操作失败且不泄密（json=%s）', async json => {
    const dir = await makeTempDir();
    const { deps, out, err, writeEnv } = harness({ cwd: dir, agents: [{ ...CODEX, protocol: 'pty-cli', adapterId: 'codex' }], bind: async () => ready(), readSecretFd: async () => SECRET });
    const result = await runSetup({ cwd: dir, larkAppId: 'cli_ok', agent: 'codex', larkAppSecretFd: '0', yes: true, json }, { ...deps, saveBot: saveRealBot });
    expect(result).toMatchObject({ ok: false, changed: false, error: { code: 'LARK_APPROVAL_UNSUPPORTED', message: expect.stringContaining('请选择支持审批的 Agent') }, next: 'dutydeck setup --lark-app-id cli_ok --agent <id>' });
    expect(writeEnv).not.toHaveBeenCalled();
    expect(JSON.stringify(result) + out.read() + err.read()).not.toContain(SECRET);
    if (json) expect(JSON.parse(out.read().trim())).toEqual(result);
    else {
      expect(out.read() + err.read()).toContain(result.next);
      expect(out.read() + err.read()).not.toContain('未写入任何配置');
    }
    const repositories = createRepositories(deps.database!);
    try {
      expect(await readLarkConfig(repositories.config, 'cli_ok')).toBeUndefined();
    } finally { repositories.close(); }
  });

  it('没有探测到 Agent 时真实保存凭据并提示补选，不自动选择 Agent', async () => {
    const dir = await makeTempDir();
    const { deps } = harness({ cwd: dir, agents: [], bind: async () => ready(), readSecretFd: async () => SECRET });
    const result = await runSetup({ cwd: dir, larkAppId: 'cli_ok', larkAppSecretFd: '0', yes: true }, { ...deps, saveBot: saveRealBot });
    expect(result.ok).toBe(true);
    expect(result.defaultAgentId).toBeUndefined();
    expect(result.warnings).toContain('机器人没有默认 Agent：本机没有检测到 Agent CLI。装好后重跑 dutydeck setup --agent <id>。');
  });

  it('拒绝未检测到的 --agent，且在任何写入或飞书绑定之前', async () => {
    const dir = await makeTempDir();
    const { deps, bind, writeEnv, saveBot } = harness({ cwd: dir, agents: [AGENT], bind: async () => ready() });
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', agent: 'ghost', yes: true }, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('未检测到 Agent「ghost」');
    expect(result.error?.message).toContain('claude');
    expect(bind).not.toHaveBeenCalled();
    expect(writeEnv).not.toHaveBeenCalled();
    expect(saveBot).not.toHaveBeenCalled();
  });

  it('--lark-app-secret-fd 读到的 Secret 与 --agent 一起写入机器人配置，Secret 不出现在任何输出里', async () => {
    const dir = await makeTempDir();
    const { deps, bind, saveBot, out, err } = harness({ cwd: dir, agents: [AGENT, CODEX], bind: async () => ready(), readSecretFd: async () => SECRET });
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', agent: 'codex', larkAppSecretFd: '0', yes: true }, deps);
    expect(result.ok).toBe(true);
    expect(saveBot).toHaveBeenCalledTimes(1);
    expect(saveBot.mock.calls[0]![0]).toMatchObject({ database: join(dir, 'fixture.db'), appId: 'cli_ok', appSecret: SECRET, defaultAgentId: 'codex', workspace: dir });
    expect(bind.mock.calls[0]![0].appSecret).toBe(SECRET);
    expect(result.defaultAgentId).toBe('codex');
    expect(result.bot).toMatchObject({ appId: 'cli_ok', hasSecret: true, defaultAgentId: 'codex', listening: false });
    expect(result.warnings.some(warning => warning.includes('尚未提供 App Secret'))).toBe(false);
    expect(JSON.stringify(result) + out.read() + err.read()).not.toContain(SECRET);
  });

  it('--json 下同样写入，结果里只有布尔 hasSecret，没有 Secret 本身', async () => {
    const dir = await makeTempDir();
    const { deps, out } = harness({ cwd: dir, agents: [AGENT], bind: async () => ready(), readSecretFd: async () => SECRET });
    await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', larkAppSecretFd: '0', json: true }, deps);
    const printed = out.read();
    expect(printed).not.toContain(SECRET);
    expect(JSON.parse(printed.trim().split('\n').at(-1)!).bot.hasSecret).toBe(true);
  });

  it('真实文件描述符：从 fd 读 Secret 并去掉末尾换行', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'secret.txt');
    writeFileSync(file, `${SECRET}\n`);
    const fd = openSync(file, 'r');
    try {
      const { deps, saveBot } = harness({ cwd: dir, agents: [AGENT], bind: async () => ready() });
      const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', larkAppSecretFd: String(fd), yes: true }, deps);
      expect(result.ok).toBe(true);
      expect(saveBot.mock.calls[0]![0].appSecret).toBe(SECRET);
    } finally { closeSync(fd); }
  });

  it('fd 读不到内容时失败，不写任何配置', async () => {
    const dir = await makeTempDir();
    const { deps, writeEnv, bind } = harness({ cwd: dir, agents: [AGENT], bind: async () => ready(), readSecretFd: async () => '' });
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', larkAppSecretFd: '0', yes: true }, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('没有读到 App Secret');
    expect(bind).not.toHaveBeenCalled();
    expect(writeEnv).not.toHaveBeenCalled();
  });

  it('非交互且没给 --agent：新机器人取第一个检测到的 Agent', async () => {
    const dir = await makeTempDir();
    const { deps, saveBot } = harness({ cwd: dir, agents: [CODEX, AGENT], bind: async () => ready(), readSecretFd: async () => SECRET });
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', larkAppSecretFd: '0', yes: true }, deps);
    expect(saveBot.mock.calls[0]![0].defaultAgentId).toBe('codex');
    expect(result.defaultAgentId).toBe('codex');
  });

  it('重跑向导不会悄悄换掉机器人已有的默认 Agent', async () => {
    const dir = await makeTempDir();
    const { deps, saveBot } = harness({ cwd: dir, agents: [CODEX, AGENT], bind: async () => ready(), storedBot: { appSecret: SECRET, defaultAgentId: 'claude', listening: false } });
    await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', yes: true }, deps);
    expect(saveBot.mock.calls[0]![0]).not.toHaveProperty('defaultAgentId');
    expect(saveBot.mock.calls[0]![0]).not.toHaveProperty('appSecret');
  });

  it('沿用 .env 里同一应用的旧 LARK_APP_SECRET，并迁进机器人配置', async () => {
    const dir = await makeTempDir();
    const { deps, saveBot } = harness({ cwd: dir, agents: [AGENT], existing: { LARK_APP_ID: 'cli_ok', LARK_APP_SECRET: SECRET }, bind: async () => ready() });
    await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', yes: true }, deps);
    expect(saveBot.mock.calls[0]![0].appSecret).toBe(SECRET);
  });

  it('机器人已保存的 Secret 优先于 .env 里可能已过期的旧值', async () => {
    const dir = await makeTempDir();
    const { deps, saveBot, bind } = harness({ cwd: dir, agents: [AGENT], existing: { LARK_APP_ID: 'cli_ok', LARK_APP_SECRET: 'stale-env-secret' }, storedBot: { appSecret: SECRET, defaultAgentId: 'claude', listening: false }, bind: async () => ready() });
    await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', yes: true }, deps);
    expect(bind.mock.calls[0]![0].appSecret).toBe(SECRET);
    expect(saveBot.mock.calls[0]![0]).not.toHaveProperty('appSecret');
  });

  it('非交互也没有 Secret 时不保存机器人，并给出补 Secret 的命令', async () => {
    const dir = await makeTempDir();
    const { deps, saveBot } = harness({ cwd: dir, agents: [AGENT], bind: async () => ready() });
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', yes: true }, deps);
    expect(result.ok).toBe(true);
    expect(saveBot).not.toHaveBeenCalled();
    expect(result.bot).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('--lark-app-secret-fd 0');
  });

  it('交互：隐藏输入 App Secret、用编号选默认 Agent', async () => {
    const dir = await makeTempDir();
    const calls: string[] = [];
    const prompter: Prompter = {
      interactive: true,
      async ask<T>(): Promise<T> { throw new Error('unexpected ask'); },
      async choose<T>(options: { question: string; choices: Array<{ value: T }> }): Promise<T> { calls.push(`choose:${options.question}`); return options.choices[1]!.value; },
      async confirm(): Promise<boolean> { return false; },
      async secret(): Promise<string> { calls.push('secret'); return SECRET; },
      close() {}
    };
    const { deps, saveBot, bind } = harness({ cwd: dir, agents: [AGENT, CODEX], bind: async () => ready(), prompter });
    setIsTTY(true);
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok' }, deps);
    expect(result.ok).toBe(true);
    expect(calls[0]).toBe('secret');
    expect(calls[1]).toContain('choose:默认 Agent');
    expect(bind.mock.calls[0]![0].appSecret).toBe(SECRET);
    expect(saveBot.mock.calls[0]![0]).toMatchObject({ appSecret: SECRET, defaultAgentId: 'codex' });
  });

  it('交互里直接回车跳过 Secret：不保存机器人', async () => {
    const dir = await makeTempDir();
    const prompter: Prompter = {
      interactive: true,
      async ask<T>(): Promise<T> { throw new Error('unexpected ask'); },
      async choose<T>(options: { choices: Array<{ value: T }> }): Promise<T> { return options.choices[0]!.value; },
      async confirm(): Promise<boolean> { return false; },
      async secret(): Promise<string> { return ''; },
      close() {}
    };
    const { deps, saveBot } = harness({ cwd: dir, agents: [AGENT], bind: async () => ready(), prompter });
    setIsTTY(true);
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok' }, deps);
    expect(result.ok).toBe(true);
    expect(saveBot).not.toHaveBeenCalled();
    expect(result.warnings.join('\n')).toContain('尚未提供 App Secret');
  });

  it('只给 --agent：改 .env 里那个机器人的默认 Agent，不碰开放平台', async () => {
    const dir = await makeTempDir();
    const { deps, bind, saveBot, writeEnv } = harness({ cwd: dir, agents: [AGENT, CODEX], existing: { LARK_APP_ID: 'cli_ok' }, storedBot: { appSecret: SECRET, defaultAgentId: 'claude', listening: true } });
    const result = await runSetup({ cwd: dir, port: '4310', agent: 'codex', yes: true }, deps);
    expect(result.ok).toBe(true);
    expect(bind).not.toHaveBeenCalled();
    expect(saveBot.mock.calls[0]![0]).toMatchObject({ appId: 'cli_ok', defaultAgentId: 'codex' });
    expect(updatesOf(writeEnv)).not.toHaveProperty('LARK_APP_ID');
  });

  it('只给 --agent 但没有机器人可改：失败并说明需要 --lark-app-id', async () => {
    const dir = await makeTempDir();
    const { deps, writeEnv, saveBot } = harness({ cwd: dir, agents: [AGENT] });
    const result = await runSetup({ cwd: dir, port: '4310', agent: 'claude', yes: true }, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('--lark-app-id');
    expect(writeEnv).not.toHaveBeenCalled();
    expect(saveBot).not.toHaveBeenCalled();
  });

  it('--skip-lark 与 --agent 冲突、--lark-app-secret-fd 没有可指的机器人，都在写入前被拒绝', async () => {
    const dir = await makeTempDir();
    const first = harness({ cwd: dir, agents: [AGENT] });
    expect((await runSetup({ cwd: dir, skipLark: true, agent: 'claude', yes: true }, first.deps)).ok).toBe(false);
    const second = harness({ cwd: dir, agents: [AGENT] });
    const result = await runSetup({ cwd: dir, larkAppSecretFd: '0', yes: true }, second.deps);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('--lark-app-id');
    expect(first.writeEnv).not.toHaveBeenCalled();
    expect(second.writeEnv).not.toHaveBeenCalled();
  });

  it('只给 --lark-app-secret-fd：用 .env 里那个机器人的 App Secret 轮换，不碰开放平台', async () => {
    const dir = await makeTempDir();
    const { deps, bind, saveBot } = harness({ cwd: dir, agents: [AGENT], existing: { LARK_APP_ID: 'cli_ok' }, storedBot: { appSecret: 'old', defaultAgentId: 'claude', listening: false }, readSecretFd: async () => SECRET });
    const result = await runSetup({ cwd: dir, port: '4310', larkAppSecretFd: '0', yes: true }, deps);
    expect(result.ok).toBe(true);
    expect(bind).not.toHaveBeenCalled();
    expect(saveBot.mock.calls[0]![0]).toMatchObject({ appId: 'cli_ok', appSecret: SECRET });
  });

  it('交互新建机器人时询问是否立即开启监听，默认是；选否则不开', async () => {
    const dir = await makeTempDir();
    const asked: Array<{ question: string; defaultValue?: boolean }> = [];
    const make = (answer: boolean): Prompter => ({
      interactive: true,
      async ask<T>(): Promise<T> { throw new Error('unexpected ask'); },
      async choose<T>(options: { choices: Array<{ value: T }> }): Promise<T> { return options.choices[0]!.value; },
      async confirm(options): Promise<boolean> { asked.push(options); return answer; },
      async secret(): Promise<string> { return SECRET; },
      close() {}
    });
    const yes = harness({ cwd: dir, agents: [AGENT], bind: async () => ready(), prompter: make(true) });
    setIsTTY(true);
    await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok' }, yes.deps);
    expect(asked.find(item => item.question.includes('监听'))?.defaultValue).toBe(true);
    expect(yes.saveBot.mock.calls[0]![0].listen).toBe(true);
    const no = harness({ cwd: dir, agents: [AGENT], bind: async () => ready(), prompter: make(false) });
    setIsTTY(true);
    await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok' }, no.deps);
    expect(no.saveBot.mock.calls[0]![0]).not.toHaveProperty('listen');
  });

  it('非交互新建机器人不询问监听，没有 --listen 就不开', async () => {
    const dir = await makeTempDir();
    const { deps, saveBot } = harness({ cwd: dir, agents: [AGENT], bind: async () => ready(), readSecretFd: async () => SECRET });
    await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', larkAppSecretFd: '0', yes: true }, deps);
    expect(saveBot.mock.calls[0]![0]).not.toHaveProperty('listen');
  });

  it('--listen 传给机器人配置', async () => {
    const dir = await makeTempDir();
    const { deps, saveBot } = harness({ cwd: dir, agents: [AGENT], bind: async () => ready(), readSecretFd: async () => SECRET });
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', larkAppSecretFd: '0', listen: true, yes: true }, deps);
    expect(saveBot.mock.calls[0]![0].listen).toBe(true);
    expect(result.bot?.listening).toBe(true);
  });

  it.each([
    ['--yes', { yes: true }],
    ['--json', { json: true, yes: true }],
    ['non-interactive', {}]
  ])('setup %s never invokes the optional outbound smoke', async (_name, mode) => {
    const dir = await makeTempDir();
    const { deps, smoke, out, err } = harness({ cwd: dir, agents: [AGENT], bind: async () => ready(), readSecretFd: async () => SECRET });
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok', larkAppSecretFd: '0', ...mode }, deps);
    expect(result.ok).toBe(true);
    expect(smoke).not.toHaveBeenCalled();
    expect(out.read() + err.read()).not.toContain('一次性验证码');
    expect(out.read() + err.read()).not.toContain('私聊机器人');
  });

  it('offers the smoke only after writing a usable bot and keeps inbound timeout as a warning', async () => {
    const dir = await makeTempDir();
    const prompter: Prompter = {
      interactive: true,
      async ask<T>(): Promise<T> { throw new Error('unexpected ask'); },
      async choose<T>(options: { choices: Array<{ value: T }> }): Promise<T> { return options.choices[0]!.value; },
      async confirm(): Promise<boolean> { return false; },
      async secret(): Promise<string> { return SECRET; },
      close() {}
    };
    const smoke = vi.fn(async () => ({ status: 'inbound_unverified' as const, message: '未收到有效私聊；入站未验证，未发送任何消息。' }));
    const { deps, writeEnv } = harness({
      cwd: dir, agents: [AGENT], bind: async () => ready(), prompter, smoke,
      storedBot: { appSecret: SECRET, defaultAgentId: 'claude', listening: true }
    });
    setIsTTY(true);
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok' }, deps);
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('未收到有效私聊；入站未验证，未发送任何消息。');
    expect(smoke).toHaveBeenCalledWith(expect.objectContaining({
      database: join(dir, 'fixture.db'), appId: 'cli_ok', interactive: true, assumeYes: false
    }));
    // setup 只负责把真实监听给出的验证码呈现到终端，不传任何用户身份。
    expect(smoke.mock.calls[0]![0]).toHaveProperty('onVerificationCode');
    expect(writeEnv.mock.invocationCallOrder[0]).toBeLessThan(smoke.mock.invocationCallOrder[0]!);
  });

  it('displays the production smoke verification code through ui.notice after the listener is ready', async () => {
    const dir = await makeTempDir();
    let receive: ((event: { messageId: string; chatType: string; senderType: string; content: string }) => void) | undefined;
    const reply = vi.fn(async () => ({ messageId: 'om_reply' }));
    const smoke: typeof offerLarkSetupSmoke = options => offerLarkSetupSmoke({
      ...options,
      onVerificationCode: code => {
        options.onVerificationCode?.(code);
        queueMicrotask(() => receive?.({
          messageId: 'om_setup', chatType: 'p2p', senderType: 'user',
          content: JSON.stringify({ text: code })
        }));
      }
    }, {
      loadBot: async () => ({ appId: 'cli_ok', appSecret: SECRET, listening: true } as import('@dutydeck/shared').StoredLarkConfig),
      daemonStatus: () => ({ processStatus: 'stale' }),
      acquireRuntime: () => ({ close() {} }),
      startListener: async (_bot, onEvent) => { receive = onEvent; return vi.fn(); },
      reply
    });
    const prompter: Prompter = {
      interactive: true,
      async ask<T>(): Promise<T> { throw new Error('unexpected ask'); },
      async choose<T>(options: { choices: Array<{ value: T }> }): Promise<T> { return options.choices[0]!.value; },
      async confirm(): Promise<boolean> { return true; },
      async secret(): Promise<string> { return SECRET; },
      close() {}
    };
    const { deps, err } = harness({
      cwd: dir, agents: [AGENT], bind: async () => ready(), prompter, smoke,
      storedBot: { appSecret: SECRET, defaultAgentId: 'claude', listening: true }
    });
    setIsTTY(true);
    const result = await runSetup({ cwd: dir, port: '4310', larkAppId: 'cli_ok' }, deps);
    expect(result.ok).toBe(true);
    expect(reply).toHaveBeenCalledOnce();
    expect(err.read()).toContain('一次性验证码');
    expect(err.read()).toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    expect(err.read()).toContain('在飞书里私聊机器人发送这段验证码');
  });
});
