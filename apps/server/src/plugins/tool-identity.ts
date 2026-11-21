import { canonicalExecutionJson, RuntimeError, type RepositoryBundle, type PluginToolIdentity } from '@dutydeck/shared';
import type { RelayCapabilityRegistry } from '@dutydeck/relay';
import type { TurnAuthority } from '../agent-host/turn-authority.js';
import { isAutomatedRequest } from '../agent-request-tools.js';
import type { PluginToolAuthorityResolver } from './tool-service.js';

export class TaskPluginToolIdentity implements PluginToolAuthorityResolver {
  constructor(private readonly repositories: RepositoryBundle, private readonly relay: RelayCapabilityRegistry, private readonly turns: TurnAuthority, private readonly runtime: { getActiveTaskContext(id: string): { taskId: string; attemptId?: string; actorId?: string } | undefined }) {}
  async resolve(token?: string, turn?: string) {
    let sessionId: string;
    try { sessionId = (await this.relay.resolve(token)).sessionId; }
    catch { throw new RuntimeError('PLUGIN_TOOL_UNAUTHORIZED', 'A valid session capability is required', 401); }
    const read = async (): Promise<PluginToolIdentity> => {
      const active = await this.turns.resolveRelayTurn(this.relay, token, sessionId, turn, id => this.runtime.getActiveTaskContext(id));
      const { session, channel: lark } = active;
      const accepted = this.repositories.execution.getAcceptedTask(active.taskId);
      const request = accepted?.request;
      const actor = request?.actor;
      if (!accepted || request?.sessionId !== sessionId || actor?.kind === 'unspecified' || !actor || isAutomatedRequest(request) || accepted.task.currentAttemptId !== active.attemptId || !['running'].includes(accepted.task.status)) throw new RuntimeError('PLUGIN_TOOL_REQUESTER_REQUIRED', 'A running human-requested task is required', 403);
      const attempt = this.repositories.execution.getAttempt({ sessionId, runId: session.runId, taskId: active.taskId, attemptId: active.attemptId });
      if (!attempt || attempt.outcome || attempt.state === 'reconcile_required') throw new RuntimeError('PLUGIN_TOOL_TURN_EXPIRED', 'Attempt is no longer live', 403);
      if (lark && actor.kind !== 'channel') throw new RuntimeError('PLUGIN_TOOL_REQUESTER_REQUIRED', 'Channel task must have a channel actor', 403);
      if (actor.kind === 'channel' && (!lark || actor.appId !== lark.appId || actor.id !== active.actorId)) throw new RuntimeError('PLUGIN_TOOL_REQUESTER_REQUIRED', 'Channel identity does not match the task', 403);
      if (!lark && actor.kind !== 'installation_owner') throw new RuntimeError('PLUGIN_TOOL_REQUESTER_REQUIRED', 'Web task must have an authenticated installation owner', 403);
      return { sessionId, runId: session.runId, taskId: active.taskId, attemptId: active.attemptId, actor, channel: lark ? 'lark' : 'web', ...(lark ? { botAppId: lark.appId, chatId: lark.chatId } : {}), cwd: session.cwd, workspaceRoot: session.workspaceSourceCwd ?? session.cwd };
    };
    const identity = await read();
    const snapshot = canonicalExecutionJson(identity);
    return { identity, assertCurrent: async () => { if (canonicalExecutionJson(await read()) !== snapshot) throw new RuntimeError('PLUGIN_TOOL_TURN_EXPIRED', 'Task identity changed', 403); } };
  }
}
