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

const eventId = (sequence: number) => `evt_browser_${sequence}`;

async function waitForPaint(page: import('@playwright/test').Page, id: string, timeoutMs = 5_000) {
  // Observe DOM insertion directly. Locator polling adds its own retry delays
  // before the two paints, which is not incremental rendering latency. Rows are
  // matched by event id: completed turns render as history summaries whose
  // text also carries status and counts, so their text is not the event text.
  await page.evaluate(({ id, timeoutMs }) => new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    // No named helper here: tsx's keepNames would wrap it in an undefined page-side __name.
    const observer = new MutationObserver((_records, observer) => {
      const element = [...document.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => element.dataset.timelineEvent === id && element.getClientRects().length > 0);
      if (!element) return;
      observer.disconnect(); clearTimeout(timeout);
      void element.offsetHeight;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const existing = [...document.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => element.dataset.timelineEvent === id && element.getClientRects().length > 0);
    if (existing) {
      void existing.offsetHeight;
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      return;
    }
    timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Timed out rendering ${id}`)); }, timeoutMs);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-timeline-event'] });
  }), { id, timeoutMs });
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
      getHistoryOutline: (id: string) => repos.events.listHistoryOutline!(id),
      // A completed fixture session has no live driver and no verification runs.
      getDriver: () => undefined,
      getVerifications: async () => [],
      getEventWindow: (id: string, options: any) => repos.events.listWindow(id, options),
      getEvents: (id: string, after: number) => repos.events.list(id, after),
      subscribe: (_id: string, listener: (next: AgentEvent) => void) => { subscribers.add(listener); return () => subscribers.delete(listener); }
    } as any;
    app = await buildApp(runtime, {
      webRoot: resolve('apps/web/dist'),
      auth: { getToken: async () => null, localOnly: true },
      lark: { config: repos.config, agents: repos.agents, cardMappings: repos.channelMappings, listeningDisabled: true }
    });
    // This fixture has no work items. Register its empty read response so the
    // footer does not change from a retrying 404 spinner to an error banner.
    app.get('/api/sessions/:sessionId/work-items', async () => ({ items: [], templates: [] }));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Browser benchmark server did not expose a port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
    const pageErrors: string[] = [];
    // A fake-runtime gap answers 5xx and the page silently renders nothing to
    // measure; any server error therefore fails the benchmark, not a timeout.
    const serverErrors: string[] = [];
    const assertNoServerErrors = () => { if (serverErrors.length) throw new Error(`API server errors during benchmark:\n${serverErrors.join('\n')}`); };
    const newPage = async (options?: Parameters<NonNullable<typeof browser>['newPage']>[0]) => {
      const page = await browser!.newPage(options);
      page.on('pageerror', error => { pageErrors.push(error.stack ?? error.message); });
      page.on('response', response => { if (response.status() >= 500 && new URL(response.url()).pathname.startsWith('/api/')) serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`); });
      return page;
    };
    Object.assign(progress, { pageErrors, serverErrors });
    const controlPage = await newPage();
    await controlPage.setContent('<main></main>');
    const controlStarted = performance.now();
    const controlPaint = waitForPaint(controlPage, 'control');
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
      const page = await newPage({ viewport: { width: 1440, height: 960 } });
      page.on('requestfailed', request => process.stderr.write(`[browser] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}\n`));
      let initialPages = 0;
      page.on('request', request => { if (request.url().includes('/events?')) initialPages++; });
      const started = performance.now();
      await page.goto(`${baseUrl}/sessions/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
      try { await waitForPaint(page, eventId(EVENT_COUNT), 30_000); }
      catch (error) {
        assertNoServerErrors();
        process.stderr.write(`[browser body] ${(await page.locator('body').innerText()).slice(0, 4_000)}\n`);
        throw error;
      }
      assertNoServerErrors();
      firstVisibleSamples.push(performance.now() - started);
      if (initialPages > 2) throw new Error(`first screen fetched ${initialPages} pages`);

      if (await page.getByRole('button', { name: '加载更早记录' }).count()) throw new Error('history still requires manual pagination');
      if (!await page.locator(`[data-history-summary="${eventId(EVENT_COUNT)}"]`).count()) throw new Error('first screen did not render the completed history outline');
      // Completed turns come from the history outline; the first screen reads
      // only the live tail after it, never every raw event.
      const scrollStarted = performance.now();
      await page.locator('[data-timeline-scroll]').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      // Turn 1 is keyed by its prompt (event 2); event 1 is its preamble.
      await waitForPaint(page, eventId(2));
      if (await page.locator('[data-timeline-turn]').count() > 40) throw new Error('timeline DOM grew beyond the viewport');
      scrollSamples.push(performance.now() - scrollStarted);
      await page.close();
    }
    await waitFor(() => subscribers.size === 0);

    const page = await newPage({ viewport: { width: 1440, height: 960 } });
    // Completed turns are outline summaries read on demand; opening, reading
    // older turns and receiving live events must not page through raw events.
    let eventPageRequests = 0;
    page.on('request', request => { if (request.url().includes('/events?')) eventPageRequests++; });
    // Live updates belong to a new running task. Each is a prompt, so each
    // paints its own visible row: an unfinished turn folds assistant text into
    // a collapsed stage, which would leave nothing new on screen to time.
    await repos.tasks.save({ ...task, id: 'task_live', prompt: 'live follow-up', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    let liveSequence = EVENT_COUNT;
    const publishLive = () => {
      const next = event(++liveSequence);
      next.data = { role: 'user', text: `event ${liveSequence}`, taskId: 'task_live' };
      for (const subscriber of subscribers) subscriber(next);
      return next.id;
    };
    const liveLoadStarted = performance.now();
    await page.goto(`${baseUrl}/sessions/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
    await waitForPaint(page, eventId(EVENT_COUNT), 30_000);
    const liveFirstVisibleMs = performance.now() - liveLoadStarted;
    await waitFor(() => subscribers.size === 1);
    await waitForPaint(page, publishLive());
    // Reading the oldest turn while live events arrive: the reader stays put.
    await page.locator('[data-timeline-scroll]').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await waitForPaint(page, eventId(2));
    const readingTop = await page.locator(`[data-timeline-event="${eventId(2)}"]`).evaluate(element => element.getBoundingClientRect().top);
    let maxAnchorDriftPx = 0, maxRenderedTurns = 0;
    for (let index = 0; index < 5; index++) {
      publishLive();
      // The new row mounts far below the viewport; the live-tail count shows it merged.
      await page.waitForFunction(count => Number(document.querySelector<HTMLElement>('[data-timeline-scroll]')?.dataset.historyLoaded) === count, liveSequence - EVENT_COUNT);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const measured = await page.evaluate(id => ({ top: document.querySelector<HTMLElement>(`[data-timeline-event="${id}"]`)?.getBoundingClientRect().top, turns: document.querySelectorAll('[data-timeline-turn]').length }), eventId(2));
      if (measured.top === undefined) throw new Error('live update unmounted the turn being read');
      maxAnchorDriftPx = Math.max(maxAnchorDriftPx, Math.abs(measured.top - readingTop));
      maxRenderedTurns = Math.max(maxRenderedTurns, measured.turns);
    }
    Object.assign(progress, { liveFirstVisibleMs, eventPageRequests, maxAnchorDriftPx, maxRenderedTurns });
    if (maxAnchorDriftPx > 2) throw new Error(`live updates moved the reading anchor by ${maxAnchorDriftPx}px`);
    if (maxRenderedTurns > 40) throw new Error(`history reading mounted ${maxRenderedTurns} turns`);
    await page.getByRole('button', { name: '回到最新消息' }).click();
    await waitForPaint(page, eventId(liveSequence));
    if (eventPageRequests > 2) throw new Error(`opening, reading and live updates fetched ${eventPageRequests} raw event pages`);
    const cdp = await page.context().newCDPSession(page);
    // Keep latency and raw heap diagnostics under natural GC. The former raw
    // endpoint-growth <=32MiB gate was GC-phase dependent; it is not a hard
    // gate now. This does not promise a 32MiB peak or bounded unlimited history.
    const browserRawHeapBeforeBytes = await page.evaluate(() => (performance as any).memory.usedJSHeapSize as number);
    const browserRawHeapSamples: number[] = [browserRawHeapBeforeBytes];
    const incrementalSamples: number[] = [];
    Object.assign(progress, { incrementalSamples, browserRawHeapSamples });
    for (let index = 1; index <= 50; index++) {
      const started = performance.now();
      await waitForPaint(page, publishLive());
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
    for (let index = 51; index <= 100; index++) await waitForPaint(page, publishLive());
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
    const memoryControlPage = await newPage();
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

    // A real long turn has no alternating user messages. Once completed it is
    // one outline summary; expanding it reads exactly its own range in pages
    // and keeps a tool the reader opened inside it.
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
    const longPage = await newPage({ viewport: { width: 1440, height: 960 } });
    const longDetailPages: string[] = [];
    longPage.on('request', request => { if (request.url().includes(`${longId}/events?`)) longDetailPages.push(new URL(request.url()).search); });
    await longPage.goto(`${baseUrl}/sessions/${longId}`, { waitUntil: 'domcontentloaded' });
    await waitForPaint(longPage, 'long_1', 30_000);
    const expandStarted = performance.now();
    await longPage.locator('[data-history-summary="long_1"]').getByRole('button', { name: '展开完整记录' }).click();
    const longActivity = longPage.locator('[data-history-summary="long_1"] details > summary').first();
    await longActivity.waitFor({ timeout: 30_000 });
    await longPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const longTurnExpandMs = performance.now() - expandStarted;
    await longActivity.click();
    // The activity's tool group is labelled by its first step; open it, then the tool.
    await longPage.getByText('step 1', { exact: true }).first().click();
    await longPage.locator('[data-timeline-event="long_450"] button').first().click();
    if (!await longPage.getByText(/long output 450/).count()) throw new Error('expanded long turn did not open the selected tool');
    // The live tail (after=600) may be re-read; only bounded range reads are the expansion.
    const longTurnDetailPages = longDetailPages.filter(search => new URLSearchParams(search).get('before') === '601').length;
    Object.assign(progress, { longTurnExpandMs, longTurnDetailPages, longDetailPages });
    if (longTurnDetailPages !== Math.ceil(600 / 200)) throw new Error(`expanding the long turn fetched ${longTurnDetailPages} pages`);
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
      liveFirstVisibleMs, eventPageRequests, longTurnExpandMs, longTurnDetailPages,
      firstVisibleP95Ms, historyScrollP95Ms, incrementalPaintP95Ms, incrementalPaintMaxMs: Math.max(...incrementalSamples), firstVisibleSamples,
      ...browserMemory, ...retainedMemory, heapControlHeldGrowthBytes, heapControlReleasedGrowthBytes, heapControlRejected,
      serverRssGrowthBytes, serverExternalGrowthBytes, maxRenderedTurns, maxAnchorDriftPx,
      sseReconnects: 100, peakSubscribers, leakedSubscribers: subscribers.size, budgets
    }, null, 2)}\n`);
    assertBudget('browser first-visible p95', firstVisibleP95Ms, budgets.firstVisibleP95Ms, 'ms');
    assertBudget('browser history-scroll p95', historyScrollP95Ms, budgets.historyScrollP95Ms, 'ms');
    assertBudget('browser incremental-paint p95', incrementalPaintP95Ms, budgets.incrementalPaintP95Ms, 'ms');
    assertBudget('browser retained JS heap growth', browserRetainedHeapGrowthBytes, budgets.browserRetainedHeapGrowthBytes, 'B');
    assertBudget('server RSS growth after SSE soak', serverRssGrowthBytes, budgets.serverRssGrowthBytes, 'B');
    assertBudget('server external growth after SSE soak', serverExternalGrowthBytes, budgets.serverExternalGrowthBytes, 'B');
    assertNoServerErrors();
    if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join('\n')}`);
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
