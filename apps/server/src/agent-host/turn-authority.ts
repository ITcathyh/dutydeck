import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseLarkSourceId, RuntimeError, type Session, type SessionRepository } from '@dutydeck/shared';
import { relayBearerToken as agentGroupToolBearerToken, type RelayCapabilityRegistry } from '@dutydeck/relay';
import { AgentGroupToolError, TurnTokens } from './turn-token.js';
import { stableMemoryCommand } from './stable-command.js';

export interface LarkAgentSessionBinding { sessionId: string; appId: string; chatId: string; chatType: 'group' | 'p2p'; threadId?: string; threadRootMessageId?: string }

export function larkAgentSessionBinding(session: Pick<Session, 'id' | 'source' | 'sourceId'>): LarkAgentSessionBinding | undefined {
  if (session.source !== 'lark' || !session.sourceId) return;
  const { appId, chatId, chatType, scope: rest } = parseLarkSourceId(session.sourceId);
  if (appId === undefined || chatId === undefined || chatType === undefined) return;
  if (!appId.startsWith('cli_')) return;
  // 飞书 message event 的 chat_id（包括 p2p）是 oc_*；兼容早期把对方 open_id
  // 持久化为 chatId 的 ou_* 记录，避免升级后旧会话突然失去工具能力。
  if (chatType === 'group') {
    if (!chatId.startsWith('oc_')) return;
    // thread 路由可锚到根消息 om_*，不能直接作为原生话题 omt_* 查询。
    const scope = rest[0] === 'thread' ? rest[1] : undefined;
    return { sessionId: session.id, appId, chatId, chatType: 'group',
      ...(scope?.startsWith('om_') ? { threadRootMessageId: scope } : scope ? { threadId: scope } : {}) };
  }
  if (chatType === 'p2p') {
    if (!chatId.startsWith('oc_') && !chatId.startsWith('ou_')) return;
    return { sessionId: session.id, appId, chatId, chatType: 'p2p' };
  }
  return;
}

export { agentGroupToolBearerToken };

type ActiveTask = { taskId: string; attemptId?: string; actorId?: string };
type ActiveTaskReader = (sessionId: string) => ActiveTask | undefined;
type AgentTurn = { sessionId: string; taskId: string; attemptId: string; actorId?: string; channel?: LarkAgentSessionBinding };
type Capability = { sessionId: string; channel?: LarkAgentSessionBinding; token: string };

export class TurnAuthority extends TurnTokens {
  private readonly byToken = new Map<string, Capability>();
  private readonly bySession = new Map<string, Capability>();
  private readonly requests = new AsyncLocalStorage<{ turn?: AgentTurn; presented?: string; read?: ActiveTaskReader }>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly apiBaseUrl: string,
    signingSecret?: string,
    private readonly command = 'dutydeck',
    private readonly issuance: { allowUnboundSessions?: boolean } = {}
  ) { super(signingSecret); }

  environmentFor(session: Session): Record<string, string> {
    const channel = larkAgentSessionBinding(session);
    if (!channel && !this.issuance.allowUnboundSessions) return {};
    let capability = this.bySession.get(session.id);
    if (!capability || capability.channel?.appId !== channel?.appId || capability.channel?.chatId !== channel?.chatId) {
      if (capability) this.byToken.delete(capability.token);
      const input = channel
        ? `dutydeck-group-tools-v1\0${session.id}\0${channel.appId}\0${channel.chatId}`
        : `dutydeck-session-tools-v1\0${session.id}`;
      const token = 'v1.' + createHmac('sha256', this.signingSecret).update(input).digest('base64url');
      capability = { sessionId: session.id, channel, token };
      this.bySession.set(session.id, capability);
      this.byToken.set(token, capability);
    }
    return {
      dutydeck_group_tools_url: `${this.apiBaseUrl.replace(/\/$/, '')}/api/lark/agent-tools`,
      dutydeck_group_tools_token: capability.token,
      dutydeck_group_tools_command: stableMemoryCommand(this.command)
    };
  }

  async resolveCapability(token?: string) {
    const capability = token ? this.byToken.get(token) : undefined;
    if (!capability) throw new AgentGroupToolError('GROUP_TOOL_UNAUTHORIZED', '群协作工具凭证缺失或无效。该工具只能在 Dutydeck 飞书会话内使用。', 401);
    const session = await this.sessions.get(capability.sessionId);
    const channel = session && larkAgentSessionBinding(session);
    if (!session || session.archivedAt || ['failed', 'stopped'].includes(session.state)
      || channel?.appId !== capability.channel?.appId || channel?.chatId !== capability.channel?.chatId) {
      throw new AgentGroupToolError('GROUP_TOOL_SESSION_EXPIRED', '当前 Dutydeck 飞书会话已结束，群协作工具凭证不再有效。', 401);
    }
    return { session, channel };
  }

  private requireChannel(channel?: LarkAgentSessionBinding) {
    if (!channel) throw new AgentGroupToolError('CHANNEL_BINDING_REQUIRED', '需要渠道绑定', 403);
    return channel;
  }

  async resolveSession(token?: string) {
    const { session, channel } = await this.resolveCapability(token);
    return { session, binding: this.requireChannel(channel) };
  }

  async resolve(token?: string) { return (await this.resolveSession(token)).binding; }

  runInRequestScope(next: () => void) { this.requests.run({}, next); }

  async resolveCapabilityTurn(token: string | undefined, presented: string | undefined, read?: ActiveTaskReader) {
    const { session, channel } = await this.resolveCapability(token);
    const turn = this.resolveTurn(session.id, read?.(session.id), presented, channel);
    return { ...turn, session, channel };
  }

  async resolveChannelTurn(token: string | undefined, presented: string | undefined, read?: ActiveTaskReader) {
    const turn = await this.resolveCapabilityTurn(token, presented, read);
    return { ...turn, channel: this.requireChannel(turn.channel) };
  }

  async bindRequestTurn(token: string | undefined, presented: string | undefined, read?: ActiveTaskReader) {
    const turn = await this.resolveChannelTurn(token, presented, read);
    const scope = this.requests.getStore();
    if (scope) Object.assign(scope, { turn, presented, read });
  }

  requestTurn(sessionId: string) {
    const scope = this.requests.getStore();
    if (scope?.turn) this.assertCurrent(scope.turn, sessionId, scope.read?.(sessionId));
    return scope?.turn;
  }

  private assertCurrent(turn: AgentTurn, sessionId: string, active?: ActiveTask) {
    if (sessionId !== turn.sessionId || active?.taskId !== turn.taskId || active?.attemptId !== turn.attemptId || active?.actorId !== turn.actorId) {
      throw new AgentGroupToolError('WORK_ITEM_TURN_EXPIRED', '任务尝试已结束，请使用本轮提供的完整 agent --turn 命令前缀。', 403);
    }
  }

  resolveTurn(sessionId: string, active: ActiveTask | undefined, presented?: string, channel?: LarkAgentSessionBinding): AgentTurn {
    const scope = this.requests.getStore();
    if (scope?.turn) {
      this.assertCurrent(scope.turn, sessionId, active);
      if (scope.presented === presented) return scope.turn;
    }
    this.assertWorkbenchTurn(sessionId, active?.taskId ?? '', active?.attemptId, presented);
    return { sessionId, taskId: active!.taskId, attemptId: active!.attemptId!, actorId: active!.actorId, channel };
  }

  async resolveRelayTurn(relay: RelayCapabilityRegistry, token: string | undefined, sessionId: string,
    presented: string | undefined, read: ActiveTaskReader) {
    await relay.resolve(token, sessionId);
    const session = await this.sessions.get(sessionId);
    const active = read(sessionId);
    if (!session || !active?.attemptId) throw new RuntimeError('PLUGIN_TOOL_TURN_EXPIRED', 'No active task attempt', 403);
    try {
      const turn = this.resolveTurn(sessionId, active, presented, larkAgentSessionBinding(session));
      return { session, ...turn };
    } catch { throw new RuntimeError('PLUGIN_TOOL_TURN_EXPIRED', 'Use the current task attempt token', 403); }
  }

  close() {
    this.byToken.clear();
    this.bySession.clear();
  }
}

