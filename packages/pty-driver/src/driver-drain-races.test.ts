import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliAdapter } from '@dutydeck/cli-adapters';
import { TmuxBackend, type SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';
import { JsonlTailer } from './transcript/tail.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(tmux = false, writeInput: CliAdapter['writeInput'] = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'driver-drain-races-'));
  const path = join(directory, 'transcript.jsonl');
  writeFileSync(path, '');
  const tail = new JsonlTailer({ resolvePath: () => path, mapEntry: () => [], pollIntervalMs: 60_000 });
  tail.start();
  await tail.flush();
  const writes: string[] = [];
  const backend: SessionBackend = tmux ? new TmuxBackend('unused-drain-race', { ownerId: 'test' }) : {
    kind: 'pty', spawn() {}, resize() {}, kill() {}, interrupt() {}, onData() {}, onExit() {},
    write(data) { writes.push(data); },
  };
  if (tmux) {
    vi.spyOn(backend as TmuxBackend, 'setDutydeckMetadata').mockImplementation(() => {});
    vi.spyOn(backend, 'kill').mockImplementation(() => {});
  }
  const driver = new PtyCliDriver({
    agent: { id: 'fixture', name: 'fixture', protocol: 'pty-cli', command: 'unused', args: [],
      env: {}, permissionMode: 'full-trust', timeout: 60, capabilities: { resume: true, pause: false }, builtin: false },
    adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], buildResumeCommand: () => [], writeInput },
    backend, sessionId: 'ses_drain-race', onEvent() {}, onExit() {},
  });
  // Keep the real driver and real yielding tail; only the external CLI is inert.
  const internals = driver as unknown as { transcript: JsonlTailer; started: boolean; preparedTurnId?: string };
  internals.transcript = tail;
  internals.started = true;
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanup.push(async () => { await driver.stop(); tail.stop(); });
  const backlog = () => appendFileSync(path, (JSON.stringify({ text: 'x'.repeat(1024) }) + '\n').repeat(4000));
  return { driver, tail, writes, backlog, internals };
}

describe('driver cancellation across a real transcript drain', () => {
  it('rejects send and fences delayed Enter before stop finishes draining', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let attempted!: () => void;
    const done = new Promise<void>(resolve => { attempted = resolve; });
    let enterError: unknown;
    const f = await fixture(false, async backend => {
      backend.write('pasted prompt');
      await gate;
      try { backend.write('\r'); } catch (error) { enterError = error; }
      attempted();
    });
    const sent = f.driver.send('prompt').then(() => 'resolved', error => error.message);
    await Promise.resolve();
    expect(f.writes).toEqual(['pasted prompt']);
    f.backlog();
    let stopped = false;
    const stopping = f.driver.stop().then(() => { stopped = true; });
    await nextTurn();
    expect(stopped).toBe(false);
    release();
    await done;
    expect(f.writes).toEqual(['pasted prompt']);
    expect(enterError).toEqual(new Error('Driver stopped'));
    expect(await sent).toBe('Driver stopped');
    expect(stopped).toBe(false);
    await stopping;
  });

  it.each([false, true])('does not revive after stop while resume drains (tmux=%s)', async tmux => {
    const f = await fixture(tmux);
    vi.spyOn(TmuxBackend, 'probeSession').mockReturnValue('exists');
    const operations = f.driver as unknown as { reattachTmux(): void; respawn(): void };
    const attach = vi.spyOn(operations, 'reattachTmux').mockImplementation(() => {});
    const spawn = vi.spyOn(operations, 'respawn').mockImplementation(() => {});
    f.backlog();
    const resuming = f.driver.resume();
    await nextTurn();
    const stopping = f.driver.stop();
    await Promise.all([resuming, stopping]);
    expect(attach).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not publish a checkpoint invalidated by stop during drain', async () => {
    const f = await fixture(true);
    f.backlog();
    const checkpoint = f.driver.checkpoint();
    await nextTurn();
    const stopping = f.driver.stop();
    await expect(checkpoint).resolves.toBeUndefined();
    await stopping;
    expect(f.internals.preparedTurnId).toBeUndefined();
  });
});
