import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { agentConfigSchema } from '@dutydeck/shared';
import { buildApp } from '../apps/server/src/app.js';
import { LarkAppCreationJobManager } from '../apps/server/src/lark/app-creation.js';
import { LARK_COMMON_TENANT_SCOPES } from '../apps/server/src/lark/open-platform-configurator.js';
import { readLarkConfig, saveLarkConfig } from '../apps/server/src/lark/config.js';
import {
  resolveArtifactDir,
  getGitMetadata,
  ArtifactLogger,
  captureBrowserArtifacts,
  withTimeout,
  installTermination,
} from './lark-e2e-shared.mts';

const startTime = Date.now();
const pendingReview = process.env.DUTYDECK_E2E_PENDING_REVIEW === '1';
const scenarioName = pendingReview ? 'e2e-lark-app-creation-pending-review' : 'e2e-lark-app-creation';

const artifactDir = await resolveArtifactDir(scenarioName);
const logger = new ArtifactLogger(artifactDir);
const gitMeta = await getGitMetadata();

let directory: string | undefined;
let repositories: ReturnType<typeof createRepositories> | undefined;
let runtime: DutydeckRuntime | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

let cleanupPromise: Promise<void> | undefined;
let cleanupFailure: Error | undefined;
let extraResults: Record<string, unknown> = {};

const doCleanup = async (isFailure: boolean) => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    try {
      await withTimeout(
        captureBrowserArtifacts(browser, context, artifactDir, { isFailure }),
        10_000,
        'captureBrowserArtifacts'
      );
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (page && !page.isClosed()) await withTimeout(page.close(), 5_000, 'page.close');
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (context) await withTimeout(context.close(), 5_000, 'context.close');
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (browser) await withTimeout(browser.close(), 5_000, 'browser.close');
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (app) await withTimeout(app.close(), 5_000, 'app.close');
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (runtime) await withTimeout(runtime.shutdown(), 5_000, 'runtime.shutdown');
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (repositories) repositories.close();
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    if (directory) {
      try {
        await withTimeout(rm(directory, { recursive: true, force: true }), 5_000, 'rm(directory)');
      } catch (e: any) {
        if (!cleanupFailure) cleanupFailure = e;
      }
    }
    await logger.flush().catch(() => {});
  })();
  return cleanupPromise;
};

const termination = installTermination(scenarioName, 180_000, async err => {
  await doCleanup(true);
  await writeResultFile(false, err);
  return { cleanupFailed: Boolean(cleanupFailure) };
});

const checkAborted = () => termination.checkAborted();

async function writeResultFile(passedFlag: boolean, err?: Error) {
  const resultPayload = {
    scenario: scenarioName,
    boundary: 'synthetic_lark' as const,
    pendingReview,
    testedAt: new Date().toISOString(),
    node: process.version,
    gitCommit: gitMeta.commit,
    gitDirty: gitMeta.dirty,
    passed: passedFlag,
    durationMs: Date.now() - startTime,
    artifactDir,
    ...extraResults,
    ...(err ? { error: err.stack || err.message } : {})
  };
  await writeFile(resolve(artifactDir, 'result.json'), JSON.stringify(resultPayload, null, 2) + '\n', 'utf8').catch(() => {});
}

async function runTest() {
  directory = await mkdtemp(join(tmpdir(), 'dutydeck-create-bot-e2e-'));
  const workspacesRoot = join(directory, 'workspaces-root');
  await mkdir(workspacesRoot, { recursive: true });

  repositories = createRepositories(join(directory, 'state.sqlite'));
  runtime = new DutydeckRuntime(repositories, { workspaceRoot: workspacesRoot });
  const agent = agentConfigSchema.parse({
    id: 'ccflash',
    name: 'CCFlash (Claude Code / CPA)',
    protocol: 'pty-cli',
    adapterId: 'claude-code',
    command: process.execPath,
    model: 'gemini-3.8-flash-high',
    cwd: directory
  });
  await runtime.initialize([agent]);
  await saveLarkConfig(repositories.config, repositories.agents, { appId: 'cli_previous', appSecret: 'previous-secret-canary', name: '已有机器人', listening: false });
  const previous = await readLarkConfig(repositories.config, 'cli_previous');
  const secret = 'created-secret-canary-never-in-browser';

  const calls: Array<{ path: string; body?: unknown }> = [];
  let releaseScan!: () => void;
  let scopesEnabled = false;
  let eventEnabled = false;
  const subscribedAppEvents = new Set<string>();
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
            if (path.includes('/event/update/')) {
              eventEnabled = true;
              const appEvents = (body as any)?.appEvents;
              if (Array.isArray(appEvents)) {
                for (const e of appEvents) subscribedAppEvents.add(e);
              }
              return { code: 0 };
            }
            if (path === '/developers/v1/event/cli_created') {
              return { code: 0, data: { eventMode: 4, appEvents: eventEnabled ? Array.from(subscribedAppEvents) : [] } };
            }
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
  app = await buildApp(runtime, {
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

  checkAborted();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();

  const errors: string[] = [];
  const publicBodies: Promise<string>[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (/\/api\/lark\/(?:apps\/create|config)/.test(response.url())) publicBodies.push(response.text());
  });

  await page.goto(`${base}/?panel=lark-setup&mode=new`);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '扫码创建机器人' })).toBeVisible();
  const desktopScreenshot = resolve(artifactDir, 'one-click-bot.png');
  await page.screenshot({ path: desktopScreenshot, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: '扫码创建机器人' })).toBeInViewport();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const mobileScreenshot = resolve(artifactDir, 'one-click-bot-mobile.png');
  await page.screenshot({ path: mobileScreenshot, animations: 'disabled' });
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

  extraResults = {
    creationCount: 1,
    publishCount: 1,
    restoredAfterRefresh: true,
    secretHidden: true,
    previousBotPreserved: true,
    selectedAgent: saved?.defaultAgentId,
    screenshots: [desktopScreenshot, mobileScreenshot],
  };
}

try {
  await runTest();
  termination.checkAborted();
  await doCleanup(false);
  if (cleanupFailure) {
    throw new Error(`Cleanup failed after run: ${cleanupFailure.message}`);
  }
  termination.dispose();
  await writeResultFile(true);
  console.log(`RESULT ${resolve(artifactDir, 'result.json')}`);
} catch (error: any) {
  const finalError = termination.error ?? error;
  console.error(`${scenarioName} failure:`, finalError);
  await doCleanup(true);
  await writeResultFile(false, finalError);
  process.exit(1);
}
