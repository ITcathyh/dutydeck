import type { FastifyInstance, FastifyReply } from 'fastify';
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

export interface RelayRoutesOptions {
  runtime?: DutydeckRuntime;
  capabilities?: RelayCapabilityRegistry;
  broker?: RelayAskBroker;
  service?: RelayService;
}

/** Only child-to-host relay calls use the session HMAC as their sole credential. */
export const isRelayCapabilityRequest = (method: string, pathname: string) =>
  method.toUpperCase() === 'POST'
  && /^\/api\/relay\/sessions\/[^/]+\/(?:send|ask)$/.test(pathname);

/** 会话进入这些状态时，把该会话所有阻塞中的 ask 唤醒 */
const terminalStates = new Set(['stopped', 'failed']);

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

  // 会话终态唤醒：ask 阻塞期间会话被 stop/archive/崩溃，必须把等待者放出来，
  // 否则 CLI 子进程会一直挂在那次 HTTP 长轮询上。只用公开的 runtime.subscribe。
  const watched = new Map<string, () => void>();
  const watchSession = (sessionId: string) => {
    if (!runtime || watched.has(sessionId)) return;
    const unsubscribe = runtime.subscribe(sessionId, event => {
      const state = (event.data as { state?: string } | undefined)?.state;
      if (event.type !== 'status' || !state || !terminalStates.has(state)) return;
      broker.cancelSession(sessionId, `会话已${state === 'stopped' ? '停止' : '失败'}`);
      unwatch(sessionId);
    });
    watched.set(sessionId, unsubscribe);
  };
  const unwatch = (sessionId: string) => {
    watched.get(sessionId)?.();
    watched.delete(sessionId);
  };

  app.addHook('onClose', async () => {
    for (const sessionId of [...watched.keys()]) unwatch(sessionId);
    // daemon 关停也要唤醒，等价于 botmux ask broker 的 invalidateAll
    broker.close();
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>('/api/relay/sessions/:id/send', async (request, reply) => {
    try {
      return await service.send(request.headers.authorization, request.params.id, request.body ?? {});
    } catch (error) { return handleRelayError(error, reply); }
  });

  app.post<{ Params: { id: string }; Body: { question?: string; timeoutMs?: number } }>('/api/relay/sessions/:id/ask', async (request, reply) => {
    try {
      // 先反解会话再注册终态唤醒：必须在阻塞之前挂上监听，
      // 否则「注册监听」这一步永远等不到执行，会话结束时无人唤醒。
      const capability = await service.resolveSession(request.headers.authorization, request.params.id);
      watchSession(capability.sessionId);
      const outcome = await service.ask(request.headers.authorization, request.params.id, request.body ?? {});
      // 长轮询结果一律 200：answered / expired / cancelled 都是通道正常工作的结果，
      // CLI 侧据 status 决定退出码，不靠 HTTP 状态码区分。
      return outcome;
    } catch (error) { return handleRelayError(error, reply); }
  });

  app.get<{ Params: { id: string } }>('/api/relay/sessions/:id/asks', async (request, reply) => {
    try {
      if ((await runtime?.getSession(request.params.id))?.source === 'work_item') throw new RuntimeError('WORK_ITEM_MANAGED_SESSION', '请从目标查看和回答步骤提问', 403);
      return service.listPending(request.params.id);
    }
    catch (error) { return handleRelayError(error, reply); }
  });

  app.post<{ Params: { id: string; askId: string }; Body: { answer?: string } }>('/api/relay/sessions/:id/asks/:askId/answer', async (request, reply) => {
    try {
      if ((await runtime?.getSession(request.params.id))?.source === 'work_item') throw new RuntimeError('WORK_ITEM_MANAGED_SESSION', '请从目标查看和回答步骤提问', 403);
      const ask = await service.answer(request.params.id, request.params.askId, request.body ?? {});
      return { ok: true, ask };
    } catch (error) { return handleRelayError(error, reply); }
  });
}
