import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpxAdapter } from './index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(mode: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-compact-'));
  const log = join(cwd, 'prompts.log');
  const events: any[] = [];
  const adapter = new AcpxAdapter({ id: 'compact-mock', name: 'Compact mock', command: process.execPath, args: [resolve('packages/acp-client/tests/fixtures/compact-agent.mjs'), mode], cwd, env: { compact_test_log: log }, protocol: 'acp', permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { sessionKey: 'persisted-compact', onEvent: event => events.push(event) });
  cleanups.push(async () => { await adapter.stop(); await rm(cwd, { recursive: true, force: true }); });
  await adapter.start();
  return { adapter, events, prompts: async () => (await readFile(log, 'utf8')).trim().split('\n') };
}
describe('native ACP compaction', () => {
  it.each(['codex', 'claude'])('compacts an advertised command without fabricating a completed user turn (%s)', async mode => {
    const h = await fixture(mode);
    await h.adapter.send('old context');
    h.events.length = 0;
    expect(await h.adapter.compact()).toBe('completed');
    expect(h.events.some(event => event.type === 'completed' || event.type === 'text')).toBe(false);
    expect(h.events.filter(event => event.data?.state === 'compaction').map(event => event.data.phase)).toContain('completed');
    await h.adapter.send('new task');
    expect(await h.prompts()).toEqual(['old context', '/compact', 'new task']);
    expect(h.events.filter(event => event.type === 'completed')).toHaveLength(1);
  });
  it('never sends the slash command to an agent that does not advertise it', async () => {
    const h = await fixture('unsupported');
    expect(await h.adapter.compact()).toBe('unsupported');
    await h.adapter.send('real task');
    expect(await h.prompts()).toEqual(['real task']);
    expect(h.events.some(event => event.data?.phase === 'completed')).toBe(false);
  });
  it('honors a newer command withdrawal rather than the initial startup advertisement', async () => {
    const h = await fixture('withdrawn');
    await h.adapter.send('withdraw command');
    expect(await h.adapter.compact()).toBe('unsupported');
    expect(await h.prompts()).toEqual(['withdraw command']);
  });
  it('reports explicit native failure after a quiescent result, without claiming success', async () => {
    const h = await fixture('failed');
    expect(await h.adapter.compact()).toBe('failed');
    expect(h.events.some(event => event.data?.phase === 'completed' || event.type === 'completed')).toBe(false);
    await h.adapter.send('real task');
    expect(await h.prompts()).toEqual(['/compact', 'real task']);
  });
  it('returns authoritative cancellation without fabricating a user completion', async () => {
    const h = await fixture('cancelled');
    expect(await h.adapter.compact()).toBe('cancelled');
    expect(await h.prompts()).toEqual(['/compact']);
    expect(h.events.some(event => event.type === 'completed')).toBe(false);
  });
  it('accounts for native compact and actual prompt tokens in one user-turn reading', async () => {
    const h = await fixture('usage');
    await h.adapter.send('old context');
    h.events.length = 0;
    await h.adapter.compact();
    await h.adapter.send('real task');
    const usage = h.events.filter(event => event.data?.state === 'turn_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].data.breakdown).toMatchObject({ inputTokens: 120, outputTokens: 12 });
    await h.adapter.send('another task');
    expect(h.events.filter(event => event.data?.state === 'turn_usage').at(-1).data.breakdown).toMatchObject({ inputTokens: 20, outputTokens: 2 });
  });
  it('declines steering during a held compact and interrupts without a fake completion', async () => {
    const h = await fixture('held');
    const pending = h.adapter.compact();
    await expect.poll(() => h.events.some(event => event.data?.state === 'compaction' && event.data.phase === 'start')).toBe(true);
    // Wait until the native command has actually reached the provider.
    await expect.poll(async () => { try { return await h.prompts(); } catch { return []; } }).toEqual(['/compact']);
    expect(await h.adapter.steer('queued task')).toBe('promptRequired');
    await h.adapter.interrupt();
    expect(await pending).toBe('cancelled');
    expect(await h.prompts()).toEqual(['/compact']);
    expect(h.events.some(event => event.type === 'completed')).toBe(false);
  });
});
