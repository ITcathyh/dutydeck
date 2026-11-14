import Database from 'better-sqlite3';
import { recordAbnormalExit } from './abnormal-exit.js';

const [database, label, count = '5'] = process.argv.slice(2);
if (!database || !label || !process.send) throw new Error('database, label and an IPC channel are required');

const exec = Database.prototype.exec;
Database.prototype.exec = function (source: string) {
  if (source === 'BEGIN IMMEDIATE') {
    process.send!({ type: 'waiting', label });
    const started = performance.now();
    const result = exec.call(this, source);
    process.send!({ type: 'acquired', label, waitMs: performance.now() - started });
    return result;
  }
  // Keep the production lock held while the other released processes enter the same critical section.
  if (source === 'COMMIT') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  const result = exec.call(this, source);
  if (source === 'COMMIT') process.send!({ type: 'released', label });
  return result;
};

process.send({ type: 'ready', label });
await new Promise<void>(resolve => {
  const onMessage = (message: unknown) => {
    if ((message as { type?: string })?.type !== 'start') return;
    process.off('message', onMessage);
    resolve();
  };
  process.on('message', onMessage);
});
for (let index = 0; index < Number(count); index++) {
  recordAbnormalExit(database, {
    kind: 'fatal', exitCode: 1, error: `${label}-${index}`, version: '1',
    lifecycle: { runId: `${label}-${index}`, pid: process.pid, startedAt: '2026-11-13T00:00:00.000Z', version: '1', phase: 'running' }
  });
}
if (process.connected) process.disconnect();
