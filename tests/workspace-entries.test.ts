import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
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

it('keeps TypeScript project references in sync with workspace dependencies', () => {
  const packages = readdirSync(join(root, 'packages'))
    .map(name => join(root, 'packages', name))
    .filter(directory => existsSync(join(directory, 'package.json')));
  const apps = [join(root, 'apps/server'), join(root, 'apps/web')];
  const references = (directory: string, file = 'tsconfig.json'): string[] => {
    const { config, error } = ts.readConfigFile(join(directory, file), ts.sys.readFile);
    if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    return (config.references ?? []).map(({ path }: ts.ProjectReference) =>
      normalize(ts.resolveProjectReferencePath({ path: resolve(directory, path) })));
  };
  const packageSolution = 'tsconfig.packages.json';
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(scripts['build:packages']).toBe(`tsc -b ${packageSolution}`);
  expect(references(root, packageSolution).sort()).toEqual(packages.map(path => join(path, 'tsconfig.json')).sort());
  expect(references(root).sort()).toEqual([join(root, packageSolution), ...apps.map(path => join(path, 'tsconfig.json'))].sort());
  for (const directory of [...packages, ...apps]) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const dependencies = Object.keys({
      ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies
    }).filter(name => name.startsWith('@dutydeck/'));
    const names = references(directory).map(path => JSON.parse(readFileSync(join(dirname(path), 'package.json'), 'utf8')).name);
    expect(names.sort(), manifest.name).toEqual(dependencies.sort());
  }
});
