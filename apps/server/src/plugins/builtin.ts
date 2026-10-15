import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_MANIFEST_PATH } from './manifest.js';

/**
 * 内置插件目录：打包后本模块在 dist/cli.js 里，目录是 dist/builtin-plugins；
 * 开发和测试时（tsx、vitest 直接跑源码）是仓库根的 builtin-plugins。
 */
export function defaultBuiltinPluginRoot(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../../../builtin-plugins' : './builtin-plugins', import.meta.url));
}

/** 内置插件：目录下每个带清单的子目录，按名字排序。目录名就是插件名，加载时核对清单里的 name。 */
export function listBuiltinPlugins(root: string): Array<{ name: string; root: string }> {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, PLUGIN_MANIFEST_PATH)))
    .map(entry => ({ name: entry.name, root: join(root, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const readJson = (path: string): unknown => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };

/**
 * 内置插件声明的场景包 id → 插件名。外部插件不能使用这些 id，内置插件加载失败时也一样（否则外部包会接过群里已确认的绑定）。
 * 只读 JSON、不执行插件代码；包文件读不出 id 时用文件名兜底。
 */
export function reservedBuiltinScenarioIds(root: string): Map<string, string> {
  const reserved = new Map<string, string>();
  for (const plugin of listBuiltinPlugins(root)) {
    const manifest = readJson(join(plugin.root, PLUGIN_MANIFEST_PATH)) as { scenarios?: unknown } | undefined;
    const declared = typeof manifest?.scenarios === 'string' && !manifest.scenarios.split(/[\\/]/).includes('..') ? manifest.scenarios : 'scenarios';
    const dir = join(plugin.root, declared);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const id = (readJson(join(dir, file)) as { id?: unknown } | undefined)?.id;
      reserved.set(typeof id === 'string' && id ? id : basename(file, '.json'), plugin.name);
    }
  }
  return reserved;
}
