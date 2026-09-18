import { createDecipheriv, createHash, scryptSync } from 'node:crypto';
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

// 归档格式契约：魔法头 + 12 字节 iv + 16 字节 GCM tag + 密文。魔法属于持久格式，改名不动。
const ARCHIVE_MAGIC = Buffer.from('DUTYDECK-BOTMUX-ARCHIVE-V2\0');

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
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-legacy-cli-'));
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

/** 按 manifest 中的 scrypt 参数派生密钥，解密单个 .enc，校验精确 magic 与 GCM 完整性。 */
function decryptArchiveEntry(bytes: Buffer, passphrase: string, keyDerivation: {
  salt_base64: string; cost: number; block_size: number; parallelization: number;
}): Buffer {
  expect(bytes.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)).toBe(true);
  let offset = ARCHIVE_MAGIC.length;
  const iv = bytes.subarray(offset, offset + 12);
  offset += 12;
  const tag = bytes.subarray(offset, offset + 16);
  offset += 16;
  const ciphertext = bytes.subarray(offset);
  const key = scryptSync(Buffer.from(passphrase, 'utf8'), Buffer.from(keyDerivation.salt_base64, 'base64'), 32, {
    N: keyDerivation.cost,
    r: keyDerivation.block_size,
    p: keyDerivation.parallelization,
    maxmem: 64 * 1024 * 1024
  });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// canonical `migrate` 与兼容别名 `botmux` 必须解析/执行一致，只允许 JSON command 字段按历史值区分。
for (const group of ['migrate', 'botmux'] as const) {
  describe(`dutydeck ${group} CLI black box`, () => {
    it('exposes only the three read-only migration subcommands', async () => {
      const source = await fixture();
      const result = invoke([group, '--help'], { cwd: source.root });
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
      for (const command of ['discover', 'plan'] as const) {
        const result = invoke([group, command, ...common], { cwd: source.root });
        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as Record<string, unknown>;
        // discover 的报告带 command 字段；plan 无 --output 时输出裸 redacted manifest，本就没有该字段。
        if (command === 'discover') expect(report.command).toBe(`${group}.discover`);
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
        group, 'plan', '--source-home', source.source_home, '--data-dir', source.data_dir, '--output', output, '--json'
      ], { cwd: source.root });
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout).command).toBe(`${group}.plan`);
      if (process.platform !== 'win32') expect((await lstat(output)).mode & 0o777).toBe(0o600);
      assertRedacted(await readFile(output, 'utf8'), source);

      const overwrite = invoke([
        group, 'plan', '--source-home', source.source_home, '--data-dir', source.data_dir, '--output', output, '--json'
      ], { cwd: source.root });
      expect(overwrite.status).not.toBe(0);
      assertRedacted(`${overwrite.stdout}${overwrite.stderr}`, source);

      const linkTarget = join(source.root, 'link-target.json');
      const link = join(source.root, 'redacted-link.json');
      await privateFile(linkTarget, 'unchanged\n');
      await symlink(linkTarget, link);
      const symlinked = invoke([
        group, 'discover', '--source-home', source.source_home, '--data-dir', source.data_dir, '--output', link, '--json'
      ], { cwd: source.root });
      expect(symlinked.status).not.toBe(0);
      assertRedacted(`${symlinked.stdout}${symlinked.stderr}`, source);
      expect(await readFile(linkTarget, 'utf8')).toBe('unchanged\n');
    });

    it('fails closed without explicit non-TTY passphrase input and creates a private encrypted archive through fd 0', async () => {
      const source = await fixture();
      const refusedDir = join(source.root, 'archive-refused');
      const refused = invoke([
        group, 'archive', '--source-home', source.source_home, '--data-dir', source.data_dir, '--output', refusedDir, '--json'
      ], { cwd: source.root });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('ARCHIVE_PASSPHRASE_INPUT_REQUIRED');
      await expect(lstat(refusedDir)).rejects.toMatchObject({ code: 'ENOENT' });

      const archiveDir = join(source.root, 'private-archive');
      const before = await sourceDigest(source.source_home);
      const passphrase = 'synthetic-archive-passphrase';
      const archived = invoke([
        group, 'archive', '--source-home', source.source_home, '--data-dir', source.data_dir,
        '--output', archiveDir, '--passphrase-fd', '0', '--json'
      ], { cwd: source.root, input: `${passphrase}\n` });
      expect(archived.status, archived.stderr).toBe(0);
      const archiveReport = JSON.parse(archived.stdout) as Record<string, unknown>;
      expect(archiveReport.command).toBe(`${group}.archive`);
      assertRedacted(`${archived.stdout}${archived.stderr}`, source);
      expect(archived.stdout).not.toContain(passphrase);
      expect(await sourceDigest(source.source_home)).toBe(before);
      if (process.platform !== 'win32') expect((await lstat(archiveDir)).mode & 0o777).toBe(0o700);

      const manifest = JSON.parse(await readFile(join(archiveDir, 'archive-manifest.json'), 'utf8')) as {
        encryption: string;
        source_mutated: boolean;
        live_config_written: boolean;
        key_derivation: { salt_base64: string; cost: number; block_size: number; parallelization: number };
      };
      expect(manifest).toMatchObject({ encryption: 'aes-256-gcm', source_mutated: false, live_config_written: false });
      expect(manifest.key_derivation).toMatchObject({ algorithm: 'scrypt', key_length_bytes: 32 });

      // 精确 magic + 解密往返：归档内必须能解出一份与源 sessions 文件逐字节一致的明文。
      const expectedSessions = await readFile(join(source.data_dir, `sessions-${PRIVATE_VALUES.app_id}.json`));
      let roundTripMatched = false;
      for (const entry of await readdir(archiveDir)) {
        const path = join(archiveDir, entry);
        if (process.platform !== 'win32') expect((await lstat(path)).mode & 0o777).toBe(0o600);
        const bytes = await readFile(path);
        expect(bytes.toString('utf8')).not.toContain(PRIVATE_VALUES.app_secret);
        if (!entry.endsWith('.enc')) continue;
        expect(bytes.subarray(0, ARCHIVE_MAGIC.length).toString('utf8')).toBe('DUTYDECK-BOTMUX-ARCHIVE-V2\0');
        const plaintext = decryptArchiveEntry(bytes, passphrase, manifest.key_derivation);
        if (plaintext.equals(expectedSessions)) roundTripMatched = true;
      }
      expect(roundTripMatched).toBe(true);
    });

    it('never accepts a passphrase value as an argv option', async () => {
      const source = await fixture();
      const result = invoke([
        group, 'archive', '--source-home', source.source_home, '--data-dir', source.data_dir,
        '--output', join(source.root, 'private-archive'), '--passphrase', 'must-not-be-accepted'
      ], { cwd: source.root });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unknown option');
      expect(result.stderr).not.toContain('must-not-be-accepted');
    });
  });
}
