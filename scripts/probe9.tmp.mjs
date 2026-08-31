// 临时探针 9：精确复现产品脚本第 8 节，并同时观测
//   (a) 会话状态  (b) 手机页自己 WS 收到的帧  (c) 观察者自写自读的对照
// 目的：判定「收不到回显」是键条的问题、回显通道的问题、还是被测会话的问题。用完即删。
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createCleanupStack, createDataDir, createHttp, createReporter, loadWebSocket, mockAgentsJson, startServer, waitFor, writeMockCli, sleep } from './e2e-harness.mjs';

const PORT = 14598;
const BASE = `http://127.0.0.1:${PORT}`;
const { log } = createReporter({ verbose: false });
const { onCleanup, runCleanup } = createCleanupStack({ log });
const request = createHttp(BASE);

try {
  const dirs = createDataDir({ onCleanup, prefix: 'dockmux-probe9-' });
  const mockPath = writeMockCli(dirs.binDir);
  const slowPath = join(dirs.binDir, 'mock-claude-slow');
  writeFileSync(slowPath, readFileSync(mockPath, 'utf8').replace('}, 300);', '}, Number(process.env.MOCK_CLAUDE_DELAY_MS ?? 300));'), 'utf8');
  chmodSync(slowPath, 0o755);
  const agentsJson = mockAgentsJson({ mockPath: slowPath, dirs });
  agentsJson[0].env.MOCK_CLAUDE_DELAY_MS = '9000';
  const { exitCode, serverLog } = startServer({ port: PORT, dirs, agentsJson, onCleanup });
  await waitFor('server', async () => {
    if (exitCode() !== undefined) throw new Error(`server exited ${exitCode()}: ${serverLog.join('')}`);
    return (await request('GET', '/health')).status === 200;
  }, { timeoutMs: 45_000 });

  const sids = {};
  for (const [key, prompt] of [['payment', 'refactor the payment gateway retries'], ['cjk', '重构支付网关的重试逻辑'], ['telemetry', 'clean up telemetry exporter']]) {
    const c = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
    sids[key] = c.json.id;
    onCleanup(`stop ${c.json.id}`, async () => { await request('POST', `/api/sessions/${c.json.id}/stop`); });
    await request('POST', `/api/sessions/${c.json.id}/send`, { prompt, mode: 'queue' });
  }
  const state = async sid => (await request('GET', `/api/sessions/${sid}`)).json?.state;
  await waitFor('summaries', async () => ((await request('GET', '/api/sessions/summaries')).json ?? []).length >= 3, { timeoutMs: 40_000 });
  log('states after summaries:', JSON.stringify(await Promise.all(Object.entries(sids).map(async ([k, v]) => [k, await state(v)]))));

  // 模拟 Toast 节对 payment 做的事
  await request('POST', `/api/sessions/${sids.payment}/send`, { prompt: 'OCCUPIER slow turn', mode: 'queue' });
  await sleep(1500);
  await request('POST', `/api/sessions/${sids.payment}/send`, { prompt: 'UNDO_TARGET_TASK', mode: 'queue' });
  await sleep(3000);
  const q = (await request('GET', `/api/sessions/${sids.payment}/tasks`)).json ?? [];
  const target = q.find(t => t.prompt === 'UNDO_TARGET_TASK');
  if (target?.status === 'queued') { await request('DELETE', `/api/sessions/${sids.payment}/queue/${target.id}`); log('cancelled queued'); }
  await request('POST', `/api/sessions/${sids.payment}/archive`);
  log('archived payment');
  log('states now:', JSON.stringify(await Promise.all(Object.entries(sids).map(async ([k, v]) => [k, await state(v)]))));

  const browser = await chromium.launch({ headless: true });
  onCleanup('close chromium', () => browser.close());
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await desktop.newPage();
  await page.goto(`${BASE}/sessions/${sids.cjk}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: '终端' }).click();
  await page.waitForTimeout(2500);
  log('desktop terminal mounted', await page.evaluate(() => Boolean(document.querySelector('.xterm-viewport'))));

  // 手机页，记录发出与收到的帧
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const mp = await phone.newPage();
  const sent = [], recv = [];
  let open = false;
  mp.on('websocket', ws => {
    if (!ws.url().includes('/api/terminal/')) return;
    open = true;
    ws.on('close', () => { open = false; log('   [phone ws CLOSED]'); });
    ws.on('framesent', f => sent.push(String(f.payload)));
    ws.on('framereceived', f => recv.push(String(f.payload).slice(0, 80)));
  });
  await mp.goto(`${BASE}/sessions/${sids.cjk}`, { waitUntil: 'domcontentloaded' });
  await mp.waitForTimeout(2500);
  await mp.getByRole('tab', { name: '终端' }).click();
  const bar = mp.getByRole('toolbar', { name: '终端快捷键' });
  await bar.waitFor({ state: 'visible', timeout: 15000 });
  await waitFor('phone ws open', async () => open, { timeoutMs: 20000, intervalMs: 200 });
  await sleep(800);
  log('cjk state right before click:', await state(sids.cjk));

  const WS = loadWebSocket();
  const observed = [];
  const obs = new WS(`ws://127.0.0.1:${PORT}/api/terminal/${encodeURIComponent(sids.cjk)}`);
  await new Promise((res, rej) => { obs.on('open', res); obs.on('error', rej); obs.on('unexpected-response', (_r, resp) => rej(new Error('HTTP ' + resp.statusCode))); });
  obs.on('message', raw => { try { const f = JSON.parse(String(raw)); if (f.type === 'data') observed.push(f.data); else log('   [obs non-data frame]', String(raw).slice(0, 120)); } catch {} });
  await sleep(600);

  // 对照 1：观察者自己写 —— 通道本身通不通
  observed.length = 0; recv.length = 0;
  obs.send(JSON.stringify({ type: 'input', data: '\x1b[A' }));
  await sleep(2500);
  log('CONTROL observer self-write → observer got', observed.length, JSON.stringify(observed.join('').slice(0, 60)), '| phone got', recv.length);

  // 被测：键条点击
  observed.length = 0; recv.length = 0; sent.length = 0;
  await bar.getByRole('button', { name: /方向键上/ }).click();
  await sleep(3000);
  log('KEYBAR click → phone sent', JSON.stringify(sent));
  log('KEYBAR click → observer got', observed.length, JSON.stringify(observed.join('').slice(0, 60)));
  log('KEYBAR click → phone recv', recv.length, JSON.stringify(recv.slice(0, 3)));
  log('cjk state after:', await state(sids.cjk));

  // 对照 2：再来一次观察者自写
  observed.length = 0;
  obs.send(JSON.stringify({ type: 'input', data: '\x1b[A' }));
  await sleep(2500);
  log('CONTROL again → observer got', observed.length, JSON.stringify(observed.join('').slice(0, 60)));

  // 对照 3：换 telemetry session（没被任何浏览器页占用过）
  const observed2 = [];
  const obs2 = new WS(`ws://127.0.0.1:${PORT}/api/terminal/${encodeURIComponent(sids.telemetry)}`);
  await new Promise((res, rej) => { obs2.on('open', res); obs2.on('error', rej); });
  obs2.on('message', raw => { try { const f = JSON.parse(String(raw)); if (f.type === 'data') observed2.push(f.data); } catch {} });
  await sleep(500);
  observed2.length = 0;
  obs2.send(JSON.stringify({ type: 'input', data: '\x1b[A' }));
  await sleep(2500);
  log('CONTROL telemetry session self-write → got', observed2.length, JSON.stringify(observed2.join('').slice(0, 60)), '| state', await state(sids.telemetry));

  try { obs.close(); obs2.close(); } catch {}
  log('--- probe 9 done ---');
} catch (error) {
  log('PROBE ERROR', error.message);
  log(error.stack);
} finally {
  await runCleanup();
}
process.exit(0);
