// 临时探针 8：为什么产品脚本第 8 节收不到 PTY 回显，而 probe7 能收到。
// 假设：回显通道本身在那个时间点已不可用（与键条无关）。用观察者自写自读来判定。用完即删。
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createCleanupStack, createDataDir, createHttp, createReporter, loadWebSocket, mockAgentsJson, startServer, waitFor, writeMockCli, sleep } from './e2e-harness.mjs';

const PORT = 14597;
const BASE = `http://127.0.0.1:${PORT}`;
const { log } = createReporter({ verbose: false });
const { onCleanup, runCleanup } = createCleanupStack({ log });
const request = createHttp(BASE);

const echoTest = async (WS, sid, label) => {
  const got = [];
  const ws = new WS(`ws://127.0.0.1:${PORT}/api/terminal/${encodeURIComponent(sid)}`);
  try {
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
      ws.on('unexpected-response', (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
    });
  } catch (e) { log(`  ${label}: WS 连不上 →`, e.message); return; }
  ws.on('message', raw => { try { const f = JSON.parse(String(raw)); if (f.type === 'data') got.push(f.data); } catch {} });
  await sleep(500);
  got.length = 0;
  ws.send(JSON.stringify({ type: 'input', data: '\x1b[A' }));
  await sleep(2000);
  log(`  ${label}: 自写 ESC[A → 收到 ${got.length} 帧 ${JSON.stringify(got.join('').slice(0, 60))}`);
  try { ws.close(); } catch {}
};

try {
  const dirs = createDataDir({ onCleanup, prefix: 'dockmux-probe8-' });
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

  const WS = loadWebSocket();
  // 完全照抄产品脚本：三个 session，各发一条
  const sids = {};
  for (const [key, prompt] of [['payment', 'refactor the payment gateway retries'], ['cjk', '重构支付网关的重试逻辑'], ['telemetry', 'clean up telemetry exporter']]) {
    const c = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
    sids[key] = c.json.id;
    onCleanup(`stop ${c.json.id}`, async () => { await request('POST', `/api/sessions/${c.json.id}/stop`); });
    await request('POST', `/api/sessions/${c.json.id}/send`, { prompt, mode: 'queue' });
  }
  log('sessions', JSON.stringify(sids));

  log('T0 立即：');
  await echoTest(WS, sids.cjk, 'cjk');
  const state = async sid => (await request('GET', `/api/sessions/${sid}`)).json?.state;
  log('  cjk state', await state(sids.cjk));

  log('T1 等 cjk 完成后：');
  await waitFor('cjk completed', async () => (await state(sids.cjk)) === 'completed', { timeoutMs: 60_000 });
  await echoTest(WS, sids.cjk, 'cjk');

  log('T2 模拟产品脚本的耗时（等 120s，中途像 Toast 那节一样往 payment 塞任务）：');
  await request('POST', `/api/sessions/${sids.payment}/send`, { prompt: 'OCCUPIER slow turn', mode: 'queue' });
  await sleep(30_000);
  log('  30s 后 cjk state', await state(sids.cjk));
  await echoTest(WS, sids.cjk, 'cjk@30s');
  await sleep(60_000);
  log('  90s 后 cjk state', await state(sids.cjk));
  await echoTest(WS, sids.cjk, 'cjk@90s');
  await sleep(45_000);
  log('  135s 后 cjk state', await state(sids.cjk));
  await echoTest(WS, sids.cjk, 'cjk@135s');

  log('T3 浏览器挂上终端后再试：');
  const browser = await chromium.launch({ headless: true });
  onCleanup('close chromium', () => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/sessions/${sids.cjk}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  await p.getByRole('tab', { name: '终端' }).click();
  await p.waitForTimeout(3000);
  log('  terminal mounted', await p.evaluate(() => Boolean(document.querySelector('.xterm-viewport'))));
  await echoTest(WS, sids.cjk, 'cjk@browser-attached');

  log('T4 全新 session（刚跑完一轮）对照：');
  const fresh = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
  onCleanup(`stop ${fresh.json.id}`, async () => { await request('POST', `/api/sessions/${fresh.json.id}/stop`); });
  await request('POST', `/api/sessions/${fresh.json.id}/send`, { prompt: 'fresh control', mode: 'queue' });
  await waitFor('fresh completed', async () => (await state(fresh.json.id)) === 'completed', { timeoutMs: 60_000 });
  await echoTest(WS, fresh.json.id, 'fresh');

  log('--- probe 8 done ---');
} catch (error) {
  log('PROBE ERROR', error.message);
  log(error.stack);
} finally {
  await runCleanup();
}
process.exit(0);
