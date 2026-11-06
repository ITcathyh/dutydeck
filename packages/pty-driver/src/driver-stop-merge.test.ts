import { expect, it, vi } from 'vitest';
import { TmuxBackend } from '@dutydeck/session-backends';
import type { AgentConfig } from '@dutydeck/shared';

// Process 1 is the pane root seen at wiring; process 2 is a child the agent started later, which survives kill-session.
const state = vi.hoisted(() => ({ dead: new Set<number>(), stops: [] as number[][] }));
vi.mock('@dutydeck/session-backends', async importOriginal => {
  const proven = (proof: { identities: Array<{ pid: number }> }) => proof.identities.every(item => state.dead.has(item.pid));
  return {
    ...await importOriginal<typeof import('@dutydeck/session-backends')>(),
    stopOwnedTmux: vi.fn(async (identity: { identities: Array<{ pid: number }> }) => {
      state.stops.push(identity.identities.map(item => item.pid));
      if (proven(identity)) return { ...identity, stoppedAt: new Date().toISOString() };
      const proof = { ...identity, identities: [...identity.identities.filter(item => item.pid !== 2), { pid: 2 }], stoppedAt: new Date().toISOString() };
      throw Object.assign(new Error('LEGACY_TMUX_EXIT_UNPROVEN'), { code: 'LEGACY_TMUX_EXIT_UNPROVEN', proof });
    }),
    verifyOwnedTmuxExit: vi.fn(async (proof: { identities: Array<{ pid: number }> }) => proven(proof)),
  };
});
const { PtyCliDriver } = await import('./driver.js');

const agent: AgentConfig = {
  id: 'stop-merge', name: 'Stop merge', protocol: 'pty-cli', command: '/unused', args: [], cwd: '/tmp', env: {},
  permissionMode: 'full-trust', timeout: 60, capabilities: { resume: true, pause: false }, builtin: false,
};

it('a repeated stop keeps the processes an earlier stop recorded instead of proving exit from the wire-time identity', async () => {
  const backend = new TmuxBackend('dd-stop-merge', { ownerId: 'dutydeck:ses_stop_merge' });
  vi.spyOn(backend, 'cancelPending').mockResolvedValue();
  vi.spyOn(backend, 'setDutydeckMetadata').mockResolvedValue();
  const driver = new PtyCliDriver({
    agent, adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], writeInput() {} }, backend, sessionId: 'ses_stop_merge',
    processProbe: { identify() { throw new Error('unused'); }, observe: () => 'alive' }, onEvent() {}, onExit() {},
  });
  (driver as unknown as { tmuxIdentity: object }).tmuxIdentity = { targetId: '$1', identities: [{ pid: 1 }] };
  await driver.stop();
  expect(await driver.isStopped()).toBe(false);
  // The pane root ends after kill-session; the child it started keeps running.
  state.dead.add(1);
  await driver.stop();
  expect(state.stops).toEqual([[1], [1, 2]]);
  expect(await driver.isStopped()).toBe(false);
  state.dead.add(2);
  expect(await driver.isStopped()).toBe(true);
});
