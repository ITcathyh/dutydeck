// Runs in a fresh Node child: the SQLite experimental warning fires once per
// process, so an in-worker test would depend on which test loaded it first.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleForTest } from '../../../tests/support/bundle-for-test.js';

const loader = fileURLToPath(new URL('./node-sqlite.ts', import.meta.url));
const probe = `
import { requireNodeSqlite } from ${JSON.stringify(loader)};
import Module from 'node:module';
const seen = [];
process.on('warning', warning => seen.push(warning.name + ': ' + warning.message));
const original = process.emitWarning;
// Other warnings emitted while node:sqlite loads, inside the filter window, must still be heard.
const realLoad = Module._load;
let inside = false;
Module._load = function (request, ...rest) {
  if (request === 'node:sqlite' && !inside) {
    inside = true;
    process.emitWarning('other experimental thing', 'ExperimentalWarning');
    process.emitWarning('SQLite but a DeprecationWarning', 'DeprecationWarning');
  }
  return realLoad.call(this, request, ...rest);
};
const sqlite = requireNodeSqlite();
Module._load = realLoad;
process.emitWarning('outside the window', 'ExperimentalWarning');
setImmediate(() => process.stdout.write(JSON.stringify({ seen, inside, restored: process.emitWarning === original, db: typeof sqlite.DatabaseSync })));
`;

describe('requireNodeSqlite', () => {
  it('drops only the SQLite experimental warning and restores emitWarning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-node-sqlite-'));
    const entry = join(dir, 'probe.mjs');
    writeFileSync(entry, probe);
    const bundle = await bundleForTest('node-sqlite', entry);
    try {
      const result = JSON.parse(execFileSync(process.execPath, [bundle.path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      expect(result).toMatchObject({ inside: true, restored: true, db: 'function' });
      expect(result.seen).toEqual([
        'ExperimentalWarning: other experimental thing',
        'DeprecationWarning: SQLite but a DeprecationWarning',
        'ExperimentalWarning: outside the window',
      ]);
    } finally { await bundle.cleanup(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('the unwrapped require does emit the warning (the test can see it)', () => {
    const out = execFileSync(process.execPath, ['-e', "process.on('warning', w => process.stdout.write(w.name + ': ' + w.message)); require('node:sqlite')"], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toMatch(/^ExperimentalWarning: SQLite/);
  });
});
