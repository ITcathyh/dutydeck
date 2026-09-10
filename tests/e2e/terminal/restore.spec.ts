import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function setup(page: Page, fullscreen = false) {
  const { PtyCliDriver } = await import('../../../packages/pty-driver/dist/index.js');
  const { TmuxBackend } = await import('../../../packages/session-backends/dist/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-browser-terminal-'));
  const name = 'dutydeck-browser-' + process.pid + '-' + Date.now();
  const ownerId = name;
  const lines = Array.from({ length: 200 }, (_, i) => `history ${String(i).padStart(3, '0')}`).join('\n');
  const fixture = join(dir, 'quiet.cjs');
  writeFileSync(join(dir, 'history.txt'), lines);
  writeFileSync(fixture, `process.stdout.write(${JSON.stringify(lines.replaceAll('\n', '\r\n') + '\r\nREADY')});process.stdin.resume();`);
  const make = () => new PtyCliDriver({
    agent: { id: 'fixture', name: 'Fixture', command: fullscreen ? '/usr/bin/less' : process.execPath,
      args: [], cwd: dir, env: {}, permissionMode: 'full-trust', protocol: 'pty-cli',
      timeout: 30, capabilities: { pause: false, resume: false }, builtin: false },
    adapter: { id: 'fixture', capabilities: {}, buildArgs: () => fullscreen ? ['--mouse', '-R', join(dir, 'history.txt')] : [fixture], writeInput() {} },
    backend: new TmuxBackend(name, { ownerId }), sessionId: name, onEvent() {}, onExit() {}
  });
  let driver = make();
  await driver.start();
  const pane = () => execFileSync('tmux', ['capture-pane', '-p', '-t', name], { encoding: 'utf8' });
  try {
    await expect.poll(pane).toContain(fullscreen ? 'history 000' : 'READY');
    driver.prepareForDaemonShutdown();
    await driver.stop();
    driver = make();
    expect(driver.attachTerminal()).toBe(true);
    await page.routeWebSocket('**/api/terminal/scroll-test', ws => {
      const stream = driver.createTerminalStream();
      ws.onMessage(message => {
        const frame = JSON.parse(String(message));
        if (frame.type === 'input') stream.write(frame.data);
        if (frame.type === 'resize') stream.resize(frame.cols, frame.rows);
      });
      stream.onData(data => ws.send(JSON.stringify({ type: 'data', data })),
        screen => ws.send(JSON.stringify({ type: 'snapshot', ...screen })));
      ws.onClose(() => stream.dispose());
    });
    await page.goto('/e2e/terminal.html');
    await expect(page.locator('.xterm-rows')).toContainText(fullscreen ? 'history 000' : 'READY');
    return { pane, cleanup: async () => { await driver.stop(); rmSync(dir, { recursive: true, force: true }); } };
  } catch (error) { await driver.stop(); rmSync(dir, { recursive: true, force: true }); throw error; }
}
const scrollTop = (page: Page) => page.locator('.xterm-viewport').evaluate(el => el.scrollTop);
async function swipe(page: Page, distance: number) {
  const box = (await page.locator('.xterm-screen').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * i / 6 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('quiet real tmux terminal survives daemon reattach and same-size reload with scrollable history', async ({ page }) => {
  const fixture = await setup(page);
  try {
    for (let i = 0; i < 2; i++) {
      await page.reload();
      await expect(page.locator('.xterm-rows')).toContainText('READY');
      await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);
      const bottom = await scrollTop(page);
      await page.locator('.xterm-screen').hover();
      await page.mouse.wheel(0, -240);
      await expect.poll(() => scrollTop(page)).toBeLessThan(bottom);
      await page.mouse.wheel(0, 240);
      await expect.poll(() => scrollTop(page)).toBe(bottom);
    }
  } finally { await fixture.cleanup(); }
});

test.describe('restored real terminal on mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('touch scrolls restored history in both directions after reload', async ({ page }) => {
    const fixture = await setup(page);
    try {
      await page.reload();
      await expect(page.locator('.xterm-rows')).toContainText('READY');
      const bottom = await scrollTop(page);
      await swipe(page, 120);
      await expect.poll(() => scrollTop(page)).toBeLessThan(bottom);
      const above = await scrollTop(page);
      await swipe(page, -120);
      await expect.poll(() => scrollTop(page)).toBeGreaterThan(above);
    } finally { await fixture.cleanup(); }
  });
  test('restored full-screen less receives touch scrolling and changes its real pane', async ({ page }) => {
    const fixture = await setup(page, true);
    try {
      await page.reload();
      await expect(page.locator('.xterm-rows')).toContainText('history 000');
      await swipe(page, -120);
      await expect.poll(fixture.pane).not.toContain('history 000');
      await expect(page.locator('.xterm-rows')).not.toContainText('history 000');
      await swipe(page, 120);
      await expect.poll(fixture.pane).toContain('history 000');
      await expect(page.locator('.xterm-rows')).toContainText('history 000');
    } finally { await fixture.cleanup(); }
  });
});
