import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Bundles this checkout's CLI from source once, for black-box tests that spawn it many times: starting
 * src/cli.ts through the TypeScript loader costs seconds per process, which load turns into timeouts.
 * Workspace packages resolve to their sources, so no pnpm build is needed. Call the returned cleanup in afterAll.
 */
export async function bundleCliForTest(label: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(workspaceRoot, `apps/server/.test-${label}-`));
  const path = join(directory, 'cli.js');
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await build({
      entryPoints: [join(workspaceRoot, 'apps/server/src/cli.ts')], outfile: path, bundle: true, format: 'esm', platform: 'node', target: 'node22',
      external: ['better-sqlite3', 'node-pty', 'acpx/runtime'],
      banner: { js: "import { createRequire as __ddCreateRequire } from 'node:module'; const require = __ddCreateRequire(import.meta.url);" },
      plugins: [{ name: 'workspace-sources', setup(builder) {
        builder.onResolve({ filter: /^@dutydeck\// }, ({ path: specifier }) => {
          const name = specifier.slice('@dutydeck/'.length);
          const source = name === 'shared/child-environment' || name === 'shared/secret-guard' || name === 'shared/safe-git'
            ? `packages/shared/runtime/${name.slice('shared/'.length)}.mjs`
            : `packages/${name === 'runtime' ? 'agent-runtime' : name}/src/index.ts`;
          return { path: join(workspaceRoot, source) };
        });
      } }]
    });
  } catch (error) { await cleanup(); throw error; }
  return { path, cleanup };
}
