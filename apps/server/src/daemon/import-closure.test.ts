import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { missingRelativeImports } from './import-closure.mjs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(source: string, present: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dutydeck-import-closure-'));
  directories.push(directory);
  for (const [name, contents] of Object.entries(present)) writeFileSync(join(directory, name), contents);
  const entry = join(directory, 'cli.js');
  writeFileSync(entry, source);
  return { directory, entry };
}

describe('relative import closure', () => {
  it('detects missing minified static, export-star and dynamic chunks', () => {
    const { directory, entry } = fixture(
      'import{x}from"./missing-static.js";export*from"./missing-star.js";export{y as z}from"./present.js";const load=()=>import("./missing-dynamic.js");',
      { 'present.js': 'export const y=1;\n' },
    );
    const missing = missingRelativeImports(entry);
    for (const name of ['missing-static.js', 'missing-star.js', 'missing-dynamic.js']) {
      expect(missing.join('\n')).toContain(join(directory, name));
    }
    expect(missing).toHaveLength(3);
  });

  it('does not start static imports at import.meta or dynamic import', () => {
    const { directory, entry } = fixture(`
const url = import.meta.url;
const values = Array.from("./not-an-import.js");
const load = () => import("./real-dynamic.js");
`);
    const missing = missingRelativeImports(entry);
    expect(missing).toHaveLength(1);
    expect(missing.join('\n')).toContain(join(directory, 'real-dynamic.js'));
    expect(missing.join('\n')).not.toContain('not-an-import.js');
  });

  it('retains multiline, comment and dynamic-import checks', () => {
    const { directory, entry } = fixture(`
import /* before */ {
  value
} /* after */ from './present.js';
export * as namespace from './star.js';
async function load() {
  return import(
    './missing-multiline-dynamic.js'
  );
}
`, { 'present.js': 'export const value=1;\n', 'star.js': 'export const star=1;\n' });
    const missing = missingRelativeImports(entry);
    expect(missing).toHaveLength(1);
    expect(missing.join('\n')).toContain(join(directory, 'missing-multiline-dynamic.js'));
  });
});
