import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { VerificationManager } from './verification.js';

const identityGate = vi.hoisted(() => ({ entered: undefined as (() => void) | undefined, closed: undefined as (() => void) | undefined, wait: undefined as Promise<void> | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: async (...args: Parameters<typeof original.readFile>) => {
    const result = await original.readFile(...args);
    if (/^\/proc\/\d+\/stat$/.test(String(args[0])) && identityGate.wait) {
      const wait = identityGate.wait; identityGate.wait = undefined;
      identityGate.entered?.(); await wait;
    }
    return result;
  } };
});
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: (...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args);
    child.once('close', () => identityGate.closed?.());
    return child;
  } };
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

it('waits for the pending process identity continuation after the verification child closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-identity-owner-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'file'), 'baseline'); git('add', '.'); git('commit', '-qm', 'baseline');
  const repos = createRepositories(join(root, '.git', 'verification.sqlite'));
  const manager = new VerificationManager(repos.config);
  const entered = deferred(), gate = deferred(), closed = deferred();
  identityGate.entered = entered.resolve; identityGate.closed = closed.resolve; identityGate.wait = gate.promise;
  let databaseClosed = false, finished = false;
  const cas = vi.spyOn(repos.config as unknown as { compareAndSet: (...args: unknown[]) => unknown }, 'compareAndSet');
  const running = manager.run('session', root, { command: 'echo should-not-run' }).catch(error => error);
  try {
    await entered.promise;
    const stopping = manager.stopSession('session').then(() => { finished = true; });
    await closed.promise;
    // Let all post-close fingerprint/record work finish if close escaped the identity tail.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(finished).toBe(false);
    gate.resolve(); await stopping;
    const result = await running;
    expect(result.status).toBe('interrupted');
    expect(result.output).not.toContain('should-not-run');
    expect((await manager.list('session', root))[0]?.status).toBe('interrupted');
    const writes = cas.mock.calls.length;
    repos.close(); databaseClosed = true;
    await new Promise(resolve => setImmediate(resolve));
    expect(cas).toHaveBeenCalledTimes(writes);
  } finally {
    gate.resolve(); await manager.stop(); await running;
    identityGate.entered = undefined; identityGate.closed = undefined; identityGate.wait = undefined;
    if (!databaseClosed) repos.close();
    rmSync(root, { recursive: true, force: true });
  }
});
