import type { PluginResultTool } from '@dutydeck/shared';
import { scopeApplies, type PluginScopeContext } from './scope.js';
export class PluginResultToolRegistry {
  private readonly entries = new Map<string, { plugin: string; scope: string; tool: PluginResultTool }>();
  register(plugin: string, scope: string, tool: PluginResultTool) {
    if (!tool || !/^[a-z][a-z0-9_-]{0,63}$/.test(tool.name) || typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 1000 || typeof tool.inputSchema?.parse !== 'function' || typeof tool.execute !== 'function') throw new Error('RESULT_TOOL_INVALID');
    const id = `${plugin}/${tool.name}`;
    if (this.entries.has(id)) throw new Error('RESULT_TOOL_DUPLICATE');
    this.entries.set(id, { plugin, scope, tool });
  }
  get(id: string, context: PluginScopeContext) { const entry = this.entries.get(id); return entry && scopeApplies(entry.scope, context) ? entry : undefined; }
  list(context: PluginScopeContext) { return [...this.entries.entries()].filter(([, entry]) => scopeApplies(entry.scope, context)).map(([id, entry]) => ({ id, description: entry.tool.description })); }
  listForPlugin(plugin: string) { return [...this.entries.entries()].filter(([, entry]) => entry.plugin === plugin).map(([id, entry]) => ({ id, name: entry.tool.name, scope: entry.scope, description: entry.tool.description })); }
}
