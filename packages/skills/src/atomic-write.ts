import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * 原子写：先写同目录下的临时文件，再 rename 到目标路径。
 *
 * dockmux 仓库里没有现成的 atomic-write 工具（botmux 有 `src/utils/atomic-write.ts`），
 * 所以这里自带一个最小实现。skill 投递必须原子，理由不是「怕丢内容」而是
 * **半个 SKILL.md 比没有 SKILL.md 更糟**：CLI 会把截断的 frontmatter 当成合法
 * skill 加载，行为静默错乱。rename(2) 在同一文件系统内是原子的，读者要么看到
 * 完整旧内容、要么看到完整新内容，不存在中间态。
 *
 * 临时文件必须与目标**同目录**：跨文件系统 rename 会退化成 copy+unlink，
 * 失去原子性（Node 直接抛 EXDEV）。
 */
export async function atomicWriteFile(path: string, content: string, mode = 0o644): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  // 点开头 + 随机后缀：CLI 的 skill 扫描器只认 `SKILL.md`，不会把临时文件
  // 当成 skill；随机后缀让并发写入互不覆盖。
  const temporary = join(directory, `.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode });
    await rename(temporary, path);
  } catch (error) {
    // rename 之前失败 → 临时文件是垃圾，清掉；rename 之后失败不可能走到这里。
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
