import { canonicalExecutionJson, RuntimeError, type PluginAction, type PluginQuery, type PluginToolSchema } from '@dutydeck/shared';
import { scopeApplies, type PluginScopeContext } from './scope.js';

const allowedKeys = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']);
export function validateToolSchema(schema: PluginToolSchema, depth = 0): void {
  if (!schema || depth > 8 || !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(schema.type) || Object.keys(schema).some(key => !allowedKeys.has(key))) throw new Error('PLUGIN_TOOL_SCHEMA_INVALID');
  const exclusive = { properties: ['object'], required: ['object'], additionalProperties: ['object'], items: ['array'], minItems: ['array'], maxItems: ['array'], minLength: ['string'], maxLength: ['string'], minimum: ['number', 'integer'], maximum: ['number', 'integer'] };
  for (const [key, types] of Object.entries(exclusive)) if (Object.hasOwn(schema, key) && !types.includes(schema.type)) throw new Error('PLUGIN_TOOL_SCHEMA_INVALID');
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) throw new Error('PLUGIN_TOOL_SCHEMA_INVALID');
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some(value => !['string', 'number', 'boolean'].includes(typeof value)))) throw new Error('PLUGIN_TOOL_SCHEMA_INVALID');
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false || !schema.properties || Object.keys(schema.properties).length > 100) throw new Error('PLUGIN_TOOL_SCHEMA_INVALID');
    for (const child of Object.values(schema.properties)) validateToolSchema(child, depth + 1);
    if (schema.required?.some(key => !Object.hasOwn(schema.properties!, key))) throw new Error('PLUGIN_TOOL_SCHEMA_INVALID');
  } else if (schema.type === 'array') {
    if (!schema.items) throw new Error('PLUGIN_TOOL_SCHEMA_INVALID');
    validateToolSchema(schema.items, depth + 1);
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'] as const) {
    if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || ((key.includes('Length') || key.includes('Items')) && (!Number.isSafeInteger(schema[key]) || schema[key]! < 0)))) throw new Error('PLUGIN_TOOL_SCHEMA_INVALID');
  }
  canonicalExecutionJson(schema);
}
export function validateToolInput(schema: PluginToolSchema, input: unknown, depth = 0): void {
  const invalid = () => { throw new RuntimeError('PLUGIN_TOOL_INVALID_INPUT', 'Arguments do not match the tool schema', 400); };
  if (depth > 8) invalid();
  if (schema.enum && !schema.enum.some(value => value === input)) invalid();
  switch (schema.type) {
    case 'object': {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
      const object = input as Record<string, unknown>;
      if (Object.keys(object).some(key => !Object.hasOwn(schema.properties!, key)) || schema.required?.some(key => !Object.hasOwn(object, key))) invalid();
      for (const [key, value] of Object.entries(object)) validateToolInput(schema.properties![key]!, value, depth + 1);
      break;
    }
    case 'array':
      if (!Array.isArray(input) || input.length < (schema.minItems ?? 0) || input.length > (schema.maxItems ?? 1000)) return invalid();
      for (const item of input) validateToolInput(schema.items!, item, depth + 1);
      break;
    case 'string':
      if (typeof input !== 'string' || input.length < (schema.minLength ?? 0) || input.length > (schema.maxLength ?? 16000)) invalid();
      break;
    case 'number': case 'integer':
      if (typeof input !== 'number' || !Number.isFinite(input) || (schema.type === 'integer' && !Number.isSafeInteger(input)) || input < (schema.minimum ?? -Infinity) || input > (schema.maximum ?? Infinity)) invalid();
      break;
    case 'boolean': if (typeof input !== 'boolean') invalid();
  }
}
export type BusinessToolEntry = { plugin: string; scope: string; packageVersion: string; kind: 'query'; effect: 'read'; tool: PluginQuery }
  | { plugin: string; scope: string; packageVersion: string; kind: 'action'; effect: 'write'; tool: PluginAction };
export class PluginBusinessToolRegistry {
  private readonly entries = new Map<string, BusinessToolEntry>();
  register(plugin: string, scope: string, packageVersion: string, kind: 'query' | 'action', tool: PluginQuery | PluginAction) {
    if (!tool || !/^[a-z][a-z0-9_-]{0,63}$/.test(tool.name) || !tool.description?.trim() || tool.description.length > 1000 || !tool.version?.trim() || tool.version.length > 64 || typeof tool.execute !== 'function' || typeof tool.resource !== 'function' || tool.inputSchema?.type !== 'object') throw new Error('PLUGIN_TOOL_INVALID');
    validateToolSchema(tool.inputSchema);
    const id = `${plugin}/${tool.name}`;
    if (this.entries.has(id)) throw new Error('PLUGIN_TOOL_DUPLICATE');
    this.entries.set(id, { plugin, scope, packageVersion, kind, effect: kind === 'query' ? 'read' : 'write', tool } as BusinessToolEntry);
  }
  get(id: string, context: PluginScopeContext) {
    const entry = this.entries.get(id);
    return entry && scopeApplies(entry.scope, context) ? entry : undefined;
  }
  list(context: PluginScopeContext) { return [...this.entries].filter(([, entry]) => scopeApplies(entry.scope, context)); }
}
