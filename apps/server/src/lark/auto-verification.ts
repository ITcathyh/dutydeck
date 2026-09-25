// 改了代码就自动验证：候选验证命令的推断、「本轮改了代码」的判定，以及验证跑完之后要不要发回 Agent 返修。
//
// 两条硬规则：
// 1. 推断只读基准上的文件（git show <base>:<path>），不读工作区——Agent 改一行 package.json
//    就能决定用什么命令验证自己，那样的验证没有意义。
// 2. 验证工具本身出错（命令不存在、启动失败、超时、中断、结论未确认）记为验证未通过，
//    但不发回 Agent 返修：那不是代码的问题，发回去只会原地打转。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ConfigRepository, VerificationResponse, WorkspaceResponse } from '@dutydeck/shared';

const run = promisify(execFile);

/** 同一条请求最多自动返修几轮；之后仍未通过，结果卡标「验证未通过」交给人处理。 */
export const maxLarkVerificationRepairRounds = 2;
/** 发回 Agent 的失败输出只留末尾：测试框架通常把失败摘要打在最后。 */
const repairOutputChars = 4_000;

/**
 * 结果卡验证状态行上的自动验证进展。
 * running：本轮改了代码，正在自动验证；interrupted：验证还没跑完就被服务重启或会话停止打断；skipped：会话还有任务在执行，没能验证；
 * repairing：失败输出已作为第 round 轮返修发回 Agent；exhausted：返修轮数用完仍未通过；
 * infrastructure：验证工具本身出错，没有发回返修。
 */
export interface LarkAutoVerificationNote {
  phase: 'running' | 'interrupted' | 'skipped' | 'repairing' | 'exhausted' | 'infrastructure';
  round?: number;
  /** 验证没能启动时的原因（此时没有新的验证记录）。 */
  error?: string;
}

/**
 * 结果卡上自动验证的进展，随卡片记录落库。record_id 是进展对应的那条验证记录：
 * 之后有了新记录（例如手动运行验证），进展说明随之失效。
 */
export type LarkAutoVerificationProgress = LarkAutoVerificationNote & { turn: number; record_id?: string };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  return stdout;
}
const gitOrUndefined = (cwd: string, args: string[]) => git(cwd, args).catch(() => undefined);

/** 目录或它的上级有没有 .git。每张跑完的结果卡都会问到这里，不是仓库就不必起 git 进程。 */
export function larkInsideGitRepository(cwd: string): boolean {
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}

/**
 * 基准 commit：worktree 取派生它的那个 commit；共享目录取仓库默认分支（origin/HEAD），
 * 没有远端时退回 HEAD。不是 Git 仓库时返回 undefined。
 */
