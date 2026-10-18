import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pluginHookEvents, scenarioProviderIdPattern, scenarioProviderRefs, type AgentConfig, type CiProvider, type PluginApi, type PluginHookEvent, type PluginTrigger, type ScenarioProvider } from '@dutydeck/shared';
import { CiProviderRegistry } from '../ci-providers.js';
import { LocalFilePluginSecretResolver } from '@dutydeck/secret-provider';
import { defaultBuiltinPluginRoot, listBuiltinPlugins, reservedBuiltinScenarioIds } from './builtin.js';
import { PluginCommandRegistry } from './commands.js';
import { inProcessHookTimeout, PluginHookBus, withTimeout, type HookRegistration } from './hooks.js';
import { loadPluginDirectory, type LoadedPlugin } from './manifest.js';
import { ScenarioProviderCaller } from './scenario-providers.js';
import { scenarioPackDigest, ScenarioRegistry, type RegisteredScenarioPack } from './scenario-registry.js';
import { scopeApplies } from './scope.js';
import type { ScopedPluginTrigger } from './triggers.js';
import { pluginSecretKey, PluginStore, type PluginLockEntry } from './store.js';

export interface PluginDiagnostic { plugin: string; scenario?: string; message: string }
/** 内置插件的条目只在内存里：免信任确认，作用域恒为 global。 */
export interface BuiltinPluginEntry { name: string; version?: string; source: { kind: 'builtin'; spec: string }; scope: 'global'; enabled: true; trustedCapabilities: string[] }
export interface ActivePlugin { entry: PluginLockEntry | BuiltinPluginEntry; plugin: LoadedPlugin; config: Readonly<Record<string, string>>; builtin: boolean }

const configPlaceholder = /\{\{\s*config\.([a-z][a-z0-9_]*)\s*\}\}/g;
/** 触发器目标里的 `{{config.<键>}}` 换成 userConfig 取值；有键没设置时返回 undefined（触发器不可用）。 */
export function resolveTriggerTarget(target: PluginTrigger['target'], config: Readonly<Record<string, string>>): PluginTrigger['target'] | undefined {
  let missing = false;
  const fill = (value: string) => value.replace(configPlaceholder, (_match, key: string) => { const found = config[key]; if (found === undefined || found === '') missing = true; return found ?? ''; });
  const resolved = { ...target, botAppId: fill(target.botAppId), chatId: fill(target.chatId) };
  return missing ? undefined : resolved;
}

export interface PluginHostOptions {
  /** daemon 数据目录（数据库所在目录）；插件装在其下 plugins/。 */
  dataDir: string;
  /** 内置插件目录；默认随包发布的 builtin-plugins。 */
  builtinRoot?: string;
  log?: { warn(data: Record<string, unknown>, message: string): void };
}

const configEnvName = (key: string) => `DUTYDECK_PLUGIN_CONFIG_${key.toUpperCase()}`;
/** 模块加载和 register(api) 共用启动时限；超时放弃插件，daemon 照常启动。 */
const PROVIDER_REGISTER_TIMEOUT_MS = 15_000;

/**
 * daemon 启动时先加载内置插件，再加载已启用、能力已信任的外部插件。单个插件出错只记诊断、跳过它，不影响 daemon；
 * 单个场景包出错只跳过那个包。插件改动（安装、启用、更新）在下次启动时生效。
 */
export class PluginHost {
  readonly diagnostics: PluginDiagnostic[] = [];
  readonly active: ActivePlugin[] = [];
  readonly ciProviders = new CiProviderRegistry();
  /** 场景注册表总是存在，只有内置包时也一样。 */
  readonly scenarios = new ScenarioRegistry();
  commands = new PluginCommandRegistry([]);
  hooks = new PluginHookBus([]);
  /** 有外部插件，或内置插件带了场景包以外的东西（命令、agents、skills、触发器、hooks、CI 提供方）时才需要接到 daemon。 */
  needsWiring = false;
  private constructor(readonly store: PluginStore, private readonly builtinRoot: string, private readonly log?: PluginHostOptions['log']) {}

  static empty(dataDir: string): PluginHost { return new PluginHost(new PluginStore(dataDir), defaultBuiltinPluginRoot()); }

  static async load(options: PluginHostOptions): Promise<PluginHost> {
    const builtinRoot = options.builtinRoot ?? defaultBuiltinPluginRoot();
    const host = new PluginHost(new PluginStore(options.dataDir, builtinRoot), builtinRoot, options.log);
    await host.initialize();
    return host;
  }

