import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createConnection, createServer, type Socket } from 'node:net';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { TmuxCapture, cleanAbandonedTmuxCapture, tmuxCaptureWriter } from './tmux-capture.js';

describe('bounded tmux capture', () => {
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
