import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRealShareToken, readAuthContextFromDb } from './session-insight-security-harness.js';
import { REPO_ROOT, launchIsolatedTestServer, type TestServerInstance } from './harness.js';

async function api(instance: TestServerInstance, method: string, path: string, body?: unknown) {
  const response = await instance.request(method, path, body);
  expect(response.status, `${method} ${path}: ${response.text}`).toBe(200);
  return response.json;
}

async function session(instance: TestServerInstance) {
  return api(instance, 'POST', '/api/sessions', { cwd: instance.sourceRepo, agentId: 'claude-code', permissionMode: 'full-trust' });
}

async function plan(instance: TestServerInstance, sessionId: string, name: string, prompt = name, extra = {}) {
  const result = await api(instance, 'POST', `/api/sessions/${sessionId}/automation/schedules`, {
    name, prompt, trigger: { kind: 'cron', expression: '0 9 * * *' }, timezone: 'UTC',
    dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }, ...extra
  });
  expect(result.schedule.enabled).toBe(false);
  return result.schedule;
}

function pathFor(sessionId: string, scheduleId: string) {
  return `/api/sessions/${sessionId}/automation/schedules/${scheduleId}`;
}

async function run(instance: TestServerInstance, sourceSessionId: string, schedule: any, key: string) {
  const path = pathFor(sourceSessionId, schedule.id);
  const { occurrence } = await api(instance, 'POST', `${path}/run`, {
    expectedRevision: schedule.revision, idempotencyKey: key
  });
  await expect.poll(async () => {
    const detail = await api(instance, 'GET', `${path}/runs/${occurrence.id}`);
    return detail.occurrence.runStatus;
  }, { timeout: 75_000 }).toBe('completed');
  const detail = await api(instance, 'GET', `${path}/runs/${occurrence.id}`);
  expect(detail.occurrence.result.output.text).toContain(schedule.prompt);
  expect(detail.occurrence.taskId).toBeTruthy();
  expect(detail.attempts.length).toBeGreaterThan(0);
  return detail;
}

test('plan listing is complete and name-only edits preserve execution timing', async ({ page }) => {
  const instance = await launchIsolatedTestServer('dutydeck-acc-plan-index-');
  try {
    const origin = await session(instance);
    const saved = await plan(instance, origin.id, 'Before rename');
    // Empty sessions must not consume the plan page.
    for (let i = 0; i < 10; i++) await session(instance);
    const other = await session(instance);
    const second = await plan(instance, other.id, 'Other plan');
    const path = pathFor(origin.id, saved.id);
    const enabled = (await api(instance, 'PATCH', path, { expectedRevision: saved.revision, enabled: true })).schedule;
    const renamed = (await api(instance, 'PATCH', path, { expectedRevision: enabled.revision, name: 'After rename' })).schedule;
    expect(renamed.revision).toBe(enabled.revision + 1);
    expect(renamed.generation).toBe(enabled.generation);
    expect(renamed.nextDueAt).toBe(enabled.nextDueAt);
    expect(renamed.prompt).toBe(enabled.prompt);
    const conflict = await instance.request('PATCH', path, { expectedRevision: enabled.revision, name: 'Stale rename' });
    expect(conflict.status).toBe(409);

    const first = await api(instance, 'GET', '/api/automation/schedules?offset=0&limit=1&sort=name');
    const next = await api(instance, 'GET', '/api/automation/schedules?offset=1&limit=1&sort=name');
    expect(first.total).toBe(2);
    expect(next.total).toBe(2);
    expect(first.items).toHaveLength(1);
    expect(next.items).toHaveLength(1);
    expect(new Set([...first.items, ...next.items].map(item => item.schedule.id))).toEqual(new Set([saved.id, second.id]));
    expect(first.counts).toEqual(next.counts);
    expect(Object.values(first.counts).reduce((sum: number, value) => sum + Number(value), 0)).toBe(2);

    for (const expression of ['0/5/2 * * * *', '1-2-3 * * * *', '0,,5 * * * *']) {
      const rejected = await instance.request('PATCH', path, {
        expectedRevision: renamed.revision, trigger: { kind: 'cron', expression }
      });
      expect(rejected.status, expression).toBe(400);
    }
    expect((await api(instance, 'GET', path)).schedule).toEqual(renamed);
    const { shareSecret } = readAuthContextFromDb(instance.dataDir);
    expect(shareSecret).toBeTruthy();
    const share = createRealShareToken(shareSecret!, origin.id);
    expect((await instance.request('GET', `/api/sessions/${origin.id}?share=${share}`)).status).toBe(200);
    const denied = await instance.request('GET', `/api/automation/schedules?share=${share}`);
    expect(denied.status).toBe(401);
    expect(denied.text).not.toContain('After rename');
    await page.goto(`${instance.baseUrl}/?nav=automation`);
    await expect(page.getByRole('heading', { name: '计划中心', exact: true })).toBeVisible();
    await expect(page.getByText('After rename · 已启用', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('schedule-overview.png'), fullPage: true });
  } finally {
    await instance.cleanup();
  }
});

