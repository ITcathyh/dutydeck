import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SAFE_GIT_CONFIG, safeGitConfigFor, safeGitConfigFromListing, safeGitEnvironment } from '@dutydeck/shared/safe-git';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** A repository whose own config, attributes and hooks would each start a program that leaves a marker. */
async function armedRepository() {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-safe-git-'));
  dirs.push(root);
  const cwd = join(root, 'work'), marker = join(root, 'ran'), program = join(root, 'program.sh');
  await writeFile(program, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  await run('git', ['init', '-q', '-b', 'main', cwd]);
  const git = (...args: string[]) => run('git', ['-C', cwd, ...args], { timeout: 10_000 });
  await git('config', 'user.email', 'user@example.com'); await git('config', 'user.name', 'User');
  await writeFile(join(cwd, 'app.ts'), 'export const a = 1;\n');
  await git('add', '.'); await git('commit', '-qm', 'initial');
  await writeFile(join(cwd, '.gitattributes'), '*.ts filter=planted\n');
  for (const [key, value] of [['core.fsmonitor', program], ['filter.planted.clean', program], ['filter.planted.smudge', program], ['filter.planted.required', 'true']]) await git('config', key, value);
  await mkdir(join(cwd, '.git/hooks'), { recursive: true });
  for (const hook of ['post-index-change', 'reference-transaction']) await writeFile(join(cwd, '.git/hooks', hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  await writeFile(join(cwd, 'app.ts'), 'export const a = 2;\n');
  return { cwd, marker, git };
}

describe('daemon-side git in an agent-writable repository', () => {
  it('reads work tree status and diff without running the repository fsmonitor, filter drivers or hooks', async () => {
    const { cwd, marker, git } = await armedRepository();
    // Precondition: plain git does run the planted programs.
    await git('diff', '--stat', 'HEAD').catch(() => undefined);
    expect(existsSync(marker)).toBe(true);
    await rm(marker);

    const env = safeGitEnvironment(process.env);
    const config = await safeGitConfigFor(['-C', cwd], { env });
    for (const args of [['status', '--porcelain'], ['diff', 'HEAD', '--numstat'], ['ls-files', '-s'], ['add', '-A']]) {
      await run('git', ['-C', cwd, ...config, ...args], { env, timeout: 10_000 });
    }
    expect((await run('git', ['-C', cwd, ...config, 'diff', '--cached', '--numstat', 'HEAD'], { env, timeout: 10_000 })).stdout).toMatch(/^1\t1\tapp\.ts$/m);
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps program keys only from system, global and command scope, and disables filters only the repository defines', () => {
    const listing = [
      'global', 'filter.lfs.clean\ngit-lfs clean -- %f',
      'global', 'credential.helper\nstore',
      'local', 'filter.lfs.clean\n/tmp/planted',
      'local', 'filter.lfs.process\n/tmp/planted',
      'local', 'filter.planted.smudge\n/tmp/planted',
      'local', 'filter.planted.required\ntrue',
      'local', 'credential.helper\n!/tmp/planted',
      'local', 'core.sshcommand\n/tmp/planted',
      'command', 'core.sshcommand\nssh -o BatchMode=yes',
      'local', 'user.name\nUser', ''
    ].join('\0');
    const config = safeGitConfigFromListing(listing);
    expect(config).toEqual([
      '-c', 'filter.lfs.process=', '-c', 'filter.planted.smudge=', '-c', 'filter.planted.required=false',
      '-c', 'filter.lfs.clean=git-lfs clean -- %f', '-c', 'credential.helper=store', '-c', 'core.sshcommand=ssh -o BatchMode=yes'
    ]);
    expect(config.join(' ')).not.toContain('/tmp/planted');
    expect(SAFE_GIT_CONFIG).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'credential.helper=']));
  });

  it('hands git only lookup, identity and transport variables, never daemon credentials', () => {
    const env = safeGitEnvironment({
      PATH: '/usr/bin', HOME: '/home/user', SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_CONFIG_GLOBAL: '/home/user/.gitconfig', HTTPS_PROXY: 'http://proxy.example.com:3128',
      LARK_APP_SECRET: 'lark-secret', ANTHROPIC_API_KEY: 'model-key', DUTYDECK_SERVICE_TOKEN: 'service-token', GITHUB_TOKEN: 'platform-token', NODE_OPTIONS: '--require /tmp/x.js'
    }, { GIT_INDEX_FILE: '/tmp/index' });
    expect(env).toEqual({
      PATH: '/usr/bin', HOME: '/home/user', SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_CONFIG_GLOBAL: '/home/user/.gitconfig', HTTPS_PROXY: 'http://proxy.example.com:3128',
      GIT_TERMINAL_PROMPT: '0', GIT_PROXY_COMMAND: '', GIT_INDEX_FILE: '/tmp/index'
    });
  });
});
