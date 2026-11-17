import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { verifyOwnedTmuxExit, type OwnedTmuxExitProof, type PhysicalProcessIdentity, type ProcessProbe } from './owned-tmux.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

const local: PhysicalProcessIdentity = { host: 'host', boot: 'boot', namespace: 'namespace', pid: process.pid, start: '1' };
const server: PhysicalProcessIdentity = { ...local, pid: 101, start: '10' };
const target: PhysicalProcessIdentity = { ...local, pid: 102, start: '123' };
const realRead = vi.mocked(readFileSync).getMockImplementation()!;

function rawStat(state: string, start: string): string {
  const fields = Array.from({ length: 52 }, () => '0');
  fields[0] = state; fields[1] = '1'; fields[2] = '1'; fields[3] = '1'; fields[19] = start;
  return `(fixture) ${fields.join(' ')}\n`;
}
function proof(identity = target): OwnedTmuxExitProof {
  return { scope: { socketPath: '/unused', sessionName: 'owned', ownerId: 'owner', hostname: hostname(), uid: process.getuid!() },
    socket: { dev: '1', ino: '1' }, targetId: '$1', server, identities: [identity], stoppedAt: new Date().toISOString() };
}
function probe(overrides: Partial<ProcessProbe> = {}): ProcessProbe {
  return {
    identify: pid => pid === process.pid ? local : pid === target.pid ? target : server,
    observe: identity => identity.pid === server.pid ? 'dead' : 'alive',
    ...overrides,
  };
}
function mockStat(raw: string | Error) {
  vi.mocked(readFileSync).mockImplementation(((path: unknown, ...args: unknown[]) => {
    if (path === `/proc/${target.pid}/stat`) { if (raw instanceof Error) throw raw; return raw; }
    return (realRead as any)(path, ...args);
  }) as typeof readFileSync);
}

beforeEach(() => { vi.mocked(readFileSync).mockImplementation(realRead); });

describe('owned tmux Linux exited-state observation', () => {
  it.skipIf(process.platform !== 'linux')('accepts Z/X only for the same complete identity and keeps a live process unproven', async () => {
    for (const state of ['Z', 'X']) {
      mockStat(rawStat(state, target.start));
      expect(await verifyOwnedTmuxExit(proof(), probe())).toBe(true);
    }
    mockStat(rawStat('S', target.start));
    expect(await verifyOwnedTmuxExit(proof(), probe())).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('preserves independent dead proof and respects unknown or thrown observations', async () => {
    mockStat(new Error('stat must not override dead proof'));
    expect(await verifyOwnedTmuxExit(proof(), probe({ observe: () => 'dead' }))).toBe(true);
    expect(await verifyOwnedTmuxExit(proof(), probe({ observe: () => 'unknown' }))).toBe(false);
    expect(await verifyOwnedTmuxExit(proof(), probe({ observe: () => { throw new Error('observation failed'); } }))).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('rejects wrong host, namespace and identity changes even when the stat is Z', async () => {
    mockStat(rawStat('Z', target.start));
    for (const identity of [{ ...target, host: 'wrong' }, { ...target, namespace: 'wrong' }]) {
      expect(await verifyOwnedTmuxExit(proof(identity), probe())).toBe(false);
    }
    expect(await verifyOwnedTmuxExit(proof(), probe({ identify: pid => pid === target.pid ? { ...target, start: '999' } : pid === process.pid ? local : server }))).toBe(false);
    expect(await verifyOwnedTmuxExit(proof(), probe({ identify: pid => pid === target.pid ? { ...target, host: '' } : pid === process.pid ? local : server }))).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('rejects malformed identities, malformed stat, start changes and read failures', async () => {
    for (const identity of [{ ...target, pid: 0 }, { ...target, start: '' }, { ...target, start: 'invalid' }]) {
      expect(await verifyOwnedTmuxExit(proof(identity), probe())).toBe(false);
    }
    for (const raw of ['not a proc stat', rawStat('Z', 'invalid'), rawStat('Z', '999'), rawStat('?', target.start), new Error('EACCES')]) {
      mockStat(raw);
      expect(await verifyOwnedTmuxExit(proof(), probe())).toBe(false);
    }
  });
});
