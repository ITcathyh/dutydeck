import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '@dutydeck/cli-adapters';
import { TmuxBackend, type SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(tmux: boolean, prepareInput?: CliAdapter['prepareInput']) {
  const backend: SessionBackend = tmux ? new TmuxBackend('unused-resume-active-turn', { ownerId: 'test' }) : {
    kind: 'pty', spawn() {}, resize() {}, kill() {}, interrupt() {}, onData() {}, onExit() {}, write() {},
  };
  if (tmux) {
    vi.spyOn(backend as TmuxBackend, 'setDutydeckMetadata').mockImplementation(() => {});
    vi.spyOn(backend, 'kill').mockImplementation(() => {});
    vi.spyOn(backend, 'write').mockImplementation(() => {});
    vi.spyOn(TmuxBackend, 'probeSession').mockReturnValue('exists');
  }
  const driver = new PtyCliDriver({
    agent: { id: 'fixture', name: 'fixture', protocol: 'pty-cli', command: 'unused', args: [],
      env: {}, permissionMode: 'full-trust', timeout: 60, capabilities: { resume: true, pause: false }, builtin: false },
    adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], buildResumeCommand: () => [],
      writeInput: target => { target.write('prompt'); }, prepareInput },
    backend, sessionId: 'ses_resume-active-turn', onEvent() {}, onExit() {},
  });
  const internals = driver as unknown as {
    started: boolean; turnActive: boolean; turnDeadlineTimer?: unknown;
    reattachTmux(): Promise<boolean>; respawn(): Promise<void>;
  };
  internals.started = true;
  const attach = vi.spyOn(internals, 'reattachTmux').mockResolvedValue(true);
  const spawn = vi.spyOn(internals, 'respawn').mockResolvedValue();
  cleanup.push(() => driver.stop().catch(() => {}));
  return { driver, internals, attach, spawn };
}

describe('resume() on a live driver', () => {
  it.each([false, true])('refuses while a turn runs and keeps its deadline (tmux=%s)', async tmux => {
    const f = fixture(tmux);
    const sent = f.driver.send('work').catch((error: Error) => error);
    await vi.waitFor(() => expect(f.internals.turnActive).toBe(true));
    await nextTurn();
    await expect(f.driver.resume()).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS', statusCode: 409 });
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.internals.turnActive).toBe(true);
    expect(f.internals.turnDeadlineTimer).toBeDefined();
    await f.driver.stop();
    expect(await sent).toBeInstanceOf(Error);
  });

  it('refuses while a submission is still preparing input', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(false, () => gate);
    const sent = f.driver.send('work').catch((error: Error) => error);
    await nextTurn();
    expect(f.internals.turnActive).toBe(false);
    await expect(f.driver.resume()).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS' });
    expect(f.spawn).not.toHaveBeenCalled();
    release();
    await f.driver.stop();
    await sent;
  });

  it('still resumes an idle driver', async () => {
    const f = fixture(false);
    await f.driver.resume();
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });
});
