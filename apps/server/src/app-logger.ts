import type { FastifyRequest } from 'fastify';
import { pino, type DestinationStream } from 'pino';
import { serializeLogError } from './log-error.js';

/**
 * 服务日志的序列化器。req：分享页的实时流只能把分享 token 放进查询串（EventSource 带不了请求头），请求日志里抹掉它。
 * error：仓库统一写 `{ error }`，pino 默认只序列化 `err`，不处理时 Error 会被记成 `{}`。
 */
export const appLoggerOptions = { serializers: {
  req: (request: FastifyRequest) => ({
    method: request.method, url: request.url.startsWith('/api/plugin-results/') ? '/api/plugin-results/[redacted]' : request.url.replace(/([?&]share=)[^&#]*/g, '$1[redacted]'), host: request.host, remoteAddress: request.ip, remotePort: request.socket?.remotePort
  }),
  error: serializeLogError
} };

/** 带上面序列化器的服务日志实例；NODE_ENV=test 时不输出。 */
export function createAppLogger(destination?: DestinationStream) {
  return pino({ ...appLoggerOptions, enabled: process.env.NODE_ENV !== 'test' }, destination);
}
