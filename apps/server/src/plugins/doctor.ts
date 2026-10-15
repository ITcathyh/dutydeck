import type { DoctorCheck } from '../doctor/types.js';
import { listBuiltinPlugins } from './builtin.js';
import { resolveTriggerTarget } from './host.js';
import { loadPluginDirectory, type LoadedPlugin } from './manifest.js';
import { pluginSecretKey, PluginStore } from './store.js';

const scenarioProblems = (plugin: LoadedPlugin) => plugin.scenarioIssues.map(issue => ({ text: `场景包未加载：${issue.file}${issue.field ? ` ${issue.field}` : ''}：${issue.message}`, command: `dutydeck plugin validate ${plugin.root}` }));

/**
 * `dutydeck doctor` 的插件检查：只读锁文件和插件目录，不加载 providers、不建目录。
 * 没有内置插件、也没有安装插件时返回空数组，体检输出与未引入插件前一致。
 */
export async function pluginDoctorChecks(dataDir: string, builtinRoot?: string): Promise<DoctorCheck[]> {
  const store = new PluginStore(dataDir, builtinRoot);
  const builtins = listBuiltinPlugins(store.builtinRoot);
  const builtinNames = new Set(builtins.map(item => item.name));
  const builtinChecks: DoctorCheck[] = [];
  for (const { name, root } of builtins) {
    const id = `plugins.${name}`;
    const label = `内置插件 ${name}`;
    try {
      const plugin = await loadPluginDirectory(root);
      if (plugin.manifest.name !== name) throw new Error(`目录名 ${name} 与插件名 ${plugin.manifest.name} 不一致`);
      const problems = scenarioProblems(plugin);
      builtinChecks.push(problems.length
        ? { id, label, level: 'warn', detail: problems.map(problem => problem.text).join('；'), remedy: '这些场景包不会加载，插件其余部分照常。' }
        : { id, label, level: 'ok', detail: `${plugin.manifest.version ?? ''}${plugin.manifest.version ? ' · ' : ''}内置` });
    } catch (error) {
      builtinChecks.push({ id, label, level: 'fail', detail: error instanceof Error ? error.message : String(error), remedy: '内置插件随 Dutydeck 发布；重新安装或升级 Dutydeck。' });
    }
  }
  let entries;
  try { entries = store.list(); }
  catch (error) {
    return [...builtinChecks, { id: 'plugins.lock', label: '插件锁文件', level: 'fail', detail: error instanceof Error ? error.message : String(error), remedy: '修正 plugins/plugins.lock.json，或删除后重新安装插件。' }];
  }
  const checks: DoctorCheck[] = [...builtinChecks];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const id = `plugins.${entry.name}`;
    const label = `插件 ${entry.name}`;
    if (!entry.enabled) { checks.push({ id, label, level: 'skip', detail: '已停用' }); continue; }
    if (builtinNames.has(entry.name)) { checks.push({ id: `${id}.external`, label, level: 'warn', detail: `和内置插件 ${entry.name} 同名，不会加载`, remedy: '卸载后改名重新安装。', command: `dutydeck plugin uninstall ${entry.name}` }); continue; }
    try {
      const plugin = await loadPluginDirectory(store.pluginDir(entry.name));
      if (plugin.manifest.name !== entry.name) throw new Error(`目录里的插件名是 ${plugin.manifest.name}，与锁文件记录的 ${entry.name} 不一致`);
      const untrusted = plugin.capabilities.filter(capability => !entry.trustedCapabilities.includes(capability));
      if (untrusted.length) {
        checks.push({ id, label, level: 'warn', detail: `能力未经确认，daemon 不会加载：${untrusted.join('、')}`, remedy: '核对插件改动后重新确认信任，然后重启。', command: `dutydeck plugin update ${entry.name}` });
        continue;
      }
      const plain = store.plainConfig(entry.name);
      const secrets = store.secretProvider(false);
      const config: Record<string, string> = { ...plain };
      for (const [key, declared] of Object.entries(plugin.manifest.userConfig ?? {})) {
        if (declared.sensitive && secrets?.inspect(pluginSecretKey(entry.name, key)).availability === 'available') config[key] = 'set';
      }
      const problems: Array<{ text: string; command: string }> = [];
      for (const [triggerId, trigger] of plugin.triggers) {
        if (!resolveTriggerTarget(trigger.target, config)) problems.push({ text: `触发器 ${triggerId} 的目标缺少配置`, command: `dutydeck plugin config ${entry.name} <配置项> --value <值>` });
        if (!store.triggerToken(entry.name, triggerId)) problems.push({ text: `触发器 ${triggerId} 还没有令牌`, command: `dutydeck plugin trigger-token ${entry.name}/${triggerId}` });
      }
      problems.push(...scenarioProblems(plugin));
      if (problems.length) checks.push({ id, label, level: 'warn', detail: problems.map(problem => problem.text).join('；'), remedy: '补齐后重启 daemon。', command: problems[0]!.command });
      else checks.push({ id, label, level: 'ok', detail: `${entry.version ?? ''}${entry.version ? ' · ' : ''}${entry.scope}` });
    } catch (error) {
      checks.push({ id, label, level: 'fail', detail: error instanceof Error ? error.message : String(error), remedy: '这个插件不会被加载，其余功能不受影响。修好插件目录后执行 update，或先停用。', command: `dutydeck plugin disable ${entry.name}` });
    }
  }
  return checks;
}
