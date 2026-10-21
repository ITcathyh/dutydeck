import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchIsolatedTestServer, type TestServerInstance } from './harness.js';

async function expectCompletedTask(instance: TestServerInstance, sessionId: string, prompt: string, timeout = 60_000) {
  const tasksPath = `/api/sessions/${sessionId}/tasks`;
  await expect.poll(async () => {
    const response = await instance.request('GET', tasksPath);
    expect(response.status).toBe(200);
    return response.json?.map((task: any) => ({ prompt: task.prompt, status: task.status }));
  }, { timeout }).toEqual([{ prompt, status: 'completed' }]);
  const task = (await instance.request('GET', tasksPath)).json[0];
  const projectsPath = join(instance.dataDir, 'claude', 'projects');
  const userEntries = readdirSync(projectsPath).flatMap(project =>
    readdirSync(join(projectsPath, project)).filter(file => file.endsWith('.jsonl')).flatMap(file =>
      readFileSync(join(projectsPath, project, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    )
  ).filter(entry => entry.type === 'user' && entry.message?.role === 'user');
  expect(userEntries).toHaveLength(1);
  const actualPrompt = userEntries[0].message.content;
  expect(typeof actualPrompt).toBe('string');
  expect(actualPrompt).toContain(`<dutydeck_session_id>${sessionId}</dutydeck_session_id>`);
  expect(actualPrompt.trim().slice(-prompt.length)).toBe(prompt);
  const expectedOutput = `MOCK_REPLY: ${actualPrompt.trim()}`;
  await expect.poll(async () => {
    const response = await instance.request('GET', `/api/sessions/${sessionId}/events?limit=1000`);
    expect(response.status).toBe(200);
    return response.json.filter((event: any) => event.taskId === task.id && event.type === 'text' && event.data.role !== 'user')
      .map((event: any) => event.data.text).join('');
  }, { timeout: 15_000 }).toBe(expectedOutput);
  return { task, expectedOutput };
}

test('creates a paused plan globally without sending a prompt, runs it explicitly, and retains deleted history', async ({ page }) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  const instance = await launchIsolatedTestServer('dutydeck-acc-scheduling-');
  try {
    const prompt = 'SCHEDULE_BROWSER_EXPLICIT_RUN';
    const name = 'Browser paused plan';
    const sendRequests: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/sessions\/[^/]+\/send$/.test(new URL(request.url()).pathname)) sendRequests.push(request.url());
    });
    await page.goto(instance.baseUrl);
    const sidebar = page.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await sidebar.getByRole('button', { name: /^自动化/ }).click();
    const automation = page.getByRole('main');
    await automation.getByRole('button', { name: '创建定时任务', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: '创建定时任务', exact: true });
    await expect(createDialog.getByRole('textbox', { name: '任务目标' })).toHaveCount(0);
    await createDialog.getByRole('textbox', { name: '工作目录', exact: true }).fill(instance.sourceRepo);
    await createDialog.getByText('执行任务的 Agent', { exact: true }).locator('..').getByRole('button').click();
    await createDialog.getByRole('option', { name: /^Mock Claude/ }).click();
    await createDialog.getByRole('checkbox', { name: /确认允许 Agent 直接操作此工作目录/ }).check();
    const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions' && response.request().method() === 'POST');
    await createDialog.getByRole('button', { name: '下一步：设置计划', exact: true }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(200);
    const session = await created.json();
    await expect(createDialog).toBeHidden();
    const tasksPath = `/api/sessions/${session.id}/tasks`;
    expect((await instance.request('GET', tasksPath)).json).toEqual([]);
    expect(sendRequests).toEqual([]);

    await automation.getByRole('textbox', { name: '计划名称', exact: true }).fill(name);
    await automation.getByRole('textbox', { name: '执行指令', exact: true }).fill(prompt);
    await automation.getByRole('combobox', { name: '触发方式', exact: true }).selectOption('daily');
    await automation.getByLabel('执行时间', { exact: true }).fill('09:00');
    await automation.getByRole('textbox', { name: '时区', exact: true }).fill('UTC');
    const schedulesPath = `/api/sessions/${session.id}/automation/schedules`;
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === schedulesPath && response.request().method() === 'POST');
    await automation.getByRole('button', { name: '保存计划', exact: true }).click();
    const saved = await savedResponse;
    expect(saved.status()).toBe(200);
    const { schedule } = await saved.json();
    expect(schedule).toMatchObject({ name, prompt, enabled: false, timezone: 'UTC', trigger: { kind: 'cron', expression: '0 9 * * *' } });
    expect((await instance.request('GET', tasksPath)).json).toEqual([]);
    expect(sendRequests).toEqual([]);
    await expect(automation.getByText(`${name} · 已停用`, { exact: true })).toBeVisible();

    const runPath = `${schedulesPath}/${schedule.id}/run`;
    const runResponse = page.waitForResponse(response => new URL(response.url()).pathname === runPath && response.request().method() === 'POST');
    await automation.getByRole('button', { name: '立即执行', exact: true }).click();
    const running = await runResponse;
    expect(running.status()).toBe(200);
    expect(running.request().postDataJSON()).toMatchObject({ expectedRevision: schedule.revision, idempotencyKey: expect.any(String) });
    const { occurrence } = await running.json();
    expect(occurrence).toMatchObject({ scheduleId: schedule.id, sessionId: session.id });
    const { task, expectedOutput } = await expectCompletedTask(instance, session.id, prompt);
    const automationPath = `/api/sessions/${session.id}/automation`;
    await expect.poll(async () => {
      const response = await instance.request('GET', automationPath);
      return response.json.occurrences.find((item: any) => item.id === occurrence.id)?.result?.output.text;
    }, { timeout: 75_000 }).toBe(expectedOutput);
    const afterRun = (await instance.request('GET', automationPath)).json;
    expect(afterRun.schedules[0]).toMatchObject({ enabled: false, trigger: schedule.trigger });
    expect(afterRun.schedules[0].nextDueAt).toBe(schedule.nextDueAt);
    expect(afterRun.occurrences).toHaveLength(1);
    expect(afterRun.occurrences[0]).toMatchObject({ taskId: task.id, runStatus: 'completed' });
    await automation.getByText('最近触发记录', { exact: true }).click();
    const resultLink = automation.getByRole('link', { name: `查看执行任务 · ${task.id}`, exact: true });
    await expect(resultLink).toHaveAttribute('href', `/sessions/${session.id}`);

    await automation.getByRole('button', { name: '删除', exact: true }).click();
    const deleteDialog = page.getByRole('alertdialog', { name: '删除定时计划', exact: true });
    const deletedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${schedulesPath}/${schedule.id}` && response.request().method() === 'DELETE');
    await deleteDialog.getByRole('button', { name: '删除计划', exact: true }).click();
    const deleted = await deletedResponse;
    expect(deleted.status()).toBe(200);
    const deletedSchedule = (await deleted.json()).schedule;
    await expect(deleteDialog).toBeHidden();
    await expect(automation.getByText(`${name} · 已停用`, { exact: true })).toHaveCount(0);
    await expect(automation.getByText(new RegExp(`历史计划 ${schedule.id}`))).toBeVisible();
    await expect(resultLink).toBeVisible();
    const rejectedRun = await instance.request('POST', runPath, { expectedRevision: deletedSchedule.revision, idempotencyKey: 'deleted-browser-plan' });
    expect(rejectedRun.status).toBe(409);
    expect(rejectedRun.json?.error.code).toBe('SESSION_AUTOMATION_SCHEDULE_DELETED');
    const history = (await instance.request('GET', automationPath)).json;
    expect(history.schedules).toEqual([]);
    expect(history.occurrences).toHaveLength(1);
    expect(history.occurrences[0]).toMatchObject({ id: occurrence.id, taskId: task.id, runStatus: 'completed', result: { output: { text: expectedOutput } } });
    expect((await instance.request('GET', tasksPath)).json).toHaveLength(1);

    await resultLink.click();
    await page.waitForURL(url => url.pathname === `/sessions/${session.id}`);
    await expect(page.getByRole('main').getByRole('article', { name: /最终输出/ })).toHaveText(expectedOutput);
  } finally {
    await instance.cleanup();
  }
});

test('an enabled once plan dispatches through the real timer and settles one exact runtime result', async () => {
  test.setTimeout(210_000);
  const instance = await launchIsolatedTestServer('dutydeck-acc-scheduling-timer-');
  try {
    const prompt = 'SCHEDULE_ONCE_TIMER_EXECUTION';
    const created = await instance.request('POST', '/api/sessions', { cwd: instance.sourceRepo, agentId: 'claude-code' });
    expect(created.status).toBe(200);
    const sessionId = created.json.id;
    const schedulesPath = `/api/sessions/${sessionId}/automation/schedules`;
    const saved = await instance.request('POST', schedulesPath, {
      name: 'Real timer once plan', prompt,
      trigger: { kind: 'at', localDateTime: new Date(Date.now() + 5_000).toISOString().slice(0, 19) },
      timezone: 'UTC', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }
    });
    expect(saved.status).toBe(200);
    expect(saved.json.schedule.enabled).toBe(false);
    expect((await instance.request('GET', `/api/sessions/${sessionId}/tasks`)).json).toEqual([]);
    const enabled = await instance.request('PATCH', `${schedulesPath}/${saved.json.schedule.id}`, { expectedRevision: saved.json.schedule.revision, enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.json.schedule.enabled).toBe(true);
    const { task, expectedOutput } = await expectCompletedTask(instance, sessionId, prompt, 90_000);
    const automationPath = `/api/sessions/${sessionId}/automation`;
    await expect.poll(async () => {
      const response = await instance.request('GET', automationPath);
      return response.json.occurrences.map((item: any) => ({ taskId: item.taskId, runStatus: item.runStatus, output: item.result?.output.text }));
    }, { timeout: 75_000 }).toEqual([{ taskId: task.id, runStatus: 'completed', output: expectedOutput }]);
    const final = (await instance.request('GET', automationPath)).json;
    expect(final.schedules[0]).toMatchObject({ id: saved.json.schedule.id, enabled: false });
    expect(final.schedules[0].nextDueAt).toBeUndefined();
    expect(final.occurrences[0].scheduledForUtc).toBe(enabled.json.schedule.nextDueAt);
    expect((await instance.request('GET', `/api/sessions/${sessionId}/tasks`)).json).toHaveLength(1);
  } finally {
    await instance.cleanup();
  }
});
