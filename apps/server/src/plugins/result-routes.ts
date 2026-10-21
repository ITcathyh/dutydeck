import type { FastifyInstance } from 'fastify';
import { agentGroupToolBearerToken } from '../lark/agent-tools.js';
import { PluginResultError, type PluginResultService } from './result-service.js';
import { registerPluginResultViewer, type PluginResultViewerOptions } from './result-viewer-auth.js';
export interface PluginResultRoutes { service: PluginResultService; viewer: PluginResultViewerOptions }
export function registerPluginResultRoutes(app:FastifyInstance,options:PluginResultRoutes) {
  app.register(async scope => { registerPluginResultViewer(scope,options.viewer); });
  const handle=(work:(request:any)=>Promise<unknown>)=>async(request:any,reply:any)=> {
    try { return await work(request); } catch(error) { const e=error instanceof PluginResultError?error:new PluginResultError('RESULT_UNAVAILABLE',403); return reply.code(e.statusCode).send({error:{code:e.code}}); }
  };
  app.get('/api/lark/agent-tools/plugin-tools',{logLevel:'silent'},handle(request=>options.service.list(agentGroupToolBearerToken(request.headers.authorization),request.headers['x-dutydeck-result-turn'])));
  app.post('/api/lark/agent-tools/plugin-tools/:plugin/:tool',{logLevel:'silent'},handle(request=> {
    const body=request.body;
    if (!body || Object.keys(body).sort().join(',')!=='callId,input,turn' || typeof body.turn!=='string') throw new PluginResultError('RESULT_INVALID_INPUT',400);
    return options.service.call(`${request.params.plugin}/${request.params.tool}`,body.input,body.callId,agentGroupToolBearerToken(request.headers.authorization),body.turn);
  }));
}
