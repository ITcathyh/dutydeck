import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describePluginCommand, type PluginCommandRegistry } from './commands.js';
import { TRIGGER_BODY_LIMIT, type PluginTriggerService } from './triggers.js';

export interface PluginRouteOptions {
  commands: PluginCommandRegistry;
  triggers: PluginTriggerService;
}

const triggerPath = /^\/api\/plugins\/[^/]+\/triggers\/[^/]+$/;
const triggerRunPath = /^\/api\/plugins\/[^/]+\/triggers\/[^/]+\/runs\/[^/]+$/;
const triggerCancelPath = /^\/api\/plugins\/[^/]+\/triggers\/[^/]+\/runs\/[^/]+\/cancel$/;
const versionedTriggerPath = /^\/api\/plugin-triggers\/v1\/runs$/;
const versionedTriggerRunPath = /^\/api\/plugin-triggers\/v1\/runs\/[^/]+$/;
const versionedTriggerCancelPath = /^\/api\/plugin-triggers\/v1\/runs\/[^/]+\/cancel$/;
/** 触发器路由不走 Web 登录态，由触发器自己的令牌或签名鉴权。 */
export const isPluginTriggerRequest = (method: string, pathname: string) => (method === 'POST' && (triggerPath.test(pathname) || triggerCancelPath.test(pathname) || versionedTriggerPath.test(pathname) || versionedTriggerCancelPath.test(pathname))) || (method === 'GET' && (triggerRunPath.test(pathname) || versionedTriggerRunPath.test(pathname)));

export async function registerPluginRoutes(app: FastifyInstance, options: PluginRouteOptions) {
  app.get<{ Querystring: { cwd?: string } }>('/api/plugins/commands', async request => ({
    commands: options.commands.list({ ...(request.query.cwd ? { cwd: request.query.cwd } : {}) }).map(command => {
      const described = describePluginCommand(command);
      return { name: described.name, description: described.summary, usage: described.usage, plugin: command.plugin };
    })
  }));
  await app.register(async scope => {
    // 签名按原始字节计算：任何内容类型都先按 Buffer 收下。
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: TRIGGER_BODY_LIMIT }, (_request, body, done) => done(null, body));
    scope.setErrorHandler((error, _request, reply) => {
      const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
      return reply.code(statusCode).send({ error: { code: statusCode === 413 ? 'PLUGIN_TRIGGER_BODY_TOO_LARGE' : 'PLUGIN_TRIGGER_FAILED', message: error.message } });
    });
    scope.post<{ Params: { plugin: string; id: string } }>('/api/plugins/:plugin/triggers/:id', {
      bodyLimit: TRIGGER_BODY_LIMIT,
      // 请求日志只记路径，不记查询串与请求头。
      childLoggerFactory: (logger, bindings, opts) => logger.child(bindings, { ...opts, serializers: { ...opts.serializers,
        req: (request: FastifyRequest) => ({ method: request.method, url: request.url.split('?')[0], remoteAddress: request.ip }) } })
    }, async (request, reply) => {
      const result = await options.triggers.receive({
        plugin: request.params.plugin,
        triggerId: request.params.id,
        rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        headers: request.headers
      });
      return reply.code(result.statusCode).send(result.body);
    });
    scope.post<{ Querystring: { plugin?: string; triggerId?: string; dryRun?: string } }>('/api/plugin-triggers/v1/runs', {
      bodyLimit: TRIGGER_BODY_LIMIT,
      childLoggerFactory: (logger, bindings, opts) => logger.child(bindings, { ...opts, serializers: { ...opts.serializers,
        req: (request: FastifyRequest) => ({ method: request.method, url: request.url.split('?')[0], remoteAddress: request.ip }) } })
    }, async (request, reply) => {
      const plugin = request.query.plugin;
      const triggerId = request.query.triggerId;
      if (!plugin || !triggerId) return reply.code(400).send({ error: { code: 'PLUGIN_TRIGGER_INVALID_REQUEST', message: 'plugin 和 triggerId 查询参数必填' } });
      const result = await options.triggers.receive({
        plugin, triggerId,
        rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        headers: request.headers,
        dryRun: request.query.dryRun === 'true',
        statusUrl: runId => `/api/plugin-triggers/v1/runs/${runId}?plugin=${encodeURIComponent(plugin)}&triggerId=${encodeURIComponent(triggerId)}`
      });
      return reply.code(result.statusCode).send(result.body);
    });
    scope.get<{ Params: { plugin: string; id: string; runId: string } }>('/api/plugins/:plugin/triggers/:id/runs/:runId', async (request, reply) => {
      if (!options.triggers.authorize(request.params.plugin, request.params.id, request.headers)) return reply.code(401).send({ error: { code: 'PLUGIN_TRIGGER_UNAUTHORIZED' } });
      const run = options.triggers.getRun(request.params.plugin, request.params.id, request.params.runId);
      return run ? reply.send(run) : reply.code(404).send({ error: { code: 'PLUGIN_TRIGGER_RUN_NOT_FOUND' } });
    });
    scope.post<{ Params: { plugin: string; id: string; runId: string } }>('/api/plugins/:plugin/triggers/:id/runs/:runId/cancel', async (request, reply) => {
      if (!options.triggers.authorize(request.params.plugin, request.params.id, request.headers)) return reply.code(401).send({ error: { code: 'PLUGIN_TRIGGER_UNAUTHORIZED' } });
      const run = await options.triggers.cancelRun(request.params.plugin, request.params.id, request.params.runId);
      return run ? reply.send(run) : reply.code(404).send({ error: { code: 'PLUGIN_TRIGGER_RUN_NOT_FOUND' } });
    });
    scope.get<{ Params: { runId: string }; Querystring: { plugin?: string; triggerId?: string } }>('/api/plugin-triggers/v1/runs/:runId', async (request, reply) => {
      const plugin = request.query.plugin;
      const triggerId = request.query.triggerId;
      if (!plugin || !triggerId || !options.triggers.authorize(plugin, triggerId, request.headers)) return reply.code(401).send({ error: { code: 'PLUGIN_TRIGGER_UNAUTHORIZED' } });
      const run = options.triggers.getRun(plugin, triggerId, request.params.runId);
      return run ? reply.send(run) : reply.code(404).send({ error: { code: 'PLUGIN_TRIGGER_RUN_NOT_FOUND' } });
    });
    scope.post<{ Params: { runId: string }; Querystring: { plugin?: string; triggerId?: string } }>('/api/plugin-triggers/v1/runs/:runId/cancel', async (request, reply) => {
      const plugin = request.query.plugin;
      const triggerId = request.query.triggerId;
      if (!plugin || !triggerId || !options.triggers.authorize(plugin, triggerId, request.headers)) return reply.code(401).send({ error: { code: 'PLUGIN_TRIGGER_UNAUTHORIZED' } });
      const run = await options.triggers.cancelRun(plugin, triggerId, request.params.runId);
      return run ? reply.send(run) : reply.code(404).send({ error: { code: 'PLUGIN_TRIGGER_RUN_NOT_FOUND' } });
    });
  });
}
