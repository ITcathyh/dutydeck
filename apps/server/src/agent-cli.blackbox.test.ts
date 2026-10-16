import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = join(workspaceRoot, 'apps/server/src/cli.ts');
const tsxPath = join(workspaceRoot, 'node_modules/.bin/tsx');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// 没有服务、没有会话凭证的干净环境。
async function invoke(args: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-agent-cli-')); roots.push(root);
  const result = spawnSync(tsxPath, [cliPath, 'agent', ...args], {
    cwd: root, env: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_OPTIONS: '--conditions=development' }, encoding: 'utf8', timeout: 30_000
  });
  return { ...result, files: await readdir(root) };
}

describe('dutydeck agent black box', () => {
  it('--help 不连服务：开头是快速说明，列出全部命令', async () => {
    const help = await invoke(['--help']);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout.startsWith('QUICKSTART')).toBe(true);
    for (const text of ['风险分级', 'write-confirm', '--dry-run', '不用带 --turn', 'status', 'session', 'schedule', 'group', 'history', 'memory', 'work', 'collaborate']) expect(help.stdout).toContain(text);
    expect(help.files).toEqual([]);
    expect((await invoke([])).stdout.startsWith('QUICKSTART')).toBe(true);
  });

  it('子命令 --help 有 Risk 行和例子', async () => {
    const status = await invoke(['status', '--help']);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('Risk: read');
    expect(status.stdout).toContain('$ dutydeck agent status');
    const created = await invoke(['session', 'new', '--help']);
    expect(created.stdout).toContain('Risk: write-confirm');
    expect(created.stdout).toContain('--dry-run');
    expect(created.stdout).toContain("$ dutydeck agent session new --agent codex --task");
    expect((await invoke(['group', 'send', '--help'])).stdout).toContain('Risk: write（');
    expect((await invoke(['group', '--help'])).stdout).toContain('messages');
  });

  it('没有会话凭证、参数不对时 stdout 只有一个结构化错误 JSON，退出码 1', async () => {
    const status = await invoke(['status']);
    expect(status.status).toBe(1);
    expect(status.stderr).toBe('');
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: false, error: { code: 'GROUP_TOOL_CONTEXT_REQUIRED' } });
    const bad = await invoke(['session', 'new', '--workspace', 'x']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe('');
    expect(JSON.parse(bad.stdout)).toEqual({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '--workspace：可选：shared、worktree', hint: '运行 dutydeck agent session new --help 看用法。', params: [{ name: '--workspace', reason: '可选：shared、worktree' }] } });
  });
});
