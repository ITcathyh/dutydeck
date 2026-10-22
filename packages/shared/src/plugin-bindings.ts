import { z } from 'zod';

export { PLUGIN_API_VERSION } from '@dutydeck/plugin-sdk';
export type { PluginBindingContext } from '@dutydeck/plugin-sdk';
const key = z.string().regex(/^[a-z][a-z0-9_]*$/).max(64);
export const pluginSkillRefSchema = z.string().regex(/^[a-z][a-z0-9-]*\/[a-zA-Z0-9_-]+$/).max(160);
const scalar = z.union([z.string().max(16_000), z.number().finite(), z.boolean()]);
export const pluginConfigFieldSchema = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'string_list', 'secret']),
  description: z.string().min(1).max(1_000),
  required: z.boolean().optional(),
  default: z.union([scalar, z.array(z.string().max(4_000)).max(100)]).optional(),
  enum: z.array(scalar).min(1).max(100).optional(),
  min: z.number().finite().optional(), max: z.number().finite().optional()
}).strict().superRefine((field, ctx) => {
  if (field.type === 'secret' && (field.default !== undefined || field.enum)) ctx.addIssue({ code: 'custom', message: 'Secrets cannot declare defaults or enum values' });
  if (['boolean', 'secret'].includes(field.type) && (field.min !== undefined || field.max !== undefined)) ctx.addIssue({ code: 'custom', message: 'This type has no size or numeric range' });
  if (['string', 'string_list'].includes(field.type) && [field.min, field.max].some(value => value !== undefined && (!Number.isInteger(value) || value < 0))) ctx.addIssue({ code: 'custom', message: 'Length bounds must be nonnegative integers' });
  if (field.type === 'string_list' && field.enum) ctx.addIssue({ code: 'custom', message: 'List fields cannot declare scalar enum values' });
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) ctx.addIssue({ code: 'custom', message: 'min must not exceed max' });
});
export type PluginConfigField = z.infer<typeof pluginConfigFieldSchema>;
export const pluginConfigSchema = z.record(key, pluginConfigFieldSchema);
export type PluginConfigSchema = z.infer<typeof pluginConfigSchema>;

export function pluginConfigValueSchema(field: PluginConfigField): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (field.type) {
    case 'string': schema = z.string().max(field.max ?? 16_000).min(field.min ?? 0); break;
    case 'number': case 'integer': {
      let number = field.type === 'integer' ? z.number().int() : z.number().finite();
      if (field.min !== undefined) number = number.min(field.min);
      if (field.max !== undefined) number = number.max(field.max);
      schema = number; break;
    }
    case 'boolean': schema = z.boolean(); break;
    case 'string_list': schema = z.array(z.string().max(4_000)).min(field.min ?? 0).max(field.max ?? 100); break;
    case 'secret': schema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/); break;
  }
  return field.enum ? schema.refine(value => field.enum!.includes(value), 'Value is not in the declared enum') : schema;
}

export function resolvePluginConfig(schema: PluginConfigSchema, config: Readonly<Record<string, unknown>>, secrets: Readonly<Record<string, string>> = {}) {
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(config)) if (!schema[name] || schema[name]!.type === 'secret') throw new Error(`Unknown or secret configuration key: ${name}`);
  for (const name of Object.keys(secrets)) if (schema[name]?.type !== 'secret') throw new Error(`Undeclared secret key: ${name}`);
  for (const [name, field] of Object.entries(schema)) {
    const value = field.type === 'secret' ? secrets[name] : (config[name] === undefined ? field.default : config[name]);
    if (value === undefined) { if (field.required) throw new Error(`Required configuration missing: ${name}`); continue; }
    const parsed = pluginConfigValueSchema(field).safeParse(value);
    if (!parsed.success) throw new Error(`Invalid configuration ${name}: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
    if (field.type !== 'secret') result[name] = parsed.data;
  }
  return result;
}

const pluginBindingInputObject = z.object({
  plugin: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64),
  botAppId: z.string().min(1).max(128).optional(), workspaceRoot: z.string().min(1).max(4096).optional(), chatId: z.string().min(1).max(128).optional(),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
  secrets: z.record(key, z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)).default({}),
  skills: z.array(pluginSkillRefSchema).max(16).default([])
}).strict();
const bindingTarget = (value: { botAppId?: string; chatId?: string; workspaceRoot?: string }, context: z.RefinementCtx) => {
  if (Boolean(value.botAppId) === Boolean(value.workspaceRoot) || value.chatId && !value.botAppId) context.addIssue({ code: 'custom', message: 'Choose a Bot/group or workspace target, not both' });
};
export const pluginBindingInputSchema = pluginBindingInputObject.superRefine(bindingTarget);
export type PluginBindingInput = z.infer<typeof pluginBindingInputSchema>;
export const pluginBindingSchema = pluginBindingInputObject.extend({ id: z.string().min(1).max(128), revision: z.number().int().positive() }).superRefine(bindingTarget);
export type PluginBinding = z.infer<typeof pluginBindingSchema>;
export const savePluginBindingSchema = pluginBindingInputObject.extend({ expectedRevision: z.number().int().nonnegative() }).superRefine(bindingTarget);
export type SavePluginBinding = z.infer<typeof savePluginBindingSchema>;

export interface PluginBindingScope { botAppId?: string; chatId?: string; cwd?: string }

export const pluginTextResourceSchema = z.object({
  path: z.string().min(1).max(512).refine(value => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'), 'Resources must be inside the package'),
  maxBytes: z.number().int().min(1).max(64 * 1024).default(16 * 1024)
}).strict();
