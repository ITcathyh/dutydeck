import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { StoredLarkConfig } from '@dutydeck/shared';
import { __testOnly_resetLarkGate } from '../lark/api-gate.js';
import { offerLarkSetupSmoke } from './lark-smoke.js';
import type { Prompter } from './prompts.js';

vi.mock('../daemon/command.js', () => ({ daemonStatus: () => ({ processStatus: 'stale' }) }));

const bot = { appId: 'cli_owner_source', appSecret: 'secret_fixture', listening: true } as StoredLarkConfig;
const applicationPath = `/open-apis/application/v6/applications/${bot.appId}`;
const tokenPath = '/open-apis/auth/v3/tenant_access_token/internal/';

interface RecordedRequest {
  method?: string;
  path: string;
  query: URLSearchParams;
  authorization?: string;
  body?: unknown;
}

interface ApplicationStub {
  status?: number;
  body?: unknown;
  disconnect?: boolean;
}

function prompter(answer = false): Prompter {
  return {
    interactive: true,
    ask: vi.fn(),
    choose: vi.fn(),
    confirm: vi.fn(async () => answer),
    secret: vi.fn(),
    close: vi.fn()
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  if (!text) return undefined;
  return JSON.parse(text);
}

async function withApplicationStub(
  application: ApplicationStub,
  run: (fixture: { requests: RecordedRequest[] }) => Promise<void>
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const json = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      if (url.pathname !== tokenPath && url.pathname !== applicationPath) {
        json(response, { code: 404, msg: 'unexpected fixture path' }, 404);
        request.resume();
        return;
      }
      let body: unknown;
      try { body = await readBody(request); }
      catch {
        request.socket.destroy();
        return;
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(body === undefined ? {} : { body })
      });
      if (url.pathname === tokenPath) {
        json(response, { code: 0, tenant_access_token: 'fixture-tenant-token', expire: 7200 });
        return;
      }
      if (application.disconnect) {
        request.socket.destroy();
        return;
      }
      json(response, application.body ?? {
        code: 0,
        data: { app: { app_id: bot.appId, owner: { type: 2, owner_id: 'ou_owner' } } }
      }, application.status ?? 200);
    })().catch(() => { request.socket.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback address for the Lark stub');
  vi.stubEnv('LARK_OPEN_API_BASE_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('LARK_API_QPS', '1000');
  vi.stubEnv('LARK_API_BURST', '1000');
  vi.stubEnv('LARK_API_RETRY_MAX_ATTEMPTS', '0');
  try { await run({ requests }); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function smoke(prompt: Prompter, overrides: Record<string, unknown> = {}) {
  const loadBot = vi.fn(async () => bot);
  const startListener = vi.fn(async () => vi.fn());
  const sendCard = vi.fn();
  const pending = offerLarkSetupSmoke({
    database: '/tmp/synthetic-owner-source.db',
    appId: bot.appId,
    interactive: true,
    prompter: prompt,
    ...overrides
  }, {
    loadBot,
    acquireRuntime: () => ({ close() {} }),
    startListener,
    sendCard
  });
  return { pending, loadBot, startListener, sendCard };
}

beforeEach(() => { __testOnly_resetLarkGate(); });
afterEach(() => {
  vi.unstubAllEnvs();
  __testOnly_resetLarkGate();
});

describe('default setup owner source', () => {
  it('reads the app-scoped enterprise owner over HTTP before the dedicated default-No confirmation', async () => {
    await withApplicationStub({}, async ({ requests }) => {
      const prompt = prompter(false);
      const { pending, startListener, sendCard } = smoke(prompt);
      await expect(pending).resolves.toMatchObject({ status: 'skipped' });
      expect(prompt.confirm).toHaveBeenCalledWith(expect.objectContaining({ dangerous: true, defaultValue: false }));
      expect(startListener).not.toHaveBeenCalled();
      expect(sendCard).not.toHaveBeenCalled();
      expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
        { method: 'POST', path: tokenPath },
        { method: 'GET', path: applicationPath }
      ]);
      expect(requests[0]?.authorization).toBeUndefined();
      expect(requests[0]?.body).toEqual({ app_id: bot.appId, app_secret: 'secret_fixture' });
      expect(requests[1]?.authorization).toBe('Bearer fixture-tenant-token');
      expect(Object.fromEntries(requests[1]!.query)).toEqual({ lang: 'zh_cn', user_id_type: 'open_id' });
    });
  });

  it('accepts an omitted response app_id and does not require creator_id to equal the current owner', async () => {
    await withApplicationStub({
      body: { code: 0, data: { app: { creator_id: 'ou_previous_owner', owner: { type: 2, owner_id: 'ou_owner' } } } }
    }, async () => {
      const prompt = prompter(false);
      const { pending } = smoke(prompt);
      await expect(pending).resolves.toMatchObject({ status: 'skipped' });
      expect(prompt.confirm).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ['Feishu owner', { code: 0, data: { app: { app_id: bot.appId, owner: { type: 0, owner_id: 'ou_owner' } } } }],
    ['partner owner', { code: 0, data: { app: { app_id: bot.appId, owner: { type: 1, owner_id: 'ou_owner' } } } }],
    ['missing owner', { code: 0, data: { app: { app_id: bot.appId } } }],
    ['non-open ID', { code: 0, data: { app: { app_id: bot.appId, owner: { type: 2, owner_id: 'on_union' } } } }],
    ['different app', { code: 0, data: { app: { app_id: 'cli_other', owner: { type: 2, owner_id: 'ou_owner' } } } }]
  ])('does not prompt, listen or send for %s', async (_name, body) => {
    await withApplicationStub({ body }, async () => {
      const prompt = prompter(true);
      const { pending, startListener, sendCard } = smoke(prompt);
      const result = await pending;
      expect(result.status).toBe('unavailable');
      expect(result.message).toContain('企业内成员所有者');
      expect(result.message).not.toContain('application:application:self_manage');
      expect(result.message).not.toContain('重跑');
      expect(prompt.confirm).not.toHaveBeenCalled();
      expect(startListener).not.toHaveBeenCalled();
      expect(sendCard).not.toHaveBeenCalled();
    });
  });

  it('directs only permission/read failures back to binding authorization', async () => {
    await withApplicationStub({ body: { code: 99991672, msg: 'permission denied' } }, async () => {
      const prompt = prompter(true);
      const { pending, startListener, sendCard } = smoke(prompt);
      const result = await pending;
      expect(result.status).toBe('unavailable');
      expect(result.message).toContain('application:application:self_manage');
      expect(result.message).toContain('重跑');
      expect(prompt.confirm).not.toHaveBeenCalled();
      expect(startListener).not.toHaveBeenCalled();
      expect(sendCard).not.toHaveBeenCalled();
    });
  });

  it('fails closed on an application-info network failure', async () => {
    await withApplicationStub({ disconnect: true }, async ({ requests }) => {
      const prompt = prompter(true);
      const { pending, startListener, sendCard } = smoke(prompt);
      const result = await pending;
      expect(result.status).toBe('unavailable');
      expect(result.message).toContain('application:application:self_manage');
      expect(result.message).toContain('重跑');
      expect(requests.map(request => request.path)).toEqual([tokenPath, applicationPath]);
      expect(prompt.confirm).not.toHaveBeenCalled();
      expect(startListener).not.toHaveBeenCalled();
      expect(sendCard).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['assumeYes', { assumeYes: true }],
    ['non-interactive', { interactive: false }],
    ['JSON', { json: true }]
  ])('makes no identity request for %s', async (_name, override) => {
    await withApplicationStub({}, async ({ requests }) => {
      const prompt = prompter(true);
      const { pending, loadBot, sendCard } = smoke(prompt, override);
      await expect(pending).resolves.toMatchObject({ status: 'skipped' });
      expect(loadBot).not.toHaveBeenCalled();
      expect(prompt.confirm).not.toHaveBeenCalled();
      expect(sendCard).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    });
  });

  it('keeps an explicitly verified owner as an independent entry without app-info requests', async () => {
    await withApplicationStub({}, async ({ requests }) => {
      const prompt = prompter(false);
      const { pending, sendCard } = smoke(prompt, { ownerOpenId: 'ou_explicitly_verified' });
      await expect(pending).resolves.toMatchObject({ status: 'skipped' });
      expect(prompt.confirm).toHaveBeenCalledOnce();
      expect(sendCard).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    });
  });
});
