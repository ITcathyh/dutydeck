import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pluginHookEvents, type AgentConfig, type CiProvider, type PluginApi, type PluginHookEvent, type PluginTrigger } from '@dutydeck/shared';
import { LocalFilePluginSecretResolver } from '@dutydeck/secret-provider';
import { PluginCommandRegistry } from './commands.js';
import { inProcessHookTimeout, PluginHookBus, withTimeout, type HookRegistration } from './hooks.js';
import { loadPluginDirectory, type LoadedPlugin } from './manifest.js';
import { scopeApplies } from './scope.js';
import { pluginSecretKey, PluginStore, type PluginLockEntry } from './store.js';

export interface PluginDiagnostic { plugin: string; message: string }
export interface ActivePlugin { entry: PluginLockEntry; plugin: LoadedPlugin; config: Readonly<Record<string, string>> }

const configPlaceholder = /\{\{\s*config\.([a-z][a-z0-9_]*)\s*\}\}/g;
/** 触发器目标里的 `{{config.<键>}}` 换成 userConfig 取值；有键没设置时返回 undefined（触发器不可用）。 */
export function resolveTriggerTarget(target: PluginTrigger['target'], config: Readonly<Record<string, string>>): PluginTrigger['target'] | undefined {
  let missing = false;
  const fill = (value: string) => value.replace(configPlaceholder, (_match, key: string) => { const found = config[key]; if (found === undefined || found === '') missing = true; return found ?? ''; });
  const resolved = { ...target, botAppId: fill(target.botAppId), chatId: fill(target.chatId) };
  return missing ? undefined : resolved;
}

export class CiProviderRegistry {
  private readonly providers = new Map<string, { plugin: string; provider: CiProvider }>();
  register(plugin: string, provider: CiProvider) {
    if (!provider?.id || typeof provider.matchRepository !== 'function') throw new Error('CI 提供方缺少 id 或 matchRepository');
    const existing = this.providers.get(provider.id);
    if (existing) throw new Error(`CI 提供方 ${provider.id} 已由插件 ${existing.plugin} 注册`);
    this.providers.set(provider.id, { plugin, provider });
  }
  get(id: string): CiProvider | undefined { return this.providers.get(id)?.provider; }
  list(): Array<{ plugin: string; provider: CiProvider }> { return [...this.providers.values()]; }
  /** 第一个认领这个远端地址的提供方。 */
  match(remoteUrl: string): CiProvider | undefined {
    return this.list().find(({ provider }) => { try { return provider.matchRepository(remoteUrl); } catch { return false; } })?.provider;
  }
}

export interface PluginHostOptions {
  /** daemon 数据目录（数据库所在目录）；插件装在其下 plugins/。 */
  dataDir: string;
  log?: { warn(data: Record<string, unknown>, message: string): void };
}

const configEnvName = (key: string) => `DUTYDECK_PLUGIN_CONFIG_${key.toUpperCase()}`;
/** register(api) 迟迟不返回时放弃这个插件，daemon 照常启动。 */
const PROVIDER_REGISTER_TIMEOUT_MS = 15_000;

/**
 * daemon 启动时加载已启用、能力已信任的插件。单个插件出错只记诊断、跳过它，不影响 daemon。
 * 插件改动（安装、启用、更新）在下次启动时生效。
 */
export class PluginHost {
  readonly diagnostics: PluginDiagnostic[] = [];
  readonly active: ActivePlugin[] = [];
  readonly ciProviders = new CiProviderRegistry();
  commands = new PluginCommandRegistry([]);
  hooks = new PluginHookBus([]);
  private constructor(readonly store: PluginStore, private readonly log?: PluginHostOptions['log']) {}

  static empty(dataDir: string): PluginHost { return new PluginHost(new PluginStore(dataDir)); }

  static async load(options: PluginHostOptions): Promise<PluginHost> {
    const host = new PluginHost(new PluginStore(options.dataDir), options.log);
    await host.initialize();
    return host;
  }

