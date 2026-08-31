// 临时探针 3：隔离 n 快捷键的失效原因、toast 两个 region、g 和弦、palette 动作。用完即删。
import { chromium } from '@playwright/test';
import { createCleanupStack, createDataDir, createHttp, createReporter, mockAgentsJson, startServer, waitFor, writeMockCli } from './e2e-harness.mjs';

const PORT = 14593;
const BASE = `http://127.0.0.1:${PORT}`;
const { log } = createReporter({ verbose: false });
const { onCleanup, runCleanup } = createCleanupStack({ log });
const request = createHttp(BASE);

try {
  const dirs = createDataDir({ onCleanup, prefix: 'dockmux-probe3-' });
  const mockPath = writeMockCli(dirs.binDir);
  const { exitCode, serverLog } = startServer({ port: PORT, dirs, agentsJson: mockAgentsJson({ mockPath, dirs }), onCleanup });
  await waitFor('server', async () => {
    if (exitCode() !== undefined) throw new Error(`server exited ${exitCode()}: ${serverLog.join('')}`);
    return (await request('GET', '/health')).status === 200;
  }, { timeoutMs: 45_000 });

  const browser = await chromium.launch({ headless: true });
  onCleanup('close chromium', () => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => log('PAGEERROR', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ timeout: 20_000 });

  const dialogNames = async () => {
    const out = [];
    for (const d of await page.locator('[role="dialog"]').all()) if (await d.isVisible().catch(() => false)) out.push(await d.getAttribute('aria-label'));
    return out;
  };
  const closeAll = async () => { for (let i = 0; i < 4; i++) { if (!(await dialogNames()).length) return; await page.keyboard.press('Escape'); await page.waitForTimeout(400); } };

  // 1) agents 确实非空？
  const agentsApi = (await request('GET', '/api/agents')).json;
  log('agents from API', agentsApi.length, agentsApi.map(a => a.id).join(','));
  // 首页按钮文案能反映 agents 是否加载：agents.length ? '创建任务' : '准备 Agent'
  const mainBtn = page.locator('header button').last();
  log('primary button text', JSON.stringify(await mainBtn.innerText()));

  // 2) 点按钮 → 应开创建任务
  await mainBtn.click();
  await page.waitForTimeout(700);
  log('A) click primary button →', JSON.stringify(await dialogNames()));
  await closeAll();

  // 3) 按 n → ?
  await page.waitForTimeout(300);
  await page.keyboard.press('n');
  await page.waitForTimeout(800);
  log('B) press n →', JSON.stringify(await dialogNames()));
  await closeAll();

  // 4) 等更久后再按 n（排除时序）
  await page.waitForTimeout(4000);
  await page.keyboard.press('n');
  await page.waitForTimeout(800);
  log('C) press n after 4s wait →', JSON.stringify(await dialogNames()));
  await closeAll();

  // 5) 打开一个 session 再回首页（强制 shortcutHandlers memo 重算），再按 n
  const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
  const sid = created.json.id;
  onCleanup(`stop ${sid}`, async () => { await request('POST', `/api/sessions/${sid}/stop`); });
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'probe three goal alpha', mode: 'queue' });
  await waitFor('completed', async () => (await request('GET', `/api/sessions/${sid}`)).json?.state === 'completed', { timeoutMs: 60_000 });
  await page.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.keyboard.press('n');
  await page.waitForTimeout(900);
  log('D) press n on session page →', JSON.stringify(await dialogNames()));
  await closeAll();
  // 回首页（memo 因 active 变化而重算）
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2000);
  await page.keyboard.press('n');
  await page.waitForTimeout(900);
  log('E) press n back on home →', JSON.stringify(await dialogNames()));
  await closeAll();

  // 6) 命令面板里的「创建任务」动作（每次渲染重建的数组，应拿到新鲜闭包）
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '搜索任务与命令' });
  await palette.waitFor({ timeout: 5000 });
  await palette.getByRole('combobox').fill('创建');
  await page.waitForTimeout(400);
  await palette.getByRole('option').first().click();
  await page.waitForTimeout(900);
  log('F) palette 创建任务 action →', JSON.stringify(await dialogNames()));
  await closeAll();

  // 7) g 和弦干净测试：g l = 飞书绑定向导
  await page.waitForTimeout(500);
  log('G) dialogs before g l', JSON.stringify(await dialogNames()));
  await page.keyboard.press('g');
  await page.keyboard.press('l');
  await page.waitForTimeout(1500);
  log('G) after g l →', JSON.stringify(await dialogNames()));
  await closeAll();
  // g 之后按一个不成和弦的键，必须什么都不发生（不能误触 e=归档 之类）
  await page.keyboard.press('g');
  await page.keyboard.press('z');
  await page.waitForTimeout(700);
  log('H) after g z (invalid chord) →', JSON.stringify(await dialogNames()));
  await closeAll();

  // 8) toast 两个 region + 排队取消
  await page.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // 先塞一条长任务让 session busy，再塞一条排队的
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'occupier turn', mode: 'queue' });
  await page.waitForTimeout(200);
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'CANCEL_ME_PLEASE', mode: 'queue' });
  await page.waitForTimeout(1200);
  const tasks = (await request('GET', `/api/sessions/${sid}/tasks`)).json ?? [];
  log('I) tasks', JSON.stringify(tasks.map(t => [t.status, t.prompt])));
  const polite = page.locator('[aria-live="polite"][aria-label="操作结果通知"]');
  const assertive = page.locator('[aria-live="assertive"][aria-label="失败与注意事项通知"]');
  log('I) regions exist', (await polite.all()).length, (await assertive.all()).length);
  const cancelBtns = await page.getByRole('button', { name: /^取消排队/ }).all();
  log('I) cancel buttons', cancelBtns.length);
  for (const b of cancelBtns) log('   ', JSON.stringify(await b.getAttribute('aria-label')));
  if (cancelBtns.length) {
    await cancelBtns[0].click();
    await page.waitForTimeout(800);
    log('I) polite text', JSON.stringify((await polite.innerText().catch(() => '')).slice(0, 300)));
    log('I) assertive text', JSON.stringify((await assertive.innerText().catch(() => '')).slice(0, 300)));
    log('I) toast cards', (await page.locator('.ui-toast').all()).length);
  }

  // 9) archive toast（success 4s）→ 自动消失
  await page.waitForTimeout(1000);
  log('J) --- archive path ---');
  const archiveBtn = page.getByRole('button', { name: '归档任务运行' });
  log('J) archive btn', (await archiveBtn.all()).length);
  if ((await archiveBtn.all()).length) {
    await archiveBtn.first().click();
    await page.waitForTimeout(500);
    const confirm = page.getByRole('dialog').filter({ hasText: '归档此任务运行' });
    log('J) confirm visible', await confirm.isVisible().catch(() => false));
    const yes = page.getByRole('button', { name: '确认归档' });
    if (await yes.isVisible().catch(() => false)) {
      await yes.click();
      await page.waitForTimeout(900);
      log('J) polite after archive', JSON.stringify((await polite.innerText().catch(() => '')).slice(0, 200)));
      log('J) toast cards', (await page.locator('.ui-toast').all()).length);
      await page.waitForTimeout(4500);
      log('J) toast cards after 5.4s', (await page.locator('.ui-toast').all()).length);
      log('J) polite after wait', JSON.stringify((await polite.innerText().catch(() => '')).slice(0, 200)));
    }
  }
  log('--- probe 3 done ---');
} catch (error) {
  log('PROBE ERROR', error.message);
  log(error.stack);
} finally {
  await runCleanup();
}
process.exit(0);
