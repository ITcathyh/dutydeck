import { canonicalExecutionJson, pluginToolGrantSchema, RuntimeError, type ConfigRepository, type PluginToolGrant, type PluginToolIdentity } from '@dutydeck/shared';
export const pluginToolGrantPrefix = 'plugin.tools.grant.';
export class PluginToolGrants {
  constructor(private readonly config: ConfigRepository) {}
  async list(): Promise<PluginToolGrant[]> { return (await this.config.list?.(pluginToolGrantPrefix) ?? []).map(row => pluginToolGrantSchema.parse(JSON.parse(row.value))); }
  async set(input: unknown) { const grant = pluginToolGrantSchema.parse(input); await this.config.set(pluginToolGrantPrefix + grant.id, JSON.stringify(grant)); return grant; }
  async revoke(id: string) {
    const raw = await this.config.get(pluginToolGrantPrefix + id);
    if (!raw) throw new RuntimeError('PLUGIN_TOOL_GRANT_NOT_FOUND', 'Grant not found', 404);
    return this.set({ ...JSON.parse(raw), enabled: false });
  }
  async permits(identity: Pick<PluginToolIdentity, 'actor'>, toolId: string, bindingId: string, effect: 'read' | 'write', operation: 'invoke' | 'reconcile', resource?: string) {
    return (await this.list()).some(grant => grant.enabled && grant.toolId === toolId && grant.bindingId === bindingId && canonicalExecutionJson(grant.actor) === canonicalExecutionJson(identity.actor) && grant.effects.includes(effect) && grant.operations.includes(operation) && (resource === undefined || grant.resources.includes('*') || grant.resources.includes(resource)));
  }
  async assert(identity: Pick<PluginToolIdentity, 'actor'>, toolId: string, bindingId: string, effect: 'read' | 'write', operation: 'invoke' | 'reconcile', resource: string) {
    if (!await this.permits(identity, toolId, bindingId, effect, operation, resource)) throw new RuntimeError('PLUGIN_TOOL_FORBIDDEN', 'Tool, binding, actor, effect or resource is not authorized', 403);
  }
}
