import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { tsImport } from 'tsx/esm/api';
import { loadWorkspaceEntries } from '../../../scripts/workspace-entries.mjs';
import { asciiBundle } from './ascii-bundle.mjs';
import { missingRelativeImports } from '../src/daemon/import-closure.mjs';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(serverRoot, '../..');
const webDist = resolve(workspaceRoot, 'apps/web/dist');
const publicDir = resolve(serverRoot, 'public');
const aliases = {
  ...loadWorkspaceEntries(),
  'acpx/runtime': fileURLToPath(import.meta.resolve('acpx/runtime'))
};

const workspacePlugins = [{
  name: 'dutydeck-workspace',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^(?:acpx\/runtime|@dutydeck\/)/ }, args => {
      const path = aliases[args.path];
      return path ? { path } : undefined;
    });
  }
}];

// Keep npm packages external, except drizzle-orm: loaded as an external ESM package, Node re-reads its
// 443-entry exports map for each of its ~110 files (~350 ms per process). Bundling it resolves through the
// default import condition (the ESM build); native packages such as better-sqlite3 stay external.
const externalPackages = {
  name: 'dutydeck-external-packages',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^[^./]/ }, args => /^drizzle-orm(\/|$)/.test(args.path) ? undefined : { path: args.path, external: true });
  }
};

// The Lark SDK is CommonJS. Importing it from ESM goes through Node's CJS translator, which keeps
// extra copies of its ~12 MB source in the heap. The main bundle imports a small ESM shim instead that
// loads it with require. The shim is a separate file so a failed load keeps rethrowing the same error,
// as Node caches a module whose evaluation threw. Sources keep `import * as lark` so Vitest mocks apply;
// the export list comes from the installed SDK.
const larkSdk = '@larksuiteoapi/node-sdk';
const larkExports = Object.keys(createRequire(resolve(serverRoot, 'package.json'))(larkSdk)).filter(key => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key));
for (const key of ['Client', 'EventDispatcher', 'LoggerLevel', 'WSClient', 'defaultHttpInstance']) {
  if (!larkExports.includes(key)) throw new Error(`${larkSdk} no longer exports ${key}`);
}
const larkShim = 'lark-sdk.mjs';
const larkRequirePlugin = {
  name: 'dutydeck-lark-require',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@larksuiteoapi\/node-sdk$/ }, () => ({ path: `./${larkShim}`, external: true }));
  }
};

// acpx imports the ACP protocol SDK at the top of its client module, and the SDK builds its whole zod schema
// set on load (~20 MB of heap, ~200 ms). Hosts that never start an ACP session don't need it, so the bundle
// loads it when the first agent launches: the static import becomes bindings that launch-support fills in,
// which every launch awaits before it creates a connection.
const acpSdk = '@agentclientprotocol/sdk';
const lazyAcpSdkPlugin = {
  name: 'dutydeck-lazy-acp-sdk',
  setup(buildApi) {
    buildApi.onLoad({ filter: /[\\/]acpx[\\/]dist[\\/][^\\/]+\.js$/ }, async args => {
      const source = await readFile(args.path, 'utf8');
      if (!source.includes(`"${acpSdk}"`)) return undefined;
      const imports = [...source.matchAll(new RegExp(`^import \\{([^}]+)\\} from "${acpSdk.replace('/', '\\/')}";$`, 'gm'))];
      const launches = source.split('\n\tasync ensureLaunchSupport(plan, resourceScope) {\n').length - 1;
      if (imports.length !== 1 || launches !== 1 || source.split(`"${acpSdk}"`).length !== 2) {
        throw new Error(`${args.path}: expected one ${acpSdk} import and one ensureLaunchSupport; update the lazy ACP SDK rewrite in build.mjs`);
      }
      const bindings = imports[0][1].split(',').map(name => name.trim()).filter(Boolean).map(name => name.split(/\s+as\s+/));
      const local = bindings.map(([imported, alias]) => alias ?? imported);
      const pattern = bindings.map(([imported, alias]) => alias ? `${imported}: ${alias}` : imported).join(', ');
      return {
        loader: 'js',
        contents: source
          .replace(imports[0][0], `let ${local.join(', ')};\nconst loadAcpSdk = async () => { ({ ${pattern} } = await import("${acpSdk}")); };`)
          .replace('\n\tasync ensureLaunchSupport(plan, resourceScope) {\n', '\n\tasync ensureLaunchSupport(plan, resourceScope) {\n\t\tawait loadAcpSdk();\n')
      };
    });
  }
};

