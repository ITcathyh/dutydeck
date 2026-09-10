import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

async function openTerminal(page: Page, data: string) {
  let socket: WebSocketRoute;
  const inputs: string[] = [];
  await page.routeWebSocket('**/api/terminal/scroll-test', ws => {
    socket = ws;
    ws.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.type === 'input') inputs.push(frame.data);
    });
    ws.send(JSON.stringify({ type: 'data', data }));
  });
  await page.goto('/e2e/terminal.html');
  await expect(page.locator('.xterm-rows')).toContainText('READY');
  return { inputs, write: (data: string) => socket.send(JSON.stringify({ type: 'data', data })) };
}

const history = Array.from({ length: 200 }, (_, i) => `history ${i}\r\n`).join('') + 'READY';
const scrollTop = (page: Page) => page.locator('.xterm-viewport').evaluate(el => el.scrollTop);

async function swipe(page: Page, distance: number) {
  const screen = (await page.locator('.xterm-screen').boundingBox())!;
  const x = screen.x + screen.width / 2;
  const y = screen.y + screen.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * i / 6 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('desktop wheel scrolls history without sending input', async ({ page }) => {
  const { inputs } = await openTerminal(page, history);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);
  const bottom = await scrollTop(page);
  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -180);
  await expect.poll(() => scrollTop(page)).toBeLessThan(bottom);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => scrollTop(page)).toBe(bottom);
  expect(inputs).toEqual([]);
});

test('new output preserves history position until returning to the bottom', async ({ page }) => {
  const { write } = await openTerminal(page, history);
  await page.getByRole('textbox', { name: 'Terminal input' }).focus();
  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -180);
  const back = page.getByRole('button', { name: '回到底部' });
  await expect(back).toBeVisible();
  const visibleHistory = await page.locator('.xterm-rows').innerText();
  const height = await page.locator('.xterm-viewport').evaluate(el => el.scrollHeight);
  write('\r\nNEW OUTPUT\r\n');
  await expect.poll(() => page.locator('.xterm-viewport').evaluate(el => el.scrollHeight)).toBeGreaterThan(height);
  await expect(page.locator('.xterm-rows')).toHaveText(visibleHistory, { useInnerText: true });
  await expect(back).toBeVisible();
  await back.click();
  await expect(back).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
  await expect(page.locator('.xterm-rows')).toContainText('NEW OUTPUT');
  const bottom = await scrollTop(page);
  write('\r\nFOLLOW OUTPUT\r\n');
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(bottom);
  await expect(back).toBeHidden();
});

test('returning to the bottom from the keyboard restores terminal input', async ({ page }) => {
  const { inputs } = await openTerminal(page, history);
  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -180);
  const back = page.getByRole('button', { name: '回到底部' });
  await expect(back).toBeVisible();
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(back).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
  await page.keyboard.type('x');
  await expect.poll(() => inputs.join('')).toBe('x');
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('normal buffer scrolls in both directions', async ({ page }) => {
    const { inputs } = await openTerminal(page, history);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);
    const bottom = await scrollTop(page);
    await swipe(page, 120);
    await expect.poll(() => scrollTop(page)).toBeLessThan(bottom);
    const above = await scrollTop(page);
    await swipe(page, -120);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(above);
    expect(inputs).toEqual([]);
  });

  test('mouse-reporting full-screen app receives scroll gestures in both directions', async ({ page }) => {
    const { inputs } = await openTerminal(page, '\x1b[?1049h\x1b[?1000h\x1b[?1006hREADY');
    await expect(page.locator('.xterm')).toHaveClass(/enable-mouse-events/);
    await swipe(page, 120);
    await expect.poll(() => inputs.join('')).toMatch(/\x1b\[<64;\d+;\d+M/);
    inputs.length = 0;
    await swipe(page, -120);
    await expect.poll(() => inputs.join('')).toMatch(/\x1b\[<65;\d+;\d+M/);
  });

  test('alternate buffer without mouse reporting receives cursor scroll keys', async ({ page }) => {
    const { inputs } = await openTerminal(page, '\x1b[?1049h\x1b[?1hREADY');
    await swipe(page, 120);
    await expect.poll(() => inputs.join('')).toContain('\x1bOA');
    inputs.length = 0;
    await swipe(page, -120);
    await expect.poll(() => inputs.join('')).toContain('\x1bOB');
  });

  test('taps and selection mode do not send scroll input to a full-screen app', async ({ page }) => {
    const { inputs } = await openTerminal(page, '\x1b[?1049h\x1b[?1000h\x1b[?1006hREADY');
    await swipe(page, 3);
    expect(inputs.join('')).not.toMatch(/\x1b\[<6[45];/);
    await page.getByRole('button', { name: '进入选择模式，拖动可选中文字复制' }).click();
    inputs.length = 0;
    await swipe(page, 120);
    expect(inputs).toEqual([]);
    await page.getByRole('button', { name: '退出选择模式，恢复拖动滚动' }).click();
    await swipe(page, 120);
    await expect.poll(() => inputs.join('')).toMatch(/\x1b\[<64;/);
  });
});
