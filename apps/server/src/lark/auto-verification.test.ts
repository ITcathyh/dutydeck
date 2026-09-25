// 改了代码就自动验证的判定回归：候选命令只按基准推断、本轮有没有改代码、要不要自动验证、
// 失败后返修几轮、哪些失败是验证工具本身的问题而不能发回 Agent 返修，以及待收尾记录（每个机器人一行）的读写。
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { ConfigRepository, VerificationResponse } from '@dutydeck/shared';
import {
  inferLarkVerificationCommand,
  isLarkVerificationInfrastructureFailure,
  larkInsideGitRepository,
  larkPendingVerificationKey,
  larkVerificationBase,
  larkVerificationOutcome,
  larkVerificationRepairPrompt,
  larkWorkspaceChanged,
  maxLarkPendingVerifications,
  maxLarkVerificationRepairRounds,
  mutateLarkPendingVerifications,
  parseLarkPendingVerifications,
  shouldAutoVerifyLarkTurn,
  type LarkPendingVerification
} from './auto-verification.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
function repository(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-auto-verify-'));
  directories.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Dutydeck Test');
  for (const [path, content] of Object.entries({ 'README.md': 'baseline\n', ...files })) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  return root;
}

const record = (patch: Partial<VerificationResponse> = {}): VerificationResponse => ({
  schemaVersion: 1, revision: 2, id: 'v1', sessionId: 's1', command: 'pnpm test', cwd: '/tmp',
  status: 'failed', startedAt: '2026-09-25T10:00:00.000Z', completedAt: '2026-09-25T10:01:00.000Z',
  exitCode: 1, output: 'FAIL src/login.test.ts', outputTruncated: false,
  beforeFingerprint: 'f1', afterFingerprint: 'f1', stale: false, ...patch
});

