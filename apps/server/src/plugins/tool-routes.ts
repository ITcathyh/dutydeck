import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import { z } from 'zod';
import { relayBearerToken } from '@dutydeck/relay';
import type { PluginBusinessToolService } from './tool-service.js';
import { hasPluginTaskCredentials } from './management-auth.js';
import type { PluginToolGrants } from './tool-grants.js';

export interface PluginBusinessToolRoutes { service: PluginBusinessToolService; grants: PluginToolGrants; origin: string; authorize(request: FastifyRequest): Promise<boolean> }
const callSchema = z.object({ tool: z.string().min(1), input: z.unknown(), callId: z.string().min(1) }).strict();
const reconcileSchema = z.object({ actionId: z.string().regex(/^pt_[a-f0-9]{64}$/) }).strict();
const credentials = (request: FastifyRequest) => [relayBearerToken(request.headers.authorization), typeof request.headers['x-dutydeck-tool-turn'] === 'string' ? request.headers['x-dutydeck-tool-turn'] : undefined] as const;
const safeError = (error: unknown) => error instanceof RuntimeError && error.code.startsWith('PLUGIN_TOOL_') ? { code: error.code, status: error.statusCode } : { code: 'PLUGIN_TOOL_UNAVAILABLE', status: 503 };
export function registerPluginBusinessToolRoutes(app: FastifyInstance, options: PluginBusinessToolRoutes) {
  const handle = (work: (request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    try { return await work(request); } catch (error) { const e = error instanceof z.ZodError ? { code: 'PLUGIN_TOOL_INVALID_INPUT', status: 400 } : safeError(error); return reply.code(e.status).send({ error: { code: e.code } }); }
  };
  app.get('/api/plugin-tools/list', { logLevel: 'silent' }, handle(request => options.service.list(...credentials(request))));
  app.get('/api/plugin-tools/summary', { logLevel: 'silent' }, handle(request => options.service.summary(...credentials(request))));
  app.get('/api/plugin-tools/describe', { logLevel: 'silent' }, handle(request => options.service.describe(z.object({ tool: z.string().min(1).max(129) }).strict().parse(request.query).tool, ...credentials(request))));
  app.get('/api/plugin-tools/manual', { logLevel: 'silent' }, handle(request => { const query = z.object({ tool: z.string().min(1).max(129), id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }).strict().parse(request.query); return options.service.manual(query.tool, query.id, ...credentials(request)); }));
  app.get('/api/plugin-tools/revision', { logLevel: 'silent' }, handle(async request => {
    const listed = await options.service.list(...credentials(request));
    return { revision: listed.revision, registryRevision: listed.registryRevision, toolCount: listed.tools.length };
  }));
  app.post('/api/plugin-tools/call', { logLevel: 'silent' }, handle(request => { const body = callSchema.parse(request.body); return options.service.call(body.tool, body.input, body.callId, ...credentials(request)); }));
  app.post('/api/plugin-tools/reconcile', { logLevel: 'silent' }, handle(request => options.service.reconcile(reconcileSchema.parse(request.body).actionId, ...credentials(request))));
  const management = (work: (request: FastifyRequest) => Promise<unknown>) => handle(async request => {
    if (hasPluginTaskCredentials(request) || !await options.authorize(request)) throw new RuntimeError('PLUGIN_TOOL_MANAGEMENT_DENIED', 'Installation owner required', 403);
    return work(request);
  });
  app.get('/api/plugins/tool-grants', management(() => options.grants.list()));
  app.put('/api/plugins/tool-grants', management(request => options.grants.set(request.body)));
  app.delete('/api/plugins/tool-grants/:id', management(request => options.grants.revoke((request.params as { id: string }).id)));

  const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26'];
  const seenRevisions = new Map<string, string>();
  const recordRevision = (key: string, revision: string) => {
    const previous = seenRevisions.get(key);
    seenRevisions.delete(key);
    seenRevisions.set(key, revision);
    while (seenRevisions.size > 512) { const oldest = seenRevisions.keys().next().value; if (oldest !== undefined) seenRevisions.delete(oldest); }
    return previous !== undefined && previous !== revision;
  };
  const authenticate = async (request: FastifyRequest) => {
    if (request.headers.origin && request.headers.origin !== options.origin) throw new RuntimeError('PLUGIN_TOOL_ORIGIN_DENIED', 'Invalid MCP origin', 403);
    await options.service.authorities.resolve(...credentials(request));
  };
  app.get('/api/plugin-tools/mcp', { logLevel: 'silent' }, async (request, reply) => {
    try { await authenticate(request); } catch (error) { const e = safeError(error); return reply.code(e.status).send({ error: { code: e.code } }); }
    return reply.code(405).header('allow', 'POST').send();
  });
  app.post('/api/plugin-tools/mcp', { logLevel: 'silent' }, async (request, reply) => {
    try { await authenticate(request); } catch (error) { const e = safeError(error); return reply.code(e.status).send({ error: { code: e.code } }); }
    const accept = request.headers.accept ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return reply.code(406).send();
    const version = request.headers['mcp-protocol-version'];
    if (version && !protocolVersions.includes(String(version))) return reply.code(400).send({ error: { code: 'PLUGIN_TOOL_PROTOCOL_UNSUPPORTED' } });
    const rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.record(z.unknown()).optional() }).strict().safeParse(request.body);
    if (!rpc.success) return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    const { id, method, params = {} } = rpc.data;
    if (id === undefined) return reply.code(202).send();
    const response = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return response({ protocolVersion: protocolVersions.includes(String(params.protocolVersion)) ? params.protocolVersion : protocolVersions[0], capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'dutydeck-plugin-tools', version: '1.0.0' } });
    const [token, turn] = credentials(request);
    const callerKey = `${token ?? ''}:${turn ?? ''}`;
    if (method === 'ping') {
      if (seenRevisions.has(callerKey)) {
        const listed = await options.service.list(token, turn);
        if (recordRevision(callerKey, listed.revision)) {
          return [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, response({ _meta: { revision: listed.revision, registryRevision: listed.registryRevision, listChanged: true } })];
        }
      }
      return response({});
    }
    try {
      if (method === 'tools/list') {
        const listed = await options.service.list(token, turn);
        const listChanged = recordRevision(callerKey, listed.revision);
        return response({
          tools: [...listed.tools.map(tool => ({
            name: tool.id.replace('/', '__'), description: tool.description,
            inputSchema: { type: 'object', properties: { input: tool.inputSchema, callId: { type: 'string', description: 'Stable invocation ID; preserve on retry.' } }, required: ['input', 'callId'], additionalProperties: false },
            annotations: { readOnlyHint: tool.effect === 'read', destructiveHint: tool.effect === 'write', idempotentHint: true, openWorldHint: true }
          })), { name: 'dutydeck_reconcile', description: 'Reconcile an unknown action; requires original and current operator grants.', inputSchema: { type: 'object', properties: { actionId: { type: 'string' } }, required: ['actionId'], additionalProperties: false } }],
          _meta: { revision: listed.revision, registryRevision: listed.registryRevision, listChanged }
        });
      }
      if (method === 'tools/call') {
        const call = z.object({ name: z.string(), arguments: z.unknown(), _meta: z.record(z.unknown()).optional() }).strict().parse(params);
        // Client _meta is never an identity source and is not forwarded to plugin code.
        const result = call.name === 'dutydeck_reconcile'
          ? await options.service.reconcile(reconcileSchema.parse(call.arguments).actionId, ...credentials(request))
          : await (async () => {
            const args = z.object({ input: z.unknown(), callId: z.string() }).strict().parse(call.arguments);
            return options.service.call(call.name.replace('__', '/'), args.input, args.callId, ...credentials(request));
          })();
        return response({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    } catch (error) {
      const code = error instanceof z.ZodError ? 'PLUGIN_TOOL_INVALID_INPUT' : safeError(error).code;
      return response({ content: [{ type: 'text', text: code }], isError: true });
    }
  });
}
