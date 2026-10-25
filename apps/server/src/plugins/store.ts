import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, lstat, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { currentProcessIdentity } from '@dutydeck/storage';
import { pluginActivationBlockers, pluginHostStates, validateProviderRegistration, type PluginHostState } from './activation.js';
import { LocalFilePluginSecretResolver, LocalFileSecretProvider, secretDirectoryForDatabase } from '@dutydeck/secret-provider';
import { defaultBuiltinPluginRoot, listBuiltinPlugins } from './builtin.js';
import { loadPluginDirectory, type LoadedPlugin } from './manifest.js';
import { parsePluginScope } from './scope.js';

const run = promisify(execFile);
const LOCK_FILE = 'plugins.lock.json';
const TOKENS_FILE = '.trigger-tokens.json';
const CONFIG_FILE = '.config.json';
const STAGING_DIR = '.staging';

export class PluginStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PluginStoreError'; }
}

const artifactSchema = z.object({
  id: z.union([z.literal('legacy'), z.string().regex(/^[a-f0-9]{64}$/)]),
  version: z.string().optional(),
  resolved: z.object({ sha: z.string().optional(), version: z.string().optional() }).strict(),
  trustedCapabilities: z.array(z.string()),
  validation: z.object({ status: z.enum(['passed', 'failed']), checkedAt: z.string() }).optional()
}).strict();
export type PluginArtifact = z.infer<typeof artifactSchema>;
const lockEntrySchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  source: z.object({ kind: z.enum(['local', 'git', 'npm']), spec: z.string(), ref: z.string().optional() }).strict(),
  resolved: z.object({ sha: z.string().optional(), version: z.string().optional() }).strict(),
  scope: z.string(),
  enabled: z.boolean(),
  trustedCapabilities: z.array(z.string()),
  installedAt: z.string(),
  updatedAt: z.string(),
  active: artifactSchema.optional(),
  candidate: artifactSchema.optional(),
  previous: artifactSchema.optional()
}).strict();
export type PluginLockEntry = z.infer<typeof lockEntrySchema>;
const lockFileSchema = z.object({ version: z.literal(1), plugins: z.record(z.string(), lockEntrySchema) }).strict();
type LockFile = z.infer<typeof lockFileSchema>;

export type PluginSource = PluginLockEntry['source'];

/**
 * 安装来源识别：
 * - `npm:<spec>` 强制 npm；`git+<url>`、`git@…`、`ssh://`、`http(s)://`、`file://` 按 git 处理，`#<ref>` 指定分支、标签或提交；
 * - 绝对路径、`./`、`../`、`~/` 开头，或本地存在的路径按本地目录；
 * - 其余按 npm 包名（可带 @version）。
 */
export function parsePluginSource(spec: string, cwd = process.cwd()): PluginSource {
  const value = spec.trim();
  if (!value) throw new PluginStoreError('PLUGIN_SOURCE_INVALID', '缺少插件来源');
  if (value.startsWith('npm:')) return { kind: 'npm', spec: notOption(value.slice(4)) };
  const gitLike = /^(git\+|git@|ssh:\/\/|https?:\/\/|file:\/\/)/.test(value);
  if (gitLike) {
    const [url, ref] = value.replace(/^git\+/, '').split('#', 2) as [string, string | undefined];
    return { kind: 'git', spec: url, ...(ref ? { ref: notOption(ref) } : {}) };
  }
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (isAbsolute(expanded) || /^\.\.?\//.test(value) || value.startsWith('~/') || existsSync(resolve(cwd, value))) {
    return { kind: 'local', spec: resolve(cwd, expanded) };
  }
  return { kind: 'npm', spec: notOption(value) };
}

/** 交给 git / npm 的参数不能以 - 开头，否则会被当成选项。 */
function notOption(value: string): string {
  if (!value || value.startsWith('-')) throw new PluginStoreError('PLUGIN_SOURCE_INVALID', `插件来源 ${value || '(空)'} 无效`);
  return value;
}

