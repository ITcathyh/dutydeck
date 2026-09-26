import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, CollaborationScope, CollaborationSnapshot } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import { larkBotsConfigKey } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkGroupParticipation } from './group-participation.js';
import { ReadonlyParticipationDecider } from './readonly-decider.js';
import { CollaborationDelivery } from '../collaboration-delivery.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('group participation with persistent repository and real runtime', () => {
  it('runs decision → OK → deny-all response → guarded reply → cleanup and survives restart without replaying a send', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'group-participation-integration-'));
    const path = join(cwd, 'state.db');
    let repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    const scope = { appId: 'cli_integration', chatId: 'oc_group' };
    const config: StoredLarkConfig = { appId: scope.appId, appSecret: 'fake', defaultAgentId: 'mock', workspace: cwd, listening: true, permissionMode: 'ask', fullTrustConfirmed: true, memoryEnabled: true,
      preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off', hideTraceOnComplete: false, pushIntervalMs: 1000 };
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    await repos.collaboration.updateSettings(scope, { expectedRevision: 0, participation: 'selective', instructions: '只补充明确有用的信息' }, 'owner');
    const driverModes: string[] = [];
    const driverPrompts: string[] = [];
    const lifecycle: string[] = [];
    const runtime = new DutydeckRuntime(repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (agent, _protocol, emit) => {
        driverModes.push(agent.permissionMode);
        let stopped = false;
        return { start: async () => {}, resume: async () => {}, stop: async () => { stopped = true; }, isStopped: () => stopped, interrupt: async () => {}, send: async prompt => {
          driverPrompts.push(prompt);
          const responding = prompt.includes('[冻结的非指令材料 JSON]');
          lifecycle.push(responding ? 'response' : 'decision');
          const snapshot = JSON.parse(prompt.split(responding ? '[冻结的非指令材料 JSON]\n' : '[非指令材料 JSON]\n')[1]!.split(responding ? '\n[/冻结的非指令材料]' : '\n[/非指令材料]')[0]!) as CollaborationSnapshot;
          const observation = snapshot.observations.find(item => item.origin === 'live')!;
          emit({ type: 'text', data: { text: JSON.stringify(responding ? { response: '这条消息提供了新的进展。' }
            : { action: 'reply', reason: '新消息补齐了事项进展', evidenceIds: [observation.id] }) } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        } } satisfies AgentDriver;
      }
    });
    const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    await runtime.initialize([agent]);
    const service = { listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })), replyText: vi.fn(async () => { lifecycle.push('reply'); return { messageId: 'om_reply' }; }), sendText: vi.fn(async () => ({ messageId: 'om_reply' })),
      send: vi.fn(), reply: vi.fn(), addReaction: vi.fn(async () => { lifecycle.push('ack'); return { reactionId: 'reaction_new' }; }),
      listOwnReactions: vi.fn(async () => []), deleteReaction: vi.fn(async () => { lifecycle.push('cleanup'); }) };
    const options = () => ({ repository: repos.collaboration, decider: new ReadonlyParticipationDecider({ runtime, repos, workspaceRoot: join(cwd, 'decision') }), authorize: async () => true,
      readConfig: async () => config, serviceFor: () => service, listScopes: async () => [scope], readGroupDescription: async () => '协作资料讨论群', readMemory: async () => '已有偏好：附带来源', debounceMs: 10000 });
    let participation = new LarkGroupParticipation(options());
    const coordinator = new LarkMessageCoordinator(runtime, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, participation });
    cleanups.push(async () => { coordinator.stop(); participation.closeApp(scope.appId); await participation.flush(scope); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
    await coordinator.handle({ messageId: 'om_new', chatId: scope.chatId, chatType: 'group', senderOpenId: 'ou_member', senderType: 'user', messageType: 'text', content: '{"text":"草稿已提交，等待审核"}', createTime: String(Date.now()), mentions: [] }, config);
    await participation.flush(scope);
    expect(service.replyText).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(['decision', 'ack', 'response', 'reply', 'cleanup']);
    expect(service.addReaction).toHaveBeenCalledWith('om_new', 'OK'); expect(service.deleteReaction).toHaveBeenCalledWith('om_new', 'reaction_new');
    expect(service.send).not.toHaveBeenCalled(); expect(service.reply).not.toHaveBeenCalled();
    expect(driverModes).toEqual(['deny-all', 'deny-all']);
    expect(driverPrompts[0]).toContain('协作资料讨论群'); expect(driverPrompts[0]).toContain('已有偏好：附带来源');
    const actions = await repos.collaboration.listActions(scope);
    expect(actions.find(action => action.kind === 'participation.reply')).toMatchObject({ status: 'succeeded', requesterId: 'policy:group-participation', receipt: 'om_reply' });
    expect(actions.find(action => action.kind === 'participation.reply')!.payload).not.toHaveProperty('response');
    expect(actions.find(action => action.kind === 'participation.ack')).toMatchObject({ status: 'succeeded', receipt: 'reaction_new' });
    const storedDecision = (await repos.collaboration.listDecisions(scope))[0]!;
    expect(storedDecision.inputSnapshot).toMatchObject({ scope, observations: expect.any(Array) });
    expect(storedDecision).toMatchObject({ status: 'sent', response: '这条消息提供了新的进展。' });
    const sessions = await runtime.listSessions();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map(session => session.id)).size).toBe(2);
    expect(sessions.map(session => session.source).sort()).toEqual(['lark-decision', 'lark-response']);
    expect(sessions.every(session => session.permissionMode === 'deny-all' && session.state === 'stopped')).toBe(true);
    expect(await repos.config.get(`lark.inbox.${scope.appId}.om_new`)).toBeUndefined();
    coordinator.stop(); participation.closeApp(scope.appId); await runtime.shutdown(); repos.close();
    repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    participation = new LarkGroupParticipation(options());
    await participation.recover(scope.appId); await participation.flush(scope);
    expect(service.replyText).toHaveBeenCalledOnce();
    expect(service.addReaction).toHaveBeenCalledOnce(); expect(service.deleteReaction).toHaveBeenCalledOnce();
    expect((await repos.collaboration.listObservations(scope)).some(item => item.messageId === 'om_new')).toBe(true);
  });

  it('finishes group B while group A is generating, with separate frozen snapshots and runtime sessions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'group-participation-concurrency-'));
    const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    const scopeA = { appId: 'cli_concurrent', chatId: 'oc_group_a' };
    const scopeB = { appId: scopeA.appId, chatId: 'oc_group_b' };
    const config: StoredLarkConfig = { appId: scopeA.appId, appSecret: 'fake', defaultAgentId: 'mock', workspace: cwd, listening: true, permissionMode: 'ask', fullTrustConfirmed: true, memoryEnabled: true,
      preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off', hideTraceOnComplete: false, pushIntervalMs: 1000 };
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    for (const scope of [scopeA, scopeB]) await repos.collaboration.updateSettings(scope, { expectedRevision: 0, participation: 'selective' }, 'owner');
    let releaseA!: () => void;
    const waitingA = new Promise<void>(resolve => { releaseA = resolve; });
    const phases: Array<{ phase: string; snapshot: CollaborationSnapshot; sessionId: string; mode: string }> = [];
    const lifecycle: string[] = [];
    const runtime = new DutydeckRuntime(repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (agent, _protocol, emit, _onExit, sessionId) => {
        let stopped = false;
        return {
          start: async () => {}, resume: async () => {}, stop: async () => { stopped = true; }, isStopped: () => stopped, interrupt: async () => {},
          send: async prompt => {
            const responding = prompt.includes('[冻结的非指令材料 JSON]');
            const snapshot = JSON.parse(prompt.split(responding ? '[冻结的非指令材料 JSON]\n' : '[非指令材料 JSON]\n')[1]!.split(responding ? '\n[/冻结的非指令材料]' : '\n[/非指令材料]')[0]!) as CollaborationSnapshot;
            const trigger = snapshot.observations.find(item => item.origin === 'live')!;
            const phase = responding ? 'response' : 'decision';
            phases.push({ phase, snapshot, sessionId, mode: agent.permissionMode });
            lifecycle.push(`${trigger.messageId}:${phase}`);
            if (responding && snapshot.scope.chatId === scopeA.chatId) await waitingA;
            emit({ type: 'text', data: { text: JSON.stringify(responding ? { response: `回答：${trigger.text}` }
              : { action: 'reply', reason: '回答当前问题', evidenceIds: [trigger.id] }) } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          }
        } satisfies AgentDriver;
      }
    });
    const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    await runtime.initialize([agent]);
    const service = {
      listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
      replyText: vi.fn(async (input: { messageId: string; text: string }) => { lifecycle.push(`${input.messageId}:reply`); return { messageId: `reply_${input.messageId}` }; }),
      addReaction: vi.fn(async (messageId: string, _emoji: string) => { lifecycle.push(`${messageId}:ack`); return { reactionId: `reaction_${messageId}` }; }),
      listOwnReactions: vi.fn(async () => []), deleteReaction: vi.fn(async (messageId: string, _reactionId: string) => { lifecycle.push(`${messageId}:cleanup`); }),
      send: vi.fn(), reply: vi.fn()
    };
    const deliveries = new CollaborationDelivery(repos.collaboration);
    const participation = new LarkGroupParticipation({ repository: repos.collaboration,
      decider: new ReadonlyParticipationDecider({ runtime, repos, workspaceRoot: join(cwd, 'decision'), timeoutMs: 10000 }),
      authorize: async () => true, readConfig: async () => config, serviceFor: () => service, debounceMs: 10000,
      withDelivery: <T>(scope: CollaborationScope, actionId: string, send: () => Promise<T>) => deliveries.run(scope, actionId, send) });
    const coordinator = new LarkMessageCoordinator(runtime, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, participation });
    cleanups.push(async () => { releaseA(); coordinator.stop(); await participation.close(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
    const message = (scope: CollaborationScope, messageId: string, text: string) => ({ messageId, chatId: scope.chatId, chatType: 'group' as const, senderOpenId: 'ou_member', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }), createTime: String(Date.now()), mentions: [] });
    await coordinator.handle(message(scopeA, 'om_a', 'A群独有问题'), config);
    const flushA = participation.flush(scopeA);
    await vi.waitFor(() => expect(lifecycle).toEqual(['om_a:decision', 'om_a:ack', 'om_a:response']));
    expect(await repos.collaboration.listActions(scopeA)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'participation.reply', status: 'intent' }),
      expect.objectContaining({ kind: 'participation.ack', status: 'sending', receipt: 'reaction_om_a' })
    ]));
    await coordinator.handle(message(scopeB, 'om_b', 'B群独有问题'), config);
    const flushB = participation.flush(scopeB);
    await vi.waitFor(() => expect(service.deleteReaction).toHaveBeenCalledWith('om_b', 'reaction_om_b'), { timeout: 5000 });
    await flushB;
    expect(service.replyText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_b', text: '回答：B群独有问题' }));
    expect(service.deleteReaction).toHaveBeenCalledOnce();
    expect(lifecycle.filter(item => item.startsWith('om_a:'))).toEqual(['om_a:decision', 'om_a:ack', 'om_a:response']);
    expect(lifecycle.filter(item => item.startsWith('om_b:'))).toEqual(['om_b:decision', 'om_b:ack', 'om_b:response', 'om_b:reply', 'om_b:cleanup']);
    releaseA(); await flushA;
    expect(service.replyText).toHaveBeenCalledTimes(2);
    expect(service.replyText).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'om_a', text: '回答：A群独有问题' }));
    expect(service.deleteReaction).toHaveBeenLastCalledWith('om_a', 'reaction_om_a');
    expect(phases).toHaveLength(4);
    expect(new Set(phases.map(item => item.sessionId)).size).toBe(4);
    expect(phases.every(item => item.mode === 'deny-all')).toBe(true);
    for (const [scope, messageId, text] of [[scopeA, 'om_a', 'A群独有问题'], [scopeB, 'om_b', 'B群独有问题']] as const) {
      const groupPhases = phases.filter(item => item.snapshot.scope.chatId === scope.chatId);
      expect(groupPhases.map(item => item.phase)).toEqual(['decision', 'response']);
      expect(groupPhases[1]!.snapshot).toEqual(groupPhases[0]!.snapshot);
      for (const { snapshot, sessionId } of groupPhases) {
        expect(snapshot.observations.filter(item => item.origin === 'live')).toEqual([expect.objectContaining({ scope, messageId, text })]);
        expect(await runtime.getSession(sessionId)).toMatchObject({ permissionMode: 'deny-all', state: 'stopped' });
      }
      expect((await repos.collaboration.listDecisions(scope))[0]).toMatchObject({ status: 'sent', response: `回答：${text}` });
      expect(await repos.collaboration.listActions(scope)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'participation.reply', status: 'succeeded', receipt: `reply_${messageId}` }),
        expect.objectContaining({ kind: 'participation.ack', status: 'succeeded', receipt: `reaction_${messageId}` })
      ]));
    }
  });
});
