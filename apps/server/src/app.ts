import { registerRecoveryRoutes, type RecoveryRouteOptions } from './recovery-routes.js';
import { registerWorkspaceGroupRoutes, type WorkspaceGroupRouteOptions } from './workspace-group-routes.js';
import { registerSessionNameRoutes, type SessionNameRouteOptions } from './session-name-routes.js';
import { ZodError } from 'zod';
import { registerCollaborationRoutes, type CollaborationRouteOptions } from './collaboration-routes.js';
import { AgentGroupToolError } from './lark/agent-tools.js';
import { LarkServiceError } from './lark/service.js';
import Fastify, { type FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { installationOwnerTaskActor, permissionModes, RuntimeError, toPublicAgent, type PermissionMode, type PolicyAction, type PolicyDecision } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { registerLarkRoutes, type LarkRoutesOptions } from './lark/routes.js';
import { discoverAgentModels } from './agent-models.js';
import { registerSystemRoutes, type SystemRoutesOptions } from './system-routes.js';
import { registerAuthMiddleware, registerBrowserAuthRoutes, type AuthMiddlewareOptions } from './auth/auth.js';
import { registerTerminalRoutes, type TerminalRouteAuth, type TerminalStreamProvider } from './terminal/terminal-ws.js';
import { isRelayCapabilityRequest, registerRelayRoutes, type RelayRoutesOptions } from './relay-routes.js';
import { registerFoundationManagementRoutes, type FoundationManagementOptions } from './foundation-routes.js';
import { registerScheduleManagementRoutes, type ScheduleManagementOptions } from './schedule-routes.js';
import { registerWorkItemTools, type WorkItemToolsOptions } from './work-item-tools.js';
import { registerLarkMemoryTools, type LarkMemoryToolsOptions } from './lark/memory-tools.js';
import { registerLarkMemoryTurnRoutes } from './lark/memory-turn-routes.js';
import { registerWorkItemRoutes, type WorkItemRouteOptions } from './work-item-routes.js';
import { registerSessionAutomationRoutes, type SessionAutomationRouteOptions } from './session-automation-routes.js';
import { registerIdentityPreflightRoutes, type IdentityPreflightRouteOptions } from './identity-preflight-routes.js';
import { registerCiHookRoutes, type CiHookRouteOptions } from './ci-hook-routes.js';
import { registerUsageRoutes, type UsageRouteOptions } from './usage-routes.js';

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

export interface TerminalRouteOptions {
  /** 由 service 从 runtime driver 暴露的会话终端流访问器。 */
  provider: TerminalStreamProvider;
  /** WS 升级认证；不传 = 不认证 */
  auth?: TerminalRouteAuth;
  /** New GroupBinding terminal authorization. Legacy sessions are explicitly unmanaged. */
  authorize?: (request: import('node:http').IncomingMessage, sessionId: string, action: 'terminal.read' | 'terminal.write') => Promise<PolicyDecision>;
}

export interface SessionExecutionPolicy {
  authorize(request: FastifyRequest, sessionId: string, boundary: 'session' | 'high_risk', action: PolicyAction): Promise<PolicyDecision>;
}

export interface BuildAppOptions {
  recovery?: RecoveryRouteOptions;
  workspaceGroups?: WorkspaceGroupRouteOptions;
  sessionNames?: SessionNameRouteOptions;
  collaboration?: CollaborationRouteOptions;
  usage?: UsageRouteOptions;
  workItems?: WorkItemRouteOptions;
  workItemTools?: WorkItemToolsOptions;
  memoryTools?: LarkMemoryToolsOptions;
  automation?: SessionAutomationRouteOptions;
  /** CI webhook 入口（/api/hooks/*）；未配置 webhook 密钥时不注册。 */
  ciHooks?: CiHookRouteOptions;
  webRoot?: string;
  lark?: LarkRoutesOptions;
  system?: SystemRoutesOptions;
  /** 访问认证中间件选项；不传 = 不启用认证（仅 loopback 场景） */
  auth?: AuthMiddlewareOptions;
  /** 终端 WS 代理；不传 = 不注册 /api/terminal/:sessionId */
  terminal?: TerminalRouteOptions;
  /** 通用会话回传通道；不传 = 不注册 /api/relay/* */
  relay?: RelayRoutesOptions;
  /** WP1a offline management only. Production service wiring is deferred to WP1b. */
  foundation?: FoundationManagementOptions;
  /** v13 disabled Schedule management. No executor is registered here. */
  schedule?: ScheduleManagementOptions;
  /** Explicit read-only App×Chat verification. Never starts a listener. */
  identityPreflight?: IdentityPreflightRouteOptions;
  /** Fail-closed policy edge for sessions associated with a new GroupBinding. */
  executionPolicy?: SessionExecutionPolicy;
}

export async function buildApp(runtime: DutydeckRuntime, options: BuildAppOptions = {}) {
  // 分享页的实时流只能把分享 token 放进查询串（EventSource 带不了请求头），请求日志里抹掉它。
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && { serializers: { req: (request: FastifyRequest) => ({
    method: request.method, url: request.url.replace(/([?&]share=)[^&#]*/g, '$1[redacted]'), host: request.host, remoteAddress: request.ip, remotePort: request.socket?.remotePort
  }) } } });
  const streams = new Set<import('node:http').ServerResponse>();
  const requireSessionExecution = async (request: FastifyRequest, sessionId: string, boundary: 'session' | 'high_risk', action: PolicyAction) => {
    if (!options.executionPolicy) return;
    const decision = await options.executionPolicy.authorize(request, sessionId, boundary, action);
    if (!decision.allowed) throw new RuntimeError(decision.code, decision.reason, 403);
    return decision;
  };
  const canViewSession = async (request: FastifyRequest, sessionId: string) => {
    if (!options.executionPolicy) return true;
    return (await options.executionPolicy.authorize(request, sessionId, 'session', 'task.view_result')).allowed;
  };
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); streams.clear(); });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') } });
    if (error instanceof AgentGroupToolError) return reply.code(error.statusCode).send(error.response());
    if (error instanceof RuntimeError || error instanceof LarkServiceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });

  app.get('/health', async () => ({ ok: true }));
  if (options.auth) {
    registerBrowserAuthRoutes(app, options.auth);
    // 中央豁免规则（所有调用方一致）：
    //  - 非 /api/ 路径（静态 web 壳）公开：HTML/JS/CSS 不含会话数据，API 仍全部要 token
    //  - /api/lark/agent-tools/* 有自己的 Bearer 机制（agentGroupToolBearerToken），不重复门禁
    //  - relay send/ask 精确使用会话 HMAC；同一个 Authorization 头无法再放 access token
    //  - /api/hooks/* 是 CI 回调，路由自己校验令牌或签名、时间戳和 event-id
    //  - 飞书卡片回调（card.action.trigger）走长连接监听、不经 HTTP，天然不受影响
    const userExempt = options.auth.exempt;
    registerAuthMiddleware(app, {
      ...options.auth,
      exempt: (method, pathname) =>
        !pathname.startsWith('/api/')
        || pathname === '/api/auth/status'
        || pathname === '/api/auth/login'
        // 登录链接：GET（及自动生成的 HEAD）只回确认页，POST 才兑换；其余方法照常鉴权。
        || (pathname === '/api/auth/link' && (method === 'GET' || method === 'HEAD' || method === 'POST'))
        || pathname === '/api/auth/logout'
        || pathname.startsWith('/api/lark/agent-tools/')
        || isRelayCapabilityRequest(method, pathname)
        || pathname.startsWith('/api/hooks/')
        || userExempt?.(method, pathname) === true
    });
  }
  registerRecoveryRoutes(app, runtime, options.recovery);
  registerWorkspaceGroupRoutes(app, options.workspaceGroups);
  registerSessionNameRoutes(app, runtime, options.sessionNames);
  if (options.terminal) registerTerminalRoutes(app, options.terminal);
  registerRelayRoutes(app, { ...options.relay, runtime: options.relay?.runtime ?? runtime });
  await registerFoundationManagementRoutes(app, options.foundation);
  await registerIdentityPreflightRoutes(app, options.identityPreflight);
  await registerScheduleManagementRoutes(app, options.schedule);
  if (options.automation) await registerSessionAutomationRoutes(app, options.automation);
  if (options.ciHooks) await registerCiHookRoutes(app, options.ciHooks);
  if (options.workItems) await registerWorkItemRoutes(app, options.workItems);
  if (options.workItemTools) await registerWorkItemTools(app, options.workItemTools);
  if (options.memoryTools) await registerLarkMemoryTools(app, options.memoryTools);
  if (options.memoryTools) await registerLarkMemoryTurnRoutes(app, { store: options.memoryTools.store,
    authorize: (request, sessionId) => requireSessionExecution(request, sessionId, 'session', 'task.view_result') });
  if (options.collaboration) await registerCollaborationRoutes(app, options.collaboration);
  if (options.usage) registerUsageRoutes(app, options.usage, (request, sessionId) => requireSessionExecution(request, sessionId, 'session', 'task.view_result'));
  await registerSystemRoutes(app, options.system);
  await registerLarkRoutes(app, { ...options.lark, runtime: options.lark?.runtime ?? runtime });
  app.get<{ Querystring: { excludeSessionId?: string } }>('/api/system/activity', async request => {
    const excludeSessionId = request.query.excludeSessionId?.trim() || undefined;
    return { runningTasks: runtime.getRunningTaskCount(excludeSessionId) };
  });
  app.get('/api/agents', async () => (await runtime.listAgents()).map(toPublicAgent));
  app.get<{ Params: { id: string }; Querystring: { model?: string; refresh?: string } }>('/api/agents/:id/models', async request => {
    const agent = (await runtime.listAgents()).find(item => item.id === request.params.id);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${request.params.id}`, 404);
    return discoverAgentModels(agent, request.query.model?.trim() || undefined, request.query.refresh === '1' || request.query.refresh === 'true');
  });
  app.get('/api/sessions', async request => {
    const sessions = await runtime.listSessions();
    if (!options.executionPolicy) return sessions;
    const visible = await Promise.all(sessions.map(async session => await canViewSession(request, session.id) ? session : undefined));
    return visible.filter(Boolean);
  });
  app.get('/api/sessions/summaries', async request => {
    const listed = await runtime.listSessions();
    const sessions = options.executionPolicy
      ? (await Promise.all(listed.map(async session => await canViewSession(request, session.id) ? session : undefined))).filter((session): session is typeof listed[number] => Boolean(session))
      : listed;
    const summaries = await Promise.all(sessions.map(async session => {
      const tasks = (await runtime.getTasks(session.id))
        .filter((task: any) => typeof task.prompt === 'string' && task.prompt.trim() && task.status !== 'cancelled')
        .sort((left: any, right: any) => left.createdAt.localeCompare(right.createdAt));
      const first = tasks[0];
      if (!first) return undefined;
      const latest = [...tasks].sort((left: any, right: any) => (right.updatedAt || right.createdAt).localeCompare(left.updatedAt || left.createdAt))[0] ?? first;
      return { sessionId: session.id, taskId: first.id, prompt: first.prompt.trim(), status: first.status, queuedCount: tasks.filter((task: any) => task.status === 'queued').length, updatedAt: latest.updatedAt || latest.createdAt };
    }));
    return summaries.filter(Boolean);
  });
  app.post<{ Body: { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode; workspaceMode?: 'shared' | 'worktree' } }>('/api/sessions', async request => {
    if (request.body.permissionMode !== undefined && !permissionModes.includes(request.body.permissionMode)) throw new RuntimeError('INVALID_PERMISSION_MODE', `Unknown permission mode: ${String(request.body.permissionMode)}`, 400);
    return runtime.start(request.body);
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    await requireSessionExecution(request, request.params.id, 'session', 'task.view_result');
    return (await runtime.getSession(request.params.id)) ?? reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/capabilities', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'task.view_result');
    const session = await runtime.getSession(request.params.id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    const driver = runtime.getDriver(request.params.id);
    const availability = (supported: boolean) => !driver ? 'unverified' : supported ? 'available' : 'unavailable';
    return {
      observedAt: new Date().toISOString(), protocol: session.protocol,
      structuredApproval: availability(typeof driver?.resolvePermission === 'function'),
      terminal: availability(typeof driver?.createTerminalStream === 'function'),
      turnRecovery: driver && !driver.recover ? 'unavailable' : 'unverified',
      verification: process.platform === 'linux' ? 'available' : 'unavailable',
      localFileDelivery: process.platform === 'linux' ? 'available' : 'unavailable'
    };
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/workspace', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'task.view_result');
    return await runtime.getWorkspace(request.params.id) ?? null;
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/workspace/cleanup', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'task.view_result');
    return runtime.getWorkspaceCleanupPreview(request.params.id);
  });
  app.post<{ Params: { id: string }; Body: { fingerprint?: string } }>('/api/sessions/:id/workspace/cleanup', async request => {
    await requireSessionExecution(request, request.params.id, 'high_risk', 'high_risk.execute');
    const fingerprint = request.body?.fingerprint;
    if (typeof fingerprint !== 'string' || !fingerprint.trim()) {
      throw new RuntimeError('INVALID_FINGERPRINT', '清理请求必须提供有效的工作区指纹', 400);
    }
    return runtime.cleanWorkspace(request.params.id, fingerprint.trim());
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/verifications', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'task.view_result');
    return runtime.getVerifications(request.params.id);
  });
  app.post<{ Params: { id: string }; Body: { command: string; timeoutSeconds?: number } }>('/api/sessions/:id/verifications', async request => {
    const decision = await requireSessionExecution(request, request.params.id, 'session', 'terminal.write');
    return runtime.runVerification(request.params.id, request.body, decision?.source === 'owner' ? installationOwnerTaskActor : undefined);
  });
  app.post<{ Params: { id: string }; Body: { prompt: string; mode?: 'queue' | 'interrupt' | 'steer'; skillRequests?: string[] } }>('/api/sessions/:id/send', async (request, reply) => {
    const prompt = request.body?.prompt?.trim();
    const requested = request.body?.mode ?? 'queue';
    if (!prompt) throw new RuntimeError('INVALID_PROMPT', 'Prompt must not be empty', 400);
    if (requested !== 'queue' && requested !== 'interrupt' && requested !== 'steer') throw new RuntimeError('INVALID_SEND_MODE', `Unknown send mode: ${String(requested)}`, 400);
    // 插话先按排队接收（完整的任务链路），再尝试送进正在执行的那一轮；送不进去就照常排队。
    const mode = requested === 'steer' ? 'queue' : requested;
    const skillRequests = request.body.skillRequests;
    if (skillRequests !== undefined && (!Array.isArray(skillRequests) || skillRequests.length > 16 || skillRequests.some(path => typeof path !== 'string' || !path.trim() || path.length > 4096))) throw new RuntimeError('INVALID_SKILL_REQUESTS', '请选择目录中的 Skill，最多 16 项', 400);
    const decision = await requireSessionExecution(request, request.params.id, 'session', 'turn.append');
    const task = decision?.source === 'owner'
      ? await runtime.dispatch(request.params.id, prompt, mode, prompt, undefined, installationOwnerTaskActor, undefined, skillRequests)
      : await runtime.dispatch(request.params.id, prompt, mode, prompt, undefined, undefined, undefined, skillRequests);
    if (requested !== 'steer') return reply.code(202).send({ accepted: true, task });
    // 这一条已经开跑（没有排队）也算按正常新一轮处理。
    let steering: { task: unknown; outcome: string; error?: string } = { task, outcome: 'promptRequired' };
    if (task.status === 'queued') {
      try { steering = await runtime.injectQueued(request.params.id, task.id, decision?.source === 'owner' ? installationOwnerTaskActor : undefined); }
      catch (error) {
        if (!(error instanceof RuntimeError && error.code === 'QUEUED_TASK_NOT_FOUND')) steering = { task, outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
        // 派发到插话之间这一条已经开跑或被取消：按它此刻的状态回报。
        else steering = { task: (await runtime.getTasks(request.params.id)).find(item => item.id === task.id) ?? task, outcome: 'moved' };
      }
    }
    return reply.code(202).send({ accepted: true, task: steering.task, steering: { outcome: steering.outcome, ...(steering.error ? { error: steering.error } : {}) } });
  });
  app.patch<{ Params: { id: string }; Body: { model?: string; reasoningEffort?: string } }>('/api/sessions/:id/config', async request => {
    const model = request.body?.model?.trim();
    if (model) {
      await requireSessionExecution(request, request.params.id, 'session', 'run.change_model');
      return runtime.setModel(request.params.id, model);
    }
    const reasoningEffort = request.body?.reasoningEffort?.trim();
    if (reasoningEffort) {
      await requireSessionExecution(request, request.params.id, 'session', 'run.change_model');
      return runtime.setReasoningEffort(request.params.id, reasoningEffort);
    }
    throw new RuntimeError('INVALID_SESSION_CONFIG', 'Model or reasoning effort is required', 400);
  });
  app.delete<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/queue/:taskId', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'queue.cancel');
    return runtime.cancelQueued(request.params.id, request.params.taskId);
  });
  app.post<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/queue/:taskId/steer', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'queue.promote');
    return runtime.steerQueued(request.params.id, request.params.taskId);
  });
  app.post<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/queue/:taskId/inject', async request => {
    const decision = await requireSessionExecution(request, request.params.id, 'session', 'queue.promote');
    return runtime.injectQueued(request.params.id, request.params.taskId, decision?.source === 'owner' ? installationOwnerTaskActor : undefined);
  });
  const sessionActionPolicy: Record<'interrupt' | 'pause' | 'resume' | 'stop' | 'restart', PolicyAction> = {
    interrupt: 'run.interrupt', pause: 'run.pause', resume: 'run.resume', stop: 'run.interrupt', restart: 'run.restart'
  };
  for (const action of ['interrupt', 'pause', 'resume', 'stop', 'restart'] as const) {
    app.post<{ Params: { id: string } }>(`/api/sessions/:id/${action}`, async request => {
      await requireSessionExecution(request, request.params.id, 'session', sessionActionPolicy[action]);
      const result = await runtime[action](request.params.id);
      return result ?? { ok: true };
    });
  }
  app.post<{ Params: { id: string } }>('/api/sessions/:id/archive', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'run.interrupt');
    return runtime.archive(request.params.id);
  });
  app.post<{ Params: { id: string; permissionId: string }; Body: { approved: boolean } }>('/api/sessions/:id/permissions/:permissionId', async request => {
    await requireSessionExecution(request, request.params.id, 'high_risk', 'high_risk.execute');
    return runtime.resolvePermission(request.params.id, request.params.permissionId, request.body.approved);
  });
  const parseEventCursor = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RuntimeError('INVALID_EVENT_CURSOR', `${name} must be a non-negative integer`, 400);
    return parsed;
  };
  const parseEventLimit = (value: string | undefined) => {
    const parsed = parseEventCursor(value, 'limit');
    if (parsed !== undefined && (parsed < 1 || parsed > 1_000)) throw new RuntimeError('INVALID_EVENT_LIMIT', 'limit must be an integer between 1 and 1000', 400);
    return parsed;
  };
  app.get<{ Params: { id: string }; Querystring: { after?: string; before?: string; limit?: string; direction?: string } }>('/api/sessions/:id/events', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'task.view_result');
    const { after, before, limit, direction } = request.query;
    if (direction !== undefined && direction !== 'forward' && direction !== 'backward') throw new RuntimeError('INVALID_EVENT_DIRECTION', `Unknown event direction: ${direction}`, 400);
    return runtime.getEventWindow(request.params.id, {
      afterSequence: parseEventCursor(after, 'after'),
      beforeSequence: parseEventCursor(before, 'before'),
      limit: parseEventLimit(limit),
      direction: (direction ?? (after !== undefined ? 'forward' : 'backward')) as 'forward' | 'backward'
    });
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/tasks', async request => {
    await requireSessionExecution(request, request.params.id, 'session', 'task.view_result');
    return runtime.getTasks(request.params.id);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/sessions/:id/stream', async (request, reply) => {
    await requireSessionExecution(request, request.params.id, 'session', 'task.view_result');
    const fromHeader = request.headers['last-event-id'];
    const queryAfter = parseEventCursor(request.query.after, 'after') ?? 0;
    const rawHeaderAfter = (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader);
    const headerAfter = parseEventCursor(rawHeaderAfter, 'Last-Event-ID') ?? 0;
    const after = Math.max(queryAfter, headerAfter);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let delivered = after;
    let replaying = true;
    let unsubscribe = () => {};
    let livePump: Promise<void> | undefined;
    const pendingLive: any[] = [];
    const drainClosers = new Set<() => void>();
    const maxPendingLive = 1_000;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      replaying = false;
      pendingLive.length = 0;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      for (const close of drainClosers) close();
      drainClosers.clear();
      streams.delete(reply.raw);
    };
    const waitForDrain = () => new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        reply.raw.off('drain', onDrain);
        drainClosers.delete(onClose);
        resolve(drained);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      drainClosers.add(onClose);
      reply.raw.once('drain', onDrain);
      if (closed || reply.raw.destroyed) onClose();
    });
    const writeChunk = async (chunk: string) => {
      if (closed || reply.raw.destroyed) return false;
      return reply.raw.write(chunk) || await waitForDrain();
    };
    const writeEvent = (event: any) => writeChunk(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const disconnectSlowClient = () => {
      cleanup();
      reply.raw.destroy();
    };
    const pumpLive = () => {
      if (livePump || closed || replaying) return;
      livePump = (async () => {
        while (!closed && pendingLive.length > 0) {
          const event = pendingLive.shift()!;
          if (event.sequence <= delivered) continue;
          if (!await writeEvent(event)) return;
          delivered = event.sequence;
        }
      })().finally(() => {
        livePump = undefined;
        if (!closed && pendingLive.length > 0) pumpLive();
      });
    };
    const enqueueLive = (event: any) => {
      if (closed || event.sequence <= delivered) return;
      if (pendingLive.length >= maxPendingLive) return disconnectSlowClient();
      pendingLive.push(event);
      pumpLive();
    };
    // Subscribe before replaying persisted events. Otherwise an event emitted
    // between getEvents() and subscribe() is neither in the replay nor live
    // stream and the client can keep stale task state forever. Sequence-based
    // filtering makes the overlap idempotent.
    unsubscribe = runtime.subscribe(request.params.id, enqueueLive);
    // Install cleanup before the replay await. A client can disconnect while
    // storage is still reading, and Node will not replay an already-fired close.
    request.raw.once('close', cleanup);
    try {
      if (!await writeChunk(': connected\n\n')) return;
      // A fresh stream only needs the latest visible window; reconnects page
      // forward in bounded batches so storage and heap never materialize an
      // unbounded session history at once. Waiting for drain also bounds the
      // socket buffer when a reconnecting client reads slowly.
      if (after === 0) {
        const replay = await runtime.getEventWindow(request.params.id, { direction: 'backward', limit: 200 });
        if (closed) return;
        for (const event of replay) {
          if (!await writeEvent(event)) return;
          delivered = Math.max(delivered, event.sequence);
        }
      } else {
        while (!closed) {
          const cursor = delivered;
          const replay = await runtime.getEventWindow(request.params.id, { afterSequence: cursor, direction: 'forward', limit: 1_000 });
          if (closed) return;
          for (const event of replay) {
            if (!await writeEvent(event)) return;
            delivered = Math.max(delivered, event.sequence);
          }
          if (replay.length < 1_000) break;
          if (delivered <= cursor) break;
        }
      }
      replaying = false;
      pendingLive.sort((left, right) => left.sequence - right.sequence);
      pumpLive();
    } catch (error) {
      const disconnected = closed;
      cleanup();
      if (disconnected) return;
      reply.raw.end();
      throw error;
    }
    if (!closed) heartbeat = setInterval(() => { if (!closed && !reply.raw.writableNeedDrain) reply.raw.write(': heartbeat\n\n'); }, 15_000);
  });

  if (options.webRoot) {
    const webRoot = resolve(options.webRoot);
    const indexFile = resolve(webRoot, 'index.html');
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      const pathname = new URL(request.url, 'http://dutydeck.local').pathname;
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
