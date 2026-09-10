import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = join(workspaceRoot, 'apps/server/src/cli.ts');
const tsxPath = join(workspaceRoot, 'node_modules/.bin/tsx');
const roots: string[] = [];

const PRIVATE_VALUES = {
  app_id: 'cli_fixture_private_app',
  app_secret: 'FIXTURE_PRIVATE_SECRET_NEVER_PRINT',
  owner: 'private-owner@example.invalid',
  chat_id: 'oc_fixture_private_chat',
  cwd: '/fixture/private/workspace',
  prompt: 'FIXTURE_PRIVATE_SCHEDULE_PROMPT'
} as const;

interface Fixture {
  root: string;
  source_home: string;
  data_dir: string;
}

async function privateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

async function privateJson(path: string, value: unknown): Promise<void> {
  await privateFile(path, `${JSON.stringify(value)}\n`);
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-botmux-cli-'));
  roots.push(root);
  const sourceHome = join(root, 'botmux-source');
  const dataDir = join(sourceHome, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await privateJson(join(sourceHome, 'bots.json'), [{
    larkAppId: PRIVATE_VALUES.app_id,
    larkAppSecret: PRIVATE_VALUES.app_secret,
    cliId: 'claude-code',
    defaultWorkingDir: PRIVATE_VALUES.cwd,
    allowedUsers: [PRIVATE_VALUES.owner],
    oncallChats: [{ chatId: PRIVATE_VALUES.chat_id, workingDir: PRIVATE_VALUES.cwd }],
    hammer: { enabled: true, mode: 'full', enforceGates: true, skillsInjection: 'prompt' }
  }]);
  await privateJson(join(sourceHome, 'bots', PRIVATE_VALUES.app_id, 'schedules.json'), {
    fixture_schedule: {
      id: 'fixture_schedule',
      larkAppId: PRIVATE_VALUES.app_id,
      chatId: PRIVATE_VALUES.chat_id,
      enabled: true,
      parsed: { kind: 'interval' },
      prompt: PRIVATE_VALUES.prompt
    }
  });
  await privateJson(join(dataDir, 'teams.json'), { teams: [{ id: 'fixture-team', members: [] }] });
  await privateJson(join(dataDir, `sessions-${PRIVATE_VALUES.app_id}.json`), {
    fixture_topic: {
      sessionId: 'fixture-topic',
      larkAppId: PRIVATE_VALUES.app_id,
      status: 'active',
      scope: 'thread'
    }
  });
  return { root, source_home: sourceHome, data_dir: dataDir };
}

function invoke(args: string[], options: { cwd: string; input?: string } ) {
  return spawnSync(tsxPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: {
      HOME: options.cwd,
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      NODE_OPTIONS: '--conditions=development'
    },
    encoding: 'utf8',
    input: options.input,
    timeout: 30_000
  });
}

function assertRedacted(text: string, source: Fixture): void {
  for (const forbidden of [
    source.root,
    source.source_home,
    source.data_dir,
    ...Object.values(PRIVATE_VALUES)
  ]) expect(text).not.toContain(forbidden);
}

