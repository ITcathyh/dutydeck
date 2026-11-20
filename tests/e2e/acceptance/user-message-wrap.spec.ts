import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_POLL_INTERVALS, launchIsolatedTestServer, type TestServerInstance } from './harness.js';

async function seedCompletedSession(instance: TestServerInstance, prompt: string): Promise<string> {
  const cwd = mkdtempSync(join(instance.dataDir, 'wrap-case-'));
  const created = await instance.request('POST', '/api/sessions', {
    agentId: 'claude-code',
    cwd,
    workspaceMode: 'shared'
  });
  expect(created.status, created.text).toBe(200);
  const sessionId = created.json.id as string;
  const sent = await instance.request('POST', `/api/sessions/${sessionId}/send`, { prompt, mode: 'queue' });
  expect(sent.status, sent.text).toBe(202);
  const taskId = sent.json.task.id as string;
  await expect.poll(async () => {
    const response = await instance.request('GET', `/api/sessions/${sessionId}/tasks`);
    return response.json?.find((task: { id: string }) => task.id === taskId)?.status;
  }, { timeout: 45_000, intervals: TASK_POLL_INTERVALS }).toBe('completed');
  await expect.poll(async () => (await instance.request('GET', `/api/sessions/${sessionId}`)).json?.state,
    { timeout: 30_000, intervals: TASK_POLL_INTERVALS }).toBe('idle');

  const events = await instance.request('GET', `/api/sessions/${sessionId}/events?limit=1000`);
  expect(events.status, events.text).toBe(200);
  expect(events.json.filter((event: { type: string; data: { role?: string } }) => event.type === 'text' && event.data.role === 'user')
    .map((event: { data: { text: string } }) => event.data.text)).toEqual([prompt]);
  return sessionId;
}

async function openUserBubble(page: Page, instance: TestServerInstance, sessionId: string): Promise<Locator> {
  await page.goto(`${instance.baseUrl}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
  const disclosure = page.getByRole('button', { name: /^(展开|收起)完整记录$/ }).first();
  await expect(disclosure).toBeVisible();
  if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
  const bubble = page.locator('.ui-timeline-item.justify-end > div').first();
  await expect(bubble).toBeVisible();
  return bubble;
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(clientWidth).toBeLessThanOrEqual(360);
}

async function contentLineCount(locator: Locator): Promise<number> {
  return locator.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).length;
  });
}

async function selectedText(locator: Locator): Promise<string> {
  return locator.evaluate(element => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const text = selection.toString();
    selection.removeAllRanges();
    return text;
  });
}

test('会话时间标注在桌面悬停或聚焦时显示，触屏常显，切换时正文高度不变', async ({ page, browser }) => {
  const instance = await launchIsolatedTestServer('dutydeck-message-time-');
  try {
    const sessionId = await seedCompletedSession(instance, '检查时间标注');
    const bubble = await openUserBubble(page, instance, sessionId);
    const sent = bubble.getByLabel(/^发送时间/);
    const ended = page.getByLabel(/^本轮结束时间/);
    const initial = await bubble.boundingBox();
    await expect(sent).toHaveCSS('opacity', '0');
    await bubble.hover();
    await expect(sent).toHaveCSS('opacity', '1');
    expect((await bubble.boundingBox())?.height).toBe(initial?.height);
    await page.mouse.move(0, 0);
    await bubble.focus();
    await expect(sent).toHaveCSS('opacity', '1');
    await ended.focus();
    await expect(ended).toHaveCSS('opacity', '1');

    const touch = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 800 } });
    try {
      const touchPage = await touch.newPage();
      const touchBubble = await openUserBubble(touchPage, instance, sessionId);
      await touchPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(touchBubble.getByLabel(/^发送时间/)).toHaveCSS('opacity', '1');
      await expect(touchPage.getByLabel(/^本轮结束时间/)).toHaveCSS('opacity', '1');
      await expectNoPageOverflow(touchPage);
    } finally { await touch.close(); }
  } finally { await instance.cleanup(); }
});

test('用户气泡在 360px 窄屏折行，正文和复制结果不变，代码块保持横向滚动', async ({ page, context }) => {
  test.setTimeout(180_000);
  const instance = await launchIsolatedTestServer('dutydeck-user-wrap-');
  try {
    await page.setViewportSize({ width: 360, height: 800 });
    const samples = [
      { kind: '长 URL', text: `https://example.invalid/${'segment/'.repeat(50)}?q=${'x'.repeat(160)}` },
      { kind: '连续 ASCII', text: `ASCII_${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(18)}_END` },
      { kind: 'CJK', text: '中文长文本应当保持原字并在用户气泡里自然折行。'.repeat(18) },
      { kind: 'emoji', text: '🙂🚀🌍✨'.repeat(70) }
    ];

    for (const sample of samples) {
      const sessionId = await seedCompletedSession(instance, sample.text);
      const bubble = await openUserBubble(page, instance, sessionId);
      const body = bubble.locator(':scope > div').first();
      await expect(body, sample.kind).toHaveText(sample.text);
      await expectNoPageOverflow(page);
      expect(await selectedText(body), `${sample.kind}选区复制文本`).toBe(sample.text);
      const paragraph = bubble.locator('p');
      await expect(paragraph).toHaveCount(1);
      expect(await contentLineCount(paragraph), `${sample.kind}实际折成多行`).toBeGreaterThan(1);
      expect(await bubble.evaluate(element => ({
        bubble: getComputedStyle(element).overflowWrap,
        minWidth: getComputedStyle(element).minWidth,
        paragraph: getComputedStyle(element.querySelector('p')!).overflowWrap
      })), sample.kind).toEqual({ bubble: 'anywhere', minWidth: '0px', paragraph: 'anywhere' });
      if (sample.kind === '长 URL') {
        const link = bubble.getByRole('link');
        await expect(link).toHaveText(sample.text);
        await expect(link).toHaveAttribute('href', sample.text);
        expect(await link.evaluate(element => getComputedStyle(element).overflowWrap)).toBe('anywhere');
      }
    }

    const code = `CODELINE_${'x'.repeat(600)}_END`;
    const codeSession = await seedCompletedSession(instance, `代码块\n\n\`\`\`text\n${code}\n\`\`\``);
    const codeBubble = await openUserBubble(page, instance, codeSession);
    const pre = codeBubble.locator('pre');
    await expect(pre).toBeVisible();
    await expect(pre.locator('code')).toHaveText(code);
    const preMetrics = await pre.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
      ownWrap: getComputedStyle(element).overflowWrap,
      descendantsKeepNormal: Array.from(element.querySelectorAll('*')).every(child => getComputedStyle(child).overflowWrap === 'normal')
    }));
    expect(preMetrics).toMatchObject({ overflowX: 'auto', ownWrap: 'normal', descendantsKeepNormal: true });
    expect(preMetrics.scrollWidth).toBeGreaterThan(preMetrics.clientWidth);
    const codeLine = pre.locator('code > span');
    await expect(codeLine).toHaveCount(1);
    const codeLineMetrics = await codeLine.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight)
    }));
    expect(codeLineMetrics.height).toBe(codeLineMetrics.lineHeight);
    await expectNoPageOverflow(page);

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: instance.baseUrl });
    await codeBubble.getByRole('button', { name: '复制代码', exact: true }).click();
    await expect(codeBubble.getByRole('button', { name: '代码已复制', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  } finally {
    await instance.cleanup();
  }
});
