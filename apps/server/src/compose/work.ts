import { createRelayContinuationChecker } from '../relay-routes.js';
import { LeaderDelegationService } from '../leader-delegation.js';
import { LeaderModeService } from '../leader-mode.js';
import { sha256Hex } from '../hash.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { workPlanConfirmationRequired } from '@dutydeck/shared';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkItemService } from '../work-items.js';
import { WorkItemInteractions } from '../work-item-interactions.js';
import { createWorkbenchFetch } from '../workbench-fetch.js';
import { authorizeWorkItemAgent, authorizeWorkItemInteraction } from '../work-item-policy.js';
import { createAutomationIntegration } from '../automation-integration.js';
import { createRelayAskStore } from '../relay-ask-store.js';
import { RelayAskBroker } from '@dutydeck/relay';
import type { ComposeContext } from './context.js';
import type { LarkGroupManager } from '../lark/group-management.js';

export function composeWork({ repos, config, env, log, lifecycle, channel }: ComposeContext,
  runtime: DutydeckRuntime, groupManager: LarkGroupManager, workbenchHttp: ReturnType<typeof createWorkbenchFetch>,
  automationIntegration: ReturnType<typeof createAutomationIntegration>) {
  const { LarkWorkbench } = channel;
  const loopLog = { warn: (details: Record<string, unknown>, message: string) => log.warn(details, message) };
  const authorizeWorkAgent = (sessionId: string, actorId: string, agentId: string) => authorizeWorkItemAgent(repos, groupManager, automationIntegration.authorize, sessionId, actorId, agentId);
  const workbench = new LarkWorkbench(repos, runtime, () => workItems, () => workInteractions, automationIntegration.authorize, { env, authorizeAgent: authorizeWorkAgent,
    leaderDecisions: workId => leaderMode.decisions(workId), log: { warn: (...args: any[]) => log.warn(...args as [unknown, string]) } });
  lifecycle.register('workbench', () => workbench.close());
  const workItems: WorkItemService = new WorkItemService({ repositories: repos, runtime, authorize: automationIntegration.authorize, authorizeAgent: authorizeWorkAgent,
    requireConfirmation: workPlanConfirmationRequired, log: loopLog,
    prepareDelivery: (sessionId, id, key) => workbench.prepareDelivery(sessionId, id, key), deliver: item => workbench.deliver(item),
    // Leader 模式目标的新请求先排上代判，再按代判后的可见请求刷新卡片。
    notify: (item, actorId) => { leaderMode.observe(item); return workbench.notify(item, actorId); },
    stepContext: (item, definition) => leaderMode.reviewContext(item, definition), answered: (workId, entry) => leaderMode.answered(workId, entry) });
  lifecycle.register('workItems', () => workItems.close());
  const delegations = new LeaderDelegationService({ repositories: repos, runtime, work: workItems, authorizeAgent: authorizeWorkAgent,
    prepareDelivery: (sessionId, id, key) => workbench.prepareDelivery(sessionId, id, key), notice: (workId, text, key) => workbench.notice(workId, text, key),
    log: { warn: (details, message) => log.warn(details, message) } });
  lifecycle.register('delegations', () => delegations.close());
  const relayBroker = new RelayAskBroker({
    async publish(sessionId, input) {
      await runtime.publishSessionEvent(sessionId, 'text', {
        text: input.text,
        relay: input.kind,
        ...(input.handledBy ? { handledBy: input.handledBy } : {}),
        ...(input.askId ? { askId: input.askId } : {})
      }, input.eventId);
    }
  }, createRelayAskStore(repos.config));
  const relayContinuation = createRelayContinuationChecker(runtime, async sessionId => (await groupManager.authorizeSession(sessionId, 'turn.append', false, false, { propagateRefreshErrors: true }))?.allowed !== false);
  const authorizeInteraction = (sessionId: string, actorId: string, action: 'high_risk.execute' | 'terminal.write' | 'terminal.read') => authorizeWorkItemInteraction(repos, groupManager, sessionId, actorId, action, env, workbenchHttp.fetch);
  const workInteractions: WorkItemInteractions = new WorkItemInteractions(workItems, runtime, relayBroker, authorizeInteraction, () => leaderMode);
  const leaderMode: LeaderModeService = new LeaderModeService({ repositories: repos, runtime, work: () => workItems, interactions: () => workInteractions, broker: relayBroker, authorizeAgent: authorizeWorkAgent, authorizeInteraction,
    resolveGroupConfig: (bot, chatId) => groupManager.resolved(bot, chatId),
    workspaceRoot: join(tmpdir(), 'dutydeck-leader', sha256Hex(resolve(config.databaseUrl)).slice(0, 16)), log: { warn: (details, message) => log.warn(details, message) } });
  lifecycle.register('leaderMode', () => leaderMode.close());
  lifecycle.register('relayClose', () => relayBroker.close(), false);
  lifecycle.register('relayFlush', () => relayBroker.flush(), false);
  const startDelegations = () => { void delegations.start().catch(error => log.warn({ error }, 'Leader 模式规划恢复失败')); };
  return { workbench, workItems, delegations, workInteractions, relayBroker, relayContinuation,
    start: { workItems: () => workItems.start(), delegations: startDelegations } };
}
