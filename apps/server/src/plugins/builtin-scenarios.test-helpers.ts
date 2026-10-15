import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from './host.js';
import type { ScenarioRegistry } from './scenario-registry.js';

let loaded: Promise<ScenarioRegistry> | undefined;
/** 只含内置场景包的注册表，和 daemon 启动时加载的一样。没有外部插件，加载一次后共用。 */
export function builtinScenarioRegistry(): Promise<ScenarioRegistry> {
  loaded ??= (async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dutydeck-builtin-scenarios-'));
    try { return (await PluginHost.load({ dataDir })).scenarios; }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  })();
  return loaded;
}
