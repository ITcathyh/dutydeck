import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import type { DockEvent, Task } from '../apps/web/src/api.js';
import { createTimelineProjector } from '../apps/web/src/timeline.js';
import { createEventWindow, mergeReconciledEvents } from '../apps/web/src/event-history.js';
import { createRawLogProjector } from '../apps/web/src/raw-log.js';

const baseline = process.argv[2] ?? '2abe76ec7ed84a5f16fe36e86ccf6d558066b0c4';
function original(path: string): any {
  const source = execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' }).replace(/^import .*$/gm, '');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('exports', code)(exports);
  return exports;
}
const before = original('apps/web/src/timeline.ts');
const beforeEvents = original('apps/web/src/event-history.ts');
const event = (sequence: number, role?: string, type = 'text'): DockEvent => ({ id: `web-${sequence}`, sequence, type, timestamp: String(sequence).padStart(9, '0'), data: { role, text: 'streaming 中文 text 12345\n' } });
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!;
const runLong = (count: number, projectFactory: typeof createTimelineProjector, merge = mergeReconciledEvents) => {
  const tasks: Task[] = [], project = projectFactory();
  let window = createEventWindow(Array.from({ length: count }, (_, index) => event(index + 1, index ? undefined : 'user')));
  project(window.events, tasks, false, window);
  const samples: number[] = [];
  for (let index = 0; index < 40; index++) {
    const started = performance.now();
    window = merge(window, [event(count + index + 1)]);
    project(window.events, tasks, false, window);
    samples.push(performance.now() - started);
  }
  return { p95Ms: p95(samples), output: project(window.events, tasks) };
};
const long = [1_000, 10_000, 50_000].map(events => {
  const old = runLong(events, before.createTimelineProjector, beforeEvents.mergeReconciledEvents), current = runLong(events, createTimelineProjector);
  assert.deepEqual(current.output, old.output);
  return { events, appends: 40, beforeP95Ms: old.p95Ms, afterP95Ms: current.p95Ms };
});
const history = [5_000, 10_000, 20_000].map(count => {
  function run(projectFactory: typeof createTimelineProjector, merge: typeof mergeReconciledEvents) {
    const events = Array.from({ length: count }, (_, index) => event(index + 1, index % 2 ? undefined : 'user'));
    const tasks: Task[] = [], project = projectFactory();
    let window = createEventWindow(events.slice(-200), true);
    project(window.events, tasks, true, window);
    const started = performance.now();
    for (let end = count - 200; end > 0; end -= 200) { window = merge(window, events.slice(Math.max(0, end - 200), end)); project(window.events, tasks, true, window); }
    return { ms: performance.now() - started, output: project(window.events, tasks, false) };
  }
  const old = run(before.createTimelineProjector, beforeEvents.mergeReconciledEvents), current = run(createTimelineProjector, mergeReconciledEvents);
  assert.deepEqual(current.output, old.output);
  return { events: count, pages: count / 200, beforeMs: old.ms, afterMs: current.ms };
});
const raw = [1_000, 10_000].map(count => {
  const initial = Array.from({ length: count }, (_, index) => ({ ...event(index + 1, undefined, 'raw_terminal'), raw: `${index}:`.padEnd(4096, 'x') }));
  function run(incremental: boolean) {
    const project = createRawLogProjector();
    let window = createEventWindow(initial), output = incremental ? project(window.events, window) : '';
    const samples: number[] = [], unchangedRawSamples: number[] = [], changedRawSamples: number[] = [];
    for (let index = 1; index <= 20; index++) {
      window = mergeReconciledEvents(window, [event(count + index, undefined, index % 2 ? 'text' : 'raw_terminal')]);
      const started = performance.now();
      output = incremental ? project(window.events, window) : window.events.filter(event => event.type === 'raw_terminal').map(event => event.raw ?? event.data.text).join('');
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      (index % 2 ? unchangedRawSamples : changedRawSamples).push(elapsed);
    }
    return { p95Ms: p95(samples), unchangedRawP95Ms: p95(unchangedRawSamples), changedRawP95Ms: p95(changedRawSamples), totalMs: samples.reduce((sum, value) => sum + value, 0), output };
  }
  const old = run(false), current = run(true);
  assert.equal(current.output, old.output);
  return { events: count, characters: current.output.length, updates: 20, beforeP95Ms: old.p95Ms, afterP95Ms: current.p95Ms,
    unchangedRawP95Ms: { before: old.unchangedRawP95Ms, after: current.unchangedRawP95Ms },
    changedRawP95Ms: { before: old.changedRawP95Ms, after: current.changedRawP95Ms }, totalMs: { before: old.totalMs, after: current.totalMs } };
});
// Independent old implementation oracle covers changed/nonmonotonic events and
// all prior returned snapshots, not only the shared append reducer.
let checkedPrefixes = 0;
for (let seed = 0; seed < 10; seed++) {
  const old = before.createTimelineProjector(), current = createTimelineProjector(), tasks: Task[] = [];
  let window = createEventWindow([]), retained: { output: any; json: string }[] = [];
  for (let index = 1; index <= 100; index++) {
    const sequence = index % 11 === 0 ? index - 3 : index;
    const next = event(sequence, index % 17 === 1 ? 'user' : undefined, index % 7 === 0 ? 'tool_result' : index % 5 === 0 ? 'thinking' : 'text');
    if (next.type === 'tool_result') next.data = { id: `tool-${index % 3}`, status: 'completed', output: `${seed}:${index}` };
    if (index % 13 === 0) next.timestamp = String(Math.max(0, sequence - 5)).padStart(9, '0');
    window = mergeReconciledEvents(window, [next]);
    const output = current(window.events, tasks, true, window);
    assert.deepEqual(output, old(window.events, tasks, true, window));
    for (const snapshot of retained) assert.equal(JSON.stringify(snapshot.output), snapshot.json);
    retained.push({ output, json: JSON.stringify(output) });
    checkedPrefixes++;
  }
}
let checkedLabels = 0, random = 47;
const tokens = ['plain text ', '\n', '<tag>', '</tag>', '<', '[title](url)', '[', ']', '(', ')', '**', '`', '12', '. ', '- ', '中文'];
for (let seed = 0; seed < 1000; seed++) {
  let text = '';
  for (let index = 0; index < 200; index++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; text += tokens[random % tokens.length]; }
  const source = [event(1, 'user'), { ...event(2), data: { text } }, { ...event(3, undefined, 'tool_call'), data: { id: 'tool', name: 'Read' } }];
  assert.deepEqual(createTimelineProjector()(source), before.createTimelineProjector()(source));
  checkedLabels++;
}
console.log(JSON.stringify({ baseline, environment: 'Node synthetic same-process before/after; excludes React/Markdown/layout', long, history, raw, checkedPrefixes, checkedLabels, equivalent: true, immutableSnapshots: true }, null, 2));
