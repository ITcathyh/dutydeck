// 临时探针 2：隔离 n 快捷键、g 和弦、toast、移动端键条、终端换主题。用完即删。
import { chromium } from '@playwright/test';
import { createCleanupStack, createDataDir, createHttp, createReporter, loadWebSocket, mockAgentsJson, startServer, waitFor, writeMockCli, sleep } from './e2e-harness.mjs';

const PORT = 14592;
const BASE = `http://127.0.0.1:${PORT}`;
const { log } = createReporter({ verbose: false });
const { onCleanup, runCleanup } = createCleanupStack({ log });
const request = createHttp(BASE);

try {
  const dirs = createDataDir({ onCleanup, prefix: 'dockmux-probe2-' });
  const mockPath = writeMockCli(dirs.binDir);
  const { exitCode, serverLog } = startServer({ port: PORT, dirs, agentsJson: mockAgentsJson({ mockPath, dirs }), onCleanup });
  await waitFor('server', async () => {
    if (exitCode() !== undefined) throw new Error(`server exited ${exitCode()}: ${serverLog.join('')}`);
    return (await request('GET', '/health')).status === 200;
  }, { timeoutMs: 45_000 });

  const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
  const sid = created.json.id;
  onCleanup(`stop ${sid}`, async () => { await request('POST', `/api/sessions/${sid}/stop`); });
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'probe two baseline goal', mode: 'queue' });
  await waitFor('completed', async () => (await request('GET', `/api/sessions/${sid}`)).json?.state === 'completed', { timeoutMs: 60_000 });
  log('session completed', sid);

  const browser = await chromium.launch({ headless: true });
  onCleanup('close chromium', () => browser.close());
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await desktop.newPage();
  page.on('pageerror', e => log('PAGEERROR', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);

  const dialogNames = async () => {
    const all = await page.locator('[role="dialog"]').all();
    const out = [];
    for (const d of all) if (await d.isVisible().catch(() => false)) out.push(await d.getAttribute('aria-label'));
    return out;
  };
  const focusInfo = () => page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, label: a?.getAttribute?.('aria-label'), cls: (a?.className || '').toString().slice(0, 40) };
  });

  log('focus before n', JSON.stringify(await focusInfo()));
  await page.keyboard.press('n');
  await page.waitForTimeout(800);
  log('A) dialogs after fresh n', JSON.stringify(await dialogNames()));
  if ((await dialogNames()).length) { await page.keyboard.press('Escape'); await page.waitForTimeout(500); }

  // n 之后再来一次 ? / Escape / n 的顺序，复现 probe1 的失败
  await page.keyboard.press('?');
  await page.waitForTimeout(500);
  log('B) dialogs after ?', JSON.stringify(await dialogNames()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  log('B) dialogs after Escape', JSON.stringify(await dialogNames()), 'focus', JSON.stringify(await focusInfo()));
  await page.keyboard.press('n');
  await page.waitForTimeout(800);
  log('C) dialogs after n post-help', JSON.stringify(await dialogNames()));

  // 输入态抑制
  const create = page.getByRole('dialog', { name: '创建新任务' });
  if (await create.isVisible().catch(() => false)) {
    const goal = create.getByLabel('任务目标');
    await goal.click();
    await goal.fill('');
    await page.keyboard.type('n?e1');
    log('D) typed value', JSON.stringify(await goal.inputValue()), 'dialogs now', JSON.stringify(await dialogNames()));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  } else {
    log('D) SKIPPED: create dialog not open');
  }
  log('D) dialogs after escape', JSON.stringify(await dialogNames()));

  // g 和弦（g s = 设置）
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await page.waitForTimeout(1200);
  log('E) dialogs after g s', JSON.stringify(await dialogNames()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  log('E) dialogs after escape', JSON.stringify(await dialogNames()));

  // ── toast：取消一条待执行指令（会 push success toast + Undo action）
  await page.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // 让 session busy 起来，这样新指令会排队
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'long running one', mode: 'queue' });
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'queued cancel me', mode: 'queue' });
  await page.waitForTimeout(1500);
  const tasks = (await request('GET', `/api/sessions/${sid}/tasks`)).json ?? [];
  log('F) tasks', JSON.stringify(tasks.map(t => [t.id.slice(-6), t.status, t.prompt])));
  const cancelBtn = page.getByRole('button', { name: /取消排队/ });
  log('F) cancel buttons', (await cancelBtn.all()).length);
  if ((await cancelBtn.all()).length) {
    await cancelBtn.first().click();
    await page.waitForTimeout(600);
    const toastArea = page.locator('[aria-label="操作结果通知"]');
    log('F) toast text', JSON.stringify((await toastArea.innerText().catch(() => '')).slice(0, 300)));
    const undo = toastArea.getByRole('button', { name: /恢复这条指令/ });
    log('F) undo present', (await undo.all()).length);
  }
  // 归档 toast：4s success，用来验证自动消失
  log('G) --- toast auto dismiss check ---');
  const toastArea = page.locator('[aria-label="操作结果通知"]');
  log('G) toast text at t0', JSON.stringify((await toastArea.innerText().catch(() => '')).slice(0, 120)));

  // ── 终端主题重刷（xterm 把颜色烤进渲染层，看 .xterm-screen / viewport 的计算色）
  await page.getByRole('tab', { name: '终端' }).click();
  await page.waitForTimeout(2500);
  const termProbe = () => page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen');
    const vp = document.querySelector('.xterm-viewport');
    const xterm = document.querySelector('.xterm');
    return {
      hasScreen: Boolean(screen),
      vpBg: vp ? getComputedStyle(vp).backgroundColor : null,
      xtermBg: xterm ? getComputedStyle(xterm).backgroundColor : null,
      canvasCount: document.querySelectorAll('.xterm canvas').length,
      rowsText: (document.querySelector('.xterm-rows')?.textContent || '').slice(0, 60)
    };
  });
  log('H) terminal light', JSON.stringify(await termProbe()));
  await page.evaluate(() => { localStorage.setItem('dockmux.theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark'); });
  await page.waitForTimeout(1200);
  log('H) terminal after data-theme=dark', JSON.stringify(await termProbe()));

  // ── 移动端键条
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const mp = await phone.newPage();
  mp.on('pageerror', e => log('MOBILE PAGEERROR', e.message));
  await mp.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await mp.waitForTimeout(2500);
  log('I) mobile tabs', JSON.stringify(await mp.locator('[role="tab"]').allInnerTexts()));
  const termTab = mp.getByRole('tab', { name: '终端' });
  if (await termTab.isVisible().catch(() => false)) {
    await termTab.click();
    await mp.waitForTimeout(2500);
  }
  const bar = mp.getByRole('toolbar', { name: '终端快捷键' });
  log('I) keybar visible', await bar.isVisible().catch(() => false));
  if (await bar.isVisible().catch(() => false)) {
    const keys = await bar.getByRole('button').all();
    log('I) keybar buttons', keys.length);
    const boxes = [];
    for (const k of keys) boxes.push([await k.getAttribute('aria-label'), await k.boundingBox()]);
    log('I) key boxes', JSON.stringify(boxes.map(([l, b]) => [String(l).slice(0, 18), b && Math.round(b.width), b && Math.round(b.height)])));
  }
  // 桌面视口是否没有键条
  log('J) desktop keybar visible', await page.getByRole('toolbar', { name: '终端快捷键' }).isVisible().catch(() => false));

  // 按下 Esc 键是否真的写进 PTY：开第二条 WS 观察输出
  const WS = loadWebSocket();
  const observed = [];
  const ws = new WS(`ws://127.0.0.1:${PORT}/api/terminal/${encodeURIComponent(sid)}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', raw => { try { const f = JSON.parse(String(raw)); if (f.type === 'data') observed.push(f.data); } catch {} });
  log('K) observer ws open');
  await sleep(500);
  observed.length = 0;
  if (await bar.isVisible().catch(() => false)) {
    // 用一个会在屏幕上留下痕迹的键：^L 清屏、方向键 ↑ 会回显历史。先试 ↑
    await bar.getByRole('button', { name: /方向键上/ }).click();
    await sleep(1500);
    log('K) after ArrowUp, frames', observed.length, JSON.stringify(observed.join('').slice(0, 200)));
    observed.length = 0;
    await bar.getByRole('button', { name: /发送 Ctrl-L/ }).click().catch(async () => {
      await bar.getByRole('button', { name: /展开更多按键/ }).click();
      await sleep(400);
      await bar.getByRole('button', { name: /发送 Ctrl-L/ }).click();
    });
    await sleep(1500);
    log('K) after ^L, frames', observed.length, JSON.stringify(observed.join('').slice(0, 200)));
  }
  try { ws.close(); } catch {}
  log('--- probe 2 done ---');
} catch (error) {
  log('PROBE ERROR', error.message);
  log(error.stack);
} finally {
  await runCleanup();
}
process.exit(0);