  private async initialize() {
    const builtins = listBuiltinPlugins(this.builtinRoot);
    const builtinNames = new Set(builtins.map(item => item.name));
    const reservedScenarioIds = reservedBuiltinScenarioIds(this.builtinRoot);
    let entries: PluginLockEntry[] = [];
    try { entries = this.store.list(); }
    catch (error) { this.fail('*', error); }
    const candidates = [
      ...builtins.map(item => ({ entry: { name: item.name, source: { kind: 'builtin', spec: item.root }, scope: 'global', enabled: true, trustedCapabilities: [] } as BuiltinPluginEntry, root: item.root, builtin: true })),
      ...entries.filter(item => item.enabled).sort((left, right) => left.name.localeCompare(right.name)).map(entry => ({ entry, root: this.store.pluginDir(entry.name), builtin: false }))
    ];
    const registrations: HookRegistration[] = [];
    let secrets: LocalFilePluginSecretResolver | undefined;
    for (const { entry: candidate, root, builtin } of candidates) {
      let entry = candidate;
      try {
        if (!builtin && builtinNames.has(entry.name)) throw new Error(`和内置插件 ${entry.name} 同名，没有加载；卸载后改名重新安装`);
        const plugin = await loadPluginDirectory(root);
        if (plugin.manifest.name !== entry.name) throw new Error(builtin ? `内置插件目录 ${entry.name} 里的插件名是 ${plugin.manifest.name}，两者必须一致` : `目录里的插件名是 ${plugin.manifest.name}，与锁文件记录的 ${entry.name} 不一致`);
        if (builtin) entry = { ...entry as BuiltinPluginEntry, ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}), trustedCapabilities: plugin.capabilities };
        const untrusted = plugin.capabilities.filter(capability => !entry.trustedCapabilities.includes(capability));
        if (untrusted.length) throw new Error(`能力未经确认：${untrusted.join('、')}；运行 dutydeck plugin update ${entry.name} 确认后重启`);
        for (const issue of plugin.scenarioIssues) {
          const message = `场景包未加载：${issue.file}${issue.field ? ` ${issue.field}` : ''}：${issue.message}`;
          this.diagnostics.push({ plugin: entry.name, message });
          this.log?.warn({ plugin: entry.name, error: message }, '场景包已跳过');
        }
        const config: Record<string, string> = { ...this.store.plainConfig(entry.name) };
        for (const [key, declared] of Object.entries(plugin.manifest.userConfig ?? {})) {
          if (!declared.sensitive) continue;
          secrets ??= (() => { const provider = this.store.secretProvider(false); return provider ? new LocalFilePluginSecretResolver(provider) : undefined; })();
          const value = secrets?.read(pluginSecretKey(entry.name, key));
          if (value !== undefined) config[key] = value;
        }
        const dataDir = this.store.pluginDataDir(entry.name);
        const pluginRegistrations: HookRegistration[] = [];
        const env = {
          DUTYDECK_PLUGIN_NAME: entry.name, DUTYDECK_PLUGIN_ROOT: plugin.root, DUTYDECK_PLUGIN_DATA: dataDir,
          ...Object.fromEntries(Object.entries(config).map(([key, value]) => [configEnvName(key), value]))
        };
        for (const event of pluginHookEvents) for (const spec of plugin.hooks[event] ?? []) {
          pluginRegistrations.push({ kind: 'command', plugin: entry.name, scope: entry.scope, event, spec, cwd: plugin.root, env, ...(spec.matcher ? { matcher: new RegExp(spec.matcher) } : {}) });
        }
        const providers: CiProvider[] = [];
        const scenarioProviders = new Map<string, ScenarioProvider>();
        if (plugin.providersEntry) {
          // 内置插件随每次启动加载，不为它们建数据目录：没装插件时数据目录下什么都不多（用到时插件自己建）。
          if (!builtin) await mkdir(dataDir, { recursive: true });
          let registering = true;
          const api: PluginApi = {
            plugin: { name: entry.name, ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}), root: plugin.root, dataDir },
            config: Object.freeze({ ...config }),
            registerCiProvider: provider => { if (registering) providers.push(provider); },
            registerHookHandler: (event: PluginHookEvent, handler, options) => {
              if (!registering) return;
              if (!pluginHookEvents.includes(event)) throw new Error(`未知的 hook 事件：${event}`);
              pluginRegistrations.push({ kind: 'handler', plugin: entry.name, scope: entry.scope, event, handler, timeout: inProcessHookTimeout(options?.timeout), ...(options?.matcher ? { matcher: new RegExp(options.matcher) } : {}) });
            },
            registerScenarioProvider: provider => {
              if (!registering) return;
              if (typeof provider?.id !== 'string' || !scenarioProviderIdPattern.test(provider.id)) throw new Error(`场景 provider id 无效：${String(provider?.id)}`);
              if (scenarioProviders.has(provider.id)) throw new Error(`场景 provider ${provider.id} 重复注册`);
              scenarioProviders.set(provider.id, provider);
            }
          };
          try {
            await withTimeout((async () => {
              const module = await import(pathToFileURL(plugin.providersEntry!).href) as { default?: unknown; register?: unknown };
              if (!registering) return;
              const register = typeof module.default === 'function' ? module.default : module.register;
              if (typeof register !== 'function') throw new Error(`${plugin.manifest.providers} 没有默认导出 register(api) 函数`);
              await register(api);
            })(), PROVIDER_REGISTER_TIMEOUT_MS);
          } finally { registering = false; }
        }
        // 先登记到临时表做完检查，失败的插件不留下一部分提供方。
        const checked = new CiProviderRegistry();
        for (const provider of providers) {
          checked.register(entry.name, provider);
          const existing = this.ciProviders.list().find(item => item.provider.id === provider.id);
          if (existing) throw new Error(`CI 提供方 ${provider.id} 已由插件 ${existing.plugin} 注册`);
        }
        const scenarios = this.resolveScenarios(entry.name, entry.scope, builtin, plugin, scenarioProviders, reservedScenarioIds);
        for (const provider of providers) this.ciProviders.register(entry.name, provider);
        this.scenarios.add(scenarios);
        registrations.push(...pluginRegistrations);
        this.active.push({ entry, plugin, config: Object.freeze({ ...config }), builtin });
        if (!builtin || plugin.commands.length || plugin.agents.length || plugin.skillsDir || plugin.triggers.size || pluginRegistrations.length || providers.length) this.needsWiring = true;
      } catch (error) { this.fail(entry.name, error); }
    }
    this.commands = new PluginCommandRegistry(this.active.map(({ entry, plugin }) => ({ name: entry.name, scope: entry.scope, commands: plugin.commands })));
    this.hooks = new PluginHookBus(registrations, this.log);
  }

  /** 可信阶段：把包里引用的 provider 解析到本插件注册的对象。解析不到、包 id 已被别的插件占用或保留给内置插件时只跳过那个包。 */
  private resolveScenarios(plugin: string, scope: string, builtin: boolean, loaded: LoadedPlugin, providers: ReadonlyMap<string, ScenarioProvider>, reserved: ReadonlyMap<string, string>): RegisteredScenarioPack[] {
    const resolved: RegisteredScenarioPack[] = [];
    for (const { pack } of loaded.scenarios) {
      const problems: string[] = [];
      const callers = new Map<string, ScenarioProviderCaller>();
      for (const ref of scenarioProviderRefs(pack)) {
        const provider = providers.get(ref.id);
        if (!provider) problems.push(`${ref.field} 引用的 provider ${ref.id} 没有注册`);
        else if (typeof provider[ref.method] !== 'function') problems.push(`provider ${ref.id} 没有 ${ref.method} 方法（${ref.field} 需要）`);
        else callers.set(ref.id, new ScenarioProviderCaller(plugin, provider, this.log));
      }
      const owner = this.scenarios.get(pack.id);
      const reservedBy = builtin ? undefined : reserved.get(pack.id);
      if (reservedBy) problems.push(`场景包 id ${pack.id} 保留给内置插件 ${reservedBy}`);
      else if (owner) problems.push(`场景包 id ${pack.id} 已由插件 ${owner.plugin} 提供`);
      if (problems.length) { this.diagnostics.push({ plugin, scenario: pack.id, message: `场景包 ${pack.id} 已跳过：${problems.join('；')}` }); this.log?.warn({ plugin, scenario: pack.id, problems }, '场景包已跳过'); continue; }
      resolved.push({ plugin, builtin, scope, pack, digest: scenarioPackDigest(pack), providers: callers });
    }
    return resolved;
  }

  private fail(plugin: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.diagnostics.push({ plugin, message });
    this.log?.warn({ plugin, error: message }, '插件加载失败，已跳过');
  }

  /** 插件 agents，先于 DUTYDECK_AGENTS_JSON 合并（同 id 以环境变量为准）。 */
  get agents(): AgentConfig[] { return this.active.flatMap(({ entry, plugin }) => plugin.agents.map(agent => ({ ...agent, origin: `plugin:${entry.name}` }))); }

  skillRoots(context: { workspaceRoot: string; botAppId?: string }): string[] {
    return this.active.filter(({ entry, plugin }) => plugin.skillsDir && scopeApplies(entry.scope, { cwd: context.workspaceRoot, ...(context.botAppId ? { botAppId: context.botAppId } : {}) }))
      .map(({ plugin }) => plugin.skillsDir!);
  }

  /** 触发器的目标机器人由触发器声明（可引用 userConfig）；bot 作用域的插件只能把任务投给它限定的那个机器人。 */
  trigger(pluginName: string, triggerId: string): ScopedPluginTrigger | undefined {
    const active = this.active.find(({ entry }) => entry.name === pluginName);
    const trigger = active?.plugin.triggers.get(triggerId);
    if (!active || !trigger) return undefined;
    const target = resolveTriggerTarget(trigger.target, active.config);
    if (!target) return undefined;
    return scopeApplies(active.entry.scope, { botAppId: target.botAppId }) || active.entry.scope.startsWith('workspace:') ? { ...trigger, target, scope: active.entry.scope } : undefined;
  }

  triggerToken(pluginName: string, triggerId: string): string | undefined {
    return this.store.triggerToken(pluginName, triggerId);
  }
}
