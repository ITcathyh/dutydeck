import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { bundleForTest } from '../../../tests/support/bundle-for-test.js';
import { abnormalExitFileName } from './abnormal-exit.js';

let fixture: string | undefined;
let cleanup: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const bundled = await bundleForTest('abnormal-exit-concurrent', fileURLToPath(new URL('./abnormal-exit.concurrent-fixture.ts', import.meta.url)));
  fixture = bundled.path; cleanup = bundled.cleanup;
}, 60_000);
afterAll(async () => { await cleanup?.(); });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('merges read-modify-write updates from two PIDs without losing either history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-abnormal-concurrent-')); roots.push(root);
  const database = join(root, 'dutydeck.db'); writeFileSync(database, '');
  const startAt = String(Date.now() + 250);
  const run = async (label: string) => {
    const child = spawn(process.execPath, [fixture!, database, label, startAt], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = new Promise<number | null>(resolve => child.once('exit', resolve));
    expect(await exit, stderr).toBe(0);
  };
  await Promise.all([run('left'), run('right')]);
  const document = JSON.parse(readFileSync(join(root, abnormalExitFileName), 'utf8'));
  expect(document.history).toHaveLength(10);
  expect(new Set(document.history.map((entry: any) => entry.runId)).size).toBe(10);
  for (const label of ['left', 'right']) for (let index = 0; index < 5; index++) {
    expect(document.history.some((entry: any) => entry.runId === `${label}-${index}`)).toBe(true);
  }
  expect(['fatal', 'startup']).toContain(document.kind);
}, 30_000);
