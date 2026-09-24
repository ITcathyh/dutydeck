import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import type { AgentEvent, Session, TaskRecord } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from '../apps/server/src/app.js';

const SESSION_ID = 'ses_browser_perf';
const EVENT_COUNT = 50_000;
const SAMPLE_COUNT = 20;
const budgets = {
  firstVisibleP95Ms: 800,
  // Scrolling to earlier history includes layout and two paints.
  historyScrollP95Ms: 250,
  incrementalPaintP95Ms: 80,
  browserHeapGrowthBytes: 32 * 1024 * 1024,
  serverRssGrowthBytes: 64 * 1024 * 1024,
  serverExternalGrowthBytes: 16 * 1024 * 1024
};

const percentile95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for benchmark resource cleanup');
};
const assertBudget = (name: string, actual: number, budget: number, unit: string) => {
  if (actual > budget) throw new Error(`${name} exceeded: ${actual.toFixed(2)}${unit} > ${budget.toFixed(2)}${unit}`);
};

function event(sequence: number): AgentEvent {
  return {
    id: `evt_browser_${sequence}`,
    sessionId: SESSION_ID,
    sequence,
    type: 'text',
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    data: { role: sequence % 2 === 0 ? 'user' : 'assistant', text: `event ${sequence}`, taskId: 'task_browser' }
  };
}

async function waitForPaint(page: import('@playwright/test').Page, text: string) {
  await page.getByText(text, { exact: false }).last().waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function main() {
  process.env.NODE_ENV = 'test';
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-browser-benchmark-'));
  const repos = createRepositories(join(directory, 'history.db'));
  const subscribers = new Set<(event: AgentEvent) => void>();
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const now = new Date().toISOString();
    const session: Session = { id: SESSION_ID, agentId: 'perf-agent', state: 'completed', cwd: directory, permissionMode: 'ask', protocol: 'acp', runId: 'run_browser_perf', createdAt: now, updatedAt: now };
    const task: TaskRecord = { id: 'task_browser', sessionId: SESSION_ID, prompt: '验证五万事件浏览体验', status: 'completed', createdAt: now, updatedAt: now };
    await repos.sessions.save(session);
    await repos.tasks.save(task);
    for (let sequence = 1; sequence <= EVENT_COUNT; sequence++) await repos.events.append(event(sequence));

    const runtime = {
      listAgents: () => repos.agents.list(),
      listSessions: () => repos.sessions.list(),
      getSession: (id: string) => repos.sessions.get(id),
      getTasks: (id: string) => repos.tasks.listBySession(id),
      getEventWindow: (id: string, options: any) => repos.events.listWindow(id, options),
      getEvents: (id: string, after: number) => repos.events.list(id, after),
      subscribe: (_id: string, listener: (next: AgentEvent) => void) => { subscribers.add(listener); return () => subscribers.delete(listener); }
    } as any;
    app = await buildApp(runtime, {
      webRoot: resolve('apps/web/dist'),
      auth: { getToken: async () => null, localOnly: true },
      lark: { config: repos.config, agents: repos.agents, cardMappings: repos.channelMappings, listeningDisabled: true }
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Browser benchmark server did not expose a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
    const firstVisibleSamples: number[] = [];
    const scrollSamples: number[] = [];
    // Twenty samples make p95 meaningful: one cold-start/outlier sample does
    // not become the percentile itself, while repeated regressions still fail.
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      page.on('pageerror', error => process.stderr.write(`[browser] ${error.message}\n`));
      page.on('requestfailed', request => process.stderr.write(`[browser] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}\n`));
      const started = performance.now();
      await page.goto(`${baseUrl}/sessions/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
      try { await waitForPaint(page, `event ${EVENT_COUNT}`); }
      catch (error) {
        process.stderr.write(`[browser body] ${(await page.locator('body').innerText()).slice(0, 4_000)}\n`);
        throw error;
      }
      firstVisibleSamples.push(performance.now() - started);

      const scrollStarted = performance.now();
      if (await page.getByRole('button', { name: '加载更早记录' }).count()) throw new Error('history still requires manual pagination');
      await page.getByText('event 1', { exact: true }).scrollIntoViewIfNeeded();
      await waitForPaint(page, 'event 1');
      scrollSamples.push(performance.now() - scrollStarted);
      await page.close();
    }
    await waitFor(() => subscribers.size === 0);

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(`${baseUrl}/sessions/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
    await waitForPaint(page, `event ${EVENT_COUNT}`);
    await waitFor(() => subscribers.size === 1);
    const browserHeapBefore = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0);
    const incrementalSamples: number[] = [];
    for (let index = 1; index <= 50; index++) {
      const next = event(EVENT_COUNT + index);
      const started = performance.now();
      for (const subscriber of subscribers) subscriber(next);
      await waitForPaint(page, `event ${EVENT_COUNT + index}`);
      incrementalSamples.push(performance.now() - started);
    }
    const browserHeapAfter = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0);
    const browserHeapGrowthBytes = Math.max(0, browserHeapAfter - browserHeapBefore);
    await page.close();
    await waitFor(() => subscribers.size === 0);

    global.gc?.();
    const serverBefore = process.memoryUsage();
    let peakSubscribers = 0;
    for (let round = 0; round < 5; round++) {
      await Promise.all(Array.from({ length: 20 }, async () => {
        const controller = new AbortController();
        const response = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/stream?after=${EVENT_COUNT}`, { signal: controller.signal });
        const reader = response.body?.getReader();
        await reader?.read();
        peakSubscribers = Math.max(peakSubscribers, subscribers.size);
        controller.abort();
        await reader?.cancel().catch(() => undefined);
      }));
      await waitFor(() => subscribers.size === 0);
    }
    global.gc?.();
    const serverAfter = process.memoryUsage();
    const serverRssGrowthBytes = Math.max(0, serverAfter.rss - serverBefore.rss);
    const serverExternalGrowthBytes = Math.max(0, serverAfter.external - serverBefore.external);

    const firstVisibleP95Ms = percentile95(firstVisibleSamples);
    const historyScrollP95Ms = percentile95(scrollSamples);
    const incrementalPaintP95Ms = percentile95(incrementalSamples);
    assertBudget('browser first-visible p95', firstVisibleP95Ms, budgets.firstVisibleP95Ms, 'ms');
    assertBudget('browser history-scroll p95', historyScrollP95Ms, budgets.historyScrollP95Ms, 'ms');
    assertBudget('browser incremental-paint p95', incrementalPaintP95Ms, budgets.incrementalPaintP95Ms, 'ms');
    assertBudget('browser JS heap growth', browserHeapGrowthBytes, budgets.browserHeapGrowthBytes, 'B');
    assertBudget('server RSS growth after SSE soak', serverRssGrowthBytes, budgets.serverRssGrowthBytes, 'B');
    assertBudget('server external growth after SSE soak', serverExternalGrowthBytes, budgets.serverExternalGrowthBytes, 'B');
    if (subscribers.size !== 0) throw new Error(`${subscribers.size} SSE subscribers leaked after soak`);

    process.stdout.write(`${JSON.stringify({
      database: 'temporary-disk-sqlite', eventCount: EVENT_COUNT, sampleCount: SAMPLE_COUNT,
      firstVisibleP95Ms, historyScrollP95Ms, incrementalPaintP95Ms,
      browserHeapGrowthBytes, serverRssGrowthBytes, serverExternalGrowthBytes,
      sseReconnects: 100, peakSubscribers, leakedSubscribers: subscribers.size, budgets
    }, null, 2)}\n`);
  } finally {
    await browser?.close();
    await app?.close();
    repos.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
