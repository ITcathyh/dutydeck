import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGitSnapshot } from './git-status.js';
import { formatLarkHandoff, larkHandoffMarker } from './handoff.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const tempDir = async () => { const path = await mkdtemp(join(tmpdir(), 'dutydeck-handoff-')); directories.push(path); return path; };

describe('/new --handoff prefix', () => {
  it('reads branch, short HEAD and at most 10 status lines, and nothing outside a repository', async () => {
    const repo = await tempDir();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    await writeFile(join(repo, 'tracked.txt'), 'v1');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    for (let index = 0; index < 12; index++) await writeFile(join(repo, `new-${index}.txt`), 'x');
    const head = git('rev-parse', '--short', 'HEAD').toString().trim();
    expect(await readGitSnapshot(repo)).toEqual({ branch: 'main', head, status: expect.any(Array), statusTotal: 12 });
    expect((await readGitSnapshot(repo))!.status).toHaveLength(10);
    expect(await readGitSnapshot(await tempDir())).toBeUndefined();
  });

  it('writes link, turns with capped excerpts, git snapshot and note under one marker', () => {
    const text = formatLarkHandoff({
      sessionId: 'ses_old', sessionUrl: 'https://dock.example/sessions/ses_old', cwd: '/repo',
      turns: [
        { title: '修复登录超时', status: 'completed', result: `结论：已修复。\n${'长'.repeat(700)}` },
        { title: '补测试', status: 'failed' }
      ],
      git: { branch: 'main', head: 'abc1234', status: [' M src/a.ts'], statusTotal: 3 },
      note: '先补重试测试'
    });
    expect(text.startsWith(larkHandoffMarker)).toBe(true);
    expect(text).toContain('旧会话：https://dock.example/sessions/ses_old');
    expect(text).toContain('1. 修复登录超时（已完成）\n   结论：已修复。');
    expect(text).toContain('2. 补测试（失败）\n   （没有可摘录的结果）');
    expect(text).not.toContain('长'.repeat(600));
    expect(text).toContain('工作目录 git 快照（/repo）：\n分支 main · HEAD abc1234\n   M src/a.ts\n  …另有 2 项未列出');
    expect(text).toContain('用户备注：先补重试测试');
    expect(formatLarkHandoff({ turns: [], note: '' })).toContain('不是 git 仓库或读取失败');
  });
});
