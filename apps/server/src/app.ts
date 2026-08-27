import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { RuntimeError } from '@dockmux/shared';
import type { DockmuxRuntime } from '@dockmux/runtime';
import { registerLarkRoutes, type LarkRoutesOptions } from './lark/routes.js';
import { discoverAgentModels } from './agent-models.js';
import { registerSystemRoutes, type SystemRoutesOptions } from './system-routes.js';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

export interface BuildAppOptions { webRoot?: string; lark?: LarkRoutesOptions; system?: SystemRoutesOptions }

export async function buildApp(runtime: DockmuxRuntime, options: BuildAppOptions = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const streams = new Set<import('node:http').ServerResponse>();
  await app.register(cors, { origin: true });
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); streams.clear(); });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RuntimeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });

  app.get('/health', async () => ({ ok: true }));
  await registerSystemRoutes(app, options.system);
  await registerLarkRoutes(app, { ...options.lark, runtime: options.lark?.runtime ?? runtime });
  app.get('/api/agents', async () => runtime.listAgents());
  app.get<{ Params: { id: string }; Querystring: { model?: string; refresh?: string } }>('/api/agents/:id/models', async request => {
    const agent = (await runtime.listAgents()).find(item => item.id === request.params.id);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${request.params.id}`, 404);
    return discoverAgentModels(agent, request.query.model?.trim() || undefined, request.query.refresh === '1' || request.query.refresh === 'true');
  });
  app.get('/api/sessions', async () => runtime.listSessions());
  app.post<{ Body: { agentId: string; cwd?: string; model?: string; reasoningEffort?: string } }>('/api/sessions', async request => runtime.start(request.body));
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => (await runtime.getSession(request.params.id)) ?? reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }));
  app.post<{ Params: { id: string }; Body: { prompt: string; mode?: 'queue' | 'interrupt' } }>('/api/sessions/:id/send', async (request, reply) => {
    const prompt = request.body?.prompt?.trim();
    const mode = request.body?.mode ?? 'queue';
    if (!prompt) throw new RuntimeError('INVALID_PROMPT', 'Prompt must not be empty', 400);
    if (mode !== 'queue' && mode !== 'interrupt') throw new RuntimeError('INVALID_SEND_MODE', `Unknown send mode: ${String(mode)}`, 400);
    const task = await runtime.dispatch(request.params.id, prompt, mode);
    return reply.code(202).send({ accepted: true, task });
  });
  app.patch<{ Params: { id: string }; Body: { model?: string; reasoningEffort?: string } }>('/api/sessions/:id/config', async request => {
    const model = request.body?.model?.trim();
    if (model) return runtime.setModel(request.params.id, model);
    const reasoningEffort = request.body?.reasoningEffort?.trim();
    if (reasoningEffort) return runtime.setReasoningEffort(request.params.id, reasoningEffort);
    throw new RuntimeError('INVALID_SESSION_CONFIG', 'Model or reasoning effort is required', 400);
  });
  app.delete<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/queue/:taskId', async request => runtime.cancelQueued(request.params.id, request.params.taskId));
  app.post<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/queue/:taskId/steer', async request => runtime.steerQueued(request.params.id, request.params.taskId));
  for (const action of ['interrupt', 'pause', 'resume', 'stop', 'restart'] as const) {
    app.post<{ Params: { id: string } }>(`/api/sessions/:id/${action}`, async request => { const result = await runtime[action](request.params.id); return result ?? { ok: true }; });
  }
  app.post<{ Params: { id: string } }>('/api/sessions/:id/archive', async request => runtime.archive(request.params.id));
  app.post<{ Params: { id: string; permissionId: string }; Body: { approved: boolean } }>('/api/sessions/:id/permissions/:permissionId', async request => runtime.resolvePermission(request.params.id, request.params.permissionId, request.body.approved));
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/sessions/:id/events', async request => runtime.getEvents(request.params.id, Number(request.query.after ?? 0)));
  app.get<{ Params: { id: string } }>('/api/sessions/:id/tasks', async request => runtime.getTasks(request.params.id));
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/sessions/:id/stream', async (request, reply) => {
    const fromHeader = request.headers['last-event-id'];
    const queryAfter = Number(request.query.after ?? 0);
    const headerAfter = Number((Array.isArray(fromHeader) ? fromHeader[0] : fromHeader) ?? 0);
    const after = Math.max(queryAfter, headerAfter);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(': connected\n\n');
    const write = (event: any) => reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of await runtime.getEvents(request.params.id, after)) write(event);
    const unsubscribe = runtime.subscribe(request.params.id, write);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    request.raw.once('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(reply.raw); });
  });

  if (options.webRoot) {
    const webRoot = resolve(options.webRoot);
    const indexFile = resolve(webRoot, 'index.html');
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      const pathname = new URL(request.url, 'http://dockmux.local').pathname;
      if (pathname.startsWith('/api/') || pathname === '/api') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'API route not found' } });

      let requestedFile: string;
      try { requestedFile = resolve(webRoot, decodeURIComponent(pathname).replace(/^\/+/, '')); }
      catch { return reply.code(400).send({ error: { code: 'INVALID_PATH', message: 'Invalid URL path' } }); }
      if (requestedFile !== webRoot && !requestedFile.startsWith(`${webRoot}${sep}`)) return reply.code(404).send();

      let file = requestedFile;
      let body: Buffer;
      try { body = await readFile(file); }
      catch {
        if (extname(pathname)) return reply.code(404).send();
        file = indexFile;
        try { body = await readFile(file); }
        catch { return reply.code(404).send({ error: { code: 'WEB_UI_NOT_FOUND', message: 'Web UI is not installed' } }); }
      }
      const type = contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream';
      if (pathname.startsWith('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.type(type).send(request.method === 'HEAD' ? undefined : body);
    });
  }
  return app;
}
