import { test, expect, type Page } from '@playwright/test';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { launchIsolatedTestServer, REPO_ROOT, TASK_POLL_INTERVALS, type TestServerInstance } from './harness.js';
import { startAcceptedResponseLossProxy } from './send-idempotency-proxy.js';

const storageRequire = createRequire(resolve(REPO_ROOT, 'packages/storage/package.json'));
const Database = storageRequire('better-sqlite3');

let instance: TestServerInstance;
let proxy: Awaited<ReturnType<typeof startAcceptedResponseLossProxy>>;

function persistedPromptCounts(sessionId: string, prompt: string) {
  const db = new Database(join(instance.dataDir, 'dutydeck.db'), { readonly: true });
  try {
    const tasks = db.prepare('SELECT id FROM tasks WHERE session_id = ? AND prompt = ?').all(sessionId, prompt);
    const totalTasks = db.prepare('SELECT count(*) AS count FROM tasks WHERE session_id = ?').get(sessionId).count as number;
    const rows = db.prepare("SELECT data FROM events WHERE session_id = ? AND type = 'text'").all(sessionId) as Array<{ data: string }>;
    const userEvents = rows.filter(row => {
      const data = JSON.parse(row.data);
      return data.role === 'user' && data.text === prompt;
    });
    return { tasks: tasks.length, userEvents: userEvents.length, totalTasks };
  } finally {
    db.close();
  }
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

test.beforeEach(async () => {
  instance = await launchIsolatedTestServer({
    prefix: 'dutydeck-send-idempotency-',
    beforeLaunch: ({ sourceRepo }) => {
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
          env: {}
        }]
      };
    }
  });
  proxy = await startAcceptedResponseLossProxy(instance.port);
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('isolated-server.log', { body: instance.serverLog.join(''), contentType: 'text/plain' });
    await testInfo.attach('send-exchanges.json', { body: JSON.stringify(proxy.exchanges, null, 2), contentType: 'application/json' });
  }
  await proxy?.close();
  await instance?.cleanup();
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

  await expect.poll(() => persistedPromptCounts(sessionId, prompt), { intervals: TASK_POLL_INTERVALS }).toEqual({ tasks: 1, userEvents: 1, totalTasks: 1 });
  await expectSingleVisibleUserInstruction(page, prompt);
  await testInfo.attach('queue-accepted-response-loss.json', {
    body: JSON.stringify({ exchanges: proxy.exchanges, browserFailures, persisted: persistedPromptCounts(sessionId, prompt) }, null, 2),
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

  await expect.poll(() => persistedPromptCounts(sessionId, prompt), { intervals: TASK_POLL_INTERVALS }).toEqual({ tasks: 1, userEvents: 1, totalTasks: 2 });
  await expectSingleVisibleUserInstruction(page, prompt);
  await testInfo.attach('interrupt-accepted-response-loss.json', {
    body: JSON.stringify({ exchanges: proxy.exchanges, browserFailures, persisted: persistedPromptCounts(sessionId, prompt) }, null, 2),
    contentType: 'application/json'
  });
});
