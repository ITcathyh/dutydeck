import type { HerdrSessions } from './herdr.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import {
  RelayAskBroker,
  RelayCapabilityRegistry,
  RelayError,
  RelayService,
  type RelayEventPublisher,
  type RelayPublishInput
} from '@dutydeck/relay';
import { HookPermissionRequests } from './permission-hook.js';

export interface RelayRoutesOptions {
  runtime?: DutydeckRuntime;
  herdr?: HerdrSessions;
  capabilities?: RelayCapabilityRegistry;
  broker?: RelayAskBroker;
  service?: RelayService;
  permissions?: HookPermissionRequests;
  authorize?(request: FastifyRequest, sessionId: string, action: 'task.view_result' | 'turn.append'): Promise<void>;
}

/** Only child-to-host relay calls use the session HMAC as their sole credential. */
export const isRelayCapabilityRequest = (method: string, pathname: string) =>
  method.toUpperCase() === 'POST'
  && /^\/api\/relay\/sessions\/[^/]+\/(?:send|ask|deferred-ack|herdr|permission)$/.test(pathname);

/** 会话进入这些状态时，把该会话所有阻塞中的 ask 唤醒 */
const terminalStates = new Set(['stopped', 'failed']);
const endedTaskStates = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'reconcile_required']);

/**
 * 事件流投递适配器：把 relay 的抽象消息映射成 runtime 的 `text` 事件。
 *
 * 为什么复用 `text` 而不是新增事件类型：`eventTypes` 是 @dutydeck/shared 里的
 * 封闭联合（driver 契约的一部分），新增一类要同时改 shared / web 时间线 /
 * 使用 `text` + `data.relay` 判别字段落地，Web 与飞书卡片沿用统一文本展示；
 * 消费方需要区分来源时读取 `data.relay`。
 *
 * role 的取舍：
 *  - send / ask 是 Agent 在说话 → assistant 侧（不设 role，消费方默认 assistant）
 *  - answer 是用户在说话，但**故意不标 role:'user'**。Web 时间线把
 *    `role==='user'` 当作「新一轮的起点」（buildTimelineSections 按用户消息切轮次），
 *    且 `legacyPrompts` 会按「无 taskId 的 user 文本」去重任务提示——
 *    中途插入一条 user 文本会切碎轮次、甚至顶掉真实任务的 prompt 显示。
 *    所以答案同样走 assistant 侧，靠 `data.relay==='answer'` 区分来源。
 */
function createRuntimePublisher(runtime: DutydeckRuntime): RelayEventPublisher {
  return {
    async publish(sessionId: string, input: RelayPublishInput) {
      await runtime.publishSessionEvent(sessionId, 'text', {
        text: input.text,
        relay: input.kind,
        ...(input.askId ? { askId: input.askId } : {})
      });
    }
  };
}

function handleRelayError(error: unknown, reply: FastifyReply) {
  if (error instanceof RelayError) return reply.code(error.statusCode).send(error.response());
  throw error;
}

/**
 * 注册通用回传通道路由。
 *
 * 认证分两套，不要混：
 *  - `/send`、`/ask` 由**会话内的 CLI 子进程**调用，凭 `Authorization: Bearer <会话能力 token>`
 *    证明自己属于哪个会话；sessionId 从 token 校验得出，调用方无法自报别的会话。
 *  - `/asks`、`/answer` 由**人类用户**从 Web/IM 调用，走 app.ts 的常规访问认证
 *    （远程监听需 access token），不需要会话能力 token。
 *
 * `/send`、`/ask` 在中央访问认证处做精确豁免，因为 HTTP Authorization 只能承载
 * 一枚 Bearer，而这里必须承载会话 HMAC。其余 relay 路由仍由中央 access token 保护。
 */
