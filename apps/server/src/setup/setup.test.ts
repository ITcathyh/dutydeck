/**
 * `dutydeck setup` 编排器测试。
 *
 * 全部依赖都从 SetupDependencies 注入：不碰网络、不碰真实 .env、不写临时目录之外
 * 的任何东西。真实目录只用 mkdtemp 建、afterEach 删。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliUi, symbolFor } from '../cli-ui.js';
import type { DetectedAgent } from './detect.js';
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
  const deps: SetupDependencies = {
    ui, prompter, cwd: options.cwd, env: {}, detect, bind, writeEnv, readExisting
  };
  return { out, err, deps, writeEnv, bind, detect, readExisting };
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
