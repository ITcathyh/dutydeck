import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(serverRoot, '../..');
const webDist = resolve(workspaceRoot, 'apps/web/dist');
const publicDir = resolve(serverRoot, 'public');
const aliases = new Map([
  ['acpx/runtime', fileURLToPath(import.meta.resolve('acpx/runtime'))],
  ['@dockmux/acp-client', 'packages/acp-client/src/index.ts'],
  ['@dockmux/config', 'packages/config/src/index.ts'],
  ['@dockmux/runtime', 'packages/agent-runtime/src/index.ts'],
  ['@dockmux/shared', 'packages/shared/src/index.ts'],
  ['@dockmux/storage', 'packages/storage/src/index.ts'],
  ['@dockmux/transports', 'packages/transports/src/index.ts']
]);

rmSync(resolve(serverRoot, 'dist'), { recursive: true, force: true });
if (!existsSync(resolve(webDist, 'index.html'))) throw new Error('Web UI is not built. Run pnpm --dir apps/web build first.');
rmSync(publicDir, { recursive: true, force: true });
cpSync(webDist, publicDir, { recursive: true });
await build({
  entryPoints: [resolve(serverRoot, 'src/cli.ts')],
  outfile: resolve(serverRoot, 'dist/cli.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  plugins: [{
    name: 'dockmux-workspace',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^(?:acpx\/runtime|@dockmux\/)/ }, args => {
        const target = aliases.get(args.path);
        return target ? { path: isAbsolute(target) ? target : resolve(workspaceRoot, target) } : undefined;
      });
    }
  }]
});
const agentsDir = resolve(serverRoot, 'dist/agents');
mkdirSync(agentsDir, { recursive: true });
cpSync(resolve(workspaceRoot, 'packages/acp-client/agents/claude-acp.mjs'), resolve(agentsDir, 'claude-acp.mjs'));
cpSync(resolve(workspaceRoot, 'packages/acp-client/agents/env-launcher.mjs'), resolve(agentsDir, 'env-launcher.mjs'));
const assetsDir = resolve(serverRoot, 'dist/assets');
mkdirSync(assetsDir, { recursive: true });
cpSync(resolve(serverRoot, 'src/lark/assets/dockmux-bouncing-ball.webp'), resolve(assetsDir, 'dockmux-bouncing-ball.webp'));
cpSync(resolve(serverRoot, 'src/lark/assets/SVG-SPINNERS-LICENSE.txt'), resolve(assetsDir, 'SVG-SPINNERS-LICENSE.txt'));
