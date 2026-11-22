import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import baseline from './architecture-boundaries.baseline.json' with { type: 'json' };

const src = fileURLToPath(new URL('.', import.meta.url));
const roots = new Set(['service.ts', 'app.ts', 'cli.ts', 'internal-agent-cli.ts']);
const upperModules = new Set(['cli-program.ts', 'service.ts', 'resource-retention.ts']);

const onlyTypes = (elements: readonly { isTypeOnly: boolean }[]) =>
  elements.length > 0 && elements.every(element => element.isTypeOnly);

function valueImports(file: string, source: string) {
  const imports = new Set<string>();
  function visit(node: ts.Node) {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && onlyTypes(bindings.elements))) return;
      specifier = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      if (node.isTypeOnly || (clause && ts.isNamedExports(clause) && onlyTypes(clause.elements))) return;
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier)) imports.add(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest));
  return imports;
}

it('counts runtime imports and re-exports, including nested dynamic imports', () => {
  expect([...valueImports('example.ts', `
    import type T from './type.js';
    import { type A, type B } from './types.js';
    type X = import('./type-query.js').X;
    import type TypeAlias = require('./type-alias.js');
    export type * from './type-star.js';
    export { type Y } from './type-export.js';
    import './side-effect.js';
    import Alias = require('./alias.js');
    import { type C, value } from './mixed.js';
    import Default, { type D } from './default.js';
    export * from './star.js';
    export { value as other } from './named.js';
    async function load() { return import('./dynamic.js'); }
  `)]).toEqual(['./side-effect.js', './alias.js', './mixed.js', './default.js', './star.js', './named.js', './dynamic.js']);
});

it('keeps direct server dependencies within the remaining baseline', () => {
  const localPath = (file: string) => relative(src, file).split(sep).join('/');
  const options = { moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const cache = ts.createModuleResolutionCache(src, ts.sys.useCaseSensitiveFileNames ? path => path : path => path.toLowerCase(), options);
  const current = new Set<string>();
  for (const file of ts.sys.readDirectory(src, ['.ts'], ['**/*.test.ts', '**/*.spec.ts'])) {
    const from = localPath(file);
    for (const specifier of valueImports(file, readFileSync(file, 'utf8'))) {
      const target = ts.resolveModuleName(specifier, file, options, ts.sys, cache).resolvedModule;
      if (!target) continue;
      const to = localPath(target.resolvedFileName);
      const lark = to.startsWith('lark/');
      if ((lark && !from.startsWith('lark/') && !roots.has(from))
        || (/^(daemon|doctor)\//.test(from) && (lark || upperModules.has(to)))) current.add(`${from} -> ${to}`);
    }
  }
  const known = new Set(baseline.map(({ from, to }) => `${from} -> ${to}`));
  const added = [...current].filter(edge => !known.has(edge)).sort();
  const removed = [...known].filter(edge => !current.has(edge)).sort();
  expect(added, '改依赖方向，不要往基线里加').toEqual([]);
  expect(removed, '旧依赖已不存在，请从基线删除').toEqual([]);
});

it('keeps concrete drivers and storage out of the runtime package', () => {
  const root = fileURLToPath(new URL('../../../packages/agent-runtime/', import.meta.url));
  const implementations = /^@dutydeck\/(acp-client|pty-driver|transports|storage)(\/|$)/;
  const manifest = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
  expect(Object.keys(manifest.dependencies).filter(name => implementations.test(name))).toEqual([]);
  const edges: string[] = [];
  for (const file of ts.sys.readDirectory(root + 'src', ['.ts'], ['**/*.test.ts', '**/*.spec.ts'])) {
    for (const target of valueImports(file, readFileSync(file, 'utf8'))) {
      if (implementations.test(target)) edges.push(`${relative(root, file)} -> ${target}`);
    }
  }
  expect(edges).toEqual([]);
});
