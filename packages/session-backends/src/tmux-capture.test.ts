import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createConnection, createServer, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { join } from 'node:path';
import { TmuxCapture, cleanAbandonedTmuxCapture, tmuxCaptureWriter } from './tmux-capture.js';
vi.mock('node:fs', async original => { const real = await original<typeof import('node:fs')>(); return { ...real, chmodSync: vi.fn(real.chmodSync) }; });

describe('bounded tmux capture', () => {
  it.each(['a'.repeat(130), '目录'.repeat(35)])('listens with a long temporary root %s', async suffix => {
    const root = mkdtempSync(join(tmpdir(), 'capture-long-'));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = join(root, suffix);
    mkdirSync(process.env.TMPDIR);
    let capture: TmuxCapture | undefined;
    try {
      capture = new TmuxCapture('long-root', () => {}, () => {});
      expect(Buffer.byteLength(capture.path)).toBeLessThanOrEqual(100);
      await capture.listen();
      expect(statSync(capture.directory).mode & 0o777).toBe(0o700);
      expect(statSync(capture.path).mode & 0o777).toBe(0o600);
    } finally {
      capture?.close();
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects and removes resources when listen initialization fails', async () => {
    const capture = new TmuxCapture('initialization-failure', () => {}, () => {});
    rmSync(capture.directory, { recursive: true });
    await expect(capture.listen()).rejects.toBeDefined();
    expect(existsSync(capture.directory)).toBe(false);
    capture.close();
  });

  it('rejects asynchronous chmod failure without an uncaught callback exception', async () => {
    const capture = new TmuxCapture('chmod-failure', () => {}, () => {});
    vi.mocked(chmodSync).mockImplementationOnce(() => { throw new Error('injected chmod failure'); });
    await expect(capture.listen()).rejects.toThrow('injected chmod failure');
    expect(existsSync(capture.directory)).toBe(false); capture.close();
  });
  it('decodes split UTF8 frames and leaves only small socket metadata, then cleans its own directory', async () => {
    let output = '';
    const capture = new TmuxCapture('fixture', data => { output += data; }, () => {});
    await capture.listen();
    const socket = createConnection(capture.path);
    await once(socket, 'connect');
    const bytes = Buffer.from('你好');
    socket.write(JSON.stringify({ data: bytes.subarray(0, 2).toString('base64') }) + '\n');
    socket.end(JSON.stringify({ data: bytes.subarray(2).toString('base64') }) + '\n');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(output).toBe('你好');
    expect(readdirSync(capture.directory).sort()).toEqual(['out.sock', 'owner.json']);
    expect(readFileSync(join(capture.directory, 'owner.json')).byteLength).toBeLessThan(1024);
    capture.close();
    expect(existsSync(capture.directory)).toBe(false);
  });

  it('drains and drops under reader backpressure, reports the final EOF gap and accounts for every byte', async () => {
    const capture = new TmuxCapture('fixture-overflow', () => {}, () => {});
    let reader!: Socket;
    const server = createServer(socket => { reader = socket; socket.pause(); });
    const socketPath = join(capture.directory, 'slow.sock');
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const child = spawn(process.execPath, ['-e', tmuxCaptureWriter, socketPath, String(64 * 1024)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = once(child, 'exit');
    await once(server, 'connection');
    const total = 32 * 1024 * 1024;
    const chunk = Buffer.alloc(8192, 120);
    try {
      for (let sent = 0; sent < total; sent += chunk.length) {
        if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
      }
      child.stdin.end();
      // EOF reaches the helper while its socket is still backpressured.
      await new Promise(resolve => setTimeout(resolve, 50));
      let pending = '', accepted = 0, dropped = 0, frames = 0;
      reader.on('data', chunk => {
        pending += chunk.toString();
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const frame = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1); frames++;
          if (frame.gap) dropped += frame.gap;
          else accepted += Buffer.from(frame.data, 'base64').length;
        }
      });
      reader.resume();
      await exit;
      expect(dropped).toBeGreaterThan(0);
      expect(accepted + dropped).toBe(total);
      expect(frames).toBeLessThan(100);
      expect(pending).toBe('');
    } finally { child.kill('SIGKILL'); reader.destroy(); server.close(); capture.close(); }
  }, 10000);

  it('cleans only the exact abandoned owner and retains live or foreign captures', async () => {
    const capture = new TmuxCapture('fixture-owner', () => {}, () => {});
    const file = join(capture.directory, 'owner.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    cleanAbandonedTmuxCapture(capture.directory, 'fixture-owner');
    expect(existsSync(capture.directory)).toBe(true);
    record.pid = 99999999;
    writeFileSync(file, JSON.stringify(record));
    cleanAbandonedTmuxCapture(capture.directory, 'foreign');
    expect(existsSync(capture.directory)).toBe(true);
    cleanAbandonedTmuxCapture(capture.directory, 'fixture-owner');
    expect(existsSync(capture.directory)).toBe(false);
    capture.close();
  });
});
