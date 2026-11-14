import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { launchIsolatedTestServer, REPO_ROOT, TASK_POLL_INTERVALS, type TestServerInstance } from './harness.js';
import { startAcceptedResponseLossProxy } from './send-idempotency-proxy.js';

const storageRequire = createRequire(resolve(REPO_ROOT, 'packages/storage/package.json'));
const Database = storageRequire('better-sqlite3');

type AcceptedResponseLossProxy = Awaited<ReturnType<typeof startAcceptedResponseLossProxy>>;
let instance: TestServerInstance;
let proxy: AcceptedResponseLossProxy;

function realPromptCallCount(targetInstance: TestServerInstance, prompt: string) {
  const callLog = join(targetInstance.dataDir, 'mock-acp-calls.jsonl');
  if (!existsSync(callLog)) return 0;
  const entries = readFileSync(callLog, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { method?: string; prompt?: string });
  return entries.filter(entry => entry.method === 'session/prompt' && entry.prompt?.endsWith(prompt)).length;
}

function persistedPromptCounts(sessionId: string, prompt: string) {
  const db = new Database(join(instance.dataDir, 'dutydeck.db'), { readonly: true });
  try {
    const tasks = db.prepare('SELECT id, status FROM tasks WHERE session_id = ? AND prompt = ?').all(sessionId, prompt) as Array<{ id: string; status: string }>;
    const totalTasks = db.prepare('SELECT count(*) AS count FROM tasks WHERE session_id = ?').get(sessionId).count as number;
    const rows = db.prepare("SELECT data FROM events WHERE session_id = ? AND type = 'text'").all(sessionId) as Array<{ data: string }>;
    const userEvents = rows.filter(row => {
      const data = JSON.parse(row.data);
      return data.role === 'user' && data.text === prompt;
    });
    return { tasks: tasks.length, userEvents: userEvents.length, totalTasks, taskStatuses: tasks.map(task => task.status) };
  } finally {
    db.close();
  }
}

async function expectFinishedPrompt(sessionId: string, prompt: string, totalTasks: number) {
  await expect.poll(async () => {
    const response = await instance.request('GET', `/api/sessions/${sessionId}`);
    expect(response.status, response.text).toBe(200);
    return { state: response.json.state, ...persistedPromptCounts(sessionId, prompt) };
  }, { intervals: TASK_POLL_INTERVALS }).toEqual({ state: 'idle', tasks: 1, userEvents: 1, totalTasks, taskStatuses: ['completed'] });
  expect(realPromptCallCount(instance, prompt)).toBe(1);
}

async function launchInstance() {
  return launchIsolatedTestServer({
    prefix: 'dutydeck-send-idempotency-',
    beforeLaunch: ({ sourceRepo, dataDir }) => {
      return {
        agents: [{
          id: 'send-idempotency-acp',
          name: 'Send idempotency ACP fixture',
          command: process.execPath,
          args: [join(REPO_ROOT, 'tests/fixtures/mock-acp-agent.mjs')],
          protocol: 'acp',
          cwd: sourceRepo,
          permissionMode: 'full-trust',
          timeout: 60,
          builtin: false,
          env: { mock_acp_call_log: join(dataDir, 'mock-acp-calls.jsonl') }
        }]
      };
    }
  });
}

async function createSession() {
  const response = await instance.request('POST', '/api/sessions', {
    agentId: 'send-idempotency-acp',
    cwd: instance.sourceRepo,
    workspaceMode: 'shared',
    permissionMode: 'full-trust'
  });
  expect(response.status, response.text).toBe(200);
  return response.json.id as string;
}

