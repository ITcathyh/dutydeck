import Fastify from 'fastify';
import { chromium, type Browser } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LarkPluginResultIdentity } from '../lark/plugin-result-identity.js';
import { registerPluginResultViewer } from './result-viewer-auth.js';
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('real browser login button reaches only the trusted OAuth origin and authorizes the original requester download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-result-browser-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const repos = createRepositories(join(dir, 'state.db'));
  cleanups.push(() => repos.close());
  const now = Date.now(), canary = 'PRIVATE_BROWSER_DOWNLOAD_CANARY';
  repos.pluginResults.reserve({ id: 'delivery', requester: { provider: 'lark', tenant: 'cli_browser', subject: 'ou_alice' }, plugin: 'private', tool: 'export', sessionId: 's', runId: 'r', taskId: 't', attemptId: 'a', callId: 'call', inputDigest: 'digest', target: {}, leaseToken: 'lease', leaseUntil: now + 60000, providerKey: 'provider', createdAt: now, expiresAt: now + 86400000 }, now);
  repos.pluginResults.store('delivery', 'lease', [{ id: 'file', name: 'private-report.csv', data: Buffer.from(canary), byteLength: Buffer.byteLength(canary), sha256: 'digest' }], now);
  const requests: Array<{ origin: string; path: string; method: string; referrer?: string; requestOrigin?: string; nonceMatchesCookie?: boolean }> = [];
  const codes = new Map<string, string>();
  let oauthVisits = 0, tokenExchanges = 0, base = '';
  const oauth = Fastify();
  cleanups.push(() => oauth.close());
  oauth.addHook('onRequest', async request => { requests.push({ origin: 'oauth', path: request.url.split('?')[0]!, method: request.method, referrer: request.headers.referer }); });
  oauth.addHook('onSend', async (_request, reply, payload) => { reply.header('referrer-policy', 'no-referrer'); return payload; });
  oauth.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
  oauth.get<{ Querystring: { client_id: string; redirect_uri: string; state: string; response_type: string } }>('/open-apis/authen/v1/authorize', (request, reply) => {
    oauthVisits++;
    expect(request.query.client_id).toBe('cli_browser');
    expect(request.query.response_type).toBe('code');
    expect(request.query.redirect_uri).toBe(`${base}/api/plugin-results/oauth/callback`);
    return reply.type('text/html').send(`<form action="/approve" method="post"><input type="hidden" name="state" value="${request.query.state}"><button name="user" value="alice">Authorize Alice</button><button name="user" value="bob">Authorize Bob</button></form>`);
  });
  oauth.post<{ Body: { state: string; user: string } }>('/approve', (request, reply) => {
    const code = `synthetic-browser-code-${codes.size}`;
    codes.set(code, request.body.user === 'alice' ? 'ou_alice' : 'ou_bob');
    return reply.code(303).header('location', `${base}/api/plugin-results/oauth/callback?${new URLSearchParams({ state: request.body.state, code })}`).send();
  });
  oauth.post<{ Body: { code: string; grant_type: string; client_id: string; client_secret: string; redirect_uri: string } }>('/open-apis/authen/v2/oauth/token', request => {
    tokenExchanges++;
    expect(request.body).toMatchObject({ grant_type: 'authorization_code', client_id: 'cli_browser', client_secret: 'synthetic-secret', redirect_uri: `${base}/api/plugin-results/oauth/callback` });
    return { access_token: `synthetic-token-${codes.get(request.body.code)}` };
  });
  oauth.get('/open-apis/authen/v1/user_info', request => ({ code: 0, data: { open_id: request.headers.authorization?.endsWith('ou_alice') ? 'ou_alice' : 'ou_bob' } }));
  oauth.get<{ Querystring: { nonce: string } }>('/attack', (request, reply) => reply.type('text/html').send(`<form action="${base}/api/plugin-results/delivery/auth/start" method="post"><input name="nonce" value="${request.query.nonce}"><button>Forged login</button></form>`));
  await oauth.listen({ port: 0, host: '127.0.0.1' });
  const oauthBase = oauth.listeningOrigin;
  const app = Fastify();
  cleanups.push(() => app.close());
  app.addHook('onRequest', async request => { requests.push({ origin: 'host', path: request.url.split('?')[0]!, method: request.method, referrer: request.headers.referer, requestOrigin: request.headers.origin }); });
  app.addHook('preHandler', async request => {
    if (request.method==='POST' && request.url.endsWith('/auth/start')) {
      const nonce=request.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith('dutydeck_result_nonce='))?.split('=')[1];
      requests.at(-1)!.nonceMatchesCookie=Boolean(nonce && (request.body as { nonce?: string })?.nonce===nonce);
    }
  });
  registerPluginResultViewer(app, { repository: repos.pluginResults, identity: new LarkPluginResultIdentity(repos.config, { allowLoopback: true, accountsBase: oauthBase, apiBase: oauthBase }), authorize: async () => {} });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = app.listeningOrigin;
  await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_browser', appSecret: 'synthetic-secret', webBaseUrl: base }]));
  const browser: Browser = await chromium.launch({ headless: true });
  cleanups.push(() => browser.close());
  const alice = await browser.newContext({ acceptDownloads: true });
  const page = await alice.newPage();
  const securityErrors: string[] = [];
  page.on('console', message => { if (/violates.*(?:form-action|Content Security Policy)/i.test(message.text())) securityErrors.push(message.text()); });
  const callbackResponses: import('@playwright/test').Response[] = [];
  page.on('response', response => { if (response.url().includes('/api/plugin-results/oauth/callback?')) callbackResponses.push(response); });
  const shell = await page.goto(`${base}/plugin-results/delivery`);
  expect(await page.locator('body').innerText()).not.toContain('private-report.csv');
  await page.getByRole('button', { name: '使用飞书登录' }).click();
  await page.waitForURL(`${oauthBase}/open-apis/authen/v1/authorize**`, { timeout: 4000 });
  expect(oauthVisits).toBe(1);
  expect(requests.find(request => request.origin === 'host' && request.method === 'POST')?.requestOrigin).toBe(base);
  expect(requests.find(request => request.path === '/open-apis/authen/v1/authorize')?.referrer).toBeUndefined();
  await page.getByRole('button', { name: 'Authorize Alice' }).click();
  await page.waitForURL(`${base}/plugin-results/delivery`);
  await page.getByRole('link', { name: 'private-report.csv', exact: false }).waitFor();
  expect(tokenExchanges).toBe(1);
  const cookies = await alice.cookies(`${base}/api/plugin-results`);
  expect(cookies.find(cookie => cookie.name === 'dutydeck_result_viewer')).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/plugin-results' });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'private-report.csv', exact: false }).click();
  const download = await downloadEvent;
  expect(await readFile((await download.path())!, 'utf8')).toBe(canary);
  expect(securityErrors).toEqual([]);
  expect(shell!.headers()['referrer-policy']).toBe('same-origin');
  expect(shell!.headers()['content-security-policy']).toContain(`form-action 'self' ${oauthBase};`);
  expect(shell!.headers()['content-security-policy']).not.toContain('*');
  expect(callbackResponses).toHaveLength(1);
  expect(callbackResponses[0]!.headers()['referrer-policy']).toBe('no-referrer');
  const downloadHead = await alice.request.head(`${base}/api/plugin-results/delivery/files/file`);
  expect(downloadHead.headers()['referrer-policy']).toBe('no-referrer');
  expect(requests.every(request => !request.referrer?.includes('code=') && !request.referrer?.includes('/files/'))).toBe(true);

  const bob = await browser.newContext();
  const forwarded = await bob.newPage();
  await forwarded.goto(`${base}/plugin-results/delivery`);
  await forwarded.getByRole('button', { name: '使用飞书登录' }).click();
  await forwarded.waitForURL(`${oauthBase}/open-apis/authen/v1/authorize**`);
  await forwarded.getByRole('button', { name: 'Authorize Bob' }).click();
  await forwarded.waitForURL(`${base}/api/plugin-results/oauth/callback**`);
  expect(await forwarded.locator('body').innerText()).toContain('RESULT_LOGIN_FAILED');
  expect((await bob.cookies()).some(cookie => cookie.name === 'dutydeck_result_viewer')).toBe(false);
  expect((await forwarded.goto(`${base}/api/plugin-results/delivery/files/file`))!.status()).toBe(401);

  // A foreign page with the correct nonce and browser cookie still cannot initiate login.
  await forwarded.goto(`${base}/plugin-results/delivery`);
  const nonce = await forwarded.locator('input[name=nonce]').inputValue();
  const visitsBeforeAttack = oauthVisits;
  await forwarded.goto(`${oauthBase}/attack?${new URLSearchParams({ nonce })}`);
  await forwarded.getByRole('button', { name: 'Forged login' }).click();
  await forwarded.waitForURL(`${base}/api/plugin-results/delivery/auth/start`);
  expect(await forwarded.locator('body').innerText()).toContain('RESULT_CSRF');
  expect(oauthVisits).toBe(visitsBeforeAttack);
  expect(requests.filter(request=>request.origin==='host' && request.method==='POST').at(-1)).toMatchObject({ requestOrigin: 'null', nonceMatchesCookie: true });
}, 30000);
