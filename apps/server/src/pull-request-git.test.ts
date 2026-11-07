import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommit, originPushUrl, pushBranch } from './pull-request-git.js';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('/pr git in an agent-writable workspace', () => {
  it('builds and pushes without running workspace or local-remote hooks and repository-configured programs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-pr-git-'));
    dirs.push(root);
    const remote = join(root, 'remote.git'), cwd = join(root, 'work'), marker = join(root, 'ran');
    const program = join(root, 'program.sh');
    await writeFile(program, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await run('git', ['init', '-q', '-b', 'main', cwd]);
    const git = async (...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout.trim();
    await git('config', 'user.email', 'user@example.com'); await git('config', 'user.name', 'User');
    await writeFile(join(cwd, 'app.ts'), 'export const a = 1;\n');
    await git('add', '.'); await git('commit', '-qm', 'initial');
    await git('push', '-q', remote, 'main');
    await git('remote', 'add', 'origin', remote);
    await mkdir(join(cwd, '.git/hooks'), { recursive: true }); await mkdir(join(remote, 'hooks'), { recursive: true });
    for (const hook of ['pre-push', 'reference-transaction']) await writeFile(join(cwd, '.git/hooks', hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    await writeFile(join(remote, 'hooks/pre-receive'), `#!/bin/sh\necho pre-receive >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    for (const [key, value] of [['core.fsmonitor', program], ['core.sshCommand', program], ['credential.helper', `!${program}`], ['core.alternateRefsCommand', program]]) await git('config', key, value);

    const url = await originPushUrl(cwd);
    const blob = await git('hash-object', '-w', 'app.ts');
    const head = await git('rev-parse', 'HEAD');
    const commit = await buildCommit(cwd, head, [{ path: 'new.ts', sha: blob }], 'feat: add new');
    await pushBranch(cwd, url, commit, 'dutydeck/fix-login', 'main');

    expect((await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/dutydeck/fix-login'])).stdout.trim()).toBe(commit);
    expect(existsSync(marker)).toBe(false);
  });
});
