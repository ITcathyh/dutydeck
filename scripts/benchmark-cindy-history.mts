import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from '@playwright/test';

// Both Web builds read exactly the same real Runtime/SQLite event stream over
// each revision's real Fastify endpoints. No CLI, model, daemon or .env is used.
// Build packages and Web in both checkouts, then run with Node >=22.12:
// node --import tsx scripts/benchmark-cindy-history.mts --baseline /old --candidate /new
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const baseline = resolve(option('--baseline', process.cwd()));
const candidate = resolve(option('--candidate', process.cwd()));
const output = resolve(option('--output', 'artifacts/cindy-history-comparison.json'));
const turns = Number(option('--turns', '30'));
const toolsPerTurn = 20;
const fragmentsPerTurn = 120;
const importFrom = (root: string, path: string) => import(pathToFileURL(join(root, path)).href);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const poll = async (predicate: () => Promise<boolean>, label: string, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(20); }
  throw new Error(`Timed out: ${label}`);
};
const paint = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const historyLayout = (page: Page) => page.evaluate(() => {
  const container = document.querySelector<HTMLElement>('[data-timeline-scroll]');
  return { scrollTop: container?.scrollTop, scrollHeight: container?.scrollHeight, viewportHeight: container?.clientHeight,
    summaries: [...document.querySelectorAll<HTMLElement>('[data-history-summary]')].map(element => ({ id: element.dataset.historySummary, prompt: element.innerText.split('\n')[0], top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height })) };
});
type HistoryRequest = { url: string; startedMs: number; finishedMs?: number; transferredBytes?: number; responseBytes?: number; eventIds?: string[]; oldToolBody?: boolean; status?: number };