async function sourceDigest(sourceHome: string): Promise<string> {
  const rows: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        rows.push(`d:${entry.name}`);
        await walk(path);
      } else if (entry.isFile()) {
        rows.push(`f:${entry.name}:${createHash('sha256').update(await readFile(path)).digest('hex')}`);
      }
    }
  };
  await walk(sourceHome);
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('dutydeck botmux CLI black box', () => {
  it('exposes only the three read-only Botmux subcommands', async () => {
    const source = await fixture();
    const result = invoke(['botmux', '--help'], { cwd: source.root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('discover');
    expect(result.stdout).toContain('plan');
    expect(result.stdout).toContain('archive');
    expect(result.stdout).not.toMatch(/\b(?:apply|stage|activate|cutover|resume)\b/i);
  });

  it('discovers and plans with NO_GO blockers while redacting paths, identities, and secrets', async () => {
    const source = await fixture();
    const common = ['--source-home', source.source_home, '--data-dir', source.data_dir, '--json'];
    const before = await sourceDigest(source.source_home);
    for (const command of ['discover', 'plan']) {
      const result = invoke(['botmux', command, ...common], { cwd: source.root });
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(JSON.stringify(report)).toContain('NO_GO');
      expect(JSON.stringify(report)).toContain('enabled_schedule_requires_single_writer');
      expect(JSON.stringify(report)).toContain('active_topics_require_disposition');
      assertRedacted(`${result.stdout}${result.stderr}`, source);
    }
    expect(await sourceDigest(source.source_home)).toBe(before);
  });

  it('writes new redacted files as 0600 and refuses overwrite or symlink targets', async () => {
    const source = await fixture();
    const output = join(source.root, 'redacted-plan.json');
    const first = invoke([
      'botmux', 'plan', '--source-home', source.source_home, '--data-dir', source.data_dir, '--output', output, '--json'
    ], { cwd: source.root });
    expect(first.status, first.stderr).toBe(0);
    if (process.platform !== 'win32') expect((await lstat(output)).mode & 0o777).toBe(0o600);
    assertRedacted(await readFile(output, 'utf8'), source);

    const overwrite = invoke([
      'botmux', 'plan', '--source-home', source.source_home, '--data-dir', source.data_dir, '--output', output, '--json'
    ], { cwd: source.root });
    expect(overwrite.status).not.toBe(0);
    assertRedacted(`${overwrite.stdout}${overwrite.stderr}`, source);

    const linkTarget = join(source.root, 'link-target.json');
    const link = join(source.root, 'redacted-link.json');
    await privateFile(linkTarget, 'unchanged\n');
    await symlink(linkTarget, link);
    const symlinked = invoke([
      'botmux', 'discover', '--source-home', source.source_home, '--data-dir', source.data_dir, '--output', link, '--json'
    ], { cwd: source.root });
    expect(symlinked.status).not.toBe(0);
    assertRedacted(`${symlinked.stdout}${symlinked.stderr}`, source);
    expect(await readFile(linkTarget, 'utf8')).toBe('unchanged\n');
  });

  it('fails closed without explicit non-TTY passphrase input and creates a private encrypted archive through fd 0', async () => {
    const source = await fixture();
    const refusedDir = join(source.root, 'archive-refused');
    const refused = invoke([
      'botmux', 'archive', '--source-home', source.source_home, '--data-dir', source.data_dir, '--output', refusedDir, '--json'
    ], { cwd: source.root });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('ARCHIVE_PASSPHRASE_INPUT_REQUIRED');
    await expect(lstat(refusedDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const archiveDir = join(source.root, 'private-archive');
    const before = await sourceDigest(source.source_home);
    const archived = invoke([
      'botmux', 'archive', '--source-home', source.source_home, '--data-dir', source.data_dir,
      '--output', archiveDir, '--passphrase-fd', '0', '--json'
    ], { cwd: source.root, input: 'synthetic-archive-passphrase\n' });
    expect(archived.status, archived.stderr).toBe(0);
    assertRedacted(`${archived.stdout}${archived.stderr}`, source);
    expect(archived.stdout).not.toContain('synthetic-archive-passphrase');
    expect(await sourceDigest(source.source_home)).toBe(before);
    if (process.platform !== 'win32') expect((await lstat(archiveDir)).mode & 0o777).toBe(0o700);
    for (const entry of await readdir(archiveDir)) {
      const path = join(archiveDir, entry);
      if (process.platform !== 'win32') expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await readFile(path)).toString('utf8')).not.toContain(PRIVATE_VALUES.app_secret);
    }
    const manifest = JSON.parse(await readFile(join(archiveDir, 'archive-manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ encryption: 'aes-256-gcm', source_mutated: false, live_config_written: false });
    expect(manifest.key_derivation).toMatchObject({ algorithm: 'scrypt', key_length_bytes: 32 });
  });

  it('never accepts a passphrase value as an argv option', async () => {
    const source = await fixture();
    const result = invoke([
      'botmux', 'archive', '--source-home', source.source_home, '--data-dir', source.data_dir,
      '--output', join(source.root, 'private-archive'), '--passphrase', 'must-not-be-accepted'
    ], { cwd: source.root });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown option');
    expect(result.stderr).not.toContain('must-not-be-accepted');
  });
});