export function registerRelayRoutes(app: FastifyInstance, options: RelayRoutesOptions = {}) {
  const runtime = options.runtime;
  const broker = options.broker ?? (runtime ? new RelayAskBroker(createRuntimePublisher(runtime)) : undefined);
  const capabilities = options.capabilities;
  const service = options.service
    ?? (runtime && capabilities && broker
      ? new RelayService(capabilities, createRuntimePublisher(runtime), broker)
      : undefined);
  if (!service || !broker) return;

  const deferredTurns = new Map<string, { sessionId: string; taskId: string; actorId?: string; timer?: NodeJS.Timeout; ended?: Promise<void> }>();
  const endDeferredTurn = (askId: string) => {
    const turn = deferredTurns.get(askId);
    if (!turn || !runtime) return Promise.resolve();
    clearTimeout(turn.timer);
    return turn.ended ??= runtime.interrupt(turn.sessionId, turn.taskId, turn.actorId).then(() => undefined, error => {
      // A newer turn is never interrupted by this old confirmation's ACK.
      if ((error as { code?: string }).code !== 'TASK_NOT_ACTIVE') app.log.warn({ error, askId }, 'Ending deferred confirmation turn failed');
    }).finally(() => {
      turn.timer = setTimeout(() => deferredTurns.delete(askId), 60_000);
      turn.timer.unref();
    });
  };
  app.post<{ Params: { id: string }; Body: { askId?: string } }>('/api/relay/sessions/:id/deferred-ack', async (request, reply) => {
    try {
      const capability = service.verifySession(request.headers.authorization, request.params.id);
      const askId = request.body?.askId ?? '';
      const turn = deferredTurns.get(askId);
      if (!turn || turn.sessionId !== capability.sessionId) throw new RelayError('RELAY_DEFERRED_NOT_FOUND', '未知的持久确认回执。', 404);
      reply.raw.once('finish', () => { void endDeferredTurn(askId); });
      return { ok: true };
    } catch (error) { return handleRelayError(error, reply); }
  });

  // 会话终态唤醒：ask 阻塞期间会话被 stop/archive/崩溃，必须把等待者放出来，
  // 否则 CLI 子进程会一直挂在那次 HTTP 长轮询上。只用公开的 runtime.subscribe。
  type Waiter = { taskId?: string; attemptId?: string; controller: AbortController };
  const watched = new Map<string, { waiters: Set<Waiter>; unsubscribe(): void }>();
  const unwatch = (sessionId: string, entry = watched.get(sessionId)) => {
    if (!entry || watched.get(sessionId) !== entry) return;
    entry.unsubscribe();
    watched.delete(sessionId);
  };
  const watchSession = (sessionId: string, waiter: Waiter) => {
    if (!runtime) return;
    let entry = watched.get(sessionId);
    if (!entry) {
      const current = { waiters: new Set<Waiter>(), unsubscribe: () => {} };
      current.unsubscribe = runtime.subscribe(sessionId, event => {
        const data = event.data as { state?: string; task?: { id: string; status: string } } | undefined;
        if (event.type === 'task' && data?.task && endedTaskStates.has(data.task.status)) {
          for (const waiting of current.waiters) {
            if (waiting.taskId === data.task.id && (!waiting.attemptId || waiting.attemptId === event.attemptId)) waiting.controller.abort('任务已结束');
          }
        }
        if (event.type !== 'status' || !data?.state || !terminalStates.has(data.state)) return;
        const reason = `会话已${data.state === 'stopped' ? '停止' : '失败'}`;
        for (const waiting of current.waiters) waiting.controller.abort(reason);
        broker.cancelSession(sessionId, reason);
        unwatch(sessionId, current);
      });
      watched.set(sessionId, current);
      entry = current;
    }
    entry.waiters.add(waiter);
    const current = entry;
    return () => { current.waiters.delete(waiter); if (current.waiters.size === 0) unwatch(sessionId, current); };
  };

  app.addHook('onClose', async () => {
    for (const turn of deferredTurns.values()) clearTimeout(turn.timer);
    deferredTurns.clear();
    for (const sessionId of [...watched.keys()]) unwatch(sessionId);
    // daemon 关停也要唤醒并取消所有等待中的 ask 请求
    broker.close();
  });

  if (options.herdr && runtime) app.post<{ Params: { id: string }; Body: { action?: string } }>('/api/relay/sessions/:id/herdr', async (request, reply) => {
    try {
      const capability = await service.resolveSession(request.headers.authorization, request.params.id);
      const session = await runtime.getSession(capability.sessionId);
      if (!session) throw new RelayError('HERDR_SESSION_MISSING', 'Dutydeck 会话不存在。', 404);
      if (request.body?.action === 'prepare') return await options.herdr!.prepare(session);
      if (request.body?.action === 'stop') return await options.herdr!.stop(session.id);
      throw new RelayError('HERDR_INVALID_ACTION', 'Herdr 入口仅支持 prepare 或 stop。', 400);
    } catch (error) { return handleRelayError(error, reply); }
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>('/api/relay/sessions/:id/send', async (request, reply) => {
    try {
      return await service.send(request.headers.authorization, request.params.id, request.body ?? {});
    } catch (error) { return handleRelayError(error, reply); }
  });

  app.post<{ Params: { id: string }; Body: { question?: string; timeoutMs?: number } }>('/api/relay/sessions/:id/ask', async (request, reply) => {
    let release: (() => void) | undefined;
    try {
      // 首次 await 前用已验签的身份绑定任务和监听；异步存活查询期间任务可能已结束并清除 activeTask。
      const capability = service.verifySession(request.headers.authorization, request.params.id);
      const owner = runtime?.getActiveTaskContext(capability.sessionId);
      const controller = new AbortController();
      release = watchSession(capability.sessionId, { ...owner, controller });
      await service.resolveSession(request.headers.authorization, request.params.id);
      // The durable settlement may already precede subscription while the
      // in-memory active task is still being cleaned up.
      if (owner && endedTaskStates.has((await runtime!.getTaskRecovery(capability.sessionId, owner.taskId)).status)) controller.abort('任务已结束');
      const outcome = await service.ask(request.headers.authorization, request.params.id, request.body ?? {}, { ...owner, signal: controller.signal });
      // 长轮询结果一律 200：answered / expired / cancelled 都是通道正常工作的结果，
      // CLI 侧据 status 决定退出码，不靠 HTTP 状态码区分。
      if (outcome.status === 'deferred' && runtime && owner) {
        // Flush the explicit deferred result before ending the original driver turn.
        // The expected task fence prevents a late response from interrupting another turn.
        deferredTurns.set(outcome.askId, { sessionId: capability.sessionId, taskId: owner.taskId, actorId: owner.actorId });
        reply.raw.once('finish', () => {
          const turn = deferredTurns.get(outcome.askId)!;
          // Supported CLI clients ACK after flushing their explicit result. Unknown
          // clients cannot keep executing indefinitely by omitting that handshake.
          turn.timer = setTimeout(() => {
            app.log.warn({ askId: outcome.askId }, 'Deferred confirmation was not acknowledged; ending original turn');
            void endDeferredTurn(outcome.askId);
          }, 5_000);
          turn.timer.unref();
        });
      }
      return outcome;
    } catch (error) { return handleRelayError(error, reply); }
    finally { release?.(); }
  });

  // Claude PermissionRequest hook 的短轮询入口：首次带工具事实登记，之后带 permissionId 续等，直到拿到裁决。
  const permissions = options.permissions ?? (runtime ? new HookPermissionRequests(runtime) : undefined);
  if (permissions) app.post<{ Params: { id: string } }>('/api/relay/sessions/:id/permission', async (request, reply) => {
    try {
      const capability = await service.resolveSession(request.headers.authorization, request.params.id);
      return await permissions.submit(capability.sessionId, request.body ?? {});
    } catch (error) { return handleRelayError(error, reply); }
  });

  app.get<{ Params: { id: string } }>('/api/relay/sessions/:id/asks', async (request, reply) => {
    try {
      if ((await runtime?.getSession(request.params.id))?.source === 'work_item') throw new RuntimeError('WORK_ITEM_MANAGED_SESSION', '请从目标查看和回答步骤提问', 403);
      await options.authorize?.(request, request.params.id, 'task.view_result');
      return service.listPending(request.params.id);
    }
    catch (error) { return handleRelayError(error, reply); }
  });

  app.post<{ Params: { id: string; askId: string }; Body: { answer?: string } }>('/api/relay/sessions/:id/asks/:askId/answer', async (request, reply) => {
    try {
      if ((await runtime?.getSession(request.params.id))?.source === 'work_item') throw new RuntimeError('WORK_ITEM_MANAGED_SESSION', '请从目标查看和回答步骤提问', 403);
      const ask = await service.answer(request.params.id, request.params.askId, request.body ?? {},
        async () => { await options.authorize?.(request, request.params.id, 'turn.append'); });
      return { ok: true, ask };
    } catch (error) { return handleRelayError(error, reply); }
  });
}
