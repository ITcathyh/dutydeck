import { describe, expect, it } from 'vitest';
import { runCommand } from './command.js';

describe('asynchronous management commands', () => {
  it('keeps timers responsive while a management client is slow', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      expect(await runCommand(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("ready"),180)'])).toBe('ready');
      expect(ticks).toBeGreaterThanOrEqual(8);
    } finally { clearInterval(timer); }
  });

  it('bounds a client that ignores SIGTERM without terminating a managed process', async () => {
    const started = Date.now();
    const error = await runCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeout: 200 }).catch(error => error);
    expect(error.code).toBe('ETIMEDOUT');
    expect(error.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
