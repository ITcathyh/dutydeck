import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTranscriptTailer } from './claude.js';

const io = vi.hoisted(() => ({ path: '', bytes: 0, fds: new Set<number>(), fail: false, truncate: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs,
    openSync: (...args: any[]) => { const fd = (fs.openSync as any)(...args); if (args[0] === io.path) io.fds.add(fd); return fd; },
    closeSync: (fd: number) => { io.fds.delete(fd); fs.closeSync(fd); },
    readSync: (...args: any[]) => {
      if (io.fds.has(args[0]) && io.fail) throw new Error('fixture read failed');
      const count = (fs.readSync as any)(...args);
      if (io.fds.has(args[0])) {
        io.bytes += count;
        if (io.truncate) { io.truncate = false; fs.truncateSync(io.path, 0); }
      }
      return count;
    },
  };
});
const records = readFileSync(new URL('../fixtures/claude-background-tasks/before-clear.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
let root = '', tailer: ClaudeTranscriptTailer;
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'dd-bg-incremental-')); const main = join(root, 'main.jsonl');
  writeFileSync(main, records.slice(0, 7).map(entry => JSON.stringify(entry) + '\n').join(''));
  tailer = new ClaudeTranscriptTailer({ cwd: root, transcriptPath: main });
  io.path = join(root, 'sibling.jsonl'); io.bytes = 0; io.fail = false; io.truncate = false;
  const id = records.find(entry => entry.toolUseResult?.isAsync)?.toolUseResult.agentId;
  const notice = (task = id) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification><task-id>${task}</task-id><summary>完成 😀</summary><status>completed</status></task-notification>` }) + '\n';
  return { main, notice };
}
afterEach(() => { tailer?.stop(); expect(io.fds.size).toBe(0); if (root) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

it('reads only appended sibling bytes and drains all complete notices in the same flush', async () => {
  const { notice } = fixture(); const padding = (JSON.stringify({ content: 'x'.repeat(2048) }) + '\n').repeat(1400);
  writeFileSync(io.path, padding); await tailer.flush(); expect(tailer.pendingBackgroundWork()).toBe(2);
  const events: any[] = []; tailer.onEvent(event => events.push(event)); io.bytes = 0;
  const increment = '{}\n' + notice('unrelated-task') + notice(); appendFileSync(io.path, increment);
  await tailer.flush();
  expect(io.bytes).toBe(Buffer.byteLength(increment)); expect(tailer.pendingBackgroundWork()).toBe(1);
  expect(events).toHaveLength(1); expect(events[0].data.count).toBe(1);
  io.bytes = 0; await tailer.flush(); expect(io.bytes).toBe(0); expect(events).toHaveLength(1);
});

it('retains the full line cursor across every byte boundary including split UTF-8', async () => {
  const { notice } = fixture(); writeFileSync(io.path, '{}\n'); await tailer.flush();
  const events: any[] = []; tailer.onEvent(event => events.push(event));
  const bytes = Buffer.from(notice());
  for (const byte of bytes.subarray(0, -1)) {
    appendFileSync(io.path, Buffer.from([byte])); await tailer.flush();
    expect(tailer.pendingBackgroundWork()).toBe(2);
  }
  appendFileSync(io.path, '\n'); await tailer.flush();
  expect(tailer.pendingBackgroundWork()).toBe(1); expect(events).toHaveLength(1);
});

it.each(['truncate', 'replace'])('resets a sibling cursor after %s without importing an old partial line', async mode => {
  const { notice } = fixture(); writeFileSync(io.path, '{}\n'.repeat(200) + '{"partial":"😀'); await tailer.flush();
  if (mode === 'truncate') { writeFileSync(io.path, ''); await tailer.flush(); writeFileSync(io.path, notice()); }
  else { const replacement = join(root, 'replacement'); writeFileSync(replacement, notice() + '{}\n'.repeat(300)); renameSync(replacement, io.path); }
  await tailer.flush(); expect(tailer.pendingBackgroundWork()).toBe(1);
});

it('closes failed reads and retries a concurrent truncation from a fresh cursor', async () => {
  const { notice } = fixture(); writeFileSync(io.path, '{}\n'); await tailer.flush();
  appendFileSync(io.path, notice()); io.fail = true; await tailer.flush();
  expect(io.fds.size).toBe(0); expect(tailer.pendingBackgroundWork()).toBe(2);
  io.fail = false; io.truncate = true; await tailer.flush();
  expect(tailer.pendingBackgroundWork()).toBe(2); expect(io.fds.size).toBe(0);
  writeFileSync(io.path, notice()); await tailer.flush(); expect(tailer.pendingBackgroundWork()).toBe(1);
});

it('does not read siblings or deliver a late status when stopped during a main flush', async () => {
  const { notice } = fixture(); writeFileSync(io.path, '{}\n'); await tailer.flush();
  const events: any[] = []; tailer.onEvent(event => events.push(event)); appendFileSync(io.path, notice()); io.bytes = 0;
  let resume!: () => void;
  vi.spyOn((tailer as any).tailer, 'flush').mockImplementation(() => new Promise<void>(resolve => { resume = resolve; }));
  const flushing = tailer.flush(); tailer.stop(); resume(); await flushing;
  expect(events).toEqual([]); expect(io.bytes).toBe(0); expect(io.fds.size).toBe(0);
});
