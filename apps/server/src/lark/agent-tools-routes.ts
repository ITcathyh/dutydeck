import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AgentGroupToolError,
  agentGroupToolBearerToken,
  type LarkAgentToolsService
} from './agent-tools.js';

interface GroupToolQuery {
  after?: string;
  limit?: string;
  timeoutMs?: string;
  since?: string;
  until?: string;
  query?: string;
}

interface GroupSendBody {
  final?: boolean;
  turn?: string;
  content?: string;
  to?: string;
  replyTo?: string;
  inThread?: boolean;
  idempotencyKey?: string;
}
interface GroupSendFileBody { path?: string; replyTo?: string; inThread?: boolean; idempotencyKey?: string; image?: boolean }
interface GroupHandoffBody {
  to?: string;
  content?: string;
  turn?: string;
}
interface GroupReplyAgentBody {
  content?: string;
  turn?: string;
}

const tokenFrom = (authorization?: string) => agentGroupToolBearerToken(authorization);
const numberFrom = (value?: string) => value === undefined ? undefined : Number(value);

function handleToolError(error: unknown, reply: FastifyReply) {
  if (error instanceof AgentGroupToolError) return reply.code(error.statusCode).send(error.response());
  throw error;
}

export async function registerLarkAgentToolRoutes(app: FastifyInstance, service?: LarkAgentToolsService) {
  if (!service) return;

  app.get('/api/lark/agent-tools/self', async (request, reply) => {
    try { return await service.self(tokenFrom(request.headers.authorization)); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get('/api/lark/agent-tools/peers', async (request, reply) => {
    try { return await service.peers(tokenFrom(request.headers.authorization)); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get('/api/lark/agent-tools/members', async (request, reply) => {
    try { return await service.members(tokenFrom(request.headers.authorization)); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get('/api/lark/agent-tools/bots', async (request, reply) => {
    try { return await service.bots(tokenFrom(request.headers.authorization)); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get<{ Querystring: GroupToolQuery }>('/api/lark/agent-tools/messages', async (request, reply) => {
    try {
      return await service.messages(tokenFrom(request.headers.authorization), {
        after: request.query.after,
        limit: numberFrom(request.query.limit),
        since: request.query.since,
        until: request.query.until,
        query: request.query.query
      });
    } catch (error) { return handleToolError(error, reply); }
  });

  app.get<{ Querystring: { messageId?: string } }>('/api/lark/agent-tools/message', async (request, reply) => {
    try {
      return await service.message(tokenFrom(request.headers.authorization), {
        messageId: request.query.messageId ?? ''
      });
    } catch (error) { return handleToolError(error, reply); }
  });

  app.get<{ Querystring: GroupToolQuery }>('/api/lark/agent-tools/history', async (request, reply) => {
    try {
      return await service.history(tokenFrom(request.headers.authorization), {
        limit: numberFrom(request.query.limit),
        since: request.query.since,
        until: request.query.until,
        query: request.query.query
      });
    } catch (error) { return handleToolError(error, reply); }
  });

  app.get<{ Params: { taskId: string } }>('/api/lark/agent-tools/history/:taskId', async (request, reply) => {
    try { return await service.historyTask(tokenFrom(request.headers.authorization), { taskId: request.params.taskId }); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get<{ Querystring: { query?: string } }>('/api/lark/agent-tools/team-search', async (request, reply) => {
    try { return await service.teamSearch(tokenFrom(request.headers.authorization), { query: request.query.query }); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.get<{ Querystring: GroupToolQuery }>('/api/lark/agent-tools/wait', async (request, reply) => {
    try {
      return await service.wait(tokenFrom(request.headers.authorization), {
        after: request.query.after,
        limit: numberFrom(request.query.limit),
        timeoutMs: numberFrom(request.query.timeoutMs)
      });
    } catch (error) { return handleToolError(error, reply); }
  });

  app.post<{ Body: GroupSendBody }>('/api/lark/agent-tools/send', async (request, reply) => {
    try { return await service.send(tokenFrom(request.headers.authorization), request.body ?? {}); }
    catch (error) { return handleToolError(error, reply); }
  });
  app.post<{ Body: GroupSendFileBody }>('/api/lark/agent-tools/send-file', async (request, reply) => {
    try { return await service.sendFile(tokenFrom(request.headers.authorization), request.body ?? {}); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.post<{ Body: GroupHandoffBody }>('/api/lark/agent-tools/handoff', async (request, reply) => {
    try { return await service.handoff(tokenFrom(request.headers.authorization), request.body ?? {}); }
    catch (error) { return handleToolError(error, reply); }
  });

  app.post<{ Body: GroupReplyAgentBody }>('/api/lark/agent-tools/reply-agent', async (request, reply) => {
    try { return await service.replyAgent(tokenFrom(request.headers.authorization), request.body ?? {}); }
    catch (error) { return handleToolError(error, reply); }
  });
}
