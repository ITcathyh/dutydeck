import { z } from 'zod';
import { prepareSkillPrompt } from '../skill-delivery.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RuntimeError, savePluginBindingSchema, type PluginBindingScope, pluginWebSlotKinds } from '@dutydeck/shared';
import type { PluginHost } from './host.js';
import { pluginDeclaredCapabilities, pluginPermissionFootprint } from './manifest.js';
import { hasPluginTaskCredentials } from './management-auth.js';
import { scopeApplies } from './scope.js';

export interface PluginBindingRoutes {
  host: PluginHost;
  authorize(request: FastifyRequest): Promise<boolean>;
}
export function registerPluginBindingRoutes(app: FastifyInstance, options?: PluginBindingRoutes) {
  const authorized = async (request: FastifyRequest) => {
    if (!options || hasPluginTaskCredentials(request) || !await options.authorize(request)) throw new RuntimeError('PLUGIN_BINDING_FORBIDDEN', 'Installation administrator access is required', 403);
    return options.host;
  };
  app.get('/api/plugin-bindings', async request => {
    const host = await authorized(request);
    const query = z.union([z.object({}).strict(), z.object({ plugin: z.string().min(1), workspaceRoot: z.string().min(1) }).strict()]).safeParse(request.query);
    if (!query.success) throw new RuntimeError('PLUGIN_BINDING_INVALID', 'Workspace lookup requires a package and workspaceRoot', 400);
    // Management lookup also returns disabled bindings; resolution for invocation would reject them.
    const selection = 'workspaceRoot' in query.data ? { selected: host.bindings.select(query.data.plugin, { cwd: query.data.workspaceRoot }) ?? null } : {};
    return { ...selection, bindings: host.bindings.list(), packages: host.active.map(({ entry, plugin }) => { const tools = host.businessTools.listForPlugin(entry.name); return { name: entry.name, version: plugin.manifest.version, scope: entry.scope,
      apiVersion: plugin.manifest.apiVersion ?? 'legacy', configSchema: plugin.manifest.bindingConfig ?? {}, requiredSkills: plugin.manifest.requiredSkills ?? [],
      legacyGlobal: [...(plugin.agents.length ? ['agents'] : []), ...(host.ciProviders.list().some(item => item.plugin === entry.name) ? ['ci'] : [])],
      capabilities: pluginDeclaredCapabilities(plugin, tools.map(tool => ({ kind: tool.kind })), host.resultTools.listForPlugin(entry.name).length > 0, host.ciProviders.list().some(item => item.plugin === entry.name)), permissions: pluginPermissionFootprint(plugin.manifest, tools.map(tool => ({ effect: tool.effect }))), slots: host.slotsForPlugin(entry.name),
      service: plugin.service ? { mode: plugin.service.spec.mode, status: host.services.status(entry.name) } : undefined }; } ), diagnostics: host.diagnostics };
  });
  app.get('/api/plugins', async request => {
    const host = await authorized(request);
    return { plugins: host.active.map(({ entry, plugin, builtin }) => { const tools = host.businessTools.listForPlugin(entry.name); return {
      name: entry.name, version: plugin.manifest.version, scope: entry.scope, builtin,
      enabled: builtin || host.store.get(entry.name).enabled,
      capabilities: pluginDeclaredCapabilities(plugin, tools.map(tool => ({ kind: tool.kind })), host.resultTools.listForPlugin(entry.name).length > 0, host.ciProviders.list().some(item => item.plugin === entry.name)),
      permissions: pluginPermissionFootprint(plugin.manifest, tools.map(tool => ({ effect: tool.effect }))),
      slots: host.slotsForPlugin(entry.name),
      service: plugin.service ? { mode: plugin.service.spec.mode, status: host.services.status(entry.name) } : undefined,
      diagnostics: host.diagnostics.filter(item => item.plugin === entry.name)
    }; }) };
  });
  app.get<{ Params: { plugin: string } }>('/api/plugins/:plugin/capabilities', async request => {
    const host = await authorized(request);
    const active = host.active.find(item => item.entry.name === request.params.plugin);
    if (!active) throw new RuntimeError('PLUGIN_UNAVAILABLE', 'Plugin is not active in this scope', 404);
    const tools = host.businessTools.listForPlugin(active.entry.name);
    return { plugin: active.entry.name, capabilities: pluginDeclaredCapabilities(active.plugin, tools.map(tool => ({ kind: tool.kind })), host.resultTools.listForPlugin(active.entry.name).length > 0, host.ciProviders.list().some(item => item.plugin === active.entry.name)), permissions: pluginPermissionFootprint(active.plugin.manifest, tools.map(tool => ({ effect: tool.effect }))), slots: host.slotsForPlugin(active.entry.name) };
  });
  app.get<{ Params: { plugin: string } }>('/api/plugins/:plugin/diagnostics', async request => {
    const host = await authorized(request);
    return { plugin: request.params.plugin, diagnostics: host.diagnostics.filter(item => item.plugin === request.params.plugin) };
  });
  app.get<{ Params: { plugin: string; slot: string } }>('/api/plugins/:plugin/slots/:slot', async request => {
    const host = await authorized(request);
    const slot = z.enum(pluginWebSlotKinds).safeParse(request.params.slot);
    if (!slot.success) throw new RuntimeError('PLUGIN_SLOT_INVALID', 'Unknown plugin Web slot', 400);
    if (!host.active.some(item => item.entry.name === request.params.plugin)) throw new RuntimeError('PLUGIN_UNAVAILABLE', 'Plugin is not active in this scope', 404);
    return { plugin: request.params.plugin, slot: slot.data, declarations: host.slotsForPlugin(request.params.plugin, slot.data) };
  });
  app.get<{ Params: { plugin: string } }>('/api/plugins/:plugin/service', async request => {
    const host = await authorized(request);
    const active = host.active.find(item => item.entry.name === request.params.plugin);
    if (!active?.plugin.service) throw new RuntimeError('PLUGIN_SERVICE_NOT_FOUND', 'Plugin has no service entrypoint', 404);
    return host.services.status(request.params.plugin);
  });
  app.post<{ Params: { plugin: string; action: 'start' | 'stop' | 'restart' } }>('/api/plugins/:plugin/service/:action', async request => {
    const host = await authorized(request);
    const active = host.active.find(item => item.entry.name === request.params.plugin);
    if (!active?.plugin.service) throw new RuntimeError('PLUGIN_SERVICE_NOT_FOUND', 'Plugin has no service entrypoint', 404);
    if (request.params.action === 'start') return host.services.start(request.params.plugin);
    if (request.params.action === 'stop') return host.services.stop(request.params.plugin);
    return host.services.restart(request.params.plugin);
  });
  app.put('/api/plugin-bindings', async request => {
    const host = await authorized(request);
    const parsed = savePluginBindingSchema.safeParse(request.body);
    if (!parsed.success) throw new RuntimeError('PLUGIN_BINDING_INVALID', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), 400);
    const active = host.active.find(item => item.entry.name === parsed.data.plugin);
    if (!active && parsed.data.enabled) throw new RuntimeError('PLUGIN_UNAVAILABLE', 'Package must be activated before binding', 409);
    if (parsed.data.enabled && active && !scopeApplies(active.entry.scope, { botAppId: parsed.data.botAppId, cwd: parsed.data.workspaceRoot })) throw new RuntimeError('PLUGIN_BINDING_SCOPE', 'Binding cannot expand installation scope', 403);
    if (parsed.data.enabled && active) await prepareSkillPrompt(parsed.data.workspaceRoot ?? process.cwd(), '', [], { botAppId: parsed.data.botAppId, chatId: parsed.data.chatId, pluginRoots: [
      ...host.skillEntries({ workspaceRoot: parsed.data.workspaceRoot ?? process.cwd(), botAppId: parsed.data.botAppId, chatId: parsed.data.chatId }).filter(item => item.plugin !== parsed.data.plugin),
      ...(active.plugin.skillsDir ? [{ path: active.plugin.skillsDir, plugin: active.entry.name, root: active.plugin.root, resources: active.plugin.manifest.skillResources }] : [])
    ], requiredSkills: [...(active.plugin.manifest.requiredSkills ?? []), ...parsed.data.skills].map(ref => ({ ref })) });
    return { binding: host.bindings.save(parsed.data, active?.plugin.manifest) };
  });
  app.post<{ Body: PluginBindingScope & { plugin: string } }>('/api/plugin-bindings/explain', async request => {
    const host = await authorized(request);
    const checked = z.object({ plugin: z.string().min(1), botAppId: z.string().min(1).optional(), chatId: z.string().min(1).optional(), cwd: z.string().min(1).optional() }).strict().safeParse(request.body);
    if (!checked.success) throw new RuntimeError('PLUGIN_BINDING_INVALID', 'Provide a package and valid Bot/group or workspace target', 400);
    const { plugin, ...scope } = checked.data;
    if (typeof plugin !== 'string') throw new RuntimeError('PLUGIN_BINDING_INVALID', 'Package name is required', 400);
    const selected = host.bindings.select(plugin, scope);
    const binding = await host.resolveBinding(plugin, scope);
    const skills = (await host.requiredSkillRequests(scope)).filter(item => item.binding.id === binding?.bindingId);
    return { plugin, binding: binding ? { id: binding.bindingId, revision: binding.revision, config: binding.config, secretKeys: Object.keys(selected?.secrets ?? {}) } : null,
      skills, delivery: 'host-inline', legacy: !binding };
  });
}
