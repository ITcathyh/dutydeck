import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  SESSION_INSIGHT_LIMITS,
  compareSessionRefSchema,
  sessionInsightCompareRequestSchema,
  sessionInsightDetailsResponseSchema,
  sessionInsightEventsQuerySchema,
  sessionInsightEventsResponseSchema,
  sessionInsightExportRequestSchema,
  sessionInsightRefreshRequestSchema,
  sessionInsightRefreshResponseSchema,
  sessionInsightCancelResponseSchema,
  sessionInsightSummaryQuerySchema,
  sessionInsightSummaryResponseSchema,
  sessionInsightCompareResponseSchema,
  type SessionInsightCancelResponse,
  type SessionInsightCompareRequest,
  type SessionInsightCompareResponse,
  type SessionInsightDetailsResponse,
  type SessionInsightEventsQuery,
  type SessionInsightEventsResponse,
  type SessionInsightExportRequest,
  type SessionInsightRefreshResponse,
  type SessionInsightSummaryQuery,
  type SessionInsightSummaryResponse
} from '@dutydeck/shared';

/**
 * T4c 实现的会话分析服务结构接口。所有方法只会在安装管理员鉴权通过后被调用，
 * session / snapshot 归属、快照淘汰与作业排队均由实现侧负责；路由层只做
 * 鉴权、固定输入契约校验、安全错误投影和响应契约校验。
 */
export interface SessionInsightApi {
  /** GET /api/sessions/:id/insight；无缓存返回 availability none，不抛 404。 */
  details(sessionId: string, snapshotId?: string): Promise<SessionInsightDetailsResponse>;
  /** POST .../refresh；同 session in-flight 复用 requestId；cacheHit=true 时 HTTP 200，否则 202。 */
  refresh(sessionId: string): Promise<SessionInsightRefreshResponse>;
  /** DELETE .../refresh/:requestId；幂等，旧 requestId 不影响新请求。 */
  cancel(sessionId: string, requestId: string): Promise<SessionInsightCancelResponse>;
  /** GET .../events；query 已按冻结契约解析（默认 limit 100，最大 200）。 */
  events(sessionId: string, query: SessionInsightEventsQuery): Promise<SessionInsightEventsResponse>;
  /** GET /api/insights/summary；候选集合与分页由实现侧负责。 */
  summary(query: SessionInsightSummaryQuery): Promise<SessionInsightSummaryResponse>;
  /** POST /api/insights/compare；两侧 session+snapshot 归属由实现侧校验。 */
  compare(request: SessionInsightCompareRequest): Promise<SessionInsightCompareResponse>;
  /** POST /api/insights/export；返回已转义报告，路由只做下载头与 16 MiB 预算二次防御。 */
  exportReport(request: SessionInsightExportRequest): Promise<SessionInsightExportReport>;
}

export interface SessionInsightExportReport {
  body: string;
  contentType: 'text/markdown; charset=utf-8' | 'text/html; charset=utf-8';
  /** 只允许安全 ASCII：ID/日期/点/连字符/下划线，扩展名 .md 或 .html。 */
  filename: string;
}

export interface SessionInsightRouteOptions {
  /** 未提供时所有分析路由在鉴权层 fail-closed；鉴权通过但无 service 返回 503。 */
  service?: SessionInsightApi;
  /** 由 service.ts 注入 Boolean(await resolveInstallationPrincipal(request))；未提供/false/抛异常一律拒绝。 */
  authorize?: (request: FastifyRequest) => boolean | Promise<boolean>;
}

// 路径 / 标识符只接受有限安全字符，拒绝任意路径、CRLF 与超大输入。
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const routeIdSchema = z.string().regex(ID_PATTERN, 'Invalid identifier');
const routeCursorSchema = z.string().min(1).max(512);
const requestIdParamSchema = z.string().uuid();
// 无 query 路由专用：严格禁止任何 query 参数，防止未知参数旁路或泄露。
const emptyQueryRouteSchema = z.object({}).strict();

// details 路由专用：仅允许可选的 snapshotId，严格拒绝任意路径或其他 query。
const detailsQueryRouteSchema = z
  .object({
    snapshotId: routeIdSchema.optional()
  })
  .strict();
// 目录/Agent 等筛选值不是资源 ID：workspace 是绝对 cwd 或自定义工作区 group ID
// （含 '/'、空格、中文），agentId 在冻结契约里仅要求非空字符串。允许有限长非空文本，
// 只拒绝控制字符（含 CR/LF）；它们是筛选条件，不是日志路径参数。
const routeTextSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(value => !/[\u0000-\u001f\u007f]/.test(value), { message: 'Control characters are not allowed' });

