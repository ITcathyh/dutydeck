import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { createLarkCardService } from './service.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';

export async function deliveryCoordinator(cwd: string, fetcher: typeof fetch, answer = 'synthetic final answer') {
  const repos = createRepositories(`${cwd}/state.db`, { newDatabaseAuthority: 'ledger_v1' });
  let finish = () => {};
  let ready = false;
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async () => new Promise<void>(resolve => { ready = true; finish = () => { emit({ type: 'text', data: { text: answer } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); resolve(); }; })
    } as AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd,
    env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_delivery_fixture', appSecret: 'synthetic', workspace: cwd,
    defaultAgentId: 'mock', permissionMode: 'full-trust', listening: true, fullTrustConfirmed: true, preInjectPrompt: '',
    structuredAskCards: false, urgentEnabled: false, pinLongTasks: false, completionReactionOnly: false, silentProgress: false, allowedBots: [], peerBotsAllowed: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000,
    hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const service = createLarkCardService({ LARK_APP_ID: config.appId, LARK_APP_SECRET: 'synthetic', LARK_API_QPS: '10000',
    LARK_API_BURST: '10000', LARK_API_RETRY_MAX_ATTEMPTS: '1', LARK_API_RETRY_BASE_MS: '1', LARK_API_RETRY_MAX_MS: '1' }, fetcher);
  const log = { info() {}, warn() {}, error() {} };
  const coordinator = new LarkMessageCoordinator(runtime, service, log, Math.random, 'ou_bot', undefined, repos.channelMappings,
    undefined, undefined, undefined, { store: repos.config });
  await coordinator.handle({ messageId: 'om_delivery_input', chatId: 'oc_delivery', chatType: 'p2p', messageType: 'text',
    content: JSON.stringify({ text: 'synthetic request' }), senderOpenId: 'ou_alice', mentions: [] }, config);
  return { repos, runtime, config, service, coordinator, ready: () => ready, finish: () => finish(), close: async () => {
    coordinator.stop(); service.close(); await runtime.shutdown(); repos.close();
  } };
}

if (process.argv[2] === '--crash-child') {
  await deliveryCoordinator(process.argv[3]!, (async (url: string, init: RequestInit) => {
    if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'synthetic', expire: 7200 });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (body.uuid?.startsWith('result_')) {
      // Provider has accepted the request; no response or local receipt can finish before SIGKILL.
      process.stdout.write(`accepted:${body.uuid}\n`);
      return new Promise(() => {});
    }
    return Response.json({ code: 0, data: { message_id: 'om_process', image_key: 'img_fixture', reaction_id: 'reaction' } });
  }) as typeof fetch).then(async h => {
    while (!h.ready()) await new Promise(resolve => setTimeout(resolve, 5));
    h.finish();
    setInterval(() => {}, 1000);
  });
}
