// 临时探针：先在真实 Chromium 里摸清行为，再据此写断言。用完即删。
import { chromium } from '@playwright/test';
import { createCleanupStack, createDataDir, createHttp, createReporter, mockAgentsJson, startServer, waitFor, writeMockCli } from './e2e-harness.mjs';

const PORT = 14591;
const BASE = `http://127.0.0.1:${PORT}`;
const { log } = createReporter({ verbose: false });
const { onCleanup, runCleanup } = createCleanupStack({ log });
const request = createHttp(BASE);

try {
  const dirs = createDataDir({ onCleanup, prefix: 'dockmux-probe-' });
  const mockPath = writeMockCli(dirs.binDir);
  const { exitCode, serverLog } = startServer({ port: PORT, dirs, agentsJson: mockAgentsJson({ mockPath, dirs }), onCleanup });
  await waitFor('server', async () => {
    if (exitCode() !== undefined) throw new Error(`server exited ${exitCode()}: ${serverLog.join('')}`);
    const r = await request('GET', '/health');
    return r.status === 200;
  }, { timeoutMs: 45_000 });
  log('server up');

  // 造两个任务，带可区分目标（含中文）
  const goals = ['refactor the payment gateway', '重构支付网关的中文任务', 'unrelated telemetry cleanup'];
  const ids = [];
  for (const goal of goals) {
    const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
    ids.push(created.json.id);
    const sent = await request('POST', `/api/sessions/${created.json.id}/send`, { prompt: goal, mode: 'queue' });
    log('send', created.json.id, sent.status);
    onCleanup(`stop ${created.json.id}`, async () => { await request('POST', `/api/sessions/${created.json.id}/stop`); });
  }
  await waitFor('summaries', async () => {
    const r = await request('GET', '/api/sessions/summaries');
    return (r.json ?? []).length >= 3 ? r.json : undefined;
  }, { timeoutMs: 30_000 });
  log('summaries', JSON.stringify((await request('GET', '/api/sessions/summaries')).json));

  const browser = await chromium.launch({ headless: true });
  onCleanup('close chromium', () => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', e => log('PAGEERROR', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ timeout: 20_000 });

  // ── 主题 ──
  const themeProbe = async () => page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    stored: localStorage.getItem('dockmux.theme'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    canvas: getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim(),
    termBg: getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim(),
    emulated: window.matchMedia('(prefers-color-scheme: dark)').matches
  }));
  log('theme initial', JSON.stringify(await themeProbe()));
  const group = page.getByRole('radiogroup', { name: '界面外观' });
  log('radiogroup visible', await group.isVisible());
  const radios = await group.getByRole('radio').all();
  for (const r of radios) log('  radio', JSON.stringify(await r.getAttribute('aria-label')), 'checked=', await r.getAttribute('aria-checked'));
  await group.getByRole('radio', { name: /^深色/ }).click();
  log('after dark', JSON.stringify(await themeProbe()));
  await group.getByRole('radio', { name: /^浅色/ }).click();
  log('after light', JSON.stringify(await themeProbe()));
  await group.getByRole('radio', { name: /^跟随系统/ }).click();
  log('after system', JSON.stringify(await themeProbe()));
  await group.getByRole('radio', { name: /^深色/ }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ timeout: 20_000 });
  log('after reload', JSON.stringify(await themeProbe()));

  // ── 命令面板 ──
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '搜索任务与命令' });
  log('palette open', await palette.isVisible().catch(() => false));
  const statusLine = palette.getByRole('status');
  log('palette summary', await statusLine.textContent());
  const optionCount = async () => (await palette.getByRole('option').all()).length;
  log('options empty query', await optionCount());
  const input = palette.getByRole('combobox', { name: '搜索任务与命令' });
  await input.fill('payment');
  await page.waitForTimeout(300);
  log('summary payment', await statusLine.textContent(), 'options', await optionCount());
  const texts = await palette.getByRole('option').allInnerTexts();
  log('option texts payment', JSON.stringify(texts));
  await input.fill('支付网关');
  await page.waitForTimeout(300);
  log('summary CJK', await statusLine.textContent(), 'options', await optionCount());
  log('option texts CJK', JSON.stringify(await palette.getByRole('option').allInnerTexts()));
  await input.fill('ｐａｙｍｅｎｔ');
  await page.waitForTimeout(300);
  log('summary fullwidth', await statusLine.textContent());
  await input.fill('创建');
  await page.waitForTimeout(300);
  log('summary action query', await statusLine.textContent(), JSON.stringify(await palette.getByRole('option').allInnerTexts()));
  await page.keyboard.press('Escape');
  log('palette closed after Esc', !(await palette.isVisible().catch(() => false)));

  // 面板中激活一个任务 → 应导航
  await page.keyboard.press('Control+k');
  await input.fill('支付网关');
  await page.waitForTimeout(300);
  await palette.getByRole('option').first().click();
  await page.waitForTimeout(800);
  log('url after activating task option', page.url());
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ timeout: 20_000 });

  // ── 快捷键 ──
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: '键盘快捷键帮助' });
  log('help open via ?', await help.isVisible().catch(() => false));
  await page.keyboard.press('Escape');
  log('help closed', !(await help.isVisible().catch(() => false)));
  await page.keyboard.press('n');
  const createDialog = page.getByRole('dialog', { name: /创建.*任务/ });
  log('create open via n', await createDialog.isVisible().catch(() => false));
  // 在输入框内打字，单键快捷键必须沉默
  const goalInput = createDialog.getByLabel('任务目标');
  await goalInput.fill('');
  await goalInput.type('n?e');
  log('typed value in input', JSON.stringify(await goalInput.inputValue()));
  log('help NOT opened while typing', !(await help.isVisible().catch(() => false)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  log('create closed', !(await createDialog.isVisible().catch(() => false)));
  // g 和弦
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await page.waitForTimeout(800);
  const settings = page.getByRole('dialog');
  log('dialogs after g s', JSON.stringify(await page.getByRole('dialog').allInnerTexts().then(t => t.map(x => x.slice(0, 40)))));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  log('escape done, dialogs', (await page.getByRole('dialog').all()).length);

  log('--- probe part 1 done ---');
} catch (error) {
  log('PROBE ERROR', error.message);
  log(error.stack);
} finally {
  await runCleanup();
}
process.exit(0);
