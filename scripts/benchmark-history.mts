import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentEvent } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from '../apps/server/src/app.js';
import { createEventWindow, EVENT_RENDER_LIMIT, mergeLiveEvent } from '../apps/web/src/event-history.js';

const SESSION_ID = 'ses_benchmark_50k';
const EVENT_COUNT = 50_000;
const budgets = { firstScreenP95Ms: 800, paginationP95Ms: 100, incrementalP95Ms: 80, retainedHeapBytes: 32 * 1024 * 1024, entryGzipBytes: 140 * 1024 };

function event(sequence: number): AgentEvent {
  return {
    id: `evt_${sequence}`,
    sessionId: SESSION_ID,
    sequence,
    type: sequence % 7 === 0 ? 'tool_result' : 'text',
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    data: { text: `event ${sequence}`, status: 'completed', taskId: `task_${Math.floor(sequence / 20)}` }
  };
}

const percentile95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
async function sample(count: number, action: (index: number) => Promise<void> | void) {
  const durations: number[] = [];
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    await action(index);
    durations.push(performance.now() - started);
  }
  return percentile95(durations);
}

function assertBudget(name: string, actual: number, budget: number, unit: string) {
  if (actual > budget) throw new Error(`${name} exceeded: ${actual.toFixed(2)}${unit} > ${budget.toFixed(2)}${unit}`);
}

async function main() {
  process.env.NODE_ENV = 'test';
  const repos = createRepositories(':memory:');
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
  const insertStarted = performance.now();
  for (let sequence = 1; sequence <= EVENT_COUNT; sequence++) await repos.events.append(event(sequence));
  const seedMs = performance.now() - insertStarted;
  const runtime = {
    getEventWindow: (sessionId: string, options: any) => repos.events.listWindow(sessionId, options),
    getEvents: (sessionId: string, after: number) => repos.events.list(sessionId, after),
    subscribe: () => () => {}
  } as any;
  app = await buildApp(runtime);

  for (let index = 0; index < 5; index++) await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/events?limit=200&direction=backward` });
  const firstScreenP95Ms = await sample(40, async () => {
    const response = await app!.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/events?limit=200&direction=backward` });
    if (response.statusCode !== 200) throw new Error(`initial history returned ${response.statusCode}`);
    const window = createEventWindow(response.json(), true);
    if (window.events.length !== 200) throw new Error(`initial history returned ${window.events.length} events`);
  });
  const paginationP95Ms = await sample(60, async index => {
    const before = EVENT_COUNT - (index % 50) * 200;
    const response = await app!.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/events?before=${before}&limit=200&direction=backward` });
    if (response.statusCode !== 200 || response.json().length !== 200) throw new Error('bounded pagination contract failed');
  });

  let window = createEventWindow(Array.from({ length: EVENT_RENDER_LIMIT }, (_, offset) => event(EVENT_COUNT - EVENT_RENDER_LIMIT + offset + 1)), true);
  const incrementalP95Ms = await sample(2_000, index => {
    window = mergeLiveEvent(window, event(EVENT_COUNT + index + 1));
    if (window.events.length > EVENT_RENDER_LIMIT) throw new Error('client event window grew past its bound');
  });

  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  for (let index = 0; index < 500; index++) {
    const before = EVENT_COUNT - (index % 100) * 200;
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/events?before=${before}&limit=200&direction=backward` });
    if (response.statusCode !== 200) throw new Error('history soak request failed');
  }
  global.gc?.();
  const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

  const assets = resolve('apps/web/dist/assets');
  const entry = (await readdir(assets)).find(name => /^index-.*\.js$/.test(name));
  if (!entry) throw new Error('Web entry bundle not found; run the production build first');
  const entryGzipBytes = gzipSync(await readFile(resolve(assets, entry))).byteLength;

  assertBudget('first visible history p95', firstScreenP95Ms, budgets.firstScreenP95Ms, 'ms');
  assertBudget('history pagination p95', paginationP95Ms, budgets.paginationP95Ms, 'ms');
  assertBudget('incremental client update p95', incrementalP95Ms, budgets.incrementalP95Ms, 'ms');
  assertBudget('history soak retained heap', retainedHeapBytes, budgets.retainedHeapBytes, 'B');
  assertBudget('Web entry gzip', entryGzipBytes, budgets.entryGzipBytes, 'B');

  process.stdout.write(`${JSON.stringify({ eventCount: EVENT_COUNT, seedMs, firstScreenP95Ms, paginationP95Ms, incrementalP95Ms, retainedHeapBytes, entryGzipBytes, budgets }, null, 2)}\n`);
  } finally {
    await app?.close();
    repos.close();
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
