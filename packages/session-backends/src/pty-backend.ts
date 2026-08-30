import * as pty from 'node-pty';
import { chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { SessionBackend, SpawnOptions } from './types.js';

// npx/pnpm may strip execute bits from prebuilt binaries — fix before first spawn.
try {
  const req = createRequire(import.meta.url);
  const helper = join(
    dirname(req.resolve('node-pty/package.json')),
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );
  const mode = statSync(helper).mode;
  if (!(mode & 0o111)) chmodSync(helper, mode | 0o755);
} catch { /* best effort */ }

/**
 * PtyBackend — node-pty backed session. Ported from botmux's
 * adapters/backend/pty-backend.ts (core only: no claude-code adapter hooks).
 *
 * There is no shared backing server here, so per-session env (opts.injectEnv)
 * is merged straight into the child env.
 */
export class PtyBackend implements SessionBackend {
  readonly kind = 'pty' as const;
  /** SessionBackend contract: a pty child has no addressable session of its
   *  own — it dies with its backend, so there is nothing to reattach to. */
  readonly sessionName = undefined;
  private process: pty.IPty | null = null;

  spawn(bin: string, args: string[], opts: SpawnOptions): void {
    this.process = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      // injectEnv appended last so it wins over a same-named key in opts.env.
      env: opts.injectEnv ? { ...opts.env, ...opts.injectEnv } : opts.env,
    });
  }

  write(data: string): boolean {
    if (!this.process) return false;
    this.process.write(data);
    return true;
  }

  interrupt(): void {
    this.process?.write('\x03');
  }

  resize(cols: number, rows: number): void {
    this.process?.resize(cols, rows);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onData(cb: (data: string) => void): void {
    this.process?.onData(cb);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.process?.onExit(({ exitCode, signal }) => {
      cb(exitCode, signal !== undefined ? String(signal) : null);
    });
  }

  getPid(): number | null {
    return this.process?.pid ?? null;
  }

  kill(): void {
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
  }
}