export interface PluginInstallOptions {
  scope?: string;
  /** 已由 --yes 确认需要信任的能力。 */
  yes?: boolean;
  /** 交互确认；返回 false 即放弃。没有交互且没加 --yes 时由调用方抛错。 */
  confirm?: (prompt: PluginTrustPrompt) => Promise<boolean>;
  cwd?: string;
}

export interface PluginTrustPrompt {
  plugin: string;
  /** 要新信任的能力。 */
  capabilities: string[];
  /** 每个 hook 实际要运行的命令，供用户核对。 */
  details: string[];
}

export function trustDetails(plugin: LoadedPlugin): string[] {
  const lines: string[] = plugin.agents.map(agent => `agent ${agent.id}：${[agent.command, ...agent.args].join(' ')}${agent.permissionMode ? `（权限模式 ${agent.permissionMode}）` : ''}`);
  for (const [event, specs] of Object.entries(plugin.hooks)) for (const spec of specs ?? []) {
    lines.push(`hook ${event}：${Array.isArray(spec.command) ? spec.command.join(' ') : spec.command}（超时 ${spec.timeout}ms${spec.onFailure === 'block' ? '，失败即阻断' : ''}）`);
  }
  if (plugin.providersEntry) lines.push(`providers：在 Dutydeck 进程内加载 ${plugin.manifest.providers}`);
  return lines;
}

interface Staged { root: string; plugin: LoadedPlugin; resolved: PluginLockEntry['resolved']; cleanup(): Promise<void> }

export class PluginStore {
  readonly pluginsDir: string;
  /** builtinRoot：内置插件目录，外部插件不能和其中的插件同名。 */
  constructor(readonly dataDir: string, readonly builtinRoot: string = defaultBuiltinPluginRoot(), readonly database = join(dataDir, 'dutydeck.db')) { this.pluginsDir = join(dataDir, 'plugins'); }

  builtinNames(): Set<string> { return new Set(listBuiltinPlugins(this.builtinRoot).map(item => item.name)); }

  pluginDir(name: string, entry = this.readLock().plugins[name]) { return this.artifactDir(name, entry?.active); }
  artifactDir(name: string, artifact?: PluginArtifact) {
    return !artifact || artifact.id === 'legacy' ? join(this.pluginsDir, name) : join(this.pluginsDir, '.artifacts', name, artifact.id);
  }
  private activeArtifact(entry: PluginLockEntry): PluginArtifact {
    return entry.active ?? { id: 'legacy', ...(entry.version ? { version: entry.version } : {}), resolved: entry.resolved, trustedCapabilities: entry.trustedCapabilities };
  }

