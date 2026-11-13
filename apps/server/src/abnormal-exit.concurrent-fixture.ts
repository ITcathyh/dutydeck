import { recordAbnormalExit } from './abnormal-exit.js';

const [database, label, startAt] = process.argv.slice(2);
if (!database || !label) throw new Error('database and label are required');
while (Date.now() < Number(startAt)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
for (let index = 0; index < 5; index++) {
  recordAbnormalExit(database, {
    kind: 'fatal', exitCode: 1, error: `${label}-${index}`, version: '1',
    lifecycle: { runId: `${label}-${index}`, pid: process.pid, startedAt: '2026-11-13T00:00:00.000Z', version: '1', phase: 'running' }
  });
}
