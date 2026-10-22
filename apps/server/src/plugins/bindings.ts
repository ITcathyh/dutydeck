import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { RuntimeError, pluginBindingSchema, savePluginBindingSchema, resolvePluginConfig, type PluginBinding, type PluginBindingContext, type PluginBindingScope, type PluginManifest, type SavePluginBinding } from '@dutydeck/shared';

const fileSchema = z.object({ version: z.literal(1), bindings: z.array(pluginBindingSchema) }).strict();
export const pluginBindingId = (plugin: string, botAppId?: string, chatId?: string, workspaceRoot?: string) => `binding_${createHash('sha256').update(JSON.stringify([plugin, botAppId ?? null, chatId ?? null, workspaceRoot ?? null])).digest('hex').slice(0, 32)}`;
const frozen = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };

/** Separate from package artifacts: optimistic revision checks and a cross-process write lock. */
export class PluginBindings {
  private readonly directory: string;
  private readonly path: string;
  constructor(dataDir: string, private readonly readSecret: (reference: string) => string | undefined) {
    this.directory = join(dataDir, 'plugins'); this.path = join(this.directory, 'bindings.json');
  }
  list(): PluginBinding[] {
    if (!existsSync(this.path)) return [];
    return fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))).bindings;
  }
  get(id: string) { return this.list().find(binding => binding.id === id); }
  select(plugin: string, scope: PluginBindingScope): PluginBinding | undefined {
    if (!scope.botAppId) {
      if (!scope.cwd) return undefined;
      let root: string;
      try { root = realpathSync(scope.cwd); } catch { return undefined; }
      return this.list().find(binding => binding.plugin === plugin && binding.workspaceRoot === root);
    }
    const candidates = this.list().filter(binding => binding.plugin === plugin && binding.botAppId === scope.botAppId);
    return (scope.chatId ? candidates.find(binding => binding.chatId === scope.chatId) : undefined) ?? candidates.find(binding => !binding.chatId);
  }
  save(input: SavePluginBinding, manifest?: PluginManifest): PluginBinding {
    const parsed = savePluginBindingSchema.parse(input);
    if (parsed.workspaceRoot) {
      if (!isAbsolute(parsed.workspaceRoot)) throw new RuntimeError('PLUGIN_BINDING_INVALID', 'Workspace must be an absolute existing directory', 400);
      try { parsed.workspaceRoot = realpathSync(parsed.workspaceRoot); } catch { throw new RuntimeError('PLUGIN_BINDING_INVALID', 'Workspace must be an absolute existing directory', 400); }
    }
    if (manifest && parsed.plugin !== manifest.name) throw new RuntimeError('PLUGIN_BINDING_INVALID', 'Binding package does not match manifest', 400);
    if (parsed.enabled) {
      if (!manifest) throw new RuntimeError('PLUGIN_UNAVAILABLE', 'Activate or repair the package before enabling its binding', 409);
      try { resolvePluginConfig(manifest.bindingConfig ?? {}, parsed.config, parsed.secrets); }
      catch (error) { throw new RuntimeError('PLUGIN_BINDING_INVALID', (error as Error).message, 400); }
      for (const reference of Object.values(parsed.secrets)) if (!reference.startsWith(`plugin.${parsed.plugin}.`)) throw new RuntimeError('PLUGIN_SECRET_NAMESPACE', 'Create this package credential with settings plugin-binding secret-set', 400);
      for (const [key, ref] of Object.entries(parsed.secrets)) if (this.readSecret(ref) === undefined) throw new RuntimeError('PLUGIN_SECRET_MISSING', `Secret reference for ${key} is unavailable`, 400);
    }
    mkdirSync(this.directory, { recursive: true });
    // SQLite's process lock is released by the kernel after a crash; no stale O_EXCL sentinel.
    const lock = new Database(join(this.directory, '.binding-lock.sqlite'), { timeout: 0 });
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}`;
    try {
      try { lock.exec('BEGIN IMMEDIATE'); } catch (error) { if ((error as {code?:string}).code === 'SQLITE_BUSY') throw new RuntimeError('PLUGIN_BINDING_BUSY', 'Another binding update is in progress; retry', 409); throw error; }
      const bindings = this.list();
      const id = pluginBindingId(parsed.plugin, parsed.botAppId, parsed.chatId, parsed.workspaceRoot);
      const previous = bindings.find(binding => binding.id === id);
      if (!parsed.enabled && (!previous || !isDeepStrictEqual([parsed.config, parsed.secrets, parsed.skills], [previous.config, previous.secrets, previous.skills]))) throw new RuntimeError('PLUGIN_BINDING_INVALID', 'Disabling requires an existing exact target and unchanged configuration, secrets and skills', 400);
      if ((previous?.revision ?? 0) !== parsed.expectedRevision) throw new RuntimeError('PLUGIN_BINDING_CONFLICT', 'Binding changed; reload before saving', 409);
      const { expectedRevision, ...values } = parsed;
      const binding = { ...values, id, revision: expectedRevision + 1 };
      writeFileSync(temporary, JSON.stringify({ version: 1, bindings: [...bindings.filter(item => item.id !== id), binding] }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.path);
      return binding;
    } finally { lock.close(); if (existsSync(temporary)) unlinkSync(temporary); }
  }
  resolve(plugin: string, scope: PluginBindingScope, manifest: PluginManifest): PluginBindingContext | undefined {
    const binding = this.select(plugin, scope);
    if (!binding) return undefined;
    if (!binding.enabled) throw new RuntimeError('PLUGIN_BINDING_DISABLED', `Binding ${binding.id} is disabled`, 403);
    let config: Record<string, unknown>;
    try { config = resolvePluginConfig(manifest.bindingConfig ?? {}, binding.config, binding.secrets); }
    catch (error) { throw new RuntimeError('PLUGIN_BINDING_INVALID', (error as Error).message, 409); }
    for (const [key, reference] of Object.entries(binding.secrets)) {
      if (!reference.startsWith(`plugin.${plugin}.`)) throw new RuntimeError('PLUGIN_SECRET_NAMESPACE', 'Secret reference does not belong to this package', 403);
      if (this.readSecret(reference) === undefined) throw new RuntimeError('PLUGIN_SECRET_MISSING', `Create the missing ${key} credential with settings plugin-binding secret-set and update the binding reference`, 409);
    }
    return Object.freeze({ bindingId: binding.id, revision: binding.revision, plugin, config: frozen(config),
      getSecret: async (key: string) => {
        const current = this.select(plugin, scope);
        if (!current?.enabled || current.id !== binding.id || current.revision !== binding.revision) throw new RuntimeError('PLUGIN_BINDING_STALE', 'Binding changed or was revoked; resolve it again', 409);
        if (manifest.bindingConfig?.[key]?.type !== 'secret') throw new RuntimeError('PLUGIN_SECRET_UNDECLARED', 'Secret key is not declared', 403);
        const ref = binding.secrets[key];
        const value = ref ? this.readSecret(ref) : undefined;
        if (ref && value === undefined) throw new RuntimeError('PLUGIN_SECRET_MISSING', 'Referenced secret is unavailable', 409);
        return value;
      }
    });
  }
}
