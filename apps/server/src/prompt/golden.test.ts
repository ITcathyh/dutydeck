import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { RuntimeOptions } from '@dutydeck/runtime';
import type { AgentConfig, Session } from '@dutydeck/shared';
import { getAvailablePort } from '../../../../tests/e2e/acceptance/harness.js';
import { startLocalServer } from '../service.js';
import { LarkMessageCoordinator } from '../lark/coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from '../lark/config.js';
import { larkMemoryKey, larkMemoryScope, LarkMemoryStore } from '../lark/memory.js';
import type { LarkGroupParticipation } from '../lark/group-participation.js';
import { TurnTokens } from '../agent-host/turn-token.js';
import { PluginHost } from '../plugins/host.js';
import * as pluginWiring from '../plugins/service-wiring.js';
import { HerdrSessions } from '../herdr.js';
import { PROJECT_MEMORY_KEY } from '../project-memory.js';
import { SessionAutomationService } from '../session-automation.js';

const sent = new Map<string, string>();
// Keep the production preparation and session-prompt callbacks, execution ledger and submission path.
vi.mock('@dutydeck/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@dutydeck/runtime')>();
  return { ...original, DutydeckRuntime: class extends original.DutydeckRuntime {
    constructor(repos: ConstructorParameters<typeof original.DutydeckRuntime>[0], options: RuntimeOptions) {
      super(repos, {
        prepareTaskPrompt: options.prepareTaskPrompt, sessionPrompt: options.sessionPrompt,
        selectPromptPolicy: async () => ({ version: 'optimized-v1' }),
        probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
        driverFactory: (_agent, _protocol, emit, _exit, id) => ({
          start: async () => {}, resume: async () => {}, interrupt: async () => {}, stop: async () => {}, setPermissionMode: () => {},
          send: async prompt => {
            if (typeof prompt !== 'string') throw new Error('Expected an ACP text submission');
            sent.set(id, prompt);
            emit({ type: 'text', data: { text: '完成' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          }
        })
      });
    }
  } };
});

const agent: AgentConfig = { id: 'claude', name: 'Claude Code', command: 'claude-agent-acp', adapterId: 'claude', args: [], protocol: 'acp',
  cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
const config: StoredLarkConfig = { appId: 'cli_golden', appSecret: 'fixture', workspace: agent.cwd, defaultAgentId: agent.id, permissionMode: 'ask',
  listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false,
  groupToolsAllowSend: false, memoryEnabled: false, pushIntervalMs: 60000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [],
  allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'fixture-restricted', riskControlMode: 'off' };
const richBot: StoredLarkConfig = { ...config, appId: 'cli_rich', groupToolsEnabled: true, groupToolsAllowSend: true, memoryEnabled: true,
  executionMode: 'layered', adhdMode: true, roleTitle: '评审员', preInjectPrompt: '  保留空白边界。  ', riskControlMode: 'guidance', highRiskAllowedUsers: [{ openId: 'ou_admin', name: 'Admin' }] };
const request = '第一行\n\n  第二行';
const fact = { id: 'mem_01234567', content: '样例使用中文。', topic: 'general', source: 'user', createdBy: 'ou_user', createdAt: '2025-01-02T00:00:00Z' };
let root: string;
let repos: ReturnType<typeof createRepositories>;
let service: Awaited<ReturnType<typeof startLocalServer>>;
let coordinator: LarkMessageCoordinator;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prompt-golden-'));
  const database = join(root, 'state.db');
  repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config, richBot]));
  await repos.config.set(larkMemoryKey(larkMemoryScope(richBot.appId, 'oc_group', 'group')), JSON.stringify({ v: 1, entries: [{ ...fact, chatId: 'oc_group' }] }));
  vi.spyOn(TurnTokens.prototype, 'finalTurnToken').mockReturnValue('fixture-turn');
  vi.spyOn(HerdrSessions.prototype, 'prompt').mockImplementation(command => command ? 'Herdr (dutydeck)' : 'Herdr (default)');
  vi.spyOn(SessionAutomationService.prototype, 'resultContext').mockImplementation(async session => session.sourceId === 'cli_rich:oc_auto:group' ? '定时结果样例' : undefined);
  const host = PluginHost.empty(root);
  host.resultTools.register('fixture', 'bot:cli_rich', { name: 'report', description: '样例结果', inputSchema: { parse: value => value }, execute: async () => ({ files: [] }) });
  vi.spyOn(pluginWiring, 'loadDaemonPlugins').mockResolvedValue({ host, scenarios: host.scenarios });
  service = await startLocalServer({ env: { NODE_ENV: 'test', DUTYDECK_HOST: '127.0.0.1', DUTYDECK_PORT: String(await getAvailablePort()),
    DUTYDECK_DATABASE_URL: database, DUTYDECK_DEFAULT_CWD: root, DUTYDECK_DISABLE_LARK_LISTENER: 'true', DUTYDECK_AGENTS_JSON: '[]' }, webRoot: root });
  await repos.agents.save(agent);
  const card = async () => ({ messageId: 'om_card' });
  const client = { send: card, reply: card, update: card, addReaction: async () => ({ reactionId: 'reaction' }), deleteReaction: async () => {},
    getUserEmails: async () => [], listChatMessages: async () => ({ items: [], hasMore: false }), getMessageItems: async () => [] };
  const participation = { mode: async () => 'off', handle: async () => ({ handled: false, enabled: false }), noteHumanMessage: () => {},
    guardBotTurn: async () => undefined, scenarioRecall: async () => undefined,
    taskContext: async () => ({ text: '群消息样例', watermark: '1', promptParts: [{ kind: 'reference', trustScope: 'untrusted:group', content: '群消息样例' }] }),
    instructions: async () => '先说明依据。' } as unknown as LarkGroupParticipation;
  coordinator = new LarkMessageCoordinator(service.runtime, client as any, console, Math.random, 'ou_bot', undefined, repos.channelMappings,
    async () => 'group', undefined, undefined, { store: repos.config, participation, memory: { store: new LarkMemoryStore(repos.config) } });
  await coordinator.initializeWorkflows(config);
  await coordinator.initializeWorkflows(richBot);
});
afterEach(async () => {
  sent.clear();
  coordinator?.stop();
  await service?.close();
  repos?.close();
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

async function snapshot(id: string, session: Session) {
  await vi.waitFor(() => expect(sent.has(session.id)).toBe(true), { timeout: 5000 });
  const [task] = await service.runtime.getTasks(session.id);
  const context = repos.execution.getAcceptedTask(task!.id)!.input.executionContext;
  const events = await service.runtime.getEvents(session.id);
  const assembly = events.findLast(event => (event.data as any)?.stage === 'session_context');
  expect(context.promptPolicyVersion).toBe('optimized-v1');
  expect(assembly).toBeDefined();
  await expect(JSON.stringify({ prompt: sent.get(session.id), promptParts: context.promptParts, diagnostics: (assembly!.data as any).sources }, null, 2) + "\n").toMatchFileSnapshot(`./golden/${id}.json`);
}

it.each([
  ['p2p', 'p2p', config, request], ['group', 'group', config, request],
  ['group-features', 'group', richBot, request], ['plan', 'p2p', richBot, '/plan 梳理样例']
] as const)('submits %s through the Lark coordinator', async (id, chatType, bot, text) => {
  const chatId = id === 'group-features' ? 'oc_group' : `oc_${id}`;
  await coordinator.handle({ messageId: `om_${id}`, chatId, chatType, senderType: 'user', senderOpenId: 'ou_user', messageType: 'text',
    content: JSON.stringify({ text: chatType === 'group' ? '@_user_1 ' + text : text }),
    mentions: chatType === 'group' ? [{ key: '@_user_1', name: 'Bot', openId: 'ou_bot', mentionedType: 'bot' }] : [] }, bot);
  const getSession = async () => (await service.runtime.listSessions()).find(session => session.sourceId?.split(':')[1] === chatId && sent.has(session.id));
  await vi.waitFor(async () => expect(await getSession()).toBeDefined(), { timeout: 5000 });
  await snapshot(id, (await getSession())!);
});

it.each([
  ['web', 'web', undefined], ['web-project', 'web', undefined],
  ['leader', 'lark-leader', 'delegation'], ['worker', 'work_item', 'work-attempt'],
  ['frozen', 'lark', 'cli_rich:oc_group:group:collaboration:mandate'],
  ['reply-polish', 'lark-reply-polish', 'cli_rich:oc_group'], ['decision', 'lark-decision', 'cli_rich:oc_group'],
  ['automatic', 'lark', 'cli_rich:oc_auto:group']
] as const)('submits %s through the runtime', async (id, source, sourceId) => {
  const input = { agentId: agent.id, source, sourceId, permissionMode: 'deny-all' as const };
  const session = source === 'work_item' ? await service.runtime.startWorkItemSession(input, 'ses_work_' + 'a'.repeat(64), async () => {})
    : await service.runtime.start(input);
  if (id === 'web-project') await repos.config.set(PROJECT_MEMORY_KEY, JSON.stringify({ v: 1,
    projects: [{ id: 'proj_fixture', enabled: true, entries: [fact] }], bindings: { [session.id]: 'proj_fixture' } }));
  await service.runtime.dispatchRequest({ version: 1, namespace: id === 'automatic' ? 'automation' : 'runtime', key: id, sessionId: session.id,
    actor: source === 'lark' || source === 'work_item' ? { kind: 'channel', id: 'ou_user', appId: 'cli_rich' } : { kind: 'unspecified' }, prompt: request, mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: {} },
    { promptParts: [{ kind: 'user_request', trustScope: 'user_request', content: request }] });
  await snapshot(id, session);
});