// 路由层在冻结契约之上收紧游标和自由文本长度；strict 行为随冻结 schema 保留。
const eventsQueryRouteSchema = sessionInsightEventsQuerySchema.extend({
  snapshotId: routeIdSchema,
  cursor: routeCursorSchema.optional(),
  tool: routeTextSchema(128).optional()
});
const summaryQueryRouteSchema = z
  .object({
    workspace: routeTextSchema(4096).optional(),
    agentId: routeTextSchema(256).optional(),
    usage: z.enum(['explicit', 'proactive', 'scheduled', 'background', 'mixed', 'unknown']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    includeArchived: z
      .union([z.boolean(), z.enum(['true', 'false']).transform(v => v === 'true')])
      .default(false),
    groupBy: z.enum(['workspace', 'agent', 'model', 'usage']).default('workspace'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageMax)
      .default(SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageDefault),
    cursor: routeCursorSchema.optional()
  })
  .strict()
  .refine(
    data => !data.from || !data.to || new Date(data.from).getTime() < new Date(data.to).getTime(),
    { message: 'from must be earlier than to' }
  );

const routeCompareRefSchema = compareSessionRefSchema.extend({
  sessionId: routeIdSchema,
  snapshotId: routeIdSchema
});
const compareRequestRouteSchema = sessionInsightCompareRequestSchema.extend({
  left: routeCompareRefSchema,
  right: routeCompareRefSchema
});
const exportRequestRouteSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('session'),
      sessionId: routeIdSchema,
      snapshotId: routeIdSchema,
      format: z.enum(['markdown', 'html'])
    })
    .strict(),
  z
    .object({
      kind: z.literal('comparison'),
      left: routeCompareRefSchema,
      right: routeCompareRefSchema,
      format: z.enum(['markdown', 'html'])
    })
    .strict()
]);

// 已知分析错误码 → 固定 HTTP 状态与固定安全文案。绝不回显异常自带 message，
// 以免原始路径、stderr、请求体或 Zod 字符串中的敏感值进入响应。
const INSIGHT_ERROR_STATUS: Record<string, number> = {
  INSIGHT_FORBIDDEN: 403,
  INSIGHT_NOT_FOUND: 404,
  INSIGHT_VERSION_MISMATCH: 409,
  INSIGHT_SNAPSHOT_GONE: 410,
  INSIGHT_QUEUE_FULL: 429,
  INSIGHT_SOURCE_CONFLICT: 409,
  INSIGHT_SOURCE_CHANGED: 409,
  INSIGHT_INPUT_LIMIT: 422,
  INSIGHT_BUDGET_EXCEEDED: 422,
  INSIGHT_REPORT_LIMIT: 413,
  // 用户提供了非法 / 跨快照 / 跨 filter 的分页游标（T4d summary、T2 events），
  // 属于请求错误而不是服务器故障。
  INSIGHT_SUMMARY_BAD_CURSOR: 400,
  INSIGHT_INVALID_CURSOR: 400
};
const INSIGHT_ERROR_MESSAGES: Record<string, string> = {
  INSIGHT_FORBIDDEN: 'Installation administrator authorization is required',
  INSIGHT_NOT_FOUND: 'Session insight resource not found',
  INSIGHT_VERSION_MISMATCH: 'Session insight version mismatch',
  INSIGHT_SNAPSHOT_GONE: 'Session insight snapshot is no longer available',
  INSIGHT_QUEUE_FULL: 'Session insight analysis queue is full',
  INSIGHT_SOURCE_CONFLICT: 'Session insight source conflict',
  INSIGHT_SOURCE_CHANGED: 'Session insight source changed during analysis',
  INSIGHT_INPUT_LIMIT: 'Session insight input limit exceeded',
  INSIGHT_BUDGET_EXCEEDED: 'Session insight budget exceeded',
  INSIGHT_REPORT_LIMIT: 'Session insight report exceeds the output limit',
  INSIGHT_SUMMARY_BAD_CURSOR: 'Invalid pagination cursor',
  INSIGHT_INVALID_CURSOR: 'Invalid pagination cursor'
};
const INTERNAL_ERROR_BODY = { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } } as const;

class SessionInsightHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionInsightHttpError';
  }
}

const forbiddenError = () =>
  new SessionInsightHttpError(403, 'INSIGHT_FORBIDDEN', INSIGHT_ERROR_MESSAGES.INSIGHT_FORBIDDEN!);

