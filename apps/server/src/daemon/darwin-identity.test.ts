import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { childProcessIdentity } from '@dutydeck/storage';
import { observeProcess } from '../../../../packages/storage/src/process-identity.js';
import { inspectDaemonState, type DaemonState } from './daemon.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn()
}));
const platform = process.platform;
const pid = 12345678;
const start = 'Mon Sep 14 21:13:05 2026';
let targetStart: string;
let toolFailure: boolean;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  targetStart = start;
  toolFailure = false;
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(execFileSync).mockImplementation(((file: string, args: string[]) => {
    if (toolFailure) throw new Error('tool unavailable');
    if (file === '/usr/sbin/ioreg') return '"IOPlatformUUID" = "4B7D2678-831C-5A2C-9C5F-81D67B0F1C36"';
    if (file === '/usr/sbin/sysctl') return 'A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D';
    if (file === '/bin/ps') return args[1] === String(pid) ? targetStart : start;
    throw new Error('unexpected command');
  }) as typeof execFileSync);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});
const recorded = (): DaemonState => ({ pid, ready: true, cwd: '/test', startedAt: 'launch', processIdentity: childProcessIdentity(pid) });
describe('Darwin daemon identities captured through actual storage parsers', () => {
  it('accepts a full normalized match without changing storage observation policy', () => {
    const state = recorded();
    expect(state.processIdentity).toMatchObject({ namespace: 'darwin:host-v1', start: `darwin:lstart-v1:${start}` });
    expect(inspectDaemonState(state).status).toBe('verified');
    expect(observeProcess(state.processIdentity!)).toBe('unknown');
  });
  it('marks changed birth time stale', () => {
    const state = recorded();
    targetStart = 'Mon Sep 14 21:13:06 2026';
    expect(inspectDaemonState(state).status).toBe('stale');
  });
  it('keeps unreadable or malformed capture unverifiable', () => {
    const state = recorded();
    targetStart = 'malformed';
    expect(inspectDaemonState(state).status).toBe('unverifiable');
    toolFailure = true;
    expect(inspectDaemonState(state).status).toBe('unverifiable');
  });
});