async function main() {
  process.env.NODE_ENV = 'test';
  const chromiumExecutable = chromium.executablePath();
  const scratch = await mkdtemp(join(tmpdir(), 'dutydeck-cindy-history-'));
  await mkdir(join(scratch, 'home'));
  const previousHome = process.env.HOME;
  process.env.HOME = join(scratch, 'home');
  // The fake Driver proves completion directly, as in history.integration.test.
  // Private HOME also isolates the real HTTP skill-discovery routes.
  const { DutydeckRuntime } = await importFrom(candidate, 'packages/agent-runtime/src/index.ts');
  const { createRepositories } = await importFrom(candidate, 'packages/storage/src/index.ts');
  const repos = createRepositories(join(scratch, 'history.db'), { newDatabaseAuthority: 'ledger_v1' });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let releaseActive!: () => void;
  const activeGate = new Promise<void>(resolve => { releaseActive = resolve; });
  let sent = 0;
  let liveEmit: ((event: any) => void) | undefined;
  const outputs = new Map<number, string>();
  const driverFactory = (_agent: any, _protocol: any, emit: (event: any) => void) => {
    liveEmit = emit;
    return { start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isIdle: () => true, isStopped: async () => true,
      send: async () => {
        const turn = ++sent;
        if (turn === 1) await firstGate;
        if (turn > turns) {
          emit({ type: 'text', data: { text: 'ACTIVE_TURN_VISIBLE' } });
          emit({ type: 'raw_terminal', data: { text: 'RAW_ACTIVE\n' } });
          await activeGate;
        } else {
          for (let tool = 0; tool < toolsPerTurn; tool++) {
            const id = `tool_${turn}_${tool}`;
            emit({ type: 'tool_call', data: { id, name: 'read', input: { path: `/fixture/turn-${turn}/tool-${tool}` } } });
            emit({ type: 'tool_result', data: { id, status: 'completed', output: `OLD_TOOL_BODY_${turn}_${tool}\n${'0123456789abcdef'.repeat(2048)}\nEND_TOOL_${turn}_${tool}`, parts: [{ type: 'resource_link', uri: `file:///fixture/result-${turn}-${tool}`, name: `result-${turn}-${tool}` }] } });
          }
          const fragments = Array.from({ length: fragmentsPerTurn }, (_, index) => `fragment-${turn}-${index} ${turn === 1 ? 'complete final output '.repeat(4) : ''}`);
          outputs.set(turn, fragments.join(''));
          for (const text of fragments) emit({ type: 'text', data: { text } });
          emit({ type: 'raw_terminal', data: { text: `RAW_TURN_${turn}_BEGIN\n${'terminal output '.repeat(64)}\nRAW_TURN_${turn}_END\n` } });
        }
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      } };
  };
  const runtime = new DutydeckRuntime(repos, { driverFactory, cleanupIntervalMs: 0 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const results: any = { methodology: { backend: 'same real candidate Runtime + file SQLite; baseline and candidate real buildApp HTTP endpoints', browser: 'headless Chromium; cold new browser context per revision', bytes: 'CDP Network.loadingFinished.encodedDataLength (actual HTTP transfer, headers included); responseBytes from actual Chromium response body', heap: 'CDP Runtime.getHeapUsage before and after explicit HeapProfiler.collectGarbage', firstScreen: 'navigation to active user prompt visible plus two animation frames', background: 'both revisions sampled 1500ms after first visible; settled additionally waits for baseline automatic full canonical cache', limits: 'single host/sample; summary list remains proportional to completed turns; no real model or live Lark' }, configuration: { turns, toolsPerTurn, fragmentsPerTurn, toolBodyBytes: 32768, samplesPerRevision: 1, nodeVersion: process.version }, measurements: [] };
  try {
    const agent = { id: 'cindy-fixture', name: 'History Fixture', protocol: 'acp', command: process.execPath, args: [], cwd: scratch, env: {}, permissionMode: 'ask', timeout: 3600, capabilities: { pause: false, resume: true }, builtin: false };
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });
    const first = await runtime.dispatch(session.id, 'instruction turn 1', 'queue', 'fixture-first', undefined, 'installation_owner');
    await poll(async () => sent === 1, 'first Driver submission');
    const queued = await runtime.dispatch(session.id, 'instruction turn 2', 'queue', 'fixture-queued', undefined, 'installation_owner');
    releaseFirst();
    await poll(async () => (await runtime.getTasks(session.id)).filter((task: any) => task.status === 'completed').length === 2, 'queued successor completes');
    for (let turn = 3; turn <= turns; turn++) {
      const task = await runtime.dispatch(session.id, `instruction turn ${turn}`, 'queue', `fixture-${turn}`, undefined, 'installation_owner');
      await poll(async () => (await runtime.getTasks(session.id)).some((entry: any) => entry.id === task.id && entry.status === 'completed'), `turn ${turn} persisted`);
    }
    const active = await runtime.dispatch(session.id, 'active instruction', 'queue', 'fixture-active', undefined, 'installation_owner');
    await poll(async () => (await runtime.getEvents(session.id)).some((event: any) => event.data.text === 'ACTIVE_TURN_VISIBLE'), 'active suffix persisted');
    const canonical = await runtime.getEvents(session.id);
    const outline = await runtime.getHistoryOutline(session.id);
    assert.equal(outline.turns.length, turns);
    assert.equal(canonical[0].type, 'status');
    assert(canonical.some((event: any) => event.type === 'task' && event.data.task?.id === queued.id && event.data.task.status === 'queued'));
    assert.equal(outline.turns[0].taskId, first.id);
    for (let index = 0; index < turns; index++) {
      const complete = outputs.get(index + 1)!;
      const turn = outline.turns[index];
      const final = canonical.filter((event: any) => event.sequence >= turn.firstSequence && event.sequence <= turn.lastSequence && event.type === 'text' && event.data.role !== 'user').map((event: any) => event.data.text).join('');
      assert.equal(final, complete);
      assert.equal(outline.turns[index].output.text, complete.slice(0, 4096));
      assert.equal(outline.turns[index].output.truncated, complete.length > 4096);
    }
    const fixtureHash = sha(JSON.stringify(canonical));
    results.fixture = { canonicalEvents: canonical.length, canonicalSha256: fixtureHash, completedTurns: outline.turns.length, activeTaskId: active.id, liveAfter: outline.liveAfter, prefixStatus: true, queuedSuccessor: true, allFinalFragmentsPreserved: true, tail: canonical.slice(-6) };
    process.stderr.write(`Fixture: ${canonical.length} canonical events, ${turns} completed turns\n`);
    browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true, args: ['--enable-precise-memory-info'] });
    results.configuration.chromiumVersion = browser.version();
    for (const [label, root] of [['baseline', baseline], ['candidate', candidate]]) {
      process.stderr.write(`Measuring ${label}\n`);
      assert.equal(sha(JSON.stringify(await runtime.getEvents(session.id))), fixtureHash, 'revisions must measure identical canonical history');
      const { buildApp } = await importFrom(root, 'apps/server/src/app.ts');
      const app = await buildApp(runtime, { webRoot: join(root, 'apps/web/dist'), auth: { getToken: async () => null, localOnly: true }, lark: { config: repos.config, agents: repos.agents, cardMappings: repos.channelMappings, listeningDisabled: true } });
      app.get('/api/sessions/:sessionId/work-items', async () => ({ items: [], templates: [] }));
      await app.listen({ host: '127.0.0.1', port: 0 });
      const baseUrl = `http://127.0.0.1:${(app.server.address() as any).port}`;
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, permissions: ['clipboard-read', 'clipboard-write'] });
      const blockedExternalUrls: string[] = [];
      const localRequestsOnly = (route: import('@playwright/test').Route) => {
        if (new URL(route.request().url()).origin === baseUrl) return route.continue();
        blockedExternalUrls.push(route.request().url()); return route.abort('blockedbyclient');
      };
      await context.route('**/*', localRequestsOnly);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const pageErrors: string[] = [];
      const requests: HistoryRequest[] = [];
      const networkRequests: HistoryRequest[] = [];
      const pendingBodies = new Set<Promise<unknown>>();
      const byId = new Map<string, HistoryRequest>();
      const started = performance.now();
      const historyUrl = (url: string) => /\/api\/sessions\/[^/]+\/(?:events\?|history(?:\?|$))/.test(url);
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('response', response => {
        if (!historyUrl(response.url())) return;
        const pending = (async () => {
          const body = await response.body();
          const row = [...requests].reverse().find(request => request.url === response.url() && request.responseBytes === undefined);
          if (!row) throw new Error(`Untracked response ${response.url()}`);
          row.responseBytes = body.length; row.status = response.status(); row.oldToolBody = body.includes(Buffer.from('OLD_TOOL_BODY_'));
          const value = JSON.parse(body.toString());
          if (Array.isArray(value)) row.eventIds = value.map((event: any) => event.id);
        })();
        pendingBodies.add(pending); void pending.finally(() => pendingBodies.delete(pending));
      });
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', event => {
        const row = { url: event.request.url, startedMs: performance.now() - started };
        networkRequests.push(row); byId.set(event.requestId, row);
        if (historyUrl(event.request.url)) requests.push(row);
      });
      cdp.on('Network.loadingFinished', event => {
        const row = byId.get(event.requestId);
        if (row) { row.finishedMs = performance.now() - started; row.transferredBytes = event.encodedDataLength; }
      });
      const snapshot = async () => {
        const elapsedMs = performance.now() - started;
        const [heap, canonicalCacheEvents] = await Promise.all([cdp.send('Runtime.getHeapUsage'), page.locator('[data-timeline-scroll]').getAttribute('data-history-loaded')]);
        await Promise.all([...pendingBodies]);
        const rows = requests.filter(row => row.finishedMs !== undefined && row.finishedMs <= elapsedMs);
        const networkRows = networkRequests.filter(row => row.finishedMs !== undefined && row.finishedMs <= elapsedMs);
        return { elapsedMs, requests: rows.length, transferredBytes: rows.reduce((sum, row) => sum + (row.transferredBytes ?? 0), 0), responseBytes: rows.reduce((sum, row) => sum + (row.responseBytes ?? 0), 0), totalPageRequests: networkRows.length, totalPageTransferredBytes: networkRows.reduce((sum, row) => sum + (row.transferredBytes ?? 0), 0), fetchedUniqueCanonicalEvents: new Set(rows.flatMap(row => row.eventIds ?? [])).size, canonicalCacheEvents, heapUsedBytes: heap.usedSize, heapTotalBytes: heap.totalSize };
      };
      try {
        await page.goto(`${baseUrl}/sessions/${session.id}`, { waitUntil: 'domcontentloaded' });
        await page.getByText('active instruction', { exact: true }).waitFor();
        await paint(page);
        const firstScreen = await snapshot();
        await pause(Math.max(0, firstScreen.elapsedMs + 1500 - (performance.now() - started)));
        await paint(page);
        const background = await snapshot();
        if (label === 'baseline') await page.waitForFunction(count => Number(document.querySelector<HTMLElement>('[data-timeline-scroll]')?.dataset.historyLoaded) === count, canonical.length, { timeout: 120_000 });
        await paint(page);
        const settled = await snapshot();
        await cdp.send('HeapProfiler.collectGarbage');
        const retained = await cdp.send('Runtime.getHeapUsage');
        const webIndex = await readFile(join(root, 'apps/web/dist/index.html'), 'utf8');
        const measurement: any = { label, root, webIndexSha256: sha(webIndex), webEntry: webIndex.match(/<script[^>]+src="([^"]+)"/)?.[1], firstScreen, background, settled: { ...settled, retainedHeapUsedBytes: retained.usedSize }, pageErrors, assertions: {}, requests };
        results.measurements.push(measurement);
        process.stderr.write(`${label}: ${settled.requests} history requests; ${settled.responseBytes} response bytes; ${settled.canonicalCacheEvents} canonical cached\n`);
        if (label === 'candidate') {
          assert.equal(sha(JSON.stringify(await runtime.getEvents(session.id))), fixtureHash, 'history changed before candidate interaction');
          assert.equal(requests.some(row => row.oldToolBody), false, 'unexpanded history downloaded an old tool body');
          assert.equal(Number(settled.canonicalCacheEvents), canonical.filter((event: any) => event.sequence > outline.liveAfter).length);
          measurement.assertions.unexpandedOldToolBodiesAbsent = true;
          const firstTurn = outline.turns[0];
          await page.getByRole('combobox', { name: '跳到轮次' }).selectOption(firstTurn.id);
          const summary = page.locator(`[data-history-summary="${firstTurn.id}"]`);
          await summary.waitFor();
          await summary.getByText('最终输出已截断；展开可读取完整内容。', { exact: true }).waitFor();
          await summary.getByRole('button', { name: '展开完整记录', exact: true }).click();
          await summary.getByText(outputs.get(1)!.trim(), { exact: true }).waitFor();
          await Promise.all([...pendingBodies]);
          const detailIds = requests.flatMap(row => row.eventIds ?? []);
          const expectedTurn = canonical.filter((event: any) => event.sequence >= firstTurn.firstSequence && event.sequence <= firstTurn.lastSequence);
          assert(expectedTurn.length > 200, 'fixture must exercise multi-page turn detail');
          assert(expectedTurn.every((event: any) => detailIds.includes(event.id)), 'expanded detail missed canonical events');
          assert(requests.some(row => row.oldToolBody), 'explicit expansion did not fetch old tool body');
          await summary.locator('details.reasoning > summary').click();
          await summary.locator('details.reasoning-group > summary').first().click();
          const toolCall = expectedTurn.find((event: any) => event.type === 'tool_call');
          const toolResult = expectedTurn.find((event: any) => event.type === 'tool_result');
          const toolCard = summary.locator(`[data-timeline-event="${toolCall.id}"]`);
          await toolCard.getByRole('button').first().click();
          const renderedToolOutput = JSON.parse((await toolCard.locator('pre').first().textContent())!);
          assert.equal(renderedToolOutput.output, toolResult.data.output, 'rendered tool body was truncated');
          await summary.locator('details.reasoning > summary').click();
          measurement.assertions.expandedFullCanonicalTurn = { events: expectedTurn.length, toolResults: expectedTurn.filter((event: any) => event.type === 'tool_result').length, finalFragments: fragmentsPerTurn, renderedToolBodyCharacters: renderedToolOutput.output.length };
          process.stderr.write('Candidate complete turn expanded\n');
          const middleTurn = outline.turns[Math.floor(turns / 2)];
          await page.getByRole('combobox', { name: '跳到轮次' }).selectOption(middleTurn.id);
          await page.locator(`[data-history-summary="${middleTurn.id}"]`).waitFor();
          const anchorBefore = await page.locator(`[data-history-summary="${middleTurn.id}"]`).evaluate(element => element.getBoundingClientRect().top);
          liveEmit!({ type: 'text', data: { text: ' LIVE_AFTER_ANCHOR' } });
          await poll(async () => (await runtime.getEvents(session.id)).length > canonical.length, 'live event persisted');
          await page.waitForFunction(count => Number(document.querySelector<HTMLElement>('[data-timeline-scroll]')?.dataset.historyLoaded) > count, Number(settled.canonicalCacheEvents));
          await pause(350); await paint(page);
          const anchorAfter = await page.locator(`[data-history-summary="${middleTurn.id}"]`).evaluate(element => element.getBoundingClientRect().top);
          assert(Math.abs(anchorAfter - anchorBefore) <= 2, `reading anchor drifted ${anchorAfter - anchorBefore}px`);
          measurement.assertions.readingAnchorDriftPx = Math.abs(anchorAfter - anchorBefore);
          // Dispatch the same source contract used by cross-panel/handoff links.
          const target = toolCall;
          await page.evaluate(detail => window.dispatchEvent(new CustomEvent('dutydeck:show-history-turn', { detail })), { taskId: firstTurn.taskId, attemptId: firstTurn.attemptId, eventId: target.id, sequence: target.sequence });
          await page.locator(`[data-history-summary="${firstTurn.id}"]`).getByRole('button', { name: '收起完整记录' }).waitFor();
          await toolCard.locator('pre').first().waitFor();
          await poll(() => toolCard.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const viewport = element.closest('[data-timeline-scroll]')!.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
          }), 'source tool scrolled into reading viewport');
          const options = await page.getByRole('combobox', { name: '跳到轮次' }).locator('option').evaluateAll(elements => elements.map(element => (element as HTMLOptionElement).value));
          await page.getByRole('combobox', { name: '跳到轮次' }).selectOption(options.at(-1)!);
          await page.getByText('active instruction', { exact: true }).waitFor();
          assert(await page.getByText('active instruction', { exact: true }).evaluate(element => {
            const rect = element.getBoundingClientRect();
            const viewport = element.closest('[data-timeline-scroll]')!.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
          }), 'active round jump did not reach the reading viewport');
          measurement.assertions.summaryActiveAndSourceJumps = true;
          process.stderr.write('Candidate source/round jumps and reading anchor passed\n');
          const beforeRaw = requests.length;
          await page.getByRole('button', { name: '原始日志', exact: true }).click();
          await page.getByRole('button', { name: '复制完整原始日志' }).waitFor({ state: 'visible' });
          await poll(() => page.getByRole('button', { name: '复制完整原始日志' }).isEnabled(), 'raw log fully loads');
          const rawText = (events: any[]) => events.filter((event: any) => event.type === 'raw_terminal').map((event: any) => event.raw ?? event.data.text).join('');
          let all = await runtime.getEvents(session.id);
          let expectedRaw = rawText(all);
          assert.equal(await page.getByLabel('原始日志内容', { exact: true }).textContent(), expectedRaw);
          liveEmit!({ type: 'raw_terminal', data: { text: 'RAW_LIVE_PANEL_APPEND\n' } });
          await poll(async () => (await page.getByLabel('原始日志内容', { exact: true }).textContent())?.endsWith('RAW_LIVE_PANEL_APPEND\n') ?? false, 'raw panel live suffix');
          all = await runtime.getEvents(session.id); expectedRaw = rawText(all);
          await page.getByRole('button', { name: '复制完整原始日志' }).click();
          await poll(async () => await page.evaluate(() => navigator.clipboard.readText()) === expectedRaw, 'full raw clipboard snapshot');
          const downloadPromise = page.waitForEvent('download');
          await page.getByRole('button', { name: '导出全部事件' }).click();
          const download = await downloadPromise;
          const downloadPath = await download.path();
          assert(downloadPath);
          const exported = JSON.parse(await readFile(downloadPath, 'utf8'));
          assert.deepEqual(exported, all);
          measurement.assertions.rawFullCopyAndExport = { records: exported.length, rawCharacters: expectedRaw.length, explicitRequests: requests.length - beforeRaw, canonicalExportSha256: sha(JSON.stringify(exported)) };
          // A second export keeps receiving new events. Its last record must
          // match the high water mark captured by that click, not chase the stream.
          let capturedWatermark: number | undefined;
          let appendIndex = 0;
          const capture = async (response: import('@playwright/test').Response) => {
            if (response.url().endsWith(`/api/sessions/${session.id}/history`)) {
              capturedWatermark = (await response.json()).highWaterMark;
              liveEmit!({ type: 'raw_terminal', data: { text: 'RAW_AFTER_EXPORT_WATERMARK\n' } });
            }
          };
          page.on('response', capture);
          const appendTimer = setInterval(() => liveEmit!({ type: 'raw_terminal', data: { text: `RAW_DURING_EXPORT_${++appendIndex}\n` } }), 25);
          try {
            const nextDownload = page.waitForEvent('download');
            await page.getByRole('button', { name: '导出全部事件' }).click();
            const nextPath = await (await nextDownload).path(); assert(nextPath);
            const snapshotExport = JSON.parse(await readFile(nextPath, 'utf8'));
            assert(capturedWatermark !== undefined);
            assert.equal(snapshotExport.at(-1)?.sequence, capturedWatermark);
            await poll(async () => (await runtime.getEvents(session.id)).at(-1).sequence > capturedWatermark!, 'events after export watermark');
            assert.deepEqual(snapshotExport, (await runtime.getEvents(session.id)).filter((event: any) => event.sequence <= capturedWatermark!));
            measurement.assertions.exportWhileLive = { capturedWatermark, records: snapshotExport.length, concurrentRawEvents: appendIndex };
          } finally { clearInterval(appendTimer); page.off('response', capture); }
          process.stderr.write('Candidate complete raw copy/export/live snapshot passed\n');
          const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
          await mobile.route('**/*', localRequestsOnly);
          const phone = await mobile.newPage();
          try {
            const mobileErrors: string[] = [];
            phone.on('pageerror', error => mobileErrors.push(error.message));
            await phone.goto(`${baseUrl}/sessions/${session.id}`, { waitUntil: 'domcontentloaded' });
            await phone.getByText('active instruction', { exact: true }).waitFor();
            await phone.getByRole('combobox', { name: '跳到轮次' }).selectOption(firstTurn.id);
            const mobileSummary = phone.locator(`[data-history-summary="${firstTurn.id}"]`);
            await mobileSummary.getByRole('button', { name: '展开完整记录', exact: true }).click();
            await mobileSummary.getByText(outputs.get(1)!.trim(), { exact: true }).waitFor();
            await phone.getByRole('button', { name: '原始日志', exact: true }).click();
            await phone.getByRole('dialog', { name: '原始日志', exact: true }).waitFor();
            await poll(() => phone.getByRole('button', { name: '复制完整原始日志' }).isEnabled(), 'mobile complete raw log');
            const mobileCanonical = await runtime.getEvents(session.id);
            assert.equal(await phone.getByLabel('原始日志内容', { exact: true }).textContent(), rawText(mobileCanonical));
            assert.deepEqual(mobileErrors, []);
            measurement.assertions.mobile = { viewport: '390x844', expandedCompleteTurn: true, rawDialogComplete: true, pageErrors: mobileErrors };
          } catch (error) { results.mobileFailure = { body: (await phone.locator('body').innerText()).slice(0, 12000), historyLayout: await historyLayout(phone) }; throw error; }
          finally { await mobile.close(); }
        }
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(blockedExternalUrls, []);
      } catch (error) {
        results.browserFailure = { label, body: (await page.locator('body').innerText()).slice(0, 12000), historyLayout: await historyLayout(page), pageErrors, requests };
        throw error;
      } finally { await context.close(); await app.close(); }
    }
    results.status = 'passed';
  } catch (error) {
    results.status = 'failed'; results.failure = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
    await browser?.close(); releaseFirst(); releaseActive(); await runtime.shutdown(); repos.close(); await rm(scratch, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    process.stdout.write(`${output}\n${JSON.stringify({ status: results.status, fixture: { ...results.fixture, tail: undefined }, measurements: results.measurements.map(({ requests, ...rest }: any) => rest) }, null, 2)}\n`);
  }
}
void main().then(() => process.exit(0)).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exit(1); });
