import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const timestamps = { createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull() };
export const agentConfigs = sqliteTable('agent_configs', { id: text('id').primaryKey(), json: text('json').notNull(), ...timestamps });
export const machines = sqliteTable('machines', { id: text('id').primaryKey(), name: text('name').notNull(), metadata: text('metadata'), ...timestamps });
export const projects = sqliteTable('projects', { id: text('id').primaryKey(), machineId: text('machine_id'), name: text('name').notNull(), cwd: text('cwd').notNull(), ...timestamps });
export const sessions = sqliteTable('sessions', { id: text('id').primaryKey(), agentId: text('agent_id').notNull(), state: text('state').notNull(), cwd: text('cwd').notNull(), model: text('model'), reasoningEffort: text('reasoning_effort'), systemPrompt: text('system_prompt'), permissionMode: text('permission_mode').default('ask'), source: text('source'), sourceId: text('source_id'), archivedAt: text('archived_at'), protocol: text('protocol'), runId: text('run_id').notNull(), error: text('error'), ...timestamps });
export const tasks = sqliteTable('tasks', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), prompt: text('prompt').notNull(), status: text('status').notNull(), executionContext: text('execution_context'), ...timestamps });
export const events = sqliteTable('events', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), sequence: integer('sequence').notNull(), type: text('type').notNull(), timestamp: text('timestamp').notNull(), data: text('data').notNull(), raw: text('raw') });
export const toolCalls = sqliteTable('tool_calls', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), data: text('data').notNull(), ...timestamps });
export const permissionRequests = sqliteTable('permission_requests', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), status: text('status').notNull(), data: text('data').notNull(), ...timestamps });
export const errors = sqliteTable('errors', { id: text('id').primaryKey(), sessionId: text('session_id').notNull(), message: text('message').notNull(), details: text('details'), createdAt: text('created_at').notNull() });
export const channelMappings = sqliteTable('channel_mappings', { id: text('id').primaryKey(), channel: text('channel').notNull(), externalId: text('external_id').notNull(), sessionId: text('session_id').notNull(), extra: text('extra'), createdAt: text('created_at').notNull() });
export const configs = sqliteTable('configs', { key: text('key').primaryKey(), value: text('value').notNull() });
