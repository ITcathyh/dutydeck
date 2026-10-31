import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import type { AgentEvent } from '@dutydeck/shared';
import { launchIsolatedTestServer, REPO_ROOT, type TestServerInstance } from './harness.js';

// Synthetic ACP model; real server, persistence, history API, SSE and Chromium.
test.describe('Session trace browser acceptance', () => {
  let instance: TestServerInstance;
  test.beforeAll(async () => {
    instance = await launchIsolatedTestServer({ prefix: 'dutydeck-trace-', beforeLaunch: ({ sourceRepo }) => ({ agents: [{
      id: 'trace-acp', name: 'Trace ACP fixture', command: process.execPath, args: [join(REPO_ROOT, 'tests/fixtures/mock-acp-agent.mjs')],
      protocol: 'acp', cwd: sourceRepo, permissionMode: 'full-trust', timeout: 60, builtin: false
    }] }) });
  });
  test.afterAll(async () => { await instance?.cleanup(); });

  test('searches, filters, expands and follows real persisted/live events in light, dark and narrow layouts', async ({ page }, info) => {
    const created = await instance.request('POST', '/api/sessions', { agentId: 'trace-acp', cwd: instance.sourceRepo, workspaceMode: 'worktree' });
    expect(created.status, created.text).toBe(200);
    const id = created.json.id as string;
    const first = await instance.request('POST', `/api/sessions/${id}/send`, { prompt: 'trace first turn', mode: 'queue' });
    expect(first.status, first.text).toBe(202);
    await expect.poll(async () => (await instance.request('GET', `/api/sessions/${id}/tasks`)).json[0]?.status, { timeout: 30_000 }).toBe('completed');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${instance.baseUrl}/sessions/${id}`);
    await page.getByRole('button', { name: '会话追踪', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '会话追踪', exact: true });
    const table = dialog.getByRole('table', { name: '追踪事件' });
    await expect(dialog.getByText('历史快照已读取；新事件随会话同步')).toBeVisible();
    await expect(table.getByText('trace first turn', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /^工具 \d/ }).click();
    await expect(table.getByRole('button', { name: /^事件 #\d+ 工具/ })).toHaveCount(2);
    await table.getByRole('button', { name: /^事件 #\d+ 工具结果/ }).click();
    await expect(dialog.getByLabel(/事件 #\d+ 数据/)).toContainText('completed');
    await dialog.getByRole('textbox', { name: '搜索追踪事件' }).fill('no matching trace canary');
    await expect(dialog.getByText('没有匹配的事件')).toBeVisible();
    await dialog.getByRole('textbox', { name: '搜索追踪事件' }).fill('');
    await dialog.getByRole('button', { name: /^全部 \d/ }).click();
    await dialog.getByRole('button', { name: '切换事件排序' }).click();
    await expect(dialog.getByRole('button', { name: '切换事件排序' })).toHaveText('最早优先');
    await dialog.getByRole('button', { name: '按轮次分组' }).click();
    await expect(dialog.getByRole('button', { name: '按轮次分组' })).toHaveAttribute('aria-pressed', 'false');

    const next = await instance.request('POST', `/api/sessions/${id}/send`, { prompt: 'trace live second turn canary', mode: 'queue' });
    expect(next.status, next.text).toBe(202);
    let assistant: AgentEvent<{ role?: string; text?: string }> | undefined;
    await expect.poll(async () => {
      const snapshot = await instance.request('GET', `/api/sessions/${id}/events?after=0&limit=200&direction=forward`);
      expect(snapshot.status, snapshot.text).toBe(200);
      assistant = (snapshot.json as AgentEvent<{ role?: string; text?: string }>[]).find(event => event.taskId === next.json.task.id && event.type === 'text'
        && (event.data?.role ?? 'assistant') === 'assistant' && event.data?.text?.includes('trace live second turn canary'));
      return assistant?.id;
    }, { timeout: 30_000 }).toBeTruthy();
    expect(assistant!.data.text).toContain('trace live second turn canary');
    const replyRow = table.getByRole('row').filter({ has: page.getByRole('button', { name: `事件 #${assistant!.sequence} 消息`, exact: true }) });
    await expect(replyRow).toContainText('trace live second turn canary');
    await replyRow.getByRole('button', { name: `事件 #${assistant!.sequence} 消息`, exact: true }).click();
    await expect(dialog.getByLabel(`事件 #${assistant!.sequence} 数据`)).toContainText('trace live second turn canary');
    await expect(dialog.getByRole('button', { name: /^工具 4$/ })).toBeVisible();
    await dialog.getByRole('button', { name: '按轮次分组' }).click();
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await dialog.screenshot({ path: info.outputPath('trace-light.png') });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await dialog.screenshot({ path: info.outputPath('trace-dark.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await expect(dialog.getByRole('textbox', { name: '搜索追踪事件' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('trace-narrow.png') });
    await dialog.getByRole('button', { name: '关闭会话追踪' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: '会话追踪', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: '会话分析', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '原始日志', exact: true })).toBeVisible();
  });
});