export async function larkVerificationBase(cwd: string, workspace?: Pick<WorkspaceResponse, 'mode' | 'baselineCommit'>): Promise<string | undefined> {
  if (!larkInsideGitRepository(cwd)) return undefined;
  const refs = workspace?.mode === 'worktree' ? [workspace.baselineCommit].filter(Boolean) as string[] : ['refs/remotes/origin/HEAD', 'HEAD'];
  for (const ref of refs) {
    const commit = (await gitOrUndefined(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim();
    if (commit) return commit;
  }
  return undefined;
}

/**
 * 按基准上的项目文件推断候选验证命令：package.json 的 typecheck / test 脚本、Makefile 的 test 目标、go.mod。
 * 路径相对任务目录；推断不出来返回 undefined。
 */
export async function inferLarkVerificationCommand(cwd: string, base: string): Promise<string | undefined> {
  const read = (path: string) => gitOrUndefined(cwd, ['show', `${base}:./${path}`]);
  const exists = async (path: string) => await gitOrUndefined(cwd, ['cat-file', '-e', `${base}:./${path}`]) !== undefined;
  const manifest = await read('package.json');
  if (manifest !== undefined) {
    let parsed: { scripts?: Record<string, unknown>; packageManager?: unknown } = {};
    try { parsed = JSON.parse(manifest) ?? {}; } catch { /* 解析不了按没有脚本处理 */ }
    const script = (name: string) => {
      const value = parsed.scripts?.[name];
      // npm init 生成的占位脚本必然失败，不算测试。
      return typeof value === 'string' && value.trim() !== '' && !/no test specified/.test(value);
    };
    const manager = String(parsed.packageManager ?? '');
    const runner = manager.startsWith('pnpm@') || await exists('pnpm-lock.yaml') ? 'pnpm'
      : manager.startsWith('yarn@') || await exists('yarn.lock') ? 'yarn' : 'npm';
    const steps = [...(script('typecheck') ? [`${runner} run typecheck`] : []), ...(script('test') ? [`${runner} test`] : [])];
    if (steps.length) return steps.join(' && ');
  }
  const makefile = await read('Makefile');
  if (makefile !== undefined && /^test\s*:(?!=)/m.test(makefile)) return 'make test';
  if (await exists('go.mod')) return 'go test ./...';
  return undefined;
}

/** 仓库相对基准有没有改动：已跟踪文件与基准的差异，或未被忽略的新文件。.dutydeck 下的平台数据不算。 */
export async function larkWorkspaceChanged(cwd: string, base: string): Promise<boolean> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const paths = [
    ...(await git(root, ['diff', '--name-only', '-z', base, '--'])).split('\0'),
    ...(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0')
  ];
  return paths.some(path => path && path.split('/').every(segment => segment !== '.dutydeck'));
}

/**
 * 本轮结束后要不要自动验证：这一轮跑完了、配了验证命令、这一轮改了代码（worktree 相对派生它的 commit，
 * 共享目录比较本轮前后的代码指纹），且最新一条记录证明不了当前代码（没有记录，或代码在它之后变过）。
 */
export function shouldAutoVerifyLarkTurn(input: { state: string; command?: string; changed: boolean; latest?: VerificationResponse }): boolean {
  return input.state === 'completed' && Boolean(input.command?.trim()) && input.changed
    && input.latest?.status !== 'running' && (!input.latest || input.latest.stale);
}

/** 验证工具本身的问题：超时、中断、结论未确认、启动失败、命令不存在（127）或不可执行（126）。 */
export function isLarkVerificationInfrastructureFailure(record: VerificationResponse): boolean {
  if (record.status === 'timed_out' || record.status === 'interrupted' || record.status === 'unverified') return true;
  return record.status === 'failed' && (Boolean(record.error) || record.exitCode === undefined || record.exitCode === 126 || record.exitCode === 127);
}

export type LarkVerificationOutcome =
  | { kind: 'passed' }
  | { kind: 'infrastructure' }
  | { kind: 'repair'; round: number }
  | { kind: 'exhausted' };

/**
 * 一次自动验证之后怎么办。record 缺省表示验证没能启动；repairedRounds 是这条请求已经返修过的轮数。
 * 通过就结束；验证工具出错不返修；代码的失败在轮数用完之前发回返修。
 */
export function larkVerificationOutcome(record: VerificationResponse | undefined, repairedRounds: number): LarkVerificationOutcome {
  if (!record || isLarkVerificationInfrastructureFailure(record)) return { kind: 'infrastructure' };
  if (record.status === 'passed') return record.stale ? { kind: 'infrastructure' } : { kind: 'passed' };
  return repairedRounds < maxLarkVerificationRepairRounds ? { kind: 'repair', round: repairedRounds + 1 } : { kind: 'exhausted' };
}

/** 发回 Agent 的返修请求。第一行也是返修那一轮的卡片标题，不放命令和输出。 */
export function larkVerificationRepairPrompt(record: VerificationResponse, round: number): string {
  const characters = Array.from(record.output);
  const tail = characters.length > repairOutputChars ? `…（前面已截断）\n${characters.slice(-repairOutputChars).join('')}` : record.output;
  return [
    `验证未通过，自动返修第 ${round}/${maxLarkVerificationRepairRounds} 轮：按下面的失败输出修复代码。`,
    '',
    `上一轮改动之后，平台在工作目录执行验证命令 \`${record.command}\`，退出码 ${record.exitCode}。${record.outputTruncated ? '输出过长，平台只保留了开头的一部分。' : ''}输出末尾：`,
    '```',
    tail.trim() || '（没有输出）',
    '```',
    '',
    '修好后不必自己宣称测试通过：这一轮结束后平台会重新执行这条命令，以它的退出码为准。'
  ].join('\n');
}

/** 机器人在结果卡下代发的那句话。失败输出只进 Agent 的请求，不贴进群里。 */
export const larkVerificationRepairNotice = (round: number) =>
  `「验证未通过 · 自动返修 ${round}/${maxLarkVerificationRepairRounds}」已把验证命令的失败输出发回 Agent 修复，修好后会重新验证。`;

/** 每个机器人一行，只放还没收尾的自动验证；收尾（卡片画到最终样子）即移除。 */
export const larkPendingVerificationKey = (appId: string) => `lark.verification_auto.${appId}`;
/** 待收尾条目的上限：正常情况下只有正在验证和返修中的几条，超出说明有条目漏了收尾，丢掉最旧的。 */
export const maxLarkPendingVerifications = 200;
const pendingWriteAttempts = 5;

/**
 * 一条还没收尾的自动验证。repair_round：代发的第几轮返修，那一轮跑完再验证时据此决定还能不能再修；
 * running：正在自动验证（boot 是发起它的进程），重启后据此把卡上遗留的「验证执行中」改成「验证被中断」。
 */
export interface LarkPendingVerification {
  task_id: string;
  repair_round?: number;
  running?: { turn: number; boot: string; record_id?: string };
}

export function parseLarkPendingVerifications(raw: string | undefined): LarkPendingVerification[] {
  try {
    const tasks = raw ? (JSON.parse(raw) as { tasks?: unknown }).tasks : undefined;
    return Array.isArray(tasks) ? tasks.filter((item): item is LarkPendingVerification => typeof item?.task_id === 'string') : [];
  } catch { return []; }
}

let pendingWriteTail: Promise<unknown> = Promise.resolve();

/**
 * 读-改-写待收尾这一行；mutation 返回 undefined 表示无需写入。本进程内的写入排成一队，
 * compareAndSet 冲突（别的进程写过）时重读重试。超出上限丢掉排在最前面（最旧）的，返回被丢掉的条目。
 */
export function mutateLarkPendingVerifications(store: ConfigRepository, appId: string,
  mutation: (entries: LarkPendingVerification[]) => LarkPendingVerification[] | undefined): Promise<LarkPendingVerification[]> {
  const key = larkPendingVerificationKey(appId);
  const run = pendingWriteTail.then(async () => {
    for (let attempt = 0; attempt < pendingWriteAttempts; attempt++) {
      const raw = await store.get(key);
      const next = mutation(parseLarkPendingVerifications(raw));
      if (!next) return [];
      const dropped = next.slice(0, Math.max(0, next.length - maxLarkPendingVerifications));
      const value = JSON.stringify({ v: 1, tasks: next.slice(dropped.length) });
      if (!store.compareAndSet) { await store.set(key, value); return dropped; }
      if (await store.compareAndSet(key, raw, value)) return dropped;
    }
    throw new Error('待收尾的自动验证记录正在被并发修改，请稍后重试。');
  });
  pendingWriteTail = run.catch(() => undefined);
  return run;
}