/** 服务层异常只按白名单错误码做固定投影；其余（含 ZodError、未知异常）一律 500。 */
function mapServiceError(error: unknown): SessionInsightHttpError {
  if (error instanceof SessionInsightHttpError) return error;
  if (error instanceof ZodError) return new SessionInsightHttpError(500, INTERNAL_ERROR_BODY.error.code, INTERNAL_ERROR_BODY.error.message);
  const code = typeof (error as { code?: unknown } | null | undefined)?.code === 'string'
    ? ((error as { code: string }).code)
    : '';
  const status = INSIGHT_ERROR_STATUS[code];
  if (status !== undefined) {
    return new SessionInsightHttpError(status, code, INSIGHT_ERROR_MESSAGES[code] ?? INTERNAL_ERROR_BODY.error.message);
  }
  return new SessionInsightHttpError(500, INTERNAL_ERROR_BODY.error.code, INTERNAL_ERROR_BODY.error.message);
}

async function validateOutput<T>(schema: z.ZodType<T>, result: Promise<unknown>): Promise<T> {
  return schema.parse(await result);
}

// T4b 生成的安全文件名形如 session-insight-<id>-YYYY-MM-DD.md /
// session-insight-compare-<id>-<id>-YYYY-MM-DD.html；这里只允许有限 ASCII、
// 单点、连字符与下划线，拒绝路径分隔、连续点（穿越）、引号与 CRLF，整体限长。
const REPORT_FILENAME_PATTERN = /^(?=.{3,200}$)[A-Za-z0-9_-][A-Za-z0-9._-]*\.(md|html)$/;
const filenameSafe = (filename: string): boolean =>
  REPORT_FILENAME_PATTERN.test(filename) && !filename.includes('..');
const REPORT_CONTENT_TYPES = {
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8'
} as const;

