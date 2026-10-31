import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@dutydeck/shared';
import { JsonlTransport, PtyTransport } from './index.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))));
const config = (fixture: string, protocol: 'jsonl' | 'pty'): AgentConfig => ({ id: protocol, name: protocol, command: process.execPath, args: [resolve(process.cwd(), fixture)], protocol, cwd: process.cwd(), env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false });

describe('fallback transports', () => {
  it('uses JSONL when ACP is unavailable and preserves structured tool output', async () => { const events: any[] = []; const transport = new JsonlTransport(config('tests/fixtures/jsonl-agent.mjs', 'jsonl'), { onEvent: e => events.push(e) }); await transport.start(); await transport.send('hello'); await vi.waitFor(() => expect(events.some(e => e.type === 'completed')).toBe(true)); expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['thinking', 'tool_call', 'tool_result', 'text'])); await transport.stop(); });
  it('uses a real PTY and does not lose raw terminal output', async () => { const events: any[] = []; const transport = new PtyTransport(config('tests/fixtures/pty-agent.mjs', 'pty'), { onEvent: e => events.push(e) }); await transport.start(); await transport.send('hello'); await vi.waitFor(() => expect(events.some(e => e.raw?.includes('RAW PTY'))).toBe(true), { timeout: 3_000 }); expect(events.filter(e => e.type === 'raw_terminal').map(e => e.raw).join('')).toContain('hello'); await transport.stop(); });
  it.skipIf(process.platform === 'win32')('delivers the exit burst through the compatibility PTY transport', async () => {
    const events: any[] = [];
    let exit!: () => void;
    const done = new Promise<void>(resolve => { exit = resolve; });
    const agent = { ...config('', 'pty'), command: '/bin/sh', args: ['-c', 'i=0; while [ "$i" -lt 256 ]; do printf "%062d\\n" "$i"; i=$((i+1)); done; printf TAIL'] };
    const transport = new PtyTransport(agent, { onEvent: event => events.push(event), onExit: exit });
    try {
      await transport.start();
      const until = Date.now() + 300; while (Date.now() < until) { /* Deliberately stall the real reader until child exit. */ }
      await done;
      const expected = Array.from({ length: 256 }, (_, i) => String(i).padStart(62, '0') + '\r\n').join('') + 'TAIL';
      expect(events.map(event => event.raw ?? '').join('')).toBe(expected);
    } finally { await transport.stop(); }
  });
  it('stop terminates the entire fallback process tree', async () => { const dir = await mkdtemp(join(tmpdir(), 'dutydeck-tree-')); dirs.push(dir); const pidFile = join(dir, 'child.pid'); const agent = { ...config('tests/fixtures/process-tree-agent.mjs', 'jsonl'), env: { DUTYDECK_TEST_PID_FILE: pidFile } }; const transport = new JsonlTransport(agent, { onEvent() {} }); await transport.start(); await vi.waitFor(async () => expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0), { timeout: 3_000 }); const childPid = Number(await readFile(pidFile, 'utf8')); await transport.stop(); await vi.waitFor(() => { let alive = true; try { process.kill(childPid, 0); } catch { alive = false; } expect(alive).toBe(false); }, { timeout: 3_000 }); });
});
