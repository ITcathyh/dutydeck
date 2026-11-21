import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HerdrBackend } from './herdr-backend.js';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('logs failed detach evidence once across backend instances and preserves the saved identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-herdr-detach-')); directories.push(directory);
  const name = `dutydeck-${'a'.repeat(32)}`, sessionId = 'ses_herdr_detach';
  const stateFile = join(directory, 'identity.json');
  const original = { name, owner: `dutydeck:${sessionId}`, root: { pid: 123 }, identities: [] };
  writeFileSync(stateFile, JSON.stringify(original));
  const warn = vi.fn();
  const backend = new HerdrBackend(name, {
    binary: 'unused', stateFile, ownerId: original.owner, log: { warn },
    processProbe: { identify() { throw new Error('unused'); }, observe: () => 'unknown' },
  });
  for (const candidate of [backend, backend.fork()]) {
    vi.spyOn(candidate, 'captureOwnedIdentity').mockRejectedValue(new Error('identity read failed'));
    await expect(candidate.detach()).resolves.toBeUndefined();
  }
  expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual(original);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    component: 'HerdrBackend', location: 'detach.captureOwnedIdentity', sessionId, error: 'identity read failed',
  }), expect.any(String));
});

it.each(['reservation', 'launched'])('fences an old natural-exit observation after the replacement %s is persisted', async stage => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-herdr-generation-')); directories.push(directory);
  const name = `dutydeck-${'c'.repeat(32)}`, stateFile = join(directory, 'identity.json');
  const oldState = { name, owner: 'fixture', launch_id: '1'.repeat(64), identities: [], root: { pid: 123 } };
  writeFileSync(stateFile, JSON.stringify(oldState));
  const old = new HerdrBackend(name, { binary: 'unused', stateFile, ownerId: 'fixture', processProbe: {} as any });
  vi.spyOn(old as any, 'exitedSnapshot').mockReturnValue(oldState);
  const verify = vi.spyOn(old, 'verifyOwnedIdentity').mockResolvedValue(false);
  let resume!: (value: unknown) => void;
  const captured = new Promise(resolve => { resume = resolve; });
  const capture = vi.spyOn(old, 'captureOwnedIdentity').mockReturnValue(captured);
  const observation = old.detach();
  expect(capture).toHaveBeenCalledTimes(1);
  const next = stage === 'reservation' ? { name, owner: 'fixture', launch_id: '2'.repeat(64) } : { ...oldState, launch_id: '2'.repeat(64), root: { pid: 456 } };
  writeFileSync(stateFile, JSON.stringify(next));
  resume(oldState); await observation;
  expect(() => (old as any).persist()).toThrow('HERDR_STATE_GENERATION_CHANGED');
  expect(await (old as any).finishNaturalExit()).toBe(false);
  expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual(next);
  expect(verify).not.toHaveBeenCalled();
});

it('permits a replacement launch to persist after its own reservation is written', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-herdr-generation-')); directories.push(directory);
  const name = `dutydeck-${'d'.repeat(32)}`, stateFile = join(directory, 'identity.json');
  writeFileSync(stateFile, JSON.stringify({ name, owner: 'fixture', launch_id: '1'.repeat(64) }));
  const backend = new HerdrBackend(name, { binary: 'unused', stateFile, ownerId: 'fixture', processProbe: {} as any });
  const reservation = { name, owner: 'fixture', launch_id: '2'.repeat(64) };
  writeFileSync(stateFile, JSON.stringify(reservation));
  const launched = { ...reservation, root: { pid: 456 }, identities: [{ pid: 456 }] };
  (backend as any).state = launched; (backend as any).persist();
  expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual(launched);
});
