import { test, expect, type Page } from '@playwright/test';
import { launchIsolatedTestServer, type TestServerInstance } from './harness.js';

// Real Chromium and xterm parser/rendering; synthetic terminal frames and a private harness server.
test.describe('terminal plain-text copy', () => {
  let instance: TestServerInstance;
  let sessionId: string;
  const command = '1234567中🙂  command  with  spaces  ' + 'long-option '.repeat(12);
  test.beforeAll(async () => {
    instance = await launchIsolatedTestServer('dutydeck-terminal-copy-');
    const created = await instance.request('POST', '/api/sessions', { agentId: 'claude-code', cwd: instance.sourceRepo, workspaceMode: 'shared' });
    expect(created.status, created.text).toBe(200);
    sessionId = created.json.id;
  });
  test.afterAll(async () => { await instance?.cleanup(); });

  const open = async (page: Page, sent: any[]) => {
    await page.routeWebSocket(`**/api/terminal/${sessionId}`, socket => {
      socket.onMessage(message => sent.push(JSON.parse(String(message))));
      socket.send(JSON.stringify({ type: 'snapshot', cols: 8, rows: 30, data: command + '\r\nlast line' }));
    });
    await page.goto(`${instance.baseUrl}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '终端', exact: true }).click();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await expect(page.getByText('已连接，等待终端输出…', { exact: true })).toHaveCount(0);
  };

  test('390px screen text preserves wide glyphs and wraps, copies a selection, and reports clipboard denial', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const sent: any[] = [];
    await open(page, sent);
    await page.getByRole('button', { name: '复制终端文本', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '终端纯文本', exact: true });
    const area = dialog.getByRole('textbox', { name: '可复制的终端文本' });
    expect((await area.inputValue()).split('\n')[0]).toBe(command);
    await area.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(7, 12));
    await dialog.getByRole('button', { name: '复制文本', exact: true }).click();
    await expect(dialog.getByText('已复制', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command.slice(7, 12));
    expect(sent.filter(frame => frame.type === 'input')).toEqual([]);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } }));
    await dialog.getByRole('button', { name: '复制文本', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('复制失败');
    await page.setViewportSize({ width: 390, height: 420 });
    await expect.poll(async () => (await dialog.boundingBox())!.height).toBeLessThanOrEqual(420);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发送 Ctrl-C 中断当前命令' })).toBeVisible();
  });

  test('long press opens a logical line in a read-only terminal without input or remote resize', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Exercise the existing source=work_item read-only caller, using synthetic session metadata.
    await page.route('**/api/sessions', async route => {
      const response = await route.fetch();
      const sessions = await response.json();
      await route.fulfill({ response, json: sessions.map((session: any) => session.id === sessionId ? { ...session, source: 'work_item' } : session) });
    });
    const sent: any[] = [];
    await open(page, sent);
    await page.locator('.xterm-screen').evaluate(element => {
      const rect = element.getBoundingClientRect();
      const touch = new Touch({ identifier: 1, target: element, clientX: rect.left + 10, clientY: rect.top + 5 });
      element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch], changedTouches: [touch] }));
    });
    const dialog = page.getByRole('dialog', { name: '终端纯文本', exact: true });
    await expect(dialog).toBeVisible();
    const area = dialog.getByRole('textbox');
    await expect.poll(() => area.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe(command);
    await expect(area).toHaveAttribute('readonly', '');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('toolbar', { name: '终端快捷键' })).toHaveCount(0);
    expect(sent).toEqual([]);
  });
});
