import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchIsolatedTestServer, REPO_ROOT, type TestServerInstance } from './harness.js';

// Real Chromium, HTTP, execution ledger and private files; the ACP model is a deterministic fixture.
test.describe('Configuration evidence, explicit project memory and artifact snapshots', () => {
  let instance: TestServerInstance;
  let promptLog: string;
  const oldFact = '项目发布窗口是周二上午。';
  const newFact = '项目发布窗口是周三下午。';

  const createSession = async () => {
    const response = await instance.request('POST', '/api/sessions', { agentId: 'happyclaw-fixture', cwd: instance.sourceRepo, workspaceMode: 'shared', model: 'fixture-before' });
    expect(response.status, response.text).toBe(200);
    return response.json as { id: string; cwd: string };
  };
  const openSession = async (page: Page, id: string) => {
    await page.goto(`${instance.baseUrl}/sessions/${id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  };
  const sendTurn = async (page: Page, sessionId: string, prompt: string) => {
    const receipt = page.waitForResponse(response => new URL(response.url()).pathname === `/api/sessions/${sessionId}/send` && response.request().method() === 'POST');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const response = await receipt;
    expect(response.status()).toBe(202);
    const { task } = await response.json();
    await expect.poll(async () => (await instance.request('GET', `/api/sessions/${sessionId}/tasks`)).json?.find((value: { id: string }) => value.id === task.id)?.status, { timeout: 30_000 }).toBe('completed');
    return task.id as string;
  };
  const receivedPrompt = (marker: string): string => {
    if (!existsSync(promptLog)) return '';
    const rows = readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { prompt: string });
    const recorded = rows.findLast(row => row.prompt.includes(marker))?.prompt;
    expect(recorded).toContain(marker);
    return recorded!;
  };

  test.beforeAll(async () => {
    instance = await launchIsolatedTestServer({ prefix: 'dutydeck-happyclaw-browser-', beforeLaunch: ({ dataDir, sourceRepo }) => {
      promptLog = join(dataDir, 'accepted-prompts.jsonl');
      return { agents: [{ id: 'happyclaw-fixture', name: 'HappyClaw ACP fixture', command: process.execPath, args: [join(REPO_ROOT, 'tests/fixtures/happyclaw-acp-agent.mjs')], protocol: 'acp', cwd: sourceRepo, model: 'fixture-before', permissionMode: 'full-trust', timeout: 60, builtin: false, version: 'fixture-1.0', env: { happyclaw_prompt_log: promptLog } }] };
    } });
  });
  test.afterAll(async () => { await instance?.cleanup(); });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus && instance) await info.attach('isolated-server.log', { body: instance.serverLog.join(''), contentType: 'text/plain' });
  });

  test('historical task and attempt show accepted model after current session settings change', async ({ page }) => {
    const session = await createSession();
    await openSession(page, session.id);
    const taskId = await sendTurn(page, session.id, 'HAPPYCLAW_HISTORY_BEFORE');
    const changed = await instance.request('PATCH', `/api/sessions/${session.id}/config`, { model: 'fixture-after' });
    expect(changed.status, changed.text).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: '配置来源', exact: true }).click();
    const explanation = page.getByRole('complementary', { name: '配置来源', exact: true });
    await expect(explanation.getByRole('region', { name: '当前会话', exact: true }).getByText('fixture-after', { exact: true })).toBeVisible();
    await expect(explanation.getByRole('region', { name: '已保存 · 后续启动', exact: true }).getByText('fixture-before', { exact: true })).toBeVisible();
    await explanation.getByRole('combobox', { name: '历史任务', exact: true }).selectOption(taskId);
    const evidence = await instance.request('GET', `/api/sessions/${session.id}/configuration?taskId=${taskId}`);
    expect(evidence.status).toBe(200);
    const attemptId = evidence.json.tasks.find((value: { id: string }) => value.id === taskId).attempts[0].id;
    await explanation.getByRole('combobox', { name: '执行尝试', exact: true }).selectOption(attemptId);
    const historical = explanation.getByRole('region', { name: '指定任务 / attempt', exact: true });
    await expect(historical.getByText('fixture-before', { exact: true })).toBeVisible();
    await expect(historical).not.toContainText('fixture-after');
    await expect(historical.getByText('未记录（unknown）', { exact: true }).first()).toBeVisible();
    await expect(explanation.getByRole('region', { name: '外部 CLI 配置', exact: true })).toContainText('未核验（unverified）');
  });

  test('project creation, explicit bindings, revision and disabling affect real next-turn inputs', async ({ page }) => {
    const first = await createSession(), second = await createSession();
    expect(first.cwd).toBe(second.cwd);
    await openSession(page, first.id);
    await page.getByRole('button', { name: '管理记忆', exact: true }).click();
    let memory = page.getByRole('complementary', { name: '记忆管理', exact: true });
    await memory.getByRole('textbox', { name: '新项目记忆名称', exact: true }).fill('浏览器验收项目');
    await memory.getByRole('button', { name: '创建项目记忆', exact: true }).click();
    await expect(memory.getByRole('button', { name: '添加记忆', exact: true })).toBeVisible();
    await expect(memory).toContainText('本会话绑定：无');
    await memory.getByRole('button', { name: '添加记忆', exact: true }).click();
    await memory.getByRole('textbox', { name: '记忆正文', exact: true }).fill(oldFact);
    await memory.getByRole('button', { name: '保存修订', exact: true }).click();
    await expect(memory.getByText(oldFact, { exact: true })).toBeVisible();
    await sendTurn(page, first.id, 'HAPPYCLAW_MEMORY_UNBOUND');
    expect(receivedPrompt('HAPPYCLAW_MEMORY_UNBOUND')).not.toContain(oldFact);
    await memory.getByRole('button', { name: '绑定所选项目', exact: true }).click();
    await expect(memory).toContainText('本会话绑定：浏览器验收项目');
    await sendTurn(page, first.id, 'HAPPYCLAW_MEMORY_BOUND');
    expect(receivedPrompt('HAPPYCLAW_MEMORY_BOUND')).toContain(oldFact);
    await memory.getByRole('listitem').filter({ hasText: oldFact }).getByRole('button', { name: '修订', exact: true }).click();
    await memory.getByRole('textbox', { name: '记忆正文', exact: true }).fill(newFact);
    await memory.getByRole('button', { name: '保存修订', exact: true }).click();
    await expect(memory.getByText(newFact, { exact: true })).toBeVisible();
    await sendTurn(page, first.id, 'HAPPYCLAW_MEMORY_REVISED');
    expect(receivedPrompt('HAPPYCLAW_MEMORY_REVISED')).toContain(newFact);
    expect(receivedPrompt('HAPPYCLAW_MEMORY_REVISED')).not.toContain(oldFact);
    const projectId = await memory.getByRole('combobox', { name: '查看项目记忆', exact: true }).inputValue();

    await openSession(page, second.id);
    await page.getByRole('button', { name: '管理记忆', exact: true }).click();
    memory = page.getByRole('complementary', { name: '记忆管理', exact: true });
    await expect(memory).toContainText('本会话绑定：无');
    await sendTurn(page, second.id, 'HAPPYCLAW_MEMORY_SECOND_UNBOUND');
    expect(receivedPrompt('HAPPYCLAW_MEMORY_SECOND_UNBOUND')).not.toContain(newFact);
    await memory.getByRole('combobox', { name: '查看项目记忆', exact: true }).selectOption(projectId);
    await memory.getByRole('button', { name: '绑定所选项目', exact: true }).click();
    await expect(memory).toContainText('本会话绑定：浏览器验收项目');
    await sendTurn(page, second.id, 'HAPPYCLAW_MEMORY_EXPLICIT_SHARE');
    expect(receivedPrompt('HAPPYCLAW_MEMORY_EXPLICIT_SHARE')).toContain(newFact);
    await memory.getByRole('button', { name: '关闭项目记忆', exact: true }).click();
    await expect(memory.getByRole('button', { name: '开启项目记忆', exact: true })).toBeVisible();
    await sendTurn(page, second.id, 'HAPPYCLAW_MEMORY_DISABLED');
    expect(receivedPrompt('HAPPYCLAW_MEMORY_DISABLED')).not.toContain(newFact);
    await page.reload();
    await page.getByRole('button', { name: '管理记忆', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '记忆管理', exact: true }).getByRole('button', { name: '开启项目记忆', exact: true })).toBeVisible();
  });

  test('snapshot preview is text and downloads retain old bytes after the source changes', async ({ page }, info) => {
    const session = await createSession();
    await openSession(page, session.id);
    await sendTurn(page, session.id, 'HAPPYCLAW_CAPTURE_REPORT');
    const source = join(session.cwd, 'report.html'), original = readFileSync(source);
    await page.getByRole('button', { name: '结果检视', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: '结果检视', exact: true });
    const references = inspector.getByRole('region', { name: '每轮产物引用', exact: true });
    await references.locator('summary').filter({ hasText: 'HAPPYCLAW_CAPTURE_REPORT' }).click();
    await references.getByRole('button', { name: '保存当前文件快照', exact: true }).click();
    const snapshot = references.getByRole('article', { name: '快照 report.html', exact: true });
    await expect(snapshot).toBeVisible();
    await expect(snapshot).toContainText(createHash('sha256').update(original).digest('hex'));
    await expect(snapshot).toContainText('这是点击保存时的内容');
    await snapshot.getByRole('button', { name: '查看快照文本', exact: true }).click();
    await expect(snapshot.locator('pre')).toHaveText(original.toString().trim());
    await expect(snapshot.locator('script, svg, iframe, img')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'happyclawPreviewExecuted'))).toBeUndefined();
    for (const generation of ['original', 'source-changed']) {
      if (generation === 'source-changed') writeFileSync(source, 'HAPPYCLAW_SOURCE_CHANGED_AFTER_SNAPSHOT');
      const downloaded = page.waitForEvent('download');
      await snapshot.getByRole('button', { name: '下载已保存快照', exact: true }).click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe('report.html');
      const destination = info.outputPath(`${generation}.html`);
      await download.saveAs(destination);
      expect(readFileSync(destination)).toEqual(original);
    }
    await snapshot.getByRole('button', { name: '查看来源记录', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: '对话', exact: true })).toBeVisible();
  });
});
