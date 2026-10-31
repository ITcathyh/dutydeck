import type { PluginQuery as TaskPluginQuery, PluginChatQuery } from '@dutydeck/plugin-sdk';
export type PluginQuery = TaskPluginQuery | PluginChatQuery;
import { z } from 'zod';
export type { PluginToolSchema, PluginToolBinding, PluginToolIdentity, PluginCommandIdentity, PluginToolContext, PluginAction, PluginToolAction } from '@dutydeck/plugin-sdk';

export const pluginToolActionPrefix = 'plugin.tools.action.';
export const pluginToolGrantSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  toolId: z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9_-]*$/),
  bindingId: z.string().min(1).max(128),
  actor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('installation_owner'), id: z.literal('installation_owner') }).strict(),
    z.object({ kind: z.literal('channel'), id: z.string().min(1), appId: z.string().min(1) }).strict()
  ]),
  effects: z.array(z.enum(['read', 'write'])).min(1),
  resources: z.array(z.string().min(1).max(1000)).min(1).max(100),
  operations: z.array(z.enum(['invoke', 'reconcile'])).min(1),
  enabled: z.boolean().default(true)
}).strict();
export type PluginToolGrant = z.infer<typeof pluginToolGrantSchema>;
