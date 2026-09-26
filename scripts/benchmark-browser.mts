import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
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
  browserRetainedHeapGrowthBytes: 32 * 1024 * 1024,
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
  // Observe DOM insertion directly. Locator polling adds its own retry delays
  // before the two paints, which is not incremental rendering latency.
  await page.evaluate(text => new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver((_records, observer) => {
      const element = [...document.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => element.textContent?.trim() === text && element.getClientRects().length > 0);
      if (!element) return;
      observer.disconnect(); clearTimeout(timeout);
      void element.offsetHeight;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const existing = [...document.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => element.textContent?.trim() === text && element.getClientRects().length > 0);
    if (existing) {
      void existing.offsetHeight;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      return;
    }
    timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Timed out rendering ${text}`)); }, 5_000);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  }), text);
}

async function main() {
  process.env.NODE_ENV = 'test';
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-browser-benchmark-'));
  const repos = createRepositories(join(directory, 'history.db'));
  const subscribers = new Set<(event: AgentEvent) => void>();
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const hostLoadAtStart = loadavg();
  const progress: Record<string, unknown> = { eventCount: EVENT_COUNT, sampleCount: SAMPLE_COUNT, hostLoadAtStart, budgets };
  try {
    const now = new Date().toISOString();
    const session: Session = { id: SESSION_ID, agentId: 'perf-agent', state: 'completed', cwd: directory, permissionMode: 'ask', protocol: 'acp', runId: 'run_browser_perf', createdAt: now, updatedAt: now };
    const task: TaskRecord = { id: 'task_browser', sessionId: SESSION_ID, prompt: '验证五万事件浏览体验', status: 'completed', createdAt: now, updatedAt: now };
    await repos.sessions.save(session);
    await repos.tasks.save(task);
    // Seed in one transaction: per-event durable commits measure disk fsync,
    // not the browser, and used to consume most of this benchmark's runtime.
    const Database = createRequire(new URL('../packages/storage/package.json', import.meta.url))('better-sqlite3');
    const seed = new Database(join(directory, 'history.db'));
    try {
      const insert = seed.prepare('INSERT INTO events(id,session_id,sequence,type,timestamp,data) VALUES(?,?,?,?,?,?)');
      seed.transaction(() => { for (let sequence = 1; sequence <= EVENT_COUNT; sequence++) {
        const item = event(sequence); insert.run(item.id, item.sessionId, item.sequence, item.type, item.timestamp, JSON.stringify(item.data));
      } })();
    } finally { seed.close(); }

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
    const controlPage = await browser.newPage();
    await controlPage.setContent('<main></main>');
    const controlStarted = performance.now();
    const controlPaint = waitForPaint(controlPage, 'delayed fixture');
    void controlPaint.catch(() => {}); // Await below after scheduling the delayed DOM write.
    await controlPage.evaluate(() => { setTimeout(() => {
      const element = document.createElement('div'); element.dataset.timelineEvent = 'control'; element.textContent = 'delayed fixture'; document.body.append(element);
    }, 100); });
    await controlPaint;
    const paintControlDelayMs = performance.now() - controlStarted;
    if (paintControlDelayMs < 100) throw new Error('paint observer omitted the injected DOM delay');
    await controlPage.close();
    progress.paintControlDelayMs = paintControlDelayMs;
    const firstVisibleSamples: number[] = [];
    const scrollSamples: number[] = [];
    Object.assign(progress, { firstVisibleSamples, scrollSamples });
    // Twenty samples make p95 meaningful: one cold-start/outlier sample does
    // not become the percentile itself, while repeated regressions still fail.
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      page.on('pageerror', error => process.stderr.write(`[browser] ${error.message}\n`));
      page.on('requestfailed', request => process.stderr.write(`[browser] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}\n`));
      let initialPages = 0;
      page.on('request', request => { if (request.url().includes('/events?')) initialPages++; });
      const started = performance.now();
      await page.goto(`${baseUrl}/sessions/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
      try { await waitForPaint(page, `event ${EVENT_COUNT}`); }
      catch (error) {
        process.stderr.write(`[browser body] ${(await page.locator('body').innerText()).slice(0, 4_000)}\n`);
        throw error;
      }
      firstVisibleSamples.push(performance.now() - started);
      if (initialPages > 2) throw new Error(`first screen fetched ${initialPages} pages`);

      const scrollStarted = performance.now();
      if (await page.getByRole('button', { name: '加载更早记录' }).count()) throw new Error('history still requires manual pagination');
      const olderPage = page.waitForResponse(response => response.url().includes('/events?') && response.url().includes('before='));
      await page.locator('[data-timeline-scroll]').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      await olderPage;
      await page.waitForFunction(expected => Number(document.querySelector<HTMLElement>('[data-timeline-scroll]')?.dataset.historyStart) <= expected, EVENT_COUNT - 399);
      // One-page upward navigation is the progressive-history scroll contract.
      await page.locator('[data-timeline-scroll]').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      await waitForPaint(page, `event ${EVENT_COUNT - 398}`);
      if (await page.locator('[data-timeline-turn]').count() > 40) throw new Error('timeline DOM grew beyond the viewport');
      scrollSamples.push(performance.now() - scrollStarted);
      await page.close();
    }
    await waitFor(() => subscribers.size === 0);

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(`${baseUrl}/sessions/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
    await waitForPaint(page, `event ${EVENT_COUNT}`);
    await waitFor(() => subscribers.size === 1);
    // Exercise the retained-history path, not just the 200-event cold window.
    // Every older page is requested by the same scroll handler a user invokes.
    let olderGate: Promise<void> | undefined;
    let releasePage!: () => void;
    await page.route('**/events?before=*', async route => { await olderGate; await route.continue(); });
    let maxRenderedTurns = 0;
    let maxAnchorDriftPx = 0;
    for (let before = EVENT_COUNT - 199; before > 1; before -= 200) {
      olderGate = new Promise<void>(resolve => { releasePage = resolve; });
      const loaded = page.waitForResponse(response => response.url().includes(`/events?before=${before}&`));
      await page.locator('[data-timeline-scroll]').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const anchor = await page.locator('[data-timeline-event]').first().evaluate(element => ({ id: element.getAttribute('data-timeline-event'), top: element.getBoundingClientRect().top }));
      releasePage(); await loaded;
      const expected = Math.max(1, before - 200);
      await page.waitForFunction(expected => Number(document.querySelector<HTMLElement>('[data-timeline-scroll]')?.dataset.historyStart) <= expected, expected);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const same = page.locator(`[data-timeline-event="${anchor.id}"]`);
      if (await same.count() !== 1) throw new Error(`history prepend lost anchor ${anchor.id}`);
      const drift = Math.abs(await same.evaluate(element => element.getBoundingClientRect().top) - anchor.top);
      maxAnchorDriftPx = Math.max(maxAnchorDriftPx, drift);
      if (drift > 2) {
        progress.anchorFailure = { before, anchor, drift, after: await page.locator('[data-timeline-scroll]').evaluate(element => ({ scrollTop: element.scrollTop, events: [...element.querySelectorAll<HTMLElement>('[data-timeline-event]')].map(event => ({ id: event.dataset.timelineEvent, top: event.getBoundingClientRect().top })), turns: [...element.querySelectorAll<HTMLElement>('[data-timeline-turn]')].map(turn => ({ id: turn.dataset.timelineTurn, top: turn.getBoundingClientRect().top, height: turn.getBoundingClientRect().height })) })) };
        throw new Error(`history prepend at ${before} moved ${anchor.id} by ${drift}px`);
      }
      maxRenderedTurns = Math.max(maxRenderedTurns, await page.locator('[data-timeline-turn]').count());
    }
    await page.locator('[data-timeline-scroll]').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await waitForPaint(page, 'event 2');
    if (maxAnchorDriftPx > 2) throw new Error(`history prepend moved its anchor by ${maxAnchorDriftPx}px`);
    if (maxRenderedTurns > 40) throw new Error(`retained history mounted ${maxRenderedTurns} turns`);
    await page.getByRole('button', { name: '回到最新消息' }).click();
    await waitForPaint(page, `event ${EVENT_COUNT}`);
    const cdp = await page.context().newCDPSession(page);
    // Keep latency and raw heap diagnostics under natural GC. The former raw
    // endpoint-growth <=32MiB gate was GC-phase dependent; it is not a hard
    // gate now. This does not promise a 32MiB peak or bounded unlimited history.
    const browserRawHeapBeforeBytes = await page.evaluate(() => (performance as any).memory.usedJSHeapSize as number);
    const browserRawHeapSamples: number[] = [browserRawHeapBeforeBytes];
    const incrementalSamples: number[] = [];
    Object.assign(progress, { incrementalSamples, browserRawHeapSamples });
    for (let index = 1; index <= 50; index++) {
      const next = event(EVENT_COUNT + index);
      const started = performance.now();
      for (const subscriber of subscribers) subscriber(next);
      await waitForPaint(page, `event ${EVENT_COUNT + index}`);
      incrementalSamples.push(performance.now() - started);
      // Sampling happens after the latency timer stops, with no forced GC.
      browserRawHeapSamples.push(await page.evaluate(() => (performance as any).memory.usedJSHeapSize as number));
    }
    const browserRawHeapAfterBytes = browserRawHeapSamples.at(-1)!;
    const browserRawHeapSampledPeakBytes = Math.max(...browserRawHeapSamples);
    const browserRawHeapGrowthBytes = Math.max(0, browserRawHeapAfterBytes - browserRawHeapBeforeBytes);
    const browserMemory = {
      browserRawHeapBeforeBytes, browserRawHeapAfterBytes, browserRawHeapGrowthBytes,
      browserRawHeapSampledPeakBytes, browserRawHeapSampledPeakGrowthBytes: browserRawHeapSampledPeakBytes - browserRawHeapBeforeBytes,
      previousRawHeapDiagnosticBudgetBytes: 32 * 1024 * 1024,
      browserRawHeapExceededPreviousBudget: browserRawHeapGrowthBytes > 32 * 1024 * 1024,
      browserRawHeapSamples
    };
    Object.assign(progress, browserMemory, { incrementalPaintMaxMs: Math.max(...incrementalSamples) });

    // A separate, equally sized live phase measures retained growth. Exactly
    // one collection at each boundary; no collections within the 50 updates.
    await cdp.send('HeapProfiler.collectGarbage');
    const browserRetainedHeapBeforeBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    for (let index = 51; index <= 100; index++) {
      const next = event(EVENT_COUNT + index);
      for (const subscriber of subscribers) subscriber(next);
      await waitForPaint(page, `event ${EVENT_COUNT + index}`);
    }
    await cdp.send('HeapProfiler.collectGarbage');
    const browserRetainedHeapAfterBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    const browserRetainedHeapGrowthBytes = Math.max(0, browserRetainedHeapAfterBytes - browserRetainedHeapBeforeBytes);
    const retainedMemory = { browserRetainedHeapBeforeBytes, browserRetainedHeapAfterBytes, browserRetainedHeapGrowthBytes };
    Object.assign(progress, retainedMemory);
    await cdp.detach();
    await page.close();
    await waitFor(() => subscribers.size === 0);

    // Positive/negative controls exercise the same retained-growth gate with
    // real JS heap storage: a dense ordinary array, not an ArrayBuffer or holes.
    const memoryControlPage = await browser.newPage();
    const controlCdp = await memoryControlPage.context().newCDPSession(memoryControlPage);
    let heapControlHeldGrowthBytes = 0, heapControlReleasedGrowthBytes = 0, heapControlRejected = false;
    try {
      await controlCdp.send('HeapProfiler.collectGarbage');
      const before = (await controlCdp.send('Runtime.getHeapUsage')).usedSize;
      await memoryControlPage.evaluate(() => {
        (window as any).__heapControl = Array.from({ length: 12 * 1024 * 1024 }, (_, index) => index);
      });
      await controlCdp.send('HeapProfiler.collectGarbage');
      heapControlHeldGrowthBytes = (await controlCdp.send('Runtime.getHeapUsage')).usedSize - before;
      try { assertBudget('retained heap positive control', heapControlHeldGrowthBytes, budgets.browserRetainedHeapGrowthBytes, 'B'); }
      catch { heapControlRejected = true; }
      Object.assign(progress, { heapControlHeldGrowthBytes, heapControlRejected });
      if (!heapControlRejected) throw new Error('retained heap gate failed to reject the held dense array');
      await memoryControlPage.evaluate(() => { delete (window as any).__heapControl; });
      await controlCdp.send('HeapProfiler.collectGarbage');
      heapControlReleasedGrowthBytes = Math.max(0, (await controlCdp.send('Runtime.getHeapUsage')).usedSize - before);
      Object.assign(progress, { heapControlReleasedGrowthBytes });
      assertBudget('retained heap released control', heapControlReleasedGrowthBytes, budgets.browserRetainedHeapGrowthBytes, 'B');
    } finally {
      await controlCdp.detach();
      await memoryControlPage.close();
    }

    // A real long turn has no alternating user messages. Its expanded tool
    // survives a prepend that changes both the first turn and first group ids.
    const longId = 'ses_browser_long_turn';
    await repos.sessions.save({ ...session, id: longId });
    await repos.tasks.save({ ...task, id: 'task_long', sessionId: longId, createdAt: new Date(1_700_000_000_000).toISOString() });
    const longSeed = new Database(join(directory, 'history.db'));
    try {
      const insert = longSeed.prepare('INSERT INTO events(id,session_id,sequence,type,timestamp,data,task_id) VALUES(?,?,?,?,?,?,?)');
      longSeed.transaction(() => { for (let sequence = 1; sequence <= 600; sequence++) {
        insert.run(`long_${sequence}`, longId, sequence, 'tool_result', new Date(1_700_000_000_000 + sequence).toISOString(),
          JSON.stringify({ id: `long_tool_${sequence}`, name: `tool ${sequence}`, input: { description: `step ${sequence}` }, output: `long output ${sequence}`, status: 'completed', taskId: 'task_long' }), 'task_long');
      } })();
    } finally { longSeed.close(); }
    const longPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await longPage.goto(`${baseUrl}/sessions/${longId}`, { waitUntil: 'domcontentloaded' });
    await longPage.locator('[data-timeline-scroll] details > summary').click();
    await longPage.getByText('step 401', { exact: true }).first().click();
    await longPage.locator('[data-timeline-event="long_450"] button').click();
    let releaseOlder!: () => void;
    const longOlderGate = new Promise<void>(resolve => { releaseOlder = resolve; });
    await longPage.route(`**/api/sessions/${longId}/events?before=401&**`, async route => { await longOlderGate; await route.continue(); });
    const older = longPage.waitForResponse(response => response.url().includes(`${longId}/events?before=401&`));
    await longPage.locator('[data-timeline-scroll]').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await longPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const anchorTop = await longPage.locator('[data-timeline-event="long_401"]').evaluate(element => element.getBoundingClientRect().top);
    releaseOlder(); await older;
    await longPage.waitForFunction(() => document.querySelector<HTMLElement>('[data-timeline-scroll]')?.dataset.historyStart === '201');
    await longPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const longTurnAnchorDriftPx = Math.abs(await longPage.locator('[data-timeline-event="long_401"]').evaluate(element => element.getBoundingClientRect().top) - anchorTop);
    if (longTurnAnchorDriftPx > 2) throw new Error(`long-turn prepend moved its anchor by ${longTurnAnchorDriftPx}px`);
    if (!await longPage.getByText(/long output 450/).count()) throw new Error('prepend collapsed the expanded tool');
    await longPage.close(); await waitFor(() => subscribers.size === 0);

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
    process.stdout.write(`${JSON.stringify({
      database: 'temporary-disk-sqlite', eventCount: EVENT_COUNT, sampleCount: SAMPLE_COUNT, hostLoadAtStart, paintControlDelayMs,
      firstVisibleP95Ms, historyScrollP95Ms, incrementalPaintP95Ms, incrementalPaintMaxMs: Math.max(...incrementalSamples), firstVisibleSamples,
      ...browserMemory, ...retainedMemory, heapControlHeldGrowthBytes, heapControlReleasedGrowthBytes, heapControlRejected,
      serverRssGrowthBytes, serverExternalGrowthBytes, maxRenderedTurns, maxAnchorDriftPx, longTurnAnchorDriftPx,
      sseReconnects: 100, peakSubscribers, leakedSubscribers: subscribers.size, budgets
    }, null, 2)}\n`);
    assertBudget('browser first-visible p95', firstVisibleP95Ms, budgets.firstVisibleP95Ms, 'ms');
    assertBudget('browser history-scroll p95', historyScrollP95Ms, budgets.historyScrollP95Ms, 'ms');
    assertBudget('browser incremental-paint p95', incrementalPaintP95Ms, budgets.incrementalPaintP95Ms, 'ms');
    assertBudget('browser retained JS heap growth', browserRetainedHeapGrowthBytes, budgets.browserRetainedHeapGrowthBytes, 'B');
    assertBudget('server RSS growth after SSE soak', serverRssGrowthBytes, budgets.serverRssGrowthBytes, 'B');
    assertBudget('server external growth after SSE soak', serverExternalGrowthBytes, budgets.serverExternalGrowthBytes, 'B');
    if (subscribers.size !== 0) throw new Error(`${subscribers.size} SSE subscribers leaked after soak`);


  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', ...progress }, null, 2)}\n`);
    throw error;
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
