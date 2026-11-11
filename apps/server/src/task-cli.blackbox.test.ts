import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bundleCliForTest } from '../../../tests/support/bundle-for-test.js';
const exec = promisify(execFile);
let bundle: Awaited<ReturnType<typeof bundleCliForTest>>;
let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'dutydeck-open-cli-')); bundle = await bundleCliForTest('open-cli'); });
afterAll(async () => { await bundle?.cleanup(); if (dir) await rm(dir, { recursive: true, force: true }); });
describe('open CLI JSON process contract', () => {
  it.each([
    ['task', 'decide', 's'],
    ['--database', '/placeholder.db', 'task', 'decide', 's'],
    ['task', 'send', 's', '--text', 'hello', '--mode', 'invalid'],
    ['task', 'list', '--limit', '201'],
    ['task', 'read'],
    ['task', 'missing'],
    ['lark', 'send', 'text', '--in-thread']
  ])('emits a single argument error for %j', async (...args) => {
    try {
      await exec(process.execPath, [bundle.path, ...args, '--json'], { cwd: dir, env: { ...process.env, HOME: dir, DUTYDECK_DAEMON_DIR: join(dir, 'daemon') } });
      throw new Error('Expected CLI failure');
    } catch (error: any) {
      expect(error.code).toBe(2);
      expect(error.stderr).toBe('');
      const lines = error.stdout.trim().split('\n'); expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ ok: false, error: { code: 'invalid_argument', message: expect.any(String) } });
    }
  });
});
