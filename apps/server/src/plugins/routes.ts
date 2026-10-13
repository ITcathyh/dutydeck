import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describePluginCommand, type PluginCommandRegistry } from './commands.js';
import { TRIGGER_BODY_LIMIT, type PluginTriggerService } from './triggers.js';

export interface PluginRouteOptions {
  commands: PluginCommandRegistry;
  triggers: PluginTriggerService;
}

const triggerPath = /^\/api\/plugins\/[^/]+\/triggers\/[^/]+$/;
/** 触发器路由不走 Web 登录态，由触发器自己的令牌或签名鉴权。 */
export const isPluginTriggerRequest = (method: string, pathname: string) => method === 'POST' && triggerPath.test(pathname);

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
  });
}
