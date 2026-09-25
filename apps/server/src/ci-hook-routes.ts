import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { CodebaseCiService } from './codebase-ci.js';

export interface CiHookRouteOptions {
  codebase: CodebaseCiService;
}

const HOOK_BODY_LIMIT = 1024 * 1024;

const hookRoute = {
  // 令牌可能放在查询串里，请求日志只记路径。
  childLoggerFactory: (logger, bindings, opts) => logger.child(bindings, { ...opts, serializers: { ...opts.serializers,
    req: (request: FastifyRequest) => ({ method: request.method, url: request.url.split('?')[0], host: request.host, remoteAddress: request.ip }) } })
} satisfies RouteShorthandOptions;

/** `/api/hooks/` 不走 Web 登录态，由路由自己校验令牌或签名、时间戳和 event-id。 */
export async function registerCiHookRoutes(app: FastifyInstance, options: CiHookRouteOptions) {
  await app.register(async scope => {
    // 签名按原始字节计算：本作用域内 JSON 先按 Buffer 收下，由服务自己解析。
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: HOOK_BODY_LIMIT }, (_request, body, done) => done(null, body));
    scope.post<{ Querystring: { token?: string } }>('/api/hooks/codebase', hookRoute, async (request, reply) => {
      const result = await options.codebase.receive({
        rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        headers: request.headers,
        ...(typeof request.query.token === 'string' ? { queryToken: request.query.token } : {})
      });
      return reply.code(result.statusCode).send(result.body);
    });
  });
}
