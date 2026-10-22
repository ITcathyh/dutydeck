import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { chromium } from '@playwright/test';
import ts from 'typescript';

// Exercise the actual class with Chromium's native EventSource and timers.
// Only URL construction and the shared enum import are supplied by the fixture.
const source = await readFile(new URL('../apps/web/src/sse.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace(/^import .*$/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const connections: { session: string; after: number }[] = [];
const active = new Set<ServerResponse>();
const server = createServer((request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  if (url.pathname.endsWith('/stream')) {
    const session = url.pathname.split('/')[3]!;
    connections.push({ session, after: Number(url.searchParams.get('after')) });
    active.add(response); response.on('close', () => active.delete(response));
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const sequence = connections.length;
    response.write(`event: text\ndata: ${JSON.stringify({ id: `event-${sequence}`, sequence, type: 'text', timestamp: '', data: { text: `${sequence}` } })}\n\n`);
    if (sequence === 1) setTimeout(() => response.destroy(), 50);
  } else if (url.pathname === '/drop') {
    for (const stream of active) stream.destroy();
    response.end('dropped');
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<script>const eventTypes=['text'],sessionStates=['idle'],withShareToken=s=>s,instanceApiUrl=s=>s;${compiled}
      let hidden=false;Object.defineProperty(document,'hidden',{get:()=>hidden,configurable:true});
      window.fixture={statuses:[],events:[],after:0,reconciles:0};
      fixture.visibility=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));};
      fixture.create=id=>new SessionStream({sessionId:id,getAfter:()=>fixture.after,onEvent:event=>{fixture.events.push(event.sequence);fixture.after=event.sequence;},onStatus:status=>fixture.statuses.push(status),onReconnect:()=>fixture.reconciles++});
      fixture.stream=fixture.create('first');fixture.stream.start();</script>`);
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.stack ?? error.message));
try {
  await page.addInitScript('globalThis.__name = value => value');
  await page.goto(base);
  await page.waitForFunction(() => (window as any).fixture.events.length === 2);
  assert.deepEqual(connections.slice(0, 2), [{ session: 'first', after: 0 }, { session: 'first', after: 1 }]);
  await page.evaluate(() => (window as any).fixture.visibility(true));
  await page.request.get(`${base}/drop`);
  await page.waitForFunction(() => (window as any).fixture.stream.source === undefined);
  await page.evaluate(() => (window as any).fixture.visibility(false));
  await page.waitForFunction(() => (window as any).fixture.events.length === 3);
  // Keep real native timer delays: the hidden suspend must fire at 60 seconds.
  await page.evaluate(() => (window as any).fixture.visibility(true));
  await page.waitForFunction(() => (window as any).fixture.stream.source === undefined, undefined, { timeout: 65_000 });
  await page.evaluate(() => (window as any).fixture.visibility(false));
  await page.waitForFunction(() => (window as any).fixture.events.length === 4);
  await page.evaluate(() => {
    const fixture = (window as any).fixture;
    fixture.old = fixture.stream;
    fixture.old.close(); fixture.stream = fixture.create('second'); fixture.stream.start();
  });
  await page.waitForFunction(() => (window as any).fixture.events.length === 5);
  const result = await page.evaluate(() => {
    const fixture = (window as any).fixture;
    fixture.stream.close();
    const clean = (stream: any) => ['source', 'timer', 'watchdog', 'suspendTimer'].every(key => stream[key] === undefined);
    return { statuses: fixture.statuses, events: fixture.events, reconciles: fixture.reconciles, cleaned: clean(fixture.old) && clean(fixture.stream) };
  });
  assert.deepEqual(result.events, [1, 2, 3, 4, 5]);
  assert.equal(result.statuses.filter((status: string) => status === 'open').length, 5);
  assert.equal(result.reconciles, 3);
  assert.equal(result.cleaned, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(connections.map(connection => connection.after), [0, 1, 2, 3, 4]);
  console.log(JSON.stringify({ case: 'native Chromium SSE open/error/backoff/hidden suspend/foreground/session switch/close', ...result, connections, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
  for (const stream of active) stream.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
