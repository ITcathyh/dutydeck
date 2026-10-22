import type { Command } from 'commander';
import { executeLocalRuntimeRequest } from '../local-runtime-request.js';

export function registerBusinessToolCli(program: Command) {
  const root = program.command('tool').description('Call authorized plugin business tools from the current task');
  const request = async (path: string, turn: string, body?: unknown) => {
    const url = process.env.dutydeck_relay_url;
    const token = process.env.dutydeck_relay_token;
    if (!url || !token) throw new Error('PLUGIN_TOOL_CONTEXT_REQUIRED');
    const response = await fetch(`${url.replace(/\/api\/relay\/?$/, '')}/api/plugin-tools/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'x-dutydeck-tool-turn': turn, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as { error?: { code?: string } };
    if (!response.ok) throw new Error(value.error?.code ?? 'PLUGIN_TOOL_UNAVAILABLE');
    process.stdout.write(JSON.stringify(value) + '\n');
  };
  root.command('list').requiredOption('--turn <token>', 'Current task attempt token').action(options => request('list', options.turn));
  root.command('call <tool>').requiredOption('--turn <token>', 'Current task attempt token').requiredOption('--call-id <id>', 'Stable invocation ID for retries').requiredOption('--json <input>', 'JSON tool input').action((tool, options) => request('call', options.turn, { tool, input: JSON.parse(options.json), callId: options.callId }));
  root.command('reconcile <action-id>').requiredOption('--turn <token>', 'Current task attempt token').action((actionId, options) => request('reconcile', options.turn, { actionId }));
  const grants = program.command('tool-grant').description('Manage explicit business-tool permissions as installation owner');
  const target = (command: Command) => command.option('--url <url>', 'Runtime URL').option('--database <path>', 'Runtime database for target discovery');
  const manage = async (method: 'GET' | 'PUT' | 'DELETE', path: string, options: { url?: string; database?: string }, body?: unknown) => {
    const result = await executeLocalRuntimeRequest({ method, endpoint: path, url: options.url, database: options.database, errorSpec: { databaseRequired: 'PLUGIN_TOOL_DATABASE_REQUIRED', daemonUnavailable: 'PLUGIN_TOOL_DAEMON_UNAVAILABLE', localRuntimeRequired: 'PLUGIN_TOOL_LOCAL_RUNTIME_REQUIRED', requestFailed: 'PLUGIN_TOOL_REQUEST_FAILED' }, createError: (code, message) => new Error(`${code}: ${message}`), ...(body === undefined ? {} : { body }) });
    process.stdout.write(JSON.stringify(result) + '\n');
  };
  target(grants.command('list')).action(options => manage('GET', '/api/plugins/tool-grants', options));
  target(grants.command('set').requiredOption('--json <grant>', 'Grant JSON: id, toolId, bindingId, actor, effects, resources, operations')).action(options => manage('PUT', '/api/plugins/tool-grants', options, JSON.parse(options.json)));
  target(grants.command('revoke <id>')).action((id, options) => manage('DELETE', `/api/plugins/tool-grants/${encodeURIComponent(id)}`, options));
}
