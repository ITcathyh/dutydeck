import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Native addons, and acpx/runtime (which the server build also keeps external), stay outside the bundle. They are
// imported by the absolute path the importing source resolves to, so the bundle loads them wherever it lives.
const externalModules = new Set(['better-sqlite3', 'node-pty', 'acpx/runtime']);

function packageRoot(path: string) {
  for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) {
    if (existsSync(join(directory, 'package.json'))) return directory;
  }
  return workspaceRoot;
}

/**
 * Bundles a TypeScript entry (the CLI or a test fixture) from source once, for tests that spawn it many times:
 * starting it through the TypeScript loader costs one to three seconds per process, which load turns into
 * timeouts. Workspace packages resolve to their sources, so no pnpm build is needed. The bundle is written inside
 * the entry's package, where its remaining bare imports resolve as they do for the source. Call cleanup in afterAll.
 */
export async function bundleForTest(label: string, entry: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(packageRoot(entry), `.test-${label}-`));
  const path = join(directory, 'bundle.mjs');
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await build({
      entryPoints: [entry], outfile: path, bundle: true, format: 'esm', platform: 'node', target: 'node22',
      logLevel: 'error',
      banner: { js: "import { createRequire as __ddCreateRequire } from 'node:module'; const require = __ddCreateRequire(import.meta.url);" },
      plugins: [{ name: 'workspace-sources', setup(builder) {
        builder.onResolve({ filter: /^@dutydeck\// }, ({ path: specifier }) => {
          const name = specifier.slice('@dutydeck/'.length);
          const source = name === 'shared/child-environment' || name === 'shared/secret-guard' || name === 'shared/safe-git'
            ? `packages/shared/runtime/${name.slice('shared/'.length)}.mjs`
            : `packages/${name === 'runtime' ? 'agent-runtime' : name}/src/index.ts`;
          return { path: join(workspaceRoot, source) };
        });
        builder.onResolve({ filter: /^[^./]/ }, ({ path: specifier, resolveDir }) => {
          if (!externalModules.has(specifier)) return undefined;
          return { path: createRequire(join(resolveDir, 'noop.js')).resolve(specifier), external: true };
        });
      } }]
    });
  } catch (error) { await cleanup(); throw error; }
  return { path, cleanup };
}

/** Like bundleForTest, but bundles on first use only; register cleanup with afterAll. */
export function lazyBundleForTest(label: string, entry: string) {
  let pending: ReturnType<typeof bundleForTest> | undefined;
  return {
    path: async () => (await (pending ??= bundleForTest(label, entry))).path,
    cleanup: async () => { const bundle = await pending?.catch(() => undefined); await bundle?.cleanup(); }
  };
}

/** Bundles this checkout's CLI (apps/server/src/cli.ts), or another entry such as a test fixture. */
export function bundleCliForTest(label: string, entry = join(workspaceRoot, 'apps/server/src/cli.ts')) {
  return bundleForTest(label, entry);
}
