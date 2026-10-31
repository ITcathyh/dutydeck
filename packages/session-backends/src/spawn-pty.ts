// Exit drain adapted from botmux 8c8f232305 (MIT); see THIRD_PARTY_NOTICES.md.
import * as pty from 'node-pty';
import { readSync } from 'node:fs';
import type { Readable } from 'node:stream';

/** node-pty 1.2 Unix uses a nonblocking tty.ReadStream. libuv can end it on
 * POLLHUP after a short read while the master still has queued bytes. Keep
 * node-pty's decoder and event ordering; only drain at its teardown boundary. */
export const spawnPty: typeof pty.spawn = (file, args, options) => {
  const terminal = pty.spawn(file, args, options);
  if (process.platform === 'win32') return terminal;
  const unix = terminal as pty.IPty & { _socket?: Readable; fd?: number };
  const socket = unix._socket, fd = unix.fd;
  if (!socket || typeof fd !== 'number' || typeof socket.push !== 'function' || typeof socket.destroy !== 'function') return terminal;
  const push = socket.push.bind(socket), destroy = socket.destroy;
  let drained = false, deferred = false;
  const drain = () => {
    if (drained || socket.destroyed) return;
    drained = true;
    // Bounded even if another process still holds and writes the slave.
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let total = 0; total < 1024 * 1024;) {
      let count: number;
      try { count = readSync(fd, buffer, 0, Math.min(buffer.length, 1024 * 1024 - total), null); }
      catch { break; } // EAGAIN/EIO/closed descriptor: retain native teardown.
      if (!count) break;
      push(Buffer.from(buffer.subarray(0, count)));
      total += count;
    }
  };
  socket.push = (chunk, encoding) => {
    if (chunk === null) drain();
    return push(chunk, encoding);
  };
  socket.destroy = error => {
    if (!error && !socket.destroyed) {
      drain();
      // pause() is a consumer contract. Do not discard buffered tail bytes or
      // announce exit until the consumer resumes and receives them.
      if (socket.readableLength > 0) {
        if (!deferred) {
          deferred = true;
          if (!socket.readableEnded) push(null);
          socket.once('end', () => destroy.call(socket));
        }
        return socket;
      }
    }
    return destroy.call(socket, error);
  };
  return terminal;
};
