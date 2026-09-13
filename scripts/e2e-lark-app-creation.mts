import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { agentConfigSchema } from '@dutydeck/shared';
import { buildApp } from '../apps/server/src/app.js';
import { LarkAppCreationJobManager } from '../apps/server/src/lark/app-creation.js';
import { LARK_COMMON_TENANT_SCOPES } from '../apps/server/src/lark/open-platform-configurator.js';
import { readLarkConfig, saveLarkConfig } from '../apps/server/src/lark/config.js';

// Real HTTP routes, job manager, configurator and SQLite. Only Feishu is synthetic.
const directory = await mkdtemp(join(tmpdir(), 'dutydeck-create-bot-e2e-'));
const repositories = createRepositories(join(directory, 'state.sqlite'));
const runtime = new DutydeckRuntime(repositories);
const agent = agentConfigSchema.parse({ id: 'ccflash', name: 'CCFlash (Claude Code / CPA)', protocol: 'pty-cli', adapterId: 'claude-code', command: process.execPath, model: 'gemini-3.8-flash-high', cwd: directory });
await runtime.initialize([agent]);
await saveLarkConfig(repositories.config, repositories.agents, { appId: 'cli_previous', appSecret: 'previous-secret-canary', name: '已有机器人', listening: false });
const previous = await readLarkConfig(repositories.config, 'cli_previous');
const secret = 'created-secret-canary-never-in-browser';
const pendingReview = process.env.DUTYDECK_E2E_PENDING_REVIEW === '1';
const calls: Array<{ path: string; body?: unknown }> = [];
let releaseScan!: () => void;
let scopesEnabled = false;
let eventEnabled = false;
let callbackEnabled = false;
let callbackMode = 0;
let published = false;
const jobs = new LarkAppCreationJobManager({
  config: repositories.config,
  agents: repositories.agents,
  connect: async options => {
    assert.equal(options?.forceLogin, true);
    const scanned = new Promise<void>(resolve => { releaseScan = resolve; });
    await options?.onQrUpdate?.({ qrPayload: 'synthetic-feishu-qr', status: 'waiting_for_scan' });
    await scanned;
    return {
      source: 'qr_login',
      owner: { userId: 'creator-user', tenantId: 'creator-tenant', userName: '测试账号', tenantName: '测试企业' },
      client: {
        apiOrigin: 'https://open.feishu.cn',
        postForm: async (path, body) => {
          calls.push({ path });
          assert.equal(body.get('uploadType'), '4');
          assert.ok((body.get('file') as Blob).size > 100);
          return { code: 0, data: { url: 'https://example.invalid/icon.png' } };
        },
        postJson: async (path, body) => {
          calls.push({ path, body });
          if (path.endsWith('/manifest/upsert_by_template')) return { code: 0, data: { ClientID: 'cli_created' } };
          if (path === '/developers/v1/secret/cli_created') return { code: 0, data: { secret } };
          if (path.includes('/scope/all/')) return { code: 0, data: { appScopeList: LARK_COMMON_TENANT_SCOPES.map((scopeName, i) => ({ scopeId: `scope-${i}`, scopeName, status: published ? 5 : scopesEnabled ? 1 : 0 })) } };
          if (path.includes('/scope/update/')) { scopesEnabled = true; return { code: 0 }; }
          if (path.includes('/robot/switch/') || path.includes('/event/switch/')) return { code: 0 };
          if (path.includes('/event/update/')) { eventEnabled = true; return { code: 0 }; }
          if (path === '/developers/v1/event/cli_created') return { code: 0, data: { eventMode: 4, appEvents: eventEnabled ? ['im.message.receive_v1'] : [] } };
          if (path.includes('/callback/switch/')) { callbackMode = 4; return { code: 0 }; }
          if (path.includes('/callback/update/')) { callbackEnabled = true; return { code: 0 }; }
          if (path === '/developers/v1/callback/cli_created') return { code: 0, data: { callbackMode, callbacks: callbackEnabled ? ['card.action.trigger'] : [] } };
          if (path.includes('/app_version/list/')) return { code: 0, data: { versions: published ? [{ versionId: 'first-version', appVersion: '0.0.1', versionStatus: pendingReview ? 1 : 2 }] : [] } };
          if (path.includes('/app_version/create/')) {
            assert.deepEqual((body as any).visibleSuggest.members, ['creator-user']);
            return { code: 0, data: { versionId: 'first-version' } };
          }
          if (path.includes('/publish/commit/')) { published = true; return { code: 0 }; }
          throw new Error(`Unexpected synthetic endpoint: ${path}`);
        },
      },
    };
  },
});
const listener = { listening: false, activeAppIds: [] as string[], sync: async () => {}, stop: async () => {} };
const app = await buildApp(runtime, {
  webRoot: resolve('apps/web/dist'),
  auth: { mode: 'local', localOnly: true, getToken: async () => null },
  lark: {
    config: repositories.config, agents: repositories.agents, listener, appCreationJobs: jobs,
    fetcher: async () => { throw new Error('Real Feishu requests are forbidden in this test'); },
  },
});
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
const publicBodies: Promise<string>[] = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (/\/api\/lark\/(?:apps\/create|config)/.test(response.url())) publicBodies.push(response.text());
});
try {
  await page.goto(`${base}/?panel=lark-setup&mode=new`);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '扫码创建机器人' })).toBeVisible();
  await page.screenshot({ path: '/tmp/dutydeck-one-click-bot.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: '扫码创建机器人' })).toBeInViewport();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/dutydeck-one-click-bot-mobile.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByLabel('新机器人名称').fill('扫码创建的助手');
  const started = page.waitForResponse(response => response.url().endsWith('/api/lark/apps/create') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '扫码创建机器人' }).click();
  const job = await (await started).json();
  await expect(dialog.getByAltText('创建机器人：飞书登录二维码')).toBeVisible();
  await page.reload();
  await expect(dialog.getByAltText('创建机器人：飞书登录二维码')).toBeVisible();
  assert.equal(calls.filter(call => call.path.includes('/manifest/')).length, 0);
  releaseScan();
  if (pendingReview) {
    await expect(dialog.getByText(/正在等待飞书管理员审核/)).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('link', { name: '查看审核进度' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '重试本次创建' })).toHaveCount(0);
    await dialog.getByRole('button', { name: '继续配置已创建的机器人' }).click();
  }
  await expect(dialog.getByRole('heading', { name: '更新飞书 Bot：扫码创建的助手' })).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText('默认 Agent', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'CCFlash (Claude Code / CPA)', exact: true })).toBeVisible();
  const draft = await readLarkConfig(repositories.config, 'cli_created');
  assert.equal(draft?.appSecret, secret);
  assert.equal(draft?.listening, false);
  assert.equal(draft?.fullTrustConfirmed, false);
  await dialog.getByRole('checkbox', { name: /确认飞书任务以 full-trust 运行/ }).check();
  await dialog.getByRole('button', { name: '完成配置' }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await readLarkConfig(repositories.config, 'cli_created');
  assert.equal(saved?.defaultAgentId, 'ccflash');
  assert.equal(saved?.listening, true);
  assert.equal(saved?.fullTrustConfirmed, true);
  assert.deepEqual(await readLarkConfig(repositories.config, 'cli_previous'), previous);
  const duplicate = await fetch(`${base}/api/lark/apps/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: job.id, name: '扫码创建的助手' }) });
  assert.equal((await duplicate.json()).appId, 'cli_created');
  assert.equal(calls.filter(call => call.path.includes('/manifest/')).length, 1);
  assert.equal(calls.filter(call => call.path.includes('/publish/commit/')).length, 1);
  assert.ok(!(await Promise.all(publicBodies)).join('\n').includes(secret));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, creationCount: 1, publishCount: 1, restoredAfterRefresh: true, secretHidden: true, previousBotPreserved: true, selectedAgent: saved?.defaultAgentId, screenshot: '/tmp/dutydeck-one-click-bot.png' }));
} finally {
  await browser.close();
  await app.close();
  await runtime.shutdown();
  repositories.close();
  await rm(directory, { recursive: true, force: true });
}
