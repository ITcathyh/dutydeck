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

type LockEvent = { type: 'waiting' | 'acquired' | 'released'; label: string; waitMs?: number };

async function runConcurrent(database: string, inputs: Array<{ label: string; count: number }>) {
  const events: LockEvent[] = [];
  const children = inputs.map(({ label, count }) => {
    const child = spawn(process.execPath, [fixture!, database, label, String(count)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.on('message', (message: unknown) => {
        const event = message as LockEvent | { type: 'ready'; label: string };
        if (event?.type === 'ready') { resolve(); return; }
        if (event?.type === 'waiting' || event?.type === 'acquired' || event?.type === 'released') events.push(event);
      });
      void exit.then(code => reject(new Error(`${label} exited before ready (${code}): ${stderr}`)), reject);
    });
    return { child, exit, ready, stderr: () => stderr };
  });
  try {
    await Promise.all(children.map(child => child.ready));
    for (const child of children) child.child.send({ type: 'start' });
    await Promise.all(children.map(async child => {
      expect(await child.exit, child.stderr()).toBe(0);
    }));
    return events;
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

function expectActualLockContention(events: LockEvent[], acquisitions: number) {
  expect(events.filter(event => event.type === 'acquired')).toHaveLength(acquisitions);
  const waits = events.filter(event => event.type === 'acquired').map(event => event.waitMs ?? 0);
  // The fixture holds each real transaction for 50 ms; the lower bound leaves scheduling headroom.
  expect(Math.max(...waits), JSON.stringify(events)).toBeGreaterThanOrEqual(20);
}

it('merges read-modify-write updates from two PIDs without losing either history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-abnormal-concurrent-')); roots.push(root);
  const database = join(root, 'dutydeck.db'); writeFileSync(database, '');
  const events = await runConcurrent(database, [{ label: 'left', count: 5 }, { label: 'right', count: 5 }]);
  expectActualLockContention(events, 10);
  const document = JSON.parse(readFileSync(join(root, abnormalExitFileName), 'utf8'));
  expect(document.history).toHaveLength(10);
  expect(new Set(document.history.map((entry: any) => entry.runId)).size).toBe(10);
  for (const label of ['left', 'right']) for (let index = 0; index < 5; index++) {
    expect(document.history.some((entry: any) => entry.runId === `${label}-${index}`)).toBe(true);
  }
  expect(document.kind).toBe('fatal');
}, 30_000);

it('keeps one write from each of three real processes in the same critical section protocol', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-abnormal-concurrent-three-')); roots.push(root);
  const database = join(root, 'dutydeck.db'); writeFileSync(database, '');
  const events = await runConcurrent(database, [{ label: 'first', count: 1 }, { label: 'second', count: 1 }, { label: 'third', count: 1 }]);
  expectActualLockContention(events, 3);
  const document = JSON.parse(readFileSync(join(root, abnormalExitFileName), 'utf8'));
  expect(document.history.map((entry: any) => entry.runId).sort()).toEqual(['first-0', 'second-0', 'third-0']);
}, 30_000);
