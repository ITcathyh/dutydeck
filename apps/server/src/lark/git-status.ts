import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeGitConfigFor, safeGitEnvironment } from '@dutydeck/shared/safe-git';
import { larkInsideGitRepository } from './auto-verification.js';
import { jsonSha256 } from '../hash.js';

const execFileAsync = promisify(execFile);

/**
 * 工作区归 Agent 写：status、diff 不能跑仓库配置里的 fsmonitor、过滤器，环境里也不带 daemon 的密钥。
 * 子模块有自己的配置，这里只按父仓库停掉过滤器，所以 status、diff 都带 --ignore-submodules=dirty，不进子模块工作区。
 */
async function workTreeGit(cwd: string, timeout: number, maxBuffer?: number) {
  const env = safeGitEnvironment(process.env);
  const config = await safeGitConfigFor(['-C', cwd], { env, timeout });
  return async (args: string[]) => (await execFileAsync('git', [...config, ...args], { cwd, env, timeout, ...(maxBuffer ? { maxBuffer } : {}) })).stdout;
}

export interface LarkGitSnapshot { branch: string; head: string; status: string[]; statusTotal: number }

/**
 * `/new --handoff` 交接用的 git 快照：分支、HEAD 短 SHA、最多 10 行 `git status --short`。
 * 不是 git 仓库、还没有提交、git 命令失败或超时时返回 undefined，不抛错。
 */
export async function readGitSnapshot(cwd: string): Promise<LarkGitSnapshot | undefined> {
  if (!cwd || typeof cwd !== 'string') return undefined;
  try {
    const git = await workTreeGit(cwd, 2000);
    const [branch, head, status] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD']), git(['rev-parse', '--short', 'HEAD']), git(['status', '--short', '--ignore-submodules=dirty'])
    ]);
    const lines = status.split('\n').filter(line => line.trim().length > 0);
    return { branch: branch.trim(), head: head.trim(), status: lines.slice(0, 10), statusTotal: lines.length };
  } catch {
    return undefined;
  }
}

/**
 * 工作目录当前的代码状态签名：HEAD、未提交改动的文件清单和每个文件的增删行数合起来取摘要。
 * 一轮开始和结束各取一次，两次不同就说明这一轮改了这个仓库（提交、改文件、新增文件都算）。
 * 比整库内容指纹（验证记录用的那个）便宜得多，每一轮都取得起；.dutydeck 下的平台数据不算。
 * 不是 git 仓库、git 失败或超时时返回 undefined，调用方按「不知道」处理。
 */
export async function readGitCodeSignature(cwd: string | undefined): Promise<string | undefined> {
  // 不是仓库就不必起 git 进程：每一轮都会问到这里。
  if (!cwd || !larkInsideGitRepository(cwd)) return undefined;
  try {
    const git = await workTreeGit(cwd, 5000, 16 * 1024 * 1024);
    const platformData = /(?:^|[\s/])\.dutydeck(?:\/|$)/;
    // 三条命令互不依赖，并行跑：每一轮结束都要等它们。
    const [head, status, numstat] = await Promise.all([
      git(['rev-parse', '--verify', 'HEAD']),
      git(['status', '--porcelain=v1', '-z', '--ignore-submodules=dirty']),
      git(['diff', 'HEAD', '--numstat', '-z', '--ignore-submodules=dirty'])
    ]);
    const entries = (output: string) => output.split('\0').filter(entry => entry && !platformData.test(entry));
    return jsonSha256([head.trim(), entries(status), entries(numstat)]);
  } catch {
    return undefined;
  }
}

/**
 * 读取指定工作目录的 git 状态摘要行。
 * 形如："分支 main · 未提交 3 个文件 · 未推送 2 个提交"。
 * 数量为 0 的项写"已全部提交"或"已全部推送"；无 upstream 时省略未推送项。
 * 若不是 git 仓库、git 命令执行失败或超时，返回 undefined，不抛错。
 */
export async function readGitStatusLine(cwd: string): Promise<string | undefined> {
  if (!cwd || typeof cwd !== 'string') return undefined;

  try {
    const git = await workTreeGit(cwd, 2000);
    // 分支、未提交文件（git status --porcelain 的行数）、未推送提交数互不依赖，并行读；没有 upstream 时 rev-list 失败，省略该项。
    const [branchOutput, statusOutput, unpushedOutput] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['status', '--porcelain', '--ignore-submodules=dirty']),
      git(['rev-list', '--count', '@{upstream}..HEAD']).catch(() => undefined)
    ]);
    const branch = branchOutput.trim();
    if (!branch) return undefined;

    const uncommittedLines = statusOutput.split('\n').filter(line => line.trim().length > 0);
    const uncommittedCount = uncommittedLines.length;
    const uncommittedText = uncommittedCount === 0 ? '已全部提交' : `未提交 ${uncommittedCount} 个文件`;

    const unpushedCount = unpushedOutput === undefined ? NaN : parseInt(unpushedOutput.trim(), 10);
    const unpushedText = Number.isNaN(unpushedCount) ? undefined : unpushedCount === 0 ? '已全部推送' : `未推送 ${unpushedCount} 个提交`;

    const parts = [`分支 ${branch}`, uncommittedText];
    if (unpushedText) parts.push(unpushedText);
    return parts.join(' · ');
  } catch {
    return undefined;
  }
}