test('old per-plan history opens its exact result after reload and tables scroll locally', async ({ page, context }) => {
  test.setTimeout(300_000);
  const instance = await launchIsolatedTestServer('dutydeck-acc-plan-history-');
  try {
    const origin = await session(instance);
    const longCell = 'long-cell-'.repeat(60);
    const redactedReport = readFileSync(join(REPO_ROOT, 'apps/web/src/fixtures/automation-report.redacted.md'), 'utf8');
    const markdown = `SCHEDULE_EXACT_OLD_RESULT\n\n${redactedReport}\n\n| Item | Evidence |\n| --- | --- |\n| Weekly | ${longCell} |\n\n[Safe link](https://example.com/report)\n\n<script>window.scheduleXss=true</script>\n\n\`\`\`text\nCOPY_CODE\n\`\`\``;
    const saved = await plan(instance, origin.id, 'History A', markdown);
    const second = await plan(instance, origin.id, 'History B', 'OTHER_PLAN_RESULT');
    const oldest = await run(instance, origin.id, saved, 'history-a-0');
    for (let i = 1; i < 21; i++) await run(instance, origin.id, saved, `history-a-${i}`);
    const otherRun = await run(instance, origin.id, second, 'history-b-0');
    const path = pathFor(origin.id, saved.id);
    const newestPage = await api(instance, 'GET', `${path}/history?offset=0&limit=20`);
    const olderPage = await api(instance, 'GET', `${path}/history?offset=20&limit=20`);
    expect(newestPage.total).toBe(21);
    expect(newestPage.occurrences).toHaveLength(20);
    expect(olderPage.occurrences.map((item: any) => item.id)).toEqual([oldest.occurrence.id]);
    expect([...newestPage.occurrences, ...olderPage.occurrences].every(item => item.scheduleId === saved.id)).toBe(true);
    const wrongPlan = await instance.request('GET', `${path}/runs/${otherRun.occurrence.id}`);
    expect(wrongPlan.status).toBe(404);

    const url = `${instance.baseUrl}/?nav=automation&automationSession=${origin.id}&schedule=${saved.id}&run=${oldest.occurrence.id}`;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: instance.baseUrl });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    const detail = page.getByRole('region', { name: '单次运行详情', exact: true });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('SCHEDULE_EXACT_OLD_RESULT');
    await expect(detail).not.toContainText('OTHER_PLAN_RESULT');
    await page.reload();
    await expect(detail).toContainText('SCHEDULE_EXACT_OLD_RESULT');
    const tableRegion = detail.getByRole('region', { name: '表格，可横向滚动', exact: true })
      .filter({ has: page.getByRole('columnheader', { name: 'Evidence', exact: true }) });
    await expect(tableRegion.getByRole('columnheader', { name: 'Evidence', exact: true })).toBeVisible();
    expect(await tableRegion.evaluate(element => ({
      overflow: getComputedStyle(element).overflowX,
      scrolls: element.scrollWidth > element.clientWidth
    }))).toEqual({ overflow: 'auto', scrolls: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => (window as any).scheduleXss)).toBeUndefined();
    await page.screenshot({ path: test.info().outputPath('schedule-run-narrow.png') });
    await tableRegion.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('schedule-run-narrow-table.png') });
    await expect(detail.getByRole('link', { name: 'Safe link', exact: true })).toHaveAttribute('href', 'https://example.com/report');
    await detail.getByRole('button', { name: '复制结果原文', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(oldest.occurrence.result.output.text);
    const fixed = await api(instance, 'GET', `${path}/runs/${oldest.occurrence.id}`);
    expect(fixed.occurrence.taskId).toBe(oldest.occurrence.taskId);
    expect(fixed.occurrence.result).toEqual(oldest.occurrence.result);
    expect((await api(instance, 'GET', `${pathFor(origin.id, second.id)}/history?offset=0&limit=20`)).total).toBe(1);
  } finally {
    await instance.cleanup();
  }
});

test('independent plans keep a dedicated managed workspace after the origin stops', async () => {
  test.setTimeout(150_000);
  const instance = await launchIsolatedTestServer('dutydeck-acc-plan-independent-');
  try {
    const origin = await session(instance);
    const dependent = await plan(instance, origin.id, 'Session mode');
    const independent = await plan(instance, origin.id, 'Independent mode', 'INDEPENDENT_AFTER_ORIGIN_STOP', { mode: 'independent' });
    expect(independent.executionSessionId).toBeTruthy();
    expect(independent.executionSessionId).not.toBe(origin.id);
    expect(independent.executionContext.contextMode).toBe('prompt_only');
    expect(independent.executionContext.cwd).not.toBe(origin.cwd);
    const execution = await api(instance, 'GET', `/api/sessions/${independent.executionSessionId}`);
    expect(execution.cwd).toBe(independent.executionContext.cwd);
    const dependentPath = pathFor(origin.id, dependent.id);
    await api(instance, 'PATCH', dependentPath, { expectedRevision: dependent.revision, enabled: true });
    const independentPath = pathFor(origin.id, independent.id);
    const enabled = (await api(instance, 'PATCH', independentPath, { expectedRevision: independent.revision, enabled: true })).schedule;
    await api(instance, 'POST', `/api/sessions/${origin.id}/stop`);
    await expect.poll(async () => (await api(instance, 'GET', dependentPath)).schedule.enabled).toBe(false);
    const stillEnabled = (await api(instance, 'GET', independentPath)).schedule;
    expect(stillEnabled.enabled).toBe(true);
    expect(stillEnabled.executionSessionId).toBe(enabled.executionSessionId);
    const detail = await run(instance, origin.id, stillEnabled, 'origin-stopped');
    expect(detail.sourceSessionId).toBe(origin.id);
    expect(detail.executionSessionId).toBe(independent.executionSessionId);
    expect(detail.occurrence.executionSessionId).toBe(independent.executionSessionId);
    expect((await api(instance, 'GET', `/api/sessions/${origin.id}/tasks`))).toEqual([]);
    const deleted = await api(instance, 'DELETE', dependentPath, {
      expectedRevision: (await api(instance, 'GET', dependentPath)).schedule.revision
    });
    expect(deleted.schedule.deletedAt).toBeTruthy();
  } finally {
    await instance.cleanup();
  }
});
