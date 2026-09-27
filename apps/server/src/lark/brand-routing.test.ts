import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createRepositories } from '@dutydeck/storage';
import type { Session } from '@dutydeck/shared';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { createLarkCardService, larkConfigurationStatus } from './service.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { LarkLongConnectionListener } from './listener.js';
import { clearLarkChatModeCache, getChatMode } from './chat-mode.js';
import { registerLarkRoutes } from './routes.js';

const sdk = vi.hoisted(() => ({ domains: [] as string[], wsDomains: [] as string[], close: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  Client: class {
    constructor(private options: { domain: string }) { sdk.domains.push(options.domain); }
    im = { chat: { get: async () => ({ code: 0, data: { chat_mode: this.options.domain === 'https://open.larksuite.com' ? 'topic' : 'group' } }) } };
  },
  EventDispatcher: class { register() { return this; } },
  WSClient: class {
    constructor(private options: { domain: string; onReady(): void }) { sdk.wsDomains.push(options.domain); }
    async start() { this.options.onReady(); }
    close() { sdk.close(); }
  }
}));

const config: StoredLarkConfig = {
  appId: 'cli_brand', appSecret: 'secret', brand: 'lark', workspace: '/tmp', defaultAgentId: 'codex',
  fullTrustConfirmed: true, listening: true, preInjectPrompt: '', groupToolsEnabled: true, groupToolsAllowSend: true,
  pushIntervalMs: 1_000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [],
  highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'rm\\b', riskControlMode: 'off'
};
const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
  sdk.domains.length = 0;
  sdk.wsDomains.length = 0;
  sdk.close.mockClear();
  clearLarkChatModeCache();
});
const fetcher = () => vi.fn(async (url: string | URL | Request) => {
  const target = new URL(String(url));
  return new Response(JSON.stringify(target.pathname.includes('tenant_access_token')
    ? { code: 0, tenant_access_token: `token-${target.host}`, expire: 7200 }
    : target.pathname.endsWith('/members/list')
    ? { code: 0, data: { bots: [{ open_id: 'ou_lark' }, { open_id: 'ou_feishu' }], has_more: false } }
    : target.pathname.endsWith('/chats') ? { code: 0, data: { items: [], has_more: false } }
    : { code: 0, bot: { app_name: target.host, open_id: target.host === 'open.larksuite.com' ? 'ou_lark' : 'ou_feishu' } }), {
    headers: { 'content-type': 'application/json' }
  });
});

describe('Lark brand routing', () => {
  it.each([
    [undefined, 'https://open.feishu.cn'], ['feishu', 'https://open.feishu.cn'], ['lark', 'https://open.larksuite.com']
  ] as const)('routes token and bot requests for %s to %s', async (brand, baseUrl) => {
    const fetch = fetcher();
    await createLarkCardService({}, fetch, { ...config, brand }).getBotInfo();
    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([baseUrl, baseUrl]);
  });

  it('keeps explicit base URL and environment overrides ahead of brand defaults', () => {
    expect(larkConfigurationStatus({ LARK_OPEN_API_BASE_URL: 'https://env.example/' }, config).baseUrl).toBe('https://env.example');
    expect(larkConfigurationStatus({ LARK_OPEN_API_BASE_URL: 'https://env.example' }, { ...config, baseUrl: 'https://input.example/' }).baseUrl).toBe('https://input.example');
  });

  it('rebuilds default group tool clients when a saved bot changes brand', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const session: Session = { id: 'ses_brand', agentId: 'codex', state: 'idle', cwd: '/tmp', source: 'lark', sourceId: `${config.appId}:oc_brand:group`, runId: 'run_brand', createdAt: '', updatedAt: '' };
    await repos.sessions.save(session);
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token;
    const fetch = fetcher();
    const tools = new LarkAgentToolsService(capabilities, repos.config, { env: {}, fetcher: fetch });
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    expect(await tools.self(token)).toMatchObject({ bot: { openId: 'ou_lark' } });
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...config, brand: 'feishu' }]));
    expect(await tools.self(token)).toMatchObject({ bot: { openId: 'ou_feishu' } });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([
      'https://open.larksuite.com', 'https://open.larksuite.com', 'https://open.feishu.cn', 'https://open.feishu.cn'
    ]);
  });

  it('uses the resolved domain for WebSocket connections and reconnects after a brand change', async () => {
    const fetch = fetcher();
    const listener = new LarkLongConnectionListener({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }, { env: {}, fetcher: fetch });
    try {
      await listener.start(config);
      await listener.start({ ...config, brand: 'feishu' });
      expect(sdk.wsDomains).toEqual(['https://open.larksuite.com', 'https://open.feishu.cn']);
      expect(sdk.close).toHaveBeenCalledOnce();
      expect(fetch.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([
        'https://open.larksuite.com', 'https://open.larksuite.com', 'https://open.feishu.cn', 'https://open.feishu.cn'
      ]);
    } finally { listener.stop(); }
  });

  it('invalidates cached peer identities when the peer brand changes', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const session: Session = { id: 'ses_peers', agentId: 'codex', state: 'idle', cwd: '/tmp', source: 'lark', sourceId: `${config.appId}:oc_peers:group`, runId: 'run_peers', createdAt: '', updatedAt: '' };
    await repos.sessions.save(session);
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
    const token = capabilities.environmentFor(session).dutydeck_group_tools_token;
    const tools = new LarkAgentToolsService(capabilities, repos.config, { env: {}, fetcher: fetcher() });
    const peer = { ...config, appId: 'cli_peer_brand' };
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config, peer]));
    expect((await tools.peers(token)).peers.find(bot => bot.appId === peer.appId)?.openId).toBe('ou_lark');
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config, { ...peer, brand: 'feishu' }]));
    expect((await tools.peers(token)).peers.find(bot => bot.appId === peer.appId)?.openId).toBe('ou_feishu');
  });

  it('preserves stored brand when routes inspect and query a configured bot', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    const app = Fastify();
    const fetch = fetcher();
    try {
      await registerLarkRoutes(app, { config: repos.config, env: {}, fetcher: fetch, listeningDisabled: true,
        listener: { listening: false, activeAppIds: [], sync: async () => {}, stop() {} }
      });
      const inspected = await app.inject({ method: 'POST', url: '/api/lark/bot/inspect', payload: { appId: config.appId, appSecret: config.appSecret } });
      expect(inspected.statusCode).toBe(200);
      expect(inspected.json().openId).toBe('ou_lark');
      const chats = await app.inject({ method: 'GET', url: `/api/lark/bots/${config.appId}/chats` });
      expect(chats.statusCode).toBe(200);
      expect(fetch.mock.calls).toHaveLength(4);
      expect(fetch.mock.calls.every(([url]) => new URL(String(url)).origin === 'https://open.larksuite.com')).toBe(true);
    } finally { await app.close(); }
  });

  it('isolates SDK clients and chat-mode caches by domain', async () => {
    expect(await getChatMode('cli_chat_brand', 'secret', 'oc_same')).toBe('group');
    expect(await getChatMode('cli_chat_brand', 'secret', 'oc_same', { domain: 'https://open.larksuite.com' })).toBe('topic');
    expect(await getChatMode('cli_chat_brand', 'secret', 'oc_same')).toBe('group');
    expect(sdk.domains).toEqual(['https://open.feishu.cn', 'https://open.larksuite.com']);
  });
});
