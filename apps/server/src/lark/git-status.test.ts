import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readGitStatusLine } from './git-status.js';

const execFileAsync = promisify(execFile);

describe('readGitStatusLine', () => {
  it('对非 git 目录返回 undefined', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'non-git-'));
    try {
      const result = await readGitStatusLine(tempDir);
      expect(result).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('对非法路径返回 undefined', async () => {
    expect(await readGitStatusLine('')).toBeUndefined();
    expect(await readGitStatusLine('/path/does/not/exist/__dutydeck__')).toBeUndefined();
  });

  it('在临时目录 git init 后提交一个文件，再改一个文件，断言返回未提交 1 个文件', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'git-test-'));
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

      const testFile = join(repoDir, 'file.txt');
      await writeFile(testFile, 'initial content');
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir });

      // 修改文件
      await writeFile(testFile, 'modified content');

      const result = await readGitStatusLine(repoDir);
      expect(result).toBeDefined();
      expect(result).toContain('分支 main');
      expect(result).toContain('未提交 1 个文件');
      // 无 upstream 时省略推送项
      expect(result).not.toContain('推送');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('全部提交且配置 upstream 时正确展示未推送/已全部推送状态', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-'));
    const localDir = await mkdtemp(join(tmpdir(), 'git-local-'));
    try {
      // 裸仓库作为 remote
      await execFileAsync('git', ['init', '--bare'], { cwd: remoteDir });

      // 本地仓库
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: localDir });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: localDir });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: localDir });
      await execFileAsync('git', ['remote', 'add', 'origin', remoteDir], { cwd: localDir });

      const file = join(localDir, 'a.txt');
      await writeFile(file, 'hello');
      await execFileAsync('git', ['add', '.'], { cwd: localDir });
      await execFileAsync('git', ['commit', '-m', 'c1'], { cwd: localDir });
      await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: localDir });

      // 已全部提交且已全部推送
      let status = await readGitStatusLine(localDir);
      expect(status).toBe('分支 main · 已全部提交 · 已全部推送');

      // 新增 2 个提交不推送
      await writeFile(file, 'hello 2');
      await execFileAsync('git', ['commit', '-am', 'c2'], { cwd: localDir });
      await writeFile(file, 'hello 3');
      await execFileAsync('git', ['commit', '-am', 'c3'], { cwd: localDir });

      status = await readGitStatusLine(localDir);
      expect(status).toBe('分支 main · 已全部提交 · 未推送 2 个提交');

      // 验证生成的结果卡元素结构
      const element = status ? { tag: 'markdown', element_id: 'git_status', content: status } : undefined;
      expect(element).toEqual({
        tag: 'markdown',
        element_id: 'git_status',
        content: '分支 main · 已全部提交 · 未推送 2 个提交'
      });
    } finally {
      await rm(remoteDir, { recursive: true, force: true });
      await rm(localDir, { recursive: true, force: true });
    }
  });
});
