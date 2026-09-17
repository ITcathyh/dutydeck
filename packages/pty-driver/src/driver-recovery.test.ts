import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import type { AgentConfig, DriverTurnRecovery, NormalizedDriverEvent } from '@dutydeck/shared';
import { DriverDetachedError, DriverRecoveryError } from '@dutydeck/shared';
import type { CliAdapter, PtyLike } from '@dutydeck/cli-adapters';
import { TmuxBackend, isTmuxAvailable, type SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const tmuxDescribe = isTmuxAvailable() ? describe : describe.skip;
const sessionId = 'ses_recovery-fixture';

async function waitFor(check: () => void, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  let error: unknown;
  while (Date.now() - started < timeoutMs) {
    try { check(); return; } catch (caught) { error = caught; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw error;
}

function assistant(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  }) + '\n';
}

function shellAdapter(prompts: string[]): CliAdapter {
  return {
    id: 'claude-code',
    capabilities: {},
    buildArgs: () => [],
    injectSessionContext: () => '',
    writeInput: (backend: PtyLike, prompt: string) => {
      prompts.push(prompt);
      backend.write(`${prompt}\n`);
    },
    completionPattern: /SHELL-DONE/,
  };
}

function config(cwd: string): AgentConfig {
  // Fake CLI 接受 Claude 生成的 CLI 参数（如 --settings 路径），外层 shell 通过 -c 吸收参数后进入交互式 shell。
  return {
    id: 'claude-code', name: 'Claude fixture', command: '/bin/sh', args: ['-c', 'exec /bin/sh'], protocol: 'pty-cli', cwd,
    env: { CLAUDE_CONFIG_DIR: cwd }, permissionMode: 'full-trust', timeout: 60,
    capabilities: { pause: false, resume: true }, builtin: false,
  } as AgentConfig;
}

tmuxDescribe('PtyCliDriver in-flight tmux turn recovery', () => {
  const roots: string[] = [];
  const sessions: string[] = [];

  afterEach(() => {
    for (const name of sessions.splice(0)) {
      try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* gone */ }
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { cwd: string; transcript: string; name: string; ownerId: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'dutydeck-turn-recovery-'));
    roots.push(cwd);
    const project = join(cwd, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(project, { recursive: true });
    const transcript = join(project, 'recovery-fixture.jsonl');
    // A pinned dutydeck id is enough for the real Claude resolver; no mocked
    // tailer or hand-wired transcript source is involved in these tests.
    writeFileSync(transcript, '');
    const name = `dutydeck-turn-recovery-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    sessions.push(name);
    return { cwd, transcript, name, ownerId: `dutydeck:${sessionId}` };
  }

  it('reattaches the original busy pane, replays only appended JSONL, and never submits the prompt twice', async () => {
    const f = fixture();
    const firstPrompts: string[] = [];
    const firstBackend = new TmuxBackend(f.name, { ownerId: f.ownerId });
    const first = new PtyCliDriver({
      agent: config(f.cwd), adapter: shellAdapter(firstPrompts), backend: firstBackend,
      onEvent() {}, onExit() {}, sessionId,
    });
    await first.start();
    const checkpoint = first.checkpoint();
    expect(checkpoint).toBeDefined();
    const originalPid = firstBackend.getPid();
    const sent = first.send('sleep 1; echo SHELL-DONE');
    await waitFor(() => expect(firstBackend.getDutydeckMetadata('turn_id')).toBe(checkpoint?.turnId));
    first.prepareForDaemonShutdown();
    await first.stop();
    expect(await first.isStopped()).toBe(false);
    await expect(sent).rejects.toBeInstanceOf(DriverDetachedError);

    const events: NormalizedDriverEvent[] = [];
    const recoveredPrompts: string[] = [];
    const recovered = new PtyCliDriver({
      agent: config(f.cwd), adapter: shellAdapter(recoveredPrompts), backend: new TmuxBackend(f.name, { ownerId: f.ownerId }),
      onEvent: event => events.push(event), onExit() {}, sessionId,
    });
    const settled = recovered.recover(checkpoint!);
    appendFileSync(f.transcript, assistant('final written while daemon was down'));
    await settled;

    expect(new TmuxBackend(f.name, { ownerId: f.ownerId }).getPid()).toBe(originalPid);
    expect(firstPrompts).toHaveLength(1);
    expect(recoveredPrompts).toEqual([]);
    expect(events.filter(event => event.type === 'text').map(event => event.data.text))
      .toEqual(['final written while daemon was down']);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
    await recovered.stop();
  }, 45_000);

  it('settles an offline-completed pane from capture-pane plus transcript replay', async () => {
    const f = fixture();
    const firstBackend = new TmuxBackend(f.name, { ownerId: f.ownerId });
    const first = new PtyCliDriver({
      agent: config(f.cwd), adapter: shellAdapter([]), backend: firstBackend,
      onEvent() {}, onExit() {}, sessionId,
    });
    await first.start();
    const checkpoint = first.checkpoint()!;
    const pending = first.send('sleep 0.2; echo SHELL-DONE');
    await waitFor(() => expect(firstBackend.getDutydeckMetadata('turn_id')).toBe(checkpoint.turnId));
    first.prepareForDaemonShutdown();
    await first.stop();
    await expect(pending).rejects.toBeInstanceOf(DriverDetachedError);
    await new Promise(resolve => setTimeout(resolve, 500));
    appendFileSync(f.transcript, assistant('offline final answer'));

    const events: NormalizedDriverEvent[] = [];
    const recovered = new PtyCliDriver({
      agent: config(f.cwd), adapter: shellAdapter([]), backend: new TmuxBackend(f.name, { ownerId: f.ownerId }),
      onEvent: event => events.push(event), onExit() {}, sessionId,
    });
    await recovered.recover(checkpoint);
    expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['offline final answer']);
    await recovered.stop();
  }, 45_000);

  it('rejects missing, foreign, and mismatched turn identities without killing or adopting the pane', async () => {
    const f = fixture();
    const owner = new TmuxBackend(f.name, { ownerId: f.ownerId });
    owner.spawn('/bin/sh', ['-c', 'sleep 30'], { cwd: f.cwd, cols: 80, rows: 24, env: { PATH: process.env.PATH ?? '' } });
    const pid = owner.getPid();
    owner.detach();
    const state: DriverTurnRecovery = { kind: 'pty-jsonl-v1', turnId: 'expected-turn', transcript: { offset: 0 } };
    for (const [ownerId, turnId] of [[f.ownerId, 'expected-turn'], ['dutydeck:someone-else', 'expected-turn'], [f.ownerId, 'other-turn']] as const) {
      const prompts: string[] = [];
      const driver = new PtyCliDriver({
        agent: config(f.cwd), adapter: shellAdapter(prompts), backend: new TmuxBackend(f.name, { ownerId }),
        onEvent() {}, onExit() {}, sessionId,
      });
      await expect(driver.recover({ ...state, turnId })).rejects.toBeInstanceOf(DriverRecoveryError);
      await driver.stop({ discardSession: true });
      expect(await driver.isStopped()).toBe(false);
      expect(TmuxBackend.probeSession(f.name)).toBe('exists');
      expect(new TmuxBackend(f.name, { ownerId: f.ownerId }).getPid()).toBe(pid);
      expect(prompts).toEqual([]);
    }
  }, 45_000);

  it.each(['throw', 'return'] as const)('does not prove a live pane stopped when kill fails by %s', async failure => {
    const f = fixture();
    const backend = new TmuxBackend(f.name, { ownerId: f.ownerId });
    const driver = new PtyCliDriver({ agent: config(f.cwd), adapter: shellAdapter([]), backend, onEvent() {}, onExit() {}, sessionId });
    await driver.start();
    const pid = backend.getPid();
    const kill = vi.spyOn(backend, 'kill').mockImplementation(() => { if (failure === 'throw') throw new Error('kill unavailable'); });
    try {
      await expect(driver.stop()).resolves.toBeUndefined();
      expect(TmuxBackend.probeSession(f.name)).toBe('exists');
      expect(backend.getPid()).toBe(pid);
      expect(await driver.isStopped()).toBe(false);
    } finally { kill.mockRestore(); backend.kill(); }
  }, 45_000);

  it('proves an explicitly killed owned pane is absent and preserves an unrelated pane', async () => {
    const f = fixture(); const other = fixture();
    const backend = new TmuxBackend(f.name, { ownerId: f.ownerId });
    const unrelated = new TmuxBackend(other.name, { ownerId: 'dutydeck:unrelated' });
    unrelated.spawn('/bin/sh', ['-c', 'sleep 30'], { cwd: other.cwd, cols: 80, rows: 24, env: { PATH: process.env.PATH ?? '' } });
    const driver = new PtyCliDriver({ agent: config(f.cwd), adapter: shellAdapter([]), backend, onEvent() {}, onExit() {}, sessionId });
    try {
      await driver.start(); await driver.stop();
      expect(await driver.isStopped()).toBe(true);
      expect(TmuxBackend.probeSession(other.name)).toBe('exists');
    } finally { unrelated.kill(); }
  }, 45_000);

  it('detaches a temporary attachment when transcript restore rejects a truncated cursor', async () => {
    const f = fixture();
    const firstBackend = new TmuxBackend(f.name, { ownerId: f.ownerId });
    const first = new PtyCliDriver({
      agent: config(f.cwd), adapter: shellAdapter([]), backend: firstBackend,
      onEvent() {}, onExit() {}, sessionId,
    });
    await first.start();
    const checkpoint = first.checkpoint()!;
    const submitted = first.send('echo SHELL-DONE');
    await waitFor(() => expect(firstBackend.getDutydeckMetadata('turn_id')).toBe(checkpoint.turnId));
    first.prepareForDaemonShutdown();
    await first.stop();
    await submitted.catch(() => {});

    const rejected = new PtyCliDriver({
      agent: config(f.cwd), adapter: shellAdapter([]), backend: new TmuxBackend(f.name, { ownerId: f.ownerId }),
      onEvent() {}, onExit() {}, sessionId,
    });
    await expect(rejected.recover({
      ...checkpoint,
      transcript: { ...checkpoint.transcript, offset: checkpoint.transcript.offset + 1 },
    })).rejects.toBeInstanceOf(DriverRecoveryError);
    await rejected.stop({ discardSession: true });
    expect(await rejected.isStopped()).toBe(false);
    expect(TmuxBackend.probeSession(f.name)).toBe('exists');

    // If the failed driver left its pipe-pane capture behind, `-o` prevents
    // this observer from capturing the echo. Seeing it proves detach cleaned
    // tail/pipe/watchers while preserving the original shell pane.
    const observer = new TmuxBackend(f.name, { ownerId: f.ownerId });
    const received: string[] = [];
    observer.onData(data => received.push(data));
    observer.attach({ cols: 80, rows: 24 });
    observer.write('echo AFTER-FAILED-RECOVERY\n');
    await waitFor(() => expect(received.join('')).toContain('AFTER-FAILED-RECOVERY'));
    observer.detach();
  }, 45_000);
});

describe('PtyCliDriver send failure cleanup', () => {
  function backend(): SessionBackend {
    return {
      kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, interrupt() {}, onData() {}, onExit() {},
    };
  }

  function driver(writeInput: CliAdapter['writeInput']): PtyCliDriver {
    return new PtyCliDriver({
      agent: { ...config(process.cwd()), id: 'mock' },
      adapter: { id: 'mock', capabilities: {}, buildArgs: () => [], writeInput },
      backend: backend(), onEvent() {}, onExit() {}, sessionId,
    });
  }

  async function expectNoUnhandled(run: () => Promise<void>): Promise<void> {
    const reasons: unknown[] = [];
    const onUnhandled = (reason: unknown) => reasons.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await run();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(reasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }

  it('does not leave an unhandled completion rejection when writeInput fails', async () => {
    await expectNoUnhandled(async () => {
      const subject = driver(async () => { throw new Error('write failed'); });
      await subject.start();
      await expect(subject.send('prompt')).rejects.toThrow('write failed');
      await subject.stop();
    });
  });

  it('does not leave an unhandled completion rejection when stop races an async write', async () => {
    await expectNoUnhandled(async () => {
      const subject = driver(() => new Promise<void>(() => {}));
      await subject.start();
      const pending = subject.send('prompt');
      await Promise.resolve();
      await subject.stop();
      await expect(pending).rejects.toThrow('Driver stopped');
    });
  });

  it('blocks every delayed adapter write after stop releases the write gate', async () => {
    await expectNoUnhandled(async () => {
      const writes: string[] = [];
      let releaseInput: (() => void) | undefined;
      let inputFinished: (() => void) | undefined;
      const inputGate = new Promise<void>(resolve => { releaseInput = resolve; });
      const inputDone = new Promise<void>(resolve => { inputFinished = resolve; });
      const target: SessionBackend & Partial<PtyLike> = {
        kind: 'pty', spawn() {}, resize() {}, kill() {}, interrupt() {}, onData() {}, onExit() {},
        write: data => { writes.push(`write:${data}`); return true; },
        sendText: text => { writes.push(`text:${text}`); return true; },
        sendSpecialKeys: (...keys) => { writes.push(`keys:${keys.join('+')}`); return true; },
      };
      const errors: Error[] = [];
      const subject = new PtyCliDriver({
        agent: { ...config(process.cwd()), id: 'mock' },
        adapter: {
          id: 'mock', capabilities: {}, buildArgs: () => [],
          async writeInput(backend) {
            backend.write('first');
            await inputGate;
            for (const write of [
              () => backend.sendText?.('late text'),
              () => backend.sendSpecialKeys?.('Enter'),
              () => backend.write('late write'),
            ]) {
              try { write(); } catch (err) { errors.push(err as Error); }
            }
            inputFinished?.();
          },
        },
        backend: target, onEvent() {}, onExit() {}, sessionId,
      });
      await subject.start();
      const pending = subject.send('prompt');
      await Promise.resolve();
      expect(writes).toEqual(['write:first']);
      await subject.stop();
      releaseInput?.();
      await expect(pending).rejects.toThrow('Driver stopped');
      await inputDone;
      expect(writes).toEqual(['write:first']);
      expect(errors).toHaveLength(3);
      expect(errors.every(error => error.message === 'Driver stopped')).toBe(true);
    });
  });
});