export function registerSessionInsightRoutes(
  app: FastifyInstance,
  options: SessionInsightRouteOptions = {}
): void {
  // 独立封装作用域：鉴权与 no-store 只覆盖分析路由。
  void app.register(async scope => {
    // onRequest 先于 body 解析与一切 schema 校验：鉴权失败（含缺回调/false/抛异常）
    // 固定 403，不泄漏 session 是否存在。
    scope.addHook('onRequest', async (request) => {
      let authorized = false;
      if (options.authorize) {
        try {
          authorized = Boolean(await options.authorize(request));
        } catch {
          authorized = false;
        }
      }
      if (!authorized) throw forbiddenError();
    });

    // no-store 放在 onSend 而不是 onRequest：生产里安装认证中间件注册在 parent
    // app 的 onRequest，早于本 scope；它对未登录 / share 请求提前 reply.send(401)
    // 时，后续 scope onRequest 会被生命周期短路而跳过。onSend 仍按匹配到的本 scope
    // 路由触发，因此能覆盖认证层提前拒绝（401/403）、scope 鉴权拒绝（403）、
    // 参数错误（400）与成功响应，且只作用于这 7 条分析路由，不影响其它路由缓存策略。
    scope.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Cache-Control', 'no-store');
      return payload;
    });

    scope.setErrorHandler((error, _request, reply) => {
      // 输入契约错误固定 400 与安全文案；绝不回显 issue.message、path 或用户提交的
      // unrecognized_keys / invalid_enum_value，防止敏感参数名与 canary 随错误信息泄露。
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid input'
          }
        });
      }
      if (error instanceof SessionInsightHttpError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      // Fastify body / content-type 解析错误自带 4xx 状态码；只回固定文案，不回原始异常。
      const requestErrorStatus = (error as { statusCode?: unknown }).statusCode;
      if (typeof requestErrorStatus === 'number' && requestErrorStatus >= 400 && requestErrorStatus < 500) {
        return reply.code(requestErrorStatus).send({ error: { code: 'INVALID_INPUT', message: 'Invalid request' } });
      }
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    });

    const requireService = (): SessionInsightApi => {
      if (!options.service) {
        throw new SessionInsightHttpError(503, 'INSIGHT_UNAVAILABLE', 'Session insight is unavailable');
      }
      return options.service;
    };

    const callService = async <T>(schema: z.ZodType<T>, invoke: (service: SessionInsightApi) => Promise<unknown>): Promise<T> => {
      const service = requireService();
      try {
        return await validateOutput(schema, invoke(service));
      } catch (error) {
        throw mapServiceError(error);
      }
    };

    scope.get<{ Params: { id: string }; Querystring: unknown }>(
      '/api/sessions/:id/insight',
      async request => {
        const sessionId = routeIdSchema.parse(request.params.id);
        const { snapshotId } = detailsQueryRouteSchema.parse(request.query ?? {});
        return callService(sessionInsightDetailsResponseSchema, service => service.details(sessionId, snapshotId));
      }
    );

    scope.post<{ Params: { id: string }; Body: unknown; Querystring: unknown }>(
      '/api/sessions/:id/insight/refresh',
      async (request, reply) => {
        const sessionId = routeIdSchema.parse(request.params.id);
        emptyQueryRouteSchema.parse(request.query ?? {});
        // 缺省 body（undefined）视作 {}；显式 JSON null 或任何字段都被 strict object 拒绝。
        sessionInsightRefreshRequestSchema.parse(request.body === undefined ? {} : request.body);
        const result = await callService(sessionInsightRefreshResponseSchema, service => service.refresh(sessionId));
        return reply.code(result.cacheHit ? 200 : 202).send(result);
      }
    );

    scope.delete<{ Params: { id: string; requestId: string }; Querystring: unknown }>(
      '/api/sessions/:id/insight/refresh/:requestId',
      async request => {
        const sessionId = routeIdSchema.parse(request.params.id);
        const requestId = requestIdParamSchema.parse(request.params.requestId);
        emptyQueryRouteSchema.parse(request.query ?? {});
        return callService(sessionInsightCancelResponseSchema, service => service.cancel(sessionId, requestId));
      }
    );

    scope.get<{ Params: { id: string }; Querystring: unknown }>(
      '/api/sessions/:id/insight/events',
      async request => {
        const sessionId = routeIdSchema.parse(request.params.id);
        const query = eventsQueryRouteSchema.parse(request.query ?? {});
        // 再过一遍冻结契约，保证传给 service 的形状与 T0 schema 完全一致。
        const parsedQuery: SessionInsightEventsQuery = sessionInsightEventsQuerySchema.parse(query);
        return callService(sessionInsightEventsResponseSchema, service => service.events(sessionId, parsedQuery));
      }
    );

    scope.get<{ Querystring: unknown }>('/api/insights/summary', async request => {
      const query = summaryQueryRouteSchema.parse(request.query ?? {});
      const parsedQuery: SessionInsightSummaryQuery = sessionInsightSummaryQuerySchema.parse(query);
      return callService(sessionInsightSummaryResponseSchema, service => service.summary(parsedQuery));
    });

    scope.post<{ Body: unknown; Querystring: unknown }>('/api/insights/compare', async request => {
      emptyQueryRouteSchema.parse(request.query ?? {});
      const body = compareRequestRouteSchema.parse(request.body);
      const parsedBody: SessionInsightCompareRequest = sessionInsightCompareRequestSchema.parse(body);
      return callService(sessionInsightCompareResponseSchema, service => service.compare(parsedBody));
    });

    scope.post<{ Body: unknown; Querystring: unknown }>('/api/insights/export', async (request, reply) => {
      emptyQueryRouteSchema.parse(request.query ?? {});
      // 内容协商（format）在鉴权之后、service 调用之前。
      const body = exportRequestRouteSchema.parse(request.body);
      const parsedBody: SessionInsightExportRequest = sessionInsightExportRequestSchema.parse(body);
      const service = requireService();
      let report: SessionInsightExportReport;
      try {
        report = await service.exportReport(parsedBody);
      } catch (error) {
        throw mapServiceError(error);
      }
      const expectedContentType = REPORT_CONTENT_TYPES[parsedBody.format];
      const filename = typeof report.filename === 'string' ? report.filename : '';
      const reportBody = typeof report.body === 'string' ? report.body : '';
      // 服务侧契约违规（含文件名注入尝试、错误 content-type、非字符串 body）不把原值透传出去。
      if (
        report.contentType !== expectedContentType
        || typeof report.body !== 'string'
        || typeof report.filename !== 'string'
        || !filenameSafe(filename)
        || (parsedBody.format === 'markdown') !== filename.endsWith('.md')
        || (parsedBody.format === 'html') !== filename.endsWith('.html')
      ) {
        throw new SessionInsightHttpError(500, INTERNAL_ERROR_BODY.error.code, INTERNAL_ERROR_BODY.error.message);
      }
      // 最终 16 MiB UTF-8 预算二次防御（T4b 生成侧已限一次）。
      if (Buffer.byteLength(reportBody, 'utf8') > SESSION_INSIGHT_LIMITS.maxReportOutputBytes) {
        throw new SessionInsightHttpError(413, 'INSIGHT_REPORT_LIMIT', INSIGHT_ERROR_MESSAGES.INSIGHT_REPORT_LIMIT!);
      }
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.code(200).type(expectedContentType).send(reportBody);
    });
  });
}
