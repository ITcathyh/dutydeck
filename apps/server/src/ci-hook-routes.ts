import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { CiWebhookService } from './ci-webhook.js';

export interface CiHookRouteOptions {
  /** 没有配置 webhook 的 CI 提供方时为 undefined，所有 `/api/hooks/<provider>` 都回 404。 */
  service?: CiWebhookService;
}

const HOOK_BODY_LIMIT = 1024 * 1024;

const hookRoute = {
  bodyLimit: HOOK_BODY_LIMIT,
  // 令牌可能放在查询串里，请求日志只记路径。
  childLoggerFactory: (logger, bindings, opts) => logger.child(bindings, { ...opts, serializers: { ...opts.serializers,
    req: (request: FastifyRequest) => ({ method: request.method, url: request.url.split('?')[0], host: request.host, remoteAddress: request.ip }) } })
} satisfies RouteShorthandOptions;

/**
 * `POST /api/hooks/<provider>`：按 id 找已加载插件注册的 CI 提供方，由它验签和解析，去重与订阅匹配在宿主。
 * `/api/hooks/` 不走 Web 登录态。
 */
export async function registerCiHookRoutes(app: FastifyInstance, options: CiHookRouteOptions) {
  await app.register(async scope => {
    // 签名按原始字节计算：任何内容类型都先按 Buffer 收下，由提供方自己解析。
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: HOOK_BODY_LIMIT }, (_request, body, done) => done(null, body));
    scope.post<{ Params: { provider: string }; Querystring: Record<string, string | undefined> }>('/api/hooks/:provider', hookRoute, async (request, reply) => {
      if (!options.service) return reply.code(404).send({ error: { code: 'CI_PROVIDER_NOT_FOUND', message: '没有这个 CI 提供方，或它没有配置 webhook' } });
      const query = Object.fromEntries(Object.entries(request.query ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const result = await options.service.receive(request.params.provider, {
        rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        headers: request.headers,
        query
      });
      return reply.code(result.statusCode).send(result.body);
    });
  });
}
