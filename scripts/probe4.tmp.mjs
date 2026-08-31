// 临时探针 4：确诊 n 的失效机理（stale memo 闭包）、拿到稳定的 queued 任务跑 Undo、
// 用系统外观变化验证终端 live 重刷、以及 composer 输入态抑制。用完即删。
import { chromium } from '@playwright/test';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createCleanupStack, createDataDir, createHttp, createReporter, startServer, waitFor, writeMockCli } from './e2e-harness.mjs';

const PORT = 14594;
const BASE = `http://127.0.0.1:${PORT}`;
const { log } = createReporter({ verbose: false });
const { onCleanup, runCleanup } = createCleanupStack({ log });
const request = createHttp(BASE);

try {
  const dirs = createDataDir({ onCleanup, prefix: 'dockmux-probe4-' });
  // 慢速 mock：回复延迟 8s，好让第二条指令稳定停在 queued
  const mockPath = writeMockCli(dirs.binDir);
  const slowPath = join(dirs.binDir, 'mock-claude-slow');
  const src = (await import('node:fs')).readFileSync(mockPath, 'utf8').replace('}, 300);', '}, Number(process.env.MOCK_CLAUDE_DELAY_MS ?? 300));');
  writeFileSync(slowPath, src, 'utf8');
  chmodSync(slowPath, 0o755);

  const agentsJson = [{
    id: 'claude-code', name: 'Mock Claude', command: slowPath, args: [], protocol: 'pty-cli',
    cwd: dirs.workspace,
    env: { CLAUDE_CONFIG_DIR: dirs.claudeDataDir, MOCK_CLAUDE_DATA_DIR: dirs.claudeDataDir, MOCK_CLAUDE_DELAY_MS: '9000' },
    permissionMode: 'full-trust', timeout: 600, capabilities: { pause: false, resume: true }, builtin: false, version: 'mock-1.0'
  }];
  const { exitCode, serverLog } = startServer({ port: PORT, dirs, agentsJson, onCleanup });
  await waitFor('server', async () => {
    if (exitCode() !== undefined) throw new Error(`server exited ${exitCode()}: ${serverLog.join('')}`);
    return (await request('GET', '/health')).status === 200;
  }, { timeoutMs: 45_000 });

  const browser = await chromium.launch({ headless: true });
  onCleanup('close chromium', () => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => log('PAGEERROR', e.message, (e.stack || '').split('\n').slice(0, 3).join(' | ')));
  const dialogNames = async () => {
    const out = [];
    for (const d of await page.locator('[role="dialog"]').all()) if (await d.isVisible().catch(() => false)) out.push(await d.getAttribute('aria-label'));
    return out;
  };
  const closeAll = async () => { for (let i = 0; i < 4; i++) { if (!(await dialogNames()).length) return; await page.keyboard.press('Escape'); await page.waitForTimeout(400); } };

  // 一个已完成的 session，供后面用
  const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
  const sid = created.json.id;
  onCleanup(`stop ${sid}`, async () => { await request('POST', `/api/sessions/${sid}/stop`); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2500);

  // ── 诊断 n：fresh home（agents 加载后）
  await page.keyboard.press('n');
  await page.waitForTimeout(800);
  log('A) fresh home, press n →', JSON.stringify(await dialogNames()));
  await closeAll();

  // 触发一次 memo 重算但不重新加载页面：SPA 内进 session 再用 g t 回首页
  await page.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await page.waitForTimeout(1500);
  log('B) after g t, on home?', await page.getByRole('heading', { name: '今天需要推进什么？' }).isVisible().catch(() => false), 'url', page.url());
  await page.keyboard.press('n');
  await page.waitForTimeout(800);
  log('C) home reached via SPA nav, press n →', JSON.stringify(await dialogNames()));
  await closeAll();

  // ── composer 输入态抑制
  await page.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const composer = page.locator('textarea').first();
  log('D) composer count', (await page.locator('textarea').all()).length, 'visible', await composer.isVisible().catch(() => false));
  if (await composer.isVisible().catch(() => false)) {
    await composer.click();
    await composer.fill('');
    await page.keyboard.type('n?1te');
    await page.waitForTimeout(600);
    log('D) composer value', JSON.stringify(await composer.inputValue()), 'dialogs', JSON.stringify(await dialogNames()));
    // Mod+K 在输入态仍必须可用
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(600);
    log('D) after Ctrl+K inside textarea →', JSON.stringify(await dialogNames()));
    await closeAll();
    await composer.fill('');
  }

  // ── 稳定的 queued 任务 → Undo
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'OCCUPIER slow turn', mode: 'queue' });
  await page.waitForTimeout(1500);
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'UNDO_TARGET_TASK', mode: 'queue' });
  await page.waitForTimeout(1500);
  let tasks = (await request('GET', `/api/sessions/${sid}/tasks`)).json ?? [];
  log('E) tasks', JSON.stringify(tasks.map(t => [t.status, t.prompt])));
  const cancelBtn = page.getByRole('button', { name: '取消排队：UNDO_TARGET_TASK' });
  log('E) cancel button visible', await cancelBtn.isVisible().catch(() => false));
  const polite = page.locator('[aria-live="polite"][aria-label="操作结果通知"]');
  if (await cancelBtn.isVisible().catch(() => false)) {
    await cancelBtn.click();
    await page.waitForTimeout(900);
    log('E) polite', JSON.stringify((await polite.innerText().catch(() => '')).slice(0, 260)));
    const undo = polite.getByRole('button', { name: '恢复这条指令' });
    log('E) undo button visible', await undo.isVisible().catch(() => false));
    tasks = (await request('GET', `/api/sessions/${sid}/tasks`)).json ?? [];
    log('E) tasks after cancel', JSON.stringify(tasks.map(t => [t.status, t.prompt])));
    if (await undo.isVisible().catch(() => false)) {
      await undo.click();
      await page.waitForTimeout(1500);
      tasks = (await request('GET', `/api/sessions/${sid}/tasks`)).json ?? [];
      log('E) tasks after undo', JSON.stringify(tasks.map(t => [t.status, t.prompt])));
      log('E) polite after undo', JSON.stringify((await polite.innerText().catch(() => '')).slice(0, 200)));
    }
    // 自动消失：success+action 至少 10s，这里只验证「还在」
    log('E) toast cards right after', (await page.locator('.ui-toast').all()).length);
  }

  // ── 终端 live 重刷：preference=system，用系统外观切换
  await page.evaluate(() => localStorage.removeItem('dockmux.theme'));
  await ctx.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: '终端' }).click();
  await page.waitForTimeout(2500);
  const term = () => page.evaluate(() => {
    const vp = document.querySelector('.xterm-viewport');
    return { attr: document.documentElement.getAttribute('data-theme'), vpBg: vp ? getComputedStyle(vp).backgroundColor : null, has: Boolean(vp) };
  });
  log('F) terminal, system=light', JSON.stringify(await term()));
  await ctx.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(1500);
  log('F) terminal, system=dark (live, no remount)', JSON.stringify(await term()));
  await ctx.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(1200);
  log('F) terminal, back to system=light', JSON.stringify(await term()));

  // 显式深色偏好在首页选，再进终端（mount 路径）
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ timeout: 20_000 });
  await page.getByRole('radiogroup', { name: '界面外观' }).getByRole('radio', { name: /^深色/ }).click();
  await page.waitForTimeout(400);
  await page.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: '终端' }).click();
  await page.waitForTimeout(2500);
  log('G) terminal with explicit dark preference', JSON.stringify(await term()));

  log('--- probe 4 done ---');
} catch (error) {
  log('PROBE ERROR', error.message);
  log(error.stack);
} finally {
  await runCleanup();
}
process.exit(0);
