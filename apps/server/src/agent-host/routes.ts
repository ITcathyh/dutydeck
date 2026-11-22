import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, RawServerDefault, RouteHandlerMethod, RouteGenericInterface } from 'fastify';
import type { LarkAgentToolsService } from '../lark/agent-tools.js';
import { agentGroupToolBearerToken } from './turn-authority.js';
import { AgentGroupToolError } from './turn-token.js';
import { otherEndpoints, toolBase, toolTable, type ToolNeed, type Endpoint, type GroupRequest } from './tool-table.js';

function toolRoute(endpoint: Endpoint) {
  return { method: endpoint.method, url: toolBase + endpoint.path };
}

type DomainHandler<R extends RouteGenericInterface> = RouteHandlerMethod<RawServerDefault, IncomingMessage, ServerResponse, R>;
export function registerToolFamily<R extends RouteGenericInterface>(app: FastifyInstance, needs: ToolNeed[],
  handlers: Record<string, DomainHandler<R>>, options: { logLevel?: 'silent' } = {}) {
  // Several command spellings share one endpoint (views, actions and work templates).
  const routes = new Map<string, Endpoint>();
  for (const tool of toolTable) {
    if (needs.includes(tool.need)) routes.set(tool.handlerName ?? tool.name, tool);
  }
  for (const [name, endpoint] of Object.entries(otherEndpoints)) {
    if (needs.includes(endpoint.need)) routes.set(name, endpoint);
  }
  for (const [name, endpoint] of routes) {
    const handler = handlers[name];
    if (!handler) throw new Error('Missing Agent tool handler: ' + name);
    app.route<R>({ ...toolRoute(endpoint), ...options, handler });
  }
}

export async function registerLarkAgentToolRoutes(app: FastifyInstance, service?: LarkAgentToolsService) {
  if (!service) return;
  for (const tool of toolTable) {
    const { serve } = tool;
    if (!serve) continue;
    app.route<{ Querystring: GroupRequest['query']; Params: GroupRequest['params']; Body: GroupRequest['body'] }>({
      ...toolRoute(tool),
      handler: async (request, reply) => {
        try { return await serve(service, agentGroupToolBearerToken(request.headers.authorization), request); }
        catch (error) {
          if (error instanceof AgentGroupToolError) return reply.code(error.statusCode).send(error.response());
          throw error;
        }
      }
    });
  }
}
