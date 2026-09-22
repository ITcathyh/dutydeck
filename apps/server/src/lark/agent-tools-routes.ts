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
        limit: numberFrom(request.query.limit)
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
}