type ActorTool = 'work' | 'request' | 'collaboration';
const missingActor = {
  work: ['WORK_ITEM_ACTIVE_ACTOR_REQUIRED', '编排工具只接受当前正在执行的飞书指令'],
  request: ['AGENT_REQUEST_ACTOR_REQUIRED', '只能在正在执行的飞书指令里代办。'],
  collaboration: ['COLLABORATION_ACTIVE_ACTOR_REQUIRED', '协作工具只接受当前正在执行的群指令。']
} as const;

export async function resolveActorTurn<T extends { sessionId: string }>(
  request: FastifyRequest, family: ActorTool, runtime: { getActiveTaskContext: ActiveTaskReader },
  turns: TurnAuthority, context: (token?: string) => Promise<T>, rejectAutomated?: (taskId: string) => boolean
) {
  const binding = await context(agentGroupToolBearerToken(request.headers.authorization));
  const active = runtime.getActiveTaskContext(binding.sessionId);
  if (!active?.actorId) {
    const [code, message] = missingActor[family];
    throw new RuntimeError(code, message, 403);
  }
  if (rejectAutomated?.(active.taskId)) throw new RuntimeError('AGENT_REQUEST_AUTOMATED', '定时任务或自动续作执行的这一轮不能代办。', 403);
  const turn = request.headers['x-dutydeck-work-turn'];
  const current = turns.resolveTurn(binding.sessionId, active, typeof turn === 'string' ? turn : undefined);
  return { ...current, binding, actorId: active.actorId };
}

/** Attach only to the Agent capability endpoints, including memory and plugin result tools. */
export function registerLarkAgentToolTurnGuard(app: FastifyInstance, service: { runInRequestScope(next: () => void): void; bindRequestTurn(token?: string, presented?: string): Promise<void> }) {
  app.addHook('onRoute', route => {
    if (!route.url.startsWith('/api/lark/agent-tools/')) return;
    const onRequest = route.onRequest ? (Array.isArray(route.onRequest) ? route.onRequest : [route.onRequest]) : [];
    route.onRequest = [(_request, _reply, done) => service.runInRequestScope(done), ...onRequest];
    const preHandler = route.preHandler ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]) : [];
    route.preHandler = [async request => {
      const body = request.body as { turn?: unknown } | undefined;
      const presented = request.headers['x-dutydeck-work-turn'] ?? request.headers['x-dutydeck-result-turn'] ?? body?.turn;
      await service.bindRequestTurn(agentGroupToolBearerToken(request.headers.authorization), typeof presented === 'string' ? presented : undefined);
    }, ...preHandler];
  });
}
