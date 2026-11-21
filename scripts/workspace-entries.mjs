import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesRoot = fileURLToPath(new URL('../packages/', import.meta.url));

export function loadWorkspaceEntries() {
  const entries = {};
  for (const directory of readdirSync(packagesRoot)) {
    const packageRoot = join(packagesRoot, directory);
    const manifest = join(packageRoot, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name, exports } = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const [subpath, conditions] of Object.entries(exports ?? {})) {
      if (typeof conditions?.development !== 'string') continue;
      const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
      entries[specifier] = resolve(packageRoot, conditions.development);
    }
  }
  return entries;
}
