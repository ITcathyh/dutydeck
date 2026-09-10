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
  ['@dutydeck/acp-client', 'packages/acp-client/src/index.ts'],
  ['@dutydeck/botmux-importer', 'packages/botmux-importer/src/index.ts'],
  ['@dutydeck/cli-adapters', 'packages/cli-adapters/src/index.ts'],
  ['@dutydeck/config', 'packages/config/src/index.ts'],
  ['@dutydeck/pty-driver', 'packages/pty-driver/src/index.ts'],
  ['@dutydeck/relay', 'packages/relay/src/index.ts'],
  ['@dutydeck/runtime', 'packages/agent-runtime/src/index.ts'],
  ['@dutydeck/secret-provider', 'packages/secret-provider/src/index.ts'],
  ['@dutydeck/session-backends', 'packages/session-backends/src/index.ts'],
  ['@dutydeck/shared', 'packages/shared/src/index.ts'],
  ['@dutydeck/storage', 'packages/storage/src/index.ts'],
  ['@dutydeck/terminal-renderer', 'packages/terminal-renderer/src/index.ts'],
  ['@dutydeck/transports', 'packages/transports/src/index.ts']
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
    name: 'dutydeck-workspace',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^(?:acpx\/runtime|@dutydeck\/)/ }, args => {
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
cpSync(resolve(serverRoot, 'src/lark/assets/dutydeck-bouncing-ball.webp'), resolve(assetsDir, 'dutydeck-bouncing-ball.webp'));
cpSync(resolve(serverRoot, 'src/lark/assets/SVG-SPINNERS-LICENSE.txt'), resolve(assetsDir, 'SVG-SPINNERS-LICENSE.txt'));
