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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { createCliUi, symbolFor } from '../cli-ui.js';
import type { DetectedAgent } from './detect.js';
import { saveBot as saveRealBot, type ExistingBot, type SaveBotInput, type SaveBotResult } from './bot-store.js';
import { readLarkConfig } from '../lark/config.js';
import type { WriteEnvResult } from './env-file.js';
import type { LarkBindOptions, LarkBindResult } from './lark-bind.js';
import { PromptUnavailableError, type AskOptions, type Prompter } from './prompts.js';
import { runSetup, type SetupDependencies } from './setup.js';

const tempDirs: string[] = [];
const originalIsTTY = process.stdin.isTTY;

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-setup-'));
  tempDirs.push(dir);
  return dir;
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
  const deps: SetupDependencies = {
    ui, prompter, cwd: options.cwd, env: {}, detect, bind, writeEnv, readExisting,
    readBot, saveBot, database: join(options.cwd, 'fixture.db'),
    ...(options.readSecretFd ? { readSecretFd: options.readSecretFd } : {})
  };
  return { out, err, deps, writeEnv, bind, detect, readExisting, readBot, saveBot };
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
});