describe('候选验证命令推断', () => {
  it('package.json 的 typecheck 与 test 脚本按锁文件选包管理器，npm init 的占位测试不算', async () => {
    const pnpm = repository({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }), 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
    expect(await inferLarkVerificationCommand(pnpm, git(pnpm, 'rev-parse', 'HEAD'))).toBe('pnpm run typecheck && pnpm test');
    const npm = repository({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
    expect(await inferLarkVerificationCommand(npm, git(npm, 'rev-parse', 'HEAD'))).toBe('npm test');
    const yarn = repository({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.1.0', scripts: { test: 'jest' } }) });
    expect(await inferLarkVerificationCommand(yarn, git(yarn, 'rev-parse', 'HEAD'))).toBe('yarn test');
    const placeholder = repository({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    expect(await inferLarkVerificationCommand(placeholder, git(placeholder, 'rev-parse', 'HEAD'))).toBeUndefined();
  });

  it('Makefile 的 test 目标与 go.mod；变量赋值不是目标', async () => {
    const make = repository({ Makefile: 'build:\n\tgo build ./...\n\ntest: build\n\tgo test ./...\n', 'go.mod': 'module example.com/app\n' });
    expect(await inferLarkVerificationCommand(make, git(make, 'rev-parse', 'HEAD'))).toBe('make test');
    const go = repository({ Makefile: 'test := unit\nbuild:\n\tgo build ./...\n', 'go.mod': 'module example.com/app\n' });
    expect(await inferLarkVerificationCommand(go, git(go, 'rev-parse', 'HEAD'))).toBe('go test ./...');
    const none = repository({});
    expect(await inferLarkVerificationCommand(none, git(none, 'rev-parse', 'HEAD'))).toBeUndefined();
  });

  it('只读基准上的文件：工作区里 Agent 改过、新加的项目文件不参与推断', async () => {
    const root = repository({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
    const base = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'true', typecheck: 'true' } }));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    writeFileSync(join(root, 'go.mod'), 'module example.com/app\n');
    expect(await inferLarkVerificationCommand(root, base)).toBe('npm test');
    const empty = repository({});
    writeFileSync(join(empty, 'go.mod'), 'module example.com/app\n');
    expect(await inferLarkVerificationCommand(empty, git(empty, 'rev-parse', 'HEAD'))).toBeUndefined();
  });

  it('路径相对任务目录：子目录任务读的是子目录下的项目文件', async () => {
    const root = repository({ 'web/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
    expect(await inferLarkVerificationCommand(join(root, 'web'), git(root, 'rev-parse', 'HEAD'))).toBe('npm test');
    expect(await inferLarkVerificationCommand(root, git(root, 'rev-parse', 'HEAD'))).toBeUndefined();
  });
});

describe('基准与「本轮改了代码」', () => {
  it('worktree 取派生它的 commit；共享目录取 origin/HEAD，没有远端退回 HEAD；不是仓库返回 undefined', async () => {
    const origin = repository({});
    const originHead = git(origin, 'rev-parse', 'HEAD');
    const clone = mkdtempSync(join(tmpdir(), 'dutydeck-auto-verify-clone-'));
    directories.push(clone);
    execFileSync('git', ['clone', '-q', origin, clone]);
    git(clone, 'config', 'user.email', 'test@example.com');
    git(clone, 'config', 'user.name', 'Dutydeck Test');
    writeFileSync(join(clone, 'local.txt'), 'local\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'local commit');
    expect(await larkVerificationBase(clone)).toBe(originHead);
    expect(await larkVerificationBase(clone, { mode: 'worktree', baselineCommit: git(clone, 'rev-parse', 'HEAD') })).toBe(git(clone, 'rev-parse', 'HEAD'));
    expect(await larkVerificationBase(origin, { mode: 'shared' })).toBe(originHead);
    const plain = mkdtempSync(join(tmpdir(), 'dutydeck-auto-verify-plain-'));
    directories.push(plain);
    expect(await larkVerificationBase(plain)).toBeUndefined();
    expect(larkInsideGitRepository(plain)).toBe(false);
    expect(larkInsideGitRepository(join(clone, 'missing', 'nested'))).toBe(true);
  });

  it('相对基准的已跟踪改动、新文件、已提交的改动都算改了代码；.dutydeck 下的平台数据与忽略文件不算', async () => {
    const root = repository({ '.gitignore': 'dist/\n' });
    const base = git(root, 'rev-parse', 'HEAD');
    expect(await larkWorkspaceChanged(root, base)).toBe(false);
    mkdirSync(join(root, '.dutydeck'));
    writeFileSync(join(root, '.dutydeck', 'state.json'), '{}');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'out.js'), '');
    expect(await larkWorkspaceChanged(root, base)).toBe(false);
    writeFileSync(join(root, 'new.ts'), 'export {};\n');
    expect(await larkWorkspaceChanged(root, base)).toBe(true);
    git(root, 'add', 'new.ts');
    git(root, 'commit', '-qm', 'agent commit');
    expect(await larkWorkspaceChanged(root, base)).toBe(true);
    expect(await larkWorkspaceChanged(root, git(root, 'rev-parse', 'HEAD'))).toBe(false);
    writeFileSync(join(root, 'README.md'), 'changed\n');
    expect(await larkWorkspaceChanged(join(root, 'dist'), git(root, 'rev-parse', 'HEAD'))).toBe(true);
  });
});

describe('自动触发条件', () => {
  const base = { state: 'completed', command: 'pnpm test', changed: true };
  it('跑完、配了命令、改了代码、没有能证明当前代码的记录才自动验证', () => {
    expect(shouldAutoVerifyLarkTurn(base)).toBe(true);
    expect(shouldAutoVerifyLarkTurn({ ...base, latest: record({ stale: true, staleReason: 'code_changed' }) })).toBe(true);
    expect(shouldAutoVerifyLarkTurn({ ...base, latest: record({ status: 'passed', exitCode: 0, stale: true, staleReason: 'code_changed' }) })).toBe(true);
  });

  it('没改代码、没配命令、这一轮没跑完、正在验证或记录已能证明当前代码时都不跑', () => {
    expect(shouldAutoVerifyLarkTurn({ ...base, changed: false })).toBe(false);
    expect(shouldAutoVerifyLarkTurn({ ...base, command: '  ' })).toBe(false);
    expect(shouldAutoVerifyLarkTurn({ ...base, command: undefined })).toBe(false);
    for (const state of ['failed', 'interrupted', 'cancelled']) expect(shouldAutoVerifyLarkTurn({ ...base, state }), state).toBe(false);
    expect(shouldAutoVerifyLarkTurn({ ...base, latest: record({ status: 'running', stale: true }) })).toBe(false);
    // 当前代码已有结论（通过或失败都算），再跑一次得到的还是同一个结论。
    expect(shouldAutoVerifyLarkTurn({ ...base, latest: record({ status: 'passed', exitCode: 0 }) })).toBe(false);
    expect(shouldAutoVerifyLarkTurn({ ...base, latest: record() })).toBe(false);
  });
});

describe('返修上限与验证工具出错', () => {
  it('代码的失败最多返修两轮，第三次失败记为返修用完', () => {
    expect(maxLarkVerificationRepairRounds).toBe(2);
    expect(larkVerificationOutcome(record(), 0)).toEqual({ kind: 'repair', round: 1 });
    expect(larkVerificationOutcome(record(), 1)).toEqual({ kind: 'repair', round: 2 });
    expect(larkVerificationOutcome(record(), 2)).toEqual({ kind: 'exhausted' });
    expect(larkVerificationOutcome(record({ status: 'passed', exitCode: 0 }), 2)).toEqual({ kind: 'passed' });
  });

  it('命令不存在、不可执行、启动失败、超时、中断、结论未确认、没能启动都不发回返修', () => {
    const infrastructure = [
      record({ exitCode: 127, output: 'sh: 1: pnpm: not found' }),
      record({ exitCode: 126 }),
      record({ exitCode: undefined, error: 'spawn /bin/sh ENOENT' }),
      record({ exitCode: 1, error: 'Unable to establish verification process identity' }),
      record({ status: 'timed_out', exitCode: undefined }),
      record({ status: 'interrupted', exitCode: undefined }),
      record({ status: 'unverified', exitCode: 0, error: 'Repository content changed during verification' })
    ];
    for (const item of infrastructure) {
      expect(isLarkVerificationInfrastructureFailure(item), JSON.stringify(item)).toBe(true);
      expect(larkVerificationOutcome(item, 0), JSON.stringify(item)).toEqual({ kind: 'infrastructure' });
    }
    expect(larkVerificationOutcome(undefined, 0)).toEqual({ kind: 'infrastructure' });
    expect(isLarkVerificationInfrastructureFailure(record())).toBe(false);
  });

  it('返修请求带上命令、退出码和截断后的输出末尾，第一行不含命令与输出', () => {
    const prompt = larkVerificationRepairPrompt(record({ output: `${'x'.repeat(10_000)}\nFAIL: expected 2 got 3` }), 1);
    expect(prompt.split('\n')[0]).toBe('验证未通过，自动返修第 1/2 轮：按下面的失败输出修复代码。');
    expect(prompt).toContain('`pnpm test`');
    expect(prompt).toContain('退出码 1');
    expect(prompt).toContain('FAIL: expected 2 got 3');
    expect(prompt).toContain('前面已截断');
    expect(prompt.length).toBeLessThan(4_600);
    expect(larkVerificationRepairPrompt(record({ output: '', outputTruncated: true }), 2)).toContain('输出过长');
  });
});

describe('待收尾的自动验证：每个机器人一行', () => {
  const open = () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-auto-verify-pending-'));
    const repos = createRepositories(join(root, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    directories.push(root);
    closers.push(() => repos.close());
    return repos.config;
  };
  const closers: Array<() => void> = [];
  afterEach(() => { for (const close of closers.splice(0)) close(); });
  const add = (id: string) => (entries: LarkPendingVerification[]) => [...entries.filter(item => item.task_id !== id), { task_id: id }];
  const ids = async (store: ConfigRepository) => parseLarkPendingVerifications(await store.get(larkPendingVerificationKey('cli_a'))).map(item => item.task_id);

  it('并发写入不丢条目，并发移除后不残留', async () => {
    const store = open();
    const all = Array.from({ length: 30 }, (_, index) => `t${index}`);
    await Promise.all(all.map(id => mutateLarkPendingVerifications(store, 'cli_a', add(id))));
    expect((await ids(store)).sort()).toEqual([...all].sort());
    await Promise.all(all.map(id => mutateLarkPendingVerifications(store, 'cli_a', entries => entries.filter(item => item.task_id !== id))));
    expect(await ids(store)).toEqual([]);
  });

  it('别的进程在读与写之间写过：compareAndSet 冲突后重读重试，两边的条目都在', async () => {
    const store = open();
    let raced = false;
    const racing: ConfigRepository = {
      get: key => store.get(key), set: (key, value) => store.set(key, value),
      compareAndSet: async (key, expected, value) => {
        if (!raced) {
          raced = true;
          await store.set(key, JSON.stringify({ v: 1, tasks: [{ task_id: 'other' }] }));
        }
        return store.compareAndSet!(key, expected, value);
      }
    };
    await mutateLarkPendingVerifications(racing, 'cli_a', add('mine'));
    expect(await ids(store)).toEqual(['other', 'mine']);
  });

  it(`超过 ${maxLarkPendingVerifications} 条丢掉最旧的，并返回被丢掉的条目`, async () => {
    const store = open();
    await store.set(larkPendingVerificationKey('cli_a'), JSON.stringify({ v: 1, tasks: Array.from({ length: maxLarkPendingVerifications }, (_, index) => ({ task_id: `t${index}` })) }));
    const dropped = await mutateLarkPendingVerifications(store, 'cli_a', add('new'));
    expect(dropped.map(item => item.task_id)).toEqual(['t0']);
    const kept = await ids(store);
    expect(kept).toHaveLength(maxLarkPendingVerifications);
    expect(kept[0]).toBe('t1');
    expect(kept.at(-1)).toBe('new');
  });

  it('无需写入时不落库；记录损坏或条目不合法时按空处理', async () => {
    const store = open();
    expect(await mutateLarkPendingVerifications(store, 'cli_a', () => undefined)).toEqual([]);
    expect(await store.get(larkPendingVerificationKey('cli_a'))).toBeUndefined();
    expect(parseLarkPendingVerifications('not json')).toEqual([]);
    expect(parseLarkPendingVerifications(JSON.stringify({ tasks: [{ task_id: 'ok' }, { nope: 1 }] }))).toEqual([{ task_id: 'ok' }]);
  });
});