rmSync(resolve(serverRoot, 'dist'), { recursive: true, force: true });
if (!existsSync(resolve(webDist, 'index.html'))) throw new Error('Web UI is not built. Run pnpm --dir apps/web build first.');
rmSync(publicDir, { recursive: true, force: true });
cpSync(webDist, publicDir, { recursive: true });
const mainResult = await build({
  entryPoints: {
    cli: resolve(serverRoot, 'src/cli.ts'),
    'internal-agent-cli': resolve(serverRoot, 'src/internal-agent-cli.ts')
  },
  outdir: resolve(serverRoot, 'dist'),
  entryNames: '[name]',
  chunkNames: 'chunk-[hash]',
  splitting: true,
  absWorkingDir: workspaceRoot,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  minify: true,
  keepNames: true,
  metafile: true,
  plugins: [...workspacePlugins, larkRequirePlugin, lazyAcpSdkPlugin, externalPackages]
});
const cliPath = resolve(serverRoot, 'dist/cli.js');
const internalAgentCliPath = resolve(serverRoot, 'dist/internal-agent-cli.js');
const outputs = new Map(Object.entries(mainResult.metafile.outputs).map(([path, output]) => [resolve(workspaceRoot, path), output]));
const startupOnly = /(?:^|[\\/])(?:fastify|pino|ws|@xterm[\\/](?:headless|addon-serialize)|mdast-util-from-markdown)(?:[\\/]|$)/;
const visited = new Set();
const checkStartupGraph = path => {
  if (visited.has(path)) return;
  visited.add(path);
  const output = outputs.get(path);
  if (!output) throw new Error(`Missing metafile output for ${path}`);
  for (const input of Object.keys(output.inputs)) {
    if (startupOnly.test(input)) throw new Error(`Startup static graph contains ${input}`);
  }
  for (const imported of output.imports) {
    if (imported.kind === 'dynamic-import') continue;
    if (startupOnly.test(imported.path)) throw new Error(`Startup static graph imports ${imported.path} from ${path}`);
    if (imported.external) continue;
    const target = imported.path.startsWith('.') ? resolve(dirname(path), imported.path) : resolve(workspaceRoot, imported.path);
    if (outputs.has(target)) checkStartupGraph(target);
  }
};
checkStartupGraph(cliPath);
checkStartupGraph(internalAgentCliPath);
const mainBundles = [...outputs.keys()].filter(path => path.endsWith('.js'));
for (const bundle of mainBundles) {
  if ((await readFile(bundle, 'utf8')).includes(`from "${acpSdk}"`)) throw new Error(`${bundle} still imports ${acpSdk} at startup`);
}
writeFileSync(resolve(serverRoot, 'dist', larkShim), `import { createRequire } from 'node:module';\nconst lark = createRequire(import.meta.url)(${JSON.stringify(larkSdk)});\nexport default lark;\nexport const { ${larkExports.join(', ')} } = lark;\n`);
// Isolated plugin activation uses the same Host registries after installation, without tsx.
await build({
  entryPoints: [resolve(serverRoot, 'src/plugins/activation-worker.ts')],
  outfile: resolve(serverRoot, 'dist/assets/plugin-validation/cli.js'),
  bundle: true, format: 'esm', platform: 'node', target: 'node22', sourcemap: false, minify: true, keepNames: true,
  plugins: [...workspacePlugins, lazyAcpSdkPlugin, externalPackages]
});
// Pane-resident OSC handshake relay must survive bundling and npm packaging.
await build({
  entryPoints: [resolve(workspaceRoot, 'packages/session-backends/src/program-status-relay.ts')],
  outfile: resolve(serverRoot, 'dist/program-status-relay.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  minify: true,
  keepNames: true,
  packages: 'external',
});
// Bundle the analyzer and its dependencies so it can run with an empty PATH
// from any cwd, without workspace packages or TypeScript loaders in production.
await build({
  entryPoints: [resolve(serverRoot, 'src/session-insight-cli.ts')],
  outfile: resolve(serverRoot, 'dist/assets/session-insight/cli.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  minify: true,
  keepNames: true,
  plugins: workspacePlugins
});
// Each process keeps its bundle's source in memory; ASCII-only source is stored at one byte per character.
for (const bundle of [...mainBundles, ...['dist/assets/plugin-validation/cli.js', 'dist/assets/session-insight/cli.js', 'dist/program-status-relay.js'].map(path => resolve(serverRoot, path))]) asciiBundle(bundle);
const missingChunks = [cliPath, internalAgentCliPath].flatMap(entry => missingRelativeImports(entry));
if (missingChunks.length) throw new Error(`CLI entry has missing relative imports:\n${missingChunks.join('\n')}`);
const agentsDir = resolve(serverRoot, 'dist/agents');
mkdirSync(agentsDir, { recursive: true });
cpSync(resolve(workspaceRoot, 'packages/acp-client/agents/claude-acp.mjs'), resolve(agentsDir, 'claude-acp.mjs'));
cpSync(resolve(workspaceRoot, 'packages/acp-client/agents/claude-guard.mjs'), resolve(agentsDir, 'claude-guard.mjs'));
cpSync(resolve(workspaceRoot, 'packages/acp-client/agents/env-launcher.mjs'), resolve(agentsDir, 'env-launcher.mjs'));
cpSync(resolve(workspaceRoot, 'packages/acp-client/agents/codex-permission-bridge.mjs'), resolve(agentsDir, 'codex-permission-bridge.mjs'));
cpSync(resolve(workspaceRoot, 'packages/shared/runtime/child-environment.mjs'), resolve(agentsDir, 'child-environment.mjs'));
cpSync(resolve(workspaceRoot, 'packages/shared/runtime/secret-guard.mjs'), resolve(agentsDir, 'secret-guard.mjs'));
cpSync(resolve(workspaceRoot, 'packages/acp-client/agents/launcher-process.mjs'), resolve(agentsDir, 'launcher-process.mjs'));
// 内置插件随包发布；各插件的 test/ 和 *.test.ts 只在仓库里跑，不进发布产物。
cpSync(resolve(workspaceRoot, 'builtin-plugins'), resolve(serverRoot, 'dist/builtin-plugins'), { recursive: true, filter: source => basename(source) !== 'test' && !source.endsWith('.test.ts') });
const assetsDir = resolve(serverRoot, 'dist/assets');
mkdirSync(assetsDir, { recursive: true });
cpSync(resolve(serverRoot, 'src/lark/assets/dutydeck-bouncing-ball.webp'), resolve(assetsDir, 'dutydeck-bouncing-ball.webp'));
cpSync(resolve(serverRoot, 'src/lark/assets/SVG-SPINNERS-LICENSE.txt'), resolve(assetsDir, 'SVG-SPINNERS-LICENSE.txt'));
cpSync(resolve(workspaceRoot, 'THIRD_PARTY_NOTICES.md'), resolve(assetsDir, 'THIRD_PARTY_NOTICES.md'));
const { latestSchemaVersion } = await tsImport('../../../packages/storage/src/migrations.ts', import.meta.url);
writeFileSync(resolve(serverRoot, 'dist/schema-reader.json'), JSON.stringify({ protocol: 1, schemaVersion: latestSchemaVersion }));
