// Run after building web and server: node tests/e2e/functional/bulk-cleanup.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  chromium, assertPortFree, createCleanupStack, createDataDir, createHttp,
  mockAgentsJson, seedCompletedSession, startServer, waitFor, writeMockCli
} from './journey-harness.mjs';

const port = Number(process.env.DUTYDECK_BULK_TEST_PORT ?? 14329);
const base = `http://127.0.0.1:${port}`;
const { onCleanup, runCleanup } = createCleanupStack({ log: console.log });

try {
  await assertPortFree(port);
  const dirs = createDataDir({ onCleanup, prefix: 'dutydeck-bulk-cleanup-' });
  const mockPath = writeMockCli(dirs.binDir);
  // The current Claude adapter requires a version heading before accepting input.
  writeFileSync(mockPath, readFileSync(mockPath, 'utf8').replaceAll('Mock Claude CLI', 'Claude Code v2.1.267'));
  const agentsJson = mockAgentsJson({ mockPath, dirs });
  agentsJson.find(agent => agent.id === 'seed').env.MOCK_TURN_MS = '60000';
  const server = startServer({ port, dirs, agentsJson, onCleanup });
  await server.waitUntilReady({ base });
  const request = createHttp(base);
  const done = await seedCompletedSession(request, { cwd: dirs.workspace, prompt: '批量清理：完成目标一' });
  const retry = await seedCompletedSession(request, { cwd: dirs.workspace, prompt: '批量清理：完成目标二' });
  const running = await request('POST', '/api/sessions', { agentId: 'seed', cwd: dirs.workspace });
  assert.equal(running.status, 200);
  const activeId = running.json.id;
  const inFlight = await request('POST', `/api/sessions/${activeId}/send`, { prompt: '批量清理：运行中的目标', mode: 'queue' });
  const queued = await request('POST', `/api/sessions/${activeId}/send`, { prompt: '批量清理：排队指令', mode: 'queue' });
  assert.equal(inFlight.status, 202);
  assert.equal(queued.status, 202);

  const browser = await chromium.launch({ headless: true });
  onCleanup('关闭浏览器', () => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base);
  const filters = page.getByRole('region', { name: '任务筛选' });
  await filters.getByRole('button', { name: '已完成 2', exact: true }).click();
  await page.getByRole('button', { name: '批量清理', exact: true }).click();
  await page.getByRole('checkbox', { name: '全选当前视图' }).check();
  await page.getByText('已选 2 个任务', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/dutydeck-bulk-cleanup-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '清理所选任务', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: '/tmp/dutydeck-bulk-cleanup-mobile.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '清理所选任务', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await request('GET', '/api/sessions')).json.filter(session => session.archivedAt).length, 0);
  console.log('PASS: desktop/mobile selection, confirmation cancellation leaves storage unchanged');

  const failPath = `**/api/sessions/${retry}/archive`;
  await page.route(failPath, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '临时失败，请重试' }) }));
  await page.getByRole('button', { name: '清理所选任务', exact: true }).click();
  await dialog.getByRole('button', { name: '确认清理', exact: true }).click();
  await dialog.getByRole('button', { name: '重试失败项', exact: true }).waitFor();
  assert.ok((await request('GET', `/api/sessions/${done}`)).json.archivedAt);
  assert.ok(!(await request('GET', `/api/sessions/${retry}`)).json.archivedAt);
  assert.ok(!(await request('GET', `/api/sessions/${activeId}`)).json.archivedAt);
  assert.ok((await request('GET', `/api/sessions/${activeId}/tasks`)).json.some(task => task.status === 'queued'));
  await page.unroute(failPath);
  await dialog.getByRole('button', { name: '重试失败项', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await filters.getByRole('button', { name: '已归档 2', exact: true }).click();
  const taskList = page.getByRole('region', { name: '任务列表' });
  await taskList.getByRole('button', { name: /批量清理：完成目标一/ }).waitFor();
  await taskList.getByRole('button', { name: /批量清理：完成目标二/ }).waitFor();
  await page.reload();
  await filters.getByRole('button', { name: '已归档 2', exact: true }).click();
  await taskList.getByRole('button', { name: /批量清理：完成目标一/ }).waitFor();
  console.log('PASS: filtered cleanup excludes running/queued work; partial success persists and failed item can be retried');

  await filters.getByRole('button', { name: '总览 1', exact: true }).click();
  await page.getByRole('button', { name: '批量清理', exact: true }).click();
  await page.getByRole('checkbox', { name: '全选当前视图' }).check();
  await page.getByRole('button', { name: '清理所选任务', exact: true }).click();
  await dialog.getByRole('button', { name: '确认清理', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await waitFor('运行中任务归档持久化', async () => {
    const session = (await request('GET', `/api/sessions/${activeId}`)).json;
    return session.state === 'stopped' && session.archivedAt;
  });
  const tasks = (await request('GET', `/api/sessions/${activeId}/tasks`)).json;
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find(task => task.id === inFlight.json.task.id)?.status, 'interrupted', JSON.stringify(tasks));
  assert.equal(tasks.find(task => task.id === queued.json.task.id)?.status, 'cancelled', JSON.stringify(tasks));
  assert.ok((await request('GET', `/api/sessions/${done}/events`)).json.some(event => event.type === 'text'));
  assert.deepEqual(pageErrors, []);
  console.log('PASS: running task stops, queued instructions cancel, historical events remain; no browser errors');
} finally {
  await runCleanup();
}
