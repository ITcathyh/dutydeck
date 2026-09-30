import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LarkGitSnapshot { branch: string; head: string; status: string[]; statusTotal: number }

/**
 * `/new --handoff` 交接用的 git 快照：分支、HEAD 短 SHA、最多 10 行 `git status --short`。
 * 不是 git 仓库、还没有提交、git 命令失败或超时时返回 undefined，不抛错。
 */
export async function readGitSnapshot(cwd: string): Promise<LarkGitSnapshot | undefined> {
  if (!cwd || typeof cwd !== 'string') return undefined;
  try {
    const git = async (args: string[]) => (await execFileAsync('git', args, { cwd, timeout: 2000 })).stdout;
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const head = (await git(['rev-parse', '--short', 'HEAD'])).trim();
    const lines = (await git(['status', '--short'])).split('\n').filter(line => line.trim().length > 0);
    return { branch, head, status: lines.slice(0, 10), statusTotal: lines.length };
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
    // 1. 读取当前分支
    const branchRes = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 2000
    });
    const branch = branchRes.stdout.trim();
    if (!branch) return undefined;

    // 2. 未提交文件数（git status --porcelain 的行数）
    const statusRes = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      timeout: 2000
    });
    const uncommittedLines = statusRes.stdout.split('\n').filter(line => line.trim().length > 0);
    const uncommittedCount = uncommittedLines.length;
    const uncommittedText = uncommittedCount === 0 ? '已全部提交' : `未提交 ${uncommittedCount} 个文件`;

    // 3. 未推送提交数（没有 upstream 时省略该项）
    let unpushedText: string | undefined;
    try {
      const revListRes = await execFileAsync('git', ['rev-list', '--count', '@{upstream}..HEAD'], {
        cwd,
        timeout: 2000
      });
      const unpushedCount = parseInt(revListRes.stdout.trim(), 10);
      if (!Number.isNaN(unpushedCount)) {
        unpushedText = unpushedCount === 0 ? '已全部推送' : `未推送 ${unpushedCount} 个提交`;
      }
    } catch {
      // 没有 upstream 或读取失败时省略
    }

    const parts = [`分支 ${branch}`, uncommittedText];
    if (unpushedText) parts.push(unpushedText);
    return parts.join(' · ');
  } catch {
    return undefined;
  }
}
