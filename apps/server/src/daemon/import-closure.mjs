import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const staticImport = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/g;
const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Return unresolved relative static or dynamic imports, including deferred chunks. */
export function missingRelativeImports(entry) {
  const missing = [];
  const visited = new Set();
  const visit = file => {
    const absolute = resolve(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      missing.push(absolute);
      return;
    }
    const source = readFileSync(absolute, 'utf8');
    for (const pattern of [staticImport, dynamicImport]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
        const imported = resolve(dirname(absolute), specifier);
        if (!existsSync(imported) || !statSync(imported).isFile()) missing.push(`${imported} (imported by ${absolute})`);
        else visit(imported);
      }
    }
  };
  visit(entry);
  return [...new Set(missing)];
}
