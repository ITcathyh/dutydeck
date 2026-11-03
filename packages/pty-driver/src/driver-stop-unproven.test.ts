import { expect, it, vi } from 'vitest';
import { TmuxBackend } from '@dutydeck/session-backends';
import type { AgentConfig } from '@dutydeck/shared';

const exit = vi.hoisted(() => ({ proven: false, stops: 0 }));
vi.mock('@dutydeck/session-backends', async importOriginal => ({
  ...await importOriginal<typeof import('@dutydeck/session-backends')>(),
  // kill-session was issued but the pane root has not exited within the proof deadline.
  stopOwnedTmux: vi.fn(async (identity: object) => {
    exit.stops++;
    throw Object.assign(new Error('LEGACY_TMUX_EXIT_UNPROVEN'), { code: 'LEGACY_TMUX_EXIT_UNPROVEN', proof: { ...identity, stoppedAt: new Date().toISOString() } });
  }),
  verifyOwnedTmuxExit: vi.fn(async () => exit.proven),
}));
const { PtyCliDriver } = await import('./driver.js');

const agent: AgentConfig = {
  id: 'stop-unproven', name: 'Stop unproven', protocol: 'pty-cli', command: '/unused', args: [], cwd: '/tmp', env: {},
  permissionMode: 'full-trust', timeout: 60, capabilities: { resume: true, pause: false }, builtin: false,
};

it('keeps the unproven tmux exit proof so a later recheck proves exit without stopping again', async () => {
  const backend = new TmuxBackend('dd-stop-unproven', { ownerId: 'dutydeck:ses_stop_unproven' });
  vi.spyOn(backend, 'cancelPending').mockResolvedValue();
  vi.spyOn(backend, 'setDutydeckMetadata').mockResolvedValue();
  const driver = new PtyCliDriver({
    agent, adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], writeInput() {} }, backend, sessionId: 'ses_stop_unproven',
    processProbe: { identify() { throw new Error('unused'); }, observe: () => 'alive' }, onEvent() {}, onExit() {},
  });
  (driver as unknown as { tmuxIdentity: object }).tmuxIdentity = { targetId: '$1', identities: [] };
  await driver.stop();
  expect(await driver.isStopped()).toBe(false);
  exit.proven = true;
  expect(await driver.isStopped()).toBe(true);
  await driver.stop();
  expect(exit.stops).toBe(1);
});