  /** Selection and lease acquisition share the mutation lock, so activation cannot race startup. */
  async acquireHost(): Promise<{ entries: PluginLockEntry[]; record(loaded: string[], diagnostics: PluginHostState['diagnostics']): Promise<void>; release(): Promise<void> }> {
    const snapshot = this.list();
    if (!snapshot.some(entry => entry.enabled)) return { entries: snapshot, record: async () => {}, release: async () => {} };
    return this.withStoreLock(async () => {
      const entries = this.list();
      const directory = join(this.pluginsDir, '.hosts');
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${randomUUID()}.json`);
      const state: PluginHostState = { identity: currentProcessIdentity(), ...(this.database !== ':memory:' ? { database: resolve(this.database) } : {}), stopped: false,
        plugins: Object.fromEntries(entries.filter(entry => entry.enabled).map(entry => [entry.name, this.activeArtifact(entry).id])) };
      const save = async () => { const temporary = `${path}.tmp`; await writeFile(temporary, JSON.stringify(state)); await rename(temporary, path); };
      await save();
      return { entries, record: async (loaded, diagnostics) => { state.loaded = loaded; state.diagnostics = diagnostics?.map(item => ({ plugin: item.plugin, message: '插件或场景未成功激活；请查看运行日志。' })); await save(); }, release: async () => { state.stopped = true; await save(); } };
    });
  }

  async activationStatus(name: string) {
    const entry = this.get(name);
    const hosts = await pluginHostStates(this.pluginsDir);
    return { selected: this.activeArtifact(entry), candidate: entry.candidate, previous: entry.previous,
      hosts: hosts.filter(host => name in host.plugins && host.observation !== 'dead').map(host => ({ pid: host.identity.pid, observation: host.observation, artifact: host.plugins[name], activated: host.loaded?.includes(name) ?? false, diagnostics: host.diagnostics?.filter(item => item.plugin === name) ?? [] })),
      blockers: await pluginActivationBlockers(this.pluginsDir, name, this.database) };
  }

  private async assertSwitchSafe(name: string) {
    const blockers = await pluginActivationBlockers(this.pluginsDir, name, this.database);
    if (blockers.length) throw new PluginStoreError('PLUGIN_ACTIVATION_BLOCKED', blockers.map(item => `${item.id}：${item.detail}`).join('\n') + '\n先在当前版本恢复并完成/取消任务、核对未决动作；然后 dutydeck stop（systemd 实例用 systemctl --user stop <unit>），停止共用此目录的所有实例，再重试。成功后 dutydeck start（systemd 实例用 systemctl --user start <unit>）。不要强制跳过存活 tmux。');
  }

  private async persistArtifact(name: string, staged: Staged): Promise<PluginArtifact> {
    const artifact: PluginArtifact = { id: await treeDigest(staged.root), ...(staged.plugin.manifest.version ? { version: staged.plugin.manifest.version } : {}), resolved: staged.resolved, trustedCapabilities: staged.plugin.capabilities };
    const root = this.artifactDir(name, artifact);
    if (!existsSync(root)) { await mkdir(join(this.pluginsDir, '.artifacts', name), { recursive: true }); await rename(staged.root, root); }
    else if (await treeDigest(root).catch(() => undefined) !== artifact.id) {
      const entry = this.readLock().plugins[name];
      if (!entry || entry.candidate?.id !== artifact.id || this.activeArtifact(entry).id === artifact.id || entry.previous?.id === artifact.id) {
        throw new PluginStoreError('PLUGIN_ARTIFACT_CHANGED', '现存包已损坏，且不是可独立修复的候选；未覆盖活动或回退目录。先排空并停止服务，再卸载重装（会清除插件私有数据和配置；请先备份）。');
      }
      await this.assertSwitchSafe(name);
      // The store lock excludes new Hosts. Only a candidate with no consumers can be replaced.
      const damaged = join(dirname(staged.root), 'damaged');
      await rename(root, damaged);
      try { await rename(staged.root, root); }
      catch (error) { await rename(damaged, root); throw error; }
    }
    return artifact;
  }

  async activate(name: string): Promise<PluginLockEntry> { return this.switchArtifact(name, 'candidate'); }
  async rollback(name: string): Promise<PluginLockEntry> { return this.switchArtifact(name, 'previous'); }

  private async switchArtifact(name: string, selection: 'candidate' | 'previous'): Promise<PluginLockEntry> {
    return this.withStoreLock(async () => {
      const lock = this.readLock(), entry = lock.plugins[name];
      if (!entry) throw new PluginStoreError('PLUGIN_NOT_INSTALLED', `插件 ${name} 未安装`);
      const artifact = entry[selection];
      if (!artifact) throw new PluginStoreError('PLUGIN_VERSION_MISSING', `插件 ${name} 没有${selection === 'candidate' ? '候选' : '上一'}版本`);
      await this.assertSwitchSafe(name);
      const root = this.artifactDir(name, artifact), loaded = await loadPluginDirectory(root);
      if (loaded.manifest.name !== name || loaded.capabilities.some(capability => !artifact.trustedCapabilities.includes(capability))) throw new PluginStoreError('PLUGIN_TRUST_REQUIRED', '目标包已变化或有未经确认的能力；重新 update 并确认信任。');
      if (artifact.id !== 'legacy' && await treeDigest(root) !== artifact.id) throw new PluginStoreError('PLUGIN_ARTIFACT_CHANGED', '不可变包内容已被修改；请重新 update。');
      await mkdir(join(this.pluginsDir, STAGING_DIR), { recursive: true });
      const checkDir = await mkdtemp(join(this.pluginsDir, STAGING_DIR, 'validate-'));
      try {
        if (loaded.providersEntry) {
          const config = this.plainConfig(name);
          const provider = this.secretProvider(false);
          const secrets = provider ? new LocalFilePluginSecretResolver(provider) : undefined;
          for (const [key, declared] of Object.entries(loaded.manifest.userConfig ?? {})) if (declared.sensitive) {
            const value = secrets?.read(pluginSecretKey(name, key));
            if (value !== undefined) config[key] = value;
          }
          await validateProviderRegistration({ root, dataDir: checkDir, entry: { ...entry, enabled: true, version: artifact.version, active: artifact, trustedCapabilities: artifact.trustedCapabilities }, config });
        }
      } catch {
        artifact.validation = { status: 'failed', checkedAt: new Date().toISOString() }; await this.writeLock(lock);
        throw new PluginStoreError('PLUGIN_ACTIVATION_FAILED', 'Provider 隔离加载/注册验证失败或超时；活动版本未改变。');
      } finally { await rm(checkDir, { recursive: true, force: true }); }
      if (artifact.id !== 'legacy' && await treeDigest(root) !== artifact.id) throw new PluginStoreError('PLUGIN_ARTIFACT_CHANGED', '验证期间包内容发生变化；未激活。');
      // Recheck after running trusted code, before publishing the selected generation.
      await this.assertSwitchSafe(name);
      artifact.validation = { status: 'passed', checkedAt: new Date().toISOString() };
      const old = this.activeArtifact(entry);
      const { version: _version, candidate: _candidate, previous: _previous, ...rest } = entry;
      const next: PluginLockEntry = { ...rest, active: artifact, previous: old,
        ...(selection === 'previous' && entry.candidate ? { candidate: entry.candidate } : {}),
        ...(artifact.version ? { version: artifact.version } : {}), resolved: artifact.resolved, trustedCapabilities: artifact.trustedCapabilities, updatedAt: new Date().toISOString() };
      lock.plugins[name] = next; await this.writeLock(lock); return next;
    });
  }
  /** 插件自己的可写目录（hook 与 providers 可用来放状态）。 */
  pluginDataDir(name: string) { return join(this.pluginsDir, '.data', name); }

  readLock(): LockFile {
    const path = join(this.pluginsDir, LOCK_FILE);
    if (!existsSync(path)) return { version: 1, plugins: {} };
    const parsed = lockFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) throw new PluginStoreError('PLUGIN_LOCK_INVALID', `${path} 格式不正确：${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
    return parsed.data;
  }

  private async writeLock(lock: LockFile) {
    await mkdir(this.pluginsDir, { recursive: true });
    const path = join(this.pluginsDir, LOCK_FILE);
    const temporary = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    const sorted = Object.fromEntries(Object.entries(lock.plugins).sort(([left], [right]) => left.localeCompare(right)));
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, plugins: sorted }, null, 2)}\n`, { flag: 'wx' });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  list(): PluginLockEntry[] { return Object.values(this.readLock().plugins); }

  get(name: string): PluginLockEntry {
    const entry = this.readLock().plugins[name];
    if (!entry) throw new PluginStoreError('PLUGIN_NOT_INSTALLED', `插件 ${name} 未安装`);
    return entry;
  }

  private async stage(source: PluginSource): Promise<Staged> {
    await mkdir(join(this.pluginsDir, STAGING_DIR), { recursive: true });
    return stagePluginSource(source, join(this.pluginsDir, STAGING_DIR));
  }

  /** 需要新信任的能力：声明式插件为空；update 时只问新增的。 */
  private async confirmTrust(plugin: LoadedPlugin, alreadyTrusted: string[], options: PluginInstallOptions) {
    const added = plugin.capabilities.filter(capability => !alreadyTrusted.includes(capability));
    if (!added.length || options.yes) return;
    const prompt = { plugin: plugin.manifest.name, capabilities: added, details: trustDetails(plugin) };
    if (!options.confirm) throw new PluginStoreError('PLUGIN_TRUST_REQUIRED', `插件 ${plugin.manifest.name} 需要信任以下能力：${added.join('、')}。确认后加 --yes 重新执行。\n${prompt.details.join('\n')}`);
    if (!await options.confirm(prompt)) throw new PluginStoreError('PLUGIN_TRUST_DECLINED', `未信任插件 ${plugin.manifest.name}，没有做任何改动`);
  }

  async install(spec: string, options: PluginInstallOptions = {}): Promise<PluginLockEntry> {
    const source = parsePluginSource(spec, options.cwd);
    const scope = parsePluginScope(options.scope);
    const staged = await this.stage(source);
    try {
      const name = staged.plugin.manifest.name;
      if (this.builtinNames().has(name)) throw new PluginStoreError('PLUGIN_NAME_BUILTIN', `插件 ${name} 和内置插件同名，不能安装；请换个名字`);
      if (this.readLock().plugins[name] || existsSync(this.pluginDir(name))) {
        throw new PluginStoreError('PLUGIN_ALREADY_INSTALLED', `插件 ${name} 已安装；更新用 dutydeck plugin update ${name}，或先 uninstall`);
      }
      await this.confirmTrust(staged.plugin, [], options);
      return await this.withStoreLock(async () => {
        const lock = this.readLock();
        if (lock.plugins[name] || existsSync(this.pluginDir(name))) {
          throw new PluginStoreError('PLUGIN_ALREADY_INSTALLED', `插件 ${name} 已安装；更新用 dutydeck plugin update ${name}，或先 uninstall`);
        }
        const active = await this.persistArtifact(name, staged);
        const at = new Date().toISOString();
        const entry: PluginLockEntry = {
          name, ...(staged.plugin.manifest.version ? { version: staged.plugin.manifest.version } : {}),
          source, resolved: staged.resolved, scope, enabled: true, active,
          trustedCapabilities: staged.plugin.capabilities, installedAt: at, updatedAt: at
        };
        lock.plugins[name] = entry;
        await this.writeLock(lock);
        return entry;
      });
    } finally { await staged.cleanup(); }
  }

  /** 按记录的来源重新拉取；能力集合有新增时重新确认，拒绝则保持原版本。 */
  async update(name: string, options: PluginInstallOptions = {}): Promise<{ entry: PluginLockEntry; changed: boolean }> {
    const current = this.get(name);
    const staged = await this.stage(current.source);
    try {
      if (staged.plugin.manifest.name !== name) throw new PluginStoreError('PLUGIN_NAME_CHANGED', `来源里的插件名变成了 ${staged.plugin.manifest.name}，不会覆盖 ${name}`);
      await this.confirmTrust(staged.plugin, [...current.trustedCapabilities, ...(current.candidate?.trustedCapabilities ?? [])], options);
      return await this.withStoreLock(async () => {
        const lock = this.readLock();
        const latest = lock.plugins[name];
        if (!latest) throw new PluginStoreError('PLUGIN_NOT_INSTALLED', `插件 ${name} 未安装`);
        if (latest.installedAt !== current.installedAt || JSON.stringify(latest.source) !== JSON.stringify(current.source)) {
          throw new PluginStoreError('PLUGIN_CHANGED', `插件 ${name} 已重新安装，请重试更新`);
        }
        const candidate = await this.persistArtifact(name, staged);
        const active = this.activeArtifact(latest);
        const changed = candidate.id !== (latest.candidate ?? active).id;
        const { candidate: _candidate, ...rest } = latest;
        const entry: PluginLockEntry = { ...rest, active, ...(candidate.id !== active.id ? { candidate } : {}), updatedAt: new Date().toISOString() };
        lock.plugins[name] = entry;
        await this.writeLock(lock);
        return { entry, changed };
      });
    } finally { await staged.cleanup(); }
  }

  async uninstall(name: string): Promise<void> {
    return this.withStoreLock(async () => {
      if (!this.readLock().plugins[name] && this.builtinNames().has(name)) throw new PluginStoreError('PLUGIN_BUILTIN', `${name} 是内置插件，随 Dutydeck 发布，不能卸载`);
      this.get(name);
      await this.assertSwitchSafe(name);
      await rm(join(this.pluginsDir, '.artifacts', name), { recursive: true, force: true });
      await rm(join(this.pluginsDir, name), { recursive: true, force: true });
      await rm(this.pluginDataDir(name), { recursive: true, force: true });
      const lock = this.readLock();
      delete lock.plugins[name];
      await this.writeLock(lock);
      const tokens = await this.readTokens();
      for (const key of Object.keys(tokens)) if (key.startsWith(`${name}/`)) delete tokens[key];
      await this.writeTokens(tokens);
      const config = await this.readConfigFile();
      if (config[name]) { delete config[name]; await this.writeConfigFile(config); }
      const provider = this.secretProvider(false);
      if (provider && existsSync(provider.directory)) for (const file of await readdir(provider.directory)) {
        const prefix = `${pluginSecretPrefix(name)}`;
        if (file.startsWith(prefix) && file.endsWith('.secret')) provider.removeConditional(file.slice(0, -'.secret'.length));
      }
    });
  }

  async setEnabled(name: string, enabled: boolean): Promise<PluginLockEntry> {
    return this.withStoreLock(async () => {
      const lock = this.readLock();
      const entry = lock.plugins[name];
      if (!entry) throw new PluginStoreError('PLUGIN_NOT_INSTALLED', `插件 ${name} 未安装`);
      entry.enabled = enabled;
      entry.updatedAt = new Date().toISOString();
      await this.writeLock(lock);
      return entry;
    });
  }

  // ---- 触发器令牌：每个触发器一份，0600 文件，daemon 每次请求直读 ----

  private async readTokens(): Promise<Record<string, string>> {
    const path = join(this.pluginsDir, TOKENS_FILE);
    return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) as Record<string, string> : {};
  }
  private async writeTokens(tokens: Record<string, string>) {
    await this.writePrivateJson(TOKENS_FILE, tokens);
  }

  private async writePrivateJson(filename: string, value: unknown): Promise<void> {
    await mkdir(this.pluginsDir, { recursive: true });
    const path = join(this.pluginsDir, filename);
    const temporary = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  /** 同步读，触发器请求路径上用；文件不存在即没有令牌。 */
  triggerToken(plugin: string, triggerId: string): string | undefined {
    const path = join(this.pluginsDir, TOKENS_FILE);
    if (!existsSync(path)) return undefined;
    return (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>)[`${plugin}/${triggerId}`];
  }

  async ensureTriggerToken(plugin: string, triggerId: string, rotate = false): Promise<{ token: string; created: boolean }> {
    return this.withStoreLock(async () => {
      this.get(plugin);
      const loaded = await loadPluginDirectory(this.pluginDir(plugin));
      if (!loaded.triggers.has(triggerId)) throw new PluginStoreError('PLUGIN_TRIGGER_NOT_FOUND', `插件 ${plugin} 没有触发器 ${triggerId}`);
      const tokens = await this.readTokens();
      const key = `${plugin}/${triggerId}`;
      if (tokens[key] && !rotate) return { token: tokens[key], created: false };
      tokens[key] = randomBytes(32).toString('base64url');
      await this.writeTokens(tokens);
      return { token: tokens[key], created: true };
    });
  }

  // ---- userConfig：普通值存 .config.json，sensitive 值存 secret-provider ----

  /** 插件清单、令牌和配置共用 SQLite 互斥；连接关闭或进程退出时由系统释放，不删除锁文件。 */
  private async withStoreLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.pluginsDir, { recursive: true });
    const lock = new Database(join(this.pluginsDir, '.config-lock.sqlite'), { timeout: 0 });
    try {
      const deadline = Date.now() + 10_000;
      while (true) {
        try { lock.exec('BEGIN IMMEDIATE'); break; }
        catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
          if (Date.now() >= deadline) throw new PluginStoreError('PLUGIN_CONFIG_BUSY', '插件状态正在被另一个进程修改，请稍后重试');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      // 不能用同步 transaction(callback)：文件的异步读改写完成前必须保留事务。
      return await action();
    } finally { lock.close(); }
  }

  private async readConfigFile(): Promise<Record<string, Record<string, string>>> {
    const path = join(this.pluginsDir, CONFIG_FILE);
    return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) as Record<string, Record<string, string>> : {};
  }
  private async writeConfigFile(config: Record<string, Record<string, string>>) {
    await this.writePrivateJson(CONFIG_FILE, config);
  }

  secretProvider(create: boolean): LocalFileSecretProvider | undefined {
    const directory = secretDirectoryForDatabase(join(this.dataDir, 'dutydeck.db'));
    if (!create && !existsSync(directory)) return undefined;
    return new LocalFileSecretProvider(directory, { createDirectory: create });
  }

  /** fromArgv：值来自命令行参数。敏感值不接受这种方式（会留在进程列表和 shell 历史里）。 */
  async setConfig(name: string, key: string, value: Buffer, fromArgv = false): Promise<{ sensitive: boolean }> {
    try { return await this.withStoreLock(async () => {
      this.get(name);
      const declared = (await loadPluginDirectory(this.pluginDir(name))).manifest.userConfig?.[key];
      if (!declared) { value.fill(0); throw new PluginStoreError('PLUGIN_CONFIG_UNKNOWN', `插件 ${name} 没有声明配置项 ${key}`); }
      if (declared.sensitive && fromArgv) { value.fill(0); throw new PluginStoreError('PLUGIN_CONFIG_SENSITIVE', `${key} 是敏感配置，请用 --value-fd 或在终端隐藏输入`); }
      if (declared.sensitive) {
        const provider = this.secretProvider(true)!;
        const referenceKey = pluginSecretKey(name, key);
        if (provider.inspect(referenceKey).availability === 'missing') provider.writeExclusive(referenceKey, value);
        else provider.replaceConditional(referenceKey, value, provider.fingerprint(referenceKey));
        return { sensitive: true };
      }
      const config = await this.readConfigFile();
      config[name] = { ...config[name], [key]: value.toString('utf8') };
      value.fill(0);
      await this.writeConfigFile(config);
      return { sensitive: false };
    }); } finally { value.fill(0); }
  }

  /** 非敏感取值；敏感取值由 daemon 经 secret-provider 读取。 */
  plainConfig(name: string): Record<string, string> {
    const path = join(this.pluginsDir, CONFIG_FILE);
    if (!existsSync(path)) return {};
    return (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>)[name] ?? {};
  }
}

export const pluginSecretPrefix = (plugin: string) => `plugin.${plugin}.`;
export const pluginSecretKey = (plugin: string, key: string) => `${pluginSecretPrefix(plugin)}${key}`;

async function git(args: string[], cwd: string): Promise<string> {
  try { return (await run('git', args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout; }
  catch (error) { throw new PluginStoreError('PLUGIN_FETCH_FAILED', `git ${args[0]} 失败：${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`); }
}

/** 复制插件目录：不带 .git，符号链接原样保留（持久化前摘要校验拒绝包外链接）。 */
async function copyTree(from: string, to: string) {
  await cp(from, to, { recursive: true, verbatimSymlinks: true, filter: source => basename(source) !== '.git' });
}

async function extractTarball(tarballPath: string, root: string, work: string) {
  const extracted = join(work, 'extracted');
  await mkdir(extracted);
  await run('tar', ['-xzf', tarballPath, '-C', extracted], { timeout: 120_000 });
  const packageDir = join(extracted, 'package');
  await rename(existsSync(packageDir) ? packageDir : extracted, root);
}

async function stagePluginSource(source: PluginSource, parentDir = tmpdir()): Promise<Staged> {
  const work = await mkdtemp(join(parentDir, 'install-'));
  const cleanup = () => rm(work, { recursive: true, force: true });
  try {
    const root = join(work, 'plugin');
    let resolved: PluginLockEntry['resolved'] = {};
    if (source.kind === 'local') {
      if (!existsSync(source.spec)) throw new PluginStoreError('PLUGIN_SOURCE_MISSING', `目录不存在：${source.spec}`);
      const info = await stat(source.spec);
      if (info.isFile() && /\.(?:tgz|tar\.gz)$/i.test(source.spec)) await extractTarball(source.spec, root, work);
      else await copyTree(source.spec, root);
    } else if (source.kind === 'git') {
      const checkout = join(work, 'checkout');
      await git(['clone', '--quiet', source.spec, checkout], work);
      if (source.ref) await git(['checkout', '--quiet', source.ref], checkout);
      resolved = { sha: (await git(['rev-parse', 'HEAD'], checkout)).trim() };
      await copyTree(checkout, root);
    } else {
      // --ignore-scripts：git 来源的 npm 包会在打包时跑 prepare，信任确认之前不能执行插件代码。
      const packed = await run('npm', ['pack', source.spec, '--json', '--ignore-scripts', '--pack-destination', work], { cwd: work, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
        .catch(error => { throw new PluginStoreError('PLUGIN_FETCH_FAILED', `npm pack ${source.spec} 失败：${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`); });
      const info = (JSON.parse(packed.stdout) as Array<{ filename: string; version?: string }>)[0];
      if (!info) throw new PluginStoreError('PLUGIN_FETCH_FAILED', `npm pack ${source.spec} 没有产出包`);
      await extractTarball(join(work, basename(info.filename)), root, work);
      resolved = { ...(info.version ? { version: info.version } : {}) };
    }
    const plugin = await loadPluginDirectory(root);
    if (!resolved.version && plugin.manifest.version) resolved = { ...resolved, version: plugin.manifest.version };
    return { root, plugin, resolved, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** 支持对目录、独立 tarball 或远程来源执行只读操作；本地目录直接就地读取以保留原路径诊断。 */
export async function withPluginSourceRoot<T>(spec: string, cwd: string, action: (context: { root: string; source: PluginSource; resolved: PluginLockEntry['resolved'] }) => Promise<T>): Promise<T> {
  const candidatePath = resolve(cwd, spec);
  const info = await stat(candidatePath).catch(() => undefined);
  if (info?.isDirectory()) {
    return action({ root: candidatePath, source: { kind: 'local', spec: candidatePath }, resolved: {} });
  }
  const source = info?.isFile() && /\.(?:tgz|tar\.gz)$/i.test(candidatePath)
    ? { kind: 'local' as const, spec: candidatePath }
    : parsePluginSource(spec, cwd);
  const staged = await stagePluginSource(source, tmpdir());
  try {
    return await action({ root: staged.root, source, resolved: staged.resolved });
  } finally {
    await staged.cleanup();
  }
}

/** Content identity includes relative names, executable mode and symlink targets. */
export async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const canonicalRoot = await realpath(root);
  const inside = (path: string) => { const value = relative(canonicalRoot, path); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
  const visit = async (relative: string) => {
    const path = join(canonicalRoot, relative), info = await lstat(path);
    hash.update(JSON.stringify([relative, info.mode & 0o777, info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'link' : 'file']));
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(relative ? `${relative}/${name}` : name);
    else if (info.isSymbolicLink()) {
      const target = await readlink(path);
      let resolved: string;
      try { resolved = await realpath(path); }
      catch { throw new PluginStoreError('PLUGIN_ARTIFACT_INVALID', `插件符号链接 ${relative} 无法解析；不允许悬空或循环链接`); }
      if (isAbsolute(target) || !inside(resolve(dirname(path), target)) || !inside(resolved)) throw new PluginStoreError('PLUGIN_ARTIFACT_INVALID', `插件符号链接 ${relative} 必须是指向包内的相对链接`);
      hash.update(JSON.stringify(target));
    }
    else if (info.isFile()) hash.update(await readFile(path));
    else throw new PluginStoreError('PLUGIN_ARTIFACT_INVALID', '插件包只允许普通文件、目录和内部符号链接');
  };
  await visit(''); return hash.digest('hex');
}
