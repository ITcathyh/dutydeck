import { afterAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lazyBundleForTest } from '../../../../tests/support/bundle-for-test.js';

const fixture = lazyBundleForTest('participation-audit', fileURLToPath(new URL('./participation-audit.fixture.ts', import.meta.url)));
afterAll(() => fixture.cleanup());

it.each(['audit', 'timer'] as const)('survives a %s failure in the real timer and handles the next message in strict Node', async failure => {
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', await fixture.path(), failure],
    { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('survived-next-message');
});