async function openSession(page: Page, sessionId: string) {
  await page.goto(`${proxy.baseUrl}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
}

async function expectSingleVisibleUserInstruction(page: Page, prompt: string) {
  await expect(page.locator('div.ui-timeline-item.flex.justify-end').filter({ hasText: prompt })).toHaveCount(1);
}

function captureSendFailures(page: Page, sessionId: string) {
  const failures: string[] = [];
  page.on('requestfailed', request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== `/api/sessions/${sessionId}/send`) return;
    failures.push(request.failure()?.errorText ?? 'unknown browser failure');
  });
  return failures;
}

async function cleanupAfterTest(
  testInfo: Pick<TestInfo, 'status' | 'expectedStatus' | 'attach'>,
  currentInstance?: TestServerInstance,
  currentProxy?: AcceptedResponseLossProxy
) {
  try {
    if (testInfo.status !== testInfo.expectedStatus) {
      if (currentInstance) await testInfo.attach('isolated-server.log', { body: currentInstance.serverLog.join(''), contentType: 'text/plain' });
      if (currentProxy) await testInfo.attach('send-exchanges.json', { body: JSON.stringify(currentProxy.exchanges, null, 2), contentType: 'application/json' });
    }
  } catch {
    // Diagnostics must not replace the test failure that triggered this cleanup.
  } finally {
    try { await currentProxy?.close(); }
    finally { await currentInstance?.cleanup(); }
  }
}

test.describe('accepted response loss', () => {
  test.beforeEach(async () => {
    instance = await launchInstance();
    proxy = await startAcceptedResponseLossProxy(instance.port);
  });

  test.afterEach(async ({}, testInfo) => {
    await cleanupAfterTest(testInfo, instance, proxy);
  });

  test('queue: server accepted then response lost, reload and normal send reuse the task', async ({ page }, testInfo) => {
    const sessionId = await createSession();
    const prompt = 'QUEUE_ACCEPTED_RESPONSE_LOSS_ONCE';
    await openSession(page, sessionId);
    const browserFailures = captureSendFailures(page, sessionId);
    const message = page.getByRole('textbox', { name: '消息', exact: true });
    await message.fill(prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();

    await expect.poll(() => proxy.exchanges[0]?.dropped ?? false).toBe(true);
    await expect.poll(() => browserFailures.length).toBe(1);
    expect(browserFailures[0]).toContain('ERR_INCOMPLETE_CHUNKED_ENCODING');
    const first = proxy.exchanges[0]!;
    expect(first.responseStatus).toBe(202);
    expect(first.responseBody).toMatchObject({ accepted: true, task: { id: expect.any(String) } });
    expect(first.request).toMatchObject({ prompt, mode: 'queue' });
    expect(first.request.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(message).toBeVisible();
    await expect(message).toHaveValue(prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => proxy.exchanges.length).toBe(2);
    expect(browserFailures).toHaveLength(1);
    const second = proxy.exchanges[1]!;
    expect(second.dropped).toBe(false);
    expect(second.request.idempotencyKey).toBe(first.request.idempotencyKey);
    expect(second.responseBody.task.id).toBe(first.responseBody.task.id);
    await expect(message).toHaveValue('');

    await expectFinishedPrompt(sessionId, prompt, 1);
    await expectSingleVisibleUserInstruction(page, prompt);
    await testInfo.attach('queue-accepted-response-loss.json', {
      body: JSON.stringify({ exchanges: proxy.exchanges, browserFailures, persisted: persistedPromptCounts(sessionId, prompt), realPromptCalls: realPromptCallCount(instance, prompt) }, null, 2),
      contentType: 'application/json'
    });
  });

  test('interrupt: server accepted then response lost, browser retry reuses the task after the session became idle', async ({ page }, testInfo) => {
    const sessionId = await createSession();
    const waiting = await instance.request('POST', `/api/sessions/${sessionId}/send`, { prompt: 'wait for steering', mode: 'queue' });
    expect(waiting.status, waiting.text).toBe(202);
    await expect.poll(async () => (await instance.request('GET', `/api/sessions/${sessionId}`)).json.state, { intervals: TASK_POLL_INTERVALS }).toBe('thinking');
    const prompt = 'INTERRUPT_ACCEPTED_RESPONSE_LOSS_ONCE';
    await openSession(page, sessionId);
    const browserFailures = captureSendFailures(page, sessionId);
    const message = page.getByRole('textbox', { name: '消息', exact: true });
    await message.fill(prompt);
    await page.getByRole('button', { name: '排队', exact: true }).click();
    await page.getByRole('button', { name: '停止当前执行并发送', exact: true }).click();
    await page.getByRole('button', { name: '停止当前执行并发送', exact: true }).click();

    await expect.poll(() => proxy.exchanges[0]?.dropped ?? false).toBe(true);
    await expect.poll(() => browserFailures.length).toBe(1);
    expect(browserFailures[0]).toContain('ERR_INCOMPLETE_CHUNKED_ENCODING');
    const first = proxy.exchanges[0]!;
    expect(first.responseStatus).toBe(202);
    expect(first.responseBody).toMatchObject({ accepted: true, task: { id: expect.any(String) } });
    expect(first.request).toMatchObject({ prompt, mode: 'interrupt' });
    await expect.poll(async () => (await instance.request('GET', `/api/sessions/${sessionId}`)).json.state, { intervals: TASK_POLL_INTERVALS }).toBe('idle');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect.poll(() => proxy.exchanges.length).toBe(2);
    expect(browserFailures).toHaveLength(1);
    const second = proxy.exchanges[1]!;
    expect(second.request).toMatchObject({ prompt, mode: 'interrupt', idempotencyKey: first.request.idempotencyKey });
    expect(second.responseBody.task.id).toBe(first.responseBody.task.id);
    await expect(message).toHaveValue('');

    await expectFinishedPrompt(sessionId, prompt, 2);
    await expectSingleVisibleUserInstruction(page, prompt);
    await testInfo.attach('interrupt-accepted-response-loss.json', {
      body: JSON.stringify({ exchanges: proxy.exchanges, browserFailures, persisted: persistedPromptCounts(sessionId, prompt), realPromptCalls: realPromptCallCount(instance, prompt) }, null, 2),
      contentType: 'application/json'
    });
  });
});

test('partial proxy startup failure preserves the original failure and cleans the private server and socket', async () => {
  const partialInstance = await launchInstance();
  let partialProxy: AcceptedResponseLossProxy | undefined;
  const blocker = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    execFileSync(join(partialInstance.binDir, 'tmux'), ['new-session', '-d', '-s', 'send-idempotency-cleanup'], { stdio: 'ignore' });
    expect(existsSync(partialInstance.socket)).toBe(true);
    await expect((async () => {
      partialProxy = await startAcceptedResponseLossProxy(partialInstance.port, (blocker.address() as AddressInfo).port);
    })()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(partialProxy).toBeUndefined();
    blocker.closeAllConnections();
    await new Promise<void>(resolve => blocker.close(() => resolve()));

    let attachmentAttempts = 0;
    await cleanupAfterTest({
      status: 'failed',
      expectedStatus: 'passed',
      attach: async () => { attachmentAttempts++; throw new Error('injected attachment failure'); }
    }, partialInstance, partialProxy);
    expect(attachmentAttempts).toBe(1);
    expect(partialInstance.server.exitCode ?? partialInstance.server.signalCode).not.toBeNull();
    await expect(partialInstance.request('GET', '/health')).rejects.toThrow();
    expect(existsSync(partialInstance.dataDir)).toBe(false);
    expect(existsSync(partialInstance.socket)).toBe(false);
  } finally {
    try { await partialProxy?.close(); }
    finally {
      try { await partialInstance.cleanup(); }
      finally {
        if (blocker.listening) {
          blocker.closeAllConnections();
          await new Promise<void>(resolve => blocker.close(() => resolve()));
        }
      }
    }
  }
});
