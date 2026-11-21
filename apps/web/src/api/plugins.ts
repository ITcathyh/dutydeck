import type { PluginBinding, PluginBindingScope, PluginConfigSchema, SavePluginBinding } from '@dutydeck/shared';
import { json, send } from './client';

export const pluginBindingsApi = {
  list: () => json<{ bindings: PluginBinding[]; packages: Array<{ name: string; version?: string; scope: string; apiVersion: number | string; configSchema: PluginConfigSchema; requiredSkills: string[]; legacyGlobal: string[]; capabilities?: string[]; permissions?: { secrets: string[]; network: string[]; filesystem: string[]; effects: string[] }; slots?: Array<{ id: string; slot: string; title: string; description?: string; elements: Array<Record<string, unknown>> }>; service?: { mode: string; status: { status: string } } }>; diagnostics: Array<{ plugin: string; message: string }> }>('/api/plugin-bindings'),
  save: (body: SavePluginBinding) => send<{ binding: PluginBinding }>('PUT', '/api/plugin-bindings', body),
  explain: (body: PluginBindingScope & { plugin: string }) => send<Record<string, unknown>>('POST', '/api/plugin-bindings/explain', body),
  slot: (plugin: string, slot: string) => json<{ plugin: string; slot: string; declarations: Array<{ id: string; slot: string; title: string; description?: string; elements: Array<Record<string, unknown>> }> }>(`/api/plugins/${encodeURIComponent(plugin)}/slots/${encodeURIComponent(slot)}`)
};

export const pluginRequests = {
  /** 已启用插件提供的斜杠命令；没有插件时服务端不注册这个接口，按空列表处理。 */
  pluginCommands: async (cwd?: string) => {
    try { return (await json<{ commands: Array<{ name: string; description: string }> }>(`/api/plugins/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)).commands; }
    catch { return []; }
  },
};
