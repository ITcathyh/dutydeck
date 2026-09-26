import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentEvent } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { createTimelineProjector } from '../apps/web/src/timeline.js';
import { buildApp } from '../apps/server/src/app.js';
import { createEventWindow, mergeLiveEvent, mergeReconciledEvents } from '../apps/web/src/event-history.js';

const SESSION_ID = 'ses_benchmark_50k';
const EVENT_COUNT = 50_000;
const budgets = { firstScreenP95Ms: 800, paginationP95Ms: 100, incrementalP95Ms: 80, retainedHeapBytes: 32 * 1024 * 1024, entryGzipBytes: 140 * 1024 };

function event(sequence: number): AgentEvent {
  return {
    id: `evt_${sequence}`,
    sessionId: SESSION_ID,
    sequence,
    type: sequence % 20 === 1 ? 'text' : sequence % 7 === 0 ? 'tool_result' : 'text',
    timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
    data: { role: sequence % 20 === 1 ? 'user' : 'assistant', text: `event ${sequence}`, status: 'completed', taskId: `task_${Math.floor(sequence / 20)}` }
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
    const window = createEventWindow(response.json());
    if (window.events.length !== 200) throw new Error(`initial history returned ${window.events.length} events`);
  });
  const paginationP95Ms = await sample(60, async index => {
    const before = EVENT_COUNT - (index % 50) * 200;
    const response = await app!.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/events?before=${before}&limit=200&direction=backward` });
    if (response.statusCode !== 200 || response.json().length !== 200) throw new Error('bounded pagination contract failed');
  });

  let window = createEventWindow(Array.from({ length: EVENT_COUNT }, (_, offset) => event(offset + 1)));
  const incrementalP95Ms = await sample(2_000, index => {
    window = mergeLiveEvent(window, event(EVENT_COUNT + index + 1));
    if (window.events.length !== EVENT_COUNT + index + 1 || window.events[0]?.sequence !== 1) throw new Error('client discarded earlier history during live updates');
  });

  const loaded = createEventWindow(Array.from({ length: EVENT_COUNT }, (_, offset) => event(offset + 1)));
  const page = Array.from({ length: 200 }, (_, offset) => event(EVENT_COUNT + offset + 1));
  const reconcileP95Ms = await sample(40, () => { mergeReconciledEvents(loaded, page); });
  const projector = createTimelineProjector();
  const tasks: [] = [];
  projector(loaded.events, tasks);
  let derivedWindow = loaded;
  const deriveP95Ms = await sample(40, index => {
    const incoming = Array.from({ length: 200 }, (_, offset) => event(EVENT_COUNT + index * 200 + offset + 1));
    const next = mergeReconciledEvents(derivedWindow, incoming);
    projector(next.events, tasks, false, next);
    derivedWindow = next;
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

  const html = await readFile(resolve('apps/web/dist/index.html'), 'utf8');
  const entry = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  if (!entry) throw new Error('Web entry bundle not found; run the production build first');
  const entryGzipBytes = gzipSync(await readFile(resolve('apps/web/dist', entry.replace(/^\//, '')))).byteLength;

  process.stdout.write(`${JSON.stringify({ eventCount: EVENT_COUNT, seedMs, firstScreenP95Ms, paginationP95Ms, incrementalP95Ms, retainedHeapBytes, entryGzipBytes, reconcileP95Ms, deriveP95Ms, budgets }, null, 2)}\n`);
  assertBudget('200-event reconciliation p95', reconcileP95Ms, 20, 'ms');
  assertBudget('200-event merge and projection p95', deriveP95Ms, 20, 'ms');
  assertBudget('first visible history p95', firstScreenP95Ms, budgets.firstScreenP95Ms, 'ms');
  assertBudget('history pagination p95', paginationP95Ms, budgets.paginationP95Ms, 'ms');
  assertBudget('incremental client update p95', incrementalP95Ms, budgets.incrementalP95Ms, 'ms');
  assertBudget('history soak retained heap', retainedHeapBytes, budgets.retainedHeapBytes, 'B');
  assertBudget('Web entry gzip', entryGzipBytes, budgets.entryGzipBytes, 'B');


  } finally {
    await app?.close();
    repos.close();
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
