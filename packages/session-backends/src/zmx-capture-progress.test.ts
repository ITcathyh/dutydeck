import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZmxBackend } from './zmx-backend.js';

const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('publishes history while tail output continues and preserves activity during a slow capture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-zmx-progress-')); roots.push(root);
  const history = join(root, 'history');
  const calls = join(root, 'calls');
  writeFileSync(history, 'first\n'); writeFileSync(calls, '');
  writeFileSync(join(root, 'zmx'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'list') process.stdout.write(args.includes('--short') ? 'progress\\n' : 'name=progress\\tpid=1\\tclients=1\\tcmd=fixture\\n');
else if (args[0] === 'tail') setInterval(() => process.stdout.write('activity'), 10);
else if (args[0] === 'history') {
  fs.appendFileSync(${JSON.stringify(calls)}, 'capture\\n');
  const content = fs.readFileSync(${JSON.stringify(history)}, 'utf8');
  setTimeout(() => process.stdout.write(content), 90);
}
`, { mode: 0o700 });
  process.env.PATH = `${root}:${originalPath}`;
  const backend = new ZmxBackend('progress');
  const chunks: string[] = [];
  backend.onData(data => chunks.push(data));
  try {
    backend.spawn('/unused', [], { cwd: root, env: {}, cols: 80, rows: 24 });
    await new Promise(resolve => setTimeout(resolve, 200));
    appendFileSync(history, 'later\n');
    const start = Date.now();
    while (!chunks.join('').includes('later') && Date.now() - start < 1_200) await new Promise(resolve => setTimeout(resolve, 20));
    expect(chunks.join('')).toContain('later');
    expect(readFileSync(calls, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);
    backend.detach();
    const delivered = chunks.join('');
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(chunks.join('')).toBe(delivered);
  } finally { backend.detach(); }
});
