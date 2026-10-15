import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { JsonlTransport } from './index.js';

const transports: JsonlTransport[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const transport of transports.splice(0)) await transport.stop(); });
describe('Agent timeout milliseconds at the process transport boundary', () => {
  it.each([0.001, 1.001, 2.003, 2_147_483.647])('registers an exact safe timer for %s seconds', async timeout => {
    const transport = new JsonlTransport({ id: 'timeout-fixture', name: 'Fixture', command: process.execPath,
      args: [resolve(process.cwd(), 'tests/fixtures/process-driver-turn-agent.mjs')], protocol: 'jsonl', env: {},
      cwd: process.cwd(), permissionMode: 'deny-all', timeout, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent() {} });
    transports.push(transport); await transport.start();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const send = transport.send('hang-forever').catch(() => undefined);
    try {
      await vi.waitFor(() => expect(timers.mock.calls.some(call => call[1] === Math.round(timeout * 1000))).toBe(true));
    } finally { timers.mockRestore(); await transport.stop(); await send; }
  });
});
