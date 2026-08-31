// 临时探针 5：终端 live 重刷（page.emulateMedia）、Illegal invocation 页面错误来源、
// 以及 n 的 stale-memo 机理确证。用完即删。
import { chromium } from '@playwright/test';
import { createCleanupStack, createDataDir, createHttp, createReporter, mockAgentsJson, startServer, waitFor, writeMockCli } from './e2e-harness.mjs';

const PORT = 14595;
const BASE = `http://127.0.0.1:${PORT}`;
const { log } = createReporter({ verbose: false });
const { onCleanup, runCleanup } = createCleanupStack({ log });
const request = createHttp(BASE);

try {
  const dirs = createDataDir({ onCleanup, prefix: 'dockmux-probe5-' });
  const mockPath = writeMockCli(dirs.binDir);
  const { exitCode, serverLog } = startServer({ port: PORT, dirs, agentsJson: mockAgentsJson({ mockPath, dirs }), onCleanup });
  await waitFor('server', async () => {
    if (exitCode() !== undefined) throw new Error(`server exited ${exitCode()}: ${serverLog.join('')}`);
    return (await request('GET', '/health')).status === 200;
  }, { timeoutMs: 45_000 });

  const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
  const sid = created.json.id;
  onCleanup(`stop ${sid}`, async () => { await request('POST', `/api/sessions/${sid}/stop`); });
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'probe five goal', mode: 'queue' });
  await waitFor('completed', async () => (await request('GET', `/api/sessions/${sid}`)).json?.state === 'completed', { timeoutMs: 60_000 });

  const browser = await chromium.launch({ headless: true });
  onCleanup('close chromium', () => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e); log('PAGEERROR', e.message, (e.stack || '').split('\n').slice(0, 3).join(' | ')); });

  // ── 终端 live 重刷
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: '终端' }).click();
  await page.waitForTimeout(2500);
  const term = () => page.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport');
    const rows = document.querySelector('.xterm-rows');
    return {
      attr: document.documentElement.getAttribute('data-theme'),
      vpBg: vp ? getComputedStyle(vp).backgroundColor : null,
      rowsColor: rows ? getComputedStyle(rows).color : null,
      panelBg: getComputedStyle(document.querySelector('#run-detail-panel-terminal') ?? document.body).backgroundColor
    };
  });
  log('A) terminal system=light', JSON.stringify(await term()));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(1500);
  log('A) terminal system=dark LIVE (no remount)', JSON.stringify(await term()));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(1200);
  log('A) terminal back to light', JSON.stringify(await term()));

  // 显式偏好写入 localStorage 后重载 → 终端 mount 时应直接是深色
  await page.evaluate(() => localStorage.setItem('dockmux.theme', 'dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: '终端' }).click();
  await page.waitForTimeout(2500);
  log('B) terminal explicit dark on mount', JSON.stringify(await term()));
  // 在终端页直接切回浅色（DOM 变更 → MutationObserver 应重刷）
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(1200);
  log('B) terminal after data-theme→light LIVE', JSON.stringify(await term()));

  log('C) page errors so far', errors.length, JSON.stringify(errors.map(e => e.message)));

  // ── n 的 stale-memo 确证：拦住 /api/agents 让它慢一点，再看首次 n
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p2.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ timeout: 20_000 });
  await p2.waitForTimeout(3000);
  const dialogNames = async pg => {
    const out = [];
    for (const d of await pg.locator('[role="dialog"]').all()) if (await d.isVisible().catch(() => false)) out.push(await d.getAttribute('aria-label'));
    return out;
  };
  // agents 显然已加载（按钮文案是「创建任务」而不是「准备 Agent」）
  log('D) primary button', JSON.stringify(await p2.locator('header button').last().innerText()));
  await p2.keyboard.press('n');
  await p2.waitForTimeout(900);
  log('D) fresh-load home, n →', JSON.stringify(await dialogNames(p2)), '（期望「创建新任务」）');
  // 帮助面板里 create-task 是否声称可用？
  for (let i = 0; i < 3; i++) { if (!(await dialogNames(p2)).length) break; await p2.keyboard.press('Escape'); await p2.waitForTimeout(400); }
  await p2.keyboard.press('?');
  await p2.waitForTimeout(700);
  const helpRow = p2.getByRole('dialog', { name: '键盘快捷键帮助' }).locator('li', { hasText: '新建任务运行' });
  log('E) help row for 新建任务运行', JSON.stringify((await helpRow.innerText().catch(() => '')).replace(/\n/g, ' | ')));

  log('--- probe 5 done ---');
} catch (error) {
  log('PROBE ERROR', error.message);
  log(error.stack);
} finally {
  await runCleanup();
}
process.exit(0);
