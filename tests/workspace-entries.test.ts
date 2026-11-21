import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { loadWorkspaceEntries } from '../scripts/workspace-entries.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

it('resolves every workspace import to a source file declared in package exports', () => {
  const entries = loadWorkspaceEntries();
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'tests', 'scripts'],
    { cwd: root, encoding: 'utf8' }).split('\0');
  const unresolved: string[] = [];
  for (const file of new Set(files)) {
    const sourcePath = join(root, file);
    if (!/\.[cm]?[jt]sx?$/.test(file) || !existsSync(sourcePath)) continue;
    const source = readFileSync(sourcePath, 'utf8');
    for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!specifier.startsWith('@dutydeck/')) continue;
      const entry = entries[specifier];
      if (!entry || !statSync(entry, { throwIfNoEntry: false })?.isFile()) {
        unresolved.push(`${file}: ${specifier}${entry ? ` → ${entry}` : ' has no development export'}`);
      }
    }
  }
  expect(unresolved).toEqual([]);
});
