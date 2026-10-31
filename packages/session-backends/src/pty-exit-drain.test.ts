import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PtyBackend } from './pty-backend.js';
import { spawnPty } from './spawn-pty.js';

const command = 'i=0; while [ "$i" -lt 256 ]; do printf "%062d\\n" "$i"; i=$((i+1)); done; printf "尾部TAIL"';
const expected = Array.from({ length: 256 }, (_, i) => String(i).padStart(62, '0') + '\r\n').join('') + '尾部TAIL';
function stall(pid: number) {
  const deadline = Date.now() + 700;
  while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { break; } }
}
describe.skipIf(process.platform === 'win32')('PTY exit drain', () => {
  it('delivers the exact exit burst before the real backend exit callback', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-pty-tail-'));
    const backend = new PtyBackend();
    try {
      backend.spawn('/bin/sh', ['-c', command], { cwd, env: { HOME: cwd, PATH: '/usr/bin:/bin' }, cols: 80, rows: 24 });
      let output = '';
      const done = new Promise<void>(resolve => {
        backend.onData(data => { output += data; });
        backend.onExit(code => { expect(code).toBe(0); resolve(); });
      });
      stall(backend.getPid()!);
      await done;
      expect(output).toBe(expected);
    } finally { backend.kill(); rmSync(cwd, { recursive: true, force: true }); }
  });
  it('preserves UTF-8 and paused output until resume', async () => {
    const term = spawnPty('/bin/sh', ['-c', command], { cols: 80, rows: 24 });
    let output = '', exited = false;
    term.onData(data => { output += data; });
    const done = new Promise<void>(resolve => term.onExit(() => { exited = true; resolve(); }));
    term.pause();
    stall(term.pid);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(output).toBe(''); expect(exited).toBe(false);
    term.resume(); await done;
    expect(output).toBe(expected);
  });
  it.each(['exit 0', 'kill -TERM $$'])('retains native exit semantics: %s', async command => {
    const term = spawnPty('/bin/sh', ['-c', command], {});
    const result = await new Promise<{ exitCode: number; signal?: number }>(resolve => term.onExit(resolve));
    expect(result.signal || result.exitCode).toBe(command === 'exit 0' ? 0 : 15);
  });
  it.each([false, true])('the built plain Node relay forwards an exact UTF-8 burst (stalled=%s)', async stalled => {
    const relay = fileURLToPath(new URL('../dist/program-status-relay.js', import.meta.url));
    const root = mkdtempSync(join(tmpdir(), 'dd-relay-tail-')), gate = join(root, 'go');
    const burst = 'printf READY; while [ ! -f "$1" ]; do sleep 0.01; done; ' + command;
    const child = spawn(process.execPath, [relay, '/bin/sh', '-c', burst, 'fixture', gate], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let ready = false, observedStopped = false, resume: NodeJS.Timeout | undefined;
    child.stdout.on('data', data => {
      output.push(data);
      if (!ready && Buffer.concat(output).toString().startsWith('READY')) {
        ready = true;
        if (stalled) child.kill('SIGSTOP');
        writeFileSync(gate, 'go');
        if (stalled) resume = setTimeout(() => {
          if (process.platform === 'linux') observedStopped = /\) T /.test(readFileSync(`/proc/${child.pid}/stat`, 'utf8'));
          child.kill('SIGCONT');
        }, 300);
      }
    });
    child.stderr.on('data', data => errors.push(data));
    try {
      const code = await new Promise(resolve => child.on('close', resolve));
      expect(errors.toString()).toBe(''); expect(code).toBe(0);
      if (stalled && process.platform === 'linux') expect(observedStopped).toBe(true);
      expect(Buffer.concat(output).toString('utf8')).toBe('READY' + expected);
    } finally {
      if (resume) clearTimeout(resume);
      child.kill('SIGCONT'); child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });
});
