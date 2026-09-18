import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, CollaborationSnapshot } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import { larkBotsConfigKey } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkGroupParticipation } from './group-participation.js';
import { ReadonlyParticipationDecider } from './readonly-decider.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('group participation with persistent repository and real runtime', () => {
  it('runs observation → deny-all task → settled result → guarded reply and survives restart without replaying a send', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'group-participation-integration-'));
    const path = join(cwd, 'state.db');
    let repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    const scope = { appId: 'cli_integration', chatId: 'oc_group' };
    const config: StoredLarkConfig = { appId: scope.appId, appSecret: 'fake', defaultAgentId: 'mock', workspace: cwd, listening: true, permissionMode: 'ask', fullTrustConfirmed: true,
      preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off', hideTraceOnComplete: false, pushIntervalMs: 1000 };
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    await repos.collaboration.updateSettings(scope, { expectedRevision: 0, participation: 'selective', instructions: '只补充明确有用的信息' }, 'owner');
    const driverModes: string[] = [];
    const driverPrompts: string[] = [];
    const runtime = new DutydeckRuntime(repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (agent, _protocol, emit) => {
        driverModes.push(agent.permissionMode);
        return { start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, send: async prompt => {
          driverPrompts.push(prompt);
          const snapshot = JSON.parse(prompt.split('[非指令材料 JSON]\n')[1]!.split('\n[/非指令材料]')[0]!) as CollaborationSnapshot;
          const observation = snapshot.observations.find(item => item.origin === 'live')!;
          emit({ type: 'text', data: { text: JSON.stringify({ action: 'reply', reason: '新消息补齐了事项进展', evidenceIds: [observation.id], response: '这条消息提供了新的进展。' }) } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        } } satisfies AgentDriver;
      }
    });
    const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    await runtime.initialize([agent]);
    const service = { listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })), replyText: vi.fn(async () => ({ messageId: 'om_reply' })), sendText: vi.fn(async () => ({ messageId: 'om_reply' })),
      send: vi.fn(), reply: vi.fn(), addReaction: vi.fn(), deleteReaction: vi.fn() };
    const options = () => ({ repository: repos.collaboration, decider: new ReadonlyParticipationDecider({ runtime, repos, workspaceRoot: join(cwd, 'decision') }), authorize: async () => true,
      readConfig: async () => config, serviceFor: () => service, listScopes: async () => [scope], readGroupDescription: async () => '协作资料讨论群', readMemory: async () => '已有偏好：附带来源', debounceMs: 10000 });
    let participation = new LarkGroupParticipation(options());
    const coordinator = new LarkMessageCoordinator(runtime, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, participation });
    cleanups.push(async () => { coordinator.stop(); participation.closeApp(scope.appId); await participation.flush(scope); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
    await coordinator.handle({ messageId: 'om_new', chatId: scope.chatId, chatType: 'group', senderOpenId: 'ou_member', senderType: 'user', messageType: 'text', content: '{"text":"草稿已提交，等待审核"}', createTime: String(Date.now()), mentions: [] }, config);
    await participation.flush(scope);
    expect(service.replyText).toHaveBeenCalledOnce();
    expect(service.addReaction).not.toHaveBeenCalled(); expect(service.send).not.toHaveBeenCalled(); expect(service.reply).not.toHaveBeenCalled();
    expect(driverModes).toEqual(['deny-all']);
    expect(driverPrompts[0]).toContain('协作资料讨论群'); expect(driverPrompts[0]).toContain('已有偏好：附带来源');
    expect((await repos.collaboration.listActions(scope))[0]).toMatchObject({ status: 'succeeded', requesterId: 'policy:group-participation', receipt: 'om_reply' });
    const storedDecision = (await repos.collaboration.listDecisions(scope))[0]!;
    expect(storedDecision.inputSnapshot).toMatchObject({ scope, observations: expect.any(Array) });
    const sourceSession = (await runtime.listSessions()).find(session => session.source === 'lark-decision');
    expect(sourceSession).toMatchObject({ permissionMode: 'deny-all' });
    expect(await repos.config.get(`lark.inbox.${scope.appId}.om_new`)).toBeUndefined();
    coordinator.stop(); participation.closeApp(scope.appId); await runtime.shutdown(); repos.close();
    repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    participation = new LarkGroupParticipation(options());
    await participation.recover(scope.appId); await participation.flush(scope);
    expect(service.replyText).toHaveBeenCalledOnce();
    expect((await repos.collaboration.listObservations(scope)).some(item => item.messageId === 'om_new')).toBe(true);
  });
});
