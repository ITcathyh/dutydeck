// 临时探针 7：复现产品脚本第 8 节的失败——手机端键条点击是否真的写进 PTY。
// 关注点：桌面终端先连过一条 WS 之后，手机端那条 WS 是否按时建立。用完即删。
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createCleanupStack, createDataDir, createHttp, createReporter, loadWebSocket, mockAgentsJson, startServer, waitFor, writeMockCli, sleep } from './e2e-harness.mjs';

const PORT = 14596;
const BASE = `http://127.0.0.1:${PORT}`;
const { log } = createReporter({ verbose: false });
const { onCleanup, runCleanup } = createCleanupStack({ log });
const request = createHttp(BASE);

try {
  const dirs = createDataDir({ onCleanup, prefix: 'dockmux-probe7-' });
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

  const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
  const sid = created.json.id;
  onCleanup(`stop ${sid}`, async () => { await request('POST', `/api/sessions/${sid}/stop`); });
  await request('POST', `/api/sessions/${sid}/send`, { prompt: 'probe seven goal', mode: 'queue' });
  await waitFor('completed', async () => (await request('GET', `/api/sessions/${sid}`)).json?.state === 'completed', { timeoutMs: 60_000 });
  log('session state', (await request('GET', `/api/sessions/${sid}`)).json?.state);

  const browser = await chromium.launch({ headless: true });
  onCleanup('close chromium', () => browser.close());

  // 1) 先让桌面页连上终端（复现产品脚本的顺序）
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await desktop.newPage();
  await page.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.getByRole('tab', { name: '终端' }).click();
  await page.waitForTimeout(2500);
  log('A) desktop terminal mounted', await page.evaluate(() => Boolean(document.querySelector('.xterm-viewport'))));

  // 2) 手机页
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  const mp = await phone.newPage();
  const wsEvents = [];
  mp.on('websocket', ws => {
    wsEvents.push(['open', ws.url()]);
    ws.on('close', () => wsEvents.push(['close', ws.url()]));
    ws.on('framesent', f => wsEvents.push(['sent', String(f.payload).slice(0, 60)]));
    ws.on('framereceived', f => wsEvents.push(['recv', String(f.payload).slice(0, 40)]));
  });
  await mp.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await mp.waitForTimeout(2500);
  await mp.getByRole('tab', { name: '终端' }).click();
  await mp.waitForTimeout(2500);
  log('B) phone terminal mounted', await mp.evaluate(() => Boolean(document.querySelector('.xterm-viewport'))));
  log('B) phone ws events', JSON.stringify(wsEvents.filter(e => e[0] === 'open' || e[0] === 'close')));

  const bar = mp.getByRole('toolbar', { name: '终端快捷键' });
  log('B) keybar visible', await bar.isVisible().catch(() => false));

  // 3) 观察者 WS
  const WS = loadWebSocket();
  const observed = [];
  const obs = new WS(`ws://127.0.0.1:${PORT}/api/terminal/${encodeURIComponent(sid)}`);
  await new Promise((res, rej) => { obs.on('open', res); obs.on('error', rej); });
  obs.on('message', raw => { try { const f = JSON.parse(String(raw)); if (f.type === 'data') observed.push(f.data); } catch {} });
  await sleep(600);

  // 4) 点 ↑，看 phone 页有没有真的 send，以及观察者有没有收到
  wsEvents.length = 0;
  observed.length = 0;
  await bar.getByRole('button', { name: /方向键上/ }).click();
  await sleep(2500);
  log('C) phone frames sent after click', JSON.stringify(wsEvents.filter(e => e[0] === 'sent')));
  log('C) observer data', observed.length, JSON.stringify(observed.join('').slice(0, 120)));

  // 5) 直接用观察者自己写一个字节，确认回显链路本身通不通
  observed.length = 0;
  obs.send(JSON.stringify({ type: 'input', data: '[A' }));
  await sleep(2000);
  log('D) observer wrote ESC[A itself, echo', observed.length, JSON.stringify(observed.join('').slice(0, 120)));

  // 6) 再点一次键条（这次终端已经确定连着）
  wsEvents.length = 0;
  observed.length = 0;
  await bar.getByRole('button', { name: /发送 Ctrl-C/ }).click();
  await sleep(2500);
  log('E) phone frames sent', JSON.stringify(wsEvents.filter(e => e[0] === 'sent')));
  log('E) observer data', observed.length, JSON.stringify(observed.join('').slice(0, 120)));

  // 7) 手机页单独跑（没有桌面页先占）——新 context 验证是否与顺序有关
  const phone2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp2 = await phone2.newPage();
  const ws2 = [];
  mp2.on('websocket', ws => { ws2.push(['open', ws.url()]); ws.on('framesent', f => ws2.push(['sent', String(f.payload).slice(0, 60)])); });
  await mp2.goto(`${BASE}/sessions/${sid}`, { waitUntil: 'domcontentloaded' });
  await mp2.waitForTimeout(2500);
  await mp2.getByRole('tab', { name: '终端' }).click();
  await mp2.waitForTimeout(3000);
  const bar2 = mp2.getByRole('toolbar', { name: '终端快捷键' });
  observed.length = 0;
  ws2.length = 0;
  await bar2.getByRole('button', { name: /方向键上/ }).click();
  await sleep(2500);
  log('F) fresh phone frames sent', JSON.stringify(ws2.filter(e => e[0] === 'sent')));
  log('F) observer data', observed.length, JSON.stringify(observed.join('').slice(0, 120)));

  try { obs.close(); } catch {}
  log('--- probe 7 done ---');
} catch (error) {
  log('PROBE ERROR', error.message);
  log(error.stack);
} finally {
  await runCleanup();
}
process.exit(0);
