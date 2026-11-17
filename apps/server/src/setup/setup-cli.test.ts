import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SetupCliOptions, SetupDependencies } from './setup.js';
import type { LarkBindResult } from './lark-bind.js';

const runSetup = vi.hoisted(() => vi.fn());
vi.mock('./setup.js', async importOriginal => ({ ...await importOriginal<typeof import('./setup.js')>(), runSetup }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('maps a returned setup failure to exit code 1 and prints one JSON result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-setup-cli-'));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  cleanups.push(async () => {
    process.chdir(originalCwd);
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    await rm(directory, { recursive: true, force: true });
  });
  process.chdir(directory);
  process.exitCode = undefined;
  vi.stubEnv('HOME', directory);
  let stdout = '', stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write);
  const failed: LarkBindResult = {
    outcome: 'failed', appId: 'cli_fixture', steps: [], warnings: [],
    next: 'retry fixture', error: { code: 'fixture_failure', message: 'fixture failed' }
  };
  const actual = await vi.importActual<typeof import('./setup.js')>('./setup.js');
  runSetup.mockImplementation(async (options: SetupCliOptions) => {
    const dependencies: SetupDependencies = {
      cwd: directory, env: {}, database: join(directory, 'fixture.db'), detect: () => [],
      readBot: async () => undefined, bind: async () => failed
    };
    return actual.runSetup(options, dependencies);
  });
  process.argv = [process.execPath, 'dutydeck', 'setup', '--json', '--yes', '--cwd', directory, '--port', '14310', '--lark-app-id', 'cli_fixture'];

  await import('../cli.js');

  expect(process.exitCode).toBe(1);
  expect(stderr).toBe('');
  expect(stdout.trimEnd().split('\n')).toHaveLength(1);
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({ ok: false, changed: true, error: failed.error, next: failed.next });
  expect(result.changedKeys).toEqual(expect.arrayContaining(['DUTYDECK_DEFAULT_CWD', 'DUTYDECK_PORT']));
  const env = await readFile(join(directory, '.env'), 'utf8');
  expect(env).toContain('DUTYDECK_PORT=14310');
  expect(env).not.toContain('LARK_APP_ID=');
}, 30_000);