  private async initialize() {
    let entries: PluginLockEntry[] = [];
    try { entries = this.store.list(); }
    catch (error) { this.fail('*', error); return; }
    const registrations: HookRegistration[] = [];
    let secrets: LocalFilePluginSecretResolver | undefined;
    for (const entry of entries.filter(item => item.enabled).sort((left, right) => left.name.localeCompare(right.name))) {
      try {
        const plugin = await loadPluginDirectory(this.store.pluginDir(entry.name));
        if (plugin.manifest.name !== entry.name) throw new Error(`目录里的插件名是 ${plugin.manifest.name}，与锁文件记录的 ${entry.name} 不一致`);
        const untrusted = plugin.capabilities.filter(capability => !entry.trustedCapabilities.includes(capability));
        if (untrusted.length) throw new Error(`能力未经确认：${untrusted.join('、')}；运行 dutydeck plugin update ${entry.name} 确认后重启`);
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
        if (plugin.providersEntry) {
          await mkdir(dataDir, { recursive: true });
          const module = await import(pathToFileURL(plugin.providersEntry).href) as { default?: unknown; register?: unknown };
          const register = typeof module.default === 'function' ? module.default : module.register;
          if (typeof register !== 'function') throw new Error(`${plugin.manifest.providers} 没有默认导出 register(api) 函数`);
          const api: PluginApi = {
            plugin: { name: entry.name, ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}), root: plugin.root, dataDir },
            config: Object.freeze({ ...config }),
            registerCiProvider: provider => { providers.push(provider); },
            registerHookHandler: (event: PluginHookEvent, handler, options) => {
              if (!pluginHookEvents.includes(event)) throw new Error(`未知的 hook 事件：${event}`);
              pluginRegistrations.push({ kind: 'handler', plugin: entry.name, scope: entry.scope, event, handler, timeout: inProcessHookTimeout(options?.timeout), ...(options?.matcher ? { matcher: new RegExp(options.matcher) } : {}) });
            }
          };
          await withTimeout(Promise.resolve().then(() => register(api)), PROVIDER_REGISTER_TIMEOUT_MS);
        }
        // 先登记到临时表做完检查，失败的插件不留下一部分提供方。
        const checked = new CiProviderRegistry();
        for (const provider of providers) {
          checked.register(entry.name, provider);
          const existing = this.ciProviders.list().find(item => item.provider.id === provider.id);
          if (existing) throw new Error(`CI 提供方 ${provider.id} 已由插件 ${existing.plugin} 注册`);
        }
        for (const provider of providers) this.ciProviders.register(entry.name, provider);
        registrations.push(...pluginRegistrations);
        this.active.push({ entry, plugin, config: Object.freeze({ ...config }) });
      } catch (error) { this.fail(entry.name, error); }
    }
    this.commands = new PluginCommandRegistry(this.active.map(({ entry, plugin }) => ({ name: entry.name, scope: entry.scope, commands: plugin.commands })));
    this.hooks = new PluginHookBus(registrations, this.log);
  }

  private fail(plugin: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.diagnostics.push({ plugin, message });
    this.log?.warn({ plugin, error: message }, '插件加载失败，已跳过');
  }

  /** 插件 agents，先于 DUTYDECK_AGENTS_JSON 合并（同 id 以环境变量为准）。 */
  get agents(): AgentConfig[] { return this.active.flatMap(({ plugin }) => plugin.agents); }

  skillRoots(context: { workspaceRoot: string; botAppId?: string }): string[] {
    return this.active.filter(({ entry, plugin }) => plugin.skillsDir && scopeApplies(entry.scope, { cwd: context.workspaceRoot, ...(context.botAppId ? { botAppId: context.botAppId } : {}) }))
      .map(({ plugin }) => plugin.skillsDir!);
  }

  /** 触发器的目标机器人由触发器声明（可引用 userConfig）；bot 作用域的插件只能把任务投给它限定的那个机器人。 */
  trigger(pluginName: string, triggerId: string): PluginTrigger | undefined {
    const active = this.active.find(({ entry }) => entry.name === pluginName);
    const trigger = active?.plugin.triggers.get(triggerId);
    if (!active || !trigger) return undefined;
    const target = resolveTriggerTarget(trigger.target, active.config);
    if (!target) return undefined;
    return scopeApplies(active.entry.scope, { botAppId: target.botAppId }) || active.entry.scope.startsWith('workspace:') ? { ...trigger, target } : undefined;
  }

  triggerToken(pluginName: string, triggerId: string): string | undefined {
    return this.store.triggerToken(pluginName, triggerId);
  }
}
